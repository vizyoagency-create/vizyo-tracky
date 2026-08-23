import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackerStatus } from '@prisma/client';
import { decodeFrame } from '@vizyo/tracky-shared';
import type { CobanFrame } from '@vizyo/tracky-shared';
import { createServer, type Server, type Socket } from 'node:net';
import type { Env } from '../config/env.validation';
import { AlertsService } from '../alerts/alerts.service';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { SocketRegistryService, type TrackerSocket } from '../socket-registry/socket-registry.service';
import { UnknownTrackerRegistry } from '../unknown-trackers/unknown-trackers.registry';

@Injectable()
export class TcpServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TcpServerService.name);
  private server: Server | null = null;

  /**
   * Sprint 0.1 — délai de grâce avant de marquer un tracker OFFLINE sur fermeture
   * de socket. Les boîtiers Coban rouvrent leur connexion GPRS très souvent
   * (churn observé en prod : plusieurs close/reconnect par appareil et par heure).
   * Sans grâce, CHAQUE reconnexion produisait un faux OFFLINE → flapping (écriture
   * DB + event WS « offline » immédiat puis « online » à la reconnexion). Si le
   * boîtier se reconnecte avant la fin du délai, le passage OFFLINE est annulé.
   */
  private static readonly OFFLINE_GRACE_MS = 90_000;
  private readonly pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly registry: SocketRegistryService,
    private readonly prisma: PrismaService,
    private readonly positions: PositionsService,
    private readonly alertsService: AlertsService,
    private readonly gateway: RealtimeGateway,
    private readonly wireLogger: CobanWireLogger,
    private readonly errorLogger: ErrorLogger,
    private readonly ackWaiter: AckWaiterService,
    private readonly unknownTrackers: UnknownTrackerRegistry,
  ) {}

  onModuleInit(): void {
    const port = this.config.get('TRACKER_TCP_PORT', { infer: true });
    this.server = createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (err) => {
      this.logger.error('TCP server error', err);
    });

    this.server.listen(port, () => {
      this.logger.log(`Coban TCP server listening on :${port}`);
    });
  }

  onModuleDestroy(): Promise<void> {
    // Annule les passages OFFLINE en attente pour ne pas fuiter de timers.
    for (const timer of this.pendingOffline.values()) clearTimeout(timer);
    this.pendingOffline.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.logger.log('TCP server closed');
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(300_000);

    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.debug(`Incoming TCP connection from ${remote}`);

    let boundImei: string | null = null;
    let buffer = '';
    // Sérialisation PAR SOCKET (audit #2/#3/#5) : les trames d'un même boîtier
    // sont traitées STRICTEMENT l'une après l'autre via une chaîne de promesses.
    // Un Coban envoie souvent plusieurs trames d'un coup (burst de reconnexion /
    // coalescing TCP) ; sans sérialisation elles étaient dispatchées en parallèle
    // (fire-and-forget), ce qui cassait l'ordre, défaisait l'anti-replay (deux
    // ingests lisaient le même snapshot tracker), perdait la position reçue avant
    // que le login n'ait lié l'IMEI, et pouvait ouvrir deux trajets concurrents.
    let chain: Promise<void> = Promise.resolve();

    const processRaw = async (raw: string): Promise<void> => {
      this.logger.debug(`← [${remote}] ${raw}`);
      let frame: CobanFrame;
      try {
        frame = decodeFrame(raw);
      } catch (err) {
        await this.recordTcpError(err, boundImei, raw);
        return;
      }
      try {
        if (boundImei || frame.type === 'login') {
          this.wireLogger.in(
            frame.type === 'login' ? (frame as { imei: string }).imei : (boundImei ?? 'unknown'),
            raw,
            frame.type,
          );
        }
        await this.dispatchFrame(frame, socket, boundImei, (newImei) => {
          boundImei = newImei;
        });
      } catch (err) {
        await this.recordTcpError(err, boundImei, raw);
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('ascii');

      let idx: number;
      while ((idx = buffer.search(/[;\r\n]/)) !== -1) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!raw) continue;
        // Enchaîne : chaque trame attend la fin de traitement de la précédente.
        chain = chain
          .then(() => processRaw(raw))
          .catch((e) => this.logger.error('TCP chain error', e as Error));
      }
    });

    socket.on('timeout', () => {
      this.logger.warn(`Socket timeout ${remote} (imei=${boundImei ?? 'unbound'})`);
      socket.destroy();
    });

    socket.on('error', (err) => {
      this.logger.warn(`Socket error ${remote}: ${err.message}`);
    });

    socket.on('close', () => {
      this.logger.warn({ imei: boundImei, remoteAddr: remote }, `Socket closed (imei=${boundImei ?? 'unbound'})`);
      if (boundImei) this.handleSocketClose(boundImei, socket);
    });
  }

  /**
   * Gère la fermeture d'un socket lié à un IMEI.
   *
   * 1. Race de reconnexion : si un socket PLUS RÉCENT est déjà enregistré pour
   *    cet IMEI (le boîtier a rouvert sa connexion AVANT que ce 'close' ne se
   *    déclenche), on ne touche à rien — sinon on désenregistrerait le nouveau
   *    socket et on marquerait OFFLINE à tort. (Bug préexistant.)
   * 2. Sinon on désenregistre et on programme un passage OFFLINE *différé*
   *    (anti-flapping) — annulé si le boîtier se reconnecte avant la fin du délai.
   */
  private handleSocketClose(imei: string, socket: TrackerSocket): void {
    const current = this.registry.get(imei);
    if (current && current.socket !== socket) {
      this.logger.debug(`Stale socket close ignoré pour ${imei} (déjà reconnecté)`);
      return;
    }
    this.registry.unregister(imei);
    this.ackWaiter.cancelAll(imei);
    this.scheduleOffline(imei);
  }

  /** Programme un passage OFFLINE différé (annulable). Réarme si déjà programmé. */
  private scheduleOffline(imei: string): void {
    const existing = this.pendingOffline.get(imei);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingOffline.delete(imei);
      // Reconnecté entre-temps (réenregistré) → ne pas marquer OFFLINE.
      if (this.registry.has(imei)) return;
      void this.markOffline(imei);
    }, TcpServerService.OFFLINE_GRACE_MS);
    // Ne pas maintenir le process en vie juste pour ce timer.
    (timer as { unref?: () => void }).unref?.();
    this.pendingOffline.set(imei, timer);
  }

  /** Annule un passage OFFLINE en attente (appelé à la reconnexion / login). */
  private cancelPendingOffline(imei: string): void {
    const existing = this.pendingOffline.get(imei);
    if (existing) {
      clearTimeout(existing);
      this.pendingOffline.delete(imei);
    }
  }

  /** Écrit le statut OFFLINE + diffuse l'event WS. Erreurs catchées + loguées. */
  private async markOffline(imei: string): Promise<void> {
    try {
      const tracker = await this.prisma.tracker.findUnique({
        where: { imei },
        include: { vehicle: true },
      });
      if (!tracker) return;
      // Garde anti-TOCTOU (#11) : si le boîtier s'est reconnecté pendant la
      // lecture ci-dessus (login → ONLINE + lastSeenAt), ne pas écraser ce
      // statut ONLINE tout neuf par un OFFLINE périmé.
      if (this.registry.has(imei)) return;
      await this.prisma.tracker.update({
        where: { id: tracker.id },
        data: { status: TrackerStatus.OFFLINE },
      });
      if (tracker.vehicle) {
        this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
          trackerId: tracker.id,
          imei: tracker.imei,
          status: 'offline',
          at: new Date().toISOString(),
        });
      }
    } catch (e) {
      this.logger.error(`Failed to set offline: ${imei}`, e as Error);
      await this.errorLogger
        .record(e instanceof Error ? e : new Error(String(e)), 'tcp-server', { imei })
        .catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
    }
  }

  /** Enregistre une erreur de traitement de trame TCP (catch partagé décode + dispatch). */
  private async recordTcpError(err: unknown, imei: string | null, raw: string): Promise<void> {
    await this.errorLogger
      .record(err instanceof Error ? err : new Error(String(err)), 'tcp-server', {
        imei: imei ?? undefined,
        frameRaw: raw,
      })
      .catch((e) => this.logger.error('ErrorLogger persist failed', e));
  }

  private async dispatchFrame(
    frame: CobanFrame,
    socket: Socket,
    currentImei: string | null,
    setImei: (imei: string) => void,
  ): Promise<void> {
    switch (frame.type) {
      case 'login': {
        const tracker = await this.prisma.tracker.findUnique({
          where: { imei: frame.imei },
        });
        if (!tracker) {
          // Provisioning — IMEI pas (ou mal) enregistré : on le mémorise pour la vue admin
          // « Boîtiers non reconnus » (sinon le boîtier retombe en SMS, invisible côté app).
          this.unknownTrackers.record(frame.imei, socket.remoteAddress ?? null);
          this.logger.warn(`Unknown IMEI attempting login: ${frame.imei}`);
          socket.end();
          return;
        }
        // Connexion réussie → cet IMEI n'est plus « inconnu » (nettoie un éventuel résidu).
        this.unknownTrackers.forget(frame.imei);
        setImei(frame.imei);
        this.registry.register(frame.imei, socket);
        // Reconnexion : annule un éventuel passage OFFLINE différé (anti-flapping).
        this.cancelPendingOffline(frame.imei);
        socket.write('LOAD');
        await this.prisma.tracker.update({
          where: { id: tracker.id },
          data: { status: TrackerStatus.ONLINE, lastSeenAt: new Date() },
        });
        this.logger.log({ imei: frame.imei, remoteAddr: socket.remoteAddress, frameRaw: frame.raw }, `Tracker connected: ${frame.imei}`);
        break;
      }

      case 'heartbeat': {
        if (frame.imei !== currentImei) {
          this.logger.warn(`Heartbeat IMEI mismatch: got ${frame.imei}, expected ${currentImei}`);
          break;
        }
        this.registry.touch(frame.imei);
        socket.write('ON');
        break;
      }

      case 'position': {
        if (!currentImei) {
          this.logger.warn(`Position received before login: ${frame.raw}`);
          break;
        }
        if (frame.imei !== currentImei) {
          this.logger.warn(`Position IMEI mismatch: got ${frame.imei}, expected ${currentImei}`);
          break;
        }
        this.logger.debug(
          { imei: frame.imei, lat: frame.latitude, lng: frame.longitude, speed: frame.speedKph, valid: frame.valid },
          `Position from ${frame.imei}`,
        );
        // TRK-040 — snapshot du tracker AVANT l'ingestion de la trame : l'état du
        // contact qui départage une alarme d'alimentation est celui d'AVANT cette
        // trame (le `kt` de 06:00), pas celui qu'elle est en train d'écrire. Une
        // trame de vraie coupure peut porter ignition=0 (fil ACC mort) : lue après
        // ingestion, elle effacerait le discriminant qu'elle doit subir.
        const trackerAvantTrame =
          frame.alarm && frame.alarm !== 'none'
            ? await this.prisma.tracker.findUnique({
                where: { imei: frame.imei },
                include: { vehicle: { include: { fleet: true } } },
              })
            : null;
        await this.positions.ingest(frame);

        // #10 — un ACK de commande (ex position_single) peut decoder comme une
        // trame 'position' : on tente de resoudre un waiter en attente pour cet
        // IMEI (no-op s'il n'y en a pas). Le pattern moteur J/K ne matche pas une
        // position, donc seule une commande "position" est resolue ici.
        this.ackWaiter.tryMatch(currentImei, frame.raw);

        if (frame.alarm && frame.alarm !== 'none') {
          const tracker = trackerAvantTrame;
          if (tracker) {
            await this.alertsService.createFromCobanFrame(frame, tracker as any).catch((err) => {
              this.logger.error('Failed to create alert', err);
              this.errorLogger.record(
                err instanceof Error ? err : new Error(String(err)),
                'tcp-server',
                { imei: frame.imei, alarm: frame.alarm },
              ).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
            });
          }
        }

        if (frame.alarm === 'sos') {
          socket.write(`**,imei:${currentImei},E;`);
          this.logger.warn(`SOS alarm from ${currentImei}, ACK sent`);
        }
        break;
      }

      case 'no_fix': {
        // Boîtier VIVANT mais sans lock GPS (rapport LBS / démarrage à froid) : on
        // rafraîchit lastSeenAt SANS écrire de position (aucune coordonnée) → l'UI
        // l'affiche « en attente GPS » au lieu de « non configuré ». Avant, ces trames
        // étaient jetées en `unknown` → le boîtier restait invisible bien que vivant.
        if (!currentImei || frame.imei !== currentImei) break;
        this.registry.touch(frame.imei);
        // `lastNoFixAt` : marque que le boitier tente ACTIVEMENT de reporter mais SANS
        // lock GPS. Couple a un `lastPositionAt` perime, c'est la preuve « GPS perdu »
        // (antenne / ciel) — cf. Tracker.lastNoFixAt + getVehicleConnectivityState.
        await this.prisma.tracker.update({
          where: { imei: frame.imei },
          data: { lastSeenAt: new Date(), lastNoFixAt: new Date() },
        });
        this.logger.debug({ imei: frame.imei, frameRaw: frame.raw }, `No-fix frame (vivant, sans GPS): ${frame.imei}`);
        break;
      }

      case 'unknown': {
        if (currentImei && this.ackWaiter.tryMatch(currentImei, frame.raw)) {
          break;
        }
        this.logger.warn({ imei: currentImei, reason: frame.reason, frameRaw: frame.raw }, `Unknown frame`);
        break;
      }
    }
  }
}

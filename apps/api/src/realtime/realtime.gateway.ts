import type { UserPermissions, UserRoleSlug } from '@vizyo/tracky-shared';
import { getDefaultPermissions } from '@vizyo/tracky-shared';
import { Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { AlertEvent, EngineCommandUpdatedEvent, GeofenceViolationEvent, PositionUpdateEvent, TrackerStatusChangedDto, TripStartedEvent, TripCompletedEvent, VehicleMovementEvent } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import type { Alert, Vehicle, Tracker } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';

// V1.10 (Sprint 6) — Le Redis adapter est branche au niveau IoAdapter custom
// dans main.ts (RedisIoAdapter). Plus de hook afterInit ici : la signature
// `server.adapter()` n'est pas disponible sur le namespace server quand on
// utilise un @WebSocketGateway avec namespace, il faut le faire sur le main
// Socket.io Server via IoAdapter.createIOServer.

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200', credentials: true },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}


  /**
   * Ce raccordement a-t-il le droit de recevoir des alertes ?
   *
   * Semantique IDENTIQUE au reste du produit : defauts du role, surcharges par
   * `User.permissions`. On ne consulte PAS `UserVehicleAccess` ici — l'adhesion a un
   * salon se decide une fois, alors que le perimetre depend du vehicule de chaque alerte.
   *
   * ⚠️ En cas de doute (compte introuvable, lecture en echec) on REFUSE : une panne ne
   * doit jamais elargir l'audience d'une alerte qui porte une position.
   */
  private async mayViewAlerts(user: { id: string; role?: string }): Promise<boolean> {
    if (user.role === 'SUPER_ADMIN' || user.role === 'FLEET_ADMIN') return true;
    try {
      const row = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { role: true, permissions: true },
      });
      if (!row) return false;
      const defaults = getDefaultPermissions(row.role as UserRoleSlug);
      const explicit = row.permissions as Partial<UserPermissions> | null;
      return (explicit ? { ...defaults, ...explicit } : defaults).alerts_view === true;
    } catch (err) {
      this.logger.warn(
        `[ws] verification alerts_view impossible pour ${user.id.slice(0, 8)} — salon d'alerte refuse: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) {
        this.logger.warn(`Client ${client.id} rejected: no token`);
        client.disconnect();
        return;
      }

      const payload = this.auth.verifyAccessToken(token);
      const localUser = await this.auth.resolveLocalUser(payload.sub);

      // #13 — memorise l'userId sur la socket pour la revalidation periodique
      // (un user suspendu/supprime ne doit pas continuer a recevoir le live).
      (client.data as { userId?: string }).userId = localUser.id;

      // Sprint 3 — split des rooms (enforced serveur) :
      //  - positions LIVE → `pos:fleet:*` ;
      //  - confirmation moteur S2 + statut tracker → AUSSI `ops:fleet:*` ;
      //  - alertes / géofences / trajets (qui PORTENT lat/lng/vitesse) → `fleet:*`.
      // Le veilleur de nuit ne rejoint QUE `ops:fleet:*` : il reçoit la confirmation moteur
      // + le statut tracker, mais AUCUNE position (ni live `pos:*`, ni via les events `fleet:*`).
      const isWatchman = localUser.role === 'NIGHT_WATCHMAN';

      if (localUser.role === 'SUPER_ADMIN') {
        client.join('fleet:*');
        client.join('pos:fleet:*');
      }

      if (localUser.fleetId) {
        if (isWatchman) {
          client.join(`ops:fleet:${localUser.fleetId}`);
        } else {
          client.join(`fleet:${localUser.fleetId}`);
          client.join(`pos:fleet:${localUser.fleetId}`);
        }
      }

      // ══ SALON DEDIE AUX ALERTES ═══════════════════════════════════════════════
      //
      // Le salon `fleet:<id>` porte SEPT familles d'evenements (mouvement, statut du
      // boitier, geofence, trajets, commandes moteur, alertes...). Le quitter pour
      // proteger les alertes priverait de tout le reste.
      //
      // Les alertes sont donc emises dans un salon a part, rejoint uniquement par qui a
      // `alerts_view`. Constat de l'audit du 2026-08-02 : un DRIVER (`alerts_view: false`
      // par defaut) rejoignait `fleet:<id>` et recevait titre, plaque, LATITUDE et
      // LONGITUDE de chaque alerte — alors que `GET /alerts` lui repond 403. La meme
      // alerte etait filtree en HTTP et servie sans controle en temps reel.
      //
      // ⚠️ Le perimetre VEHICULE n'est pas applicable ici : l'adhesion se decide une fois,
      // au raccordement, alors que le perimetre depend du vehicule de chaque alerte. Le
      // filtrage fin se fait donc a l'EMISSION (voir `broadcastAlert`).
      const canSeeAlerts = await this.mayViewAlerts(localUser);
      if (canSeeAlerts) {
        if (localUser.role === 'SUPER_ADMIN') client.join('alerts:fleet:*');
        if (localUser.fleetId) client.join(`alerts:fleet:${localUser.fleetId}`);
      } else {
        this.logger.debug(
          `Client ${client.id} (${localUser.email}) n'a pas alerts_view — aucun salon d'alerte`,
        );
      }

      this.logger.debug(`Client ${client.id} authenticated (${localUser.email}, fleet=${localUser.fleetId})`);
    } catch (err) {
      this.logger.warn(`Client ${client.id} rejected: ${err instanceof Error ? err.message : 'invalid token'}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * #13 — Revalidation periodique des connexions WS. L'auth n'etait verifiee QU'au
   * handshake : un user SUSPENDU (isActive=false) ou SUPPRIME continuait de recevoir
   * le live de sa flotte tant que sa socket tenait. Toutes les 60s on coupe les
   * sockets dont l'user n'est plus actif (1 requete DB sur les userIds connectes,
   * en local a cette instance).
   *
   * Choix delibere : on NE deconnecte PAS sur simple expiration du token. L'user
   * reste legitime ; le forcer a se reconnecter a chaque TTL creerait du churn et
   * de faux incidents "connexion temps reel interrompue". La revocation d'acces se
   * traduit par isActive=false (gere ici) ou la suppression du compte.
   */
  @Interval(60_000)
  async revalidateConnections(): Promise<void> {
    // Garde anti unhandled-rejection : un blip DB (findMany) ne doit pas faire
    // rejeter ce cron qui tourne toutes les 60s. On log et on retente au tick suivant.
    try {
      const ns = this.server as unknown as { sockets?: Map<string, Socket> };
      const sockets = ns.sockets;
      if (!sockets || sockets.size === 0) return;

      const byUser = new Map<string, Socket[]>();
      for (const [, socket] of sockets) {
        const userId = (socket.data as { userId?: string } | undefined)?.userId;
        if (!userId) continue;
        const list = byUser.get(userId) ?? [];
        list.push(socket);
        byUser.set(userId, list);
      }
      if (byUser.size === 0) return;

      const activeUsers = await this.prisma.user.findMany({
        where: { id: { in: [...byUser.keys()] }, isActive: true },
        select: { id: true },
      });
      const stillActive = new Set(activeUsers.map((u) => u.id));

      for (const [userId, userSockets] of byUser) {
        if (stillActive.has(userId)) continue;
        for (const socket of userSockets) {
          this.logger.warn(`Revalidation WS: deconnexion ${socket.id} (user ${userId} inactif/supprime)`);
          socket.disconnect();
        }
      }
    } catch (err) {
      this.logger.warn(`revalidateConnections: tick ignore (${err instanceof Error ? err.message : err})`);
    }
  }

  /**
   * Emit a single POSITION_UPDATE immediately (legacy path).
   *
   * Most callers should go through `PositionBroadcastBuffer.enqueue()` which
   * coalesces 1s windows into POSITIONS_BATCH events. The immediate path is
   * kept for explicit cases (alerts, geofence violations linked to a position).
   */
  broadcastPosition(fleetId: string, payload: PositionUpdateEvent): void {
    // Sprint 3 — positions live sur la room dédiée `pos:fleet:*` (le veilleur n'y est pas).
    this.server.to(`pos:fleet:${fleetId}`).to('pos:fleet:*').emit(WS_EVENTS.POSITION_UPDATE, payload);
  }

  /**
   * Fix veilleur — diffuse une transition « en mouvement » (booléen, aucune position)
   * vers `ops:fleet:*` (où siège le veilleur) + les rooms flotte classiques. Permet au
   * client veilleur — privé de toute position — de griser le bouton « Couper » quand le
   * véhicule roule. Le garde serveur (engine-control.service) reste le rempart final.
   */
  emitVehicleMovement(fleetId: string, payload: VehicleMovementEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').to(`ops:fleet:${fleetId}`).emit(WS_EVENTS.VEHICLE_MOVEMENT, payload);
  }

  emitTrackerStatus(fleetId: string, payload: TrackerStatusChangedDto): void {
    // Sprint 3 — aussi vers `ops:fleet:*` : le veilleur (hors `fleet:*`) a besoin du statut tracker (badge connectivité).
    this.server.to(`fleet:${fleetId}`).to('fleet:*').to(`ops:fleet:${fleetId}`).emit(WS_EVENTS.TRACKER_STATUS, payload);
  }

  broadcastAlert(alert: Alert & { vehicle?: Vehicle | null; tracker?: Tracker | null }): void {
    const payload = (alert.payload ?? {}) as Record<string, unknown>;
    const event: AlertEvent = {
      id: alert.id,
      fleetId: alert.fleetId,
      vehicleId: alert.vehicleId,
      trackerId: alert.trackerId,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      latitude: alert.latitude,
      longitude: alert.longitude,
      createdAt: alert.createdAt.toISOString(),
      vehiclePlate: (alert as any).vehicle?.plate,
      speedKmh: typeof payload['speedKmh'] === 'number' ? payload['speedKmh'] : undefined,
    };
    // Salon DEDIE : seuls les raccordements portant `alerts_view` y sont.
    this.server.to(`alerts:fleet:${alert.fleetId}`).to('alerts:fleet:*').emit(WS_EVENTS.ALERT_NEW, event);
  }

  broadcastAlertAcknowledged(alert: Alert): void {
    this.server
      .to(`alerts:fleet:${alert.fleetId}`)
      .to('alerts:fleet:*')
      .emit(WS_EVENTS.ALERT_ACK, {
        id: alert.id,
        acknowledgedAt: alert.acknowledgedAt?.toISOString(),
        acknowledgedBy: alert.acknowledgedBy,
      });
  }

  broadcastGeofenceViolation(fleetId: string, event: GeofenceViolationEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.GEOFENCE_VIOLATION, event);
  }

  emitTripStarted(fleetId: string, event: TripStartedEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.TRIP_STARTED, event);
  }

  emitTripCompleted(fleetId: string, event: TripCompletedEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.TRIP_COMPLETED, event);
  }

  emitEngineCommandUpdate(fleetId: string, payload: EngineCommandUpdatedEvent): void {
    // Sprint 3 — aussi vers `ops:fleet:*` : le veilleur (hors `fleet:*`) doit recevoir la confirmation moteur S2.
    this.server.to(`fleet:${fleetId}`).to('fleet:*').to(`ops:fleet:${fleetId}`).emit(WS_EVENTS.ENGINE_COMMAND_UPDATED, payload);
  }
}

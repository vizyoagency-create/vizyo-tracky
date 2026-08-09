import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
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
import { DepotScopeService } from '../depot/depot-scope.service';
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
    private readonly vehicleAccess: VehicleAccessService,
    // Espace dépôt (2026-08) — résout les missions dont le suivi est actif, pour
    // décider des salons `depot:mission:<id>`. DepotModule est @Global.
    private readonly depotScope: DepotScopeService,
  ) {}


  // ⚠️ NE JAMAIS INSERER DE METHODE ENTRE UN DECORATEUR ET SA METHODE.
  // Un bloc glisse sous `@Interval(60_000)` a fait que l'ordonnanceur appelait CE
  // CALCUL toutes les 60 s — sans arguments — et que `revalidateConnections` ne
  // tournait plus du tout. Le symptome (« not iterable ») pointait vers la valeur,
  // pas vers la cause. Un decorateur doit toucher la methode qu'il decore.
  /**
   * Tout ce qui decide des salons d'un raccordement, condense en une chaine comparable.
   *
   * ⚠️ Le perimetre vehicule est TRIE : `getAccessibleVehicleIds` ne garantit pas
   * d'ordre stable, et une simple permutation ferait croire a un changement — on
   * deconnecterait alors tout le monde a chaque tick, en boucle.
   */
  private scopeKey(
    user: { role: string; fleetId: string | null },
    accessible: string[] | 'ALL',
    canSeeAlerts: boolean,
  ): string {
    // ⚠️ DEFENSIF, apres un incident en production (2026-08-02) : `[...accessible]` a
    // leve « accessible is not iterable » a chaque tick, ce qui faisait echouer TOUTE la
    // revalidation — y compris la deconnexion des comptes desactives, qui fonctionnait
    // avant. Un garde-fou ajoute ne doit jamais casser celui qu'il complete.
    //
    // On ne fait donc plus confiance a la forme de la valeur : tout ce qui n'est ni
    // `'ALL'` ni un tableau est traite comme un perimetre INCONNU. L'empreinte devient
    // alors instable a dessein ? Non : on renvoie un marqueur STABLE, sinon on
    // deconnecterait tout le monde en boucle. Et on trace, pour ne pas remplacer un
    // plantage par un silence.
    let scope: string;
    if (accessible === 'ALL') {
      scope = 'ALL';
    } else if (Array.isArray(accessible)) {
      // TRI obligatoire : l'ordre n'est pas garanti, et une permutation ferait croire a
      // un changement — donc une deconnexion generale a chaque tick.
      scope = [...accessible].sort().join(',');
    } else {
      this.logger.warn(
        `[ws] perimetre de forme inattendue (${typeof accessible}) pour ${user.role} — empreinte neutralisee`,
      );
      scope = 'INCONNU';
    }
    return `${user.role}|${user.fleetId ?? '-'}|${canSeeAlerts ? 'A' : '-'}|${scope}`;
  }

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

  /**
   * Raccordements au perimetre RESTREINT, par flotte.
   *
   * Ils ne sont dans aucun salon de flotte : c'est ce registre qui les sert, filtres.
   * Une `Map` par flotte evite de balayer toutes les sockets a chaque position.
   */
  private readonly restrictedByFleet = new Map<string, Map<string, { socket: Socket; allowed: Set<string> }>>();

  private registerRestricted(client: Socket, fleetId: string, allowed: string[]): void {
    let byFleet = this.restrictedByFleet.get(fleetId);
    if (!byFleet) {
      byFleet = new Map();
      this.restrictedByFleet.set(fleetId, byFleet);
    }
    byFleet.set(client.id, { socket: client, allowed: new Set(allowed) });
    (client.data as { restrictedFleetId?: string }).restrictedFleetId = fleetId;
    this.logger.debug(
      `Client ${client.id} au perimetre restreint (${allowed.length} vehicule(s)) — hors salons de flotte`,
    );
  }

  private unregisterRestricted(client: Socket): void {
    const fleetId = (client.data as { restrictedFleetId?: string }).restrictedFleetId;
    if (!fleetId) return;
    const byFleet = this.restrictedByFleet.get(fleetId);
    if (!byFleet) return;
    byFleet.delete(client.id);
    // Sans ce nettoyage, la Map de flotte grossirait indefiniment au fil des
    // reconnexions — une fuite memoire lente, invisible jusqu'a l'incident.
    if (byFleet.size === 0) this.restrictedByFleet.delete(fleetId);
  }

  /**
   * Perimetre vehicule d'un raccordement. `'ALL'` = aucune restriction PAR VEHICULE.
   *
   * ⚠️ En cas d'echec de lecture on renvoie une liste VIDE, pas `'ALL'` : une panne ne
   * doit jamais elargir ce qu'un compte recoit. Le pire cas est un ecran sans live,
   * visible immediatement, jamais une fuite silencieuse.
   */
  private async resolveAccessibleVehicles(user: { id: string; role: string; fleetId: string | null }): Promise<string[] | 'ALL'> {
    try {
      return await this.vehicleAccess.getAccessibleVehicleIds(user as never);
    } catch (err) {
      this.logger.warn(
        `[ws] perimetre vehicule illisible pour ${user.id.slice(0, 8)} — aucun live: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  /**
   * Emission d'un evenement portant UN vehicule, vers le salon collectif ET les
   * raccordements restreints qui ont droit a ce vehicule.
   */
  private emitScoped(fleetId: string, vehicleId: string | null | undefined, event: string, payload: unknown, rooms: string[]): void {
    let chain = this.server.to(rooms[0]!);
    for (const r of rooms.slice(1)) chain = chain.to(r);
    chain.emit(event, payload);

    if (!vehicleId) return; // sans vehicule, rien a cibler : le salon a deja servi
    const byFleet = this.restrictedByFleet.get(fleetId);
    if (!byFleet) return;
    for (const { socket, allowed } of byFleet.values()) {
      if (allowed.has(vehicleId)) socket.emit(event, payload);
    }
  }

  /**
   * Lot de positions : le salon recoit TOUT, chaque raccordement restreint recoit SA
   * part. Un lot ne peut pas passer par des salons par vehicule — il en contient
   * plusieurs — d'ou ce filtrage socket par socket, qui ne s'applique qu'aux comptes
   * restreints (rares).
   */
  emitPositionsBatch(fleetId: string, positions: Array<{ vehicleId?: string | null }>): void {
    this.server
      .to(`pos:fleet:${fleetId}`)
      .to('pos:fleet:*')
      .emit(WS_EVENTS.POSITIONS_BATCH, { fleetId, positions });

    const byFleet = this.restrictedByFleet.get(fleetId);
    if (!byFleet || byFleet.size === 0) return;
    for (const { socket, allowed } of byFleet.values()) {
      const mine = positions.filter((p) => p.vehicleId && allowed.has(p.vehicleId));
      // On n'envoie pas un lot vide : ce serait du bruit reseau a chaque seconde pour
      // un compte qui ne suit aucun des vehicules qui bougent.
      if (mine.length > 0) socket.emit(WS_EVENTS.POSITIONS_BATCH, { fleetId, positions: mine });
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

      // ══ ESPACE DEPOT (2026-08) — SALONS PAR MISSION, ET RIEN D'AUTRE ══════════
      //
      // Un DEPOT ne rejoint QUE `depot:mission:<missionId>`, une par mission dont le
      // suivi est actif MAINTENANT. Jamais `fleet:*`, `pos:fleet:*`, `ops:fleet:*`
      // ni `alerts:fleet:*` (A1 § 3, regle 5).
      //
      // ⚠️ Cette branche est un ARRET NET, volontairement place avant toute autre
      // logique. Aujourd'hui un depot serait de toute facon exclu des salons de
      // flotte : sans ligne `UserVehicleAccess`, `getAccessibleVehicleIds` renvoie
      // `[]`, donc `restricted` vaut true et il finit dans le registre avec un
      // ensemble vide. Mais ce serait une isolation ACCIDENTELLE — elle tient a une
      // propriete d'un autre service, qui n'a jamais eu le depot en tete. Le jour ou
      // ce service changerait (un defaut « aucune regle = tout voir », par exemple),
      // le depot entrerait dans les salons de flotte sans qu'aucun test ne s'en
      // apercoive. On ecrit donc l'exclusion, plutot que d'en heriter.
      if (localUser.role === 'DEPOT') {
        const missionIds = await this.depotScope.activeMissionIds(localUser.id);
        for (const id of missionIds) client.join(`depot:mission:${id}`);
        // L'empreinte porte les missions : quand l'une se termine ou qu'une autre
        // demarre, le tick de revalidation coupe la socket et le client se reconnecte
        // sur les bons salons. C'est ce qui garantit qu'un socket ouvert AVANT `endAt`
        // ne continue pas de recevoir apres (A1 § 8, test 10).
        (client.data as { scopeKey?: string }).scopeKey = `DEPOT|${missionIds.sort().join(',')}`;
        this.logger.debug(
          `Client ${client.id} (depot ${localUser.email}) — ${missionIds.length} mission(s) suivie(s), aucun salon de flotte`,
        );
        return;
      }

      if (localUser.role === 'SUPER_ADMIN') {
        client.join('fleet:*');
        client.join('pos:fleet:*');
      }

      // ══ PERIMETRE PAR VEHICULE ════════════════════════════════════════════════
      //
      // Les salons de flotte diffusent a TOUS leurs membres. Un gestionnaire limite a
      // 2 vehicules y recevait donc, en continu, la latitude et la longitude des 28
      // autres — alors que l'API HTTP, elle, les lui refuse. Le masquage existait
      // uniquement dans le navigateur (`map.component.ts`), c'est-a-dire APRES que la
      // donnee soit arrivee : visible dans l'onglet reseau, et absent pendant le
      // chargement initial.
      //
      // Regle : un compte au perimetre RESTREINT n'entre PAS dans les salons de flotte.
      // Il est enregistre a part et recoit des lots filtres, socket par socket. Les
      // comptes a perimetre complet — l'immense majorite — gardent le chemin collectif,
      // qui ne coute rien.
      const accessible = await this.resolveAccessibleVehicles(localUser);
      const restricted = accessible !== 'ALL';

      if (localUser.fleetId) {
        if (isWatchman) {
          // Le veilleur ne recoit aucune position : son salon n'en porte pas.
          client.join(`ops:fleet:${localUser.fleetId}`);
        } else if (restricted) {
          this.registerRestricted(client, localUser.fleetId, accessible);
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
        // Un compte restreint est servi par `emitScoped` (registre), pas par le salon :
        // une alerte porte un vehicule, donc elle se filtre.
        if (localUser.fleetId && !restricted) client.join(`alerts:fleet:${localUser.fleetId}`);
      } else {
        this.logger.debug(
          `Client ${client.id} (${localUser.email}) n'a pas alerts_view — aucun salon d'alerte`,
        );
      }

      // ══ EMPREINTE DU PERIMETRE ════════════════════════════════════════════════
      //
      // Les salons sont decides UNE FOIS, au raccordement. La revalidation periodique
      // ne verifiait que `isActive` : deplacer un utilisateur d'une societe a l'autre,
      // lui retirer `alerts_view` ou restreindre son acces vehicule ne changeait RIEN
      // tant que son onglet restait ouvert. Il continuait de recevoir l'ancien perimetre,
      // parfois pendant des jours.
      //
      // On memorise donc ce qui a DECIDE des salons. Au tick suivant, si l'empreinte a
      // bouge, on coupe la socket : le client se reconnecte et rejoint les bons salons.
      // Recalculer les salons en place serait plus subtil et plus fragile — il faudrait
      // quitter les anciens sans en oublier un, et un oubli serait une fuite.
      (client.data as { scopeKey?: string }).scopeKey = this.scopeKey(localUser, accessible, canSeeAlerts);

      this.logger.debug(`Client ${client.id} authenticated (${localUser.email}, fleet=${localUser.fleetId})`);
    } catch (err) {
      this.logger.warn(`Client ${client.id} rejected: ${err instanceof Error ? err.message : 'invalid token'}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    // Sans ce retrait, le registre des raccordements restreints grossirait a chaque
    // reconnexion : une fuite memoire lente, et des emissions vers des sockets mortes.
    this.unregisterRestricted(client);
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

      // On charge desormais AUSSI le role, la societe et les permissions : ce sont eux
      // qui decident des salons, et leur changement doit couper la socket.
      const activeUsers = await this.prisma.user.findMany({
        where: { id: { in: [...byUser.keys()] }, isActive: true },
        select: { id: true, role: true, fleetId: true, permissions: true },
      });
      const stillActive = new Set(activeUsers.map((u) => u.id));
      const byId = new Map(activeUsers.map((u) => [u.id, u]));

      for (const [userId, userSockets] of byUser) {
        if (!stillActive.has(userId)) {
          for (const socket of userSockets) {
            this.logger.warn(`Revalidation WS: deconnexion ${socket.id} (user ${userId} inactif/supprime)`);
            socket.disconnect();
          }
          continue;
        }

        // Le compte est toujours actif — mais son PERIMETRE a-t-il bouge ?
        //
        // ⚠️ ISOLE PAR UTILISATEUR. Sans ce try, une seule anomalie sur un seul compte
        // faisait echouer TOUT le tick — y compris la deconnexion des comptes desactives,
        // qui fonctionnait avant. C'est exactement ce qui s'est produit en production le
        // 2026-08-02 : le garde-fou ajoute a casse celui qu'il devait completer.
        let key: string;
        try {
          const row = byId.get(userId)!;
          const current = { id: userId, role: String(row.role), fleetId: row.fleetId };
          const accessible = await this.resolveAccessibleVehicles(current);
          const perms = row.permissions as { alerts_view?: boolean } | null;
          const canSeeAlerts =
            current.role === 'SUPER_ADMIN' || current.role === 'FLEET_ADMIN'
              ? true
              : perms?.alerts_view === true;
          key = this.scopeKey(current, accessible, canSeeAlerts);
        } catch (err) {
          // On ne coupe PAS sur une erreur de calcul : deconnecter sur un doute
          // transformerait un incident de lecture en interruption de service.
          this.logger.warn(
            `[ws] empreinte de perimetre incalculable pour ${userId.slice(0, 8)} — socket conservee: ${err instanceof Error ? err.message : err}`,
          );
          continue;
        }

        for (const socket of userSockets) {
          const previous = (socket.data as { scopeKey?: string }).scopeKey;
          // Une socket sans empreinte vient d'une version anterieure du serveur : on la
          // laisse vivre plutot que de deconnecter tout le monde au premier deploiement.
          if (previous === undefined || previous === key) continue;
          this.logger.warn(
            `Revalidation WS: deconnexion ${socket.id} (perimetre modifie pour ${userId}) — le client se reconnectera sur les bons salons`,
          );
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
    this.emitScoped(fleetId, (payload as { vehicleId?: string }).vehicleId, WS_EVENTS.POSITION_UPDATE, payload, [
      `pos:fleet:${fleetId}`,
      'pos:fleet:*',
    ]);
  }

  /**
   * Fix veilleur — diffuse une transition « en mouvement » (booléen, aucune position)
   * vers `ops:fleet:*` (où siège le veilleur) + les rooms flotte classiques. Permet au
   * client veilleur — privé de toute position — de griser le bouton « Couper » quand le
   * véhicule roule. Le garde serveur (engine-control.service) reste le rempart final.
   */
  emitVehicleMovement(fleetId: string, payload: VehicleMovementEvent): void {
    this.emitScoped(fleetId, (payload as { vehicleId?: string }).vehicleId, WS_EVENTS.VEHICLE_MOVEMENT, payload, [
      `fleet:${fleetId}`,
      'fleet:*',
      `ops:fleet:${fleetId}`,
    ]);
  }

  emitTrackerStatus(fleetId: string, payload: TrackerStatusChangedDto): void {
    // Sprint 3 — aussi vers `ops:fleet:*` : le veilleur (hors `fleet:*`) a besoin du statut tracker (badge connectivité).
    this.emitScoped(fleetId, (payload as { vehicleId?: string }).vehicleId, WS_EVENTS.TRACKER_STATUS, payload, [
      `fleet:${fleetId}`,
      'fleet:*',
      `ops:fleet:${fleetId}`,
    ]);
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
    // Salon DEDIE (`alerts_view`) + raccordements restreints ayant droit a CE vehicule.
    this.emitScoped(alert.fleetId, alert.vehicleId, WS_EVENTS.ALERT_NEW, event, [
      `alerts:fleet:${alert.fleetId}`,
      'alerts:fleet:*',
    ]);
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
    this.emitScoped(fleetId, (event as { vehicleId?: string }).vehicleId, WS_EVENTS.GEOFENCE_VIOLATION, event, [
      `fleet:${fleetId}`,
      'fleet:*',
    ]);
  }

  emitTripStarted(fleetId: string, event: TripStartedEvent): void {
    this.emitScoped(fleetId, (event as { vehicleId?: string }).vehicleId, WS_EVENTS.TRIP_STARTED, event, [
      `fleet:${fleetId}`,
      'fleet:*',
    ]);
  }

  emitTripCompleted(fleetId: string, event: TripCompletedEvent): void {
    this.emitScoped(fleetId, (event as { vehicleId?: string }).vehicleId, WS_EVENTS.TRIP_COMPLETED, event, [
      `fleet:${fleetId}`,
      'fleet:*',
    ]);
  }

  emitEngineCommandUpdate(fleetId: string, payload: EngineCommandUpdatedEvent): void {
    // Sprint 3 — aussi vers `ops:fleet:*` : le veilleur (hors `fleet:*`) doit recevoir la confirmation moteur S2.
    this.emitScoped(fleetId, (payload as { vehicleId?: string }).vehicleId, WS_EVENTS.ENGINE_COMMAND_UPDATED, payload, [
      `fleet:${fleetId}`,
      'fleet:*',
      `ops:fleet:${fleetId}`,
    ]);
  }
}

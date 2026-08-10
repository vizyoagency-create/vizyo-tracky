import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  DepotLiveDto,
  DepotMissionDto,
  DepotPositionDto,
  DepotPositionUnavailableDto,
} from '@vizyo/tracky-shared';
import { WS_EVENTS, type DepotMissionEndedEvent, type DepotMissionPositionEvent } from '@vizyo/tracky-shared';
import { io, type Socket } from 'socket.io-client';
import { swallow } from '../../core/error/swallow';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DepotApiService } from './depot-api.service';

/**
 * Espace dépôt (2026-08) — l'état vivant de la carte (A3 § 1, « Rafraîchissement »).
 *
 * ┌─ DEUX CANAUX, UNE SEULE VÉRITÉ ───────────────────────────────────────────┐
 * │ Le WebSocket porte les positions ; le polling est son FILET, pas son égal. │
 * │ Il ne démarre que si le socket tombe, et s'arrête dès qu'il revient — sinon │
 * │ deux sources écriraient le même signal dans un ordre indéterminé, et un    │
 * │ marqueur reculerait de temps en temps sans que personne comprenne pourquoi.│
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * L'indicateur « rafraîchie il y a 12 s » est un VRAI compteur : il part de l'heure
 * du dernier message reçu, pas d'un texte figé au chargement. Un compteur qui ment
 * est pire qu'un compteur absent — il donne confiance dans une donnée périmée.
 */

/** Repli quand le socket est tombé. La spec dit 20 s. */
const PERIODE_POLLING_MS = 20_000;
/**
 * Relecture COMPLÈTE, socket connecté ou non.
 *
 * L'événement de position ne porte pas les bascules de statut (IN_PROGRESS → LATE),
 * ni la distance restante, ni l'arrivée d'une nouvelle mission. Sans ce battement
 * lent, un dépôt resté une heure sur sa carte lirait un statut d'il y a une heure —
 * en direct, et donc sans s'en méfier.
 */
const PERIODE_RELECTURE_MS = 60_000;
/** Au-delà, on annonce la coupure plutôt que de laisser croire au direct. */
const SILENCE_MAX_MS = 60_000;
/** Cadence du compteur de fraîcheur affiché. */
const TIC_MS = 1_000;
/** Relance après une coupure décidée par le serveur (recalcul des salons). */
const DELAI_RELANCE_MS = 800;
/** Garde anti-boucle : si le serveur nous éjecte en rafale, on s'arrête au polling. */
const MAX_RELANCES = 8;

@Injectable({ providedIn: 'root' })
export class DepotLiveStore {
  private readonly api = inject(DepotApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  readonly chargement = signal(true);
  readonly carrierName = signal('');
  readonly depotName = signal('');
  readonly missions = signal<DepotMissionDto[]>([]);
  readonly positions = signal<DepotPositionDto[]>([]);
  /** missionId → l'indisponibilité, avec sa RAISON : un boîtier muet et un suivi
   *  suspendu ne se disent pas de la même façon (A3 § 8). */
  readonly indisponibles = signal<Map<string, DepotPositionUnavailableDto>>(new Map());
  readonly otherVehiclesCount = signal(0);

  /** Horodatage du dernier message reçu, quel que soit le canal. */
  readonly dernierMessageAt = signal<number>(Date.now());
  /** Ré-évalué chaque seconde : c'est lui qui rend le compteur honnête. */
  private readonly maintenant = signal(Date.now());
  readonly socketConnecte = signal(false);

  /** Dernière mission close PENDANT la consultation. L'écran s'en sert pour retirer
   *  sa sélection ; l'annonce, elle, est faite par le store (cf. le gestionnaire). */
  readonly derniereFin = signal<DepotMissionEndedEvent | null>(null);

  readonly secondesDepuisMaj = computed(() =>
    Math.max(0, Math.floor((this.maintenant() - this.dernierMessageAt()) / 1000)),
  );

  /**
   * « Connexion perdue · nouvelle tentative » — au-delà de 60 s sans le moindre
   * message. Pas « socket déconnecté » : le dépôt ne sait pas ce qu'est un socket,
   * et le repli en polling peut très bien continuer de le servir.
   */
  readonly connexionPerdue = computed(
    () => this.maintenant() - this.dernierMessageAt() > SILENCE_MAX_MS,
  );

  readonly camionsEnMission = computed(
    () => this.missions().filter((m) => m.status === 'IN_PROGRESS' || m.status === 'LATE').length,
  );

  private socket: Socket | null = null;
  private timerPolling: ReturnType<typeof setInterval> | null = null;
  private timerRelecture: ReturnType<typeof setInterval> | null = null;
  private timerTic: ReturnType<typeof setInterval> | null = null;
  private abonnes = 0;
  /** Relances consécutives après une coupure serveur. Remis à zéro à la reconnexion. */
  private relances = 0;
  /** Verrou : l'accès retiré ne se traite qu'une fois, même si trois lectures échouent. */
  private sessionCoupee = false;

  /** Chaque écran s'abonne ; le dernier à partir coupe les canaux. Sans ce compteur,
   *  passer de la carte à Missions couperait le direct puis le rouvrirait. */
  async demarrer(): Promise<void> {
    this.abonnes += 1;
    if (this.abonnes === 1) {
      this.timerTic = setInterval(() => this.maintenant.set(Date.now()), TIC_MS);
      this.timerRelecture = setInterval(() => void this.recharger(), PERIODE_RELECTURE_MS);
      this.brancherSocket();
    }
    await this.recharger();
  }

  arreter(): void {
    this.abonnes = Math.max(0, this.abonnes - 1);
    if (this.abonnes > 0) return;
    this.arreterTout();
  }

  private arreterTout(): void {
    this.abonnes = 0;
    this.socket?.disconnect();
    this.socket = null;
    this.socketConnecte.set(false);
    if (this.timerPolling) clearInterval(this.timerPolling);
    if (this.timerRelecture) clearInterval(this.timerRelecture);
    if (this.timerTic) clearInterval(this.timerTic);
    this.timerPolling = null;
    this.timerRelecture = null;
    this.timerTic = null;
  }

  /**
   * Garantit que la MARQUE DU TRANSPORTEUR est connue, sans ouvrir le direct.
   *
   * L'en-tête du menu porte le nom du transporteur (A3 § 7, règle 5) — mais seuls la
   * carte et l'onglet Missions ouvrent le flux live. Un dépôt qui arrive directement
   * sur `/depot/history` (lien d'e-mail, favori) lisait donc un repli neutre à la
   * place de la marque, sur l'écran même qui doit lui appartenir visuellement.
   *
   * Une seule lecture, et seulement si le nom manque : pas de socket, pas de timer.
   */
  async assurerMarque(): Promise<void> {
    if (this.carrierName()) return;
    await this.recharger();
  }

  async recharger(): Promise<void> {
    try {
      const live = await this.api.live();
      this.appliquer(live);
    } catch (err) {
      swallow('depot-live:recharger', err);
      // « Votre accès a été retiré par votre transporteur » (A3 § 6).
      //
      // Un dépôt dont le compte est désactivé ou dont les missions ont toutes été
      // réaffectées reçoit un 403 sur CHAQUE lecture. Sans ce traitement, il resterait
      // devant une page qui charge sans fin — et appellerait son transporteur pour
      // signaler une panne qui n'en est pas une. On coupe la session et on dit
      // pourquoi : c'est une décision de son transporteur, pas un incident.
      if (this.api.accesRetire()) this.couperSession();
    } finally {
      this.chargement.set(false);
    }
  }

  private couperSession(): void {
    if (this.sessionCoupee) return;
    this.sessionCoupee = true;
    this.arreterTout();
    this.toast.show({
      kind: 'warning',
      title: 'Votre accès a été retiré',
      message: 'Votre transporteur a fermé cet accès. Contactez-le pour le rétablir.',
      duration: 0,
    });
    // Un délai court : le message doit être LU avant que la page de connexion le
    // remplace. Sans lui, le dépôt voit un écran de login sans savoir pourquoi.
    setTimeout(() => this.auth.logout(), 4000);
  }

  private appliquer(live: DepotLiveDto): void {
    this.carrierName.set(live.carrierName);
    this.depotName.set(live.depotName);
    this.missions.set(live.missions);
    this.positions.set(live.positions);
    this.indisponibles.set(new Map(live.unavailable.map((u) => [u.missionId, u])));
    this.otherVehiclesCount.set(live.otherVehiclesCount);
    // L'heure SERVEUR, pas `Date.now()` : une horloge de poste qui dérive de deux
    // minutes afficherait « rafraîchie il y a 2 min » sur une donnée fraîche.
    this.dernierMessageAt.set(new Date(live.serverTime).getTime());
  }

  /**
   * Le socket rejoint `depot:mission:<id>` côté serveur — le client ne demande aucun
   * salon. C'est la moitié qui compte : un client qui choisirait ses salons pourrait
   * en demander d'autres.
   */
  private brancherSocket(): void {
    const token = this.auth.token;
    if (!token) return;

    // `tryAllTransports` : sans lui, socket.io-client ≥ 4.8 abandonne dès que
    // l'upgrade WebSocket échoue au lieu de replier sur le polling long — le live
    // tombe en totalité derrière un proxy capricieux (leçon Sprint 0.1).
    this.socket = io('/realtime', {
      auth: { token },
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnection: true,
    });

    this.socket.on('connect', () => {
      this.socketConnecte.set(true);
      this.relances = 0;
      this.dernierMessageAt.set(Date.now());
      this.arreterPolling();
      // Une reconnexion a pu manquer des bascules de statut : on relit l'état complet
      // plutôt que de repartir d'un état qui a vieilli hors ligne.
      void this.recharger();
    });

    this.socket.on('disconnect', (raison: string) => {
      this.socketConnecte.set(false);
      this.demarrerPolling();
      // ⚠️ COUPURE INITIÉE PAR LE SERVEUR — socket.io ne se reconnecte PAS tout seul
      // dans ce cas (règle du client), et c'est le cas NORMAL pour un dépôt : A1
      // coupe le raccordement dès qu'une mission entre ou sort de sa fenêtre, pour
      // que les salons soient recalculés. Sans cette relance explicite, le direct
      // s'arrête définitivement à la PREMIÈRE bascule de statut — c'est-à-dire au
      // moment précis où il devient intéressant.
      if (raison === 'io server disconnect' && this.relances < MAX_RELANCES) {
        this.relances += 1;
        setTimeout(() => this.socket?.connect(), DELAI_RELANCE_MS);
      }
    });
    this.socket.on('connect_error', () => {
      this.socketConnecte.set(false);
      this.demarrerPolling();
    });

    this.socket.on(WS_EVENTS.DEPOT_MISSION_POSITION, (event: DepotMissionPositionEvent) => {
      this.dernierMessageAt.set(Date.now());
      this.positions.update((liste) => {
        const precedent = liste.find((p) => p.missionId === event.missionId);
        const suivant = liste.filter((p) => p.missionId !== event.missionId);
        suivant.push({
          missionId: event.missionId,
          lat: event.lat,
          lng: event.lng,
          speedKmh: event.speedKmh,
          at: event.timestamp,
          // La distance restante n'est PAS dans l'événement : la calculer exigerait de
          // relire la destination à chaque trame diffusée. On garde la dernière valeur
          // connue — un entier de kilomètres, rafraîchi par la relecture périodique
          // ci-dessous. Mieux vaut un ordre de grandeur d'une minute qu'un chiffre qui
          // disparaît et réapparaît à chaque position.
          remainingKm: precedent?.remainingKm ?? null,
        });
        return suivant;
      });
      // Une position reçue lève l'indisponibilité : le boîtier a reparlé.
      this.indisponibles.update((carte) => {
        if (!carte.has(event.missionId)) return carte;
        const suivant = new Map(carte);
        suivant.delete(event.missionId);
        return suivant;
      });
    });

    this.socket.on(WS_EVENTS.DEPOT_MISSION_ENDED, (event: DepotMissionEndedEvent) => {
      this.dernierMessageAt.set(Date.now());
      // Le marqueur part d'abord — la carte réagit à `positions` — et le toast suit.
      // L'inverse (toast puis marqueur figé) serait pire que rien.
      this.positions.update((liste) => liste.filter((p) => p.missionId !== event.missionId));
      this.derniereFin.set(event);
      // ⚠️ Le toast est émis ICI, pas dans un `effect` de l'écran.
      //
      // La première version faisait consommer une file par un effect : l'effect lisait
      // le signal ET l'écrivait pour dépiler. Un effect qui écrit ce qu'il lit ne
      // rejoue pas de façon prévisible, et l'annonce se perdait — le marqueur
      // disparaissait sans un mot, exactement le défaut que le critère 4 interdit.
      // Un événement qui doit être annoncé UNE FOIS s'annonce là où il arrive.
      this.toast.show({
        kind: 'info',
        title: `Mission ${event.missionRef} terminée`,
        message: "Le camion a quitté la carte : son suivi s'arrête à la fin de la mission.",
        duration: 8000,
        // Deux missions closes en même temps ne produisent qu'un toast par référence.
        dedupeKey: `depot-fin-${event.missionId}`,
      });
      void this.recharger();
    });
  }

  private demarrerPolling(): void {
    if (this.timerPolling) return;
    this.timerPolling = setInterval(() => void this.recharger(), PERIODE_POLLING_MS);
  }

  private arreterPolling(): void {
    if (!this.timerPolling) return;
    clearInterval(this.timerPolling);
    this.timerPolling = null;
  }

}

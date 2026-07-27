import { Component, computed, input } from '@angular/core';
import { AlertTriangle, LucideAngularModule, Moon, Satellite, SatelliteDish, Unplug, Wifi, WifiOff } from 'lucide-angular';
import { formatSilenceLabel, type VehiclePresenceState } from '@vizyo/tracky-shared';

/**
 * Métadonnées d'affichage d'un état de présence véhicule. Source unique de
 * vérité visuelle (label + couleurs + icône) réutilisée partout : badge de liste,
 * détail, popup carte. Les couleurs distinguent les causes de non-suivi :
 *  - AWAITING_GPS (sky)     : connecté mais sans fix GPS — vivant, cherche les satellites.
 *  - GPS_LOST (rouge)       : vivant mais a PERDU son fix GPS (antenne/ciel) — action requise.
 *  - OFFLINE (ambre)        : débranché / hors-ligne — il fonctionnait, à traiter.
 *  - DORMANT (ambre brûlé)  : muet depuis des SEMAINES — plus rien à en tirer en direct.
 *  - NOT_CONFIGURED (gris)  : pas (ou mal) installé — neutre, à équiper.
 */
export interface ConnectivityMeta {
  label: string;
  /** Couleur d'accent (texte + pastille). */
  color: string;
  /** Fond du chip. */
  bg: string;
  icon: typeof Wifi;
}

/**
 * @param state        état de présence (tri-état de connectivité ÉLARGI d'un cran `DORMANT`).
 * @param silenceLabel ancienneté du silence déjà formatée (« 89 j »), utilisée UNIQUEMENT par
 *                     `DORMANT` : un dormant sans durée affichée ne dit pas grand-chose — c'est
 *                     précisément l'ancienneté qui fait comprendre « ce n'est pas un week-end ».
 */
export function connectivityMeta(state: VehiclePresenceState, silenceLabel?: string | null): ConnectivityMeta {
  switch (state) {
    case 'ONLINE':
      return { label: 'En ligne', color: '#10b981', bg: 'rgba(16,185,129,.12)', icon: Wifi };
    case 'AWAITING_GPS':
      // Connecté sans fix GPS : sky-blue « acquisition » — distinct du vert (suivi) et de
      // l'ambre (hors-ligne). Le boîtier est vivant, il cherche les satellites.
      return { label: 'Recherche GPS', color: '#0ea5e9', bg: 'rgba(14,165,233,.13)', icon: Satellite };
    case 'GPS_LOST':
      // GPS PERDU : le boîtier émet encore mais a perdu son lock satellite (antenne /
      // ciel bouché). Rouge = action requise (aller vérifier l'antenne), distinct du
      // sky-blue « acquisition » (démarrage à froid, transitoire).
      return { label: 'GPS perdu', color: '#ef4444', bg: 'rgba(239,68,68,.12)', icon: SatelliteDish };
    case 'PARKED':
      // Garé en veille : neutre/calme (slate), pas alarmant — comportement normal.
      return { label: 'Stationné', color: '#64748b', bg: 'rgba(100,116,139,.14)', icon: Moon };
    case 'OFFLINE':
      return { label: 'Hors ligne', color: '#f59e0b', bg: 'rgba(245,158,11,.13)', icon: WifiOff };
    case 'DORMANT':
      // DORMANT : le boîtier parlait, puis s'est tu depuis des SEMAINES (prod : FV-941-LZ à
      // 89 j, FL-787-KV à 52 j). Ambre BRÛLÉ (#d97706) volontairement PLUS SOUTENU que l'ambre
      // « Hors ligne » (#f59e0b) : les deux disent « il ne parle pas », mais un hors-ligne se
      // règle dans l'heure alors qu'un dormant est un dossier (batterie, SIM, boîtier déposé).
      // Icône `Unplug` — jamais `Moon`, déjà pris par « Stationné » : en mode compact seule
      // l'icône reste visible, deux lunes = deux états confondus.
      // Le libellé PORTE l'ancienneté (« Dormant · 89 j ») : sans elle, l'exploitant ne peut pas
      // distinguer un congé d'un boîtier arraché il y a trois mois.
      return {
        label: silenceLabel ? `Dormant · ${silenceLabel}` : 'Dormant',
        color: '#d97706',
        bg: 'rgba(217,119,6,.16)',
        icon: Unplug,
      };
    case 'NOT_CONFIGURED':
    default:
      // ⚠️ PIÈGE : cette branche `default` avale TOUT état non traité au-dessus, SANS la
      // moindre erreur de compilation. Un état ajouté à `VehiclePresenceState` et oublié ici
      // s'afficherait « Non configuré » en silence — c'est-à-dire « jamais installé », le
      // contraire exact d'un boîtier qui s'est tu. Tout nouvel état doit avoir son `case`.
      return { label: 'Non configuré', color: '#9ca3af', bg: 'rgba(156,163,175,.14)', icon: AlertTriangle };
  }
}

/**
 * Infobulle explicative d'un état de présence. Fonction PURE et exportée (et non un
 * `computed` privé du composant) pour être testable sans TestBed, au même titre que
 * {@link connectivityMeta} — les deux doivent rester alignées état par état.
 */
export function connectivityTitle(state: VehiclePresenceState, silenceLabel?: string | null): string {
  switch (state) {
    case 'ONLINE': return 'Boîtier en ligne — suivi en direct';
    case 'AWAITING_GPS': return 'Connecté — en attente du fix GPS : le boîtier émet mais n\'a pas encore de lock satellite (intérieur / démarrage à froid / antenne). Mets-le à ciel ouvert.';
    case 'GPS_LOST': return 'GPS perdu — le boîtier communique toujours (réseau OK) mais n\'envoie plus de position GPS depuis un moment. Antenne débranchée/masquée ou véhicule sans vue ciel : à vérifier physiquement.';
    case 'PARKED': return 'Stationné — contact coupé, boîtier en veille (dernier signal > 15 min). Normal.';
    case 'OFFLINE': return 'Hors ligne — coupé en roulant / débranché ou sans réseau depuis > 15 min';
    case 'DORMANT':
      // On DATE, on ne masque pas : le véhicule reste partout, avec la raison affichée.
      // « se réveille tout seul » est là pour couper court à la question « comment je le
      // réactive ? » — il n'y a aucun drapeau à lever, la dormance est dérivée à la lecture.
      return `Dormant — le boîtier a cessé d'émettre depuis ${silenceLabel ?? 'plus d\'une semaine'}. `
        + 'Les valeurs affichées sont les DERNIÈRES CONNUES, pas du direct. Causes usuelles : batterie '
        + 'débranchée, fusible, SIM coupée ou boîtier déposé. Rien à réactiver : il redevient normal '
        + 'tout seul dès la première trame reçue.';
    case 'NOT_CONFIGURED': return 'Non configuré — aucun boîtier connecté à Tracky';
    // Volontairement vide (et non « non configuré ») : une infobulle absente ne ment pas,
    // alors qu'un libellé faux, lui, se lit comme une information.
    default: return '';
  }
}

/**
 * Badge de présence véhicule. Rend un chip coloré « En ligne / Hors ligne /
 * Dormant · 89 j / Non configuré » à partir de l'état partagé
 * `getVehiclePresenceState` (ou de `getVehicleConnectivityState`, qui en est un
 * sous-ensemble : les appelants historiques restent valides sans rien changer).
 *
 * Usage :
 *   <app-connectivity-badge [state]="presence(v)" [lastSeenAt]="v.tracker?.lastSeenAt" />
 *   <app-connectivity-badge [state]="state" [compact]="true" />   (pastille + icône seules)
 *   <app-connectivity-badge [state]="state" [hideWhenOnline]="true" />  (ne flague que les problèmes)
 */
@Component({
  selector: 'app-connectivity-badge',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (visible()) {
      <span
        class="conn-badge"
        [class.conn-badge--compact]="compact()"
        [style.color]="meta().color"
        [style.background]="meta().bg"
        [style.border-color]="meta().color + '40'"
        [attr.title]="title()"
      >
        <lucide-icon [img]="meta().icon" [size]="compact() ? 12 : 11" aria-hidden="true"></lucide-icon>
        @if (!compact()) {
          <span class="conn-badge-label">{{ meta().label }}</span>
        }
      </span>
    }
  `,
  styles: [`
    .conn-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      font-size: 10px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: .01em;
      border-radius: 9999px;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .conn-badge--compact {
      padding: 3px;
      border-radius: 9999px;
    }
    .conn-badge-label { overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class ConnectivityBadgeComponent {
  /**
   * État à afficher. Typé `VehiclePresenceState` (union ÉLARGIE) : un appelant qui passe
   * encore un `VehicleConnectivityState` compile sans modification, il n'affichera
   * simplement jamais « Dormant ».
   */
  readonly state = input.required<VehiclePresenceState>();
  /**
   * Dernier signal du boîtier, d'où est tirée l'ancienneté affichée par l'état `DORMANT`
   * (« Dormant · 89 j »). Optionnel : l'appelant qui ne le fournit pas obtient « Dormant »
   * tout court, jamais un état faux.
   */
  readonly lastSeenAt = input<Date | string | number | null>(null);
  /** Pastille + icône seules (sans texte), pour les rangées denses. */
  readonly compact = input<boolean>(false);
  /** Si true, ne rend rien quand le véhicule est ONLINE (ne flague que les problèmes). */
  readonly hideWhenOnline = input<boolean>(false);

  /** « 45 min » / « 5 h » / « 89 j » — helper partagé, mêmes paliers que l'API. */
  protected readonly silence = computed(() => formatSilenceLabel(this.lastSeenAt()));
  protected readonly meta = computed(() => connectivityMeta(this.state(), this.silence()));
  /**
   * Seul ONLINE peut être masqué. Un DORMANT reste TOUJOURS rendu, y compris sous
   * `hideWhenOnline` : c'est exactement le cas qu'on veut voir, jamais escamoter.
   */
  protected readonly visible = computed(() => !(this.hideWhenOnline() && this.state() === 'ONLINE'));
  protected readonly title = computed(() => connectivityTitle(this.state(), this.silence()));
}

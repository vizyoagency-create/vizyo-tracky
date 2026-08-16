import { Component, EventEmitter, Output, OnInit, inject, computed, signal, effect } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import {
  LucideAngularModule,
  Menu, Maximize2, History, ShieldCheck,
  Car, Crosshair, Satellite, Search, ChevronRight, X,
} from 'lucide-angular';
import {
  DORMANT_STOP_COUNTING_MS,
  formatSilenceLabel,
  isTrackerOnline,
  isVehicleDormant,
  MOVING_FRESHNESS_MS,
} from '@vizyo/tracky-shared';
import { AuthService } from '../../core/services/auth.service';
import { MapBridgeService } from '../../core/services/map-bridge.service';
import { MenuStateService } from '../../core/services/menu-state.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehicleGroupsService, type VehicleGroup } from '../../core/services/vehicle-groups.service';

/**
 * V1.12 — Overlay UI style Baanool pour la page /map en mode 'baanool'.
 *
 * Reproduit fidelement le look Baanool :
 * - Top-left : 3 boutons cercles (burger, recentrer, alertes)
 * - Top-right : 1 bouton cercle profile
 * - Right vertical : boutons cercles (vehicules, coupe-circuit, GPS, satellite)
 * - Panel central blanc flottant (toggleable) : search + tabs + groupes
 *
 * Inclus dans dashboard-layout via @if (isBaanoolMode() && route === '/map').
 * Tous les inputs sont en pointer-events: auto pour permettre les clics, mais
 * l'overlay lui-meme est en pointer-events: none pour ne pas bloquer la map.
 */
@Component({
  selector: 'app-baanool-map-overlay',
  standalone: true,
  imports: [LucideAngularModule, DecimalPipe],
  template: `
      <!-- LES OUTILS DE LA CARTE — recadrer, se localiser, changer de fond.
           Ce ne sont pas des destinations : la règle « jamais plus de 3 boutons »
           porte sur les FONCTIONS, pas sur les prises en main de la carte, que la
           planche garde elle aussi en petits ronds à côté du bloc du bas.
           Menu, Alertes et Mon compte ont quitté cet étage : ce sont des
           destinations, elles passent DERRIÈRE le Menu (règle 1). -->
      <div class="bn-right">
        <button class="bn-circle" (click)="mapBridge.requestRecenter()" aria-label="Voir tous mes véhicules sur la carte">
          <lucide-icon [img]="MaximizeIcon" [size]="20"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="mapBridge.requestLocate()" aria-label="Ma position">
          <lucide-icon [img]="CrosshairIcon" [size]="20"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="mapBridge.requestToggleSatellite()" aria-label="Vue satellite">
          <lucide-icon [img]="SatelliteIcon" [size]="20"></lucide-icon>
        </button>
      </div>

      <!-- LE BLOC DU BAS — les 4 règles de l'interface simplifiée.
           Trois besoins en langage courant, jamais quatre ; le reste entre derrière
           le Menu, qui porte aussi la sortie « Revenir en interface complète ». -->
      <nav class="bn-bas" aria-label="Navigation simplifiée">
        <button class="bn-bas-btn bn-bas-btn--principal" [class.active]="panelOpen() && intention() === 'centrer'"
                (click)="ouvrirPour('centrer')">
          <lucide-icon [img]="CarIcon" [size]="21"></lucide-icon>
          Ma voiture
        </button>
        <button class="bn-bas-btn" (click)="ouvrirPour('trajet')">
          <lucide-icon [img]="HistoryIcon" [size]="21"></lucide-icon>
          Trajet
        </button>
        <button class="bn-bas-btn" (click)="ouvrirPour('antivol')">
          <lucide-icon [img]="ShieldIcon" [size]="21"></lucide-icon>
          Anti-vol
        </button>
        <button class="bn-bas-btn bn-bas-btn--menu" (click)="openMenu()"
                [attr.aria-label]="unreadCount() > 0 ? 'Menu — ' + unreadCount() + ' alerte(s) non lue(s)' : 'Menu'">
          <lucide-icon [img]="MenuIcon" [size]="19"></lucide-icon>
          Menu
          @if (unreadCount() > 0) {
            <span class="bn-badge">{{ unreadCount() }}</span>
          }
        </button>
      </nav>

      <!-- CENTRAL PANEL (toggleable) -->
      @if (panelOpen()) {
        <div class="bn-panel" role="dialog" [attr.aria-label]="titrePanneau()">
          <button class="bn-panel-close" (click)="closePanel()" aria-label="Fermer la liste">
            <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
          </button>
          <!-- Le panneau sert les trois intentions. Sans ce titre, on tape « Trajet »
               puis on voit la même liste que « Ma voiture » : on ne sait plus ce que
               le prochain geste va faire. -->
          <p class="bn-panel-titre">{{ titrePanneau() }}</p>
          <div class="bn-panel-search">
            <lucide-icon [img]="SearchIcon" [size]="16"></lucide-icon>
            <input
              type="search"
              placeholder="Numéro d'appareil/plaque d'i..."
              [value]="searchQuery()"
              (input)="onSearch($event)"
            />
          </div>
          <div class="bn-panel-tabs">
            @for (t of tabs; track t.key) {
              <button class="bn-tab" [class.active]="activeTab() === t.key" (click)="activeTab.set(t.key)">
                {{ t.label }}({{ counts()[t.key] }})
              </button>
            }
          </div>
          <div class="bn-panel-vehicles">
            @if (filteredVehicles().length === 0) {
              <div class="bn-vehicle-empty">
                Aucun véhicule
              </div>
            } @else {
              @for (v of filteredVehicles(); track v.vehicleId) {
                <button class="bn-vehicle-row" [class.bn-vehicle-row--dormant]="v.dormant" (click)="onVehicleClick(v.vehicleId)">
                  <span class="bn-vehicle-dot" [class.online]="v.live" [class.dormant]="v.dormant"></span>
                  <div class="bn-vehicle-main">
                    <div class="bn-vehicle-plate">{{ v.plate || '—' }}</div>
                    <!-- On DATE la ligne au lieu de la retirer : un vehicule muet reste
                         selectionnable (on va voir sa derniere position connue), il porte
                         juste son anciennete. Une vitesse n'est affichee que si la trame
                         est assez fraiche pour la prouver (< 5 min) — sinon on afficherait
                         « 62 km/h » pour un vehicule a l'arret depuis des semaines. -->
                    <div class="bn-vehicle-meta">
                      @if (v.dormant) {
                        Muet depuis {{ v.silenceLabel }}
                      } @else if (v.movingFresh) {
                        {{ v.speedKmh | number: '1.0-0' }} km/h
                      } @else if (v.silenceLabel) {
                        Vu il y a {{ v.silenceLabel }}
                      } @else {
                        Hors ligne
                      }
                    </div>
                  </div>
                  <lucide-icon [img]="ChevronRightIcon" [size]="16"></lucide-icon>
                </button>
              }
            }
          </div>
        </div>
      }
  `,
  styles: [`
    /* V1.12 — Overlay Baanool.
       Pas de conteneur intermediaire, pas de display:contents (buggé iOS Safari),
       pas de pointer-events:none. Chaque cluster est position:fixed directement.
       Le :host Angular est un simple block sans dimensions qui ne bloque rien. */
    :host {
      display: block;
      position: fixed;
      top: 0; left: 0;
      width: 0; height: 0;
      overflow: visible;
      z-index: 7500;
    }
    button {
      -webkit-touch-callout: none;
      touch-action: manipulation;
    }

    /* Cercle de base : fond blanc, ombre douce, taille tap target Apple HIG. */
    .bn-circle {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--bg-secondary);
      border: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--fg-primary);
      position: relative;
      transition: transform 120ms;
    }
    .bn-circle:active { transform: scale(0.92); }
    .bn-circle.active { box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.4), 0 4px 12px rgba(0, 0, 0, 0.15); }
    .bn-circle--empty { background: var(--bg-secondary); }
    .bn-color-blue { background: var(--blue); color: var(--accent-ink); }
    .bn-color-red { background: var(--danger); color: var(--accent-ink); }

    /* Badge alerte non lue, accroche en haut a droite du cercle. */
    .bn-badge {
      position: absolute;
      top: -4px; right: -4px;
      min-width: 18px; height: 18px;
      padding: 0 4px;
      border-radius: 9999px;
      background: var(--warning);
      color: var(--accent-ink);
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* LE BLOC DU BAS — trois besoins, jamais quatre.
       La planche pose des boutons LARGES portant un libellé (62-66 px de haut,
       rayon 16-20), pas des ronds d'icônes : un artisan doit pouvoir lire l'écran
       en une seconde, et une icône seule se devine au lieu de se lire.
       Le quatrième, « Menu », est volontairement ÉTROIT et sans accent : ce n'est
       pas une quatrième fonction, c'est la porte derrière laquelle passent toutes
       les autres — y compris la sortie « Revenir en interface complète ». */
    .bn-bas {
      position: fixed;
      left: 14px; right: 14px;
      bottom: calc(14px + env(safe-area-inset-bottom));
      display: flex;
      gap: 8px;
      z-index: 7500;
      pointer-events: auto;
    }
    .bn-bas-btn {
      flex: 1;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 5px;
      height: 62px;
      border-radius: 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-strong);
      color: var(--fg-primary);
      font-size: 12px; font-weight: 700;
      line-height: 1.15; text-align: center;
      cursor: pointer;
      box-shadow: 0 8px 20px -4px rgba(0, 0, 0, .28);
      transition: transform 120ms;
    }
    .bn-bas-btn:active { transform: scale(0.96) }
    .bn-bas-btn--principal {
      background: var(--tracky-light);
      border-color: var(--tracky-light);
      color: var(--accent-ink);
    }
    /* Étroit — il porte le même geste, pas le même poids. */
    .bn-bas-btn--menu {
      flex: 0 0 58px;
      position: relative;
      font-size: 11px;
      color: var(--fg-secondary);
    }

    /* Chaque cluster est position:fixed independamment — pas de conteneur
       intermediaire qui pourrait bloquer les events sur iOS Safari. */
    .bn-right {
      position: fixed;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 7500;
      pointer-events: auto;
    }

    /* Panel central blanc : max-width pour pas etaler sur desktop.
       Il descendait de 72 px pour passer sous les ronds du haut ; ces ronds sont
       partis dans le Menu, donc il remonte. Sa hauteur maximale laisse la place
       au bloc du bas — sinon la liste passe DERRIÈRE les boutons qui l'ont
       ouverte, et les dernières lignes deviennent intouchables. */
    .bn-panel {
      position: fixed;
      top: calc(14px + env(safe-area-inset-top));
      z-index: 7500;
      left: 12px;
      right: 70px; /* laisse la place pour la colonne d'outils de carte */
      max-width: 480px;
      background: var(--bg-secondary);
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      overflow: hidden;
      /* dvh = iOS-safe (tient compte de la barre/safe-area) ; vh reste en fallback.
         120 px = les 62 px du bloc du bas + ses marges + la marge du haut. */
      max-height: calc(100vh - 120px);
      max-height: calc(100dvh - 120px);
      display: flex;
      flex-direction: column;
    }
    .bn-panel-titre {
      margin: 0;
      padding: 12px 44px 0 14px;
      font-size: 13px; font-weight: 700;
      color: var(--fg-primary);
    }
    /* Bouton fermeture en absolute dans le coin du panel — petite icone X qui
       n'empiete pas sur le contenu mais reste cliquable au pouce. */
    .bn-panel-close {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: transparent;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--fg-tertiary);
      z-index: 1;
      transition: background-color 120ms, color 120ms;
    }
    .bn-panel-close:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .bn-panel-close:active { transform: scale(0.9); }
    .bn-panel-search {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 44px 12px 14px; /* +30px right pour ne pas chevaucher le X */
      border-bottom: 1px solid #eee;
      color: var(--fg-tertiary);
    }
    .bn-panel-search input {
      flex: 1;
      border: none;
      outline: none;
      font-size: 14px;
      background: transparent;
      color: var(--fg-primary);
      min-width: 0;
    }
    .bn-panel-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid #eee;
      padding: 0 14px;
    }
    .bn-tab {
      flex: 1;
      padding: 12px 4px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      font-size: 13px;
      color: var(--fg-secondary);
      cursor: pointer;
      transition: color 120ms, border-color 120ms;
    }
    .bn-tab.active {
      color: var(--texte-succes);
      border-bottom-color: var(--tracky-light);
      font-weight: 600;
    }
    .bn-panel-vehicles {
      overflow-y: auto;
      padding: 4px 0;
      max-height: 50vh;
      max-height: 50dvh;
    }
    .bn-vehicle-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: var(--bg-secondary);
      border: none;
      cursor: pointer;
      color: var(--fg-primary);
      font-size: 14px;
      border-bottom: 1px solid #f5f5f5;
      text-align: left;
    }
    .bn-vehicle-row:hover { background: var(--bg-tertiary); }
    .bn-vehicle-row:last-child { border-bottom: none; }
    .bn-vehicle-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--fg-tertiary); flex-shrink: 0;
    }
    .bn-vehicle-dot.online { background: var(--tracky); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tracky) 20%, transparent); }
    /* Muet de longue date : pastille CREUSE (le signal ne revient plus) plutot
       qu'un simple gris, et ligne estompee. Le vehicule reste dans la liste et
       reste cliquable — il est signale, jamais masque. */
    .bn-vehicle-dot.dormant { background: var(--bg-quaternary); box-shadow: inset 0 0 0 2px var(--fg-tertiary); }
    .bn-vehicle-row--dormant { opacity: 0.72; }
    .bn-vehicle-main { flex: 1; min-width: 0; }
    .bn-vehicle-plate { font-weight: 600; font-size: 14px; color: var(--fg-primary); }
    .bn-vehicle-meta { font-size: 12px; color: var(--fg-tertiary); margin-top: 2px; }
    .bn-vehicle-empty {
      padding: 32px 16px; text-align: center; color: var(--fg-tertiary); font-size: 13px;
    }

    /* Mobile : compress les espacements et reduce panel padding.
       ⚠️ Cette regle RAMENAIT les boutons a 40x40 — sous le plancher de 44 px, et
       precisement sur mobile, la ou le doigt en a le plus besoin. C'est l'inverse
       du critere de recette « iPhone 390 px : cibles >= 44 px », et sur le mode
       destine aux utilisateurs qui ont le moins de marge d'erreur. Les
       espacements se compressent, la CIBLE non. */
    @media (max-width: 480px) {
      .bn-right { gap: 10px; }
      .bn-panel { right: 60px; }
    }
  `],
})
export class BaanoolMapOverlayComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly vehicleGroupsService = inject(VehicleGroupsService);
  private readonly menuState = inject(MenuStateService);
  protected readonly mapBridge = inject(MapBridgeService);

  @Output() groupClick = new EventEmitter<string>();

  /** Bug fix : ouvrir le menu via service partage au lieu d'EventEmitter,
   *  qui ne propage pas son listener (menuClick) au parent dashboard-layout
   *  dans certains contextes Angular HMR + iOS PWA standalone. */
  openMenu(): void { this.menuState.open(); }

  // Icons
  protected readonly MenuIcon = Menu;
  protected readonly MaximizeIcon = Maximize2;
  protected readonly HistoryIcon = History;
  protected readonly ShieldIcon = ShieldCheck;
  protected readonly CarIcon = Car;
  protected readonly CrosshairIcon = Crosshair;
  protected readonly SatelliteIcon = Satellite;
  protected readonly SearchIcon = Search;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly XIcon = X;

  /** V1.12 — Auto-dismiss du panel quand l'utilisateur interagit avec la map
   *  (drag/zoom/click sur le fond). Le pattern UX : ouvrir le panel = explorer
   *  la liste ; toucher la map = explorer la carte → fermer le panel revele
   *  ce que l'user veut voir. Combine avec le X explicite (top-right du panel)
   *  et le close-on-vehicle-click (centrage + fermeture en un geste), on a
   *  3 facons naturelles de fermer + le toggle voiture bleu.
   *
   *  Important : on NE lit PAS panelOpen() dans l'effect (sinon il devient
   *  reactif a panelOpen et se re-trigger en boucle a chaque ouverture).
   *  Set(false) est idempotent — safe a appeler meme si deja false. */
  private bridgeMapInteractionEffect = effect(() => {
    const n = this.mapBridge.mapInteractionTrigger();
    if (n > 0) {
      this.panelOpen.set(false);
    }
  });

  // Panel state
  protected readonly panelOpen = signal(false);
  protected readonly searchQuery = signal('');
  protected readonly activeTab = signal<'total' | 'online' | 'offline'>('total');
  protected readonly tabs = [
    { key: 'total' as const, label: 'Total' },
    { key: 'online' as const, label: 'En ligne' },
    { key: 'offline' as const, label: 'Hors ligne' },
  ];

  // Data
  protected readonly groups = signal<VehicleGroup[]>([]);
  protected readonly unreadCount = signal(0);

  ngOnInit(): void {
    this.vehicleGroupsService.list()
      .then((g) => this.groups.set(g))
      .catch(() => this.groups.set([]));
  }

  /**
   * Index snapshot par vehicule — la SEULE source de fraicheur autorisee.
   *
   * `position.timestamp` est l'horloge DU BOITIER (Coban) : elle derive, repart a
   * 1970 apres une coupure d'alimentation, ou avance de plusieurs heures. Compter
   * « en ligne » dessus classait des vehicules au hasard. `lastSeenAt` est l'heure
   * SERVEUR de la derniere trame recue : c'est elle qui dit si le boitier parle.
   */
  private readonly snapshotByVehicle = computed(
    () => new Map(this.realtime.snapshot().map((s) => [s.vehicleId, s])),
  );

  /**
   * Onglets Total / En ligne / Hors ligne.
   *
   * « En ligne » = le boitier a parle depuis moins de 15 min (seuil PARTAGE
   * `isTrackerOnline`, le meme que l'admin Trackers et les marqueurs de la carte).
   * Les 5 min reinventees ici basculaient en « hors ligne » des vehicules gares
   * parfaitement sains : un Coban a l'arret n'emet que toutes les ~300 s.
   */
  protected readonly counts = computed(() => {
    const positions = this.realtime.positionsList();
    const snapshots = this.snapshotByVehicle();
    const total = positions.length;
    const now = Date.now();
    let online = 0;
    for (const p of positions) {
      if (isTrackerOnline(snapshots.get(p.vehicleId)?.lastSeenAt ?? p.timestamp, now)) online++;
    }
    return { total, online, offline: total - online };
  });

  protected readonly filteredCount = computed(() => {
    const cnt = this.counts();
    const tab = this.activeTab();
    return tab === 'online' ? cnt.online : tab === 'offline' ? cnt.offline : cnt.total;
  });

  /**
   * Liste filtree des vehicules : merge positions (vitesse live) avec le snapshot
   * (plaque + `lastSeenAt` serveur). Filtres : recherche + onglet.
   *
   * Trois faits DISTINCTS sont calcules une fois par ligne, au lieu d'un unique
   * « online » a 5 min qui melangeait tout :
   *  - `live`        : le boitier parle (< 15 min) → pastille verte, meme definition
   *                    que le marqueur de la carte ;
   *  - `movingFresh` : trame de moins de 5 min, seule condition pour AFFIRMER une
   *                    vitesse (un vehicule qui roule emet toutes les ~30 s) ;
   *  - `dormant`     : muet depuis plus de 7 j (seuil de COMPTAGE, c'est une liste,
   *                    pas une commande) → il reste affiche, date de son anciennete.
   */
  protected readonly filteredVehicles = computed(() => {
    const positions = this.realtime.positionsList();
    const snapshots = this.snapshotByVehicle();
    const tab = this.activeTab();
    const q = this.searchQuery().trim().toLowerCase();
    const now = Date.now();

    const enriched = positions.map((p) => {
      const snap = snapshots.get(p.vehicleId);
      // Repli sur `p.timestamp` UNIQUEMENT si le vehicule n'a aucune ligne de
      // snapshot (course au demarrage) : sans repli la liste dirait « hors ligne »
      // pour tout le parc pendant la seconde qui precede l'hydratation.
      const lastSeenAt = snap?.lastSeenAt ?? p.timestamp;
      return {
        vehicleId: p.vehicleId,
        plate: snap?.plate ?? '',
        speedKmh: p.speedKmh,
        live: isTrackerOnline(lastSeenAt, now),
        movingFresh: isTrackerOnline(lastSeenAt, now, MOVING_FRESHNESS_MS),
        dormant: isVehicleDormant(
          { trackerId: snap?.trackerId ?? p.trackerId, lastSeenAt },
          now,
          DORMANT_STOP_COUNTING_MS,
        ),
        silenceLabel: formatSilenceLabel(lastSeenAt, now),
      };
    });

    return enriched.filter((v) => {
      if (q && !v.plate.toLowerCase().includes(q)) return false;
      if (tab === 'total') return true;
      return tab === 'online' ? v.live : !v.live;
    });
  });

  /**
   * Ce que le PROCHAIN clic sur un véhicule va faire.
   *
   * Les trois boutons du bas partagent une même liste : la choisir est le geste
   * commun, seule la destination change. Sans cet état, « Trajet » ouvrirait la
   * même liste que « Ma voiture » et le geste suivant serait une devinette.
   */
  protected readonly intention = signal<'centrer' | 'trajet' | 'antivol'>('centrer');

  protected readonly titrePanneau = computed(() => {
    switch (this.intention()) {
      case 'trajet': return 'Voir les trajets de quel véhicule ?';
      case 'antivol': return 'Protéger quel véhicule ?';
      default: return 'Mes véhicules';
    }
  });

  /**
   * Ouvre la liste pour une intention — ou saute la liste s'il n'y a rien à
   * choisir. Un sélecteur à une seule entrée demande un geste pour rien : la
   * cible de cette interface est « un artisan avec 1 à 3 véhicules », donc le cas
   * à un véhicule est le cas courant, pas le cas limite.
   */
  protected ouvrirPour(intention: 'centrer' | 'trajet' | 'antivol'): void {
    const seul = this.filteredVehicles();
    if (seul.length === 1) {
      this.panelOpen.set(false);
      this.allerVers(intention, seul[0]!.vehicleId);
      return;
    }
    // Re-taper le bouton déjà actif referme : le geste reste réversible.
    if (this.panelOpen() && this.intention() === intention) {
      this.panelOpen.set(false);
      return;
    }
    this.intention.set(intention);
    this.panelOpen.set(true);
  }

  private allerVers(intention: 'centrer' | 'trajet' | 'antivol', vehicleId: string): void {
    if (intention === 'centrer') {
      this.mapBridge.requestFlyToVehicle(vehicleId);
      return;
    }
    // `?tab=` est déjà lu par la fiche véhicule : aucun contrat nouveau.
    const tab = intention === 'trajet' ? 'history' : 'surveillance';
    void this.router.navigate(['/vehicles', vehicleId], { queryParams: { tab } });
  }

  onVehicleClick(vehicleId: string): void {
    this.allerVers(this.intention(), vehicleId);
    // Fermer le panel apres avoir centre — pattern UX coherent : l'utilisateur
    // a fait sa selection, on revele la map qui montre le vehicule choisi.
    this.panelOpen.set(false);
  }

  /** Ferme le panel (utilise par le bouton X). togglePanel() sert au bouton
   *  voiture bleu qui doit garder son comportement on/off. */
  closePanel(): void {
    this.panelOpen.set(false);
  }

  onSearch(e: Event): void {
    this.searchQuery.set((e.target as HTMLInputElement).value);
  }
}

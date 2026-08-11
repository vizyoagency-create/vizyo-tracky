import {
  AfterViewInit,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LucideAngularModule, Play, Pause, X, MessageSquare, Pencil } from 'lucide-angular';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import type { TripAnalysisDto, TripDto } from '@vizyo/tracky-shared';
import { isValidLatLng, haversineMeters } from '@vizyo/tracky-shared';
import { MapService } from '../../core/services/map.service';
import { PreferencesService } from '../../core/services/preferences.service';
import {
  attachVehicleMarker,
  buildVehicleMarkerEl,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from '../../shared/utils/maplibre-markers';
import { COULEURS_CARTE } from '../../shared/utils/couleurs-carte';

/** Un événement situé dans le trajet — un arrêt, ou un excès confirmé. */
interface EvenementRejeu {
  type: 'arret' | 'exces';
  /** Horodatage en ms, pour le tri et la clé de boucle. */
  at: number;
  /** Position dans le trajet, de 0 à 1 — sert à placer le repère sur la frise. */
  fraction: number;
  heure: string;
  titre: string;
  detail: string;
  lat: number;
  lng: number;
}

@Component({
  selector: 'app-trip-replay',
  standalone: true,
  imports: [LucideAngularModule, DecimalPipe],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex flex-col tr-replay-shell">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" (click)="onClose()"></div>
        <div class="relative flex-1 flex flex-col bg-bg-secondary border border-border-subtle
                    rounded-[--radius-card] overflow-hidden tr-replay-card">

          <div class="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-border-subtle shrink-0 gap-3">
            <div class="text-sm text-fg-primary min-w-0 flex-1">
              <div>
                <strong>Replay trajet</strong>
                @if (trip()) {
                  <span class="text-fg-secondary ml-2">
                    {{ (max0(trip()!.distanceMeters) / 1000) | number:'1.1-1' }} km ·
                    {{ formatDur(trip()!.durationSeconds) }} ·
                    max {{ clampSpeed(trip()!.maxSpeed) | number:'1.0-0' }} km/h
                  </span>
                  @if (trip()!.polylineMatched) {
                    <span class="ml-2 inline-block px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300
                                 border border-blue-500/30 text-[9px] uppercase tracking-wider">
                      Snap-to-road
                    </span>
                  }
                }
              </div>
              @if (analysis(); as a) {
                <div class="tr-analysis-summary">
                  <span class="tr-as-chip" [attr.data-tier]="ecoTier(a.ecoScore)">🍃 Éco {{ a.ecoScore }}</span>
                  @if (a.stopCount > 0) { <span class="tr-as-chip tr-as-chip--stop">🅿 {{ a.stopCount }} arrêt{{ a.stopCount > 1 ? 's' : '' }}</span> }
                  @if (a.speedingCount > 0) { <span class="tr-as-chip tr-as-chip--speed">⚠ {{ a.speedingCount }} excès confirmé{{ a.speedingCount > 1 ? 's' : '' }}@if (a.maxOverKmh > 0) { <span class="opacity-80"> +{{ a.maxOverKmh | number:'1.0-0' }}</span> }</span> }
                  <!-- Aucune limite résolue sur le trajet : « 0 excès » ne voudrait rien
                       dire, et ne rien afficher le laisserait croire. -->
                  @if (!a.limitsKnown) { <span class="tr-as-chip tr-as-chip--inconnu">Limites inconnues — excès non vérifiables</span> }
                  @if (a.fuelLiters != null) { <span class="tr-as-chip">⛽ {{ a.fuelLiters | number:'1.1-1' }} L</span> }
                </div>
              }
              <!-- Bandeau driver + note : visibles si presents OU si role autorise. -->
              <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                @if (trip()?.driver) {
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px]
                               font-semibold border"
                        [style.background]="'color-mix(in srgb, ' + couleurConducteur() + ' 12%, transparent)'"
                        [style.border-color]="'color-mix(in srgb, ' + couleurConducteur() + ' 30%, transparent)'"
                        [style.color]="'var(--fg-primary)'">
                    <span class="inline-block w-2 h-2 rounded-full"
                          [style.background]="couleurConducteur()"></span>
                    {{ trip()!.driver!.firstName }} {{ trip()!.driver!.lastName }}
                  </span>
                }
                @if (trip()?.notes) {
                  <span class="flex items-center gap-1.5 text-xs min-w-0">
                    <lucide-icon [img]="MessageSquareIcon" [size]="12" class="text-tracky-light shrink-0"></lucide-icon>
                    <span class="text-fg-secondary truncate">{{ trip()!.notes }}</span>
                    @if (canEditNote()) {
                      <button type="button" (click)="onEditNoteClick()"
                              class="tr-note-b text-fg-secondary hover:text-tracky-light cursor-pointer shrink-0"
                              aria-label="Modifier la note"
                              title="Modifier la note">
                        <lucide-icon [img]="PencilIcon" [size]="11"></lucide-icon>
                      </button>
                    }
                  </span>
                } @else if (canEditNote()) {
                  <button type="button" (click)="onEditNoteClick()"
                          class="tr-note-b inline-flex items-center gap-1 text-[11px] text-fg-secondary
                                 hover:text-tracky-light cursor-pointer">
                    <lucide-icon [img]="MessageSquareIcon" [size]="11"></lucide-icon>
                    Ajouter une note
                  </button>
                }
              </div>
            </div>
            <button (click)="onClose()"
                    aria-label="Fermer le replay"
                    class="tr-replay-close shrink-0 inline-flex items-center justify-center
                           w-11 h-11 rounded-full bg-bg-tertiary/80 backdrop-blur-sm
                           text-fg-secondary hover:text-fg-primary hover:bg-bg-tertiary
                           border border-border-subtle cursor-pointer transition-colors">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Container carte : flex-1 en flow normal (PAS absolute inset-0).
               MapLibre s'initialise mal dans un absolute au sein d'un parent
               flex — bug silencieux de canvas blanc constaté en prod (idem
               period-replay). Le min-h évite un collapse à 0 au tick d'init. -->
          <div class="tr-corps">
            <div class="relative flex-1 flex flex-col min-h-[280px]">
              <div #mapContainer class="flex-1"></div>
              @if (analysis(); as a) {
                @if (a.stopCount > 0 || a.speedingCount > 0) {
                  <div class="tr-legend">
                    @if (a.stopCount > 0) { <span><i class="tr-dot" [style.background]="couleursCarte.arret"></i> Arrêt</span> }
                    @if (a.speedingCount > 0) { <span><i class="tr-dot" [style.background]="couleursCarte.exces"></i> Excès confirmé</span> }
                  </div>
                }
              }
            </div>

            <!-- « Ce qui s'est passé ». Les arrêts et les excès existaient sur la
                 carte, mais rien ne disait QUAND les chercher. -->
            @if (evenements().length) {
              <aside class="tr-aside">
                <h3 class="tr-aside-titre">
                  Ce qui s'est passé
                  <span>{{ evenements().length }} événement{{ evenements().length > 1 ? 's' : '' }}</span>
                </h3>
                <ul class="tr-evs">
                  @for (ev of evenements(); track ev.at) {
                    <li>
                      <button type="button" class="tr-ev" [attr.data-type]="ev.type" (click)="allerA(ev)">
                        <span class="tr-ev-h">{{ ev.heure }}</span>
                        <span class="tr-ev-c">
                          <span class="tr-ev-t">{{ ev.titre }}</span>
                          @if (ev.detail) { <span class="tr-ev-d">{{ ev.detail }}</span> }
                        </span>
                      </button>
                    </li>
                  }
                </ul>
              </aside>
            }
          </div>

          <div class="tr-barre">
            <div class="tr-lecture">
              <button (click)="togglePlay()" class="tr-play"
                      [attr.aria-label]="playing() ? 'Mettre en pause' : 'Lancer la lecture'">
                @if (playing()) {
                  <lucide-icon [img]="PauseIcon" [size]="20"></lucide-icon>
                } @else {
                  <lucide-icon [img]="PlayIcon" [size]="20"></lucide-icon>
                }
              </button>

              <div class="tr-frise">
                <!-- Les repères sont AU-DESSUS du curseur, pas dessus : une cible de
                     44 px posée sur la glissière en intercepterait le glissement. -->
                <div class="tr-marques">
                  @for (ev of evenements(); track ev.at) {
                    <button type="button" class="tr-marque" [attr.data-type]="ev.type"
                            [style.left.%]="ev.fraction * 100"
                            (click)="allerA(ev)"
                            [attr.aria-label]="'Aller à ' + ev.heure + ' — ' + ev.titre"
                            [title]="ev.heure + ' — ' + ev.titre"><i></i></button>
                  }
                </div>
                <input type="range" [min]="0" [max]="pointCount() - 1" [value]="currentIndex()"
                       aria-label="Position dans le trajet"
                       (input)="seekTo($event)" class="tr-range accent-[var(--color-tracky)]" />
              </div>
            </div>

            <div class="tr-vitesses">
              <div class="tr-mult">
                @for (s of speeds; track s) {
                  <button (click)="speed.set(s)" class="tr-mult-b"
                          [attr.aria-pressed]="speed() === s"
                          [class.tr-mult-b--on]="speed() === s">{{ s }}×</button>
                }
              </div>
              <!-- Le multiplicateur seul ne dit pas combien de temps on va rester
                   devant l'écran. Cette durée est CALCULÉE depuis la constante que
                   l'animation utilise : elle ne peut pas dériver. -->
              @if (trip(); as t) {
                <span class="tr-duree">soit {{ dureeVisionnage() }} pour {{ formatDur(t.durationSeconds) }}</span>
              }
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    /* Safe-area iOS PWA standalone : evite que le bouton X / le header soient
       caches sous l'island/notch ou sous la home indicator. Le shell reserve
       l'espace via padding ; la carte reste plein-shell visuellement. */
    .tr-replay-shell {
      /* La top-bar de l'app (z-1800) repeint par-dessus le replay sur iOS (stacking
         context piege). On descend le contenu SOUS la top-bar (hauteur 56px + safe-area
         + 10px = env+66px) pour que le bouton X reste atteignable. */
      padding-top: calc(env(safe-area-inset-top) + 70px);
      padding-bottom: max(1rem, env(safe-area-inset-bottom));
      padding-left: max(1rem, env(safe-area-inset-left));
      padding-right: max(1rem, env(safe-area-inset-right));
    }
    .tr-replay-card { min-height: 0; }

    /* Résumé d'analyse (en-tête) */
    .tr-analysis-summary { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .tr-as-chip {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 700;
      background: var(--bg-tertiary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    /* Chips d'analyse : jetons de PETIT TEXTE (11 px). Les valeurs d'avant — #F59E0B,
       #EF4444, #60A5FA — donnaient 2,7 à 3,4:1 en thème clair, sous le seuil. */
    .tr-as-chip[data-tier="good"] { background: color-mix(in srgb, var(--texte-succes) 16%, transparent); color: var(--texte-succes); border-color: transparent; }
    .tr-as-chip[data-tier="mid"]  { background: color-mix(in srgb, var(--texte-attente) 16%, transparent); color: var(--texte-attente); border-color: transparent; }
    .tr-as-chip[data-tier="bad"]  { background: color-mix(in srgb, var(--texte-alerte) 16%, transparent); color: var(--texte-alerte); border-color: transparent; }
    .tr-as-chip--stop { color: var(--texte-info); }
    .tr-as-chip--speed { background: color-mix(in srgb, var(--texte-alerte) 14%, transparent); color: var(--texte-alerte); border-color: transparent; }

    /* Légende carte */
    .tr-legend {
      position: absolute; left: 10px; bottom: 10px; z-index: 5;
      display: flex; flex-direction: column; gap: 4px;
      padding: 8px 10px; border-radius: 10px;
      background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
      backdrop-filter: blur(6px);
      border: 1px solid var(--border-subtle);
      font-size: 11px; font-weight: 600; color: var(--fg-secondary);
    }
    .tr-legend span { display: inline-flex; align-items: center; gap: 6px; }
    /* La pastille de légende reprend la couleur de la COUCHE de carte, pas celle du
       chip : c'est elle qu'on cherche des yeux sur le fond. Le halo suit la surface —
       en blanc fixe il disparaissait sur le fond clair de la légende. */
    .tr-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 2px var(--bg-secondary); }
    .tr-as-chip--inconnu { background: color-mix(in srgb, var(--texte-attente) 14%, transparent); color: var(--texte-attente); border-color: transparent; }

    /* ─── Corps : la carte, et le journal des événements ───
       Au-dela de 1024 px le journal tient a cote de la carte ; en dessous il
       passe sous elle, avec son propre defilement. Il n'est jamais replie :
       savoir QUAND regarder est la raison d'etre de cet ecran. */
    .tr-corps { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .tr-aside {
      display: flex; flex-direction: column; min-height: 0;
      max-height: 38%;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
    }
    @media (min-width: 1024px) {
      .tr-corps { flex-direction: row; }
      .tr-aside { max-height: none; width: 328px; flex: none; border-top: none; border-left: 1px solid var(--border-subtle); }
    }
    .tr-aside-titre {
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      margin: 0; padding: 12px 14px 8px;
      font-size: 13px; font-weight: 700; color: var(--fg-primary);
    }
    .tr-aside-titre span { font-size: 11px; font-weight: 600; color: var(--fg-secondary); }
    .tr-evs { list-style: none; margin: 0; padding: 0 10px 12px; overflow-y: auto; display: grid; gap: 4px; }
    .tr-ev {
      width: 100%; min-height: 44px;
      display: flex; align-items: flex-start; gap: 10px;
      padding: 8px 10px; border-radius: 10px;
      background: transparent; border: 1px solid transparent;
      text-align: left; cursor: pointer;
      border-left: 3px solid var(--border-strong);
    }
    .tr-ev:hover { background: var(--bg-tertiary); }
    .tr-ev[data-type="exces"] { border-left-color: var(--texte-alerte); }
    .tr-ev[data-type="arret"] { border-left-color: var(--texte-info); }
    .tr-ev-h { flex: none; font-size: 11.5px; font-weight: 700; color: var(--fg-secondary); font-variant-numeric: tabular-nums; padding-top: 1px; }
    .tr-ev-c { display: grid; gap: 2px; min-width: 0; }
    .tr-ev-t { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); }
    .tr-ev-d { font-size: 11.5px; line-height: 1.4; color: var(--fg-secondary); }

    /* ─── Barre de lecture ─── */
    .tr-barre { flex-shrink: 0; border-top: 1px solid var(--border-subtle); padding: 8px 16px 10px; display: grid; gap: 8px; }
    @media (min-width: 640px) { .tr-barre { padding: 8px 24px 10px; } }
    .tr-lecture { display: flex; align-items: flex-end; gap: 12px; }
    .tr-play {
      flex: none; width: 44px; height: 44px; border-radius: 12px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--texte-succes); background: transparent; border: 1px solid var(--border-subtle); cursor: pointer;
    }
    .tr-play:hover { background: var(--bg-tertiary); }
    .tr-frise { flex: 1; min-width: 0; }
    .tr-marques { position: relative; height: 44px; }
    /* Le repere est une cible de 44 px centree sur sa position ; seul le trait de
       3 px se voit. Sans cette cible, on vise un trait au doigt. */
    .tr-marque {
      position: absolute; bottom: 0; transform: translateX(-50%);
      width: 44px; height: 44px; padding: 0; margin: 0;
      display: flex; align-items: flex-end; justify-content: center;
      background: transparent; border: none; cursor: pointer;
    }
    .tr-marque i { display: block; width: 3px; height: 15px; border-radius: 2px; background: var(--fg-tertiary); }
    .tr-marque[data-type="exces"] i { background: var(--texte-alerte); height: 20px; }
    .tr-marque[data-type="arret"] i { background: var(--texte-info); }
    .tr-marque:hover i, .tr-marque:focus-visible i { transform: scaleX(2); }
    /* 44 px : la glissiere native mesure 16 px de haut. C'est la commande la plus
       utilisee de cet ecran, et la plus difficile a saisir au doigt. */
    .tr-range { width: 100%; display: block; height: 44px; margin: 0; cursor: pointer; }
    /* Le bouton d'edition de note est une icone de 11 px dans une ligne de texte :
       la cible est agrandie sans pousser la ligne. */
    .tr-note-b { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; margin: -12px 0; }
    .tr-vitesses { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .tr-mult { display: flex; gap: 4px; }
    .tr-mult-b {
      min-width: 44px; min-height: 44px; padding: 0 8px; border-radius: 10px;
      font-size: 12.5px; font-weight: 600; cursor: pointer;
      background: transparent; border: 1px solid var(--border-subtle); color: var(--fg-secondary);
    }
    .tr-mult-b--on { background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent); color: var(--texte-succes); border-color: transparent; }
    .tr-duree { font-size: 12px; color: var(--fg-secondary); }
  `],
})
export class TripReplayComponent implements AfterViewInit, OnDestroy {
  readonly open = input.required<boolean>();
  readonly trip = input<TripDto | null>(null);
  /** Analyse déterministe du trajet (Palier 4) — arrêts + excès de vitesse affichés sur la carte. */
  readonly analysis = input<TripAnalysisDto | null>(null);
  readonly vehicleType = input<string>('OTHER');
  /** Si true, affiche le bouton crayon "Modifier la note". */
  readonly canEditNote = input<boolean>(false);
  readonly closed = output<void>();
  /** Demande au parent d'ouvrir le modal d'edition pour le trip courant. */
  readonly editNote = output<TripDto>();

  /** Exposé au template : la légende doit porter la couleur RÉELLE des couches de carte. */
  protected readonly couleursCarte = COULEURS_CARTE;
  /**
   * La couleur du conducteur est une DONNÉE (choisie dans sa fiche), pas un jeton : elle
   * ne peut pas suivre le thème. Seul son repli le fait — un conducteur sans couleur
   * prenait un vert fixe qui, sur fond clair, n'était pas celui de l'accent.
   */
  protected readonly couleurConducteur = computed(
    () => this.trip()?.driver?.color || 'var(--color-tracky-light)',
  );

  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');
  private readonly mapSvc = inject(MapService);
  private readonly preferences = inject(PreferencesService);

  protected readonly playing = signal(false);
  protected readonly currentIndex = signal(0);
  protected readonly speed = signal(1);
  protected readonly pointCount = signal(0);

  protected readonly PlayIcon = Play;
  protected readonly PauseIcon = Pause;
  protected readonly XIcon = X;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;

  protected onEditNoteClick(): void {
    const t = this.trip();
    if (t) this.editNote.emit(t);
  }

  protected readonly speeds = [1, 2, 4, 8];

  /**
   * Durée de lecture à 1×, en secondes. La légende « soit X pour Y » s'en déduit,
   * et `animate()` s'en sert : un chiffre écrit à la main dans le gabarit aurait
   * menti dès le premier réglage de l'animation.
   */
  private static readonly LECTURE_1X_SEC = 30;

  /** Le temps qu'on va RÉELLEMENT passer devant l'écran, au multiplicateur courant. */
  protected readonly dureeVisionnage = computed(
    () => this.dureeCourte(TripReplayComponent.LECTURE_1X_SEC / this.speed()),
  );

  /**
   * Les événements du trajet, situés sur la frise.
   *
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ SEULS LES EXCÈS **CONFIRMÉS** EXISTENT                                     │
   * │                                                                            │
   * │ Un segment d'excès n'est créé côté API que lorsque la limite du tronçon    │
   * │ est résolue (`trip-analysis.preprocessor.ts` : `if (lim != null)`), et     │
   * │ `speedingCount` vaut `speeding.length`. Autrement dit un excès listé ici   │
   * │ a toujours une limite connue.                                              │
   * │                                                                            │
   * │ Les « pointes à vérifier » de la planche — vitesse élevée sur un tronçon   │
   * │ SANS limite connue — ne sont donc produites nulle part : le préprocesseur  │
   * │ les écarte en silence. Les afficher demanderait que l'API les émette.      │
   * │ Cf. le point laissé à l'arbitrage dans le rapport de ce lot.               │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  protected readonly evenements = computed<EvenementRejeu[]>(() => {
    const a = this.analysis();
    const t = this.trip();
    if (!a || !t) return [];
    const t0 = Date.parse(t.startedAt);
    if (!Number.isFinite(t0)) return [];
    const fin = t.endedAt ? Date.parse(t.endedAt) : NaN;
    const t1 = Number.isFinite(fin) ? fin : t0 + Math.max(1, t.durationSeconds) * 1000;
    const etendue = Math.max(1, t1 - t0);
    const situe = (ms: number): number => Math.min(1, Math.max(0, (ms - t0) / etendue));

    const out: EvenementRejeu[] = [];
    for (const s of a.detail?.stops ?? []) {
      const ms = Date.parse(s.arrivedAt);
      if (!Number.isFinite(ms)) continue;
      const station = this.stationDe(s.arrivedAt);
      out.push({
        type: 'arret', at: ms, fraction: situe(ms), heure: this.heure(ms),
        titre: `Arrêt de ${this.dureeCourte(Math.max(0, s.durationMin) * 60)}`,
        detail: station, lat: s.lat, lng: s.lng,
      });
    }
    for (const e of a.detail?.speeding ?? []) {
      const ms = Date.parse(e.startAt);
      if (!Number.isFinite(ms)) continue;
      const tenue = e.durationSec >= 5 ? ` pendant ${this.dureeCourte(e.durationSec)}` : '';
      out.push({
        type: 'exces', at: ms, fraction: situe(ms), heure: this.heure(ms),
        titre: `Excès confirmé · ${Math.round(e.maxSpeedKmh)} km/h`,
        detail: `Limite ${Math.round(e.limitKmh)} · dépassement +${Math.round(e.overKmh)}${tenue}`,
        lat: e.lat, lng: e.lng,
      });
    }
    return out.sort((x, y) => x.at - y.at);
  });

  /** Le nom de la station si cet arrêt en était un — la donnée existe déjà. */
  private stationDe(arriveIso: string): string {
    const ms = Date.parse(arriveIso);
    for (const f of this.analysis()?.detail?.fuelStops ?? []) {
      if (Math.abs(Date.parse(f.arrivedAt) - ms) > 60_000) continue;
      const nom = [f.brand, f.name].filter(Boolean).join(' ') || 'Station-service';
      return f.city ? `${nom}, ${f.city} — lieu reconnu` : `${nom} — lieu reconnu`;
    }
    return '';
  }

  protected heure(ms: number | string): string {
    const d = new Date(typeof ms === 'string' ? Date.parse(ms) : ms);
    return Number.isFinite(d.getTime())
      ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : '—';
  }

  /** « 8 min », « 1 min 20 s », « 1 h 36 » — court, sans zéro inutile. */
  protected dureeCourte(secondes: number): string {
    const s = Math.max(0, Math.round(secondes));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) { const r = s % 60; return r ? `${m} min ${r} s` : `${m} min`; }
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h} h ${String(rm).padStart(2, '0')}` : `${h} h`;
  }

  /** Saute à l'événement : la frise porte l'analyse, et ses repères sont cliquables. */
  protected allerA(ev: EvenementRejeu): void {
    const n = this.pointCount();
    if (n > 1) {
      const idx = Math.min(n - 1, Math.max(0, Math.round(ev.fraction * (n - 1))));
      this.floatIndex = idx;
      this.currentIndex.set(idx);
      const pt = this.points[idx];
      if (pt && this.marker) this.marker.setLngLat(pt);
    }
    // On recentre sur les coordonnées de l'ÉVÉNEMENT, qui sont exactes ; l'index de
    // la frise, lui, n'est qu'une position proportionnelle dans la polyligne.
    if (isValidLatLng(ev.lat, ev.lng)) {
      try { this.map?.easeTo({ center: [ev.lng, ev.lat], duration: 400 }); } catch { /* carte pas prête */ }
    }
  }

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;
  private markerEl: HTMLElement | null = null;
  private points: Array<[number, number]> = []; // [lng, lat]
  private resizeObserver: ResizeObserver | null = null;
  private animId: number | null = null;
  private lastFrameTime = 0;
  private floatIndex = 0;

  private initEffect = effect(() => {
    const t = this.trip();
    const isOpen = this.open();
    if (isOpen && t) {
      setTimeout(() => this.initReplay(t), 100);
    }
  });

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.open()) this.onClose(); }

  ngAfterViewInit(): void { /* noop */ }

  ngOnDestroy(): void {
    this.cleanup();
  }

  protected onClose(): void {
    this.cleanup();
    this.closed.emit();
  }

  protected togglePlay(): void {
    if (this.playing()) {
      this.playing.set(false);
      if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
    } else {
      this.playing.set(true);
      this.lastFrameTime = performance.now();
      this.floatIndex = this.currentIndex();
      this.animate();
    }
  }

  protected seekTo(event: Event): void {
    const idx = parseInt((event.target as HTMLInputElement).value, 10);
    this.floatIndex = idx;
    this.currentIndex.set(idx);
    const pt = this.points[idx];
    if (pt && this.marker) {
      this.marker.setLngLat(pt);
    }
  }

  protected formatDur(s: number): string {
    // Clamp defensif : aligne sur reports.component formatDuration. Une legacy
    // negative ne doit jamais s'afficher en "-11min".
    const safe = Number.isFinite(s) && s > 0 ? s : 0;
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
  }

  protected max0(n: number): number {
    return Math.max(0, Number.isFinite(n) ? n : 0);
  }

  /** Clamp d'une vitesse km/h dans [0, 250]. Voir reports.component#clampSpeed. */
  protected clampSpeed(n: number): number {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 250) return 250;
    return n;
  }

  protected ecoTier(score: number): 'good' | 'mid' | 'bad' {
    return score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad';
  }
  /*
   * `speedingTitle()` vivait ici. Elle portait la seule mention de l'incertitude sur
   * les limites — dans un `title`, invisible au doigt — et sa branche « limites non
   * résolues » était INATTEIGNABLE : la pastille ne s'affiche que si
   * `speedingCount > 0`, or un excès n'est compté que lorsque la limite est connue.
   * L'incertitude est désormais dite en clair, et seulement quand elle existe :
   * la pastille « Limites inconnues » de l'en-tête.
   */

  private initReplay(trip: TripDto): void {
    this.cleanup();

    const el = this.mapRef()?.nativeElement;
    if (!el) return;

    let parsed: Array<{ lat: number; lng: number }> = [];
    let usedMatched = false;
    try {
      // Sprint G.3 — preferer la polyligne snappee aux routes si disponible.
      if (trip.polylineMatched) {
        parsed = JSON.parse(trip.polylineMatched);
        usedMatched = parsed.length >= 2;
      }
      if (!usedMatched && trip.polyline) {
        parsed = JSON.parse(trip.polyline);
      }
    } catch { /* */ }

    if (parsed.length === 0) {
      parsed = [{ lat: trip.startLat, lng: trip.startLng }];
      if (trip.endLat != null && trip.endLng != null) {
        parsed.push({ lat: trip.endLat, lng: trip.endLng });
      }
    }

    // Garde-fou cote frontend : filtre points invalides et sauts > 5 km.
    const cleaned: Array<{ lat: number; lng: number }> = [];
    for (const p of parsed) {
      if (!isValidLatLng(p.lat, p.lng)) continue;
      const last = cleaned[cleaned.length - 1];
      if (last && haversineMeters(last.lat, last.lng, p.lat, p.lng) > 5000) continue;
      cleaned.push(p);
    }

    this.points = cleaned.map((p) => [p.lng, p.lat] as [number, number]);
    this.pointCount.set(this.points.length);
    this.currentIndex.set(0);

    if (this.points.length === 0) return;

    const first = this.points[0]!;
    const styleId = this.preferences.prefs().map.style;

    this.map = this.mapSvc.createMap(el, {
      center: { lat: first[1], lng: first[0] },
      zoom: 15,
      style: styleId,
      withGeolocateControl: false,
    });

    // Observe la taille du container : la fin de l'animation d'ouverture du
    // shell / une rotation device déclenche un resize() pour éviter un canvas
    // rendu dans le vide (carte blanche). Idem period-replay.
    try {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.map?.resize());
      this.resizeObserver.observe(el);
    } catch { /* ResizeObserver indispo : les timers ci-dessous prennent le relais */ }

    this.map.on('load', () => {
      // Polyligne replay (gradient couleur si donnees vitesse, sinon vert).
      this.map!.addSource('replay-line', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: this.points },
          properties: {},
        },
      });
      this.map!.addLayer({
        id: 'replay-line',
        type: 'line',
        source: 'replay-line',
        paint: {
          'line-color': COULEURS_CARTE.trace,
          'line-width': 4,
          'line-opacity': 0.85,
        },
      });

      // Auto-fit sur l'ensemble du trajet.
      const points = this.points.map(([lng, lat]) => ({ lat, lng }));
      this.mapSvc.fitBounds(this.map!, points, { padding: 50, animate: false });

      // Marker initial.
      const data: VehicleMarkerData = {
        trackerId: '',
        vehicleId: '',
        type: this.vehicleType(),
        plate: '',
        speedKmh: trip.avgSpeed ?? 0,
        heading: 0,
        ignition: true,
      };
      this.markerEl = buildVehicleMarkerEl(data);
      this.markerEl.classList.add('tracky-marker--no-plate');
      this.marker = attachVehicleMarker(this.map!, this.markerEl, first[1], first[0]);

      // Traçabilité fine (Palier 4) : arrêts (bleu) + excès de vitesse (rouge) sur la carte.
      this.addAnalysisLayers();
    });

    // Triple resize défensif : couvre les transitions CSS qui finissent après
    // l'init et l'animation d'apparition du shell (sinon canvas blanc).
    setTimeout(() => this.map?.resize(), 50);
    setTimeout(() => this.map?.resize(), 250);
    setTimeout(() => this.map?.resize(), 600);
  }

  /** Ajoute les couches d'analyse (arrêts + excès) — appelé une fois la carte chargée. */
  private addAnalysisLayers(): void {
    const a = this.analysis();
    const map = this.map;
    if (!a || !map) return;

    const stops = (a.detail?.stops ?? []).filter((s) => isValidLatLng(s.lat, s.lng));
    if (stops.length > 0) {
      map.addSource('replay-stops', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: stops.map((s) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
            properties: { radius: Math.min(5 + s.durationMin / 4, 13) },
          })),
        },
      });
      map.addLayer({
        id: 'replay-stops', type: 'circle', source: 'replay-stops',
        paint: { 'circle-radius': ['get', 'radius'], 'circle-color': COULEURS_CARTE.arret, 'circle-opacity': 0.8, 'circle-stroke-width': 2, 'circle-stroke-color': COULEURS_CARTE.contour },
      });
    }

    const speeding = (a.detail?.speeding ?? []).filter((s) => isValidLatLng(s.lat, s.lng));
    if (speeding.length > 0) {
      map.addSource('replay-speeding', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: speeding.map((s) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
            properties: { radius: Math.min(5 + s.overKmh / 5, 12) },
          })),
        },
      });
      map.addLayer({
        id: 'replay-speeding', type: 'circle', source: 'replay-speeding',
        paint: { 'circle-radius': ['get', 'radius'], 'circle-color': COULEURS_CARTE.exces, 'circle-opacity': 0.9, 'circle-stroke-width': 2, 'circle-stroke-color': COULEURS_CARTE.contour },
      });
    }
  }

  private animate(): void {
    if (!this.playing()) return;

    const now = performance.now();
    const delta = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    const pointsPerSecond = this.points.length / TripReplayComponent.LECTURE_1X_SEC;
    const step = delta * this.speed() * pointsPerSecond;
    let idx = this.floatIndex + step;

    if (idx >= this.points.length - 1) {
      idx = this.points.length - 1;
      this.playing.set(false);
    }

    this.floatIndex = idx;
    this.currentIndex.set(Math.round(idx));
    const pt = this.points[Math.round(idx)];
    if (pt && this.marker) {
      this.marker.setLngLat(pt);

      // Update marker icon : vitesse via interpolation lineaire (rough), heading
      // calcule sur la direction du segment courant.
      const next = this.points[Math.min(this.points.length - 1, Math.round(idx) + 1)];
      let heading = 0;
      if (next && (next[0] !== pt[0] || next[1] !== pt[1])) {
        heading = bearingFrom(pt[1], pt[0], next[1], next[0]);
      }
      if (this.markerEl) {
        updateVehicleMarkerEl(this.markerEl, {
          trackerId: '',
          vehicleId: '',
          type: this.vehicleType(),
          plate: '',
          speedKmh: this.trip()?.avgSpeed ?? 30,
          heading,
          ignition: true,
        });
      }
    }

    if (this.playing()) {
      this.animId = requestAnimationFrame(() => this.animate());
    }
  }

  private cleanup(): void {
    this.playing.set(false);
    if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch { /* */ }
      this.resizeObserver = null;
    }
    this.marker?.remove();
    this.marker = null;
    this.markerEl = null;
    if (this.map) { this.map.remove(); this.map = null; }
    this.points = [];
  }
}

function bearingFrom(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

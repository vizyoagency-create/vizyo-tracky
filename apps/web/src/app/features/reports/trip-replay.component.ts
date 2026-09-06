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
import { LucideAngularModule, Play, Pause, X, MessageSquare, Pencil, Link2, Crosshair, ChevronDown, Car, Maximize } from 'lucide-angular';
import { TrackClickDirective } from '../../shared/directives/track-click.directive';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import type { SpeedingSegmentDto, TripAnalysisDto, TripDto } from '@vizyo/tracky-shared';
import { excesDuTrajet } from '@vizyo/tracky-shared';
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
// Les chiffres de l'en-tête viennent des MÊMES fonctions que la ligne du tableau :
// même plafond de vitesse (250), même arrondi de durée, même clamp de distance.
// Deux copies locales existaient ici — c'est ainsi que deux écrans finissent par
// décrire le même trajet différemment.
import { clampSpeed, formatDuration, max0 } from './reports.utils';
// La note lettrée est celle du classement ET des badges du tableau : une TROISIÈME
// échelle (80/50) vivait ici et donnait « Éco 74 » vert à côté d'un « C » ambre.
import { gradeOf } from '../trip-analysis/trip-analysis-badges.component';

/**
 * Un événement situé dans le trajet — un arrêt, un excès CONFIRMÉ, ou une pointe que
 * l'analyse refuse d'affirmer.
 *
 * ⚠️ `pointe` EST UN TROISIÈME TYPE, et pas une variante d'`exces`. Les deux partageaient
 * `'exces'` : la frise peignait donc les pointes du même rouge que les excès, sous un en-tête
 * qui n'en comptait qu'un et une légende qui ne parlait que d'« Excès confirmé ». Mesuré en
 * production le 2026-09-06 sur un trajet de « mh cars » — 1 excès confirmé (137 km/h pour 130,
 * tenu 99 s) et 5 pointes « point unique » — la frise affichait SIX traits rouges identiques.
 */
interface EvenementRejeu {
  type: 'arret' | 'exces' | 'pointe';
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

/**
 * Un relevé du tracé simplifié de l'analyse, replacé dans le trajet.
 *
 * `fraction` situe le relevé dans le TEMPS (0 = départ, 1 = arrivée) ; `partDistance`
 * dit quelle part du chemin était parcourue à cet instant. Les deux ne coïncident
 * pas — un arrêt de vingt minutes avance le temps sans avancer la distance —, et
 * c'est exactement ce qui manquait au replay : il lisait un index de polyligne.
 */
interface ReleveTrace {
  fraction: number;
  partDistance: number;
  speedKmh: number;
}

/** Ce que le bandeau de lecture affirme sur la vitesse, et d'où elle vient. */
interface VitesseAffichee {
  kmh: number;
  /** Vrai si la valeur est un relevé du trajet ; faux si c'est la moyenne. */
  mesuree: boolean;
  libelle: string;
}

/** Le récit du trajet tel qu'il est montré ici — jamais fabriqué, seulement relayé. */
interface RecitTrajet {
  texte: string;
  conseils: string[];
  fiabilite: string;
  /** Vrai si le récit a été écrit AVANT le dernier recalcul des chiffres. */
  perime: boolean;
}

@Component({
  selector: 'app-trip-replay',
  standalone: true,
  /**
   * ⚠️ `TrackClickDirective` MANQUAIT, et les huit `trackClick="…"` de ce fichier étaient
   * donc de simples attributs HTML : aucun clic du replay n'a jamais été compté. Le défaut
   * est muet par construction — un attribut inconnu ne fait ni erreur ni avertissement, et
   * la seule trace est l'absence de lignes dans le journal d'activité, que personne ne va
   * chercher. Les trois autres écrans qui posent ces marqueurs, eux, l'importent.
   */
  imports: [LucideAngularModule, DecimalPipe, TrackClickDirective],
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
                  <!-- Distance, durée, vitesse max : LES MÊMES fonctions que la ligne du
                       tableau (reports.utils), donc les mêmes chiffres. -->
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
                <!-- Le MÊME résumé que la cellule « Analyse » du tableau : note lettrée,
                     excès, puis les faits secondaires et les estimations. Le replay
                     n'affichait ni à-coups, ni ralenti, ni fiabilité : on croyait qu'un
                     des deux écrans mentait. -->
                <div class="tr-analysis-summary">
                  <span class="tr-as-chip" [attr.data-tier]="ecoTier(a.ecoScore ?? 0)">
                    @if (a.ecoScore !== null) { <b>{{ note(a.ecoScore) }}</b> Conduite {{ a.ecoScore }} }
                    @else { Note non calculable }
                  </span>
                  @if (nbExces() > 0) {
                    <span class="tr-as-chip tr-as-chip--speed">
                      {{ nbExces() }} excès@if (a.limitsKnown && a.maxOverKmh > 0) { <span> · +{{ a.maxOverKmh | number:'1.0-0' }} km/h</span> }@else if (!a.limitsKnown) { <span> · limites inconnues</span> }
                    </span>
                  }
                  <!-- Aucune limite résolue sur le trajet : « 0 excès » ne voudrait rien
                       dire, et ne rien afficher le laisserait croire. -->
                  @if (!a.limitsKnown && nbExces() === 0) {
                    <span class="tr-as-chip tr-as-chip--inconnu">Limites inconnues — excès non vérifiables</span>
                  }
                </div>
                @if (faits().length) { <p class="tr-as-l2">{{ faits().join(' · ') }}</p> }
                <!-- ⚠️ LES ESTIMATIONS SE REPLIENT, PAS LES FAITS. « 1 arrêt », « 3 à-coups »
                     décrivent ce qui EST arrivé ; les litres, le CO₂ et la fiabilité GPS sont
                     des estimations qu'on va chercher. Sur 375 px, ces deux lignes coûtaient
                     50 px à une carte qui n'en avait que 180. -->
                @if (estimations().length) {
                  @if (estRepliee('faits')) {
                    <button type="button" class="tr-plus" (click)="basculerSectionModale('faits')"
                            aria-expanded="false" trackClick="replay-voir-estimations">
                      <lucide-icon [img]="ChevronDownIcon" [size]="12"></lucide-icon>
                      Consommation, CO₂ et fiabilité
                    </button>
                  } @else {
                    <p class="tr-as-l3">{{ estimations().join(' · ') }}</p>
                  }
                }
                <!-- L'écart entre le trajet et son analyse est DIT, pas masqué : les deux
                     comptent des positions différentes, et un lecteur qui voit 180 km
                     ici et 150 km dans le récit doit savoir pourquoi. -->
                @if (ecartAnalyse(); as e) {
                  @if (!estRepliee('faits')) { <p class="tr-as-ecart">{{ e }}</p> }
                }
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
            <!-- ══ CITER CE TRAJET AILLEURS (F10) ═══════════════════════════════════
                 Un trajet précis ne pouvait pas se citer dans un courriel ou un ticket :
                 il fallait demander à son interlocuteur de le retrouver lui-même dans un
                 tableau paginé, à partir d'une date et d'une plaque. -->
            @if (lienPartage()) {
              <button type="button" (click)="copierLien.emit()"
                      aria-label="Copier le lien de ce trajet"
                      title="Copier le lien de ce trajet"
                      class="tr-replay-lien shrink-0 inline-flex items-center justify-center gap-1.5
                             h-11 px-3 rounded-full bg-bg-tertiary/80 backdrop-blur-sm
                             text-fg-secondary hover:text-fg-primary hover:bg-bg-tertiary
                             border border-border-subtle cursor-pointer transition-colors
                             text-[11.5px] font-semibold">
                <lucide-icon [img]="LinkIcon" [size]="15"></lucide-icon>
                <span class="hidden sm:inline">Copier le lien</span>
              </button>
            }
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
            <!-- 180 px de plancher sur mobile, 280 au-dela : l'en-tete (resume) et la
                 barre de lecture (heure, vitesse, frise) sont incompressibles, et un
                 plancher de carte trop haut poussait la barre hors de l'ecran sur les
                 petits telephones — la commande principale devenait inatteignable. -->
            <div class="tr-carte-hote relative flex-1 flex flex-col min-h-[260px] sm:min-h-[280px]">
              <div #mapContainer class="flex-1"></div>
              <!-- ══ LA VITESSE, SUR LA CARTE ══════════════════════════════════════════
                   Elle existait déjà, mais SOUS la carte, en petit, sous la frise — loin
                   du véhicule qu'on regarde. Sur un trajet court elle vaut en plus la même
                   chose que le « max » de l'en-tête, si bien qu'elle passait pour un
                   rappel figé de celui-ci. Relevé à l'audit : la valeur bougeait bien
                   (26 → 8 → 0 km/h), personne ne pouvait le voir.
                   Elle est donc posée EN SURIMPRESSION, à côté de ce qu'elle décrit. Le
                   bandeau du bas est conservé : il porte l'heure, la provenance du relevé
                   et l'excès en cours, que cette pastille n'a pas la place de dire. -->
              <div class="tr-vit-carte" [class.tr-vit-carte--moyenne]="!vitesse().mesuree"
                   role="status" [attr.aria-label]="'Vitesse à l’instant lu : ' + (vitesse().kmh | number:'1.0-0') + ' kilomètres-heure'">
                <b>{{ vitesse().kmh | number:'1.0-0' }}</b><small>km/h</small>
              </div>
              <!-- ⚠️ N'APPARAÎT QUE QUAND LE SUIVI EST COUPÉ, c'est-à-dire quand
                   l'utilisateur a déplacé la carte lui-même. Un bouton toujours affiché
                   pour une caméra qui suit déjà n'aurait rien à corriger. -->
              @if (!suiviActif()) {
                <button type="button" class="tr-suivre" (click)="reprendreLeSuivi()"
                        trackClick="replay-reprendre-suivi">
                  <lucide-icon [img]="CrosshairIcon" [size]="13"></lucide-icon>
                  Suivre le véhicule
                </button>
              }
              <!-- ══ LES DEUX ÉCHELLES D'UN REPLAY ═══════════════════════════════════════
                   La carte s'ouvre sur TOUT le trajet : 47 km dans 342 px de large, où la
                   voiture est un point et la route un trait. À cette échelle le suivi ne
                   sert à rien — la voiture ne quitte jamais les 60 % centraux, donc la
                   caméra ne bouge pas d'un pixel de toute la lecture.
                   Pour regarder la conduite il fallait pincer trois fois, à chaque
                   ouverture, et le geste coupait le suivi. Ce bouton fait les deux d'un
                   coup, et sait revenir. -->
              <button type="button" class="tr-cam" (click)="basculerCamera()"
                      [attr.aria-pressed]="modeCamera() === 'conduite'"
                      [trackClick]="modeCamera() === 'conduite' ? 'replay-vue-trajet' : 'replay-vue-conduite'">
                <lucide-icon [img]="modeCamera() === 'conduite' ? MaximizeIcon : CarIcon" [size]="13"></lucide-icon>
                {{ modeCamera() === 'conduite' ? 'Tout le trajet' : 'Zoom sur la voiture' }}
              </button>
              @if (analysis(); as a) {
                @if (a.stopCount > 0 || nbExces() > 0 || nbPointes() > 0) {
                  <div class="tr-legend">
                    @if (a.stopCount > 0) { <span><i class="tr-dot" [style.background]="couleursCarte.arret"></i> Arrêt</span> }
                    @if (nbExces() > 0) { <span><i class="tr-dot" [style.background]="couleursCarte.exces"></i> Excès confirmé</span> }
                    <!-- ⚠️ La légende doit nommer TOUT ce que la carte et la frise montrent.
                         Elle ne disait qu'« Excès confirmé » pendant que la frise portait aussi
                         les pointes : le lecteur comptait des fautes qui n'en étaient pas. -->
                    @if (nbPointes() > 0) { <span><i class="tr-dot" [style.background]="couleursCarte.pointe"></i> Pointe à vérifier</span> }
                  </div>
                }
              }
            </div>

            <!-- Le récit et « ce qui s'est passé ». Le récit était produit pour CE
                 trajet et n'était lisible qu'ailleurs : il fallait fermer le replay,
                 retrouver la ligne, rouvrir la fiche. -->
            @if (evenements().length || recit()) {
              <aside class="tr-aside">
                <div class="tr-aside-scroll">
                  @if (recit(); as r) {
                    <section class="tr-recit">
                      <!-- ⚠️ AU DOIGT, LE RÉCIT NAÎT REPLIÉ, et le bouton porte alors le
                           repli plutôt que le « Lire la suite » : deux lignes d'extrait
                           coûtaient 110 px à une carte qui n'en avait que 180, pour un texte
                           que ce même bouton invitait déjà à déplier. Sur écran large rien
                           ne change — l'extrait reste visible d'emblée. -->
                      <button type="button" class="tr-recit-b"
                              (click)="estRepliee('recit') ? basculerSectionModale('recit') : basculerRecit()"
                              [attr.aria-expanded]="!estRepliee('recit') && recitOuvert()">
                        <span class="tr-recit-titre">Le récit de ce trajet</span>
                        <span class="tr-recit-plus">
                          {{ estRepliee('recit') ? 'Lire' : (recitOuvert() ? 'Réduire' : 'Lire la suite') }}
                        </span>
                      </button>
                      @if (!estRepliee('recit')) {
                      @if (r.perime) {
                        <p class="tr-recit-perime">
                          Récit écrit AVANT le dernier recalcul des chiffres : il décrit le trajet
                          tel qu'il était analysé auparavant.
                        </p>
                      }
                      @if (r.texte) {
                        <p class="tr-recit-t" [class.tr-recit-t--court]="!recitOuvert()">{{ r.texte }}</p>
                      }
                      @if (recitOuvert()) {
                        @if (r.conseils.length) {
                          <h4 class="tr-recit-h4">Conseils d'éco-conduite</h4>
                          <ul class="tr-conseils">
                            @for (c of r.conseils; track $index) { <li>{{ c }}</li> }
                          </ul>
                        }
                        @if (r.fiabilite) { <p class="tr-recit-fia">{{ r.fiabilite }}</p> }
                      }
                      }
                    </section>
                  }

                  @if (evenements().length) {
                    <!-- ══ L'ÉVENTAIL DES ARRÊTS ET DES EXCÈS ═══════════════════════════
                         OUVERT par défaut, même au doigt : c'est la liste qu'on touche pour
                         se déplacer dans le trajet — la replier d'office reviendrait à
                         cacher la commande principale. Mais elle se replie, parce qu'un
                         trajet à sept événements poussait la barre de lecture hors de
                         l'écran. Le compte reste visible dans l'en-tête : on sait ce qu'on
                         rouvre sans avoir à le rouvrir. -->
                    <button type="button" class="tr-aside-titre tr-aside-titre--b"
                            (click)="basculerSectionModale('evenements')"
                            [attr.aria-expanded]="!estRepliee('evenements')"
                            aria-controls="tr-sec-evenements"
                            trackClick="replay-replier-evenements">
                      <lucide-icon [img]="ChevronDownIcon" [size]="14" class="tr-chev"
                                   [class.tr-chev--ferme]="estRepliee('evenements')"></lucide-icon>
                      Ce qui s'est passé
                      <span>{{ evenements().length }} événement{{ evenements().length > 1 ? 's' : '' }}</span>
                    </button>
                    <ul class="tr-evs" id="tr-sec-evenements" [class.tr-sec--repliee]="estRepliee('evenements')">
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
                  }
                </div>
              </aside>
            }
          </div>

          <div class="tr-barre">
            <!-- L'instant lu, la vitesse, et D'OÙ elle vient. Une moyenne affichée
                 « Vitesse » restait à 62 km/h pendant un arrêt et pendant un excès
                 à 124 : le replay contredisait le trajet qu'il rejouait. -->
            <div class="tr-hud">
              <span class="tr-hud-h">{{ heureCourante() }}</span>
              <span class="tr-hud-v" [class.tr-hud-v--moyenne]="!vitesse().mesuree">
                {{ vitesse().kmh | number:'1.0-0' }}<small>km/h</small>
              </span>
              <span class="tr-hud-l">{{ vitesse().libelle }}</span>
              @if (excesEnCours(); as ex) {
                <span class="tr-hud-exces">
                  Excès en cours · pointe {{ ex.maxSpeedKmh | number:'1.0-0' }} km/h
                  (limite {{ ex.limitKmh | number:'1.0-0' }})
                </span>
              }
            </div>

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
                     44 px posée sur la glissière en intercepterait le glissement.
                     Leur position et celle du curseur sont maintenant la MÊME grandeur
                     — la part de temps écoulée —, donc elles coïncident. -->
                <div class="tr-marques">
                  @for (ev of evenements(); track ev.at) {
                    <button type="button" class="tr-marque" [attr.data-type]="ev.type"
                            [style.left.%]="ev.fraction * 100"
                            (click)="allerA(ev)"
                            [attr.aria-label]="'Aller à ' + ev.heure + ' — ' + ev.titre"
                            [title]="ev.heure + ' — ' + ev.titre"><i></i></button>
                  }
                </div>
                <input type="range" [min]="0" [max]="pas" step="1" [value]="curseur()"
                       aria-label="Position dans le trajet"
                       [attr.aria-valuetext]="heureCourante()"
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
    .tr-as-chip b { font-weight: 800; }
    /* Chips d'analyse : jetons de PETIT TEXTE (11 px). Les valeurs d'avant — #F59E0B,
       #EF4444, #60A5FA — donnaient 2,7 à 3,4:1 en thème clair, sous le seuil. */
    .tr-as-chip[data-tier="good"] { background: color-mix(in srgb, var(--texte-succes) 16%, transparent); color: var(--texte-succes); border-color: transparent; }
    .tr-as-chip[data-tier="mid"]  { background: color-mix(in srgb, var(--texte-attente) 16%, transparent); color: var(--texte-attente); border-color: transparent; }
    .tr-as-chip[data-tier="bad"]  { background: color-mix(in srgb, var(--texte-alerte) 16%, transparent); color: var(--texte-alerte); border-color: transparent; }
    .tr-as-chip--speed { background: color-mix(in srgb, var(--texte-alerte) 14%, transparent); color: var(--texte-alerte); border-color: transparent; }
    .tr-as-chip--inconnu { background: color-mix(in srgb, var(--texte-attente) 14%, transparent); color: var(--texte-attente); border-color: transparent; }
    /* Faits secondaires puis estimations — la même hiérarchie que la cellule du tableau. */
    .tr-as-l2 { margin: 4px 0 0; font-size: 11.5px; line-height: 1.4; color: var(--fg-secondary); }
    .tr-as-l3 { margin: 2px 0 0; font-size: 11px; line-height: 1.4; color: var(--fg-tertiary); }
    .tr-as-ecart { margin: 4px 0 0; font-size: 11px; line-height: 1.45; color: var(--texte-attente); }

    /* ─── La vitesse lue, en surimpression de la carte ───
       Même matière que la légende (fond translucide, flou) pour qu'on la lise sur
       n'importe quel fond de carte, clair ou sombre. En HAUT à droite : la légende occupe
       le bas à gauche, et les commandes de zoom le bas à droite. */
    .tr-vit-carte {
      position: absolute; right: 10px; top: 10px; z-index: 5;
      display: inline-flex; align-items: baseline; gap: 3px;
      padding: 6px 10px; border-radius: 10px;
      background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
      backdrop-filter: blur(6px);
      border: 1px solid var(--border-subtle);
      font-variant-numeric: tabular-nums;
    }
    .tr-vit-carte b { font-size: 20px; font-weight: 800; color: var(--fg-primary); line-height: 1; }
    .tr-vit-carte small { font-size: 10px; font-weight: 700; color: var(--fg-tertiary); }
    /* ⚠️ Une vitesse DÉDUITE de la moyenne ne se lit pas comme une mesure : elle est mise
       en retrait, exactement comme le bandeau du bas le fait déjà (classe tr-hud-v--moyenne).
       Deux surfaces qui affichent le même chiffre doivent porter la même réserve. */
    .tr-vit-carte--moyenne b { color: var(--fg-secondary); font-weight: 700; }

    /* Le retour au véhicule, quand le doigt a pris la main sur la caméra. */
    .tr-suivre {
      position: absolute; right: 10px; top: 52px; z-index: 5;
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; padding: 8px 12px; border-radius: 10px;
      background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
      backdrop-filter: blur(6px);
      border: 1px solid var(--border-subtle);
      font-size: 11.5px; font-weight: 700; color: var(--fg-primary);
      cursor: pointer;
    }
    .tr-suivre:hover { border-color: var(--tracky-light, #10E0A0); }
    .tr-suivre lucide-icon { color: var(--tracky-light, #10E0A0); }

    /* La bascule d'échelle occupe le coin HAUT-GAUCHE : la pastille de vitesse tient le
       haut-droit, le bouton « Suivre le véhicule » juste dessous, la légende le bas-gauche.
       C'est le seul coin libre, et le plus proche du pouce sur un téléphone tenu à gauche. */
    .tr-cam {
      position: absolute; left: 10px; top: 10px; z-index: 5;
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; padding: 8px 12px; border-radius: 10px;
      background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
      backdrop-filter: blur(6px);
      border: 1px solid var(--border-subtle);
      font-size: 11.5px; font-weight: 700; color: var(--fg-primary);
      cursor: pointer;
    }
    .tr-cam:hover { border-color: var(--tracky-light, #10E0A0); }
    .tr-cam lucide-icon { color: var(--tracky-light, #10E0A0); }
    /* En vue conduite le bouton porte l'accent : c'est un MODE actif, pas une action
       disponible, et rien d'autre à l'écran ne dit à quelle échelle on regarde. */
    .tr-cam[aria-pressed="true"] {
      border-color: var(--tracky-light, #10E0A0);
      background: color-mix(in srgb, var(--color-tracky-light) 14%, var(--bg-secondary));
    }
    /* Sous 380 px, la légende et la bascule se disputent la largeur : la légende descend
       d'un cran plutôt que de passer dessous, où elle masquerait la fin du tracé. */
    @media (max-width: 380px) {
      .tr-cam { font-size: 11px; padding: 8px 10px; }
    }

    /* ─── Ce qui se replie dans la modale ─── */
    /* ⚠️ Borné à l'écran, comme sur la page Rapports : à l'impression une section repliée
       doit sortir quand même, avec sa mise en page d'origine. */
    @media screen {
      .tr-sec--repliee { display: none !important; }
    }
    .tr-chev { color: var(--tracky-light, #10E0A0); flex-shrink: 0; transition: transform .2s; }
    .tr-chev--ferme { transform: rotate(-90deg); }
    /* Le repli des estimations : un lien discret, pas une pastille — il ne doit pas
       concurrencer les deux chips de note et d'excès juste au-dessus. */
    .tr-plus {
      display: inline-flex; align-items: center; gap: 5px;
      min-height: 44px; padding: 0; margin: 0;
      background: none; border: none; cursor: pointer;
      font-size: 11.5px; font-weight: 700; color: var(--fg-tertiary);
    }
    .tr-plus:hover { color: var(--fg-secondary); }
    .tr-plus lucide-icon { color: var(--tracky-light, #10E0A0); transform: rotate(-90deg); }

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

    /* ─── Corps : la carte, le récit, et le journal des événements ───
       Au-dela de 1024 px le panneau tient a cote de la carte ; en dessous il
       passe sous elle, avec son propre defilement. Il n'est jamais replie :
       savoir QUAND regarder est la raison d'etre de cet ecran. */
    .tr-corps { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .tr-aside {
      display: flex; flex-direction: column; min-height: 0;
      max-height: 42%;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
    }
    /* Un SEUL defilement pour le panneau : le recit et les evenements bougent
       ensemble, sinon le recit reste coince en haut d'une liste qui defile. */
    .tr-aside-scroll { overflow-y: auto; min-height: 0; padding-bottom: 10px; }
    /*
     * ─── SOUS 1024 px, C'EST LE CORPS QUI DÉFILE, PAS LE PANNEAU ───
     *
     * ⚠️ MESURÉ EN PRODUCTION LE 2026-09-06, iPhone 375 × 812 : le panneau recevait
     * 33 PIXELS DE HAUT pour 590 px de contenu. Le titre « Le récit de ce trajet » était
     * coupé en deux, et la liste des événements — celle qu'on vient toucher pour se déplacer
     * dans le trajet — était hors d'atteinte.
     *
     * L'arithmétique ne laissait pas le choix : l'en-tête prend 309 px, la barre de lecture
     * 167, il reste 294 px de corps, et la carte en réclame 260 (min-h-[260px], relevé de
     * 180 au lot précédent pour qu'un tracé y soit lisible). 294 − 260 = 34. Le
     * max-height: 42% du panneau ne l'a jamais protégé : il PLAFONNE, il ne réserve rien.
     *
     * Donner un plancher au panneau ne suffisait pas non plus — 260 + 148 = 408 pour 294 px
     * disponibles : sur un écran court, les deux ne tiennent pas ensemble, quelle que soit la
     * répartition. Donc le corps défile, la carte garde ses 260 px, et le panneau prend sa
     * hauteur naturelle. L'en-tête et la barre de lecture restent fixes : c'est la barre qu'on
     * doit pouvoir atteindre à tout moment pendant la lecture.
     *
     * Le défilement INTÉRIEUR du panneau est retiré ici, sinon deux zones défilantes
     * s'emboîtent et le doigt ne sait plus laquelle il déplace.
     */
    @media (max-width: 1023px) {
      .tr-corps { overflow-y: auto; }
      .tr-aside { max-height: none; }
      .tr-aside-scroll { overflow-y: visible; }
    }
    /*
     * Sur un écran COURT, la carte cède 40 px de son plancher.
     *
     * Le corps défile désormais, donc le panneau est atteignable — mais à 812 px de haut il
     * n'en dépassait que 34, et le titre « Le récit de ce trajet » arrivait coupé en son
     * milieu. Une ligne tranchée se lit comme un défaut d'affichage, pas comme « la suite est
     * en dessous ». À 220 px la carte reste bien au-dessus des 180 px d'avant le lot
     * précédent, et le panneau montre son premier titre en entier plus l'amorce du suivant :
     * cette amorce-là, elle, se lit comme une invitation à faire défiler.
     *
     * ⚠️ Bornée en HAUTEUR, pas en largeur : c'est la place verticale qui manque. Sur un
     * téléphone posé à l'horizontale comme sur une tablette haute, la carte garde ses 260 px.
     */
    @media (max-width: 1023px) and (max-height: 900px) {
      .tr-carte-hote { min-height: 220px; }
    }
    @media (min-width: 1024px) {
      .tr-corps { flex-direction: row; }
      .tr-aside { max-height: none; width: 328px; flex: none; border-top: none; border-left: 1px solid var(--border-subtle); }
    }

    /* ─── Le récit, replié par défaut ─── */
    .tr-recit { padding: 10px 14px 6px; border-bottom: 1px solid var(--border-subtle); }
    .tr-recit-b {
      width: 100%; min-height: 44px;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 0; background: transparent; border: none; cursor: pointer; text-align: left;
    }
    .tr-recit-titre { font-size: 13px; font-weight: 700; color: var(--fg-primary); }
    .tr-recit-plus { font-size: 11.5px; font-weight: 700; color: var(--texte-succes); }
    .tr-recit-t { margin: 2px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); }
    /* Deux lignes repliees : assez pour savoir de quoi parle le recit, pas assez
       pour manger le journal des evenements. */
    .tr-recit-t--court {
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .tr-recit-perime {
      margin: 4px 0 0; padding: 6px 8px; border-radius: 8px;
      font-size: 11px; line-height: 1.4;
      background: color-mix(in srgb, var(--texte-attente) 12%, transparent);
      color: var(--texte-attente);
    }
    .tr-recit-h4 { margin: 10px 0 4px; font-size: 12px; font-weight: 700; color: var(--fg-primary); }
    .tr-conseils { margin: 0; padding-left: 16px; display: grid; gap: 3px; }
    .tr-conseils li { font-size: 12px; line-height: 1.45; color: var(--fg-secondary); }
    .tr-recit-fia { margin: 8px 0 0; font-size: 11px; color: var(--fg-tertiary); }

    .tr-aside-titre {
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      margin: 0; padding: 12px 14px 8px;
      font-size: 13px; font-weight: 700; color: var(--fg-primary);
    }
    .tr-aside-titre span { font-size: 11px; font-weight: 600; color: var(--fg-secondary); }
    /* ⚠️ POSÉ APRÈS SA BASE, jamais avant. L'élément porte LES DEUX classes, et deux
       sélecteurs d'une classe ont la même spécificité : seul l'ordre tranche. Déclarée
       plus haut, cette règle était strictement inerte — le piège que ce dépôt a déjà payé
       trois fois, et que cascade-css.spec.ts tient désormais sur la page Rapports.
       L'en-tête devient un bouton : même dessin, plus un chevron et 44 px au doigt. */
    .tr-aside-titre--b {
      width: 100%; min-height: 44px; cursor: pointer;
      background: none; border: none; text-align: left;
      align-items: center;
    }
    .tr-evs { list-style: none; margin: 0; padding: 0 10px; display: grid; gap: 4px; }
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
    .tr-ev[data-type="pointe"] { border-left-color: var(--texte-orange); }
    .tr-ev[data-type="arret"] { border-left-color: var(--texte-info); }
    .tr-ev-h { flex: none; font-size: 11.5px; font-weight: 700; color: var(--fg-secondary); font-variant-numeric: tabular-nums; padding-top: 1px; }
    .tr-ev-c { display: grid; gap: 2px; min-width: 0; }
    .tr-ev-t { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); }
    .tr-ev-d { font-size: 11.5px; line-height: 1.4; color: var(--fg-secondary); }

    /* ─── Barre de lecture ─── */
    .tr-barre { flex-shrink: 0; border-top: 1px solid var(--border-subtle); padding: 8px 16px 10px; display: grid; gap: 8px; }
    @media (min-width: 640px) { .tr-barre { padding: 8px 24px 10px; } }
    /* Le bandeau de lecture : l'heure lue, la vitesse, et sa provenance. */
    .tr-hud { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
    .tr-hud-h { font-size: 13px; font-weight: 700; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .tr-hud-v { font-size: 17px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .tr-hud-v small { font-size: 10px; font-weight: 700; color: var(--fg-secondary); margin-left: 2px; }
    /* Une valeur qui n'est PAS une mesure ne se donne pas les airs d'une mesure. */
    .tr-hud-v--moyenne { color: var(--fg-secondary); font-weight: 700; }
    .tr-hud-l { font-size: 11px; line-height: 1.4; color: var(--fg-tertiary); }
    .tr-hud-exces {
      padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 700;
      background: color-mix(in srgb, var(--texte-alerte) 14%, transparent);
      color: var(--texte-alerte);
    }
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
    /* Ambre ET plus courte que l'excès confirmé : la couleur seule ne suffit pas — un
       daltonien deutan lit le rouge et l'ambre presque pareil, et c'est justement la
       distinction entre « faute » et « doute » qu'il ne faut pas lui coûter. */
    .tr-marque[data-type="pointe"] i { background: var(--texte-orange); height: 13px; }
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

  /**
   * Lot V7 — LE compte des excès, celui que lisent aussi le rapport de vitesse et le PDF.
   * On affichait `speedingCount`, le compteur écrit au moment de l'analyse : sur les analyses
   * antérieures au lot V2, il retient des segments de durée nulle que la règle actuelle écarte.
   */
  protected readonly nbExces = computed(() => excesDuTrajet(this.analysis()).nombre);
  /**
   * Les pointes écartées par l'analyse. Elles NE COMPTENT PAS comme des excès — c'est tout
   * l'objet de la distinction — mais la légende doit les nommer, faute de quoi la frise et la
   * carte montrent une couleur que rien n'explique.
   */
  protected readonly nbPointes = computed(() => (this.analysis()?.detail?.aVerifier ?? []).length);
  readonly vehicleType = input<string>('OTHER');
  /** Si true, affiche le bouton crayon "Modifier la note". */
  readonly canEditNote = input<boolean>(false);
  /**
   * Lien PARTAGEABLE de ce trajet, ou `null` quand l'écran hôte n'en fabrique pas.
   *
   * ⚠️ Le lien est construit par le PARENT, qui seul connaît l'URL de la page et ses
   * filtres. Le fabriquer ici obligerait ce composant à connaître la route qui l'affiche —
   * il est utilisé aussi bien depuis la page Rapports que depuis une fiche véhicule.
   */
  readonly lienPartage = input<string | null>(null);
  readonly copierLien = output<void>();
  readonly closed = output<void>();
  /** Demande au parent d'ouvrir le modal d'edition pour le trip courant. */
  readonly editNote = output<TripDto>();

  /** Exposé au template : la légende doit porter la couleur RÉELLE des couches de carte. */
  protected readonly LinkIcon = Link2;
  protected readonly CrosshairIcon = Crosshair;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly CarIcon = Car;
  protected readonly MaximizeIcon = Maximize;
  protected readonly couleursCarte = COULEURS_CARTE;
  /**
   * Les chiffres de l'en-tête passent par les MÊMES fonctions que le tableau. Une
   * copie locale de `clampSpeed` (plafond écrit à la main) et de `formatDur` vivait
   * ici : deux écrans, deux implémentations, et un jour deux résultats.
   */
  protected readonly max0 = max0;
  protected readonly clampSpeed = clampSpeed;
  protected readonly formatDur = formatDuration;
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

  /**
   * La caméra suit-elle le véhicule ? Vrai par défaut, coupé dès que l'utilisateur
   * manipule la carte lui-même (cf. `suivreSiBesoin` et l'écoute posée à la création).
   */
  protected readonly suiviActif = signal(true);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * DEUX ÉCHELLES, DEUX RÈGLES DE CAMÉRA — ET C'EST L'UTILISATEUR QUI CHOISIT
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * « trajet »  — l'ouverture : toute la trace tient dans le cadre. On voit le parcours,
   *               pas la conduite. La caméra ne recentre qu'au bord (règle historique).
   * « conduite » — l'échelle de la route : on voit les rues, les sorties, l'endroit exact
   *               d'un excès. La caméra reste COLLÉE à la voiture.
   *
   * ── POURQUOI DEUX RÈGLES DE SUIVI, ET PAS UNE ────────────────────────────────────────
   *
   * La règle des 60 % centraux a été écrite pour le zoom que l'utilisateur avait choisi
   * lui-même : y recentrer à chaque image aurait rendu la carte illisible. En vue conduite,
   * la promesse est l'inverse — on demande explicitement à rester sur la voiture — et la
   * règle du bord y produirait un défilement par à-coups : à 1x, ce replay comprime 1 h 07
   * en 30 s, soit 134 fois le temps réel, donc la voiture traverse un cadre de 700 m en
   * moins de deux secondes. On recentre donc à chaque image, sans animation : ce sont les
   * positions qui sont interpolées, le mouvement est déjà lisse.
   *
   * ⚠️ LE DOIGT GAGNE TOUJOURS, dans les deux modes : un geste coupe le suivi et fait
   * apparaître « Suivre le véhicule », qui le réarme À L'ÉCHELLE DU MODE COURANT.
   */
  protected readonly modeCamera = signal<'trajet' | 'conduite'>('trajet');

  /**
   * Le zoom de la vue conduite : environ 700 m de large sur un téléphone. Assez serré pour
   * lire les rues et situer un excès, assez large pour que la voiture ne sorte pas du cadre
   * entre deux images de lecture.
   *
   * ⚠️ Ce n'est qu'un POINT DE DÉPART : le pincement de l'utilisateur reste souverain, et le
   * suivi conserve ensuite le zoom qu'il a choisi.
   */
  private static readonly ZOOM_CONDUITE = 15;

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * CE QUI SE REPLIE DANS LA MODALE — LA CARTE D'ABORD
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * Mesuré sur la production, à 375 × 812 : la modale occupe 726 px, et la CARTE n'en a que
   * 180 — un quart. L'en-tête en prend 200 à lui seul (titre, deux pastilles, les faits,
   * les estimations, la note), le récit 110, et « Ce qui s'est passé » se retrouvait COUPÉ
   * en bas : la liste des excès, c'est-à-dire ce qu'on vient cliquer, était hors d'atteinte.
   *
   * Sur un replay, la carte EST le sujet. Tout le reste l'accompagne.
   *
   * ── CE QUI SE REPLIE, ET DANS QUEL ÉTAT IL NAÎT ──────────────────────────────────────
   *
   *   `faits`       — litres, CO₂, fiabilité GPS, écart d'analyse : replié au doigt. Ce
   *                   sont des chiffres qu'on va CHERCHER, jamais qu'on surveille.
   *   `recit`       — replié au doigt : deux lignes d'extrait coûtaient 110 px pour un
   *                   texte que le bouton « Lire la suite » invitait déjà à déplier.
   *   `evenements`  — OUVERT par défaut, mais repliable : c'est la liste des arrêts et des
   *                   excès, celle qu'on touche pour se déplacer dans le trajet. La replier
   *                   d'office reviendrait à cacher la commande principale.
   *
   * ⚠️ Sur écran large, RIEN n'est replié : la place ne manque pas, et fermer des sections
   * d'office y serait une perte sèche.
   */
  private readonly SECTIONS_MODALE = ['faits', 'recit', 'evenements'] as const;
  private readonly REPLIS_AU_DOIGT = ['faits', 'recit'] as const;

  protected readonly sectionsRepliees = signal<ReadonlySet<string>>(
    typeof matchMedia === 'function' && matchMedia('(max-width: 768px)').matches
      ? new Set(this.REPLIS_AU_DOIGT)
      : new Set<string>(),
  );

  protected estRepliee(cle: string): boolean {
    return this.sectionsRepliees().has(cle);
  }

  protected basculerSectionModale(cle: string): void {
    if (!(this.SECTIONS_MODALE as readonly string[]).includes(cle)) return;
    const suivant = new Set(this.sectionsRepliees());
    if (suivant.has(cle)) suivant.delete(cle);
    else suivant.add(cle);
    this.sectionsRepliees.set(suivant);
    // La carte change de taille quand une section s'ouvre ou se ferme : sans ce redimensionnement,
    // MapLibre garde son ancien canvas et rend une bande grise sur la hauteur gagnée.
    queueMicrotask(() => this.map?.resize());
  }
  protected readonly speed = signal(1);
  protected readonly recitOuvert = signal(false);

  /**
   * Le curseur de lecture, en MILLIÈMES DE TEMPS écoulé (0 = départ, 1000 = arrivée).
   *
   * Il portait auparavant un INDEX de polyligne. Or la polyligne est simplifiée
   * (Douglas-Peucker / OSRM) : ses points ne sont pas régulièrement espacés dans le
   * temps. Un arrêt de vingt minutes y tient en deux points, donc durait zéro seconde
   * à la lecture, et les repères de la frise — posés, eux, sur le temps — n'étaient
   * jamais atteints au bon moment.
   */
  protected readonly curseur = signal(0);
  protected readonly pas = 1000;

  protected readonly PlayIcon = Play;
  protected readonly PauseIcon = Pause;
  protected readonly XIcon = X;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;

  protected onEditNoteClick(): void {
    const t = this.trip();
    if (t) this.editNote.emit(t);
  }

  protected basculerRecit(): void { this.recitOuvert.update((v) => !v); }

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

  /** Part du trajet écoulée, de 0 à 1 — la grandeur qui pilote TOUT cet écran. */
  protected readonly fraction = computed(() => this.curseur() / this.pas);

  /**
   * Les bornes temporelles du trajet. `endedAt` peut manquer (trajet en cours ou
   * legacy) : on retombe alors sur la durée, jamais sur une étendue nulle.
   */
  private readonly bornes = computed<{ t0: number; etendue: number } | null>(() => {
    const t = this.trip();
    if (!t) return null;
    const t0 = Date.parse(t.startedAt);
    if (!Number.isFinite(t0)) return null;
    const fin = t.endedAt ? Date.parse(t.endedAt) : NaN;
    const t1 = Number.isFinite(fin) && fin > t0 ? fin : t0 + Math.max(1, t.durationSeconds) * 1000;
    return { t0, etendue: Math.max(1, t1 - t0) };
  });

  /** L'heure lue à l'instant courant — ce que le curseur désigne, en clair. */
  protected readonly heureCourante = computed(() => {
    const b = this.bornes();
    if (!b) return '—';
    return this.heure(b.t0 + this.fraction() * b.etendue);
  });

  /**
   * Le tracé horodaté de l'analyse, replacé dans le trajet.
   *
   * C'est la SEULE source d'une vitesse instantanée côté web : l'API la transporte
   * (jusqu'à 60 relevés, `detail.track`) et personne ne la lisait. Vide quand
   * l'analyse est absente ou muette — le repli est alors dit à l'écran, pas déguisé.
   */
  private readonly profil = computed<ReleveTrace[]>(() => {
    const a = this.analysis();
    const b = this.bornes();
    if (!a || !b) return [];
    const bruts = (a.detail?.track ?? [])
      .map((p) => ({ ms: Date.parse(p.t), lat: p.lat, lng: p.lng, speedKmh: p.speedKmh }))
      .filter((p) => Number.isFinite(p.ms) && isValidLatLng(p.lat, p.lng))
      .sort((x, y) => x.ms - y.ms);
    if (bruts.length < 2) return [];

    const cumuls: number[] = [0];
    for (let i = 1; i < bruts.length; i++) {
      const prec = bruts[i - 1]!;
      const cur = bruts[i]!;
      cumuls.push((cumuls[i - 1] ?? 0) + haversineMeters(prec.lat, prec.lng, cur.lat, cur.lng));
    }
    const total = cumuls[cumuls.length - 1] ?? 0;
    return bruts.map((p, i) => ({
      fraction: Math.min(1, Math.max(0, (p.ms - b.t0) / b.etendue)),
      partDistance: total > 0 ? (cumuls[i] ?? 0) / total : i / (bruts.length - 1),
      speedKmh: clampSpeed(p.speedKmh),
    }));
  });

  /**
   * La vitesse affichée, et ce qu'elle vaut.
   *
   * Le relevé le plus proche dans le temps est une MESURE du trajet ; la moyenne n'en
   * est pas une et le dit. On n'interpole pas entre deux relevés : la valeur montrée
   * a été enregistrée, elle n'a pas été fabriquée pour l'occasion.
   */
  protected readonly vitesse = computed<VitesseAffichee>(() => {
    const releves = this.profil();
    const f = this.fraction();
    if (releves.length > 0) {
      let meilleur = releves[0]!;
      let ecart = Math.abs(meilleur.fraction - f);
      for (const r of releves) {
        const e = Math.abs(r.fraction - f);
        if (e <= ecart) { ecart = e; meilleur = r; }
      }
      // Un relevé vieux de plusieurs minutes reste une mesure, mais ce n'est plus la
      // mesure de CET instant : l'écart est dit plutôt que dissimulé.
      const b = this.bornes();
      const ecartSec = b ? (ecart * b.etendue) / 1000 : 0;
      const libelle = ecartSec > 120
        ? 'relevé GPS le plus proche — à ' + this.dureeCourte(ecartSec) + ' de l\'instant affiché'
        : 'relevé GPS le plus proche de cet instant';
      return { kmh: meilleur.speedKmh, mesuree: true, libelle };
    }
    return {
      kmh: clampSpeed(this.trip()?.avgSpeed),
      mesuree: false,
      libelle: 'moyenne du trajet — aucune vitesse instantanée mesurée sur ce trajet',
    };
  });

  /** L'excès de vitesse en cours à l'instant lu, s'il y en a un. */
  protected readonly excesEnCours = computed<SpeedingSegmentDto | null>(() => {
    const a = this.analysis();
    const b = this.bornes();
    if (!a || !b) return null;
    const t = b.t0 + this.fraction() * b.etendue;
    for (const e of a.detail?.speeding ?? []) {
      const debut = Date.parse(e.startAt);
      if (!Number.isFinite(debut)) continue;
      const brut = Date.parse(e.endAt);
      const fin = Number.isFinite(brut) && brut > debut ? brut : debut + 1000;
      // Une seconde de marge de part et d'autre : l'instant lu est un continu, les
      // bornes du segment sont des relevés discrets.
      if (t >= debut - 1000 && t <= fin + 1000) return e;
    }
    return null;
  });

  /** L2 — faits secondaires, MÊME formulation que la cellule « Analyse » du tableau. */
  protected readonly faits = computed<string[]>(() => {
    const a = this.analysis();
    if (!a) return [];
    const out: string[] = [];
    if (a.stopCount > 0) out.push(a.stopCount + ' arrêt' + (a.stopCount > 1 ? 's' : ''));
    const acoups = a.harshAccel + a.harshBrake;
    if (acoups > 0) out.push(acoups + ' à-coup' + (acoups > 1 ? 's' : ''));
    if (a.idleSec >= 60) out.push('ralenti ' + Math.round(a.idleSec / 60) + ' min');
    for (const fs of (a.detail?.fuelStops ?? []).slice(0, 2)) {
      const prix = fs.unitPriceEur != null ? ' ' + fs.unitPriceEur.toFixed(3) + ' €' : '';
      out.push(('station ' + (fs.brand || '') + prix).replace(/\s+/g, ' ').trim());
    }
    return out;
  });

  /** L3 — estimations (toujours « ≈ ») et fiabilité, comme dans le tableau. */
  protected readonly estimations = computed<string[]>(() => {
    const a = this.analysis();
    if (!a) return [];
    const out: string[] = [];
    if (a.fuelLiters != null) out.push('≈ ' + a.fuelLiters.toFixed(1).replace('.', ',') + ' L');
    if (a.co2Kg != null) out.push('≈ ' + Math.round(a.co2Kg) + ' kg CO₂');
    if (a.trustScore != null) out.push('fiabilité GPS ' + a.trustScore);
    return out;
  });

  /**
   * L'écart entre le TRAJET (ce que montre le tableau) et son ANALYSE (ce que raconte
   * le récit), quand il existe.
   *
   * Les deux ne comptent pas les mêmes positions : l'analyse écarte les trames trop
   * rapides et travaille sur les positions conservées. Tant que l'écart est petit,
   * personne n'a besoin d'en entendre parler ; au-delà, le taire revient à laisser
   * croire que l'un des deux écrans se trompe.
   */
  protected readonly ecartAnalyse = computed<string | null>(() => {
    const a = this.analysis();
    const t = this.trip();
    if (!a || !t) return null;
    // Analyse vide (aucune position exploitable) : le sujet n'est pas l'écart, et la
    // cellule du tableau le dit déjà à sa façon.
    if (a.gpsPoints === 0 && a.distanceKm === 0) return null;

    const kmTrajet = max0(t.distanceMeters) / 1000;
    const kmAnalyse = max0(a.distanceKm);
    const vTrajet = clampSpeed(t.maxSpeed);
    const vAnalyse = clampSpeed(a.maxSpeedKmh);

    const ecartKm = kmTrajet > 0.5 && Math.abs(kmAnalyse - kmTrajet) / kmTrajet > 0.05;
    const ecartV = Math.abs(vAnalyse - vTrajet) > 5;
    if (!ecartKm && !ecartV) return null;

    const morceaux: string[] = [];
    if (ecartKm) morceaux.push(kmAnalyse.toFixed(1).replace('.', ',') + ' km');
    if (ecartV) morceaux.push(Math.round(vAnalyse) + ' km/h de pointe');
    return 'Les chiffres ci-dessus sont ceux du trajet. L\'analyse, calculée sur les positions GPS'
      + ' retenues, mesure ' + morceaux.join(' et ') + ' — c\'est elle que décrivent le récit et les événements.';
  });

  /**
   * Le récit tel qu'il est relayé ici. `null` quand l'analyse n'en porte pas :
   * on ne fabrique ni texte, ni promesse de texte — le replay ne sait pas si
   * l'option IA de la société est active.
   */
  protected readonly recit = computed<RecitTrajet | null>(() => {
    const a = this.analysis();
    if (!a) return null;
    const texte = (a.narrative ?? '').trim();
    const conseils = (a.advice ?? '')
      .split(/\s*(?:^|\n)\s*[•\-–]\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!texte && conseils.length === 0) return null;

    const fiabilite = a.trustScore != null
      ? 'Fiabilité GPS ' + a.trustScore + '/100 · ' + a.gpsPoints + ' positions'
      : (a.gpsPoints > 0 ? Math.round(a.gpsValidRatio * 100) + ' % de mesures valides · ' + a.gpsPoints + ' positions' : '');

    // Une minute de battement : l'analyse et le récit s'écrivent à quelques secondes
    // d'écart lors d'un passage normal de l'agent, et cet écart-là n'est pas une
    // péremption. Même règle que la modale d'analyse.
    const perime = !!texte && !!a.narratedAt
      && Date.parse(a.computedAt) - Date.parse(a.narratedAt) > 60_000;

    return { texte, conseils, fiabilite, perime };
  });

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
    const b = this.bornes();
    if (!a || !b) return [];
    const situe = (ms: number): number => Math.min(1, Math.max(0, (ms - b.t0) / b.etendue));

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
    /**
     * Pointes que l'analyse REFUSE d'affirmer. Elles ne comptent ni dans le nombre d'excès ni
     * dans le score, mais elles restent visibles ici : un doute effacé est un doute que
     * personne ne pourra lever, et le conducteur mérite de savoir ce qui a été écarté.
     */
    for (const e of a.detail?.aVerifier ?? []) {
      const ms = Date.parse(e.startAt);
      if (!Number.isFinite(ms)) continue;
      const pourquoi = e.motif === 'limite-invraisemblable'
        ? `Limite ${Math.round(e.limitKmh)} relevée à cet endroit — invraisemblable à cette vitesse, la carte a probablement retenu une voie voisine (pont, contre-allée)`
        : 'Dépassement vu sur un seul point : trop court pour être affirmé';
      out.push({
        type: 'pointe', at: ms, fraction: situe(ms), heure: this.heure(ms),
        titre: `Pointe à vérifier · ${Math.round(e.maxSpeedKmh)} km/h`,
        detail: pourquoi, lat: e.lat, lng: e.lng,
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

  /**
   * Saute à l'événement : le curseur, le marqueur ET la caméra vont au même endroit.
   *
   * Le marqueur prend les coordonnées EXACTES de l'événement, pas la projection du
   * curseur : c'est le point que la caméra centre, et voir le véhicule à cent mètres
   * du point rouge suffisait à faire douter de tout l'écran.
   */
  protected allerA(ev: EvenementRejeu): void {
    const f = Math.min(1, Math.max(0, ev.fraction));
    this.floatFraction = f;
    this.curseur.set(Math.round(f * this.pas));

    if (isValidLatLng(ev.lat, ev.lng)) {
      if (this.marker) {
        this.marker.setLngLat([ev.lng, ev.lat]);
        this.majIcone(0);
      }
      try { this.map?.easeTo({ center: [ev.lng, ev.lat], duration: 400 }); } catch { /* carte pas prête */ }
    } else {
      this.appliquer(f);
    }
  }

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;
  private markerEl: HTMLElement | null = null;
  private points: Array<[number, number]> = []; // [lng, lat]
  /** Distance cumulée en mètres pour chaque point de `points`. */
  private cumuls: number[] = [];
  private distanceTotale = 0;
  private resizeObserver: ResizeObserver | null = null;
  private animId: number | null = null;
  private lastFrameTime = 0;
  private floatFraction = 0;
  /**
   * Toutes les minuteries armées par cet écran.
   *
   * Fermer puis rouvrir le replay laissait tirer les `setTimeout` de l'ouverture
   * précédente sur une carte déjà détruite. Elles sont désormais annulées à la
   * fermeture ET avant d'en armer de nouvelles.
   */
  private minuteries: number[] = [];

  private initEffect = effect(() => {
    const t = this.trip();
    const isOpen = this.open();
    if (isOpen && t) {
      this.annulerMinuteries();
      this.minuteries.push(window.setTimeout(() => this.initReplay(t), 100));
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
      return;
    }
    // En fin de trajet, relire depuis le départ plutôt que de ne rien faire.
    if (this.fraction() >= 1) {
      this.floatFraction = 0;
      this.curseur.set(0);
      this.appliquer(0);
    }
    this.playing.set(true);
    this.lastFrameTime = performance.now();
    this.floatFraction = this.fraction();
    this.animate();
  }

  protected seekTo(event: Event): void {
    const brut = parseInt((event.target as HTMLInputElement).value, 10);
    const f = Math.min(1, Math.max(0, (Number.isFinite(brut) ? brut : 0) / this.pas));
    this.floatFraction = f;
    this.curseur.set(Math.round(f * this.pas));
    this.appliquer(f);
  }

  /** Note lettrée A→E — celle du classement et des badges du tableau. */
  protected note(score: number): string { return gradeOf(score); }

  /** Le palier de couleur suit la NOTE : une échelle de plus donnait deux verdicts. */
  protected ecoTier(score: number): 'good' | 'mid' | 'bad' {
    const g = gradeOf(score);
    if (g === 'A' || g === 'B') return 'good';
    return g === 'C' ? 'mid' : 'bad';
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
    // La distance cumulée est le pont entre le TEMPS (qui pilote la lecture) et la
    // POLYLIGNE (qui n'est pas régulière) : on avance de tant de mètres, pas de tant
    // de points.
    this.cumuls = [0];
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1]!;
      const b = this.points[i]!;
      this.cumuls.push((this.cumuls[i - 1] ?? 0) + haversineMeters(a[1], a[0], b[1], b[0]));
    }
    this.distanceTotale = this.cumuls[this.cumuls.length - 1] ?? 0;
    this.floatFraction = 0;
    this.curseur.set(0);

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

      /**
       * ⚠️ LE GESTE DE L'UTILISATEUR COUPE LE SUIVI, et c'est `originalEvent` qui fait la
       * différence : MapLibre émet `dragstart` / `zoomstart` AUSSI pour ses propres
       * animations — dont le `easeTo` du suivi lui-même. Sans ce test, la caméra se serait
       * désarmée toute seule au premier recentrage, et le suivi n'aurait jamais duré plus
       * d'une image.
       */
      for (const evenement of ['dragstart', 'zoomstart', 'rotatestart'] as const) {
        this.map!.on(evenement, (e: { originalEvent?: unknown }) => {
          if (e?.originalEvent) this.suiviActif.set(false);
        });
      }

      // Marker initial : la vitesse du DÉPART, mesurée quand elle existe. Il portait
      // la moyenne du trajet, donc restait ambre à l'arrêt comme en excès.
      const data: VehicleMarkerData = {
        trackerId: '',
        vehicleId: '',
        type: this.vehicleType(),
        plate: '',
        speedKmh: this.vitesse().kmh,
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
    this.minuteries.push(window.setTimeout(() => this.map?.resize(), 50));
    this.minuteries.push(window.setTimeout(() => this.map?.resize(), 250));
    this.minuteries.push(window.setTimeout(() => this.map?.resize(), 600));
  }

  /** Ajoute les couches d'analyse (arrêts, pointes, excès) — une fois la carte chargée. */
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

    /**
     * ── LES POINTES ÉCARTÉES, SUR LA CARTE AUSSI ──────────────────────────────────────
     *
     * ⚠️ POSÉES AVANT LES EXCÈS CONFIRMÉS, exprès : MapLibre empile dans l'ordre d'ajout, et
     * c'est l'excès affirmé qui doit rester au-dessus quand les deux se superposent.
     *
     * Elles n'étaient pas dessinées du tout, alors que la frise portait déjà leurs repères :
     * cliquer un repère y menait la caméra, et le lecteur cherchait sur la carte une pastille
     * qui n'existait pas. Un repère qui ne mène nulle part se lit comme un défaut d'affichage.
     *
     * Le rayon est FIXE, contrairement aux excès dont il croît avec le dépassement : sur une
     * pointe vue en un seul point, ce dépassement est justement la valeur dont on doute — la
     * mettre en taille ferait affirmer par le dessin ce que le texte refuse d'affirmer.
     */
    const pointes = (a.detail?.aVerifier ?? []).filter((s) => isValidLatLng(s.lat, s.lng));
    if (pointes.length > 0) {
      map.addSource('replay-pointes', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: pointes.map((s) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
            properties: {},
          })),
        },
      });
      map.addLayer({
        id: 'replay-pointes', type: 'circle', source: 'replay-pointes',
        paint: {
          'circle-radius': 5,
          'circle-color': COULEURS_CARTE.pointe,
          'circle-opacity': 0.75,
          'circle-stroke-width': 2,
          'circle-stroke-color': COULEURS_CARTE.contour,
        },
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

  /**
   * La lecture avance dans le TEMPS du trajet, pas dans les points de la polyligne :
   * un arrêt de vingt minutes dure vingt minutes de trajet, donc sa part de la lecture.
   */
  private animate(): void {
    if (!this.playing()) return;

    const now = performance.now();
    const delta = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    let f = this.floatFraction + (delta * this.speed()) / TripReplayComponent.LECTURE_1X_SEC;
    if (f >= 1) { f = 1; this.playing.set(false); }

    this.floatFraction = f;
    this.curseur.set(Math.round(f * this.pas));
    this.appliquer(f);

    if (this.playing()) {
      this.animId = requestAnimationFrame(() => this.animate());
    }
  }

  /** Place le marqueur à l'instant `f` du trajet et met son icône à jour. */
  private appliquer(f: number): void {
    const pos = this.projeter(this.partDistanceA(f));
    if (!pos || !this.marker) return;
    this.marker.setLngLat([pos.lng, pos.lat]);
    this.majIcone(pos.heading);
    this.suivreSiBesoin(pos.lng, pos.lat);
  }

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * LA CAMÉRA SUIT LE VÉHICULE — SANS JAMAIS SE BATTRE AVEC LE DOIGT
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * Mesuré sur la production : la caméra ne bougeait JAMAIS pendant la lecture. Elle se
   * posait une fois sur l'ensemble du trajet, et c'est tout. Conséquence, vérifiée au
   * navigateur : trois crans de zoom pour voir la rue, et le véhicule sortait du cadre dès
   * la première seconde — pour n'y jamais revenir. Le replay ne servait donc qu'à un seul
   * niveau de zoom, celui de l'ouverture, où l'on ne distingue rien.
   *
   * ── POURQUOI PAS UN RECENTRAGE À CHAQUE IMAGE ─────────────────────────────────────────
   *
   * Parce que la carte deviendrait inutilisable : à 8×, une caméra collée au véhicule
   * défile en continu, on ne peut plus rien lire autour, et le moindre geste est balayé à
   * l'image suivante. On ne recentre donc QUE lorsque le véhicule approche du bord — tant
   * qu'il est dans les 60 % centraux, la carte ne bouge pas d'un pixel.
   *
   * ⚠️ ET LE DOIGT GAGNE TOUJOURS. Dès que l'utilisateur déplace ou zoome la carte
   * lui-même, le suivi s'arrête et un bouton « Suivre le véhicule » apparaît. Une caméra
   * qui ramène de force là où elle veut, pendant qu'on essaie de regarder ailleurs, est
   * pire que pas de caméra du tout.
   */
  private suivreSiBesoin(lng: number, lat: number): void {
    if (!this.suiviActif() || !this.map) return;
    if (this.modeCamera() === 'conduite') {
      // Collé à la voiture, sans animation : les positions sont déjà interpolées image par
      // image, et un `easeTo` de 300 ms empilerait une seconde animation par-dessus — la
      // caméra courrait alors derrière la voiture au lieu de la porter.
      try { this.map.jumpTo({ center: [lng, lat] }); } catch { /* carte pas prête */ }
      return;
    }
    try {
      const canvas = this.map.getCanvas();
      const p = this.map.project([lng, lat]);
      const margeX = canvas.clientWidth * 0.2;
      const margeY = canvas.clientHeight * 0.2;
      const dansLaZoneSure =
        p.x > margeX && p.x < canvas.clientWidth - margeX &&
        p.y > margeY && p.y < canvas.clientHeight - margeY;
      if (dansLaZoneSure) return;
      // `easeTo` ne touche QUE le centre : le zoom choisi par l'utilisateur est conservé.
      this.map.easeTo({ center: [lng, lat], duration: 300 });
    } catch { /* carte pas prête : la position suivante réessaiera */ }
  }

  /** Ramène la caméra sur le véhicule et réarme le suivi, à l'échelle du mode courant. */
  protected reprendreLeSuivi(): void {
    this.suiviActif.set(true);
    const pos = this.projeter(this.partDistanceA(this.floatFraction));
    if (pos && this.map) {
      // ⚠️ En vue conduite, réarmer SANS revenir au zoom de conduite ramènerait sur la
      // voiture à l'échelle du trajet entier — c'est-à-dire nulle part où l'on voit
      // quoi que ce soit, sous un bouton qui promet de suivre le véhicule.
      const zoom = this.modeCamera() === 'conduite'
        ? Math.max(this.map.getZoom(), TripReplayComponent.ZOOM_CONDUITE)
        : undefined;
      try { this.map.easeTo({ center: [pos.lng, pos.lat], zoom, duration: 400 }); } catch { /* carte pas prête */ }
    }
  }

  /**
   * Passe d'une échelle à l'autre. Le libellé du bouton dit ce que le clic VA FAIRE, jamais
   * l'état courant : « Zoom sur la voiture » puis « Tout le trajet ».
   */
  protected basculerCamera(): void {
    const map = this.map;
    if (!map) return;
    if (this.modeCamera() === 'conduite') {
      this.modeCamera.set('trajet');
      // Le suivi est coupé : à cette échelle il n'a rien à suivre, et le laisser armé
      // ferait recentrer la carte au moindre passage près du bord.
      this.suiviActif.set(false);
      const points = this.points.map(([lng, lat]) => ({ lat, lng }));
      try { this.mapSvc.fitBounds(map, points, { padding: 50, animate: true }); } catch { /* carte pas prête */ }
      return;
    }
    this.modeCamera.set('conduite');
    this.suiviActif.set(true);
    const pos = this.projeter(this.partDistanceA(this.floatFraction));
    if (!pos) return;
    try {
      map.easeTo({
        center: [pos.lng, pos.lat],
        zoom: Math.max(map.getZoom(), TripReplayComponent.ZOOM_CONDUITE),
        duration: 600,
      });
    } catch { /* carte pas prête */ }
  }

  /** Rafraîchit la pastille du véhicule (couleur = vitesse affichée, cap = direction). */
  private majIcone(heading: number): void {
    if (!this.markerEl) return;
    updateVehicleMarkerEl(this.markerEl, {
      trackerId: '',
      vehicleId: '',
      type: this.vehicleType(),
      plate: '',
      speedKmh: this.vitesse().kmh,
      heading,
      ignition: true,
    });
  }

  /**
   * Quelle part du chemin était parcourue à l'instant `f` ?
   *
   * Avec le tracé horodaté de l'analyse, la réponse tient compte des arrêts. Sans lui,
   * on retombe sur un mouvement uniforme (part de chemin = part de temps) — approximatif,
   * mais c'est déjà ce que fait le replay de période, et cela ne prétend rien de plus.
   */
  private partDistanceA(f: number): number {
    const releves = this.profil();
    if (releves.length < 2) return f;
    const premier = releves[0]!;
    const dernier = releves[releves.length - 1]!;
    // Un tracé qui ne couvre pas le trajet (analyse partielle : positions purgées ou
    // plafonnées) ferait finir la polyligne bien avant la fin de la lecture, puis
    // figerait le véhicule. Dans ce cas on ne s'en sert pas pour la position.
    if (dernier.fraction - premier.fraction < 0.8) return f;
    if (f <= premier.fraction) return premier.partDistance;
    if (f >= dernier.fraction) return dernier.partDistance;
    for (let i = 1; i < releves.length; i++) {
      const a = releves[i - 1]!;
      const b = releves[i]!;
      if (f <= b.fraction) {
        const ecart = b.fraction - a.fraction;
        const k = ecart > 0 ? (f - a.fraction) / ecart : 0;
        return a.partDistance + (b.partDistance - a.partDistance) * k;
      }
    }
    return dernier.partDistance;
  }

  /** Projette une part de distance (0→1) sur la polyligne dessinée. */
  private projeter(part: number): { lng: number; lat: number; heading: number } | null {
    const pts = this.points;
    if (pts.length === 0) return null;
    const p0 = pts[0]!;
    if (pts.length === 1 || this.distanceTotale <= 0) return { lng: p0[0], lat: p0[1], heading: 0 };

    const cible = Math.min(1, Math.max(0, part)) * this.distanceTotale;
    let lo = 0;
    let hi = this.cumuls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cumuls[mid] ?? 0) < cible) lo = mid + 1; else hi = mid;
    }
    const idx = Math.max(1, lo);
    const a = pts[idx - 1]!;
    const b = pts[idx]!;
    const da = this.cumuls[idx - 1] ?? 0;
    const db = this.cumuls[idx] ?? da;
    const k = db === da ? 0 : (cible - da) / (db - da);
    return {
      lng: a[0] + (b[0] - a[0]) * k,
      lat: a[1] + (b[1] - a[1]) * k,
      heading: bearingFrom(a[1], a[0], b[1], b[0]),
    };
  }

  /** Annule TOUTES les minuteries en attente (fermeture, ou nouvelle ouverture). */
  private annulerMinuteries(): void {
    for (const id of this.minuteries) window.clearTimeout(id);
    this.minuteries = [];
  }

  private cleanup(): void {
    this.playing.set(false);
    this.annulerMinuteries();
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
    this.cumuls = [];
    this.distanceTotale = 0;
    this.floatFraction = 0;
    this.curseur.set(0);
    this.recitOuvert.set(false);
    /**
     * ── L'ÉTAT DE CAMÉRA NE SURVIT PAS À UN TRAJET ────────────────────────────────────
     *
     * `cleanup()` est appelé au début de CHAQUE `initReplay` : c'est ici que se remet à zéro
     * ce qui appartient au trajet qu'on vient de quitter.
     *
     * ⚠️ Ces deux-là manquaient, et le défaut se voyait à l'œil. Relevé en production le
     * 2026-09-06 : après un replay passé en vue conduite, ouvrir un AUTRE trajet donnait un
     * bouton « Tout le trajet » — donc une modale qui se déclare en vue conduite — alors que
     * la caméra venait de faire son `fitBounds` d'ouverture. Le bouton proposait de revenir
     * là où on était déjà : un clic pour rien, puis un libellé inversé.
     *
     * Même chose pour le suivi : un geste dans le trajet précédent le laissait désarmé, et
     * le trajet suivant s'ouvrait avec « Suivre le véhicule » affiché sans que personne n'ait
     * touché à cette carte-là.
     */
    this.modeCamera.set('trajet');
    this.suiviActif.set(true);
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

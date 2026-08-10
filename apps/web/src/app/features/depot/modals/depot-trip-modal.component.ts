import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import type { DepotTripDto } from '@vizyo/tracky-shared';
import { AlertTriangle, Download, LucideAngularModule, Share2 } from 'lucide-angular';
import { swallow } from '../../../core/error/swallow';
import { MiniMapComponent } from '../../../shared/ui/mini-map/mini-map.component';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { DepotApiService } from '../depot-api.service';
import { DepotModalComponent } from './depot-modal.component';

/**
 * Espace dépôt (2026-08) — le détail d'un trajet (A3 § 5).
 *
 * ┌─ CE QUI JUSTIFIE CETTE MODALE ────────────────────────────────────────────┐
 * │ Le TEMPS PASSÉ SUR PLACE. Il distingue « le camion est parti à 8h15 » de    │
 * │ « le camion a attendu 14 minutes au premier point » — et c'est ce qui       │
 * │ permet au dépôt de comprendre un retard SANS APPELER personne.              │
 * │                                                                            │
 * │ Sans les durées d'arrêt, le déroulé n'est qu'une liste d'heures : il dit    │
 * │ QUAND, jamais POURQUOI. C'est le POURQUOI qui évite l'appel.                │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * L'étape à venir est rendue EN TIRETÉ avec son heure prévue. Une arrivée estimée
 * présentée comme constatée est un mensonge qui ne se voit pas — même règle que
 * pour les positions périmées.
 */
@Component({
  selector: 'app-depot-trip-modal',
  standalone: true,
  imports: [LucideAngularModule, DepotModalComponent, MiniMapComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      [titre]="trip() ? 'Trajet ' + trip()!.missionRef : 'Trajet'"
      [sousTitre]="trip() ? trip()!.origin + ' → ' + trip()!.destination : null"
      (fermer)="fermer.emit()"
    >
      @if (chargement()) {
        <div class="dtm-sk">
          <div class="sk" style="height:74px;border-radius:14px"></div>
          <div class="sk" style="height:190px;border-radius:14px"></div>
          <div class="sk" style="height:120px;border-radius:14px"></div>
        </div>
      } @else if (!trip()) {
        <p class="dtm-erreur">Ce trajet ne fait pas partie de vos missions.</p>
      } @else {
        <!-- ═══ 4 tuiles ═══════════════════════════════════════════════════ -->
        <div class="dtm-tuiles">
          <!-- Un tiret quand la mesure n'existe pas encore : « 0 km » sur une mission
               en cours se lirait comme « le camion n'a pas bougé ». -->
          <div class="dtm-tuile">
            @if (trip()!.distanceKm !== null) {
              <span class="dtm-tuile-v">{{ trip()!.distanceKm }}</span><span class="dtm-tuile-u">km</span>
            } @else {
              <span class="dtm-tuile-v">—</span>
            }
            <span class="dtm-tuile-l">Distance</span>
          </div>
          <div class="dtm-tuile">
            <span class="dtm-tuile-v">{{ dureeLisible() }}</span>
            <span class="dtm-tuile-l">Durée</span>
          </div>
          <div class="dtm-tuile">
            <span class="dtm-tuile-v">{{ trip()!.stops === null ? '—' : trip()!.stops }}</span>
            <span class="dtm-tuile-l">{{ (trip()!.stops ?? 0) > 1 ? 'Arrêts' : 'Arrêt' }}</span>
          </div>
          <!-- L'arrivée en ACCENT : c'est le chiffre que le dépôt cherche en premier. -->
          <div class="dtm-tuile dtm-tuile--accent">
            <span class="dtm-tuile-v">{{ heure(trip()!.etaAt) }}</span>
            <span class="dtm-tuile-l">Arrivée</span>
          </div>
        </div>

        <app-mini-map
          class="dtm-carte"
          [center]="centre()"
          [trail]="trace()"
          [plate]="trip()!.plate"
          [interactive]="false"
          height="190px"
        />

        <!-- ═══ Déroulé horodaté ═══════════════════════════════════════════ -->
        <ol class="dtm-deroule">
          @for (e of trip()!.steps; track $index) {
            <li class="dtm-etape" [class.dtm-etape--avenir]="!e.done">
              <span class="dtm-puce" aria-hidden="true"></span>
              <div class="dtm-etape-txt">
                <span class="dtm-etape-l">{{ e.label }}</span>
                @if (e.dwellMinutes !== null) {
                  <!-- L'information qui évite l'appel. -->
                  <span class="dtm-dwell">{{ e.dwellMinutes }} min sur place</span>
                }
              </div>
              <span class="dtm-etape-h">
                @if (e.done) {
                  {{ heure(e.actualAt) }}
                } @else {
                  <span class="dtm-prevu">prévu {{ heure(e.plannedAt) }}</span>
                }
              </span>
            </li>
          }
        </ol>
      }

      <footer pied class="dtm-pied">
        <button type="button" class="dtm-btn" (click)="exporter()" [disabled]="!trip() || exportEnCours()">
          <lucide-icon [img]="Download" [size]="15" aria-hidden="true" />
          {{ exportEnCours() ? 'Génération…' : 'Exporter ce trajet' }}
        </button>
        <button type="button" class="dtm-btn" (click)="signalerIncident()" [disabled]="!trip()">
          <lucide-icon [img]="AlertTriangle" [size]="15" aria-hidden="true" />Signaler un incident
        </button>
        <button type="button" class="dtm-btn dtm-btn--accent" (click)="demanderPartage()">
          <lucide-icon [img]="Share2" [size]="15" aria-hidden="true" />Partager le suivi
        </button>
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    .dtm-sk { display: flex; flex-direction: column; gap: 12px }
    .dtm-erreur { margin: 20px 0; text-align: center; font-size: 13.5px; color: var(--depot-attenue) }

    .dtm-tuiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; margin-bottom: 14px }
    .dtm-tuile {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      padding: 11px 12px; border-radius: 13px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
    }
    .dtm-tuile--accent {
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 30%, transparent);
    }
    .dtm-tuile--accent .dtm-tuile-v { color: var(--depot-succes) }
    .dtm-tuile-v {
      font-family: var(--font-display); font-size: 19px; font-weight: 800; line-height: 1;
      color: var(--text-primary);
    }
    .dtm-tuile-u { font-size: 11px; color: var(--depot-attenue); margin-left: 2px }
    .dtm-tuile-l { font-size: 11px; color: var(--depot-attenue); margin-top: 4px }

    .dtm-carte { display: block; margin-bottom: 14px }

    .dtm-deroule { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column }
    .dtm-etape {
      position: relative; display: flex; align-items: flex-start; gap: 12px;
      padding: 9px 0 9px 4px;
    }
    /* Le fil vertical qui relie les étapes : c'est lui qui fait lire une SUITE
       plutôt qu'une liste. Tireté sur les étapes à venir. */
    .dtm-etape::before {
      content: ''; position: absolute; left: 9px; top: 22px; bottom: -4px; width: 2px;
      background: var(--border-color);
    }
    .dtm-etape:last-child::before { display: none }
    .dtm-etape--avenir::before { background: repeating-linear-gradient(to bottom, var(--border-strong-color) 0 4px, transparent 4px 8px) }
    .dtm-puce {
      flex: 0 0 auto; width: 11px; height: 11px; margin-top: 5px; border-radius: 50%;
      background: var(--color-tracky-light); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-tracky-light) 18%, transparent);
    }
    .dtm-etape--avenir .dtm-puce {
      background: transparent; border: 2px dashed var(--border-strong-color); box-shadow: none;
    }
    .dtm-etape-txt { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0 }
    .dtm-etape-l { font-size: 13.5px; font-weight: 600; color: var(--text-primary) }
    .dtm-etape--avenir .dtm-etape-l { color: var(--depot-attenue) }
    .dtm-dwell { font-size: 12px; font-weight: 700; color: var(--depot-attente) }
    .dtm-etape-h { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-secondary); white-space: nowrap }
    .dtm-prevu { color: var(--depot-attenue); font-style: italic }

    .dtm-pied {
      flex: 0 0 auto; display: flex; gap: 8px; flex-wrap: wrap;
      padding: 12px 20px 16px; border-top: 1px solid var(--border-color);
    }
    .dtm-btn {
      display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 8px 14px;
      border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--text-secondary); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .dtm-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--border-strong-color) }
    .dtm-btn:disabled { opacity: .5; cursor: not-allowed }
    .dtm-btn--accent { margin-left: auto; background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink) }

    @media (max-width: 767px) {
      .dtm-tuiles { grid-template-columns: repeat(2, 1fr) }
      .dtm-btn { min-height: 44px; flex: 1 1 auto; justify-content: center }
      .dtm-btn--accent { margin-left: 0 }
    }
  `],
})
export class DepotTripModalComponent implements OnInit {
  /**
   * Deux entrées, une seule modale.
   *
   * Depuis l'HISTORIQUE on connaît le trajet : `tripId`. Depuis la CARTE LIVE on ne
   * connaît que la mission — `Trip.missionId` n'est rattaché qu'à la clôture — d'où
   * `missionId`. Exiger un `tripId` partout aurait rendu la modale inaccessible
   * pendant la mission, c'est-à-dire au moment où elle sert le plus.
   */
  readonly tripId = input<string | null>(null);
  readonly missionId = input<string | null>(null);
  readonly fermer = output<void>();
  /** Émet l'identifiant de mission : le parent enchaîne sur la modale d'incident. */
  readonly signaler = output<string>();
  /** Idem pour le partage : la modale de trajet ne connaît pas la mission complète,
   *  c'est l'écran qui la porte — il ouvre donc la modale de partage lui-même. */
  readonly partager = output<string>();

  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Download = Download;
  protected readonly Share2 = Share2;

  protected readonly trip = signal<DepotTripDto | null>(null);
  protected readonly chargement = signal(true);
  protected readonly exportEnCours = signal(false);

  /** La mini-carte se centre sur la position actuelle si le suivi est actif, sinon
   *  sur la fin du tracé : jamais sur un point par défaut qui n'a rien à voir. */
  protected readonly centre = computed(() => {
    const t = this.trip();
    if (t?.currentPosition) return { lat: t.currentPosition.lat, lng: t.currentPosition.lng };
    const trace = this.trace();
    return trace.length > 0 ? trace[trace.length - 1]! : null;
  });

  protected readonly trace = computed(() => this.decoder(this.trip()?.polyline ?? null));

  protected readonly dureeLisible = computed(() => {
    const minutes = this.trip()?.durationMinutes ?? 0;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
  });

  async ngOnInit(): Promise<void> {
    const trajet = this.tripId();
    const mission = this.missionId();
    try {
      if (trajet) this.trip.set(await this.api.trip(trajet));
      else if (mission) this.trip.set(await this.api.tripDeMission(mission));
    } catch (err) {
      swallow('depot-trip-modal:charger', err);
    } finally {
      this.chargement.set(false);
    }
  }

  protected heure(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  protected async exporter(): Promise<void> {
    const t = this.trip();
    if (!t) return;
    this.exportEnCours.set(true);
    try {
      // Une journée entière autour de la mission : l'export est borné aux missions du
      // dépôt côté serveur, la fenêtre ne fait que restreindre.
      const jour = t.etaAt ? new Date(t.etaAt) : new Date();
      const debut = new Date(jour);
      debut.setHours(0, 0, 0, 0);
      const fin = new Date(jour);
      fin.setHours(23, 59, 59, 999);
      const blob = await this.api.export(debut.toISOString(), fin.toISOString(), 'PDF');
      this.telecharger(blob, `trajet-${t.missionRef}.pdf`);
    } catch (err) {
      swallow('depot-trip-modal:exporter', err);
      this.toast.show({ kind: 'error', title: 'Export impossible', message: 'Réessayez dans un instant.' });
    } finally {
      this.exportEnCours.set(false);
    }
  }

  protected signalerIncident(): void {
    const t = this.trip();
    if (t) this.signaler.emit(t.missionId);
  }

  protected demanderPartage(): void {
    const t = this.trip();
    if (t) this.partager.emit(t.missionId);
  }

  private telecharger(blob: Blob, nom: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nom;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Décodeur polyline Google (précision 5), le format que produit le backend.
   *
   * Écrit ici plutôt qu'ajouté en dépendance : une dépendance npm de plus demande un
   * accord préalable (règle 5 du chantier), pour vingt lignes qui ne bougeront jamais.
   */
  private decoder(encode: string | null): Array<{ lat: number; lng: number }> {
    if (!encode) return [];
    const points: Array<{ lat: number; lng: number }> = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    while (index < encode.length) {
      let resultat = 0;
      let decalage = 0;
      let octet: number;
      do {
        octet = encode.charCodeAt(index++) - 63;
        resultat |= (octet & 0x1f) << decalage;
        decalage += 5;
      } while (octet >= 0x20);
      lat += resultat & 1 ? ~(resultat >> 1) : resultat >> 1;

      resultat = 0;
      decalage = 0;
      do {
        octet = encode.charCodeAt(index++) - 63;
        resultat |= (octet & 0x1f) << decalage;
        decalage += 5;
      } while (octet >= 0x20);
      lng += resultat & 1 ? ~(resultat >> 1) : resultat >> 1;

      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
  }
}

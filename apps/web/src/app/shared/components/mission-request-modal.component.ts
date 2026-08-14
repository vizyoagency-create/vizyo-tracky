import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Truck } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import {
  libelleStatut,
  MissionRequestsApi,
  type Camp,
  type Demande,
} from '../../core/services/mission-requests.api';
import { DepotModalComponent } from '../../features/depot/modals/depot-modal.component';
import { ToastService } from '../ui/toast/toast.service';
import { MissionRequestThreadComponent } from './mission-request-thread.component';

/**
 * Espace dépôt, lot A6 — la modale de négociation, OUVERTE AUX DEUX CAMPS.
 *
 * ┌─ LA COQUE EST CELLE DU DÉPÔT, ET C'EST VOLONTAIRE ────────────────────────┐
 * │ `depot-modal` porte la géométrie déjà conforme : feuille basse sous 768 px,│
 * │ 88dvh, `env(safe-area-inset-bottom)`, fermeture 44×44, échappement clavier.│
 * │ Son nom dit son origine, pas son périmètre.                                │
 * │                                                                            │
 * │ En écrire une seconde pour le transporteur, c'est exactement ce qui avait   │
 * │ cassé `mission-dialog` (§ 10) : deux coques divergent, l'une reçoit les     │
 * │ correctifs mobiles et l'autre non, et on redécouvre six mois plus tard      │
 * │ qu'une modale ne se ferme plus au pouce sur téléphone.                      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * L'AFFECTATION vit ici et non dans le fil : elle n'est pas un tour de négociation,
 * c'est le geste qui fait naître la mission. Elle n'apparaît qu'au transporteur, et
 * seulement une fois l'accord conclu — le serveur le revérifie de toute façon.
 */

interface VehiculeDispo {
  id: string;
  plate: string;
  label: string | null;
  available: boolean;
  reason: string | null;
}

interface Conducteur {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}

@Component({
  selector: 'app-mission-request-modal',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, DepotModalComponent, MissionRequestThreadComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      [titre]="'Demande ' + courante().ref"
      [sousTitre]="sousTitre()"
      (fermer)="fermer.emit()"
    >
      <!-- ═══ AFFECTER : le geste qui fait naître la mission ════════════════ -->
      @if (peutAffecter()) {
        <section class="mrm-affect">
          <h3 class="mrm-titre">
            <lucide-icon [img]="Truck" [size]="15" aria-hidden="true" /> Affecter un véhicule
          </h3>
          <p class="mrm-aide">
            C'est ce geste qui crée la mission : le véhicule devient indisponible sur le
            créneau, et le dépôt verra sa position le jour venu.
          </p>

          @if (chargementParc()) {
            <div class="mrm-sk"><div class="sk mrm-sk-l"></div><div class="sk mrm-sk-l"></div></div>
          } @else {
            <label class="mrm-label" for="mrm-veh">Véhicule</label>
            <select id="mrm-veh" class="mrm-champ" [(ngModel)]="vehiculeId">
              <option value="">Choisir un véhicule…</option>
              @for (v of parc(); track v.id) {
                <!-- Les occupes restent VISIBLES, grises, avec leur motif : un vehicule
                     qui disparait sans explication renvoie au formulaire cinq fois. -->
                <option [value]="v.id" [disabled]="!v.available">
                  {{ v.plate }}{{ v.label ? ' · ' + v.label : '' }}{{ v.available ? '' : ' — ' + (v.reason || 'occupé') }}
                </option>
              }
            </select>
            @if (aucunLibre()) {
              <p class="mrm-alerte">
                Aucun véhicule n'est libre sur ce créneau. Contre-proposez un autre
                horaire plutôt que de promettre un camion que vous n'avez pas.
              </p>
            }

            <label class="mrm-label" for="mrm-cond">Conducteur (facultatif)</label>
            <select id="mrm-cond" class="mrm-champ" [(ngModel)]="conducteurId">
              <option value="">À désigner plus tard</option>
              @for (c of conducteurs(); track c.id) {
                <option [value]="c.id">{{ nomConducteur(c) }}</option>
              }
            </select>

            <label class="mrm-label" for="mrm-notes">Consignes internes (facultatif)</label>
            <textarea id="mrm-notes" class="mrm-champ mrm-texte" rows="2"
                      [(ngModel)]="notes"
                      placeholder="Accès quai, contact sur place…"></textarea>

            <div class="mrm-actions">
              <button type="button" class="mrm-btn mrm-btn--accent"
                      [disabled]="affectation() || !vehiculeId"
                      (click)="affecter()">
                {{ affectation() ? 'Affectation…' : 'Créer la mission' }}
              </button>
            </div>
          }
        </section>
      }

      <app-mission-request-thread
        [demande]="courante()"
        [camp]="camp()"
        (misAJour)="surMiseAJour($event)"
      />

      <footer pied class="mrm-pied">
        <button type="button" class="mrm-btn" (click)="fermer.emit()">Fermer</button>
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    .mrm-affect { padding: 13px 14px; border-radius: 13px; margin-bottom: 14px;
                  background: var(--surface-secondary); border: 1px solid var(--border-color) }
    .mrm-titre { display: flex; align-items: center; gap: 7px; margin: 0 0 8px;
                 font-size: 13px; font-weight: 700; color: var(--text-primary) }
    .mrm-aide { margin: 0 0 12px; font-size: 12px; line-height: 1.6; color: var(--text-secondary) }
    .mrm-label { display: block; margin: 12px 0 6px; font-size: 11.5px; font-weight: 600;
                 color: var(--text-secondary) }
    .mrm-label:first-of-type { margin-top: 0 }
    .mrm-champ { width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px;
                 border-radius: 11px; background: var(--surface-tertiary);
                 border: 1px solid var(--border-color); color: var(--text-primary);
                 font-family: inherit; font-size: 13.5px }
    .mrm-champ:focus { outline: 2px solid var(--violet); outline-offset: 1px }
    .mrm-texte { resize: vertical; line-height: 1.55 }
    .mrm-alerte { margin: 8px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--texte-alerte) }

    .mrm-actions { display: flex; justify-content: flex-end; margin-top: 14px }
    .mrm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
               min-height: 44px; padding: 10px 17px; border-radius: 11px;
               border: 1px solid var(--border-color); background: var(--surface-tertiary);
               color: var(--text-secondary); font-family: inherit; font-size: 13px;
               font-weight: 600; cursor: pointer }
    .mrm-btn--accent { background: var(--color-tracky-light); border-color: transparent;
                       color: var(--accent-ink); font-weight: 700 }
    .mrm-btn:disabled { opacity: .5; cursor: not-allowed }

    .mrm-pied { flex: 0 0 auto; display: flex; justify-content: flex-end;
                padding: 12px 20px 16px; border-top: 1px solid var(--border-color) }
    .mrm-sk { display: flex; flex-direction: column; gap: 9px }
    .mrm-sk-l { height: 44px; border-radius: 11px }

    @media (max-width: 767px) { .mrm-pied .mrm-btn { flex: 1 } }
  `],
})
export class MissionRequestModalComponent {
  readonly demande = input.required<Demande>();
  readonly camp = input.required<Camp>();
  readonly fermer = output<void>();
  /** La demande a changé — la liste appelante se rafraîchit. */
  readonly misAJour = output<Demande>();

  private readonly api = inject(MissionRequestsApi);
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);

  protected readonly Truck = Truck;

  /**
   * La demande TELLE QU'ELLE EST MAINTENANT.
   *
   * ⚠️ Une copie locale, alimentée par les réponses du serveur, et non l'entrée seule :
   * après une acceptation la demande passe de `NEGOTIATING` à `ACCEPTED`, et c'est ce
   * qui fait apparaître l'affectation. Attendre que la liste appelante se recharge
   * aurait laissé la modale afficher un état périmé — celui d'avant le clic.
   */
  private readonly locale = signal<Demande | null>(null);
  protected readonly courante = computed(() => this.locale() ?? this.demande());

  protected readonly chargementParc = signal(false);
  protected readonly parc = signal<VehiculeDispo[]>([]);
  protected readonly conducteurs = signal<Conducteur[]>([]);
  protected readonly affectation = signal(false);

  protected vehiculeId = '';
  protected conducteurId = '';
  protected notes = '';

  protected readonly sousTitre = computed(() => {
    const d = this.courante();
    const depot = this.camp() === 'CARRIER' && d.depot ? ` · ${d.depot.nom}` : '';
    return `${libelleStatut(d.status)}${depot}`;
  });

  /**
   * L'affectation n'est proposée qu'au TRANSPORTEUR, et seulement sur un accord conclu
   * qui n'a pas encore donné de mission. C'est son parc qu'il engage : le serveur
   * refuse un dépôt qui tenterait l'appel, avant toute écriture.
   */
  protected readonly peutAffecter = computed(() => {
    const d = this.courante();
    return this.camp() === 'CARRIER' && d.status === 'ACCEPTED' && !d.missionId;
  });

  protected readonly aucunLibre = computed(
    () => this.parc().length > 0 && this.parc().every((v) => !v.available),
  );

  constructor() {
    // Le parc n'est chargé QUE si l'affectation est possible : interroger la
    // disponibilité pour une demande en négociation ferait une requête pour rien, et
    // un dépôt la recevrait en 403 — un refus légitime qui pollue les journaux par
    // lesquels on prouve l'isolation.
    queueMicrotask(() => {
      if (this.peutAffecter()) void this.chargerParc();
    });
  }

  protected surMiseAJour(d: Demande): void {
    this.locale.set(d);
    this.misAJour.emit(d);
    // L'accord vient d'être conclu : le parc devient utile à l'instant même.
    if (this.peutAffecter() && this.parc().length === 0) void this.chargerParc();
  }

  private async chargerParc(): Promise<void> {
    this.chargementParc.set(true);
    const d = this.courante();
    try {
      const [v, c] = await Promise.all([
        this.dispo(d.wantedStartAt, d.wantedEndAt),
        this.listeConducteurs(),
      ]);
      this.parc.set(v);
      this.conducteurs.set(c);
    } catch (err) {
      swallow('mission-request-modal:parc', err);
    } finally {
      this.chargementParc.set(false);
    }
  }

  private async dispo(debut: string, fin: string): Promise<VehiculeDispo[]> {
    const url =
      `/api/missions/vehicle-availability?startAt=${encodeURIComponent(debut)}` +
      `&endAt=${encodeURIComponent(fin)}`;
    return (await this.lire<VehiculeDispo[]>(url)) ?? [];
  }

  private async listeConducteurs(): Promise<Conducteur[]> {
    // Un parc sans conducteurs déclarés est un cas courant : l'affectation reste
    // possible, le conducteur se désigne plus tard.
    try {
      return (await this.lire<Conducteur[]>('/api/drivers')) ?? [];
    } catch {
      return [];
    }
  }

  private lire<T>(url: string): Promise<T> {
    return new Promise<T>((resoudre, rejeter) => {
      this.http.get<T>(url).subscribe({ next: resoudre, error: rejeter });
    });
  }

  protected nomConducteur(c: Conducteur): string {
    const compose = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
    return c.fullName || compose || 'Conducteur';
  }

  protected async affecter(): Promise<void> {
    if (!this.vehiculeId || this.affectation()) return;
    this.affectation.set(true);
    try {
      const r = await this.api.affecter(this.courante().id, {
        vehicleId: this.vehiculeId,
        driverId: this.conducteurId || null,
        notes: this.notes.trim() || null,
      });
      this.locale.set(r.request);
      this.misAJour.emit(r.request);
      this.toast.show({
        kind: 'success',
        title: `Mission ${r.mission.ref} créée`,
        // Les avertissements du serveur ne sont pas des échecs : « ce véhicule n'a pas
        // de boîtier » se planifie très bien, mais le dépôt ne verra pas sa position.
        message:
          r.avertissements.length > 0
            ? r.avertissements.join(' ')
            : 'Le dépôt en est prévenu par e-mail.',
      });
    } catch (err) {
      swallow('mission-request-modal:affecter', err);
      const brut = (err as { error?: { message?: unknown } })?.error?.message;
      this.toast.show({
        kind: 'error',
        title: 'Affectation impossible',
        message:
          typeof brut === 'string' && brut.trim()
            ? brut
            : 'Le véhicule n\'a pas pu être engagé. Réessayez dans un instant.',
      });
    } finally {
      this.affectation.set(false);
    }
  }
}

import { swallow } from '../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, Fuel, Save, Check, X, ArrowLeftRight, AlertTriangle, Loader,
  Info, Users, ClipboardList, Sparkles,
} from 'lucide-angular';
import type {
  InstallationEnergy,
  VehicleCapacityRowDto,
  VehicleSyncableField,
} from '@vizyo/tracky-shared';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { VehiclesApiService } from '../../core/services/vehicles.service';
import { AiStatusService } from '../../core/services/ai-status.service';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

const ENERGY_LABELS: Record<InstallationEnergy, string> = {
  DIESEL: 'Diesel',
  ESSENCE: 'Essence',
  ELECTRIQUE: 'Électrique',
  HYBRIDE: 'Hybride',
  AUTRE: 'Autre',
};
const ENERGIES: InstallationEnergy[] = ['DIESEL', 'ESSENCE', 'ELECTRIQUE', 'HYBRIDE', 'AUTRE'];
const FIELD_LABELS: Record<VehicleSyncableField, string> = {
  brand: 'Marque',
  model: 'Modèle',
  energy: 'Énergie',
};

interface EditRow extends VehicleCapacityRowDto {
  draftSeats: string;
  draftFeatures: string;
  draftEnergy: InstallationEnergy | '';
  saving: boolean;
  syncing: boolean;
}

/**
 * Sprint 10 — Vue « Parc & capacités ». Voir QUI a QUOI et éditer la capacité (places /
 * équipements / énergie) de chaque véhicule, avec en regard le modèle/énergie issus du planning
 * d'installation + une synchro 1-clic (aperçu des écarts, application au choix). Édition gardée
 * `vehicles_edit` (lecture seule sinon).
 *
 * Les sièges auto à bord ne se règlent pas ici : c'est un STOCK de la société, réglé dans la vue
 * Parc de l'agenda (refonte du 28/09) — pas une capacité du véhicule.
 *
 * Revue du 29/09 : les renvois nommaient des écrans supprimés par la refonte (« Agenda →
 * Optimisation ») ou vidés (« Agenda → Paramètres »), et menaient au Calendrier. Ils pointent
 * désormais sur la vue concernée (lien profond `?vue=`), et seulement pour qui peut l'ouvrir.
 * L'édition RESTE ici : c'est le seul écran de réglage d'un gestionnaire sans `reservations_view`
 * (FLEET_MANAGER par défaut), et le seul qui porte la synchro depuis le planning.
 *
 * Contre-revue du 29/09 : les gardes des renvois sont celles de l'écran d'ARRIVÉE, recopiées de
 * l'agenda (elles ne sont pas partagées : l'agenda les porte dans `vuePermise`) —
 *  - vue Parc : `reservations_view` seul, comme `vuePermise('parc')`. L'ancienne garde
 *    (`agenda_view` + `reservations_view`) datait de la barre de vues sous `agenda_view`, supprimée
 *    par la même revue : un délégué qui pouvait ouvrir la vue ne voyait pas le lien ;
 *  - sièges auto : se RÈGLENT dans la vue Parc pour SUPER_ADMIN et FLEET_ADMIN seulement (rôle, et
 *    non permission — `canSeats` de la vue, `@Roles` du serveur). Aux autres, on ne promet plus
 *    un réglage qu'ils ne trouveraient pas : la vue leur est proposée en consultation ;
 *  - Assistant IA → Vérifier le parc : seulement si l'étape EXISTE et que le compte peut la lancer
 *    — analyse de capacité ouverte pour la société du bandeau (`AiStatusService.can('capacity')`)
 *    et `ai_optimize`. Sans l'option IA (le cas par défaut), le lien menait au Calendrier.
 */
@Component({
  selector: 'app-vehicle-capacity-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="cap">
      <div class="cap-head">
        <div class="cap-intro">
          <p class="cap-lead">Capacité de chaque véhicule, alignée sur les données du planning d'installation.</p>
          @if (canSeeIa()) {
            <p class="cap-hint"><lucide-icon [img]="SparklesIcon" [size]="12"></lucide-icon> Remplissage assisté par IA : <a routerLink="/agenda" [queryParams]="{ vue: 'ia' }" class="cap-link">Agenda → Assistant IA → Vérifier le parc</a>.</p>
          }
          @if (canSeeParc()) {
            <p class="cap-hint"><lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon> {{ renvoiParc() }} : <a routerLink="/agenda" [queryParams]="{ vue: 'parc' }" class="cap-link">Agenda → vue Parc</a>.</p>
          }
        </div>
        @if (!canEdit()) {
          <span class="cap-ro"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Lecture seule — droit « Modifier un véhicule » requis pour éditer.</span>
        }
      </div>

      @if (loading()) {
        <div class="cap-skel"></div><div class="cap-skel"></div><div class="cap-skel"></div>
      } @else if (error()) {
        <div class="cap-alert"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ error() }}</div>
      } @else if (rows().length === 0) {
        <div class="cap-empty"><lucide-icon [img]="ClipboardIcon" [size]="34" class="cap-empty-ic"></lucide-icon><p>Aucun véhicule sur ce périmètre.</p></div>
      } @else {
        <div class="cap-grid">
          @for (r of rows(); track r.vehicleId) {
            <article class="cap-card" [class.cap-card--dirty]="isDirty(r)">
              <!-- Identité -->
              <header class="cap-card-head">
                <div class="cap-id">
                  <span class="cap-plate">{{ r.plate }}</span>
                  <span class="cap-model">{{ r.brand || '—' }} {{ r.model || '' }}</span>
                </div>
                <div class="cap-id-right">
                  @if (r.group) { <span class="cap-group">{{ r.group.name }}</span> }
                  @if (r.energy) { <span class="cap-energy"><lucide-icon [img]="FuelIcon" [size]="11"></lucide-icon> {{ energyLabel(r.energy) }}</span> }
                </div>
              </header>

              <!-- Source planning + synchro -->
              @if (r.installationSource; as src) {
                <div class="cap-src">
                  <span class="cap-src-label"><lucide-icon [img]="ClipboardIcon" [size]="11"></lucide-icon> Planning{{ src.planName ? ' · ' + src.planName : '' }} :</span>
                  <span class="cap-src-val">{{ src.brand || '—' }} {{ src.model || '' }}@if (src.energy) { · {{ energyLabel(src.energy) }} }</span>
                  @if (canEdit() && r.divergentFields.length > 0) {
                    <button type="button" class="cap-sync-btn" (click)="openSync(r)">
                      <lucide-icon [img]="SyncIcon" [size]="12"></lucide-icon> Synchroniser
                    </button>
                  } @else if (r.divergentFields.length === 0) {
                    <span class="cap-sync-ok"><lucide-icon [img]="CheckIcon" [size]="11"></lucide-icon> à jour</span>
                  }
                </div>

                <!-- Aperçu synchro (écarts, application au choix) -->
                @if (syncOpenId() === r.vehicleId) {
                  <div class="cap-sync-panel">
                    <p class="cap-sync-title">Recopier du planning vers le véhicule :</p>
                    @for (f of r.divergentFields; track f) {
                      <label class="cap-sync-row">
                        <input type="checkbox" [checked]="syncSel().has(f)" (change)="toggleSyncField(f)">
                        <span class="cap-sync-field">{{ fieldLabel(f) }}</span>
                        <span class="cap-sync-diff"><span class="cap-sync-old">{{ currentVal(r, f) || '—' }}</span> <lucide-icon [img]="SyncIcon" [size]="11"></lucide-icon> <span class="cap-sync-new">{{ sourceVal(r, f) || '—' }}</span></span>
                      </label>
                    }
                    <div class="cap-sync-actions">
                      <button type="button" class="cap-btn cap-btn--ghost" (click)="closeSync()">Annuler</button>
                      <button type="button" class="cap-btn cap-btn--primary" [disabled]="r.syncing || syncSel().size === 0" (click)="applySync(r)">
                        @if (r.syncing) { <lucide-icon [img]="LoaderIcon" [size]="13" class="cap-spin"></lucide-icon> }
                        Appliquer
                      </button>
                    </div>
                  </div>
                }
              } @else {
                <div class="cap-src cap-src--none"><lucide-icon [img]="InfoIcon" [size]="11"></lucide-icon> Aucun planning d'installation lié.</div>
              }

              <!-- Capacité éditable -->
              <div class="cap-fields">
                <label class="cap-f">
                  <span><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> Places</span>
                  <input type="number" min="1" max="99" inputmode="numeric" class="cap-in" [disabled]="!canEdit()"
                         [value]="r.draftSeats" (input)="patch(r, 'draftSeats', $any($event.target).value)">
                </label>
                <label class="cap-f">
                  <span><lucide-icon [img]="FuelIcon" [size]="12"></lucide-icon> Énergie</span>
                  <!-- [selected] sur chaque option : avec [value] seul, les options créées par la boucle
                       arrivent après la liaison et le select retombait sur « — ». -->
                  <select class="cap-in" [disabled]="!canEdit()" [value]="r.draftEnergy" (change)="patch(r, 'draftEnergy', $any($event.target).value)">
                    <option value="" [selected]="!r.draftEnergy">—</option>
                    @for (e of energies; track e) { <option [value]="e" [selected]="e === r.draftEnergy">{{ energyLabel(e) }}</option> }
                  </select>
                </label>
                <!-- Sièges auto à bord : lecture seule ici — ils se règlent, avec le total possédé et le
                     stock, dans la vue Parc de l'agenda (une seule règle, un seul endroit), par un
                     administrateur seulement. Un non-administrateur qui peut ouvrir la vue y est
                     renvoyé pour CONSULTER, sans promesse de réglage. -->
                <div class="cap-f cap-f--wide">
                  <span><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> Sièges auto à bord</span>
                  <span class="cap-ro-val">{{ r.childSeatsBaby }} bébé · {{ r.childSeatsChild }} enfant —
                    @if (canReglerSieges()) { se règle dans <a routerLink="/agenda" [queryParams]="{ vue: 'parc' }" class="cap-link">Agenda → vue Parc</a> }
                    @else if (canSeeParc()) { réglés par un administrateur, visibles dans <a routerLink="/agenda" [queryParams]="{ vue: 'parc' }" class="cap-link">Agenda → vue Parc</a> }
                    @else { réglés par un administrateur, dans la vue Parc de l'agenda }
                  </span>
                </div>
                <label class="cap-f cap-f--wide">
                  <span><lucide-icon [img]="ClipboardIcon" [size]="12"></lucide-icon> Équipements (séparés par des virgules)</span>
                  <input type="text" class="cap-in" [disabled]="!canEdit()" placeholder="Ex. climatisation, hayon, GPS"
                         [value]="r.draftFeatures" (input)="patch(r, 'draftFeatures', $any($event.target).value)">
                </label>
              </div>

              @if (canEdit()) {
                <div class="cap-card-foot">
                  @if (isDirty(r)) { <button type="button" class="cap-btn cap-btn--ghost" (click)="resetRow(r)">Annuler</button> }
                  <button type="button" class="cap-btn cap-btn--primary" [disabled]="!isDirty(r) || r.saving" (click)="save(r)">
                    @if (r.saving) { <lucide-icon [img]="LoaderIcon" [size]="13" class="cap-spin"></lucide-icon> } @else { <lucide-icon [img]="SaveIcon" [size]="13"></lucide-icon> }
                    Enregistrer
                  </button>
                </div>
              }
            </article>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .cap { display: flex; flex-direction: column; gap: 12px; }
    .cap-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .cap-lead { font-size: 13px; color: var(--fg-secondary); }
    .cap-hint { font-size: 12px; color: var(--fg-tertiary); display: flex; align-items: center; gap: 5px; margin-top: 3px; }
    .cap-hint lucide-icon { color: var(--tracky-light); }
    .cap-link { color: var(--tracky-light); font-weight: 600; }
    .cap-ro { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-tertiary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 9px; padding: 6px 10px; }
    .cap-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 720px) { .cap-grid { grid-template-columns: 1fr 1fr; } }
    @media (min-width: 1180px) { .cap-grid { grid-template-columns: 1fr 1fr 1fr; } }
    .cap-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: var(--radius-card, 16px); background: var(--bg-secondary); border: 1px solid var(--border-subtle); transition: border-color .15s; }
    .cap-card--dirty { border-color: rgba(16,224,160,.4); }
    .cap-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .cap-id { display: flex; flex-direction: column; min-width: 0; }
    .cap-plate { font-family: var(--font-mono, monospace); font-weight: 800; font-size: 15px; color: var(--fg-primary); letter-spacing: .4px; }
    .cap-model { font-size: 12px; color: var(--fg-tertiary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cap-id-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
    .cap-group { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .cap-energy { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(56,189,248,.14); color: #38BDF8; }
    .cap-src { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11.5px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); }
    .cap-src--none { color: var(--fg-tertiary); }
    .cap-src-label { color: var(--fg-tertiary); display: inline-flex; align-items: center; gap: 4px; }
    .cap-src-val { color: var(--fg-secondary); font-weight: 600; }
    .cap-sync-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 12%, transparent); border-radius: 8px; padding: 4px 9px; }
    .cap-sync-ok { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--tracky-light); }
    .cap-sync-panel { display: flex; flex-direction: column; gap: 7px; padding: 10px; border-radius: 10px; background: var(--bg-primary); border: 1px dashed var(--border-strong); }
    .cap-sync-title { font-size: 11.5px; font-weight: 700; color: var(--fg-secondary); }
    .cap-sync-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .cap-sync-row input { width: 16px; height: 16px; accent-color: var(--tracky-light); }
    .cap-sync-field { font-weight: 600; color: var(--fg-secondary); min-width: 56px; }
    .cap-sync-diff { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-tertiary); }
    .cap-sync-old { text-decoration: line-through; opacity: .7; }
    .cap-sync-new { color: var(--tracky-light); font-weight: 700; }
    .cap-sync-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
    .cap-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .cap-f { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--fg-tertiary); }
    .cap-f--wide { grid-column: 1 / -1; }
    .cap-f > span { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    /* Valeur en lecture seule (sièges auto à bord) : même grille que les champs, sans la casse de libellé. */
    .cap-f > span.cap-ro-val { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 12.5px; color: var(--fg-secondary); padding: 6px 0; }
    .cap-in { width: 100%; padding: 9px 10px; border-radius: 9px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 16px; }
    .cap-in:focus { outline: none; border-color: var(--tracky-light); }
    .cap-in:disabled { opacity: .6; cursor: not-allowed; }
    .cap-card-foot { display: flex; justify-content: flex-end; gap: 8px; }
    .cap-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 9px; font-size: 12.5px; font-weight: 700; }
    .cap-btn--primary { background: var(--tracky, #10B981); color: #fff; }
    .cap-btn--primary:disabled { opacity: .5; }
    .cap-btn--ghost { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .cap-alert { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px; background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); font-size: 13px; }
    .cap-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 36px; text-align: center; color: var(--fg-tertiary); font-size: 13px; }
    .cap-empty-ic { opacity: .3; }
    .cap-skel { height: 150px; border-radius: var(--radius-card, 16px); background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: cap-sh 1.3s infinite; }
    @keyframes cap-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .cap-spin { animation: cap-spin 1s linear infinite; }
    @keyframes cap-spin { to { transform: rotate(360deg); } }
  `],
})
export class VehicleCapacityTableComponent {
  private readonly api = inject(VehiclesApiService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly auth = inject(AuthService);
  private readonly aiStatus = inject(AiStatusService);

  protected readonly FuelIcon = Fuel;
  protected readonly SaveIcon = Save;
  protected readonly CheckIcon = Check;
  protected readonly XIcon = X;
  protected readonly SyncIcon = ArrowLeftRight;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly InfoIcon = Info;
  protected readonly UsersIcon = Users;
  protected readonly ClipboardIcon = ClipboardList;
  protected readonly SparklesIcon = Sparkles;
  protected readonly energies = ENERGIES;

  protected readonly canEdit = computed(() => this.perms.can('vehicles_edit'));
  /**
   * Vue Parc de l'agenda : même garde que `vuePermise('parc')` de la page (onglet, lien profond
   * `?vue=parc`, route) — `reservations_view` seul. Contre-revue du 29/09 : `agenda_view` en plus
   * cachait le lien à un délégué qui peut ouvrir la vue.
   */
  protected readonly canSeeParc = computed(() => this.perms.can('reservations_view'));
  /**
   * Sièges auto (à bord, stock) : réglables par SUPER_ADMIN et FLEET_ADMIN seulement — même règle
   * que `canSeats` de la vue Parc et que les `@Roles` de `PUT /agenda/child-seats*`. Un RÔLE et
   * non une permission : un gestionnaire à qui l'on a ouvert l'agenda n'y trouve aucun champ sièges.
   * Ces deux rôles passent toutes les permissions : la vue Parc leur est toujours ouverte.
   */
  protected readonly canReglerSieges = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  /** Libellé du renvoi vers la vue Parc : n'annonce que ce que le compte pourra y faire. */
  protected readonly renvoiParc = computed(() => {
    if (this.canReglerSieges()) return 'Réglage rapide et stock de sièges auto';
    return this.canEdit()
      ? 'Réglage rapide (places, énergie, équipements) et stock de sièges auto en lecture'
      : 'Le parc et le stock de sièges auto, en lecture';
  });
  /**
   * « Assistant IA → Vérifier le parc » : montré seulement si la vue IA S'OUVRIRA et y portera
   * l'étape que le compte peut LANCER (contre-revue du 29/09) —
   *  - `reservations_view` : `canOptimize` de la page (lien profond `?vue=ia`, `montrerVueIa`) ;
   *  - `AiStatusService.can('capacity')` : l'étape n'existe que si l'analyse de capacité est
   *    ouverte pour la société du bandeau (option payante, coupée par défaut : sans elle la page
   *    retombait sur le Calendrier) ; elle suffit aussi à `montrerVueIa` ;
   *  - `ai_optimize` : sans lui l'étape dit « réservée aux comptes autorisés à lancer l'IA » ;
   *  - super-admin : une société choisie (sinon la vue demande d'en choisir une). Le statut d'IA
   *    sans société est de toute façon tout coupé ; ceci couvre l'instant où il se recharge.
   */
  protected readonly canSeeIa = computed(
    () =>
      this.perms.can('reservations_view') &&
      this.perms.can('ai_optimize') &&
      this.aiStatus.can('capacity') &&
      !(this.auth.user()?.role === 'SUPER_ADMIN' && !this.fleetFilter.selectedFleetId()),
  );
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rows = signal<EditRow[]>([]);

  // Aperçu de synchro : véhicule ouvert + champs cochés.
  protected readonly syncOpenId = signal<string | null>(null);
  protected readonly syncSel = signal<Set<VehicleSyncableField>>(new Set());

  /** Numéro de la dernière lecture lancée : une réponse plus ancienne (société changée) est ignorée. */
  private lecture = 0;

  constructor() {
    // Revue du 29/09 — le serveur accepte désormais la société du bandeau (super-admin) : l'onglet
    // suit le bandeau comme la liste des véhicules, au lieu des 500 premières plaques de TOUTES les
    // sociétés. « Toutes les sociétés » (aucun choix) garde l'ancien comportement.
    effect(() => {
      const fleetId = this.fleetFilter.isActive() ? this.fleetFilter.selectedFleetId() : null;
      untracked(() => void this.load(fleetId));
    });
    // Statut d'IA de la société du bandeau, pour le renvoi « Vérifier le parc » (`canSeeIa`).
    // Idempotent ; le service se recharge de lui-même quand la société change. Opt-in : tant qu'il
    // n'est pas arrivé, le renvoi reste caché (pas de lien montré puis retiré au chargement).
    this.aiStatus.ensureLoaded();
  }

  protected energyLabel(e: InstallationEnergy): string { return ENERGY_LABELS[e]; }
  protected fieldLabel(f: VehicleSyncableField): string { return FIELD_LABELS[f]; }

  private toEditRow(r: VehicleCapacityRowDto): EditRow {
    return {
      ...r,
      draftSeats: r.seats != null ? String(r.seats) : '',
      draftFeatures: (r.features ?? []).join(', '),
      draftEnergy: r.energy ?? '',
      saving: false,
      syncing: false,
    };
  }

  private async load(fleetId: string | null): Promise<void> {
    const n = ++this.lecture;
    this.loading.set(true);
    this.error.set(null);
    this.closeSync();
    try {
      const data = await firstValueFrom(this.api.capacityOverview(fleetId));
      if (n === this.lecture) this.rows.set(data.map((r) => this.toEditRow(r)));
    } catch (e) {
      swallow('vehicle-capacity-table:load', e);
      if (n === this.lecture) this.error.set(this.errMsg(e));
    } finally {
      if (n === this.lecture) this.loading.set(false);
    }
  }

  protected isDirty(r: EditRow): boolean {
    return (
      r.draftSeats !== (r.seats != null ? String(r.seats) : '') ||
      r.draftFeatures !== (r.features ?? []).join(', ') ||
      (r.draftEnergy || '') !== (r.energy ?? '')
    );
  }

  /** Mise à jour immuable d'un champ de brouillon (OnPush-safe). */
  protected patch(row: EditRow, key: 'draftSeats' | 'draftFeatures' | 'draftEnergy', value: string): void {
    this.rows.update((list) => list.map((r) => (r.vehicleId === row.vehicleId ? { ...r, [key]: value } : r)));
  }

  protected resetRow(row: EditRow): void {
    this.rows.update((list) => list.map((r) => (r.vehicleId === row.vehicleId ? this.toEditRow(r) : r)));
  }

  /**
   * Places saisies → nombre à écrire, `undefined` (inchangé) ou un message de refus.
   *
   * Revue du 29/09 (même règle que la vue Parc de l'agenda) : la valeur était RAMENÉE en silence
   * dans 1..99 — « 120 » tapé pour « 12 » devenait 99 places, « 0 » devenait 1 — et un champ vidé
   * gardait l'ancienne valeur sous un « Capacité enregistrée ». On refuse désormais avec un message.
   * `Number` et non `parseInt` (qui lisait « 1e2 » comme 1 et « 9.5 » comme 9). Vider un nombre
   * connu est refusé : un champ numérique rend aussi une chaîne vide pour une frappe invalide.
   */
  private placesAEcrire(row: EditRow): { seats?: number } | { erreur: string } {
    const brut = row.draftSeats.trim();
    if (brut === (row.seats != null ? String(row.seats) : '')) return {};
    if (brut === '') return { erreur: 'Le nombre de places ne peut pas être effacé : gardez-le ou saisissez un nombre entier de 1 à 99.' };
    const n = Number(brut);
    if (!Number.isInteger(n) || n < 1 || n > 99) return { erreur: 'Places : un nombre entier de 1 à 99, conducteur compris.' };
    return n === row.seats ? {} : { seats: n };
  }

  protected async save(row: EditRow): Promise<void> {
    if (!this.canEdit() || row.saving) return;
    const places = this.placesAEcrire(row);
    if ('erreur' in places) {
      this.toast.error(`${row.plate} — non enregistré`, places.erreur);
      return;
    }
    const features = row.draftFeatures.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);
    const energy = (row.draftEnergy || null) as InstallationEnergy | null;
    const payload: Record<string, unknown> = { features, energy };
    if (places.seats !== undefined) payload['seats'] = places.seats;

    this.setRow(row.vehicleId, { saving: true });
    try {
      const updated = await firstValueFrom(this.api.update(row.vehicleId, payload));
      this.rows.update((list) =>
        list.map((r) =>
          r.vehicleId === row.vehicleId
            ? this.toEditRow({
                ...r,
                seats: updated.seats,
                features: updated.features ?? [],
                energy: updated.energy,
              })
            : r,
        ),
      );
      this.toast.success('Capacité enregistrée', row.plate);
    } catch (e) {
      swallow('vehicle-capacity-table:save', e);
      this.setRow(row.vehicleId, { saving: false });
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  // ─── Synchro depuis le planning ───
  protected openSync(row: EditRow): void {
    this.syncSel.set(new Set(row.divergentFields));
    this.syncOpenId.set(row.vehicleId);
  }
  protected closeSync(): void {
    this.syncOpenId.set(null);
    this.syncSel.set(new Set());
  }
  protected toggleSyncField(f: VehicleSyncableField): void {
    const next = new Set(this.syncSel());
    if (next.has(f)) next.delete(f); else next.add(f);
    this.syncSel.set(next);
  }
  protected currentVal(r: EditRow, f: VehicleSyncableField): string {
    if (f === 'energy') return r.energy ? this.energyLabel(r.energy) : '';
    return (r[f] as string | null) ?? '';
  }
  protected sourceVal(r: EditRow, f: VehicleSyncableField): string {
    const s = r.installationSource;
    if (!s) return '';
    if (f === 'energy') return s.energy ? this.energyLabel(s.energy) : '';
    return (s[f] as string | null) ?? '';
  }

  protected async applySync(row: EditRow): Promise<void> {
    const fields = [...this.syncSel()];
    if (!this.canEdit() || row.syncing || fields.length === 0) return;
    this.setRow(row.vehicleId, { syncing: true });
    try {
      const updated = await firstValueFrom(this.api.syncFromInstallation(row.vehicleId, fields));
      // Recalcule les écarts résiduels vs la source (un champ peut rester divergent s'il n'a pas été coché).
      this.rows.update((list) =>
        list.map((r) => {
          if (r.vehicleId !== row.vehicleId) return r;
          const merged: VehicleCapacityRowDto = {
            ...r,
            brand: updated.brand,
            model: updated.model,
            energy: updated.energy,
            divergentFields: this.recomputeDivergent(r, updated.brand, updated.model, updated.energy),
          };
          return this.toEditRow(merged);
        }),
      );
      this.toast.success('Synchronisé depuis le planning', row.plate);
      this.closeSync();
    } catch (e) {
      swallow('vehicle-capacity-table:energyLabel', e);
      this.setRow(row.vehicleId, { syncing: false });
      this.toast.error('Échec de la synchro', this.errMsg(e));
    }
  }

  private recomputeDivergent(
    r: EditRow,
    brand: string | null,
    model: string | null,
    energy: InstallationEnergy | null,
  ): VehicleSyncableField[] {
    const s = r.installationSource;
    if (!s) return [];
    const out: VehicleSyncableField[] = [];
    if (s.brand && s.brand !== brand) out.push('brand');
    if (s.model && s.model !== model) out.push('model');
    if (s.energy && s.energy !== energy) out.push('energy');
    return out;
  }

  /** Patch immuable de quelques champs d'état d'une ligne (saving/syncing). */
  private setRow(vehicleId: string, partial: Partial<EditRow>): void {
    this.rows.update((list) => list.map((r) => (r.vehicleId === vehicleId ? { ...r, ...partial } : r)));
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return Array.isArray(m) ? m.join(', ') : m;
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}

import { swallow } from '../../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage } from '../../../core/error/api-error';
import {
  LucideAngularModule, Baby, Truck, X, Loader, Pencil, Check, AlertTriangle, WifiOff, Ban, Search,
} from 'lucide-angular';
import {
  CHILD_SEAT_LABELS,
  CHILD_SEAT_POLICY_LABELS,
  DORMANT_STOP_COUNTING_MS,
  formatSilenceLabel,
  isVehicleDormant,
  type ChildSeatCounts,
  type ChildSeatPolicy,
  type ChildSeatStockDto,
  type InstallationEnergy,
  type VehicleCapacityRowDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaSyncService } from '../agenda-sync.service';
import { AgendaApiService } from '../../../core/services/agenda.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../../core/services/vehicles.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';
import { GroupBadgeComponent } from '../../../shared/ui/group-badge/group-badge.component';
import { horsServiceLabel } from '../sheets/reservation-sheet.component';

const ENERGIES: InstallationEnergy[] = ['DIESEL', 'ESSENCE', 'ELECTRIQUE', 'HYBRIDE', 'AUTRE'];
const ENERGY_LABELS: Record<InstallationEnergy, string> = {
  DIESEL: 'Diesel', ESSENCE: 'Essence', ELECTRIQUE: 'Électrique', HYBRIDE: 'Hybride', AUTRE: 'Autre',
};
const SEAT_POLICIES: ChildSeatPolicy[] = ['STOCK_OR_INSTALLED', 'INSTALLED_ONLY'];

/** Brouillon de la feuille de réglage rapide d'un véhicule. */
interface Brouillon {
  row: VehicleCapacityRowDto;
  seats: string;
  energy: string;
  features: string;
  baby: number;
  child: number;
}

/**
 * État lisible d'un véhicule dans la grille (au plus un, le plus grave d'abord).
 *
 * Revue du 29/09 : lu sur la LIGNE du parc elle-même. Il était cherché dans la liste de véhicules
 * de la page, que `GET /vehicles` plafonne à 50 (toutes sociétés mêlées pour un super-admin) : les
 * cartes absentes de cette liste n'avaient aucun état, et les compteurs « hors service » / « boîtier
 * muet » étaient faux. Le seuil ne change pas : même prédicat et même seuil que la feuille Réserver
 * (`isVehicleDormant` + `DORMANT_STOP_COUNTING_MS`), recalculés ici depuis `lastSeenAt`.
 */
export function etatVehicule(
  r: Pick<VehicleCapacityRowDto, 'outOfServiceReason' | 'dormant' | 'lastSeenAt' | 'silenceLabel'> | undefined,
  now = Date.now(),
): { kind: 'hors_service' | 'muet'; label: string } | null {
  if (!r) return null;
  const hs = horsServiceLabel(r.outOfServiceReason);
  if (hs) return { kind: 'hors_service', label: `Hors service · ${hs}` };
  if (r.lastSeenAt === undefined) {
    // Réponse sans le champ (API antérieure) : le drapeau du serveur, calculé au même seuil.
    return r.dormant ? { kind: 'muet', label: `Boîtier muet depuis ${r.silenceLabel ?? 'longtemps'}` } : null;
  }
  // `lastSeenAt` ne vient QUE du boîtier : non nul, il prouve qu'un boîtier est affecté et a déjà
  // parlé. Nul (pas de boîtier, ou jamais émis) n'est pas « muet » — exactement le prédicat partagé.
  if (isVehicleDormant({ trackerId: r.lastSeenAt ? 'affecté' : null, lastSeenAt: r.lastSeenAt }, now, DORMANT_STOP_COUNTING_MS)) {
    return { kind: 'muet', label: `Boîtier muet depuis ${formatSilenceLabel(r.lastSeenAt, now)}` };
  }
  return null;
}

/**
 * Même règle et même phrase que le serveur (`ChildSeatsService.setStock`) : on ne peut pas posséder
 * moins de sièges qu'il n'y en a d'installés. Contrôlé AVANT l'appel pour répondre tout de suite ;
 * le serveur reste l'autorité (un autre administrateur a pu modifier les sièges à bord entre-temps).
 */
function messageSiegesInstalles(installed: ChildSeatCounts): string {
  return `Impossible : ${installed.baby} siège(s) « ${CHILD_SEAT_LABELS.BABY} » et ${installed.child} « ${CHILD_SEAT_LABELS.CHILD} » sont installés dans des véhicules. `
    + 'Retirez-les des véhicules avant de réduire le total possédé.';
}

/**
 * Quatrième revue du 29/09 (C3) — le 403 d'une écriture sur UN véhicule. Le serveur refuse désormais
 * véhicule par véhicule (« Permission requise : vehicles_edit »), et ce texte technique arrivait tel
 * quel à l'écran. Un refus de droit se dit en clair ; un autre 403, porteur d'un motif explicite du
 * serveur, reste affiché tel quel.
 */
export function messageEcritureVehicule(err: unknown, fallback: string): string {
  if (err instanceof HttpErrorResponse && err.status === 403) {
    const body = err.error as { message?: string; error?: { message?: string } } | null;
    const m = (body?.error?.message ?? body?.message ?? '').trim();
    if (!m || m.startsWith('Permission requise') || m.startsWith('Forbidden')) return 'Vous ne pouvez que consulter ce véhicule.';
  }
  return apiErrorMessage(err, fallback);
}

/** Équipements tels que le serveur les range (`normalizeFeatures`) : rognés, sans vide, sans doublon à la casse près. */
function normaliserEquipements(texte: string): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const brut of texte.split(',')) {
    const t = brut.trim();
    if (!t || vus.has(t.toLowerCase())) continue;
    vus.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 30);
}

/**
 * Ce que la fiche doit VRAIMENT écrire (revue du 29/09), validé avant toute écriture.
 *
 * Le PATCH partait dès que le texte d'un champ différait, avec l'énergie et les équipements
 * inchangés, et laissait tomber en silence des places vidées ou hors bornes (« 0 », « 120 ») : le
 * message annonçait « fiche mise à jour » et l'ancienne valeur revenait au rechargement. Désormais :
 *  - places : un entier de 1 à 99, sinon un message et RIEN n'est envoyé (ni fiche, ni sièges) ;
 *    `Number` et non `parseInt`, qui faisait de « 1e2 » une place et de « 9.5 » neuf places ;
 *  - un nombre connu qu'on vide est refusé avec un message. Le PATCH accepterait `seats: null`,
 *    mais un champ numérique rend aussi une chaîne vide pour une frappe invalide (« 1e ») :
 *    l'envoyer effacerait les places sur une faute de frappe ;
 *  - seuls les champs réellement changés partent, comparés après la même normalisation que le serveur.
 */
function ficheAEcrire(e: Brouillon): { erreur: string } | { payload: Record<string, unknown>; champs: string[] } {
  const r = e.row;
  const payload: Record<string, unknown> = {};
  const champs: string[] = [];
  const brut = e.seats.trim();
  if (brut !== (r.seats === null ? '' : String(r.seats))) {
    if (brut === '') {
      return { erreur: 'Le nombre de places ne peut pas être effacé ici : gardez-le ou saisissez un nombre entier de 1 à 99.' };
    }
    const n = Number(brut);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      return { erreur: 'Places : un nombre entier de 1 à 99, conducteur compris.' };
    }
    if (n !== r.seats) { payload['seats'] = n; champs.push('places'); }
  }
  const energie = e.energy || null;
  if (energie !== (r.energy ?? null)) { payload['energy'] = energie; champs.push('énergie'); }
  const equipements = normaliserEquipements(e.features);
  if (JSON.stringify(equipements) !== JSON.stringify(r.features)) { payload['features'] = equipements; champs.push('équipements'); }
  return { payload, champs };
}

/**
 * ── VUE « PARC » (refonte UX du 28/09, point 3) ───────────────────────────────────────────────
 *
 * « Une vue sous forme de schéma des véhicules : le gestionnaire clique sur un véhicule et fait
 * directement les réglages — sièges, places, configuration — pour garantir que l'agenda soit
 * cohérent avec la configuration réelle. » Et pour le stock, « une représentation visuelle ».
 *
 * Tout ce que l'agenda LIT d'un véhicule est ici, sur une carte ; un clic ouvre le réglage rapide.
 * Le stock de sièges est dessiné : un siège plein est à bord d'un véhicule, un siège creux est en
 * stock. Aucune nouvelle route : `PATCH /vehicles/:id` (places, énergie, équipements),
 * `PUT /agenda/child-seats/vehicles/:id` (sièges à bord), `PUT /agenda/child-seats` (possédés,
 * réglage). Le bloc « Sièges auto » des Paramètres de l'agenda renvoie ici.
 *
 * Revue du 29/09 : la grille est le parc ENTIER de la société du bandeau
 * (`GET /vehicles/capacity-overview?fleetId=`), et non plus son recoupement avec la liste de la page ; et
 * chaque écriture prévient la page par `AgendaSyncService`, qui survit à la destruction de la vue.
 */
@Component({
  selector: 'app-agenda-parc-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, BottomSheetComponent, GroupBadgeComponent],
  template: `
    <section class="pv" aria-label="Parc">
      <header class="pv-head">
        <div class="pv-head-txt">
          <h2 class="pv-t"><lucide-icon [img]="TruckIcon" [size]="18"></lucide-icon> Parc</h2>
          <p class="pv-l">Ce que l'agenda sait de chaque véhicule — places, sièges auto à bord, équipements, groupe — et ce qu'il reste à renseigner. <strong>Touchez un véhicule pour le régler.</strong></p>
        </div>
        <div class="pv-kpis">
          <span class="pv-kpi"><strong>{{ rows().length }}</strong> véhicule{{ rows().length > 1 ? 's' : '' }}</span>
          @if (sansPlaces() > 0) { <span class="pv-kpi pv-kpi--warn"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> <strong>{{ sansPlaces() }}</strong> sans places renseignées</span> }
          @if (horsService() > 0) { <span class="pv-kpi pv-kpi--off"><lucide-icon [img]="BanIcon" [size]="12"></lucide-icon> <strong>{{ horsService() }}</strong> hors service</span> }
          @if (muets() > 0) { <span class="pv-kpi pv-kpi--off"><lucide-icon [img]="WifiOffIcon" [size]="12"></lucide-icon> <strong>{{ muets() }}</strong> boîtier muet</span> }
        </div>
      </header>

      @if (needsFleet()) {
        <div class="pv-note">Choisissez une société dans le bandeau en haut de page : le parc se règle société par société.</div>
      } @else {
        <!-- ───── Le stock de sièges, dessiné ───── -->
        <div class="pv-stock">
          <div class="pv-stock-head">
            <span class="pv-stock-t"><lucide-icon [img]="BabyIcon" [size]="14"></lucide-icon> Sièges auto de la société</span>
            @if (canStock() && stock() && !stockEdit()) {
              <button type="button" class="pv-mini" (click)="ouvrirStock()"><lucide-icon [img]="PencilIcon" [size]="12"></lucide-icon> Modifier</button>
            }
          </div>
          <!-- stockError = échec de LECTURE seulement (il n'y a alors rien à montrer). Un refus
               d'enregistrement s'affiche DANS le formulaire (stockSaveError) : la saisie reste. -->
          @if (stockError(); as e) {
            <p class="pv-err"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> {{ e }}
              <button type="button" class="pv-mini" (click)="chargerStock()">Réessayer</button></p>
          }
          @else if (!stock()) { <div class="pv-skel"></div> }
          @else {
            <div class="pv-stock-rows">
              @for (t of types; track t.key) {
                <div class="pv-stock-row">
                  <span class="pv-stock-lbl">{{ t.label }} <em>{{ t.ex }}</em></span>
                  <span class="pv-seats" [attr.aria-label]="t.label + ' : ' + stock()!.installed[t.key] + ' à bord, ' + stock()!.stock[t.key] + ' en stock'">
                    @for (i of plages(stock()!.total[t.key]); track i) {
                      <span class="pv-seat" [class.pv-seat--bord]="i < stock()!.installed[t.key]" [title]="i < stock()!.installed[t.key] ? 'À bord d’un véhicule' : 'En stock (mobile)'"></span>
                    }
                    @if (stock()!.total[t.key] === 0) { <span class="pv-seat-none">aucun</span> }
                  </span>
                  <span class="pv-stock-n"><strong>{{ stock()!.installed[t.key] }}</strong> à bord · <strong>{{ stock()!.stock[t.key] }}</strong> en stock · {{ stock()!.total[t.key] }} possédé{{ stock()!.total[t.key] > 1 ? 's' : '' }}</span>
                </div>
              }
            </div>
            @if (!stockEdit()) {
              <p class="pv-stock-policy">Réglage : <strong>{{ policyLabel(stock()!.policy) }}</strong> — {{ policyHelp(stock()!.policy) }}</p>
              @if (stock()!.total.baby === 0 && stock()!.total.child === 0) {
                <p class="pv-hint pv-hint--warn">Aucun siège renseigné : toute réservation qui demande un siège auto sera refusée tant que ce n'est pas compté.</p>
              }
            } @else {
              <div class="pv-stock-edit">
                <label class="pv-f"><span>Bébé possédés</span><input type="number" min="0" max="500" inputmode="numeric" class="pv-in" [value]="stockDraft().baby" (input)="stockDraftSet('baby', $any($event.target).value)"></label>
                <label class="pv-f"><span>Enfant possédés</span><input type="number" min="0" max="500" inputmode="numeric" class="pv-in" [value]="stockDraft().child" (input)="stockDraftSet('child', $any($event.target).value)"></label>
                <label class="pv-f pv-f--wide"><span>Si le véhicule choisi n'a pas les sièges à bord</span>
                  <select class="pv-in" [value]="stockDraft().policy" (change)="stockDraftPolicy($any($event.target).value)">
                    @for (p of policies; track p) { <option [value]="p" [selected]="p === stockDraft().policy">{{ policyLabel(p) }}</option> }
                  </select>
                  <span class="pv-hint">{{ policyHelp(stockDraft().policy) }}</span>
                </label>
                @if (stockSaveError(); as err) {
                  <p class="pv-err pv-stock-err" role="alert"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> {{ err }}</p>
                }
                <div class="pv-stock-actions">
                  <button type="button" class="pv-btn" (click)="annulerStock()">Annuler</button>
                  <button type="button" class="pv-btn pv-btn--primary" [disabled]="stockSaving()" (click)="saveStock()">
                    @if (stockSaving()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="pv-spin"></lucide-icon> } Enregistrer
                  </button>
                </div>
              </div>
            }
          }
        </div>

        <!-- ───── Les véhicules ───── -->
        <div class="pv-tools">
          <label class="pv-search"><lucide-icon [img]="SearchIcon" [size]="14"></lucide-icon><input type="search" placeholder="Plaque, modèle, groupe…" [value]="filtre()" (input)="filtre.set($any($event.target).value)" aria-label="Filtrer les véhicules"></label>
          <span class="pv-legend"><span class="pv-legend-dot pv-legend-dot--warn"></span> à compléter · <span class="pv-legend-dot pv-legend-dot--off"></span> indisponible</span>
        </div>
        @if (rowsError(); as e) { <p class="pv-err"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> {{ e }}</p> }
        @else if (rowsLoading()) { <div class="pv-grid"><div class="pv-skel"></div><div class="pv-skel"></div><div class="pv-skel"></div></div> }
        @else if (rowsFiltrees().length === 0) { <p class="pv-hint">Aucun véhicule@if (filtre()) { pour « {{ filtre() }} » }.</p> }
        @else {
          <div class="pv-grid">
            @for (r of rowsFiltrees(); track r.vehicleId) {
              <button type="button" class="pv-card" [class.pv-card--off]="!!etatDe(r)" [class.pv-card--warn]="r.seats === null" (click)="ouvrir(r)" [attr.aria-label]="'Régler ' + r.plate">
                <div class="pv-card-top">
                  <span class="pv-plate">{{ r.plate }}</span>
                  <app-group-badge [group]="r.group" />
                </div>
                <div class="pv-model">{{ r.brand || '' }} {{ r.model || '' }}@if (!r.brand && !r.model) { {{ r.type }} }@if (r.energy) { <span class="pv-energy">· {{ energyLabel(r.energy) }}</span> }</div>
                <div class="pv-chips">
                  <span class="pv-chip" [class.pv-chip--warn]="r.seats === null">{{ r.seats === null ? 'places ?' : r.seats + ' places' }}</span>
                  <span class="pv-chip pv-chip--seat" [class.pv-chip--none]="r.childSeatsBaby === 0 && r.childSeatsChild === 0"><lucide-icon [img]="BabyIcon" [size]="11"></lucide-icon> @if (r.childSeatsBaby === 0 && r.childSeatsChild === 0) { aucun siège à bord } @else { {{ r.childSeatsBaby }} bébé · {{ r.childSeatsChild }} enfant }</span>
                  @for (f of r.features.slice(0, 3); track f) { <span class="pv-chip pv-chip--feat">{{ f }}</span> }
                  @if (r.features.length > 3) { <span class="pv-chip pv-chip--feat">+{{ r.features.length - 3 }}</span> }
                </div>
                @if (etatDe(r); as e) {
                  <span class="pv-etat" [attr.data-kind]="e.kind"><lucide-icon [img]="e.kind === 'muet' ? WifiOffIcon : BanIcon" [size]="11"></lucide-icon> {{ e.label }}</span>
                }
              </button>
            }
          </div>
        }
      }
    </section>

    <!-- ───── Réglage rapide d'un véhicule ───── -->
    <app-bottom-sheet [open]="!!edit()" ariaLabel="Régler le véhicule" (closed)="fermer()">
      @if (edit(); as e) {
        <div class="pv-sheet">
          <div class="pv-sheet-head">
            <h3 class="pv-sheet-t"><span class="pv-plate">{{ e.row.plate }}</span> <span class="pv-sheet-sub">{{ e.row.brand || '' }} {{ e.row.model || '' }}</span></h3>
            <button type="button" class="pv-x" (click)="fermer()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </div>
          <div class="pv-sheet-body">
            @if (!canEditRow(e.row) && !canSeats()) {
              <p class="pv-hint">Vous ne pouvez que consulter ce véhicule : votre droit « Modifier un véhicule » ne le couvre pas.</p>
            }
            <div class="pv-grid2">
              <label class="pv-f"><span>Places <em>conducteur compris</em></span><input type="number" min="1" max="99" inputmode="numeric" class="pv-in" [disabled]="!canEditRow(e.row)" [value]="e.seats" (input)="draftSet('seats', $any($event.target).value)" placeholder="ex. 9"></label>
              <label class="pv-f"><span>Énergie</span>
                <select class="pv-in" [disabled]="!canEditRow(e.row)" (change)="draftSet('energy', $any($event.target).value)">
                  <option value="" [selected]="!e.energy">—</option>
                  @for (en of energies; track en) { <option [value]="en" [selected]="en === e.energy">{{ energyLabel(en) }}</option> }
                </select>
              </label>
            </div>
            <label class="pv-f"><span>Équipements <em>séparés par des virgules</em></span><input type="text" class="pv-in" [disabled]="!canEditRow(e.row)" [value]="e.features" (input)="draftSet('features', $any($event.target).value)" placeholder="ex. climatisation, attelage, rampe PMR"></label>
            <p class="pv-hint">Les places et les équipements servent aux critères des demandes (« 7 places, attelage ») et à l'IA de placement.</p>
            @if (canSeats()) {
              <div class="pv-grid2">
                <label class="pv-f"><span>Sièges bébé à bord</span><input type="number" min="0" max="20" inputmode="numeric" class="pv-in" [value]="e.baby" (input)="draftSet('baby', $any($event.target).value)"></label>
                <label class="pv-f"><span>Sièges enfant à bord</span><input type="number" min="0" max="20" inputmode="numeric" class="pv-in" [value]="e.child" (input)="draftSet('child', $any($event.target).value)"></label>
              </div>
              <p class="pv-hint">Un siège à bord est prêt pour ce véhicule ; les autres sièges possédés restent en stock, mobiles. Si la société possède moins de sièges que ce qu'on installe, le total est relevé. Un siège « Bébé » ne remplace jamais un siège « Enfant ».</p>
            } @else if (e.row.childSeatsBaby > 0 || e.row.childSeatsChild > 0) {
              <p class="pv-hint">À bord : {{ e.row.childSeatsBaby }} bébé · {{ e.row.childSeatsChild }} enfant (réglés par un administrateur).</p>
            }
            @if (editError(); as err) { <p class="pv-err"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> {{ err }}</p> }
          </div>
          <div class="pv-sheet-foot">
            <button type="button" class="pv-btn" (click)="fermer()">Annuler</button>
            @if (canEditRow(e.row) || canSeats()) {
              <button type="button" class="pv-btn pv-btn--primary" [disabled]="saving() || !dirty()" (click)="enregistrer()">
                @if (saving()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="pv-spin"></lucide-icon> } @else { <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> } Enregistrer
              </button>
            }
          </div>
        </div>
      }
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: block; }
    .pv { display: flex; flex-direction: column; gap: 12px; }
    .pv-head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
    .pv-head-txt { flex: 1; min-width: 240px; }
    .pv-t { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .pv-t lucide-icon { color: var(--tracky-light); }
    .pv-l { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-secondary); line-height: 1.5; }
    .pv-l strong { color: var(--fg-primary); }
    .pv-kpis { display: flex; gap: 6px; flex-wrap: wrap; }
    .pv-kpi { display: inline-flex; align-items: center; gap: 4px; padding: 5px 9px; border-radius: 999px; font-size: 11.5px; color: var(--fg-secondary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .pv-kpi strong { color: var(--fg-primary); }
    .pv-kpi--warn { color: var(--texte-attente); border-color: color-mix(in srgb, var(--warning) 40%, transparent); }
    .pv-kpi--off { color: var(--fg-tertiary); }
    .pv-note { padding: 10px 12px; border-radius: 11px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: 12.5px; }

    /* Le stock, dessiné. */
    .pv-stock { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .pv-stock-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .pv-stock-t { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .pv-stock-t lucide-icon { color: var(--tracky-light); }
    .pv-stock-rows { display: flex; flex-direction: column; gap: 6px; }
    .pv-stock-row { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 10px; }
    .pv-stock-lbl { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .pv-stock-lbl em { display: block; font-style: normal; font-size: 10.5px; font-weight: 400; color: var(--fg-tertiary); }
    .pv-seats { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 18px; }
    .pv-seat { width: 16px; height: 18px; border-radius: 5px 5px 3px 3px; border: 2px solid var(--tracky-light); background: transparent; box-sizing: border-box; }
    .pv-seat--bord { background: var(--tracky-light); }
    .pv-seat-none { font-size: 11.5px; color: var(--fg-tertiary); font-style: italic; }
    .pv-stock-n { font-size: 11.5px; color: var(--fg-tertiary); white-space: nowrap; }
    .pv-stock-n strong { color: var(--fg-primary); }
    .pv-stock-policy { margin: 0; font-size: 12px; color: var(--fg-secondary); line-height: 1.45; }
    .pv-stock-policy strong { color: var(--fg-primary); }
    .pv-stock-edit { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-top: 4px; }
    .pv-f--wide { grid-column: 1 / -1; }
    .pv-stock-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
    .pv-stock-err { grid-column: 1 / -1; align-items: flex-start; line-height: 1.45; }
    .pv-err .pv-mini { margin-left: auto; }

    .pv-tools { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .pv-search { display: flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); flex: 1; max-width: 320px; min-height: 40px; }
    .pv-search input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--fg-primary); font-size: 13px; outline: none; }
    .pv-legend { font-size: 11px; color: var(--fg-tertiary); display: inline-flex; align-items: center; gap: 4px; }
    .pv-legend-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
    .pv-legend-dot--warn { background: var(--warning); }
    .pv-legend-dot--off { background: var(--fg-tertiary); }

    .pv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
    .pv-card { text-align: left; display: flex; flex-direction: column; gap: 6px; padding: 11px 12px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); cursor: pointer; transition: border-color .12s, transform .05s; }
    .pv-card:hover { border-color: var(--tracky-light); }
    .pv-card:active { transform: translateY(1px); }
    .pv-card--warn { border-left: 3px solid var(--warning); }
    .pv-card--off { opacity: .7; border-left: 3px solid var(--fg-tertiary); }
    .pv-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .pv-plate { font-family: var(--font-mono, monospace); font-weight: 800; font-size: 13.5px; color: var(--fg-primary); letter-spacing: .3px; }
    .pv-model { font-size: 11.5px; color: var(--fg-tertiary); }
    .pv-energy { color: var(--fg-tertiary); }
    .pv-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .pv-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; color: var(--fg-secondary); background: var(--bg-tertiary); }
    .pv-chip--warn { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 14%, transparent); }
    .pv-chip--seat { color: var(--texte-succes); background: color-mix(in srgb, var(--tracky-light) 12%, transparent); }
    .pv-chip--seat lucide-icon { color: var(--tracky-light); }
    .pv-chip--none { color: var(--fg-tertiary); background: var(--bg-tertiary); }
    .pv-chip--none lucide-icon { color: var(--fg-tertiary); }
    .pv-chip--feat { font-weight: 600; }
    .pv-etat { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; color: var(--fg-tertiary); }
    .pv-etat[data-kind='hors_service'] { color: var(--texte-alerte); }

    .pv-mini { display: inline-flex; align-items: center; gap: 4px; padding: 6px 9px; border-radius: 8px; font-size: 12px; font-weight: 700; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); min-height: 32px; }
    .pv-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 700; min-height: 40px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; }
    .pv-btn--primary { background: var(--tracky); color: var(--accent-ink); border-color: transparent; }
    .pv-btn:disabled { opacity: .55; cursor: not-allowed; }
    .pv-f { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); }
    .pv-f em { font-style: normal; font-weight: 400; text-transform: none; letter-spacing: 0; }
    .pv-in { width: 100%; min-height: 40px; padding: 8px 10px; border-radius: 9px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 15px; text-transform: none; letter-spacing: 0; font-weight: 500; }
    .pv-in:disabled { opacity: .6; }
    .pv-hint { margin: 0; font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.45; text-transform: none; letter-spacing: 0; font-weight: 400; }
    .pv-hint--warn { color: var(--texte-attente); }
    .pv-err { display: flex; align-items: center; gap: 5px; margin: 0; font-size: 12px; color: var(--texte-alerte); }
    .pv-skel { height: 64px; border-radius: 12px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: pv-sh 1.3s infinite; }
    @keyframes pv-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .pv-spin { animation: pv-spin 1s linear infinite; }
    @keyframes pv-spin { to { transform: rotate(360deg); } }

    .pv-sheet { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .pv-sheet-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .pv-sheet-t { margin: 0; display: flex; align-items: baseline; gap: 8px; font-size: 15px; }
    .pv-sheet-sub { font-size: 12px; font-weight: 500; color: var(--fg-tertiary); }
    .pv-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .pv-sheet-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 2px 2px; overflow-y: auto; max-height: 62vh; max-height: 62dvh; }
    .pv-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .pv-sheet-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border-subtle); }

    @media (max-width: 560px) {
      .pv-stock-row { grid-template-columns: 1fr; gap: 4px; }
      .pv-stock-n { white-space: normal; }
      .pv-stock-edit { grid-template-columns: 1fr; }
    }
    :host-context([data-theme='dark']) .pv-in { border-color: rgba(255,255,255,.15); color-scheme: dark; }
  `],
})
export class AgendaParcViewComponent {
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly agendaApi = inject(AgendaApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly sync = inject(AgendaSyncService);

  /**
   * PLUS LU depuis la revue du 29/09 — gardé pour que la liaison de la page compile.
   * Cette liste vient de `GET /vehicles`, plafonné à 50 (toutes sociétés mêlées pour un
   * super-admin) : la recouper amputait la grille des véhicules les plus anciens. La grille est
   * désormais le parc de la société lu en entier, et l'état se lit sur chaque ligne.
   */
  readonly vehicles = input<VehicleDetailDto[]>([]);
  /**
   * Déclarée pour la liaison de la page, mais PLUS ÉMISE (revue du 29/09) : une sortie émise après
   * la destruction de la vue (écriture longue, puis changement de vue) ne parvient plus à la page.
   * Chaque écriture appelle `AgendaSyncService.vehiculesModifies()`, que la page observe.
   */
  readonly changed = output<void>();

  protected readonly BabyIcon = Baby;
  protected readonly TruckIcon = Truck;
  protected readonly XIcon = X;
  protected readonly LoaderIcon = Loader;
  protected readonly PencilIcon = Pencil;
  protected readonly CheckIcon = Check;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly WifiOffIcon = WifiOff;
  protected readonly BanIcon = Ban;
  protected readonly SearchIcon = Search;
  protected readonly energies = ENERGIES;
  protected readonly policies = SEAT_POLICIES;
  protected readonly types: { key: 'baby' | 'child'; label: string; ex: string }[] = [
    { key: 'baby', label: 'Bébé', ex: 'coque, cosy, nacelle' },
    { key: 'child', label: 'Enfant', ex: 'siège, rehausseur' },
  ];

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.fleetFilter.selectedFleetId());
  /**
   * Quatrième revue du 29/09 (C3) — le droit se lit PAR VÉHICULE. Il se lisait en union
   * (`perms.can('vehicles_edit')` sans véhicule) : un gestionnaire « Nord : modifier, Sud :
   * consulter » voyait les champs actifs sur les véhicules Sud, et chaque enregistrement finissait
   * en 403 « Permission requise : vehicles_edit ».
   *
   * Le droit « Modifier un véhicule » sur CE véhicule — même règle que le serveur (le plus spécifique
   * gagne : véhicule > groupe > tous ; administrateurs toujours autorisés). Les sièges à bord restent
   * réservés aux administrateurs (`canSeats`, rôle vérifié par le serveur) : un administrateur a tous
   * les véhicules de sa société, il n'y a pas d'équivalent par véhicule à résoudre.
   */
  protected canEditRow(r: Pick<VehicleCapacityRowDto, 'vehicleId'>): boolean {
    return this.perms.can('vehicles_edit', r.vehicleId);
  }
  protected readonly canSeats = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  protected readonly canStock = this.canSeats;

  protected readonly overview = signal<VehicleCapacityRowDto[]>([]);
  protected readonly rowsLoading = signal(false);
  protected readonly rowsError = signal<string | null>(null);
  protected readonly filtre = signal('');
  /**
   * Le parc de la société, tel que le serveur le renvoie (déjà borné à la société du bandeau ou à
   * celle du compte). Revue du 29/09 : plus aucun recoupement avec la liste de la page.
   */
  protected readonly rows = computed(() => [...this.overview()].sort((a, b) => a.plate.localeCompare(b.plate)));
  protected readonly rowsFiltrees = computed(() => {
    const q = this.filtre().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter((r) =>
      [r.plate, r.brand, r.model, r.group?.name, ...r.features].filter(Boolean).some((x) => String(x).toLowerCase().includes(q)),
    );
  });
  /** État de chaque ligne, calculé une fois par lecture du parc (cartes ET compteurs lisent le même). */
  private readonly etats = computed(() => {
    const now = Date.now();
    return new Map(this.rows().map((r) => [r.vehicleId, etatVehicule(r, now)]));
  });
  protected readonly sansPlaces = computed(() => this.rows().filter((r) => r.seats === null).length);
  protected readonly horsService = computed(() => [...this.etats().values()].filter((e) => e?.kind === 'hors_service').length);
  protected readonly muets = computed(() => [...this.etats().values()].filter((e) => e?.kind === 'muet').length);

  protected readonly stock = signal<ChildSeatStockDto | null>(null);
  /** Échec de LECTURE du stock : il n'y a rien à montrer, le bloc affiche le message et « Réessayer ». */
  protected readonly stockError = signal<string | null>(null);
  /**
   * Refus d'ENREGISTREMENT (revue du 29/09) — distinct de `stockError`. Il remplaçait tout le bloc :
   * plus de formulaire, plus d'Annuler ni de Modifier, saisie perdue, et rien pour en sortir sauf
   * quitter la vue. Il s'affiche désormais DANS le formulaire, qui reste ouvert avec la saisie.
   * Effacé à l'ouverture, à Annuler, au début de chaque enregistrement et quand les sièges à bord changent.
   */
  protected readonly stockSaveError = signal<string | null>(null);
  protected readonly stockEdit = signal(false);
  protected readonly stockSaving = signal(false);
  protected readonly stockDraft = signal<{ baby: number; child: number; policy: ChildSeatPolicy }>({ baby: 0, child: 0, policy: 'STOCK_OR_INSTALLED' });

  protected readonly edit = signal<Brouillon | null>(null);
  protected readonly saving = signal(false);
  protected readonly editError = signal<string | null>(null);
  /**
   * Le bouton Enregistrer s'allume s'il y a quelque chose à écrire APRÈS normalisation (une virgule
   * en trop n'est pas un changement), ou une saisie de places invalide — pour que le clic dise
   * pourquoi elle est refusée au lieu de la taire.
   */
  protected readonly dirty = computed(() => {
    const e = this.edit();
    if (!e) return false;
    // C3 : seul ce qu'on a le droit d'écrire sur CE véhicule allume le bouton.
    const fiche = this.canEditRow(e.row) ? ficheAEcrire(e) : { champs: [] as string[] };
    const sieges = this.canSeats() && (e.baby !== e.row.childSeatsBaby || e.child !== e.row.childSeatsChild);
    return 'erreur' in fiche || fiche.champs.length > 0 || sieges;
  });

  constructor() {
    // À l'affichage et à chaque changement de société : parc et stock relus. Seuls la société et
    // « société à choisir » sont suivis — le reste est lu hors suivi, sinon chaque chargement
    // (qui écrit des signaux) relancerait l'effet.
    effect(() => {
      this.fleetFilter.selectedFleetId();
      const attente = this.needsFleet();
      untracked(() => {
        // Revue du 29/09 : changer de société referme les saisies et vide l'affichage. Un brouillon
        // de stock lu chez A s'enregistrait sinon chez B (le PUT part avec la société COURANTE), et
        // le stock de A restait modifiable sous le bandeau de B le temps que B arrive.
        this.stockEdit.set(false);
        this.stockSaveError.set(null);
        this.edit.set(null);
        this.overview.set([]);
        this.stock.set(null);
        if (attente) return;
        void this.chargerParc();
        void this.chargerStock();
      });
    });
  }

  protected energyLabel(e: InstallationEnergy): string { return ENERGY_LABELS[e]; }
  protected policyLabel(p: ChildSeatPolicy): string { return CHILD_SEAT_POLICY_LABELS[p]; }
  protected policyHelp(p: ChildSeatPolicy): string {
    return p === 'INSTALLED_ONLY'
      ? 'seuls les sièges déjà installés dans le véhicule comptent ; le stock n\'est jamais promis.'
      : 'les sièges à bord comptent d\'abord, le stock complète ce qui manque sur le créneau ; un véhicule déjà équipé est proposé en premier.';
  }
  protected plages(n: number): number[] { return Array.from({ length: Math.min(n, 60) }, (_, i) => i); }
  protected etatDe(r: VehicleCapacityRowDto) { return this.etats().get(r.vehicleId) ?? null; }

  /**
   * Société à passer à l'API : celle du bandeau, pour un super-admin SEULEMENT. Le filtre est
   * relu du stockage local quel que soit le rôle ; l'envoyer pour un autre compte ferait refuser
   * le stock (« Société hors périmètre ») sur une valeur laissée par une session précédente.
   */
  private fleetParam(): string | undefined {
    return this.isSuperAdmin() ? (this.fleetFilter.selectedFleetId() ?? undefined) : undefined;
  }

  /**
   * Contre-revue du 29/09 — un résumé de stock est-il celui de la société `f` passée à l'API ?
   * Pour un super-admin, `f` est la société du bandeau et le serveur renvoie la société résolue
   * (`ChildSeatStockDto.fleetId`) : on les compare. Pour les autres comptes, `f` est vide et le
   * serveur borne à la société du compte — rien à comparer. Filet sous les gardes « société
   * inchangée » : aucun chemin, présent ou futur, ne doit écrire le stock de A chez B.
   */
  private stockDeLaSociete(s: ChildSeatStockDto, f = this.fleetParam()): boolean {
    return !f || s.fleetId === f;
  }

  /**
   * Revue du 29/09 : une réponse qui revient APRÈS un changement de société est ignorée. Le
   * recoupement avec la liste de la page masquait ce cas ; sans lui, le parc de A s'afficherait
   * sous le bandeau de B.
   */
  private async chargerParc(): Promise<void> {
    const f = this.fleetParam();
    this.rowsLoading.set(true);
    this.rowsError.set(null);
    try {
      const rows = await firstValueFrom(this.vehiclesApi.capacityOverview(f));
      if (this.fleetParam() === f) this.overview.set(rows);
    } catch (e) {
      swallow('agenda-parc-view:parc', e);
      if (this.fleetParam() === f) this.rowsError.set(apiErrorMessage(e, 'Le parc n\'a pas pu être lu.'));
    } finally {
      if (this.fleetParam() === f) this.rowsLoading.set(false);
    }
  }

  protected async chargerStock(): Promise<void> {
    const f = this.fleetParam();
    this.stockError.set(null);
    try {
      const s = await firstValueFrom(this.agendaApi.childSeatStock(f));
      if (this.fleetParam() !== f) return;
      if (this.stockDeLaSociete(s, f)) this.stock.set(s);
      else this.stockError.set('Le stock reçu n\'est pas celui de la société choisie.');
    } catch (e) {
      swallow('agenda-parc-view:stock', e);
      if (this.fleetParam() === f) this.stockError.set(apiErrorMessage(e, 'Le stock de sièges auto n\'a pas pu être lu.'));
    }
  }

  // ─── Stock ───
  protected ouvrirStock(): void {
    const s = this.stock();
    if (!s) return;
    // Filet (contre-revue du 29/09) : un stock d'une autre société ne sert jamais de brouillon.
    if (!this.stockDeLaSociete(s)) { this.stock.set(null); void this.chargerStock(); return; }
    this.stockSaveError.set(null);
    this.stockDraft.set({ baby: s.total.baby, child: s.total.child, policy: s.policy });
    this.stockEdit.set(true);
  }
  protected annulerStock(): void {
    this.stockEdit.set(false);
    this.stockSaveError.set(null);
  }
  protected stockDraftSet(key: 'baby' | 'child', v: string): void {
    const n = Math.trunc(Number(v));
    this.stockDraft.update((d) => ({ ...d, [key]: Number.isFinite(n) ? Math.max(0, Math.min(500, n)) : 0 }));
  }
  protected stockDraftPolicy(p: string): void {
    this.stockDraft.update((d) => ({ ...d, policy: p as ChildSeatPolicy }));
  }
  protected async saveStock(): Promise<void> {
    if (this.stockSaving()) return;
    this.stockSaveError.set(null);
    const d = this.stockDraft();
    const actuel = this.stock();
    // Filet (contre-revue du 29/09) : le brouillon a été pris sur le stock affiché ; s'il n'est pas
    // celui de la société à laquelle le PUT va partir, on n'écrit rien et on relit.
    if (actuel && !this.stockDeLaSociete(actuel)) {
      this.stockEdit.set(false);
      this.stock.set(null);
      this.toast.error('Sièges auto non enregistrés', 'Le stock affiché n\'était pas celui de la société choisie : il est relu, recommencez.');
      void this.chargerStock();
      return;
    }
    if (actuel && (d.baby < actuel.installed.baby || d.child < actuel.installed.child)) {
      this.stockSaveError.set(messageSiegesInstalles(actuel.installed));
      return;
    }
    const f = this.fleetParam();
    this.stockSaving.set(true);
    try {
      const r = await firstValueFrom(this.agendaApi.setChildSeatStock({ fleetId: f, baby: d.baby, child: d.child, policy: d.policy }));
      this.sync.vehiculesModifies();
      // Société changée pendant l'appel : l'effet a déjà refermé la saisie et relit la nouvelle.
      if (this.fleetParam() !== f || !this.stockDeLaSociete(r, f)) return;
      this.stock.set(r);
      this.stockEdit.set(false);
      this.toast.success('Sièges auto enregistrés', `${r.total.baby} bébé · ${r.total.child} enfant possédés — ${r.stock.baby} / ${r.stock.child} en stock.`);
    } catch (e) {
      swallow('agenda-parc-view:saveStock', e);
      // Le formulaire reste ouvert avec la saisie : corriger ou Annuler.
      if (this.fleetParam() === f) this.stockSaveError.set(apiErrorMessage(e, 'Les sièges n\'ont pas pu être enregistrés.'));
    } finally {
      this.stockSaving.set(false);
    }
  }

  // ─── Réglage rapide ───
  protected ouvrir(r: VehicleCapacityRowDto): void {
    this.editError.set(null);
    this.edit.set({
      row: r,
      seats: r.seats === null ? '' : String(r.seats),
      energy: r.energy ?? '',
      features: r.features.join(', '),
      baby: r.childSeatsBaby,
      child: r.childSeatsChild,
    });
  }
  protected fermer(): void { this.edit.set(null); }
  protected draftSet(key: 'seats' | 'energy' | 'features' | 'baby' | 'child', v: string): void {
    this.edit.update((e) => {
      if (!e) return e;
      if (key === 'baby' || key === 'child') {
        const n = Math.trunc(Number(v));
        return { ...e, [key]: Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 0 };
      }
      return { ...e, [key]: v };
    });
  }

  /**
   * Deux écritures indépendantes, chacune seulement si elle a changé et si le droit est là :
   * la fiche (places, énergie, équipements — `vehicles_edit`), puis les sièges à bord (admin).
   * Ce qui a réussi reste écrit même si la seconde échoue, et le message le dit.
   *
   * Revue du 29/09 : la fiche est validée AVANT toute écriture (une saisie refusée n'envoie ni la
   * fiche ni les sièges — pas d'enregistrement partiel), et le message ne cite que ce qui a
   * vraiment été écrit (voir {@link ficheAEcrire}).
   *
   * Contre-revue du 29/09 : la feuille se referme pendant l'appel (croix, Échap, fond) et le
   * bandeau reste utilisable. Le résumé renvoyé par `PUT …/vehicles/:id` est celui de la société
   * du VÉHICULE (A) : écrit sans condition, il s'affichait sous le bandeau de B une fois B choisi,
   * et « Modifier › Enregistrer » écrivait alors les totaux et le réglage de A chez B. Chaque effet
   * de bord est donc rejoué contre la société et la feuille notées AVANT l'appel : la réponse d'une
   * autre société ne touche plus au stock ni à la grille (l'effet a déjà relu B), et la réponse
   * d'un véhicule ne referme plus — ni n'annote — la feuille d'un autre.
   */
  protected async enregistrer(): Promise<void> {
    const e = this.edit();
    if (!e || this.saving()) return;
    this.editError.set(null);
    const r = e.row;
    const fiche = this.canEditRow(r) ? ficheAEcrire(e) : { payload: {}, champs: [] as string[] };
    if ('erreur' in fiche) { this.editError.set(fiche.erreur); return; }
    const siegesChanges = this.canSeats() && (e.baby !== r.childSeatsBaby || e.child !== r.childSeatsChild);
    // Rien de réel à écrire (le bouton est alors éteint) : on referme sans annoncer d'enregistrement.
    if (fiche.champs.length === 0 && !siegesChanges) { this.edit.set(null); return; }
    const f = this.fleetParam();
    const memeSociete = () => this.fleetParam() === f;
    const memeFeuille = () => memeSociete() && this.edit()?.row.vehicleId === r.vehicleId;
    this.saving.set(true);
    const faits: string[] = [];
    try {
      if (fiche.champs.length > 0) {
        await firstValueFrom(this.vehiclesApi.update(r.vehicleId, fiche.payload));
        faits.push(`fiche mise à jour (${fiche.champs.join(', ')})`);
      }
      if (siegesChanges) {
        const s = await firstValueFrom(this.agendaApi.setVehicleChildSeats(r.vehicleId, { baby: e.baby, child: e.child }));
        // Jamais le stock d'une société sous le bandeau d'une autre : société inchangée, et (super-
        // admin) le résumé est bien celui de la société choisie.
        if (memeSociete() && this.stockDeLaSociete(s, f)) {
          this.stock.set(s);
          // Les sièges à bord ont bougé : un refus du formulaire de stock ne tient peut-être plus.
          this.stockSaveError.set(null);
        }
        faits.push('sièges à bord mis à jour');
      }
      this.toast.success(`${r.plate} enregistré`, faits.join(' · ') + '.');
      if (memeFeuille()) this.edit.set(null);
      this.sync.vehiculesModifies();
      // Société changée : l'effet relit déjà la grille de la nouvelle.
      if (memeSociete()) await this.chargerParc();
    } catch (err) {
      swallow('agenda-parc-view:enregistrer', err);
      // C3 : un refus de droit se dit en clair (« Vous ne pouvez que consulter ce véhicule. »).
      const msg = (faits.length ? `Enregistré : ${faits.join(', ')}. Puis : ` : '') + messageEcritureVehicule(err, 'Enregistrement impossible.');
      // Feuille refermée, autre véhicule ouvert ou société changée : l'erreur n'a plus de feuille
      // où s'afficher — elle est dite quand même, avec la plaque.
      if (memeFeuille()) this.editError.set(msg);
      else this.toast.error(`${r.plate} : ${faits.length ? 'enregistrement incomplet' : 'non enregistré'}`, msg);
      if (faits.length) {
        this.sync.vehiculesModifies();
        if (memeSociete()) {
          await this.chargerParc();
          // La feuille reste ouverte : sa ligne de référence devient celle relue, pour qu'un nouvel
          // essai n'envoie que ce qui reste à écrire (et ne réannonce pas une fiche déjà écrite).
          const relue = this.overview().find((x) => x.vehicleId === r.vehicleId);
          if (relue && memeFeuille()) this.edit.update((d) => (d && d.row.vehicleId === r.vehicleId ? { ...d, row: relue } : d));
        }
      }
    } finally {
      this.saving.set(false);
    }
  }
}

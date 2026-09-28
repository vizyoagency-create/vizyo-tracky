import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AlertTriangle, ArrowRightLeft, Check, Loader, LucideAngularModule, Shuffle, X } from 'lucide-angular';
import type { OrigineReservation, ReorganisationResultDto } from '@vizyo/tracky-shared';
import { apiErrorMessage } from '../../../core/error/api-error';
import { swallow } from '../../../core/error/swallow';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';

/** Fenêtres proposées — celles qu'on veut réellement reprendre, pas un sélecteur de dates. */
const FENETRES = [
  { cle: '7', libelle: '7 jours', jours: 7 },
  { cle: '14', libelle: '14 jours', jours: 14 },
  { cle: '30', libelle: '30 jours', jours: 30 },
] as const;

export type ActionReorganisation = 'reaffecter' | 'annuler' | 'decaler';

/** Véhicule proposé comme destination d'une réaffectation. */
export interface VehiculeReorganisation {
  id: string;
  plate: string | null;
}

/**
 * Pré-réglage de la feuille quand on l'ouvre DEPUIS un geste (ex. après avoir posé une
 * immobilisation) : le véhicule, la fenêtre, l'action. Sans, la feuille s'ouvre sur ses défauts.
 */
export interface PresetReorganisation {
  vehicleId?: string | null;
  from?: string | null;
  to?: string | null;
  action?: ActionReorganisation | null;
}

/**
 * ── RÉORGANISER (lot 3c du 23/09, refondu le 28/09 — point 4 de la commande) ─────────────────
 *
 * ┌─ POURQUOI CET ÉCRAN EXISTE ───────────────────────────────────────────────┐
 * │ Reprendre d'un coup les réservations À VENIR : un véhicule part au garage │
 * │ (→ réaffecter les siennes), une journée tombe (→ annuler), les horaires   │
 * │ glissent (→ décaler). Une par une, par la feuille d'édition, n'est pas    │
 * │ tenable — 108 réservations sur 21 véhicules chez cdef31 le 23/09.         │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * **La feuille ouvre sur une SIMULATION, toujours.** On montre combien de réservations sont
 * concernées, lesquelles, et seulement ensuite on propose d'appliquer.
 *
 * Refonte du 28/09 : la feuille s'ouvrait sur « Aucune réservation ne correspond » — sa cible par
 * défaut, « posées par l'agent », est structurellement vide depuis que l'agent ne réserve plus
 * fermement. Maintenant : les trois cas sont nommés, chaque choix porte son COMPTE, un véhicule se
 * cible, le vide s'explique, et le geste qui manquait — réaffecter — existe.
 */
@Component({
  selector: 'app-reorganisation-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, LucideAngularModule, BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Réorganiser des réservations" (closed)="closed.emit()">
      <div class="ro">
        <div class="ro-head">
          <h3 class="ro-title"><lucide-icon [img]="ShuffleIcon" [size]="15"></lucide-icon> Réorganiser des réservations</h3>
          <button type="button" class="ro-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        <div class="ro-body">
          <p class="ro-intro">
            Reprendre d'un coup les réservations <strong>à venir</strong>. Le passé n'est jamais touché,
            et rien n'est appliqué avant que vous ayez vu la liste.
          </p>
          <ul class="ro-cas">
            <li><strong>Un véhicule part au garage</strong> → ses réservations passent sur un autre : <em>Réaffecter</em>.</li>
            <li><strong>Une journée tombe</strong> (sortie annulée, fermeture) → <em>Annuler</em> le lot.</li>
            <li><strong>Les horaires glissent</strong> → <em>Décaler</em> le lot de quelques minutes ou heures.</li>
          </ul>

          <div class="ro-f">
            <span>Sur les</span>
            <div class="ro-seg">
              @for (f of fenetres; track f.cle) {
                <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="fenetre() === f.jours"
                        (click)="fenetre.set(f.jours)">{{ f.libelle }}</button>
              }
            </div>
          </div>

          <div class="ro-f">
            <span>Véhicule</span>
            <select class="ro-in" [value]="vehicleId()" (change)="vehicleId.set($any($event.target).value)" aria-label="Véhicule concerné">
              <option value="" [selected]="vehicleId() === ''">Tous les véhicules@if (resultat()?.totaux; as t) { ({{ totalOrigine() }}) }</option>
              @for (v of parVehicule(); track v.vehicleId) {
                <option [value]="v.vehicleId" [selected]="v.vehicleId === vehicleId()">{{ v.plate || '—' }} ({{ v.n }})</option>
              }
              @if (vehicleId() && !vehiculeDansListe()) {
                <option [value]="vehicleId()" selected>{{ plaqueDe(vehicleId()) }} (0)</option>
              }
            </select>
          </div>

          <div class="ro-f">
            <span>Quelles réservations</span>
            <div class="ro-seg">
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="origine() === 'toutes'"
                      (click)="origine.set('toutes')">Toutes@if (resultat()?.totaux; as t) { <span class="ro-n">{{ t.agent + t.public + t.manuelle }}</span> }</button>
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="origine() === 'auto'"
                      (click)="origine.set('auto')">Posées par l'agent@if (resultat()?.totaux; as t) { <span class="ro-n">{{ t.agent }}</span> }</button>
            </div>
            @if (resultat()?.totaux; as t) {
              <span class="ro-detail">Sur la fenêtre : {{ t.manuelle }} saisie{{ t.manuelle > 1 ? 's' : '' }} à la main · {{ t.public }} du lien public · {{ t.agent }} de l'agent.</span>
            }
            @if (origine() === 'toutes') {
              <span class="ro-avert">
                <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                Inclut les réservations saisies par des personnes : relisez la liste avant d'appliquer.
              </span>
            }
          </div>

          <div class="ro-f">
            <span>Que faire</span>
            <div class="ro-seg">
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'reaffecter'"
                      (click)="action.set('reaffecter')"><lucide-icon [img]="SwapIcon" [size]="13"></lucide-icon> Réaffecter</button>
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'annuler'"
                      (click)="action.set('annuler')">Annuler</button>
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'decaler'"
                      (click)="action.set('decaler')">Décaler</button>
            </div>
          </div>

          @if (action() === 'reaffecter') {
            <label class="ro-f">
              <span>Vers quel véhicule</span>
              <select class="ro-in" [value]="versVehicleId()" (change)="versVehicleId.set($any($event.target).value)">
                <option value="auto" [selected]="versVehicleId() === 'auto'">Auto — le premier véhicule libre et conforme à chaque réservation</option>
                @for (v of destinations(); track v.id) {
                  <option [value]="v.id" [selected]="v.id === versVehicleId()">{{ v.plate || '—' }}</option>
                }
              </select>
              <span class="ro-detail">
                @if (versVehicleId() === 'auto') {
                  Chaque réservation prend le premier véhicule libre sur son créneau qui respecte ses critères (places, sièges auto, équipements) — jamais celui d'origine. Le groupe de la réservation ne change pas.
                } @else {
                  Toutes passent sur {{ plaqueDe(versVehicleId()) }} — refusée ligne par ligne s'il est déjà pris, hors service, ou sans les sièges demandés.
                }
              </span>
            </label>
          }

          @if (action() === 'decaler') {
            <label class="ro-f">
              <span>De combien (minutes, négatif pour avancer)</span>
              <input type="number" step="15" class="ro-in" inputmode="numeric"
                     [value]="decalage()" (input)="decalage.set(+$any($event.target).value || 0)">
            </label>
          }

          @if (chargement()) {
            <div class="ro-sk"></div>
          } @else if (erreur(); as e) {
            <p class="ro-err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ e }}</p>
          } @else if (resultat(); as r) {
            @if (r.concernees === 0) {
              <div class="ro-vide">
                @if (origine() === 'auto' && r.totaux && r.totaux.agent === 0 && r.totaux.public + r.totaux.manuelle > 0) {
                  <p><strong>Aucune réservation posée par l'agent</strong> sur cette période — l'agent ne réserve plus fermement depuis le 23/09 : il propose, vous validez.</p>
                  <p>Il y a {{ r.totaux.public + r.totaux.manuelle }} réservation{{ r.totaux.public + r.totaux.manuelle > 1 ? 's' : '' }} saisie{{ r.totaux.public + r.totaux.manuelle > 1 ? 's' : '' }} à la main ou venue{{ r.totaux.public + r.totaux.manuelle > 1 ? 's' : '' }} du lien public.</p>
                  <button type="button" class="ro-lien" (click)="origine.set('toutes')">Prendre toutes les réservations</button>
                } @else if (vehicleId()) {
                  <p><strong>Rien à venir sur {{ plaqueDe(vehicleId()) }}</strong> dans les {{ fenetre() }} prochains jours : aucune réservation à reprendre.</p>
                } @else {
                  <p><strong>Aucune réservation à venir</strong> dans les {{ fenetre() }} prochains jours : rien à réorganiser. C'est le bon état.</p>
                }
              </div>
            } @else {
              <div class="ro-bilan" [class.ro-bilan--fait]="!r.simulation">
                <span class="ro-bilan-n">{{ r.simulation ? r.concernees : r.appliquees }}</span>
                <span class="ro-bilan-l">
                  @if (r.simulation) {
                    réservation{{ r.concernees > 1 ? 's' : '' }} seraient
                    {{ verbe(r.concernees) }}
                  } @else {
                    réservation{{ r.appliquees > 1 ? 's' : '' }} reprise{{ r.appliquees > 1 ? 's' : '' }}
                  }
                </span>
              </div>

              @if (r.plafonne) {
                <p class="ro-avert ro-avert--bloc">
                  <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                  Plus de 500 réservations : seules les 500 premières sont reprises. Relancez ensuite.
                </p>
              }

              @if (r.apercu.length > 0) {
                <ul class="ro-apercu">
                  @for (a of r.apercu; track a.startAt + a.plate) {
                    <li>
                      <span class="ro-plate">{{ a.plate || '—' }}</span>
                      <span class="ro-when">{{ a.startAt | date:'EEE d MMM · HH:mm' }}</span>
                      @if (a.origine === 'agent') { <span class="ro-tag">agent</span> }
                      @else if (a.origine === 'public') { <span class="ro-tag ro-tag--public">lien public</span> }
                    </li>
                  }
                  @if (r.concernees > r.apercu.length) {
                    <li class="ro-reste">… et {{ r.concernees - r.apercu.length }} autre{{ r.concernees - r.apercu.length > 1 ? 's' : '' }}</li>
                  }
                </ul>
              }

              @if (r.refusees.length > 0) {
                <div class="ro-refus">
                  <span class="ro-refus-t"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> {{ r.refusees.length }} non reprise{{ r.refusees.length > 1 ? 's' : '' }}</span>
                  @for (ref of r.refusees.slice(0, 5); track ref.startAt + ref.plate) {
                    <span class="ro-refus-l">{{ ref.plate || '—' }} · {{ ref.startAt | date:'dd/MM HH:mm' }} — {{ ref.motif }}</span>
                  }
                </div>
              }
            }
          }
        </div>

        <div class="ro-foot">
          @if (resultat(); as r) {
            @if (r.simulation && r.concernees > 0) {
              <!-- Le bouton d'application NOMME ce qu'il fait et COMBIEN : « Appliquer » seul
                   laisserait le nombre hors de la décision. -->
              <button type="button" class="ro-btn" [class.ro-btn--go]="action() === 'annuler'" [class.ro-btn--ok2]="action() !== 'annuler'" [disabled]="envoi()" (click)="appliquer()">
                @if (envoi()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="ro-spin"></lucide-icon> }
                {{ libelleAction() }} ces {{ r.concernees }} réservation{{ r.concernees > 1 ? 's' : '' }}
              </button>
            } @else if (!r.simulation) {
              <button type="button" class="ro-btn ro-btn--ok" (click)="closed.emit()">
                <lucide-icon [img]="CheckIcon" [size]="15"></lucide-icon> Terminé
              </button>
            }
          }
        </div>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .ro { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .ro-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .ro-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .ro-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .ro-body { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 62vh; max-height: 62dvh; padding: 12px 2px 2px; }
    .ro-intro { font-size: 13px; color: var(--fg-secondary); line-height: 1.5; margin: 0; }
    .ro-intro strong { color: var(--fg-primary); }
    .ro-cas { margin: 0; padding: 9px 11px; border-radius: 10px; background: var(--bg-tertiary); list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-secondary); line-height: 1.45; }
    .ro-cas strong { color: var(--fg-primary); }
    .ro-cas em { font-style: normal; font-weight: 700; color: var(--texte-succes); }
    .ro-f { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--fg-tertiary); }
    .ro-f > span:first-child { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .ro-seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ro-seg-btn { flex: 1; min-height: 40px; padding: 8px 6px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); cursor: pointer; background: transparent; border: 0;
                  display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
    .ro-seg-btn--on { background: var(--bg-primary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .ro-n { font-size: 10.5px; font-weight: 800; padding: 0 6px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .ro-seg-btn--on .ro-n { background: color-mix(in srgb, var(--tracky-light) 16%, transparent); color: var(--texte-succes); }
    .ro-in { width: 100%; padding: 10px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 15px; text-transform: none; letter-spacing: 0; }
    .ro-detail { font-size: 11.5px; color: var(--fg-tertiary); text-transform: none; letter-spacing: 0; font-weight: 400; line-height: 1.4; }
    .ro-avert { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--texte-attente); text-transform: none; letter-spacing: 0; font-weight: 400; }
    .ro-avert--bloc { padding: 8px 10px; border-radius: 9px; background: color-mix(in srgb, var(--warning) 12%, transparent); }
    .ro-bilan { display: flex; align-items: baseline; gap: 9px; padding: 13px 14px; border-radius: 12px;
                background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ro-bilan--fait { border-color: color-mix(in srgb, var(--tracky-light) 45%, transparent); background: color-mix(in srgb, var(--tracky-light) 8%, transparent); }
    .ro-bilan-n { font-family: var(--font-display); font-size: 26px; font-weight: 800; line-height: 1; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .ro-bilan-l { font-size: 12.5px; color: var(--fg-secondary); line-height: 1.4; }
    .ro-apercu { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .ro-apercu li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--fg-secondary); }
    .ro-plate { font-weight: 700; color: var(--fg-primary); font-family: var(--font-mono, monospace); }
    .ro-when { color: var(--fg-tertiary); text-transform: capitalize; }
    .ro-tag { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; color: var(--texte-violet); border: 1px dashed color-mix(in srgb, var(--violet) 45%, transparent); }
    .ro-tag--public { color: var(--fg-secondary); border-style: solid; border-color: var(--border-strong); }
    .ro-reste { color: var(--fg-tertiary); font-style: italic; }
    .ro-refus { display: flex; flex-direction: column; gap: 3px; padding: 10px 11px; border-radius: 10px;
                background: color-mix(in srgb, var(--danger) 9%, transparent); }
    .ro-refus-t { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--texte-alerte); }
    .ro-refus-l { font-size: 11px; color: var(--fg-secondary); }
    /* Le vide s'explique : ce qu'il y a, ce qu'il n'y a pas, et le geste pour sortir de là. */
    .ro-vide { display: flex; flex-direction: column; gap: 6px; padding: 12px 13px; border-radius: 12px; background: var(--bg-tertiary); font-size: 12.5px; color: var(--fg-secondary); line-height: 1.45; }
    .ro-vide p { margin: 0; }
    .ro-vide strong { color: var(--fg-primary); }
    .ro-lien { align-self: flex-start; font-size: 12.5px; font-weight: 700; color: var(--texte-succes); text-decoration: underline; padding: 2px 0; }
    .ro-err { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--texte-alerte); }
    .ro-sk { height: 74px; border-radius: 12px; background: var(--bg-tertiary); }
    .ro-foot { display: flex; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border-subtle); }
    .ro-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
              min-height: 44px; padding: 11px 16px; border-radius: 11px; font-size: 13.5px; font-weight: 700; cursor: pointer; border: 1px solid transparent; }
    .ro-btn--go { background: var(--danger); color: #fff; }
    .ro-btn--ok2 { background: var(--tracky); color: var(--accent-ink); }
    .ro-btn--ok { background: var(--bg-tertiary); color: var(--fg-primary); border-color: var(--border-subtle); }
    .ro-btn:disabled { opacity: .55; }
    .ro-spin { animation: ro-spin 1s linear infinite; }
    @keyframes ro-spin { to { transform: rotate(360deg); } }
    :host-context([data-theme='dark']) .ro-in { border-color: rgba(255,255,255,.15); }
  `],
})
export class ReorganisationSheetComponent {
  readonly open = input(false);
  /** Véhicules du périmètre : destinations possibles d'une réaffectation, et plaques à afficher. */
  readonly vehicles = input<VehiculeReorganisation[]>([]);
  /** Pré-réglage à l'ouverture (véhicule, fenêtre, action) — depuis un autre geste de la page. */
  readonly preset = input<PresetReorganisation | null>(null);
  readonly closed = output<void>();
  /** Émis après une application réelle — l'agenda recharge ses couches. */
  readonly applique = output<void>();

  private readonly http = inject(HttpClient);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ShuffleIcon = Shuffle;
  protected readonly SwapIcon = ArrowRightLeft;
  protected readonly XIcon = X;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly CheckIcon = Check;
  protected readonly LoaderIcon = Loader;

  protected readonly fenetres = FENETRES;
  protected readonly fenetre = signal<number>(30);
  protected readonly vehicleId = signal('');
  /**
   * « Toutes » par défaut (refonte du 28/09) : « posées par l'agent » est vide depuis que l'agent ne
   * réserve plus fermement — un défaut qui ouvre sur du vide n'aide personne. La liste s'affiche
   * TOUJOURS avant d'appliquer, et l'avertissement sur les saisies humaines reste.
   */
  protected readonly origine = signal<OrigineReservation>('toutes');
  protected readonly action = signal<ActionReorganisation>('reaffecter');
  protected readonly versVehicleId = signal('auto');
  protected readonly decalage = signal(60);
  /** Fenêtre imposée par un pré-réglage (sinon « maintenant + N jours »). */
  private readonly fenetreFixe = signal<{ from: string; to: string } | null>(null);

  protected readonly chargement = signal(false);
  protected readonly envoi = signal(false);
  protected readonly erreur = signal<string | null>(null);
  protected readonly resultat = signal<ReorganisationResultDto | null>(null);

  protected readonly parVehicule = computed(() => this.resultat()?.parVehicule ?? []);
  protected readonly vehiculeDansListe = computed(() => this.parVehicule().some((v) => v.vehicleId === this.vehicleId()));
  protected readonly totalOrigine = computed(() => this.parVehicule().reduce((n, v) => n + v.n, 0));
  protected readonly destinations = computed(() => this.vehicles().filter((v) => v.id !== this.vehicleId()));
  protected readonly libelleAction = computed(() =>
    this.action() === 'annuler' ? 'Annuler' : this.action() === 'decaler' ? 'Décaler' : 'Réaffecter',
  );

  /** Corps de requête commun à la simulation et à l'application. */
  private readonly corps = computed(() => {
    const fixe = this.fenetreFixe();
    return {
      from: fixe?.from ?? new Date().toISOString(),
      to: fixe?.to ?? new Date(Date.now() + this.fenetre() * 86_400_000).toISOString(),
      origine: this.origine(),
      action: this.action(),
      decalageMinutes: this.action() === 'decaler' ? this.decalage() : undefined,
      versVehicleId: this.action() === 'reaffecter' ? this.versVehicleId() : undefined,
      vehicleId: this.vehicleId() || undefined,
      fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
    };
  });

  private etaitOuverte = false;

  constructor() {
    /**
     * À l'OUVERTURE : les pré-réglages s'appliquent (véhicule, fenêtre, action) ; puis toute
     * modification d'un critère REFAIT la simulation — le nombre affiché et le bouton restent
     * d'accord entre eux (on ne peut pas appliquer à 40 un geste évalué sur 12).
     */
    effect(() => {
      const ouverte = this.open();
      if (!ouverte) { this.etaitOuverte = false; return; }
      if (!this.etaitOuverte) {
        this.etaitOuverte = true;
        untracked(() => this.appliquerPreset());
      }
      this.fenetre(); this.origine(); this.action(); this.decalage(); this.vehicleId(); this.versVehicleId(); this.fenetreFixe();
      void this.simuler();
    });
  }

  private appliquerPreset(): void {
    const p = this.preset();
    this.resultat.set(null);
    this.erreur.set(null);
    this.vehicleId.set(p?.vehicleId ?? '');
    this.action.set(p?.action ?? (p?.vehicleId ? 'reaffecter' : 'annuler'));
    this.versVehicleId.set('auto');
    this.origine.set('toutes');
    this.fenetreFixe.set(p?.from && p?.to ? { from: p.from, to: p.to } : null);
    if (p?.from && p?.to) {
      const jours = Math.max(1, Math.round((new Date(p.to).getTime() - Date.now()) / 86_400_000));
      this.fenetre.set(jours <= 7 ? 7 : jours <= 14 ? 14 : 30);
    }
  }

  protected plaqueDe(id: string): string {
    return this.vehicles().find((v) => v.id === id)?.plate ?? this.parVehicule().find((v) => v.vehicleId === id)?.plate ?? '—';
  }

  protected verbe(n: number): string {
    const s = n > 1 ? 's' : '';
    if (this.action() === 'annuler') return `annulée${s}`;
    if (this.action() === 'decaler') return `décalée${s}`;
    return `réaffectée${s}`;
  }

  private async simuler(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set(null);
    this.http
      .post<ReorganisationResultDto>('/api/reservations/reorganiser', { ...this.corps(), simulation: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.resultat.set(r); this.chargement.set(false); },
        error: (err) => {
          swallow('reorganisation:simuler', err);
          this.resultat.set(null);
          this.erreur.set(apiErrorMessage(err, 'Simulation impossible.'));
          this.chargement.set(false);
        },
      });
  }

  protected appliquer(): void {
    if (this.envoi()) return;
    this.envoi.set(true);
    this.http
      .post<ReorganisationResultDto>('/api/reservations/reorganiser', { ...this.corps(), simulation: false })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.resultat.set(r);
          this.envoi.set(false);
          this.applique.emit();
          this.toast.success(
            `${r.appliquees} réservation(s) reprise(s)`,
            r.refusees.length > 0 ? `${r.refusees.length} non reprise(s) — voir le détail.` : '',
          );
        },
        error: (err) => {
          swallow('reorganisation:appliquer', err);
          this.envoi.set(false);
          this.toast.error('Échec', apiErrorMessage(err, 'La réorganisation n’a pas abouti.'));
        },
      });
  }
}

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
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AlertTriangle, Check, Loader, LucideAngularModule, Shuffle, X } from 'lucide-angular';
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

/**
 * ── LOT 3C (2026-09-23) — REPRENDRE UN LOT DE RÉSERVATIONS ──────────────────────────────────
 *
 * ┌─ POURQUOI CET ÉCRAN EXISTE ───────────────────────────────────────────────┐
 * │ L'agent avait posé 108 réservations à venir sur 21 véhicules de cdef31.   │
 * │ Les reprendre une par une, par la feuille d'édition, n'est pas tenable —  │
 * │ et sur un téléphone, encore moins. La réorganisation n'avait aucun geste  │
 * │ de masse.                                                                  │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * **La feuille ouvre sur une SIMULATION, toujours.** On montre combien de réservations sont
 * concernées, lesquelles, et seulement ensuite on propose d'appliquer. Un geste de masse qu'on
 * ne peut pas prévisualiser ne se propose pas — c'est la discipline du DRY-RUN de la rétention.
 *
 * Par défaut, la cible est `auto` : les réservations posées par l'agent. Reprendre par erreur les
 * réservations SAISIES PAR DES HUMAINS serait bien plus grave que de rater une automatique.
 */
@Component({
  selector: 'app-reorganisation-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, LucideAngularModule, BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Réorganiser les réservations" (closed)="closed.emit()">
      <div class="ro">
        <div class="ro-head">
          <h3 class="ro-title"><lucide-icon [img]="ShuffleIcon" [size]="15"></lucide-icon> Réorganiser</h3>
          <button type="button" class="ro-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        <div class="ro-body">
          <p class="ro-intro">
            Reprendre d'un coup les réservations <strong>à venir</strong>.
            Le passé n'est jamais touché.
          </p>

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
            <span>Quelles réservations</span>
            <div class="ro-seg">
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="origine() === 'auto'"
                      (click)="origine.set('auto')">Posées par l'agent</button>
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="origine() === 'toutes'"
                      (click)="origine.set('toutes')">Toutes</button>
            </div>
            @if (origine() === 'toutes') {
              <span class="ro-avert">
                <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                Inclut les réservations saisies par des personnes.
              </span>
            }
          </div>

          <div class="ro-f">
            <span>Que faire</span>
            <div class="ro-seg">
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'annuler'"
                      (click)="action.set('annuler')">Tout annuler</button>
              <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'decaler'"
                      (click)="action.set('decaler')">Tout décaler</button>
            </div>
          </div>

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
              <p class="ro-vide">Aucune réservation ne correspond sur cette période.</p>
            } @else {
              <div class="ro-bilan" [class.ro-bilan--fait]="!r.simulation">
                <span class="ro-bilan-n">{{ r.simulation ? r.concernees : r.appliquees }}</span>
                <span class="ro-bilan-l">
                  @if (r.simulation) {
                    réservation{{ r.concernees > 1 ? 's' : '' }} seraient
                    {{ action() === 'annuler' ? 'annulée' + (r.concernees > 1 ? 's' : '') : 'décalée' + (r.concernees > 1 ? 's' : '') }}
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
                      @if (a.source === 'SYSTEM') { <span class="ro-tag">agent</span> }
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
              <button type="button" class="ro-btn ro-btn--go" [disabled]="envoi()" (click)="appliquer()">
                @if (envoi()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="ro-spin"></lucide-icon> }
                {{ action() === 'annuler' ? 'Annuler' : 'Décaler' }} ces {{ r.concernees }} réservation{{ r.concernees > 1 ? 's' : '' }}
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
    .ro-body { display: flex; flex-direction: column; gap: 13px; overflow-y: auto; max-height: 60vh; max-height: 60dvh; padding: 12px 2px 2px; }
    .ro-intro { font-size: 13px; color: var(--fg-secondary); line-height: 1.5; }
    .ro-intro strong { color: var(--fg-primary); }
    .ro-f { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--fg-tertiary); }
    .ro-f > span:first-child { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .ro-seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ro-seg-btn { flex: 1; min-height: 40px; padding: 8px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); cursor: pointer; background: transparent; border: 0; }
    .ro-seg-btn--on { background: var(--bg-primary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .ro-in { width: 100%; padding: 10px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 16px; }
    .ro-avert { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--texte-attente); text-transform: none; letter-spacing: 0; font-weight: 400; }
    .ro-avert--bloc { padding: 8px 10px; border-radius: 9px; background: color-mix(in srgb, var(--warning) 12%, transparent); }
    .ro-bilan { display: flex; align-items: baseline; gap: 9px; padding: 13px 14px; border-radius: 12px;
                background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ro-bilan--fait { border-color: color-mix(in srgb, var(--tracky-light) 45%, transparent); background: color-mix(in srgb, var(--tracky-light) 8%, transparent); }
    .ro-bilan-n { font-family: var(--font-display); font-size: 26px; font-weight: 800; line-height: 1; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .ro-bilan-l { font-size: 12.5px; color: var(--fg-secondary); line-height: 1.4; }
    .ro-apercu { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .ro-apercu li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--fg-secondary); }
    .ro-plate { font-weight: 700; color: var(--fg-primary); }
    .ro-when { color: var(--fg-tertiary); text-transform: capitalize; }
    .ro-tag { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; color: var(--texte-violet); border: 1px dashed color-mix(in srgb, var(--violet) 45%, transparent); }
    .ro-reste { color: var(--fg-tertiary); font-style: italic; }
    .ro-refus { display: flex; flex-direction: column; gap: 3px; padding: 10px 11px; border-radius: 10px;
                background: color-mix(in srgb, var(--danger) 9%, transparent); }
    .ro-refus-t { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--texte-alerte); }
    .ro-refus-l { font-size: 11px; color: var(--fg-secondary); }
    .ro-vide { font-size: 13px; color: var(--fg-tertiary); padding: 14px 0; text-align: center; }
    .ro-err { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--texte-alerte); }
    .ro-sk { height: 74px; border-radius: 12px; background: var(--bg-tertiary); }
    .ro-foot { display: flex; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border-subtle); }
    .ro-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
              min-height: 44px; padding: 11px 16px; border-radius: 11px; font-size: 13.5px; font-weight: 700; cursor: pointer; border: 1px solid transparent; }
    .ro-btn--go { background: var(--danger); color: #fff; }
    .ro-btn--ok { background: var(--bg-tertiary); color: var(--fg-primary); border-color: var(--border-subtle); }
    .ro-btn:disabled { opacity: .55; }
    .ro-spin { animation: ro-spin 1s linear infinite; }
    @keyframes ro-spin { to { transform: rotate(360deg); } }
  `],
})
export class ReorganisationSheetComponent {
  readonly open = input(false);
  readonly closed = output<void>();
  /** Émis après une application réelle — l'agenda recharge ses couches. */
  readonly applique = output<void>();

  private readonly http = inject(HttpClient);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ShuffleIcon = Shuffle;
  protected readonly XIcon = X;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly CheckIcon = Check;
  protected readonly LoaderIcon = Loader;

  protected readonly fenetres = FENETRES;
  protected readonly fenetre = signal<number>(30);
  protected readonly origine = signal<OrigineReservation>('auto');
  protected readonly action = signal<'annuler' | 'decaler'>('annuler');
  protected readonly decalage = signal(60);

  protected readonly chargement = signal(false);
  protected readonly envoi = signal(false);
  protected readonly erreur = signal<string | null>(null);
  protected readonly resultat = signal<ReorganisationResultDto | null>(null);

  /** Corps de requête commun à la simulation et à l'application. */
  private readonly corps = computed(() => ({
    from: new Date().toISOString(),
    to: new Date(Date.now() + this.fenetre() * 86_400_000).toISOString(),
    origine: this.origine(),
    action: this.action(),
    decalageMinutes: this.action() === 'decaler' ? this.decalage() : undefined,
    fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
  }));

  constructor() {
    /**
     * Toute modification d'un critère REFAIT la simulation.
     *
     * C'est ce qui garde le nombre affiché et le bouton d'application d'accord entre eux : sans
     * ça, on pourrait changer « toutes » puis cliquer sur un bouton portant le compte de
     * « posées par l'agent » — et appliquer à 40 réservations un geste évalué sur 12.
     */
    effect(() => {
      if (!this.open()) return;
      this.fenetre(); this.origine(); this.action(); this.decalage();
      void this.simuler();
    });
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

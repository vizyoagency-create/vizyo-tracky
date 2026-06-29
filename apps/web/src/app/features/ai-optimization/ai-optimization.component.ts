import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { LucideAngularModule, Sparkles, Truck, CalendarCheck, AlertTriangle, Info, Users, Gauge } from 'lucide-angular';
import {
  FLEET_METIER_LABELS,
  type AiCapacityProposalDto,
  type AiCapacityResultDto,
  type AiPlacementResultDto,
  type FleetMetier,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AiApiService } from '../../core/services/ai.service';
import { AuthService } from '../../core/services/auth.service';
import { FleetCacheService } from '../../core/services/fleet-cache.service';
import { PermissionsService } from '../../core/services/permissions.service';

const METIERS: FleetMetier[] = ['CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC'];

function toLocalInput(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

@Component({
  selector: 'app-ai-optimization',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgClass, LucideAngularModule],
  template: `
    <div class="flex flex-col gap-5">
      <header class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <h1 class="text-2xl font-display font-bold text-fg-primary flex items-center gap-2">
            <lucide-icon [img]="SparklesIcon" [size]="22" class="text-tracky-light"></lucide-icon>
            Optimisation IA
          </h1>
          <p class="text-sm text-fg-tertiary mt-0.5">
            L'IA <strong>propose</strong>, vous <strong>validez</strong> : complétez la capacité du parc et
            placez au mieux selon le métier de la flotte. Rien n'est écrit sans votre accord.
          </p>
        </div>
        @if (isSuperAdmin() && fleetOptions().length > 0) {
          <label class="aio-fleet">
            <span>Flotte</span>
            <select class="aio-input" [value]="selectedFleetId() ?? ''" (change)="onFleetChange($any($event.target).value)">
              <option value="" disabled>Choisir…</option>
              @for (f of fleetOptions(); track f.id) { <option [value]="f.id">{{ f.name }}</option> }
            </select>
          </label>
        }
      </header>

      <!-- Métier de la flotte -->
      <section class="aio-card aio-metier">
        <div class="aio-metier-info">
          <span class="aio-metier-lbl">Métier de la flotte</span>
          @if (metierLoading()) {
            <span class="aio-metier-cur">…</span>
          } @else if (metier()) {
            <span class="aio-metier-cur">{{ metierLabel(metier()!) }}</span>
          } @else {
            <span class="aio-metier-cur aio-muted">{{ metierError() || (needsFleet() ? 'Sélectionnez une flotte' : 'Non déterminé') }}</span>
          }
        </div>
        @if (canEditMetier() && metier()) {
          <select class="aio-input" [value]="metier()!" (change)="onMetierChange($any($event.target).value)">
            @for (m of metiers; track m) { <option [value]="m">{{ metierLabel(m) }}</option> }
          </select>
        }
        <p class="aio-metier-hint">
          <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
          Le métier conditionne l'objectif de l'IA (enfants → places/sièges-enfant, colis → charge, location → disponibilité).
        </p>
      </section>

      <!-- Onglets -->
      <div class="aio-tabs" role="tablist">
        <button type="button" role="tab" class="aio-tab" [class.aio-tab--on]="tab() === 'capacity'" (click)="tab.set('capacity')">
          <lucide-icon [img]="TruckIcon" [size]="15"></lucide-icon> Capacité du parc
        </button>
        <button type="button" role="tab" class="aio-tab" [class.aio-tab--on]="tab() === 'placement'" (click)="tab.set('placement')">
          <lucide-icon [img]="CalendarCheckIcon" [size]="15"></lucide-icon> Placement
        </button>
      </div>

      <!-- ───────────────── CAPACITÉ ───────────────── -->
      @if (tab() === 'capacity') {
        <section class="aio-card">
          <div class="aio-card-head">
            <h2 class="aio-card-title"><lucide-icon [img]="TruckIcon" [size]="16" class="text-tracky-light"></lucide-icon> Compléter la capacité avec l'IA</h2>
            <button type="button" class="aio-btn aio-btn--primary" [disabled]="capLoading() || needsFleet()" (click)="runCapacity()">
              {{ capLoading() ? 'Analyse en cours…' : 'Analyser le parc' }}
            </button>
          </div>
          <p class="aio-sub">
            L'IA déduit le nombre de places et de places-enfant par modèle (ex. Jumpy/Expert : 9 ou 2 places), avec un niveau de
            confiance. <strong>Vérifiez</strong> puis appliquez : un Jumpy peut être un fourgon comme une navette.
          </p>
          @if (needsFleet()) {
            <div class="aio-alert aio-alert--warn"><lucide-icon [img]="InfoIcon" [size]="14"></lucide-icon> Sélectionnez d'abord une flotte (en haut à droite) pour analyser son parc.</div>
          }

          @if (capError()) {
            <div class="aio-alert aio-alert--err"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ capError() }}</div>
          }

          @if (capLoading()) {
            <div class="aio-skel"></div><div class="aio-skel"></div>
          } @else if (capResult(); as r) {
            @if (r.proposals.length === 0) {
              <div class="aio-empty">Aucune proposition (parc vide ou hors périmètre).</div>
            } @else {
              <div class="aio-table-scroll">
                <table class="aio-table">
                  <thead>
                    <tr>
                      @if (canApply()) { <th class="aio-th-check"><input type="checkbox" [checked]="allSelected()" (change)="toggleAll()" aria-label="Tout sélectionner"></th> }
                      <th>Véhicule</th><th>Places</th><th>Sièges-enfant</th><th>Confiance</th><th>Justification</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of r.proposals; track p.vehicleId) {
                      <tr [class.aio-row--on]="selected().has(p.vehicleId)">
                        @if (canApply()) { <td><input type="checkbox" [checked]="selected().has(p.vehicleId)" (change)="toggleSel(p.vehicleId)" [attr.aria-label]="'Sélectionner ' + (p.plate || p.model)"></td> }
                        <td><span class="aio-plate">{{ p.plate || '—' }}</span><span class="aio-model">{{ p.model || '' }}</span></td>
                        <td>{{ p.seats ?? '—' }}</td>
                        <td>{{ p.childSeats ?? '—' }}</td>
                        <td><span class="aio-conf" [ngClass]="confClass(p.confidence)">{{ p.confidence * 100 | number:'1.0-0' }}%</span></td>
                        <td class="aio-reason">{{ p.reasoning }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (canApply()) {
                <div class="aio-apply">
                  @if (applyMsg()) { <span class="aio-apply-ok">{{ applyMsg() }}</span> }
                  <button type="button" class="aio-btn aio-btn--primary" [disabled]="applying() || selected().size === 0" (click)="applySelected()">
                    {{ applying() ? 'Application…' : 'Appliquer la sélection (' + selected().size + ')' }}
                  </button>
                </div>
              } @else {
                <div class="aio-apply"><span class="aio-muted">Consultation seule — l'application nécessite le droit « Modifier un véhicule ».</span></div>
              }
            }
          }
        </section>
      }

      <!-- ───────────────── PLACEMENT ───────────────── -->
      @if (tab() === 'placement') {
        <section class="aio-card">
          <h2 class="aio-card-title"><lucide-icon [img]="CalendarCheckIcon" [size]="16" class="text-tracky-light"></lucide-icon> Meilleur placement (mutualisation)</h2>
          <p class="aio-sub">
            L'IA classe les véhicules <strong>disponibles</strong> sur le créneau : adéquation au besoin, bon dimensionnement,
            mutualisation des sous-utilisés. Elle ne réserve rien — vous validez ensuite dans Réservations.
          </p>
          <div class="aio-form">
            <label class="aio-field"><span>Début</span><input type="datetime-local" class="aio-input" [value]="startAt()" (input)="startAt.set($any($event.target).value)"></label>
            <label class="aio-field"><span>Fin</span><input type="datetime-local" class="aio-input" [value]="endAt()" (input)="endAt.set($any($event.target).value)"></label>
            <label class="aio-field aio-field--sm"><span>Places min.</span><input type="number" min="0" class="aio-input" [value]="minSeats()" (input)="minSeats.set($any($event.target).value)"></label>
            <label class="aio-field aio-field--sm"><span>Sièges-enfant min.</span><input type="number" min="0" class="aio-input" [value]="minChildSeats()" (input)="minChildSeats.set($any($event.target).value)"></label>
            <button type="button" class="aio-btn aio-btn--primary aio-form-go" [disabled]="plLoading()" (click)="runPlacement()">
              {{ plLoading() ? 'Analyse…' : 'Suggérer avec l\\'IA' }}
            </button>
          </div>

          @if (plError()) {
            <div class="aio-alert aio-alert--err"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ plError() }}</div>
          }

          @if (plLoading()) {
            <div class="aio-skel"></div><div class="aio-skel"></div>
          } @else if (plResult(); as r) {
            @if (r.noGoodMatch) {
              <div class="aio-alert aio-alert--warn"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ r.notes || 'Aucun véhicule ne couvre correctement le besoin sur ce créneau.' }}</div>
            }
            @if (r.proposals.length > 0) {
              <div class="aio-pl-grid">
                @for (p of r.proposals; track p.vehicleId; let i = $index) {
                  <div class="aio-pl" [class.aio-pl--top]="i === 0">
                    <div class="aio-pl-top">
                      <span class="aio-rank">#{{ i + 1 }}</span>
                      <span class="aio-plate">{{ p.plate || '—' }}</span>
                      <span class="aio-score" [ngClass]="confClass(p.score)">{{ p.score * 100 | number:'1.0-0' }}%</span>
                    </div>
                    <div class="aio-pl-meta"><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> {{ p.seats ?? '—' }} places · {{ p.childSeats ?? '—' }} sièges-enfant</div>
                    <p class="aio-pl-reason">{{ p.reasoning }}</p>
                  </div>
                }
              </div>
            } @else if (!r.noGoodMatch) {
              <div class="aio-empty">Aucune proposition.</div>
            }
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .aio-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 16px; }
    .aio-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
    .aio-card-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); display: flex; align-items: center; gap: 7px; font-family: var(--font-display, inherit); }
    .aio-sub { font-size: 12.5px; color: var(--fg-tertiary); margin: 6px 0 12px; line-height: 1.5; }
    .aio-muted { color: var(--fg-muted); }

    .aio-input { padding: 7px 10px; border-radius: 9px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 13px; }
    .aio-input:focus { outline: none; border-color: var(--tracky-light); }

    .aio-fleet { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-tertiary); }

    /* Métier */
    .aio-metier { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .aio-metier-info { display: flex; flex-direction: column; }
    .aio-metier-lbl { font-size: 11.5px; color: var(--fg-tertiary); }
    .aio-metier-cur { font-size: 16px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aio-metier-hint { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-muted); flex-basis: 100%; }

    /* Onglets */
    .aio-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aio-tab { display: flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 7px; font-size: 13px; font-weight: 600; color: var(--fg-tertiary); transition: all .15s; }
    .aio-tab--on { background: var(--bg-primary); color: var(--fg-primary); box-shadow: 0 1px 3px rgba(0,0,0,.18); }

    /* Boutons */
    .aio-btn { padding: 8px 15px; border-radius: 10px; font-size: 13px; font-weight: 700; transition: all .15s; }
    .aio-btn--primary { background: var(--tracky, #10B981); color: #fff; }
    .aio-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
    .aio-btn:disabled { opacity: .55; cursor: not-allowed; }

    /* Table capacité */
    .aio-table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 6px; }
    .aio-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px; }
    .aio-table th { text-align: left; font-size: 11px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .04em; padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); }
    .aio-th-check { width: 36px; }
    .aio-table td { padding: 10px; border-bottom: 1px solid var(--border-subtle); color: var(--fg-secondary); vertical-align: top; }
    .aio-row--on { background: rgba(16,224,160,.06); }
    .aio-plate { font-weight: 800; color: var(--fg-primary); letter-spacing: .3px; display: block; }
    .aio-model { font-size: 11.5px; color: var(--fg-tertiary); }
    .aio-reason { font-size: 12px; color: var(--fg-tertiary); max-width: 340px; }
    .aio-conf, .aio-score { font-size: 12px; font-weight: 800; padding: 2px 8px; border-radius: 999px; }
    .aio-conf--hi, .aio-score--hi { color: #10B981; background: rgba(16,185,129,.13); }
    .aio-conf--mid, .aio-score--mid { color: #F59E0B; background: rgba(245,158,11,.14); }
    .aio-conf--lo, .aio-score--lo { color: #EF4444; background: rgba(239,68,68,.13); }

    .aio-apply { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 13px; }
    .aio-apply-ok { font-size: 12.5px; font-weight: 600; color: #10B981; }

    /* Form placement */
    .aio-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 6px; }
    .aio-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--fg-tertiary); }
    .aio-field--sm { width: 120px; }
    .aio-form-go { align-self: flex-end; }

    /* Cartes placement */
    .aio-pl-grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 12px; }
    @media (min-width: 640px) { .aio-pl-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1024px) { .aio-pl-grid { grid-template-columns: repeat(3, 1fr); } }
    .aio-pl { padding: 12px 13px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aio-pl--top { border-color: rgba(16,224,160,.4); box-shadow: 0 0 0 1px rgba(16,224,160,.25) inset; }
    .aio-pl-top { display: flex; align-items: center; gap: 8px; }
    .aio-rank { font-size: 12px; font-weight: 800; color: var(--fg-tertiary); }
    .aio-pl-top .aio-plate { display: inline; flex: 1; }
    .aio-pl-top .aio-score { margin-left: auto; }
    .aio-pl-meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-tertiary); margin-top: 6px; }
    .aio-pl-reason { font-size: 12.5px; color: var(--fg-secondary); margin-top: 7px; line-height: 1.45; }

    /* États */
    .aio-alert { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; margin-top: 10px; }
    .aio-alert--err { background: rgba(239,68,68,.1); color: #EF4444; }
    .aio-alert--warn { background: rgba(245,158,11,.12); color: #B45309; }
    .aio-empty { padding: 22px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }
    .aio-skel { height: 54px; border-radius: 12px; margin-top: 8px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: aio-sh 1.3s infinite; }
    @keyframes aio-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  `],
})
export class AiOptimizationComponent implements OnInit {
  private readonly api = inject(AiApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetCache = inject(FleetCacheService);
  private readonly perms = inject(PermissionsService);

  protected readonly SparklesIcon = Sparkles;
  protected readonly TruckIcon = Truck;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly InfoIcon = Info;
  protected readonly UsersIcon = Users;
  protected readonly GaugeIcon = Gauge;
  protected readonly metiers = METIERS;

  protected readonly tab = signal<'capacity' | 'placement'>('capacity');

  // Flotte / métier
  protected readonly selectedFleetId = signal<string | null>(null);
  protected readonly metier = signal<FleetMetier | null>(null);
  protected readonly metierLoading = signal(false);
  protected readonly metierError = signal<string | null>(null);
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly canEditMetier = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  protected readonly fleetOptions = computed(() =>
    [...this.fleetCache.fleets().entries()].map(([id, name]) => ({ id, name })),
  );
  /** Appliquer une capacité = écriture véhicule → requiert vehicles_edit (≠ ai_optimize). */
  protected readonly canApply = computed(() => this.perms.can('vehicles_edit'));
  /** Super-admin sans flotte sélectionnée : capacité/métier ont besoin d'une flotte. */
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.selectedFleetId());

  // Capacité
  protected readonly capLoading = signal(false);
  protected readonly capError = signal<string | null>(null);
  protected readonly capResult = signal<AiCapacityResultDto | null>(null);
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly applying = signal(false);
  protected readonly applyMsg = signal<string | null>(null);
  protected readonly allSelected = computed(() => {
    const r = this.capResult();
    return !!r && r.proposals.length > 0 && r.proposals.every((p) => this.selected().has(p.vehicleId));
  });

  // Placement
  protected readonly startAt = signal('');
  protected readonly endAt = signal('');
  protected readonly minSeats = signal('');
  protected readonly minChildSeats = signal('');
  protected readonly plLoading = signal(false);
  protected readonly plError = signal<string | null>(null);
  protected readonly plResult = signal<AiPlacementResultDto | null>(null);

  ngOnInit(): void {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    this.startAt.set(toLocalInput(now));
    this.endAt.set(toLocalInput(new Date(now.getTime() + 60 * 60 * 1000)));
    void this.fleetCache.loadIfNeeded();
    if (!this.isSuperAdmin()) void this.loadMetier();
  }

  protected metierLabel(m: FleetMetier): string {
    return FLEET_METIER_LABELS[m];
  }

  protected onFleetChange(id: string): void {
    this.selectedFleetId.set(id || null);
    this.capResult.set(null);
    this.selected.set(new Set());
    void this.loadMetier();
  }

  private async loadMetier(): Promise<void> {
    this.metierLoading.set(true);
    this.metierError.set(null);
    this.metier.set(null);
    try {
      const fid = this.selectedFleetId() ?? undefined;
      const res = await firstValueFrom(this.api.getFleetMetier(fid));
      this.metier.set(res.metier);
    } catch (e) {
      this.metierError.set(this.isSuperAdmin() ? 'Sélectionnez une flotte' : this.errMsg(e));
    } finally {
      this.metierLoading.set(false);
    }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    this.metier.set(metier);
    try {
      await firstValueFrom(this.api.setFleetMetier({ fleetId: this.selectedFleetId() ?? undefined, metier }));
    } catch (e) {
      this.metier.set(prev); // rollback
      this.metierError.set(this.errMsg(e));
    }
  }

  // ─── Capacité ───
  protected async runCapacity(): Promise<void> {
    this.capLoading.set(true);
    this.capError.set(null);
    this.applyMsg.set(null);
    this.selected.set(new Set());
    try {
      const fleetId = this.selectedFleetId() ?? undefined;
      const res = await firstValueFrom(this.api.capacitySuggest({ fleetId }));
      this.capResult.set(res);
    } catch (e) {
      this.capError.set(this.errMsg(e));
    } finally {
      this.capLoading.set(false);
    }
  }

  protected toggleSel(id: string): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selected.set(next);
  }

  protected toggleAll(): void {
    const r = this.capResult();
    if (!r) return;
    if (this.allSelected()) this.selected.set(new Set());
    else this.selected.set(new Set(r.proposals.map((p) => p.vehicleId)));
  }

  protected async applySelected(): Promise<void> {
    const r = this.capResult();
    if (!r) return;
    const items = r.proposals
      .filter((p: AiCapacityProposalDto) => this.selected().has(p.vehicleId))
      .map((p) => ({ vehicleId: p.vehicleId, seats: p.seats, childSeats: p.childSeats, features: p.features }));
    if (items.length === 0) return;
    this.applying.set(true);
    this.applyMsg.set(null);
    this.capError.set(null);
    try {
      const res = await firstValueFrom(this.api.capacityApply({ items }));
      this.applyMsg.set(`${res.updated} véhicule(s) mis à jour.`);
      this.selected.set(new Set());
    } catch (e) {
      this.capError.set(this.errMsg(e));
    } finally {
      this.applying.set(false);
    }
  }

  // ─── Placement ───
  protected async runPlacement(): Promise<void> {
    const start = this.startAt();
    const end = this.endAt();
    if (!start || !end) {
      this.plError.set('Renseignez le créneau (début et fin).');
      return;
    }
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      this.plError.set('La fin doit être après le début.');
      return;
    }
    this.plLoading.set(true);
    this.plError.set(null);
    try {
      const res = await firstValueFrom(
        this.api.placementSuggest({
          startAt: startIso,
          endAt: endIso,
          criteria: {
            minSeats: this.numOrUndef(this.minSeats()),
            minChildSeats: this.numOrUndef(this.minChildSeats()),
          },
        }),
      );
      this.plResult.set(res);
    } catch (e) {
      this.plError.set(this.errMsg(e));
    } finally {
      this.plLoading.set(false);
    }
  }

  private numOrUndef(v: string): number | undefined {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  protected confClass(v: number): string {
    if (v >= 0.7) return 'aio-conf--hi aio-score--hi';
    if (v >= 0.4) return 'aio-conf--mid aio-score--mid';
    return 'aio-conf--lo aio-score--lo';
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      // Le serveur envoie déjà un message précis (clé absente, quota, réseau, refus…) :
      // ne pas l'écraser par un message « non configuré » générique.
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return m;
      if (e.status === 503) {
        return "Copilote IA non configuré côté serveur (ANTHROPIC_API_KEY). À tester d'abord en Console.";
      }
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}

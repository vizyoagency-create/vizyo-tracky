import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, Sparkles, Check, AlertTriangle, Loader, CalendarCheck, Inbox, X,
} from 'lucide-angular';
import type { VehicleEventDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../../core/services/agenda.service';
import { AiApiService } from '../../../core/services/ai.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';
import { DateTimeRangePickerComponent } from '../../../shared/ui/datetime-range/datetime-range-picker.component';

export interface ReservationSheetVehicle {
  id: string;
  plate: string | null;
  brand?: string | null;
  model?: string | null;
}

function toLocalInput(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Sprint 9 (consolidation) — Réservations depuis l'Agenda. Deux modes dans une seule
 * feuille : « Demander » (créneau + critères + suggestion IA du meilleur véhicule) et
 * « À valider » (file des demandes REQUESTED → valider/refuser). Aucune page séparée.
 */
@Component({
  selector: 'app-reservation-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, NgClass, LucideAngularModule, BottomSheetComponent, DateTimeRangePickerComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Réservations" (closed)="closed.emit()">
      <div class="rs">
        <div class="rs-head">
          <h3 class="rs-title"><lucide-icon [img]="CalendarCheckIcon" [size]="15"></lucide-icon> Réservations</h3>
          <button type="button" class="rs-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        @if (canManage()) {
          <div class="rs-seg">
            <button type="button" class="rs-seg-btn" [class.rs-seg-btn--on]="mode() === 'request'" (click)="mode.set('request')">Demander</button>
            <button type="button" class="rs-seg-btn" [class.rs-seg-btn--on]="mode() === 'validate'" (click)="setValidate()">
              À valider @if (pending().length > 0) { <span class="rs-badge">{{ pending().length }}</span> }
            </button>
          </div>
        }

        <!-- ───── DEMANDER ───── -->
        @if (mode() === 'request') {
          <div class="rs-body">
            <div class="rs-f">
              <span>Créneau</span>
              <app-datetime-range [start]="startAt()" [end]="endAt()" (startChange)="startAt.set($event)" (endChange)="endAt.set($event)"></app-datetime-range>
            </div>
            <div class="rs-grid">
              <label class="rs-f rs-f--sm"><span>Places min.</span><input type="number" min="0" inputmode="numeric" class="rs-in" [value]="minSeats()" (input)="minSeats.set($any($event.target).value)"></label>
              <label class="rs-f rs-f--sm"><span>Sièges-enfant min.</span><input type="number" min="0" inputmode="numeric" class="rs-in" [value]="minChildSeats()" (input)="minChildSeats.set($any($event.target).value)"></label>
            </div>
            <label class="rs-f"><span>Motif (optionnel)</span><input type="text" class="rs-in" [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Ex. Ramassage scolaire secteur nord"></label>

            <!-- Véhicule -->
            <div class="rs-f">
              <span class="rs-lbl-row">
                Véhicule
                @if (canAi()) {
                  <button type="button" class="rs-ai" [disabled]="aiLoading()" (click)="suggestAi()">
                    @if (aiLoading()) { <lucide-icon [img]="LoaderIcon" [size]="13" class="rs-spin"></lucide-icon> } @else { <lucide-icon [img]="SparklesIcon" [size]="13"></lucide-icon> }
                    Suggérer avec l'IA
                  </button>
                }
              </span>
              <select class="rs-in" [value]="vehicleId()" (change)="vehicleId.set($any($event.target).value)">
                <option value="">Auto (le 1er disponible conforme)</option>
                @for (v of vehicles(); track v.id) { <option [value]="v.id">{{ v.plate || '—' }}@if (v.brand) { · {{ v.brand }} {{ v.model }} }</option> }
              </select>
            </div>

            <!-- Loader explicatif : l'utilisateur comprend ce que fait l'IA et combien de temps ça prend -->
            @if (aiLoading()) {
              <div class="rs-ai-loading">
                <lucide-icon [img]="LoaderIcon" [size]="16" class="rs-spin"></lucide-icon>
                <div>
                  <p class="rs-ai-loading-t">Analyse en cours… (10–30 s)</p>
                  <p class="rs-ai-loading-s">L'IA compare les places, l'énergie et le coût au km des véhicules disponibles pour proposer le placement le plus adapté et le moins cher.</p>
                </div>
              </div>
            }
            @if (aiError()) { <div class="rs-alert rs-alert--err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ aiError() }}</div> }
            @if (aiNoMatch()) { <div class="rs-alert rs-alert--warn"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ aiNotes() || 'Aucun véhicule ne couvre bien le besoin sur ce créneau.' }}</div> }
            <!-- Transparence : véhicules écartés AVANT le raisonnement IA (résultats non faussés en silence) -->
            @if (aiExcludedInfo()) { <div class="rs-alert rs-alert--info">{{ aiExcludedInfo() }}</div> }
            @if (aiProposals().length > 0) {
              <div class="rs-ai-list">
                <span class="rs-ai-hint">Proposé par l'IA — touchez pour choisir. Le n°1 est le meilleur compromis besoin / coût :</span>
                @for (p of aiProposals(); track p.vehicleId; let i = $index) {
                  <button type="button" class="rs-ai-card" [class.rs-ai-card--on]="vehicleId() === p.vehicleId" (click)="vehicleId.set(p.vehicleId)">
                    <div class="rs-ai-top">
                      <span class="rs-rank">#{{ i + 1 }}</span>
                      <span class="rs-plate">{{ p.plate || '—' }}</span>
                      <span class="rs-chip" [ngClass]="scoreClass(p.score)">{{ p.score * 100 | number:'1.0-0' }}%</span>
                    </div>
                    <p class="rs-ai-reason">{{ p.reasoning }}</p>
                    <span class="rs-ai-seats">
                      {{ valOf(p.seats) }} places · {{ valOf(p.childSeats) }} sièges-enfant
                      @if (p.energy) { · <span class="rs-tag">{{ energyLabel(p.energy) }}</span> }
                      @if (p.costPerKm != null) { · <span class="rs-tag rs-tag--cost">≈ {{ p.costPerKm | number:'1.2-2' }} €/km</span> }
                    </span>
                  </button>
                }
                @if (aiCost() != null) {
                  <p class="rs-ai-cost">Coût de cette analyse IA : ≈ {{ aiCost() | number:'1.2-2' }} €</p>
                }
              </div>
            }

            @if (reqError()) { <div class="rs-alert rs-alert--err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ reqError() }}</div> }
          </div>
          <div class="rs-foot">
            <button type="button" class="rs-btn rs-btn--primary" [disabled]="submitting()" (click)="submit()">
              @if (submitting()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="rs-spin"></lucide-icon> }
              {{ submitting() ? 'Envoi…' : 'Déposer la demande' }}
            </button>
          </div>
        }

        <!-- ───── À VALIDER ───── -->
        @if (mode() === 'validate') {
          <div class="rs-body">
            @if (queueLoading()) {
              <div class="rs-skel"></div><div class="rs-skel"></div>
            } @else if (pending().length === 0) {
              <div class="rs-empty"><lucide-icon [img]="InboxIcon" [size]="36" class="rs-empty-ic"></lucide-icon><p>Aucune demande en attente.</p></div>
            } @else {
              @for (r of pending(); track r.id) {
                <div class="rs-q">
                  <div class="rs-q-top">
                    <span class="rs-plate">{{ r.vehiclePlate || '—' }}</span>
                    <span class="rs-q-when">{{ r.startAt | date:'dd MMM HH:mm' }} → {{ r.endAt | date:'HH:mm' }}</span>
                  </div>
                  <p class="rs-q-title">{{ r.title }}</p>
                  <div class="rs-q-actions">
                    <button type="button" class="rs-btn rs-btn--ok" [disabled]="busyId() === r.id" (click)="confirm(r)"><lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> Valider</button>
                    <button type="button" class="rs-btn rs-btn--no" [disabled]="busyId() === r.id" (click)="reject(r)">Refuser</button>
                  </div>
                </div>
              }
            }
          </div>
        }
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .rs { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .rs-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .rs-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .rs-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .rs-x:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .rs-seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); margin: 10px 0; }
    .rs-seg-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--fg-tertiary); }
    .rs-seg-btn--on { background: var(--bg-primary); color: var(--tracky-light); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .rs-badge { font-size: 11px; font-weight: 800; padding: 0 6px; border-radius: 999px; background: rgba(56,189,248,.18); color: #38BDF8; }
    .rs-body { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; max-height: 58dvh; padding: 2px; }
    .rs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .rs-f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--fg-tertiary); }
    .rs-f > span:first-child, .rs-lbl-row { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .rs-lbl-row { display: flex; align-items: center; justify-content: space-between; }
    .rs-in { width: 100%; padding: 10px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 16px; }
    .rs-in:focus { outline: none; border-color: var(--tracky-light); box-shadow: 0 0 0 3px rgba(16,224,160,.14); }
    .rs-ai { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--tracky-light); text-transform: none; letter-spacing: 0; padding: 3px 8px; border-radius: 8px; background: rgba(16,224,160,.1); }
    .rs-ai:disabled { opacity: .6; }
    .rs-ai-list { display: flex; flex-direction: column; gap: 8px; }
    .rs-ai-hint { font-size: 11.5px; color: var(--fg-tertiary); }
    .rs-ai-card { text-align: left; padding: 11px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .rs-ai-card--on { border-color: var(--tracky-light); box-shadow: 0 0 0 1px var(--tracky-light) inset; background: rgba(16,224,160,.06); }
    .rs-ai-top { display: flex; align-items: center; gap: 8px; }
    .rs-rank { font-size: 12px; font-weight: 800; color: var(--fg-tertiary); }
    .rs-ai-top .rs-plate { flex: 1; }
    .rs-ai-reason { font-size: 12px; color: var(--fg-secondary); margin-top: 6px; line-height: 1.4; }
    .rs-ai-seats { font-size: 11px; color: var(--fg-tertiary); margin-top: 5px; display: block; }
    .rs-tag { font-weight: 700; color: var(--fg-secondary); }
    .rs-tag--cost { color: var(--tracky-light); }
    .rs-ai-cost { font-size: 11px; color: var(--fg-tertiary); text-align: right; margin: 2px 2px 0; }
    .rs-ai-loading {
      display: flex; align-items: flex-start; gap: 10px; padding: 12px;
      border-radius: 12px; background: rgba(16,224,160,.06);
      border: 1px solid color-mix(in srgb, var(--tracky-light) 30%, var(--border-subtle));
    }
    .rs-ai-loading lucide-icon { color: var(--tracky-light); flex-shrink: 0; margin-top: 1px; }
    .rs-ai-loading-t { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .rs-ai-loading-s { font-size: 11.5px; color: var(--fg-tertiary); margin: 3px 0 0; line-height: 1.45; }
    .rs-plate { font-weight: 800; color: var(--fg-primary); letter-spacing: .3px; }
    .rs-chip { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px; }
    .rs-chip--hi { color: #10B981; background: rgba(16,185,129,.13); }
    .rs-chip--mid { color: #F59E0B; background: rgba(245,158,11,.14); }
    .rs-chip--lo { color: #EF4444; background: rgba(239,68,68,.13); }
    .rs-alert { display: flex; align-items: center; gap: 7px; padding: 9px 11px; border-radius: 10px; font-size: 12px; }
    .rs-alert--err { background: rgba(239,68,68,.1); color: #EF4444; }
    .rs-alert--warn { background: rgba(245,158,11,.12); color: #B45309; }
    .rs-alert--info { background: var(--bg-tertiary); color: var(--fg-secondary); }
    .rs-foot { display: flex; justify-content: flex-end; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); margin-top: 2px; border-top: 1px solid var(--border-subtle); }
    .rs-btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; border-radius: 10px; font-size: 13px; font-weight: 700; }
    .rs-btn--primary { background: var(--tracky, #10B981); color: #fff; }
    .rs-btn--primary:disabled { opacity: .55; }
    .rs-btn--ok { background: rgba(16,224,160,.12); color: var(--tracky-light); border: 1px solid rgba(16,224,160,.25); }
    .rs-btn--no { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .rs-btn:disabled { opacity: .55; }
    .rs-q { padding: 11px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .rs-q-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .rs-q-when { font-size: 11.5px; color: var(--fg-tertiary); }
    .rs-q-title { font-size: 13px; font-weight: 600; color: var(--fg-primary); margin: 6px 0 0; }
    .rs-q-actions { display: flex; gap: 8px; margin-top: 9px; }
    .rs-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 26px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }
    .rs-empty-ic { opacity: .3; }
    .rs-skel { height: 64px; border-radius: 12px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: rs-sh 1.3s infinite; }
    @keyframes rs-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .rs-spin { animation: rs-spin 1s linear infinite; }
    @keyframes rs-spin { to { transform: rotate(360deg); } }
    /* ── Dark : les bordures à 8 % de blanc sont presque invisibles sur le fond
       sombre. On renforce les traits pour structurer la feuille et détacher les
       champs (bordures d'inputs + séparateurs haut/bas + cartes). ── */
    :host-context([data-theme='dark']) .rs-in { border-color: rgba(255,255,255,.15); color-scheme: dark; }
    :host-context([data-theme='dark']) .rs-in:focus { border-color: var(--tracky-light); }
    :host-context([data-theme='dark']) .rs-head,
    :host-context([data-theme='dark']) .rs-foot { border-color: rgba(255,255,255,.10); }
    :host-context([data-theme='dark']) .rs-seg,
    :host-context([data-theme='dark']) .rs-ai-card,
    :host-context([data-theme='dark']) .rs-q { border-color: rgba(255,255,255,.12); }

    @media (max-width: 480px) { .rs-grid { grid-template-columns: 1fr; } }
  `],
})
export class ReservationSheetComponent {
  private readonly api = inject(AgendaApiService);
  private readonly ai = inject(AiApiService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  readonly open = input(false);
  readonly vehicles = input<ReservationSheetVehicle[]>([]);
  /** Date pré-sélectionnée (clic sur un jour du calendrier), format 'YYYY-MM-DD'. */
  readonly defaultDate = input<string | null>(null);
  /** Mode initial à l'ouverture ('request' ou 'validate'). */
  readonly startMode = input<'request' | 'validate'>('request');
  readonly closed = output<void>();
  readonly created = output<void>();

  protected readonly SparklesIcon = Sparkles;
  protected readonly CheckIcon = Check;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly InboxIcon = Inbox;
  protected readonly XIcon = X;

  protected readonly mode = signal<'request' | 'validate'>('request');
  protected readonly canManage = computed(() => this.perms.can('reservations_manage'));
  protected readonly canAi = computed(() => this.perms.can('ai_optimize'));

  // Demande
  protected readonly startAt = signal('');
  protected readonly endAt = signal('');
  protected readonly minSeats = signal('');
  protected readonly minChildSeats = signal('');
  protected readonly reason = signal('');
  protected readonly vehicleId = signal('');
  protected readonly submitting = signal(false);
  protected readonly reqError = signal<string | null>(null);

  // IA placement
  protected readonly aiLoading = signal(false);
  protected readonly aiError = signal<string | null>(null);
  protected readonly aiNoMatch = signal(false);
  protected readonly aiNotes = signal<string | null>(null);
  protected readonly aiProposals = signal<{ vehicleId: string; plate: string | null; seats: number | null; childSeats: number | null; energy?: string | null; costPerKm?: number | null; score: number; reasoning: string }[]>([]);
  /** Phrase « N véhicule(s) écarté(s) » (immobilisés / capacité inconnue), sinon null. */
  protected readonly aiExcludedInfo = signal<string | null>(null);
  /** Coût € de l'appel IA (transparence), affiché après l'analyse. */
  protected readonly aiCost = signal<number | null>(null);

  // File de validation
  protected readonly queueLoading = signal(false);
  protected readonly pending = signal<VehicleEventDto[]>([]);
  protected readonly busyId = signal<string | null>(null);

  constructor() {
    // À l'ouverture : (ré)initialise le créneau depuis la date cliquée (ou prochaine heure).
    effect(() => {
      if (!this.open()) return;
      const base = this.defaultDate() ? new Date(`${this.defaultDate()}T09:00:00`) : new Date();
      if (!this.defaultDate()) { base.setMinutes(0, 0, 0); base.setHours(base.getHours() + 1); }
      this.startAt.set(toLocalInput(base));
      this.endAt.set(toLocalInput(new Date(base.getTime() + 60 * 60 * 1000)));
      this.resetAi();
      this.reqError.set(null);
      this.vehicleId.set('');
      const m = this.startMode() === 'validate' && this.canManage() ? 'validate' : 'request';
      this.mode.set(m);
      if (m === 'validate') void this.loadQueue();
    });
  }

  protected valOf(n: number | null): string { return n === null || n === undefined ? '—' : String(n); }
  protected scoreClass(v: number): string { return v >= 0.7 ? 'rs-chip--hi' : v >= 0.4 ? 'rs-chip--mid' : 'rs-chip--lo'; }

  /** Libellé court d'énergie (badge de proposition). */
  protected energyLabel(e: string | null | undefined): string {
    switch (e) {
      case 'ELECTRIQUE': return 'Électrique';
      case 'DIESEL': return 'Diesel';
      case 'ESSENCE': return 'Essence';
      case 'HYBRIDE': return 'Hybride';
      default: return e ?? '';
    }
  }

  protected setValidate(): void {
    this.mode.set('validate');
    void this.loadQueue();
  }

  private resetAi(): void {
    this.aiProposals.set([]); this.aiError.set(null); this.aiNoMatch.set(false); this.aiNotes.set(null);
    this.aiExcludedInfo.set(null); this.aiCost.set(null);
  }

  /** Compose la phrase de transparence sur les véhicules écartés avant le raisonnement IA. */
  private excludedInfo(immobilized: number, unknownCapacity: number): string | null {
    const parts: string[] = [];
    if (immobilized > 0) parts.push(`${immobilized} immobilisé(s) (incident ou maintenance)`);
    if (unknownCapacity > 0) parts.push(`${unknownCapacity} sans capacité renseignée (à compléter dans Parc & capacités)`);
    if (parts.length === 0) return null;
    return `Écartés d'office : ${parts.join(' · ')}.`;
  }

  private criteria() {
    const s = parseInt(this.minSeats(), 10);
    const c = parseInt(this.minChildSeats(), 10);
    return {
      minSeats: Number.isFinite(s) && s > 0 ? s : undefined,
      minChildSeats: Number.isFinite(c) && c > 0 ? c : undefined,
    };
  }

  private slot(): { startAt: string; endAt: string } | null {
    const s = this.startAt(); const e = this.endAt();
    if (!s || !e) { this.reqError.set('Renseignez le créneau.'); return null; }
    const si = new Date(s).toISOString(); const ei = new Date(e).toISOString();
    if (new Date(ei).getTime() <= new Date(si).getTime()) { this.reqError.set('La fin doit être après le début.'); return null; }
    return { startAt: si, endAt: ei };
  }

  protected async suggestAi(): Promise<void> {
    this.reqError.set(null); this.resetAi();
    const slot = this.slot();
    if (!slot) return;
    this.aiLoading.set(true);
    try {
      const res = await firstValueFrom(this.ai.placementSuggest({ ...slot, reason: this.reason() || undefined, criteria: this.criteria() }));
      this.aiProposals.set(res.proposals);
      this.aiNoMatch.set(res.noGoodMatch);
      this.aiNotes.set(res.notes ?? null);
      this.aiExcludedInfo.set(this.excludedInfo(res.excludedImmobilized ?? 0, res.excludedUnknownCapacity ?? 0));
      this.aiCost.set(res.aiCostEur ?? null);
      if (res.proposals.length > 0) this.vehicleId.set(res.proposals[0].vehicleId); // pré-sélectionne le meilleur
    } catch (e) {
      this.aiError.set(this.errMsg(e));
    } finally {
      this.aiLoading.set(false);
    }
  }

  protected async submit(): Promise<void> {
    this.reqError.set(null);
    const slot = this.slot();
    if (!slot) return;
    this.submitting.set(true);
    try {
      await firstValueFrom(this.api.requestReservation({
        vehicleId: this.vehicleId() || undefined,
        startAt: slot.startAt,
        endAt: slot.endAt,
        reason: this.reason() || undefined,
        criteria: this.criteria(),
      }));
      this.toast.success('Demande déposée', 'À valider par un gestionnaire.');
      this.created.emit();
      this.closed.emit();
    } catch (e) {
      this.reqError.set(this.errMsg(e));
    } finally {
      this.submitting.set(false);
    }
  }

  private async loadQueue(): Promise<void> {
    this.queueLoading.set(true);
    try {
      this.pending.set(await firstValueFrom(this.api.listReservations({ status: 'REQUESTED' })));
    } catch {
      this.pending.set([]);
    } finally {
      this.queueLoading.set(false);
    }
  }

  protected async confirm(r: VehicleEventDto): Promise<void> {
    this.busyId.set(r.id);
    try {
      await firstValueFrom(this.api.confirmReservation(r.id));
      this.pending.update((l) => l.filter((x) => x.id !== r.id));
      this.toast.success('Réservation validée', r.vehiclePlate ?? '');
      this.created.emit();
    } catch (e) {
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async reject(r: VehicleEventDto): Promise<void> {
    this.busyId.set(r.id);
    try {
      await firstValueFrom(this.api.cancelReservation(r.id));
      this.pending.update((l) => l.filter((x) => x.id !== r.id));
      this.toast.success('Demande refusée', r.vehiclePlate ?? '');
      this.created.emit();
    } catch (e) {
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.busyId.set(null);
    }
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return m;
      if (e.status === 503) return "Copilote IA non configuré côté serveur (ANTHROPIC_API_KEY).";
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}

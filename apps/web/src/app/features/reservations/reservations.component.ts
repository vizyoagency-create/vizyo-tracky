import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, CalendarPlus, Check, X, Search, Users, Truck, Clock, Inbox, Sparkles, CalendarClock,
} from 'lucide-angular';
import type { SuggestedVehicleDto, VehicleEventDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../core/services/agenda.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

interface ReservationForm {
  date: string;
  startTime: string;
  endTime: string;
  minSeats: number | undefined;
  minChildSeats: number | undefined;
  features: string[];
  featureInput: string;
  title: string;
  reason: string;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

@Component({
  selector: 'app-reservations',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, LucideAngularModule],
  template: `
    <div class="flex flex-col gap-5">
      <header class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <h1 class="text-2xl font-display font-bold text-fg-primary flex items-center gap-2">
            <lucide-icon [img]="CalendarClockIcon" [size]="22" class="text-tracky-light"></lucide-icon>
            Réservations
          </h1>
          <p class="text-sm text-fg-tertiary mt-0.5">
            Réservez un véhicule par créneau et critères — le système propose les véhicules libres.
          </p>
        </div>
        @if (canRequest()) {
          <button type="button" (click)="openModal()" class="rz-btn-primary">
            <lucide-icon [img]="CalendarPlusIcon" [size]="15"></lucide-icon>
            <span>Demander un véhicule</span>
          </button>
        }
      </header>

      @if (loading()) {
        <div class="rz-skel"></div><div class="rz-skel"></div>
      } @else {
        <!-- File de validation -->
        @if (canManage() && pending().length > 0) {
          <section class="rz-card">
            <div class="rz-card-head">
              <h2 class="rz-card-title"><lucide-icon [img]="InboxIcon" [size]="16" class="text-tracky-light"></lucide-icon> Demandes en attente</h2>
              <span class="rz-badge-count">{{ pending().length }}</span>
            </div>
            <div class="flex flex-col gap-2">
              @for (r of pending(); track r.id) {
                <div class="rz-row">
                  <div class="min-w-0">
                    <div class="rz-row-top"><span class="rz-plate">{{ r.vehiclePlate || '—' }}</span><span class="rz-pill rz-pill--req">Demande</span></div>
                    <div class="rz-row-sub">{{ r.startAt | date:'EEE d MMM, HH:mm' }} → {{ r.endAt | date:'HH:mm' }}<span class="rz-crit">{{ criteriaLabel(r) }}</span></div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <button type="button" class="rz-icon-btn rz-icon-btn--ok" [disabled]="actioning() === r.id" (click)="confirmPending(r)" aria-label="Valider"><lucide-icon [img]="CheckIcon" [size]="16"></lucide-icon></button>
                    <button type="button" class="rz-icon-btn rz-icon-btn--no" [disabled]="actioning() === r.id" (click)="rejectPending(r)" aria-label="Refuser"><lucide-icon [img]="XIcon" [size]="16"></lucide-icon></button>
                  </div>
                </div>
              }
            </div>
          </section>
        }

        <!-- À venir -->
        <section class="rz-card">
          <div class="rz-card-head">
            <h2 class="rz-card-title"><lucide-icon [img]="CalendarClockIcon" [size]="16" class="text-tracky-light"></lucide-icon> Réservations à venir</h2>
            <span class="rz-card-sub">{{ upcoming().length }}</span>
          </div>
          @if (upcoming().length === 0) {
            <div class="rz-empty">Aucune réservation ferme à venir. @if (canRequest()) { Cliquez sur « Demander un véhicule ». }</div>
          } @else {
            <div class="flex flex-col gap-2">
              @for (r of upcoming(); track r.id) {
                <div class="rz-row">
                  <div class="min-w-0">
                    <div class="rz-row-top"><span class="rz-plate">{{ r.vehiclePlate || '—' }}</span><span class="rz-pill rz-pill--ok">Confirmée</span></div>
                    <div class="rz-row-sub">{{ r.startAt | date:'EEE d MMM, HH:mm' }} → {{ r.endAt | date:'HH:mm' }}<span class="rz-crit">{{ criteriaLabel(r) }}</span></div>
                  </div>
                  @if (canManage()) {
                    <button type="button" class="rz-icon-btn rz-icon-btn--no shrink-0" [disabled]="actioning() === r.id" (click)="rejectPending(r)" aria-label="Annuler"><lucide-icon [img]="XIcon" [size]="16"></lucide-icon></button>
                  }
                </div>
              }
            </div>
          }
        </section>
      }
    </div>

    <!-- Modale Demander -->
    @if (modalOpen()) {
      <div class="rz-overlay" (click)="closeModal()">
        <div class="rz-modal" (click)="$event.stopPropagation()">
          <div class="rz-modal-head">
            <h3 class="rz-modal-title">Demander un véhicule</h3>
            <button type="button" class="rz-x" (click)="closeModal()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </div>

          <div class="rz-modal-body">
            <div class="grid grid-cols-3 gap-2">
              <div class="col-span-3"><label class="rz-label">Date</label><input type="date" [(ngModel)]="form.date" (ngModelChange)="onSlotChange()" class="rz-input" /></div>
              <div><label class="rz-label">Début</label><input type="time" [(ngModel)]="form.startTime" (ngModelChange)="onSlotChange()" class="rz-input" /></div>
              <div><label class="rz-label">Fin</label><input type="time" [(ngModel)]="form.endTime" (ngModelChange)="onSlotChange()" class="rz-input" /></div>
              <div><label class="rz-label">Places min.</label><input type="number" min="1" max="99" [(ngModel)]="form.minSeats" (ngModelChange)="onSlotChange()" placeholder="—" class="rz-input" /></div>
            </div>
            <div class="grid grid-cols-2 gap-2 mt-2">
              <div><label class="rz-label">Sièges enfants min.</label><input type="number" min="0" max="20" [(ngModel)]="form.minChildSeats" (ngModelChange)="onSlotChange()" placeholder="—" class="rz-input" /></div>
              <div><label class="rz-label">Libellé (option.)</label><input type="text" [(ngModel)]="form.title" placeholder="Tournée Nord" class="rz-input" /></div>
            </div>
            <div class="mt-2">
              <label class="rz-label">Équipements requis</label>
              <div class="rz-chips">
                @for (f of form.features; track f) { <span class="rz-chip">{{ f }}<button type="button" class="rz-chip-x" (click)="removeFeature(f)" aria-label="Retirer">×</button></span> }
                <input type="text" [(ngModel)]="form.featureInput" (keydown.enter)="addFeature($event)" placeholder="Ajouter (Entrée)…" class="rz-chip-input" />
              </div>
            </div>

            <button type="button" class="rz-search" [disabled]="!canSearch() || suggesting()" (click)="search()">
              <lucide-icon [img]="SearchIcon" [size]="15"></lucide-icon>
              {{ suggesting() ? 'Recherche…' : 'Voir les véhicules libres' }}
            </button>

            @if (suggestions() !== null) {
              @if (suggestions()!.length === 0) {
                <div class="rz-empty rz-empty--sm">Aucun véhicule libre ne correspond sur ce créneau. Élargissez les critères ou changez d'horaire.</div>
              } @else {
                <div class="rz-sug-head"><lucide-icon [img]="SparklesIcon" [size]="13" class="text-tracky-light"></lucide-icon> {{ suggestions()!.length }} véhicule(s) libre(s)</div>
                <div class="flex flex-col gap-2">
                  @for (v of suggestions()!; track v.vehicleId) {
                    <div class="rz-sug">
                      <div class="min-w-0">
                        <div class="rz-row-top"><span class="rz-plate">{{ v.vehiclePlate || '—' }}</span>@if (v.underutilized) { <span class="rz-pill rz-pill--under">sous-utilisé</span> }</div>
                        <div class="rz-sug-meta">
                          @if (v.seats != null) { <span><lucide-icon [img]="UsersIcon" [size]="11"></lucide-icon> {{ v.seats }}</span> }
                          @if (v.childSeats) { <span>· {{ v.childSeats }} siège(s) enf.</span> }
                          @for (f of v.features.slice(0, 3); track f) { <span class="rz-tag">{{ f }}</span> }
                        </div>
                      </div>
                      <button type="button" class="rz-reserve shrink-0" [disabled]="submitting() === v.vehicleId" (click)="reserve(v)">
                        {{ submitting() === v.vehicleId ? '…' : (canManage() ? 'Réserver' : 'Demander') }}
                      </button>
                    </div>
                  }
                </div>
              }
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .rz-btn-primary { display: inline-flex; align-items: center; gap: 7px; padding: 9px 15px; border-radius: 11px; font-size: 13px; font-weight: 600; color: #04241b; background: var(--tracky-light, #10E0A0); }
    .rz-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 15px; }
    .rz-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
    .rz-card-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); display: flex; align-items: center; gap: 7px; font-family: var(--font-display, inherit); }
    .rz-card-sub { font-size: 12px; color: var(--fg-tertiary); }
    .rz-badge-count { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px; color: #F59E0B; background: rgba(245,158,11,.14); }
    .rz-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 13px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .rz-row-top { display: flex; align-items: center; gap: 8px; }
    .rz-row-sub { font-size: 12px; color: var(--fg-tertiary); margin-top: 3px; }
    .rz-crit { margin-left: 8px; color: var(--fg-muted); }
    .rz-plate { font-weight: 800; font-size: 14px; color: var(--fg-primary); letter-spacing: .3px; }
    .rz-pill { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    .rz-pill--req { color: #F59E0B; background: rgba(245,158,11,.13); }
    .rz-pill--ok { color: var(--tracky-light, #10E0A0); background: rgba(16,224,160,.13); }
    .rz-pill--under { color: #38BDF8; background: rgba(56,189,248,.14); }
    .rz-icon-btn { width: 34px; height: 34px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border-subtle); }
    .rz-icon-btn:disabled { opacity: .5; }
    .rz-icon-btn--ok { color: var(--tracky-light, #10E0A0); background: rgba(16,224,160,.1); }
    .rz-icon-btn--no { color: #EF4444; background: rgba(239,68,68,.08); }
    .rz-empty { padding: 22px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }
    .rz-empty--sm { padding: 14px; font-size: 12px; }
    .rz-skel { height: 90px; border-radius: 16px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: rz-sh 1.3s infinite; }
    @keyframes rz-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    /* Modale */
    .rz-overlay { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.62); backdrop-filter: blur(3px); }
    .rz-modal { width: 100%; max-width: 560px; max-height: 90vh; max-height: 90dvh; display: flex; flex-direction: column; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 18px; overflow: hidden; }
    .rz-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 15px 17px; border-bottom: 1px solid var(--border-subtle); }
    .rz-modal-title { font-size: 16px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .rz-x { width: 34px; height: 34px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg-tertiary); }
    .rz-x:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .rz-modal-body { padding: 16px 17px; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
    .rz-label { display: block; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); margin-bottom: 4px; }
    .rz-input { width: 100%; padding: 9px 11px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); border-radius: 11px; color: var(--fg-primary); font-size: 13px; outline: none; }
    .rz-input:focus { border-color: var(--tracky); }
    .rz-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px; border: 1.5px solid var(--border-subtle); border-radius: 11px; background: var(--bg-secondary); }
    .rz-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 9px; border-radius: 8px; font-size: 12px; font-weight: 600; color: var(--tracky-light, #10E0A0); background: rgba(16,224,160,.12); }
    .rz-chip-x { width: 16px; height: 16px; border-radius: 5px; font-size: 14px; line-height: 1; color: var(--fg-tertiary); }
    .rz-chip-input { flex: 1; min-width: 90px; background: transparent; border: none; outline: none; color: var(--fg-primary); font-size: 13px; }
    .rz-search { width: 100%; margin-top: 14px; padding: 11px; border-radius: 12px; font-size: 13px; font-weight: 600; color: var(--fg-primary); background: var(--bg-tertiary); border: 1px solid var(--border-subtle); display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
    .rz-search:disabled { opacity: .5; }
    .rz-sug-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--fg-secondary); margin: 16px 0 9px; }
    .rz-sug { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 13px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .rz-sug-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-tertiary); margin-top: 4px; }
    .rz-sug-meta lucide-icon { vertical-align: -1px; }
    .rz-tag { padding: 1px 7px; border-radius: 6px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .rz-reserve { padding: 8px 14px; border-radius: 10px; font-size: 12.5px; font-weight: 700; color: #04241b; background: var(--tracky-light, #10E0A0); }
    .rz-reserve:disabled { opacity: .6; }
  `],
})
export class ReservationsComponent implements OnInit {
  private readonly api = inject(AgendaApiService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  protected readonly CalendarClockIcon = CalendarClock;
  protected readonly CalendarPlusIcon = CalendarPlus;
  protected readonly CheckIcon = Check;
  protected readonly XIcon = X;
  protected readonly SearchIcon = Search;
  protected readonly UsersIcon = Users;
  protected readonly TruckIcon = Truck;
  protected readonly ClockIcon = Clock;
  protected readonly InboxIcon = Inbox;
  protected readonly SparklesIcon = Sparkles;

  protected readonly reservations = signal<VehicleEventDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly modalOpen = signal(false);
  protected readonly suggestions = signal<SuggestedVehicleDto[] | null>(null);
  protected readonly suggesting = signal(false);
  protected readonly submitting = signal<string | null>(null);
  protected readonly actioning = signal<string | null>(null);

  protected form: ReservationForm = this.blankForm();

  protected readonly pending = computed(() => this.reservations().filter((r) => r.status === 'REQUESTED'));
  protected readonly upcoming = computed(() => {
    const now = Date.now();
    return this.reservations()
      .filter((r) => r.status === 'CONFIRMED' && (r.endAt ? new Date(r.endAt).getTime() : new Date(r.startAt).getTime()) >= now)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  });

  ngOnInit(): void {
    void this.load();
  }

  protected canRequest(): boolean { return this.perms.can('reservations_request'); }
  protected canManage(): boolean { return this.perms.can('reservations_manage'); }

  private blankForm(): ReservationForm {
    const d = new Date();
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      startTime: '09:00',
      endTime: '12:00',
      minSeats: undefined,
      minChildSeats: undefined,
      features: [],
      featureInput: '',
      title: '',
      reason: '',
    };
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.reservations.set(await firstValueFrom(this.api.listReservations()));
    } catch {
      this.reservations.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  protected openModal(): void {
    this.form = this.blankForm();
    this.suggestions.set(null);
    this.modalOpen.set(true);
  }
  protected closeModal(): void {
    this.modalOpen.set(false);
  }

  /** Le créneau/critères ont changé → invalide les suggestions précédentes. */
  protected onSlotChange(): void {
    if (this.suggestions() !== null) this.suggestions.set(null);
  }

  protected addFeature(ev: Event): void {
    ev.preventDefault();
    const raw = this.form.featureInput.trim();
    if (!raw) return;
    if (!this.form.features.some((f) => f.toLowerCase() === raw.toLowerCase()) && this.form.features.length < 20) {
      this.form.features = [...this.form.features, raw];
    }
    this.form.featureInput = '';
    this.onSlotChange();
  }
  protected removeFeature(f: string): void {
    this.form.features = this.form.features.filter((x) => x !== f);
    this.onSlotChange();
  }

  /** Méthode (pas computed) : lit l'objet `form` muté par ngModel. */
  protected canSearch(): boolean {
    return this.buildSlot() !== null;
  }

  private buildSlot(): { startAt: string; endAt: string } | null {
    const f = this.form;
    if (!f.date || !f.startTime || !f.endTime) return null;
    const start = new Date(`${f.date}T${f.startTime}`);
    const end = new Date(`${f.date}T${f.endTime}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) return null;
    return { startAt: start.toISOString(), endAt: end.toISOString() };
  }

  private buildCriteria() {
    return {
      minSeats: this.form.minSeats || undefined,
      minChildSeats: this.form.minChildSeats || undefined,
      requiredFeatures: this.form.features.length ? this.form.features : undefined,
    };
  }

  protected async search(): Promise<void> {
    const slot = this.buildSlot();
    if (!slot) return;
    this.suggesting.set(true);
    try {
      const res = await firstValueFrom(this.api.suggestReservation({
        startAt: slot.startAt,
        endAt: slot.endAt,
        minSeats: this.form.minSeats || undefined,
        minChildSeats: this.form.minChildSeats || undefined,
        features: this.form.features.length ? this.form.features : undefined,
      }));
      this.suggestions.set(res.vehicles);
    } catch (err) {
      this.toast.error('Recherche impossible', this.errMsg(err));
      this.suggestions.set([]);
    } finally {
      this.suggesting.set(false);
    }
  }

  protected async reserve(v: SuggestedVehicleDto): Promise<void> {
    const slot = this.buildSlot();
    if (!slot) return;
    this.submitting.set(v.vehicleId);
    try {
      const created = await firstValueFrom(this.api.requestReservation({
        vehicleId: v.vehicleId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        title: this.form.title.trim() || undefined,
        criteria: this.buildCriteria(),
      }));
      if (this.canManage()) {
        await firstValueFrom(this.api.confirmReservation(created.id, {}));
        this.toast.success('Réservation confirmée', `${v.vehiclePlate ?? 'Véhicule'} réservé.`);
      } else {
        this.toast.success('Demande envoyée', 'En attente de validation par un gestionnaire.');
      }
      this.closeModal();
      await this.load();
    } catch (err) {
      this.toast.error('Échec de la réservation', this.errMsg(err));
    } finally {
      this.submitting.set(null);
    }
  }

  protected async confirmPending(r: VehicleEventDto): Promise<void> {
    this.actioning.set(r.id);
    try {
      await firstValueFrom(this.api.confirmReservation(r.id, {}));
      this.toast.success('Demande validée', `${r.vehiclePlate ?? 'Véhicule'} réservé.`);
      await this.load();
    } catch (err) {
      this.toast.error('Validation impossible', this.errMsg(err));
    } finally {
      this.actioning.set(null);
    }
  }

  protected async rejectPending(r: VehicleEventDto): Promise<void> {
    this.actioning.set(r.id);
    try {
      await firstValueFrom(this.api.cancelReservation(r.id));
      this.toast.success('Réservation annulée', '');
      await this.load();
    } catch (err) {
      this.toast.error('Action impossible', this.errMsg(err));
    } finally {
      this.actioning.set(null);
    }
  }

  protected criteriaLabel(r: VehicleEventDto): string {
    const c = (r.metadata?.['criteria'] ?? null) as { minSeats?: number; minChildSeats?: number; requiredFeatures?: string[] } | null;
    if (!c) return '';
    const parts: string[] = [];
    if (c.minSeats) parts.push(`${c.minSeats}+ places`);
    if (c.minChildSeats) parts.push(`${c.minChildSeats}+ sièges enf.`);
    if (c.requiredFeatures?.length) parts.push(c.requiredFeatures.join(', '));
    return parts.length ? `· ${parts.join(' · ')}` : '';
  }

  private errMsg(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      return typeof err.error?.message === 'string' ? err.error.message : 'Une erreur est survenue.';
    }
    return 'Une erreur est survenue.';
  }
}

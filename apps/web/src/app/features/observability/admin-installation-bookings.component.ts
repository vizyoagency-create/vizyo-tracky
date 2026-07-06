import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ArrowLeft, CalendarClock, Check, ChevronRight, Copy, Link2, LucideAngularModule, Plus, Trash2, X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type {
  InstallationBookingDto, InstallationBookingLinkDto, InstallationBookingStatus,
} from '@vizyo/tracky-shared';
import { FleetsApiService, type FleetSummary } from '../../core/services/fleets.service';
import { InstallationBookingApiService } from '../../core/services/installation-booking.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

const TZ = 'Europe/Paris';
const DAY_FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const TIME_FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Prise de RDV en ligne — console admin (SUPER_ADMIN). 3 onglets : Demandes (valider /
 * refuser), Liens (créer / copier / désactiver), Agenda (poses réservées par jour).
 */
@Component({
  selector: 'app-admin-installation-bookings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="ib">
      <a routerLink="/admin" class="ib-back"><lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon> Administration</a>
      <div class="ib-head">
        <div>
          <h1>Réservations d'installation</h1>
          <p>Liens publics de prise de RDV, demandes de créneau et agenda des poses.</p>
        </div>
      </div>

      <div class="ib-tabs">
        <button [class.on]="tab() === 'requests'" (click)="tab.set('requests')">Demandes @if (pendingCount() > 0) { <span class="ib-badge">{{ pendingCount() }}</span> }</button>
        <button [class.on]="tab() === 'links'" (click)="tab.set('links')">Liens</button>
        <button [class.on]="tab() === 'agenda'" (click)="tab.set('agenda')">Agenda</button>
      </div>

      @if (loading()) { <div class="ib-loading">Chargement…</div> }

      <!-- ════════ DEMANDES ════════ -->
      @if (tab() === 'requests') {
        <div class="ib-filters">
          @for (f of statusFilters; track f.value) {
            <button class="ib-chip" [class.on]="statusFilter() === f.value" (click)="statusFilter.set(f.value)">{{ f.label }}</button>
          }
        </div>
        @if (filteredBookings().length === 0) {
          <div class="ib-empty">Aucune demande {{ statusLabel(statusFilter()) }}.</div>
        }
        @for (b of filteredBookings(); track b.id) {
          <div class="ib-card">
            <div class="ib-card-top">
              <div>
                <div class="ib-slot"><lucide-icon [img]="CalendarClock" [size]="14"></lucide-icon> {{ formatSlot(b.startAt, b.endAt) }}</div>
                <div class="ib-client">{{ b.clientName }} · <a href="mailto:{{ b.clientEmail }}">{{ b.clientEmail }}</a>@if (b.clientPhone) { · {{ b.clientPhone }} }</div>
                @if (b.vehiclePlate || b.vehicleBrand) { <div class="ib-meta">🚗 {{ b.vehiclePlate }}@if (b.vehicleBrand) { · {{ b.vehicleBrand }} {{ b.vehicleModel }} }</div> }
                @if (b.clientAddress) { <div class="ib-meta">📍 {{ b.clientAddress }}</div> }
                @if (b.notes) { <div class="ib-meta">💬 {{ b.notes }}</div> }
              </div>
              <span class="ib-status ib-status--{{ b.status.toLowerCase() }}">{{ statusLabel(b.status) }}</span>
            </div>

            @if (b.status === 'PENDING') {
              @if (expandedId() === b.id && expandMode() === 'confirm') {
                <div class="ib-action">
                  <label class="ib-in-lbl">Plaque du véhicule (obligatoire)</label>
                  <input class="ib-in" [value]="plate()" (input)="plate.set($any($event.target).value)" placeholder="AB-123-CD">
                  <div class="ib-action-btns">
                    <button class="ib-btn ib-btn--ok" [disabled]="busy()" (click)="doConfirm(b)"><lucide-icon [img]="Check" [size]="14"></lucide-icon> Valider & créer la pose</button>
                    <button class="ib-btn ib-btn--ghost" (click)="collapse()">Annuler</button>
                  </div>
                </div>
              } @else if (expandedId() === b.id && expandMode() === 'reject') {
                <div class="ib-action">
                  <input class="ib-in" [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Motif du refus (optionnel)">
                  <label class="ib-check"><input type="checkbox" [checked]="notify()" (change)="notify.set($any($event.target).checked)"> Prévenir le client par e-mail</label>
                  <div class="ib-action-btns">
                    <button class="ib-btn ib-btn--danger" [disabled]="busy()" (click)="doReject(b)">Confirmer le refus</button>
                    <button class="ib-btn ib-btn--ghost" (click)="collapse()">Annuler</button>
                  </div>
                </div>
              } @else {
                <div class="ib-action-btns">
                  <button class="ib-btn ib-btn--ok" (click)="openConfirm(b)"><lucide-icon [img]="Check" [size]="14"></lucide-icon> Valider</button>
                  <button class="ib-btn ib-btn--danger" (click)="openReject(b)"><lucide-icon [img]="X" [size]="14"></lucide-icon> Refuser</button>
                </div>
              }
            } @else if (b.status === 'REJECTED' && b.rejectionReason) {
              <div class="ib-meta">Motif : {{ b.rejectionReason }}</div>
            }
          </div>
        }
      }

      <!-- ════════ LIENS ════════ -->
      @if (tab() === 'links') {
        @if (createdUrl()) {
          <div class="ib-created">
            <div><strong>Lien créé !</strong> Copiez-le et envoyez-le au client.</div>
            <div class="ib-url"><code>{{ createdUrl() }}</code><button class="ib-copy" (click)="copy(createdUrl()!)"><lucide-icon [img]="Copy" [size]="13"></lucide-icon> Copier</button></div>
          </div>
        }
        <details class="ib-new" [open]="links().length === 0">
          <summary><lucide-icon [img]="Plus" [size]="15"></lucide-icon> Nouveau lien de réservation</summary>
          <div class="ib-form">
            <label class="ib-f"><span>Société / flotte *</span>
              <select class="ib-in" [value]="fFleet()" (change)="fFleet.set($any($event.target).value)">
                <option value="">— choisir —</option>
                @for (fl of fleets(); track fl.id) { <option [value]="fl.id">{{ fl.name }}</option> }
              </select>
            </label>
            <label class="ib-f"><span>Libellé (interne) *</span><input class="ib-in" [value]="fLabel()" (input)="fLabel.set($any($event.target).value)" placeholder="Ex. Pose flotte Dupont"></label>
            <label class="ib-f ib-f--full"><span>E-mail du client (optionnel — « lien direct »)</span><input class="ib-in" [value]="fEmail()" (input)="fEmail.set($any($event.target).value)" placeholder="Si renseigné, la page ne redemandera pas l'e-mail"></label>
            @if (fEmail().trim()) {
              <label class="ib-f"><span>Nom du client</span><input class="ib-in" [value]="fName()" (input)="fName.set($any($event.target).value)"></label>
              <label class="ib-f"><span>Téléphone</span><input class="ib-in" [value]="fPhone()" (input)="fPhone.set($any($event.target).value)"></label>
            }
            <label class="ib-check ib-f--full"><input type="checkbox" [checked]="fSingle()" (change)="fSingle.set($any($event.target).checked)"> Usage unique (le lien se ferme après la 1ʳᵉ réservation)</label>
            @if (createErr()) { <div class="ib-err ib-f--full">{{ createErr() }}</div> }
            <button class="ib-btn ib-btn--ok ib-f--full" [disabled]="busy()" (click)="createLink()">Générer le lien</button>
          </div>
        </details>

        @for (l of links(); track l.id) {
          <div class="ib-card" [class.off]="!l.active">
            <div class="ib-card-top">
              <div>
                <div class="ib-slot"><lucide-icon [img]="Link2" [size]="14"></lucide-icon> {{ l.label }} @if (!l.active) { <span class="ib-off-tag">désactivé</span> }</div>
                <div class="ib-meta">{{ l.fleetName }} · {{ l.pendingCount }} en attente · {{ l.confirmedCount }} confirmé{{ l.confirmedCount > 1 ? 's' : '' }}@if (l.clientEmail) { · lien direct ({{ l.clientEmail }}) }</div>
                @if (l.publicUrl) { <div class="ib-url"><code>{{ l.publicUrl }}</code><button class="ib-copy" (click)="copy(l.publicUrl!)"><lucide-icon [img]="Copy" [size]="13"></lucide-icon></button></div> }
              </div>
            </div>
            <div class="ib-action-btns">
              <button class="ib-btn ib-btn--ghost" (click)="toggleLink(l)">{{ l.active ? 'Désactiver' : 'Réactiver' }}</button>
              <button class="ib-btn ib-btn--danger" (click)="deleteLink(l)"><lucide-icon [img]="Trash2" [size]="14"></lucide-icon> Supprimer</button>
            </div>
          </div>
        }
      }

      <!-- ════════ AGENDA ════════ -->
      @if (tab() === 'agenda') {
        @if (agendaDays().length === 0) { <div class="ib-empty">Aucune pose réservée à venir.</div> }
        @for (day of agendaDays(); track day.date) {
          <div class="ib-agenda-day">
            <div class="ib-agenda-date">{{ day.label }}</div>
            @for (b of day.items; track b.id) {
              <div class="ib-agenda-row ib-agenda-row--{{ b.status.toLowerCase() }}">
                <span class="ib-agenda-time">{{ timeOnly(b.startAt) }}–{{ timeOnly(b.endAt) }}</span>
                <span class="ib-agenda-client">{{ b.clientName }}@if (b.vehiclePlate) { · {{ b.vehiclePlate }} }</span>
                <span class="ib-status ib-status--{{ b.status.toLowerCase() }}">{{ statusLabel(b.status) }}</span>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .ib { max-width:860px; }
    .ib-back { font-size:12px; color:var(--fg-tertiary,#69736E); display:inline-flex; align-items:center; gap:4px; text-decoration:none; margin-bottom:6px; }
    .ib-head h1 { margin:0; font-size:24px; font-weight:800; color:var(--fg-primary,#EAEFED); }
    .ib-head p { margin:2px 0 0; font-size:13px; color:var(--fg-tertiary,#9BA5A1); }
    .ib-tabs { display:flex; gap:6px; margin:20px 0 16px; border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.08)); }
    .ib-tabs button { background:none; border:none; padding:10px 14px; font-size:14px; font-weight:600; color:var(--fg-tertiary,#69736E); cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; display:inline-flex; align-items:center; gap:6px; }
    .ib-tabs button.on { color:var(--tracky,#10E0A0); border-bottom-color:var(--tracky,#10E0A0); }
    .ib-badge { background:#F5B33D; color:#3a2a06; border-radius:9px; font-size:11px; font-weight:800; padding:1px 7px; }
    .ib-filters { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
    .ib-chip { padding:6px 12px; border-radius:999px; border:1px solid var(--border-subtle,rgba(255,255,255,.1)); background:transparent; color:var(--fg-secondary,#9BA5A1); font-size:13px; cursor:pointer; }
    .ib-chip.on { background:var(--tracky,#10E0A0); color:#04130D; border-color:var(--tracky,#10E0A0); font-weight:700; }
    .ib-card { border:1px solid var(--border-subtle,rgba(255,255,255,.09)); border-radius:14px; padding:16px; margin-bottom:12px; background:var(--bg-secondary,#101514); }
    .ib-card.off { opacity:.6; }
    .ib-card-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .ib-slot { font-weight:700; font-size:15px; color:var(--fg-primary,#EAEFED); display:flex; align-items:center; gap:6px; text-transform:capitalize; }
    .ib-client { font-size:13px; color:var(--fg-secondary,#9BA5A1); margin-top:5px; }
    .ib-client a { color:var(--tracky,#10E0A0); text-decoration:none; }
    .ib-meta { font-size:12.5px; color:var(--fg-tertiary,#69736E); margin-top:4px; }
    .ib-status { font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; white-space:nowrap; }
    .ib-status--pending { background:rgba(245,179,61,.15); color:#F5B33D; }
    .ib-status--confirmed { background:rgba(16,224,160,.15); color:#10E0A0; }
    .ib-status--rejected { background:rgba(242,112,107,.15); color:#F2706B; }
    .ib-status--cancelled { background:rgba(255,255,255,.08); color:#9BA5A1; }
    .ib-action { margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle,rgba(255,255,255,.07)); }
    .ib-action-btns { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
    .ib-btn { padding:9px 14px; border-radius:10px; border:1px solid transparent; font-size:13px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
    .ib-btn--ok { background:var(--tracky,#10E0A0); color:#04130D; }
    .ib-btn--danger { background:rgba(242,112,107,.12); color:#F2706B; border-color:rgba(242,112,107,.3); }
    .ib-btn--ghost { background:transparent; color:var(--fg-secondary,#9BA5A1); border-color:var(--border-subtle,rgba(255,255,255,.12)); }
    .ib-btn:disabled { opacity:.5; cursor:default; }
    .ib-in { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid var(--border-subtle,rgba(255,255,255,.12)); background:var(--bg-primary,#0C1210); color:var(--fg-primary,#EAEFED); font-size:14px; }
    .ib-in:focus { outline:none; border-color:var(--tracky,#10E0A0); }
    .ib-in-lbl { display:block; font-size:12px; color:var(--fg-secondary,#9BA5A1); margin-bottom:6px; }
    .ib-check { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fg-secondary,#9BA5A1); margin-top:10px; cursor:pointer; }
    .ib-new { border:1px solid var(--border-subtle,rgba(255,255,255,.09)); border-radius:14px; padding:14px 16px; margin-bottom:16px; background:var(--bg-secondary,#101514); }
    .ib-new summary { font-weight:700; font-size:14px; color:var(--fg-primary,#EAEFED); cursor:pointer; display:flex; align-items:center; gap:8px; }
    .ib-form { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:16px; }
    .ib-f { display:flex; flex-direction:column; gap:6px; }
    .ib-f--full { grid-column:1 / -1; }
    .ib-f span { font-size:12px; color:var(--fg-secondary,#9BA5A1); }
    .ib-created { border:1px solid rgba(16,224,160,.3); background:rgba(16,224,160,.08); border-radius:12px; padding:14px 16px; margin-bottom:16px; font-size:13px; color:var(--fg-secondary,#9BA5A1); }
    .ib-url { display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap; }
    .ib-url code { flex:1; min-width:180px; font-size:12px; background:var(--bg-primary,#0C1210); padding:8px 10px; border-radius:8px; color:var(--tracky,#10E0A0); word-break:break-all; }
    .ib-copy { padding:7px 11px; border-radius:8px; border:1px solid var(--border-subtle,rgba(255,255,255,.12)); background:transparent; color:var(--fg-secondary,#9BA5A1); font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
    .ib-off-tag { font-size:11px; color:#F2706B; font-weight:600; }
    .ib-err { color:#F2706B; font-size:13px; }
    .ib-empty, .ib-loading { padding:28px; text-align:center; color:var(--fg-tertiary,#69736E); font-size:14px; }
    .ib-agenda-day { margin-bottom:16px; }
    .ib-agenda-date { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-tertiary,#69736E); margin-bottom:8px; text-transform:capitalize; }
    .ib-agenda-row { display:flex; align-items:center; gap:12px; padding:10px 14px; border-radius:10px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.07)); margin-bottom:6px; }
    .ib-agenda-row--pending { border-left:3px solid #F5B33D; }
    .ib-agenda-row--confirmed { border-left:3px solid #10E0A0; }
    .ib-agenda-time { font-variant-numeric:tabular-nums; font-weight:700; font-size:13px; color:var(--fg-primary,#EAEFED); }
    .ib-agenda-client { flex:1; font-size:13px; color:var(--fg-secondary,#9BA5A1); }
    @media (max-width:560px) { .ib-form { grid-template-columns:1fr; } }
  `],
})
export class AdminInstallationBookingsComponent implements OnInit {
  private readonly api = inject(InstallationBookingApiService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft; protected readonly CalendarClock = CalendarClock;
  protected readonly Check = Check; protected readonly X = X; protected readonly Copy = Copy;
  protected readonly Trash2 = Trash2; protected readonly Plus = Plus; protected readonly Link2 = Link2;
  protected readonly ChevronRight = ChevronRight;

  protected readonly tab = signal<'requests' | 'links' | 'agenda'>('requests');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly bookings = signal<InstallationBookingDto[]>([]);
  protected readonly links = signal<InstallationBookingLinkDto[]>([]);
  protected readonly fleets = signal<FleetSummary[]>([]);

  protected readonly statusFilter = signal<InstallationBookingStatus>('PENDING');
  protected readonly statusFilters = [
    { value: 'PENDING' as const, label: 'En attente' },
    { value: 'CONFIRMED' as const, label: 'Confirmées' },
    { value: 'REJECTED' as const, label: 'Refusées' },
  ];

  // Expansion valider/refuser
  protected readonly expandedId = signal<string | null>(null);
  protected readonly expandMode = signal<'confirm' | 'reject' | null>(null);
  protected readonly plate = signal('');
  protected readonly reason = signal('');
  protected readonly notify = signal(false);

  // Formulaire nouveau lien
  protected readonly fFleet = signal(''); protected readonly fLabel = signal('');
  protected readonly fEmail = signal(''); protected readonly fName = signal(''); protected readonly fPhone = signal('');
  protected readonly fSingle = signal(false);
  protected readonly createErr = signal<string | null>(null);
  protected readonly createdUrl = signal<string | null>(null);

  protected readonly pendingCount = computed(() => this.bookings().filter((b) => b.status === 'PENDING').length);
  protected readonly filteredBookings = computed(() => this.bookings().filter((b) => b.status === this.statusFilter()));

  protected readonly agendaDays = computed(() => {
    const items = this.bookings()
      .filter((b) => b.status === 'PENDING' || b.status === 'CONFIRMED')
      .filter((b) => new Date(b.endAt).getTime() > Date.now())
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    const byDay = new Map<string, { date: string; label: string; items: InstallationBookingDto[] }>();
    for (const b of items) {
      const key = b.startAt.slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, { date: key, label: DAY_FMT.format(new Date(b.startAt)), items: [] });
      byDay.get(key)!.items.push(b);
    }
    return [...byDay.values()];
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [bookings, links, fleets] = await Promise.all([
        firstValueFrom(this.api.listBookings()),
        firstValueFrom(this.api.listLinks()),
        firstValueFrom(this.fleetsApi.list()),
      ]);
      this.bookings.set(bookings);
      this.links.set(links);
      this.fleets.set(fleets);
    } catch {
      this.toast.error('Chargement impossible', 'Réessayez.');
    } finally {
      this.loading.set(false);
    }
  }

  protected statusLabel(s: InstallationBookingStatus): string {
    return { PENDING: 'en attente', CONFIRMED: 'confirmée', REJECTED: 'refusée', CANCELLED: 'annulée' }[s];
  }
  protected formatSlot(startAt: string, endAt: string): string {
    return `${DAY_FMT.format(new Date(startAt))}, ${TIME_FMT.format(new Date(startAt))} – ${TIME_FMT.format(new Date(endAt))}`;
  }
  protected timeOnly(iso: string): string { return TIME_FMT.format(new Date(iso)); }

  protected copy(url: string): void {
    navigator.clipboard?.writeText(url).then(
      () => this.toast.success('Lien copié'),
      () => this.toast.error('Copie impossible'),
    );
  }

  // ── Demandes ──
  protected openConfirm(b: InstallationBookingDto): void {
    this.expandedId.set(b.id); this.expandMode.set('confirm');
    this.plate.set(b.vehiclePlate ?? '');
  }
  protected openReject(b: InstallationBookingDto): void {
    this.expandedId.set(b.id); this.expandMode.set('reject'); this.reason.set(''); this.notify.set(false);
  }
  protected collapse(): void { this.expandedId.set(null); this.expandMode.set(null); }

  protected async doConfirm(b: InstallationBookingDto): Promise<void> {
    if (!this.plate().trim()) { this.toast.error('Plaque requise', 'Renseignez la plaque du véhicule.'); return; }
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.confirmBooking(b.id, { vehiclePlate: this.plate().trim() }));
      this.toast.success('Créneau validé', 'La pose a été ajoutée au planning et le client prévenu.');
      this.collapse();
      await this.reload();
    } catch (e) { this.toast.error('Validation impossible', this.errMsg(e)); }
    finally { this.busy.set(false); }
  }

  protected async doReject(b: InstallationBookingDto): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.rejectBooking(b.id, { reason: this.reason().trim() || undefined, notifyClient: this.notify() }));
      this.toast.success('Demande refusée', 'Le créneau est de nouveau disponible.');
      this.collapse();
      await this.reload();
    } catch (e) { this.toast.error('Refus impossible', this.errMsg(e)); }
    finally { this.busy.set(false); }
  }

  // ── Liens ──
  protected async createLink(): Promise<void> {
    this.createErr.set(null);
    if (!this.fFleet()) { this.createErr.set('Choisissez une société.'); return; }
    if (!this.fLabel().trim()) { this.createErr.set('Donnez un libellé.'); return; }
    this.busy.set(true);
    try {
      const link = await firstValueFrom(this.api.createLink({
        fleetId: this.fFleet(),
        label: this.fLabel().trim(),
        clientEmail: this.fEmail().trim() || undefined,
        clientName: this.fEmail().trim() ? (this.fName().trim() || undefined) : undefined,
        clientPhone: this.fEmail().trim() ? (this.fPhone().trim() || undefined) : undefined,
        singleUse: this.fSingle(),
      }));
      this.createdUrl.set(link.publicUrl ?? null);
      this.fLabel.set(''); this.fEmail.set(''); this.fName.set(''); this.fPhone.set(''); this.fSingle.set(false);
      await this.reload();
      this.toast.success('Lien créé', 'Copiez-le et envoyez-le au client.');
    } catch (e) { this.createErr.set(this.errMsg(e)); }
    finally { this.busy.set(false); }
  }

  protected async toggleLink(l: InstallationBookingLinkDto): Promise<void> {
    try {
      await firstValueFrom(this.api.updateLink(l.id, { active: !l.active }));
      await this.reload();
    } catch (e) { this.toast.error('Action impossible', this.errMsg(e)); }
  }

  protected async deleteLink(l: InstallationBookingLinkDto): Promise<void> {
    if (!confirm(`Supprimer le lien « ${l.label} » ? Les demandes déjà reçues sont conservées.`)) return;
    try {
      await firstValueFrom(this.api.deleteLink(l.id));
      if (this.createdUrl() === l.publicUrl) this.createdUrl.set(null);
      await this.reload();
      this.toast.success('Lien supprimé');
    } catch (e) { this.toast.error('Suppression impossible', this.errMsg(e)); }
  }

  private errMsg(e: unknown): string {
    const m = (e as { error?: { message?: string } })?.error?.message;
    return typeof m === 'string' ? m : 'Une erreur est survenue.';
  }
}

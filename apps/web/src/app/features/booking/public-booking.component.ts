import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type {
  BookingDayDto,
  BookingSlotDto,
  CreatePublicBookingDto,
  PublicBookingLinkDto,
} from '@vizyo/tracky-shared';
import { InstallationBookingApiService } from '../../core/services/installation-booking.service';

/**
 * Page PUBLIQUE de réservation de créneau d'installation (hors auth). Le client ouvre
 * `/book/<token>`, choisit un jour puis un créneau LIBRE, renseigne ses infos (sauf en
 * mode « lien direct » où l'e-mail est déjà connu) et dépose sa demande. Page autonome
 * (hors shell authentifié) → styles complets ici, charte émeraude/Manrope.
 */
@Component({
  selector: 'app-public-booking',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pb">
      <div class="pb-card">
        <header class="pb-head">
          <span class="pb-brand">Vizyo <span class="pb-brand-hl">Tracky</span></span>
        </header>

        @if (loading()) {
          <div class="pb-state"><div class="pb-spin"></div><p>Chargement…</p></div>
        } @else if (notFound()) {
          <div class="pb-state">
            <div class="pb-emoji">🔎</div>
            <h1>Lien introuvable</h1>
            <p>Ce lien de réservation n'existe pas ou a été supprimé.</p>
          </div>
        } @else if (link()?.closed) {
          <div class="pb-state">
            <div class="pb-emoji">🔒</div>
            <h1>Réservation indisponible</h1>
            <p>{{ link()?.closedReason }}</p>
          </div>
        } @else if (done()) {
          <div class="pb-state">
            <div class="pb-emoji">✅</div>
            <h1>Demande envoyée</h1>
            <p class="pb-slot-ok">{{ confirmedLabel() }}</p>
            <p>Votre demande a bien été transmise. Vous recevrez un e-mail dès que le créneau sera confirmé.</p>
          </div>
        } @else {
          <div class="pb-body">
            <h1 class="pb-title">Réservez votre installation</h1>
            <p class="pb-sub">{{ link()?.companyName }} · créneaux de {{ (link()?.slotMinutes || 120) / 60 }}h</p>

            @if (days().length === 0) {
              <div class="pb-empty">Aucun créneau disponible pour le moment. Réessayez plus tard.</div>
            } @else {
              <!-- Jours -->
              <div class="pb-label">1 · Choisissez un jour</div>
              <div class="pb-days">
                @for (d of days(); track d.date) {
                  <button type="button" class="pb-day" [class.on]="selectedDate() === d.date" (click)="selectDay(d.date)">
                    <span class="pb-day-l">{{ d.label }}</span>
                    <span class="pb-day-n">{{ d.slots.length }} créneau{{ d.slots.length > 1 ? 'x' : '' }}</span>
                  </button>
                }
              </div>

              <!-- Créneaux -->
              @if (selectedDay(); as day) {
                <div class="pb-label">2 · Choisissez un créneau</div>
                <div class="pb-slots">
                  @for (s of day.slots; track s.startAt) {
                    <button type="button" class="pb-slot" [class.on]="selectedSlot()?.startAt === s.startAt" (click)="selectSlot(s)">{{ s.label }}</button>
                  }
                </div>
              }

              <!-- Formulaire -->
              @if (selectedSlot()) {
                <div class="pb-label">3 · Vos informations</div>
                <div class="pb-form">
                  @if (link()?.needsClientInfo) {
                    <label class="pb-f"><span>Nom complet *</span><input class="pb-in" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="Prénom Nom"></label>
                    <label class="pb-f"><span>E-mail *</span><input class="pb-in" type="email" [value]="email()" (input)="email.set($any($event.target).value)" placeholder="vous@exemple.fr"></label>
                    <label class="pb-f"><span>Téléphone</span><input class="pb-in" [value]="phone()" (input)="phone.set($any($event.target).value)" placeholder="06 12 34 56 78"></label>
                    <label class="pb-f pb-f--full"><span>Adresse (lieu de pose)</span><input class="pb-in" [value]="address()" (input)="address.set($any($event.target).value)" placeholder="12 rue…, 31000 Toulouse"></label>
                  } @else {
                    <div class="pb-known">Bonjour <strong>{{ link()?.prefill?.name || 'à vous' }}</strong>, on a déjà vos coordonnées. Choisissez juste votre créneau ci-dessus.</div>
                  }
                  <label class="pb-f"><span>Immatriculation</span><input class="pb-in" [value]="plate()" (input)="plate.set($any($event.target).value)" placeholder="AB-123-CD"></label>
                  <label class="pb-f"><span>Marque / modèle</span><input class="pb-in" [value]="vehicle()" (input)="vehicle.set($any($event.target).value)" placeholder="Renault Kangoo"></label>
                  <label class="pb-f pb-f--full"><span>Remarque (optionnel)</span><textarea class="pb-in pb-ta" [value]="notes()" (input)="notes.set($any($event.target).value)" rows="2" placeholder="Une précision utile ?"></textarea></label>
                </div>

                @if (error()) { <div class="pb-err">{{ error() }}</div> }
                <button type="button" class="pb-submit" [disabled]="submitting()" (click)="submit()">
                  {{ submitting() ? 'Envoi…' : 'Confirmer ma demande' }}
                </button>
                <p class="pb-legal">Créneau choisi : <strong>{{ selectedSlot()?.label }}</strong> · {{ selectedDayLabel() }}</p>
              }
            }
          </div>
        }
      </div>
      <p class="pb-foot">Propulsé par Vizyo Tracky · GPS flotte</p>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .pb { min-height:100dvh; background:#060807; padding:24px 16px calc(24px + env(safe-area-inset-bottom)); display:flex; flex-direction:column; align-items:center; font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif; }
    .pb-card { width:100%; max-width:560px; background:#101514; border:1px solid rgba(255,255,255,.08); border-radius:18px; overflow:hidden; box-shadow:0 18px 48px rgba(0,0,0,.35); }
    .pb-head { padding:20px 26px; border-bottom:1px solid rgba(255,255,255,.06); }
    .pb-brand { font-weight:800; font-size:16px; letter-spacing:-.01em; color:#EAEFED; }
    .pb-brand-hl { color:#10E0A0; }
    .pb-body { padding:24px 26px 28px; }
    .pb-title { margin:0 0 4px; font-size:24px; font-weight:800; letter-spacing:-.025em; color:#EAEFED; }
    .pb-sub { margin:0 0 22px; font-size:14px; color:#9BA5A1; }
    .pb-label { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#69736E; margin:22px 0 10px; }
    .pb-days { display:flex; gap:8px; overflow-x:auto; padding-bottom:6px; scrollbar-width:thin; }
    .pb-day { flex:0 0 auto; min-width:92px; padding:11px 12px; border-radius:12px; border:1px solid rgba(255,255,255,.09); background:#161D1B; color:#EAEFED; cursor:pointer; text-align:left; transition:.15s; }
    .pb-day:hover { border-color:rgba(16,224,160,.5); }
    .pb-day.on { border-color:#10E0A0; background:rgba(16,224,160,.1); }
    .pb-day-l { display:block; font-size:13px; font-weight:700; text-transform:capitalize; }
    .pb-day-n { display:block; font-size:11px; color:#69736E; margin-top:2px; }
    .pb-slots { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; }
    .pb-slot { padding:12px 10px; border-radius:11px; border:1px solid rgba(255,255,255,.09); background:#161D1B; color:#EAEFED; font-size:13px; font-weight:600; cursor:pointer; transition:.15s; }
    .pb-slot:hover { border-color:rgba(16,224,160,.5); }
    .pb-slot.on { border-color:#10E0A0; background:rgba(16,224,160,.14); color:#10E0A0; }
    .pb-form { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .pb-f { display:flex; flex-direction:column; gap:6px; }
    .pb-f--full { grid-column:1 / -1; }
    .pb-f span { font-size:12px; color:#9BA5A1; }
    .pb-in { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.1); background:#0C1210; color:#EAEFED; font-size:14px; font-family:inherit; }
    .pb-in:focus { outline:none; border-color:#10E0A0; }
    .pb-ta { resize:vertical; }
    .pb-known { grid-column:1 / -1; padding:12px 14px; border-radius:11px; background:rgba(16,224,160,.08); border:1px solid rgba(16,224,160,.2); font-size:13px; color:#9BA5A1; }
    .pb-submit { width:100%; margin-top:18px; padding:15px; border:none; border-radius:12px; background:#10E0A0; color:#04130D; font-size:15px; font-weight:800; cursor:pointer; }
    .pb-submit:disabled { opacity:.6; cursor:default; }
    .pb-legal { margin:12px 0 0; font-size:12px; color:#69736E; text-align:center; }
    .pb-err { margin-top:14px; padding:11px 14px; border-radius:10px; background:rgba(242,112,107,.12); border:1px solid rgba(242,112,107,.3); color:#F2A6A3; font-size:13px; }
    .pb-empty { padding:24px; text-align:center; color:#9BA5A1; font-size:14px; background:#161D1B; border-radius:12px; }
    .pb-state { padding:44px 26px; text-align:center; }
    .pb-emoji { font-size:40px; margin-bottom:12px; }
    .pb-state h1 { margin:0 0 8px; font-size:22px; font-weight:800; color:#EAEFED; }
    .pb-state p { margin:0 auto; max-width:360px; font-size:14px; line-height:1.6; color:#9BA5A1; }
    .pb-slot-ok { color:#10E0A0 !important; font-weight:700; margin-bottom:10px !important; }
    .pb-spin { width:34px; height:34px; margin:0 auto 14px; border:3px solid rgba(16,224,160,.2); border-top-color:#10E0A0; border-radius:50%; animation:pbspin .8s linear infinite; }
    @keyframes pbspin { to { transform:rotate(360deg); } }
    .pb-foot { margin-top:18px; font-size:11px; color:#3a423f; }
    @media (max-width:520px) { .pb-form { grid-template-columns:1fr; } }
  `],
})
export class PublicBookingComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(InstallationBookingApiService);

  private token = '';
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly link = signal<PublicBookingLinkDto | null>(null);
  protected readonly days = signal<BookingDayDto[]>([]);
  protected readonly selectedDate = signal<string | null>(null);
  protected readonly selectedSlot = signal<BookingSlotDto | null>(null);
  protected readonly done = signal(false);
  protected readonly confirmedLabel = signal('');
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  // Champs client / véhicule
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly address = signal('');
  protected readonly plate = signal('');
  protected readonly vehicle = signal('');
  protected readonly notes = signal('');

  protected readonly selectedDay = computed(() => this.days().find((d) => d.date === this.selectedDate()) ?? null);
  protected readonly selectedDayLabel = computed(() => this.selectedDay()?.label ?? '');

  async ngOnInit(): Promise<void> {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const link = await firstValueFrom(this.api.getPublicLink(this.token));
      this.link.set(link);
      this.days.set(link.days);
      if (link.days.length > 0) this.selectedDate.set(link.days[0].date);
    } catch (err) {
      swallow('public-booking:load', err);
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected selectDay(date: string): void {
    this.selectedDate.set(date);
    this.selectedSlot.set(null);
  }
  protected selectSlot(s: BookingSlotDto): void {
    this.selectedSlot.set(s);
    this.error.set(null);
  }

  protected async submit(): Promise<void> {
    const slot = this.selectedSlot();
    if (!slot) return;
    this.error.set(null);
    if (this.link()?.needsClientInfo) {
      if (!this.name().trim()) { this.error.set('Renseignez votre nom.'); return; }
      if (!/.+@.+\..+/.test(this.email().trim())) { this.error.set('Renseignez un e-mail valide.'); return; }
    }
    const [brand, ...rest] = this.vehicle().trim().split(' ');
    const dto: CreatePublicBookingDto = {
      startAt: slot.startAt,
      clientName: this.name().trim() || undefined,
      clientEmail: this.email().trim() || undefined,
      clientPhone: this.phone().trim() || undefined,
      clientAddress: this.address().trim() || undefined,
      vehiclePlate: this.plate().trim() || undefined,
      vehicleBrand: brand || undefined,
      vehicleModel: rest.join(' ') || undefined,
      notes: this.notes().trim() || undefined,
    };
    this.submitting.set(true);
    try {
      const res = await firstValueFrom(this.api.book(this.token, dto));
      this.confirmedLabel.set(res.slotLabel);
      this.done.set(true);
    } catch (e: unknown) {
      swallow('public-booking:submit', e);
      const msg = (e as { error?: { message?: string } })?.error?.message;
      this.error.set(typeof msg === 'string' ? msg : 'Une erreur est survenue. Réessayez.');
      // Créneau plus dispo → on recharge les disponibilités.
      await this.load();
      this.selectedSlot.set(null);
    } finally {
      this.submitting.set(false);
    }
  }
}

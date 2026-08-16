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
import {
  CalendarX, CheckCircle2, Lock, LucideAngularModule, Mail, SearchX,
} from 'lucide-angular';
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
  imports: [LucideAngularModule],
  template: `
    <div class="pb">
      <div class="pb-card">
        <header class="pb-head">
          <span class="pb-brand">Vizyo <span class="pb-brand-hl">Tracky</span></span>
        </header>

        @if (loading()) {
          <div class="pb-state"><div class="pb-spin"></div><p>Chargement…</p></div>
        } @else if (notFound()) {
          <!--
            PLUS D'ECRAN CUL-DE-SAC (B1 § A). Ces trois ecrans disaient ce qui n'allait pas
            et s'arretaient la — sur un lien ouvert depuis un SMS, sans compte, sans menu :
            litteralement aucune suite possible sauf fermer l'onglet.
          -->
          <div class="pb-state">
            <span class="pb-ico pb-ico--warn"><lucide-icon [img]="SearchXIcon" [size]="26" /></span>
            <h1>Ce lien ne fonctionne plus</h1>
            <p>Il a peut-être été remplacé, ou l'installation est déjà planifiée. Rien n'est perdu&nbsp;: demandez-nous un nouveau lien.</p>
            <a class="pb-sortie" [href]="mailtoNouveauLien()">
              <lucide-icon [img]="MailIcon" [size]="15" /> Demander un nouveau lien
            </a>
          </div>
        } @else if (link()?.closed) {
          <div class="pb-state">
            <span class="pb-ico pb-ico--warn"><lucide-icon [img]="LockIcon" [size]="26" /></span>
            <h1>Réservation indisponible</h1>
            <p>{{ link()?.closedReason || 'Ce lien de réservation est fermé.' }}</p>
            <a class="pb-sortie" [href]="mailtoNouveauLien()">
              <lucide-icon [img]="MailIcon" [size]="15" /> Demander un nouveau lien
            </a>
          </div>
        } @else if (done()) {
          <div class="pb-state">
            <span class="pb-ico pb-ico--ok"><lucide-icon [img]="CheckIcon" [size]="26" /></span>
            <h1>Demande envoyée</h1>
            <p class="pb-slot-ok">{{ confirmedLabel() }}</p>
            <p>Votre demande a bien été transmise. Vous recevrez un e-mail dès que le créneau sera confirmé.</p>
            <a class="pb-sortie pb-sortie--discret" [href]="mailtoQuestion()">
              <lucide-icon [img]="MailIcon" [size]="15" /> Une question sur ce rendez-vous&nbsp;?
            </a>
          </div>
        } @else {
          <div class="pb-body">
            <h1 class="pb-title">Réservez votre installation</h1>
            <p class="pb-sub">{{ link()?.companyName }} · créneaux de {{ (link()?.slotMinutes || 120) / 60 }}h</p>

            @if (days().length === 0) {
              <!-- « Reessayez plus tard » n'est pas une sortie : rien ne dit quand, ni a qui parler. -->
              <div class="pb-state pb-state--inline">
                <span class="pb-ico pb-ico--warn"><lucide-icon [img]="CalendarIcon" [size]="26" /></span>
                <h1>Aucun créneau ouvert pour l'instant</h1>
                <p>Les prochaines dates ne sont pas encore publiées. Écrivez-nous&nbsp;: on vous propose un créneau directement.</p>
                <a class="pb-sortie" [href]="mailtoCreneau()">
                  <lucide-icon [img]="MailIcon" [size]="15" /> Demander un créneau
                </a>
              </div>
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
    .pb { min-height:100dvh; background:var(--bg-primary); padding:24px 16px calc(24px + env(safe-area-inset-bottom)); display:flex; flex-direction:column; align-items:center; font-family:inherit; }
    .pb-card { width:100%; max-width:560px; background:var(--bg-secondary); border:1px solid var(--border-subtle); border-radius:18px; overflow:hidden; box-shadow:none; }
    .pb-head { padding:20px 26px; border-bottom:1px solid var(--border-subtle); }
    .pb-brand { font-weight:800; font-size:16px; letter-spacing:-.01em; color:var(--fg-primary); }
    .pb-brand-hl { color:var(--texte-succes); }
    .pb-body { padding:24px 26px 28px; }
    .pb-title { margin:0 0 4px; font-size:24px; font-weight:800; letter-spacing:-.025em; color:var(--fg-primary); }
    .pb-sub { margin:0 0 22px; font-size:14px; color:var(--fg-secondary); }
    .pb-label { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--fg-secondary); margin:22px 0 10px; }
    .pb-days { display:flex; gap:8px; overflow-x:auto; padding-bottom:6px; scrollbar-width:thin; }
    .pb-day { flex:0 0 auto; min-width:92px; padding:11px 12px; border-radius:12px; border:1px solid var(--border-strong); background:var(--bg-tertiary); color:var(--fg-primary); cursor:pointer; text-align:left; transition:.15s; }
    .pb-day:hover { border-color:color-mix(in srgb, var(--color-tracky-light) 50%, transparent); }
    .pb-day.on { border-color:var(--color-tracky-light); background:color-mix(in srgb, var(--color-tracky-light) 10%, transparent); }
    .pb-day-l { display:block; font-size:13px; font-weight:700; text-transform:capitalize; }
    .pb-day-n { display:block; font-size:11px; color:var(--fg-secondary); margin-top:2px; }
    .pb-slots { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; }
    .pb-slot { padding:12px 10px; border-radius:11px; border:1px solid var(--border-strong); background:var(--bg-tertiary); color:var(--fg-primary); font-size:13px; font-weight:600; cursor:pointer; transition:.15s; }
    .pb-slot:hover { border-color:color-mix(in srgb, var(--color-tracky-light) 50%, transparent); }
    .pb-slot.on { border-color:var(--color-tracky-light); background:color-mix(in srgb, var(--color-tracky-light) 14%, transparent); color:var(--texte-succes); }
    .pb-form { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .pb-f { display:flex; flex-direction:column; gap:6px; }
    .pb-f--full { grid-column:1 / -1; }
    .pb-f span { font-size:12px; color:var(--fg-secondary); }
    .pb-in { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:10px; border:1px solid var(--border-strong); background:var(--bg-primary); color:var(--fg-primary); font-size:14px; font-family:inherit; }
    .pb-in:focus { outline:none; border-color:var(--color-tracky-light); }
    .pb-ta { resize:vertical; }
    .pb-known { grid-column:1 / -1; padding:12px 14px; border-radius:11px; background:color-mix(in srgb, var(--color-tracky-light) 8%, transparent); border:1px solid color-mix(in srgb, var(--color-tracky-light) 20%, transparent); font-size:13px; color:var(--fg-secondary); }
    .pb-submit { width:100%; margin-top:18px; padding:15px; border:none; border-radius:12px; background:var(--color-tracky-light); color:var(--accent-ink); font-size:15px; font-weight:800; cursor:pointer; }
    .pb-submit:disabled { opacity:.6; cursor:default; }
    .pb-legal { margin:12px 0 0; font-size:12px; color:var(--fg-secondary); text-align:center; }
    .pb-err { margin-top:14px; padding:11px 14px; border-radius:10px; background:color-mix(in srgb, var(--danger) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger) 30%, transparent); color:var(--texte-alerte); font-size:13px; }
    .pb-empty { padding:24px; text-align:center; color:var(--fg-secondary); font-size:14px; background:var(--bg-tertiary); border-radius:12px; }
    .pb-state { padding:44px 26px; text-align:center; }
    .pb-emoji { font-size:40px; margin-bottom:12px; }
    .pb-state h1 { margin:0 0 8px; font-size:22px; font-weight:800; color:var(--fg-primary); }
    .pb-state p { margin:0 auto; max-width:360px; font-size:14px; line-height:1.6; color:var(--fg-secondary); }
    .pb-slot-ok { color:var(--texte-succes) !important; font-weight:700; margin-bottom:10px !important; }
    .pb-spin { width:34px; height:34px; margin:0 auto 14px; border:3px solid color-mix(in srgb, var(--color-tracky-light) 20%, transparent); border-top-color:var(--color-tracky-light); border-radius:50%; animation:pbspin .8s linear infinite; }
    @keyframes pbspin { to { transform:rotate(360deg); } }
    .pb-foot { margin-top:18px; font-size:11.5px; color:var(--fg-secondary); }
    @media (max-width:520px) { .pb-form { grid-template-columns:1fr; } }

    /* Cibles tactiles : cette page s'ouvre au telephone, depuis un SMS. */
    .pb-day, .pb-slot { min-height:44px; }
    .pb-in { min-height:44px; }
    .pb-submit { min-height:48px; }

    /*
     * LA SORTIE. Les ecrans d'echec disaient ce qui n'allait pas et s'arretaient la : sans
     * compte ni menu, il ne restait qu'a fermer l'onglet.
     */
    .pb-ico {
      display:inline-flex; align-items:center; justify-content:center;
      width:52px; height:52px; border-radius:16px; margin-bottom:12px;
    }
    .pb-ico--warn { background:color-mix(in srgb, var(--warning) 14%, transparent); color:var(--texte-attente); }
    .pb-ico--ok { background:color-mix(in srgb, var(--color-tracky-light) 14%, transparent); color:var(--texte-succes); }
    .pb-sortie {
      display:inline-flex; align-items:center; justify-content:center; gap:8px;
      min-height:44px; margin-top:18px; padding:0 18px; border-radius:12px;
      background:var(--color-tracky-light); color:var(--accent-ink);
      font-size:14px; font-weight:700; text-decoration:none;
    }
    .pb-sortie--discret {
      background:transparent; border:1px solid var(--border-strong); color:var(--fg-primary);
    }
    .pb-state--inline { padding:24px 8px; }
  `],
})
export class PublicBookingComponent implements OnInit {
  protected readonly SearchXIcon = SearchX;
  protected readonly LockIcon = Lock;
  protected readonly CheckIcon = CheckCircle2;
  protected readonly CalendarIcon = CalendarX;
  protected readonly MailIcon = Mail;

  /**
   * LA SORTIE. Ces écrans n'en avaient aucune : ouverts depuis un SMS, sans compte ni menu,
   * ils laissaient le client devant un constat et rien d'autre.
   *
   * ⚠️ B1 § A cite trois sorties : « être prévenu, appeler, redemander un lien ». Seule la
   * dernière est faisable aujourd'hui : `PublicBookingLinkDto` ne porte **ni téléphone de la
   * société ni endpoint d'abonnement à une disponibilité**. On offre donc la sortie réelle
   * plutôt que d'en simuler trois — les deux autres sont consignées dans la fiche de reprise.
   */
  private mailto(sujet: string, corps: string): string {
    return `mailto:contact@vizyoagency.com?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(corps)}`;
  }
  protected mailtoNouveauLien(): string {
    return this.mailto(
      'Nouveau lien de réservation — installation',
      "Bonjour,\n\nMon lien de réservation d'installation ne fonctionne plus. Pouvez-vous m'en envoyer un nouveau ?\n\nMerci.",
    );
  }
  protected mailtoCreneau(): string {
    const societe = this.link()?.companyName ?? '';
    return this.mailto(
      'Demande de créneau d\'installation',
      `Bonjour,\n\nAucun créneau n'est ouvert pour le moment${societe ? ` (${societe})` : ''}. Pouvez-vous me proposer une date ?\n\nMerci.`,
    );
  }
  protected mailtoQuestion(): string {
    return this.mailto(
      'Question sur mon rendez-vous d\'installation',
      `Bonjour,\n\nJ'ai une question sur mon rendez-vous (${this.confirmedLabel()}).\n\nMerci.`,
    );
  }

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

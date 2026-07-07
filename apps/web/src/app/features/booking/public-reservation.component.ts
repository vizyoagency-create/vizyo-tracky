import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { LucideAngularModule, CalendarCheck, MapPin, Users, Check, Loader, Send, Sparkles } from 'lucide-angular';
import type {
  PublicReservationLinkDto,
  PublicReservationSuggestionDto,
  PublicSuggestedVehicleDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { ReservationBookingApiService } from '../../core/services/reservation-booking.service';

/**
 * Refonte agenda/IA (2026-07, P4) — Page PUBLIQUE de demande de réservation (hors auth, hors shell).
 * Un tiers décrit son besoin (places, créneau, destination, ou texte libre) ; l'app propose une
 * combinaison de véhicules disponibles ; l'envoi dépose une demande à valider. Styles complets ici
 * (page autonome). Société = fixée par le token.
 */
@Component({
  selector: 'app-public-reservation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, LucideAngularModule],
  template: `
    <div class="pr-page">
      <div class="pr-card">
        @if (loadError()) {
          <div class="pr-state"><h1 class="pr-h1">Lien indisponible</h1><p>{{ loadError() }}</p></div>
        } @else if (!link()) {
          <div class="pr-state"><lucide-icon [img]="LoaderIcon" [size]="26" class="pr-spin"></lucide-icon></div>
        } @else if (done()) {
          <div class="pr-state">
            <div class="pr-ok"><lucide-icon [img]="CheckIcon" [size]="30"></lucide-icon></div>
            <h1 class="pr-h1">Demande envoyée</h1>
            <p>{{ done() }}</p>
            <p class="pr-sub">Un gestionnaire de {{ link()?.fleetName || 'la société' }} va la valider.</p>
          </div>
        } @else {
          <header class="pr-head">
            <span class="pr-brand"><lucide-icon [img]="SparklesIcon" [size]="16"></lucide-icon> {{ link()?.fleetName || 'Réservation' }}</span>
            <h1 class="pr-h1">{{ link()?.label || 'Demander un véhicule' }}</h1>
            <p class="pr-sub">Décrivez votre besoin — on vous propose les véhicules disponibles.</p>
          </header>

          <label class="pr-f"><span>Votre besoin (texte libre)</span>
            <textarea class="pr-in" rows="2" [value]="freeText()" (input)="freeText.set($any($event.target).value)" placeholder="Ex. J'ai besoin de 11 places pour Carcassonne"></textarea>
          </label>
          <div class="pr-grid">
            <label class="pr-f"><span><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> Places</span>
              <input type="number" min="1" class="pr-in" [value]="seats()" (input)="seats.set($any($event.target).value)" placeholder="ex. 11"></label>
            <label class="pr-f"><span><lucide-icon [img]="MapPinIcon" [size]="12"></lucide-icon> Destination</span>
              <input type="text" class="pr-in" [value]="destination()" (input)="destination.set($any($event.target).value)" placeholder="ex. Carcassonne"></label>
          </div>
          <div class="pr-grid">
            <label class="pr-f"><span>Début</span><input type="datetime-local" class="pr-in" [value]="startAt()" (input)="startAt.set($any($event.target).value)"></label>
            <label class="pr-f"><span>Fin</span><input type="datetime-local" class="pr-in" [value]="endAt()" (input)="endAt.set($any($event.target).value)"></label>
          </div>

          @if (formError()) { <div class="pr-alert">{{ formError() }}</div> }

          <button type="button" class="pr-btn pr-btn--soft" [disabled]="searching()" (click)="search()">
            @if (searching()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="pr-spin"></lucide-icon> } @else { <lucide-icon [img]="SparklesIcon" [size]="15"></lucide-icon> }
            Voir les véhicules disponibles
          </button>

          @if (suggestion(); as s) {
            <div class="pr-result">
              <p class="pr-result-msg" [class.pr-result-msg--ko]="!s.covered">{{ s.message }}</p>
              @if (s.combination.length > 0) {
                <p class="pr-lbl">Proposition ({{ s.totalSeats }} places pour {{ s.seatsNeeded }}) :</p>
                @for (v of s.combination; track v.vehicleId) {
                  <label class="pr-veh pr-veh--on"><input type="checkbox" [checked]="selected().has(v.vehicleId)" (change)="toggle(v.vehicleId)"><span class="pr-plate">{{ v.plate || '—' }}</span><span class="pr-seats">{{ v.seats ?? '?' }} places</span></label>
                }
              }
              @if (s.alternatives.length > 0) {
                <p class="pr-lbl">Autres véhicules libres :</p>
                @for (v of s.alternatives; track v.vehicleId) {
                  <label class="pr-veh"><input type="checkbox" [checked]="selected().has(v.vehicleId)" (change)="toggle(v.vehicleId)"><span class="pr-plate">{{ v.plate || '—' }}</span><span class="pr-seats">{{ v.seats ?? '?' }} places</span></label>
                }
              }

              <div class="pr-grid">
                <label class="pr-f"><span>Votre nom</span><input type="text" class="pr-in" [value]="requesterName()" (input)="requesterName.set($any($event.target).value)" placeholder="Nom / structure"></label>
                <label class="pr-f"><span>Contact</span><input type="text" class="pr-in" [value]="requesterContact()" (input)="requesterContact.set($any($event.target).value)" placeholder="E-mail ou téléphone"></label>
              </div>
              @if (submitError()) { <div class="pr-alert">{{ submitError() }}</div> }
              <button type="button" class="pr-btn" [disabled]="submitting() || selectedCount() === 0" (click)="submit()">
                @if (submitting()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="pr-spin"></lucide-icon> } @else { <lucide-icon [img]="SendIcon" [size]="15"></lucide-icon> }
                Envoyer la demande ({{ selectedCount() }})
              </button>
            </div>
          }
        }
      </div>
      <p class="pr-footer">Propulsé par Tracky</p>
    </div>
  `,
  styles: [`
    :host { --pr-accent: #10B981; }
    .pr-page { min-height: 100dvh; background: #0b1220; color: #e5e7eb; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px 14px; font-family: system-ui, -apple-system, sans-serif; }
    .pr-card { width: 100%; max-width: 520px; background: #111827; border: 1px solid rgba(255,255,255,.08); border-radius: 18px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
    .pr-state { text-align: center; padding: 30px 10px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .pr-ok { width: 60px; height: 60px; border-radius: 50%; background: rgba(16,185,129,.16); color: var(--pr-accent); display: inline-flex; align-items: center; justify-content: center; }
    .pr-head { margin-bottom: 16px; }
    .pr-brand { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--pr-accent); text-transform: uppercase; letter-spacing: .04em; }
    .pr-h1 { font-size: 22px; font-weight: 800; margin: 6px 0 4px; color: #fff; }
    .pr-sub { font-size: 13px; color: #9ca3af; margin: 0; }
    .pr-f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #9ca3af; margin-bottom: 12px; }
    .pr-f > span { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
    .pr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .pr-in { width: 100%; padding: 11px 12px; border-radius: 11px; background: #0b1220; border: 1px solid rgba(255,255,255,.12); color: #fff; font-size: 16px; }
    .pr-in:focus { outline: none; border-color: var(--pr-accent); box-shadow: 0 0 0 3px rgba(16,185,129,.18); }
    textarea.pr-in { resize: vertical; }
    .pr-alert { background: rgba(239,68,68,.12); color: #fca5a5; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; margin-bottom: 12px; }
    .pr-btn { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 13px; border-radius: 12px; font-size: 14px; font-weight: 700; background: var(--pr-accent); color: #05261c; cursor: pointer; }
    .pr-btn--soft { background: rgba(16,185,129,.14); color: var(--pr-accent); border: 1px solid rgba(16,185,129,.3); }
    .pr-btn:disabled { opacity: .55; cursor: not-allowed; }
    .pr-result { margin-top: 16px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 14px; }
    .pr-result-msg { font-size: 13px; font-weight: 700; color: var(--pr-accent); margin: 0 0 10px; }
    .pr-result-msg--ko { color: #fbbf24; }
    .pr-lbl { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: .03em; margin: 10px 0 6px; }
    .pr-veh { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; background: #0b1220; border: 1px solid rgba(255,255,255,.1); margin-bottom: 6px; cursor: pointer; }
    .pr-veh--on { border-color: rgba(16,185,129,.4); background: rgba(16,185,129,.06); }
    .pr-veh input { width: 18px; height: 18px; accent-color: var(--pr-accent); }
    .pr-plate { flex: 1; font-weight: 700; color: #fff; font-size: 13px; }
    .pr-seats { font-size: 12px; color: #9ca3af; }
    .pr-footer { margin-top: 16px; font-size: 11px; color: #6b7280; }
    .pr-spin { animation: pr-spin 1s linear infinite; }
    @keyframes pr-spin { to { transform: rotate(360deg); } }
    @media (max-width: 460px) { .pr-grid { grid-template-columns: 1fr; } }
  `],
})
export class PublicReservationComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ReservationBookingApiService);

  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly MapPinIcon = MapPin;
  protected readonly UsersIcon = Users;
  protected readonly CheckIcon = Check;
  protected readonly LoaderIcon = Loader;
  protected readonly SendIcon = Send;
  protected readonly SparklesIcon = Sparkles;

  private token = '';
  protected readonly link = signal<PublicReservationLinkDto | null>(null);
  protected readonly loadError = signal<string | null>(null);

  protected readonly freeText = signal('');
  protected readonly seats = signal('');
  protected readonly destination = signal('');
  protected readonly startAt = signal('');
  protected readonly endAt = signal('');
  protected readonly requesterName = signal('');
  protected readonly requesterContact = signal('');

  protected readonly searching = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly suggestion = signal<PublicReservationSuggestionDto | null>(null);
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);
  protected readonly done = signal<string | null>(null);

  protected readonly selectedCount = computed(() => this.selected().size);

  async ngOnInit(): Promise<void> {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    // Créneau par défaut : demain 09:00 → 17:00 (heure locale).
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    this.startAt.set(this.toLocal(d));
    this.endAt.set(this.toLocal(new Date(d.getTime() + 8 * 3600_000)));
    try {
      this.link.set(await firstValueFrom(this.api.getPublicLink(this.token)));
    } catch (e) {
      this.loadError.set(this.msg(e, 'Ce lien est introuvable ou a été désactivé.'));
    }
  }

  private toLocal(d: Date): string {
    const p = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  private iso(local: string): string | null {
    if (!local) return null;
    const d = new Date(local);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  protected async search(): Promise<void> {
    this.formError.set(null);
    this.suggestion.set(null);
    const startAt = this.iso(this.startAt());
    const endAt = this.iso(this.endAt());
    if (!startAt || !endAt) { this.formError.set('Renseignez le créneau.'); return; }
    this.searching.set(true);
    try {
      const seatsNum = parseInt(this.seats(), 10);
      const res = await firstValueFrom(this.api.suggest(this.token, {
        startAt, endAt,
        seatsNeeded: Number.isFinite(seatsNum) && seatsNum > 0 ? seatsNum : undefined,
        destination: this.destination().trim() || undefined,
        freeText: this.freeText().trim() || undefined,
      }));
      this.suggestion.set(res);
      // Pré-sélectionne la combinaison proposée + reflète les valeurs extraites.
      this.selected.set(new Set(res.combination.map((v) => v.vehicleId)));
      if (!this.seats()) this.seats.set(String(res.seatsNeeded));
      if (!this.destination() && res.destination) this.destination.set(res.destination);
    } catch (e) {
      this.formError.set(this.msg(e, 'Recherche impossible.'));
    } finally {
      this.searching.set(false);
    }
  }

  protected toggle(id: string): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selected.set(next);
  }

  protected async submit(): Promise<void> {
    this.submitError.set(null);
    const startAt = this.iso(this.startAt());
    const endAt = this.iso(this.endAt());
    if (!startAt || !endAt) { this.submitError.set('Créneau invalide.'); return; }
    const vehicleIds = [...this.selected()];
    if (vehicleIds.length === 0) { this.submitError.set('Choisissez au moins un véhicule.'); return; }
    this.submitting.set(true);
    try {
      const seatsNum = parseInt(this.seats(), 10);
      const res = await firstValueFrom(this.api.submit(this.token, {
        startAt, endAt, vehicleIds,
        seatsNeeded: Number.isFinite(seatsNum) && seatsNum > 0 ? seatsNum : undefined,
        destination: this.destination().trim() || undefined,
        freeText: this.freeText().trim() || undefined,
        requesterName: this.requesterName().trim() || undefined,
        requesterContact: this.requesterContact().trim() || undefined,
      }));
      this.done.set(res.message);
    } catch (e) {
      this.submitError.set(this.msg(e, 'Envoi impossible.'));
    } finally {
      this.submitting.set(false);
    }
  }

  private msg(e: unknown, fallback: string): string {
    return e instanceof HttpErrorResponse ? (e.error?.message ?? fallback) : fallback;
  }
}

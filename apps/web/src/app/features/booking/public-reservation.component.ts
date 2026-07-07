import { ChangeDetectionStrategy, Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { apiErrorMessage } from '../../core/error/api-error';
import { ActivatedRoute } from '@angular/router';
import { LucideAngularModule, MapPin, Users, Check, Loader, Send, Sparkles, Mic, MicOff } from 'lucide-angular';
import type { PublicReservationLinkDto } from '@vizyo/tracky-shared';
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
  imports: [LucideAngularModule],
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
            <p class="pr-sub">Décrivez votre besoin — {{ link()?.fleetName || 'la société' }} s'occupe du véhicule et vous confirme.</p>
          </header>

          <div class="pr-f">
            <span class="pr-voice-lbl">
              Votre besoin (texte libre)
              @if (voiceSupported()) {
                <button type="button" class="pr-mic" [class.pr-mic--on]="listening()" [disabled]="parsing()" (click)="toggleVoice()">
                  @if (parsing()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="pr-spin"></lucide-icon> Analyse… }
                  @else if (listening()) { <lucide-icon [img]="MicOffIcon" [size]="14"></lucide-icon> Arrêter }
                  @else { <lucide-icon [img]="MicIcon" [size]="14"></lucide-icon> Dicter }
                </button>
              }
            </span>
            <textarea class="pr-in" rows="2" [value]="freeText()" (input)="freeText.set($any($event.target).value)" placeholder="Ex. J'ai besoin de 11 places pour Carcassonne demain matin"></textarea>
            @if (voiceSupported()) {
              <p class="pr-voice-hint">
                @if (listening()) { <span class="pr-dot"></span> <strong>À l'écoute…</strong> dites tout d'une traite : « 11 places pour Carcassonne demain de 9h à 17h ». }
                @else { 🎤 Astuce : cliquez sur <strong>Dicter</strong> et dites votre besoin à voix haute (places, destination, date et heure) — l'IA remplit le formulaire pour vous. }
              </p>
            }
          </div>
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

          <!-- #4 — Lien PUBLIC : on n'expose AUCUN véhicule (donnée sensible). Le demandeur décrit son
               besoin + son contact et envoie ; la société choisit le véhicule et valide. -->
          <div class="pr-grid">
            <label class="pr-f"><span>Votre nom</span><input type="text" class="pr-in" [value]="requesterName()" (input)="requesterName.set($any($event.target).value)" placeholder="Nom / structure"></label>
            <label class="pr-f"><span>Contact <span class="pr-req">obligatoire</span></span><input type="text" class="pr-in" [class.pr-in--req]="!requesterContact().trim()" [value]="requesterContact()" (input)="requesterContact.set($any($event.target).value)" placeholder="E-mail ou téléphone"></label>
          </div>
          <p class="pr-hint">📩 Un e-mail ou un téléphone est <strong>obligatoire</strong> : c'est par là que {{ link()?.fleetName || 'la société' }} vous confirmera la réservation.</p>

          @if (formError()) { <div class="pr-alert">{{ formError() }}</div> }
          @if (submitError()) { <div class="pr-alert">{{ submitError() }}</div> }

          <button type="button" class="pr-btn" [disabled]="submitting() || !requesterContact().trim()" (click)="submit()">
            @if (submitting()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="pr-spin"></lucide-icon> Envoi de la demande… }
            @else { <lucide-icon [img]="SendIcon" [size]="15"></lucide-icon> Envoyer la demande }
          </button>
          <p class="pr-tiny">Votre demande part directement à {{ link()?.fleetName || 'la société' }}, qui choisit le véhicule adapté et vous répond.</p>
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
    .pr-voice-lbl { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; }
    .pr-mic { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 999px; font-size: 11.5px; font-weight: 700; background: rgba(16,185,129,.14); color: var(--pr-accent); border: 1px solid rgba(16,185,129,.3); cursor: pointer; }
    .pr-mic:disabled { opacity: .6; cursor: wait; }
    .pr-mic--on { background: rgba(239,68,68,.16); color: #fca5a5; border-color: rgba(239,68,68,.4); animation: pr-pulse 1.4s ease-in-out infinite; }
    .pr-voice-hint { font-size: 11px; color: #94a3b8; margin: 6px 0 0; line-height: 1.45; }
    .pr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin-right: 3px; animation: pr-pulse 1s ease-in-out infinite; }
    @keyframes pr-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    .pr-f > span { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
    .pr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .pr-in { width: 100%; padding: 11px 12px; border-radius: 11px; background: #0b1220; border: 1px solid rgba(255,255,255,.12); color: #fff; font-size: 16px; }
    .pr-in:focus { outline: none; border-color: var(--pr-accent); box-shadow: 0 0 0 3px rgba(16,185,129,.18); }
    textarea.pr-in { resize: vertical; }
    .pr-alert { background: rgba(239,68,68,.12); color: #fca5a5; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; margin-bottom: 12px; }
    .pr-req { font-size: 10px; font-weight: 700; color: #fbbf24; text-transform: uppercase; letter-spacing: .03em; margin-left: 4px; }
    .pr-in--req { border-color: rgba(245,158,11,.55); }
    .pr-hint { font-size: 11.5px; color: #cbd5e1; background: rgba(16,185,129,.08); border: 1px solid rgba(16,185,129,.2); padding: 9px 11px; border-radius: 9px; margin: 0 0 12px; line-height: 1.45; }
    .pr-tiny { font-size: 11px; color: #9ca3af; text-align: center; margin: 10px 0 0; line-height: 1.4; }
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
export class PublicReservationComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ReservationBookingApiService);

  protected readonly MapPinIcon = MapPin;
  protected readonly UsersIcon = Users;
  protected readonly CheckIcon = Check;
  protected readonly LoaderIcon = Loader;
  protected readonly SendIcon = Send;
  protected readonly SparklesIcon = Sparkles;
  protected readonly MicIcon = Mic;
  protected readonly MicOffIcon = MicOff;

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

  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);
  protected readonly done = signal<string | null>(null);

  // Voix (Web Speech API navigateur, fr-FR) + analyse IA du besoin dicté.
  protected readonly voiceSupported = signal(false);
  protected readonly listening = signal(false);
  protected readonly parsing = signal(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognition: any = null;

  async ngOnInit(): Promise<void> {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    const w = window as unknown as Record<string, unknown>;
    this.voiceSupported.set(!!(w['SpeechRecognition'] || w['webkitSpeechRecognition']));
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

  /**
   * #4 — Envoi de la demande PUBLIQUE : on transmet le BESOIN (places / destination / créneau /
   * contact), JAMAIS un véhicule (le demandeur n'en voit aucun). Le serveur choisit le véhicule et
   * la société valide. Loader visible pendant l'envoi.
   */
  protected async submit(): Promise<void> {
    this.submitError.set(null);
    this.formError.set(null);
    const startAt = this.iso(this.startAt());
    const endAt = this.iso(this.endAt());
    if (!startAt || !endAt) { this.submitError.set('Renseignez le créneau (début et fin).'); return; }
    if (!this.requesterContact().trim()) {
      this.submitError.set('Renseignez un e-mail ou un téléphone : il est obligatoire pour recevoir la validation.');
      return;
    }
    this.submitting.set(true);
    try {
      const seatsNum = parseInt(this.seats(), 10);
      const res = await firstValueFrom(this.api.submit(this.token, {
        startAt, endAt,
        seatsNeeded: Number.isFinite(seatsNum) && seatsNum > 0 ? seatsNum : undefined,
        destination: this.destination().trim() || undefined,
        freeText: this.freeText().trim() || undefined,
        requesterName: this.requesterName().trim() || undefined,
        requesterContact: this.requesterContact().trim() || undefined,
      }));
      this.done.set(res.message);
    } catch (e) {
      this.submitError.set(this.msg(e, 'Envoi impossible. Réessayez dans un instant.'));
    } finally {
      this.submitting.set(false);
    }
  }

  // ─── Commande vocale (Web Speech API) ───────────────────────────────────────

  ngOnDestroy(): void {
    this.stopVoice();
  }

  protected toggleVoice(): void {
    if (this.listening()) this.stopVoice();
    else this.startVoice();
  }

  /** Démarre la dictée (fr-FR) : le transcript alimente le champ « besoin » en direct. */
  private startVoice(): void {
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w['SpeechRecognition'] || w['webkitSpeechRecognition']) as (new () => Record<string, unknown>) | undefined;
    if (!Ctor) return;
    this.formError.set(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new Ctor();
    rec.lang = 'fr-FR';
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = this.freeText().trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const tr = e.results[i][0].transcript as string;
        if (e.results[i].isFinal) finalText = `${finalText} ${tr}`.trim();
        else interim += tr;
      }
      this.freeText.set(`${finalText} ${interim}`.trim());
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (e: any) => {
      this.listening.set(false);
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
        this.formError.set('Micro refusé. Autorisez le micro dans votre navigateur pour dicter votre demande.');
      }
    };
    rec.onend = () => {
      this.listening.set(false);
      this.recognition = null;
      void this.parseVoice(this.freeText().trim());
    };
    this.recognition = rec;
    this.listening.set(true);
    try { rec.start(); } catch { this.listening.set(false); }
  }

  private stopVoice(): void {
    const rec = this.recognition;
    if (rec) { try { rec.stop(); } catch { /* déjà arrêté */ } }
    this.listening.set(false);
  }

  /** Analyse IA du besoin dicté → remplit places / destination / créneau (le demandeur envoie ensuite). */
  private async parseVoice(text: string): Promise<void> {
    if (!text) return;
    this.parsing.set(true);
    try {
      const r = await firstValueFrom(this.api.parse(this.token, text));
      if (r.seatsNeeded != null) this.seats.set(String(r.seatsNeeded));
      if (r.destination) this.destination.set(r.destination);
      if (r.startAt) this.startAt.set(this.toLocal(new Date(r.startAt)));
      if (r.endAt) this.endAt.set(this.toLocal(new Date(r.endAt)));
    } catch {
      // silencieux : les champs déjà extraits suffisent ; le demandeur vérifie puis envoie.
    } finally {
      this.parsing.set(false);
    }
  }

  private msg(e: unknown, fallback: string): string {
    return apiErrorMessage(e, fallback);
  }
}

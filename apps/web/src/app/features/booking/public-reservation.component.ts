import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { apiErrorMessage } from '../../core/error/api-error';
import { ActivatedRoute } from '@angular/router';
import { LucideAngularModule, MapPin, Users, Check, Loader, Send, Sparkles, Mic, MicOff, Keyboard } from 'lucide-angular';
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
          </header>

          @if (etape() === 'dictee') {
            <!--
              LE CHEMIN PRINCIPAL (B1 § A). Cette page s'ouvre depuis un SMS, souvent debout,
              une main prise. Lui demander d'abord de remplir six champs, c'est lui demander
              le geste le plus couteux au pire moment. On demande une PHRASE.
            -->
            <h1 class="pr-h1">De quoi avez-vous besoin&nbsp;?</h1>
            <p class="pr-sub">Dites-le d'une traite. On remplit la demande pour vous, vous relisez avant d'envoyer.</p>

            <div class="pr-dictee">
              <button
                type="button"
                class="pr-mic-xl"
                [class.pr-mic-xl--on]="listening()"
                [disabled]="parsing()"
                (click)="toggleVoice()"
                [attr.aria-label]="listening() ? 'Arrêter la dictée' : 'Dicter mon besoin'">
                @if (listening()) { <span class="pr-onde"></span><span class="pr-onde pr-onde--2"></span> }
                <lucide-icon [img]="parsing() ? LoaderIcon : (listening() ? MicOffIcon : MicIcon)"
                             [size]="44" [class.pr-spin]="parsing()" />
              </button>

              <div class="pr-dictee-txt">
                @if (parsing()) {
                  <div class="pr-dictee-t">On remplit votre demande…</div>
                  <div class="pr-dictee-s">Encore un instant.</div>
                } @else if (listening()) {
                  <div class="pr-dictee-t">On vous écoute</div>
                  <div class="pr-dictee-s">Appuyez de nouveau quand vous avez fini.</div>
                } @else {
                  <div class="pr-dictee-t">Appuyez et parlez</div>
                  <div class="pr-dictee-s">Places, destination, dates — dans l'ordre que vous voulez</div>
                }
              </div>
            </div>

            <!-- La TRANSCRIPTION est visible : on doit voir que ca ecoute, et quoi. -->
            @if (freeText()) {
              <p class="pr-transcript" aria-live="polite">« {{ freeText() }} »</p>
            }

            @if (!listening() && !parsing()) {
              <div class="pr-exemples">
                <div class="pr-ex-t"><lucide-icon [img]="SparklesIcon" [size]="13" /> Exemples</div>
                <div class="pr-ex-l">« 11 places pour Carcassonne demain de 9 h à 17 h »</div>
                <div class="pr-ex-l">« Un utilitaire vendredi toute la journée, on déménage le local »</div>
              </div>

              <button type="button" class="pr-btn-2" (click)="ecrireALaPlace()">
                <lucide-icon [img]="KeyboardIcon" [size]="16" />
                {{ voiceSupported() ? 'Écrire à la place' : 'Écrire mon besoin' }}
              </button>
              @if (!voiceSupported()) {
                <p class="pr-tiny">Le micro n'est pas disponible sur cet appareil. Écrivez votre besoin en une phrase, on remplit le reste.</p>
              }
            }

            <p class="pr-tiny">{{ link()?.fleetName || 'La société' }} choisit le véhicule adapté et vous répond.</p>

          } @else {
            <h1 class="pr-h1">Relisez votre demande</h1>
            <p class="pr-sub">Corrigez ce qui ne va pas, puis envoyez.</p>

            @if (micRefuse()) {
              <div class="pr-alert pr-alert--info">
                Le micro a été refusé. Écrivez votre besoin en une phrase ci-dessous —
                on remplit le reste, et vous pouvez tout corriger.
              </div>
            } @else if (parseEchoue()) {
              <div class="pr-alert pr-alert--info">
                Nous n'avons pas réussi à comprendre votre phrase. Complétez les champs
                ci-dessous, ou <button type="button" class="pr-lien" (click)="revenirALaDictee()">réessayez la dictée</button>.
              </div>
            }

            <label class="pr-f">
              <span>Votre besoin, en une phrase</span>
              <textarea class="pr-in" rows="2" [value]="freeText()" (input)="freeText.set($any($event.target).value)"
                        placeholder="Ex. 11 places pour Carcassonne demain de 9 h à 17 h"></textarea>
            </label>

            <div class="pr-grid">
              <label class="pr-f">
                <span><lucide-icon [img]="UsersIcon" [size]="12" /> Places @if (estDicte('seats')) { <em class="pr-dit">dicté</em> }</span>
                <input type="number" min="1" class="pr-in" [value]="seats()" (input)="seats.set($any($event.target).value)" placeholder="ex. 11">
              </label>
              <label class="pr-f">
                <span><lucide-icon [img]="MapPinIcon" [size]="12" /> Destination @if (estDicte('destination')) { <em class="pr-dit">dicté</em> }</span>
                <input type="text" class="pr-in" [value]="destination()" (input)="destination.set($any($event.target).value)" placeholder="ex. Carcassonne">
              </label>
            </div>
            <div class="pr-grid">
              <label class="pr-f">
                <span>Début @if (estDicte('startAt')) { <em class="pr-dit">dicté</em> }</span>
                <input type="datetime-local" class="pr-in" [value]="startAt()" (input)="startAt.set($any($event.target).value)">
              </label>
              <label class="pr-f">
                <span>Fin @if (estDicte('endAt')) { <em class="pr-dit">dicté</em> }</span>
                <input type="datetime-local" class="pr-in" [value]="endAt()" (input)="endAt.set($any($event.target).value)">
              </label>
            </div>

            <!-- #4 — Lien PUBLIC : on n'expose AUCUN véhicule (donnée sensible). Le demandeur décrit son
                 besoin + son contact et envoie ; la société choisit le véhicule et valide. -->
            <div class="pr-grid">
              <label class="pr-f"><span>Votre nom</span>
                <input type="text" class="pr-in" [value]="requesterName()" (input)="requesterName.set($any($event.target).value)" placeholder="Nom / structure"></label>
              <label class="pr-f"><span>Contact</span>
                <input type="text" class="pr-in" [class.pr-in--req]="contactManquant()" [value]="requesterContact()"
                       (input)="requesterContact.set($any($event.target).value)" placeholder="E-mail ou téléphone"></label>
            </div>

            <!--
              LE CONTACT MANQUANT SE DIT AVANT LE BOUTON, pas apres un envoi refuse. C'est la
              seule chose qui empeche la demande de partir : la decouvrir au moment d'envoyer
              est une perte seche pour quelqu'un qui a deja tout dicte.
            -->
            @if (contactManquant()) {
              <div class="pr-manque">
                <div class="pr-manque-t">Il manque votre contact</div>
                <p>C'est par là que {{ link()?.fleetName || 'la société' }} vous confirmera. Sans contact, la demande ne peut pas partir.</p>
              </div>
            }

            @if (formError()) { <div class="pr-alert">{{ formError() }}</div> }
            @if (submitError()) { <div class="pr-alert">{{ submitError() }}</div> }

            <button type="button" class="pr-btn" [disabled]="submitting() || contactManquant()" (click)="submit()">
              @if (submitting()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="pr-spin" /> Envoi de la demande… }
              @else { <lucide-icon [img]="SendIcon" [size]="15" /> Envoyer la demande }
            </button>

            <!-- Dit enfin, au lieu d'etre devine : le demandeur ne choisit pas le vehicule. -->
            <div class="pr-pasvous">
              <div class="pr-pasvous-t">Ce que vous ne choisissez pas</div>
              <p>Le véhicule. {{ link()?.fleetName || 'La société' }} choisit celui qui correspond à votre besoin, puis vous confirme.</p>
            </div>
          }
        }
      </div>
      <p class="pr-footer">Propulsé par Tracky</p>
    </div>
  `,
  styles: [`
    /*
     * Page PUBLIQUE (hors shell, hors auth) — mais elle reste du Vizyo Tracky : elle vit
     * desormais sur les JETONS du systeme, pas sur une palette privee. Elle portait 40+
     * couleurs en dur (bleus, verts, gris) qui ne suivaient aucun theme.
     */
    .pr-page {
      min-height: 100dvh; background: var(--bg-primary); color: var(--fg-primary);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 20px 14px;
    }
    .pr-card {
      width: 100%; max-width: 520px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: 18px; padding: 22px;
    }
    .pr-state { text-align: center; padding: 30px 10px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .pr-ok {
      width: 60px; height: 60px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent); color: var(--texte-succes);
    }
    .pr-head { margin-bottom: 14px; }
    .pr-brand {
      display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700;
      color: var(--texte-succes); text-transform: uppercase; letter-spacing: .04em;
    }
    .pr-h1 { font-size: 24px; font-weight: 800; letter-spacing: -.03em; line-height: 1.18; margin: 6px 0 0; color: var(--fg-primary); }
    .pr-sub { font-size: 13.5px; line-height: 1.5; color: var(--fg-secondary); margin: 9px 0 0; text-wrap: pretty; }

    /* La dictee : le chemin principal */
    .pr-dictee { display: flex; flex-direction: column; align-items: center; gap: 15px; padding: 34px 0 0; }
    /*
     * 112 px — la valeur de la planche, et elle se justifie : c'est une cible qu'on vise
     * d'un pouce, debout, sans regarder. Le minimum de 44 px est un plancher pour une
     * commande ordinaire, pas pour LE geste de l'ecran.
     */
    .pr-mic-xl {
      position: relative; display: flex; align-items: center; justify-content: center;
      width: 112px; height: 112px; border-radius: 50%; border: none; cursor: pointer;
      background: var(--color-tracky-light); color: var(--accent-ink);
    }
    .pr-mic-xl:disabled { cursor: wait; }
    .pr-mic-xl--on {
      background: color-mix(in srgb, var(--danger) 14%, transparent);
      border: 2px solid var(--danger); color: var(--texte-alerte);
      animation: pr-pulse 1.4s ease-in-out infinite;
    }
    .pr-onde {
      position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--danger);
      animation: pr-onde 2.4s ease-out infinite; pointer-events: none;
    }
    .pr-onde--2 { animation-delay: 1.2s; }
    @keyframes pr-onde { 0% { transform: scale(1); opacity: .7 } 100% { transform: scale(1.6); opacity: 0 } }
    @keyframes pr-pulse { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
    @media (prefers-reduced-motion: reduce) {
      .pr-onde, .pr-mic-xl--on, .pr-spin { animation: none; }
    }
    .pr-dictee-txt { text-align: center; }
    .pr-dictee-t { font-size: 16px; font-weight: 800; color: var(--fg-primary); }
    .pr-dictee-s { font-size: 12.5px; color: var(--fg-secondary); margin-top: 4px; text-wrap: pretty; }
    .pr-transcript {
      margin: 16px 0 0; padding: 11px 13px; border-radius: 12px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      font-size: 13.5px; line-height: 1.5; color: var(--fg-primary); text-wrap: pretty;
    }

    .pr-exemples {
      margin-top: 22px; padding: 13px 15px; border-radius: 16px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
    }
    .pr-ex-t {
      display: flex; align-items: center; gap: 7px; margin-bottom: 8px;
      font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
      color: var(--fg-secondary);
    }
    .pr-ex-t lucide-icon { color: var(--texte-succes); }
    .pr-ex-l { font-size: 12.5px; line-height: 1.45; color: var(--fg-secondary); margin-top: 7px; }

    /* Relecture */
    .pr-f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--fg-secondary); margin-bottom: 12px; }
    .pr-f > span { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
    .pr-dit {
      font-style: normal; font-size: 10px; font-weight: 800; letter-spacing: .03em;
      text-transform: uppercase; padding: 1px 6px; border-radius: 999px;
      background: color-mix(in srgb, var(--color-tracky-light) 14%, transparent); color: var(--texte-succes);
    }
    .pr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .pr-in {
      width: 100%; min-height: 44px; padding: 11px 12px; border-radius: 11px;
      background: var(--bg-primary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-size: 16px; font-family: inherit;
    }
    .pr-in:focus { outline: none; border-color: var(--color-tracky-light); }
    textarea.pr-in { resize: vertical; }
    .pr-in--req { border-color: color-mix(in srgb, var(--warning) 55%, transparent); }

    .pr-manque {
      padding: 11px 13px; border-radius: 12px; margin-bottom: 12px;
      background: color-mix(in srgb, var(--warning) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--warning) 32%, transparent);
    }
    .pr-manque-t { font-size: 13px; font-weight: 800; color: var(--texte-attente); }
    .pr-manque p { margin: 4px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--fg-secondary); text-wrap: pretty; }

    .pr-pasvous { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
    .pr-pasvous-t {
      font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
      color: var(--fg-secondary);
    }
    .pr-pasvous p { margin: 5px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); text-wrap: pretty; }

    .pr-alert {
      background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--texte-alerte);
      padding: 10px 12px; border-radius: 10px; font-size: 12.5px; line-height: 1.5;
      margin-bottom: 12px; text-wrap: pretty;
    }
    .pr-alert--info {
      background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--fg-primary);
      border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    }
    .pr-lien {
      background: none; border: none; padding: 0; font: inherit; cursor: pointer;
      color: var(--texte-succes); text-decoration: underline;
    }

    .pr-tiny { font-size: 12px; color: var(--fg-secondary); text-align: center; margin: 14px 0 0; line-height: 1.45; text-wrap: pretty; }
    .pr-btn {
      width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 48px; padding: 13px; border-radius: 12px; border: none;
      font-size: 14px; font-weight: 700; font-family: inherit;
      background: var(--color-tracky-light); color: var(--accent-ink); cursor: pointer;
    }
    .pr-btn:disabled { opacity: .55; cursor: not-allowed; }
    .pr-btn-2 {
      width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 9px;
      min-height: 46px; margin-top: 18px; border-radius: 13px;
      background: var(--bg-tertiary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-size: 13.5px; font-weight: 700; font-family: inherit; cursor: pointer;
    }
    .pr-footer { margin-top: 16px; font-size: 11.5px; color: var(--fg-secondary); }
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
  protected readonly KeyboardIcon = Keyboard;

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

  /**
   * L'écran courant. `dictee` est le CHEMIN PRINCIPAL (B1 § A : « la dictée devient le chemin
   * principal ») ; `revue` est l'écran où l'on relit et corrige. Le formulaire ne disparaît
   * pas — il cesse d'être la première chose demandée à quelqu'un debout dans la rue, qui a
   * ouvert le lien depuis un SMS.
   */
  protected readonly etape = signal<'dictee' | 'revue'>('dictee');
  /** Champs remplis par la dictée — marqués « · dicté » pour savoir quoi relire. */
  protected readonly dictes = signal<Set<string>>(new Set());
  /** L'analyse n'a rien pu extraire : on le dit, plutôt que d'afficher un formulaire vide. */
  protected readonly parseEchoue = signal(false);
  /** Le micro a été refusé : le repli clavier devient la seule route, et on l'explique. */
  protected readonly micRefuse = signal(false);
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
      swallow('public-reservation:ngOnInit', e);
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
      swallow('public-reservation:submit', e);
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
        // Cul-de-sac evite : on ne se contente pas de dire « refuse », on bascule sur la
        // route qui reste ouverte — le clavier — et on l'annonce.
        this.micRefuse.set(true);
        this.etape.set('revue');
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

  /**
   * Analyse IA du besoin dicté → remplit places / destination / créneau.
   *
   * On MEMORISE quels champs viennent de la dictée (`dictes`) : la planche les marque
   * « · dicté ». Ce n'est pas décoratif — c'est ce qui permet au demandeur de savoir quoi
   * relire. Un champ qu'il a tapé lui-même n'a pas besoin d'être vérifié ; un champ deviné
   * par une machine, si.
   */
  private async parseVoice(text: string): Promise<void> {
    if (!text) return;
    this.parsing.set(true);
    this.parseEchoue.set(false);
    try {
      const r = await firstValueFrom(this.api.parse(this.token, text));
      const vus = new Set<string>();
      if (r.seatsNeeded != null) { this.seats.set(String(r.seatsNeeded)); vus.add('seats'); }
      if (r.destination) { this.destination.set(r.destination); vus.add('destination'); }
      if (r.startAt) { this.startAt.set(this.toLocal(new Date(r.startAt))); vus.add('startAt'); }
      if (r.endAt) { this.endAt.set(this.toLocal(new Date(r.endAt))); vus.add('endAt'); }
      this.dictes.set(vus);
      // Rien compris ? On le DIT, au lieu de laisser un formulaire vide qui a l'air casse.
      if (vus.size === 0) this.parseEchoue.set(true);
    } catch (err) {
      swallow('public-reservation:parseVoice', err);
      this.parseEchoue.set(true);
    } finally {
      this.parsing.set(false);
      // Quoi qu'il arrive, on passe a la RELECTURE : le texte dicte est deja saisi, et
      // laisser le demandeur sur l'ecran du micro apres avoir parle est un cul-de-sac.
      this.etape.set('revue');
    }
  }

  /** Passer au clavier — le repli quand le micro est refusé, indisponible, ou pas voulu. */
  protected ecrireALaPlace(): void {
    this.stopVoice();
    this.etape.set('revue');
  }

  protected revenirALaDictee(): void {
    this.parseEchoue.set(false);
    this.etape.set('dictee');
  }

  /** Le contact manque-t-il ? Signalé AVANT le bouton, jamais après un envoi refusé. */
  protected readonly contactManquant = computed(() => !this.requesterContact().trim());

  protected estDicte(champ: string): boolean {
    return this.dictes().has(champ);
  }

  private msg(e: unknown, fallback: string): string {
    return apiErrorMessage(e, fallback);
  }
}

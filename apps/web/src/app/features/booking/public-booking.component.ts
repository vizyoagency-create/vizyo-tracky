import { apiErrorMessage } from '../../core/error/api-error';
import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type {
  BookingDayDto,
  BookingSlotDto,
  BookingVisitEventType,
  CreatePublicBookingDto,
  DecouverteVideoDto,
  InstallationEnergy,
  PublicBookingLinkDto,
} from '@vizyo/tracky-shared';
import {
  BellRing, CalendarX, CheckCircle2, ChartColumn, CirclePlay, ExternalLink, Lock, LucideAngularModule,
  Mail, Phone, Radar, SearchX, Settings2, Warehouse,
} from 'lucide-angular';
import { InstallationBookingApiService } from '../../core/services/installation-booking.service';

/**
 * Page PUBLIQUE de réservation de créneau d'installation (hors auth). Le client ouvre
 * `/book/<token>`, dit COMBIEN de véhicules il équipe (la grille s'adapte : 2 h par véhicule),
 * choisit un jour puis un créneau LIBRE, renseigne ses coordonnées — nom, e-mail ET téléphone,
 * toujours demandés depuis le lot A, pré-remplis sur un lien nominatif — décrit chaque véhicule
 * (tout facultatif : il ne sait pas toujours) et dépose sa demande. Page autonome (hors shell
 * authentifié) → styles complets ici, charte émeraude/Manrope.
 *
 * ┌─ CE QUE LA PAGE RACONTE À L'ATELIER ────────────────────────────────────────────────┐
 * │ Chaque ouverture est une VISITE côté serveur (appareil, provenance, IP tronquée), et  │
 * │ la page y ajoute ses gestes : jour regardé, créneau choisi, vidéo ouverte, appel…     │
 * │ `trace()` est best-effort : un suivi qui échoue ne change rien pour le client.        │
 * │ La visite est rendue par le GET et REPASSÉE au rechargement, pour qu'un « ce créneau  │
 * │ vient d'être pris » ne compte pas pour un deuxième client.                             │
 * └───────────────────────────────────────────────────────────────────────────────────────┘
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
            <a class="pb-sortie" [href]="mailtoNouveauLien()" (click)="trace('courriel', 'nouveau-lien')">
              <lucide-icon [img]="MailIcon" [size]="15" /> Demander un nouveau lien
            </a>
          </div>
        } @else if (link()?.closed) {
          <div class="pb-state">
            <span class="pb-ico pb-ico--warn"><lucide-icon [img]="LockIcon" [size]="26" /></span>
            <h1>Réservation indisponible</h1>
            <p>{{ link()?.closedReason || 'Ce lien de réservation est fermé.' }}</p>
            <div class="pb-sorties pb-sorties--centre">
              @if (link()?.telephonePublic; as tel) {
                <a class="pb-sortie" [href]="telHref(tel)" (click)="trace('appel')">
                  <lucide-icon [img]="PhoneIcon" [size]="15" /> Appeler l'atelier
                </a>
              }
              <a class="pb-sortie pb-sortie--discret" [href]="mailtoNouveauLien()" (click)="trace('courriel', 'nouveau-lien')">
                <lucide-icon [img]="MailIcon" [size]="15" /> Demander un nouveau lien
              </a>
            </div>
          </div>
        } @else if (done()) {
          <div class="pb-state">
            <span class="pb-ico pb-ico--ok"><lucide-icon [img]="CheckIcon" [size]="26" /></span>
            <h1>Demande envoyée</h1>
            <p class="pb-slot-ok">{{ confirmedLabel() }}</p>
            <p>Votre demande a bien été transmise. Vous recevrez un e-mail dès que le créneau sera confirmé.</p>
            <a class="pb-sortie pb-sortie--discret" [href]="mailtoQuestion()" (click)="trace('courriel', 'question')">
              <lucide-icon [img]="MailIcon" [size]="15" /> Une question sur ce rendez-vous&nbsp;?
            </a>
          </div>
        } @else {
          <div class="pb-body">
            <h1 class="pb-title">Réservez votre installation</h1>
            <p class="pb-sub">
              {{ link()?.companyName }} · {{ dureeLisible() }} par véhicule
              @if (link()?.weekendOuvert) { <span class="pb-pill">week-end possible</span> }
            </p>

            <!-- Combien de véhicules : la grille dépend de la réponse (n × 2 h). -->
            @if (maxVehicles() > 1) {
              <div class="pb-label">{{ etape(0) }} · Combien de véhicules à équiper&nbsp;?</div>
              <div class="pb-nb">
                @for (n of choixVehicules(); track n) {
                  <button type="button" class="pb-nb-b" [class.on]="vehicleCount() === n" [disabled]="rechargement()" (click)="choisirNombre(n)">
                    {{ n }}
                  </button>
                }
                <span class="pb-nb-d">{{ vehicleCount() }} véhicule{{ vehicleCount() > 1 ? 's' : '' }} · rendez-vous de {{ dureeTotaleLisible() }}</span>
              </div>
            }

            @if (days().length === 0) {
              <!-- « Reessayez plus tard » n'est pas une sortie : rien ne dit quand, ni a qui parler. -->
              <div class="pb-state pb-state--inline">
                <span class="pb-ico pb-ico--warn"><lucide-icon [img]="CalendarIcon" [size]="26" /></span>
                <h1>Aucun créneau ouvert pour l'instant</h1>
                <p>Les prochaines dates ne sont pas encore publiées. Trois façons d'avancer quand même&nbsp;:</p>
              </div>
            } @else {
              <!-- Jours -->
              <div class="pb-label">{{ etape(1) }} · Choisissez un jour</div>
              <div class="pb-days" [class.pb-days--rechargement]="rechargement()">
                @for (d of days(); track d.date) {
                  <button type="button" class="pb-day" [class.on]="selectedDate() === d.date" [class.we]="d.weekend" (click)="selectDay(d.date)">
                    <span class="pb-day-l">{{ d.label }}</span>
                    <span class="pb-day-n">{{ d.slots.length }} créneau{{ d.slots.length > 1 ? 'x' : '' }}</span>
                    @if (d.weekend) { <span class="pb-day-we">week-end</span> }
                  </button>
                }
              </div>

              <!-- Créneaux -->
              @if (selectedDay(); as day) {
                <div class="pb-label">{{ etape(2) }} · Choisissez un créneau</div>
                <div class="pb-slots">
                  @for (s of day.slots; track s.startAt) {
                    <button type="button" class="pb-slot" [class.on]="selectedSlot()?.startAt === s.startAt" (click)="selectSlot(s)">{{ s.label }}</button>
                  }
                </div>
              }

              <!-- Formulaire -->
              @if (selectedSlot()) {
                <div class="pb-label">{{ etape(3) }} · Vos coordonnées</div>
                <div class="pb-form" (focusin)="formulaireTouche()">
                  @if (link()?.prefill?.name) {
                    <div class="pb-known">Bonjour <strong>{{ link()?.prefill?.name }}</strong> — vérifiez vos coordonnées, c'est là que la confirmation arrive.</div>
                  }
                  <label class="pb-f"><span>Nom complet *</span><input class="pb-in" autocomplete="name" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="Prénom Nom"></label>
                  <label class="pb-f"><span>E-mail *</span><input class="pb-in" type="email" autocomplete="email" inputmode="email" [value]="email()" (input)="email.set($any($event.target).value)" placeholder="vous@exemple.fr"></label>
                  <label class="pb-f"><span>Téléphone *</span><input class="pb-in" type="tel" autocomplete="tel" inputmode="tel" [value]="phone()" (input)="phone.set($any($event.target).value)" placeholder="06 12 34 56 78"><small class="pb-aide-champ">Pour vous joindre la veille si besoin.</small></label>
                  <label class="pb-f"><span>Adresse (lieu de pose)</span><input class="pb-in" autocomplete="street-address" [value]="address()" (input)="address.set($any($event.target).value)" placeholder="12 rue…, 31000 Toulouse"></label>
                </div>

                <div class="pb-label">{{ etape(4) }} · {{ vehicleCount() > 1 ? 'Vos véhicules' : 'Votre véhicule' }} <span class="pb-label-opt">— si vous les connaissez</span></div>
                @for (v of vehicleRows(); track $index; let i = $index) {
                  <div class="pb-veh">
                    @if (vehicleCount() > 1) { <div class="pb-veh-t">Véhicule {{ i + 1 }}</div> }
                    <div class="pb-form pb-form--veh">
                      <label class="pb-f"><span>Immatriculation</span><input class="pb-in" [value]="v.plate" (input)="majVehicule(i, 'plate', $any($event.target).value)" placeholder="AB-123-CD" autocapitalize="characters"></label>
                      <label class="pb-f"><span>Marque / modèle</span><input class="pb-in" [value]="v.vehicle" (input)="majVehicule(i, 'vehicle', $any($event.target).value)" placeholder="Renault Kangoo"></label>
                      <label class="pb-f"><span>Énergie</span>
                        <select class="pb-in" (change)="majVehicule(i, 'energy', $any($event.target).value)">
                          <option value="" [selected]="!v.energy">—</option>
                          @for (e of ENERGIES; track e.value) { <option [value]="e.value" [selected]="v.energy === e.value">{{ e.label }}</option> }
                        </select>
                      </label>
                    </div>
                  </div>
                }
                <div class="pb-form">
                  <label class="pb-f pb-f--full"><span>Remarque (optionnel)</span><textarea class="pb-in pb-ta" [value]="notes()" (input)="notes.set($any($event.target).value)" rows="2" placeholder="Une précision utile ? (accès, horaires, contact sur place…)"></textarea></label>
                </div>

                @if (error()) { <div class="pb-err">{{ error() }}</div> }
                <button type="button" class="pb-submit" [disabled]="submitting()" (click)="submit()">
                  {{ submitting() ? 'Envoi…' : 'Confirmer ma demande' }}
                </button>
                <p class="pb-legal">Créneau choisi : <strong>{{ selectedSlot()?.label }}</strong> · {{ selectedDayLabel() }}@if (vehicleCount() > 1) { · {{ vehicleCount() }} véhicules }</p>
              }
            }

            <!--
              LES SORTIES (B1 § A) : « être prévenu, appeler, redemander un lien ». Toutes trois
              réelles maintenant — l'API porte le téléphone de l'atelier et l'abonnement.
            -->
            <section class="pb-aide" [class.pb-aide--seule]="days().length === 0">
              @if (days().length > 0) { <div class="pb-aide-t">Aucun créneau ne vous convient&nbsp;?</div> }
              <div class="pb-sorties">
                @if (link()?.telephonePublic; as tel) {
                  <a class="pb-sortie pb-sortie--discret" [href]="telHref(tel)" (click)="trace('appel')">
                    <lucide-icon [img]="PhoneIcon" [size]="15" /> Appeler l'atelier · {{ tel }}
                  </a>
                }
                @if (link()?.abonnementCreneauDisponible) {
                  @if (!abonnementOuvert()) {
                    <button type="button" class="pb-sortie pb-sortie--discret" (click)="abonnementOuvert.set(true)">
                      <lucide-icon [img]="BellIcon" [size]="15" /> Me prévenir si un créneau se libère
                    </button>
                  }
                }
                <a class="pb-sortie pb-sortie--discret" [href]="mailtoCreneau()" (click)="trace('courriel', 'creneau')">
                  <lucide-icon [img]="MailIcon" [size]="15" /> Demander un autre créneau
                </a>
              </div>

              @if (abonnementOuvert() && link()?.abonnementCreneauDisponible) {
                <div class="pb-abo">
                  @if (abonnementFait()) {
                    <div class="pb-abo-ok"><lucide-icon [img]="CheckIcon" [size]="15" /> C'est noté. On vous écrit dès qu'un créneau se libère — et seulement pour ça.</div>
                  } @else {
                    <label class="pb-f pb-f--full"><span>Votre e-mail — rien d'autre n'est demandé</span>
                      <input class="pb-in" type="email" [value]="aboEmail()" (input)="aboEmail.set($any($event.target).value)" placeholder="vous@exemple.fr">
                    </label>
                    @if (aboError()) { <div class="pb-err">{{ aboError() }}</div> }
                    <div class="pb-abo-btns">
                      <button type="button" class="pb-submit pb-submit--compact" [disabled]="aboSending()" (click)="prevenirMoi()">
                        {{ aboSending() ? 'Envoi…' : 'Me prévenir' }}
                      </button>
                      <button type="button" class="pb-lien" (click)="abonnementOuvert.set(false)">Annuler</button>
                    </div>
                    <p class="pb-tiny">Adresse conservée 90 jours au plus, puis effacée.</p>
                  }
                </div>
              }
            </section>
          </div>
        }

        <!--
          DÉCOUVRIR TRACKY. Le client tient un lien de RDV : il attend une pose, il n'a pas
          encore d'accès. C'est le moment où il se demande « ça ressemble à quoi ? » — les
          scènes de la vitrine répondent, sans compte. Visible aussi après la demande envoyée.
        -->
        @if (link() && !notFound()) {
          <section class="pb-dec">
            <div class="pb-dec-head">
              <div class="pb-label pb-label--dec">En attendant la pose · Découvrir Tracky</div>
              <p class="pb-dec-sub">À quoi ressemble ce qu'on va installer&nbsp;: quatre scènes de deux minutes, sans compte à créer.</p>
            </div>
            <div class="pb-videos">
              @for (v of link()!.decouverte.videos; track v.id) {
                <a class="pb-video" [href]="v.url" target="_blank" rel="noopener" (click)="trace('decouverte', 'video:' + v.id)">
                  <span class="pb-video-ico"><lucide-icon [img]="iconeVideo(v)" [size]="18" /></span>
                  <span class="pb-video-txt">
                    <span class="pb-video-t"><lucide-icon [img]="PlayIcon" [size]="13" /> {{ v.titre }}</span>
                    <span class="pb-video-d">{{ v.description }}</span>
                  </span>
                </a>
              }
            </div>
            <div class="pb-dec-liens">
              <a [href]="link()!.decouverte.presentationUrl" target="_blank" rel="noopener" (click)="trace('decouverte', 'presentation')">
                <lucide-icon [img]="ExternalIcon" [size]="13" /> Toute la présentation
              </a>
              <a [href]="link()!.decouverte.depotUrl" target="_blank" rel="noopener" (click)="trace('decouverte', 'depot')">
                <lucide-icon [img]="WarehouseIcon" [size]="13" /> Vous recevez des livraisons&nbsp;? L'espace dépôt
              </a>
            </div>
          </section>
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
    .pb-sub { margin:0 0 22px; font-size:14px; color:var(--fg-secondary); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .pb-pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:.02em; background:color-mix(in srgb, var(--color-tracky-light) 14%, transparent); color:var(--texte-succes); border:1px solid color-mix(in srgb, var(--color-tracky-light) 30%, transparent); }
    .pb-label { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--fg-secondary); margin:22px 0 10px; }
    .pb-days { display:flex; gap:8px; overflow-x:auto; padding-bottom:6px; scrollbar-width:thin; }
    /* « display » posé EXPLICITEMENT : le style global passe tout <button> en inline-flex sous 768px,
       ce qui mettait le jour et son nombre de créneaux côte à côte sur téléphone. */
    .pb-day { position:relative; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; flex:0 0 auto; min-width:92px; padding:11px 12px; border-radius:12px; border:1px solid var(--border-strong); background:var(--bg-tertiary); color:var(--fg-primary); cursor:pointer; text-align:left; transition:.15s; }
    .pb-day:hover { border-color:color-mix(in srgb, var(--color-tracky-light) 50%, transparent); }
    .pb-day.on { border-color:var(--color-tracky-light); background:color-mix(in srgb, var(--color-tracky-light) 10%, transparent); }
    .pb-day.we { border-style:dashed; }
    .pb-day.we.on { border-style:solid; }
    .pb-day-l { display:block; font-size:13px; font-weight:700; text-transform:capitalize; }
    .pb-day-n { display:block; font-size:11px; color:var(--fg-secondary); margin-top:2px; }
    .pb-day-we { display:block; margin-top:6px; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--texte-succes); }
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
    .pb-aide-champ { font-size:11.5px; color:var(--fg-secondary); }
    .pb-label-opt { font-weight:500; text-transform:none; letter-spacing:0; }
    /* Nombre de véhicules */
    .pb-nb { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
    .pb-nb-b { display:inline-flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; padding:0 14px; border-radius:12px; border:1px solid var(--border-strong); background:var(--bg-tertiary); color:var(--fg-primary); font-size:15px; font-weight:800; cursor:pointer; transition:.15s; font-family:inherit; }
    .pb-nb-b:hover { border-color:color-mix(in srgb, var(--color-tracky-light) 50%, transparent); }
    .pb-nb-b.on { border-color:var(--color-tracky-light); background:color-mix(in srgb, var(--color-tracky-light) 14%, transparent); color:var(--texte-succes); }
    .pb-nb-b:disabled { opacity:.6; cursor:default; }
    .pb-nb-d { font-size:12.5px; color:var(--fg-secondary); margin-left:4px; }
    .pb-days--rechargement { opacity:.5; pointer-events:none; }
    /* Un bloc par véhicule */
    .pb-veh { margin-bottom:10px; padding:12px 14px; border-radius:12px; border:1px solid var(--border-subtle); background:color-mix(in srgb, var(--bg-tertiary) 55%, transparent); }
    .pb-veh-t { font-size:12px; font-weight:800; letter-spacing:.02em; color:var(--fg-primary); margin-bottom:8px; }
    .pb-form--veh { grid-template-columns:1fr 1fr 1fr; }
    select.pb-in { appearance:auto; }
    .pb-submit { width:100%; margin-top:18px; padding:15px; border:none; border-radius:12px; background:var(--color-tracky-light); color:var(--accent-ink); font-size:15px; font-weight:800; cursor:pointer; }
    .pb-submit:disabled { opacity:.6; cursor:default; }
    .pb-submit--compact { width:auto; margin-top:0; padding:0 18px; min-height:44px; font-size:14px; }
    .pb-legal { margin:12px 0 0; font-size:12px; color:var(--fg-secondary); text-align:center; }
    .pb-err { margin-top:14px; padding:11px 14px; border-radius:10px; background:color-mix(in srgb, var(--danger) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger) 30%, transparent); color:var(--texte-alerte); font-size:13px; }
    .pb-state { padding:44px 26px; text-align:center; }
    .pb-state h1 { margin:0 0 8px; font-size:22px; font-weight:800; color:var(--fg-primary); }
    .pb-state p { margin:0 auto; max-width:360px; font-size:14px; line-height:1.6; color:var(--fg-secondary); }
    .pb-slot-ok { color:var(--texte-succes) !important; font-weight:700; margin-bottom:10px !important; }
    .pb-spin { width:34px; height:34px; margin:0 auto 14px; border:3px solid color-mix(in srgb, var(--color-tracky-light) 20%, transparent); border-top-color:var(--color-tracky-light); border-radius:50%; animation:pbspin .8s linear infinite; }
    @keyframes pbspin { to { transform:rotate(360deg); } }
    .pb-foot { margin-top:18px; font-size:11.5px; color:var(--fg-secondary); }
    @media (max-width:520px) { .pb-form, .pb-form--veh { grid-template-columns:1fr; } }

    /* Cibles tactiles : cette page s'ouvre au téléphone, depuis un SMS. */
    .pb-day, .pb-slot { min-height:44px; }
    .pb-in { min-height:44px; }
    .pb-submit { min-height:48px; }

    /*
     * LES SORTIES. Les ecrans d'echec disaient ce qui n'allait pas et s'arretaient la : sans
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
      font-size:14px; font-weight:700; text-decoration:none; cursor:pointer; font-family:inherit;
    }
    .pb-sortie--discret {
      background:transparent; border:1px solid var(--border-strong); color:var(--fg-primary);
    }
    .pb-state--inline { padding:24px 8px 4px; }
    .pb-sorties { display:flex; flex-wrap:wrap; gap:8px; }
    .pb-sorties .pb-sortie { margin-top:0; }
    .pb-sorties--centre { justify-content:center; margin-top:18px; }
    .pb-aide { margin-top:26px; padding-top:18px; border-top:1px solid var(--border-subtle); }
    .pb-aide--seule { border-top:none; padding-top:0; margin-top:8px; }
    .pb-aide-t { font-size:13px; font-weight:700; color:var(--fg-primary); margin-bottom:10px; }
    .pb-abo { margin-top:12px; padding:14px; border-radius:12px; background:var(--bg-tertiary); border:1px solid var(--border-subtle); display:grid; gap:10px; }
    .pb-abo-btns { display:flex; align-items:center; gap:12px; }
    .pb-abo-ok { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--texte-succes); font-weight:600; }
    .pb-lien { background:none; border:none; padding:0; color:var(--fg-secondary); font-size:13px; text-decoration:underline; cursor:pointer; font-family:inherit; min-height:44px; }
    .pb-tiny { margin:0; font-size:11.5px; color:var(--fg-secondary); }

    /* Découvrir Tracky */
    .pb-dec { padding:20px 26px 26px; border-top:1px solid var(--border-subtle); background:color-mix(in srgb, var(--bg-tertiary) 55%, transparent); }
    .pb-label--dec { margin-top:0; }
    .pb-dec-sub { margin:0 0 14px; font-size:13px; line-height:1.5; color:var(--fg-secondary); }
    .pb-videos { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .pb-video { display:flex; gap:12px; align-items:flex-start; padding:12px; border-radius:12px; border:1px solid var(--border-strong); background:var(--bg-secondary); text-decoration:none; color:var(--fg-primary); transition:.15s; min-height:44px; }
    .pb-video:hover { border-color:var(--color-tracky-light); }
    .pb-video-ico { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px; border-radius:11px; background:color-mix(in srgb, var(--color-tracky-light) 12%, transparent); color:var(--texte-succes); }
    .pb-video-txt { display:flex; flex-direction:column; gap:3px; min-width:0; }
    .pb-video-t { display:inline-flex; align-items:center; gap:5px; font-size:13.5px; font-weight:800; letter-spacing:-.01em; }
    .pb-video-d { font-size:12px; line-height:1.45; color:var(--fg-secondary); }
    .pb-dec-liens { display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:14px; }
    .pb-dec-liens a { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; color:var(--texte-succes); text-decoration:none; min-height:32px; }
    .pb-dec-liens a:hover { text-decoration:underline; }
    @media (max-width:520px) { .pb-videos { grid-template-columns:1fr; } }
  `],
})
export class PublicBookingComponent implements OnInit {
  protected readonly SearchXIcon = SearchX;
  protected readonly LockIcon = Lock;
  protected readonly CheckIcon = CheckCircle2;
  protected readonly CalendarIcon = CalendarX;
  protected readonly MailIcon = Mail;
  protected readonly PhoneIcon = Phone;
  protected readonly BellIcon = BellRing;
  protected readonly PlayIcon = CirclePlay;
  protected readonly ExternalIcon = ExternalLink;
  protected readonly WarehouseIcon = Warehouse;

  /** Une icône par scène : la vitrine les présente ainsi, on garde la même lecture. */
  protected iconeVideo(v: DecouverteVideoDto) {
    switch (v.id) {
      case 'supervision': return Radar;
      case 'analyse': return ChartColumn;
      case 'administration': return Settings2;
      default: return Warehouse;
    }
  }

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
      `Bonjour,\n\nAucun des créneaux proposés ne me convient${societe ? ` (${societe})` : ''}. Pouvez-vous me proposer une autre date ?\n\nMerci.`,
    );
  }
  protected mailtoQuestion(): string {
    return this.mailto(
      'Question sur mon rendez-vous d\'installation',
      `Bonjour,\n\nJ'ai une question sur mon rendez-vous (${this.confirmedLabel()}).\n\nMerci.`,
    );
  }
  protected telHref(tel: string): string {
    return `tel:${tel.replace(/[^+\d]/g, '')}`;
  }
  private minutesLisibles(m: number): string {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
  }
  protected dureeLisible(): string {
    return this.minutesLisibles(this.link()?.slotMinutes || 120);
  }
  protected dureeTotaleLisible(): string {
    return this.minutesLisibles((this.link()?.slotMinutes || 120) * this.vehicleCount());
  }
  /** Les numéros d'étape glissent d'un cran quand la question du nombre de véhicules s'affiche. */
  protected etape(n: number): number {
    return this.maxVehicles() > 1 ? n + 1 : n;
  }

  protected readonly ENERGIES: { value: InstallationEnergy; label: string }[] = [
    { value: 'DIESEL', label: 'Diesel' },
    { value: 'ESSENCE', label: 'Essence' },
    { value: 'ELECTRIQUE', label: 'Électrique' },
    { value: 'HYBRIDE', label: 'Hybride' },
    { value: 'AUTRE', label: 'Autre' },
  ];

  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(InstallationBookingApiService);

  private token = '';
  /** La visite ouverte par le serveur — repassée au rechargement, et à chaque geste. */
  private visiteId: string | null = null;
  private formulaireDejaTouche = false;

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

  // « Prévenez-moi »
  protected readonly abonnementOuvert = signal(false);
  protected readonly abonnementFait = signal(false);
  protected readonly aboEmail = signal('');
  protected readonly aboError = signal<string | null>(null);
  protected readonly aboSending = signal(false);

  // Contact (obligatoire) et véhicules (un bloc par véhicule, tout facultatif)
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly address = signal('');
  protected readonly notes = signal('');
  protected readonly vehicleCount = signal(1);
  protected readonly maxVehicles = computed(() => Math.max(1, this.link()?.maxVehicles ?? 1));
  protected readonly choixVehicules = computed(() => Array.from({ length: this.maxVehicles() }, (_, i) => i + 1));
  protected readonly vehicleRows = signal<{ plate: string; vehicle: string; energy: InstallationEnergy | '' }[]>([{ plate: '', vehicle: '', energy: '' }]);
  /** La grille se recharge quand le nombre change — les jours sont grisés pendant ce temps. */
  protected readonly rechargement = signal(false);

  protected readonly selectedDay = computed(() => this.days().find((d) => d.date === this.selectedDate()) ?? null);
  protected readonly selectedDayLabel = computed(() => this.selectedDay()?.label ?? '');

  async ngOnInit(): Promise<void> {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      // La provenance n'a de sens qu'à la PREMIÈRE ouverture : au rechargement, c'est nous.
      const provenance = this.visiteId ? undefined : (typeof document !== 'undefined' ? document.referrer : '');
      const link = await firstValueFrom(this.api.getPublicLink(this.token, this.visiteId, provenance, this.vehicleCount()));
      this.link.set(link);
      this.visiteId = link.visite?.id ?? this.visiteId;
      this.days.set(link.days);
      if (link.days.length > 0) this.selectedDate.set(link.days[0].date);
      // Lien nominatif : les coordonnées connues sont proposées, le client les corrige.
      if (link.prefill) {
        if (link.prefill.email) this.aboEmail.set(link.prefill.email);
        if (!this.name()) this.name.set(link.prefill.name ?? '');
        if (!this.email()) this.email.set(link.prefill.email ?? '');
        if (!this.phone()) this.phone.set(link.prefill.phone ?? '');
        if (!this.address()) this.address.set(link.prefill.address ?? '');
      }
      if (this.vehicleCount() !== link.vehicleCount) this.vehicleCount.set(link.vehicleCount);
      this.ajusterVehicules(link.vehicleCount);
    } catch (err) {
      swallow('public-booking:load', err);
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Un geste vers la chronologie de la visite. BEST-EFFORT et silencieux : le client n'a
   * rien à faire d'un suivi qui échoue, et la navigation (tel:, mailto:, nouvel onglet)
   * n'attend pas la réponse.
   */
  protected trace(type: BookingVisitEventType, target?: string): void {
    if (!this.visiteId || !this.token) return;
    this.api.evenement(this.token, this.visiteId, { type, target }).subscribe({
      error: (e) => swallow('public-booking:trace', e),
    });
  }

  protected formulaireTouche(): void {
    if (this.formulaireDejaTouche) return;
    this.formulaireDejaTouche = true;
    this.trace('formulaire');
  }

  /** Changer le nombre de véhicules recharge la grille (même visite), en gardant ce qui est saisi. */
  protected async choisirNombre(n: number): Promise<void> {
    if (n === this.vehicleCount() || this.rechargement()) return;
    this.vehicleCount.set(n);
    this.ajusterVehicules(n);
    this.selectedSlot.set(null);
    this.trace('vehicules', String(n));
    this.rechargement.set(true);
    try {
      const link = await firstValueFrom(this.api.getPublicLink(this.token, this.visiteId, undefined, n));
      this.link.set(link);
      this.days.set(link.days);
      const encore = link.days.find((d) => d.date === this.selectedDate());
      this.selectedDate.set(encore ? encore.date : (link.days[0]?.date ?? null));
    } catch (e) {
      swallow('public-booking:vehicules', e);
    } finally {
      this.rechargement.set(false);
    }
  }
  private ajusterVehicules(n: number): void {
    const actuels = this.vehicleRows();
    if (actuels.length === n) return;
    this.vehicleRows.set(
      actuels.length > n
        ? actuels.slice(0, n)
        : [...actuels, ...Array.from({ length: n - actuels.length }, () => ({ plate: '', vehicle: '', energy: '' as const }))],
    );
  }
  protected majVehicule(i: number, champ: 'plate' | 'vehicle' | 'energy', valeur: string): void {
    this.vehicleRows.update((liste) => liste.map((v, j) => (j === i ? { ...v, [champ]: valeur } : v)));
  }

  protected selectDay(date: string): void {
    if (this.selectedDate() !== date) this.trace('jour', date);
    this.selectedDate.set(date);
    this.selectedSlot.set(null);
  }
  protected selectSlot(s: BookingSlotDto): void {
    this.selectedSlot.set(s);
    this.error.set(null);
    this.trace('creneau', `${this.selectedDayLabel()} ${s.label}`);
  }

  protected async submit(): Promise<void> {
    const slot = this.selectedSlot();
    if (!slot) return;
    this.error.set(null);
    // Le contact est obligatoire : c'est là qu'arrive la confirmation, et l'appel de la veille.
    if (this.name().trim().length < 2) { this.error.set('Renseignez votre nom.'); return; }
    if (!/.+@.+\..+/.test(this.email().trim())) { this.error.set('Renseignez un e-mail valide.'); return; }
    if (this.phone().replace(/\D/g, '').length < 9) { this.error.set('Renseignez un numéro de téléphone (ex. 06 12 34 56 78).'); return; }
    const dto: CreatePublicBookingDto = {
      startAt: slot.startAt,
      vehicleCount: this.vehicleCount(),
      vehicles: this.vehicleRows().map((v) => {
        const [brand, ...rest] = v.vehicle.trim().split(' ');
        return {
          plate: v.plate.trim() || undefined,
          brand: brand || undefined,
          model: rest.join(' ') || undefined,
          energy: v.energy || undefined,
        };
      }),
      clientName: this.name().trim(),
      clientEmail: this.email().trim(),
      clientPhone: this.phone().trim(),
      clientAddress: this.address().trim() || undefined,
      notes: this.notes().trim() || undefined,
      visiteId: this.visiteId ?? undefined,
    };
    this.submitting.set(true);
    try {
      const res = await firstValueFrom(this.api.book(this.token, dto));
      this.confirmedLabel.set(res.slotLabel);
      this.done.set(true);
    } catch (e: unknown) {
      swallow('public-booking:submit', e);
      // `{ error: { message } }` : le filtre global de l'API enveloppe le message métier.
      this.error.set(apiErrorMessage(e, 'Une erreur est survenue. Réessayez.'));
      // Créneau plus dispo → on recharge les disponibilités (même visite : voir `load`).
      await this.load();
      this.selectedSlot.set(null);
    } finally {
      this.submitting.set(false);
    }
  }

  protected async prevenirMoi(): Promise<void> {
    const email = this.aboEmail().trim();
    this.aboError.set(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { this.aboError.set('Renseignez un e-mail valide.'); return; }
    this.aboSending.set(true);
    try {
      await firstValueFrom(this.api.prevenirMoi(this.token, { email, visiteId: this.visiteId ?? undefined }));
      this.abonnementFait.set(true);
    } catch (e: unknown) {
      swallow('public-booking:prevenirMoi', e);
      this.aboError.set(apiErrorMessage(e, 'Une erreur est survenue. Réessayez.'));
    } finally {
      this.aboSending.set(false);
    }
  }
}

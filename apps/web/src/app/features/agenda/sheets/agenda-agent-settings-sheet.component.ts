import { swallow } from '../../../core/error/swallow';
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
import { DatePipe, DecimalPipe } from '@angular/common';
import { apiErrorMessage } from '../../../core/error/api-error';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Settings, X, Loader, Zap, ExternalLink, Link2, Copy, Plus, Power, History, Mail, Baby } from 'lucide-angular';
import {
  CHILD_SEAT_POLICY_LABELS,
  FLEET_METIER_LABELS,
  type ChildSeatPolicy,
  type ChildSeatStockDto,
  type AgendaAgentAutonomy,
  type AgendaAgentFrequency,
  type AgendaAgentRunDto,
  type DestinataireAvisDto,
  type FleetMetier,
  type ReservationBookingLinkDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../../core/services/agenda.service';
import { AgendaAgentApiService } from '../../../core/services/agenda-agent.service';
import { ReservationBookingApiService } from '../../../core/services/reservation-booking.service';
import { AiApiService } from '../../../core/services/ai.service';
import { AiStatusService } from '../../../core/services/ai-status.service';
import { BillingApiService } from '../../../core/services/billing.service';
import { AiUsageApiService } from '../../../core/services/ai-usage.service';
import { AiJobService } from '../../../core/services/ai-job.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';
import { AgendaSyncService } from '../agenda-sync.service';
import { lancerPassageAgent } from '../ia/agenda-ia-view.component';

/**
 * Refonte agenda/IA (2026-07) — ⚙️ « Paramètres de l'agenda » (PAR FLOTTE).
 * Pilote l'agent d'optimisation : activation, analyse nocturne (heure/fréquence), autonomie
 * (suggestions vs auto si confiance haute), auto-complétion, déclencheurs, métier, + coût IA du mois.
 * Source de vérité de la société = le sélecteur global (FleetFilterService).
 */
@Component({
  selector: 'app-agenda-agent-settings-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, DatePipe, RouterLink, LucideAngularModule, BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Paramètres de l'agenda" (closed)="closed.emit()">
      <div class="aas">
        <div class="aas-head">
          <h3 class="aas-title"><lucide-icon [img]="SettingsIcon" [size]="15"></lucide-icon> Paramètres de l'agenda</h3>
          <button type="button" class="aas-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        @if (needsFleet()) {
          <div class="aas-note">Choisis une société dans le sélecteur en haut de page pour régler son agent.</div>
        } @else if (loading()) {
          <div class="aas-skel"></div><div class="aas-skel"></div><div class="aas-skel"></div>
        } @else {
          <div class="aas-body">
            @if (error()) { <div class="aas-alert">{{ error() }}</div> }

            <!-- Interrupteur MAÎTRE de l'IA (globale). Option PAYANTE : super-admin peut l'OFFRIR
                 (toggle → COMP) ; un fleet-admin l'active via son onglet Facturation (abonnement). -->
            <label class="aas-row aas-row--switch aas-row--master">
              <div>
                <span class="aas-lbl"><lucide-icon [img]="ZapIcon" [size]="13"></lucide-icon> Assistance IA</span>
                <span class="aas-sub"><strong>Toute l'IA</strong> de cette société (récit de trajet, agent d'agenda, optimiseur, saisie vocale). Option payante (abonnement mensuel) ; l'app fonctionne parfaitement sans IA (analyse des trajets, stations, scores restent inclus).</span>
              </div>
              @if (isSuperAdmin()) {
                <input type="checkbox" class="aas-sw" [checked]="aiMasterEnabled()" [disabled]="savingAi()" (change)="onToggleAi($any($event.target).checked)">
              } @else {
                <a routerLink="/settings" (click)="closed.emit()" class="aas-manage">{{ aiMasterEnabled() ? 'Gérer' : 'Activer' }}</a>
              }
            </label>
            @if (!aiMasterEnabled()) {
              <!-- Vrai, et rien de plus : la détection des habitudes est DÉTERMINISTE (elle ne passe
                   pas par l'IA). L'ancienne note prétendait les réglages « sans effet », alors qu'un
                   agent déjà activé continue ses passages planifiés sans avis de l'IA. -->
              <div class="aas-note">L'IA est désactivée pour cette société : l'agent ne peut pas être activé d'ici. S'il l'était déjà, ses passages planifiés continuent sans avis de l'IA — détection déterministe des habitudes, propositions et réservations selon l'autonomie réglée.</div>
            }

            <!-- Activation de l'agent d'agenda (sous-ensemble de l'IA). Le texte dit où l'IA
                 intervient : APRÈS coup, par le poste (design/C3 point 7) — ni la nuit ni le clic
                 n'appellent l'API. -->
            <label class="aas-row aas-row--switch">
              <div><span class="aas-lbl">Activer l'agent IA</span><span class="aas-sub">L'agent détecte les habitudes de {{ fleetName() || 'cette société' }} et prépare les propositions ; l'IA les relit ensuite depuis le poste (06:30 et 14:30) pour écarter les douteuses et expliquer les autres.</span></div>
              <input type="checkbox" class="aas-sw" [checked]="enabled()" [disabled]="!aiMasterEnabled()" (change)="enabled.set($any($event.target).checked)">
            </label>

            <!-- Métier -->
            <div class="aas-row">
              <div><span class="aas-lbl">Métier de la flotte</span><span class="aas-sub">Oriente l'objectif de l'IA (ex. sécurité enfants).</span></div>
              <!-- « [value] » sur le select est posé AVANT que les options existent (elles naissent
                   dans la boucle) : le navigateur retombe alors sur la première, « Transport
                   d'enfants », quel que soit le métier enregistré — et quand la valeur chargée est
                   déjà celle du signal (GENERIC), rien ne le rattrape. Recette du 28/09 sur la démo.
                   « [selected] » sur chaque option est la liaison que le DOM honore ici. -->
              <select class="aas-in" [value]="metier()" (change)="onMetierChange($any($event.target).value)">
                @for (m of metiers; track m) { <option [value]="m" [selected]="m === metier()">{{ metierLabel(m) }}</option> }
              </select>
            </div>

            <!--
              SIÈGES AUTO — le réglage vit dans la vue PARC de l'agenda depuis la refonte du 28/09
              (représentation visuelle du stock, sièges à bord par véhicule, places, équipements). Ici :
              l'état en une ligne et le chemin, pas un second formulaire — un réglage à deux endroits
              finit par en avoir deux.
            -->
            <div class="aas-sieges">
              <div class="aas-links-head">
                <span class="aas-lbl"><lucide-icon [img]="BabyIcon" [size]="13"></lucide-icon> Sièges auto de la société</span>
                <button type="button" class="aas-mini aas-mini--accent" (click)="ouvrirParc()">Ouvrir la vue Parc</button>
              </div>
              <!-- Revue du 29/09 : ouvrir la vue Parc FERME cette feuille. Des réglages de l'agent
                   cochés mais pas enregistrés disparaissaient sans un mot ; on demande d'abord. -->
              @if (confirmerParc() && modifie()) {
                <div class="aas-garde" role="alert">
                  <span class="aas-garde-t">Réglages non enregistrés</span>
                  <span class="aas-sub">L'activation, l'heure, la fréquence, l'auto-complétion ou les déclencheurs ont changé depuis l'ouverture de cette feuille. Ouvrir la vue Parc la ferme.</span>
                  @if (error(); as e) { <span class="aas-avis-err">{{ e }}</span> }
                  <div class="aas-garde-act">
                    <button type="button" class="aas-mini aas-mini--accent" [disabled]="saving()" (click)="enregistrerPuisParc()">
                      @if (saving()) { <lucide-icon [img]="LoaderIcon" [size]="12" class="aas-spin"></lucide-icon> } Enregistrer et ouvrir
                    </button>
                    <button type="button" class="aas-mini" [disabled]="saving()" (click)="parcSansEnregistrer()">Ouvrir sans enregistrer</button>
                  </div>
                </div>
              }
              @if (seatsError(); as e) { <p class="aas-avis-err">{{ e }}</p> }
              @else if (seatsEtat(); as st) {
                <span class="aas-sub aas-sieges-etat">
                  Possédés : <strong>{{ st.total.baby }}</strong> bébé · <strong>{{ st.total.child }}</strong> enfant —
                  à bord : <strong>{{ st.installed.baby }}</strong> / <strong>{{ st.installed.child }}</strong> —
                  en stock : <strong>{{ st.stock.baby }}</strong> / <strong>{{ st.stock.child }}</strong> ·
                  {{ seatPolicyLabel(st.policy) }}
                </span>
                @if (st.total.baby === 0 && st.total.child === 0) {
                  <span class="aas-sub">Aucun siège renseigné : toute réservation qui demande un siège auto sera refusée tant que ce n'est pas compté — dans la vue Parc.</span>
                }
              }
            </div>

            <!-- Analyse nocturne -->
            <div class="aas-grid">
              <label class="aas-row aas-row--col"><span class="aas-lbl">Heure d'analyse nocturne</span>
                <input type="number" min="0" max="23" class="aas-in" [value]="nightlyHour()" (input)="nightlyHour.set(clampHour($any($event.target).value))"></label>
              <label class="aas-row aas-row--col"><span class="aas-lbl">Fréquence</span>
                <select class="aas-in" [value]="frequency()" (change)="frequency.set($any($event.target).value)">
                  <option value="daily">Quotidienne</option><option value="weekly">Hebdomadaire</option>
                </select></label>
            </div>

            <!-- Autonomie -->
            <div class="aas-row aas-row--col">
              <!--
                ── L'AUTONOMIE NE SE RÈGLE PLUS (lot 3a, 2026-09-23) ──────────────────────────
                Le segment proposait « Auto si confiance haute » et un curseur de seuil. Le
                serveur ne réserve plus fermement, quel que soit le réglage : laisser le
                contrôle actif promettrait un comportement que l'application n'a plus. On
                affiche donc l'état, et le CHIFFRE qui l'a décidé — sinon « pourquoi ça ne
                réserve plus ? » n'a pas de réponse à l'écran.
              -->
              <span class="aas-lbl">Niveau d'autonomie</span>
              <div class="aas-fige">
                <span class="aas-fige-etat">Suggestions seules</span>
                <span class="aas-sub">
                  L'agent <strong>propose</strong>, il ne réserve jamais. Ses propositions
                  apparaissent en pointillé sur le calendrier et n'immobilisent aucun véhicule
                  tant que tu ne les as pas validées.
                </span>
                <span class="aas-sub aas-fige-pourquoi">
                  Mesuré le 23/09 sur 321 réservations automatiques passées : le véhicule avait
                  réellement roulé sur le créneau <strong>57 fois sur 100</strong> — et pas du tout
                  ce jour-là 23 fois sur 100. Le jour est juste, l'heure dérape de 47 min en
                  médiane. Une réservation ferme bloquait donc le mauvais créneau.
                </span>
              </div>
            </div>

            <!-- Auto-complétion -->
            <label class="aas-row aas-row--switch">
              <div><span class="aas-lbl">Auto-complétion après une réservation</span><span class="aas-sub">Quand quelqu'un réserve, l'IA optimise autour (mutualisation, coût).</span></div>
              <input type="checkbox" class="aas-sw" [checked]="autoComplete()" (change)="autoComplete.set($any($event.target).checked)">
            </label>

            <!-- Déclencheurs -->
            <div class="aas-row aas-row--col">
              <span class="aas-lbl">Déclencheurs de (re)analyse</span>
              <div class="aas-checks">
                <label class="aas-chk"><input type="checkbox" [checked]="trigNightly()" (change)="trigNightly.set($any($event.target).checked)"> Analyse nocturne</label>
                <label class="aas-chk"><input type="checkbox" [checked]="trigIncident()" (change)="trigIncident.set($any($event.target).checked)"> À un incident</label>
                <label class="aas-chk"><input type="checkbox" [checked]="trigMaintenance()" (change)="trigMaintenance.set($any($event.target).checked)"> À une maintenance</label>
                <label class="aas-chk"><input type="checkbox" [checked]="trigReservation()" (change)="trigReservation.set($any($event.target).checked)"> À une réservation</label>
              </div>
            </div>

            <!-- Coûts IA -->
            <div class="aas-cost">
              <div class="aas-cost-top">
                <span class="aas-lbl"><lucide-icon [img]="ZapIcon" [size]="13"></lucide-icon> Coûts IA · ce mois</span>
                <span class="aas-cost-amount">≈ {{ monthCostEur() | number:'1.2-2' }} €</span>
              </div>
              @if (byAction().length > 0) {
                <ul class="aas-cost-list">
                  @for (r of byAction(); track r.key) { <li><span>{{ r.label }}</span><span>{{ r.costEur | number:'1.2-2' }} €</span></li> }
                </ul>
              }
              <a routerLink="/admin/ai-usage" class="aas-cost-link" (click)="closed.emit()">Ouvrir le centre Coûts IA <lucide-icon [img]="ExternalLinkIcon" [size]="12"></lucide-icon></a>
            </div>

            <!-- Liens publics de réservation (P4) -->
            <div class="aas-links">
              <div class="aas-links-head">
                <span class="aas-lbl"><lucide-icon [img]="LinkIcon" [size]="13"></lucide-icon> Liens publics de réservation</span>
                <button type="button" class="aas-mini aas-mini--accent" [disabled]="creatingLink()" (click)="createLink()">
                  @if (creatingLink()) { <lucide-icon [img]="LoaderIcon" [size]="12" class="aas-spin"></lucide-icon> } @else { <lucide-icon [img]="PlusIcon" [size]="12"></lucide-icon> } Créer
                </button>
              </div>
              <span class="aas-sub">Un tiers décrit son besoin sur une page publique, l'app propose des véhicules ; la demande arrive dans « Demandes ».</span>
              @for (l of links(); track l.id) {
                <div class="aas-link" [class.aas-link--off]="!l.active">
                  <div class="aas-link-main">
                    <span class="aas-link-url">{{ l.publicUrl }}</span>
                    <span class="aas-link-meta">{{ l.active ? 'Actif' : 'Inactif' }} · ouvert {{ l.openCount }}×</span>
                  </div>
                  <button type="button" class="aas-mini" (click)="copyUrl(l.publicUrl)" title="Copier"><lucide-icon [img]="CopyIcon" [size]="13"></lucide-icon></button>
                  <button type="button" class="aas-mini" (click)="toggleLink(l)" [title]="l.active ? 'Désactiver' : 'Activer'"><lucide-icon [img]="PowerIcon" [size]="13"></lucide-icon></button>
                </div>
              }
            </div>
          </div>

          <!--
            QUI EST PRÉVENU QUAND UNE DEMANDE ARRIVE.

            Juste sous le lien public, parce que c'est la suite du même geste : le conducteur
            demande ici, et quelqu'un doit l'apprendre. Jusqu'au 24/09 les deux étaient confondus
            — être valideur, c'était être notifié —, si bien qu'ouvrir la validation à quatre
            gestionnaires envoyait quatre courriels par demande.
          -->
          <div class="aas-links">
            <div class="aas-links-head">
              <span class="aas-lbl"><lucide-icon [img]="MailIcon" [size]="13"></lucide-icon> Qui reçoit les demandes à valider</span>
            </div>
            <span class="aas-sub">
              Tous ceux listés <strong>peuvent valider</strong> une demande. Seuls les cochés en
              sont <strong>prévenus par e-mail</strong>.
            </span>
            @if (avisErreur(); as e) { <p class="aas-avis-err">{{ e }}</p> }
            @for (d of destinataires(); track d.userId) {
              <!-- Pas un label : la ligne entière basculait l'avis, et chaque bascule PART au serveur
                   (PUT) sans « Enregistrer ». Un clic égaré sur l'adresse a coupé l'avis d'un
                   gestionnaire en recette (28/09). Seul l'interrupteur agit ; l'adresse est son nom. -->
              <div class="aas-avis" [class.aas-avis--off]="!d.notifie">
                <span class="aas-avis-main">
                  <span class="aas-link-url">{{ d.email }}</span>
                  <span class="aas-link-meta">{{ roleLisible(d.role) }}{{ d.notifie ? '' : ' · ne reçoit pas l’avis' }}</span>
                </span>
                <input type="checkbox" class="aas-avis-sw" [checked]="d.notifie" [disabled]="avisEnvoi()"
                       [attr.aria-label]="'Prévenir ' + d.email + ' par e-mail'"
                       (change)="basculerAvis(d, $any($event.target).checked)">
              </div>
            } @empty {
              <p class="aas-avis-err">
                Personne ne peut valider dans cette société : ouvrez « Valider les réservations »
                à quelqu'un depuis l'écran des droits, sinon les demandes resteront en attente.
              </p>
            }
          </div>

          <!--
            Derniers passages de l'agent. C'est ici qu'on règle l'agent, c'est donc ici qu'on doit
            voir ce qu'il a RÉELLEMENT fait — sinon « rien ne se passe » reste sans explication.
          -->
          <div class="aas-runs">
            <div class="aas-links-head">
              <span class="aas-lbl"><lucide-icon [img]="HistoryIcon" [size]="13"></lucide-icon> Derniers passages</span>
              @if (runs().length > 0) {
                <button type="button" class="aas-mini" (click)="loadRuns()" [disabled]="runsLoading()" title="Rafraîchir">
                  <lucide-icon [img]="LoaderIcon" [size]="12" [class.aas-spin]="runsLoading()"></lucide-icon>
                </button>
              }
            </div>

            @if (runsLoading() && runs().length === 0) {
              <div class="aas-skel"></div>
            } @else if (runs().length === 0) {
              <span class="aas-sub">Aucun passage enregistré pour l'instant. L'agent archive chaque passage dès qu'il tourne.</span>
            } @else {
              @for (r of runs(); track r.id) {
                <div class="aas-run" [class.aas-run--err]="r.status === 'error'">
                  <div class="aas-run-main">
                    <span class="aas-run-when">
                      {{ r.startedAt | date: 'dd/MM HH:mm' }}
                      <span class="aas-run-origin">{{ r.origin === 'manual' ? 'manuel' : 'auto' }}</span>
                      @if (r.aiUsed) { <span class="aas-run-ai">IA</span> }
                    </span>
                    @if (r.status === 'error') {
                      <span class="aas-run-detail aas-run-detail--err">Échec : {{ r.error }}</span>
                    } @else if (r.patterns === 0) {
                      <!-- Le cas le plus fréquent d'un « il n'a rien fait » : aucune habitude détectée. -->
                      <span class="aas-run-detail">Aucune habitude récurrente détectée — rien à proposer.</span>
                    } @else {
                      <span class="aas-run-detail">
                        {{ r.patterns }} habitude{{ r.patterns > 1 ? 's' : '' }} ·
                        {{ r.created }} réservée{{ r.created > 1 ? 's' : '' }} ·
                        {{ r.proposed }} proposée{{ r.proposed > 1 ? 's' : '' }} ·
                        {{ r.skipped }} ignorée{{ r.skipped > 1 ? 's' : '' }}
                      </span>
                    }
                  </div>
                  <span class="aas-run-dur">{{ runDuration(r.durationMs) }}</span>
                </div>
              }
            }
          </div>

          <div class="aas-foot">
            <!-- Grisé sur la valeur ENREGISTRÉE de l'interrupteur, pas sur la case cochée : le
                 serveur juge le réglage en base (409 sinon), et un clic entre « cocher » et
                 « enregistrer » serait refusé. Le motif est écrit sous les boutons.
                 Revue du 29/09 : « Lancer l'analyse » devient « Lancer un passage de l'agent » —
                 même geste, même nom, même pastille que dans l'Assistant IA, où « analyse »
                 désigne l'analyse du parc (une par jour). -->
            <button type="button" class="aas-btn aas-btn--ghost" [disabled]="running() || saving() || !lancementPossible()" (click)="runNow()" [title]="titreLancement()">
              @if (running()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="aas-spin"></lucide-icon> } @else { <lucide-icon [img]="ZapIcon" [size]="15"></lucide-icon> }
              Lancer un passage de l'agent
            </button>
            <button type="button" class="aas-btn" [disabled]="saving()" (click)="save()">
              @if (saving()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="aas-spin"></lucide-icon> }
              {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
            @if (motifLancement(); as motif) {
              <span class="aas-foot-note">{{ motif }}</span>
            }
            @if (modifie()) {
              <span class="aas-foot-note aas-foot-note--modif">Réglages de l'agent modifiés, pas encore enregistrés : fermer la feuille les abandonne.</span>
            }
          </div>
        }
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .aas { display: flex; flex-direction: column; padding: 2px 2px 0; }
    /* Réglage FIGÉ : on montre l'état et sa raison, sans contrôle — un interrupteur qui
       n'agit plus est pire qu'un interrupteur absent. */
    .aas-fige { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-radius: 11px;
                background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-fige-etat { font-size: 13px; font-weight: 700; color: var(--texte-succes); }
    .aas-fige-pourquoi { padding-top: 6px; border-top: 1px dashed var(--border-strong); }
    .aas-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .aas-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aas-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .aas-x:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .aas-note, .aas-alert { margin: 12px 2px; padding: 12px; border-radius: 12px; background: rgba(56,189,248,.10); color: #38BDF8; font-size: 12.5px; }
    .aas-alert { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); }
    .aas-skel { height: 46px; border-radius: 12px; margin: 8px 2px; background: linear-gradient(90deg, var(--bg-tertiary), var(--bg-secondary), var(--bg-tertiary)); }
    /* Un seul ascenseur : celui de la feuille (.bs-content). Le corps avait le sien (62dvh) — deux
       ascenseurs emboîtés, et la molette n'atteignait ni « Qui reçoit les demandes à valider » ni
       les boutons du bas (recette du 28/09). Le pied reste visible par « position: sticky ». */
    .aas-body { display: flex; flex-direction: column; gap: 12px; padding: 10px 2px 2px; }
    .aas-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .aas-row--col { flex-direction: column; align-items: stretch; gap: 6px; }
    .aas-row--switch { padding: 4px 0; }
    .aas-row--master { padding: 12px 14px; border-radius: 12px; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 7%, var(--bg-tertiary)); border: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 20%, transparent); align-items: flex-start; }
    .aas-row--master .aas-lbl lucide-icon { color: var(--tracky-light, #10E0A0); }
    .aas-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .aas-lbl { font-size: 13px; font-weight: 600; color: var(--fg-primary); display: inline-flex; align-items: center; gap: 6px; }
    .aas-sub { display: block; font-size: 11.5px; color: var(--fg-tertiary); margin-top: 2px; line-height: 1.4; }
    .aas-in { padding: 9px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 16px; min-width: 130px; }
    .aas-manage { flex: 0 0 auto; padding: 7px 12px; border-radius: 9px; background: var(--tracky, #10B981); color: #fff; font-size: 12.5px; font-weight: 700; text-decoration: none; white-space: nowrap; }
    .aas-sw { width: 42px; height: 24px; appearance: none; border-radius: 999px; background: var(--bg-tertiary); border: 1px solid var(--border-strong); position: relative; cursor: pointer; flex: 0 0 auto; transition: background .15s; }
    .aas-sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .aas-sw:checked { background: var(--tracky, #10B981); border-color: var(--tracky, #10B981); }
    .aas-sw:checked::after { transform: translateX(18px); }
    .aas-seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-seg-btn { flex: 1; padding: 8px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); }
    .aas-seg-btn--on { background: var(--bg-primary); color: var(--tracky-light); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .aas-slider { display: flex; flex-direction: column; gap: 6px; }
    .aas-slider input { width: 100%; }
    .aas-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .aas-chk { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--fg-secondary); }
    .aas-cost { border: 1px solid var(--border-subtle); border-radius: 12px; padding: 12px; background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 8px; }
    .aas-cost-top { display: flex; align-items: center; justify-content: space-between; }
    .aas-cost-amount { font-size: 18px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aas-cost-list { display: flex; flex-direction: column; gap: 4px; }
    .aas-cost-list li { display: flex; justify-content: space-between; font-size: 12px; color: var(--fg-tertiary); }
    .aas-cost-link { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--tracky-light); }
    .aas-links { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-subtle); padding-top: 12px; }
    /* Stock de sièges auto : un bloc à part, cadré comme les coûts — c'est un réglage de matériel, pas d'agent. */
    .aas-sieges { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-sieges .aas-in { min-width: 0; width: 100%; }
    .aas-sieges-etat { color: var(--fg-secondary); line-height: 1.5; }
    /* Une ligne par véhicule équipé : plaque, deux petits compteurs, un bouton. Ça s'actionne au doigt. */
    .aas-links-head { display: flex; align-items: center; justify-content: space-between; }
    .aas-mini { display: inline-flex; align-items: center; gap: 4px; padding: 6px 8px; border-radius: 8px; font-size: 11.5px; font-weight: 700; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); flex: 0 0 auto; }
    .aas-mini--accent { background: rgba(16,224,160,.12); color: var(--tracky-light); border-color: rgba(16,224,160,.25); }
    /* Destinataires de l'avis : même bloc visuel que les liens publics, avec une bascule.
       Hauteur 44 px : ça s'actionne au doigt depuis un téléphone. */
    .aas-avis { display: flex; align-items: center; gap: 10px; padding: 9px 11px; min-height: 44px;
                border-radius: 10px; background: var(--bg-tertiary);
                border: 1px solid var(--border-subtle); }
    .aas-avis + .aas-avis { margin-top: 6px; }
    .aas-avis--off { opacity: .6; }
    .aas-avis-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .aas-avis-sw { flex: none; width: 40px; height: 22px; accent-color: var(--tracky-light); cursor: pointer; }
    .aas-avis-sw:disabled { opacity: .5; cursor: progress; }
    .aas-avis-err { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--texte-attente); }
    .aas-link { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-link--off { opacity: .55; }
    .aas-link-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .aas-link-url { font-size: 11.5px; color: var(--fg-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .aas-link-meta { font-size: 10.5px; color: var(--fg-tertiary); }
    /* Derniers passages de l'agent */
    .aas-runs { display: flex; flex-direction: column; gap: 7px; border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-top: 12px; }
    .aas-run { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-run--err { border-color: color-mix(in srgb, var(--danger) 35%, var(--border-subtle)); }
    .aas-run-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .aas-run-when { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-mono, monospace); }
    .aas-run-origin { padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); color: var(--fg-tertiary); font-family: var(--font-sans, sans-serif); }
    .aas-run-ai { padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 800; background: color-mix(in srgb, var(--violet) 10%, transparent); color: var(--texte-violet); font-family: var(--font-sans, sans-serif); }
    .aas-run-detail { font-size: 11px; color: var(--fg-tertiary); line-height: 1.4; }
    .aas-run-detail--err { color: var(--danger); }
    .aas-run-dur { flex: 0 0 auto; font-size: 10.5px; color: var(--fg-tertiary); font-family: var(--font-mono, monospace); }
    .aas-foot { position: sticky; bottom: 0; z-index: 1; background: var(--bg-secondary); display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); margin-top: 2px; border-top: 1px solid var(--border-subtle); }
    /* Le motif d'un bouton grisé, sous les boutons, sur toute la largeur. */
    .aas-foot-note { flex-basis: 100%; font-size: 11.5px; line-height: 1.4; color: var(--fg-tertiary); text-align: right; }
    .aas-foot-note--modif { color: var(--texte-attente); font-weight: 600; }
    /* Garde « réglages non enregistrés » avant de quitter pour la vue Parc. */
    .aas-garde { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px;
                 background: color-mix(in srgb, var(--warning) 10%, transparent);
                 border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent); }
    .aas-garde-t { font-size: 12.5px; font-weight: 700; color: var(--texte-attente); }
    .aas-garde-act { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .aas-btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 18px; border-radius: 10px; font-size: 13px; font-weight: 700; background: var(--tracky, #10B981); color: #fff; }
    .aas-btn--ghost { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .aas-btn:disabled { opacity: .55; }
    .aas-spin { animation: aas-spin 1s linear infinite; }
    @keyframes aas-spin { to { transform: rotate(360deg); } }
    @media (max-width: 480px) { .aas-grid, .aas-checks { grid-template-columns: 1fr; } }
  `],
})
export class AgendaAgentSettingsSheetComponent {
  private readonly agentApi = inject(AgendaAgentApiService);
  private readonly agendaApi = inject(AgendaApiService);
  private readonly bookingApi = inject(ReservationBookingApiService);
  private readonly ai = inject(AiApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly billing = inject(BillingApiService);
  private readonly usage = inject(AiUsageApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);
  private readonly aiJob = inject(AiJobService);
  private readonly sync = inject(AgendaSyncService);

  readonly open = input(false);
  readonly closed = output<void>();
  readonly saved = output<void>();
  /** « Ouvrir la vue Parc » : la page bascule sur la vue, la feuille se ferme. */
  readonly parc = output<void>();

  protected readonly SettingsIcon = Settings;
  protected readonly XIcon = X;
  protected readonly LoaderIcon = Loader;
  protected readonly ZapIcon = Zap;
  protected readonly ExternalLinkIcon = ExternalLink;
  protected readonly LinkIcon = Link2;
  protected readonly CopyIcon = Copy;
  protected readonly PlusIcon = Plus;
  protected readonly PowerIcon = Power;
  protected readonly HistoryIcon = History;
  protected readonly MailIcon = Mail;
  protected readonly BabyIcon = Baby;
  protected readonly metiers = Object.keys(FLEET_METIER_LABELS) as FleetMetier[];

  // Sièges auto — LUS pour le résumé ; le réglage vit dans la vue Parc (refonte du 28/09).
  protected readonly seatsEtat = signal<ChildSeatStockDto | null>(null);
  protected readonly seatsError = signal<string | null>(null);

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly running = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fleetName = signal<string | null>(null);

  // Interrupteur MAÎTRE de l'IA (globale) pour la flotte — distinct de l'agent d'agenda.
  protected readonly aiMasterEnabled = signal(true);
  protected readonly savingAi = signal(false);

  // Champs éditables
  protected readonly enabled = signal(false);
  /**
   * Valeur ENREGISTRÉE de l'interrupteur de l'agent (chargée par `load()`, mise à jour après
   * `save()`), distincte de la case `enabled()` en cours d'édition. C'est elle que le serveur
   * juge : « Lancer un passage » répond 409 quand l'agent est désactivé en base (design/C3
   * point 2). Griser sur la case cochée aurait laissé cliquer entre « cocher » et
   * « enregistrer », pour un refus.
   */
  protected readonly enregistre = signal(false);
  protected readonly nightlyHour = signal(2);
  protected readonly frequency = signal<AgendaAgentFrequency>('daily');
  protected readonly autonomy = signal<AgendaAgentAutonomy>('suggest');
  protected readonly confidenceThreshold = signal(80);
  protected readonly autoComplete = signal(false);
  protected readonly trigNightly = signal(true);
  protected readonly trigIncident = signal(true);
  protected readonly trigMaintenance = signal(true);
  protected readonly trigReservation = signal(false);
  protected readonly metier = signal<FleetMetier>('GENERIC');

  /**
   * ── RÉGLAGES NON ENREGISTRÉS (revue du 29/09) ────────────────────────────────────────────
   * Les réglages de l'agent ne partent qu'à « Enregistrer ». Instantané pris au chargement (et
   * après un enregistrement réussi) : `modifie()` dit si la feuille diffère de la base. Le métier,
   * les avis et les liens publics n'y sont pas — ils s'enregistrent dès qu'on les touche.
   */
  private readonly instantane = signal<string | null>(null);
  protected readonly modifie = computed(() => {
    const s = this.instantane();
    return s !== null && s !== this.reglagesCourants();
  });
  /** « Ouvrir la vue Parc » cliqué avec des réglages non enregistrés : la feuille demande quoi faire. */
  protected readonly confirmerParc = signal(false);

  // Coûts
  protected readonly monthCostEur = signal(0);
  protected readonly byAction = signal<{ key: string; label: string; costEur: number }[]>([]);

  // Liens publics de réservation (P4)
  protected readonly links = signal<ReservationBookingLinkDto[]>([]);
  protected readonly creatingLink = signal(false);

  /**
   * Qui peut valider une demande, et qui en est PRÉVENU. Deux choses distinctes depuis le
   * 2026-09-24 ; l'écran montre les deux ensemble pour qu'on voie qui on pourrait ajouter.
   */
  protected readonly destinataires = signal<DestinataireAvisDto[]>([]);
  protected readonly avisEnvoi = signal(false);
  protected readonly avisErreur = signal<string | null>(null);

  /**
   * Historique des passages de l'agent. Répond à la question qu'on se pose devant un agenda qui
   * n'a pas bougé : « a-t-il seulement tourné, et qu'a-t-il vu ? ». Chargé en best-effort — son
   * indisponibilité ne doit pas empêcher de régler l'agent.
   */
  protected readonly runs = signal<AgendaAgentRunDto[]>([]);
  protected readonly runsLoading = signal(false);

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.fleetFilter.selectedFleetId());

  /**
   * « Lancer un passage de l'agent » n'est proposé que si l'agent est activé EN BASE — c'est
   * exactement ce que le serveur refuse (409). L'IA maître coupée ne grise PAS le bouton : le
   * serveur accepte ce lancement et produit un passage déterministe (détection, propositions) sans
   * avis de l'IA — comportement voulu, décrit dans design/C3. Griser ici ce que le serveur accepte
   * aurait caché une fonction qui marche — c'est aussi pourquoi ce bouton reste ici alors que
   * l'Assistant IA a le sien : quand l'IA de la société est coupée, l'onglet IA peut disparaître.
   */
  protected readonly lancementPossible = computed(() => this.enregistre() && !this.error());
  /** Le motif du bouton grisé — écrit sous le bouton, jamais deviné. `null` quand le lancement est possible. */
  protected readonly motifLancement = computed<string | null>(() => {
    if (this.error()) return 'Réglage indisponible : impossible de savoir si l\'agent est activé.';
    if (!this.enregistre()) return 'L\'agent est désactivé : activez-le et enregistrez pour lancer un passage.';
    return null;
  });
  /**
   * Info-bulle du bouton : le motif du refus s'il y en a un, sinon ce que le clic fait vraiment
   * depuis le 05/09 — préparer les propositions, l'avis de l'IA venant du poste (design/C3
   * point 7). Calculée ici plutôt que dans le gabarit : une apostrophe dans une expression
   * Angular casse le parseur.
   */
  protected readonly titreLancement = computed(
    () => this.motifLancement() ?? 'Préparer les propositions maintenant (sans attendre la nuit) ; l\'avis de l\'IA arrive au prochain passage du poste.',
  );

  constructor() {
    effect(() => {
      if (!this.open() || this.needsFleet()) return;
      void this.load();
    });
  }

  /** Charge l'historique. Best-effort : jamais bloquant pour le reste de la feuille. */
  protected async loadRuns(): Promise<void> {
    if (this.needsFleet()) return;
    this.runsLoading.set(true);
    try {
      this.runs.set(await firstValueFrom(this.agentApi.listRuns(this.currentFleetId(), 10)));
    } catch (err) {
      // l'historique est un confort : son échec ne doit pas masquer les réglages
      swallow('agenda-agent-settings-sheet:loadRuns', err);
    } finally {
      this.runsLoading.set(false);
    }
  }

  /** Durée lisible d'un passage (les passages sont courts : secondes, sinon minutes). */
  protected runDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min`;
  }

  protected metierLabel(m: FleetMetier): string { return FLEET_METIER_LABELS[m]; }
  protected clampHour(v: string): number {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(23, n)) : 0;
  }
  protected seatPolicyLabel(p: ChildSeatPolicy): string { return CHILD_SEAT_POLICY_LABELS[p]; }

  private currentFleetId(): string | undefined {
    return this.fleetFilter.selectedFleetId() ?? undefined;
  }

  /**
   * Société d'un travail en arrière-plan : celle du bandeau pour un super-admin, `null` sinon —
   * la convention de l'Assistant IA, pour que les deux boutons « passage » se gardent l'un l'autre.
   */
  private jobFleetId(): string | null {
    return this.isSuperAdmin() ? this.fleetFilter.selectedFleetId() : null;
  }

  /** Les réglages de l'agent tels qu'ils partiraient à « Enregistrer », en une chaîne comparable. */
  private reglagesCourants(): string {
    return JSON.stringify([
      this.enabled(), this.nightlyHour(), this.frequency(), this.autoComplete(),
      this.trigNightly(), this.trigIncident(), this.trigMaintenance(), this.trigReservation(),
    ]);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.instantane.set(null); // rien à comparer tant que la base n'est pas relue
    this.confirmerParc.set(false);
    this.enregistre.set(false); // inconnu tant que le réglage n'est pas relu : pas de bouton, pas de faux motif
    const fleetId = this.currentFleetId();
    try {
      const s = await firstValueFrom(this.agentApi.getSettings(fleetId));
      this.fleetName.set(s.fleetName);
      this.enabled.set(s.enabled);
      this.enregistre.set(s.enabled);
      this.nightlyHour.set(s.nightlyHour);
      this.frequency.set(s.frequency);
      this.autonomy.set(s.autonomy);
      this.confidenceThreshold.set(s.confidenceThreshold);
      this.autoComplete.set(s.autoCompleteAfterReservation);
      this.trigNightly.set(s.triggerNightly);
      this.trigIncident.set(s.triggerIncident);
      this.trigMaintenance.set(s.triggerMaintenance);
      this.trigReservation.set(s.triggerReservation);
      this.metier.set(s.metier);
      this.monthCostEur.set(s.monthCostEur);
      this.instantane.set(this.reglagesCourants());
    } catch (e) {
      swallow('agenda-agent-settings-sheet:load', e);
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
    void this.loadRuns();
    // Interrupteur maître IA de la flotte (best-effort : ne bloque pas les autres réglages).
    try {
      const ai = await firstValueFrom(this.aiStatus.getFleetEnabled(fleetId));
      this.aiMasterEnabled.set(ai.enabled);
    } catch (err) {
      // garde l'optimiste
      swallow('agenda-agent-settings-sheet:load', err);
    }
    // Répartition des coûts (best-effort : ne bloque pas les réglages).
    try {
      const sum = await firstValueFrom(this.usage.summary(undefined, undefined, fleetId));
      this.byAction.set(sum.byAction.slice(0, 4).map((r) => ({ key: r.key, label: r.label, costEur: r.costEur })));
    } catch (err) {
      // le coût du mois (settings) suffit
      swallow('agenda-agent-settings-sheet:load', err);
    }
    // Liens publics de réservation (best-effort).
    try {
      this.links.set(await firstValueFrom(this.bookingApi.listLinks(fleetId)));
    } catch (err) {
      swallow('agenda-agent-settings-sheet:load', err);
      this.links.set([]);
    }
    // Sièges auto (best-effort, mais DIT : un état illisible n'est pas un stock vide).
    this.seatsError.set(null);
    try {
      this.seatsEtat.set(await firstValueFrom(this.agendaApi.childSeatStock(fleetId)));
    } catch (err) {
      swallow('agenda-agent-settings-sheet:childSeats', err);
      this.seatsError.set(apiErrorMessage(err, "Le stock de sièges auto n'a pas pu être lu."));
    }
    await this.chargerDestinataires(fleetId);
  }

  /**
   * Qui reçoit les demandes à valider. Best-effort comme le reste de la feuille : ne pas
   * pouvoir lire cette liste ne doit pas empêcher de régler l'agent. Mais on le DIT — une
   * liste vide sans explication se lirait « personne ne peut valider », ce qui est autre chose.
   */
  private async chargerDestinataires(fleetId?: string): Promise<void> {
    this.avisErreur.set(null);
    try {
      const r = await firstValueFrom(this.agentApi.destinatairesAvis(fleetId));
      this.destinataires.set(r.comptes);
    } catch (err) {
      swallow('agenda-agent-settings-sheet:destinataires', err);
      this.destinataires.set([]);
      this.avisErreur.set(apiErrorMessage(err, "La liste des destinataires n'a pas pu être lue."));
    }
  }

  /**
   * Bascule l'avis d'un compte.
   *
   * ⚠️ On REMET la case dans son état d'avant si le serveur refuse — notamment quand on tente de
   * couper le dernier destinataire. Sans ça, l'écran montrerait un avis coupé alors qu'il ne
   * l'est pas : le pire des deux mondes, puisqu'on se croirait tranquille.
   */
  protected async basculerAvis(d: DestinataireAvisDto, notifie: boolean): Promise<void> {
    if (this.avisEnvoi()) return;
    const avant = this.destinataires();
    this.avisEnvoi.set(true);
    this.avisErreur.set(null);
    this.destinataires.set(avant.map((c) => (c.userId === d.userId ? { ...c, notifie } : c)));
    try {
      const r = await firstValueFrom(this.agentApi.reglerAvis({ userId: d.userId, notifie }));
      this.destinataires.set(r.comptes);
      this.toast.success(
        notifie ? 'Destinataire ajouté' : 'Destinataire retiré',
        `${d.email} — demandes à valider`,
      );
    } catch (err) {
      swallow('agenda-agent-settings-sheet:reglerAvis', err);
      this.destinataires.set(avant); // on rend l'écran honnête
      this.toast.error('Réglage refusé', apiErrorMessage(err, "Le réglage n'a pas pu être enregistré."));
    } finally {
      this.avisEnvoi.set(false);
    }
  }

  /** Le rôle en français — l'écran des droits parle déjà cette langue, pas celle de l'énumération. */
  protected roleLisible(role: string): string {
    switch (role) {
      case 'SUPER_ADMIN': return 'Super-administrateur';
      case 'FLEET_ADMIN': return 'Administrateur';
      case 'FLEET_MANAGER': return 'Gestionnaire';
      case 'NIGHT_WATCHMAN': return 'Veilleur de nuit';
      case 'VIEWER': return 'Lecture seule';
      default: return role;
    }
  }

  /** Crée un lien public pour la société active + copie l'URL. */
  protected async createLink(): Promise<void> {
    this.creatingLink.set(true);
    try {
      const link = await firstValueFrom(this.bookingApi.createLink({ fleetId: this.currentFleetId() }));
      this.links.update((l) => [link, ...l]);
      await this.copyUrl(link.publicUrl);
      this.toast.success('Lien créé', 'URL copiée dans le presse-papier.');
    } catch (e) {
      swallow('agenda-agent-settings-sheet:createLink', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.creatingLink.set(false);
    }
  }

  protected async copyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('Lien copié');
    } catch {
      /* presse-papier indisponible (contexte non sécurisé) */
    }
  }

  protected async toggleLink(link: ReservationBookingLinkDto): Promise<void> {
    try {
      const updated = await firstValueFrom(this.bookingApi.setActive(link.id, !link.active));
      this.links.update((l) => l.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      swallow('agenda-agent-settings-sheet:toggleLink', e);
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    this.metier.set(metier);
    try {
      await firstValueFrom(this.ai.setFleetMetier({ fleetId: this.currentFleetId(), metier }));
      this.toast.success('Métier mis à jour', this.metierLabel(metier));
      // Contre-revue du 29/09 (R20) : le métier s'enregistre ici SANS « Enregistrer » — on ferme la
      // feuille par la croix. L'Assistant IA, resté monté sous la feuille, ne le relisait jamais :
      // l'en-tête gardait l'ancien métier et l'avertissement « analyse faite pour un autre métier »
      // ne s'affichait pas. Ce signal le lui fait relire (pas en cas d'échec : rien n'a changé).
      this.sync.propositionsModifiees();
    } catch (e) {
      swallow('agenda-agent-settings-sheet:onMetierChange', e);
      this.metier.set(prev);
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  /**
   * Interrupteur MAÎTRE (SUPER-ADMIN uniquement) : OFFRE (COMP) ou coupe TOUTE l'IA d'une société,
   * GRATUITEMENT, via /api/billing/comp. Un fleet-admin, lui, active l'IA en s'abonnant (onglet
   * Facturation) — d'où le lien « Gérer » à sa place dans le template.
   */
  protected async onToggleAi(next: boolean): Promise<void> {
    const fleetId = this.currentFleetId();
    if (!fleetId) { this.toast.error('Société', 'Choisissez une société.'); return; }
    const prev = this.aiMasterEnabled();
    this.aiMasterEnabled.set(next);
    this.savingAi.set(true);
    try {
      await firstValueFrom(this.billing.comp(fleetId, next)); // offert (COMP) + synchro aiEnabled
      this.aiStatus.refresh(); // met à jour le masquage des boutons IA dans toute l'app
      this.toast.success(next ? 'IA offerte' : 'IA coupée', next ? 'L\'assistance IA est offerte à cette société.' : 'Toute l\'IA est coupée pour cette société.');
    } catch (e) {
      swallow('agenda-agent-settings-sheet:toggleAiMaster', e);
      this.aiMasterEnabled.set(prev);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.savingAi.set(false);
    }
  }

  /**
   * Enregistre les réglages de l'agent, puis ferme la feuille. `apres` (ex. basculer sur la vue
   * Parc) ne s'exécute qu'en cas de SUCCÈS : un enregistrement refusé laisse la feuille ouverte,
   * l'erreur affichée, et la page là où elle était. Rend `true` si c'est enregistré.
   */
  protected async save(apres?: () => void): Promise<boolean> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.agentApi.setSettings({
        fleetId: this.currentFleetId(),
        enabled: this.enabled(),
        nightlyHour: this.nightlyHour(),
        frequency: this.frequency(),
        autonomy: this.autonomy(),
        confidenceThreshold: this.confidenceThreshold(),
        autoCompleteAfterReservation: this.autoComplete(),
        triggerNightly: this.trigNightly(),
        triggerIncident: this.trigIncident(),
        triggerMaintenance: this.trigMaintenance(),
        triggerReservation: this.trigReservation(),
      }));
      this.enregistre.set(this.enabled()); // la valeur en base est désormais celle de la case
      this.instantane.set(this.reglagesCourants());
      this.confirmerParc.set(false);
      this.toast.success('Paramètres enregistrés', 'L\'agent utilisera ces réglages.');
      // Revue du 29/09 : l'Assistant IA, resté monté SOUS cette feuille, relit l'activation de
      // l'agent par ce signal — sinon son bouton restait grisé « activez-le dans les réglages ».
      this.sync.propositionsModifiees();
      this.saved.emit();
      apres?.();
      this.closed.emit();
      return true;
    } catch (e) {
      swallow('agenda-agent-settings-sheet:save', e);
      this.error.set(this.errMsg(e));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  /** « Ouvrir la vue Parc » : directement si rien n'est en suspens, sinon la feuille demande d'abord. */
  protected ouvrirParc(): void {
    if (this.modifie()) {
      this.confirmerParc.set(true);
      return;
    }
    this.parc.emit();
    this.closed.emit();
  }

  protected async enregistrerPuisParc(): Promise<void> {
    await this.save(() => this.parc.emit());
  }

  /** Choix explicite d'abandonner : les réglages seront relus depuis la base à la prochaine ouverture. */
  protected parcSansEnregistrer(): void {
    this.confirmerParc.set(false);
    this.parc.emit();
    this.closed.emit();
  }

  /**
   * Lance un passage de l'agent EN ARRIÈRE-PLAN (sans attendre la nuit) : on ferme la modal
   * immédiatement et une PASTILLE en haut de l'agenda montre « l'agent travaille… » puis les
   * résultats (cliquables pour ouvrir les propositions). Fini l'attente bloquée sans retour.
   *
   * Depuis le 2026-09-05 (design/C3 point 7), le clic suit le MÊME chemin que la nuit : détection
   * déterministe, propositions préparées tout de suite avec leur phrase mécanique, et l'avis de
   * l'IA confié au poste — il arrive au passage suivant du courrier (06:30 ou 14:30).
   *
   * Revue du 29/09 : passe par `lancerPassageAgent`, la fonction du bouton de l'Assistant IA —
   * même titre de pastille (« Passage de l'agent »), même aide (qui ne promet plus de réservation
   * placée : l'agent ne réserve jamais), même bilan, et la page recharge à la fin.
   */
  protected runNow(): void {
    // Le bouton est grisé dans ce cas ; la garde évite un clic clavier ou un état intermédiaire.
    // Le serveur refuserait de toute façon (409, design/C3 point 2).
    if (!this.lancementPossible()) return;
    // Anti-double-lancement (dans la fonction) : la feuille reste montée ~220 ms après fermeture
    // (animation de sortie) ; un double-tap ne crée pas deux passages.
    lancerPassageAgent(
      { aiJob: this.aiJob, agentApi: this.agentApi, sync: this.sync },
      { fleetId: this.jobFleetId(), fleetName: this.isSuperAdmin() ? this.fleetName() : null },
    );
    this.closed.emit(); // suivi désormais dans la pastille : plus de blocage de la modal.
  }

  private errMsg(e: unknown): string {
    return apiErrorMessage(e, 'Erreur serveur.');
  }
}

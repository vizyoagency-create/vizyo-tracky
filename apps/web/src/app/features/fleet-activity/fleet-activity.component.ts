import { swallow } from '../../core/error/swallow';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { httpFailureMessage } from '../../core/services/http-failure';
import { ZoneComponent } from '../../shared/ui/zone/zone.component';
import type { EtatZone } from '../../shared/ui/zone/zone.component';
import {
  ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import {
  Activity, AlertTriangle, CalendarDays, CircleDot, Globe, LucideAngularModule, Power, PowerOff, RefreshCw,
  Settings, ShieldCheck, Sparkles, User, Users, Zap,
} from 'lucide-angular';
import type {
  ActivityFeedItemDto, EngineCommandAuditDto, FleetAgendaActivityDto, OnlineUserDto, StatutActionAgenda,
} from '@vizyo/tracky-shared';
import { AGENDA_ACTIVITY_ACTION_LABELS, statutActionAgenda } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AiStatusService } from '../../core/services/ai-status.service';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { FleetActivityApiService, type CategorieAgenda } from './fleet-activity-api.service';

export type Tab = 'agenda' | 'engine' | 'live' | 'history';

/**
 * L'onglet qu'un lien demande par `?tab=`. Le bouton moteur (« Le boîtier n'a pas confirmé » →
 * « Voir l'historique ») doit ouvrir « Moteurs » : depuis que l'Agenda ouvre la page (29/09), le
 * lien nu tombait sur le fil des réservations, et la commande non confirmée n'apparaissait nulle
 * part à l'écran — au moment même où il faut savoir si le véhicule est immobilisé.
 * « En ligne » n'est un onglet que sous 1024 px : sur grand écran, la présence est déjà une
 * colonne permanente, on reste sur l'onglet par défaut. Valeur inconnue → null (défaut).
 */
export function ongletDemande(valeur: string | null | undefined, large: boolean): Tab | null {
  switch (valeur) {
    case 'agenda':
    case 'engine':
    case 'history':
      return valeur;
    case 'live':
      return large ? null : 'live';
    default:
      return null;
  }
}

/** Ton d'une action d'agenda — chacun pointe vers un jeton de la famille --texte-*. */
type TonAgenda = 'succes' | 'info' | 'attente' | 'alerte' | 'agent' | 'inactif';

/**
 * Libellé de la première tuile — les compteurs moteur, AU-DESSUS des onglets.
 *
 * Revue du 29/09 : depuis que l'Agenda ouvre la page, une panne des commandes moteur ne se lisait
 * nulle part (la zone d'erreur est dans l'onglet Moteurs) et les tuiles affichaient « 0 Échec ·
 * Commandes moteur · 7 j » — une liste vide passait pour une semaine lue en entier. Une liste
 * vide ne couvre la fenêtre que si elle a été LUE : panne → « indisponibles », pas encore lue →
 * sans promesse de période. Les chiffres, eux, passent à « — » dans ces deux cas (gabarit).
 */
export function libelleTuileMoteurs(e: { erreur: boolean; charge: boolean; fenetreComplete: boolean }): string {
  if (e.erreur) return 'Commandes moteur indisponibles';
  if (!e.charge) return 'Commandes moteur';
  return e.fenetreComplete ? 'Commandes moteur · 7 j' : 'Commandes chargées';
}

/** Code d'un passage de l'agent d'agenda dans le journal (catégorie AI, « Passage de l'agent »). */
const ACTION_PASSAGE_AGENT = 'agenda_agent_run';

/**
 * 29/09 — le fil Agenda tel qu'il s'affiche. IA de la société DÉSACTIVÉE (interrupteur maître,
 * `AiStatusService.enabled()`, faux tant que le statut n'est pas arrivé) : les lignes « Passage de
 * l'agent » sortent du fil. L'agent peut encore tourner côté serveur (ses passages déterministes),
 * mais le client qui a coupé l'IA n'en voit plus la trace. Les gestes HUMAINS sur ses propositions
 * (« réservée », « écartée ») restent : c'est l'historique de l'agenda. IA réactivée : les passages
 * reviennent aussitôt — ils sont déjà chargés, rien n'est relu.
 */
export function filAgendaVisible<T extends { action: string }>(lignes: readonly T[], iaActive: boolean): readonly T[] {
  return iaActive ? lignes : lignes.filter((l) => l.action !== ACTION_PASSAGE_AGENT);
}

/**
 * 29/09 — pages lues AU PLUS par clic sur « Charger plus » quand elles n'ajoutent rien à l'écran
 * (IA coupée : une page faite uniquement de passages de l'agent, masqués). Au-delà, le bouton reste
 * et le clic suivant reprend où la lecture s'est arrêtée. 5 × 50 lignes, ce sont des mois de
 * passages nocturnes sans un seul geste humain : la borne ne sert qu'à ne jamais boucler.
 */
export const PAGES_AGENDA_PAR_CLIC = 5;

/** Une ligne du fil Agenda, prête à lire : tout ce qui se calcule l'est une fois, ici. */
interface LigneAgenda {
  dto: FleetAgendaActivityDto;
  heure: string;
  dateLongue: string;
  libelle: string;
  ton: TonAgenda;
  /**
   * Mot de statut quand le geste n'a PAS (pleinement) abouti ; null = réussi, rien à dire.
   * Calculé par `statutActionAgenda` (packages/shared) : la MÊME fonction que l'onglet Système
   * de /admin/activity — les deux écrans ne peuvent plus dire deux choses d'une même ligne.
   */
  statut: StatutActionAgenda | null;
}

interface GroupeAgenda {
  cle: string;
  titre: string;
  items: LigneAgenda[];
}

/**
 * Heure de PARIS, jamais celle du poste : un administrateur en déplacement (ou un poste réglé
 * en UTC) lirait sinon « 07:42 » pour une réservation validée à 09:42 à l'agence — et le
 * détail écrit par le serveur, lui, est déjà en heure de Paris : les deux se contrediraient.
 */
const FUSEAU = 'Europe/Paris';
const FMT_HEURE = new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, hour: '2-digit', minute: '2-digit' });
const FMT_DATE_LONGUE = new Intl.DateTimeFormat('fr-FR', {
  timeZone: FUSEAU, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const FMT_JOUR = new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, weekday: 'long', day: 'numeric', month: 'long' });
const FMT_PARTIES_JOUR = new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU, year: 'numeric', month: '2-digit', day: '2-digit' });

/** « 2026-09-29 » : le jour CIVIL à Paris de l'instant donné (clé de regroupement). */
function jourParis(d: Date): { a: number; m: number; j: number } {
  const p = FMT_PARTIES_JOUR.formatToParts(d);
  const val = (t: string) => Number(p.find((x) => x.type === t)?.value ?? NaN);
  return { a: val('year'), m: val('month'), j: val('day') };
}
function cleJour(x: { a: number; m: number; j: number }): string {
  return `${x.a}-${String(x.m).padStart(2, '0')}-${String(x.j).padStart(2, '0')}`;
}

/** Les pastilles du fil Agenda. « Agenda » = maintenances, incidents, propositions de l'agent. */
const PASTILLES_AGENDA: { id: CategorieAgenda; label: string }[] = [
  { id: '', label: 'Tout' },
  { id: 'RESERVATION', label: 'Réservations' },
  { id: 'AGENDA', label: 'Agenda' },
];

/** Ton d'un resultat — chacun pointe vers un jeton de la famille --texte-*. */
type Ton = 'succes' | 'attente' | 'alerte' | 'inactif';

/** Le resultat d'une commande, tel qu'il se lit : un mot, puis ce qui s'est passe. */
interface Resultat {
  mot: string;
  detail: string | null;
  ton: Ton;
  probleme: boolean;
}

interface Groupe {
  cle: string;
  titre: string;
  alerte: boolean;
  items: EngineCommandAuditDto[];
}

/** Fenetre des compteurs de tete. La maquette parle de « ces 7 derniers jours ». */
const FENETRE_JOURS = 7;
const FENETRE_MS = FENETRE_JOURS * 24 * 60 * 60 * 1000;

/**
 * Espace « Activite de la flotte » — FLEET_ADMIN (demande 2026-07).
 *
 * Permet a un responsable de flotte de CONTROLER qui agit sur ses vehicules, notamment QUI a
 * COUPE / RALLUME un moteur et QUAND. AUCUN rapport/analytics.
 *
 * SECURITE : le back borne a la flotte de l'appelant ET exclut les roles ELEVES
 * (super-admin / owner) — un fleet-admin ne voit JAMAIS l'activite des roles au-dessus de lui.
 *
 * ── Lot B-pages (2026-08-11) — « le resultat avant l'evenement » ────────────────────────
 *
 * L'ecran affichait un MOT de statut (« Echec », « Refusee (en mouvement) ») et s'arretait la.
 * Or c'est la RAISON qui fait agir : « refusee » ne dit pas s'il faut s'inquieter, alors que
 * « refusee · vehicule en mouvement, 74 km/h » dit que le garde-fou a fonctionne, et que rien
 * n'est a reparer. La raison existait deja en base (`lastError`, ecrit par `rejectSpeed`) et
 * n'etait affichee NULLE PART. Aucun DTO n'a bouge : la colonne « Resultat » lit des champs
 * qui etaient deja servis.
 *
 * Trois autres decisions de la planche :
 *  · LES ECHECS EN TETE — un groupe « A verifier » ouvre la liste, avant le classement par
 *    jour. Un echec vieux de trois jours se lit avant une confirmation d'il y a une heure.
 *  · LA PRESENCE DEVIENT PERMANENTE sur grand ecran — elle etait un onglet, donc invisible
 *    tant qu'on ne cliquait pas. Sous 1024 px elle reste un onglet : la planche mobile ne lui
 *    donne pas de colonne, et il n'y en a pas.
 *  · LES COMPTEURS NE MENTENT PAS SUR LEUR PERIMETRE — cf. `fenetreComplete()` plus bas.
 *
 * ── 29/09 — onglet « Agenda », en premier et par defaut ─────────────────────────────────
 *
 * Ce que l'administrateur vient chercher ici, c'est « qui a valide / refuse / deplace cette
 * reservation, qui a signale cet incident ». Le fil lit le journal metier (categories
 * RESERVATION et AGENDA, plus les passages de l'agent) via `GET /api/fleet-admin/activity/agenda`,
 * borne a SA societe. Le nom de l'auteur est calcule cote serveur : un geste d'un compte
 * interne s'y lit « Equipe Tracky », jamais un nom (regle « owner cache »).
 *
 * Un SUPER_ADMIN n'a pas de societe : l'API lui repond une liste vide s'il ne passe pas
 * `?fleetId=`. La page lit donc le filtre societe global du bandeau, et le dit quand il manque —
 * sans quoi quatre onglets vides lui feraient croire qu'il ne s'est rien passe.
 */
@Component({
  selector: 'app-fleet-activity',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, LucideAngularModule, NgTemplateOutlet, ZoneComponent],
  template: `
    <div class="fa">
      <header class="fa-head">
        <div class="fa-title">
          <lucide-icon [img]="ActivityIcon" [size]="20" />
          <div>
            <h1>Activité de la flotte</h1>
            <p class="fa-sub">Qui agit sur vos véhicules — réservations et agenda, coupures/rallumages moteur, présence et historique.</p>
          </div>
        </div>
        <button class="fa-refresh" (click)="rafraichir()" [disabled]="loading()" aria-label="Rafraîchir">
          <lucide-icon [img]="RefreshIcon" [size]="16" [class.spin]="loading()" />
        </button>
      </header>

      @if (societeManquante()) {
        <div class="fa-note fa-note--attente" role="status">
          Aucune société choisie : choisissez-en une dans le sélecteur de société du bandeau pour voir son activité.
        </div>
      }

      <!-- Revue du 29/09 : une panne des commandes moteur se lit AU-DESSUS des onglets. Sa zone
           d'erreur est dans l'onglet Moteurs ; depuis l'Agenda (onglet par défaut), rien ne la
           signalait et les tuiles disaient « 0 Échec ». Dans Moteurs, la zone le dit déjà. -->
      @if (engineErreur() && tab() !== 'engine') {
        <div class="fa-note fa-note--attente fa-note--action" role="status">
          <span>Commandes moteur indisponibles : les chiffres ci-dessous ne sont pas à jour.</span>
          <button type="button" class="fa-note-btn" (click)="rechargerMoteurs()" [disabled]="loading()">Réessayer</button>
        </div>
      }

      @if (problemes().length) {
        <div class="fa-alerte" role="status">
          <span class="fa-alerte-ico"><lucide-icon [img]="WarnIcon" [size]="16" /></span>
          <div class="fa-alerte-corps">
            <div class="fa-alerte-titre">{{ titreProblemes() }}</div>
            <p class="fa-alerte-txt">{{ expliqueProblemes() }}</p>
            <div class="fa-alerte-chips">
              @for (c of problemes(); track c.id) {
                <span class="fa-chip" [attr.data-ton]="resultat(c).ton">
                  <span class="fa-plq">{{ c.vehiclePlate ?? 'Sans plaque' }}</span>
                  · {{ motCourt(c) }}
                </span>
              }
            </div>
          </div>
        </div>
      }

      <!-- « — » tant que les commandes ne sont pas lues, ou que leur lecture a échoué : un 0
           dirait « rien ne s'est passé » là où l'on ne sait pas. -->
      <div class="fa-tuiles">
        <div class="fa-tuile"><b>{{ compteursLisibles() ? vus().length : '—' }}</b><span>{{ libelleFenetre() }}</span></div>
        <div class="fa-tuile"><b class="t-info">{{ compteursLisibles() ? nbCoupures() : '—' }}</b><span>Coupures</span></div>
        <div class="fa-tuile"><b class="t-succes">{{ compteursLisibles() ? nbRallumages() : '—' }}</b><span>Rallumages</span></div>
        <div class="fa-tuile" [class.bord-attente]="compteursLisibles() && nbRefusees() > 0">
          <b class="t-attente">{{ compteursLisibles() ? nbRefusees() : '—' }}</b><span>Refusée en marche</span>
        </div>
        <div class="fa-tuile" [class.bord-alerte]="compteursLisibles() && nbEchecs() > 0">
          <b class="t-alerte">{{ compteursLisibles() ? nbEchecs() : '—' }}</b><span>Échec</span>
        </div>
      </div>

      <nav class="fa-tabs" aria-label="Vues de l'activité">
        <button class="tab-btn" [class.on]="tab() === 'agenda'" (click)="setTab('agenda')">
          <lucide-icon [img]="AgendaIcon" [size]="15" /> Agenda
        </button>
        <button class="tab-btn" [class.on]="tab() === 'engine'" (click)="setTab('engine')">
          <lucide-icon [img]="ZapIcon" [size]="15" /> Moteurs
        </button>
        @if (!large()) {
          <button class="tab-btn" [class.on]="tab() === 'live'" (click)="setTab('live')">
            <lucide-icon [img]="UsersIcon" [size]="15" /> En ligne
            @if (online().length) { <span class="fa-badge">{{ online().length }}</span> }
          </button>
        }
        <button class="tab-btn" [class.on]="tab() === 'history'" (click)="setTab('history')">
          <lucide-icon [img]="DotIcon" [size]="15" /> Historique
        </button>
      </nav>

      <div class="fa-grille" [class.avec-aside]="large()">
        <div class="fa-colonne">

          @if (tab() === 'agenda') {
            <div class="fa-pastilles" role="group" aria-label="Filtrer le fil de l'agenda">
              @for (p of pastillesAgenda; track p.id) {
                <button type="button" class="fa-pastille" [class.on]="agendaCategorie() === p.id"
                        [attr.aria-pressed]="agendaCategorie() === p.id" (click)="setAgendaCategorie(p.id)">
                  {{ p.label }}
                </button>
              }
            </div>

            <!-- Réessayer = Rafraîchir : une panne de l'API fait tomber l'agenda ET les commandes
                 moteur ; ne relancer que l'agenda laissait les tuiles d'en haut en panne.
                 29/09 — IA de la société coupée : le fil n'affiche plus les passages de l'agent, et
                 l'état vide ne les promet plus. Une page lue faite SEULEMENT de passages masqués
                 peut précéder des gestes plus anciens : l'état vide garde alors « Charger plus »
                 (bouton projeté dans la case action-vide de la zone), jamais une impasse. -->
            <app-zone
              [etat]="etatAgenda()"
              quoi="L'activité de l'agenda"
              [vide]="videAgenda()"
              [videDetail]="videDetailAgenda()"
              erreur="Impossible de charger l'activité de l'agenda"
              (reessayer)="rafraichir()">
              @if (agendaSuite()) {
                <button action-vide type="button" class="fa-more" (click)="loadMoreAgenda()" [disabled]="loading()">Charger plus</button>
              }
              <div class="fa-liste">
                @for (g of groupesAgenda(); track g.cle) {
                  <div class="fa-groupe">
                    <span class="fa-losange" aria-hidden="true">&#9670;</span>{{ g.titre }}
                  </div>
                  @for (l of g.items; track l.dto.id) {
                    <article class="fa-ag" [attr.data-ton]="l.statut?.ton === 'alerte' ? 'alerte' : null">
                      <div class="fa-ag-tete">
                        <time class="fa-ag-heure" [attr.datetime]="l.dto.at" [attr.title]="l.dateLongue">{{ l.heure }}</time>
                        <span class="fa-ag-qui" [attr.data-kind]="l.dto.actorKind">
                          <lucide-icon [img]="iconeActeur(l.dto.actorKind)" [size]="13" />
                          <span class="fa-ag-nom">{{ l.dto.actorName }}</span>
                        </span>
                        <span class="fa-ag-act" [attr.data-ton]="l.ton">{{ l.libelle }}</span>
                        @if (l.dto.vehiclePlate) { <span class="fa-plq">{{ l.dto.vehiclePlate }}</span> }
                        @if (l.statut; as s) { <span class="fa-mot" [attr.data-ton]="s.ton">{{ s.mot }}</span> }
                      </div>
                      @if (l.dto.detail) { <p class="fa-ag-detail">{{ l.dto.detail }}</p> }
                    </article>
                  }
                }
              </div>
              <p class="fa-note-pied">Heures de Paris. « Équipe Tracky » désigne un geste de notre équipe sur votre agenda.</p>
              @if (agendaSuite()) {
                <button class="fa-more" (click)="loadMoreAgenda()" [disabled]="loading()">Charger plus</button>
              }
            </app-zone>
          }

          @if (tab() === 'engine') {
            <div class="fa-filters">
              <label class="sr-only" for="fa-action">Filtrer par action</label>
              <select id="fa-action" [ngModel]="engineAction()" (ngModelChange)="setEngineAction($event)">
                <option value="">Toutes actions</option>
                <option value="CUT">Coupures</option>
                <option value="RESTORE">Rallumages</option>
              </select>
              <label class="sr-only" for="fa-statut">Filtrer par résultat</label>
              <select id="fa-statut" [ngModel]="engineStatus()" (ngModelChange)="setEngineStatus($event)">
                <option value="">Tous résultats</option>
                <option value="ACKNOWLEDGED">Confirmée</option>
                <option value="SENT">Envoyée</option>
                <option value="PENDING">En attente</option>
                <option value="FAILED">Échec</option>
                <option value="REJECTED_SPEED">Refusée (en mouvement)</option>
              </select>
            </div>

            <app-zone
              [etat]="etatMoteurs()"
              quoi="Les actions moteur"
              vide="Aucune action moteur sur cette flotte"
              videDetail="Les coupures et rallumages apparaîtront ici dès qu'un moteur sera commandé."
              erreur="Impossible de charger les actions moteur"
              (reessayer)="reloadActive()">
              <div class="fa-liste">
                @for (g of groupes(); track g.cle) {
                  <div class="fa-groupe" [class.alerte]="g.alerte">
                    <span class="fa-losange" aria-hidden="true">&#9670;</span>{{ g.titre }}
                  </div>
                  @for (c of g.items; track c.id) {
                    <article class="fa-ligne" [attr.data-ton]="resultat(c).probleme ? resultat(c).ton : null">
                      <div class="fa-l-tete">
                        <span class="fa-plq">{{ c.vehiclePlate ?? 'Sans plaque' }}</span>
                        <span class="fa-act" [attr.data-a]="c.action">
                          <lucide-icon [img]="c.action === 'CUT' ? PowerOffIcon : PowerIcon" [size]="12" />
                          {{ c.action === 'CUT' ? 'Coupure' : 'Rallumage' }}
                        </span>
                        <time class="fa-when">{{ c.createdAt | date:'dd/MM HH:mm' }}</time>
                      </div>
                      <div class="fa-l-res">
                        <span class="fa-mot" [attr.data-ton]="resultat(c).ton">{{ resultat(c).mot }}</span>
                        @if (resultat(c).detail) {
                          <span class="fa-detail">{{ resultat(c).detail }}</span>
                        }
                      </div>
                      <div class="fa-l-pied">
                        <span>{{ c.requestedByName }}</span>
                        @if (c.requestedByRole) { <span class="fa-role">{{ roleLabel(c.requestedByRole) }}</span> }
                        <span class="fa-sep" aria-hidden="true">·</span>
                        <span>{{ sourceLabel(c.source) }}</span>
                      </div>
                    </article>
                  }
                }
              </div>

              <p class="fa-note-pied">
                « Détecté (boîtier) » signifie que quelqu'un a agi <strong>sur le véhicule</strong>, pas depuis Tracky.
              </p>
              @if (engine().length >= pageSize) {
                <button class="fa-more" (click)="loadMoreEngine()" [disabled]="loading()">Charger plus</button>
              }
            </app-zone>
          }

          @if (tab() === 'live' && !large()) {
            <ng-container [ngTemplateOutlet]="presence" />
          }

          @if (tab() === 'history') {
            <div class="fa-note">Flux des actions des utilisateurs de votre flotte (les plus récentes d'abord).</div>
            <app-zone
              [etat]="etatFeed()"
              quoi="L'historique"
              vide="Aucune activité récente"
              videDetail="Les pages ouvertes et les actions de vos utilisateurs apparaîtront ici."
              erreur="Impossible de charger l'historique"
              (reessayer)="reloadActive()">
              <ul class="fa-feed">
                @for (f of feed(); track f.id) {
                  <li>
                    <span class="fa-feed-when">{{ f.at | date:'dd/MM HH:mm' }}</span>
                    <span class="fa-feed-user">{{ f.userName }}</span>
                    <span class="fa-feed-type">{{ typeLabel(f.type) }}</span>
                    <span class="fa-feed-target">{{ cibleFeed(f) }}</span>
                  </li>
                }
              </ul>
              @if (feed().length >= pageSize) {
                <button class="fa-more" (click)="loadMoreFeed()" [disabled]="loading()">Charger plus</button>
              }
            </app-zone>
          }
        </div>

        @if (large()) {
          <aside class="fa-aside">
            <ng-container [ngTemplateOutlet]="presence" />
          </aside>
        }
      </div>
    </div>

    <ng-template #presence>
      <section class="fa-presence">
        <header class="fa-p-tete">
          <span class="fa-p-ico"><lucide-icon [img]="UsersIcon" [size]="16" /></span>
          <div class="fa-p-titres">
            <h2>En ligne maintenant</h2>
            <p>Rafraîchi toutes les {{ periodeSondageSec }} s</p>
          </div>
          <span class="fa-p-nb">{{ online().length }}</span>
        </header>
        <app-zone
          [etat]="etatPresence()"
          quoi="La présence"
          vide="Personne en ligne"
          videDetail="Aucun utilisateur de votre flotte n'est connecté en ce moment."
          [lignes]="2">
          <ul class="fa-p-liste">
            @for (u of online(); track u.userId) {
              <li>
                <span class="fa-dot" [class.idle]="u.status !== 'ACTIVE'" aria-hidden="true"></span>
                <div class="fa-p-corps">
                  <div class="fa-p-nom">
                    <span class="fa-p-n">{{ u.name }}</span>
                    <span class="fa-role">{{ roleLabel(u.role) }}</span>
                  </div>
                  <div class="fa-p-meta">
                    {{ u.currentRouteLabel ?? u.currentRoute ?? 'Page inconnue' }}
                    · {{ vuIlYA(u.lastSeenSec) }}
                  </div>
                </div>
              </li>
            }
          </ul>
        </app-zone>
      </section>
    </ng-template>
  `,
  styles: [`
    .fa { padding: 16px; max-width: 1240px; margin: 0 auto; }
    .fa-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .fa-title { display: flex; gap: 10px; align-items: center; color: var(--text-primary); }
    .fa-title h1 { font-size: 20px; font-weight: 800; margin: 0; }
    .fa-sub { margin: 2px 0 0; font-size: 12.5px; color: var(--text-secondary); }
    .fa-refresh {
      display: flex; align-items: center; justify-content: center;
      min-width: 44px; min-height: 44px; flex-shrink: 0;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 10px; cursor: pointer; color: var(--text-secondary);
    }
    .fa-refresh:disabled { opacity: .5; }
    .spin { animation: fa-spin 1s linear infinite; }
    @keyframes fa-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

    /* Bandeau « ce qui n'a pas abouti » — les echecs en tete, avant tout le reste. */
    .fa-alerte {
      display: flex; gap: 11px; padding: 12px 14px; border-radius: 13px; margin-bottom: 13px;
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    }
    .fa-alerte-ico {
      display: flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 10px; flex-shrink: 0;
      background: var(--danger); color: var(--accent-ink);
    }
    .fa-alerte-corps { min-width: 0; flex: 1; }
    .fa-alerte-titre { font-size: 13.5px; font-weight: 800; color: var(--texte-alerte); }
    .fa-alerte-txt { margin: 4px 0 0; font-size: 12px; line-height: 1.45; color: var(--text-secondary); text-wrap: pretty; }
    .fa-alerte-chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .fa-chip {
      display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 7px;
      background: var(--bg-secondary); font-size: 11.5px; font-weight: 700;
    }
    .fa-chip[data-ton='alerte'] { color: var(--texte-alerte); border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent); }
    .fa-chip[data-ton='attente'] { color: var(--texte-attente); border: 1px solid color-mix(in srgb, var(--warning) 28%, transparent); }

    /* Tuiles de tete. */
    .fa-tuiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 8px; margin-bottom: 13px; }
    .fa-tuile {
      display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 13px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); min-width: 0;
    }
    .fa-tuile b { font-size: 20px; font-weight: 800; letter-spacing: -.03em; line-height: 1.05; color: var(--text-primary); }
    .fa-tuile span { font-size: 11px; font-weight: 600; color: var(--text-secondary); }
    .fa-tuile.bord-attente { border-color: color-mix(in srgb, var(--warning) 34%, transparent); }
    .fa-tuile.bord-alerte { border-color: color-mix(in srgb, var(--danger) 34%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .t-info { color: var(--texte-info); } .t-succes { color: var(--texte-succes); }
    .t-attente { color: var(--texte-attente); } .t-alerte { color: var(--texte-alerte); }

    .fa-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
    .fa-tabs .tab-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; min-height: 44px;
      border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-secondary);
      color: var(--text-secondary); font-weight: 700; font-size: 13px; cursor: pointer;
    }
    .fa-tabs .tab-btn.on { background: var(--tracky-light); color: var(--accent-ink); border-color: var(--tracky-light); }
    .fa-badge { background: var(--surface-quaternary); color: var(--text-primary); border-radius: 9999px; padding: 0 6px; font-size: 11px; }
    .fa-tabs .tab-btn.on .fa-badge { background: color-mix(in srgb, var(--accent-ink) 18%, transparent); color: var(--accent-ink); }

    .fa-grille { display: block; }
    .fa-grille.avec-aside { display: grid; grid-template-columns: minmax(0, 1fr) 344px; gap: 16px; align-items: start; }
    .fa-colonne { min-width: 0; }
    .fa-aside { min-width: 0; position: sticky; top: 16px; }

    .fa-note { font-size: 12.5px; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
    .fa-note--attente {
      color: var(--texte-attente); font-weight: 600;
      background: color-mix(in srgb, var(--warning) 12%, transparent);
      border-color: color-mix(in srgb, var(--warning) 28%, transparent);
    }
    .fa-note--action { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
    .fa-note-btn {
      min-height: 44px; padding: 6px 14px; border-radius: 10px; cursor: pointer;
      background: transparent; border: 1px solid currentColor; color: inherit;
      font-size: 12.5px; font-weight: 700;
    }
    .fa-note-btn:disabled { opacity: .5; cursor: default; }

    /* Fil Agenda — pastilles de filtre, puis une ligne par geste. */
    .fa-pastilles { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
    .fa-pastille {
      min-height: 44px; padding: 7px 15px; border-radius: 9999px;
      border: 1px solid var(--border-subtle); background: var(--bg-secondary);
      color: var(--text-secondary); font-size: 13px; font-weight: 700; cursor: pointer;
    }
    .fa-pastille.on {
      color: var(--texte-succes);
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 45%, transparent);
    }
    .fa-ag { display: flex; flex-direction: column; gap: 5px; padding: 11px 14px; border-bottom: 1px solid var(--border-subtle); min-width: 0; }
    .fa-ag:last-child { border-bottom: none; }
    .fa-ag[data-ton='alerte'] { background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .fa-ag-tete { display: flex; align-items: center; gap: 6px 8px; flex-wrap: wrap; min-width: 0; }
    .fa-ag-heure { font-size: 12.5px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .fa-ag-qui {
      display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%;
      font-size: 12.5px; font-weight: 700; color: var(--text-primary);
    }
    .fa-ag-qui lucide-icon { color: var(--text-secondary); flex-shrink: 0; display: inline-flex; }
    .fa-ag-qui[data-kind='team'] { color: var(--texte-succes); }
    .fa-ag-qui[data-kind='agent'] { color: var(--texte-violet); }
    .fa-ag-qui[data-kind='public'] { color: var(--texte-info); }
    .fa-ag-nom { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fa-ag-act { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 7px; font-size: 11.5px; font-weight: 700; }
    .fa-ag-act[data-ton='succes'] { color: var(--texte-succes); background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); }
    .fa-ag-act[data-ton='info'] { color: var(--texte-info); background: color-mix(in srgb, var(--blue) 12%, transparent); }
    .fa-ag-act[data-ton='attente'] { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 12%, transparent); }
    .fa-ag-act[data-ton='alerte'] { color: var(--texte-alerte); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .fa-ag-act[data-ton='agent'] { color: var(--texte-violet); background: color-mix(in srgb, var(--violet) 12%, transparent); }
    .fa-ag-act[data-ton='inactif'] { color: var(--texte-inactif); background: var(--surface-quaternary); }
    /* Meme cause que .fa-ligne[data-ton] .fa-act : deux lavis de 12 % empiles font tomber le contraste. */
    .fa-ag[data-ton] .fa-ag-act { background: var(--bg-secondary); }
    .fa-ag-detail { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); text-wrap: pretty; overflow-wrap: anywhere; }
    .fa-filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .fa-filters select {
      min-height: 44px; padding: 7px 10px; border-radius: 9px; border: 1px solid var(--border-subtle);
      background: var(--bg-secondary); color: var(--text-primary); font-size: 13px; flex: 1 1 150px;
    }

    /* Liste des actions moteur — une carte par action, groupee. */
    .fa-liste { border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden; }
    .fa-groupe {
      display: flex; align-items: center; gap: 8px; padding: 7px 14px;
      background: var(--bg-tertiary); border-bottom: 1px solid var(--border-subtle);
      font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
      color: var(--text-secondary);
    }
    .fa-groupe:not(:first-child) { border-top: 1px solid var(--border-subtle); }
    .fa-groupe.alerte { color: var(--texte-alerte); }
    .fa-losange { font-size: 9px; }
    .fa-ligne { display: flex; flex-direction: column; gap: 5px; padding: 11px 14px; border-bottom: 1px solid var(--border-subtle); }
    .fa-ligne:last-child { border-bottom: none; }
    .fa-ligne[data-ton='alerte'] { background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .fa-ligne[data-ton='attente'] { background: color-mix(in srgb, var(--warning) 12%, transparent); }
    .fa-l-tete { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .fa-plq {
      display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 5px;
      background: var(--surface-quaternary); border: 1px solid var(--border-strong);
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; font-weight: 600; white-space: nowrap;
      color: var(--text-primary);
    }
    .fa-act { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; padding: 2px 8px; border-radius: 7px; font-size: 11.5px; }
    .fa-act[data-a='CUT'] { color: var(--texte-alerte); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .fa-act[data-a='RESTORE'] { color: var(--texte-succes); background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); }
    /*
     * Sur une ligne « a verifier », le lavis de la PUCE (12 %) se posait sur le lavis de la
     * LIGNE (12 %) : les deux teintes s'additionnent, le fond fonce, et le contraste tombe a
     * 4,37 — mesure en theme clair. La puce reprend donc la surface de la carte : la couleur
     * du texte et l'icone portent deja la distinction coupure / rallumage.
     */
    .fa-ligne[data-ton] .fa-act { background: var(--bg-secondary); }
    .fa-when { margin-left: auto; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

    /* Le resultat : un mot, puis ce qui s'est reellement passe. */
    .fa-l-res { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
    .fa-mot { font-size: 13px; font-weight: 800; }
    .fa-mot[data-ton='succes'] { color: var(--texte-succes); }
    .fa-mot[data-ton='attente'] { color: var(--texte-attente); }
    .fa-mot[data-ton='alerte'] { color: var(--texte-alerte); }
    .fa-mot[data-ton='inactif'] { color: var(--texte-inactif); }
    /*
     * --text-tertiary est lisible a 16 px, pas a 12 : mesure au navigateur en theme CLAIR,
     * 2,34:1 sur une ligne teintee et 3,07:1 sur la carte — sous le seuil de 4,5. Or cette
     * ligne EST le sujet de la page (« le resultat avant l'evenement ») : c'est le dernier
     * texte de l'ecran qu'on peut laisser palir. Meme constat que la famille --texte-* au
     * lot B0-prime : la couleur ne change pas de sens, elle descend d'un cran pour se lire.
     */
    .fa-detail { font-size: 12px; color: var(--text-secondary); text-wrap: pretty; }
    .fa-l-pied { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); }
    .fa-sep { color: var(--text-secondary); }
    .fa-role {
      display: inline-block; font-size: 10.5px; font-weight: 700; color: var(--text-secondary);
      background: var(--surface-quaternary); border-radius: 6px; padding: 1px 6px;
    }
    .fa-note-pied { margin: 10px 2px 0; font-size: 12px; line-height: 1.45; color: var(--text-secondary); text-wrap: pretty; }
    .fa-note-pied strong { color: var(--text-primary); }
    .fa-more {
      display: block; margin: 12px auto 0; min-height: 44px; padding: 8px 18px; border-radius: 9px;
      border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-primary);
      font-weight: 700; cursor: pointer;
    }

    /* Presence — panneau permanent au-dela de 1024 px, onglet en deca. */
    .fa-presence {
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 26%, transparent);
      border-radius: 13px; background: var(--bg-secondary); overflow: hidden;
    }
    .fa-p-tete {
      display: flex; align-items: center; gap: 11px; padding: 12px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--color-tracky-light) 20%, transparent);
    }
    .fa-p-ico {
      display: flex; align-items: center; justify-content: center; width: 31px; height: 31px;
      border-radius: 10px; flex-shrink: 0;
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); color: var(--texte-succes);
    }
    .fa-p-titres { min-width: 0; flex: 1; }
    .fa-p-titres h2 { margin: 0; font-size: 14px; font-weight: 800; color: var(--text-primary); }
    .fa-p-titres p { margin: 1px 0 0; font-size: 11.5px; color: var(--text-secondary); }
    .fa-p-nb { font-size: 17px; font-weight: 800; color: var(--texte-succes); }
    .fa-p-liste { list-style: none; margin: 0; padding: 0; }
    .fa-p-liste li { display: flex; align-items: center; gap: 11px; padding: 11px 14px; border-bottom: 1px solid var(--border-subtle); }
    .fa-p-liste li:last-child { border-bottom: none; }
    .fa-dot { width: 8px; height: 8px; border-radius: 9999px; background: var(--color-tracky-light); flex-shrink: 0; }
    .fa-dot.idle { background: var(--warning); }
    .fa-p-corps { min-width: 0; flex: 1; }
    .fa-p-nom { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .fa-p-n { font-size: 13px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fa-p-meta { font-size: 11.5px; color: var(--text-secondary); margin-top: 2px; }

    .fa-feed { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden; }
    .fa-feed li { display: flex; gap: 10px; align-items: baseline; padding: 9px 12px; border-top: 1px solid var(--border-subtle); font-size: 13px; flex-wrap: wrap; }
    .fa-feed li:first-child { border-top: none; }
    .fa-feed-when { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .fa-feed-user { font-weight: 700; color: var(--text-primary); }
    .fa-feed-type { font-size: 11px; text-transform: uppercase; color: var(--text-secondary); }
    .fa-feed-target { color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class FleetActivityComponent implements OnInit, OnDestroy {
  private readonly api = inject(FleetActivityApiService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  /**
   * 29/09 — IA de la société (interrupteur maître) : décide si les passages de l'agent se lisent
   * dans le fil Agenda. Suit le filtre société d'un super-admin, comme le reste de la page.
   */
  private readonly aiStatus = inject(AiStatusService);
  /** Optionnelle : la page doit rester utilisable hors routeur (test, intégration). */
  private readonly route = inject(ActivatedRoute, { optional: true });

  protected readonly AgendaIcon = CalendarDays;
  protected readonly ActivityIcon = Activity;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly ZapIcon = Zap;
  protected readonly UsersIcon = Users;
  protected readonly DotIcon = CircleDot;
  protected readonly PowerIcon = Power;
  protected readonly PowerOffIcon = PowerOff;
  protected readonly WarnIcon = AlertTriangle;

  protected readonly pageSize = 50;
  /**
   * La presence est desormais un panneau PERMANENT sur grand ecran : elle est a l'ecran en
   * continu, alors qu'elle n'apparaissait avant que sur clic d'onglet. Un sondage de 5 s
   * permanent serait un appel toutes les 5 secondes pendant toute la session ; la planche
   * ecrit « Rafraichi toutes les 20 s », et le libelle affiche cette valeur — il ne peut donc
   * pas deriver de la realite.
   */
  protected readonly periodeSondageSec = 20;
  /** L'agenda d'abord : c'est ce que l'administrateur vient chercher (29/09). */
  protected readonly tab = signal<Tab>('agenda');
  protected readonly loading = signal(false);
  protected readonly online = signal<OnlineUserDto[]>([]);
  protected readonly feed = signal<ActivityFeedItemDto[]>([]);
  protected readonly engine = signal<EngineCommandAuditDto[]>([]);
  protected readonly engineAction = signal<string>('');
  protected readonly engineStatus = signal<string>('');
  /** Grand ecran : la presence a une colonne a elle. Sous 1024 px, elle redevient un onglet. */
  protected readonly large = signal(false);

  /**
   * Une panne et un resultat vide sont DEUX choses. Le code precedent les confondait
   * (`catch` qui posait un tableau vide) : une API tombee affichait « Aucune action moteur
   * sur cette flotte » — un mensonge rassurant sur l'ecran meme qui sert a verifier que
   * personne n'a touche aux vehicules.
   */
  /** Lu aussi par le gabarit : la panne se signale au-dessus des onglets (revue du 29/09). */
  protected readonly engineErreur = signal(false);
  private readonly feedErreur = signal(false);
  private readonly presenceErreur = signal(false);
  private readonly engineCharge = signal(false);
  private readonly feedCharge = signal(false);
  private readonly presenceCharge = signal(false);

  // ── Fil Agenda ─────────────────────────────────────────────────────────────
  protected readonly pastillesAgenda = PASTILLES_AGENDA;
  protected readonly agenda = signal<FleetAgendaActivityDto[]>([]);
  protected readonly agendaCategorie = signal<CategorieAgenda>('');
  private readonly agendaErreur = signal(false);
  private readonly agendaCharge = signal(false);
  /**
   * Y a-t-il une page apres ? Vrai tant que la derniere page reçue etait PLEINE. Un bouton
   * « Charger plus » affiche des qu'on a 50 lignes promettait une suite qui n'existait pas
   * quand la liste tombait pile sur la taille de page, et ne disparaissait jamais.
   */
  protected readonly agendaSuite = signal(false);
  /**
   * Numero du chargement en cours. Deux pastilles cliquees vite, ou une societe changee
   * pendant un appel : la reponse la plus LENTE arrivait en dernier et ecrasait la bonne —
   * des reservations sous la pastille « Agenda ». On ne garde que la reponse du dernier appel.
   */
  private agendaSeq = 0;
  /** Meme garde pour les autres onglets, le temps d'un changement de societe. */
  private generation = 0;

  // ── Societe (super-admin) ─────────────────────────────────────────────────
  private readonly estSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  /**
   * La societe a interroger : celle du filtre global du bandeau pour un super-admin, rien pour
   * un administrateur de flotte (le serveur lit la sienne dans son jeton et ignore le parametre).
   */
  private readonly societeCible = computed<string | null>(() =>
    this.estSuperAdmin() ? this.fleetFilter.selectedFleetId() : null,
  );
  protected readonly societeManquante = computed(() => this.estSuperAdmin() && !this.fleetFilter.selectedFleetId());
  /** Derniere societe chargee — `undefined` tant que le premier chargement n'est pas parti. */
  private societeChargee: string | null | undefined = undefined;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private mq: MediaQueryList | null = null;
  private onMq: ((e: MediaQueryListEvent) => void) | null = null;

  constructor() {
    // Le super-admin change de societe dans le bandeau : tout ce qui est a l'ecran appartient a
    // l'ANCIENNE. On vide avant de recharger — laisser ses lignes pendant l'appel ferait lire
    // l'activite d'un client sous le nom d'un autre.
    effect(() => {
      const societe = this.societeCible();
      if (this.societeChargee === undefined || societe === this.societeChargee) return;
      this.societeChargee = societe;
      untracked(() => this.changerDeSociete());
    });
  }

  /**
   * Le fil tel qu'il s'affiche : sans les passages de l'agent quand l'IA de la société est coupée
   * (29/09, `filAgendaVisible`). `agenda()` garde la page BRUTE du serveur : c'est elle qui porte le
   * curseur de « Charger plus » et qui dit s'il reste une page.
   */
  protected readonly agendaVisible = computed(() => filAgendaVisible(this.agenda(), this.aiStatus.societeActive()));

  // ── Etats de zone ──────────────────────────────────────────────────────────
  /** Rempli / vide se jugent sur ce qui S'AFFICHE : une page de passages masqués est un fil vide. */
  protected readonly etatAgenda = computed<EtatZone>(() => {
    if (this.agendaErreur()) return 'erreur';
    if (!this.agendaCharge()) return 'chargement';
    return this.agendaVisible().length ? 'rempli' : 'vide';
  });
  protected readonly videAgenda = computed(() => {
    // 29/09 — rien à afficher alors que le serveur a une suite : la page lue n'était faite que de
    // passages de l'agent, masqués (IA coupée). « Sur la période » dirait qu'il n'y a rien avant.
    if (this.agendaSuite()) return "Aucune action d'agenda récente";
    switch (this.agendaCategorie()) {
      case 'RESERVATION': return 'Aucune action de réservation sur la période';
      default: return "Aucune action d'agenda sur la période";
    }
  });
  /** 29/09 — l'état vide ne promet les propositions de l'agent que si l'IA de la société est active. */
  protected readonly videDetailAgenda = computed(() => {
    if (this.agendaSuite()) return 'Les gestes plus anciens se lisent avec « Charger plus ».';
    return this.aiStatus.societeActive()
      ? "Les réservations, maintenances, incidents et propositions de l'agent apparaîtront ici dès qu'un geste sera posé."
      : "Les réservations, maintenances et incidents apparaîtront ici dès qu'un geste sera posé.";
  });
  protected readonly etatMoteurs = computed<EtatZone>(() => {
    if (this.engineErreur()) return 'erreur';
    if (!this.engineCharge()) return 'chargement';
    return this.engine().length ? 'rempli' : 'vide';
  });
  protected readonly etatFeed = computed<EtatZone>(() => {
    if (this.feedErreur()) return 'erreur';
    if (!this.feedCharge()) return 'chargement';
    return this.feed().length ? 'rempli' : 'vide';
  });
  /**
   * La presence est un sondage de FOND, volontairement silencieux (cf. le service). Une panne
   * n'y merite pas un bandeau d'erreur rouge sur un panneau permanent : on garde le dernier
   * etat connu s'il y en a un, et on ne bascule en « vide » qu'une fois un tour reussi.
   */
  protected readonly etatPresence = computed<EtatZone>(() => {
    if (this.online().length) return 'rempli';
    if (!this.presenceCharge()) return this.presenceErreur() ? 'vide' : 'chargement';
    return 'vide';
  });

  // ── Compteurs de tete ──────────────────────────────────────────────────────
  /**
   * Les actions retenues pour les compteurs : celles des 7 derniers jours PARMI celles
   * chargees. Le back sert une page (cursor `before`), pas une fenetre : compter « sur 7
   * jours » sans le verifier afficherait un chiffre faux des que la flotte depasse une page.
   */
  protected readonly vus = computed<EngineCommandAuditDto[]>(() => {
    const limite = Date.now() - FENETRE_MS;
    return this.engine().filter((c) => new Date(c.createdAt).getTime() >= limite);
  });
  /**
   * A-t-on REELLEMENT toute la fenetre de 7 jours ? Oui seulement si la plus ancienne action
   * chargee est plus vieille que la fenetre : dans ce cas la page couvre les 7 jours en
   * entier. Sinon on ne sait pas ce qui manque, et le libelle le dit.
   */
  private readonly fenetreComplete = computed<boolean>(() => {
    const tout = this.engine();
    if (!tout.length) return true;
    const plusAncienne = new Date(tout[tout.length - 1].createdAt).getTime();
    return plusAncienne < Date.now() - FENETRE_MS;
  });
  /**
   * Les chiffres des tuiles se lisent-ils ? Non tant que la liste n'a pas été reçue, ni quand sa
   * dernière lecture a échoué (la liste gardée n'est plus à jour) : les tuiles disent alors « — ».
   */
  protected readonly compteursLisibles = computed(() => this.engineCharge() && !this.engineErreur());
  /**
   * « Commandes moteur », plus « Actions » : depuis que l'onglet Agenda ouvre la page (29/09),
   * « Actions · 7 j » au-dessus d'un fil de réservations se lisait comme le compte de CE fil.
   */
  protected readonly libelleFenetre = computed(() => libelleTuileMoteurs({
    erreur: this.engineErreur(),
    charge: this.engineCharge(),
    fenetreComplete: this.fenetreComplete(),
  }));

  private compte(pred: (c: EngineCommandAuditDto) => boolean): number {
    return this.vus().filter(pred).length;
  }
  protected readonly nbCoupures = computed(() => this.compte((c) => c.action === 'CUT'));
  protected readonly nbRallumages = computed(() => this.compte((c) => c.action === 'RESTORE'));
  protected readonly nbRefusees = computed(() => this.compte((c) => c.status === 'REJECTED_SPEED'));
  protected readonly nbEchecs = computed(() => this.compte((c) => c.status === 'FAILED'));

  /** Ce qui n'a pas abouti — l'ordre de lecture de la page commence ici. */
  protected readonly problemes = computed(() =>
    this.vus().filter((c) => c.status === 'FAILED' || c.status === 'REJECTED_SPEED'),
  );

  protected readonly titreProblemes = computed(() => {
    const n = this.problemes().length;
    const suffixe = this.fenetreComplete() ? ` ces ${FENETRE_JOURS} derniers jours` : ' parmi les actions chargées';
    return n > 1
      ? `${n} commandes moteur n'ont pas abouti${suffixe}`
      : `1 commande moteur n'a pas abouti${suffixe}`;
  });

  /**
   * La phrase qui evite l'inquietude inutile : une refusee est le garde-fou qui FONCTIONNE,
   * un echec est un boitier a verifier. Les deux etaient rouges et indistincts.
   */
  protected readonly expliqueProblemes = computed(() => {
    const r = this.nbRefusees();
    const e = this.nbEchecs();
    const bouts: string[] = [];
    if (r) bouts.push(r > 1
      ? `${r} refusées parce que le véhicule roulait — c'est le garde-fou, il a fonctionné`
      : `Une refusée parce que le véhicule roulait — c'est le garde-fou, il a fonctionné`);
    if (e) bouts.push(e > 1
      ? `${e} en échec : le boîtier n'a pas répondu, à vérifier`
      : `Une en échec : le boîtier n'a pas répondu, à vérifier`);
    return bouts.join('. ') + '.';
  });

  /** Les echecs en tete, puis le classement par jour. */
  protected readonly groupes = computed<Groupe[]>(() => {
    const tout = this.engine();
    const aVerifier = tout.filter((c) => this.resultat(c).probleme);
    const reste = tout.filter((c) => !this.resultat(c).probleme);
    const out: Groupe[] = [];
    if (aVerifier.length) {
      out.push({ cle: 'a-verifier', titre: `À vérifier · ${aVerifier.length}`, alerte: true, items: aVerifier });
    }
    const parJour = new Map<string, EngineCommandAuditDto[]>();
    for (const c of reste) {
      const d = new Date(c.createdAt);
      const cle = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const liste = parJour.get(cle);
      if (liste) liste.push(c); else parJour.set(cle, [c]);
    }
    for (const [cle, items] of parJour) {
      out.push({ cle, titre: this.libelleJour(items[0].createdAt), alerte: false, items });
    }
    return out;
  });

  /**
   * Le fil Agenda, classe par JOUR DE PARIS (pas celui du poste : une validation a 00:30 a
   * Paris n'appartient pas a « hier » parce que le poste est en UTC). Le serveur sert du plus
   * recent au plus ancien ; l'ordre est conserve. Lit le fil AFFICHE (29/09 : sans les passages
   * de l'agent quand l'IA de la societe est coupee) — un jour qui n'aurait porte qu'eux disparait.
   */
  protected readonly groupesAgenda = computed<GroupeAgenda[]>(() => {
    const maintenant = new Date();
    const auj = jourParis(maintenant);
    const cleAuj = cleJour(auj);
    const h = new Date(Date.UTC(auj.a, auj.m - 1, auj.j - 1));
    const cleHier = cleJour({ a: h.getUTCFullYear(), m: h.getUTCMonth() + 1, j: h.getUTCDate() });

    const groupes: GroupeAgenda[] = [];
    let courant: GroupeAgenda | null = null;
    let cleCourante = '';
    for (const dto of this.agendaVisible()) {
      const d = new Date(dto.at);
      const valide = !Number.isNaN(d.getTime());
      const cle = valide ? cleJour(jourParis(d)) : 'sans-date';
      if (!courant || cleCourante !== cle) {
        cleCourante = cle;
        const titre = !valide ? 'Date inconnue'
          : cle === cleAuj ? "Aujourd'hui"
          : cle === cleHier ? 'Hier'
          : FMT_JOUR.format(d);
        // Deux lots du meme jour separes par un autre jour ne devraient pas exister (tri serveur),
        // mais une cle de suivi en double ferait planter le @for : on la rend unique.
        courant = { cle: groupes.some((g) => g.cle === cle) ? `${cle}-${groupes.length}` : cle, titre, items: [] };
        groupes.push(courant);
      }
      courant.items.push(this.ligneAgenda(dto, d, valide));
    }
    return groupes;
  });

  private ligneAgenda(dto: FleetAgendaActivityDto, d: Date, valide: boolean): LigneAgenda {
    return {
      dto,
      heure: valide ? FMT_HEURE.format(d) : '—',
      dateLongue: valide ? FMT_DATE_LONGUE.format(d) : '',
      libelle: dto.actionLabel || AGENDA_ACTIVITY_ACTION_LABELS[dto.action] || dto.action,
      ton: this.tonAction(dto.action),
      statut: statutActionAgenda(String(dto.status), dto.action),
    };
  }

  ngOnInit(): void {
    this.societeChargee = this.societeCible();

    // La presence n'a une colonne que s'il y a la place. 1024 px = la largeur en deca de
    // laquelle la colonne de 344 px mangerait la liste au lieu de l'accompagner.
    // Lu AVANT l'onglet demande : « En ligne » n'existe que sous 1024 px.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mq = window.matchMedia('(min-width: 1024px)');
      this.large.set(this.mq.matches);
      this.onMq = (e: MediaQueryListEvent) => {
        this.large.set(e.matches);
        // En passant au grand ecran, l'onglet « En ligne » disparait : on ne laisse pas
        // l'utilisateur sur un onglet qui n'existe plus.
        if (e.matches && this.tab() === 'live') this.setTab('agenda');
      };
      this.mq.addEventListener('change', this.onMq);
    }

    // `?tab=engine` (lien « Voir l'historique » du bouton moteur) : on ouvre l'onglet demande.
    const demande = ongletDemande(this.route?.snapshot.queryParamMap.get('tab'), this.large());
    if (demande) this.tab.set(demande);

    // 29/09 — statut IA de la société (passages de l'agent affichés ou non). Idempotent ; le
    // service se recharge de lui-même quand la société du bandeau change. Opt-in : tant qu'il
    // n'est pas arrivé, les passages restent masqués (pas de ligne montrée puis retirée).
    this.aiStatus.ensureLoaded();

    // Agenda, moteurs et presence se chargent toujours : les tuiles et le bandeau d'echecs
    // (au-dessus des onglets) lisent `engine()`, la presence est une colonne sur grand ecran.
    void this.loadAgenda();
    void this.loadEngine();
    void this.loadOnline();
    if (this.tab() === 'history') void this.loadFeed();
    this.pollTimer = setInterval(() => void this.loadOnline(), this.periodeSondageSec * 1000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.mq && this.onMq) this.mq.removeEventListener('change', this.onMq);
  }

  protected setTab(t: Tab): void {
    if (t === this.tab()) return;
    this.tab.set(t);
    this.reloadActive();
  }

  protected reloadActive(): void {
    if (this.tab() === 'agenda') void this.loadAgenda();
    else if (this.tab() === 'engine') void this.loadEngine();
    else if (this.tab() === 'live') void this.loadOnline();
    else void this.loadFeed();
  }

  /**
   * Le bouton « Rafraichir » de l'en-tete. Les tuiles (Coupures, Rallumages, Refusee en marche,
   * Echec) et le bandeau « N commandes moteur n'ont pas abouti » sont AU-DESSUS des onglets et
   * lisent `engine()` : tant que « Moteurs » etait l'onglet par defaut, rafraichir l'onglet
   * suffisait. Depuis que l'Agenda ouvre la page (29/09), une coupure en echec restait a 0 et
   * sans bandeau jusqu'a un passage par « Moteurs ». On recharge donc aussi les commandes.
   */
  protected rafraichir(): void {
    this.reloadActive();
    if (this.tab() !== 'engine') void this.loadEngine();
  }

  /** « Réessayer » de la note « Commandes moteur indisponibles », depuis un autre onglet que Moteurs. */
  protected rechargerMoteurs(): void { void this.loadEngine(); }

  protected setEngineAction(v: string): void { this.engineAction.set(v); void this.loadEngine(); }
  protected setEngineStatus(v: string): void { this.engineStatus.set(v); void this.loadEngine(); }

  protected setAgendaCategorie(c: CategorieAgenda): void {
    if (c === this.agendaCategorie()) return;
    this.agendaCategorie.set(c);
    // On vide AVANT l'appel : garder les lignes de l'ancien filtre sous la nouvelle pastille
    // ferait lire des reservations sous « Agenda » le temps de la reponse.
    this.agenda.set([]);
    this.agendaCharge.set(false);
    void this.loadAgenda();
  }

  /** Changement de societe (super-admin) : tout ce qui est affiche appartient a l'ancienne. */
  private changerDeSociete(): void {
    this.generation++;
    this.agenda.set([]); this.agendaCharge.set(false); this.agendaSuite.set(false);
    this.engine.set([]); this.engineCharge.set(false);
    this.feed.set([]); this.feedCharge.set(false);
    this.online.set([]); this.presenceCharge.set(false);
    void this.loadAgenda();
    void this.loadEngine();
    void this.loadOnline();
    if (this.tab() === 'history') void this.loadFeed();
  }

  private async loadAgenda(): Promise<void> {
    const seq = ++this.agendaSeq;
    this.loading.set(true);
    this.agendaErreur.set(false);
    try {
      const page = await firstValueFrom(this.api.agenda({
        limit: this.pageSize,
        category: this.agendaCategorie(),
        fleetId: this.societeCible(),
      }));
      if (seq !== this.agendaSeq) return;
      this.agenda.set(page);
      this.agendaSuite.set(page.length >= this.pageSize);
      this.agendaCharge.set(true);
    } catch (err) {
      if (seq !== this.agendaSeq) return;
      swallow('fleet-activity:loadAgenda', err);
      // Une panne n'est pas un fil vide : l'ecran le dit, avec un bouton Reessayer.
      this.agenda.set([]);
      this.agendaSuite.set(false);
      this.agendaErreur.set(true);
    } finally {
      if (seq === this.agendaSeq) this.loading.set(false);
    }
  }

  /**
   * « Charger plus » du fil Agenda.
   *
   * 29/09 — IA de la société coupée, une page peut n'être faite QUE de passages de l'agent, masqués :
   * le clic lisait 50 lignes, n'en affichait aucune, et il fallait recliquer sans savoir pourquoi.
   * On enchaîne donc la page suivante tant que rien de nouveau ne s'affiche, que le serveur a une
   * suite et que le curseur avance — au plus `PAGES_AGENDA_PAR_CLIC` pages. IA active, tout se voit :
   * une page par clic, comme avant.
   */
  protected async loadMoreAgenda(): Promise<void> {
    if (!this.agenda().length) return;
    const seq = this.agendaSeq;
    this.loading.set(true);
    try {
      for (let lues = 0; lues < PAGES_AGENDA_PAR_CLIC; lues++) {
        // Le curseur est la dernière ligne BRUTE lue (un passage masqué compris), pas la dernière affichée.
        const last = this.agenda()[this.agenda().length - 1];
        const visiblesAvant = this.agendaVisible().length;
        const more = await firstValueFrom(this.api.agenda({
          limit: this.pageSize,
          before: last.at,
          beforeId: last.id,
          category: this.agendaCategorie(),
          fleetId: this.societeCible(),
        }));
        // Filtre ou societe changes entre-temps : cette page appartient a une autre liste.
        if (seq !== this.agendaSeq) return;
        // Filet contre un curseur qui se recouvre : une ligne deja affichee n'est pas reprise.
        const vus = new Set(this.agenda().map((a) => a.id));
        const nouvelles = more.filter((a) => !vus.has(a.id));
        if (nouvelles.length) this.agenda.update((cur) => [...cur, ...nouvelles]);
        this.agendaSuite.set(more.length >= this.pageSize);
        // Une page qui ne rapporte rien de neuf (curseur qui n'avance plus) arrête aussi la chaîne :
        // la relire en boucle redonnerait la même.
        if (!nouvelles.length || !this.agendaSuite() || this.agendaVisible().length > visiblesAvant) break;
      }
    } catch (err) {
      if (seq !== this.agendaSeq) return;
      swallow('fleet-activity:loadMoreAgenda', err);
      this.toast.error('Chargement impossible', httpFailureMessage(err, "l'activité de l'agenda"));
    } finally {
      // Comme `loadAgenda` : un rechargement parti entre-temps (pastille, société) garde la main
      // sur l'indicateur — la chaîne, plus longue qu'un seul appel, ne le coupe pas sous lui.
      if (seq === this.agendaSeq) this.loading.set(false);
    }
  }

  private async loadOnline(): Promise<void> {
    const gen = this.generation;
    try {
      const liste = await firstValueFrom(this.api.online(this.societeCible()));
      if (gen !== this.generation) return;
      this.online.set(liste);
      this.presenceErreur.set(false);
      this.presenceCharge.set(true);
    } catch (err) {
      // Silencieux : sondage de fond. Signaler toutes les 20 s serait du harcelement.
      swallow('fleet-activity:loadOnline', err);
      this.presenceErreur.set(true);
    }
  }

  private async loadEngine(): Promise<void> {
    const gen = this.generation;
    this.loading.set(true);
    this.engineErreur.set(false);
    try {
      const liste = await firstValueFrom(
        this.api.engineCommands(
          this.pageSize, undefined, this.engineAction() || undefined, this.engineStatus() || undefined, this.societeCible(),
        ),
      );
      if (gen !== this.generation) return;
      this.engine.set(liste);
      this.engineCharge.set(true);
    } catch (err) {
      if (gen !== this.generation) return;
      swallow('fleet-activity:loadEngine', err);
      // Une RELECTURE ratée (Rafraîchir, filtre) n'efface plus la dernière liste reçue : une
      // coupure en échec déjà connue disparaissait du bandeau et le compteur Échec retombait à 0.
      // La note « indisponibles » et les « — » des tuiles disent qu'elle n'est plus à jour ; dans
      // l'onglet Moteurs, la zone passe en erreur. Jamais la liste d'une AUTRE société :
      // changerDeSociete() l'a vidée et a remis engineCharge à false avant cet appel.
      if (!this.engineCharge()) this.engine.set([]);
      this.engineErreur.set(true);
    } finally { this.loading.set(false); }
  }

  protected async loadMoreEngine(): Promise<void> {
    const last = this.engine()[this.engine().length - 1];
    if (!last) return;
    const gen = this.generation;
    this.loading.set(true);
    try {
      const more = await firstValueFrom(
        this.api.engineCommands(
          this.pageSize, last.createdAt, this.engineAction() || undefined, this.engineStatus() || undefined, this.societeCible(),
        ),
      );
      if (gen !== this.generation) return;
      if (more.length) this.engine.update((cur) => [...cur, ...more]);
    } catch (err) {
      swallow('fleet-activity:loadMoreEngine', err);
      // Chargement declenche par l'utilisateur : une panne muette lui laisserait croire
      // qu'il n'y a plus rien a montrer.
      this.toast.error('Chargement impossible', httpFailureMessage(err, 'cette activité'));
    } finally { this.loading.set(false); }
  }

  private async loadFeed(): Promise<void> {
    const gen = this.generation;
    this.loading.set(true);
    this.feedErreur.set(false);
    try {
      const liste = await firstValueFrom(this.api.feed({ limit: this.pageSize, fleetId: this.societeCible() }));
      if (gen !== this.generation) return;
      this.feed.set(liste);
      this.feedCharge.set(true);
    } catch (err) {
      if (gen !== this.generation) return;
      swallow('fleet-activity:loadFeed', err);
      this.feed.set([]);
      this.feedErreur.set(true);
    } finally { this.loading.set(false); }
  }

  protected async loadMoreFeed(): Promise<void> {
    const last = this.feed()[this.feed().length - 1];
    if (!last) return;
    const gen = this.generation;
    this.loading.set(true);
    try {
      const more = await firstValueFrom(this.api.feed({
        limit: this.pageSize, before: last.at, beforeId: last.id, fleetId: this.societeCible(),
      }));
      if (gen !== this.generation) return;
      if (more.length) this.feed.update((cur) => [...cur, ...more]);
    } catch (err) {
      swallow('fleet-activity:loadMoreFeed', err);
      this.toast.error('Chargement impossible', httpFailureMessage(err, 'cet historique'));
    } finally { this.loading.set(false); }
  }

  // ── Le resultat, pas le statut ────────────────────────────────────────────
  /**
   * « Refusee » seul n'aide personne : il faut savoir POURQUOI pour savoir s'il y a quelque
   * chose a faire. Le detail vient de `lastError`, que le serveur ecrit deja
   * (« Vitesse trop elevee : 74 km/h », « Position trop ancienne (…) », « Fix GPS invalide »)
   * et que l'ecran n'affichait pas. Aucun champ nouveau n'a ete demande a l'API.
   */
  protected resultat(c: EngineCommandAuditDto): Resultat {
    switch (c.status) {
      case 'ACKNOWLEDGED':
        return { mot: 'Confirmée', detail: this.delaiAck(c), ton: 'succes', probleme: false };
      case 'SENT':
        return {
          mot: 'Envoyée',
          detail: c.confirmationExpected ? "en attente de la confirmation du boîtier" : 'le boîtier ne confirme pas ce modèle',
          ton: 'attente',
          probleme: false,
        };
      case 'PENDING':
        return { mot: 'En attente', detail: "pas encore transmise au boîtier", ton: 'inactif', probleme: false };
      case 'FAILED':
        return { mot: 'Échec', detail: c.lastError ?? "le boîtier n'a pas répondu", ton: 'alerte', probleme: true };
      case 'REJECTED_SPEED':
        return { mot: 'Refusée', detail: c.lastError ?? 'véhicule en mouvement', ton: 'attente', probleme: true };
      // TRK-018 — « nul ne sait » n'est NI un succes NI un echec. Le ton reste `attente` et
      // `probleme` reste false : ce n'est pas une panne, c'est une absence de preuve. La
      // ranger en echec ferait croire a un incident ; la ranger en succes serait un mensonge.
      case 'SENT_UNCONFIRMED':
        return {
          mot: 'Non confirmée',
          detail: c.channel === 'SMS'
            ? "partie par SMS, aucun retour du boîtier — impossible de dire si elle a abouti"
            : "échéance passée sans réponse du boîtier — impossible de dire si elle a abouti",
          ton: 'attente',
          probleme: false,
        };
      default:
        return { mot: c.status, detail: c.lastError, ton: 'inactif', probleme: false };
    }
  }

  /**
   * Le libelle court d'une puce du bandeau : « GH-204-LP · échec boîtier ». On nomme la CAUSE
   * quand elle tient en deux mots, sinon le mot de resultat suffit — la ligne complete est
   * juste en dessous.
   */
  protected motCourt(c: EngineCommandAuditDto): string {
    if (c.status === 'FAILED') return 'échec boîtier';
    if (c.status === 'REJECTED_SPEED') return 'refusée';
    return this.resultat(c).mot.toLowerCase();
  }

  /** « le boitier a repondu en 4 s » — mesure reelle, jamais une valeur ecrite en dur. */
  private delaiAck(c: EngineCommandAuditDto): string | null {
    if (!c.ackedAt) return null;
    const depart = c.sentAt ?? c.createdAt;
    const ms = new Date(c.ackedAt).getTime() - new Date(depart).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms < 60_000) return `le boîtier a répondu en ${Math.max(1, Math.round(ms / 1000))} s`;
    return `le boîtier a répondu en ${Math.round(ms / 60_000)} min`;
  }

  protected vuIlYA(sec: number): string {
    if (sec < 10) return "vu à l'instant";
    if (sec < 60) return `vu il y a ${Math.round(sec)} s`;
    if (sec < 3600) return `vu il y a ${Math.round(sec / 60)} min`;
    return `vu il y a ${Math.round(sec / 3600)} h`;
  }

  private libelleJour(iso: string): string {
    const d = new Date(iso);
    const auj = new Date();
    const memeJour = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (memeJour(d, auj)) return "Aujourd'hui";
    const hier = new Date(auj.getTime() - 86_400_000);
    if (memeJour(d, hier)) return 'Hier';
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ── Libellés ──────────────────────────────────────────────────────────────
  protected roleLabel(role: string): string {
    switch (role) {
      case 'FLEET_ADMIN': return 'Admin flotte';
      case 'FLEET_MANAGER': return 'Gestionnaire';
      case 'NIGHT_WATCHMAN': return 'Veilleur';
      case 'VIEWER': return 'Observateur';
      default: return role;
    }
  }
  protected sourceLabel(s: string): string {
    switch (s) {
      case 'MANUAL': return 'Manuel';
      case 'SCHEDULER': return 'Planning horaire';
      case 'DEVICE_OBSERVED': return 'Détecté (boîtier)';
      default: return s;
    }
  }
  protected typeLabel(t: string): string {
    switch (t) {
      case 'PAGE_VIEW': return 'Page';
      case 'CLICK': return 'Clic';
      case 'FORM_SUBMIT': return 'Formulaire';
      case 'SCROLL': return 'Défilement';
      // 29/09 — ces cinq types s'affichaient bruts (« SESSION_START ») : un code, pas un mot.
      case 'SESSION_START': return 'Connexion';
      case 'SESSION_END': return 'Déconnexion';
      case 'SESSION_RESUME': return 'Reprise de session';
      case 'IDLE': return 'Inactif';
      case 'AWAY': return 'Absent';
      default: return t;
    }
  }

  /**
   * Ce que l'evenement concerne. Pour une deconnexion, `target` porte la CAUSE sous forme de
   * code (`manual`, `tab_close`, `auto`) : l'afficher tel quel ecrivait « tab_close » a l'ecran.
   */
  protected cibleFeed(f: ActivityFeedItemDto): string {
    if (f.type === 'SESSION_END') {
      switch (f.target) {
        case 'manual': return 'volontaire';
        case 'tab_close': return 'onglet fermé';
        case 'auto': return 'expiration de la session';
        default: return f.routeLabel ?? f.route ?? '';
      }
    }
    return f.routeLabel ?? f.route ?? f.target ?? '';
  }

  // ── Fil Agenda : qui, et de quelle couleur ────────────────────────────────
  protected iconeActeur(kind: FleetAgendaActivityDto['actorKind']): typeof User {
    switch (kind) {
      case 'team': return ShieldCheck;
      case 'public': return Globe;
      case 'agent': return Sparkles;
      case 'system': return Settings;
      default: return User;
    }
  }

  /**
   * Une couleur = une signification (design/TOKENS.md) : vert = acte, rouge = refus ou
   * incident, ambre = en attente d'une decision, bleu = modification, violet = l'IA,
   * gris = retrait sans gravite (annulation, suppression, proposition ecartee).
   */
  private tonAction(action: string): TonAgenda {
    switch (action) {
      case 'reservation_creee':
      case 'reservation_consignee':
      case 'reservation_validee':
      case 'proposition_reservee':
      case 'evenement_clos':
        return 'succes';
      case 'reservation_refusee':
      case 'incident_signale':
        return 'alerte';
      case 'reservation_demandee':
      case 'public_booking_submitted':
        return 'attente';
      case 'agenda_agent_run':
        return 'agent';
      case 'reservation_annulee':
      // Revue du 29/09 : une demande RETIREE par son auteur est un retrait, pas une modification.
      // Tombee dans default, elle s'affichait en bleu a cote d'une « Reservation annulee » grise.
      // Garder admin-activity.component.ts (agendaBadgeCls) d'accord : fleet-activity.component.spec.ts.
      case 'reservation_retiree':
      case 'evenement_supprime':
      case 'proposition_ecartee':
        return 'inactif';
      default:
        // Modifications (modifiee, reaffectee, decalee, scindee, reorganisees, evenement_cree,
        // evenement_modifie, sieges, capacites, plan d'entretien, reglages) et codes inconnus.
        return 'info';
    }
  }
}

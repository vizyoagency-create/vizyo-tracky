import { swallow } from '../../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage } from '../../../core/error/api-error';
import {
  LucideAngularModule, Sparkles, Check, X, AlertTriangle, Loader, Info, MapPin, ChevronDown, ChevronRight,
  Settings, CalendarCheck, TrendingDown, Truck, Clock, Zap,
} from 'lucide-angular';
import {
  FLEET_METIER_LABELS,
  type AgendaAgentProposalDto,
  type AgendaAgentRunDto,
  type AgendaAgentRunResultDto,
  type AiCapacityAnalysisDto,
  type AiCapacityApplyItem,
  type AiCapacityApplyResultDto,
  type AiCapacityLatestDto,
  type AiCapacityProposalDto,
  type FleetMetier,
  type FleetOptimizationDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaSyncService } from '../agenda-sync.service';
import { AgendaApiService } from '../../../core/services/agenda.service';
import { AgendaAgentApiService } from '../../../core/services/agenda-agent.service';
import { AiApiService } from '../../../core/services/ai.service';
import { AiJobService, type AiJobKind } from '../../../core/services/ai-job.service';
import { AiStatusService } from '../../../core/services/ai-status.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetCacheService } from '../../../core/services/fleet-cache.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';

const METIERS: FleetMetier[] = ['CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC'];

/** Les propositions d'un même véhicule, ensemble : « on se perd quand plusieurs positions concernent la même voiture ». */
export interface GroupeProposals {
  vehicleId: string;
  plate: string;
  items: AgendaAgentProposalDto[];
}

/**
 * Regroupe les propositions par véhicule, chaque groupe trié par date, les groupes par plaque.
 * Exportée pour être éprouvée : c'est l'ordre dans lequel le gestionnaire décide.
 */
export function grouperParVehicule(items: AgendaAgentProposalDto[]): GroupeProposals[] {
  const map = new Map<string, GroupeProposals>();
  for (const p of items) {
    const g = map.get(p.vehicleId);
    if (g) g.items.push(p);
    else map.set(p.vehicleId, { vehicleId: p.vehicleId, plate: p.vehiclePlate || '—', items: [p] });
  }
  const groupes = [...map.values()];
  for (const g of groupes) g.items.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  return groupes.sort((a, b) => a.plate.localeCompare(b.plate));
}

/*
 * ── CE QU'« APPLIQUER » ÉCRIT VRAIMENT (revue du 29/09) ─────────────────────────────────────
 *
 * La charge partait telle quelle : `seats: null` effaçait un nombre de places connu quand l'IA ne
 * tranchait pas, et la liste d'équipements REMPLAÇAIT celle de la fiche — un « attelage » saisi à
 * la main disparaissait, le véhicule sortait des critères des réservations. Et l'analyse étant
 * conservée des jours, une correction faite entre-temps dans la vue Parc était réécrite.
 *
 * Désormais : la fiche de référence est celle d'AUJOURD'HUI (`nowSeats`/`nowFeatures`, rendues par
 * `latest`), à défaut celle du jour de l'analyse ; on n'écrit les places que si l'IA propose un
 * entier valide (1 à 99, comme la fiche véhicule) DIFFÉRENT de la fiche ; on n'AJOUTE que les
 * équipements absents (comparés sans casse). Une proposition qui n'ajoute rien n'est plus « à
 * appliquer ».
 *
 * Contre-revue du 29/09 (R24) : on n'envoie QUE les équipements à ajouter — le serveur fait l'union
 * avec la fiche. L'écran envoyait l'union entière, que le serveur tronquait à 20 AVANT d'écarter
 * les équipements déjà présents : sur une fiche de 19 équipements, « rampe » se perdait en silence
 * et le véhicule était pourtant noté « appliqué ». Et un équipement retiré à la main entre la
 * lecture de l'écran et le clic revenait avec l'union.
 */

/** La fiche à laquelle on compare : maintenant si le serveur la donne, sinon au jour de l'analyse. */
function ficheActuelle(p: AiCapacityProposalDto): { seats: number | null | undefined; features: string[] | undefined } {
  return {
    seats: p.nowSeats !== undefined ? p.nowSeats : p.currentSeats,
    features: p.nowFeatures ?? p.currentFeatures,
  };
}

function cleEquipement(f: string): string {
  return f.trim().toLowerCase();
}

/** Équipements proposés ABSENTS de la fiche, dans l'ordre de l'IA, sans doublon. Fiche inconnue : tous. */
export function equipementsAjoutes(p: AiCapacityProposalDto): string[] {
  const deja = new Set((ficheActuelle(p).features ?? []).map(cleEquipement));
  const vus = new Set<string>();
  const out: string[] = [];
  for (const f of p.features ?? []) {
    const k = cleEquipement(f);
    if (!k || deja.has(k) || vus.has(k)) continue;
    vus.add(k);
    out.push(f.trim());
  }
  return out;
}

/** Places à écrire : un entier de 1 à 99 différent de la fiche ; `null` = rien à écrire (IA indécise, ou déjà juste). */
export function placesAEcrire(p: AiCapacityProposalDto): number | null {
  const s = p.seats;
  if (s === null || s === undefined || !Number.isInteger(s) || s < 1 || s > 99) return null;
  return ficheActuelle(p).seats === s ? null : s;
}

/** Vrai si appliquer changerait quelque chose sur la fiche. */
export function propositionUtile(p: AiCapacityProposalDto): boolean {
  return placesAEcrire(p) !== null || equipementsAjoutes(p).length > 0;
}

/**
 * Ce qu'on envoie pour un véhicule coché — `null` s'il n'y a rien à écrire. `features` = les seuls
 * équipements À AJOUTER (le serveur fait l'union avec la fiche), jamais la liste entière (R24).
 */
export function itemApplication(p: AiCapacityProposalDto): AiCapacityApplyItem | null {
  const seats = placesAEcrire(p);
  const ajoutes = equipementsAjoutes(p);
  if (seats === null && ajoutes.length === 0) return null;
  const item: AiCapacityApplyItem = { vehicleId: p.vehicleId };
  if (seats !== null) item.seats = seats;
  if (ajoutes.length > 0) item.features = ajoutes;
  return item;
}

/**
 * Vrai si la proposition vient d'une analyse SANS instantané de la fiche (celles du 28/09, encore en
 * base) : on ne sait pas si la fiche a bougé depuis, seulement qu'elle dit déjà autre chose.
 */
export function sansInstantane(p: AiCapacityProposalDto): boolean {
  return p.currentSeats === undefined && p.currentFeatures === undefined;
}

/**
 * Pourquoi une carte « à revoir » n'est pas appliquée d'office — le même motif que le serveur
 * (contre-revue du 29/09, R23) : « fiche modifiée depuis l'analyse » n'est vrai qu'AVEC un
 * instantané ; sans lui, la fiche indiquait peut-être déjà cette valeur le jour de l'analyse.
 */
export function motifRevue(p: AiCapacityProposalDto): string {
  if (sansInstantane(p)) return 'La fiche indique déjà un autre nombre de places que la proposition : à vérifier avant d\'écrire.';
  const avant = p.currentSeats ?? null;
  const maintenant = p.nowSeats ?? null;
  const detail = avant !== maintenant
    ? ` — places : ${avant ?? '?'} à l'analyse, ${maintenant ?? '?'} aujourd'hui`
    : ' — ses équipements ont changé';
  return `Fiche modifiée depuis l'analyse${detail}. Une correction faite à la main prime : elle n'est pas réécrite d'office.`;
}

/**
 * Le serveur dit-il qu'une analyse de ce parc TOURNE en ce moment (autre onglet, autre poste) ?
 * Drapeau `enCours` s'il est rendu ; à défaut, le motif `MOTIF_EN_COURS` du serveur
 * (ai-optimization.service.ts) — c'est lui qui grise « Analyser le parc » dans ce cas.
 */
export function analyseEnCoursCoteServeur(l: AiCapacityLatestDto | null | undefined): boolean {
  if (!l) return false;
  const drapeau = (l as { enCours?: unknown }).enCours;
  if (typeof drapeau === 'boolean') return drapeau;
  return /d[ée]j[àa] en cours/i.test(l.motif ?? '');
}

/**
 * Clé d'un lot « Tout réserver / Tout écarter » dans `AgendaSyncService.lotsEnCours` : société
 * (« - » pour un compte sans bandeau) + véhicule.
 */
export function cleLot(fleetId: string | null, vehicleId: string): string {
  return `${fleetId ?? '-'}|${vehicleId}`;
}

/** Relecture de la dernière analyse pendant qu'une autre tourne : toutes les 20 s, 15 fois au plus (5 min). */
const RELECTURE_EN_COURS_MS = 20_000;
const RELECTURES_EN_COURS_MAX = 15;

/** « Places : 2 → 9 », « Places : 9 (inchangé) », « Places : 9 — l'IA ne tranche pas ». « ? » = fiche vide. */
export function textePlaces(p: AiCapacityProposalDto): { texte: string; change: boolean } {
  const actuel = ficheActuelle(p).seats;
  const a = actuel === null || actuel === undefined ? '?' : String(actuel);
  const ecrire = placesAEcrire(p);
  if (ecrire !== null) return { texte: `Places : ${a} → ${ecrire}`, change: true };
  if (p.seats === null || p.seats === undefined) return { texte: `Places : ${a} — l'IA ne tranche pas`, change: false };
  if (p.seats === actuel) return { texte: `Places : ${a} (inchangé)`, change: false };
  // 0, plus de 99 ou non entier : la fiche véhicule le refuserait, on ne l'écrit pas.
  return { texte: `Places : ${a} — proposition ${p.seats} ignorée`, change: false };
}

/*
 * ── UN PASSAGE DE L'AGENT, DEUX BOUTONS, UN SEUL GESTE (revue du 29/09) ──────────────────────
 *
 * La feuille Paramètres disait « Lancer l'analyse » (pastille « Analyse de l'agenda »), cette vue
 * « Lancer un passage maintenant » (pastille « Passage de l'agent ») — pour le même appel, alors que
 * « analyse » désigne ici l'analyse du parc, limitée à une par jour. Les deux boutons passent
 * désormais par cette fonction : même titre, même aide, même bilan, même rechargement de la page.
 */

/** Bilan lisible d'un passage, pour la pastille. */
export function resumePassage(r: AgendaAgentRunResultDto): string {
  // Verrou serveur (passage nocturne ou événementiel en cours) : rien n'a été lancé — ne pas le
  // résumer en « rien à proposer », qui ferait passer un agent occupé pour un agent vide.
  if (r.alreadyRunning) return 'Un passage de l\'agent était déjà en cours pour cette société : rien de nouveau n\'a été lancé.';
  if (!r.created && !r.proposed) return 'Aucune habitude assez nette pour proposer une réservation.';
  const fait = `${r.proposed} proposition(s) préparée(s) — à valider dans l'Assistant IA`
    + (r.created ? ` · ${r.created} réservation(s) posée(s)` : '');
  // `aiVerdictQueued = false` confond trois causes (IA coupée, rien à juger, file indisponible) :
  // on ne promet rien, sans accuser un réglage que la pastille ne connaît pas.
  return fait + (r.aiVerdictQueued
    ? ' ; l\'avis de l\'IA arrivera au prochain passage du poste (06:30 ou 14:30).'
    : ' ; aucun avis de l\'IA n\'est attendu pour ce passage.');
}

/**
 * Lance un passage de l'agent en arrière-plan. `fleetId` : société du bandeau pour un super-admin,
 * `null` sinon. Rend `false` si un passage tourne déjà pour cette société (rien n'est lancé).
 * La fin du passage prévient la page par `AgendaSyncService` : elle recharge même si la vue qui a
 * lancé le passage a été détruite entre-temps (changement de vue, feuille fermée).
 */
export function lancerPassageAgent(
  deps: { aiJob: AiJobService; agentApi: AgendaAgentApiService; sync: AgendaSyncService },
  cible: { fleetId: string | null; fleetName: string | null },
): boolean {
  if (deps.aiJob.hasRunningOf('agent-run', cible.fleetId)) return false;
  deps.aiJob.run({
    kind: 'agent-run',
    fleetId: cible.fleetId,
    title: 'Passage de l\'agent' + (cible.fleetName ? ` — ${cible.fleetName}` : ''),
    hint: 'L\'agent parcourt les trajets récurrents et l\'agenda pour préparer des propositions ; il ne réserve jamais. L\'avis de l\'IA arrive au prochain passage du poste (06:30 ou 14:30). Ça prend quelques secondes…',
    task: firstValueFrom(deps.agentApi.run(cible.fleetId ?? undefined)).then((r) => {
      deps.sync.propositionsModifiees();
      return r;
    }),
    summarize: resumePassage,
    refus: {
      409: 'Refusé : l\'agent est désactivé pour cette société. Activez-le dans les Paramètres de l\'agenda, enregistrez, puis relancez.',
    },
  });
  return true;
}

/**
 * ── VUE « ASSISTANT IA » (refonte UX du 28/09, points 2, 6 et 7) ─────────────────────────────
 *
 * « J'ai même pensé qu'il serait préférable de regrouper toutes les actions IA dans un seul onglet
 * dédié, plutôt que d'avoir énormément de boutons dispersés. » Les voici, dans l'ordre où elles
 * servent, chacune disant CE QU'ELLE LIT, CE QU'ELLE PROPOSE et CE QU'ELLE CHANGE :
 *
 *  1. Vérifier le parc — l'analyse des capacités (places, équipements). Analyser ne modifie rien ;
 *     Appliquer écrit les fiches cochées. UNE analyse par jour et par société, résultat conservé.
 *  2. Valider les propositions de l'agent — regroupées par véhicule, actions en ligne.
 *  3. Réserver avec l'IA — ce que « Suggérer avec l'IA » fait dans la feuille Réserver.
 *  Puis les véhicules sous-utilisés (sans IA, déterministe).
 *
 * Remplace les feuilles « Optimisation » et « Propositions de l'agent » (supprimées).
 *
 * Revue du 29/09 : ce que cette vue change, elle le dit à la page par `AgendaSyncService` (plus par
 * des sorties, perdues quand la vue est détruite en cours de traitement) ; elle ne montre que la
 * société du bandeau, et ignore les réponses arrivées pour une autre.
 */
@Component({
  selector: 'app-agenda-ia-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, LucideAngularModule],
  template: `
    <section class="ia" aria-label="Assistant IA">
      <!-- En-tête : ce que l'assistant est, et la règle qui rassure. -->
      <header class="ia-hero">
        <span class="ia-hero-ico"><lucide-icon [img]="SparklesIcon" [size]="20"></lucide-icon></span>
        <div class="ia-hero-txt">
          <h2 class="ia-hero-t">Assistant IA @if (fleetName(); as n) { <span class="ia-hero-fleet">· {{ n }}</span> }</h2>
          <p class="ia-hero-l">Trois gestes, dans l'ordre. <strong>Rien n'est écrit sans votre validation</strong> : l'IA lit et propose, vous décidez.</p>
        </div>
        @if (canEditMetier()) {
          <label class="ia-metier">
            <span>Métier de la flotte</span>
            <select class="ia-in" [value]="metier() ?? ''" (change)="onMetierChange($any($event.target).value)" [disabled]="!metier()">
              @for (m of metiers; track m) { <option [value]="m" [selected]="m === metier()">{{ metierLabel(m) }}</option> }
            </select>
          </label>
        } @else if (metier(); as m) {
          <span class="ia-metier ia-metier--ro"><span>Métier de la flotte</span><strong>{{ metierLabel(m) }}</strong></span>
        }
      </header>

      @if (needsFleet()) {
        <div class="ia-note"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Choisissez une société dans le bandeau en haut de page : l'assistant travaille sur un parc à la fois.</div>
      } @else if (!aiMaster()) {
        <div class="ia-note"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> L'assistance IA est désactivée pour cette société (Paramètres de l'agenda). Les véhicules sous-utilisés, calculés sans IA, restent visibles plus bas.</div>
      }

      <!-- ───── Étape 1 — Vérifier le parc ───── -->
      @if (!needsFleet() && aiCapacity()) {
        <article class="ia-step" [class.ia-step--fait]="etape1Faite()">
          <div class="ia-step-head">
            <span class="ia-n" [class.ia-n--ok]="etape1Faite()">@if (etape1Faite()) { <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> } @else { 1 }</span>
            <h3 class="ia-step-t">Vérifier le parc</h3>
            <!-- Contre-revue du 29/09 (R6/R23) : « à appliquer » ne compte que ce qui se coche ; les
                 fiches modifiées depuis l'analyse se comptent à part, comme le fait le 429 du serveur. -->
            @if (latest()?.analysis) {
              <span class="ia-badge">{{ selectionnables().length }} à appliquer</span>
              @if (cartesRevoir().length > 0) {
                <span class="ia-badge ia-badge--revoir">{{ cartesRevoir().length }} à revoir</span>
              }
            }
          </div>
          <dl class="ia-lit">
            <div><dt>Ce que ça lit</dt><dd>la marque et le modèle de chaque véhicule (Jumpy, Trafic, Kangoo…), et ce que sa fiche dit déjà.</dd></div>
            <div><dt>Ce que ça propose</dt><dd>le nombre de places quand la fiche n'en a pas ou en a un autre, et les équipements absents de la fiche, avec un indice de confiance. Chaque carte montre « actuel → proposé ».</dd></div>
            <div><dt>Ce que ça change</dt><dd><strong>rien</strong> tant que vous n'appliquez pas. « Appliquer » écrit les fiches cochées : les places, et les équipements <strong>ajoutés</strong> à ceux déjà saisis (rien n'est retiré). Les réservations et l'IA de placement s'en servent ensuite.</dd></div>
          </dl>

          <!-- Revue du 29/09 : sans le droit « Optimisation IA », la dernière analyse n'est pas lisible
               (le serveur l'exige). L'écran disait « Aucune analyse pour l'instant » — faux dès qu'un
               administrateur en avait lancé une. On dit la vraie raison, sans règle de quota. -->
          @if (!canRunCapacity()) {
            <div class="ia-note ia-note--in"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> L'analyse du parc est réservée aux comptes autorisés à lancer l'IA. Les places et les équipements se vérifient à la main dans la vue Parc.</div>
          } @else {
            <div class="ia-quota" [class.ia-quota--bloque]="latest() && (!latest()!.canRun || !!latest()!.motif)">
              <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon>
              <span>
                @if (latest()?.analysis; as a) {
                  Dernière analyse le <strong>{{ a.analysedAt | date:'dd/MM à HH:mm' }}</strong>
                  @if (!latest()!.motif) {
                    @if (latest()!.canRun) { — une nouvelle est possible. } @else { — prochaine possible le <strong>{{ latest()!.nextAllowedAt | date:'EEEE d MMM à HH:mm' }}</strong>. }
                  }
                  @if (metierAnalyse(); as m) {
                    <span class="ia-quota-metier">Analyse faite pour le métier « {{ m }} » : le métier de la flotte a changé depuis, vérifiez les places avant d'appliquer.</span>
                  }
                } @else if (latestLoading()) {
                  Lecture de la dernière analyse…
                } @else {
                  Aucune analyse pour l'instant.
                }
                @if (latest()?.motif; as motif) {
                  <span class="ia-quota-metier">{{ motif }}</span>
                }
                <!-- Contre-revue du 29/09 (R9) : une analyse lancée ailleurs (autre onglet, autre poste)
                     est suivie — l'écran relit toutes les 20 s, et le dit ; au-delà de 5 min, il le dit aussi. -->
                @if (enCoursServeur()) {
                  @if (relectureAbandonnee()) {
                    <span class="ia-quota-why">Toujours en cours après 5 minutes : cet écran ne se met plus à jour seul. Changez de vue puis revenez pour relire.</span>
                  } @else {
                    <span class="ia-quota-why">L'écran se met à jour seul dès qu'elle se termine.</span>
                  }
                }
                <span class="ia-quota-why">Une analyse par jour et par société : le parc ne change pas d'heure en heure, et chaque analyse est facturée. Relancer sans avoir rien changé redonne le même résultat.</span>
              </span>
            </div>
          }

          <div class="ia-actions">
            @if (canRunCapacity()) {
              <button type="button" class="ia-btn ia-btn--primary" [disabled]="!peutLancer()" [title]="titreLancement()" (click)="lancerAnalyse()">
                @if (analyseEnCours()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="ia-spin"></lucide-icon> Analyse en cours… } @else { <lucide-icon [img]="SparklesIcon" [size]="14"></lucide-icon> Analyser le parc }
              </button>
            }
            <button type="button" class="ia-btn" (click)="parc.emit()"><lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon> Vérifier à la main dans la vue Parc</button>
          </div>
          @if (latestError(); as e) { <div class="ia-alert ia-alert--err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ e }}</div> }

          @if (latest()?.analysis; as a) {
            @if (a.proposals.length === 0) {
              <!-- Troisième passe du 29/09 (T8) : après un « Appliquer » refusé pour des véhicules supprimés
                   ou sortis du périmètre, la relecture ne rend plus aucune proposition. Le parc n'est pas
                   « déjà renseigné » pour autant : on renvoie aux refus, listés juste en dessous. -->
              @if (ecartees().length > 0) {
                <p class="ia-muted">Plus aucune proposition à afficher : les fiches non appliquées sont listées ci-dessous, chacune avec son motif.</p>
              } @else {
                <p class="ia-muted">Aucune proposition : le parc semble déjà renseigné.</p>
              }
            } @else {
              @if (restantes().length > 0 && !canApply()) {
                <div class="ia-alert ia-alert--info"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Consultation seule — le droit « Modifier un véhicule » est requis pour appliquer.</div>
              }
              <!-- Ce qui se coche : les propositions applicables, et elles seules. -->
              @if (cartes().length > 0) {
                @if (canApply()) {
                  <div class="ia-selbar">
                    <button type="button" class="ia-link" (click)="toggleAll()">{{ allSelected() ? 'Tout désélectionner' : 'Tout sélectionner' }}</button>
                    <span class="ia-selc">{{ nbCochees() }}/{{ selectionnables().length }} cochée(s)</span>
                  </div>
                }
                <div class="ia-cards">
                  @for (c of cartes(); track c.p.vehicleId) {
                    <button type="button" class="ia-card" [class.ia-card--on]="canApply() && selected().has(c.p.vehicleId)" [disabled]="!canApply()" (click)="toggleSel(c.p.vehicleId)">
                      <div class="ia-card-top">
                        <span class="ia-plate">{{ c.p.plate || '—' }}@if (c.p.model) { <span class="ia-model">{{ c.p.model }}</span> }</span>
                        <span class="ia-chip" [class.ia-chip--hi]="c.p.confidence >= 0.7" [class.ia-chip--mid]="c.p.confidence >= 0.4 && c.p.confidence < 0.7" [class.ia-chip--lo]="c.p.confidence < 0.4">{{ c.p.confidence * 100 | number:'1.0-0' }}%</span>
                      </div>
                      <div class="ia-vals">
                        <span [class.ia-val--change]="c.places.change">{{ c.places.texte }}</span>
                        @if (c.ajoutes.length > 0) { <span class="ia-val--change">+ {{ c.ajoutes.join(', ') }}</span> }
                      </div>
                      @if (c.p.reasoning) { <p class="ia-reason">{{ c.p.reasoning }}</p> }
                    </button>
                  }
                </div>
                @if (canApply()) {
                  <div class="ia-apply">
                    <button type="button" class="ia-btn ia-btn--primary" [disabled]="applying() || nbCochees() === 0" (click)="appliquer()">
                      @if (applying()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="ia-spin"></lucide-icon> }
                      {{ applying() ? 'Application…' : 'Appliquer sur ' + nbCochees() + ' fiche(s)' }}
                    </button>
                  </div>
                }
              }
              <!-- Contre-revue du 29/09 (R6/R23) : les fiches modifiées depuis l'analyse ne se cochent
                   pas (« Tout sélectionner » les laisse de côté) et ne comptent pas dans « à appliquer ».
                   Elles vivent ici, repliées ; chacune peut être écrite par un geste explicite. -->
              @if (cartesRevoir().length > 0) {
                <div class="ia-revoir">
                  <button type="button" class="ia-revoir-toggle" (click)="basculerRevoir()" [attr.aria-expanded]="revoirOuvert()">
                    <lucide-icon [img]="revoirOuvert() ? ChevronDownIcon : ChevronRightIcon" [size]="15"></lucide-icon>
                    <lucide-icon [img]="AlertIcon" [size]="13" class="ia-revoir-ico"></lucide-icon>
                    <span>À revoir ({{ cartesRevoir().length }}) — {{ titreRevoir() }}</span>
                  </button>
                  @if (revoirOuvert()) {
                    <p class="ia-muted">Elles ne se cochent pas : une correction faite à la main prime sur l'analyse. Vérifiez-les dans la vue Parc@if (canApply()) {, ou écrivez la proposition sur une fiche précise avec « Appliquer quand même »}.</p>
                    <div class="ia-cards">
                      @for (c of cartesRevoir(); track c.p.vehicleId) {
                        <article class="ia-card ia-card--modif">
                          <div class="ia-card-top">
                            <span class="ia-plate">{{ c.p.plate || '—' }}@if (c.p.model) { <span class="ia-model">{{ c.p.model }}</span> }</span>
                            <span class="ia-chip" [class.ia-chip--hi]="c.p.confidence >= 0.7" [class.ia-chip--mid]="c.p.confidence >= 0.4 && c.p.confidence < 0.7" [class.ia-chip--lo]="c.p.confidence < 0.4">{{ c.p.confidence * 100 | number:'1.0-0' }}%</span>
                          </div>
                          <div class="ia-vals">
                            <span [class.ia-val--change]="c.places.change">{{ c.places.texte }}</span>
                            @if (c.ajoutes.length > 0) { <span class="ia-val--change">+ {{ c.ajoutes.join(', ') }}</span> }
                          </div>
                          <p class="ia-modif"><lucide-icon [img]="AlertIcon" [size]="11"></lucide-icon> {{ c.motif }}</p>
                          @if (c.p.reasoning) { <p class="ia-reason">{{ c.p.reasoning }}</p> }
                          @if (canApply()) {
                            <div class="ia-card-act">
                              <button type="button" class="ia-mini" [disabled]="applying()" title="Écrit sur la fiche ce que montre la carte, malgré la modification" (click)="appliquerQuandMeme(c.p)">
                                @if (forcage().has(c.p.vehicleId)) { <lucide-icon [img]="LoaderIcon" [size]="12" class="ia-spin"></lucide-icon> }
                                Appliquer quand même
                              </button>
                            </div>
                          }
                        </article>
                      }
                    </div>
                  }
                </div>
              }
            }
            <!-- Ce que le serveur a refusé d'écrire, véhicule par véhicule, avec son motif :
                 un toast qui s'efface ne suffit pas pour savoir quelle fiche reprendre.
                 Troisième passe (T8) : hors de la branche « des propositions restent », sinon la liste
                 disparaissait justement quand tous les véhicules refusés avaient quitté la relecture.
                 « Déjà à jour » et « Déjà appliqué » la suivent : ils sont vides sans proposition. -->
            @if (ecartees().length > 0) {
              <div class="ia-alert ia-alert--warn">
                <lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon>
                <div>
                  <strong>Non appliqué :</strong>
                  <ul class="ia-ecartees">
                    @for (s of ecartees(); track s.vehicleId) { <li><span class="ia-plate">{{ s.plate || '—' }}</span> — {{ s.motif }}</li> }
                  </ul>
                </div>
              </div>
            }
            @if (dejaAJour().length > 0) {
              <p class="ia-muted">Déjà à jour, rien à écrire : {{ dejaAJourPlaques() }}</p>
            }
            @if (appliquees().length > 0) {
              <p class="ia-done"><lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> Déjà appliqué : {{ appliqueesPlaques() }}</p>
            }
          }
        </article>
      }

      <!-- ───── Étape 2 — Propositions de l'agent ───── -->
      @if (!needsFleet() && (aiAgent() || proposals().length > 0)) {
        <article class="ia-step" [class.ia-step--fait]="proposals().length === 0">
          <div class="ia-step-head">
            <span class="ia-n" [class.ia-n--ok]="proposals().length === 0">@if (proposals().length === 0) { <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> } @else { 2 }</span>
            <h3 class="ia-step-t">Valider les propositions de l'agent</h3>
            @if (proposals().length > 0) { <span class="ia-badge ia-badge--n">{{ proposals().length }}</span> }
            @if (groupes().length > 1) {
              <button type="button" class="ia-link ia-link--right" (click)="toutReplierOuDeplier()">{{ toutReplie() ? 'Tout déplier' : 'Tout replier' }}</button>
            }
          </div>
          <dl class="ia-lit">
            <div><dt>Ce que ça lit</dt><dd>les trajets des dernières semaines, la nuit ({{ heureNuit() }}).</dd></div>
            <div><dt>Ce que ça propose</dt><dd>une réservation quand un véhicule part au même moment chaque semaine (même jour, même heure, même destination). Elle apparaît en pointillé dans le calendrier et <strong>ne bloque rien</strong>.</dd></div>
            <div><dt>Ce que ça change</dt><dd>« Réserver » pose une vraie réservation sur le créneau. « Écarter » ne change rien : la proposition disparaît.</dd></div>
          </dl>

          @if (proposals().length === 0) {
            <p class="ia-muted">Aucune proposition en attente.
              @if (dernierPassage(); as r) { Dernier passage le {{ r.startedAt | date:'dd/MM à HH:mm' }} : @if (r.status === 'error') { échec. } @else if (r.patterns === 0) { aucune habitude assez nette. } @else { {{ r.patterns }} habitude(s), {{ r.proposed }} proposée(s). } }
            </p>
          } @else {
            <div class="ia-groupes">
              @for (g of groupes(); track g.vehicleId) {
                <div class="ia-g" [class.ia-g--replie]="replies().has(g.vehicleId)">
                  <div class="ia-g-head">
                    <button type="button" class="ia-g-toggle" (click)="basculer(g.vehicleId)" [attr.aria-expanded]="!replies().has(g.vehicleId)">
                      <lucide-icon [img]="replies().has(g.vehicleId) ? ChevronRightIcon : ChevronDownIcon" [size]="15"></lucide-icon>
                      <span class="ia-plate">{{ g.plate }}</span>
                      <span class="ia-g-n">{{ g.items.length }} proposition{{ g.items.length > 1 ? 's' : '' }}</span>
                    </button>
                    <!-- Revue du 29/09 : un seul lot à la fois, et ça se VOIT — les boutons des autres
                         véhicules étaient actifs mais leur clic était ignoré sans un mot, et les lignes
                         du lot restaient cliquables (deux gestes contraires sur la même proposition).
                         Contre-revue (R22) : l'état du lot est lu dans AgendaSyncService, qui survit à
                         cette vue — en revenant sur l'onglet pendant un « Tout réserver », tout reste grisé. -->
                    @if (canManage() && g.items.length > 1) {
                      <div class="ia-g-bulk">
                        <button type="button" class="ia-mini ia-mini--ok" [disabled]="lotEnCours() || groupeOccupe(g)" [title]="titreLot(g)" (click)="toutReserver(g)"><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Tout réserver</button>
                        <button type="button" class="ia-mini" [disabled]="lotEnCours() || groupeOccupe(g)" [title]="titreLot(g)" (click)="toutEcarter(g)"><lucide-icon [img]="XIcon" [size]="12"></lucide-icon> Tout écarter</button>
                      </div>
                    }
                  </div>
                  @if (!replies().has(g.vehicleId)) {
                    <ul class="ia-rows">
                      @for (p of g.items; track p.id) {
                        <li class="ia-row" [class.ia-row--busy]="busy().has(p.id) || lotsVehicules().has(g.vehicleId)">
                          <span class="ia-row-when">{{ p.startAt | date:'EEE d MMM' }} <strong>{{ p.startAt | date:'HH:mm' }} → {{ p.endAt | date:'HH:mm' }}</strong></span>
                          @if (p.destinationLabel) { <span class="ia-row-dest"><lucide-icon [img]="MapPinIcon" [size]="11"></lucide-icon> {{ p.destinationLabel }}</span> }
                          <span class="ia-row-conf" [class.ia-chip--hi]="p.confidence >= 0.7" [title]="p.reasoning">{{ p.confidence * 100 | number:'1.0-0' }}%</span>
                          @if (canManage()) {
                            <span class="ia-row-act">
                              <button type="button" class="ia-mini ia-mini--ok" [disabled]="busy().has(p.id) || lotsVehicules().has(g.vehicleId)" (click)="reserverProposition(p)" title="Réserver ce créneau"><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Réserver</button>
                              <button type="button" class="ia-mini" [disabled]="busy().has(p.id) || lotsVehicules().has(g.vehicleId)" (click)="ecarter(p)" title="Écarter cette proposition" aria-label="Écarter"><lucide-icon [img]="XIcon" [size]="12"></lucide-icon></button>
                            </span>
                          }
                        </li>
                      }
                    </ul>
                  }
                </div>
              }
            </div>
          }

          <div class="ia-actions ia-actions--foot">
            @if (canConfigureAgent() && aiAgent()) {
              <button type="button" class="ia-btn" [disabled]="passageEnCours() || agentEnabled() === false" [title]="agentEnabled() === false ? 'L’agent est désactivé : activez-le dans les réglages.' : 'Préparer les propositions maintenant, sans attendre la nuit'" (click)="lancerPassage()">
                @if (passageEnCours()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="ia-spin"></lucide-icon> } @else { <lucide-icon [img]="ZapIcon" [size]="14"></lucide-icon> } Lancer un passage maintenant
              </button>
            }
            @if (canConfigureAgent()) {
              <button type="button" class="ia-btn" (click)="reglages.emit()"><lucide-icon [img]="SettingsIcon" [size]="14"></lucide-icon> Réglages de l'agent</button>
            }
          </div>
        </article>
      }

      <!-- ───── Étape 3 — Réserver avec l'IA ───── -->
      <!-- Revue du 29/09 : seulement pour qui peut SUGGÉRER (droit « Optimisation IA ») — la feuille
           Réserver cache « Suggérer avec l'IA » aux autres ; l'étape leur promettait un bouton absent. -->
      @if (!needsFleet() && aiPlacement() && canSuggest()) {
        <article class="ia-step ia-step--info">
          <div class="ia-step-head">
            <span class="ia-n">3</span>
            <h3 class="ia-step-t">Réserver avec l'IA</h3>
          </div>
          <dl class="ia-lit">
            <div><dt>Où</dt><dd>dans <strong>Réserver</strong>, le bouton « Suggérer avec l'IA », une fois le créneau et le besoin saisis.</dd></div>
            <div><dt>Ce que ça lit</dt><dd>les véhicules libres sur le créneau : places, sièges auto à bord ou en stock, énergie, coût au kilomètre, utilisation récente.</dd></div>
            <div><dt>Ce que ça change</dt><dd>rien : elle classe les trois meilleurs et pré-sélectionne le premier. C'est « Réserver » qui réserve.</dd></div>
          </dl>
          @if (canReserve()) {
            <div class="ia-actions"><button type="button" class="ia-btn ia-btn--primary" (click)="reserver.emit()"><lucide-icon [img]="CalendarCheckIcon" [size]="14"></lucide-icon> Ouvrir Réserver</button></div>
          }
        </article>
      }

      <!-- ───── Sous-utilisés (déterministe, sans IA) ───── -->
      @if (!needsFleet()) {
        <article class="ia-step ia-step--plain">
          <div class="ia-step-head">
            <span class="ia-n ia-n--plain"><lucide-icon [img]="TrendingDownIcon" [size]="13"></lucide-icon></span>
            <h3 class="ia-step-t">Véhicules sous-utilisés <span class="ia-sans">sans IA</span></h3>
          </div>
          <p class="ia-muted">Calculé sur les trajets réels des 28 derniers jours : les véhicules qui roulent peu, et quand ils sont libres. Utile avant de réserver ou de mutualiser.</p>
          @if (utilLoading()) { <div class="ia-skel"></div> }
          @else if (underutilized().length === 0) { <p class="ia-muted">Aucun véhicule franchement sous-utilisé.</p> }
          @else {
            <div class="ia-under">
              @for (v of underutilized(); track v.vehicleId) {
                <div class="ia-u">
                  <div class="ia-u-top"><span class="ia-plate">{{ v.vehiclePlate || '—' }}</span><span class="ia-u-pct">{{ v.utilizationRatio * 100 | number:'1.0-0' }}% utilisé</span></div>
                  @if (v.freePatterns.length > 0) { <div class="ia-free">@for (fp of v.freePatterns; track fp) { <span class="ia-free-c">Libre {{ fp }}</span> }</div> }
                </div>
              }
            </div>
          }
        </article>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ia { display: flex; flex-direction: column; gap: 12px; }
    .ia-hero { display: flex; gap: 12px; align-items: flex-start; padding: 14px 15px; border-radius: 14px; border: 1px solid var(--border-subtle);
               background: color-mix(in srgb, var(--tracky) 5%, var(--bg-secondary)); flex-wrap: wrap; }
    .ia-hero-ico { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; background: var(--tracky); color: var(--accent-ink); flex-shrink: 0; }
    .ia-hero-txt { flex: 1; min-width: 220px; }
    .ia-hero-t { margin: 0; font-size: 16px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .ia-hero-fleet { font-weight: 600; color: var(--fg-secondary); }
    .ia-hero-l { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-secondary); line-height: 1.5; }
    .ia-hero-l strong { color: var(--fg-primary); }
    .ia-metier { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .ia-metier--ro strong { font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--fg-primary); }
    .ia-in { padding: 7px 10px; border-radius: 9px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 13px; text-transform: none; letter-spacing: 0; font-weight: 600; }
    .ia-note { display: flex; align-items: center; gap: 7px; padding: 10px 12px; border-radius: 11px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: 12.5px; }

    .ia-step { display: flex; flex-direction: column; gap: 10px; padding: 14px 15px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .ia-step--fait { border-color: color-mix(in srgb, var(--tracky-light) 35%, transparent); }
    .ia-step-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .ia-n { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 8px; font-family: var(--font-mono); font-size: 12px; font-weight: 800;
            background: color-mix(in srgb, var(--tracky) 12%, transparent); color: var(--texte-succes); flex-shrink: 0; }
    .ia-n--ok { background: var(--tracky-light); color: var(--accent-ink); }
    .ia-n--plain { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .ia-step-t { margin: 0; font-size: 14.5px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .ia-sans { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-tertiary); margin-left: 6px; }
    .ia-badge { font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .ia-badge--n { background: color-mix(in srgb, var(--violet) 16%, transparent); color: var(--texte-violet); }

    /* « Ce que ça lit / propose / change » : trois lignes, toujours les mêmes, pour que l'œil les retrouve. */
    .ia-lit { display: grid; grid-template-columns: 1fr; gap: 4px; margin: 0; font-size: 12.5px; line-height: 1.45; }
    .ia-lit div { display: flex; gap: 8px; }
    .ia-lit dt { flex: 0 0 118px; font-weight: 700; color: var(--fg-tertiary); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; padding-top: 2px; }
    .ia-lit dd { margin: 0; color: var(--fg-secondary); }
    .ia-lit dd strong { color: var(--fg-primary); }

    .ia-quota { display: flex; gap: 8px; align-items: flex-start; padding: 9px 11px; border-radius: 10px; background: var(--bg-tertiary); font-size: 12px; color: var(--fg-secondary); line-height: 1.45; }
    .ia-quota lucide-icon { color: var(--tracky-light); flex-shrink: 0; margin-top: 2px; }
    .ia-quota strong { color: var(--fg-primary); }
    .ia-quota--bloque { background: color-mix(in srgb, var(--warning) 10%, transparent); }
    .ia-quota-why { display: block; margin-top: 3px; font-size: 11.5px; color: var(--fg-tertiary); }
    /* Ce qui rend l'analyse conservée moins sûre (métier changé, compte restreint) : dit sous la date. */
    .ia-quota-metier { display: block; margin-top: 3px; font-weight: 600; color: var(--texte-attente); }
    .ia-note--in { background: var(--bg-tertiary); }

    .ia-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .ia-actions--foot { padding-top: 6px; border-top: 1px dashed var(--border-subtle); }
    .ia-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 700; min-height: 40px;
              background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; }
    .ia-btn:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--border-strong); }
    .ia-btn--primary { background: var(--tracky); color: var(--accent-ink); border-color: transparent; }
    .ia-btn--primary:hover:not(:disabled) { background: var(--tracky-dark); color: var(--accent-ink); }
    .ia-btn:disabled { opacity: .55; cursor: not-allowed; }
    .ia-link { font-size: 12px; font-weight: 600; color: var(--tracky-light); }
    .ia-link--right { margin-left: auto; }
    .ia-selbar { display: flex; align-items: center; justify-content: space-between; }
    .ia-selc { font-size: 12px; color: var(--fg-tertiary); }
    .ia-cards { display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 640px) { .ia-cards { grid-template-columns: 1fr 1fr; } }
    @media (min-width: 1100px) { .ia-cards { grid-template-columns: 1fr 1fr 1fr; } }
    .ia-card { text-align: left; padding: 10px 11px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ia-card--on { border-color: var(--tracky-light); box-shadow: 0 0 0 1px var(--tracky-light) inset; background: color-mix(in srgb, var(--tracky-light) 7%, var(--bg-tertiary)); }
    .ia-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .ia-plate { font-weight: 800; color: var(--fg-primary); letter-spacing: .3px; font-family: var(--font-mono, monospace); }
    .ia-model { display: block; font-size: 11px; color: var(--fg-tertiary); font-weight: 400; margin-top: 1px; font-family: inherit; }
    .ia-vals { display: flex; gap: 12px; margin-top: 6px; font-size: 12px; font-weight: 700; color: var(--fg-secondary); flex-wrap: wrap; }
    /* « actuel → proposé » : ce qui changera sur la fiche ressort, le reste se lit en retrait. */
    .ia-val--change { color: var(--texte-succes); }
    .ia-card--modif { border-style: dashed; border-color: color-mix(in srgb, var(--warning) 55%, var(--border-subtle)); }
    .ia-modif { display: flex; align-items: flex-start; gap: 5px; margin: 6px 0 0; font-size: 11.5px; font-weight: 600; color: var(--texte-attente); line-height: 1.4; }
    .ia-modif lucide-icon { flex-shrink: 0; margin-top: 2px; }
    .ia-card-act { display: flex; justify-content: flex-end; margin-top: 8px; }
    /* « À revoir » : repliée par défaut, en retrait — ce n'est pas le travail du jour. */
    .ia-badge--revoir { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--texte-attente); }
    .ia-revoir { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 0; border-top: 1px dashed var(--border-subtle); }
    .ia-revoir-toggle { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 6px 8px 6px 2px; min-height: 40px; border-radius: 8px;
                        font-size: 12.5px; font-weight: 700; color: var(--texte-attente); text-align: left; }
    .ia-revoir-toggle:hover { background: var(--bg-tertiary); }
    .ia-revoir-ico { flex-shrink: 0; }
    .ia-reason { font-size: 11.5px; color: var(--fg-secondary); margin: 6px 0 0; line-height: 1.4; }
    .ia-chip { font-size: 11.5px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--bg-secondary); color: var(--fg-tertiary); }
    .ia-chip--hi { color: var(--texte-succes); background: color-mix(in srgb, var(--tracky-light) 14%, transparent); }
    .ia-chip--mid { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 14%, transparent); }
    .ia-chip--lo { color: var(--texte-alerte); background: color-mix(in srgb, var(--danger) 13%, transparent); }
    .ia-apply { display: flex; justify-content: flex-end; }
    .ia-done { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--texte-succes); font-weight: 600; }
    .ia-muted { margin: 0; font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.45; }
    .ia-alert { display: flex; align-items: center; gap: 7px; padding: 9px 11px; border-radius: 10px; font-size: 12px; }
    .ia-alert--err { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); }
    .ia-alert--info { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .ia-alert--warn { align-items: flex-start; background: color-mix(in srgb, var(--warning) 10%, transparent); color: var(--texte-attente); }
    .ia-alert--warn lucide-icon { flex-shrink: 0; margin-top: 2px; }
    .ia-ecartees { margin: 4px 0 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; color: var(--fg-secondary); }
    .ia-skel { height: 56px; border-radius: 12px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: ia-sh 1.3s infinite; }
    @keyframes ia-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .ia-spin { animation: ia-spin 1s linear infinite; }
    @keyframes ia-spin { to { transform: rotate(360deg); } }

    /* Propositions groupées par véhicule : une ligne par proposition, les actions au bout de la ligne. */
    .ia-groupes { display: flex; flex-direction: column; gap: 8px; }
    .ia-g { border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-tertiary); overflow: hidden; }
    .ia-g-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 6px 4px; flex-wrap: wrap; }
    .ia-g-toggle { display: inline-flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 8px; color: var(--fg-secondary); min-height: 40px; }
    .ia-g-toggle:hover { background: var(--bg-secondary); }
    .ia-g-n { font-size: 11.5px; color: var(--fg-tertiary); }
    .ia-g-bulk { display: flex; gap: 6px; }
    .ia-rows { list-style: none; margin: 0; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 4px; }
    .ia-row { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 9px; background: var(--bg-secondary); font-size: 12.5px; color: var(--fg-secondary); flex-wrap: wrap; }
    .ia-row--busy { opacity: .55; }
    .ia-row-when { text-transform: capitalize; white-space: nowrap; }
    .ia-row-when strong { color: var(--fg-primary); text-transform: none; }
    .ia-row-dest { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; color: var(--texte-succes); }
    .ia-row-conf { font-size: 11px; font-weight: 800; padding: 1px 7px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-tertiary); cursor: help; }
    .ia-row-act { margin-left: auto; display: inline-flex; gap: 6px; }
    .ia-mini { display: inline-flex; align-items: center; gap: 4px; padding: 6px 9px; border-radius: 8px; font-size: 12px; font-weight: 700; min-height: 32px;
               background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; }
    .ia-mini--ok { background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--texte-succes); border-color: color-mix(in srgb, var(--tracky-light) 30%, transparent); }
    .ia-mini:disabled { opacity: .5; }

    .ia-under { display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 640px) { .ia-under { grid-template-columns: 1fr 1fr; } }
    @media (min-width: 1100px) { .ia-under { grid-template-columns: 1fr 1fr 1fr; } }
    .ia-u { padding: 9px 11px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ia-u-top { display: flex; align-items: center; justify-content: space-between; }
    .ia-u-pct { font-size: 12px; font-weight: 800; color: var(--texte-attente); }
    .ia-free { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .ia-free-c { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 6px; background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--texte-succes); }

    @media (max-width: 480px) {
      .ia-lit dt { flex-basis: 96px; }
      .ia-row-act { margin-left: 0; width: 100%; justify-content: flex-end; }
    }
  `],
})
export class AgendaIaViewComponent {
  private readonly ai = inject(AiApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly aiJob = inject(AiJobService);
  private readonly agentApi = inject(AgendaAgentApiService);
  private readonly agendaApi = inject(AgendaApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetCache = inject(FleetCacheService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly sync = inject(AgendaSyncService);

  /** Propositions en attente — chargées par la page (elle en porte le compteur). */
  readonly proposals = input<AgendaAgentProposalDto[]>([]);
  /** Ouvrir la feuille Réserver. */
  readonly reserver = output<void>();
  /** Ouvrir les réglages de l'agent (feuille Paramètres). */
  readonly reglages = output<void>();
  /** Basculer sur la vue Parc. */
  readonly parc = output<void>();
  /**
   * @deprecated Revue du 29/09 : n'est plus émise. Émise APRÈS la destruction de la vue (on change
   * d'onglet pendant « Tout réserver » ou un passage), elle n'arrivait jamais à la page : calendrier,
   * fantômes et badge restaient périmés. Les changements passent par
   * `AgendaSyncService.propositionsModifiees()`. Gardée déclarée tant que la page s'y lie.
   */
  readonly changed = output<void>();
  /** @deprecated Revue du 29/09 : n'est plus émise — voir `AgendaSyncService.vehiculesModifies()`. */
  readonly capaciteAppliquee = output<void>();

  protected readonly SparklesIcon = Sparkles;
  protected readonly CheckIcon = Check;
  protected readonly XIcon = X;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly InfoIcon = Info;
  protected readonly MapPinIcon = MapPin;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly SettingsIcon = Settings;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly TrendingDownIcon = TrendingDown;
  protected readonly TruckIcon = Truck;
  protected readonly ClockIcon = Clock;
  protected readonly ZapIcon = Zap;
  protected readonly metiers = METIERS;

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly selectedFleetId = computed(() => (this.isSuperAdmin() ? this.fleetFilter.selectedFleetId() : null));
  protected readonly fleetName = computed(() => this.fleetCache.getName(this.selectedFleetId()));
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.selectedFleetId());
  protected readonly aiMaster = computed(() => this.aiStatus.can('capacity') || this.aiStatus.can('agendaAgent') || this.aiStatus.can('placement'));
  protected readonly aiCapacity = computed(() => this.aiStatus.can('capacity'));
  protected readonly aiAgent = computed(() => this.aiStatus.can('agendaAgent'));
  protected readonly aiPlacement = computed(() => this.aiStatus.can('placement'));
  /** Lire la dernière analyse ET en lancer une : le serveur exige « Optimisation IA » pour les deux. */
  protected readonly canRunCapacity = computed(() => this.perms.can('ai_optimize'));
  /** « Suggérer avec l'IA » dans Réserver : même droit (la feuille le cache sinon). */
  protected readonly canSuggest = computed(() => this.perms.can('ai_optimize'));
  protected readonly canApply = computed(() => this.perms.can('vehicles_edit'));
  protected readonly canManage = computed(() => this.perms.can('reservations_manage'));
  protected readonly canReserve = computed(() => this.perms.can('reservations_request'));
  protected readonly canConfigureAgent = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  protected readonly canEditMetier = computed(() => this.canConfigureAgent() && this.perms.can('ai_optimize'));

  // ─── Étape 1 ───
  protected readonly latest = signal<AiCapacityLatestDto | null>(null);
  protected readonly latestLoading = signal(false);
  protected readonly latestError = signal<string | null>(null);
  protected readonly selected = signal<Set<string>>(new Set());
  /**
   * Sociétés dont une application est en vol (contre-revue du 29/09, R25). Tenue PAR SOCIÉTÉ : un
   * super-admin qui applique sur A puis passe sur B retrouve le bouton de B libre, et « Application… »
   * s'il revient sur A avant la réponse — jamais la fin de A qui libère le bouton de B en plein envoi.
   */
  private readonly enApplication = signal<ReadonlySet<string>>(new Set());
  protected readonly applying = computed(() => this.enApplication().has(this.selectedFleetId() ?? '-'));
  /** Véhicules en cours d'« Appliquer quand même » (le sablier de leur carte). */
  protected readonly forcage = signal<ReadonlySet<string>>(new Set());
  /** Section « À revoir » : repliée par défaut. */
  protected readonly revoirOuvert = signal(false);
  protected readonly metier = signal<FleetMetier | null>(null);
  /** Ce que le serveur a refusé d'écrire au dernier « Appliquer », véhicule par véhicule, avec le motif. */
  protected readonly ecartees = signal<AiCapacityApplyResultDto['skipped']>([]);
  /** Propositions pas encore appliquées. */
  private readonly nonAppliquees = computed<AiCapacityProposalDto[]>(() => {
    const a = this.latest()?.analysis;
    if (!a) return [];
    const faites = new Set(a.appliedVehicleIds);
    return a.proposals.filter((p) => !faites.has(p.vehicleId));
  });
  /**
   * « À appliquer » = pas encore appliquées ET qui changeraient la fiche. L'IA répond pour CHAQUE
   * véhicule en service : sans ce filtre, le badge valait la taille du parc et l'étape ne se
   * cochait qu'en « appliquant » aussi les fiches déjà justes (revue du 29/09).
   */
  protected readonly restantes = computed(() => this.nonAppliquees().filter(propositionUtile));
  protected readonly dejaAJour = computed(() => this.nonAppliquees().filter((p) => !propositionUtile(p)));
  protected readonly dejaAJourPlaques = computed(() => this.dejaAJour().map((p) => p.plate || '—').join(', '));
  /**
   * Ce qui se coche : pas les fiches modifiées depuis l'analyse — une correction faite entre-temps
   * dans la vue Parc ne doit pas être réécrite par l'ancienne proposition. Le serveur les écarte de
   * toute façon (« fiche modifiée depuis l'analyse ») : les laisser cocher promettrait une écriture
   * qui n'aura pas lieu. « Tout sélectionner » ne coche donc que celles-ci.
   */
  protected readonly selectionnables = computed(() => this.restantes().filter((p) => p.ficheModifiee !== true));
  /**
   * Contre-revue du 29/09 (R6/R23) — les fiches modifiées depuis l'analyse : ni cochables, ni
   * comptées « à appliquer », ni dans l'étape à cocher. Elles restaient dans le badge et l'étape 1 ne
   * se cochait plus jusqu'à la prochaine analyse (payante, 24 h plus tard). Elles sont listées à
   * part, repliées, avec « Appliquer quand même » (`forcer`) carte par carte.
   */
  protected readonly aRevoir = computed(() => this.restantes().filter((p) => p.ficheModifiee === true));
  /** Ce que chaque carte affiche : « actuel → proposé » et les équipements AJOUTÉS. */
  protected readonly cartes = computed(() =>
    this.selectionnables().map((p) => ({ p, places: textePlaces(p), ajoutes: equipementsAjoutes(p) })),
  );
  protected readonly cartesRevoir = computed(() =>
    this.aRevoir().map((p) => ({ p, places: textePlaces(p), ajoutes: equipementsAjoutes(p), motif: motifRevue(p) })),
  );
  /**
   * Titre de la section : « fiche modifiée depuis l'analyse » n'est vrai qu'avec un instantané. Une
   * analyse du 28/09 n'en a pas — la fiche disait peut-être déjà autre chose le jour même (R23).
   */
  protected readonly titreRevoir = computed(() =>
    this.aRevoir().every(sansInstantane) ? 'la fiche indique déjà un autre nombre de places' : 'fiche modifiée depuis l\'analyse',
  );
  protected readonly nbCochees = computed(() => {
    const s = this.selected();
    return this.selectionnables().filter((p) => s.has(p.vehicleId)).length;
  });
  protected readonly appliquees = computed<AiCapacityProposalDto[]>(() => {
    const a = this.latest()?.analysis;
    if (!a) return [];
    const faites = new Set(a.appliedVehicleIds);
    return a.proposals.filter((p) => faites.has(p.vehicleId));
  });
  protected readonly appliqueesPlaques = computed(() => this.appliquees().map((p) => p.plate || '—').join(', '));
  /**
   * L'étape est « faite » quand il y a une analyse et plus rien d'APPLICABLE : les fiches « à
   * revoir » n'y comptent pas — la correction faite à la main prime, c'est la règle du serveur
   * (`resteDeLAnalyse`), et le badge « à revoir » continue de les signaler.
   */
  protected readonly etape1Faite = computed(() => !!this.latest()?.analysis && this.selectionnables().length === 0);
  protected readonly allSelected = computed(() => {
    const r = this.selectionnables();
    const s = this.selected();
    return r.length > 0 && r.every((p) => s.has(p.vehicleId));
  });
  /**
   * Revue du 29/09 (D2) : l'analyse conservée a été faite pour un AUTRE métier que celui de la
   * flotte aujourd'hui — le nombre de places en dépend (fourgon ou navette). On le dit sous la date.
   */
  protected readonly metierAnalyse = computed<string | null>(() => {
    const a = this.latest()?.analysis;
    const m = this.metier();
    if (!a || !m || a.metier === m) return null;
    return FLEET_METIER_LABELS[a.metier] ?? a.metier;
  });
  /**
   * Troisième passe du 29/09 (T6) — sociétés (`fleetId ?? '-'`) dont une analyse du parc LANCÉE D'ICI
   * tourne encore, tenues par la tâche elle-même et non par la liste des pastilles. Le X de la
   * pastille la retire même en cours (« l'analyse continue en arrière-plan ») : `enCoursPour`
   * retombait alors à faux, « Analyser le parc » redevenait actif pendant que le serveur tenait son
   * verrou — un clic, un 429, « Refusé » pour un geste que l'écran proposait.
   */
  private readonly analysesLanceesIci = signal<ReadonlySet<string>>(new Set());
  /** « En cours » pour la société AFFICHÉE seulement : une analyse de A ne grise pas le bouton de B. */
  protected readonly analyseEnCours = computed(
    () => this.enCoursPour('optimization') || this.analysesLanceesIci().has(this.selectedFleetId() ?? '-'),
  );
  /** Le serveur dit qu'une analyse de ce parc tourne (lancée d'un autre onglet ou d'un autre poste). */
  protected readonly enCoursServeur = computed(() => analyseEnCoursCoteServeur(this.latest()));
  /** Les 15 relectures sont faites et l'analyse tourne toujours : l'écran ne suit plus (et le dit). */
  protected readonly relectureAbandonnee = signal(false);
  protected readonly peutLancer = computed(
    () => !this.analyseEnCours() && !this.latestLoading() && (this.latest()?.canRun ?? true) && !this.latest()?.motif && !this.needsFleet(),
  );
  protected readonly titreLancement = computed(() => {
    const l = this.latest();
    if (l?.motif) return l.motif;
    if (l && !l.canRun) return 'Une analyse par jour et par société — voir la date de la prochaine.';
    return 'L\'IA lit le parc et propose ; rien n\'est écrit.';
  });

  // ─── Étape 2 ───
  protected readonly groupes = computed(() => grouperParVehicule(this.proposals()));
  /**
   * Véhicules DÉPLIÉS (le premier seulement à l'ouverture) : « on peut rapidement se perdre lorsque
   * plusieurs positions concernent le même véhicule » — 418 propositions sur 20 véhicules se lisent
   * comme 20 lignes, et chaque véhicule s'ouvre d'un geste. `replies()` rend l'ensemble des repliés.
   */
  private readonly deplies = signal<Set<string> | null>(null);
  protected readonly replies = computed<Set<string>>(() => {
    const groupes = this.groupes();
    const ouverts = this.deplies() ?? new Set(groupes.slice(0, 1).map((g) => g.vehicleId));
    return new Set(groupes.filter((g) => !ouverts.has(g.vehicleId)).map((g) => g.vehicleId));
  });
  protected readonly toutReplie = computed(() => this.groupes().length > 0 && this.replies().size === this.groupes().length);
  /** Propositions tenues par un geste de ligne (Réserver / Écarter) — une requête, le temps d'un clic. */
  protected readonly busy = signal<Set<string>>(new Set());
  /**
   * Contre-revue du 29/09 (R22) — véhicules de la société AFFICHÉE dont un lot « Tout réserver /
   * Tout écarter » tourne. Lu dans `AgendaSyncService.lotsEnCours` (racine) et non dans l'instance :
   * la vue est détruite quand on change d'onglet, le lot continue ; la nouvelle instance avait tout
   * de nouveau cliquable, sur une liste encore périmée — relancer le lot rejouait des propositions
   * déjà traitées (toasts « refusée(s) » pour des réservations bien créées).
   */
  protected readonly lotsVehicules = computed<ReadonlySet<string>>(() => {
    const prefixe = cleLot(this.selectedFleetId(), '');
    return new Set([...this.sync.lotsEnCours()].filter((k) => k.startsWith(prefixe)).map((k) => k.slice(prefixe.length)));
  });
  /** Un lot tourne dans cette société : un seul à la fois, les boutons des autres véhicules sont grisés. */
  protected readonly lotEnCours = computed(() => this.lotsVehicules().size > 0);
  protected readonly dernierPassage = signal<AgendaAgentRunDto | null>(null);
  protected readonly agentEnabled = signal<boolean | null>(null);
  protected readonly nightlyHour = signal<number | null>(null);
  protected readonly heureNuit = computed(() => (this.nightlyHour() === null ? 'à l\'heure réglée' : `vers ${this.nightlyHour()} h`));
  protected readonly passageEnCours = computed(() => this.enCoursPour('agent-run'));

  // ─── Sous-utilisés ───
  protected readonly utilLoading = signal(false);
  protected readonly util = signal<FleetOptimizationDto | null>(null);
  protected readonly underutilized = computed(() => (this.util()?.vehicles ?? []).filter((v) => v.underutilized).slice(0, 12));

  /*
   * ── UNE SOCIÉTÉ À LA FOIS (revue du 29/09) ─────────────────────────────────────────────────
   * Un super-admin change de société pendant qu'une lecture est en vol : sa réponse arrivait après
   * celle de la nouvelle société et l'écrasait — cartes de A sous « Assistant IA · B ». Chaque
   * lecture porte donc un numéro ; seule la DERNIÈRE lancée a le droit d'écrire. Et au changement
   * de société, tout ce qui venait de l'ancienne est effacé avant de relire.
   */
  private seqLatest = 0;
  private seqMetier = 0;
  private seqUtil = 0;
  private seqAgent = 0;
  /** Société dont l'écran montre l'état (`undefined` = pas encore lue). */
  private societe: string | null | undefined = undefined;
  /** Travaux d'analyse déjà vus terminés : leur fin ne fait relire qu'une fois. */
  private readonly jobsVus = new Set<string>();
  private syncVu = 0;

  /*
   * ── UNE ANALYSE QUI TOURNE AILLEURS (contre-revue du 29/09, R9) ──────────────────────────────
   * Un onglet rechargé pendant l'attente, ou le poste d'un autre gestionnaire, lit « Une analyse de
   * ce parc est déjà en cours » et un bouton grisé. Seul l'onglet qui l'a LANCÉE relisait à la fin
   * (sa pastille) : les autres restaient sur ce message, même quand l'analyse avait échoué et qu'une
   * nouvelle redevenait permise. Tant que le serveur dit « en cours », on relit donc toutes les 20 s,
   * 15 fois au plus ; plus rien à la destruction de la vue ni au changement de société.
   */
  private minuteurEnCours: ReturnType<typeof setTimeout> | null = null;
  private relecturesEnCours = 0;
  private detruite = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.detruite = true;
      this.arreterRelecture();
    });
    this.aiStatus.ensureLoaded();
    void this.fleetCache.loadIfNeeded();
    for (const j of this.aiJob.jobs()) if (j.status !== 'running') this.jobsVus.add(j.id);
    this.syncVu = this.sync.propositions();

    // À l'affichage, à chaque changement de société, et quand l'état de l'IA ou les droits
    // arrivent (ils se chargent en parallèle) : tout est relu.
    effect(() => {
      const societe = this.selectedFleetId();
      const besoin = this.needsFleet();
      this.aiCapacity();
      this.canRunCapacity();
      this.canConfigureAgent();
      untracked(() => {
        if (societe !== this.societe) {
          this.societe = societe;
          this.remettreAZero();
        }
        if (besoin) return;
        void this.chargerLatest();
        void this.chargerMetier();
        void this.chargerUtil();
        void this.chargerAgent();
      });
    });

    // Fin d'une analyse du parc lancée en arrière-plan : relue SEULEMENT si c'est celle de la
    // société affichée (celle de A, finie pendant qu'on regarde B, n'a rien à dire sur B).
    effect(() => {
      const jobs = this.aiJob.jobs();
      const courante = this.selectedFleetId();
      let relire = false;
      for (const j of jobs) {
        if (j.kind !== 'optimization' || j.status === 'running' || this.jobsVus.has(j.id)) continue;
        this.jobsVus.add(j.id);
        if ((j.fleetId ?? null) === courante) relire = true;
      }
      if (relire) untracked(() => void this.chargerLatest());
    });

    // Un passage de l'agent a fini, ou la feuille Paramètres (ouverte PAR-DESSUS cette vue) a
    // enregistré les réglages de l'agent ou changé le métier de la flotte (contre-revue R20 : le
    // métier s'enregistre seul, sans « Enregistrer ») : dernier passage, activation et métier relus —
    // sinon « Lancer un passage » restait grisé « activez-le dans les réglages » après l'avoir fait,
    // et l'avertissement « analyse faite pour un autre métier » ne s'affichait pas.
    effect(() => {
      const v = this.sync.propositions();
      if (v === this.syncVu) return;
      this.syncVu = v;
      untracked(() => {
        void this.chargerAgent();
        void this.chargerMetier();
      });
    });
  }

  protected metierLabel(m: FleetMetier): string { return FLEET_METIER_LABELS[m]; }

  private fleetParam(): string | undefined { return this.selectedFleetId() ?? undefined; }

  private enCoursPour(kind: AiJobKind): boolean {
    const f = this.selectedFleetId();
    return this.aiJob.jobs().some((j) => j.kind === kind && j.status === 'running' && (j.fleetId ?? null) === f);
  }

  /** Changement de société : rien de l'ancienne ne reste affiché, et ses réponses en vol sont ignorées. */
  private remettreAZero(): void {
    this.seqLatest++;
    this.seqMetier++;
    this.seqUtil++;
    this.seqAgent++;
    this.latest.set(null);
    this.latestLoading.set(false);
    this.latestError.set(null);
    this.ecartees.set([]);
    this.metier.set(null);
    this.util.set(null);
    this.utilLoading.set(false);
    this.dernierPassage.set(null);
    this.agentEnabled.set(null);
    this.nightlyHour.set(null);
    this.selected.set(new Set());
    this.deplies.set(null);
    this.revoirOuvert.set(false);
    // L'analyse suivie était celle de l'ancienne société : plus de relecture pour elle.
    this.arreterRelecture();
    this.relecturesEnCours = 0;
    this.relectureAbandonnee.set(false);
  }

  /**
   * Relit la dernière analyse. `silencieux` : relecture de suivi (analyse en cours ailleurs) — ni
   * « Lecture de la dernière analyse… » qui clignoterait toutes les 20 s, ni erreur affichée.
   */
  private async chargerLatest(opts: { silencieux?: boolean } = {}): Promise<void> {
    if (!this.canRunCapacity() || !this.aiCapacity() || this.needsFleet()) {
      this.arreterRelecture();
      return;
    }
    const seq = ++this.seqLatest;
    // Chaque lecture qui aboutit replanifie la suivante ; celle-ci remplace la relecture prévue.
    this.arreterRelecture();
    if (!opts.silencieux) {
      this.relecturesEnCours = 0; // un geste (ou l'ouverture) relance le suivi pour 15 relectures
      this.latestLoading.set(true);
      this.latestError.set(null);
    }
    try {
      const r = await firstValueFrom(this.ai.capacityLatest(this.fleetParam()));
      if (seq !== this.seqLatest) return; // périmée : une lecture plus récente (ou une autre société) est passée
      const avant = this.latest()?.analysis?.id ?? null;
      this.latest.set(r);
      // Nouvelle analyse : les cases cochées et les refus concernaient l'ancienne.
      if ((r.analysis?.id ?? null) !== avant) {
        this.selected.set(new Set());
        this.ecartees.set([]);
      }
      this.planifierRelecture(r);
    } catch (e) {
      if (seq !== this.seqLatest) return;
      swallow('agenda-ia-view:latest', e);
      if (!opts.silencieux) this.latestError.set(this.errMsg(e));
      // Un raté réseau n'arrête pas le suivi d'une analyse en cours (borné par le compteur).
      this.planifierRelecture(this.latest());
    } finally {
      if (seq === this.seqLatest) this.latestLoading.set(false);
    }
  }

  /** Tant que le serveur dit « analyse en cours », relire dans 20 s — 15 fois au plus (R9). */
  private planifierRelecture(r: AiCapacityLatestDto | null): void {
    this.arreterRelecture();
    if (this.detruite) return;
    if (!analyseEnCoursCoteServeur(r)) {
      this.relecturesEnCours = 0;
      this.relectureAbandonnee.set(false);
      return;
    }
    if (this.relecturesEnCours >= RELECTURES_EN_COURS_MAX) {
      this.relectureAbandonnee.set(true);
      return;
    }
    this.relectureAbandonnee.set(false);
    this.minuteurEnCours = setTimeout(() => {
      this.minuteurEnCours = null;
      if (this.detruite) return;
      this.relecturesEnCours++;
      void this.chargerLatest({ silencieux: true });
    }, RELECTURE_EN_COURS_MS);
  }

  private arreterRelecture(): void {
    if (this.minuteurEnCours !== null) clearTimeout(this.minuteurEnCours);
    this.minuteurEnCours = null;
  }

  private async chargerMetier(): Promise<void> {
    if (!this.perms.can('ai_optimize') || this.needsFleet()) return;
    const seq = ++this.seqMetier;
    try {
      const r = await firstValueFrom(this.ai.getFleetMetier(this.fleetParam()));
      if (seq === this.seqMetier) this.metier.set(r.metier);
    } catch (e) {
      swallow('agenda-ia-view:metier', e);
    }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    const societe = this.selectedFleetId();
    const seq = ++this.seqMetier; // une lecture encore en vol ne doit pas réafficher l'ancien métier
    this.metier.set(metier);
    try {
      await firstValueFrom(this.ai.setFleetMetier({ fleetId: societe ?? undefined, metier }));
      this.toast.success('Métier mis à jour', this.metierLabel(metier));
      // Revue du 29/09 (D2) : la dernière analyse est relue — l'écran dit si elle a été faite pour
      // un autre métier, et si une nouvelle est possible.
      if (societe === this.selectedFleetId()) void this.chargerLatest();
    } catch (e) {
      swallow('agenda-ia-view:onMetierChange', e);
      if (seq === this.seqMetier) this.metier.set(prev);
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  private async chargerUtil(): Promise<void> {
    if (!this.perms.can('reservations_view') || this.needsFleet()) return;
    const seq = ++this.seqUtil;
    this.utilLoading.set(true);
    try {
      const r = await firstValueFrom(this.agendaApi.getUtilization({ fleetId: this.fleetParam() }));
      if (seq === this.seqUtil) this.util.set(r);
    } catch (e) {
      if (seq !== this.seqUtil) return;
      swallow('agenda-ia-view:util', e);
      this.util.set(null);
    } finally {
      if (seq === this.seqUtil) this.utilLoading.set(false);
    }
  }

  /** Dernier passage et réglage « activé » — best-effort, réservés à qui peut régler l'agent. */
  private async chargerAgent(): Promise<void> {
    if (!this.canConfigureAgent() || this.needsFleet()) return;
    const seq = ++this.seqAgent;
    const fleetId = this.fleetParam();
    try {
      const runs = await firstValueFrom(this.agentApi.listRuns(fleetId, 1));
      if (seq === this.seqAgent) this.dernierPassage.set(runs[0] ?? null);
    } catch (e) {
      swallow('agenda-ia-view:runs', e);
    }
    try {
      const s = await firstValueFrom(this.agentApi.getSettings(fleetId));
      if (seq === this.seqAgent) {
        this.agentEnabled.set(s.enabled);
        this.nightlyHour.set(s.nightlyHour);
      }
    } catch (e) {
      swallow('agenda-ia-view:settings', e);
    }
  }

  // ─── Étape 1 : analyser / appliquer ───

  /**
   * Lance l'analyse EN ARRIÈRE-PLAN (pastille en haut de l'agenda) ; à la fin, la dernière analyse
   * est relue ici — si la société affichée est toujours celle de l'analyse. Le serveur refuse (429)
   * une seconde analyse dans les 24 h, ou pendant qu'une autre tourne, et (403) un compte qui ne
   * voit qu'une partie du parc : le bouton est grisé avant, et le motif se lit dans la pastille si
   * la course a lieu quand même.
   *
   * Troisième passe du 29/09 (T6) : la relecture est accrochée à la TÂCHE, comme dans
   * `lancerPassageAgent`, et non plus seulement à la liste des pastilles. Pastille fermée en cours,
   * l'effet des travaux ne voyait jamais la fin : l'analyse, payée et enregistrée, n'apparaissait pas,
   * et « Aucune analyse pour l'instant » restait affiché.
   */
  protected lancerAnalyse(): void {
    if (!this.peutLancer()) return;
    const fleetId = this.selectedFleetId();
    const cle = fleetId ?? '-';
    if (this.aiJob.hasRunningOf('optimization', fleetId) || this.analysesLanceesIci().has(cle)) return;
    const nom = this.fleetName();
    this.analysesLanceesIci.update((s) => new Set([...s, cle]));
    // Affecté dès le retour de `run()` ; le `finally` ne s'exécute qu'après (toujours asynchrone).
    let jobId: string | null = null;
    jobId = this.aiJob.run({
      kind: 'optimization',
      fleetId,
      title: 'Analyse du parc' + (nom ? ` — ${nom}` : ''),
      hint: 'L\'IA lit la marque et le modèle de chaque véhicule pour proposer les places et les équipements manquants. Rien n\'est écrit. Ça prend quelques secondes…',
      // `finally` rend le même résultat ou le même rejet : la pastille classe toujours prêt, échec, refus.
      task: firstValueFrom(this.ai.capacitySuggest({ fleetId: fleetId ?? undefined })).finally(() => {
        this.analysesLanceesIci.update((s) => {
          const n = new Set(s);
          n.delete(cle);
          return n;
        });
        // Vue détruite : l'instance suivante relit à son montage. Autre société affichée : la fin
        // de A n'a rien à dire sur B (A sera relue en y revenant).
        if (this.detruite || this.selectedFleetId() !== fleetId) return;
        // Pastille encore là : AiJobService la bascule en prêt/échec JUSTE APRÈS ce `finally` (il
        // attend la promesse qu'il rend), et l'effet des travaux relit — une seule lecture suffit.
        if (jobId !== null && this.aiJob.jobs().some((j) => j.id === jobId)) return;
        void this.chargerLatest();
      }),
      summarize: (r) => {
        const n = r.proposals.filter(propositionUtile).length;
        return n
          ? `${n} fiche(s) véhicule à compléter — à vérifier puis appliquer dans l'Assistant IA.`
          : 'Aucune fiche à compléter : le parc semble déjà renseigné.';
      },
      refus: {
        403: 'Refusé : l\'analyse du parc demande de voir toute la société, et ce compte n\'en voit qu\'une partie.',
        429: 'Refusé : une analyse de ce parc est déjà en cours, ou a déjà été faite dans les dernières 24 h. Son résultat reste à appliquer dans l\'Assistant IA.',
      },
    });
  }

  protected toggleSel(id: string): void {
    if (!this.canApply()) return;
    if (!this.selectionnables().some((p) => p.vehicleId === id)) return; // fiche modifiée depuis l'analyse
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selected.set(next);
  }

  /** Coche tout SAUF les fiches modifiées depuis l'analyse (voir `selectionnables`). */
  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.selectionnables().map((p) => p.vehicleId)));
  }

  protected basculerRevoir(): void {
    this.revoirOuvert.update((v) => !v);
  }

  /** Applique les cartes cochées — jamais une fiche « à revoir » (voir `selectionnables`). */
  protected async appliquer(): Promise<void> {
    const a = this.latest()?.analysis;
    if (!a || this.applying()) return;
    const coches = this.selected();
    const items = this.selectionnables()
      .filter((p) => coches.has(p.vehicleId))
      .map((p) => itemApplication(p))
      .filter((it): it is AiCapacityApplyItem => it !== null);
    if (items.length === 0) return;
    await this.envoyerApplication(a, items, null);
  }

  /**
   * « Appliquer quand même » sur une carte « à revoir » (contre-revue du 29/09, R6/R23) : geste
   * explicite, UNE fiche, `forcer` — le serveur écrit malgré la modification faite depuis l'analyse.
   * Ce qui part est ce que la carte montre (« actuel → proposé », équipements ajoutés).
   */
  protected async appliquerQuandMeme(p: AiCapacityProposalDto): Promise<void> {
    const a = this.latest()?.analysis;
    if (!a || this.applying() || !this.canApply()) return;
    if (!this.aRevoir().some((r) => r.vehicleId === p.vehicleId)) return;
    const item = itemApplication(p);
    if (!item) return;
    await this.envoyerApplication(a, [{ ...item, forcer: true }], p);
  }

  /**
   * Envoie une application et en montre le bilan.
   *
   * Contre-revue du 29/09 (R25) : la réponse est celle de la société (et de l'analyse) AU CLIC. Un
   * super-admin applique 40 fiches sur A puis choisit B : la réponse de A arrivait après la relecture
   * de B et affichait sous « Assistant IA · B » les plaques refusées de A, effaçait ses cases cochées,
   * et la fin de A libérait le bouton de B. Arrivée ailleurs, elle ne fait plus qu'un toast qui NOMME
   * la société ; l'écran de B n'est pas touché.
   */
  private async envoyerApplication(a: AiCapacityAnalysisDto, items: AiCapacityApplyItem[], forcee: AiCapacityProposalDto | null): Promise<void> {
    const societe = this.selectedFleetId();
    const cle = societe ?? '-';
    const nom = this.fleetCache.getName(societe);
    const plaques = new Map(a.proposals.map((p) => [p.vehicleId, p.plate]));
    const ailleurs = (): boolean => societe !== this.selectedFleetId() || this.latest()?.analysis?.id !== a.id;
    const qui = (): string => (societe !== this.selectedFleetId() ? nom ?? 'Société précédente' : 'Analyse précédente');
    this.enApplication.update((s) => new Set([...s, cle]));
    if (forcee) this.forcage.update((s) => new Set([...s, forcee.vehicleId]));
    this.latestError.set(null);
    this.ecartees.set([]);
    try {
      const res = await firstValueFrom(this.ai.capacityApply({ items, analysisId: a.id }));
      // Le serveur ne relit pas la plaque d'un véhicule qu'il refuse (403/404 : ce serait la fuite
      // que le refus empêche) ; l'écran la connaît par la carte qu'il affichait.
      const ecartees = (Array.isArray(res.skipped) ? res.skipped : []).map((s) => ({ ...s, plate: s.plate ?? plaques.get(s.vehicleId) ?? null }));
      // La page relit le parc TOUT DE SUITE, par le service : cette vue peut être détruite pendant
      // la relecture qui suit (bouton « Vérifier à la main dans la vue Parc »). Vrai aussi quand la
      // réponse arrive pour une autre société : ses fiches ont bien été écrites.
      if (res.updated > 0) this.sync.vehiculesModifies();
      if (ailleurs()) {
        const bilan = `${qui()} : ${res.updated} fiche(s) mise(s) à jour`;
        if (ecartees.length === 0) this.toast.success(bilan, '');
        else {
          this.toast.warning(
            `${bilan}, ${ecartees.length} non appliquée(s)`,
            ecartees.slice(0, 3).map((s) => `${s.plate ?? '—'} : ${s.motif}`).join(' · '),
          );
        }
        return;
      }
      this.ecartees.set(ecartees);
      // Un « Appliquer quand même » ne touche pas aux cases cochées au-dessus.
      if (!forcee) this.selected.set(new Set());
      if (ecartees.length > 0) {
        this.toast.warning(
          forcee ? `${forcee.plate || 'Fiche'} : non appliquée` : `${res.updated} fiche(s) mise(s) à jour, ${ecartees.length} non appliquée(s)`,
          'Le motif de chacune est écrit sous les cartes.',
        );
      } else if (forcee) {
        this.toast.success('Fiche mise à jour', `${forcee.plate || 'Le véhicule'} : la proposition est écrite ; les équipements déjà saisis sont conservés.`);
      } else {
        this.toast.success('Fiches mises à jour', `${res.updated} fiche(s) complétée(s) ; les équipements déjà saisis sont conservés.`);
      }
      await this.chargerLatest();
    } catch (e) {
      swallow('agenda-ia-view:appliquer', e);
      if (ailleurs()) {
        this.toast.error(`Échec — ${qui()}`, this.errMsg(e));
        return;
      }
      this.latestError.set(this.errMsg(e));
    } finally {
      this.enApplication.update((s) => {
        const n = new Set(s);
        n.delete(cle);
        return n;
      });
      if (forcee) {
        this.forcage.update((s) => {
          const n = new Set(s);
          n.delete(forcee.vehicleId);
          return n;
        });
      }
    }
  }

  // ─── Étape 2 : propositions ───

  protected basculer(vehicleId: string): void {
    const ouverts = new Set(this.deplies() ?? this.groupes().slice(0, 1).map((g) => g.vehicleId));
    if (ouverts.has(vehicleId)) ouverts.delete(vehicleId); else ouverts.add(vehicleId);
    this.deplies.set(ouverts);
  }

  protected toutReplierOuDeplier(): void {
    this.deplies.set(this.toutReplie() ? new Set(this.groupes().map((g) => g.vehicleId)) : new Set());
  }

  private marquer(id: string, occupe: boolean): void {
    this.busy.update((s) => { const n = new Set(s); if (occupe) n.add(id); else n.delete(id); return n; });
  }

  /** Une proposition de ce véhicule est en cours de traitement (geste de ligne) : pas de lot par-dessus. */
  protected groupeOccupe(g: GroupeProposals): boolean {
    const b = this.busy();
    return g.items.some((p) => b.has(p.id));
  }

  /** Pourquoi un bouton de lot est grisé — dit, plutôt qu'un clic ignoré sans un mot. */
  protected titreLot(g: GroupeProposals): string {
    if (this.lotsVehicules().has(g.vehicleId)) return 'Lot en cours sur ce véhicule…';
    if (this.lotEnCours()) return 'Un lot est en cours sur un autre véhicule : attendez son bilan.';
    if (this.groupeOccupe(g)) return 'Une proposition de ce véhicule est en cours de traitement.';
    return '';
  }

  /*
   * Réserver / écarter préviennent la page par `AgendaSyncService`, succès OU refus : un refus vient
   * souvent d'une proposition déjà traitée ailleurs, et la page doit alors relire sa liste. Le
   * service survit à cette vue — la notification arrive même si l'on a changé d'onglet entre-temps.
   */

  protected async reserverProposition(p: AgendaAgentProposalDto): Promise<void> {
    if (this.busy().has(p.id) || this.lotsVehicules().has(p.vehicleId)) return;
    this.marquer(p.id, true);
    try {
      await firstValueFrom(this.agentApi.applyProposal(p.id));
      this.toast.success('Réservé', `${p.vehiclePlate ?? ''} — la réservation est dans l'agenda.`);
    } catch (e) {
      swallow('agenda-ia-view:reserverProposition', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.marquer(p.id, false);
      this.sync.propositionsModifiees();
    }
  }

  protected async ecarter(p: AgendaAgentProposalDto): Promise<void> {
    if (this.busy().has(p.id) || this.lotsVehicules().has(p.vehicleId)) return;
    this.marquer(p.id, true);
    try {
      await firstValueFrom(this.agentApi.dismissProposal(p.id));
    } catch (e) {
      swallow('agenda-ia-view:ecarter', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.marquer(p.id, false);
      this.sync.propositionsModifiees();
    }
  }

  /** Tout réserver pour un véhicule : une par une (un refus n'arrête pas les autres), un bilan à la fin. */
  protected async toutReserver(g: GroupeProposals): Promise<void> {
    await this.enLot(g, 'reserver');
  }

  protected async toutEcarter(g: GroupeProposals): Promise<void> {
    await this.enLot(g, 'ecarter');
  }

  /**
   * Un lot à la fois par société (les boutons des autres véhicules sont grisés). Il ne prend que
   * les propositions LIBRES — une ligne déjà en cours de traitement n'est pas rejouée en parallèle —
   * et les marque occupées le temps du lot : leurs boutons de ligne sont grisés, et le `finally` ne
   * libère QUE celles qu'il a prises, jamais une ligne tenue par un geste individuel.
   *
   * Le lot est inscrit dans `AgendaSyncService` sous la société AU CLIC (R22) : il survit à la vue,
   * et une vue recréée pendant qu'il tourne le voit — ses boutons restent grisés jusqu'au bilan.
   */
  private async enLot(g: GroupeProposals, geste: 'reserver' | 'ecarter'): Promise<void> {
    if (this.lotEnCours()) return;
    const lot = g.items.filter((p) => !this.busy().has(p.id));
    if (lot.length === 0) return;
    const cle = cleLot(this.selectedFleetId(), g.vehicleId);
    this.sync.debutLot(cle);
    for (const p of lot) this.marquer(p.id, true);
    let faits = 0;
    const refus: string[] = [];
    try {
      for (const p of lot) {
        try {
          await firstValueFrom(geste === 'reserver' ? this.agentApi.applyProposal(p.id) : this.agentApi.dismissProposal(p.id));
          faits++;
        } catch (e) {
          swallow('agenda-ia-view:enLot', e);
          refus.push(`${new Date(p.startAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} : ${this.errMsg(e)}`);
        }
      }
      const verbe = geste === 'reserver' ? 'réservée(s)' : 'écartée(s)';
      if (refus.length === 0) this.toast.success(`${g.plate} : ${faits} proposition(s) ${verbe}`, '');
      else this.toast.error(`${g.plate} : ${faits} ${verbe}, ${refus.length} refusée(s)`, refus.slice(0, 3).join(' · '));
    } finally {
      for (const p of lot) this.marquer(p.id, false);
      this.sync.finLot(cle);
      this.sync.propositionsModifiees();
    }
  }

  /** Lance un passage de l'agent en arrière-plan (même fonction, même pastille que depuis les Paramètres). */
  protected lancerPassage(): void {
    if (this.passageEnCours() || this.agentEnabled() === false) return;
    lancerPassageAgent(
      { aiJob: this.aiJob, agentApi: this.agentApi, sync: this.sync },
      { fleetId: this.selectedFleetId(), fleetName: this.fleetName() },
    );
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse && e.status === 503) {
      return apiErrorMessage(e, 'Copilote IA non configuré côté serveur (ANTHROPIC_API_KEY).');
    }
    return apiErrorMessage(e, e instanceof HttpErrorResponse ? `Erreur (${e.status}).` : 'Une erreur est survenue.');
  }
}

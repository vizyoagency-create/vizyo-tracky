import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  AiCapacityAnalysisDto,
  AiCapacityApplyDto,
  AiCapacityApplyResultDto,
  AiCapacityLatestDto,
  AiCapacityInputDto,
  AiCapacityProposalDto,
  AiCapacityResultDto,
  AiCapacitySuggestRequestDto,
  AiPlacementCandidateInput,
  AiPlacementInputDto,
  AiPlacementProposalDto,
  AiPlacementResultDto,
  AiPlacementSuggestRequestDto,
  FleetMetier,
  FleetMetierDto,
  SetFleetMetierDto,
} from '@vizyo/tracky-shared';
import { DORMANT_STOP_COUNTING_MS, isVehicleDormant } from '@vizyo/tracky-shared';

/** Refonte UX du 28/09 (point 6) : une analyse de capacités par société et par fenêtre de 24 h. */
const CAPACITY_WINDOW_MS = 24 * 60 * 60 * 1000;
import type { AuthUser } from '../auth/types/auth-user';
import { messageAucunVehicule } from '../agenda/aucun-vehicule.message';
import { ForecastService } from '../agenda/forecast.service';
import { ReservationsService } from '../agenda/reservations.service';
import { VehicleEventsService } from '../agenda/vehicle-events.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { AiServiceError, type AiErrorKind, type NiveauEchecIa } from './anthropic.client';
import { AiRouter } from './ai-router.service';
import { AiAvailabilityService } from './ai-availability.service';
import {
  CAPACITY_SCHEMA,
  PLACEMENT_SCHEMA,
  renderCapacitySystem,
  renderPlacementSystem,
} from './ai.prompts';

/** Borne une valeur dans [0,1] ; non-fini → 0. */
function clamp01(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
/**
 * Nombre de places plausible : entier de 1 à 99, les bornes de `UpdateVehicleDto` — sinon null.
 *
 * Revue du 29/09 : l'ancien `cleanInt` laissait passer 0 (que la vue Parc refuse) et tronquait
 * 2,7 en 2 — une valeur que personne n'a dite. Une place inventée finit dans le placement.
 */
function cleanSeats(n: unknown): number | null {
  if (n === null || n === undefined || n === '') return null;
  const x = Number(n);
  return Number.isInteger(x) && x >= 1 && x <= 99 ? x : null;
}

/** Plancher de places demandé (conducteur compris), entier > 0, sinon null — corps non typé à l'exécution. */
function minSeatsDe(criteria: unknown): number | null {
  const brut = criteria && typeof criteria === 'object' ? (criteria as { minSeats?: unknown }).minSeats : undefined;
  const n = Math.floor(Number(brut));
  return brut !== null && brut !== undefined && brut !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/** Bornes de `UpdateVehicleDto` : la fiche écrite par « Appliquer » doit rester une fiche que la vue Parc accepte. */
const FEATURES_MAX = 30;
const FEATURE_LEN_MAX = 40;
/** Équipements AJOUTÉS qu'on conserve d'une réponse de l'IA (au-delà, c'est du bruit, pas une fiche). */
const FEATURES_IA_MAX = 20;
/** Clé de comparaison d'un équipement : « Climatisation » et « climatisation » sont le même. */
const cleEquipement = (s: string): string => s.trim().toLowerCase();

/**
 * Équipements nettoyés : chaînes non vides d'au plus 40 caractères, sans doublon (casse ignorée),
 * sans ceux d'`exclus` (clés `cleEquipement`), et au plus `max`.
 *
 * Contre-revue du 29/09 (R7/R24) : la borne (20) tombait AVANT qu'on écarte les équipements déjà
 * sur la fiche. L'écran envoyant l'union « fiche + ajouts », une fiche de 20 équipements perdait
 * tous ses ajouts — et la proposition était notée appliquée sans rien écrire. On écarte d'abord,
 * on borne ensuite.
 */
function cleanFeatures(f: unknown, max: number, exclus: ReadonlySet<string> = new Set()): string[] {
  if (!Array.isArray(f)) return [];
  const vus = new Set<string>(exclus);
  const out: string[] = [];
  for (const x of f) {
    if (out.length >= max) break;
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (!s || s.length > FEATURE_LEN_MAX || vus.has(cleEquipement(s))) continue;
    vus.add(cleEquipement(s));
    out.push(s);
  }
  return out;
}

/** Ce que porte une fiche véhicule côté capacité. */
type FicheCapacite = { seats: number | null; features: string[] };

/** Bilan d'un « Appliquer » pour UNE société — une ligne `capacites_appliquees` au journal (29/09). */
type BilanCapacites = {
  appliques: {
    vehicleId: string;
    plate: string | null;
    seats?: { avant: number | null; apres: number };
    ajouts: string[];
    force: boolean;
  }[];
  ecartes: { vehicleId: string; plate: string | null; motif: string }[];
  /** La fiche portait déjà les valeurs proposées : rien écrit, proposition notée faite. */
  inchanges: string[];
};
/** Véhicules nommés dans le texte d'une ligne ; au-delà, « … » (le détail complet est dans `meta`). */
const CAPACITES_NOMMEES_MAX = 5;

/**
 * Ce qu'une proposition AJOUTE à une fiche (revue du 29/09) : un nombre de places valide et
 * différent de l'actuel, et les équipements absents de la fiche (casse ignorée). Jamais de
 * retrait : une proposition ne vide ni une place ni un équipement saisis à la main — « Appliquer »
 * complète, il ne remplace pas.
 *
 * Les ajouts ne sont PAS rognés à la place restante (contre-revue du 29/09, R7) : la lecture
 * (`latest`) et l'écriture (`apply`) comptent ainsi les mêmes ajouts, et c'est « Appliquer » qui
 * refuse, avec son motif, une fiche qui dépasserait 30 — plutôt que d'en écrire une partie en
 * silence. Au-delà de 30 ajouts la réponse est la même (trop) : inutile de compter plus loin.
 * `features` reçu peut être les seuls ajouts (l'écran, depuis le 29/09) ou l'union avec la fiche
 * (écran encore en cache) : les équipements déjà présents sont écartés dans les deux cas.
 */
function apportSurFiche(prop: { seats?: unknown; features?: unknown }, fiche: FicheCapacite): FicheCapacite {
  const seats = cleanSeats(prop.seats);
  const connus = new Set((fiche.features ?? []).map(cleEquipement));
  return {
    seats: seats !== null && seats !== (fiche.seats ?? null) ? seats : null,
    features: cleanFeatures(prop.features, FEATURES_MAX + 1, connus),
  };
}
const apporteQuelqueChose = (a: FicheCapacite): boolean => a.seats !== null || a.features.length > 0;

function memesEquipements(a: string[], b: string[]): boolean {
  const ka = new Set(a.map(cleEquipement));
  const kb = new Set(b.map(cleEquipement));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
}

/** Vrai si la proposition porte l'instantané de la fiche pris à l'analyse (analyses du 29/09 et après). */
function aUnInstantane(p: AiCapacityProposalDto | undefined): p is AiCapacityProposalDto {
  return !!p && (p.currentSeats !== undefined || p.currentFeatures !== undefined);
}

/**
 * La fiche a-t-elle bougé depuis l'analyse ? (revue du 29/09)
 *
 * Avec instantané : places ou équipements différents de ceux lus à l'analyse — typiquement une
 * correction faite à la main dans la vue Parc, que « Tout sélectionner → Appliquer » écrasait.
 *
 * Sans instantané (analyses du 28/09, déjà en base) : on ne peut pas savoir, donc jamais
 * « modifiée » (contre-revue du 29/09, R8). L'ancienne règle de repli marquait toute fiche qui
 * portait déjà un autre nombre de places — c'était le cas DÈS l'analyse, l'IA du 28/09 répondant
 * pour chaque véhicule — et l'écran comme le 429 affirmaient alors une correction manuelle que
 * personne n'avait faite. La carte montre « actuel → proposé » : c'est le gestionnaire qui coche.
 */
function ficheModifiee(p: AiCapacityProposalDto | undefined, fiche: FicheCapacite): boolean {
  if (!aUnInstantane(p)) return false;
  return (p.currentSeats ?? null) !== (fiche.seats ?? null) || !memesEquipements(p.currentFeatures ?? [], fiche.features ?? []);
}

/** Forme d'un identifiant d'analyse (colonne uuid) : un id mal formé ferait échouer Prisma. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Motifs rendus à l'écran, véhicule par véhicule, quand « Appliquer » en écarte un. */
const MOTIF_INTROUVABLE = "véhicule introuvable : supprimé depuis l'analyse";
const MOTIF_HORS_PERIMETRE = 'véhicule hors de votre périmètre ou passé dans une autre société';
/** T9 : le véhicule est dans le périmètre, mais sa ligne d'accès n'accorde pas « Modifier un véhicule ». */
const MOTIF_SANS_DROIT_EDITION = "vous n'avez pas le droit « Modifier un véhicule » sur ce véhicule";
const MOTIF_FICHE_MODIFIEE = "fiche modifiée depuis l'analyse";
const MOTIF_TROP_EQUIPEMENTS = `trop d'équipements (${FEATURES_MAX} au plus)`;

/** Pourquoi CE compte ne lance pas l'analyse du parc (revue du 29/09, C10). */
const MOTIF_PERIMETRE =
  "L'analyse du parc porte sur toute la société : elle est lancée par un compte qui voit tous ses véhicules. " +
  'Vous voyez ici ses propositions pour les vôtres.';
const MOTIF_EN_COURS = 'Une analyse de ce parc est déjà en cours.';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fenêtre « maintenance imminente » : maintenance prévue dans les 7 jours suivant le créneau. */
const MAINT_SOON_MS = 7 * DAY_MS;
/**
 * Coût/km INDICATIF pour aider l'IA à mutualiser vers le véhicule le moins cher à mission égale.
 * Prix carburant TTC moyens France (approximatifs, 2026) ; l'électrique est estimé à un forfait
 * recharge dépôt. Volontairement grossier : sert au CLASSEMENT relatif, pas à une facturation.
 */
const FUEL_PRICE_EUR_PER_L: Record<string, number> = { DIESEL: 1.75, ESSENCE: 1.9, HYBRIDE: 1.9 };
const DEFAULT_CONSO_L100: Record<string, number> = { DIESEL: 6.5, ESSENCE: 7.5, HYBRIDE: 5 };
const ELECTRIC_COST_PER_KM = 0.03;

/** Estime un coût/km (€) depuis l'énergie + la conso (L/100km si connue, sinon défaut par énergie). */
function estimateCostPerKm(energy: string | null, consoL100: number | null): number | null {
  if (!energy) return null;
  if (energy === 'ELECTRIQUE') return ELECTRIC_COST_PER_KM;
  const price = FUEL_PRICE_EUR_PER_L[energy];
  if (!price) return null;
  const conso = consoL100 && consoL100 > 0 ? consoL100 : DEFAULT_CONSO_L100[energy];
  if (!conso) return null;
  return Math.round((conso / 100) * price * 1000) / 1000; // €/km, 3 décimales
}

/**
 * Métadonnées véhicule du placement. `tracker` est joint à la requête coût DÉJÀ faite (et non
 * chargé par une requête dédiée) : le VPS tourne sur 2 vCPU, une lecture de plus par suggestion
 * IA se paierait à chaque clic.
 */
type PlacementVehicleMeta = {
  id: string;
  energy: string | null;
  fuelConsumptionL100km: number | null;
  tracker: { id: string; lastSeenAt: Date | null } | null;
};

/**
 * Le seuil de dormance en JOURS, dérivé de la constante partagée et non réécrit « 7 » à la main.
 *
 * Ces jours partent dans deux textes lus par des humains (la note `noGoodMatch`) et par le modèle
 * (`scopeNote`). Un littéral y survivrait à un changement de seuil et affirmerait alors une durée
 * fausse à l'exploitant — le genre d'écart qu'aucun test ne rattrape parce que la phrase reste
 * grammaticalement correcte.
 */
const DORMANT_COUNTING_DAYS = Math.round(DORMANT_STOP_COUNTING_MS / (24 * 60 * 60 * 1000));

type CapacityVehicleRow = {
  id: string;
  plate: string | null;
  type: string;
  brand: string | null;
  model: string | null;
  seats: number | null;
  features: string[];
};

type CapacityAiOutput = {
  proposals: Array<{
    vehicleId: string;
    seats: number | null;
    features: string[];
    confidence: number;
    reasoning: string;
  }>;
};
type PlacementAiOutput = {
  proposals: Array<{ vehicleId: string; score: number; reasoning: string }>;
  noGoodMatch: boolean;
  notes?: string | null;
};

/**
 * Ce que rend `GET /ai/capacity/latest` : le contrat partagé, plus `enCours` (contre-revue du 29/09,
 * R9) — vrai tant que le verrou mémoire de la société est pris par une analyse en cours.
 */
export type AiCapacityLatestReponse = AiCapacityLatestDto & { enCours: boolean };

/** Anti-spam des alertes IA : 1 entrée / fenêtre par (capacité, flotte, nature). */
const AI_ALERT_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Sprint 9 — Copilote IA d'optimisation. L'IA PROPOSE (sortie structurée) ; l'app
 * VALIDE/APPLIQUE. Toutes les lectures passent par les services SCOPÉS (chaîne S5
 * anti-IDOR) : l'IA ne reçoit jamais que le périmètre de l'appelant. Aucune
 * proposition n'écrit en base : capacité → applyCapacity (perm vehicles_edit),
 * placement → flux de réservation S8 (request/confirm, gardes EXCLUDE + scoping).
 *
 * Les `preview*` renvoient le PAYLOAD EXACT envoyé à Claude (sans appel) → permet de
 * tester en Console avec les vraies données live + prouve la fraîcheur du parc.
 * Chaque échec IA est journalisé (ErrorLogger, source AI_OPTIMIZER) → centre d'alerte.
 */
@Injectable()
export class AiOptimizationService {
  /** Dernière alerte IA émise par clé (anti-spam). */
  private readonly aiErrLast = new Map<string, number>();

  /**
   * Sociétés dont une analyse de capacités est EN COURS (revue du 29/09, C13).
   *
   * La garde « une par jour » lit la dernière ligne, puis l'appel IA dure jusqu'à deux minutes,
   * et la ligne n'est créée qu'après : deux onglets, deux gestionnaires, ou un rechargement
   * pendant l'attente passaient tous la garde — deux analyses facturées. Un verrou en mémoire
   * suffit : l'API tourne en UNE instance (un seul conteneur `tracky-api`, aucune réplique), le
   * service est un singleton, et un redémarrage libère le verrou tout seul — pas d'orphelin
   * possible, contrairement à une ligne « en cours » en base. Si l'API passe un jour à plusieurs
   * instances, il faudra réserver le créneau en base.
   */
  private readonly analysesEnCours = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly events: VehicleEventsService,
    private readonly reservations: ReservationsService,
    private readonly forecast: ForecastService,
    private readonly ai: AiRouter,
    private readonly aiAvail: AiAvailabilityService,
    private readonly errors: ErrorLogger,
    private readonly aiUsage: AiUsageService,
    // Revue du 29/09 (T9) — `vehicles_edit` résolu véhicule par véhicule dans `applyCapacity`.
    // Module global (`PermissionsModule`) : rien à importer dans `AiModule`.
    private readonly permissions: PermissionsResolverService,
    // Journal métier (29/09, `SystemActivityModule` @Global) — EN DERNIER et @Optional : les specs
    // qui construisent le service à la main restent valides, et sans journal « Appliquer » passe.
    @Optional() private readonly systemActivity?: SystemActivityService,
  ) {}

  // ─── Capacité 1 — enrichissement de capacité ───────────────────────────────

  /**
   * Refonte UX du 28/09 (point 6) — la dernière analyse conservée d'une société, et si une
   * nouvelle est possible. C'est ce que l'écran Assistant IA lit à l'ouverture : le résultat
   * d'hier reste à appliquer, et le bouton dit quand il pourra repayer.
   */
  async latestCapacity(user: AuthUser, fleetId?: string): Promise<AiCapacityLatestReponse> {
    const id = this.resolveFleetId(user, fleetId);
    // Revue du 29/09 (C10) : l'analyse est celle de la SOCIÉTÉ, mais chacun n'en lit que la part de
    // son périmètre — un gestionnaire limité au « secteur nord » voyait les plaques, modèles et
    // raisonnements de tout le parc, ce que `/vehicles` et la vue Parc lui cachent.
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const last = await this.prisma.aiCapacityAnalysis.findFirst({ where: { fleetId: id }, orderBy: { createdAt: 'desc' } });
    const next = last ? new Date(last.createdAt.getTime() + CAPACITY_WINDOW_MS) : null;
    const fenetreOuverte = !next || next.getTime() <= Date.now();
    // Contre-revue du 29/09 (R9) : l'état du verrou est rendu tel quel, quel que soit le périmètre.
    // Un onglet qui n'a pas lancé l'analyse (rechargé pendant l'attente, autre poste) n'a aucun
    // travail à suivre : sans ce booléen il gardait « déjà en cours » après la fin — et, si l'IA
    // avait échoué, refusait à tort une analyse redevenue possible. L'écran relit tant qu'il est vrai,
    // sans avoir à reconnaître la phrase du motif.
    const enCours = this.analysesEnCours.has(id);
    // Le motif dit pourquoi CE compte ne peut pas lancer, quand ce n'est pas la fenêtre de 24 h :
    // un périmètre partiel (l'analyse est réservée à qui voit tout le parc), ou une analyse déjà
    // en cours — un onglet rechargé pendant l'attente voit alors le bouton grisé, et pourquoi.
    const motif = accessible !== 'ALL' ? MOTIF_PERIMETRE : enCours ? MOTIF_EN_COURS : null;
    return {
      analysis: last ? await this.analyseVisible(last, id, accessible) : null,
      canRun: fenetreOuverte && motif === null,
      // Pour un périmètre partiel il n'y a pas de « prochaine fois » : ce n'est pas une question d'heure.
      nextAllowedAt: fenetreOuverte || accessible !== 'ALL' ? null : next!.toISOString(),
      windowHours: CAPACITY_WINDOW_MS / 3_600_000,
      motif,
      enCours,
    };
  }

  private toAnalysisDto(row: {
    id: string; fleetId: string; createdAt: Date; metier: string; proposals: unknown; appliedVehicleIds: string[];
  }): AiCapacityAnalysisDto {
    return {
      id: row.id,
      fleetId: row.fleetId,
      analysedAt: row.createdAt.toISOString(),
      metier: row.metier as FleetMetier,
      proposals: Array.isArray(row.proposals) ? (row.proposals as AiCapacityProposalDto[]) : [],
      appliedVehicleIds: [...new Set(row.appliedVehicleIds ?? [])],
    };
  }

  /**
   * L'analyse conservée telle qu'un compte doit la voir (revue du 29/09) :
   * - bornée à son PÉRIMÈTRE véhicules (C10) — propositions et `appliedVehicleIds` ;
   * - sans les véhicules qui n'existent plus dans CETTE société (C11) : supprimés (suppression
   *   physique) ou transférés. Sinon « Tout sélectionner → Appliquer » échouait à chaque essai sur
   *   le même véhicule disparu ;
   * - chaque proposition porte la fiche ACTUELLE (`nowSeats`/`nowFeatures`) et `ficheModifiee`,
   *   pour que l'écran montre « actuel → proposé » et n'applique pas d'office une fiche corrigée à
   *   la main depuis (C12) ;
   * - sans les propositions pas encore appliquées qui n'apportent PLUS rien à la fiche (corrigée
   *   entre-temps, ou analyse du 28/09 qui proposait chaque véhicule, même complet) : le badge
   *   « N à appliquer » disait la taille du parc. Les appliquées restent : l'écran les liste.
   *
   * Une seule requête véhicules, bornée aux ids des propositions.
   */
  private async analyseVisible(
    row: { id: string; fleetId: string; createdAt: Date; metier: string; proposals: unknown; appliedVehicleIds: string[] },
    fleetId: string,
    accessible: string[] | 'ALL',
  ): Promise<AiCapacityAnalysisDto> {
    const dto = this.toAnalysisDto(row);
    const permis = accessible === 'ALL' ? null : new Set(accessible);
    const dansPerimetre = (vehicleId: string): boolean => !permis || permis.has(vehicleId);
    const ids = [...new Set(dto.proposals.map((p) => p?.vehicleId).filter((v): v is string => !!v && dansPerimetre(v)))];
    const fiches = ids.length
      ? await this.prisma.vehicle.findMany({ where: { fleetId, id: { in: ids } }, select: { id: true, seats: true, features: true } })
      : [];
    const ficheParId = new Map(fiches.map((f) => [f.id, { seats: f.seats ?? null, features: f.features ?? [] }]));
    const faites = new Set(dto.appliedVehicleIds);
    const proposals: AiCapacityProposalDto[] = [];
    for (const p of dto.proposals) {
      const fiche = p?.vehicleId ? ficheParId.get(p.vehicleId) : undefined;
      if (!fiche) continue; // hors périmètre, supprimé, ou passé dans une autre société
      const appliquee = faites.has(p.vehicleId);
      if (!appliquee && !apporteQuelqueChose(apportSurFiche(p, fiche))) continue;
      proposals.push({
        ...p,
        nowSeats: fiche.seats,
        nowFeatures: fiche.features,
        // Une proposition appliquée a forcément changé la fiche : ce n'est pas une « modification ».
        // Sans instantané (analyse du 28/09), jamais « modifiée » : on ne peut pas le savoir (R8).
        ficheModifiee: !appliquee && ficheModifiee(p, fiche),
      });
    }
    return { ...dto, proposals, appliedVehicleIds: dto.appliedVehicleIds.filter(dansPerimetre) };
  }

  /** « 28/09 à 14:02 », heure de Paris — celle que lit le gestionnaire. */
  private static heureParis(d: Date): string {
    return d
      .toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      .replace(' ', ' à ');
  }

  /**
   * La garde « une analyse par jour et par société ». Refuse (429) tant que la dernière analyse a
   * moins de 24 h — sauf `force` par un super-admin (recette, démonstration). Le message dit la
   * date de la dernière, celle de la prochaine, et ce qu'il reste RÉELLEMENT de son résultat.
   *
   * Revue du 29/09 (C14) : la dernière phrase affirmait toujours « reste à appliquer », y compris
   * quand l'analyse n'avait rien proposé ou que tout avait été appliqué — la pastille annonçait un
   * travail que l'écran, juste en dessous, disait inexistant. Le reste se compte avec la même règle
   * que l'écran (`analyseVisible`), jamais par `proposalsCount − appliedVehicleIds.length` :
   * `appliedVehicleIds` a pu recevoir des véhicules absents des propositions.
   *
   * Le changement de métier ne rouvre PAS la garde (D2, écarté) : basculer le métier dans un sens
   * puis dans l'autre suffirait à payer autant d'analyses qu'on veut.
   */
  private async assertCapacityQuota(user: AuthUser, fleetId: string, force: boolean | undefined): Promise<void> {
    if (force && user.role === UserRole.SUPER_ADMIN) return;
    const derniere = await this.prisma.aiCapacityAnalysis.findFirst({
      where: { fleetId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fleetId: true, createdAt: true, metier: true, proposals: true, appliedVehicleIds: true },
    });
    if (!derniere) return;
    const prochaine = new Date(derniere.createdAt.getTime() + CAPACITY_WINDOW_MS);
    if (prochaine.getTime() <= Date.now()) return;
    throw new HttpException(
      `Une analyse par jour et par société : la dernière date du ${AiOptimizationService.heureParis(derniere.createdAt)}, ` +
        `la prochaine sera possible le ${AiOptimizationService.heureParis(prochaine)}. ` +
        (await this.resteDeLAnalyse(derniere, fleetId)),
      429,
    );
  }

  /**
   * La phrase qui dit ce qu'il reste d'une analyse conservée — même décompte que l'écran.
   *
   * Contre-revue du 29/09 (R8) : « fiche modifiée depuis » ne compte plus que les fiches dont
   * l'instantané prouve la modification (`ficheModifiee` est faux sans instantané) ; et les deux
   * restes sont dits ensemble quand il y a les deux — la phrase taisait les fiches à revoir dès
   * qu'une proposition restait à appliquer.
   */
  private async resteDeLAnalyse(
    row: { id: string; fleetId: string; createdAt: Date; metier: string; proposals: unknown; appliedVehicleIds: string[] },
    fleetId: string,
  ): Promise<string> {
    const proposees = Array.isArray(row.proposals) ? row.proposals.length : 0;
    if (proposees === 0) return "Elle n'avait rien trouvé à compléter : le parc semble déjà renseigné.";
    // L'appelant voit tout le parc (seul un tel compte lance l'analyse) : aucune borne de périmètre.
    const vue = await this.analyseVisible(row, fleetId, 'ALL');
    const faites = new Set(vue.appliedVehicleIds);
    const ouvertes = vue.proposals.filter((p) => !faites.has(p.vehicleId));
    const aAppliquer = ouvertes.filter((p) => !p.ficheModifiee).length;
    const aRevoir = ouvertes.length - aAppliquer;
    const restes: string[] = [];
    if (aAppliquer > 0) {
      restes.push(aAppliquer === 1 ? '1 proposition reste à appliquer' : `${aAppliquer} propositions restent à appliquer`);
    }
    if (aRevoir > 0) {
      restes.push(aRevoir === 1 ? '1 fiche modifiée depuis est à revoir' : `${aRevoir} fiches modifiées depuis sont à revoir`);
    }
    if (restes.length > 0) return `Son résultat est conservé dans l'Assistant IA : ${restes.join(', ')}.`;
    return 'Toutes ses propositions ont été appliquées, ou figurent déjà sur les fiches.';
  }

  /** Construit le payload capacité (scopé). Réutilisé par preview + suggest. */
  private async buildCapacityPayload(
    user: AuthUser,
    dto: AiCapacitySuggestRequestDto,
  ): Promise<{ payload: AiCapacityInputDto; vehicles: CapacityVehicleRow[]; metier: FleetMetier; fleetId: string }> {
    const fleetId = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { metier: true, name: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const metier = fleet.metier as FleetMetier;

    // Scoping anti-IDOR : un véhicule hors périmètre n'entre jamais dans le payload.
    //
    // Les DORMANTS restent VOLONTAIREMENT dans ce payload-ci, contrairement au placement : on
    // demande ici combien de places a une Citroën ë-Jumpy, pas si elle est disponible mardi.
    // Le nombre de places est une caractéristique PHYSIQUE et permanente ; elle ne dépend pas de
    // l'état du boîtier. Les écarter creuserait un trou définitif dans la fiche des véhicules
    // muets — trou que plus rien ne viendrait combler, y compris après leur retour.
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const ids = resolveReportVehicleScope(accessible, dto?.vehicleIds); // 403 si sous-ensemble hors périmètre
    // Un vehicule hors service ne doit pas etre PROPOSE : l'IA de placement repondrait a
    // « quel vehicule pour cette demande ? » par une voiture au garage ou accidentee.
    const where: Prisma.VehicleWhereInput = { fleetId, outOfServiceReason: null };
    if (ids !== 'ALL') where.id = { in: ids };
    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: {
        id: true, plate: true, type: true, brand: true, model: true,
        seats: true, features: true,
      },
      take: 2000,
    });

    // Énergie : depuis l'InstallationTask liée si disponible (le planning porte model + energy).
    const vids = vehicles.map((v) => v.id);
    const tasks = vids.length
      ? await this.prisma.installationTask.findMany({
          where: { vehicleId: { in: vids } },
          select: { vehicleId: true, energy: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const energyByVeh = new Map<string, string | null>();
    for (const t of tasks) {
      // 1re tâche (la plus ancienne) gagne — déterministe grâce à l'orderBy.
      if (t.vehicleId && !energyByVeh.has(t.vehicleId)) energyByVeh.set(t.vehicleId, t.energy ?? null);
    }

    const payload: AiCapacityInputDto = {
      metier,
      fleetContext: fleet.name ?? null,
      vehicles: vehicles.map((v) => ({
        vehicleId: v.id,
        plate: v.plate,
        type: v.type,
        brand: v.brand,
        model: v.model,
        energy: energyByVeh.get(v.id) ?? null,
        currentSeats: v.seats,
        currentFeatures: v.features,
      })),
    };
    return { payload, vehicles, metier, fleetId };
  }

  /** Aperçu du payload capacité (DRY-RUN, aucun appel Claude) — testable en Console. */
  async previewCapacity(user: AuthUser, dto: AiCapacitySuggestRequestDto): Promise<AiCapacityInputDto> {
    return (await this.buildCapacityPayload(user, dto)).payload;
  }

  /**
   * L'analyse conservée est celle de TOUTE la société (revue du 29/09, C10) : elle n'est donc
   * lancée — donc payée, conservée et comptée dans « une par jour » — que par un compte qui voit
   * tout le parc, et jamais sur une sélection de véhicules. Avant, un gestionnaire limité à son
   * groupe (ou un `vehicleIds` passé à l'API) enregistrait SON sous-ensemble comme l'analyse de la
   * société : l'administrateur ne voyait plus que ces véhicules et se voyait refuser l'analyse du
   * parc complet pendant 24 h. Le compte limité lit l'analyse de l'administrateur, bornée à ses
   * véhicules (`latestCapacity`).
   */
  private async assertAnalyseDeSociete(user: AuthUser, dto: AiCapacitySuggestRequestDto): Promise<void> {
    const selection = dto?.vehicleIds as unknown;
    if (selection !== undefined && selection !== null && (!Array.isArray(selection) || selection.length > 0)) {
      throw new ForbiddenException(
        "L'analyse du parc porte sur toute la société : elle ne se lance pas sur une sélection de véhicules.",
      );
    }
    if ((await this.vehicleAccess.getAccessibleVehicleIds(user)) !== 'ALL') {
      throw new ForbiddenException(
        "L'analyse du parc porte sur toute la société : elle est réservée à un compte qui voit tous ses véhicules. " +
          "Ses propositions pour les vôtres s'affichent dans l'Assistant IA.",
      );
    }
  }

  async suggestCapacity(user: AuthUser, dto: AiCapacitySuggestRequestDto): Promise<AiCapacityResultDto> {
    // Refusé AVANT toute lecture du parc et tout appel payant.
    await this.assertAnalyseDeSociete(user, dto);
    const { payload, vehicles, metier, fleetId } = await this.buildCapacityPayload(user, dto);
    if (vehicles.length === 0) return { metier, proposals: [] };
    // Interrupteur maître : IA désactivée pour la flotte → aucune proposition (l'app tourne sans IA).
    if (!(await this.aiAvail.isEnabledForFleet(fleetId, 'capacity'))) return { metier, proposals: [] };

    // Une seule analyse à la fois par société (C13). Le test et la prise du verrou se suivent
    // SANS `await` entre eux : deux requêtes ne peuvent pas passer toutes les deux. Même un
    // super-admin qui force attend la fin de celle en cours.
    if (this.analysesEnCours.has(fleetId)) throw new HttpException(MOTIF_EN_COURS, 429);
    this.analysesEnCours.add(fleetId);
    try {
      // Une par jour et par société — vérifié AVANT de payer l'appel.
      await this.assertCapacityQuota(user, fleetId, dto?.force);

      let ai: CapacityAiOutput;
      try {
        const call = await this.ai.completeJson<CapacityAiOutput>({
          system: renderCapacitySystem(metier),
          userPayload: payload,
          schema: CAPACITY_SCHEMA,
          // Une proposition par véhicule : marge pour une grande flotte sans risquer le
          // timeout HTTP (16k = plafond non-stream confortable, ~200 véhicules).
          maxTokens: 16000,
        }, { trace: { action: 'capacity', userId: user.id, fleetId } });
        ai = call.result;
        // Palier « Coûts IA » — journalise l'usage (non bloquant).
        void this.aiUsage.record({
          userId: user.id, fleetId, action: 'capacity', model: call.model, provider: call.provider,
          inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
          cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
          latencyMs: call.latencyMs, ok: true,
        });
      } catch (err) {
        await this.recordAiFailure(err, 'capacity', { userId: user.id, fleetId, vehicleCount: vehicles.length });
        throw err;
      }

      const byId = new Map(vehicles.map((v) => [v.id, v]));
      const vus = new Set<string>();
      const proposals: AiCapacityProposalDto[] = [];
      for (const p of ai?.proposals ?? []) {
        // Anti-hallucination : on ignore tout id inconnu ; et une seule proposition par véhicule.
        if (!p || !byId.has(p.vehicleId) || vus.has(p.vehicleId)) continue;
        const v = byId.get(p.vehicleId)!;
        const fiche: FicheCapacite = { seats: v.seats ?? null, features: v.features ?? [] };
        // Revue du 29/09 (C12/C22) : le prompt fait répondre l'IA pour CHAQUE véhicule, même
        // complet. On ne garde que les propositions qui APPORTENT quelque chose — sinon le badge
        // « N à appliquer » valait la taille du parc et l'étape ne se cochait qu'une fois tout
        // appliqué, ce qui poussait à « Tout sélectionner » et réécrivait des fiches justes.
        const ajout = apportSurFiche(p, fiche);
        if (!apporteQuelqueChose(ajout)) continue;
        vus.add(p.vehicleId);
        proposals.push({
          vehicleId: p.vehicleId,
          plate: v.plate,
          model: v.model,
          seats: cleanSeats(p.seats),
          // Contre-revue du 29/09 (R7) : les seuls équipements AJOUTÉS, bornés APRÈS avoir écarté ceux
          // de la fiche — une IA qui recopiait d'abord les équipements actuels voyait ses ajouts
          // tomber sous la borne de 20. L'écran n'affiche que les ajouts : rien d'autre n'est perdu.
          features: ajout.features.slice(0, FEATURES_IA_MAX),
          confidence: clamp01(p.confidence),
          reasoning: typeof p.reasoning === 'string' ? p.reasoning.slice(0, 400) : '',
          // L'instantané de la fiche lue à l'analyse : « Appliquer » saura si elle a bougé depuis.
          currentSeats: fiche.seats,
          currentFeatures: fiche.features,
        });
      }
      // Conservée : c'est elle que l'écran relit demain, d'un autre poste, ou après un rechargement.
      const analyse = await this.prisma.aiCapacityAnalysis.create({
        data: {
          fleetId,
          createdBy: user.id,
          metier,
          proposals: proposals as unknown as Prisma.InputJsonValue,
          proposalsCount: proposals.length,
        },
        select: { id: true, createdAt: true },
      });
      return { metier, proposals, analysisId: analyse.id, analysedAt: analyse.createdAt.toISOString() };
    } finally {
      this.analysesEnCours.delete(fleetId);
    }
  }

  /**
   * Application HUMAINE des propositions acceptées → écrit les véhicules (scopé).
   *
   * Revue du 29/09 — l'analyse vit désormais des jours et se partage entre postes ; « Appliquer »
   * ne peut plus écrire à l'aveugle :
   * - chaque véhicule est traité SEUL (C11/C24). Un véhicule supprimé (404) ou hors périmètre /
   *   passé dans une autre société (403) est ÉCARTÉ avec son motif au lieu de faire échouer tout
   *   l'envoi — avant, les fiches déjà écrites restaient écrites, rien n'était noté, et chaque
   *   nouvel essai réécrivait les mêmes puis échouait au même endroit. La barrière anti-IDOR tient
   *   toujours : un 403 n'écrit rien. Seuls 403 et 404 sont rattrapés ; une panne de base remonte ;
   * - `vehicles_edit` est exigé SUR CHAQUE véhicule (T9), pas seulement en union au contrôleur : un
   *   véhicule du périmètre dont la ligne d'accès n'accorde que la lecture est écarté avec son motif ;
   * - ce qui a été écrit est TOUJOURS noté sur l'analyse, même si une erreur imprévue interrompt
   *   la boucle ;
   * - on COMPLÈTE, on ne remplace pas (C12/C22) : jamais `seats` à null ni à 0 (une proposition
   *   « — places » effaçait une valeur saisie), et les équipements reçus s'AJOUTENT à ceux de
   *   la fiche (union, casse ignorée) — « attelage » saisi à la main ne disparaît plus. `features`
   *   porte les AJOUTS (contrat du 29/09) ; une union reçue d'un écran en cache revient au même ;
   * - la fiche reste une fiche que la vue Parc accepte (contre-revue du 29/09, R7/R24) : si l'union
   *   dépasse 30 équipements, le véhicule est ÉCARTÉ avec son motif et rien n'est écrit — avant,
   *   une borne à 20 posée sur l'union perdait des ajouts en silence et notait quand même la
   *   proposition appliquée ;
   * - une fiche modifiée depuis l'analyse (instantané `currentSeats`/`currentFeatures`) est
   *   écartée : une correction faite dans la vue Parc n'est plus réécrite par l'ancienne valeur.
   *   Seul `forcer: true` (geste explicite « Appliquer quand même », contre-revue R6/R23) la
   *   réécrit. On ne compare JAMAIS `Vehicle.updatedAt` : il bouge avec la calibration carburant,
   *   les horaires, les sièges à bord, le kilométrage…
   * - l'analyse notée est celle que l'écran affichait (`analysisId`, si elle est bien de la
   *   société du véhicule), sinon la dernière de la société (D3) ; seuls ses propres véhicules y
   *   sont notés.
   */
  async applyCapacity(user: AuthUser, dto: AiCapacityApplyDto): Promise<AiCapacityApplyResultDto> {
    const recus = Array.isArray(dto?.items) ? dto.items : [];
    if (recus.length === 0) throw new BadRequestException('Aucune capacité à appliquer.');
    if (recus.length > 500) throw new BadRequestException('Trop de véhicules en une fois (max 500).');
    // Un véhicule envoyé deux fois n'est traité qu'une fois : la fiche lue ci-dessous serait périmée au second.
    const vus = new Set<string>();
    const items = recus.filter((it) => {
      if (!it?.vehicleId || typeof it.vehicleId !== 'string' || vus.has(it.vehicleId)) return false;
      vus.add(it.vehicleId);
      return true;
    });

    // Les fiches vivantes, lues d'un coup (VPS à 2 vCPU : pas une requête par véhicule). Rien n'en
    // sort avant que `assertVehicleAccess` ait validé le véhicule.
    const fiches = items.length
      ? await this.prisma.vehicle.findMany({
          where: { id: { in: items.map((it) => it.vehicleId) } },
          select: { id: true, plate: true, seats: true, features: true },
        })
      : [];
    const ficheParId = new Map(fiches.map((f) => [f.id, f]));

    // Revue du 29/09 (T9) — le contrôleur ne vérifie `vehicles_edit` qu'en UNION des scopes : un
    // gestionnaire qui l'a sur le groupe Nord et n'a que la lecture sur le groupe Sud passait, et
    // `assertVehicleAccess` ne contrôle que le périmètre — les places et équipements d'un véhicule
    // Sud étaient réécrits. Le droit se résout donc ici sur la ligne d'accès qui couvre CHAQUE
    // véhicule, comme `@RequireVehiclePermission` le fait pour `PATCH /vehicles/:id`. Une seule
    // requête pour tout le lot : `resolveForVehicles` remplit le cache de la requête, que
    // `canOnVehicle` relit ensuite sans retourner en base (super-admin et admin de flotte passent).
    if (items.length) await this.permissions.resolveForVehicles(user, items.map((it) => it.vehicleId));

    // L'analyse à noter, par société (un super-admin peut toucher plusieurs sociétés).
    type AnalyseCible = { id: string; proposals: Map<string, AiCapacityProposalDto>; deja: Set<string> };
    const analyses = new Map<string, AnalyseCible | null>();
    const demandee = typeof dto?.analysisId === 'string' && UUID_RE.test(dto.analysisId) ? dto.analysisId : null;
    const analyseDe = async (fleetId: string): Promise<AnalyseCible | null> => {
      if (analyses.has(fleetId)) return analyses.get(fleetId) ?? null;
      const select = { id: true, proposals: true, appliedVehicleIds: true } as const;
      const row =
        (demandee ? await this.prisma.aiCapacityAnalysis.findFirst({ where: { id: demandee, fleetId }, select }) : null) ??
        (await this.prisma.aiCapacityAnalysis.findFirst({ where: { fleetId }, orderBy: { createdAt: 'desc' }, select }));
      const cible: AnalyseCible | null = row
        ? {
            id: row.id,
            proposals: new Map(
              (Array.isArray(row.proposals) ? (row.proposals as unknown as AiCapacityProposalDto[]) : [])
                .filter((p) => !!p?.vehicleId)
                .map((p) => [p.vehicleId, p]),
            ),
            deja: new Set(row.appliedVehicleIds ?? []),
          }
        : null;
      analyses.set(fleetId, cible);
      return cible;
    };

    let updated = 0;
    const skipped: AiCapacityApplyResultDto['skipped'] = [];
    const aNoter = new Map<string, string[]>(); // id d'analyse → véhicules traités
    // Journal métier (29/09) — le bilan PAR SOCIÉTÉ DU VÉHICULE (un super-admin peut en toucher
    // plusieurs d'un coup). Un véhicule refusé AVANT de connaître sa société (404, 403 de
    // périmètre) n'entre dans aucun bilan : l'écrire chez sa société serait tracer, chez un tiers,
    // un geste que l'utilisateur n'avait pas le droit de faire — et révéler qu'il l'a tenté.
    const bilans = new Map<string, BilanCapacites>();
    const bilanDe = (fleetId: string): BilanCapacites => {
      let b = bilans.get(fleetId);
      if (!b) {
        b = { appliques: [], ecartes: [], inchanges: [] };
        bilans.set(fleetId, b);
      }
      return b;
    };
    const noter = (analyse: AnalyseCible | null, vehicleId: string): void => {
      // Seuls les véhicules que CETTE analyse proposait y sont notés.
      if (!analyse || !analyse.proposals.has(vehicleId)) return;
      aNoter.set(analyse.id, [...(aNoter.get(analyse.id) ?? []), vehicleId]);
    };

    let erreur: unknown;
    try {
      for (const it of items) {
        let fleetId: string;
        try {
          fleetId = await this.events.assertVehicleAccess(user, it.vehicleId);
        } catch (e) {
          // Pas de plaque lue en base pour un véhicule refusé : ce serait la fuite que le 403
          // empêche. L'écran connaît la plaque par la proposition qu'il affichait.
          if (e instanceof NotFoundException) skipped.push({ vehicleId: it.vehicleId, plate: null, motif: MOTIF_INTROUVABLE });
          else if (e instanceof ForbiddenException) skipped.push({ vehicleId: it.vehicleId, plate: null, motif: MOTIF_HORS_PERIMETRE });
          else throw e;
          continue;
        }
        // Dans le périmètre, mais sans le droit d'écrire CE véhicule : écarté, rien n'est écrit ni
        // noté sur l'analyse (la proposition reste à appliquer par un compte qui en a le droit).
        // Pas de plaque lue en base ici non plus : l'écran la tient de sa proposition. (Le journal,
        // lui, la porte : sa ligne est écrite chez la société DU véhicule, qui la connaît.)
        const bilan = bilanDe(fleetId);
        const lue = ficheParId.get(it.vehicleId);
        if (!(await this.permissions.canOnVehicle(user, it.vehicleId, 'vehicles_edit'))) {
          skipped.push({ vehicleId: it.vehicleId, plate: null, motif: MOTIF_SANS_DROIT_EDITION });
          bilan.ecartes.push({ vehicleId: it.vehicleId, plate: lue?.plate ?? null, motif: MOTIF_SANS_DROIT_EDITION });
          continue;
        }
        if (!lue) {
          skipped.push({ vehicleId: it.vehicleId, plate: null, motif: MOTIF_INTROUVABLE });
          bilan.ecartes.push({ vehicleId: it.vehicleId, plate: null, motif: MOTIF_INTROUVABLE });
          continue;
        }
        const fiche: FicheCapacite = { seats: lue.seats ?? null, features: lue.features ?? [] };
        const analyse = await analyseDe(fleetId);
        const proposition = analyse?.proposals.get(it.vehicleId);
        // Plus de `childSeats` (2026-09-28) : les sièges auto sont un stock de la société ; un
        // `childSeats` reçu n'est pas lu.
        const ajout = apportSurFiche(it, fiche);
        if (!apporteQuelqueChose(ajout)) {
          // La fiche porte déjà ces valeurs : rien à écrire, mais la proposition est faite — sans
          // quoi elle resterait « à appliquer » pour toujours.
          noter(analyse, it.vehicleId);
          bilan.inchanges.push(it.vehicleId);
          continue;
        }
        // Une correction faite à la main prime — sauf geste explicite « Appliquer quand même ».
        // `=== true` : un « true » en chaîne ou un 1 ne passe pas outre une correction manuelle.
        if (it.forcer !== true && ficheModifiee(proposition, fiche)) {
          skipped.push({ vehicleId: it.vehicleId, plate: lue.plate ?? null, motif: MOTIF_FICHE_MODIFIEE });
          bilan.ecartes.push({ vehicleId: it.vehicleId, plate: lue.plate ?? null, motif: MOTIF_FICHE_MODIFIEE });
          continue;
        }
        // Jamais une fiche que la vue Parc refuserait, jamais une partie des ajouts en silence :
        // l'écran lit le motif, et on fait de la place dans la vue Parc avant de réappliquer. Sans
        // ajout d'équipement, la liste n'est pas réécrite : une fiche déjà pleine reçoit ses places.
        if (ajout.features.length > 0 && fiche.features.length + ajout.features.length > FEATURES_MAX) {
          skipped.push({ vehicleId: it.vehicleId, plate: lue.plate ?? null, motif: MOTIF_TROP_EQUIPEMENTS });
          bilan.ecartes.push({ vehicleId: it.vehicleId, plate: lue.plate ?? null, motif: MOTIF_TROP_EQUIPEMENTS });
          continue;
        }
        const data: Prisma.VehicleUpdateInput = {};
        if (ajout.seats !== null) data.seats = ajout.seats;
        if (ajout.features.length > 0) data.features = [...fiche.features, ...ajout.features];
        try {
          await this.prisma.vehicle.update({ where: { id: it.vehicleId }, data });
        } catch (e) {
          // Supprimé entre la lecture et l'écriture : écarté comme les autres introuvables.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
            skipped.push({ vehicleId: it.vehicleId, plate: lue.plate ?? null, motif: MOTIF_INTROUVABLE });
            bilan.ecartes.push({ vehicleId: it.vehicleId, plate: lue.plate ?? null, motif: MOTIF_INTROUVABLE });
            continue;
          }
          throw e;
        }
        updated++;
        noter(analyse, it.vehicleId);
        bilan.appliques.push({
          vehicleId: it.vehicleId,
          plate: lue.plate ?? null,
          ...(ajout.seats !== null ? { seats: { avant: fiche.seats, apres: ajout.seats } } : {}),
          ajouts: ajout.features,
          force: it.forcer === true,
        });
      }
    } catch (e) {
      erreur = e;
    }
    // Journalisé AVANT de rendre la main (et avant de relancer une erreur) : les fiches déjà
    // écrites le sont, même si la boucle a été interrompue.
    this.journaliserCapacites(user, bilans, erreur);

    // L'analyse note ce qui est fait — y compris quand la boucle a été interrompue : les fiches
    // déjà écrites le sont, l'écran ne doit plus les proposer. `push` est un ajout atomique en
    // base : deux applications simultanées ne s'effacent plus l'une l'autre (l'ancienne
    // lecture-modification-écriture perdait un des deux lots).
    try {
      for (const [analysisId, ids] of aNoter) {
        const deja = [...analyses.values()].find((a) => a?.id === analysisId)?.deja ?? new Set<string>();
        const nouveaux = [...new Set(ids)].filter((v) => !deja.has(v));
        if (nouveaux.length === 0) continue;
        await this.prisma.aiCapacityAnalysis.update({
          where: { id: analysisId },
          data: { appliedVehicleIds: { push: nouveaux }, appliedAt: new Date() },
        });
      }
    } catch (e) {
      if (erreur === undefined) throw e; // sinon l'erreur de la boucle, première cause, l'emporte
    }
    if (erreur !== undefined) throw erreur;
    return { updated, skipped };
  }

  /**
   * Une ligne `capacites_appliquees` (catégorie AGENDA) par société touchée : combien de fiches
   * complétées, écartées (avec leur motif) ou déjà à jour, et véhicule par véhicule dans `meta`
   * (places avant → après, équipements ajoutés). `fleetId` = société DES VÉHICULES, jamais celle
   * de l'utilisateur. Ne lève jamais : le journal ne fait pas échouer « Appliquer ».
   */
  private journaliserCapacites(user: AuthUser, bilans: Map<string, BilanCapacites>, erreur: unknown): void {
    if (!this.systemActivity) return;
    for (const [fleetId, b] of bilans) {
      try {
        const nommes = b.appliques.slice(0, CAPACITES_NOMMEES_MAX).map((a) => {
          const quoi: string[] = [];
          if (a.seats) quoi.push(`${a.seats.avant ?? '?'} → ${a.seats.apres} places`);
          if (a.ajouts.length > 0) quoi.push(`+ ${a.ajouts.join(', ')}`);
          return `${a.plate ?? 'véhicule'} : ${quoi.join(', ')}`;
        });
        const suite = b.appliques.length > CAPACITES_NOMMEES_MAX ? ' ; …' : '';
        const parts = [
          `${b.appliques.length} véhicule(s) mis à jour${nommes.length > 0 ? ` (${nommes.join(' ; ')}${suite})` : ''}`,
        ];
        if (b.ecartes.length > 0) parts.push(`${b.ecartes.length} écarté(s)`);
        if (b.inchanges.length > 0) parts.push(`${b.inchanges.length} déjà à jour`);
        this.systemActivity.record({
          category: 'AGENDA',
          action: 'capacites_appliquees',
          status: erreur !== undefined ? 'FAILURE' : b.appliques.length > 0 ? 'SUCCESS' : 'SKIPPED',
          actor: 'utilisateur',
          target: b.appliques.length === 1 ? b.appliques[0].plate : null,
          detail: `Capacités du parc appliquées — ${parts.join(' · ')}${erreur !== undefined ? ' · interrompu par une erreur' : ''}`,
          fleetId,
          triggeredByUserId: user.id,
          meta: {
            applied: b.appliques.length,
            skipped: b.ecartes.length,
            unchanged: b.inchanges.length,
            vehicules: b.appliques,
            ecartes: b.ecartes,
            ...(erreur !== undefined ? { error: erreur instanceof Error ? erreur.message.slice(0, 300) : String(erreur) } : {}),
          },
        });
      } catch {
        // Le journal ne fait jamais échouer « Appliquer ».
      }
    }
  }

  // ─── Capacité 2 — optimiseur de placement ──────────────────────────────────

  /** Construit le payload placement (scopé, candidats disponibles). Réutilisé par preview + suggest. */
  private async buildPlacementPayload(
    user: AuthUser,
    dto: AiPlacementSuggestRequestDto,
  ): Promise<{
    payload: AiPlacementInputDto;
    candidates: AiPlacementCandidateInput[];
    slot: { startAt: string; endAt: string };
    excluded: {
      unknownCapacity: number;
      immobilized: number;
      dormant: number;
      childSeats: number;
      /** 29/09 (« 12 places ») — trop petits pour `minSeats`, et la plus grande capacité du périmètre. */
      tooSmall: number;
      largestSeats: number | null;
    };
    fleetId: string;
  }> {
    if (!dto?.startAt || !dto?.endAt) throw new BadRequestException('startAt et endAt (ISO) requis.');
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
      throw new BadRequestException('Créneau invalide.');
    }
    const slot = { startAt: start.toISOString(), endAt: end.toISOString() };

    // Calibrage flotte : le placement raisonne sur UNE société (comme la capacité). Un super-admin
    // DOIT préciser la flotte (sinon 400) — sans quoi les candidats agrègent TOUTES les sociétés et
    // le métier retombe sur GENERIC. Le métier + le nom viennent de CETTE flotte (injectés au prompt).
    const fleetId = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: { metier: true, name: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const metier = fleet.metier as FleetMetier;

    // Candidats = véhicules DISPONIBLES sur le créneau, SCOPÉS à la flotte résolue
    // (scoping + conflits réels gérés par suggest()).
    const sug = await this.reservations.suggest(user, {
      startAt: dto.startAt,
      endAt: dto.endAt,
      criteria: dto.criteria,
      fleetId,
    });

    // Prévision : indique « souvent pris à ce moment » (informe le tri, jamais bloquant).
    let forecastBusy = new Set<string>();
    try {
      const fc = await this.forecast.getForecast(user, start, end, fleetId);
      forecastBusy = new Set(
        fc.slots
          .filter((s) => new Date(s.startAt).getTime() < end.getTime() && new Date(s.endAt).getTime() > start.getTime())
          .map((s) => s.vehicleId),
      );
    } catch {
      // best-effort : on continue sans la prévision si elle échoue.
    }

    // Enrichissement COÛT (P3) : énergie + coût/km estimé + maintenance imminente par candidat,
    // pour que l'IA puisse mutualiser vers le véhicule le moins cher À MISSION ÉGALE.
    // `tracker.lastSeenAt` voyage dans CETTE requête (et pas une de plus) : il sert à écarter
    // les DORMANTS juste en dessous.
    const candidateIds = sug.vehicles.map((v) => v.vehicleId);
    const [meta, maintRows] = await Promise.all([
      candidateIds.length
        ? this.prisma.vehicle.findMany({
            where: { id: { in: candidateIds } },
            select: {
              id: true,
              energy: true,
              fuelConsumptionL100km: true,
              tracker: { select: { id: true, lastSeenAt: true } },
            },
          })
        : Promise.resolve([] as PlacementVehicleMeta[]),
      candidateIds.length
        ? this.prisma.vehicleEvent.findMany({
            where: {
              vehicleId: { in: candidateIds },
              type: VehicleEventType.MAINTENANCE,
              status: { in: [VehicleEventStatus.PLANNED, VehicleEventStatus.OPEN, VehicleEventStatus.IN_PROGRESS] },
              startAt: { gte: new Date(start.getTime() - DAY_MS), lte: new Date(start.getTime() + MAINT_SOON_MS) },
            },
            select: { vehicleId: true },
          })
        : Promise.resolve([] as { vehicleId: string }[]),
    ]);
    const metaById = new Map(meta.map((m) => [m.id, m]));
    const maintSet = new Set(maintRows.map((r) => r.vehicleId));

    // ── DORMANCE — on ne propose pas un véhicule qu'on ne sait plus joindre ────────────────
    //
    // Cas réel : FV-941-LZ, boîtier muet depuis 89 jours. Il n'a aucun trajet, donc son
    // `utilizationRatio` vaut 0 : c'est LE candidat que l'IA classe en tête au titre de la
    // mutualisation (critère 3 du prompt). La proposition arrive en tête de liste, un exploitant
    // la valide, et découvre à la remise des clés que le véhicule n'est plus là. On paie des
    // jetons pour produire un conseil inapplicable.
    //
    // Le vivier lui-même (`reservations.suggest`) écarte déjà les muets : ce filtre-ci est une
    // SECONDE barrière, tenue par le service qui construit le payload facturé. Elle vaut son
    // coût (une colonne de plus sur une requête déjà faite) parce que ce chemin-ci est le seul
    // qui envoie des véhicules à un moteur payant : si un jour le vivier change de règle ou
    // qu'un autre appelant l'alimente, l'IA ne recommencera pas à proposer un fantôme.
    //
    // Semantique volontaire : un véhicule SANS boîtier, ou dont le boîtier n'a JAMAIS émis, n'est
    // PAS dormant — il n'est pas suivi, mais il est bel et bien réservable (cf. isVehicleDormant).
    const now = Date.now();
    const dormantIds = new Set(
      sug.vehicles
        .filter((v) => {
          const t = metaById.get(v.vehicleId)?.tracker;
          return isVehicleDormant(
            { trackerId: t?.id ?? null, lastSeenAt: t?.lastSeenAt ?? null },
            now,
            // 7 j, EXPLICITEMENT — même seuil que le vivier amont, écrit ici plutôt que laissé au
            // défaut. Ce chemin PROPOSE, il n'agit pas : basculer sur le seuil « arrêter d'AGIR »
            // (72 h) retirerait des propositions un véhicule simplement garé le temps d'un pont,
            // et le client verrait son parc proposable rétrécir sans que rien n'ait changé.
            DORMANT_STOP_COUNTING_MS,
          );
        })
        .map((v) => v.vehicleId),
    );
    // Total = ce que le vivier a déjà écarté + ce qu'on écarte ici. Aucun double comptage
    // possible : un véhicule écarté en amont ne figure plus dans `sug.vehicles`, donc il ne peut
    // pas être recompté ci-dessus. Le garde `Number.isFinite` couvre les appelants qui ne
    // renseignent pas encore le compteur (le champ est jeune) — un `undefined` ferait un NaN
    // qui s'afficherait tel quel dans l'UI.
    const upstreamDormant = sug.excludedDormant;
    const excludedDormant =
      (Number.isFinite(upstreamDormant) && upstreamDormant > 0 ? upstreamDormant : 0) + dormantIds.size;

    const candidates: AiPlacementCandidateInput[] = sug.vehicles
      .filter((v) => !dormantIds.has(v.vehicleId))
      .map((v) => {
        const m = metaById.get(v.vehicleId);
        const energy = m?.energy ?? null;
        return {
          vehicleId: v.vehicleId,
          plate: v.vehiclePlate,
          seats: v.seats,
          features: v.features,
          utilizationRatio: v.utilizationRatio,
          underutilized: v.underutilized,
          forecastBusy: forecastBusy.has(v.vehicleId),
          energy,
          costPerKm: estimateCostPerKm(energy, m?.fuelConsumptionL100km ?? null),
          upcomingMaintenance: maintSet.has(v.vehicleId),
          // Sièges auto : ce qui est déjà à bord, et ce que le stock devrait fournir pour ce candidat.
          childSeatsInstalled: v.childSeatsInstalled ?? { baby: 0, child: 0 },
          childSeatsFromStock: v.childSeatsFromStock ?? { baby: 0, child: 0 },
        };
      });
    const underutilizedCount = candidates.filter((c) => c.underutilized).length;
    const avg = candidates.length ? candidates.reduce((s, c) => s + c.utilizationRatio, 0) / candidates.length : 0;
    const costs = candidates.map((c) => c.costPerKm).filter((x): x is number => typeof x === 'number');
    const cheapestCostPerKm = costs.length ? Math.min(...costs) : null;

    const payload: AiPlacementInputDto = {
      metier,
      fleetContext: fleet.name ?? null,
      // Le résumé est calculé sur les candidats RESTANTS : sans cette phrase, le modèle lit
      // « totalVehicles: 3 » comme « cette société a 3 véhicules » et bâtit son conseil de
      // mutualisation sur un parc qui n'est pas celui qu'on lui a montré.
      // ⚠️ « du périmètre analysé », PAS « de cette flotte » : `suggest()` est déjà borné aux
      // véhicules accessibles à CET utilisateur (un chef de groupe ne voit que son groupe) puis
      // aux véhicules conformes aux critères. Écrire « de cette flotte » ferait affirmer au modèle,
      // dans ses « notes » rendues à l'exploitant, un état du parc ENTIER que le serveur n'a jamais
      // mesuré — et un chef de groupe lirait « 2 véhicules hors service » sur une flotte de 40.
      ...(excludedDormant > 0
        ? {
            scopeNote:
              `${excludedDormant} véhicule(s) du périmètre analysé sont exclus de cette analyse : leur ` +
              `boîtier n'émet plus depuis plus de ${DORMANT_COUNTING_DAYS} jours, ils sont donc injoignables ` +
              `et non affectables. « candidates » et « fleetSummary » ne décrivent QUE le parc réellement ` +
              `suivi. Ne propose jamais un véhicule absent de « candidates », ne raisonne pas sur un parc ` +
              `plus large, et n'affirme rien sur les véhicules exclus au-delà de leur nombre.`,
          }
        : {}),
      request: {
        startAt: slot.startAt,
        endAt: slot.endAt,
        title: dto.title,
        reason: dto.reason,
        criteria: dto.criteria,
      },
      // Sièges auto : politique de la société et stock du créneau. Les candidats qui ne peuvent
      // pas couvrir le besoin (à bord + stock) ont déjà été écartés par le vivier, et comptés.
      childSeats: sug.childSeats ?? null,
      candidates,
      fleetSummary: {
        totalVehicles: candidates.length,
        underutilizedCount,
        avgUtilization: Math.round(avg * 100) / 100,
        cheapestCostPerKm,
        dormantExcluded: excludedDormant,
      },
    };
    return {
      payload,
      candidates,
      slot,
      // Transparence UI : véhicules écartés AVANT le raisonnement IA (résultats non faussés en silence).
      excluded: {
        unknownCapacity: sug.excludedUnknownCapacity ?? 0,
        immobilized: sug.excludedImmobilized ?? 0,
        dormant: excludedDormant,
        childSeats: sug.excludedChildSeats ?? 0,
        // Rendus par le vivier depuis le 29/09 (contrat `SuggestReservationResultDto`) — lus en
        // optionnel : un vivier qui ne les renseigne pas encore laisse le message d'avant.
        tooSmall: typeof sug.excludedTooSmall === 'number' && sug.excludedTooSmall > 0 ? sug.excludedTooSmall : 0,
        largestSeats: typeof sug.largestSeats === 'number' ? sug.largestSeats : null,
      },
      fleetId,
    };
  }

  /** Aperçu du payload placement (DRY-RUN, aucun appel Claude) — testable en Console. */
  async previewPlacement(user: AuthUser, dto: AiPlacementSuggestRequestDto): Promise<AiPlacementInputDto> {
    return (await this.buildPlacementPayload(user, dto)).payload;
  }

  async suggestPlacement(user: AuthUser, dto: AiPlacementSuggestRequestDto): Promise<AiPlacementResultDto> {
    const { payload, candidates, slot, excluded, fleetId } = await this.buildPlacementPayload(user, dto);
    if (candidates.length === 0) {
      // Relecture du 29/09 — les SIÈGES AUTO passent avant la taille (même règle que
      // `ReservationsService.contexteAucunVehicule`). Le vivier juge les sièges APRÈS le plancher de
      // places et l'occupation : un véhicule écarté pour ses sièges était libre ET assez grand.
      // Transmettre tel quel le 4 places de Client test (`tooSmall` = 1) faisait sauter la branche
      // « sièges auto » du constructeur et dire « aucun véhicule d'au moins 5 places n'est libre »
      // pour 7 véhicules libres à qui il manquait un siège bébé. La taille ne l'emporte que si le parc
      // n'a VRAIMENT aucun véhicule assez grand (`largestSeats < minSeats`).
      const minSeats = minSeatsDe(dto?.criteria);
      const parcTropPetit = !!minSeats && excluded.largestSeats != null && excluded.largestSeats < minSeats;
      const tropPetits = excluded.childSeats > 0 && !parcTropPetit ? 0 : excluded.tooSmall;
      return {
        slot,
        proposals: [],
        noGoodMatch: true,
        // « Aucun véhicule » tout court laisserait croire que la flotte est pleine sur ce créneau
        // alors que la vraie cause est un parc qui ne répond plus : on nomme la cause, sinon
        // l'exploitant cherche un conflit d'agenda qui n'existe pas.
        // Sièges auto (2026-09-28) : quand des véhicules libres ont été écartés faute de sièges
        // (pas assez à bord, et le stock ne complète pas ou ne suffit plus), la réponse est
        // CERTAINE et ne coûte aucun jeton — on la donne, avec la cause, pas « aucun véhicule ».
        // 29/09 (« 12 places ») : la phrase vient du constructeur PARTAGÉ avec la demande et la
        // réaffectation (`messageAucunVehicule`) — une demande de 12 places sur un parc dont le plus
        // grand en a 9 dit « aucun véhicule de 12 places », plus « aucun véhicule libre sur ce créneau ».
        notes: messageAucunVehicule({
          minSeats,
          excludedTooSmall: tropPetits,
          largestSeats: excluded.largestSeats,
          excludedUnknownCapacity: excluded.unknownCapacity,
          excludedChildSeats: excluded.childSeats,
          excludedDormant: excluded.dormant,
        }),
        excludedUnknownCapacity: excluded.unknownCapacity,
        excludedImmobilized: excluded.immobilized,
        excludedDormant: excluded.dormant,
        excludedChildSeats: excluded.childSeats,
      };
    }
    // Interrupteur maître : IA désactivée pour la flotte → pas de placement IA (l'app tourne sans IA).
    if (!(await this.aiAvail.isEnabledForFleet(fleetId, 'placement'))) {
      return {
        slot,
        proposals: [],
        noGoodMatch: true,
        notes: 'Assistance IA désactivée pour cette flotte.',
        excludedUnknownCapacity: excluded.unknownCapacity,
        excludedImmobilized: excluded.immobilized,
        excludedDormant: excluded.dormant,
        excludedChildSeats: excluded.childSeats,
      };
    }

    let ai: PlacementAiOutput;
    let aiCostEur: number | null = null;
    try {
      const call = await this.ai.completeJson<PlacementAiOutput>({
        system: renderPlacementSystem(payload.metier),
        userPayload: payload,
        schema: PLACEMENT_SCHEMA,
        // 8192 : une longue liste de propositions (grosse flotte) pouvait être tronquée à 4096.
        maxTokens: 8192,
      }, { trace: { action: 'placement', userId: user.id, fleetId } });
      ai = call.result;
      // Transparence : coût € de CET appel (même calcul que le palier « Coûts IA »).
      aiCostEur = Math.round(this.aiUsage.costOf(call.model, call.usage) * this.aiUsage.eurRate() * 10000) / 10000;
      void this.aiUsage.record({
        userId: user.id, fleetId, action: 'placement', model: call.model, provider: call.provider,
        inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
        cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
        latencyMs: call.latencyMs, ok: true,
      });
    } catch (err) {
      await this.recordAiFailure(err, 'placement', { userId: user.id, fleetId });
      throw err;
    }

    const byId = new Map(candidates.map((c) => [c.vehicleId, c]));
    const proposals: AiPlacementProposalDto[] = (ai?.proposals ?? [])
      .filter((p) => p && byId.has(p.vehicleId)) // anti-hallucination
      .map((p) => {
        const c = byId.get(p.vehicleId)!;
        return {
          vehicleId: p.vehicleId,
          plate: c.plate,
          seats: c.seats,
          energy: c.energy ?? null,
          costPerKm: c.costPerKm ?? null,
          score: clamp01(p.score),
          reasoning: typeof p.reasoning === 'string' ? p.reasoning.slice(0, 400) : '',
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      slot,
      proposals,
      noGoodMatch: !!ai?.noGoodMatch,
      notes: ai?.notes ?? null,
      excludedUnknownCapacity: excluded.unknownCapacity,
      excludedImmobilized: excluded.immobilized,
      excludedDormant: excluded.dormant,
      excludedChildSeats: excluded.childSeats,
      aiCostEur,
    };
  }

  // ─── Journalisation des échecs IA → centre d'alerte ────────────────────────

  /** Journalise un échec IA (source AI_OPTIMIZER) avec anti-spam. Ne propage pas d'erreur. */
  private async recordAiFailure(
    err: unknown,
    capability: 'capacity' | 'placement',
    ctx: { userId?: string; fleetId?: string; vehicleCount?: number },
  ): Promise<void> {
    const kind: AiErrorKind = err instanceof AiServiceError ? err.kind : 'http';
    // TRK-061 — la gravité est décidée par la couche IA (`NIVEAU_PAR_KIND`), pas ici. Avant, la
    // règle « clé invalide = CRITICAL » vivait dans ce seul appelant : le même incident changeait
    // de gravité selon la porte par laquelle il entrait.
    const level: NiveauEchecIa = err instanceof AiServiceError ? err.niveau : 'ERROR';
    const key = `${capability}:${ctx.fleetId ?? 'all'}:${kind}`;
    const now = Date.now();
    const last = this.aiErrLast.get(key);
    if (last && now - last < AI_ALERT_THROTTLE_MS) return; // anti-spam
    this.aiErrLast.set(key, now);
    // TRK-061 — on passe l'INSTANCE, pas son message.
    //
    // C'est la cause exacte du « un incident, deux lignes » du 03/09 (`AI_OPTIMIZER` à .379 puis
    // `http` à .396, 17 ms plus tard, pour UN seul appel) : `ErrorLogger.record` marque l'erreur
    // qu'il vient d'archiver pour qu'une couche supérieure ne la réécrive pas — mais il ne peut
    // marquer qu'un OBJET. En lui donnant une chaîne, le marqueur ne se posait sur rien, et le
    // filtre global d'exceptions archivait le même incident une seconde fois.
    //
    // ⚠️ Le motif du fournisseur va dans le CONTEXTE, jamais dans le message : `message` est le
    // corps de la réponse HTTP servie à l'utilisateur.
    const motifFournisseur = err instanceof AiServiceError ? err.detail : undefined;
    try {
      await this.errors.record(
        err instanceof Error ? err : new Error(String(err)),
        'AI_OPTIMIZER',
        { ...ctx, capability, kind, motifFournisseur },
        level,
      );
    } catch {
      // la journalisation ne doit jamais casser la requête.
    }
  }

  // ─── Métier de la flotte (lecture / réglage) ───────────────────────────────

  async getFleetMetier(user: AuthUser, fleetId?: string): Promise<FleetMetierDto> {
    const id = this.resolveFleetId(user, fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id },
      select: { id: true, name: true, metier: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    return { fleetId: fleet.id, fleetName: fleet.name, metier: fleet.metier as FleetMetier };
  }

  async setFleetMetier(user: AuthUser, dto: SetFleetMetierDto): Promise<FleetMetierDto> {
    const allowed: FleetMetier[] = ['CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC'];
    if (!dto?.metier || !allowed.includes(dto.metier)) {
      throw new BadRequestException('Métier invalide.');
    }
    const id = this.resolveFleetId(user, dto.fleetId);
    const existing = await this.prisma.fleet.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Flotte introuvable.');
    const updated = await this.prisma.fleet.update({
      where: { id },
      data: { metier: dto.metier },
      select: { id: true, name: true, metier: true },
    });
    return { fleetId: updated.id, fleetName: updated.name, metier: updated.metier as FleetMetier };
  }

  /** Résout la flotte cible (propre flotte ou, super-admin, celle passée) + garde de périmètre. */
  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la flotte (fleetId).');
    if (user.role !== UserRole.SUPER_ADMIN && id !== user.fleetId) {
      throw new ForbiddenException('Flotte hors périmètre.');
    }
    return id;
  }
}

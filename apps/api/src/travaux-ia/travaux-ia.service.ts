import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from '../observability/refroidissement-alerte.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * File de travaux IA exécutés sur le POSTE du propriétaire — cf. design/C1-TRAVAUX-IA-LOCAUX.md,
 * durcie par design/C3-CHANTIER-IA-2026-09-05.md (points 3 et 6).
 *
 * ── LE CONTRAT, EN UNE PHRASE ────────────────────────────────────────────────────────
 *
 * Le serveur PRÉPARE tout (prompt système, schéma JSON, données) et CONSOMME tout (validation,
 * persistance) ; l'agent du poste n'est qu'un COURRIER qui remplit `resultat`. Aucune logique
 * métier ne quitte le serveur — c'est ce qui a permis de basculer le rapport d'activité et
 * l'analyse de lieux en local SANS recopier une seule requête Prisma dans un `.cjs`, la
 * recopie étant la source des trois jours d'incidents qui précèdent ce fichier.
 *
 * ── CYCLE DE VIE D'UN TRAVAIL ────────────────────────────────────────────────────────
 *
 *   a-faire ──(courrier)──▶ pris ──▶ fait ──(consommateur)──▶ ligne EFFACÉE
 *                             │                    (l'objet métier persisté EST la trace)
 *                             └──▶ a-faire (repris après 2 h : agent tué — payé trois fois
 *                                  en deux jours : un reboot, deux crashs de session)
 *                             └──▶ echec (après 3 tentatives — pas d'acharnement, UNE alerte,
 *                                  une ligne d'usage `ok=false`, purgé après 7 jours)
 *
 * ── CE QUE LE 2026-09-05 A CHANGÉ (C3, point 6) ──────────────────────────────────────
 *
 * Relevé en production ce jour-là : 5 travaux `analyse-lieu` en `echec` depuis le 27/08, repris
 * 76 à 1 330 fois par le courrier avant d'y arriver — le plafond de 3 tentatives promis par C1
 * n'était appliqué qu'aux `pris` périmés, jamais aux `a-faire` que le courrier reposait en boucle.
 * Aucune alerte, aucune ligne `ok=false` dans `ai_usage_logs`, et les lignes mortes restaient là.
 * D'où : le plafond acté aussi sur les `a-faire`, une transition unique vers `echec` qui écrit
 * l'alerte et l'usage, et une purge quotidienne.
 *
 * ── LES JETONS RÉELS (C3, point 3) ───────────────────────────────────────────────────
 *
 * Le courrier range désormais dans `resultat`, à côté du contenu, ce que la CLI a mesuré :
 * `{ contenu, modele, usage, coutEquivalentUsd, dureeMs }`. `lireResultatLocal()` en fait un objet
 * sûr pour les consommateurs — et tolère l'ANCIEN format `{ contenu, modele }` (travaux déjà
 * `fait` avant le déploiement) : jetons 0, jamais d'erreur.
 */

export type TypeTravailIa = 'rapport-activite' | 'analyse-lieu';

/** Un travail pris depuis plus longtemps que ça est réputé abandonné (agent tué). */
export const REPRISE_APRES_MS = 2 * 60 * 60 * 1000;
/** Au-delà, on cesse d'essayer : le travail passe en `echec` et se voit au catalogue. Même valeur que le courrier. */
export const TENTATIVES_MAX = 3;
/**
 * Un `echec` de plus de 7 jours disparaît. Une semaine laisse le temps de lire l'alerte et le
 * motif ; au-delà, la ligne n'apprend plus rien (les 5 travaux morts du 27/08 étaient encore là
 * le 05/09, alors que leurs lieux avaient été ré-analysés avec succès les 01 et 02/09).
 */
export const PURGE_ECHECS_APRES_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Refroidissement de l'alerte d'échec définitif : UNE ligne par travail. 30 jours dépassent la
 * durée de vie de la ligne (purgée à 7 j) : un même travail ne peut donc jamais crier deux fois,
 * même si deux chemins (courrier puis serveur, `rejeter` puis `reprendrePerimes`) actent le même
 * échec à quelques minutes d'intervalle.
 */
export const REFROIDISSEMENT_ECHEC_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Préfixe de la clé de refroidissement, suffixé par l'id du travail (`travaux-ia:echec:<id>`).
 *
 * La clé vit dans `CLES_REFROIDISSEMENT` (observability/refroidissement-alerte.service.ts), le
 * registre qui montre d'un coup d'œil qui possède un refroidissement ; elle est reprise ici pour
 * ne pas répéter la chaîne. Une clé est un identifiant PERSISTANT : la renommer remettrait le
 * garde à zéro.
 */
export const CLE_REFROIDISSEMENT_ECHEC: string = CLES_REFROIDISSEMENT.TRAVAUX_IA_ECHEC;
/** Source des lignes du centre d'alerte écrites par cette file. */
export const SOURCE_ALERTE = 'travaux-ia';

/** Usage d'un appel modèle, tel que `AiUsageService.record` le compte. */
export interface UsageJetons {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** Ce que le courrier a rangé dans `resultat`, lu de façon sûre. */
export interface ResultatTravailLocal {
  contenu: unknown;
  /** Identifiant RÉEL du modèle rendu par la CLI (ex. `claude-sonnet-4-5-20250929`), `local` à défaut. */
  modele: string;
  usage: UsageJetons;
  /** Durée de l'appel CLI en ms (0 si inconnue). */
  latencyMs: number;
  /** Coût équivalent API rendu par la CLI (`total_cost_usd`) — informatif, JAMAIS facturé. */
  coutEquivalentUsd: number | null;
}

const USAGE_NUL: UsageJetons = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
const entierPositif = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * Lit le `resultat` d'un travail `fait`, quel que soit son format.
 *
 * Nouveau format (courrier ≥ 2026-09-05) : `{ contenu, modele, usage: { inputTokens, outputTokens,
 * cacheWriteTokens, cacheReadTokens }, coutEquivalentUsd, dureeMs }`. Ancien format : `{ contenu,
 * modele }` — jetons à 0, modèle tel quel. Un `resultat` nul ou difforme rend un objet vide : c'est
 * le `sanitize()` du consommateur qui décide de rejeter, pas cette lecture.
 */
export function lireResultatLocal(resultat: unknown): ResultatTravailLocal {
  const r = (resultat && typeof resultat === 'object' && !Array.isArray(resultat) ? resultat : {}) as Record<string, unknown>;
  const u = (r['usage'] && typeof r['usage'] === 'object' ? r['usage'] : {}) as Record<string, unknown>;
  const cout = r['coutEquivalentUsd'];
  return {
    contenu: r['contenu'],
    modele: typeof r['modele'] === 'string' && r['modele'].trim() ? r['modele'] : 'local',
    usage: {
      inputTokens: entierPositif(u['inputTokens']),
      outputTokens: entierPositif(u['outputTokens']),
      cacheWriteTokens: entierPositif(u['cacheWriteTokens']),
      cacheReadTokens: entierPositif(u['cacheReadTokens']),
    },
    latencyMs: entierPositif(r['dureeMs']),
    coutEquivalentUsd: typeof cout === 'number' && Number.isFinite(cout) && cout >= 0 ? cout : null,
  };
}

/**
 * L'action `ai_usage_logs` d'un type de travail — la MÊME que celle écrite par le consommateur
 * quand le travail réussit, pour que l'échec apparaisse dans la même ligne du tableau « par
 * fonction ». Un type futur inconnu garde son nom : la page le montre tel quel plutôt que de
 * le fondre dans une autre fonction.
 */
export function actionUsagePourType(type: string): string {
  switch (type) {
    case 'analyse-lieu': return 'place_analysis';
    case 'rapport-activite': return 'activity_report';
    default: return type;
  }
}

/** Ce qu'il faut d'une ligne pour acter son échec et le dire. */
interface LigneAActer {
  id: string;
  type: string;
  tentatives: number;
  erreur: string | null;
  contexte: unknown;
}

@Injectable()
export class TravauxIaService {
  private readonly logger = new Logger(TravauxIaService.name);

  /**
   * Les trois services d'observabilité et d'usage sont `@Optional()` : `ObservabilityModule` et
   * `AiUsageModule` sont `@Global`, donc toujours présents dans l'application — mais la spec
   * construit ce service avec le seul Prisma, et une file qui ne saurait pas alerter doit
   * continuer à FONCTIONNER (l'échec est acté quoi qu'il arrive ; l'alerte est un plus).
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly errorLogger?: ErrorLogger,
    @Optional() private readonly refroidissement?: RefroidissementAlerteService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  /**
   * Enfile un travail, en refusant le doublon : si un travail du même type encore vivant
   * (`a-faire`, `pris` ou `fait` non consommé) porte le même `cleIdempotence` dans son
   * contexte, on ne ré-enfile pas. Un producteur horaire qui repasse avant que le courrier
   * soit passé créerait sinon un travail — donc un appel modèle — par heure.
   */
  async enfiler(
    type: TypeTravailIa,
    payload: { system: string; schema: unknown; userPayload: unknown; maxTokens?: number },
    contexte: Record<string, unknown> & { cleIdempotence: string },
  ): Promise<{ enfile: boolean; id?: string }> {
    const existant = await this.prisma.travailIaLocal.findFirst({
      where: {
        type,
        statut: { in: ['a-faire', 'pris', 'fait'] },
        contexte: { path: ['cleIdempotence'], equals: contexte.cleIdempotence },
      },
      select: { id: true },
    });
    if (existant) return { enfile: false };

    const row = await this.prisma.travailIaLocal.create({
      data: {
        type,
        payload: payload as unknown as Prisma.InputJsonValue,
        contexte: contexte as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    this.logger.log(`travail ${type} enfile (${row.id})`);
    return { enfile: true, id: row.id };
  }

  /**
   * Redonne leur chance aux travaux abandonnés, et acte les échecs définitifs.
   * Appelé par les crons consommateurs — pas besoin d'un traitement dédié pour si peu.
   *
   *   — `pris` depuis plus de 2 h et sous le plafond → `a-faire` (agent tué) ;
   *   — `pris` depuis plus de 2 h AU plafond → `echec` (`abandonnes`) ;
   *   — `a-faire` AU plafond → `echec` (`plafonnes`). C'est le cas que C1 promettait sans le
   *     tenir : le courrier reposait indéfiniment (76 à 1 330 reprises relevées le 05/09). Le
   *     courrier acte désormais lui-même à la 3ᵉ tentative ; ceci rattrape un courrier ancien,
   *     un travail reposé par un décodage raté, ou une ligne modifiée à la main.
   *
   * Le motif existant n'est JAMAIS écrasé : il dit POURQUOI (JSON illisible, délai dépassé,
   * session expirée…), et c'est la seule chose que l'opérateur lira.
   */
  async reprendrePerimes(): Promise<{ repris: number; abandonnes: number; plafonnes: number }> {
    const limite = new Date(Date.now() - REPRISE_APRES_MS);
    const { count: repris } = await this.prisma.travailIaLocal.updateMany({
      where: { statut: 'pris', prisA: { lt: limite }, tentatives: { lt: TENTATIVES_MAX } },
      data: { statut: 'a-faire', prisA: null },
    });
    const abandonnes = await this.acterEchecs(
      { statut: 'pris', prisA: { lt: limite }, tentatives: { gte: TENTATIVES_MAX } },
      'agent interrompu à chaque tentative',
    );
    const plafonnes = await this.acterEchecs(
      { statut: 'a-faire', tentatives: { gte: TENTATIVES_MAX } },
      'reposé sans livraison à chaque tentative',
    );
    if (repris || abandonnes || plafonnes) {
      this.logger.log(`travaux perimes : ${repris} repris, ${abandonnes} abandonnes, ${plafonnes} au plafond de tentatives`);
    }
    return { repris, abandonnes, plafonnes };
  }

  /**
   * Les travaux d'un type que le courrier a terminés et que le consommateur doit ranger.
   * Le `payload` est rendu aussi : l'analyse de lieux persiste les FAITS qui ont nourri le
   * modèle (colonne `facts` + empreinte anti-redite), et ils vivent dans le payload.
   */
  async faits(type: TypeTravailIa): Promise<Array<{ id: string; resultat: unknown; contexte: Record<string, unknown>; payload: Record<string, unknown> }>> {
    const rows = await this.prisma.travailIaLocal.findMany({
      where: { type, statut: 'fait' },
      select: { id: true, resultat: true, contexte: true, payload: true },
      orderBy: { finiA: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, resultat: r.resultat, contexte: r.contexte as Record<string, unknown>, payload: r.payload as Record<string, unknown> }));
  }

  /**
   * Le consommateur a persisté l'objet métier : la ligne s'efface — l'objet EST la trace.
   * S'il a jugé le résultat inexploitable, il repasse par `rejeter` à la place.
   */
  async consommer(id: string): Promise<void> {
    await this.prisma.travailIaLocal.delete({ where: { id } }).catch(() => {
      /* deja consomme par un passage concurrent : sans gravite */
    });
  }

  /** Résultat inexploitable (sanitize a refusé) : on rejoue, puis on acte l'échec. */
  async rejeter(id: string, motif: string): Promise<void> {
    const row = await this.prisma.travailIaLocal.findUnique({
      where: { id },
      select: { id: true, type: true, tentatives: true, erreur: true, contexte: true },
    });
    if (!row) return;
    if (row.tentatives >= TENTATIVES_MAX) {
      await this.passerEnEchec(row, motif);
    } else {
      await this.prisma.travailIaLocal.update({
        where: { id },
        data: { statut: 'a-faire', resultat: Prisma.DbNull, prisA: null, erreur: motif.slice(0, 400) },
      });
    }
  }

  /**
   * Purge quotidienne des `echec` de plus de 7 jours.
   *
   * 04:50, heure du serveur : après la vague des purges de rétention (03:00 à 04:45) et avant le
   * premier passage du poste (06:30) et les sentinelles (06:30) — une minute creuse où rien
   * d'autre ne touche la base. Public et paramétrable en date pour la spec ; le `@Cron` ne fait
   * que l'appeler. Une tâche de fond qui lève tue l'ordonnanceur pour toutes les suivantes :
   * l'échec est journalisé, jamais propagé.
   */
  @Cron('0 50 4 * * *', { name: 'travaux-ia-purge-echecs' })
  async purgerEchecsAnciensPlanifie(): Promise<void> {
    try {
      const n = await this.purgerEchecsAnciens();
      if (n > 0) this.logger.log(`${n} travail(aux) IA en echec depuis plus de 7 jours purge(s)`);
    } catch (e) {
      this.logger.error(`purge des travaux IA en échec impossible : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Supprime les `echec` dont `finiA` (ou `creeA` quand `finiA` manque — lignes actées avant que
   * la transition ne pose la date) est antérieur à `maintenant − 7 j`. Rend le nombre supprimé.
   */
  async purgerEchecsAnciens(maintenant: Date = new Date()): Promise<number> {
    const limite = new Date(maintenant.getTime() - PURGE_ECHECS_APRES_MS);
    const { count } = await this.prisma.travailIaLocal.deleteMany({
      where: {
        statut: 'echec',
        OR: [{ finiA: { lt: limite } }, { finiA: null, creeA: { lt: limite } }],
      },
    });
    return count;
  }

  /** Pour l'écran des traitements : la file en un coup d'œil. */
  async etat(): Promise<{ aFaire: number; pris: number; faits: number; echecs: number }> {
    const [aFaire, pris, faits, echecs] = await Promise.all([
      this.prisma.travailIaLocal.count({ where: { statut: 'a-faire' } }),
      this.prisma.travailIaLocal.count({ where: { statut: 'pris' } }),
      this.prisma.travailIaLocal.count({ where: { statut: 'fait' } }),
      this.prisma.travailIaLocal.count({ where: { statut: 'echec' } }),
    ]);
    return { aFaire, pris, faits, echecs };
  }

  // ─── La transition vers `echec` — un seul chemin ──────────────────────────────────

  /** Acte en `echec` toutes les lignes qui répondent à `where`, une par une, et rend leur nombre. */
  private async acterEchecs(where: Prisma.TravailIaLocalWhereInput, motifParDefaut: string): Promise<number> {
    const lignes = await this.prisma.travailIaLocal.findMany({
      where,
      select: { id: true, type: true, tentatives: true, erreur: true, contexte: true },
    });
    for (const ligne of lignes) await this.passerEnEchec(ligne, null, motifParDefaut);
    return lignes.length;
  }

  /**
   * L'UNIQUE transition vers `echec` (C3, point 6) : écrit le statut, la date, un motif qui
   * conserve celui déjà présent, puis signale — une alerte et une ligne d'usage `ok=false`.
   *
   * `motif` est celui de l'appelant (le consommateur qui rejette) ; à défaut, le motif DÉJÀ
   * stocké sur la ligne (celui du courrier : sortie de la CLI, délai, JSON illisible) ; à défaut
   * encore, `motifParDefaut` décrit le chemin qui a acté. Le tout préfixé « plafond de tentatives
   * atteint — » pour qu'on lise d'abord CE qui s'est passé, puis POURQUOI.
   */
  private async passerEnEchec(ligne: LigneAActer, motif: string | null, motifParDefaut = 'aucun motif transmis'): Promise<void> {
    const cause = (motif ?? ligne.erreur ?? '').trim() || motifParDefaut;
    // La cause d'une sortie de CLI est à la FIN (pile Node d'abord, « API Error … » en dernier) :
    // on garde la fin de la cause, jamais le début (revue C3 du 2026-09-05).
    const prefixe = 'plafond de tentatives atteint — ';
    const erreur = prefixe + cause.slice(-(400 - prefixe.length));
    await this.prisma.travailIaLocal.update({
      where: { id: ligne.id },
      data: { statut: 'echec', erreur, finiA: new Date() },
    });
    await this.signalerEchecDefinitif({ ...ligne, erreur });
  }

  /**
   * Un échec définitif doit SE VOIR (C3, point 5-6) : jusqu'au 05/09, `ai_usage_logs` n'avait
   * jamais porté une ligne `ok=false` et le centre d'alerte ignorait la file.
   *
   *   1. une ligne d'usage `ok=false`, executor `local`, 0 jeton, modèle `local` : le KPI « Échecs »
   *      de la page « Coûts IA » compte les travaux morts, sous la même action que les succès ;
   *   2. UNE ligne au centre d'alerte, derrière un refroidissement PAR TRAVAIL : deux chemins qui
   *      actent le même échec (courrier puis serveur) ne produisent qu'une alerte. Sans service de
   *      refroidissement (spec), on émet : devant le doute, le silence est le mauvais défaut.
   *
   * Aucune de ces deux écritures ne peut faire échouer la transition elle-même.
   */
  private async signalerEchecDefinitif(t: LigneAActer & { erreur: string }): Promise<void> {
    const contexte = (t.contexte && typeof t.contexte === 'object' ? t.contexte : {}) as Record<string, unknown>;
    const fleetId = typeof contexte['fleetId'] === 'string' ? contexte['fleetId'] : null;

    try {
      await this.aiUsage?.record({
        userId: null,
        fleetId,
        model: 'local',
        action: actionUsagePourType(t.type),
        executor: 'local',
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        latencyMs: null,
        ok: false,
        // 0 et non null : cet appel n'a RIEN produit, et c'est un fait, pas une absence de mesure.
        resultCount: 0,
      });
    } catch (e) {
      this.logger.warn(`usage ok=false non journalisé pour ${t.id} : ${e instanceof Error ? e.message : String(e)}`);
    }

    const message = `Travail IA local en échec définitif : ${t.type} (${t.tentatives} tentatives) — ${t.erreur}`;
    this.logger.error(message);
    try {
      const emettre = this.refroidissement
        ? await this.refroidissement.tenterEmission(`${CLE_REFROIDISSEMENT_ECHEC}:${t.id}`, REFROIDISSEMENT_ECHEC_MS)
        : true;
      if (!emettre || !this.errorLogger) return;
      await this.errorLogger.record(
        new Error(message),
        SOURCE_ALERTE,
        { id: t.id, type: t.type, tentatives: t.tentatives, erreur: t.erreur, contexte },
        'ERROR',
      );
    } catch (e) {
      this.logger.warn(`alerte d'échec non écrite pour ${t.id} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

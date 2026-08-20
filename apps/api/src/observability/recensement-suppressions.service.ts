import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from './error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Ce qu'on relève d'une table surveillée : combien de lignes, et depuis quand. */
export interface Recensement {
  /** Nombre de lignes. */
  n: number;
  /** Horodatage de la PLUS ANCIENNE ligne, en ISO. `null` si la table est vide. */
  plusAncienne: string | null;
}

export type RecensementParTable = Record<string, Recensement>;

/** Une disparition constatée, telle qu'elle sera écrite au centre d'alerte. */
export interface Disparition {
  table: string;
  lignesPerdues: number;
  /** De combien de jours la borne basse a AVANCÉ. `null` si elle n'a pas bougé. */
  bondJours: number | null;
  avant: Recensement;
  apres: Recensement;
}

/**
 * Une purge enregistrée par le ménage automatique, telle qu'on la lit dans le journal.
 * La clé est le nom de table, la valeur le nombre de lignes que la purge revendique.
 */
export type PurgesEnregistrees = Record<string, number>;

/**
 * ══ LA COMPARAISON, EN FONCTION PURE ══════════════════════════════════════════════════
 *
 * Sortie du service exprès : c'est la règle métier, elle doit être vérifiable sans base,
 * sans horloge et sans injection. Tout le reste de ce fichier n'est que de la plomberie.
 *
 * ── CE QUI DÉCLENCHE, ET CE QUI NE DÉCLENCHE PAS ─────────────────────────────────────
 *
 * Une table perd des lignes tous les jours sans que ce soit anormal : c'est la rétention.
 * Le ménage automatique, lui, écrit ce qu'il supprime. La question n'est donc pas
 * « des lignes ont-elles disparu ? » mais **« la disparition est-elle EXPLIQUÉE ? »**.
 *
 * On compare donc la baisse constatée au nombre de lignes que les purges enregistrées
 * revendiquent. Ce qui dépasse n'a pas d'explication — et c'est cela qu'on signale.
 *
 * ⚠️ On regarde DEUX signaux, pas un seul :
 *   — le NOMBRE de lignes, qui baisse ;
 *   — la BORNE BASSE (`plusAncienne`), qui avance.
 * Une suppression ciblée au milieu de l'historique ferait baisser le nombre sans toucher
 * la borne ; un `DELETE` par ancienneté ferait les deux. Le second signal est le plus
 * parlant, mais s'y fier seul laisserait passer le premier cas.
 */
export function comparerRecensements(
  avant: RecensementParTable,
  apres: RecensementParTable,
  purges: PurgesEnregistrees = {},
): Disparition[] {
  const trouvees: Disparition[] = [];

  for (const [table, precedent] of Object.entries(avant)) {
    const courant = apres[table];
    if (!courant) continue;

    const baisse = precedent.n - courant.n;
    const expliquees = purges[table] ?? 0;
    const inexpliquees = baisse - expliquees;

    const bondJours = bondBorneBasse(precedent.plusAncienne, courant.plusAncienne);

    // ⚠️ Une borne basse qui avance ALORS QUE la purge n'a rien revendiqué est le signal le
    // plus net d'une suppression hors application — c'est exactement ce qui s'est passé le
    // 2026-08-19 : la borne a bondi de 22 jours pendant que le ménage déclarait 0 ligne.
    const borneSuspecte = bondJours !== null && bondJours > 0 && expliquees === 0;

    if (inexpliquees > 0 || borneSuspecte) {
      trouvees.push({
        table,
        lignesPerdues: Math.max(inexpliquees, 0),
        bondJours,
        avant: precedent,
        apres: courant,
      });
    }
  }

  return trouvees;
}

/** De combien de jours la plus ancienne ligne a-t-elle « rajeuni » ? */
function bondBorneBasse(avant: string | null, apres: string | null): number | null {
  if (!avant || !apres) return null;
  const ecartMs = new Date(apres).getTime() - new Date(avant).getTime();
  if (!Number.isFinite(ecartMs) || ecartMs <= 0) return null;
  return Math.round(ecartMs / 86_400_000);
}

/** Une phrase par table, lisible sans ouvrir la base. */
export function messageDisparition(d: Disparition): string {
  const bond = d.bondJours !== null && d.bondJours > 0 ? `, et sa plus ancienne ligne a avancé de ${d.bondJours} jour(s)` : '';
  return (
    `${d.table} : ${d.lignesPerdues} ligne(s) ont disparu sans qu'aucune purge ne le revendique${bond}. ` +
    `Avant : ${d.avant.n} ligne(s) depuis ${d.avant.plusAncienne ?? '—'}. ` +
    `Après : ${d.apres.n} ligne(s) depuis ${d.apres.plusAncienne ?? '—'}.`
  );
}

const SOURCE = 'recensement-suppressions';
const ACTION_RECENSEMENT = 'recensement_lignes';

/**
 * ══ TRK-035 — RENDRE VISIBLE CE QU'AUCUN GARDE-FOU NE PEUT EMPÊCHER ══════════════════
 *
 * ── L'INCIDENT ───────────────────────────────────────────────────────────────────────
 *
 * Entre deux passages de l'audit, le 2026-08-19, **41 709 alertes et au moins 89 lignes
 * d'erreur ont disparu**. Les trois pistes ont été fermées une par une :
 *
 *   — le ménage automatique déclare `errorDeleted: 0`, et sa fenêtre est à 90 jours ;
 *   — il n'existe **qu'une seule** suppression de masse de lignes d'erreur dans toute
 *     l'image servie, celle du cron, et **aucune** sur les alertes ;
 *   — la migration du jour ajoute deux colonnes, rien d'autre.
 *
 * La suppression a donc été faite **directement en base**. On ne l'a vue que dans les
 * statistiques internes de PostgreSQL — et **un jour plus tard**.
 *
 * ── POURQUOI CE N'EST PAS UN GARDE-FOU, ET NE PEUT PAS EN ÊTRE UN ────────────────────
 *
 * 🔑 **Aucun code applicatif ne peut arrêter un `DELETE` exécuté directement en base.**
 * C'est le fond du sujet, et il ne faut pas se raconter le contraire : cette sonde
 * n'empêche rien. Elle fait la seule chose qui reste possible — **empêcher que ça passe
 * inaperçu**.
 *
 * *Un garde-fou posé dans le code ne protège que ce qui passe par le code.*
 *
 * ── CE QUE ÇA COÛTAIT DE NE PAS LE VOIR ──────────────────────────────────────────────
 *
 * Le taux d'alertes sans message est passé de **81,6 % à 5,5 %** — non pas parce qu'un
 * correctif a agi, mais parce que le dénominateur avait été effacé. Sans relevé, une telle
 * chute se lit comme un progrès. C'est la pire erreur de lecture possible d'un tableau de
 * bord : croire qu'on a réparé ce qu'on a seulement cessé de compter.
 *
 * ── LE RELEVÉ VIT AILLEURS QUE DANS LES TABLES SURVEILLÉES ───────────────────────────
 *
 * ⚠️ Volontaire, et c'est tout l'intérêt : un recensement rangé dans `error_logs`
 * disparaîtrait avec les lignes qu'il est censé compter. Il est écrit dans le journal des
 * actions système, où il est aussi **lisible depuis l'écran d'administration** — la même
 * place que le ménage automatique utilise déjà pour déclarer ses propres purges.
 */
@Injectable()
export class RecensementSuppressionsService {
  private readonly logger = new Logger(RecensementSuppressionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * Chaque nuit à 03:15 — **APRÈS le ménage automatique de 03:00**, et c'est délibéré.
   *
   * ⚠️ Recenser avant la purge produirait un écart d'un jour à chaque passage : on compterait
   * l'état d'avant le ménage et on le comparerait à celui d'après, donc chaque nuit
   * ressemblerait à une disparition. La sonde crierait tous les jours, on l'ignorerait, et
   * le jour où elle aurait raison personne ne la lirait.
   */
  @Cron('0 15 3 * * *')
  async recenser(): Promise<void> {
    try {
      const precedent = await this.dernierRecensement();
      const courant = await this.mesurer();

      // On enregistre TOUJOURS, y compris quand rien n'a bougé : c'est la série qui rend une
      // disparition future lisible, pas le relevé isolé.
      this.enregistrer(courant);

      if (!precedent) {
        this.logger.log('Premier recensement posé — rien à comparer, la série commence ici.');
        return;
      }

      const purges = await this.purgesDepuis(precedent.date);
      const disparitions = comparerRecensements(precedent.tables, courant, purges);
      if (disparitions.length === 0) return;

      for (const d of disparitions) {
        await this.errorLogger.record(
          new Error(messageDisparition(d)),
          SOURCE,
          {
            table: d.table,
            lignesPerdues: d.lignesPerdues,
            bondJours: d.bondJours,
            avant: d.avant,
            apres: d.apres,
            purgeRevendiquee: purges[d.table] ?? 0,
          },
          // CRITICAL assumé : la consigne du propriétaire est qu'une erreur reste visible tant
          // qu'elle n'est pas corrigée ET vérifiée. Une disparition non expliquée contourne
          // cette consigne, et c'est le seul moment où on peut encore le dire.
          'CRITICAL',
        );
      }
    } catch (err) {
      // Une sonde qui tombe ne doit pas emporter le worker — même règle que le ménage.
      this.logger.error(
        `Recensement des suppressions en echec : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** L'état courant des tables surveillées. */
  async mesurer(): Promise<RecensementParTable> {
    const [nErreurs, plusAncienneErreur, nAlertes, plusAncienneAlerte] = await Promise.all([
      this.prisma.errorLog.count(),
      this.prisma.errorLog.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.alert.count(),
      this.prisma.alert.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return {
      error_logs: { n: nErreurs, plusAncienne: plusAncienneErreur?.createdAt.toISOString() ?? null },
      alerts: { n: nAlertes, plusAncienne: plusAncienneAlerte?.createdAt.toISOString() ?? null },
    };
  }

  /**
   * ⚠️ `record()` est FIRE-AND-FORGET et ne jette jamais : il ne faut pas l'attendre, et il ne
   * faut pas croire qu'il garantit l'écriture. La limite est assumée et connue — si le journal
   * échoue, la série repart de zéro le lendemain plutôt que de mentir, et l'échec lui-même
   * remonte au centre d'alerte par le chemin interne du journal. *Un relevé manquant est
   * lisible ; un relevé faux ne l'est pas.*
   */
  private enregistrer(tables: RecensementParTable): void {
    const resume = Object.entries(tables)
      .map(([t, r]) => `${t} ${r.n}`)
      .join(' · ');
    this.systemActivity.record({
      category: 'RETENTION',
      action: ACTION_RECENSEMENT,
      status: 'SUCCESS',
      actor: SOURCE,
      target: resume,
      detail: 'Recensement quotidien des lignes conservees (TRK-035)',
      meta: { tables },
    });
  }

  private async dernierRecensement(): Promise<{ date: Date; tables: RecensementParTable } | null> {
    const ligne = await this.prisma.systemActivityLog.findFirst({
      where: { category: 'RETENTION', action: ACTION_RECENSEMENT },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, meta: true },
    });
    const tables = (ligne?.meta as { tables?: RecensementParTable } | null)?.tables;
    if (!ligne || !tables) return null;
    return { date: ligne.createdAt, tables };
  }

  /**
   * Ce que les purges ENREGISTRÉES revendiquent depuis le dernier recensement.
   *
   * ⚠️ On lit le compte-rendu que le ménage écrit lui-même (`logs_purged`), pas une
   * estimation. C'est ce qui permet de distinguer « la rétention a fait son travail » de
   * « quelqu'un est passé par la base » — et c'est précisément ce compte-rendu qui a
   * disculpé la rétention le 2026-08-19, en déclarant `errorDeleted: 0`.
   */
  private async purgesDepuis(depuis: Date): Promise<PurgesEnregistrees> {
    const lignes = await this.prisma.systemActivityLog.findMany({
      where: { category: 'RETENTION', action: 'logs_purged', createdAt: { gt: depuis } },
      select: { meta: true },
    });
    const total: PurgesEnregistrees = { error_logs: 0, alerts: 0 };
    for (const l of lignes) {
      const meta = l.meta as { errorDeleted?: number } | null;
      total['error_logs'] = (total['error_logs'] ?? 0) + (meta?.errorDeleted ?? 0);
    }
    // ⚠️ `alerts` reste à 0 : AUCUNE purge automatique ne les touche aujourd'hui. Le jour où
    // une rétention des alertes sera posée, elle devra revendiquer son compte ICI, sinon la
    // sonde la prendra pour une suppression manuelle — et elle aura raison de le faire.
    return total;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ── T34 / D5 (2026-09-13) — LA PAUSE DES AGENTS DU POSTE ─────────────────────────────────
 *
 * Pendant le plafond hebdomadaire de la CLI Claude (10 → 13/09), les agents du poste ont essayé
 * trente-six fois pour rien — un passage toutes les deux heures, chacun avec son contrôle de
 * session, sa ligne d'échec et, pour le courrier, une tentative consommée sur un travail qui ne
 * pouvait pas aboutir (sept travaux IA morts ainsi) — alors que la CLI annonçait l'heure de remise
 * à zéro dès la première réponse.
 *
 * Décision du propriétaire (D5) : « si ça échoue par exemple cinq heures d'affilée, on s'arrête ;
 * mais bien faire un mail, et une page pour tout redémarrer, dans l'admin de Tracky ». D'où :
 *
 *   - la pause vit EN BASE (`pauses_agents_locaux`), pas dans un fichier du poste : c'est ce qui
 *     permet au bouton « Reprendre maintenant » de /admin de la lever, et à la sentinelle de la
 *     notifier par courriel ;
 *   - un agent la LIT avant tout appel à la CLI (une requête SQL, aucun lancement) et sort aussitôt
 *     en disant pourquoi ; il la POSE lui-même à la première réponse « plafond », avec l'heure que
 *     la CLI annonce ; la sentinelle la pose après cinq heures d'échecs d'affilée, sans échéance ;
 *   - une pause périmée ne retient personne : le premier appel qui réussit — ou le contrôle
 *     horaire de la sentinelle — la lève pour de bon. Zéro risque de rester bloqué.
 *
 * Le poste écrit et lit cette table en SQL (`outils/pause-agents.cjs`) : les deux bords doivent
 * s'accorder sur les colonnes et sur la règle « active = ouverte ET (sans échéance OU à venir) ».
 */
export const CAUSES_PAUSE = ['plafond-hebdo', 'plafond-usage', 'echecs-consecutifs'] as const;
export type CausePause = (typeof CAUSES_PAUSE)[number];

/** Cinq heures d'échecs d'affilée des agents qui passent par la CLI : le chiffre du propriétaire. */
export const SEUIL_ECHECS_CONSECUTIFS_MS = 5 * 3_600_000;

/**
 * RAPPEL d'une pause qui DURE — 12 h.
 *
 * ┌─ CE QUE CE DÉLAI RÉPARE ──────────────────────────────────────────────────┐
 * │ `aNotifier()` ne rendait que les pauses jamais notifiées : une pause       │
 * │ prévenait UNE fois, le jour où elle était posée, puis se taisait pour      │
 * │ toujours. Mesuré le 23/09 sur la production : pause posée le 17/09 à      │
 * │ 08:50 (« 401 OAuth access token has expired »), notifiée à 08:50 — et      │
 * │ SIX JOURS de silence ensuite. Pendant ce temps : 1 357 récits de trajet    │
 * │ non écrits, 6 jugements d'agenda en attente, le rapport hebdomadaire       │
 * │ bloqué. Un seul courriel, le premier matin, pour une panne qui a duré      │
 * │ une semaine.                                                               │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 12 h et non 24 : deux rappels par jour (matin et soir) suffisent à ne pas laisser passer une
 * journée entière, sans transformer la sentinelle en réveil horaire. Une pause AVEC échéance
 * (plafond de la CLI, qui se lève seule) n'est jamais rappelée : elle a une fin connue, et la
 * rappeler apprendrait à ignorer le canal.
 */
export const RAPPEL_PAUSE_MS = 12 * 3_600_000;

export interface PauseAgents {
  id: string;
  poseeA: Date;
  cause: string;
  motif: string;
  poseePar: string;
  jusqua: Date | null;
  leveeA: Date | null;
  leveePar: string | null;
  notifieeA: Date | null;
}

const SELECTION = {
  id: true, poseeA: true, cause: true, motif: true, poseePar: true,
  jusqua: true, leveeA: true, leveePar: true, notifieeA: true,
} as const;

@Injectable()
export class PauseAgentsLocauxService {
  private readonly logger = new Logger(PauseAgentsLocauxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * La pause qui retient les agents en ce moment, ou `null`. Une ligne ouverte dont l'échéance
   * est passée n'en est pas une : elle attend seulement qu'on la ferme (`leverPerimees`).
   */
  async active(nowMs = Date.now()): Promise<PauseAgents | null> {
    const p = await this.prisma.pauseAgentsLocaux.findFirst({
      where: { leveeA: null },
      orderBy: { poseeA: 'desc' },
      select: SELECTION,
    });
    if (!p) return null;
    if (p.jusqua && p.jusqua.getTime() <= nowMs) return null;
    return p;
  }

  /** La ligne ouverte la plus récente, périmée ou non — ce que l'écran montre en attendant la levée. */
  async ouverte(): Promise<PauseAgents | null> {
    return this.prisma.pauseAgentsLocaux.findFirst({ where: { leveeA: null }, orderBy: { poseeA: 'desc' }, select: SELECTION });
  }

  /**
   * Pose une pause — sauf si une pause ACTIVE retient déjà les agents : on ne l'empile pas, on
   * rend `null`. Une cause hors de la liste est refusée : c'est elle que le poste, l'écran et le
   * courriel lisent, un libellé libre n'y aurait pas de sens.
   */
  async poser(
    p: { cause: CausePause; motif: string; poseePar: string; jusqua: Date | null },
    nowMs = Date.now(),
  ): Promise<PauseAgents | null> {
    if (!CAUSES_PAUSE.includes(p.cause)) throw new Error(`Pause des agents : cause inconnue « ${String(p.cause)} »`);
    if (await this.active(nowMs)) return null;
    const ligne = await this.prisma.pauseAgentsLocaux.create({
      data: { cause: p.cause, motif: p.motif.slice(0, 400), poseePar: p.poseePar, jusqua: p.jusqua, poseeA: new Date(nowMs) },
    });
    this.logger.warn(`Pause des agents du poste posée (${p.cause}, par ${p.poseePar}) — reprise ${p.jusqua ? p.jusqua.toISOString() : 'manuelle'}.`);
    return ligne as PauseAgents;
  }

  /** Lève TOUTES les lignes ouvertes — le bouton, ou un appel réussi. Rend le nombre fermé. */
  async lever(par: string, nowMs = Date.now()): Promise<number> {
    const { count } = await this.prisma.pauseAgentsLocaux.updateMany({
      where: { leveeA: null },
      data: { leveeA: new Date(nowMs), leveePar: par },
    });
    if (count > 0) this.logger.log(`Pause des agents du poste levée par ${par} (${count} ligne(s)).`);
    return count;
  }

  /** Ferme les lignes ouvertes dont l'échéance est passée, au nom de l'expiration. */
  async leverPerimees(nowMs = Date.now()): Promise<number> {
    const { count } = await this.prisma.pauseAgentsLocaux.updateMany({
      where: { leveeA: null, jusqua: { lte: new Date(nowMs) } },
      data: { leveeA: new Date(nowMs), leveePar: 'expiration' },
    });
    return count;
  }

  /**
   * Les pauses ouvertes à signaler — jamais notifiées, OU notifiées il y a plus de
   * {@link RAPPEL_PAUSE_MS} et SANS échéance (donc qui ne se lèveront pas toutes seules).
   *
   * ⚠️ Le rappel ne vise QUE les pauses sans `jusqua`. Une pause de plafond CLI porte l'heure de
   * remise à zéro annoncée par la CLI : elle se lève d'elle-même, la rappeler serait du bruit.
   * Une pause `echecs-consecutifs` n'a pas d'échéance — elle attend un geste humain, et c'est
   * exactement celle qui s'est tue six jours (cf. RAPPEL_PAUSE_MS).
   */
  async aNotifier(nowMs = Date.now()): Promise<PauseAgents[]> {
    const rappelAvant = new Date(nowMs - RAPPEL_PAUSE_MS);
    return this.prisma.pauseAgentsLocaux.findMany({
      where: {
        leveeA: null,
        OR: [{ notifieeA: null }, { jusqua: null, notifieeA: { lte: rappelAvant } }],
      },
      orderBy: { poseeA: 'asc' },
    });
  }

  async marquerNotifiee(id: string, nowMs = Date.now()): Promise<void> {
    await this.prisma.pauseAgentsLocaux.updateMany({ where: { id }, data: { notifieeA: new Date(nowMs) } });
  }
}

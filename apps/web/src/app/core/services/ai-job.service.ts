import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, signal } from '@angular/core';
import { apiErrorMessage } from '../error/api-error';

/**
 * Type d'opération IA suivie en arrière-plan (pour l'icône / le libellé de la pastille).
 *
 * ⚠️ Pas de `report` : aucun code n'en produisait, et l'agenda portait un `case 'report': break`
 * « à brancher quand la génération passera en async » (P2-7, audit du 22/09). Un type que rien
 * n'émet est une promesse écrite dans une union — on l'ajoutera avec son producteur, pas avant.
 */
export type AiJobKind = 'agent-run' | 'optimization' | 'capacity';
export type AiJobStatus = 'running' | 'done' | 'error';

/** Un travail IA lancé « en arrière-plan » : on ferme la modal et on suit son avancement via une pastille. */
export interface AiJob {
  id: string;
  kind: AiJobKind;
  /**
   * Société concernée (revue du 29/09). Super-admin : celle du bandeau AU LANCEMENT ; `null` pour
   * les autres rôles, qui n'en ont qu'une. Sans elle, une analyse lancée sur A s'affichait « en
   * cours » sur B dès qu'on changeait de société, et sa fin faisait relire l'analyse de B.
   */
  fleetId?: string | null;
  /** Titre court (ex. « Passage de l'agent — CDEF »). */
  title: string;
  /** Explication vulgarisée de CE QUE fait l'IA pendant le chargement (pour les non-experts). */
  hint: string;
  status: AiJobStatus;
  startedAt: number;
  finishedAt?: number;
  /** Résultat lisible affiché quand c'est prêt (ex. « 2 propositions à valider »). */
  resultText?: string;
  error?: string;
  /**
   * Vrai quand le serveur a REFUSÉ (403, 409, 429) plutôt qu'échoué : la pastille dit « Refusé »
   * et le motif. Un « Échec » sur un refus de quota faisait croire à une panne (revue du 29/09).
   */
  refused?: boolean;
  /** Résultat BRUT de la tâche (pour ré-afficher des résultats interactifs — ex. capacités à valider). */
  payload?: unknown;
}

/**
 * Motifs par défaut d'un REFUS, quand le serveur n'en écrit pas. L'appelant peut les préciser
 * (`run({ refus })`) : lui seul sait ce que « 429 » veut dire pour son geste.
 */
const REFUS_PAR_DEFAUT: Partial<Record<number, string>> = {
  403: 'Refusé : ce compte n\'a pas le droit de lancer ce travail pour cette société.',
  409: 'Refusé : l\'état a changé entre-temps. Rechargez la page puis réessayez.',
  429: 'Refusé : ce travail est déjà en cours, ou a déjà été fait récemment pour cette société.',
};

/**
 * Refonte agenda/IA — Suivi des opérations IA en ARRIÈRE-PLAN.
 *
 * Les actions IA de l'agenda (analyse de l'agent, optimisation, rapport…) étaient SYNCHRONES : la
 * modal restait bloquée sur un spinner et l'utilisateur ne savait pas ce qui se passait. Ici on
 * découple : on `run()` la tâche, on ferme la modal, et une PASTILLE en haut de l'agenda montre
 * « l'IA travaille… » (avec une explication claire) puis « résultats prêts » (cliquable pour les voir).
 * Purement front (signals) : les appels HTTP restent les mêmes, seul le suivi UX change.
 */
@Injectable({ providedIn: 'root' })
export class AiJobService {
  private readonly _jobs = signal<AiJob[]>([]);
  readonly jobs = this._jobs.asReadonly();
  /** true si au moins un job IA est en cours (pour animer discrètement l'entrée d'agenda). */
  readonly hasRunning = computed(() => this._jobs().some((j) => j.status === 'running'));
  private seq = 0;

  /**
   * true si un job de CE TYPE est déjà en cours. Sert de garde anti-double-lancement : depuis le
   * passage en asynchrone, la feuille se ferme AVANT que la tâche finisse et reste montée ~220 ms
   * (animation de sortie) → un double-tap sur « Lancer un passage » créerait 2 jobs (coût IA doublé).
   * L'appelant renonce si un même job tourne déjà.
   *
   * `fleetId` (revue du 29/09) restreint la garde à UNE société : `null` = les jobs sans société
   * (rôles à une seule flotte), omis = toutes. Le serveur tient ses gardes par société ; une garde
   * globale ici laissait le bouton de B cliquable mais muet pendant que A tournait.
   */
  hasRunningOf(kind: AiJobKind, fleetId?: string | null): boolean {
    return this._jobs().some(
      (j) => j.kind === kind && j.status === 'running' && (fleetId === undefined || (j.fleetId ?? null) === fleetId),
    );
  }

  /**
   * Lance une tâche IA en arrière-plan. Ajoute une pastille « en cours », attend la promesse, puis
   * bascule la pastille en « prêt » (avec un résumé + une action de consultation) ou « erreur ».
   * L'appelant ferme sa modal juste après (l'UX de suivi vit dans la pastille).
   */
  run<T>(opts: {
    kind: AiJobKind;
    title: string;
    hint: string;
    task: Promise<T>;
    /** Texte de résultat lisible (pour un non-expert) à partir de la réponse. */
    summarize: (result: T) => string;
    /** Société concernée (voir `AiJob.fleetId`). */
    fleetId?: string | null;
    /** Motif lisible d'un refus, par statut HTTP, quand le serveur n'en donne pas. */
    refus?: Partial<Record<number, string>>;
  }): string {
    const id = `aijob-${++this.seq}`;
    const job: AiJob = {
      id,
      kind: opts.kind,
      fleetId: opts.fleetId ?? null,
      title: opts.title,
      hint: opts.hint,
      status: 'running',
      startedAt: Date.now(),
    };
    this._jobs.update((list) => [job, ...list]);

    opts.task.then(
      (result) =>
        this.patch(id, {
          status: 'done',
          finishedAt: Date.now(),
          resultText: safe(() => opts.summarize(result)) ?? 'Terminé.',
          payload: result,
        }),
      (err) => {
        const status = err instanceof HttpErrorResponse ? err.status : 0;
        const refused = status === 403 || status === 409 || status === 429;
        const repli = (refused ? opts.refus?.[status] ?? REFUS_PAR_DEFAUT[status] : undefined) ?? 'Échec de l\'analyse IA.';
        this.patch(id, { status: 'error', finishedAt: Date.now(), error: apiErrorMessage(err, repli), refused });
      },
    );
    return id;
  }

  /** Retire une pastille (fermée par l'utilisateur, ou après consultation). */
  dismiss(id: string): void {
    this._jobs.update((list) => list.filter((j) => j.id !== id));
  }

  /** Retire toutes les pastilles terminées (prêtes ou en erreur). */
  clearFinished(): void {
    this._jobs.update((list) => list.filter((j) => j.status === 'running'));
  }

  private patch(id: string, p: Partial<AiJob>): void {
    this._jobs.update((list) => list.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

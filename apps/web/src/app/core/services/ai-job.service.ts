import { Injectable, computed, signal } from '@angular/core';
import { apiErrorMessage } from '../error/api-error';

/** Type d'opération IA suivie en arrière-plan (pour l'icône / le libellé de la pastille). */
export type AiJobKind = 'agent-run' | 'optimization' | 'capacity' | 'report';
export type AiJobStatus = 'running' | 'done' | 'error';

/** Un travail IA lancé « en arrière-plan » : on ferme la modal et on suit son avancement via une pastille. */
export interface AiJob {
  id: string;
  kind: AiJobKind;
  /** Titre court (ex. « Analyse de l'agenda — CDEF »). */
  title: string;
  /** Explication vulgarisée de CE QUE fait l'IA pendant le chargement (pour les non-experts). */
  hint: string;
  status: AiJobStatus;
  startedAt: number;
  finishedAt?: number;
  /** Résultat lisible affiché quand c'est prêt (ex. « 2 propositions à valider »). */
  resultText?: string;
  error?: string;
  /** Résultat BRUT de la tâche (pour ré-afficher des résultats interactifs — ex. capacités à valider). */
  payload?: unknown;
}

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
   * (animation de sortie) → un double-tap sur « Lancer l'analyse » créerait 2 jobs (coût IA doublé,
   * voire double placement automatique pour l'agent). L'appelant renonce si un même job tourne déjà.
   */
  hasRunningOf(kind: AiJobKind): boolean {
    return this._jobs().some((j) => j.kind === kind && j.status === 'running');
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
  }): string {
    const id = `aijob-${++this.seq}`;
    const job: AiJob = {
      id,
      kind: opts.kind,
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
      (err) => this.patch(id, { status: 'error', finishedAt: Date.now(), error: apiErrorMessage(err, 'Échec de l\'analyse IA.') }),
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

/**
 * Cadence de la file CUT. Le worker se réveille toutes les 10 s : on arrondit donc la valeur
 * configurée au créneau supérieur pour que la promesse affichée par l'UI soit exacte.
 */
const requestedIntervalMs = Number(process.env.SCHEDULE_CUT_QUEUE_INTERVAL_MS) || 10_000;
export const AUTOMATIC_CUT_QUEUE_INTERVAL_MS = Math.min(
  60_000,
  Math.max(10_000, Math.ceil(requestedIntervalMs / 10_000) * 10_000),
);

/**
 * Cadenceur déterministe et testable. Il ne contient aucune commande : il ouvre seulement
 * un créneau de départ au plus toutes les N secondes. La vérité durable reste le planning en DB.
 */
export class AutomaticCutQueueGate {
  private nextSlotAt = 0;

  constructor(private readonly intervalMs: number) {}

  tryAcquire(now = Date.now()): boolean {
    if (this.intervalMs <= 0) return true;
    if (now < this.nextSlotAt) return false;
    this.nextSlotAt = now + this.intervalMs;
    return true;
  }
}

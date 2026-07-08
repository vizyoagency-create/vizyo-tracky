import { getNowInTimezone } from '../vehicle-schedules/schedule-evaluator';

/**
 * Fuseau du serveur (les @Cron sans `timeZone` explicite tournent dessus — UTC en prod Docker).
 * Résolu une fois ; sert de fuseau par défaut pour le calcul du « prochain lancement ».
 */
export const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Prochain instant RÉEL (> earliest) où l'horloge murale dans `tz` satisfait `matcher`.
 *
 * On avance dans le temps réel et on reconvertit chaque instant candidat en heure locale
 * du fuseau (via getNowInTimezone) → DST et fuseaux gérés sans parser cron. Pas de 30 s,
 * horizon borné. Aligne le résultat au début de la minute (les crons tirent à la seconde 0).
 * Retourne null si aucune occurrence dans l'horizon (ex. tâche en pause).
 */
export function nextFireInstant(
  matcher: (wall: Date) => boolean,
  earliestMs: number,
  tz: string,
  nowMs: number = Date.now(),
  horizonDays = 8,
): Date | null {
  const start = Math.max(nowMs, earliestMs);
  const STEP = 30_000;
  const end = start + horizonDays * 86_400_000;
  for (let t = start + STEP; t <= end; t += STEP) {
    const wall = getNowInTimezone(tz, new Date(t));
    if (matcher(wall)) {
      // Ramener au début de la minute (les secondes s'écoulent à l'identique dans tout fuseau).
      return new Date(t - wall.getSeconds() * 1000 - wall.getMilliseconds());
    }
  }
  return null;
}

/**
 * Prochain tick d'un cron HAUTE FRÉQUENCE aligné sur l'époque (ex. « chaque minute »,
 * « toutes les 30 s », « minute paire à la 30e s »). `everyMs` = période, `offsetMs` =
 * décalage dans la période. Indépendant du fuseau (secondes/minutes = temps absolu).
 */
export function nextPeriodicTick(everyMs: number, offsetMs: number, nowMs: number = Date.now()): Date {
  const k = Math.floor((nowMs - offsetMs) / everyMs) + 1;
  return new Date(k * everyMs + offsetMs);
}

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

/**
 * DERNIER instant RÉEL (≤ nowMs) où l'horloge murale dans `tz` a satisfait `matcher` — le miroir
 * exact de `nextFireInstant`, pour répondre à « quand cet agent AURAIT DÛ tourner ? ».
 *
 * Né du PS du chantier C3 (2026-09-05) : la sentinelle des agents du poste compare le dernier
 * passage journalisé au dernier déclenchement PLANIFIÉ, et non à un multiple de cadence. Deux fois
 * la cadence de l'agent de récits, c'est 48 h : un PC éteint la nuit ne se serait vu que le
 * surlendemain, alors que le propriétaire veut le lire LE MATIN MÊME. Seul l'instant planifié
 * permet de dire « attendu à 03:15, rien depuis » à 05:50.
 *
 * Même mécanique que le calcul du prochain — pas de 30 s, reconversion en heure murale du fuseau
 * (DST et fuseaux gérés sans parser cron), horizon borné, résultat aligné au début de la minute —
 * pour que les deux instants se répondent : le passage attendu de 03:15 (Paris) est bien celui que
 * l'écran des traitements annonçait la veille comme « prochain ». `null` si aucune occurrence dans
 * l'horizon.
 */
export function previousFireInstant(
  matcher: (wall: Date) => boolean,
  nowMs: number = Date.now(),
  tz: string,
  horizonDays = 8,
): Date | null {
  const STEP = 30_000;
  const end = nowMs - horizonDays * 86_400_000;
  for (let t = nowMs; t >= end; t -= STEP) {
    const wall = getNowInTimezone(tz, new Date(t));
    if (matcher(wall)) {
      // Début de la minute : les secondes s'écoulent à l'identique dans tout fuseau, et les
      // millisecondes de `nowMs` n'ont rien à faire dans un instant planifié.
      return new Date(t - wall.getSeconds() * 1000 - (t % 1000));
    }
  }
  return null;
}

/**
 * DERNIER tick (≤ nowMs) d'un cron haute fréquence aligné sur l'époque — miroir de
 * `nextPeriodicTick`, même contrat (`everyMs` période, `offsetMs` décalage, indépendant du fuseau).
 * Par construction `previousPeriodicTick(...) ≤ nowMs < nextPeriodicTick(...)` et les deux sont
 * séparés d'exactement `everyMs`.
 */
export function previousPeriodicTick(everyMs: number, offsetMs: number, nowMs: number = Date.now()): Date {
  const k = Math.floor((nowMs - offsetMs) / everyMs);
  return new Date(k * everyMs + offsetMs);
}

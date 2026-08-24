export function nmeaToDecimal(value: string, hemisphere: 'N' | 'S' | 'E' | 'W'): number {
  const numeric = parseFloat(value);
  if (isNaN(numeric) || value.trim() === '') {
    throw new Error(`Invalid NMEA coordinate value: "${value}"`);
  }
  const degrees = Math.floor(numeric / 100);
  const minutes = numeric - degrees * 100;
  let decimal = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') decimal = -decimal;
  return decimal;
}

export function knotsToKph(knots: number): number {
  return Math.round(knots * 1.852 * 1000) / 1000;
}

/**
 * Intervalle MAXIMAL exprimable dans la trame TCP `,C,` de ce firmware : **99 s**.
 *
 * Ce n'est pas un choix de confort, c'est une limite matérielle mesurée — voir
 * `formatFrequency` juste en dessous. Toute cible plus lente doit être ramenée à cette
 * valeur PAR L'APPELANT (cf. `HARD_CAP_S` du fix-mode), pas ici : un plafonnement
 * silencieux ferait dire à l'interface « 10 minutes » pendant que la trame dit 99 s.
 */
export const TCP_MAX_FREQUENCY_S = 99;

/**
 * Fréquence du `,C,` TCP — **DEUX CHIFFRES, TOUJOURS EN SECONDES**.
 *
 * ══ TRK-045 (2026-08-24) — le firmware lit deux chiffres et JETTE la lettre d'unité ══
 *
 * Cette fonction imitait le `formatValue` de Traccar (`%02dh` / `%02dm` / `%02ds`). Sur
 * les Coban 403C/403D de ce parc, la forme en minutes est **interprétée en secondes** :
 * `05m` ne vaut pas 5 minutes, il vaut **5 secondes**. Le 2026-08-23, le correctif de
 * transport de [TRK-012](docs/centre-alerte/REFERENCE-ERREURS.md#trk-012) a rendu ces
 * trames effectives pour la première fois en quatre mois — et le débit de la flotte est
 * passé de 6 826 à 19 794 trames/heure en 21 heures, pour MOINS de positions stockées.
 *
 * Un seul modèle explique les quatre formes mesurées en production :
 *
 * | Envoyé   | Lu par le boîtier                        | Mesuré | Boîtiers |
 * |----------|------------------------------------------|--------|----------|
 * | `,C,20s;`| « 20 » → 20 s                            | 20 s   | 4        |
 * | `,C,30s;`| « 30 » → 30 s                            | 30 s   | 6        |
 * | `,C,05m;`| « 05 » → 5 s *(le `m` est jeté)*         | 4–6 s  | 28       |
 * | `,C,300s;`| « 30 » puis `0` au lieu de l'unité       | 60 s   | 1 canari |
 * |          | → échec d'analyse → défaut firmware 60 s |        |          |
 *
 * D'où les deux règles ci-dessous, et elles ne sont pas négociables :
 *
 * 1. **Toujours la lettre `s`.** Une unité que le destinataire ignore n'est pas une
 *    unité, c'est un piège : elle divise l'intervalle par 60 sans rien signaler.
 * 2. **Jamais plus de deux chiffres.** Un troisième casse l'analyse et le boîtier
 *    retombe sur son défaut — on obtiendrait 60 s en croyant demander 300 s.
 *
 * ⚠️ **On lève une erreur au-delà de 99 s, on ne plafonne pas.** Plafonner en silence
 * laisserait l'interface proposer « 10 minutes » et la trame partir à 99 s : on
 * échangerait un mensonge de 60× contre un mensonge de 6×. Le seul endroit qui connaisse
 * la limite du matériel est ici ; c'est donc ici qu'elle doit se faire entendre.
 */
export function formatFrequency(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(`Fréquence Coban invalide: ${seconds}s (entier >= 1 attendu)`);
  }
  if (seconds > TCP_MAX_FREQUENCY_S) {
    throw new Error(
      `Fréquence Coban non exprimable en TCP: ${seconds}s. Le firmware lit deux chiffres ` +
        `et ignore l'unité (TRK-045) — le maximum est ${TCP_MAX_FREQUENCY_S}s. ` +
        `Ramener la cible avant d'encoder, ne pas plafonner ici.`,
    );
  }
  return String(seconds).padStart(2, '0') + 's';
}

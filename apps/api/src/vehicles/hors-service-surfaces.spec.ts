import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ── LE GARDE QUI EMPÊCHE UN VÉHICULE HORS SERVICE DE RÉAPPARAÎTRE QUELQUE PART ───────
 *
 * Déclarer un véhicule accidenté ou débranché ne sert à rien si UNE seule surface l'oublie :
 * il suffit qu'elle le propose, le note ou l'alerte pour que le problème revienne — et il
 * reviendra en silence, parce que personne ne relit six services pour vérifier un filtre.
 *
 * Ce test fige donc la liste des surfaces concernées et exige que chacune porte le filtre.
 * Le retirer casse la construction. En ajouter une nouvelle sans filtre ne sera PAS détecté
 * — aucun test ne peut deviner l'intention d'un fichier futur — d'où la liste explicite
 * ci-dessous, qu'il faut compléter à la main : c'est le prix d'un contrôle honnête plutôt
 * que d'une promesse d'exhaustivité qu'on ne peut pas tenir.
 *
 * ── POURQUOI CES SURFACES-LÀ, ET PAS D'AUTRES ────────────────────────────────────────
 *
 * La règle : hors service = retiré de tout ce qui REGARDE DEVANT (proposer, noter, alerter,
 * rappeler) ; conservé dans tout ce qui REGARDE DERRIÈRE (historique, rapports, listes, carte).
 * Un véhicule accidenté garde ses trajets, ses positions et ses rapports — ce sont des faits.
 * Ce qu'on lui retire, c'est le droit d'être proposé demain et de peser sur les moyennes.
 */
const RACINE = join(__dirname, '..');

/** Surface → le motif qui prouve que le filtre y est posé. */
const SURFACES: Array<{ fichier: string; motif: RegExp; pourquoi: string }> = [
  {
    fichier: 'trip-analysis/trip-automation.service.ts',
    motif: /outOfServiceReason:\s*null/,
    pourquoi: 'analyse et recalcul des trajets — 843 trajets sans issue pour un seul accidenté',
  },
  {
    fichier: 'gps-integrity/gps-integrity.service.ts',
    motif: /vehicle:\s*\{\s*outOfServiceReason:\s*null\s*\}/,
    pourquoi: 'perte de GPS — conséquence de l’état déclaré, pas une anomalie',
  },
  {
    fichier: 'alerts/detection-accident.service.ts',
    motif: /vehicle:\s*\{\s*outOfServiceReason:\s*null\s*\}/,
    pourquoi: 'veille accident — annoncer un accident déjà connu',
  },
  {
    fichier: 'agenda/reservations.service.ts',
    motif: /outOfServiceReason:\s*null/,
    pourquoi: 'réservations — promettre une voiture qui est au garage',
  },
  {
    fichier: 'ai/ai-optimization.service.ts',
    motif: /outOfServiceReason:\s*null/,
    pourquoi: 'IA de placement — proposer un véhicule accidenté',
  },
  {
    fichier: 'agenda/maintenance-reminder.service.ts',
    motif: /vehicle:\s*\{\s*outOfServiceReason:\s*null\s*\}/,
    pourquoi: 'rappels d’entretien — une vidange sur un véhicule immobilisé',
  },
  {
    fichier: 'surveillance/surveillance-scheduler.service.ts',
    motif: /vehicle:\s*\{\s*outOfServiceReason:\s*null\s*\}/,
    pourquoi: 'surveillance nocturne — un véhicule au garage déclencherait à vide',
  },
  {
    fichier: 'agenda/fleet-insights.service.ts',
    motif: /outOfServiceReason:\s*null/,
    pourquoi: 'insights — 0 % d’utilisation en tête des « à mutualiser »',
  },
  {
    fichier: 'trip-analysis/driving-score.service.ts',
    // `!=` volontairement LÂCHE ici : le service utilise la forme non stricte, parce que
    // `!== null` est vrai pour `undefined` et aurait vidé le classement entier si le champ
    // manquait d'un `select`. Le motif accepte les deux écritures.
    motif: /outOfServiceReason\s*!==?\s*null/,
    pourquoi: 'score de conduite — une note figée qui pèse sur le rang et la moyenne',
  },
];

describe('Véhicule hors service — aucune surface ne l’oublie', () => {
  it.each(SURFACES)('⚠️ $fichier écarte les véhicules hors service ($pourquoi)', ({ fichier, motif }) => {
    const source = readFileSync(join(RACINE, fichier), 'utf8');
    expect(source).toMatch(motif);
  });

  it('la liste des surfaces reste substantielle — elle ne s’est pas vidée par accident', () => {
    // Garde-fou grossier : si quelqu'un vide la liste, les tests ci-dessus passeraient
    // tous en ne vérifiant plus rien.
    expect(SURFACES.length).toBeGreaterThanOrEqual(9);
  });
});

/**
 * ── L'AUTRE MOITIÉ DE LA RÈGLE : CE QUI DOIT RESTER VISIBLE ──────────────────────────
 *
 * Un état qui ferait DISPARAÎTRE le véhicule serait pire que le problème : on perdrait
 * l'accès à son historique au moment précis où on en a besoin (dossier d'assurance après
 * un accident). Ces surfaces ne doivent donc PAS filtrer.
 */
const SURFACES_QUI_GARDENT = [
  { fichier: 'vehicles/vehicles.service.ts', pourquoi: 'la fiche et les listes — sinon le véhicule devient introuvable' },
  { fichier: 'trips/trips.service.ts', pourquoi: 'l’historique des trajets — ce sont des faits' },
  { fichier: 'positions/position-history.service.ts', pourquoi: 'l’historique des positions' },
];

describe('… mais il ne DISPARAÎT nulle part', () => {
  it.each(SURFACES_QUI_GARDENT)('$fichier ne filtre PAS sur l’état ($pourquoi)', ({ fichier }) => {
    const source = readFileSync(join(RACINE, fichier), 'utf8');
    // `vehicles.service.ts` porte l'écriture de l'état (setOutOfService) : on vérifie
    // qu'il ne l'utilise pas comme FILTRE de lecture.
    expect(source).not.toMatch(/where:[^}]*outOfServiceReason:\s*null/);
  });
});

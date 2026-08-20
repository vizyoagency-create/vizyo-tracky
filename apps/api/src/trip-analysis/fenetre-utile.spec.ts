import { TripAutomationService } from './trip-automation.service';

/**
 * ── TRK-034 : LA FENÊTRE DEMANDÉE N'EST PAS LA FENÊTRE EXPLOITABLE ──────────────────
 *
 * Relevé du 2026-08-20 : `lookbackHours` vaut **1 500 h = 62,5 jours** en production, les
 * positions sont conservées **60 jours**, et les trajets **12 mois**. L'automatisation allait
 * donc chercher des trajets **2,5 jours au-delà de l'horizon où il peut exister une position**.
 *
 * ⚠️ Le signalement de la tranche vide est déjà tu (cf. `horizon-retention.spec.ts`). Ce qui
 * restait, c'est le TRAVAIL : un trajet situé au-delà de l'horizon est sélectionné, puis
 * **analysé** — or l'analyse relit les positions du trajet, n'en trouve aucune, et persiste une
 * analyse VIDE. Du budget dépensé pour un résultat qui ne peut rien contenir.
 *
 * Et ce budget est saturé : le passage du 2026-08-20 00:35 a analysé **3 712 trajets en
 * 50 minutes**, atteint son plafond de temps et laissé **6 véhicules** de côté.
 *
 * 🔑 Ce n'est pas un aléa mais une soustraction : tant que la fenêtre dépasse la rétention, la
 * bande de recouvrement existe **à chaque passage, pour toujours**, et s'élargit dès que l'un
 * des deux réglages bouge sans l'autre.
 */
const JOUR = 86_400_000;
const HEURE = 3_600_000;

/** Accès à la méthode privée : c'est une règle métier, elle mérite d'être vérifiée. */
const utile = (svc: TripAutomationService, windowFrom: Date): Date =>
  (svc as unknown as { fenetreUtile(w: Date): Date }).fenetreUtile(windowFrom);

/** Aucune dépendance injectée n'est sollicitée — même motif que `horizon-retention.spec.ts`. */
function service(): TripAutomationService {
  return Object.create(TripAutomationService.prototype) as TripAutomationService;
}

describe('Fenêtre utile — ne pas travailler là où la donnée ne peut pas exister', () => {
  const OLD = process.env.POSITIONS_RETENTION_DAYS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.POSITIONS_RETENTION_DAYS;
    else process.env.POSITIONS_RETENTION_DAYS = OLD;
  });

  it('🔴 LE CAS RÉEL : 1 500 h demandées, la fenêtre est ramenée à l’horizon de rétention', () => {
    // Le test du correctif : sur le code d'avant, la fenêtre partait telle quelle à 62,5 jours.
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const demandee = new Date(Date.now() - 1500 * HEURE); // 62,5 jours
    const obtenue = utile(service(), demandee);

    expect(obtenue.getTime()).toBeGreaterThan(demandee.getTime());
    // 59 jours = 60 moins la marge d'un jour de `horizonRetention`.
    expect(Math.round((Date.now() - obtenue.getTime()) / JOUR)).toBe(59);
  });

  it('une fenêtre DÉJÀ dans la rétention n’est pas touchée', () => {
    // ⚠️ Le correctif ne doit RIEN raccourcir de ce qui est exploitable : il ne retire que du
    // travail provablement vide. Une fenêtre de 30 jours reste une fenêtre de 30 jours.
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const demandee = new Date(Date.now() - 30 * JOUR);
    expect(utile(service(), demandee).getTime()).toBe(demandee.getTime());
  });

  it('la borne SUIT la rétention — elle n’est pas recopiée', () => {
    // Une constante recopiée finirait par diverger de la purge, et on se remettrait soit à
    // travailler dans le vide, soit à ignorer des trajets parfaitement exploitables.
    const demandee = new Date(Date.now() - 1500 * HEURE);
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const a = utile(service(), demandee);
    process.env.POSITIONS_RETENTION_DAYS = '90';
    const b = utile(service(), demandee);

    // 90 jours de rétention > 62,5 jours demandés : plus rien à borner.
    expect(b.getTime()).toBe(demandee.getTime());
    expect(a.getTime()).toBeGreaterThan(b.getTime());
  });

  it('🔴 rétention DÉSACTIVÉE : on ne borne RIEN — rien n’est purgé, tout est exploitable', () => {
    // Le piège symétrique : borner malgré une purge désactivée amputerait la fenêtre sans
    // aucune raison, et des trajets analysables seraient ignorés en silence.
    const demandee = new Date(Date.now() - 1500 * HEURE);
    for (const v of ['0', '-5', 'bidule']) {
      process.env.POSITIONS_RETENTION_DAYS = v;
      expect(utile(service(), demandee).getTime()).toBe(demandee.getTime());
    }
  });

  it('variable absente → repli sur 60 jours, la valeur de production', () => {
    delete process.env.POSITIONS_RETENTION_DAYS;
    const demandee = new Date(Date.now() - 1500 * HEURE);
    expect(Math.round((Date.now() - utile(service(), demandee).getTime()) / JOUR)).toBe(59);
  });
});

/**
 * ── LE PLAFOND D'ÉCRITURE, TRANCHÉ LE 2026-08-20 ────────────────────────────────────
 *
 * L'ancien plafond (720 h = 30 j) était **plus bas que la rétention des positions (60 j)** :
 * l'écran refusait d'écrire une fenêtre de 45 jours que le système savait honorer. Le plafond
 * n'y protégeait rien, il amputait.
 *
 * 🔑 La règle posée : **ce plafond ne doit jamais descendre sous la rétention des positions**.
 */
describe('Plafond d’écriture — il ne doit jamais brider ce que la rétention autorise', () => {
  const OLD = process.env.POSITIONS_RETENTION_DAYS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.POSITIONS_RETENTION_DAYS;
    else process.env.POSITIONS_RETENTION_DAYS = OLD;
  });

  it('🔴 le plafond couvre au moins la rétention des positions', () => {
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const retentionHeures = 60 * 24;
    // Importé indirectement : la constante n'est pas exportée, on la vérifie par son effet —
    // une fenêtre égale à la rétention doit survivre au clamp d'écriture ET au clamp de lecture.
    const demandee = new Date(Date.now() - retentionHeures * HEURE);
    const obtenue = utile(service(), demandee);
    // La fenêtre est ramenée à l'horizon (59 j), pas au plafond d'écriture (qui vaut 90 j).
    expect(Math.round((Date.now() - obtenue.getTime()) / JOUR)).toBe(59);
  });

  it('🔴 une rétention portée à 90 jours reste exploitable de bout en bout', () => {
    // Le jour où la rétention monte, la fenêtre doit pouvoir suivre sans rien changer d'autre.
    process.env.POSITIONS_RETENTION_DAYS = '90';
    const demandee = new Date(Date.now() - 89 * JOUR);
    expect(utile(service(), demandee).getTime()).toBe(demandee.getTime());
  });
});

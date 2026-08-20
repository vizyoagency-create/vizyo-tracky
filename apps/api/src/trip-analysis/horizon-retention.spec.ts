import { TripAutomationService } from './trip-automation.service';

/**
 * ── POURQUOI CE TEST EXISTE ──────────────────────────────────────────────────────────
 *
 * Le recalcul des trajets refuse — à raison — de supprimer une tranche qu'il ne saurait pas
 * reconstruire faute de positions, et il le signale bruyamment : « un blocage visible vaut
 * mieux qu'un historique détruit en silence ».
 *
 * Mais une tranche vide a DEUX causes, et elles n'ont rien à voir :
 *
 *   — au-delà de l'horizon de rétention, l'absence est ATTENDUE. La purge a fait son travail.
 *     Alerter là-dessus revient à signaler chaque jour que le passé est passé ;
 *   — en deçà, les positions devraient être là : c'est une vraie anomalie.
 *
 * Relevé du 2026-08-20 : en portant la fenêtre d'analyse à 1 500 h pour rattraper l'historique,
 * elle s'est mise à chevaucher la limite de rétention. Trois alertes en quatre heures sur
 * FZ-862-VY pour une tranche du 19 au 21 juin — vouées à se répéter à chaque passage,
 * indéfiniment, pour un fait sans remède.
 *
 * ⚠️ L'horizon est lu depuis LA MÊME variable que la purge. Une constante recopiée finirait par
 *    diverger, et on se remettrait à crier sur du normal — ou, bien pire, à se taire sur une
 *    vraie disparition de données.
 */
const JOUR = 86_400_000;

/** Accès à la méthode privée : c'est une règle métier, elle mérite d'être vérifiée. */
const horizon = (svc: TripAutomationService, now: number): number =>
  (svc as unknown as { horizonRetention(n?: number): number }).horizonRetention(now);

/**
 * `horizonRetention` ne lit que l'environnement : aucune dépendance injectée n'est sollicitée.
 * On instancie donc sans câbler les services, ce qui garde le test insensible aux futurs ajouts
 * de dépendances dans le constructeur.
 */
function service(): TripAutomationService {
  return Object.create(TripAutomationService.prototype) as TripAutomationService;
}

describe('Horizon de rétention — séparer l’attendu de l’anomalie', () => {
  const OLD = process.env.POSITIONS_RETENTION_DAYS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.POSITIONS_RETENTION_DAYS;
    else process.env.POSITIONS_RETENTION_DAYS = OLD;
  });

  it('⚠️ suit la variable de la PURGE, pas une valeur recopiée', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const a = horizon(service(), now);
    process.env.POSITIONS_RETENTION_DAYS = '30';
    const b = horizon(service(), now);
    expect(b).toBeGreaterThan(a); // 30 jours => horizon plus recent que 60
    expect(Math.round((now - a) / JOUR)).toBe(59); // 60 jours moins la marge d'un jour
    expect(Math.round((now - b) / JOUR)).toBe(29);
  });

  it('⚠️ LE CAS RÉEL : une tranche de juin, purgée, tombe SOUS l’horizon → pas d’alerte', () => {
    // FZ-862-VY, tranche du 19 au 21 juin, constatee le 20 aout avec 60 jours de retention.
    const now = Date.UTC(2026, 7, 20, 3, 46, 0);
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const tranche = Date.UTC(2026, 5, 19, 6, 16, 22);
    expect(tranche).toBeLessThan(horizon(service(), now));
  });

  it('⚠️ une tranche RÉCENTE sans positions reste une anomalie, et doit alerter', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const hier = now - JOUR;
    expect(hier).toBeGreaterThan(horizon(service(), now));
  });

  it('la marge d’un jour absorbe l’écart entre l’heure de purge et celle du passage', () => {
    // Une tranche pile a 60 jours ne doit pas basculer d'un cote a l'autre selon l'heure.
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    process.env.POSITIONS_RETENTION_DAYS = '60';
    const pileALaLimite = now - 60 * JOUR;
    expect(pileALaLimite).toBeLessThan(horizon(service(), now)); // classe comme purge : silence
  });

  it('⚠️ rétention DÉSACTIVÉE : rien n’est purgé, donc toute absence redevient une anomalie', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    for (const v of ['0', '-5', 'bidule']) {
      process.env.POSITIONS_RETENTION_DAYS = v;
      // Horizon a 0 => toute date est >= 0 => on alerte partout. C'est le bon defaut : sans
      // purge, une position manquante n'a aucune excuse.
      expect(horizon(service(), now)).toBe(0);
    }
  });

  it('variable absente → repli sur 60 jours, la valeur de production', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    delete process.env.POSITIONS_RETENTION_DAYS;
    expect(Math.round((now - horizon(service(), now)) / JOUR)).toBe(59);
  });
});

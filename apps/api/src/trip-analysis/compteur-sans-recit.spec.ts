import { TripAutomationService, fenetreRecitHeures, libelleResteRecit } from './trip-automation.service';

/**
 * Le compteur « trajets encore sans récit » doit annoncer LE TRAVAIL QUE L'AGENT FERA.
 *
 * ── LE BUG QUE CES TESTS VERROUILLENT ─────────────────────────────────────────────────
 *
 * Les récits ne sont pas écrits par l'API mais par `outils/agent-recit-trajet.cjs`, sur un poste.
 * Cet agent choisit ses trajets avec trois clauses (`narrative IS NULL`, `segmentationSource =
 * 'recompute'`, `startedAt` dans sa fenêtre) et deux jointures (véhicule, société). Le compteur
 * de l'écran, lui, comptait « les analyses sans récit sur trajets recalculés » — sans fenêtre,
 * et rattachées à la colonne dénormalisée `trip_analyses."fleetId"`.
 *
 * Deux nombres pour la même question, donc, et aucun des deux n'était celui de l'agent : au
 * 2026-09-02 l'écran des tâches annonçait « 132 récit(s) encore à écrire » pendant que celui de
 * l'automatisation affichait 0 partout. Un reste-à-faire qu'on ne peut pas confronter au travail
 * réel ne pilote plus rien : il fait accuser l'agent d'un retard imaginaire, ou taire le vrai.
 *
 * ── CE QUE LES TESTS FIXENT (des PROPRIÉTÉS, pas des nombres magiques) ────────────────
 *
 * On lit le SQL réellement envoyé et ses paramètres. Un test qui se contenterait du nombre
 * renvoyé par un mock ne dirait rien : c'est la DÉFINITION du compteur qui doit être verrouillée,
 * clause par clause, contre la prochaine « petite simplification » de la requête.
 */
describe('TripAutomationService — compteur « encore sans récit »', () => {
  const HEURE = 3_600_000;

  /** Une ligne par société, comme la vraie requête la renvoie. */
  function ligne(over: Record<string, unknown> = {}) {
    return {
      fleetId: 'f1', fleetName: 'A2R', aiEnabled: false,
      sansAnalyse: 0, sansRecit: 0, sansRecitBruts: 0, figes: 0,
      ...over,
    };
  }

  function build(rows: Record<string, unknown>[] = [ligne()]) {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    const svc = new TripAutomationService(
      prisma as never,
      { recompute: jest.fn() } as never,
      { analyze: jest.fn() } as never,
      { narrate: jest.fn() } as never,
      { isEnabledForFleet: jest.fn() } as never,
      { record: jest.fn() } as never,
      { record: jest.fn() } as never,
    );
    return { svc, prisma };
  }

  /**
   * Le SQL envoyé, paramètres remplacés par des marqueurs `$0`, `$1`… : c'est la seule façon de
   * vérifier QUELLE borne atterrit dans QUEL compteur (l'horizon de rétention ne doit pas
   * s'égarer dans le compteur de récits, cf. dernier test).
   */
  function sqlEnvoye(prisma: { $queryRaw: jest.Mock }): { sql: string; valeurs: unknown[] } {
    const appel = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const [morceaux, ...valeurs] = appel;
    const sql = morceaux.reduce((acc, m, i) => acc + (i > 0 ? '$' + String(i - 1) : '') + m, '');
    return { sql, valeurs };
  }

  /** Le sous-SELECT qui alimente une colonne donnée, isolé de ses voisins. */
  function bloc(sql: string, alias: string): string {
    const fin = sql.indexOf('::int AS "' + alias + '"');
    expect(fin).toBeGreaterThan(0);
    const avant = sql.slice(0, fin);
    return avant.slice(avant.lastIndexOf('(SELECT count(*)'));
  }

  let fenetre: string | undefined;
  let retention: string | undefined;
  beforeEach(() => {
    fenetre = process.env.NARRATION_WINDOW_HOURS;
    retention = process.env.POSITIONS_RETENTION_DAYS;
    delete process.env.NARRATION_WINDOW_HOURS;
    process.env.POSITIONS_RETENTION_DAYS = '60';
  });
  afterEach(() => {
    if (fenetre === undefined) delete process.env.NARRATION_WINDOW_HOURS;
    else process.env.NARRATION_WINDOW_HOURS = fenetre;
    if (retention === undefined) delete process.env.POSITIONS_RETENTION_DAYS;
    else process.env.POSITIONS_RETENTION_DAYS = retention;
  });

  it('reprend les TROIS clauses de l\'agent : pas de récit, trajet recalculé, trajet dans la fenêtre', async () => {
    const { svc, prisma } = build();
    const avant = Date.now();
    await svc.backlog();

    const { sql, valeurs } = sqlEnvoye(prisma);
    const compteur = bloc(sql, 'sansRecit');

    expect(compteur).toContain('a.narrative IS NULL');
    expect(compteur).toContain(`t."segmentationSource" = 'recompute'`);
    // La borne porte sur la date du TRAJET, jamais sur celle de la ligne d'analyse : le rattrapage
    // de l'analyse déterministe rafraîchit `trip_analyses."updatedAt"` sur des milliers de vieux
    // trajets, filtrer dessus ramènerait tout l'historique (4 761 candidats au lieu de 234).
    expect(compteur).toMatch(/t\."startedAt" > \$\d/);

    const marqueur = Number(/t\."startedAt" > \$(\d)/.exec(compteur)![1]);
    const depuis = valeurs[marqueur] as Date;
    expect(depuis).toBeInstanceOf(Date);
    const heures = (avant - depuis.getTime()) / HEURE;
    // 9 000 h : la fenêtre de la tâche planifiée qui couvre l'historique (rattrapage-recits.cmd),
    // pas les 48 h du passage de nuit — les deux tournent, le reste-à-faire est leur union.
    expect(heures).toBeGreaterThan(8_999);
    expect(heures).toBeLessThan(9_001);
  });

  it('⚠️ compte les sociétés dont l\'option IA est COUPÉE — elle gouverne la lecture, pas la rédaction', async () => {
    // Décision du 2026-09-02 : l'agent narre toutes les sociétés ; le masquage se joue à la
    // lecture, dans l'API. Le filtre `aiEnabled = true` avait laissé 5 128 analyses sans récit
    // chez les sociétés à option coupée — invisibles ici, et jamais reprises là-bas.
    const { svc, prisma } = build([ligne({ aiEnabled: false, sansRecit: 132 })]);
    const res = await svc.backlog();

    const compteur = bloc(sqlEnvoye(prisma).sql, 'sansRecit');
    expect(compteur).not.toContain('aiEnabled');
    expect(res.fleets[0].sansRecit).toBe(132);
    expect(res.fleets[0].aiEnabled).toBe(false);
  });

  it('rattache la société au VÉHICULE, comme l\'agent — pas à la colonne dénormalisée de l\'analyse', async () => {
    // L'agent passe par `vehicles` puis `fleets`. Une analyse dont le véhicule a changé de société
    // (ou n'existe plus) serait comptée ici et jamais reprise là-bas : un reste-à-faire immortel.
    const { svc, prisma } = build();
    await svc.backlog();

    const compteur = bloc(sqlEnvoye(prisma).sql, 'sansRecit');
    expect(compteur).toContain('JOIN vehicles v ON v.id = a."vehicleId"');
    expect(compteur).toContain('v."fleetId" = f.id');
    expect(compteur).not.toContain('a."fleetId" = f.id');
  });

  it('⚠️ n\'applique PAS le plancher de rétention des positions au récit (il ne relit aucune position)', async () => {
    // `horizonRetention()` borne ce qui est encore ANALYSABLE : l'analyse relit les positions,
    // purgées à 60 jours. Narrer ne lit que la ligne d'analyse. Appliquer ce plancher au récit
    // effacerait du travail bien réel : au 2026-09-02, 552 analyses de « mh cars » et 205 d'A2R,
    // toutes au-delà de 62 jours, que le rattrapage a précisément pour mission de reprendre.
    const { svc, prisma } = build();
    await svc.backlog();

    const { sql, valeurs } = sqlEnvoye(prisma);
    // Le paramètre 0 est l'horizon ; il n'apparaît que dans le compteur « sans analyse ».
    const horizon = valeurs[0] as Date;
    expect((Date.now() - horizon.getTime()) / HEURE).toBeGreaterThan(58 * 24);
    expect(bloc(sql, 'sansAnalyse')).toContain('$0');
    expect(bloc(sql, 'sansRecit')).not.toContain('$0');
    expect(bloc(sql, 'sansRecitBruts')).not.toContain('$0');
  });

  it('les trajets encore BRUTS subissent la même fenêtre, et restent comptés à part', async () => {
    // Hors fenêtre, ni le recalcul ni le récit ne viendront : les afficher comme « à faire »
    // ferait attendre un travail qui n'arrivera pas. Et on ne les ADDITIONNE pas au reste de
    // l'agent : tant que le recalcul serveur n'est pas passé, ce n'est pas son retard.
    const { svc, prisma } = build([
      ligne({ fleetId: 'f1', sansRecit: 12, sansRecitBruts: 40 }),
      ligne({ fleetId: 'f2', fleetName: 'mh cars', aiEnabled: true, sansRecit: 5, sansRecitBruts: 3 }),
    ]);
    const total = await svc.resteRecitTotal();

    const bruts = bloc(sqlEnvoye(prisma).sql, 'sansRecitBruts');
    expect(bruts).toMatch(/t\."startedAt" > \$\d/);
    expect(bruts).toContain(`t."segmentationSource" <> 'recompute'`);
    expect(total.aNarrer).toBe(17);
    expect(total.enAttenteDeRecalcul).toBe(43);
  });

  it('le nombre voyage avec sa définition : une phrase qui dit ce qui est compté', async () => {
    // Un nombre sans définition se fait interpréter — « 132 récits à écrire » a déjà été lu comme
    // « l'agent est en panne » alors qu'il n'avait rien à prendre.
    const { svc } = build();
    const { libelle } = await svc.resteRecitTotal();

    expect(libelle).toContain('recalculé');
    expect(libelle).toContain('375 j');
    expect(libelle).toContain('toutes sociétés');
  });

  it('la fenêtre suit la tâche planifiée (NARRATION_WINDOW_HOURS), et ignore une valeur absurde', async () => {
    // Si le poste repasse la tâche à 48 h, l'écran doit pouvoir recoller sans redéploiement.
    process.env.NARRATION_WINDOW_HOURS = '48';
    expect(fenetreRecitHeures()).toBe(48);
    expect(libelleResteRecit()).toContain('2 j');

    const { svc, prisma } = build();
    const avant = Date.now();
    await svc.backlog();
    const { sql, valeurs } = sqlEnvoye(prisma);
    const marqueur = Number(/t\."startedAt" > \$(\d)/.exec(bloc(sql, 'sansRecit'))![1]);
    const heures = (avant - (valeurs[marqueur] as Date).getTime()) / HEURE;
    expect(heures).toBeGreaterThan(47.9);
    expect(heures).toBeLessThan(48.1);

    // Réglage cassé : on retombe sur le défaut plutôt que sur un compteur muet à zéro.
    process.env.NARRATION_WINDOW_HOURS = 'zéro';
    expect(fenetreRecitHeures()).toBe(9000);
    process.env.NARRATION_WINDOW_HOURS = '0';
    expect(fenetreRecitHeures()).toBe(9000);
  });
});

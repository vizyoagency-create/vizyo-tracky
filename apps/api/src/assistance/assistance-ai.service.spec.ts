import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { AssistanceAiService } from './assistance-ai.service';

/**
 * Assistance IA — le moteur de réponse.
 *
 * Ce qui est verrouillé ici n'est pas la qualité de la rédaction (elle dépend du modèle) mais les
 * DÉCISIONS du service : quand il appelle, quand il refuse d'appeler, ce qu'il journalise, et ce
 * qu'il renvoie quand tout va mal. Une assistance qui tombe en panne bruyamment est pire
 * qu'aucune assistance : la personne avait déjà un problème.
 */
describe('AssistanceAiService', () => {
  const USAGE = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 };

  function build(opts: {
    classement?: Record<string, unknown>;
    redaction?: Record<string, unknown>;
    echecClassement?: boolean;
    echecRedaction?: boolean;
    configure?: boolean;
    lots?: Array<{ key: string; libelle: string; data: unknown; volume: number; refus?: string }>;
  } = {}) {
    const classement = {
      sujets: ['trajets'], contexte: ['erreurs'], horsSujet: false, urgence: false, titre: 'Trajet coupe en deux',
      ...opts.classement,
    };
    const redaction = {
      reponse: 'Votre trajet a ete coupe parce que le contact a ete remis.', escalade: false, gravite: 'LOW',
      ...opts.redaction,
    };
    let appel = 0;
    const ai = {
      isConfigured: jest.fn().mockReturnValue(opts.configure ?? true),
      completeJson: jest.fn().mockImplementation(() => {
        appel++;
        if (appel === 1) {
          if (opts.echecClassement) return Promise.reject(new Error('moteur indisponible'));
          return Promise.resolve({ result: classement, usage: USAGE, model: 'm-test', provider: 'claude', latencyMs: 300 });
        }
        if (opts.echecRedaction) return Promise.reject(new Error('moteur indisponible'));
        return Promise.resolve({ result: redaction, usage: USAGE, model: 'm-test', provider: 'claude', latencyMs: 900 });
      }),
    };
    const aiUsage = {
      costOf: jest.fn().mockReturnValue(0.002),
      record: jest.fn().mockResolvedValue(undefined),
    };
    const contexte = {
      build: jest.fn().mockResolvedValue(
        opts.lots ?? [{ key: 'erreurs', libelle: 'Les erreurs subies', data: [], volume: 0 }],
      ),
    };
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new AssistanceAiService(ai as never, aiUsage as never, contexte as never, errorLogger as never);
    const user: AuthUser = {
      id: 'u1', authUserId: 'a1', email: 'u@x.fr', firstName: null, lastName: null,
      role: UserRole.FLEET_MANAGER, isOwner: false, fleetId: 'f1', isActive: true, permissions: null,
    };
    return { svc, ai, aiUsage, contexte, errorLogger, user };
  }

  // ─── Le chemin normal ──────────────────────────────────────────────────────

  it('classe, lit le contexte, puis rédige — deux appels, pas plus', async () => {
    const { svc, ai, contexte, user } = build();
    const r = await svc.repondre(user, 'Pourquoi mon trajet est coupe en deux ?');
    // Le coût d'une question est BORNÉ à deux appels : c'est la contrepartie du choix « deux
    // étapes » plutôt qu'une boucle d'outils de longueur inconnue.
    expect(ai.completeJson).toHaveBeenCalledTimes(2);
    expect(contexte.build).toHaveBeenCalledWith(user, ['erreurs']);
    expect(r.reponse).toContain('contact');
    expect(r.sansIa).toBe(false);
    expect(r.titre).toBe('Trajet coupe en deux');
  });

  it('journalise les DEUX appels dans les coûts IA, en exécutant `api`', async () => {
    const { svc, aiUsage, user } = build();
    await svc.repondre(user, 'question');
    expect(aiUsage.record).toHaveBeenCalledTimes(2);
    for (const call of aiUsage.record.mock.calls) {
      // Sans ces deux champs, l'assistance serait le seul poste de dépense invisible de
      // l'application — exactement l'inverse du chantier `executor`.
      expect(call[0]).toMatchObject({ action: 'support_chat', executor: 'api', userId: 'u1', fleetId: 'f1' });
    }
  });

  it('remonte l\'audit de ce qui a été lu, sans les données elles-mêmes', async () => {
    const { svc, user } = build({
      lots: [
        { key: 'erreurs', libelle: 'Les erreurs subies', data: [{ message: 'secret' }], volume: 1 },
        { key: 'trajets', libelle: 'Ses trajets', data: null, volume: 0, refus: 'Pas le droit.' },
      ],
    });
    const r = await svc.repondre(user, 'question');
    expect(r.contextUsed).toEqual([
      { key: 'erreurs', volume: 1, refuse: false },
      { key: 'trajets', volume: 0, refuse: true },
    ]);
    // L'audit note QUOI a été lu et COMBIEN, jamais le contenu : dupliquer la donnée hors de sa
    // table d'origine créerait une seconde copie à protéger.
    expect(JSON.stringify(r.contextUsed)).not.toContain('secret');
  });

  // ─── Urgence : on n'appelle pas le rédacteur ───────────────────────────────

  it('sur une urgence, ne fait PAS rédiger et pousse vers l\'humain', async () => {
    const { svc, ai, contexte, user } = build({ classement: { urgence: true, titre: 'Vol en cours' } });
    const r = await svc.repondre(user, 'on me vole le camion la tout de suite');
    // Générer trois phrases empathiques prend des secondes pendant lesquelles personne n'est
    // prévenu — et le texte pourrait laisser croire qu'une action a été déclenchée.
    expect(ai.completeJson).toHaveBeenCalledTimes(1);
    expect(contexte.build).not.toHaveBeenCalled();
    expect(r.escalade).toBe(true);
    expect(r.gravite).toBe('CRITICAL');
    expect(r.reponse).toMatch(/rappel urgent/i);
  });

  it('sur une question hors sujet, ne lit AUCUNE donnée du demandeur', async () => {
    const { svc, contexte, user } = build({ classement: { horsSujet: true, contexte: ['erreurs', 'trajets'] } });
    await svc.repondre(user, 'raconte moi une blague');
    // On recadre, on ne fouille pas : une question hors sujet ne justifie aucune lecture.
    expect(contexte.build).not.toHaveBeenCalled();
  });

  // ─── Pannes : jamais d'exception ───────────────────────────────────────────

  it('classement en échec : message honnête, escalade, aucune exception', async () => {
    const { svc, errorLogger, user } = build({ echecClassement: true });
    const r = await svc.repondre(user, 'question');
    expect(r.sansIa).toBe(true);
    expect(r.escalade).toBe(true);
    expect(r.costUsd).toBe(0);
    expect(errorLogger.record).toHaveBeenCalled();
  });

  it('rédaction en échec : le coût DÉJÀ engagé au classement est tout de même remonté', async () => {
    const { svc, user } = build({ echecRedaction: true });
    const r = await svc.repondre(user, 'question');
    expect(r.escalade).toBe(true);
    // Le premier appel a été facturé. L'oublier rendrait la facture inexplicable : on verrait des
    // lignes dans les coûts IA sans conversation correspondante.
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.titre).toBe('Trajet coupe en deux');
  });

  it('moteur non configuré : aucun appel, message d\'indisponibilité', async () => {
    const { svc, ai, user } = build({ configure: false });
    const r = await svc.repondre(user, 'question');
    expect(ai.completeJson).not.toHaveBeenCalled();
    expect(r.sansIa).toBe(true);
  });

  it('message vide : on ne dépense rien', async () => {
    const { svc, ai, user } = build();
    const r = await svc.repondre(user, '   ');
    expect(ai.completeJson).not.toHaveBeenCalled();
    expect(r.sansIa).toBe(true);
  });

  // ─── Le schéma garantit la forme, pas le sens ──────────────────────────────

  it('une réponse VIDE bascule en escalade au lieu d\'afficher un blanc', async () => {
    const { svc, user } = build({ redaction: { reponse: '   ' } });
    const r = await svc.repondre(user, 'question');
    expect(r.reponse.length).toBeGreaterThan(20);
    expect(r.escalade).toBe(true);
  });

  it('une gravité inconnue retombe sur MEDIUM, jamais sur LOW', async () => {
    const { svc, user } = build({ redaction: { gravite: 'PEUT-ETRE' } });
    const r = await svc.repondre(user, 'question');
    // Un défaut « anodin » sur une valeur qu'on n'a pas comprise ferait passer sous le radar
    // exactement ce qu'on cherche à voir remonter.
    expect(r.gravite).toBe('MEDIUM');
  });

  it('les clés inventées par le modèle sont bornées et écartées', async () => {
    const { svc, contexte, user } = build({
      classement: { sujets: ['a', 'b', 'c', 'd', 'e'], contexte: ['x', 'y', 'z', 'w', 'v', 'u', 't'] },
    });
    const r = await svc.repondre(user, 'question');
    // Bornage au passage (3 sujets, 5 lots), puis élimination par les listes fermées en aval.
    expect(contexte.build.mock.calls[0][1]).toHaveLength(5);
    expect(r.sujets).toEqual([]); // aucun de ces sujets n'existe
  });

  it('une réponse trop longue est coupée (le prompt demande 2-4 phrases, ceci est le filet)', async () => {
    const { svc, user } = build({ redaction: { reponse: 'x'.repeat(9000) } });
    const r = await svc.repondre(user, 'question');
    expect(r.reponse.length).toBeLessThanOrEqual(1200);
  });

  it('ne repasse au modèle que les derniers messages de l\'historique', async () => {
    const { svc, ai, user } = build();
    const historique = Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` }));
    await svc.repondre(user, 'question', historique);
    const payload = ai.completeJson.mock.calls[0][0].userPayload as { historique: unknown[] };
    expect(payload.historique).toHaveLength(6);
  });
});

import type { AiErrorKind, AiProviderMode } from './ai-client.types';
import { AiServiceError, REPLI_KINDS } from './ai-client.types';
import { AiRouter, estimerJetonsEntree } from './ai-router.service';

/**
 * LE PLAFOND MENSUEL DE DÉPENSE IA — appliqué au POINT D'ENTRÉE UNIQUE.
 *
 * ── Le défaut (audit du 2026-08-03) ─────────────────────────────────────────────────
 * La règle vivait dans `PlaceAnalysisService`, **un seul des huit points d'appel IA**.
 * L'administrateur fixait 10 €, voyait la barre rouge et le badge « Dépassé » — et seules
 * les analyses de lieux s'arrêtaient. Le cron horaire de récits de trajets, l'agent
 * d'agenda, le rapport d'activité, l'optimiseur et la saisie vocale continuaient
 * d'appeler le modèle, et de facturer.
 *
 * **Un plafond qui ne plafonne pas est pire qu'aucun plafond** : il donne une fausse
 * assurance, donc on ne surveille plus.
 *
 * `AiRouter` se déclare « point d'entrée UNIQUE de tous les appels IA ». C'est le
 * seul endroit où la règle ne peut pas être oubliée par un futur appelant — et c'est donc
 * là qu'elle doit être testée, pas seulement chez ses consommateurs.
 *
 * ── C3 point 1 (2026-09-05) — le repli ───────────────────────────────────────────────
 * Le même point d'entrée unique est celui où le routeur BASCULE sur un autre moteur quand
 * le premier refuse. Le monde simulé ci-dessous a donc gagné un second moteur, un centre
 * d'alerte et un refroidissement ; les jeux d'essai du plafond, eux, sont inchangés.
 */

/** Réponse nominale de chaque moteur simulé — le `provider` est ce que l'appelant lit. */
const OK_CLAUDE = { result: { ok: true }, model: 'm', provider: 'claude', usage: {}, latencyMs: 1 };
const OK_GPT = { result: { ok: true }, model: 'gpt-4.1', provider: 'gpt', usage: {}, latencyMs: 1 };

interface Monde {
  /** Mode réglé dans « Coûts IA ». Défaut `claude`. */
  mode?: AiProviderMode;
  /** Clé Anthropic présente. Défaut vrai. */
  anthropicConfigure?: boolean;
  /** Clé OpenAI présente. Défaut FAUX : les jeux d'essai du plafond n'ont qu'un moteur. */
  openaiConfigure?: boolean;
  /** Réponses successives du refroidissement (`tenterEmission`). Défaut : toujours « émets ». */
  emissions?: boolean[];
  /** Routeur construit à quatre dépendances, comme avant C3 : ni centre d'alerte ni refroidissement. */
  sansObservabilite?: boolean;
}

function build(exhausted = false, monde: Monde = {}) {
  const completeJson = jest.fn().mockResolvedValue({ ...OK_CLAUDE });
  // `modelFor` : le modèle qui SERAIT employé — ce que la ligne d'échec chiffre quand rien n'a répondu (C3 point 5).
  const anthropic = { isConfigured: () => monde.anthropicConfigure ?? true, completeJson, modelFor: jest.fn(() => 'claude-sonnet-5') };
  const openai = { isConfigured: () => monde.openaiConfigure ?? false, completeJson: jest.fn().mockResolvedValue({ ...OK_GPT }), modelFor: jest.fn(() => 'gpt-4.1') };
  const settings = { current: jest.fn().mockResolvedValue(monde.mode ?? 'claude') };
  const usage = { monthBudgetExhausted: jest.fn().mockResolvedValue(exhausted), recordFailure: jest.fn().mockResolvedValue(undefined) };
  const errorLogger = { record: jest.fn().mockResolvedValue('log-1') };
  const emissions = [...(monde.emissions ?? [])];
  const refroidissement = {
    tenterEmission: jest.fn(async (_cle: string, _fenetreMs: number) => (emissions.length > 0 ? emissions.shift()! : true)),
  };
  const svc = monde.sansObservabilite
    ? new AiRouter(anthropic as never, openai as never, settings as never, usage as never)
    : new AiRouter(anthropic as never, openai as never, settings as never, usage as never, errorLogger as never, refroidissement as never);
  return { svc, completeJson, anthropic, openai, usage, settings, errorLogger, refroidissement };
}

const REQ = { system: 's', userPayload: {}, schema: {}, maxTokens: 10 } as never;

/** Un échec typé, tel que les clients le lèvent. `detail` = motif brut du fournisseur (TRK-061). */
const refus = (kind: AiErrorKind, detail?: string) => new AiServiceError(kind, `échec ${kind}`, detail);

/**
 * Fige `Date.now()` : la quarantaine et le refroidissement suivent l'horloge, sans vrais délais.
 * Un espion sur `Date.now` plutôt que les faux minuteurs de Jest : rien d'autre n'est touché.
 */
const T0 = Date.parse('2026-09-05T08:00:00.000Z');
function figerHorloge() {
  const espion = jest.spyOn(Date, 'now').mockReturnValue(T0);
  return {
    avancer: (ms: number) => { espion.mockReturnValue(T0 + ms); },
    rendre: () => { espion.mockRestore(); },
  };
}

describe('AiRouter — plafond mensuel', () => {
  it('budget NON atteint : l appel part normalement', async () => {
    const t = build(false);
    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ model: 'm' });
    expect(t.completeJson).toHaveBeenCalledTimes(1);
  });

  it('⚠️ budget ATTEINT : l appel est REFUSE, le modele n est jamais sollicite', async () => {
    // LE test du correctif. Sans lui, deplacer la garde ici ne serait couvert par rien —
    // les tests de `place-analysis` ne verifient que son pre-controle.
    const t = build(true);
    await expect(t.svc.completeJson(REQ)).rejects.toBeInstanceOf(AiServiceError);
    expect(t.completeJson).not.toHaveBeenCalled();
  });

  it('le refus est de type « quota » — donc lisible par le centre d alerte', async () => {
    const t = build(true);
    await t.svc.completeJson(REQ).catch((e: AiServiceError) => {
      expect(e.kind).toBe('quota');
    });
    expect.assertions(1);
  });

  it('⚠️ le plafond est verifie AVANT de choisir le fournisseur', async () => {
    // Sinon on paierait la resolution du mode (une lecture en base) pour un appel
    // qu'on va refuser — et surtout, un futur `pick()` qui appellerait le modele
    // passerait sous la garde.
    const t = build(true);
    await t.svc.completeJson(REQ).catch(() => undefined);
    expect(t.settings.current).not.toHaveBeenCalled();
  });

  it('le plafond est consulte a CHAQUE appel, jamais mis en cache ici', async () => {
    // Le budget bouge en cours de journee : le mettre en cache dans le routeur ferait
    // dépasser le plafond pendant toute la duree du cache.
    const t = build(false);
    await t.svc.completeJson(REQ);
    await t.svc.completeJson(REQ);
    expect(t.usage.monthBudgetExhausted).toHaveBeenCalledTimes(2);
  });

  it('(g) le plafond passe AVANT le repli : un second moteur configuré ne contourne pas le budget', async () => {
    // Le repli ajoute un moteur candidat ; il ne doit pas ajouter une porte au plafond.
    const t = build(true, { openaiConfigure: true });
    await expect(t.svc.completeJson(REQ)).rejects.toMatchObject({ kind: 'quota' });
    expect(t.completeJson).not.toHaveBeenCalled();
    expect(t.openai.completeJson).not.toHaveBeenCalled();
  });
});

/**
 * ── C3 POINT 1 — LE ROUTEUR BASCULE SUR GPT QUAND ANTHROPIC REFUSE ─────────────────────
 *
 * Relevé de production du 2026-09-05 : `ANTHROPIC_API_KEY` refusée (400 « credit balance is
 * too low ») depuis le 03/09, `OPENAI_API_KEY` présente et VALIDE (GET /v1/models = 200), et
 * l'agent d'agenda en mode dégradé depuis le 04/09. Le routeur élisait UN moteur et l'appel
 * mourait avec lui, un second moteur payé dormant à côté.
 */
describe('AiRouter — repli sur GPT quand Anthropic refuse (C3 point 1, 2026-09-05)', () => {
  it('(a) compte Anthropic à sec, clé OpenAI valide : GPT répond, et le repli est archivé UNE fois en DEGRADATION', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded', 'Your credit balance is too low'));

    const res = await t.svc.completeJson(REQ, { trace: { action: 'agenda_agent', fleetId: 'f1', userId: 'u1' } });

    // Le résultat de GPT, intact : l'appelant attribue le coût au moteur qui a vraiment répondu.
    expect(res).toMatchObject({ provider: 'gpt', model: 'gpt-4.1', result: { ok: true } });
    expect(t.completeJson).toHaveBeenCalledTimes(1);
    expect(t.openai.completeJson).toHaveBeenCalledTimes(1);

    expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
    const [err, source, ctx, niveau] = t.errorLogger.record.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Repli IA : claude → gpt (provider_unfunded) — Your credit balance is too low');
    expect(source).toBe('AI_ROUTER');
    expect(ctx).toMatchObject({
      de: 'claude', vers: 'gpt', kind: 'provider_unfunded',
      motifFournisseur: 'Your credit balance is too low',
      action: 'agenda_agent', fleetId: 'f1', userId: 'u1',
    });
    expect(niveau).toBe('DEGRADATION');
  });

  it('chaque sorte de REPLI_KINDS bascule', async () => {
    for (const kind of REPLI_KINDS) {
      const t = build(false, { openaiConfigure: true });
      t.completeJson.mockRejectedValue(refus(kind));
      await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'gpt' });
    }
  });

  it('(b) un défaut de la requête (parse) ne bascule pas : GPT n’est pas appelé, l’erreur remonte telle quelle', async () => {
    const t = build(false, { openaiConfigure: true });
    const err = refus('parse');
    t.completeJson.mockRejectedValue(err);

    await expect(t.svc.completeJson(REQ)).rejects.toBe(err);
    expect(t.openai.completeJson).not.toHaveBeenCalled();
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('(b bis) aucune sorte hors REPLI_KINDS ne bascule — timeout et réseau compris : l’appel a peut-être été facturé', async () => {
    for (const kind of ['refusal', 'truncated', 'parse', 'empty', 'http', 'timeout', 'network'] as const) {
      const t = build(false, { openaiConfigure: true });
      const err = refus(kind);
      t.completeJson.mockRejectedValue(err);
      await expect(t.svc.completeJson(REQ)).rejects.toBe(err);
      expect(t.openai.completeJson).not.toHaveBeenCalled();
    }
  });

  it('(c) moteur IMPOSÉ (preferProvider) : jamais de repli — un résultat GPT ne s’affiche pas sous l’étiquette Claude', async () => {
    const t = build(false, { openaiConfigure: true });
    const err = refus('provider_unfunded');
    t.completeJson.mockRejectedValue(err);

    await expect(t.svc.completeJson(REQ, { preferProvider: 'claude' })).rejects.toBe(err);
    expect(t.openai.completeJson).not.toHaveBeenCalled();
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('(c bis) `fallback: true` explicite ne l’emporte pas sur un moteur imposé', async () => {
    const t = build(false, { openaiConfigure: true });
    const err = refus('provider_unfunded');
    t.completeJson.mockRejectedValue(err);
    await expect(t.svc.completeJson(REQ, { preferProvider: 'claude', fallback: true })).rejects.toBe(err);
    expect(t.openai.completeJson).not.toHaveBeenCalled();
  });

  it('(c ter) moteur imposé SANS clé : c’est SON client qui répond (no_key clair), jamais l’autre moteur à sa place', async () => {
    // Avant C3, « Comparer » sans clé OpenAI affichait un récit Claude dans la colonne GPT.
    const t = build(false, { openaiConfigure: false });
    t.openai.completeJson.mockRejectedValue(refus('no_key'));
    await expect(t.svc.completeJson(REQ, { preferProvider: 'gpt' })).rejects.toMatchObject({ kind: 'no_key' });
    expect(t.completeJson).not.toHaveBeenCalled();
  });

  it('`fallback: false` sans moteur imposé : le premier configuré seulement', async () => {
    const t = build(false, { openaiConfigure: true });
    const err = refus('provider_unfunded');
    t.completeJson.mockRejectedValue(err);
    await expect(t.svc.completeJson(REQ, { fallback: false })).rejects.toBe(err);
    expect(t.openai.completeJson).not.toHaveBeenCalled();
  });

  it('(e) les deux moteurs échouent : l’erreur du PRIMAIRE remonte telle quelle ; seul l’échec du REPLI est archivé', async () => {
    // L'erreur du primaire, c'est elle que les appelants et le filtre HTTP archivent déjà ; une
    // ligne de plus serait le doublon du 03/09 (TRK-061), et son message est celui écrit pour
    // l'utilisateur. L'échec du moteur de repli, lui, n'a personne d'autre pour le dire : UNE
    // ligne, sous sa propre clé, avec SON niveau (revue C3 du 2026-09-05).
    const t = build(false, { openaiConfigure: true });
    const primaire = refus('provider_unfunded', 'credit balance');
    t.completeJson.mockRejectedValue(primaire);
    t.openai.completeJson.mockRejectedValue(refus('quota', '429'));

    await expect(t.svc.completeJson(REQ)).rejects.toBe(primaire);
    expect(t.openai.completeJson).toHaveBeenCalledTimes(1);
    expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
    const [err, , ctx, niveau] = t.errorLogger.record.mock.calls[0];
    expect((err as Error).message).toBe('Repli IA en échec : claude → gpt (quota) — 429');
    expect(ctx).toMatchObject({ de: 'claude', vers: 'gpt', kind: 'quota' });
    expect(niveau).toBe('DEGRADATION');
  });

  it('(e bis) le second moteur échoue sur un défaut de requête : c’est encore l’erreur du primaire qui remonte', async () => {
    const t = build(false, { openaiConfigure: true });
    const primaire = refus('overloaded');
    t.completeJson.mockRejectedValue(primaire);
    t.openai.completeJson.mockRejectedValue(refus('parse'));
    await expect(t.svc.completeJson(REQ)).rejects.toBe(primaire);
  });

  it('le mode réglé sur GPT inverse l’ordre : GPT d’abord, Claude en repli', async () => {
    const t = build(false, { mode: 'gpt', openaiConfigure: true });
    t.openai.completeJson.mockRejectedValue(refus('quota'));

    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'claude' });
    expect(t.openai.completeJson.mock.invocationCallOrder[0]).toBeLessThan(t.completeJson.mock.invocationCallOrder[0]);
    expect(t.errorLogger.record.mock.calls[0][2]).toMatchObject({ de: 'gpt', vers: 'claude', kind: 'quota' });
  });

  it('le mode mixte retombe sur Claude pour un appel simple, avec GPT en repli', async () => {
    const t = build(false, { mode: 'both', openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('overloaded'));
    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'gpt' });
  });

  it('un seul moteur configuré : aucun repli possible, l’erreur remonte (comportement d’avant)', async () => {
    const t = build(false);
    const err = refus('provider_unfunded');
    t.completeJson.mockRejectedValue(err);
    await expect(t.svc.completeJson(REQ)).rejects.toBe(err);
    expect(t.openai.completeJson).not.toHaveBeenCalled();
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('aucun moteur configuré : le moteur réglé est sollicité, il lèvera son no_key clair', async () => {
    const t = build(false, { anthropicConfigure: false, openaiConfigure: false });
    t.completeJson.mockRejectedValue(refus('no_key'));
    await expect(t.svc.completeJson(REQ)).rejects.toMatchObject({ kind: 'no_key' });
    expect(t.openai.completeJson).not.toHaveBeenCalled();
  });

  it('une erreur qui n’est pas un échec typé (défaut du code) remonte telle quelle, sans repli', async () => {
    // La cacher derrière le 503 d'un autre moteur rendrait le bug invisible au centre d'alerte.
    const t = build(false, { openaiConfigure: true });
    const bug = new TypeError('Cannot read properties of undefined');
    t.completeJson.mockRejectedValue(bug);
    await expect(t.svc.completeJson(REQ)).rejects.toBe(bug);
    expect(t.openai.completeJson).not.toHaveBeenCalled();
  });

  it('sans observabilité (routeur à quatre dépendances), le repli fonctionne quand même', async () => {
    const t = build(false, { openaiConfigure: true, sansObservabilite: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'gpt' });
  });

  it('archiver le repli ne peut pas faire échouer un appel qui, lui, a réussi', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    t.errorLogger.record.mockRejectedValue(new Error('DB down'));
    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'gpt' });
  });
});

describe('AiRouter — niveau de la ligne de repli', () => {
  const niveauPour = async (kind: AiErrorKind) => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus(kind));
    await t.svc.completeJson(REQ);
    return t.errorLogger.record.mock.calls[0][3];
  };

  it('invalid_key → CRITICAL : une clé configurée mais refusée, quelqu’un doit agir', async () => {
    expect(await niveauPour('invalid_key')).toBe('CRITICAL');
  });

  it('provider_unfunded → DEGRADATION : dépendance assumée, repli propre (TRK-061)', async () => {
    expect(await niveauPour('provider_unfunded')).toBe('DEGRADATION');
  });

  it('⚠️ une sorte PASSAGÈRE (overloaded, quota) → DEGRADATION, jamais ERROR', async () => {
    // `ErrorLogger` n'archive jamais un 529 ou un 429 qui ÉCHOUE (2026-07-20). Un repli qui a
    // MARCHÉ ne peut pas crier plus fort que l'échec qu'il a évité — mais il reste visible.
    expect(await niveauPour('overloaded')).toBe('DEGRADATION');
    expect(await niveauPour('quota')).toBe('DEGRADATION');
  });
});

describe('AiRouter — quarantaine (d)', () => {
  let horloge: ReturnType<typeof figerHorloge>;
  beforeEach(() => { horloge = figerHorloge(); });
  afterEach(() => { horloge.rendre(); });

  it('(d) après un « compte à sec », Claude n’est plus appelé pendant 15 min ; il est retenté ensuite', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await t.svc.completeJson(REQ); // 1er appel : refus, puis repli
    expect(t.completeJson).toHaveBeenCalledTimes(1);

    horloge.avancer(14 * 60_000);
    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'gpt' });
    expect(t.completeJson).toHaveBeenCalledTimes(1); // sauté sans appel réseau
    expect(t.openai.completeJson).toHaveBeenCalledTimes(2);

    horloge.avancer(15 * 60_000); // expiration
    t.completeJson.mockResolvedValue({ ...OK_CLAUDE }); // le compte a été rechargé entre-temps
    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'claude' });
    expect(t.completeJson).toHaveBeenCalledTimes(2);
  });

  it('un quota ou une saturation (passagers) ne mettent à l’écart que 60 s', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('quota'));
    await t.svc.completeJson(REQ);

    horloge.avancer(59_000);
    await t.svc.completeJson(REQ);
    expect(t.completeJson).toHaveBeenCalledTimes(1);

    horloge.avancer(60_000);
    await t.svc.completeJson(REQ);
    expect(t.completeJson).toHaveBeenCalledTimes(2);
  });

  it('un refus à l’expiration relance la quarantaine — une tentative, pas un martèlement', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await t.svc.completeJson(REQ);

    horloge.avancer(15 * 60_000);
    await t.svc.completeJson(REQ); // retenté : refuse encore
    expect(t.completeJson).toHaveBeenCalledTimes(2);

    horloge.avancer(16 * 60_000);
    await t.svc.completeJson(REQ); // de nouveau à l'écart
    expect(t.completeJson).toHaveBeenCalledTimes(2);
  });

  it('un moteur sauté pour quarantaine n’écrit pas une nouvelle ligne : l’épisode a déjà été archivé', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await t.svc.completeJson(REQ);
    horloge.avancer(60_000);
    await t.svc.completeJson(REQ);
    expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
    expect(t.refroidissement.tenterEmission).toHaveBeenCalledTimes(1);
  });

  it('un moteur à l’écart qui est le SEUL candidat (imposé) est quand même appelé : jamais un interblocage', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await t.svc.completeJson(REQ); // Claude en quarantaine

    await expect(t.svc.completeJson(REQ, { preferProvider: 'claude' })).rejects.toMatchObject({ kind: 'provider_unfunded' });
    expect(t.completeJson).toHaveBeenCalledTimes(2);
    expect(t.openai.completeJson).toHaveBeenCalledTimes(1);
  });

  it('tous les candidats à l’écart : on tente quand même le premier', async () => {
    // Avec deux moteurs, cet état est inatteignable par l'API publique (un moteur n'est mis à
    // l'écart que s'il reste un candidat derrière lui). On force l'état interne : la garde doit
    // exister le jour où un troisième moteur arrive, et ne pas se perdre d'ici là.
    const t = build(false, { openaiConfigure: true });
    const quarantaines = (t.svc as unknown as { quarantaines: Map<string, { jusqua: number; kind: string }> }).quarantaines;
    quarantaines.set('claude', { jusqua: T0 + 60_000, kind: 'quota' });
    quarantaines.set('gpt', { jusqua: T0 + 60_000, kind: 'quota' });

    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ provider: 'claude' });
    expect(t.completeJson).toHaveBeenCalledTimes(1);
    expect(t.openai.completeJson).not.toHaveBeenCalled();
  });

  it('etatFournisseurs() expose la quarantaine (sorte, fin en ISO) puis l’oublie à l’expiration', async () => {
    const t = build(false, { openaiConfigure: true });
    expect(t.svc.etatFournisseurs()).toEqual({ claude: { configure: true }, gpt: { configure: true } });

    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await t.svc.completeJson(REQ);
    expect(t.svc.etatFournisseurs()).toEqual({
      claude: { configure: true, quarantaine: { kind: 'provider_unfunded', jusqua: '2026-09-05T08:15:00.000Z' } },
      gpt: { configure: true },
    });

    horloge.avancer(15 * 60_000);
    expect(t.svc.etatFournisseurs().claude).toEqual({ configure: true });
  });

  it('etatFournisseurs() dit aussi qui n’a pas de clé', () => {
    const t = build(false, { openaiConfigure: false });
    expect(t.svc.etatFournisseurs().gpt).toEqual({ configure: false });
  });
});

describe('AiRouter — refroidissement de la ligne de repli (f)', () => {
  let horloge: ReturnType<typeof figerHorloge>;
  beforeEach(() => { horloge = figerHorloge(); });
  afterEach(() => { horloge.rendre(); });

  it('(f) deux replis successifs → une seule ligne archivée ; clé et fenêtre sont celles du registre', async () => {
    const t = build(false, { openaiConfigure: true, emissions: [true, false] });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));

    await t.svc.completeJson(REQ);
    horloge.avancer(15 * 60_000); // quarantaine expirée : Claude retenté, refuse, repli à nouveau
    await t.svc.completeJson(REQ);

    expect(t.completeJson).toHaveBeenCalledTimes(2);
    expect(t.refroidissement.tenterEmission).toHaveBeenCalledTimes(2);
    expect(t.refroidissement.tenterEmission).toHaveBeenNthCalledWith(1, 'ai-repli:claude:provider_unfunded', 6 * 3_600_000);
    expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
  });

  it('la clé distingue le moteur ET la sorte : un compte à sec ne fait pas taire un quota', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await t.svc.completeJson(REQ);

    horloge.avancer(15 * 60_000);
    t.completeJson.mockRejectedValue(refus('quota'));
    await t.svc.completeJson(REQ);

    const cles = t.refroidissement.tenterEmission.mock.calls.map((c) => c[0]);
    expect(cles).toEqual(['ai-repli:claude:provider_unfunded', 'ai-repli:claude:quota']);
    expect(t.errorLogger.record).toHaveBeenCalledTimes(2);
  });
});

describe('AiRouter — quand le repli échoue à son tour', () => {
  /**
   * Revue C3 du 2026-09-05 : Claude sature (529, passager), GPT refuse la clé (401, CRITICAL).
   * L'erreur relancée reste celle du primaire (c'est elle que l'appelant sait classer), mais la
   * faute de GPT ne doit PAS disparaître : archivée sous sa propre clé, avec SON niveau.
   */
  it('archive l’échec du moteur de repli avec SON niveau, et relance l’erreur du primaire', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('overloaded', '529 overloaded'));
    t.openai.completeJson.mockRejectedValue(refus('invalid_key', '401 clé refusée'));

    await expect(t.svc.completeJson(REQ, { trace: { action: 'agenda_agent' } })).rejects.toMatchObject({ kind: 'overloaded' });

    // Deux lignes, deux faits : la faute de GPT (CRITICAL, sous sa clé) ET — C3 point 5 — l'échec
    // PASSAGER du primaire, que personne d'autre n'archivera (`ErrorLogger` ignore un transitoire).
    expect(t.errorLogger.record).toHaveBeenCalledTimes(2);
    const repli = t.errorLogger.record.mock.calls.find((c) => (c[0] as Error).message.startsWith('Repli IA en échec'))!;
    const [err, source, ctx, niveau] = repli;
    expect((err as Error).message).toBe('Repli IA en échec : claude → gpt (invalid_key) — 401 clé refusée');
    expect(source).toBe('AI_ROUTER');
    expect(ctx).toMatchObject({ de: 'claude', vers: 'gpt', kind: 'invalid_key', action: 'agenda_agent' });
    expect(niveau).toBe('CRITICAL');
    expect(t.refroidissement.tenterEmission).toHaveBeenCalledWith('ai-repli-echec:gpt:invalid_key', expect.any(Number));
    const passager = t.errorLogger.record.mock.calls.find((c) => (c[0] as Error).message.startsWith('Appel IA en échec passager'))!;
    expect((passager[0] as Error).message).toBe('Appel IA en échec passager : claude overloaded — 529 overloaded');
    expect(passager[3]).toBe('DEGRADATION');
  });

  it('un échec passager du moteur de repli est archivé en DEGRADATION', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded', 'credit balance too low'));
    t.openai.completeJson.mockRejectedValue(refus('quota', '429 rate limited'));

    await expect(t.svc.completeJson(REQ)).rejects.toMatchObject({ kind: 'provider_unfunded' });
    // Le primaire (compte à sec) n'est PAS passager : l'appelant l'archive, le routeur se tait.
    expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
    expect(t.errorLogger.record.mock.calls[0][3]).toBe('DEGRADATION');
  });
});

/**
 * ══ C3 POINT 5 (2026-09-05) — CHAQUE ÉCHEC EST UNE LIGNE, ET UN ÉCHEC PASSAGER SE VOIT ══
 *
 * `ai_usage_logs` n'avait jamais porté une ligne `ok = false` : trois jours de compte Anthropic
 * à sec (03-04/09) sans une trace sur la page « Coûts IA ». Le routeur est le seul point de
 * passage : c'est ici qu'aucun échec ne peut être oublié.
 */
describe('AiRouter — chaque tentative en échec écrit une ligne (C3 point 5)', () => {
  const TRACE = { trace: { action: 'agenda_agent', userId: 'u1', fleetId: 'f1' } };
  /** Requête dont on connaît la taille : 8 caractères de prompt + `{"a":"bcdefghij"}` (17) = 25 → 7 jetons estimés. */
  const REQ_MESUREE = { system: 'systeme!', userPayload: { a: 'bcdefghij' }, schema: {}, maxTokens: 10 } as never;

  it('(a) refus Anthropic (compte à sec) puis repli GPT réussi → UNE ligne d’échec, provider claude, ESTIMÉE', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('provider_unfunded', 'Your credit balance is too low'));

    await expect(t.svc.completeJson(REQ_MESUREE, TRACE)).resolves.toMatchObject({ provider: 'gpt' });

    expect(t.usage.recordFailure).toHaveBeenCalledTimes(1);
    const ligne = t.usage.recordFailure.mock.calls[0][0];
    expect(ligne).toMatchObject({
      action: 'agenda_agent', userId: 'u1', fleetId: 'f1', provider: 'claude', model: 'claude-sonnet-5',
      errorKind: 'provider_unfunded', errorDetail: 'Your credit balance is too low', usage: null,
    });
    // Rien n'a été facturé : l'estimation porte les jetons du prompt (25 caractères / 4 → 7).
    expect(ligne.estimatedInputTokens).toBe(7);
    expect(ligne.latencyMs).toBeGreaterThanOrEqual(0);
    // Le modèle estimé est celui que Claude AURAIT employé pour cette requête.
    expect(t.anthropic.modelFor).toHaveBeenCalledWith(REQ_MESUREE);
  });

  it('(b) un échec APRÈS réponse (tronqué, avec usage) porte les jetons facturés et le modèle réel, sans estimation', async () => {
    const t = build(false, { openaiConfigure: true });
    const usage = { inputTokens: 100, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 };
    t.completeJson.mockRejectedValue(new AiServiceError('truncated', 'Réponse tronquée', undefined, { usage, model: 'claude-sonnet-5-20260101' }));

    await expect(t.svc.completeJson(REQ_MESUREE, TRACE)).rejects.toMatchObject({ kind: 'truncated' });

    expect(t.usage.recordFailure).toHaveBeenCalledTimes(1);
    expect(t.usage.recordFailure.mock.calls[0][0]).toMatchObject({
      provider: 'claude', model: 'claude-sonnet-5-20260101', errorKind: 'truncated', usage, estimatedInputTokens: undefined,
    });
    // Pas de repli (défaut de la requête), pas de DEGRADATION (pas passager) : l'appelant archive.
    expect(t.openai.completeJson).not.toHaveBeenCalled();
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('(c) tout échoue en 429 : une ligne d’échec PAR tentative + UNE DEGRADATION derrière `ai-echec:<moteur>:<sorte>` (1 h)', async () => {
    const t = build(false, { openaiConfigure: true });
    t.completeJson.mockRejectedValue(refus('quota', '429 rate limited'));
    t.openai.completeJson.mockRejectedValue(refus('quota', '429 too many requests'));

    await expect(t.svc.completeJson(REQ, TRACE)).rejects.toMatchObject({ kind: 'quota' });

    expect(t.usage.recordFailure).toHaveBeenCalledTimes(2);
    expect(t.usage.recordFailure.mock.calls.map((c) => [c[0].provider, c[0].model, c[0].errorKind])).toEqual([
      ['claude', 'claude-sonnet-5', 'quota'],
      ['gpt', 'gpt-4.1', 'quota'],
    ]);
    // DEGRADATION du primaire passager, derrière le refroidissement d'une heure.
    expect(t.refroidissement.tenterEmission).toHaveBeenCalledWith('ai-echec:claude:quota', 3_600_000);
    const passager = t.errorLogger.record.mock.calls.find((c) => (c[0] as Error).message.startsWith('Appel IA en échec passager'))!;
    expect(passager).toBeDefined();
    expect((passager[0] as Error).message).toBe('Appel IA en échec passager : claude quota — 429 rate limited');
    expect(passager[1]).toBe('AI_ROUTER');
    expect(passager[2]).toMatchObject({ action: 'agenda_agent', provider: 'claude', kind: 'quota', motif: '429 rate limited', userId: 'u1', fleetId: 'f1' });
    expect(passager[3]).toBe('DEGRADATION');
  });

  it('(c bis) le refroidissement encore actif fait taire la DEGRADATION, pas la ligne d’échec', async () => {
    // Deux gardes consultés dans l'ordre : l'échec du repli (`ai-repli-echec`), puis l'échec
    // passager du primaire (`ai-echec`). Tous deux encore chauds : aucune ligne au centre.
    const t = build(false, { openaiConfigure: true, emissions: [false, false] });
    t.completeJson.mockRejectedValue(refus('quota'));
    t.openai.completeJson.mockRejectedValue(refus('quota'));
    await expect(t.svc.completeJson(REQ, TRACE)).rejects.toMatchObject({ kind: 'quota' });
    expect(t.usage.recordFailure).toHaveBeenCalledTimes(2);
    expect(t.refroidissement.tenterEmission).toHaveBeenLastCalledWith('ai-echec:claude:quota', 3_600_000);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('(c ter) un échec total NON passager (compte à sec, un seul moteur) : la ligne, mais pas de DEGRADATION — l’appelant archive', async () => {
    const t = build(false);
    t.completeJson.mockRejectedValue(refus('provider_unfunded', 'credit'));
    await expect(t.svc.completeJson(REQ, TRACE)).rejects.toMatchObject({ kind: 'provider_unfunded' });
    expect(t.usage.recordFailure).toHaveBeenCalledTimes(1);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('(d) le plafond mensuel levé AVANT tout appel écrit une ligne sans fournisseur, et une DEGRADATION « plafond »', async () => {
    const t = build(true, { openaiConfigure: true });
    await expect(t.svc.completeJson(REQ_MESUREE, TRACE)).rejects.toMatchObject({ kind: 'quota' });

    expect(t.usage.recordFailure).toHaveBeenCalledTimes(1);
    expect(t.usage.recordFailure.mock.calls[0][0]).toMatchObject({
      action: 'agenda_agent', provider: null, model: 'claude-sonnet-5', errorKind: 'quota', latencyMs: 0, estimatedInputTokens: 7,
    });
    // Sans lire le réglage du moteur : le plafond passe AVANT le choix du fournisseur.
    expect(t.settings.current).not.toHaveBeenCalled();
    expect(t.refroidissement.tenterEmission).toHaveBeenCalledWith('ai-echec:plafond:quota', 3_600_000);
    expect(t.errorLogger.record.mock.calls[0][3]).toBe('DEGRADATION');
  });

  it('(e) un appelant sans `trace` voit ses échecs rangés sous l’action « inconnu »', async () => {
    const t = build(false);
    t.completeJson.mockRejectedValue(refus('http', '400'));
    await expect(t.svc.completeJson(REQ)).rejects.toMatchObject({ kind: 'http' });
    expect(t.usage.recordFailure.mock.calls[0][0]).toMatchObject({ action: 'inconnu', userId: null, fleetId: null });
  });

  it('un succès n’écrit aucune ligne d’échec', async () => {
    const t = build(false, { openaiConfigure: true });
    await t.svc.completeJson(REQ, TRACE);
    expect(t.usage.recordFailure).not.toHaveBeenCalled();
  });

  it('un moteur SAUTÉ pour quarantaine n’a pas tenté : pas de ligne pour lui', async () => {
    const horloge = figerHorloge();
    try {
      const t = build(false, { openaiConfigure: true });
      t.completeJson.mockRejectedValue(refus('provider_unfunded'));
      await t.svc.completeJson(REQ, TRACE); // refus + repli : une ligne (claude)
      horloge.avancer(60_000);
      await t.svc.completeJson(REQ, TRACE); // Claude sauté sans appel : aucune ligne de plus
      expect(t.usage.recordFailure).toHaveBeenCalledTimes(1);
    } finally {
      horloge.rendre();
    }
  });

  it('journaliser l’échec ne peut pas faire échouer l’appel (ni changer l’erreur relancée)', async () => {
    const t = build(false, { openaiConfigure: true });
    t.usage.recordFailure.mockRejectedValue(new Error('DB down'));
    t.completeJson.mockRejectedValue(refus('provider_unfunded'));
    await expect(t.svc.completeJson(REQ, TRACE)).resolves.toMatchObject({ provider: 'gpt' });
  });

  it('estimerJetonsEntree : longueur(system + JSON des données) / 4, arrondi au-dessus', () => {
    expect(estimerJetonsEntree({ system: 'abcd', userPayload: { x: 1 }, schema: {} } as never)).toBe(Math.ceil((4 + 7) / 4));
    expect(estimerJetonsEntree({ system: '', userPayload: undefined, schema: {} } as never)).toBe(1);
  });

  it('modeleParDefaut expose le modèle réel de chaque moteur (carte « Moteur IA »)', () => {
    const t = build();
    expect(t.svc.modeleParDefaut('claude')).toBe('claude-sonnet-5');
    expect(t.svc.modeleParDefaut('gpt')).toBe('gpt-4.1');
  });
});

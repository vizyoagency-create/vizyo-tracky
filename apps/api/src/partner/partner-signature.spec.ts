import {
  PARTNER_SIGNATURE_DRIFT_SECONDS,
  PartnerSignatureError,
  buildCanonicalString,
  computePartnerSignature,
  signPartnerRequest,
  verifyPartnerRequest,
} from './partner-signature';

/**
 * VECTEURS FIGÉS — ils épinglent le FORMAT DU FIL.
 *
 * Ils sont dupliqués À L'IDENTIQUE dans le jumeau Maestroo
 * (`apps/api/src/integrations/partner-signature.spec.ts`). Si une des deux
 * implémentations change sa chaîne canonique, son test casse : c'est ce qui garantit
 * que ce que Tracky signe, Maestroo le vérifie — sans partage de code entre les repos.
 *
 * ⚠️ Si ce test échoue, NE PAS recalculer les valeurs depuis l'implémentation : c'est
 * le signal qu'un changement de format vient de casser la compatibilité avec le pair.
 */
const SECRET = 'vecteur-de-test-ne-jamais-utiliser-en-prod';
const TS = '1753171200'; // 2026-07-22T08:00:00Z
const AT = new Date(Number(TS) * 1000);

const VECTORS = [
  {
    label: 'POST corps JSON',
    method: 'POST',
    op: 'partner.token',
    rawBody: JSON.stringify({ linkId: 'link-1' }),
    expected: '72fc84f847667ccb434d5b6a5cac7e0613f163623b742b60e96a591a61f3778a',
  },
  {
    label: 'GET corps vide',
    method: 'GET',
    op: 'partner.ping',
    rawBody: '',
    expected: 'a86e3dd920c8e2c9f44f0205c5451ee1f6389195e73973a0ef3c50a98fb7c529',
  },
  {
    label: 'GET autre opération, même horodatage et même corps vide',
    method: 'GET',
    op: 'partner.vehicles.count',
    rawBody: '',
    expected: '76007aef9e5fa0c9aa43695fd6271346451b3b42ff3dddee8c4b2ca8195784fb',
  },
  {
    label: 'webhook de révocation',
    method: 'POST',
    op: 'partner.webhook',
    rawBody: JSON.stringify({ type: 'link.revoked', linkId: 'link-1' }),
    expected: 'e76e78701ee287527924fb04b699f0c0c9d608a79e140503df4559f7ff4e120a',
  },
  {
    label: 'corps accentué (UTF-8)',
    method: 'POST',
    op: 'partner.webhook',
    rawBody: JSON.stringify({ raison: 'impayé — coupé' }),
    expected: '53c22838f74e9b721759df7b04e9c03f40fe6c8bc9a3c05c05c216daf5ce3b81',
  },
] as const;

describe('signature partenaire — vecteurs figés (compatibilité inter-repos)', () => {
  it.each(VECTORS)('$label', ({ method, op, rawBody, expected }) => {
    expect(computePartnerSignature(SECRET, { method, op, rawBody, timestamp: TS })).toBe(expected);
  });

  it('la chaîne canonique est `timestamp.METHOD.op.rawBody`', () => {
    expect(buildCanonicalString({ timestamp: TS, method: 'POST', op: 'partner.token', rawBody: '{}' })).toBe(
      `${TS}.POST.partner.token.{}`,
    );
  });

  it('la méthode est normalisée en majuscules (un pair qui envoie « post » reste compatible)', () => {
    const lower = computePartnerSignature(SECRET, { method: 'post', op: 'x', rawBody: '', timestamp: TS });
    const upper = computePartnerSignature(SECRET, { method: 'POST', op: 'x', rawBody: '', timestamp: TS });
    expect(lower).toBe(upper);
  });
});

describe('signature partenaire — ce que la liaison à l\'opération empêche', () => {
  // LA raison du choix de conception. Avec le schéma `timestamp.body` de Vizyo Auth,
  // ces deux signatures seraient IDENTIQUES (même horodatage, corps vide des deux
  // côtés) : une signature capturée sur /ping ouvrirait /vehicles/count.
  it('deux GET différents au MÊME horodatage produisent des signatures DIFFÉRENTES', () => {
    const ping = computePartnerSignature(SECRET, { method: 'GET', op: 'partner.ping', rawBody: '', timestamp: TS });
    const count = computePartnerSignature(SECRET, {
      method: 'GET',
      op: 'partner.vehicles.count',
      rawBody: '',
      timestamp: TS,
    });
    expect(ping).not.toBe(count);
  });

  it('une signature valide pour une opération est REFUSÉE sur une autre', () => {
    const headers = signPartnerRequest(SECRET, { method: 'GET', op: 'partner.ping', rawBody: '' }, AT);
    expect(() =>
      verifyPartnerRequest(SECRET, {
        method: 'GET',
        op: 'partner.vehicles.count', // le récepteur impose SON op, jamais celui du client
        rawBody: '',
        timestamp: headers['X-Partner-Timestamp'],
        signature: headers['X-Partner-Signature'],
        now: AT,
      }),
    ).toThrow(expect.objectContaining({ reason: 'signature_mismatch' }));
  });

  it('changer la méthode invalide la signature', () => {
    const headers = signPartnerRequest(SECRET, { method: 'POST', op: 'partner.token', rawBody: '{}' }, AT);
    expect(() =>
      verifyPartnerRequest(SECRET, {
        method: 'DELETE',
        op: 'partner.token',
        rawBody: '{}',
        timestamp: headers['X-Partner-Timestamp'],
        signature: headers['X-Partner-Signature'],
        now: AT,
      }),
    ).toThrow(expect.objectContaining({ reason: 'signature_mismatch' }));
  });
});

describe('signature partenaire — aller-retour', () => {
  it('ce qui est signé se vérifie', () => {
    const input = { method: 'POST', op: 'partner.webhook', rawBody: JSON.stringify({ a: 1 }) };
    const headers = signPartnerRequest(SECRET, input, AT);
    expect(() =>
      verifyPartnerRequest(SECRET, { ...input, ...toVerify(headers), now: AT }),
    ).not.toThrow();
  });

  it('l\'horodatage émis est bien en SECONDES UNIX', () => {
    const headers = signPartnerRequest(SECRET, { method: 'GET', op: 'x', rawBody: '' }, AT);
    expect(headers['X-Partner-Timestamp']).toBe(TS);
  });

  it('la signature est du hex minuscule sur 64 caractères', () => {
    const headers = signPartnerRequest(SECRET, { method: 'GET', op: 'x', rawBody: '' }, AT);
    expect(headers['X-Partner-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signature partenaire — rejets', () => {
  const base = { method: 'POST', op: 'partner.token', rawBody: '{}' };
  const valid = () => signPartnerRequest(SECRET, base, AT)['X-Partner-Signature'];

  it('secret non configuré ⇒ TOUT est rejeté (jamais « pas de vérification »)', () => {
    // Le piège classique : un secret vide qui devient une porte ouverte silencieuse.
    expect(() =>
      verifyPartnerRequest('', { ...base, timestamp: TS, signature: valid(), now: AT }),
    ).toThrow(PartnerSignatureError);
  });

  it.each([
    ['horodatage absent', { timestamp: undefined, signature: 'a'.repeat(64) }, 'missing_headers'],
    ['signature absente', { timestamp: TS, signature: undefined }, 'missing_headers'],
    ['horodatage non numérique', { timestamp: 'hier', signature: 'a'.repeat(64) }, 'invalid_timestamp'],
    // parseInt('1753171200abc') vaudrait 1753171200 : sans validation stricte, ça passerait.
    ['horodatage numérique + suffixe', { timestamp: `${TS}abc`, signature: 'a'.repeat(64) }, 'invalid_timestamp'],
    ['signature non hexadécimale', { timestamp: TS, signature: 'z'.repeat(64) }, 'malformed_signature'],
    ['signature trop courte', { timestamp: TS, signature: 'ab' }, 'malformed_signature'],
    ['signature trop longue', { timestamp: TS, signature: 'a'.repeat(65) }, 'malformed_signature'],
  ])('%s ⇒ %s', (_label, headers, reason) => {
    expect(() => verifyPartnerRequest(SECRET, { ...base, ...headers, now: AT })).toThrow(
      expect.objectContaining({ reason }),
    );
  });

  it('corps altéré ⇒ signature_mismatch', () => {
    expect(() =>
      verifyPartnerRequest(SECRET, {
        ...base,
        rawBody: '{"a":2}',
        timestamp: TS,
        signature: valid(),
        now: AT,
      }),
    ).toThrow(expect.objectContaining({ reason: 'signature_mismatch' }));
  });

  it('mauvais secret ⇒ signature_mismatch', () => {
    expect(() =>
      verifyPartnerRequest('un-autre-secret', { ...base, timestamp: TS, signature: valid(), now: AT }),
    ).toThrow(expect.objectContaining({ reason: 'signature_mismatch' }));
  });
});

describe('signature partenaire — fenêtre temporelle', () => {
  const base = { method: 'GET', op: 'partner.ping', rawBody: '' };
  const sig = () => signPartnerRequest(SECRET, base, AT)['X-Partner-Signature'];
  const at = (offsetSec: number) => new Date(AT.getTime() + offsetSec * 1000);

  it.each([0, 299, 300, -300])('dérive de %s s : accepté', (offset) => {
    expect(() =>
      verifyPartnerRequest(SECRET, { ...base, timestamp: TS, signature: sig(), now: at(offset) }),
    ).not.toThrow();
  });

  it.each([301, -301, 86400])('dérive de %s s : rejeté', (offset) => {
    expect(() =>
      verifyPartnerRequest(SECRET, { ...base, timestamp: TS, signature: sig(), now: at(offset) }),
    ).toThrow(expect.objectContaining({ reason: 'timestamp_out_of_window' }));
  });

  it('la tolérance par défaut est de 300 s', () => {
    expect(PARTNER_SIGNATURE_DRIFT_SECONDS).toBe(300);
  });

  it('une dérive hors fenêtre est rejetée AVANT toute comparaison de signature', () => {
    // Une signature bidon ET un horodatage périmé : on doit voir l'erreur d'horodatage,
    // pas celle de signature. Sinon on comparerait des signatures déjà disqualifiées.
    expect(() =>
      verifyPartnerRequest(SECRET, {
        ...base,
        timestamp: TS,
        signature: 'f'.repeat(64),
        now: at(9999),
      }),
    ).toThrow(expect.objectContaining({ reason: 'timestamp_out_of_window' }));
  });
});

function toVerify(headers: ReturnType<typeof signPartnerRequest>) {
  return {
    timestamp: headers['X-Partner-Timestamp'],
    signature: headers['X-Partner-Signature'],
  };
}

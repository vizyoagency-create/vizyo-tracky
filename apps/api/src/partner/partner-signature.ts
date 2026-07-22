import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature HMAC des échanges partenaires (intégration Tracky × Maestroo).
 *
 * Fonctions PURES, sans DI ni accès à la config : le secret et la tolérance sont
 * passés en paramètre. Le service Nest qui les câble arrive à l'incrément 0.4, quand
 * les variables d'environnement existeront. Ça garde ces primitives triviales à
 * tester — et une primitive de crypto doit être triviale à tester.
 *
 * ⚠️ Ce fichier a un JUMEAU côté Maestroo
 * (`apps/api/src/integrations/partner-signature.ts`). Les deux repos étant
 * indépendants, la parité est garantie par des VECTEURS DE TEST FIGÉS, identiques des
 * deux côtés : ils épinglent le format du fil. Si une implémentation dérive, son test
 * casse — même technique que le registre des scopes.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §5
 */

/** Chaîne canonique signée. Voir `buildCanonicalString` pour le pourquoi de chaque champ. */
export interface PartnerSignatureInput {
  /** Méthode HTTP en MAJUSCULES ('GET', 'POST'…). */
  method: string;
  /**
   * Identifiant STABLE de l'opération (ex. 'partner.token', 'partner.webhook').
   * ⚠️ Ce n'est volontairement PAS le chemin d'URL — cf. `buildCanonicalString`.
   */
  op: string;
  /** Corps brut EXACTEMENT tel qu'il transite. Chaîne vide pour un GET. */
  rawBody: string;
  /** Secondes UNIX, en chaîne. */
  timestamp: string;
}

export type PartnerSignatureFailure =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_out_of_window'
  | 'malformed_signature'
  | 'signature_mismatch';

/** Échec de vérification, avec une raison exploitable par l'appelant (jamais exposée telle quelle au client). */
export class PartnerSignatureError extends Error {
  constructor(
    readonly reason: PartnerSignatureFailure,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`Signature partenaire invalide : ${reason}`);
    this.name = 'PartnerSignatureError';
  }
}

/** Tolérance de dérive d'horloge, en secondes. Standard maison (identique à Vizyo Auth). */
export const PARTNER_SIGNATURE_DRIFT_SECONDS = 300;

const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Construit la chaîne canonique : `timestamp.METHOD.op.rawBody`.
 *
 * Deux écarts DÉLIBÉRÉS par rapport au schéma Vizyo Auth existant (`timestamp.body`) :
 *
 * 1. **On lie la méthode et l'opération.** Avec `timestamp.body` seul, une signature
 *    reste valide pour N'IMPORTE QUEL endpoint. Le cas le plus net : tous les GET ont
 *    un corps vide, donc `GET /partner/v1/ping` et `GET /partner/v1/vehicles/count`
 *    produisent LA MÊME signature à la même seconde — une signature capturée sur l'un
 *    ouvre l'autre. Lier l'opération ferme la classe entière du rejeu inter-endpoints.
 *
 * 2. **`op` est un identifiant stable, PAS le chemin d'URL.** Signer le chemin
 *    paraîtrait plus naturel, mais rendrait la crypto dépendante du routage : un
 *    préfixe ajouté ou retiré par Traefik (ou par `API_BASE_PATH` côté Maestroo) ferait
 *    échouer toutes les signatures — panne totale, silencieuse, et très difficile à
 *    diagnostiquer. On a déjà vu ce type de surprise de routage en prod
 *    (incident Traefik du 2026-07-21). L'émetteur ET le récepteur codent en dur la même
 *    constante `op` pour une route donnée ; le récepteur n'accepte JAMAIS un `op` fourni
 *    par l'appelant, il utilise le sien. L'attaquant n'a donc aucune prise dessus.
 */
export function buildCanonicalString(input: PartnerSignatureInput): string {
  return `${input.timestamp}.${input.method.toUpperCase()}.${input.op}.${input.rawBody}`;
}

/** Calcule la signature hexadécimale (minuscules) d'une chaîne canonique. */
export function computePartnerSignature(secret: string, input: PartnerSignatureInput): string {
  return createHmac('sha256', secret).update(buildCanonicalString(input)).digest('hex');
}

export interface PartnerSignatureHeaders {
  'X-Partner-Timestamp': string;
  'X-Partner-Signature': string;
}

/**
 * Signe une requête sortante. `now` est injectable pour les tests — jamais pour la prod.
 */
export function signPartnerRequest(
  secret: string,
  input: Omit<PartnerSignatureInput, 'timestamp'>,
  now: Date = new Date(),
): PartnerSignatureHeaders {
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  return {
    'X-Partner-Timestamp': timestamp,
    'X-Partner-Signature': computePartnerSignature(secret, { ...input, timestamp }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Énoncé de révocation SIGNÉ (incr. 0.7)
// ─────────────────────────────────────────────────────────────────────────────

export type RevocationEvent = 'LINK_REVOKED' | 'LINK_SUSPENDED';

export interface RevocationStatement {
  event: RevocationEvent;
  linkId: string;
  /** ISO-8601. */
  at: string;
  nonce: string;
  signature: string;
}

/**
 * ⚠️ LA brique du kill-switch. Un simple code HTTP 403 ne doit JAMAIS déclencher de
 * purge : pendant l'incident Traefik du 2026-07-21, un routeur mal configuré renvoyait
 * un `404 page not found` indiscernable d'un 404 applicatif. Si « 4xx ⇒ purge » était
 * la règle, une panne d'infrastructure effacerait les données de TOUS les clients.
 *
 * Seul un énoncé SIGNÉ avec le secret de plateforme prouve que c'est bien Tracky qui
 * a décidé de couper. Un proxy, un pare-feu ou un load-balancer ne peuvent pas le
 * fabriquer.
 */
export function buildRevocationStatement(
  secret: string,
  input: { event: RevocationEvent; linkId: string; at: string; nonce: string },
): RevocationStatement {
  return { ...input, signature: revocationSignature(secret, input) };
}

/** Lève `PartnerSignatureError` si l'énoncé n'est pas authentique. */
export function verifyRevocationStatement(secret: string, statement: Partial<RevocationStatement>): void {
  if (!secret) throw new PartnerSignatureError('missing_headers', { reason: 'secret_not_configured' });
  // `statement` vient du fil : il peut être null, une chaîne, un tableau… On le
  // valide AVANT de le déstructurer, sinon un `null` produirait un TypeError au
  // lieu du refus propre attendu par l'appelant.
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    throw new PartnerSignatureError('missing_headers', { reason: 'not_an_object' });
  }
  const { event, linkId, at, nonce, signature } = statement;
  if (!event || !linkId || !at || !nonce || !signature) {
    throw new PartnerSignatureError('missing_headers', { reason: 'incomplete_statement' });
  }
  if (event !== 'LINK_REVOKED' && event !== 'LINK_SUSPENDED') {
    throw new PartnerSignatureError('signature_mismatch', { reason: 'unknown_event' });
  }
  if (!HEX_64.test(signature)) throw new PartnerSignatureError('malformed_signature');

  const expected = Buffer.from(revocationSignature(secret, { event, linkId, at, nonce }), 'hex');
  const provided = Buffer.from(signature.toLowerCase(), 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new PartnerSignatureError('signature_mismatch');
  }
}

function revocationSignature(
  secret: string,
  input: { event: string; linkId: string; at: string; nonce: string },
): string {
  return createHmac('sha256', secret)
    .update(`${input.event}.${input.linkId}.${input.at}.${input.nonce}`)
    .digest('hex');
}

export interface VerifyPartnerRequestInput extends Omit<PartnerSignatureInput, 'timestamp'> {
  /** En-tête `X-Partner-Timestamp` reçu (peut être absent → `missing_headers`). */
  timestamp: string | undefined;
  /** En-tête `X-Partner-Signature` reçu. */
  signature: string | undefined;
  driftSeconds?: number;
  now?: Date;
}

/**
 * Vérifie une requête entrante. Lève `PartnerSignatureError` au premier échec.
 *
 * Ordre volontaire : présence → horodatage → forme → comparaison. On rejette sur des
 * critères bon marché avant de calculer un HMAC, et surtout on ne compare JAMAIS une
 * signature dont l'horodatage est déjà hors fenêtre.
 */
export function verifyPartnerRequest(secret: string, input: VerifyPartnerRequestInput): void {
  if (!secret) {
    // Secret non configuré = on rejette TOUT. Un secret vide ne doit jamais devenir
    // « pas de vérification » : ce serait une porte ouverte silencieuse.
    throw new PartnerSignatureError('missing_headers', { reason: 'secret_not_configured' });
  }
  if (!input.timestamp || !input.signature) {
    throw new PartnerSignatureError('missing_headers');
  }

  // parseInt('123abc') vaut 123 : on exige des chiffres uniquement, sinon un
  // horodatage bricolé passerait la validation.
  if (!/^\d+$/.test(input.timestamp)) {
    throw new PartnerSignatureError('invalid_timestamp');
  }
  const ts = Number.parseInt(input.timestamp, 10);
  if (!Number.isSafeInteger(ts)) {
    throw new PartnerSignatureError('invalid_timestamp');
  }

  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const drift = Math.abs(nowSec - ts);
  const maxDrift = input.driftSeconds ?? PARTNER_SIGNATURE_DRIFT_SECONDS;
  if (drift > maxDrift) {
    throw new PartnerSignatureError('timestamp_out_of_window', { drift, maxDrift });
  }

  // Valider la forme AVANT Buffer.from(..., 'hex') : sur une entrée invalide, Node
  // tronque SILENCIEUSEMENT au lieu de lever. Sans ce garde-fou, une signature
  // malformée deviendrait un simple `signature_mismatch` — même résultat ici, mais
  // on perdrait la distinction utile au diagnostic.
  if (!HEX_64.test(input.signature)) {
    throw new PartnerSignatureError('malformed_signature');
  }

  const expected = computePartnerSignature(secret, {
    method: input.method,
    op: input.op,
    rawBody: input.rawBody,
    timestamp: input.timestamp,
  });

  const provided = Buffer.from(input.signature.toLowerCase(), 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    throw new PartnerSignatureError('signature_mismatch');
  }
}

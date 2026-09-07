import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UN CODE POSÉ EXPLICITEMENT NE DOIT PAS ÊTRE ÉCRASÉ
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le filtre ne lisait que `body.error` — le libellé que Nest met dans SES propres exceptions
 * (« Forbidden »). Un service qui levait `new ForbiddenException({ code: 'CONSENT_REQUIRED' })`
 * voyait donc son code remplacé par `HttpStatus[403]`, soit `FORBIDDEN`. Le client recevait un
 * 403 indiscernable de tous les autres 403 du produit.
 *
 * ── DEUX GARDES DE SÉCURITÉ EN DÉPENDAIENT, ET TOUTES DEUX ÉTAIENT MUETTES ───────────────
 *
 *   · `ConsentGateInterceptor` → `CONSENT_REQUIRED` : l'écran de consentement ne s'ouvrait
 *     jamais depuis un appel HttpClient ;
 *   · `SecurityGateInterceptor` → `DEVICE_VERIFICATION_REQUIRED` : idem pour la vérification
 *     d'appareil.
 *
 * ⚠️ ET LE DÉFAUT ÉTAIT DOUBLÉ CÔTÉ WEB, où l'intercepteur lisait le code au mauvais niveau
 * de l'enveloppe. Deux erreurs qui se cachaient l'une l'autre : corriger une seule des deux
 * n'aurait rien changé au comportement, et aurait pu faire conclure que la piste était mauvaise.
 *
 * Conséquence observée le 2026-09-07 sur un compte DEPOT de production : l'espace dépôt, qui
 * ne pouvait plus distinguer ce 403 d'un retrait d'accès, affichait « Votre transporteur a
 * fermé cet accès. Contactez-le pour le rétablir. » On envoyait la personne appeler son
 * transporteur pour un accord qu'elle seule pouvait donner.
 */

/**
 * Capture ce que le filtre écrit dans la réponse.
 *
 * ⚠️ `await` SUR `catch` : le filtre est asynchrone — pour une erreur NON HTTP, il journalise
 * avant de répondre. Sans l'attendre, on lit la réponse avant qu'elle soit écrite, et le test
 * mesure un statut de zéro.
 */
async function capturer(exception: unknown): Promise<{ status: number; corps: Record<string, unknown> }> {
  let status = 0;
  let corps: Record<string, unknown> = {};
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const res: any = {
    status: (s: number) => { status = s; return res; },
    json: (c: Record<string, unknown>) => { corps = c; return res; },
    headersSent: false,
  };
  const req: any = { method: 'GET', url: '/api/depot/live', headers: {} };
  const host: any = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  };
  const filtre = new AllExceptionsFilter({ record: () => undefined, recordBackground: () => undefined } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  await filtre.catch(exception, host);
  return { status, corps };
}

/** Le code métier, lu à travers l'enveloppe `{ error: { code } }`. */
function code(corps: Record<string, unknown>): string | undefined {
  return (corps['error'] as { code?: string } | undefined)?.code;
}

describe('Filtre d’exceptions — le code métier survit', () => {
  /**
   * 🔴 LE TEST DE RÉGRESSION. Sans le correctif, ce code vaut `FORBIDDEN` et l'écran de
   * consentement ne s'ouvre jamais.
   */
  it('🔴 `CONSENT_REQUIRED` arrive intact au client', async () => {
    const { status, corps } = await capturer(
      new ForbiddenException({ code: 'CONSENT_REQUIRED', message: 'Consentement requis.' }),
    );

    expect(status).toBe(HttpStatus.FORBIDDEN);
    expect(code(corps)).toBe('CONSENT_REQUIRED');
  });

  it('`DEVICE_VERIFICATION_REQUIRED` aussi — c’est la seconde garde', async () => {
    const { corps } = await capturer(
      new ForbiddenException({ code: 'DEVICE_VERIFICATION_REQUIRED', message: 'Vérification requise.' }),
    );

    expect(code(corps)).toBe('DEVICE_VERIFICATION_REQUIRED');
  });

  it('le message explicite est servi, pas celui de Nest', async () => {
    const { corps } = await capturer(
      new ForbiddenException({ code: 'CONSENT_REQUIRED', message: 'Consentement requis pour accéder au service.' }),
    );

    expect((corps['error'] as { message?: string }).message)
      .toBe('Consentement requis pour accéder au service.');
  });

  /**
   * ⚠️ LE TÉMOIN. Les exceptions natives de Nest portent `{ statusCode, message, error }` et
   * AUCUN `code` : elles doivent garder exactement le comportement d'avant. Sans ce test, on
   * pourrait « corriger » en lisant `code` seul et casser tout le reste du produit.
   */
  it('une exception Nest ordinaire garde son code d’origine', async () => {
    expect(code((await capturer(new NotFoundException('Trajet introuvable'))).corps)).toBe('Not Found');
    expect(code((await capturer(new BadRequestException('Paramètre invalide'))).corps)).toBe('Bad Request');
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * ET LES CHAMPS QUI PORTENT LE MOTIF
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * Le filtre ne servait que `{ code, message, requestId }` : tout autre champ de la charge
   * utile disparaissait sans bruit. `missions.service.ts` refuse un créneau pris en joignant
   * la plaque et la mission qui bloque — et le dialogue d'agenda, faute de les recevoir,
   * retombait sur « La mission n'a pas pu être créée. » : un refus sans raison.
   */
  it('🔴 les champs métier d’une charge utile explicite arrivent au client', async () => {
    const { status, corps } = await capturer(
      new ConflictException({
        code: 'MISSION_SLOT_CONFLICT',
        vehiclePlate: 'FM-772-JH',
        conflictingMission: { ref: 'M-241', startAt: '2026-09-08T08:00:00.000Z', endAt: '2026-09-08T11:30:00.000Z' },
      }),
    );

    expect(status).toBe(HttpStatus.CONFLICT);
    const err = corps['error'] as Record<string, unknown>;
    expect(err['code']).toBe('MISSION_SLOT_CONFLICT');
    expect(err['vehiclePlate']).toBe('FM-772-JH');
    expect((err['conflictingMission'] as { ref?: string }).ref).toBe('M-241');
  });

  /**
   * ⚠️ LE GARDE-FOU CONTRE LA FUITE. Sans `code` explicite, RIEN ne passe. C'est ce qui
   * distingue une charge utile écrite pour le client de l'emballage interne de Nest — et ce
   * qui empêche cette ouverture de laisser filer un détail que personne n'a voulu exposer.
   */
  it('une charge utile SANS code ne laisse rien passer', async () => {
    const { corps } = await capturer(
      new BadRequestException({ message: 'Paramètre invalide', internalHint: 'table users, colonne fleetId' }),
    );

    const err = corps['error'] as Record<string, unknown>;
    expect(err['internalHint']).toBeUndefined();
    expect(Object.keys(err).sort()).toEqual(['code', 'message', 'requestId']);
  });

  /**
   * ⚠️ ET UNE CHARGE UTILE NE PEUT PAS MASQUER LES CLÉS DU FILTRE. `requestId` est la seule
   * trace qui relie l'erreur vue par l'utilisateur à sa ligne de journal : la laisser
   * réécrire rendrait un incident intraçable, exactement quand on en a besoin.
   */
  it('les clés du filtre ne peuvent pas être réécrites', async () => {
    const { corps } = await capturer(
      new ForbiddenException({
        code: 'CONSENT_REQUIRED',
        message: 'Consentement requis.',
        requestId: 'usurpé',
        statusCode: 200,
        error: 'usurpé',
      }),
    );

    const err = corps['error'] as Record<string, unknown>;
    expect(err['requestId']).not.toBe('usurpé');
    expect(err['code']).toBe('CONSENT_REQUIRED');
    expect(err['statusCode']).toBeUndefined();
  });

  it('une erreur non HTTP reste une erreur serveur', async () => {
    const { status, corps } = await capturer(new Error('boum'));

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(code(corps)).toBe('INTERNAL_SERVER_ERROR');
    // ⚠️ Et son message n'est PAS divulgué : « boum » pourrait porter un détail interne.
    expect((corps['error'] as { message?: string }).message).toBe('Internal server error');
  });
});

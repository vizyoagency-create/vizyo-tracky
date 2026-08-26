import {
  confirmationDeCommande,
  ventilerConfirmations,
  LIBELLE_CONFIRMATION,
} from './confirmation-commande';

/**
 * TRK-051 — « ACKNOWLEDGED » ne veut pas dire « acquitté par le boîtier ».
 *
 * Ces tests fixent la seule question qui compte pour un lecteur : COMBIEN DE BOÎTIERS ONT
 * RÉPONDU ? Avant ce correctif, la réponse lue à l'écran et dans la collecte était le nombre
 * de lignes `ACKNOWLEDGED` — soit 120 le 2026-08-26, là où la vraie réponse est 2.
 */
describe('TRK-051 — confirmation d une commande boîtier', () => {
  describe('confirmationDeCommande', () => {
    it('rend BOITIER quand une trame de réponse est réellement revenue', () => {
      expect(
        confirmationDeCommande({
          status: 'ACKNOWLEDGED',
          ackResponse: 'imei:864035054756789,tracker,260824055128,100%,F,055128.000,',
        }),
      ).toBe('BOITIER');
    });

    /**
     * 🔴 LE CŒUR DE LA FICHE. Cette ligne est le cas réel des 118 `fix_continuous` du 25/08 :
     * statut `ACKNOWLEDGED`, et le texte de la commande elle-même dit « sans accusé de
     * réception du boîtier ». Un lecteur qui agrège le statut la compte comme un acquittement.
     */
    it('rend MESURE pour un ACKNOWLEDGED SANS réponse du boîtier (clôture par échéance)', () => {
      expect(
        confirmationDeCommande({ status: 'ACKNOWLEDGED', ackResponse: null }),
      ).toBe('MESURE');
    });

    it('ne se laisse pas prendre à une réponse vide ou blanche — ce n est pas une preuve', () => {
      expect(confirmationDeCommande({ status: 'ACKNOWLEDGED', ackResponse: '' })).toBe('MESURE');
      expect(confirmationDeCommande({ status: 'ACKNOWLEDGED', ackResponse: '   ' })).toBe('MESURE');
    });

    it('rend null pour tout ce qui n est pas confirmé', () => {
      for (const status of ['PENDING', 'SENT', 'FAILED', 'CANCELLED', 'SCHEDULED']) {
        expect(confirmationDeCommande({ status, ackResponse: null })).toBeNull();
      }
    });

    /**
     * Un FAILED qui porte quand même une réponse de boîtier reste une PREUVE que le boîtier a
     * parlé — la question posée est « qui a répondu ? », pas « la commande a-t-elle réussi ? ».
     */
    it('reconnaît une réponse du boîtier même sur une commande en échec', () => {
      expect(confirmationDeCommande({ status: 'FAILED', ackResponse: 'imei:…,ack' })).toBe('BOITIER');
    });

    it('traite ackResponse absent (undefined) comme une absence de preuve', () => {
      expect(confirmationDeCommande({ status: 'ACKNOWLEDGED' })).toBe('MESURE');
      expect(confirmationDeCommande({ status: 'SENT' })).toBeNull();
    });
  });

  describe('ventilerConfirmations', () => {
    /**
     * Le lot exact mesuré en production le 2026-08-26 sur 7 jours, réduit à l échelle :
     * 120 ACKNOWLEDGED dont 2 seulement portent une vraie réponse.
     */
    it('sépare les 2 vraies réponses des 118 clôtures par mesure', () => {
      const lot = [
        ...Array.from({ length: 2 }, () => ({ status: 'ACKNOWLEDGED', ackResponse: 'imei:…,ack' })),
        ...Array.from({ length: 118 }, () => ({ status: 'ACKNOWLEDGED', ackResponse: null })),
        ...Array.from({ length: 396 }, () => ({ status: 'FAILED', ackResponse: null })),
      ];

      const v = ventilerConfirmations(lot);

      expect(v.total).toBe(516);
      // ⚠️ LA question de TRK-051 : combien de boîtiers ont répondu ?
      expect(v.acquitteesBoitier).toBe(2);
      expect(v.cibleAtteinteMesuree).toBe(118);
      expect(v.nonConfirmees).toBe(396);
      // Et le comptage naïf qu on remplace aurait rendu 120.
      expect(lot.filter((c) => c.status === 'ACKNOWLEDGED').length).toBe(120);
    });

    it('rend des compteurs cohérents : la somme des trois vaut le total', () => {
      const lot = [
        { status: 'ACKNOWLEDGED', ackResponse: 'x' },
        { status: 'ACKNOWLEDGED', ackResponse: null },
        { status: 'SENT', ackResponse: null },
        { status: 'FAILED', ackResponse: null },
      ];
      const v = ventilerConfirmations(lot);
      expect(v.acquitteesBoitier + v.cibleAtteinteMesuree + v.nonConfirmees).toBe(v.total);
    });

    it('accepte un lot vide sans inventer de confirmation', () => {
      expect(ventilerConfirmations([])).toEqual({
        total: 0,
        acquitteesBoitier: 0,
        cibleAtteinteMesuree: 0,
        nonConfirmees: 0,
      });
    });
  });

  /**
   * Le mot « acquittée » porte la confusion de TRK-051 : il ne doit apparaître QUE sur le cas
   * matériel. Ce test empêche qu un futur libellé le réintroduise sur le cas mesuré.
   */
  it('réserve le mot « acquittée » au seul cas matériel', () => {
    expect(LIBELLE_CONFIRMATION.BOITIER.toLowerCase()).toContain('acquittée');
    expect(LIBELLE_CONFIRMATION.MESURE.toLowerCase()).not.toContain('acquittée');
    expect(LIBELLE_CONFIRMATION.MESURE.toLowerCase()).toContain('sans accusé');
  });
});

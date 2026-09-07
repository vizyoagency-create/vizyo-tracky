import { ConflictException, NotFoundException } from '@nestjs/common';
import { LiensPartagesAdminService } from './liens-partages-admin.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * PROLONGER UN ACCÈS PUBLIC — CE QUI EMPÊCHE « PROLONGER » DE DEVENIR « PUBLIER »
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'expiration était, jusqu'au 2026-09-07, « calculée à la création, jamais prolongeable ».
 * L'ouvrir répond à un besoin réel — le lien expire pendant que le destinataire dort, et
 * régénérer laisse l'ancien dans la nature en perdant son compteur de visites — mais déplace
 * la seule protection d'un accès sans mot de passe : l'horloge.
 *
 * ⚠️ CHAQUE TEST ICI VERROUILLE UNE DES TROIS RÈGLES QUI RENDENT CETTE OUVERTURE ACCEPTABLE.
 * Aucune ne se voit à l'écran ; leur régression se découvrirait le jour où un lien censé durer
 * 24 h se révélerait ouvert depuis un trimestre.
 */

const MAINTENANT = Date.parse('2026-09-07T12:00:00.000Z');
const HEURE = 3600_000;
const JOUR = 24 * HEURE;
const UTILISATEUR = { id: 'u-admin', email: 'admin@vizyoagency.com' };

interface Options {
  creeIlYaMs?: number;
  expireDansMs?: number;
  revoque?: boolean;
  absent?: boolean;
}

function service(o: Options = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lien = o.absent ? null : {
    id: 'lien-1',
    createdAt: new Date(MAINTENANT - (o.creeIlYaMs ?? HEURE)),
    expiresAt: new Date(MAINTENANT + (o.expireDansMs ?? 12 * HEURE)),
    revokedAt: o.revoque ? new Date(MAINTENANT - HEURE) : null,
    fleetId: 'flotte-1',
  };
  const update = jest.fn().mockResolvedValue({});
  const prisma: any = {
    tripShareLink: {
      findUnique: jest.fn().mockResolvedValue(lien),
      update,
      // `vue()` est rappelée en fin de prolongation pour rendre la ligne à jour : on lui sert
      // une liste vide, le test porte sur les règles, pas sur le rendu.
      findMany: jest.fn().mockResolvedValue([]),
    },
    missionShareLink: {
      findUnique: jest.fn().mockResolvedValue(lien),
      update,
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const activite: any = { record: jest.fn() };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { svc: new LiensPartagesAdminService(prisma, activite), update, activite, prisma };
}

describe('Prolongation d’un lien de partage', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(MAINTENANT));
  afterEach(() => jest.useRealTimers());

  /**
   * ⚠️ RÈGLE 1 — UN LIEN RÉVOQUÉ NE SE PROLONGE PAS.
   *
   * La révocation est une DÉCISION prise par quelqu'un. La défaire par une prolongation la
   * transformerait en accident réversible : « j'ai coupé cet accès » cesserait d'être vrai.
   */
  it('🔴 refuse de prolonger un lien révoqué', async () => {
    const { svc, update } = service({ revoque: true });

    await expect(svc.prolonger('TRAJET', 'lien-1', 'HOUR_24', UTILISATEUR))
      .rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ RÈGLE 2 — UN LIEN EXPIRÉ, LUI, SE PROLONGE, ET LE COMPTE REPART DE MAINTENANT.
   *
   * C'est le cas d'usage principal. Repartir de l'ancienne échéance donnerait une date déjà
   * passée : on aurait « prolongé » un lien qui reste mort, sans que rien ne le signale.
   */
  it('🔴 prolonge un lien EXPIRÉ en comptant depuis maintenant, pas depuis l’ancienne échéance', async () => {
    const { svc, update } = service({ creeIlYaMs: 4 * JOUR, expireDansMs: -3 * JOUR });

    await svc.prolonger('TRAJET', 'lien-1', 'HOUR_24', UTILISATEUR).catch(() => undefined);

    const data = update.mock.calls[0]![0].data;
    expect(data.expiresAt.getTime()).toBe(MAINTENANT + JOUR);
  });

  it('un lien encore actif est repoussé depuis SON échéance, pas depuis maintenant', async () => {
    // Sinon prolonger de 24 h un lien qui en a encore 12 le RACCOURCIRAIT de 12 h.
    const { svc, update } = service({ expireDansMs: 12 * HEURE });

    await svc.prolonger('TRAJET', 'lien-1', 'HOUR_24', UTILISATEUR).catch(() => undefined);

    expect(update.mock.calls[0]![0].data.expiresAt.getTime()).toBe(MAINTENANT + 12 * HEURE + JOUR);
  });

  /**
   * ⚠️ RÈGLE 3 — LE PLAFOND DE VIE TOTALE, 30 JOURS DEPUIS LA CRÉATION.
   *
   * Sans borne, trois clics suffisent pour qu'un lien de 24 h vive un trimestre : « prolonger »
   * deviendrait « publier ». Compté depuis la CRÉATION — depuis la dernière prolongation, il
   * suffirait de repousser régulièrement pour ne jamais l'atteindre.
   */
  it('🔴 refuse la prolongation qui ferait dépasser 30 jours de vie totale', async () => {
    const { svc, update } = service({ creeIlYaMs: 28 * JOUR, expireDansMs: HEURE });

    // 28 j + 1 h + 7 j dépasse le plafond : refus.
    await expect(svc.prolonger('TRAJET', 'lien-1', 'DAY_7', UTILISATEUR))
      .rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it('accepte celle qui reste sous le plafond', async () => {
    // Le témoin : sans lui, un plafond réglé trop bas refuserait TOUT et le test précédent
    // passerait quand même.
    const { svc, update } = service({ creeIlYaMs: 28 * JOUR, expireDansMs: HEURE });

    await svc.prolonger('TRAJET', 'lien-1', 'HOUR_24', UTILISATEUR).catch(() => undefined);

    expect(update).toHaveBeenCalled();
  });

  /**
   * ⚠️ LA TRACE EST LA CONTREPARTIE DE L'OUVERTURE. Sans compteur ni auteur, une échéance
   * repoussée trois fois est indiscernable d'une échéance d'origine — et l'écran de
   * surveillance ne surveille plus rien.
   */
  it('incrémente le compteur et inscrit qui a prolongé, et quand', async () => {
    const { svc, update, activite } = service();

    await svc.prolonger('TRAJET', 'lien-1', 'HOUR_24', UTILISATEUR).catch(() => undefined);

    const data = update.mock.calls[0]![0].data;
    expect(data.extendedCount).toEqual({ increment: 1 });
    expect(data.lastExtendedById).toBe('u-admin');
    expect(data.lastExtendedAt.getTime()).toBe(MAINTENANT);
    expect(activite.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'share_link_extended', triggeredByUserId: 'u-admin' }),
    );
  });

  it('un lien inconnu est un 404, pas une prolongation silencieuse', async () => {
    const { svc } = service({ absent: true });

    await expect(svc.prolonger('MISSION', 'inexistant', 'HOUR_1', UTILISATEUR))
      .rejects.toThrow(NotFoundException);
  });
});

describe('Révocation depuis la vue d’ensemble', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(MAINTENANT));
  afterEach(() => jest.useRealTimers());

  it('coupe le lien et inscrit qui l’a coupé', async () => {
    const { svc, update, activite } = service();

    await svc.revoquer('TRAJET', 'lien-1', UTILISATEUR);

    expect(update.mock.calls[0]![0].data.revokedByUserId).toBe('u-admin');
    expect(activite.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'share_link_revoked' }),
    );
  });

  /**
   * ⚠️ IDEMPOTENT. Le geste vise un RÉSULTAT (« que ce lien ne serve plus »), pas une
   * transition d'état : échouer parce que quelqu'un d'autre a coupé une seconde plus tôt
   * n'aiderait personne, et ferait croire que l'accès est encore ouvert.
   */
  it('révoquer un lien déjà révoqué ne fait rien, et ne lève pas', async () => {
    const { svc, update } = service({ revoque: true });

    await expect(svc.revoquer('TRAJET', 'lien-1', UTILISATEUR)).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });
});

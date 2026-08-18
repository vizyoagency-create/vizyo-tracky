import { ConflictException, NotFoundException } from '@nestjs/common';
import { RattachementService } from './rattachement.service';

const IMEI = '864035054756409';
const MSISDN = '+345901035259762';
const FLOTTE_A = 'flotte-a';
const FLOTTE_B = 'flotte-b';
const INSTALLATEUR = { userId: 'u1', email: 'inst@exemple.fr', role: 'FLEET_ADMIN', fleetId: FLOTTE_A };

function service(opts: {
  vehicule?: Record<string, unknown> | null;
  trackerExistant?: Record<string, unknown> | null;
  inconnus?: string[];
  positions?: number;
  trackerParId?: Record<string, unknown> | null;
}) {
  const creer = jest.fn().mockResolvedValue({ id: 't-neuf', imei: IMEI });
  const majTracker = jest.fn().mockResolvedValue({ id: 't-exist', imei: IMEI });
  const prisma = {
    vehicle: { findUnique: jest.fn().mockResolvedValue(opts.vehicule ?? null) },
    tracker: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { imei?: string; id?: string } }) =>
        Promise.resolve(where.imei ? opts.trackerExistant ?? null : opts.trackerParId ?? null),
      ),
      create: creer,
      update: majTracker,
    },
    position: { count: jest.fn().mockResolvedValue(opts.positions ?? 0) },
  };
  const inconnus = {
    list: jest.fn().mockReturnValue((opts.inconnus ?? []).map((i) => ({ imei: i }))),
  };
  const systemActivity = { record: jest.fn() };
  const events = { emit: jest.fn() };
  return {
    svc: new RattachementService(prisma as never, inconnus as never, systemActivity as never, events as never),
    creer,
    majTracker,
    systemActivity,
    events,
  };
}

const VEHICULE_LIBRE = { id: 'v1', plate: 'FL-787-KV', fleetId: FLOTTE_A, tracker: null };

describe('Rattachement — declarer le boitier, meme s’il se tait', () => {
  it('cree le boitier et le monte sur le vehicule', async () => {
    const { svc, creer, events } = service({ vehicule: VEHICULE_LIBRE });
    const r = await svc.rattacher({ vehicleId: 'v1', imei: IMEI, msisdn: MSISDN, demandeur: INSTALLATEUR });

    expect(r.cree).toBe(true);
    expect(r.vehiculePlaque).toBe('FL-787-KV');
    expect(creer).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ imei: IMEI, vehicleId: 'v1', simPhoneNumber: MSISDN, model: '403C' }),
      }),
    );
    // ⚠️ Sans cet evenement, l'allowlist ignore le numero et le premier SMS part en 403 —
    // le mecanisme exact des 1476 rejets de juillet.
    expect(events.emit).toHaveBeenCalledWith('tracker.sim-changed', { imei: IMEI });
  });

  it('reutilise un boitier deja declare mais libre', async () => {
    const { svc, creer, majTracker } = service({
      vehicule: VEHICULE_LIBRE,
      trackerExistant: { id: 't-exist', vehicleId: null },
    });
    const r = await svc.rattacher({ vehicleId: 'v1', imei: IMEI, msisdn: null, demandeur: INSTALLATEUR });
    expect(r.cree).toBe(false);
    expect(creer).not.toHaveBeenCalled();
    expect(majTracker).toHaveBeenCalled();
  });

  it('journalise au systeme : qui a rattache quoi, et sur quoi', async () => {
    const { svc, systemActivity } = service({ vehicule: VEHICULE_LIBRE });
    await svc.rattacher({ vehicleId: 'v1', imei: IMEI, msisdn: MSISDN, demandeur: INSTALLATEUR });
    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'boitier_rattache', actor: 'inst@exemple.fr' }),
    );
  });

  it('refuse un IMEI qui n’a pas 15 chiffres', async () => {
    const { svc } = service({ vehicule: VEHICULE_LIBRE });
    await expect(
      svc.rattacher({ vehicleId: 'v1', imei: '8640350547564', msisdn: null, demandeur: INSTALLATEUR }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('Rattachement — ce qu’on refuse', () => {
  it('un vehicule qui porte deja un AUTRE boitier', async () => {
    const { svc } = service({
      vehicule: { ...VEHICULE_LIBRE, tracker: { id: 't9', imei: '864035053276839' } },
    });
    await expect(
      svc.rattacher({ vehicleId: 'v1', imei: IMEI, msisdn: null, demandeur: INSTALLATEUR }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un boitier deja monte sur un autre vehicule', async () => {
    const { svc } = service({
      vehicule: VEHICULE_LIBRE,
      trackerExistant: { id: 't-exist', vehicleId: 'v-autre' },
    });
    await expect(
      svc.rattacher({ vehicleId: 'v1', imei: IMEI, msisdn: null, demandeur: INSTALLATEUR }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('⚠️ le vehicule d’une AUTRE societe : introuvable, pas « interdit »', async () => {
    // Repondre « interdit » confirmerait l'existence du vehicule a un tiers.
    const { svc } = service({ vehicule: { ...VEHICULE_LIBRE, fleetId: FLOTTE_B } });
    await expect(
      svc.rattacher({ vehicleId: 'v1', imei: IMEI, msisdn: null, demandeur: INSTALLATEUR }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('le super-admin, lui, traverse les societes', async () => {
    const { svc } = service({ vehicule: { ...VEHICULE_LIBRE, fleetId: FLOTTE_B } });
    const r = await svc.rattacher({
      vehicleId: 'v1',
      imei: IMEI,
      msisdn: null,
      demandeur: { ...INSTALLATEUR, role: 'SUPER_ADMIN', fleetId: null },
    });
    expect(r.cree).toBe(true);
  });
});

/**
 * ── L'ATTENTE DOIT SAVOIR DIRE QU'ELLE EST VAINE ─────────────────────────────────────
 *
 * Un boîtier qui continue de frapper en tant qu'INCONNU après le rattachement dit que
 * l'IMEI déclaré n'est pas le sien — un chiffre de travers, comme les quatre fiches
 * fautives trouvées dans ce parc. Sans ce signal, l'écran afficherait « en attente »
 * indéfiniment et personne ne saurait qu'il attend pour rien.
 */
describe('Rattachement — l’etat de l’attente', () => {
  it('boitier jamais vu : on attend', async () => {
    const { svc } = service({ trackerParId: { imei: IMEI, status: 'OFFLINE', lastSeenAt: null } });
    const e = await svc.attente('t1');
    expect(e.connecte).toBe(false);
    expect(e.encoreInconnu).toBe(false);
  });

  it('boitier connecte : on a gagne', async () => {
    const vu = new Date();
    const { svc } = service({
      trackerParId: { imei: IMEI, status: 'ONLINE', lastSeenAt: vu },
      positions: 2,
    });
    const e = await svc.attente('t1');
    expect(e.connecte).toBe(true);
    expect(e.positions).toBe(2);
    expect(e.derniereVueIso).toBe(vu.toISOString());
  });

  it('⚠️ toujours refuse en TCP apres rattachement : l’IMEI declare est faux', async () => {
    const { svc } = service({
      trackerParId: { imei: IMEI, status: 'OFFLINE', lastSeenAt: null },
      inconnus: [IMEI],
    });
    const e = await svc.attente('t1');
    expect(e.encoreInconnu).toBe(true);
  });
});

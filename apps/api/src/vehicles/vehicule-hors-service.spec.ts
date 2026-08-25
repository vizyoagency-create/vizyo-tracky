import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { VehiclesService } from './vehicles.service';

/**
 * ── VÉHICULES HORS SERVICE — l'interrupteur des cas spéciaux ─────────────────────────
 *
 * Un véhicule qui ne roule plus (accident, boîtier débranché, immobilisation) reste sinon dans
 * le périmètre de tous les traitements de fond : il y produit du travail impossible et des
 * alertes vraies-mais-inutiles. Mesure du 2026-08-21 sur KSR370, accidenté : 843 trajets à
 * re-segmenter et 1 309 à analyser — 99 % du reste-à-faire de TOUTE la flotte pour un seul
 * véhicule immobilisé. Les compteurs de convergence ne voulaient plus rien dire.
 *
 * Ce que ces tests protègent, dans l'ordre d'importance :
 *   1. l'état est RÉSERVÉ au super-admin — il fait taire des alertes ;
 *   2. on peut toujours en SORTIR (un interrupteur qu'on ne sait pas éteindre ne sera plus
 *      jamais allumé) ;
 *   3. corriger une note ne réécrit pas la date de mise hors service ;
 *   4. la bascule est journalisée — sinon on saurait qu'un véhicule est muet sans savoir
 *      sur décision de qui.
 */
function build(vehiculeExistant: Record<string, unknown> | null = {
  id: 'v1', plate: 'KSR370', fleetId: 'f1', outOfServiceReason: null,
}) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue(vehiculeExistant),
      update,
      // `findOne` relit la fiche complète après la mise à jour.
      findFirst: jest.fn().mockResolvedValue({ id: 'v1', plate: 'KSR370', fleetId: 'f1', groups: [] }),
    },
  };
  const cache = { invalidate: jest.fn(), get: jest.fn(), set: jest.fn() };
  const systemActivity = { record: jest.fn() };
  const svc = new VehiclesService(
    prisma as never, cache as never, {} as never, systemActivity as never,
    // TRK-046 — GpsDeadZonesService : aucune zone dans ces scénarios hors-service.
    { zonesParkingParVehicule: jest.fn().mockResolvedValue(new Map()), matchAmong: jest.fn().mockReturnValue(null) } as never,
  );
  return { svc, prisma, cache, systemActivity, update };
}

const SUPER = { userId: 'u-super', role: UserRole.SUPER_ADMIN, fleetId: null };
const ADMIN_FLOTTE = { userId: 'u-fa', role: UserRole.FLEET_ADMIN, fleetId: 'f1' };

describe('Véhicule hors service — qui peut, et que se passe-t-il', () => {
  it('⚠️ un FLEET_ADMIN ne peut PAS : cet état fait taire des alertes', async () => {
    const { svc, update } = build();

    await expect(
      svc.setOutOfService('v1', { reason: 'ACCIDENT' }, ADMIN_FLOTTE as never),
    ).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('un véhicule inconnu répond 404 et n’écrit rien', async () => {
    const { svc, update } = build(null);

    await expect(
      svc.setOutOfService('inconnu', { reason: 'ACCIDENT' }, SUPER as never),
    ).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('le super-admin déclare l’accident : motif, date, auteur et note sont posés', async () => {
    const { svc, update } = build();

    await svc.setOutOfService('v1', { reason: 'ACCIDENT', note: '  choc arrière le 18/08  ' }, SUPER as never);

    const data = update.mock.calls[0]![0].data;
    expect(data.outOfServiceReason).toBe('ACCIDENT');
    expect(data.outOfServiceById).toBe('u-super');
    expect(data.outOfServiceNote).toBe('choc arrière le 18/08'); // rogné
    expect(data.outOfServiceSince).toBeInstanceOf(Date);
  });

  it('⚠️ ON PEUT TOUJOURS EN SORTIR : reason null remet en service et efface l’état', async () => {
    const { svc, update } = build({ id: 'v1', plate: 'KSR370', fleetId: 'f1', outOfServiceReason: 'ACCIDENT' });

    await svc.setOutOfService('v1', { reason: null }, SUPER as never);

    const data = update.mock.calls[0]![0].data;
    expect(data.outOfServiceReason).toBeNull();
    expect(data.outOfServiceSince).toBeNull();
    expect(data.outOfServiceById).toBeNull();
    expect(data.outOfServiceNote).toBeNull();
  });

  it('⚠️ corriger la NOTE ne réécrit pas la date : le véhicule n’est pas immobilisé de nouveau', async () => {
    const { svc, update } = build({ id: 'v1', plate: 'KSR370', fleetId: 'f1', outOfServiceReason: 'ACCIDENT' });

    await svc.setOutOfService('v1', { reason: 'ACCIDENT', note: 'dossier AX-42' }, SUPER as never);

    const data = update.mock.calls[0]![0].data;
    expect(data.outOfServiceNote).toBe('dossier AX-42');
    expect('outOfServiceSince' in data).toBe(false); // la date n'est pas touchée
  });

  it('changer de motif REDATE, lui — c’est un nouvel événement', async () => {
    const { svc, update } = build({ id: 'v1', plate: 'KSR370', fleetId: 'f1', outOfServiceReason: 'IMMOBILIZED' });

    await svc.setOutOfService('v1', { reason: 'ACCIDENT' }, SUPER as never);

    expect(update.mock.calls[0]![0].data.outOfServiceSince).toBeInstanceOf(Date);
  });

  it('une note vide ou blanche vaut « pas de note », pas une chaîne vide en base', async () => {
    const { svc, update } = build();
    await svc.setOutOfService('v1', { reason: 'IMMOBILIZED', note: '   ' }, SUPER as never);
    expect(update.mock.calls[0]![0].data.outOfServiceNote).toBeNull();
  });

  it('⚠️ la bascule est JOURNALISÉE — sinon un véhicule muet sans décideur identifiable', async () => {
    const { svc, systemActivity } = build();

    await svc.setOutOfService('v1', { reason: 'TRACKER_UNPLUGGED' }, SUPER as never);

    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vehicle_out_of_service',
        target: 'KSR370',
        meta: expect.objectContaining({ vehicleId: 'v1', reason: 'TRACKER_UNPLUGGED' }),
      }),
    );
  });

  it('la remise en service est journalisée sous une action DISTINCTE', async () => {
    const { svc, systemActivity } = build({ id: 'v1', plate: 'KSR370', fleetId: 'f1', outOfServiceReason: 'ACCIDENT' });

    await svc.setOutOfService('v1', { reason: null }, SUPER as never);

    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'vehicle_back_in_service' }),
    );
  });

  it('les compteurs du tableau de bord sont invalidés — sinon l’écran ment jusqu’au TTL', async () => {
    const { svc, cache } = build();
    await svc.setOutOfService('v1', { reason: 'ACCIDENT' }, SUPER as never);
    expect(cache.invalidate).toHaveBeenCalled();
  });
});

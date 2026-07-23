import { PartnerLinkStatus } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { PartnerClientService } from './partner-client.service';
import type { PartnerConfigService } from './partner.config';
import type { PartnerInvitationService } from './partner-invitation.service';
import { PartnerSyncService } from './partner-sync.service';

function make(opts: {
  enabled?: boolean;
  links?: any[];
  seed?: any[];
  reseedThrows?: boolean;
  reseedSkipped?: boolean;
} = {}) {
  const prisma = {
    partnerLink: {
      findMany: jest.fn(async () => opts.links ?? []),
    },
  } as unknown as PrismaService;

  const client = {
    reseedVehicles: jest.fn(async () => {
      if (opts.reseedThrows) throw new Error('partenaire injoignable');
      return { created: 1, updated: 0, total: 1, skipped: opts.reseedSkipped ?? false };
    }),
  } as unknown as PartnerClientService;

  const invitations = {
    seedVehicles: jest.fn(async () => opts.seed ?? []),
  } as unknown as PartnerInvitationService;

  const config = { enabled: opts.enabled ?? true } as unknown as PartnerConfigService;
  const activity = { record: jest.fn() } as unknown as SystemActivityService;

  return {
    service: new PartnerSyncService(prisma, client, config, invitations, activity),
    client,
    invitations,
    activity,
  };
}

const LINK = { id: 'link-1', fleetId: 'fleet-1', scopes: ['VEHICLE_IDENTITY'] };

describe('PartnerSyncService — réconciliation périodique', () => {
  it('module éteint ⇒ ne fait RIEN', async () => {
    const { service, client } = make({ enabled: false, links: [LINK] });
    await service.reconcile();
    expect(client.reseedVehicles).not.toHaveBeenCalled();
  });

  it('re-pousse l\'identité des véhicules d\'un lien actif', async () => {
    const { service, client, activity } = make({
      links: [LINK],
      seed: [{ plate: 'AA-123-BB' }],
    });
    await service.reconcile();
    expect(client.reseedVehicles).toHaveBeenCalledWith('link-1', [{ plate: 'AA-123-BB' }]);
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'partner_vehicles_synced' }),
    );
  });

  it('scope VEHICLE_IDENTITY coupé (seed vide) ⇒ n\'appelle même pas le partenaire', async () => {
    // La synchro ne réenrichit jamais ce que le client a révoqué, et n'envoie
    // pas de bruit réseau pour une liste vide.
    const { service, client } = make({ links: [LINK], seed: [] });
    await service.reconcile();
    expect(client.reseedVehicles).not.toHaveBeenCalled();
  });

  it('un lien en PANNE n\'empêche pas les suivants', async () => {
    // Isolation : le premier lien jette, le second doit quand même être traité.
    const links = [
      { id: 'link-ko', fleetId: 'f-ko', scopes: ['VEHICLE_IDENTITY'] },
      { id: 'link-ok', fleetId: 'f-ok', scopes: ['VEHICLE_IDENTITY'] },
    ];
    let call = 0;
    const { service, client } = make({ links, seed: [{ plate: 'X' }] });
    (client.reseedVehicles as jest.Mock).mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('injoignable');
      return { created: 0, updated: 1, total: 1, skipped: false };
    });

    await service.reconcile();
    expect(client.reseedVehicles).toHaveBeenCalledTimes(2);
  });

  it('anti-recouvrement : un second passage concurrent est ignoré', async () => {
    // `@Cron` ne bloque pas le self-overlap tout seul — c'est le drapeau interne.
    const { service, client, invitations } = make({ links: [LINK], seed: [{ plate: 'A' }] });
    let resolveReseed!: () => void;
    (client.reseedVehicles as jest.Mock).mockImplementation(
      () => new Promise((r) => { resolveReseed = () => r({ created: 0, updated: 0, total: 0, skipped: false }); }),
    );

    const first = service.reconcile();
    // Laisse le premier passage avancer jusqu'à l'appel réseau (il await d'abord
    // findMany puis seedVehicles) avant de lancer le concurrent.
    await Promise.resolve();
    await Promise.resolve();
    await service.reconcile(); // pendant que le premier tourne encore
    // Le second n'a pas relu les liens : une seule passe active.
    expect(invitations.seedVehicles).toHaveBeenCalledTimes(1);
    resolveReseed();
    await first;
  });
});

import { Test } from '@nestjs/testing';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { TrackerFixModeService } from './tracker-fix-mode.service';

/**
 * TRK-057 — les cibles que personne n'a jamais demandees.
 *
 * `desiredIntervalFor` ne produit que TROIS valeurs. Toute autre en base est un residu de
 * l'ancien auto-alignement, qui inscrivait un echantillon unique (TRK-056). Mesure du 01/09 :
 * sur 44 boitiers, 40 portaient une valeur canonique et QUATRE portaient 21, 28, 43 et 56 s.
 */
describe('cibles canoniques (TRK-057)', () => {
  let service: TrackerFixModeService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerFixModeService,
        { provide: PrismaService, useValue: { tracker: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn(), updateMany: jest.fn() } } },
        { provide: SocketRegistryService, useValue: {} },
        { provide: CobanWireLogger, useValue: {} },
        { provide: SmsGatewayService, useValue: { isEnabled: () => false, send: jest.fn() } },
        { provide: AckWaiterService, useValue: { waitForAck: jest.fn() } },
      ],
    }).compile();
    service = module.get(TrackerFixModeService);
  });

  const gareDepuisLongtemps = {
    lastKnownIgnition: false,
    lastIgnitionChangeAt: new Date('2026-09-01T10:00:00Z'),
  };
  const MAINTENANT = new Date('2026-09-01T14:00:00Z');

  // 🔑 LE TEST QUI VERROUILLE LA LISTE. Si `desiredIntervalFor` gagne une valeur sans que
  // CIBLES_CANONIQUES la gagne aussi, la reparation se mettrait a corriger des cibles
  // parfaitement legitimes — le pire resultat possible pour un nettoyage.
  it('desiredIntervalFor ne produit QUE trois valeurs, et ce sont les canoniques', () => {
    const produites = new Set<number>();
    for (const etat of ['MOVING', 'IDLE_ENGINE_ON', 'STOPPED'] as const) {
      produites.add(service.desiredIntervalFor(etat, gareDepuisLongtemps, MAINTENANT));
      produites.add(
        service.desiredIntervalFor(etat, { lastKnownIgnition: true, lastIgnitionChangeAt: MAINTENANT }, MAINTENANT),
      );
    }
    expect([...produites].sort((a, b) => a - b)).toEqual([20, 30, 99]);
  });

  // ⚠️ ON RECALCULE, ON N'ARRONDIT PAS. Le cas reel HD-964-XY : cible 43, boitier a l'arret
  // contact coupe, emettant a 99 s. La valeur canonique la plus PROCHE serait 30 (|43-30|=13
  // contre |43-99|=56) — on aurait remplace une valeur fausse par une autre, et declenche une
  // commande vouee a l'echec.
  it('le cas HD-964-XY : recalculer donne 99, arrondir aurait donne 30', () => {
    const recalcule = service.desiredIntervalFor('STOPPED', gareDepuisLongtemps, MAINTENANT);
    expect(recalcule).toBe(99);

    const plusProche = [20, 30, 99].reduce((a, b) => (Math.abs(b - 43) < Math.abs(a - 43) ? b : a));
    expect(plusProche).toBe(30);
    expect(recalcule).not.toBe(plusProche);
  });

  it('un vehicule qui roule est ramene a 20 s, pas a la valeur la plus proche de sa derive', () => {
    expect(service.desiredIntervalFor('MOVING', gareDepuisLongtemps, MAINTENANT)).toBe(20);
  });

  it('un arret BREF garde 30 s — la cadence d economie ne s applique qu apres le delai de grace', () => {
    const arretRecent = { lastKnownIgnition: false, lastIgnitionChangeAt: new Date(MAINTENANT.getTime() - 60_000) };
    expect(service.desiredIntervalFor('STOPPED', arretRecent, MAINTENANT)).toBe(30);
  });
});

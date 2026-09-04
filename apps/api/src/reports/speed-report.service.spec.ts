/**
 * Lot V7 — LE RAPPORT DE VITESSE, pièce présentée par un employeur.
 *
 * Il comptait ses « excès » au-dessus d'un seuil FIXE de 90 km/h, sans jamais consulter la
 * limite légale de la voie. Un trajet entier sur une voie à 110 y affichait des dizaines
 * d'excès ; 80 km/h dans une zone 50 n'en produisait aucun. Ces tests protègent la règle qui
 * l'a remplacé — celle de l'analyse, partagée avec le replay et le PDF — et surtout ce que le
 * document doit RECONNAÎTRE ne pas savoir.
 */
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SpeedReportService } from './speed-report.service';

const TRIP_ID = '00000000-0000-0000-0000-0000000000t1';
const SUPER_ADMIN = { userId: 'sa', role: UserRole.SUPER_ADMIN, fleetId: null };

const T0 = new Date('2026-09-04T12:00:00.000Z');
const a = (secondes: number) => new Date(T0.getTime() + secondes * 1000);

const position = (secondes: number, speedKmh: number) => ({
  timestamp: a(secondes), speedKmh, lat: 43.6, lng: 1.4, valid: true, heading: 0, ignition: true,
});

const segment = (p: Record<string, unknown> = {}) => ({
  startAt: a(0).toISOString(), endAt: a(40).toISOString(), durationSec: 40,
  maxSpeedKmh: 125, limitKmh: 90, overKmh: 35, lat: 43.6, lng: 1.4,
  ...p,
});

interface Monde {
  positions?: ReturnType<typeof position>[];
  analyse?: Record<string, unknown> | null;
  maxSpeed?: number;
}

/** Le HTML avec ses retours à la ligne aplatis : on teste la PHRASE, pas sa mise en page. */
function prose(html: string): string {
  return html.replace(/\s+/g, ' ');
}

async function rapport(monde: Monde = {}): Promise<string> {
  const prisma = {
    trip: {
      findFirst: jest.fn().mockResolvedValue({
        id: TRIP_ID, startedAt: T0, endedAt: a(3600), trackerId: 'trk-1',
        distanceKm: 60, maxSpeed: monde.maxSpeed ?? 125, avgSpeed: 60, positionCount: 120,
        vehicle: {
          plate: 'AB-123-CD', brand: 'Renault', model: 'Clio', privacyModeEnabled: false,
          fleet: { id: 'f1', name: 'MH Cars' }, tracker: { id: 'trk-1', imei: '123456789012345' },
        },
      }),
    },
    tracker: { findUnique: jest.fn().mockResolvedValue({ imei: '123456789012345' }) },
    position: { findMany: jest.fn().mockResolvedValue(monde.positions ?? []) },
    tripAnalysis: {
      findUnique: jest.fn().mockResolvedValue(
        monde.analyse === null ? null : { detail: { speeding: [segment()] }, maxSpeedKmh: 125, speedingCount: 1, limitsCoverage: 0.9, computedAt: a(4000), ...(monde.analyse ?? {}) },
      ),
    },
  };
  const module = await Test.createTestingModule({
    providers: [SpeedReportService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  const { html } = await module.get(SpeedReportService).generate(TRIP_ID, SUPER_ADMIN);
  return html;
}

describe('Rapport de vitesse — le seuil fixe de 90 km/h a disparu', () => {
  it('ne juge plus aucune vitesse contre un seuil fixe', async () => {
    // ⚠️ « 90 » figure encore dans le document — comme LIMITE LÉGALE de la voie citée par
    // l'analyse. C'est justement la différence : un chiffre qui vient de la route, et non un
    // seuil que le rapport s'était donné à lui-même.
    const html = await rapport({ positions: [position(0, 125), position(20, 120), position(40, 118)] });
    expect(html).not.toContain('Mesures > 90');
    expect(html).not.toContain('Limite 90 km/h');
    expect(html).not.toContain('&lt; 90 km/h');
    expect(html).not.toContain('limit-line');
    expect(prose(html)).toContain("Aucune ligne de seuil n'est tracée");
  });

  it('compte les excès ÉTABLIS par l’analyse, et cite la limite de la voie', async () => {
    const html = await rapport({ positions: [position(0, 125), position(20, 120)] });
    expect(html).toContain('Excès établis');
    expect(html).toContain('125 km/h sur une voie limitée à 90 (+35 km/h)');
    expect(html).toContain('1 bis. Excès établis, un par un');
  });

  it('⚠️ 78 km/h dans une zone 50 est rapporté — l’ancien seuil n’en voyait rien', async () => {
    const html = await rapport({
      positions: [position(0, 78), position(20, 76)],
      maxSpeed: 78,
      analyse: { detail: { speeding: [segment({ limitKmh: 50, maxSpeedKmh: 78, overKmh: 28 })] } },
    });
    expect(html).toContain('78 km/h sur une voie limitée à 50 (+28 km/h)');
  });

  it('⚠️ 100 km/h sur une voie à 110 n’est plus rapporté — l’ancien seuil en inventait un', async () => {
    const html = await rapport({
      positions: [position(0, 100), position(20, 102)],
      maxSpeed: 102,
      analyse: { detail: { speeding: [] }, speedingCount: 0 },
    });
    expect(prose(html)).toContain('Aucun excès établi');
    expect(html).not.toContain('1 bis. Excès établis');
  });

  it('n’affirme RIEN quand l’analyse manque, au lieu d’inventer un seuil', async () => {
    const html = await rapport({ positions: [position(0, 150)], maxSpeed: 150, analyse: null });
    expect(prose(html)).toContain('Aucun excès ne peut être établi pour ce trajet');
    expect(prose(html)).toContain('mesures brutes du boîtier');
    expect(html).not.toContain('1 bis. Excès établis');
  });
});

describe('Rapport de vitesse — les réserves appartiennent au document', () => {
  it('énonce la pointe que la trajectoire ne soutient pas', async () => {
    const html = await rapport({
      positions: [position(0, 125)],
      analyse: { detail: { speeding: [segment()], vitesse: { pointeBruteKmh: 180, pointsEcartes: 2 } } },
    });
    expect(prose(html)).toContain('Réserve sur la vitesse annoncée');
    expect(prose(html)).toContain('180 km/h annoncés');
    expect(prose(html)).toContain('un artefact de mesure ne peut pas être opposé à un salarié');
  });

  it('signale les pointes écartées du décompte', async () => {
    const html = await rapport({
      positions: [position(0, 125)],
      analyse: { detail: { speeding: [segment()], aVerifier: [{ motif: 'limite-invraisemblable' }, { motif: 'point-unique' }] } },
    });
    expect(prose(html)).toContain('2 pointes écartées');
    expect(prose(html)).toContain("n'entrent dans aucun total");
  });

  it('avertit quand la couverture des limites est trop faible pour conclure', async () => {
    const html = await rapport({ positions: [position(0, 125)], analyse: { limitsCoverage: 0.2 } });
    expect(prose(html)).toContain('Couverture des limites légales incomplète (20 %)');
    expect(prose(html)).toContain('est donc un MINIMUM');
  });

  it('ne crie pas au loup quand la couverture est bonne', async () => {
    const html = await rapport({ positions: [position(0, 125)], analyse: { limitsCoverage: 0.95 } });
    expect(prose(html)).not.toContain('Couverture des limites légales incomplète');
  });
});

describe('Rapport de vitesse — chaque mesure porte la limite qu’elle dépassait', () => {
  it('marque les positions tombant dans un excès, et laisse les autres neutres', async () => {
    const html = await rapport({ positions: [position(0, 125), position(20, 120), position(600, 70)] });
    // La colonne de limite existe, et la mesure hors excès n'en porte aucune.
    expect(html).toContain('<th>Limite voie</th>');
    expect(html).toContain('<td>90</td>');
    expect(html).toContain('<td>—</td>');
  });

  it('la note de fiabilité parle d’excès établis, pas de mesures au-dessus d’un seuil', async () => {
    const html = await rapport({
      positions: [position(0, 125), position(20, 120)],
      analyse: { detail: { speeding: [segment(), segment({ startAt: a(600).toISOString(), endAt: a(640).toISOString() })] } },
    });
    expect(html).toContain('2 excès distincts');
    expect(prose(html)).toContain('rendent improbable un artefact GPS isolé');
  });
});

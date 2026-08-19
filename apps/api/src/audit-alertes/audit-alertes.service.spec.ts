import { AuditAlertesService } from './audit-alertes.service';

/**
 * Ce que cet ecran doit rendre possible : trancher un deluge d'alertes SANS restaurer une
 * sauvegarde ni ecrire de SQL. Les valeurs ci-dessous sont celles du cas reel du
 * 2026-08-19 — 41 468 alertes attribuees a un boitier remplace sept semaines plus tot.
 */
const TRAME_FZ =
  'imei:864035054756292,ac alarm,260617170553,100%,F,170553.000,A,4340.05365,N,00126.29918,E,,,,0,0,0.00%,,';

function alerte(p: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    createdAt: new Date('2026-06-17T17:05:53Z'),
    type: 'POWER_CUT',
    severity: 'CRITICAL',
    title: 'Alimentation coupée',
    message: null,
    acknowledgedAt: null,
    payload: { raw: TRAME_FZ, alarm: 'power_cut', speedKmh: 0, ignition: false },
    vehicle: { plate: 'FZ-862-VY', fleet: { name: 'mh cars' } },
    ...p,
  };
}

function service(rows: Record<string, unknown>[]) {
  const prisma = {
    alert: {
      count: jest.fn().mockResolvedValue(rows.length),
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
  return { svc: new AuditAlertesService(prisma as never), prisma };
}

describe('AuditAlertes — la trame a cote de l’alerte', () => {
  it('⚠️ rend l’IMEI LU DANS LA TRAME, pas celui du vehicule', async () => {
    // C'est CE champ qui a resolu le cas reel : les 41 468 alertes de FZ-862-VY
    // portaient l'IMEI de son ANCIEN boitier, remplace le 1er juillet.
    const { svc } = service([alerte()]);
    const r = await svc.lignes({});
    expect(r.lignes[0]!.imeiTrame).toBe('864035054756292');
  });

  it('extrait la batterie du 4e champ — le discriminant vrai/faux', async () => {
    const { svc } = service([alerte()]);
    const r = await svc.lignes({});
    expect(r.lignes[0]!.batterie).toBe(100);
  });

  it('rend la trame BRUTE : « ac alarm » ou « oil » n’est pas une opinion', async () => {
    const { svc } = service([alerte()]);
    const r = await svc.lignes({});
    expect(r.lignes[0]!.trameBrute).toContain('ac alarm');
    expect(r.lignes[0]!.alarmeDecodee).toBe('power_cut');
  });

  it('supporte une alerte SANS payload sans casser l’ecran', async () => {
    // Les alertes creees hors trame (cron GPS perdu) n'ont pas de `raw`.
    const { svc } = service([alerte({ payload: null })]);
    const r = await svc.lignes({});
    expect(r.lignes[0]!.trameBrute).toBeNull();
    expect(r.lignes[0]!.imeiTrame).toBeNull();
    expect(r.lignes[0]!.batterie).toBeNull();
  });

  it('un 4e champ qui n’est PAS un pourcentage ne devient pas une batterie', async () => {
    const brut = 'imei:864035054756292,rfid,260617170553,A1B2C3D4,F,170553.000,A,4340.0,N,00126.2,E';
    const { svc } = service([alerte({ payload: { raw: brut, alarm: 'rfid' } })]);
    const r = await svc.lignes({});
    expect(r.lignes[0]!.batterie).toBeNull();
  });
});

/**
 * ── LA FENETRE EST TOUJOURS BORNEE ───────────────────────────────────────────────────
 *
 * Sans borne, une table de 50 000 alertes se ferait scanner integralement au premier
 * affichage — et l'ecran d'audit deviendrait lui-meme l'incident qu'il sert a diagnostiquer.
 */
describe('AuditAlertes — bornes', () => {
  it('sans dates, la fenetre remonte a 30 jours, jamais plus', async () => {
    const { svc, prisma } = service([]);
    await svc.lignes({});
    const where = prisma.alert.findMany.mock.calls[0]![0]!.where as { createdAt: { gte: Date } };
    const jours = (Date.now() - where.createdAt.gte.getTime()) / 86_400_000;
    expect(jours).toBeGreaterThan(29);
    expect(jours).toBeLessThan(31);
  });

  it('la taille de page est plafonnee — on ne tire pas 10 000 lignes', async () => {
    const { svc, prisma } = service([]);
    await svc.lignes({ taille: 10_000 });
    expect(prisma.alert.findMany.mock.calls[0]![0]!.take).toBe(200);
  });

  it('une page negative ne renvoie pas un skip negatif', async () => {
    const { svc, prisma } = service([]);
    await svc.lignes({ page: -3 });
    expect(prisma.alert.findMany.mock.calls[0]![0]!.skip).toBe(0);
  });
});

/**
 * ── LE REGROUPEMENT PAR CAUSE ────────────────────────────────────────────────────────
 *
 * La vue qui repond en une ligne a « d'ou viennent ces milliers d'alertes ? ». Sur le cas
 * reel, elle aurait montre immediatement 41 468 lignes attribuees a un IMEI qui n'equipe
 * plus aucun vehicule — au lieu de deux heures d'enquete et d'une sauvegarde restauree.
 */
describe('AuditAlertes — regrouper par cause', () => {
  it('agrege par type, alarme et BOITIER d’origine', async () => {
    const ancien = alerte();
    const nouveau = alerte({
      id: 'a2',
      payload: { raw: TRAME_FZ.replace('864035054756292', '864035054756102'), alarm: 'power_cut' },
    });
    const { svc } = service([ancien, ancien, nouveau]);
    const causes = await svc.causes({});
    expect(causes).toHaveLength(2);
    expect(causes[0]!.nombre).toBe(2);
    expect(causes[0]!.imeiTrame).toBe('864035054756292');
  });

  it('trie par volume decroissant — le coupable est en tete', async () => {
    const { svc } = service([
      alerte(),
      alerte({ id: 'b', type: 'GPS_LOST', payload: { raw: null, alarm: null } }),
      alerte(),
      alerte(),
    ]);
    const causes = await svc.causes({});
    expect(causes[0]!.nombre).toBe(3);
    expect(causes[0]!.type).toBe('POWER_CUT');
  });

  it('porte la periode : depuis quand, jusqu’a quand', async () => {
    const { svc } = service([
      alerte({ createdAt: new Date('2026-06-17T00:00:00Z') }),
      alerte({ id: 'b', createdAt: new Date('2026-07-01T00:00:00Z') }),
    ]);
    const causes = await svc.causes({});
    expect(causes[0]!.premiere).toBe('2026-06-17T00:00:00.000Z');
    expect(causes[0]!.derniere).toBe('2026-07-01T00:00:00.000Z');
  });
});

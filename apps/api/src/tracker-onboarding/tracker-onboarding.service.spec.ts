import { TrackerOnboardingService, type Demandeur } from './tracker-onboarding.service';

/**
 * Valeurs du parc RÉEL (relevé du 2026-08-18). Un jeu d'essai inventé ne dirait pas si la
 * résolution marche sur les étiquettes que le technicien a en main.
 */
const IMEI_FL = '864035054756409';
const ICCID_FL = '8934075700126838215';
const MSISDN_FL = '345901035259762';
const FLOTTE_A = 'flotte-a';
const FLOTTE_B = 'flotte-b';

const ADMIN_A: Demandeur = { role: 'FLEET_ADMIN', fleetId: FLOTTE_A };
const SUPER: Demandeur = { role: 'SUPER_ADMIN', fleetId: null };

function service(opts: {
  puce?: Record<string, unknown> | null;
  tracker?: Record<string, unknown> | null;
  inconnus?: { imei: string; lastSeenAt: string }[];
}) {
  const prisma = {
    sim: { findFirst: jest.fn().mockResolvedValue(opts.puce ?? null) },
    tracker: { findUnique: jest.fn().mockResolvedValue(opts.tracker ?? null) },
  };
  const registre = { list: jest.fn().mockReturnValue(opts.inconnus ?? []) };
  return {
    svc: new TrackerOnboardingService(prisma as never, registre as never),
    prisma,
  };
}

const PUCE_ACTIVE = {
  iccid: ICCID_FL,
  msisdn: MSISDN_FL,
  imei: IMEI_FL,
  statusId: 2,
  statusLabel: 'Activée',
};

describe('TrackerOnboarding — un scan devient une identite', () => {
  it('un IMEI scanne retrouve sa puce et son numero, en E.164', async () => {
    const { svc } = service({ puce: PUCE_ACTIVE });
    const r = await svc.resoudre(IMEI_FL, ADMIN_A);
    expect(r.imei).toBe(IMEI_FL);
    expect(r.iccid).toBe(ICCID_FL);
    // ⚠️ L'inventaire stocke le MSISDN sans le « + » ; tout le reste de l'app le porte.
    expect(r.msisdn).toBe(`+${MSISDN_FL}`);
  });

  it('un ICCID scanne retrouve l’IMEI — l’etiquette peut porter l’un ou l’autre', async () => {
    const { svc, prisma } = service({ puce: PUCE_ACTIVE });
    const r = await svc.resoudre(ICCID_FL, ADMIN_A);
    expect(r.imei).toBe(IMEI_FL);
    expect(prisma.sim.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { iccid: ICCID_FL } }),
    );
  });

  it('un numero saisi a la main retrouve le boitier', async () => {
    const { svc } = service({ puce: PUCE_ACTIVE });
    const r = await svc.resoudre(`+${MSISDN_FL}`, ADMIN_A);
    expect(r.imei).toBe(IMEI_FL);
  });

  it('un code illisible ne rend AUCUN candidat, et le dit', async () => {
    const { svc, prisma } = service({});
    const r = await svc.resoudre('ETIQUETTE ABIMEE', ADMIN_A);
    expect(r.voie).toBe('inconnu');
    expect(r.candidats).toEqual([]);
    // On n'interroge meme pas la base sur du bruit.
    expect(prisma.sim.findFirst).not.toHaveBeenCalled();
  });
});

describe('TrackerOnboarding — la voie a suivre', () => {
  it('⚠️ boitier qui frappe deja en TCP : rattachement immediat, AUCUN SMS', async () => {
    // C'est la voie prioritaire : elle economise une salve de huit SMS.
    const { svc } = service({
      puce: PUCE_ACTIVE,
      inconnus: [{ imei: IMEI_FL, lastSeenAt: new Date(Date.now() - 12_000).toISOString() }],
    });
    const r = await svc.resoudre(IMEI_FL, ADMIN_A);
    expect(r.voie).toBe('rattacher_maintenant');
    expect(r.frappeEnTcp).toBe(true);
    expect(r.vuIlYaSecondes).toBeGreaterThanOrEqual(11);
  });

  it('IMEI connu mais silencieux : on ecoute, on n’envoie pas de SMS pour rien', async () => {
    const { svc } = service({ puce: PUCE_ACTIVE });
    const r = await svc.resoudre(IMEI_FL, ADMIN_A);
    expect(r.voie).toBe('attente_tcp');
    expect(r.frappeEnTcp).toBe(false);
  });

  it('puce active mais boitier JAMAIS vu : la seule raison de payer des SMS', async () => {
    // imei null = la puce n'a jamais ouvert de session, donc l'operateur ignore
    // dans quel boitier elle se trouve.
    const { svc } = service({ puce: { ...PUCE_ACTIVE, imei: null } });
    const r = await svc.resoudre(`+${MSISDN_FL}`, ADMIN_A);
    expect(r.voie).toBe('provisioning_sms');
  });

  it('puce en stock : on active AVANT de configurer — un SMS vers une puce inactive se perd', async () => {
    const { svc } = service({
      puce: { ...PUCE_ACTIVE, imei: null, statusId: 8, statusLabel: 'Prête à activer' },
    });
    const r = await svc.resoudre(`+${MSISDN_FL}`, ADMIN_A);
    expect(r.voie).toBe('sim_a_activer');
    expect(r.message).toContain('Prête à activer');
  });

  it('boitier deja monte sur un vehicule : on refuse', async () => {
    const { svc } = service({
      puce: PUCE_ACTIVE,
      tracker: { id: 't1', vehicle: { plate: 'FZ-862-VY', fleetId: FLOTTE_A, fleet: { name: 'mh cars' } } },
    });
    const r = await svc.resoudre(IMEI_FL, ADMIN_A);
    expect(r.voie).toBe('deja_rattache');
    expect(r.message).toContain('FZ-862-VY');
  });

  it('boitier declare mais libre : on ecoute sa prochaine trame', async () => {
    const { svc } = service({ puce: PUCE_ACTIVE, tracker: { id: 't1', vehicle: null } });
    const r = await svc.resoudre(IMEI_FL, ADMIN_A);
    expect(r.voie).toBe('attente_tcp');
    expect(r.trackerId).toBe('t1');
  });
});

/**
 * ── CLOISONNEMENT MULTI-SOCIETES ─────────────────────────────────────────────────────
 *
 * L'app heberge plusieurs clients. Apprendre a l'administrateur d'une societe la plaque
 * et le nom d'une autre, juste en scannant un boitier ramasse quelque part, serait une
 * fuite — et elle passerait inapercue puisque le message a l'air anodin.
 */
describe('TrackerOnboarding — ne pas nommer le client d’a cote', () => {
  const occupePar = {
    id: 't1',
    vehicle: { plate: 'FZ-862-VY', fleetId: FLOTTE_B, fleet: { name: 'cdef31' } },
  };

  it('⚠️ un admin d’une AUTRE societe apprend que c’est occupe, pas par qui', async () => {
    const { svc } = service({ puce: PUCE_ACTIVE, tracker: occupePar });
    const r = await svc.resoudre(IMEI_FL, ADMIN_A);
    expect(r.voie).toBe('deja_rattache');
    expect(r.vehiculePlaque).toBeNull();
    expect(r.flotteNom).toBeNull();
    expect(r.message).not.toContain('FZ-862-VY');
    expect(r.message).not.toContain('cdef31');
  });

  it('le super-admin voit tout : c’est son role', async () => {
    const { svc } = service({ puce: PUCE_ACTIVE, tracker: occupePar });
    const r = await svc.resoudre(IMEI_FL, SUPER);
    expect(r.vehiculePlaque).toBe('FZ-862-VY');
    expect(r.message).toContain('cdef31');
  });
});

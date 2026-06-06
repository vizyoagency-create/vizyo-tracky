/**
 * V1.15 — Seed du planning d'installation CDEF 31 (27 véhicules).
 *
 * Idempotent : upsert sur des UUID fixes. Au re-run, seuls les champs descriptifs
 * sont mis à jour — les données de pose (imei/sim/status/installedAt/vehicleId/
 * trackerId) déjà saisies ne sont jamais écrasées.
 *
 * Lancer (PowerShell, depuis apps/api) :
 *   $env:DATABASE_URL="postgresql://..."; $env:SEED_INSTALL_FLEET_ID="<uuid flotte CDEF31>"
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed-installation.ts
 *
 * SEED_INSTALL_FLEET_ID défaut = flotte démo 00000000-0000-0000-0000-000000000001.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type InstallationEnergy } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// UUID valides (version 4, variant 8) — important : ids parses par @IsUUID()
// cote API (ex. endpoint reorder qui recoit les ids en body). Un id "uuid"
// Postgres-valide mais sans nibble version/variant correct (ex. ...-0000-0000-...)
// serait rejete en 400 par class-validator.
const PLAN_ID = 'cdef3100-0000-4000-8000-000000000000';
const DEFAULT_FLEET_ID = '00000000-0000-0000-0000-000000000001';

/** "DD/MM/YYYY" -> Date (minuit UTC) pour une colonne @db.Date. */
function mec(ddmmyyyy: string): Date {
  const [d, m, y] = ddmmyyyy.split('/');
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}
/** "YYYY-MM-DD" -> Date (minuit UTC). */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const DAY_THEMES: Record<string, string> = {
  '2026-06-08': 'Vieux diesels (coupure simple)',
  '2026-06-09': 'Fourgons PSA thermiques',
  '2026-06-10': 'Citadines essence + TEST électrique',
  '2026-06-11': 'Citroën C3 (réf. + duplication)',
  '2026-06-12': 'Citroën C3',
  '2026-06-15': 'Citroën C3',
  '2026-06-16': 'Dernière C3 + démarrage batch électrique',
  '2026-06-17': 'ë-Jumpy électriques',
  '2026-06-18': 'ë-Jumpy électriques',
};

interface SeedTask {
  n: number;
  date: string;
  plate: string;
  brand: string;
  model: string;
  energy: InstallationEnergy;
  mec: string;
  proc: string;
}

const TASKS: SeedTask[] = [
  // Jour 1 — 08/06
  { n: 1, date: '2026-06-08', plate: 'CD-257-YJ', brand: 'Renault', model: 'Kangoo II', energy: 'DIESEL', mec: '12/04/2012', proc: 'Coupure simple sur circuit alim/injection' },
  { n: 2, date: '2026-06-08', plate: 'BP-434-RD', brand: 'Renault', model: 'Kangoo II', energy: 'DIESEL', mec: '08/06/2011', proc: 'Coupure simple sur circuit alim/injection' },
  { n: 3, date: '2026-06-08', plate: 'DZ-034-CA', brand: 'Peugeot', model: '208 I (BlueHDi)', energy: 'DIESEL', mec: '22/01/2016', proc: 'Coupure circuit PSA, architecture standard' },
  // Jour 2 — 09/06
  { n: 4, date: '2026-06-09', plate: 'AL-927-QM', brand: 'Citroën', model: 'Jumpy II (HDi)', energy: 'DIESEL', mec: '12/02/2010', proc: 'Coupure simple, génération ancienne' },
  { n: 5, date: '2026-06-09', plate: 'FR-428-QB', brand: 'Peugeot', model: 'Expert/Traveller III', energy: 'DIESEL', mec: '23/07/2020', proc: 'EMP2 · gateway CAN → repérage avant coupure' },
  { n: 6, date: '2026-06-09', plate: 'FY-038-TS', brand: 'Peugeot', model: 'Expert III (fourgon)', energy: 'DIESEL', mec: '23/04/2021', proc: 'EMP2 · gateway CAN → repérage avant coupure' },
  // Jour 3 — 10/06
  { n: 7, date: '2026-06-10', plate: 'FS-253-HR', brand: 'Renault', model: 'Clio V (TCe)', energy: 'ESSENCE', mec: '28/08/2020', proc: 'Coupure circuit · gateway CAN → repérage' },
  { n: 8, date: '2026-06-10', plate: 'FS-808-CE', brand: 'Renault', model: 'Clio V (TCe)', energy: 'ESSENCE', mec: '17/08/2020', proc: 'Idem Clio (procédure identique)' },
  { n: 9, date: '2026-06-10', plate: 'HD-292-SH', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '26/05/2025', proc: 'TEST VE : relais sur circuit BASSE TENSION (ligne réveil/contact), JAMAIS le HV. Valider + tester avant le batch final.' },
  // Jour 4 — 11/06
  { n: 10, date: '2026-06-11', plate: 'GR-270-HZ', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '21/09/2023', proc: 'Établir le repérage de réf. C3 (à dupliquer)' },
  { n: 11, date: '2026-06-11', plate: 'GS-878-NX', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '23/11/2023', proc: 'Duplique repérage réf. C3' },
  { n: 12, date: '2026-06-11', plate: 'GS-208-NY', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '23/11/2023', proc: 'Duplique repérage réf. C3' },
  // Jour 5 — 12/06
  { n: 13, date: '2026-06-12', plate: 'GS-138-LT', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '17/11/2023', proc: 'Duplique repérage réf. C3' },
  { n: 14, date: '2026-06-12', plate: 'GR-294-VW', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '16/10/2023', proc: 'Duplique repérage réf. C3' },
  { n: 15, date: '2026-06-12', plate: 'GS-909-NX', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '23/11/2023', proc: 'Duplique repérage réf. C3' },
  // Jour 6 — 15/06
  { n: 16, date: '2026-06-15', plate: 'GT-493-KS', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '02/01/2024', proc: 'Duplique repérage réf. C3' },
  { n: 17, date: '2026-06-15', plate: 'GS-928-NX', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '23/11/2023', proc: 'Duplique repérage réf. C3' },
  { n: 18, date: '2026-06-15', plate: 'GS-014-NY', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '23/11/2023', proc: 'Duplique repérage réf. C3' },
  // Jour 7 — 16/06
  { n: 19, date: '2026-06-16', plate: 'GS-187-NY', brand: 'Citroën', model: 'C3 III (PureTech)', energy: 'ESSENCE', mec: '23/11/2023', proc: 'Duplique repérage réf. C3' },
  { n: 20, date: '2026-06-16', plate: 'HD-597-XY', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '04/06/2025', proc: 'Procédure VE validée au test J3 — appliquer' },
  { n: 21, date: '2026-06-16', plate: 'HD-998-XY', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '04/06/2025', proc: 'Procédure VE validée au test J3 — appliquer' },
  // Jour 8 — 17/06
  { n: 22, date: '2026-06-17', plate: 'HD-443-QY', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '22/05/2025', proc: 'Coupure BT validée — appliquer' },
  { n: 23, date: '2026-06-17', plate: 'HD-686-QX', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '22/05/2025', proc: 'Coupure BT validée — appliquer' },
  { n: 24, date: '2026-06-17', plate: 'HD-595-XY', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '04/06/2025', proc: 'Coupure BT validée — appliquer' },
  // Jour 9 — 18/06
  { n: 25, date: '2026-06-18', plate: 'HD-964-XY', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '04/06/2025', proc: 'Coupure BT validée — appliquer' },
  { n: 26, date: '2026-06-18', plate: 'HD-584-BF', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '16/04/2025', proc: 'Coupure BT validée — appliquer' },
  { n: 27, date: '2026-06-18', plate: 'HD-603-XY', brand: 'Citroën', model: 'ë-Jumpy', energy: 'ELECTRIQUE', mec: '04/06/2025', proc: 'Coupure BT validée — appliquer' },
];

function taskId(n: number): string {
  return `cdef3100-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const fleetId = process.env.SEED_INSTALL_FLEET_ID ?? DEFAULT_FLEET_ID;
  const fleet = await prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true } });
  if (!fleet) {
    throw new Error(
      `Flotte ${fleetId} introuvable.\n` +
      'Définissez SEED_INSTALL_FLEET_ID avec l\'UUID de la flotte CDEF 31 (créez-la d\'abord si besoin).',
    );
  }

  await prisma.installationPlan.upsert({
    where: { id: PLAN_ID },
    update: {
      clientName: "CDEF 31 — Centre Dép. de l'Enfant et de la Famille",
      clientAddress: '425 rte de Launaguet, 31200 Toulouse',
      description: 'Pose traceurs + coupure moteur · 27 véhicules · 3/jour · 1 ë-Jumpy en test J3 puis batch électrique J7-J9',
      startDate: day('2026-06-08'),
      endDate: day('2026-06-18'),
      dayThemes: DAY_THEMES,
    },
    create: {
      id: PLAN_ID,
      fleetId,
      clientName: "CDEF 31 — Centre Dép. de l'Enfant et de la Famille",
      clientAddress: '425 rte de Launaguet, 31200 Toulouse',
      description: 'Pose traceurs + coupure moteur · 27 véhicules · 3/jour · 1 ë-Jumpy en test J3 puis batch électrique J7-J9',
      startDate: day('2026-06-08'),
      endDate: day('2026-06-18'),
      status: 'PUBLISHED',
      dayThemes: DAY_THEMES,
    },
  });

  for (const t of TASKS) {
    const descriptive = {
      orderIndex: t.n - 1,
      scheduledDate: day(t.date),
      plate: t.plate,
      brand: t.brand,
      model: t.model,
      energy: t.energy,
      firstRegistrationDate: mec(t.mec),
      cutoffProcedure: t.proc,
    };
    await prisma.installationTask.upsert({
      where: { id: taskId(t.n) },
      // Re-run : on ne touche pas aux champs de pose (imei/sim/status/installedAt/FK).
      update: descriptive,
      create: { id: taskId(t.n), planId: PLAN_ID, ...descriptive },
    });
  }

  console.log(`✅ Planning CDEF 31 seedé (${TASKS.length} véhicules) sur la flotte "${fleet.name}" (${fleetId}).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });

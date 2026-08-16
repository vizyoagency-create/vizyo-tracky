/**
 * Vérification de l'isolation dépôt CONTRE LA BASE RÉELLE.
 *
 * Les 12 tests d'A1 § 8 tournent sur un Prisma mocké : ils prouvent que le code fait
 * ce qu'on croit. Ce script prouve autre chose — que sur de vraies données, un dépôt
 * voit exactement ce qu'il doit voir, et rien d'autre. Les deux ne se remplacent pas.
 *
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/verif-depot.ts
 */
import { PrismaClient } from '@prisma/client';
import { DepotScopeService } from '../src/depot/depot-scope.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();
const scope = new DepotScopeService(prisma as unknown as PrismaService);

let reussis = 0;
let echoues = 0;

function verifier(libelle: string, obtenu: unknown, attendu: unknown): void {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  console.log(` ${ok ? '✓' : '✗'} ${libelle}${ok ? '' : `  → attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`}`);
  ok ? reussis++ : echoues++;
}

async function main(): Promise<void> {
  const depotA = await prisma.user.findUniqueOrThrow({ where: { email: 'depot.fenouillet@exemple.fr' } });
  const depotB = await prisma.user.findUniqueOrThrow({ where: { email: 'depot.muret@exemple.fr' } });
  const parRef = new Map(
    (await prisma.mission.findMany({ select: { ref: true, id: true, vehicleId: true } })).map((m) => [m.ref, m]),
  );
  const temoin = await prisma.vehicle.findFirstOrThrow({ where: { plate: 'FR-903-HC' } });

  console.log('\n═══ PÉRIMÈTRE DES MISSIONS ═══════════════════════════════════');
  const misA = await scope.missionsFor(depotA.id);
  const misB = await scope.missionsFor(depotB.id);
  // Lot A3 — le jeu d'essai porte désormais 4 missions du jour PLUS 6 missions
  // terminées, sans quoi l'historique et ses KPI ne seraient jamais exercés. Ce qui
  // compte ici n'est pas le nombre total mais la BORNE : le dépôt A voit exactement
  // ses missions du jour, et rien de ce qui appartient au dépôt B.
  verifier(
    'le dépôt A voit ses 4 missions du jour',
    misA.filter((m) => ['M-0001', 'M-0002', 'M-0003', 'M-0004'].includes(m.ref)).length,
    4,
  );
  verifier(
    'aucune mission d\'un autre dépôt dans le périmètre de A',
    misA.every((m) => m.ref !== 'M-0005' && m.ref !== 'M-0006'),
    true,
  );
  verifier('le dépôt B voit sa mission', misB.length, 1);
  verifier(
    'aucune mission du dépôt B ne fuit vers A',
    misA.some((m) => m.ref === 'M-0005'),
    false,
  );
  verifier(
    'la mission INTERNE ne fuit vers aucun dépôt',
    [...misA, ...misB].some((m) => m.ref === 'M-0006'),
    false,
  );

  console.log('\n═══ LA FENÊTRE HORAIRE — position live ═══════════════════════');
  verifier(
    'M-0001 EN COURS → position servie',
    await scope.canSeeLivePosition(depotA.id, parRef.get('M-0001')!.vehicleId),
    true,
  );
  verifier(
    'M-0004 EN RETARD → position servie (le suivi continue)',
    await scope.canSeeLivePosition(depotA.id, parRef.get('M-0004')!.vehicleId),
    true,
  );
  verifier(
    'M-0002 PLANIFIÉE → position REFUSÉE',
    await scope.canSeeLivePosition(depotA.id, parRef.get('M-0002')!.vehicleId),
    false,
  );
  verifier(
    'M-0003 TERMINÉE → position REFUSÉE',
    await scope.canSeeLivePosition(depotA.id, parRef.get('M-0003')!.vehicleId),
    false,
  );

  console.log('\n═══ ISOLATION ENTRE DÉPÔTS ══════════════════════════════════');
  verifier(
    'le dépôt A ne voit PAS la position du camion du dépôt B',
    await scope.canSeeLivePosition(depotA.id, parRef.get('M-0005')!.vehicleId),
    false,
  );
  verifier(
    'le dépôt B ne voit PAS la position du camion du dépôt A',
    await scope.canSeeLivePosition(depotB.id, parRef.get('M-0001')!.vehicleId),
    false,
  );
  verifier(
    'le dépôt A ne voit PAS la mission du dépôt B',
    await scope.canSeeMission(depotA.id, parRef.get('M-0005')!.id),
    false,
  );

  console.log('\n═══ LE CAMION TÉMOIN (aucune mission) ═══════════════════════');
  verifier(
    'FR-903-HC invisible du dépôt A',
    await scope.canSeeLivePosition(depotA.id, temoin.id),
    false,
  );
  verifier(
    'FR-903-HC invisible du dépôt B',
    await scope.canSeeLivePosition(depotB.id, temoin.id),
    false,
  );

  console.log('\n═══ INVARIANT : aucun scope véhicule sur un dépôt ═══════════');
  const scopes = await prisma.userVehicleAccess.count({
    where: { userId: { in: [depotA.id, depotB.id] } },
  });
  verifier('0 ligne UserVehicleAccess', scopes, 0);

  console.log('\n═══ SALONS TEMPS RÉEL ═══════════════════════════════════════');
  const salonsA = await scope.activeMissionIds(depotA.id);
  verifier('le dépôt A rejoint 2 salons (en cours + en retard)', salonsA.length, 2);
  verifier(
    'aucun salon pour la mission planifiée',
    salonsA.includes(parRef.get('M-0002')!.id),
    false,
  );

  console.log('\n═══ INDISPONIBILITÉ VÉHICULE ════════════════════════════════');
  const maintenant = new Date();
  const dans2h = new Date(maintenant.getTime() + 2 * 3600_000);
  const bloquants = await prisma.vehicleEvent.count({
    where: {
      type: 'MISSION',
      blocksVehicle: true,
      status: { in: ['PLANNED', 'OPEN', 'IN_PROGRESS'] },
      startAt: { lt: dans2h },
      endAt: { gt: maintenant },
    },
  });
  verifier('les missions en cours immobilisent bien leur véhicule', bloquants > 0, true);

  console.log(`\n${'═'.repeat(62)}`);
  console.log(` RÉSULTAT : ${reussis} vérification(s) réussie(s), ${echoues} échec(s)`);
  console.log('═'.repeat(62));
  if (echoues > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

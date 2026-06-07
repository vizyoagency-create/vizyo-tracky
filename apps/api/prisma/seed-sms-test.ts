import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';

/**
 * Seed dédié au test local des notifications SMS d'alerte (Chantier B, V1.15).
 *
 * Idempotent (upsert sur UUID fixes) — re-run sans effet de bord. Crée :
 *   - une flotte de test "SMS Test Fleet"
 *   - un FLEET_ADMIN avec un `phone` => destinataire resolu par
 *     NotificationDispatchService quand une alerte de cette flotte est dispatchée
 *   - un véhicule (sa plaque apparaît dans le corps du SMS)
 *   - une AlertRule catch-all (`alertType='*'`) avec le canal SMS activé
 *
 * Lancer : `pnpm --filter @vizyo/tracky-api seed:sms-test`
 * (DATABASE_URL doit pointer sur la base locale — port 5436 en dev).
 *
 * Le FLEET_ADMIN a un authUserId synthétique : il ne peut pas se connecter via
 * Vizyo Auth (inutile pour tester le dispatch). Pour piloter les règles depuis
 * l'UI, connecte-toi en SUPER_ADMIN (admin@vizyoagency.com) qui voit toutes les
 * flottes.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Destinataire des SMS de test — DOIT être dans l'allowlist vizyo-texto (sinon
// 403 → ErrorLog CRITICAL). Default = numéro heartbeat connu (déjà allowlisté).
const TEST_PHONE = process.env.SMS_TEST_PHONE ?? '+33656691615';

const FLEET_ID = 'a5000000-0000-0000-0000-000000000001';
const ADMIN_ID = 'a5000000-0000-0000-0000-000000000002';
const ADMIN_AUTH_ID = 'a5000000-0000-0000-0000-0000000000a2'; // synthétique (pas un vrai user Vizyo Auth)
const VEHICLE_ID = 'a5000000-0000-0000-0000-000000000003';
const RULE_ID = 'a5000000-0000-0000-0000-000000000004';

async function main() {
  const fleet = await prisma.fleet.upsert({
    where: { id: FLEET_ID },
    update: { name: 'SMS Test Fleet' },
    create: { id: FLEET_ID, name: 'SMS Test Fleet', clientId: 'sms-test' },
  });

  const admin = await prisma.user.upsert({
    where: { id: ADMIN_ID },
    update: { phone: TEST_PHONE, isActive: true, fleetId: FLEET_ID, role: UserRole.FLEET_ADMIN },
    create: {
      id: ADMIN_ID,
      authUserId: ADMIN_AUTH_ID,
      email: 'fleet-admin.smstest@tracky.local',
      firstName: 'SMS',
      lastName: 'Tester',
      role: UserRole.FLEET_ADMIN,
      fleetId: FLEET_ID,
      phone: TEST_PHONE,
      isActive: true,
    },
  });

  const vehicle = await prisma.vehicle.upsert({
    where: { id: VEHICLE_ID },
    update: { plate: 'SMS-TEST-01' },
    create: {
      id: VEHICLE_ID,
      fleetId: FLEET_ID,
      plate: 'SMS-TEST-01',
      brand: 'Renault',
      model: 'Kangoo',
    },
  });

  // Catch-all : toute alerte de la flotte (n'importe quel type) déclenche le SMS.
  const rule = await prisma.alertRule.upsert({
    where: { id: RULE_ID },
    update: { channels: ['IN_APP', 'SMS'] as Prisma.InputJsonValue, enabled: true },
    create: {
      id: RULE_ID,
      fleetId: FLEET_ID,
      vehicleId: null,
      alertType: '*',
      enabled: true,
      channels: ['IN_APP', 'SMS'] as Prisma.InputJsonValue,
    },
  });

  console.log('✅ Seed SMS test OK');
  console.log(`   Fleet   : ${fleet.name} (${fleet.id})`);
  console.log(`   Admin   : ${admin.email} · phone=${admin.phone} · role=${admin.role}`);
  console.log(`   Vehicle : ${vehicle.plate} (${vehicle.id})`);
  console.log(`   Rule    : alertType=${rule.alertType} · channels=${JSON.stringify(rule.channels)}`);
  console.log('');
  console.log(`   → Quand une alerte de la flotte "${fleet.name}" est dispatchée, un SMS part vers ${TEST_PHONE}.`);
  console.log('   → Pense à "Synchroniser" l\'allowlist (admin SMS › Allowlist) pour pousser ce numéro.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

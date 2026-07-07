import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole } from '@prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const adminAuthUserId = process.env.SEED_ADMIN_AUTH_USER_ID;
  if (!adminAuthUserId) {
    throw new Error(
      'SEED_ADMIN_AUTH_USER_ID is required.\n' +
      'Get it from Auth DB: SELECT id FROM "User" WHERE email = \'admin@vizyoagency.com\''
    );
  }

  const fleet = await prisma.fleet.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Vizyo Demo Fleet',
      clientId: 'vizyo-internal',
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@vizyoagency.com' },
    // Owner plateforme : re-seed idempotent qui (re)pose le flag isOwner.
    update: { isOwner: true },
    create: {
      authUserId: adminAuthUserId,
      email: 'admin@vizyoagency.com',
      firstName: 'Admin',
      lastName: 'Vizyo',
      role: UserRole.SUPER_ADMIN,
      isOwner: true,
      fleetId: null,
    },
  });

  // V1.5+ — User systeme pour les commandes auto (engine cut/restore detecte
  // par le boitier, fix mode adaptatif, schedule auto). Reference par
  // SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000' dans
  // positions.service.ts + tracker-fix-mode.service.ts.
  await prisma.user.upsert({
    where: { id: '00000000-0000-0000-0000-000000000000' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000000',
      authUserId: '00000000-0000-0000-0000-000000000000', // pas un vrai user Vizyo Auth
      email: 'system@tracky.local',
      firstName: 'System',
      lastName: '',
      role: UserRole.SUPER_ADMIN,
      fleetId: null,
      isActive: false, // ne peut pas se connecter — sert juste de FK target
    },
  });

  console.log('✅ Seed OK — admin@vizyoagency.com + system user linked');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

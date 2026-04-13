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
    update: {},
    create: {
      authUserId: adminAuthUserId,
      email: 'admin@vizyoagency.com',
      firstName: 'Admin',
      lastName: 'Vizyo',
      role: UserRole.SUPER_ADMIN,
      fleetId: null,
    },
  });

  console.log('✅ Seed OK — admin@vizyoagency.com linked to Auth userId:', adminAuthUserId);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

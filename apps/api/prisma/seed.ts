import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const fleet = await prisma.fleet.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Vizyo Demo Fleet',
      clientId: 'vizyo-internal',
    },
  });

  const passwordHash = await bcrypt.hash('admin123', 12);

  await prisma.user.upsert({
    where: { email: 'admin@vizyo.fr' },
    update: {},
    create: {
      email: 'admin@vizyo.fr',
      passwordHash,
      firstName: 'Admin',
      lastName: 'Vizyo',
      role: UserRole.SUPER_ADMIN,
      fleetId: fleet.id,
    },
  });

  console.log('✅ Seed OK — admin@vizyo.fr / admin123');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

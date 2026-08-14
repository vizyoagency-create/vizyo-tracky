/* eslint-disable no-console */
/**
 * Comptes de test pour les DEUX rôles qu'aucun compte de dev ne portait —
 * `DRIVER` et `NIGHT_WATCHMAN`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CE SCRIPT EXISTE                                                  │
 * │                                                                            │
 * │ Deux interfaces entières — l'espace conducteur `/driver` et le mode        │
 * │ veilleur — ont été livrées **sans avoir jamais été vues avec leur vrai     │
 * │ rôle** : la base de dev n'a jamais porté un seul compte DRIVER ni          │
 * │ NIGHT_WATCHMAN. Elles étaient donc mesurées avec un compte fleet-admin,    │
 * │ qui voit tout — c'est-à-dire en ne vérifiant justement pas ce que ces      │
 * │ rôles restreignent.                                                        │
 * │                                                                            │
 * │ Le constat était écrit au suivi comme une dette d'environnement. Un        │
 * │ script la solde une fois pour toutes : la prochaine session n'a plus à     │
 * │ redécouvrir le problème ni à recréer les comptes à la main.                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ DÉVELOPPEMENT UNIQUEMENT. Le script refuse de s'exécuter si `DATABASE_URL`
 * ne pointe pas sur une base locale — ces comptes n'ont rien à faire en
 * production.
 *
 * Idempotent : relancé, il met à jour au lieu de dupliquer.
 *
 * Usage :
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed-roles-test.ts
 *
 * Puis, pour ouvrir une session avec l'un d'eux :
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/gen-test-token.ts <authUserId>
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole } from '@prisma/client';
import { getDefaultPermissions } from '@vizyo/tracky-shared';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** `resolveLocalUser` cherche l'utilisateur sur `authUserId` : c'est le `sub` du JWT. */
const COMPTES = [
  {
    authUserId: 'seedtest0000conducteur0001',
    email: 'test-conducteur@tracky.local',
    firstName: 'Test',
    lastName: 'Conducteur',
    role: UserRole.DRIVER,
  },
  {
    authUserId: 'seedtest0000veilleur00001',
    email: 'test-veilleur@tracky.local',
    firstName: 'Test',
    lastName: 'Veilleur',
    role: UserRole.NIGHT_WATCHMAN,
  },
] as const;

function estBaseLocale(url: string | undefined): boolean {
  if (!url) return false;
  return /@(localhost|127\.0\.0\.1|postgres|host\.docker\.internal)[:/]/.test(url);
}

async function main(): Promise<void> {
  if (!estBaseLocale(process.env.DATABASE_URL)) {
    throw new Error(
      "Refus : DATABASE_URL ne pointe pas sur une base locale. Ces comptes sont réservés au développement.",
    );
  }

  const fleet = await prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!fleet) throw new Error('Aucune flotte en base — rien à rattacher.');
  console.log(`Flotte cible : ${fleet.name} (${fleet.id})`);

  for (const c of COMPTES) {
    const user = await prisma.user.upsert({
      where: { authUserId: c.authUserId },
      update: {
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        role: c.role,
        fleetId: fleet.id,
        isActive: true,
        permissions: getDefaultPermissions(c.role) as object,
      },
      create: {
        authUserId: c.authUserId,
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        role: c.role,
        fleetId: fleet.id,
        isActive: true,
        permissions: getDefaultPermissions(c.role) as object,
      },
    });
    console.log(`  ${c.role.padEnd(15)} ${c.email}  → authUserId ${c.authUserId}`);

    // Le rôle DRIVER n'a de sens QUE relié à un Driver : `/driver` liste les
    // véhicules du conducteur via `Driver.userId`. Sans cette ligne, le compte
    // existe mais l'écran est vide — et on croirait mesurer un état « vide »
    // légitime alors qu'on mesure un compte mal câblé.
    if (c.role === UserRole.DRIVER) {
      const existant = await prisma.driver.findFirst({ where: { userId: user.id } });
      if (existant) {
        console.log(`      conducteur déjà relié (${existant.id})`);
      } else {
        const libre = await prisma.driver.findFirst({
          where: { fleetId: fleet.id, userId: null },
          orderBy: { createdAt: 'asc' },
        });
        if (libre) {
          await prisma.driver.update({ where: { id: libre.id }, data: { userId: user.id } });
          console.log(`      relié au conducteur existant ${libre.firstName} ${libre.lastName}`);
        } else {
          const cree = await prisma.driver.create({
            data: {
              fleetId: fleet.id,
              firstName: c.firstName,
              lastName: c.lastName,
              email: c.email,
              userId: user.id,
            },
          });
          console.log(`      conducteur créé (${cree.id})`);
        }
      }
    }
  }

  // Un conducteur SANS véhicule affiche un écran vide — légitime, mais ce n'est pas
  // l'état qu'on veut pouvoir mesurer. On lui rattache un véhicule de la flotte via
  // `Vehicle.currentDriverId`, qui est ce que lit `/driver`.
  const conducteur = await prisma.user.findUnique({
    where: { authUserId: 'seedtest0000conducteur0001' },
  });
  if (conducteur) {
    const fiche = await prisma.driver.findFirst({ where: { userId: conducteur.id } });
    if (fiche) {
      const dejaSien = await prisma.vehicle.findFirst({ where: { currentDriverId: fiche.id } });
      if (dejaSien) {
        console.log(`\n  Véhicule déjà rattaché : ${dejaSien.plate}`);
      } else {
        const v = await prisma.vehicle.findFirst({
          where: { fleetId: fleet.id },
          orderBy: { createdAt: 'asc' },
        });
        if (v) {
          await prisma.vehicle.update({ where: { id: v.id }, data: { currentDriverId: fiche.id } });
          console.log(`\n  Véhicule ${v.plate} rattaché au conducteur de test`);
        } else {
          console.log('\n  ⚠️ Aucun véhicule dans la flotte : /driver restera vide.');
        }
      }

      // ⚠️ `currentDriverId` NE DONNE AUCUN DROIT DE LECTURE. Le périmètre d'un
      // utilisateur passe par `UserVehicleAccess` : sans une entrée ici, l'API
      // renvoie une liste vide et l'écran affiche « aucun véhicule attribué » —
      // ce qui est vrai du point de vue des DROITS, mais donne un compte de test
      // inutile. Les deux liens sont nécessaires : l'un dit « c'est son
      // véhicule », l'autre « il a le droit de le voir ».
      const vehiculeSien = await prisma.vehicle.findFirst({ where: { currentDriverId: fiche.id } });
      if (vehiculeSien) {
        const acces = await prisma.userVehicleAccess.findFirst({
          where: { userId: conducteur.id, vehicleId: vehiculeSien.id },
        });
        if (acces) {
          console.log(`  Accès déjà accordé sur ${vehiculeSien.plate}`);
        } else {
          await prisma.userVehicleAccess.create({
            data: { userId: conducteur.id, accessType: 'VEHICLE', vehicleId: vehiculeSien.id },
          });
          console.log(`  Accès VEHICLE accordé sur ${vehiculeSien.plate}`);
        }
      }
    }
  }

  console.log('\nPour ouvrir une session :');
  for (const c of COMPTES) {
    console.log(`  ts-node prisma/gen-test-token.ts ${c.authUserId}   # ${c.role}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

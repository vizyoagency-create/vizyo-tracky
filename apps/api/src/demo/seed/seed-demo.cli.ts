/* eslint-disable no-console */
/**
 * ═══ SEED DE L'ENVIRONNEMENT DE DÉMONSTRATION ═════════════════════════════════════════════
 *
 * À lancer sur la BASE DE DÉMO — une première fois avant le premier import, puis à volonté
 * (idempotent), par exemple après un import pour lier le compte « conducteur » à un conducteur :
 *
 *   docker exec tracky-demo-api node dist/demo/seed/seed-demo.cli.js
 *
 * (en développement : `pnpm --filter @vizyo/tracky-api exec ts-node src/demo/seed/seed-demo.cli.ts`)
 *
 * Ce qu'il pose :
 *   1. le MARQUEUR « base de démonstration » — sans lui, l'importeur refuse d'écrire ici ;
 *   2. le compte système (cible des clés « auteur », comme prisma/seed.ts) ;
 *   3. VOUS, SUPER_ADMIN de la démo (SEED_ADMIN_AUTH_USER_ID + SEED_ADMIN_EMAIL) — votre
 *      identité Vizyo Auth, préalablement liée à l'application « Tracky Démo » ;
 *   4. la société de démo (vide tant que l'import n'est pas passé) ;
 *   5. si DEMO_ACCOUNTS_PASSWORD est renseigné : cinq comptes de rôle sur cette société,
 *      créés dans Vizyo Auth (application « Tracky Démo ») puis provisionnés ici — pour les
 *      démonstrations que Vizyo anime. Les PROSPECTS, eux, reçoivent une INVITATION depuis
 *      /users (docs/environnement-demo/EXPLOITATION.md).
 *
 * Refuse de tourner sans DEMO_MODE=true : ce seed ne doit jamais toucher une autre base.
 * Vit dans `src/` (et non `prisma/`) pour être COMPILÉ dans l'image : l'image de production
 * n'embarque pas les sources TypeScript, seulement `dist/`.
 */
import type { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { getDefaultPermissions } from '@vizyo/tracky-shared';
import { AuthClientService } from '../../auth-client/auth-client.service';
import type { Env } from '../../config/env.validation';
import { idDemo } from '../import/uuid-deterministe';
import { JOURNAL_DEMO } from '../journal-demo';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

const COMPTES_DE_ROLE: ReadonlyArray<{ prefixe: string; role: UserRole; prenom: string; nom: string }> = [
  { prefixe: 'demo-admin', role: UserRole.FLEET_ADMIN, prenom: 'Démo', nom: 'Administrateur' },
  { prefixe: 'demo-gestionnaire', role: UserRole.FLEET_MANAGER, prenom: 'Démo', nom: 'Gestionnaire' },
  { prefixe: 'demo-lecteur', role: UserRole.VIEWER, prenom: 'Démo', nom: 'Lecteur' },
  { prefixe: 'demo-veilleur', role: UserRole.NIGHT_WATCHMAN, prenom: 'Démo', nom: 'Veilleur' },
  { prefixe: 'demo-conducteur', role: UserRole.DRIVER, prenom: 'Démo', nom: 'Conducteur' },
];

function lire(nom: string): string {
  return (process.env[nom] ?? '').trim();
}

async function main(): Promise<void> {
  if (lire('DEMO_MODE') !== 'true') {
    throw new Error("DEMO_MODE=true est requis : ce seed ne tourne que sur l'environnement de démonstration.");
  }
  const sel = lire('DEMO_SALT');
  const idsSource = lire('DEMO_SOURCE_FLEET_IDS').split(',').map((s) => s.trim()).filter(Boolean);
  if (sel.length < 16) throw new Error('DEMO_SALT doit faire au moins 16 caractères.');
  if (idsSource.length === 0) {
    throw new Error("DEMO_SOURCE_FLEET_IDS est vide : impossible de calculer l'identifiant de la société de démo.");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: lire('DATABASE_URL') }) });
  try {
    // 1. Le marqueur.
    const marqueur = await prisma.systemActivityLog.findFirst({
      where: { category: JOURNAL_DEMO.categorie, action: JOURNAL_DEMO.marqueur },
    });
    if (!marqueur) {
      await prisma.systemActivityLog.create({
        data: {
          category: JOURNAL_DEMO.categorie,
          action: JOURNAL_DEMO.marqueur,
          actor: 'seed-demo',
          detail: "Cette base est la base de DÉMONSTRATION : l'importeur peut y écrire, et elle est régénérée depuis la production.",
        },
      });
      console.log('[marqueur] base marquée « démonstration »');
    } else {
      console.log('[marqueur] déjà présent');
    }

    // 2. Le compte système.
    await prisma.user.upsert({
      where: { id: SYSTEM_USER_ID },
      update: {},
      create: {
        id: SYSTEM_USER_ID,
        authUserId: SYSTEM_USER_ID,
        email: 'system@tracky.local',
        firstName: 'System',
        lastName: '',
        role: UserRole.SUPER_ADMIN,
        fleetId: null,
        isActive: false,
      },
    });

    // 3. Vous.
    const adminAuthUserId = lire('SEED_ADMIN_AUTH_USER_ID');
    const adminEmail = lire('SEED_ADMIN_EMAIL').toLowerCase();
    if (adminAuthUserId && adminEmail) {
      await prisma.user.upsert({
        where: { email: adminEmail },
        update: { authUserId: adminAuthUserId, role: UserRole.SUPER_ADMIN, isOwner: true, isActive: true },
        create: {
          authUserId: adminAuthUserId,
          email: adminEmail,
          firstName: 'Admin',
          lastName: 'Vizyo',
          role: UserRole.SUPER_ADMIN,
          isOwner: true,
          fleetId: null,
          // L'assistant de bienvenue n'a rien à apprendre au propriétaire de l'application.
          onboardingCompletedAt: new Date(),
        },
      });
      console.log(`[super-admin] ${adminEmail}`);
    } else {
      console.log('[super-admin] SEED_ADMIN_AUTH_USER_ID / SEED_ADMIN_EMAIL absents — aucun super-admin posé');
    }

    // 4. La société de démo — le même identifiant que l'importeur calculera.
    const idFlotte = idDemo(sel, 'Fleet', idsSource[0]!);
    const nomFlotte = lire('DEMO_FLEET_NAME') || 'Transports Démo';
    await prisma.fleet.upsert({
      where: { id: idFlotte },
      update: {},
      create: { id: idFlotte, name: nomFlotte, clientId: null },
    });
    console.log(`[société] ${nomFlotte} (${idFlotte})`);

    // 5. Les comptes de rôle.
    const motDePasse = lire('DEMO_ACCOUNTS_PASSWORD');
    const domaine = lire('DEMO_ACCOUNTS_DOMAIN') || 'demo.vizyoagency.com';
    if (!motDePasse) {
      console.log('[comptes] DEMO_ACCOUNTS_PASSWORD vide — pas de comptes de rôle');
      return;
    }
    if (motDePasse.length < 12) throw new Error('DEMO_ACCOUNTS_PASSWORD doit faire au moins 12 caractères (règle Vizyo Auth).');

    // Le client Vizyo Auth de l'application, avec la configuration lue dans l'environnement.
    const config = { get: (cle: string) => process.env[cle] } as unknown as ConfigService<Env, true>;
    const auth = new AuthClientService(config);

    for (const compte of COMPTES_DE_ROLE) {
      const email = `${compte.prefixe}@${domaine}`.toLowerCase();
      const nomAffiche = `${compte.prenom} ${compte.nom}`;
      let authUserId: string | undefined;
      try {
        const cree = await auth.register(email, motDePasse, nomAffiche);
        authUserId = cree.id;
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!msg.includes('409') && !msg.includes('already')) throw err;
      }
      if (!authUserId) {
        // Déjà dans Vizyo Auth : la connexion rend le jeton, dont le `sub` est l'identifiant.
        const jetons = await auth.login(email, motDePasse);
        const charge = JSON.parse(Buffer.from(jetons.accessToken.split('.')[1]!, 'base64').toString()) as { sub: string };
        authUserId = charge.sub;
      }
      const utilisateur = await prisma.user.upsert({
        where: { email },
        update: { authUserId, role: compte.role, fleetId: idFlotte, isActive: true },
        create: {
          authUserId,
          email,
          firstName: compte.prenom,
          lastName: compte.nom,
          role: compte.role,
          fleetId: idFlotte,
          permissions: getDefaultPermissions(compte.role) as unknown as Prisma.JsonObject,
          onboardingCompletedAt: new Date(),
        },
      });
      console.log(`[compte] ${email} → ${compte.role}`);

      // Le compte conducteur est lié au premier conducteur actif encore sans compte.
      if (compte.role === UserRole.DRIVER) {
        const dejaLie = await prisma.driver.findUnique({ where: { userId: utilisateur.id } });
        if (dejaLie) {
          console.log(`[conducteur] déjà lié à ${dejaLie.firstName} ${dejaLie.lastName}`);
        } else {
          const libre = await prisma.driver.findFirst({
            where: { fleetId: idFlotte, isActive: true, userId: null },
            orderBy: { lastName: 'asc' },
          });
          if (libre) {
            await prisma.driver.update({ where: { id: libre.id }, data: { userId: utilisateur.id } });
            console.log(`[conducteur] lié à ${libre.firstName} ${libre.lastName}`);
          } else {
            console.log("[conducteur] aucun conducteur importé pour l'instant — relancer ce seed après le premier import");
          }
        }
      }
    }
    console.log('✅ Seed de démonstration terminé');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

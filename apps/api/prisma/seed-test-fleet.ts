/* eslint-disable no-console */
/**
 * V1.11 Phase 2 — Seed des comptes de test pour valider la refonte permissions.
 *
 * Cree dans la flotte cible :
 *   - 2 groupes de vehicules : "Nuit", "Jour" (a peupler manuellement apres)
 *   - 3 invitations preconfigurees pour 3 profils de test :
 *       * test-manager-full@tracky.local   — FLEET_MANAGER avec tout cocher
 *       * test-manager-night@tracky.local  — FLEET_MANAGER restreint (engine_control sur "Nuit" uniquement)
 *       * test-viewer@tracky.local         — VIEWER read-only (pas d'engine_control)
 *
 * NOTE : la matrice scope x permissions ne peut etre creee qu'APRES acceptation
 * des invitations (un user doit exister en DB pour porter ses UserVehicleAccess).
 * Le script affiche une checklist a derouler manuellement apres acceptation.
 *
 * Pre-requis :
 *   - DB Tracky accessible (DATABASE_URL)
 *   - SEED_FLEET_ID : la flotte cible (UUID). Si omis, on prend la 1ere flotte trouvee.
 *   - INVITATION_JWT_SECRET (ou VIZYO_AUTH_JWT_ACCESS_SECRET) : pour signer les liens
 *   - APP_BASE_URL : pour construire le lien /accept-invite (ex: http://localhost:4200)
 *   - SEED_INVITER_USER_ID : l'admin qui "invite" (createdById de l'invitation).
 *     A defaut, on prend le 1er FLEET_ADMIN/SUPER_ADMIN.
 *
 * Usage : pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed-test-fleet.ts
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { getDefaultPermissions, type UserPermissions } from '@vizyo/tracky-shared';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TOKEN_TTL_SECONDS = 24 * 60 * 60;

interface SeedProfile {
  email: string;
  role: UserRole;
  permissions: Partial<UserPermissions>;
  description: string;
}

const PROFILES: SeedProfile[] = [
  {
    email: 'test-manager-full@tracky.local',
    role: UserRole.FLEET_MANAGER,
    permissions: { ...getDefaultPermissions('FLEET_MANAGER'), engine_control: true },
    description: 'Manager avec TOUTES les permissions, peut couper le moteur partout',
  },
  {
    email: 'test-manager-night@tracky.local',
    role: UserRole.FLEET_MANAGER,
    permissions: { ...getDefaultPermissions('FLEET_MANAGER'), engine_control: false },
    description:
      'Manager restreint : engine_control: false en GLOBAL. Apres acceptation, l\'admin doit creer une entry UserVehicleAccess "GROUP=Nuit" avec engine_control: true pour autoriser la coupure UNIQUEMENT sur le groupe Nuit (regle specificite).',
  },
  {
    email: 'test-viewer@tracky.local',
    role: UserRole.VIEWER,
    permissions: { ...getDefaultPermissions('VIEWER'), engine_control: false },
    description: 'Lecteur read-only. Pas de coupure moteur. Pas de modification vehicule.',
  },
];

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function main(): Promise<void> {
  const jwtSecret = process.env.INVITATION_JWT_SECRET || process.env.VIZYO_AUTH_JWT_ACCESS_SECRET;
  if (!jwtSecret) {
    throw new Error('INVITATION_JWT_SECRET (ou VIZYO_AUTH_JWT_ACCESS_SECRET) est requis');
  }
  const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:4200';

  // 1. Resolution de la flotte cible
  let fleetId = process.env.SEED_FLEET_ID;
  if (!fleetId) {
    const fleet = await prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!fleet) throw new Error('Aucune flotte trouvee. Lance d\'abord le seed admin (prisma db seed).');
    fleetId = fleet.id;
    console.log(`[i] SEED_FLEET_ID non fourni — utilise la 1ere flotte : ${fleet.name} (${fleetId})`);
  }

  // 2. Resolution de l'inviter (admin qui "envoie" les invitations)
  let inviterId = process.env.SEED_INVITER_USER_ID;
  if (!inviterId) {
    const inviter = await prisma.user.findFirst({
      where: { role: { in: [UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN] }, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!inviter) throw new Error('Aucun admin trouve pour porter les invitations.');
    inviterId = inviter.id;
    console.log(`[i] SEED_INVITER_USER_ID non fourni — utilise ${inviter.email}`);
  }

  // 3. Creation des groupes (idempotent)
  const groups: { id: string; name: string }[] = [];
  for (const name of ['Nuit', 'Jour']) {
    const grp = await prisma.vehicleGroup.upsert({
      where: { fleetId_name: { fleetId: fleetId!, name } },
      update: {},
      create: { name, fleetId: fleetId! },
    });
    groups.push({ id: grp.id, name: grp.name });
    console.log(`[group] ${name} → ${grp.id}`);
  }

  // 4. Creation des invitations preconfigurees
  console.log('\n=== INVITATIONS ===\n');
  for (const profile of PROFILES) {
    // Auto-revoke any existing PENDING invitation for this email
    await prisma.invitation.updateMany({
      where: { email: profile.email, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });

    // Skip si user deja en DB (deja accepte une fois)
    const existing = await prisma.user.findUnique({ where: { email: profile.email } });
    if (existing) {
      console.log(`[skip] ${profile.email} — deja accepte (user id ${existing.id})`);
      continue;
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

    const inv = await prisma.invitation.create({
      data: {
        email: profile.email,
        role: profile.role,
        fleetId: fleetId!,
        permissions: profile.permissions as object,
        tokenHash,
        expiresAt,
        createdById: inviterId!,
      },
    });

    const inviteJwt = jwt.sign(
      { invitationId: inv.id, token: rawToken },
      jwtSecret,
      { expiresIn: TOKEN_TTL_SECONDS, issuer: 'vizyo-tracky' },
    );
    const acceptUrl = `${appBaseUrl.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(inviteJwt)}`;

    console.log(`[invite] ${profile.email} (${profile.role})`);
    console.log(`         ${profile.description}`);
    console.log(`         LIEN : ${acceptUrl}\n`);
  }

  // 5. Checklist post-acceptation
  console.log('\n=== CHECKLIST A DEROULER APRES ACCEPTATION DES INVITATIONS ===\n');
  console.log('1. Connecte-toi en tant que FLEET_ADMIN.');
  console.log('2. Va sur /vehicles. Assigne 2-3 vehicules au groupe "Nuit", 2-3 au groupe "Jour".');
  console.log('3. Pour chaque user test (Manager Full, Manager Restreint, Viewer) :');
  console.log('   - Va sur /users, clique sur "Perms" pour le user');
  console.log('   - Configure la matrice scope x permissions :');
  console.log('');
  console.log('   == test-manager-full ==');
  console.log('   - Scope ALL → coche engine_control + toutes les autres perms');
  console.log('');
  console.log('   == test-manager-night ==');
  console.log('   - Scope ALL → permissions standard FLEET_MANAGER (engine_control OFF)');
  console.log('   - + Ajouter scope GROUP "Nuit" → cocher SEULEMENT engine_control: true');
  console.log('   - Resultat attendu : peut couper moteur UNIQUEMENT sur vehicules du groupe Nuit');
  console.log('');
  console.log('   == test-viewer ==');
  console.log('   - Scope ALL → permissions standard VIEWER (read-only)');
  console.log('');
  console.log('4. Pour valider, deconnecte-toi puis re-connecte en tant que CHAQUE user test :');
  console.log('   - test-manager-full   : bouton "Couper moteur" visible sur TOUS les vehicules');
  console.log('   - test-manager-night  : bouton visible UNIQUEMENT sur les vehicules du groupe Nuit');
  console.log('   - test-viewer         : bouton invisible partout');
  console.log('');
  console.log('5. Verification API directe (test contournement) :');
  console.log('   - Connecte-toi en tant que test-viewer, recupere son cookie tracky_at');
  console.log('   - curl -X POST http://localhost:3000/api/engine-control/trackers/<tracker_id>/commands \\');
  console.log('       -H "Content-Type: application/json" \\');
  console.log('       --cookie "tracky_at=<token>" \\');
  console.log('       -d \'{"action": "CUT"}\'');
  console.log('   - Resultat attendu : 403 Forbidden "Permission requise : engine_control"');
  console.log('');
}

main()
  .then(() => {
    console.log('\nOK — seed-test-fleet termine.');
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

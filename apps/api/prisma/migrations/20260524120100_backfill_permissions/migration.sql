-- V1.11 Phase 1 — Backfill des permissions par scope.
-- Cf. plan sharded-mixing-shore.md section A.3.
--
-- Objectif : zero regression d'acces apres deploy de la refonte permissions.
--   1. Tout user FLEET_MANAGER/VIEWER sans aucune ligne d'acces voit son
--      User.permissions copie sur une nouvelle ligne ALL.
--   2. Tout user qui a deja des lignes d'acces voit User.permissions copie sur
--      chaque ligne dont permissions IS NULL (semantique "meme perm partout").
--   3. Ajout de la nouvelle cle engine_control: false aux 3 endroits qui
--      portent un JSON permissions (users, user_vehicle_access, invitations).

-- Etape 1 : seeder une ligne ALL pour les users FLEET_MANAGER/VIEWER sans aucune
-- ligne d'acces. Sans cette etape, ils n'auraient acces a aucun vehicule apres
-- le deploy (le resolveur per-vehicle retourne null quand aucune ligne couvre).
INSERT INTO user_vehicle_access (id, "userId", "accessType", permissions, "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  u.id,
  'ALL'::"AccessType",
  u.permissions,
  NOW(),
  NOW()
FROM users u
WHERE u.role IN ('FLEET_MANAGER', 'VIEWER')
  AND u.permissions IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_vehicle_access uva WHERE uva."userId" = u.id
  );

-- Etape 2 : copier User.permissions sur les lignes existantes sans permissions
-- (semantique : avant la refonte, un user avait les memes perms partout).
UPDATE user_vehicle_access uva
SET permissions = u.permissions,
    "updatedAt" = NOW()
FROM users u
WHERE uva."userId" = u.id
  AND uva.permissions IS NULL
  AND u.permissions IS NOT NULL
  AND u.role IN ('FLEET_MANAGER', 'VIEWER');

-- Etape 3 : ajouter engine_control: false aux User.permissions existants.
-- Default false coherent avec le choix produit (manager + viewer configurables
-- par l'admin, jamais autorise par defaut).
UPDATE users
SET permissions = permissions || '{"engine_control": false}'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions ? 'engine_control');

-- Etape 4 : meme chose sur les lignes UserVehicleAccess (issues de l'etape 1 ou 2,
-- ou deja presentes avant la refonte).
UPDATE user_vehicle_access
SET permissions = permissions || '{"engine_control": false}'::jsonb,
    "updatedAt" = NOW()
WHERE permissions IS NOT NULL
  AND NOT (permissions ? 'engine_control');

-- Etape 5 : invitations PENDING (preconfigurees par un FLEET_ADMIN avant la
-- refonte) — ajouter engine_control: false pour ne pas casser l'acceptation a
-- posteriori. Les invitations ACCEPTED/EXPIRED/REVOKED ne sont pas touchees.
UPDATE invitations
SET permissions = permissions || '{"engine_control": false}'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions ? 'engine_control')
  AND status = 'PENDING';

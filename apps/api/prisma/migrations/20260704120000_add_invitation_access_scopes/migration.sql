-- Invitation : scopes d'accès (matrice Accès & Permissions) configurés dès l'invitation.
-- Nullable → les invitations existantes (legacy) retombent sur `permissions` (scope ALL unique).
ALTER TABLE "invitations" ADD COLUMN "accessScopes" JSONB;

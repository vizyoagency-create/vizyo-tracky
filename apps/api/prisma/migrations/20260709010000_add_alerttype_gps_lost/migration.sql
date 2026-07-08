-- Incident FS-253 — la valeur `GPS_LOST` existait dans l'enum Prisma AlertType (schema.prisma)
-- mais n'avait JAMAIS été ajoutée au type Postgres (aucune alerte GPS_LOST n'était créée
-- jusqu'ici : mapCobanAlarm ne la produit pas). Le détecteur gps-integrity la crée désormais →
-- il faut la valeur en base. `IF NOT EXISTS` = idempotent (déjà appliquée à chaud en prod le
-- 2026-07-09). ADD VALUE est supporté en transaction sur Postgres 12+ (valeur non utilisée dans
-- la même transaction).
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'GPS_LOST';

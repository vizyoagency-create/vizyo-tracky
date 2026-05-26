-- V1.12 — User preferences JSON (per-user UI mode notamment).
-- null = mode Tracky par defaut. Pas de backfill necessaire.

ALTER TABLE "users" ADD COLUMN "preferences" JSONB;

-- Ouverture des contrats d'API décidée le 2026-08-16.
--
-- Trois ajouts, tous ADDITIFS : aucune donnée transformée, aucune ligne relue,
-- aucun comportement modifié pour l'existant.

-- ── 1. « Coûts IA » : ce que l'IA PRODUIT, pas seulement ce qu'elle coûte ────
--
-- La page disait le prix sans jamais dire le rendu — une facture sans ligne.
--
-- ⚠️ NULLABLE, et c'est le point : `0` affirmerait « cet appel n'a rien produit »,
-- `NULL` dit « on ne l'a pas noté ». Toutes les lignes antérieures sont dans ce
-- second cas, et on ne réécrit pas le passé pour faire joli dans un graphique.
ALTER TABLE "ai_usage_logs" ADD COLUMN "resultCount" INTEGER;

-- ── 2. « Prévenez-moi si un créneau se libère » ──────────────────────────────
--
-- La sortie n° 3 de la page publique de prise de rendez-vous. Sans elle, un client
-- qui ne trouve aucun créneau referme l'onglet et personne ne le sait.
--
-- ⚠️ Cette table collecte une DONNÉE PERSONNELLE sur une page SANS authentification.
-- Elle porte donc sa propre limite (`expiresAt`, purgé par le cron) : la finalité
-- s'épuise, la donnée part avec elle. Et rien d'autre n'est demandé — ni nom, ni
-- téléphone, ni adresse. Le strict nécessaire pour envoyer un e-mail.
CREATE TABLE "installation_slot_watchers" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "linkId"     UUID NOT NULL,
  "email"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notifiedAt" TIMESTAMP(3),
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "installation_slot_watchers_pkey" PRIMARY KEY ("id")
);

-- Un même e-mail ne s'abonne qu'une fois par lien : sans cette contrainte, dix
-- clics impatients enverraient dix e-mails à la même personne.
CREATE UNIQUE INDEX "installation_slot_watchers_linkId_email_key"
  ON "installation_slot_watchers"("linkId", "email");

-- Index de balayage de la purge.
CREATE INDEX "installation_slot_watchers_expiresAt_idx"
  ON "installation_slot_watchers"("expiresAt");

ALTER TABLE "installation_slot_watchers"
  ADD CONSTRAINT "installation_slot_watchers_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "installation_booking_links"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

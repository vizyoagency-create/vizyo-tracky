-- Sprint V1.10 — Ajoute deviceId optionnel a push_subscriptions
--
-- Permet de dedupliquer une PushSubscription par (userId, deviceId) au lieu de
-- par endpoint uniquement : quand un client se reabonne (PWA reinstallee,
-- endpoint rotate par le push service), la nouvelle sub remplace l'ancienne
-- pour le meme device physique au lieu de creer un doublon.
--
-- Le champ est nullable pour la backward-compat : les subs existantes en prod
-- restent valides sans deviceId. Le frontend genere et stocke l'UUID en
-- localStorage des le prochain refreshSubscription apres ce deploy.

ALTER TABLE "push_subscriptions" ADD COLUMN "deviceId" TEXT;

CREATE INDEX "push_subscriptions_userId_deviceId_idx"
  ON "push_subscriptions" ("userId", "deviceId");

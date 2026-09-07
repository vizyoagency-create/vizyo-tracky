-- Le partage PUBLIC d'un trajet.
--
-- Le bouton << Partager >> du replay copiait l'URL INTERNE de l'application : envoyee a un
-- conducteur sans compte, elle affichait un ecran de connexion. Le lien ne partageait rien.
--
-- Calque sur `mission_share_links` (lot A4) : meme token opaque, meme expiration verifiee a
-- l'heure serveur, meme revocation, meme suivi d'usage, meme purge quotidienne. Un second
-- mecanisme de lien public aurait sa propre idee de la securite.

CREATE TYPE "TripShareDuration" AS ENUM ('HOUR_1', 'HOUR_24', 'DAY_7');

CREATE TABLE "trip_share_links" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "tripId"          UUID NOT NULL,
    "fleetId"         UUID NOT NULL,
    "token"           TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "duration"        "TripShareDuration" NOT NULL,
    "revokedAt"       TIMESTAMP(3),
    "revokedByUserId" UUID,
    "openCount"       INTEGER NOT NULL DEFAULT 0,
    "firstOpenedAt"   TIMESTAMP(3),
    "lastOpenedAt"    TIMESTAMP(3),
    "lastOpenedFrom"  TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_share_links_pkey" PRIMARY KEY ("id")
);

-- Le token est l'UNIQUE justificatif d'acces : sa collision donnerait le trajet d'autrui.
CREATE UNIQUE INDEX "trip_share_links_token_key" ON "trip_share_links"("token");
CREATE INDEX "trip_share_links_tripId_createdAt_idx" ON "trip_share_links"("tripId", "createdAt");
-- L'ecran de surveillance : les liens VIVANTS d'une societe.
CREATE INDEX "trip_share_links_fleetId_expiresAt_idx" ON "trip_share_links"("fleetId", "expiresAt");
-- La purge quotidienne.
CREATE INDEX "trip_share_links_expiresAt_idx" ON "trip_share_links"("expiresAt");

-- CASCADE partout : un trajet supprime, une societe fermee ou un compte efface emportent
-- leurs liens. Un acces public que plus personne n'assume ne doit pas survivre a son objet.
ALTER TABLE "trip_share_links" ADD CONSTRAINT "trip_share_links_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_share_links" ADD CONSTRAINT "trip_share_links_fleetId_fkey"
  FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_share_links" ADD CONSTRAINT "trip_share_links_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

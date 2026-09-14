-- PRISE DE RDV D'INSTALLATION : LE WEEK-END A SES HEURES, ET UNE VISITE EST UNE LIGNE.
--
-- 1. Horaires du week-end. `dayStartMinutes`/`dayEndMinutes` valaient pour TOUS les jours
--    coches : ouvrir le samedi revenait a l'ouvrir de 08:00 a 21:00 comme un mardi. Deux
--    colonnes NULLABLES : null = memes horaires que la semaine, donc aucun lien existant ne
--    change de comportement (ils sont tous a null, et aucun n'a le samedi coche par defaut).
--
-- 2. Les visites. `openCount` + premiere/derniere ouverture repondaient a << combien >>.
--    La question posee est << qui, quand, depuis quoi, et qu'a-t-il fait >> : une ligne par
--    ouverture reelle, avec une chronologie de gestes en JSONB (ajoutes par `||`, donc sans
--    relecture ni course entre deux clics rapides).
--
-- Proportionne : IP tronquee, pas d'user-agent brut (seulement ce qu'on en deduit), hote du
-- referrer seulement, identite posee uniquement quand elle est connue. Cf. le modele Prisma.
--
-- Colonnes ajoutees sans reecriture de ligne (nullables) : aucun verrou long sur la table.

ALTER TABLE "installation_booking_links"
    ADD COLUMN "weekendStartMinutes" INTEGER,
    ADD COLUMN "weekendEndMinutes"   INTEGER;

CREATE TABLE "installation_booking_link_visits" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "linkId"         UUID NOT NULL,
    "fleetId"        UUID NOT NULL,
    "openedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipTruncated"    TEXT,
    "device"         TEXT,
    "os"             TEXT,
    "browser"        TEXT,
    "referrerHost"   TEXT,
    "robot"          BOOLEAN NOT NULL DEFAULT false,
    "contactName"    TEXT,
    "contactEmail"   TEXT,
    "identitySource" TEXT,
    "events"         JSONB NOT NULL DEFAULT '[]',
    "eventCount"     INTEGER NOT NULL DEFAULT 0,
    "bookingId"      UUID,

    CONSTRAINT "installation_booking_link_visits_pkey" PRIMARY KEY ("id")
);

-- Une demande est deposee pendant UNE visite.
CREATE UNIQUE INDEX "installation_booking_link_visits_bookingId_key" ON "installation_booking_link_visits"("bookingId");
-- L'ecran admin : les visites d'un lien, les plus recentes d'abord.
CREATE INDEX "installation_booking_link_visits_linkId_openedAt_idx" ON "installation_booking_link_visits"("linkId", "openedAt");
CREATE INDEX "installation_booking_link_visits_fleetId_openedAt_idx" ON "installation_booking_link_visits"("fleetId", "openedAt");
-- La purge quotidienne.
CREATE INDEX "installation_booking_link_visits_openedAt_idx" ON "installation_booking_link_visits"("openedAt");

-- CASCADE sur le lien : un lien supprime emporte ses visites (elles ne racontent plus rien
-- sans lui). SET NULL sur la demande : supprimer une pose n'efface pas la trace de la visite.
ALTER TABLE "installation_booking_link_visits" ADD CONSTRAINT "installation_booking_link_visits_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "installation_booking_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "installation_booking_link_visits" ADD CONSTRAINT "installation_booking_link_visits_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "installation_bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

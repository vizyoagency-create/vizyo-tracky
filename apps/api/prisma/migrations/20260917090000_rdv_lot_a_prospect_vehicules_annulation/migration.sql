-- LOT A DE LA CONCEPTION V2 (docs/rdv-installation/2026-09-16-CONCEPTION-V2-…, § 3) — 2026-09-17.
--
-- 1. Le lien « prospect » : `fleetId` devient FACULTATIF (rattache a la validation), `companyName`
--    porte le nom de la societe, `maxVehicles` plafonne le multi-vehicules, `createdBy` est enfin
--    RELIE a `users` (« cree par … le … »).
-- 2. La demande : `linkId` facultatif et SET NULL au lieu de CASCADE — l'ecran promettait deja que
--    « les demandes deja recues sont conservees » ; `linkLabel` les garde lisibles. `fleetId`
--    facultatif (prospect). `vehicleCount` et la table des vehicules (une pose par vehicule a la
--    validation). L'annulation (qui, quand, pourquoi). `confirmedBy` relie a `users`.
-- 3. La pose : `bookingId` — plusieurs poses par demande ; l'ancien `installation_bookings.taskId`
--    (1:1) est OBSOLETE, conserve pour le repli d'image, plus ecrit.
--
-- Tout est ADDITIF (colonnes nullables ou a defaut, une table) : l'image precedente lit encore
-- chaque table. Aucune reecriture de ligne, aucun verrou long. Les contraintes de cle etrangere
-- ajoutees sur `createdBy` / `confirmedBy` supposent des identifiants existants : la production
-- ne porte aucun lien ni aucune demande au 17/09 (menage du 16/09).

-- 1. Liens
ALTER TABLE "installation_booking_links"
    ADD COLUMN "companyName" TEXT,
    ADD COLUMN "maxVehicles" INTEGER NOT NULL DEFAULT 3,
    ALTER COLUMN "fleetId" DROP NOT NULL;
ALTER TABLE "installation_booking_links" ADD CONSTRAINT "installation_booking_links_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Demandes
ALTER TABLE "installation_bookings" DROP CONSTRAINT "installation_bookings_linkId_fkey";
ALTER TABLE "installation_bookings"
    ADD COLUMN "linkLabel"    TEXT,
    ADD COLUMN "companyName"  TEXT,
    ADD COLUMN "vehicleCount" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "cancelledAt"  TIMESTAMP(3),
    ADD COLUMN "cancelledBy"  TEXT,
    ADD COLUMN "cancelReason" TEXT,
    ALTER COLUMN "linkId" DROP NOT NULL,
    ALTER COLUMN "fleetId" DROP NOT NULL;
ALTER TABLE "installation_bookings" ADD CONSTRAINT "installation_bookings_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "installation_booking_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "installation_bookings" ADD CONSTRAINT "installation_bookings_confirmedBy_fkey"
  FOREIGN KEY ("confirmedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- `fleetId` etait denormalise SANS cle etrangere : une flotte supprimee laissait son identifiant.
ALTER TABLE "installation_bookings" ADD CONSTRAINT "installation_bookings_fleetId_fkey"
  FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2 ter. Visites d'un lien prospect : pas de flotte
ALTER TABLE "installation_booking_link_visits" ALTER COLUMN "fleetId" DROP NOT NULL;
-- `fleetId` etait denormalise SANS cle etrangere : une flotte supprimee laissait son identifiant.
ALTER TABLE "installation_bookings" ADD CONSTRAINT "installation_bookings_fleetId_fkey"
  FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2 ter. Visites d'un lien prospect : pas de flotte
ALTER TABLE "installation_booking_link_visits" ALTER COLUMN "fleetId" DROP NOT NULL;

-- 2 bis. Les vehicules d'une demande
CREATE TABLE "installation_booking_vehicles" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "bookingId" UUID NOT NULL,
    "position"  INTEGER NOT NULL,
    "plate"     TEXT,
    "brand"     TEXT,
    "model"     TEXT,
    "energy"    "InstallationEnergy",
    "taskId"    UUID,

    CONSTRAINT "installation_booking_vehicles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "installation_booking_vehicles_taskId_key" ON "installation_booking_vehicles"("taskId");
CREATE INDEX "installation_booking_vehicles_bookingId_position_idx" ON "installation_booking_vehicles"("bookingId", "position");
ALTER TABLE "installation_booking_vehicles" ADD CONSTRAINT "installation_booking_vehicles_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "installation_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "installation_booking_vehicles" ADD CONSTRAINT "installation_booking_vehicles_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "installation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Poses
ALTER TABLE "installation_tasks" ADD COLUMN "bookingId" UUID;
CREATE INDEX "installation_tasks_bookingId_idx" ON "installation_tasks"("bookingId");
ALTER TABLE "installation_tasks" ADD CONSTRAINT "installation_tasks_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "installation_bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

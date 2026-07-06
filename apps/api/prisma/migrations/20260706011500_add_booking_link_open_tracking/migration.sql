-- Observabilité des liens de prise de RDV : suivi des OUVERTURES de la page publique
-- (combien de fois le lien a été ouvert + 1re / dernière ouverture).
ALTER TABLE "installation_booking_links" ADD COLUMN "openCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "installation_booking_links" ADD COLUMN "firstOpenedAt" TIMESTAMP(3);
ALTER TABLE "installation_booking_links" ADD COLUMN "lastOpenedAt" TIMESTAMP(3);

-- Incident FS-253 (GPS perdu) — HAND-WRITTEN (chirurgicale) : ajoute la seule colonne
-- `lastNoFixAt` sur `trackers`. Marque la dernière trame `no_fix` (LBS sans lock GPS)
-- reçue d'un boîtier VIVANT. Couplée à un `lastPositionAt` périmé, c'est le discriminant
-- « GPS perdu » (antenne / ciel) vs « simple stationnement » (garé sain = muet).
-- Alimente l'état UI GPS_LOST + le détecteur d'alerte gps-integrity.
ALTER TABLE "trackers" ADD COLUMN "lastNoFixAt" TIMESTAMP(3);

-- Sprint G.3 V1.4 : stockage de la polyligne snappee aux routes (via OSRM).
-- Calculee asynchroniquement apres finalizeTrip ; null en attendant.
ALTER TABLE "trips"
  ADD COLUMN "polylineMatched" TEXT;

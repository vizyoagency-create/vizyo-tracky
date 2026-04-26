-- Sprint F.2 V1.4 : ajout du stockage des sommets pour les geofences POLYGON.
-- JSONB pour rester compatible avec la convention Prisma `Json?` et permettre
-- des requetes en cas de besoin futur (ex : ST_GeomFromGeoJSON pour PostGIS).
ALTER TABLE "geofences"
  ADD COLUMN "polygonPoints" JSONB;

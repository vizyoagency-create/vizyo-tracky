-- Add GEOFENCE_ENTER to AlertType enum
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'GEOFENCE_ENTER';

-- Add new columns to geofences table
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "centerLat" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "centerLng" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "radiusMeters" INTEGER NOT NULL DEFAULT 500;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "color" TEXT DEFAULT '#10e0a0';

-- Add PostGIS geometry column (may already exist from init migration)
DO $$ BEGIN
  ALTER TABLE "geofences" ADD COLUMN "geometry" geography(Geometry, 4326) NOT NULL DEFAULT ST_GeogFromText('POINT(0 0)');
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "geofences_geometry_gix" ON "geofences" USING GIST ("geometry");

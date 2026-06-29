-- Sprint 8 (Palier B) — Anti-double-réservation RACE-PROOF au niveau base.
-- Aucune réservation ferme (CONFIRMED/IN_PROGRESS) ne peut chevaucher une autre sur le
-- même véhicule. tsrange [startAt, endAt) (borne basse incluse, haute exclue = créneaux
-- jointifs autorisés, ex. 9-12 puis 12-15). Doublé d'un pré-check applicatif (409 lisible).
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "vehicle_events" ADD CONSTRAINT "no_overlap_reservation"
  EXCLUDE USING gist (
    "vehicleId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("type" = 'RESERVATION' AND "status" IN ('CONFIRMED', 'IN_PROGRESS'));

-- Garde-fou structurel : une réservation FERME doit avoir un endAt — sinon tsrange("startAt",
-- NULL) = [startAt, ∞) bloquerait tout le futur du véhicule. L'invariant vit au niveau base
-- (pas seulement dans le service TS), pour résister à tout writer hors-bande.
ALTER TABLE "vehicle_events" ADD CONSTRAINT "reservation_requires_endat"
  CHECK ("type" <> 'RESERVATION' OR "status" NOT IN ('CONFIRMED', 'IN_PROGRESS') OR "endAt" IS NOT NULL);

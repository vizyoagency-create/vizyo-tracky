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

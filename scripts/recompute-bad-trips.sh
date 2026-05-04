#!/usr/bin/env bash
#
# recompute-bad-trips.sh — Restaure les vraies durations/distances pour les
# trips ecrases a 0 par la migration `20260504100000_trip_duration_non_negative`.
#
# Contexte : 641 trips legacy avaient `durationSeconds < 0` a cause du bug
# de retransmission GPS hors ordre (trackers store-and-forward). La migration
# a clamp ces valeurs a 0 pour permettre la pose des CHECK constraints.
# Ce script appelle `POST /trips/recompute` pour 3 vehicules x periode large,
# ce qui re-segmente les positions encore presentes en base (retention ~20j)
# via le `TripSegmenterService` (qui pre-trie les positions = donnees saines).
#
# A LANCER UNE SEULE FOIS, peu apres le deploy du fix backend.
#
# Pre-requis :
#   - jq, curl
#   - 2 variables d'env :
#       API_URL  : ex. https://api.vizyo-tracky.com  (sans slash final)
#       API_TOKEN: JWT d'un user SUPER_ADMIN ou FLEET_ADMIN ayant acces aux 3 fleets
#
# Verifier d'abord avec --dry-run, puis lancer en vrai.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

: "${API_URL:?API_URL non defini (ex: export API_URL=https://api.vizyo-tracky.com)}"
: "${API_TOKEN:?API_TOKEN non defini (JWT SUPER_ADMIN ou FLEET_ADMIN)}"

# Vehicules concernes par les trips negatifs (cf. rapport diagnostic du
# 2026-05-04, requete B). On etend la fenetre 1 jour de chaque cote pour
# couvrir les trips a cheval sur minuit.
VEHICLE_IDS=(
  "d209e502-fae5-4697-9523-7680597eeb4d" # tracker 7ae3d894 — 530 bad trips
  "58d50934-df2f-4ca9-b6f1-fc68944c10e8" # tracker 52d07d0f — 100 bad trips
  "5993cd87-622a-4de4-a5c6-7ce16602dc37" # tracker 66117069 — 11 bad trips
)
FROM="2026-04-14T00:00:00Z"
TO="2026-05-04T00:00:00Z"

echo "==> Recompute des trips corrompus (Sprint corruption-durations)"
echo "    API_URL = $API_URL"
echo "    Periode = $FROM -> $TO"
echo "    DRY_RUN = $DRY_RUN"
echo ""

for VID in "${VEHICLE_IDS[@]}"; do
  echo "--> Vehicule $VID"
  PAYLOAD=$(jq -n --arg vid "$VID" --arg from "$FROM" --arg to "$TO" \
    '{vehicleId:$vid, from:$from, to:$to}')

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "    [DRY] POST $API_URL/trips/recompute  $PAYLOAD"
    continue
  fi

  RESP=$(curl -sS -X POST "$API_URL/trips/recompute" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
  echo "    -> $RESP"
  # Petit espacement pour eviter de saturer l'API et le map-matching async.
  sleep 5
done

echo ""
echo "Termine. Verifier en base :"
echo "  SELECT COUNT(*) FROM trips WHERE \"durationSeconds\" = 0 AND \"distanceMeters\" > 0;"
echo "  (devrait baisser fortement vs avant le run)"

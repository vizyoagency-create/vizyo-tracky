#!/usr/bin/env bash
# V1.11 Phase 1 — Matrice exhaustive des tests de specificite per-vehicle.
# Verifie 10 cas (ALL/GROUP/VEHICLE × seul, combinaisons, conflits).
#
# Pour chaque cas : PUT user1's access, POST engine-control sur TE001 (in Nuit)
# et TE002 (in Jour), compare le retour API au resultat attendu.
#
# - "Permission requise" = guard a bloque (= perm denied OU scope ne couvre pas)
# - "Vitesse trop elevee" = guard passe (perm OK, validation metier refuse)

set -u

ADMIN_TOKEN="${ADMIN_TOKEN:-}"
USER1_TOKEN="${USER1_TOKEN:-}"
USER1_ID="${USER1_ID:-6d646d40-9112-4fd6-b0c0-c323d585f06b}"
VEHICLE_TE001="${VEHICLE_TE001:-9d810dc3-ed76-462f-8f89-454369cb48c5}"
VEHICLE_TE002="${VEHICLE_TE002:-6c4cba99-4b6c-43af-8812-c53c0dae99c9}"
TRACKER_TE001="${TRACKER_TE001:-b12ca7a9-a5f7-4b31-b314-3e5e5d116195}"
TRACKER_TE002="${TRACKER_TE002:-f4487754-42dd-481f-8446-872b75e445bc}"
GROUP_NUIT="${GROUP_NUIT:-cc618636-c07c-40b6-bf33-919506251a83}"
GROUP_JOUR="${GROUP_JOUR:-735ebb4d-e89e-4e69-ac0e-a28e70f267cd}"

PASS=0
FAIL=0

# Args: $1 description, $2 entries JSON, $3 expected_TE001, $4 expected_TE002
test_case() {
  local desc="$1"
  local entries="$2"
  local expect_te001="$3"  # "perm" | "vitesse"
  local expect_te002="$4"

  # 1) PUT user1's access
  local put_res
  put_res=$(curl -s -w "\n%{http_code}" -X PUT \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d "{\"entries\":$entries}" \
    "http://localhost:3000/api/users/$USER1_ID/access")
  local put_code
  put_code=$(echo "$put_res" | tail -n1)
  if [ "$put_code" != "200" ]; then
    echo "FAIL [$desc] PUT returned $put_code"
    FAIL=$((FAIL+1)); return
  fi

  # 2) POST engine-control sur TE001 et TE002 avec user1 token
  local r1 r2
  r1=$(curl -s -X POST -H "Authorization: Bearer $USER1_TOKEN" -H "Content-Type: application/json" \
    -d '{"action":"CUT"}' "http://localhost:3000/api/engine-control/trackers/$TRACKER_TE001/commands")
  r2=$(curl -s -X POST -H "Authorization: Bearer $USER1_TOKEN" -H "Content-Type: application/json" \
    -d '{"action":"CUT"}' "http://localhost:3000/api/engine-control/trackers/$TRACKER_TE002/commands")

  # 3) Categorize : on ne s'interesse qu'au comportement du guard.
  #   - guard_deny = guard a bloque (perm denied ou scope ne couvre pas)
  #   - guard_ok   = guard a passe (peu importe si metier refuse pour vitesse ou si commande creee)
  local cat1 cat2
  if echo "$r1" | grep -q "Permission requise"; then cat1="guard_deny"
  elif echo "$r1" | grep -qE "Vitesse|\"id\"|REJECTED|PENDING|SENT"; then cat1="guard_ok"
  else cat1="unknown:$(echo $r1 | head -c 80)"; fi
  if echo "$r2" | grep -q "Permission requise"; then cat2="guard_deny"
  elif echo "$r2" | grep -qE "Vitesse|\"id\"|REJECTED|PENDING|SENT"; then cat2="guard_ok"
  else cat2="unknown:$(echo $r2 | head -c 80)"; fi

  # 4) Compare
  local ok1="OK" ok2="OK"
  [ "$cat1" != "$expect_te001" ] && ok1="FAIL"
  [ "$cat2" != "$expect_te002" ] && ok2="FAIL"

  printf "[%s] %s\n  TE001 (in Nuit): expect=%s got=%s [%s]\n  TE002 (in Jour): expect=%s got=%s [%s]\n" \
    "$desc" "" "$expect_te001" "$cat1" "$ok1" "$expect_te002" "$cat2" "$ok2"

  if [ "$ok1" = "OK" ] && [ "$ok2" = "OK" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

# === Matrice ===
echo "=========================================="
echo " Matrice de specificite — 10 cas"
echo "=========================================="

# D1: ALL engine=true seul → guard passe pour les 2
test_case "D1: ALL true" \
  '[{"type":"ALL","permissions":{"engine_control":true}}]' \
  "guard_ok" "guard_ok"

# D2: ALL engine=false seul → guard bloque les 2
test_case "D2: ALL false" \
  '[{"type":"ALL","permissions":{"engine_control":false}}]' \
  "guard_deny" "guard_deny"

# D3: VEHICLE TE001 engine=true seul → TE001 ok, TE002 pas couvert
test_case "D3: VEHICLE TE001 true" \
  "[{\"type\":\"VEHICLE\",\"vehicleId\":\"$VEHICLE_TE001\",\"permissions\":{\"engine_control\":true}}]" \
  "guard_ok" "guard_deny"

# D4: GROUP Nuit engine=true seul → TE001 ok (in Nuit), TE002 pas couvert
test_case "D4: GROUP Nuit true" \
  "[{\"type\":\"GROUP\",\"groupId\":\"$GROUP_NUIT\",\"permissions\":{\"engine_control\":true}}]" \
  "guard_ok" "guard_deny"

# D5: ALL true + VEHICLE TE001 false → TE001 deny (VEHICLE > ALL), TE002 ok (ALL)
test_case "D5: ALL true + VEHICLE TE001 false" \
  "[{\"type\":\"ALL\",\"permissions\":{\"engine_control\":true}},{\"type\":\"VEHICLE\",\"vehicleId\":\"$VEHICLE_TE001\",\"permissions\":{\"engine_control\":false}}]" \
  "guard_deny" "guard_ok"

# D6: ALL true + GROUP Nuit false → TE001 deny (GROUP > ALL), TE002 ok (ALL)
test_case "D6: ALL true + GROUP Nuit false" \
  "[{\"type\":\"ALL\",\"permissions\":{\"engine_control\":true}},{\"type\":\"GROUP\",\"groupId\":\"$GROUP_NUIT\",\"permissions\":{\"engine_control\":false}}]" \
  "guard_deny" "guard_ok"

# D7: GROUP Nuit true + VEHICLE TE001 false → TE001 deny (VEHICLE > GROUP), TE002 pas couvert
test_case "D7: GROUP Nuit true + VEHICLE TE001 false" \
  "[{\"type\":\"GROUP\",\"groupId\":\"$GROUP_NUIT\",\"permissions\":{\"engine_control\":true}},{\"type\":\"VEHICLE\",\"vehicleId\":\"$VEHICLE_TE001\",\"permissions\":{\"engine_control\":false}}]" \
  "guard_deny" "guard_deny"

# D8: ALL false + GROUP Nuit true → TE001 ok (GROUP > ALL), TE002 deny (ALL = false)
test_case "D8: ALL false + GROUP Nuit true" \
  "[{\"type\":\"ALL\",\"permissions\":{\"engine_control\":false}},{\"type\":\"GROUP\",\"groupId\":\"$GROUP_NUIT\",\"permissions\":{\"engine_control\":true}}]" \
  "guard_ok" "guard_deny"

# D9: ALL false + VEHICLE TE001 true → TE001 ok (VEHICLE > ALL), TE002 deny
test_case "D9: ALL false + VEHICLE TE001 true" \
  "[{\"type\":\"ALL\",\"permissions\":{\"engine_control\":false}},{\"type\":\"VEHICLE\",\"vehicleId\":\"$VEHICLE_TE001\",\"permissions\":{\"engine_control\":true}}]" \
  "guard_ok" "guard_deny"

# D10: GROUP Nuit false + VEHICLE TE001 true → TE001 ok (VEHICLE > GROUP), TE002 pas couvert
test_case "D10: GROUP Nuit false + VEHICLE TE001 true" \
  "[{\"type\":\"GROUP\",\"groupId\":\"$GROUP_NUIT\",\"permissions\":{\"engine_control\":false}},{\"type\":\"VEHICLE\",\"vehicleId\":\"$VEHICLE_TE001\",\"permissions\":{\"engine_control\":true}}]" \
  "guard_ok" "guard_deny"

echo "=========================================="
echo " Resultat : $PASS pass, $FAIL fail"
echo "=========================================="

# Cleanup : restore user1 a ALL avec permissions: null (defaults FLEET_MANAGER)
curl -s -o /dev/null -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"entries":[{"type":"ALL"}]}' \
  "http://localhost:3000/api/users/$USER1_ID/access"

exit $FAIL

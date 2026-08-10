#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  Isolation du role DEPOT, verifiee PAR HTTP contre l'API reelle.
#
#  Les 12 tests d'A1 § 8 tournent sur un Prisma MOCKE : ils prouvent que le code
#  fait ce qu'on croit. Ce script prouve autre chose — que sur de vraies donnees,
#  a travers le vrai pipeline (gardes, resolution de permissions, serialisation),
#  un depot obtient exactement ce qu'il doit obtenir. Les deux se completent.
#
#  PREREQUIS
#    1. docker compose up -d           (postgres + redis)
#    2. prisma migrate deploy
#    3. ts-node prisma/seed.ts         (flotte de demonstration)
#    4. ts-node prisma/seed-depot.ts   (7 camions, 3 depots, 12 missions, 6 trajets)
#    5. pnpm --filter @vizyo/tracky-api dev
#    6. Generer les deux jetons (les variables VIZYO_AUTH_* viennent du .env) :
#         ts-node prisma/gen-test-token.ts seed-depot-a > /tmp/tok_a.txt
#         ts-node prisma/gen-test-token.ts seed-depot-b > /tmp/tok_b.txt
#
#  USAGE   bash prisma/verif-depot-http.sh
#  Attendu : 44 reussites, 0 echec.
#
#  ⚠️ Ne pas lancer PENDANT `pnpm test` : la suite Jest sature le processeur, l'API
#     repond au-dela du delai, et des echecs FANTOMES apparaissent (constate le
#     2026-08-09 : 4 faux echecs, puis 31/31 sur trois passages consecutifs a vide).
#     Le delai est a 25 s pour absorber une machine chargee, pas pour masquer une
#     lenteur reelle — si l'API met vraiment 25 s, il y a un vrai probleme.
# ══════════════════════════════════════════════════════════════════════════════
API=${API_BASE:-http://localhost:3000/api}
A=$(cat "${TOK_A:-/tmp/tok_a.txt}")
B=$(cat "${TOK_B:-/tmp/tok_b.txt}")
ok=0; ko=0

verif() { # libelle, attendu, obtenu
  if [ "$2" = "$3" ]; then echo " OK   $1"; ok=$((ok+1));
  else echo " ECHEC $1 — attendu $2, obtenu $3"; ko=$((ko+1)); fi
}

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 25 -H "Authorization: Bearer $1" "$API$2"; }
corps() { curl -s --max-time 25 -H "Authorization: Bearer $1" "$API$2"; }

echo "═══ ROUTES DE LA FLOTTE : toutes fermees au depot ═══════════"
verif "GET /vehicles"                403 "$(code "$A" /vehicles)"
verif "GET /users"                   403 "$(code "$A" /users)"
verif "GET /trips"                   403 "$(code "$A" /trips)"
verif "GET /alerts"                  403 "$(code "$A" /alerts)"
verif "GET /positions"               403 "$(code "$A" /positions)"
verif "GET /drivers"                 403 "$(code "$A" /drivers)"
verif "GET /reports/stats"           403 "$(code "$A" /reports/stats)"
verif "GET /reports/pdf (export)"    403 "$(code "$A" /reports/pdf)"
verif "GET /reports/csv (export)"    403 "$(code "$A" /reports/csv)"

echo ""
echo "═══ LA FAILLE REFERMEE : trip-analysis ══════════════════════"
verif "GET /trip-analysis/scores"            403 "$(code "$A" /trip-analysis/scores)"
verif "GET /trip-analysis/fuel-stations/map" 403 "$(code "$A" /trip-analysis/fuel-stations/map)"
verif "GET /ai/status"                       403 "$(code "$A" /ai/status)"

echo ""
echo "═══ SON PROPRE ESPACE : ouvert ══════════════════════════════"
verif "GET /depot/missions"          200 "$(code "$A" /depot/missions)"
verif "GET /users/me"                200 "$(code "$A" /users/me)"

echo ""
echo "═══ CE QU'IL VOIT REELLEMENT ════════════════════════════════"
# Lot A3 — le jeu d'essai porte 4 missions DU JOUR plus 6 missions terminees, sans
# quoi l'historique et ses KPI ne seraient jamais exerces. On mesure donc ce qui est
# BORNE (les missions du jour, et l'absence de celles d'autrui), pas un total.
N_A=$(corps "$A" /depot/live | grep -o '"ref"' | wc -l | tr -d ' ')
N_B=$(corps "$B" /depot/live | grep -o '"ref"' | wc -l | tr -d ' ')
verif "le depot A voit 4 missions du jour" 4 "$N_A"
verif "le depot B voit 1 mission"  1 "$N_B"

# L'encart qui nomme ce qui est absent : 7 camions - 4 sur mes missions = 3.
AUTRES_A=$(corps "$A" /depot/live | grep -o '"otherVehiclesCount":[0-9]*' | grep -o '[0-9]*$')
verif "l'encart annonce 3 autres camions" 3 "$AUTRES_A"

echo ""
echo "═══ AUCUNE FUITE DANS LA REPONSE ════════════════════════════"
REP=$(corps "$A" /depot/missions)
for interdit in vehicleId imei trackerId depotUserId driverId notes cost score polyline; do
  if echo "$REP" | grep -q "\"$interdit\""; then
    echo " ECHEC le champ $interdit FUIT dans la reponse"; ko=$((ko+1));
  else echo " OK   $interdit absent"; ok=$((ok+1)); fi
done
# La mission du depot B ne doit apparaitre nulle part chez A.
if echo "$REP" | grep -q "M-0005"; then echo " ECHEC la mission du depot B fuit"; ko=$((ko+1));
else echo " OK   la mission du depot B (M-0005) est absente"; ok=$((ok+1)); fi
if echo "$REP" | grep -q "M-0006"; then echo " ECHEC la mission interne fuit"; ko=$((ko+1));
else echo " OK   la mission interne (M-0006) est absente"; ok=$((ok+1)); fi

echo ""
echo "═══ LE TELEPHONE EST MASQUE COTE SERVEUR ════════════════════"
if echo "$REP" | grep -qE '"phone":"[0-9+][0-9 ]{8,}"'; then
  echo " ECHEC un numero complet transite"; ko=$((ko+1));
else echo " OK   aucun numero complet dans la reponse"; ok=$((ok+1)); fi

echo ""
echo "═══ INDISCERNABILITE : inconnu vs hors perimetre ════════════"
C1=$(code "$A" /depot/missions/00000000-0000-0000-0000-0000000000ff)
M_B=$(corps "$B" /depot/missions | grep -oE '"id":"[^"]+' | head -1 | cut -d'"' -f4)
C2=$(code "$A" "/depot/missions/$M_B")
verif "identifiant inconnu -> 403"        403 "$C1"
verif "mission d'un autre depot -> 403"   403 "$C2"
verif "les deux codes sont identiques" "$C1" "$C2"

echo ""
echo "═══ LOT A3 : LA SURFACE NEUVE EST BORNEE AUSSI ══════════════"
# Les cinq endpoints ajoutes par A3 ouvrent autant de chemins nouveaux. Chacun doit
# etre borne comme les trois d'A1 — c'est ce que verifie cette section.
verif "GET /depot/history"            200 "$(code "$A" /depot/history)"
verif "GET /depot/documents"          200 "$(code "$A" /depot/documents)"

# Le trajet d'une mission du depot A, vu par le depot B : refus.
TRIP_A=$(corps "$A" /depot/history | grep -oE '"tripId":"[^"]+' | head -1 | cut -d'"' -f4)
if [ -n "$TRIP_A" ]; then
  verif "trajet de A lu par A"          200 "$(code "$A" "/depot/trips/$TRIP_A")"
  verif "trajet de A lu par B -> 403"   403 "$(code "$B" "/depot/trips/$TRIP_A")"
else
  echo " ECHEC aucun trajet dans l'historique de A (jeu d'essai incomplet)"; ko=$((ko+1))
fi

# Le bon de livraison d'une mission de A, telecharge par B : refus.
MISSION_DONE=$(corps "$A" /depot/history | grep -oE '"missionId":"[^"]+' | head -1 | cut -d'"' -f4)
verif "bon de livraison de A par B -> 403" 403 "$(code "$B" "/depot/documents/note:$MISSION_DONE/download")"

# L'historique de B ne contient aucune mission de A.
if corps "$B" /depot/history | grep -qE 'M-000[1234]|M-001'; then
  echo " ECHEC une mission du depot A fuit dans l'historique de B"; ko=$((ko+1))
else echo " OK   l'historique de B ne contient aucune mission de A"; ok=$((ok+1)); fi

# Aucune donnee d'exploitation dans l'historique ni dans les documents.
for interdit in maxSpeed avgSpeed fuel score cost consumption; do
  if corps "$A" /depot/history | grep -q "\"$interdit\""; then
    echo " ECHEC le champ $interdit FUIT dans l'historique"; ko=$((ko+1));
  else echo " OK   $interdit absent de l'historique"; ok=$((ok+1)); fi
done

echo ""
echo "════════════════════════════════════════════════════════════"
echo " RESULTAT : $ok reussite(s), $ko echec(s)"
echo "════════════════════════════════════════════════════════════"
[ "$ko" -eq 0 ] || exit 1

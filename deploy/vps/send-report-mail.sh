#!/usr/bin/env bash
# =============================================================================================
# ENVOI D'UN RAPPORT PAR E-MAIL — passerelle minimale vers Resend.
#
# Usage :  ssh root@72.62.26.240 'bash -s "Sujet du message"' < rapport.md
#          cat rapport.md | ssh root@72.62.26.240 "bash /opt/vizyo-tracky/deploy/vps/send-report-mail.sh 'Sujet'"
#
# ── Pourquoi ce script vit sur le VPS et pas sur le poste ────────────────────────────────────
#   L'agent d'audit du PC tourne sur la machine de travail, mais la cle Resend, elle, vit dans
#   `.env.prod` sur le VPS. Faire transiter l'envoi par ici evite de copier un secret sur un
#   poste de developpement — ou il finirait dans un historique de shell, une sauvegarde ou un
#   depot. Le rapport traverse le tunnel SSH ; la cle ne bouge pas.
#
#   Contrepartie assumee : si le VPS est injoignable, l'e-mail ne part pas. L'agent doit donc
#   TOUJOURS ecrire son rapport sur disque d'abord, et signaler l'echec d'envoi — jamais
#   dependre de ce script pour conserver son travail.
#
# ── Ce que ce script n'est pas ──────────────────────────────────────────────────────────────
#   Ce n'est PAS un service d'envoi generique, et il ne doit pas le devenir : le destinataire
#   est fige ci-dessous. Un point d'entree acceptant un destinataire arbitraire derriere un
#   acces SSH partage serait un relais de spam avec notre domaine comme expediteur.
# =============================================================================================

set -uo pipefail

SUJET="${1:-Rapport}"
DESTINATAIRE="${REPORT_MAIL_TO:-younesshaddou31@gmail.com}"
ENV_FILE="/opt/vizyo-tracky/deploy/vps/.env.prod"

# La cle et l'expediteur viennent du meme fichier que l'API : un seul endroit a tenir a jour.
KEY=$(grep -E '^RESEND_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'')
FROM=$(grep -E '^RESEND_FROM=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
FROM="${FROM:-Vizyo <contact@vizyoagency.com>}"

if [ -z "$KEY" ]; then
  echo "ERREUR: RESEND_API_KEY introuvable dans $ENV_FILE — e-mail NON envoye" >&2
  exit 1
fi

CORPS=$(cat)
if [ -z "$CORPS" ]; then
  echo "ERREUR: corps vide sur l'entree standard — e-mail NON envoye" >&2
  exit 1
fi

# `jq -Rs` fait l'echappement JSON du corps entier : un rapport Markdown contient des guillemets,
# des retours a la ligne et des accents, qui casseraient un JSON construit a la main.
if ! command -v jq >/dev/null 2>&1; then
  echo "ERREUR: jq absent (apt install jq) — echappement JSON impossible, e-mail NON envoye" >&2
  exit 1
fi

PAYLOAD=$(jq -n \
  --arg from "$FROM" \
  --arg to "$DESTINATAIRE" \
  --arg subject "$SUJET" \
  --arg text "$CORPS" \
  '{from:$from, to:[$to], subject:$subject, text:$text}')

REPONSE=$(curl -s --max-time 30 --connect-timeout 10 -w '\n%{http_code}' -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1)

CODE=$(printf '%s' "$REPONSE" | tail -1)
CORPS_REP=$(printf '%s' "$REPONSE" | sed '$d')

if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  echo "E-mail envoye a $DESTINATAIRE (HTTP $CODE) — $(printf '%s' "$CORPS_REP" | head -c 120)"
else
  # On ressort le corps de la reponse : un « 422 domain not verified » doit etre LISIBLE,
  # pas reduit a un code. Sinon on cherche la panne du mauvais cote.
  echo "ERREUR d'envoi (HTTP $CODE) : $CORPS_REP" >&2
  exit 1
fi

-- Sprint 4 — Écoute audio : DISARM + filet auto-disarm.
-- Le mode monitor du boîtier Coban/Baanool (SMS `monitor<password>`) OUVRE le micro
-- MAIS COUPE le report de position GPS → un véhicule laissé armé « disparaît » de la
-- carte. On trace donc le retour en mode « track » (SMS `tracker<password>`) via
-- `disarmedAt`. Une écoute ARMÉE = status SENT + disarmedAt NULL ; le désarmement
-- (manuel /stop OU cron de sécurité) pose ce timestamp.

-- AddColumn : disarmedAt (NULL = écoute encore armée OU jamais armée)
ALTER TABLE "audio_monitoring_commands" ADD COLUMN "disarmedAt" TIMESTAMP(3);

-- CreateIndex : couvre la requête du cron auto-disarm (status=SENT AND disarmedAt IS NULL
-- AND sentAt < seuil) sans full-scan de la table d'audit.
CREATE INDEX "audio_monitoring_commands_status_disarmedAt_sentAt_idx" ON "audio_monitoring_commands"("status", "disarmedAt", "sentAt");

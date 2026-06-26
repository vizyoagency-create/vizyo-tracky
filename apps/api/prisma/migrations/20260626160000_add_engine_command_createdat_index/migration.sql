-- Review 2026-06-26 — index global sur createdAt (tri DESC) pour l'audit admin des
-- commandes moteur (GET /admin/activity/engine-commands : ORDER BY createdAt DESC
-- sans filtre trackerId). L'index composite [trackerId, createdAt] existant ne
-- couvre pas ce tri global (colonne de tête = trackerId).
CREATE INDEX "engine_control_commands_createdAt_idx" ON "engine_control_commands"("createdAt" DESC);

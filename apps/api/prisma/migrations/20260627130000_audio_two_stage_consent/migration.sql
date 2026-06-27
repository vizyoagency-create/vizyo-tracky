-- Sprint 4 — Écoute audio : passage à un gating de CONSENTEMENT à DEUX étages.
-- N1 `superAdminEnabled` (prestataire/super-admin) : la flotte est-elle ÉLIGIBLE ? OFF par défaut.
-- N2 `assistanceEnabled` (fleet-admin) : consentement « Mode assistance ». L'ancien `enabled`
--    devient ce consentement N2 (rename pour préserver l'attestation déjà posée).
-- Une écoute n'est permise que si superAdminEnabled ET assistanceEnabled sont true.

-- RenameColumn : enabled (consentement existant) → assistanceEnabled (N2)
ALTER TABLE "fleet_audio_configs" RENAME COLUMN "enabled" TO "assistanceEnabled";

-- AddColumn : superAdminEnabled (N1 éligibilité prestataire) — OFF par défaut
ALTER TABLE "fleet_audio_configs" ADD COLUMN "superAdminEnabled" BOOLEAN NOT NULL DEFAULT false;

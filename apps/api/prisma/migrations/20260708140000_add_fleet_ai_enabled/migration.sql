-- IA (2026-07) — INTERRUPTEUR MAÎTRE de l'assistance IA par flotte. false = toute l'IA (récit de
-- trajet, agent d'agenda, optimiseur, parsing vocal) désactivée pour cette flotte ; l'app reste
-- fonctionnelle sans IA. Togglable par le fleet-admin. true par défaut (comportement historique).
-- Migration HAND-WRITTEN (chirurgicale, anti-drift) : ne touche que cette colonne.
ALTER TABLE "fleets" ADD COLUMN "aiEnabled" BOOLEAN NOT NULL DEFAULT true;

-- IA OPT-IN (2026-07-14) — bascule l'assistance IA en OFF PAR DÉFAUT.
-- Décision owner : « par défaut personne n'a l'IA sauf si je l'active ». Deux effets :
--   1) le DÉFAUT de la colonne passe à false → toute NOUVELLE flotte naît sans IA ;
--   2) RESET des flottes existantes à false → l'IA active pour tests est coupée ; l'owner
--      réactive explicitement chaque société qui doit en bénéficier (via l'UI Coûts IA / réglages).
-- L'analyse DÉTERMINISTE (trajets/arrêts/excès/éco/stations/scores) n'est PAS de l'IA et reste intacte.
-- Migration HAND-WRITTEN (chirurgicale, anti-drift) : ne touche que cette colonne.
ALTER TABLE "fleets" ALTER COLUMN "aiEnabled" SET DEFAULT false;
UPDATE "fleets" SET "aiEnabled" = false;

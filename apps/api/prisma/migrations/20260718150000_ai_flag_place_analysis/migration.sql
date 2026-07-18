-- Switchboard IA — nouvel interrupteur GLOBAL « analyse d'un lieu cle » (station / parking).
-- Defaut TRUE comme les autres flags : la coupure est une action EXPLICITE de l'owner
-- (fail-OPEN assume, cf. AiFeatureFlagsService). Se cumule AU-DESSUS de Fleet.aiEnabled
-- (lui-meme pilote par l'abonnement) et de la permission places_analyze.
ALTER TABLE "ai_feature_flags" ADD COLUMN IF NOT EXISTS "placeAnalysis" BOOLEAN NOT NULL DEFAULT true;

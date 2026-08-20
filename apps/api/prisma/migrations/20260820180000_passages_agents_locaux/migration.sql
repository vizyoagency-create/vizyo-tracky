-- Passages des agents qui tournent sur le poste du proprietaire.
--
-- Pourquoi cette table existe : les deux premiers agents locaux deduisent leur etat du travail
-- qu'ils ont ECRIT. C'etait juste pour eux, qui ont toujours du travail en attente. L'agent de
-- qualite GPS peut legitimement ne RIEN ecrire d'une nuit — aucune zone partagee, aucun boitier
-- disperse. Deduire sa sante de sa production annoncerait « agent a l'arret » precisement quand
-- tout va bien.
--
--   « a-t-il TOURNE ? »  -> cette table, une ligne par passage, meme vide.
--   « a-t-il TROUVE ? »  -> ses ecritures metier, inchangees.
CREATE TABLE "passages_agents_locaux" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent" TEXT NOT NULL,
    "demarreA" TIMESTAMP(3) NOT NULL,
    "finiA" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dureeMs" INTEGER NOT NULL DEFAULT 0,
    "succes" BOOLEAN NOT NULL,
    "resume" TEXT NOT NULL,
    "erreur" TEXT,

    CONSTRAINT "passages_agents_locaux_pkey" PRIMARY KEY ("id")
);

-- L'ecran de supervision ne demande jamais que « le dernier passage de CET agent ».
CREATE INDEX "passages_agents_locaux_agent_finiA_idx"
    ON "passages_agents_locaux" ("agent", "finiA" DESC);

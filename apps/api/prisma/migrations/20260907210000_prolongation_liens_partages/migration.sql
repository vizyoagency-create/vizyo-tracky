-- PROLONGER UN LIEN DE PARTAGE, ET POUVOIR LE RACONTER.
--
-- Jusqu'ici l'expiration etait << calculee a la creation, jamais prolongeable >>. Le cas reel
-- que cela ne couvrait pas : le lien expire pendant que le destinataire dort, ou pendant que
-- le camion roule encore. La seule issue etait d'en regenerer un -- ce qui laisse l'ancien
-- dans la nature et fait perdre son compteur de visites.
--
-- ⚠️ CE QUI REND LA PROLONGATION ACCEPTABLE, C'EST LA TRACE. Sans elle, une echeance repoussee
-- trois fois est indiscernable d'une echeance d'origine : l'ecran de surveillance ne
-- surveillerait plus rien. On enregistre donc COMBIEN de fois, QUAND et PAR QUI.
--
-- `duration` n'est pas touchee : elle reste la duree d'ORIGINE, et `expiresAt` fait foi. Les
-- garder toutes deux permet de lire << 24 h au depart, repousse deux fois >>.
--
-- Colonnes ajoutees avec un defaut : aucune reecriture de ligne, aucun verrou long. Les liens
-- existants valent donc `extendedCount = 0`, ce qui est exact -- aucun n'a jamais ete prolonge.

ALTER TABLE "trip_share_links"
    ADD COLUMN "extendedCount"    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastExtendedAt"   TIMESTAMP(3),
    ADD COLUMN "lastExtendedById" UUID;

ALTER TABLE "mission_share_links"
    ADD COLUMN "extendedCount"    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastExtendedAt"   TIMESTAMP(3),
    ADD COLUMN "lastExtendedById" UUID;

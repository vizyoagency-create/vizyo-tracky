-- CreateTable
CREATE TABLE "disparitions_lignes" (
    "id" UUID NOT NULL,
    "tableCible" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "lignes" INTEGER NOT NULL,
    "utilisateur" TEXT NOT NULL,
    "utilisateurSession" TEXT NOT NULL,
    "adresseClient" TEXT,
    "application" TEXT,
    "requete" TEXT,
    "pidBackend" INTEGER,
    "plusAncienneSupprimee" TIMESTAMP(3),
    "plusRecenteSupprimee" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disparitions_lignes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "disparitions_lignes_createdAt_idx" ON "disparitions_lignes"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "disparitions_lignes_tableCible_createdAt_idx" ON "disparitions_lignes"("tableCible", "createdAt" DESC);


-- ═══════════════════════════════════════════════════════════════════════════════
-- TEMOIN DES DISPARITIONS — TRK-035
--
-- PostgreSQL ne journalise rien sur cette base (`log_statement = none`,
-- `log_connections = off`, `logging_collector = off`) et un seul role porte DELETE
-- ET TRUNCATE. Resultat mesure le 22/08 : 73 lignes disparues de `error_logs` en
-- 20,7 h, l'application prouvant n'en avoir supprime aucune — et personne ne pouvait
-- dire qui.
--
-- Ces declencheurs ne bloquent rien. Ils CONSIGNENT, une ligne par INSTRUCTION.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION consigner_disparition() RETURNS trigger
LANGUAGE plpgsql
-- SECURITY DEFINER : le constat s'ecrit avec les droits du proprietaire de la
-- fonction, pas de l'appelant. Sans interet tant qu'un seul role existe ; decisif le
-- jour ou l'on retirera DELETE au role applicatif — l'audit doit survivre au
-- cloisonnement qu'il justifie.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $consigner$
DECLARE
  nb          bigint;
  borne_min   timestamp;
  borne_max   timestamp;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Table de transition : on lit ce qui vient d'etre supprime SANS declencheur
    -- par ligne. Un DELETE de 170 000 lignes ecrit UN constat, pas 170 000.
    SELECT count(*), min("createdAt"), max("createdAt")
      INTO nb, borne_min, borne_max
      FROM supprimees;
  ELSE
    -- TRUNCATE n'expose AUCUNE table de transition — c'est precisement pour ca
    -- qu'il ne laissait aucune trace, pas meme dans `n_tup_del`. On compte donc
    -- AVANT, pendant que les lignes existent encore : d'ou un declencheur BEFORE.
    EXECUTE format(
      'SELECT count(*), min("createdAt"), max("createdAt") FROM %I', TG_TABLE_NAME
    ) INTO nb, borne_min, borne_max;
  END IF;

  -- Une instruction qui n'emporte rien n'est pas une disparition. La purge
  -- nocturne passe a vide sur `error_logs` depuis des mois : sans ce test, elle
  -- ecrirait un constat par nuit et noierait le vrai signal.
  IF nb IS NULL OR nb = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO disparitions_lignes (
    "id", "tableCible", "operation", "lignes",
    "utilisateur", "utilisateurSession", "adresseClient", "application",
    "requete", "pidBackend", "plusAncienneSupprimee", "plusRecenteSupprimee"
  ) VALUES (
    gen_random_uuid(), TG_TABLE_NAME, TG_OP, nb,
    current_user, session_user,
    -- NULL = socket locale, donc un shell DANS le conteneur. Non nul = TCP :
    -- l'API de production se presente en 172.23.0.x. Ce seul champ separe deja
    -- « l'application a supprime » de « quelqu'un a ouvert psql ».
    inet_client_addr()::text,
    current_setting('application_name', true),
    -- Le texte de l'instruction elle-meme : la clause WHERE dit l'intention.
    current_query(),
    pg_backend_pid(), borne_min, borne_max
  );

  RETURN NULL;
END;
$consigner$;

COMMENT ON FUNCTION consigner_disparition() IS
  'TRK-035 — consigne toute suppression de masse sur error_logs / alerts. Ne bloque jamais.';

-- error_logs ────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_disparition_delete ON error_logs;
CREATE TRIGGER trg_disparition_delete
  AFTER DELETE ON error_logs
  REFERENCING OLD TABLE AS supprimees
  FOR EACH STATEMENT EXECUTE FUNCTION consigner_disparition();

DROP TRIGGER IF EXISTS trg_disparition_truncate ON error_logs;
CREATE TRIGGER trg_disparition_truncate
  BEFORE TRUNCATE ON error_logs
  FOR EACH STATEMENT EXECUTE FUNCTION consigner_disparition();

-- alerts ────────────────────────────────────────────────────────────────────────
-- 41 709 alertes ont ete effacees le 19/08 par un DELETE qu'aucun code applicatif
-- n'emet : il n'existe AUCUN `deleteMany` sur cette table dans tout le depot.
DROP TRIGGER IF EXISTS trg_disparition_delete ON alerts;
CREATE TRIGGER trg_disparition_delete
  AFTER DELETE ON alerts
  REFERENCING OLD TABLE AS supprimees
  FOR EACH STATEMENT EXECUTE FUNCTION consigner_disparition();

DROP TRIGGER IF EXISTS trg_disparition_truncate ON alerts;
CREATE TRIGGER trg_disparition_truncate
  BEFORE TRUNCATE ON alerts
  FOR EACH STATEMENT EXECUTE FUNCTION consigner_disparition();

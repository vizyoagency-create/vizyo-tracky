-- Mot de passe du boîtier, par boîtier (Coban 403C).
--
-- Jusqu'ici la valeur d'usine « 123456 » était écrite EN DUR dans cinq modules (coupe-circuit,
-- audio, surveillance, mode fix, provisionnement). Le 24/09/2026 elle a été trouvée sur internet
-- par une veilleuse de CDEF31 puis diffusée par courriel : quiconque connaît le numéro de SIM
-- d'un boîtier peut immobiliser ou rallumer le véhicule, sans Tracky, sans trace, sans droit.
--
-- ⚠️ LE DÉFAUT VAUT « 123456 » PARCE QUE C'EST LA VÉRITÉ au moment de cette migration : les
-- 46 boîtiers sont en configuration d'usine. Mettre autre chose — ou NULL — ferait mentir la
-- base et casserait le repli SMS du coupe-circuit dès l'application. Le changement réel des
-- boîtiers est une opération SÉPARÉE, boîtier par boîtier, avec accusé du matériel.
--
-- `devicePasswordSetAt` reste NULL : aucun boîtier n'a encore été changé. C'est ce champ, et non
-- une comparaison avec « 123456 », qui dira à l'écran d'administration lesquels sont à risque.
--
-- SQL produit par `prisma migrate diff` puis RESTREINT à ce seul changement : un diff complet
-- embarquait de la dérive préexistante entre l'historique des migrations et le schéma (index et
-- valeurs d'énumération d'autres chantiers), qui n'a rien à faire ici.

-- AlterTable
ALTER TABLE "trackers" ADD COLUMN     "devicePassword" TEXT NOT NULL DEFAULT '123456',
ADD COLUMN     "devicePasswordSetAt" TIMESTAMP(3);

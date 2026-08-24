-- TRK-018 — donner une FIN DE VIE aux commandes moteur, et sortir le routage du champ d'erreur.
--
-- Mesure du 2026-08-24 : 313 commandes `SENT`, dont 307 de plus de 24 h, 0 acquittee depuis
-- l'origine. Rien ne solde jamais ces lignes : la file n'est plus une file. Meme famille que
-- TRK-007 sur `fix_continuous`.
--
-- SQL genere par `prisma migrate diff` (comparaison des deux schemas, sans toucher a aucune
-- base), plus UN retro-remplissage ecrit ici — Prisma ne peut pas l'inferer.
--
-- /!\ `ALTER TYPE ... ADD VALUE` : autorise dans une transaction depuis PostgreSQL 12 (la
-- production est en 16.4), a la condition que la valeur ne soit PAS UTILISEE dans la meme
-- transaction. Cette migration ne fait que l'ajouter — aucun UPDATE ne s'en sert.

-- AlterEnum
ALTER TYPE "CommandStatus" ADD VALUE 'SENT_UNCONFIRMED';

-- AlterTable
ALTER TABLE "engine_control_commands" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "expiredAt" TIMESTAMP(3);

-- Retro-remplissage du canal, UNIQUEMENT sur ce qui est prouvable.
--
-- Jusqu'ici, l'information de routage etait ecrite dans `lastError` (« Envoyé via SMS (TCP
-- indisponible) ») : un champ dont le nom annonce une erreur et le contenu livre autre chose.
-- 153 lignes portent ce marqueur ; elles deviennent `channel = 'SMS'`.
--
-- /!\ ON NE DEVINE PAS LE RESTE. Les 5 191 autres lignes gardent `channel = NULL` — c'est-a-dire
-- « inconnu », ce qui est la verite. Les marquer 'TCP' par defaut fabriquerait une donnee que
-- personne n'a observee, et un chiffre faux qui persiste finit par etre cru.
--
-- /!\ `lastError` N'EST PAS EFFACE. Detruire une donnee pour corriger un NOM serait pire que le
-- nom. Les lignes historiques gardent leur texte ; seules les commandes NOUVELLES cessent
-- d'ecrire du routage dans un champ d'erreur.
UPDATE "engine_control_commands"
SET "channel" = 'SMS'
WHERE "lastError" LIKE 'Envoyé via SMS%';

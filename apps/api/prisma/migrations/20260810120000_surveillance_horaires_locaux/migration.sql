-- Lot B0′ — la surveillance planifiée passe de l'heure UTC à l'heure de la flotte.
--
-- CE QUE CORRIGE LE CHANGEMENT DE CODE
-- `isWithinSchedule` lisait `getUTCHours()`. Une surveillance réglée « 18:00 »
-- démarrait à 18:00 UTC, soit 20:00 à Paris en été : deux heures pendant lesquelles
-- le véhicule n'était pas protégé, alors que l'écran affichait « 18:00 » et que
-- l'antivol était bien « actif ». Le code lit désormais l'heure d'Europe/Paris.
--
-- POURQUOI CETTE MIGRATION EXISTE
-- Sans elle, le changement de lecture DÉPLACERAIT la fenêtre de protection de tous
-- les profils déjà réglés : « 18:00 » stocké voulait dire 20:00 heure locale, il
-- voudrait soudain dire 18:00 heure locale, et l'antivol s'armerait deux heures plus
-- tôt le soir — et se DÉSARMERAIT deux heures plus tôt le matin, ce qui, lui, laisse
-- le véhicule nu. On convertit donc les valeurs pour que le comportement observé soit
-- STRICTEMENT identique avant et après le déploiement.
--
-- LE DÉCALAGE APPLIQUÉ EST CELUI DU JOUR DU DÉPLOIEMENT
-- `AT TIME ZONE` résout +2 h en été (CEST) et +1 h en hiver (CET) : PostgreSQL prend
-- l'offset réellement en vigueur à `CURRENT_DATE`, pas une constante. C'est la seule
-- valeur défendable — une plage récurrente n'a pas d'équivalent UTC unique, c'est
-- précisément la raison de ce lot. Un profil migré en hiver puis relu en été garde la
-- fenêtre qu'affichait l'écran ; c'est l'utilisateur qui décidera de la corriger, avec
-- une saisie qui, cette fois, dit la vérité.
--
-- Seuls les profils SCHEDULED portent des horaires ; les autres ont des colonnes NULL
-- et ne sont pas touchés.

UPDATE "surveillance_profiles"
SET
  "scheduleStartTime" = to_char(
    ((CURRENT_DATE + "scheduleStartTime"::time) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris',
    'HH24:MI'
  ),
  "scheduleEndTime" = to_char(
    ((CURRENT_DATE + "scheduleEndTime"::time) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris',
    'HH24:MI'
  )
WHERE "scheduleStartTime" IS NOT NULL
  AND "scheduleEndTime" IS NOT NULL
  AND "scheduleStartTime" ~ '^[0-9]{2}:[0-9]{2}$'
  AND "scheduleEndTime" ~ '^[0-9]{2}:[0-9]{2}$';

-- `scheduleDays` n'est PAS converti, volontairement. Le jour était déjà lu en UTC ;
-- le décalage ne fait basculer de jour qu'une plage commençant entre 22:00 et minuit
-- UTC. La convertir demanderait de décaler l'ensemble des jours cochés d'un cran pour
-- ces seuls profils — un traitement qui, appliqué à tort, déplacerait la protection
-- d'une nuit entière. On préfère l'écart d'un cas limite à une correction qui peut se
-- tromper en silence : le profil concerné voit ses horaires justes et ses jours à
-- revoir, ce que l'écran lui montre désormais sans ambiguïté.

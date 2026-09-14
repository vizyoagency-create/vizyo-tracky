# Implémentation isolée et procédure Go/No-Go

## État au 13 septembre 2026

Branche : `codex/tracky-cutoff-reliability-2026-09-12`

Worktree : `D:\www\vizyo-agency\vizyo-tracky\vizyo-tracky-reliability-sep2026`
Production : **aucune modification, aucun déploiement, aucun planning réactivé**.

Ce lot retire les faux succès et rend les intentions RESTORE durables. Il ne promet pas
qu'un réseau, Android ou un boîtier ne tombera jamais ; il garantit que Tracky conserve
l'intention, montre l'absence de preuve et alerte au lieu d'abandonner silencieusement.

## Corrections réellement implémentées

- intention idempotente et unicité d'une commande active par boîtier ;
- table durable `EngineDeliveryAttempt` avec canal, numéro, statut, code brut et timestamps ;
- socket absente : intention conservée, attente de reconnexion puis seconde tentative TCP avant SMS ;
- tentative TCP marquée `WRITTEN`, puis fallback SMS planifié après timeout sans ACK ;
- worker RESTORE durable toutes les 15 secondes avec lease, polling du statut SMS, backoff et
  trois tentatives SMS maximum ;
- une RESTORE n'entre plus dans la clôture générique des commandes anciennes ;
- arrivée d'un RESTORE annule les CUT actives contradictoires ;
- `queued`, `accepted`, `sent` et `delivered` restent des preuves de transport, jamais une
  preuve de rallumage ; seule l'ACK ou la remontée ignition confirme l'exécution ;
- webhook signé pour les statuts sortants, plus polling indépendant si le webhook se perd (*émetteur côté relais depuis T45, doc 24 — exige le relais du chantier déployé, doc 25*) ;
- alerte critique après 60 secondes sans confirmation, avec plaque, IMEI, canal et tentative ;
- file SMS cadencée, priorité RESTORE, FIFO à priorité égale et état de file visible ;
- bouton Horaires flotte non bloquant : les CUT rejoignent une file récupérable, au plus un départ
  toutes les 10 secondes, tandis que les RESTORE restent prioritaires ;
- kill-switch `ENGINE_AUTOMATIC_CUT_ENABLED=false` par défaut ;
- préflight avant CUT automatique : passerelle joignable, preuve terminale récente et file saine ;
- état UI « rallumage en cours/non confirmé », sans effacer le statut coupé sur simple HTTP 200 ;
- verrou UI partagé entre carte et fiche, complété par l'idempotence serveur ;
- écran admin SMS distinguant joignabilité et preuve réelle de remise.

## Variables à préparer, sans les appliquer avant décision

```text
ENGINE_AUTOMATIC_CUT_ENABLED=false
SMS_MIN_INTERVAL_MS=15000
SCHEDULE_CUT_QUEUE_INTERVAL_MS=10000
ENGINE_RESTORE_ACK_TIMEOUT_MS=15000
ENGINE_RESTORE_ALERT_AFTER_MS=60000
ENGINE_RESTORE_MAX_SMS_ATTEMPTS=3
ENGINE_RESTORE_TCP_RETRY_MIN=30
ENGINE_MANUAL_RESPONSE_BUDGET_MS=20000
ENGINE_SMS_UNREACHABLE_STREAK=3
ENGINE_TCP_ONLY_RETRY_MIN=5
ENGINE_RESTORE_EXPIRY_MIN=240
ENGINE_CUT_SMS_TTL_S=900
SMS_DAILY_PROOF_RECIPIENT=<numero E.164 neutre — recommande : la SIM du telephone passerelle, a ajouter a l'allowlist Tracky du relais>
```

Côté relais Texto (conteneur `texto-relay`, cf. T43/T44 — la contre-expertise a relevé que ce
document ne les listait pas) :

```text
CAPCOM6_DEVICE_ID=<id du S21 dans GET /3rdparty/v1/devices>
CAPCOM6_SIM_NUMBER=1
CAPCOM6_DEVICE_STALE_SECONDS=240
CAPCOM6_DEVICE_OFFLINE_SECONDS=900
CAPCOM6_REQUEST_TIMEOUT_MS=5000
CAPCOM6_SEND_TIMEOUT_MS=9000
```

Le kill-switch reste `false` pendant le déploiement technique, les tests et le canari. Le passer
à `true` n'est permis qu'après le Go terrain. Les horaires CDEF et MH Cars restent désactivés.

## Ordre proposé pour la fenêtre de validation

> ⚠️ **Corrigé le 14/09 (T47, contre-expertise du 13/09).** Les étapes 3 à 5 décrivaient une
> migration et un déploiement « à la main », contraires à la décision D1 du 13/09 : la production
> se déploie par `deploy/vps/deploy.sh` et par rien d'autre, la migration s'applique au démarrage
> du conteneur, et elle est d'abord **rejouée sur une copie** de la base. La procédure complète —
> téléphone → relais → Tracky, sauvegardes des trois bases, variables, version du serveur capcom6,
> vérifications, 24 h de preuve, rollback — est le **[document 25](./25-PROCEDURE-DE-DEPLOIEMENT-DU-CHANTIER-2026-09-14.md)**.
> Les étapes ci-dessous sont conservées comme sommaire ; en cas d'écart, le document 25 fait foi.

1. sauvegarder les **trois** bases (Tracky, relais, MariaDB capcom6) et noter les images/versions déployées ;
2. vérifier que les plannings CDEF et MH Cars sont toujours désactivés ;
3. **rejouer** la migration additive `20260912110000_engine_delivery_reliability` sur une copie de la production (`tracky_copie`), jamais directement ;
4. déployer par `bash deploy/vps/deploy.sh` (API et Web ensemble, migration au démarrage) avec `ENGINE_AUTOMATIC_CUT_ENABLED=false` — après le téléphone (T43) et le relais ;
5. vérifier l'artefact **dans le conteneur**, `_prisma_migrations`, le journal des déploiements ;
6. vérifier le statut SMS, la file, la dernière preuve terminale et le centre d'alertes ;
7. réaliser un RESTORE TCP sur boîtier de test, puis un RESTORE avec socket coupée ;
8. vérifier : intention, TCP, timeout, SMS cadencé, statut terminal, ACK/ignition ;
9. redémarrer volontairement l'API avec une RESTORE en attente et vérifier sa reprise ;
10. tester deux véhicules internes pendant trois cycles ;
11. décider seulement ensuite d'un petit canari, jamais CDEF en premier.

## Critères Go

- aucune RESTORE ne disparaît après redémarrage ;
- aucune réponse `queued/accepted` ne rend le véhicule « rallumé » ;
- une panne terminale apparaît au centre d'alertes en moins de 60 secondes ;
- une vague contrôlée ne produit pas de rafale Android ;
- le fallback coûte au maximum le nombre borné de SMS prévu ;
- le téléphone reste joignable écran éteint et après redémarrage ;
- le rollback applicatif a été répété hors production ;
- un opérateur est présent pour vérifier physiquement les véhicules du canari.

Si un seul point échoue : **No-Go**, horaires toujours désactivés.

## Rollback sûr

1. laisser immédiatement `ENGINE_AUTOMATIC_CUT_ENABLED=false` ;
2. ne réactiver aucun planning ;
3. revenir à l'image API/Web précédente ;
4. conserver la migration additive et ses journaux ; l'ancienne version ignore ces colonnes ;
5. exporter `EngineControlCommand`, `EngineDeliveryAttempt`, `SmsLog`, `WireLog` et `ErrorLog`
   avant toute nouvelle intervention ;
6. restaurer la base uniquement si une corruption est démontrée, jamais pour un simple rollback code.

## Ce qui reste volontairement non validé

- test terrain avec vrais boîtiers et vraie SIM ;
- perte FCM, Android tué, écran éteint et redémarrage du téléphone ;
- vague réelle de 22 RESTORE dans le SLO ;
- second téléphone/SIM/opérateur ;
- canari puis réactivation progressive.

Ces éléments ne peuvent pas être cochés par des tests locaux. Ils conditionnent la décision finale
de mise en production et la reprise des horaires automatiques.

## Validation locale obtenue

- schéma Prisma valide et client régénéré ;
- build API réussi ;
- build Web réussi (avertissements de budget existants, sans erreur) ;
- suite API complète : succès, zéro échec (relever les nombres dans le rapport de la campagne courante) ;
- tests ciblés couvrant moteur, SMS, webhook, confidentialité démo et véhicules : verts ;
- `git diff --check` : aucune erreur d'espace ou de patch.

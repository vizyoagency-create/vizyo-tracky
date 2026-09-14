# 33 — Journée S21 du 14 septembre : diagnostic, configuration du téléphone passerelle, tests (T43, T61)

Date : 14 septembre 2026, 08:30–09:40 (Paris)
Moyen : Mobile connecté (diffusion d'application et écran du téléphone), base du relais et base Tracky en lecture seule.
Production : **aucun changement** côté VPS. Le téléphone a été **reconfiguré** avec l'accord du propriétaire. 13 SMS de test envoyés.

## 1. Ce que le téléphone était avant (08:40)

| Élément | Constat |
|---|---|
| SMSGate 1.65.0 | ping **non défini** (relève des ordres toutes les 15 min), ordre **LIFO**, ni délai ni limite, SIM = OS default, canal de notification « Auto », **Local server activé** (inutile), 4 webhooks Cloud vers le relais, retry 15, clé de signature posée, Start on boot ON, optimisation batterie désactivée |
| Serveur capcom6 1.43.0 | `GET /3rdparty/v1/settings` = `{}` : aucun réglage, tout au défaut ; un seul appareil, `lastSeen` vieux de 10 min |
| Android 15 / One UI 7 | « Mise en veille des applis inutilisées » **ON** avec 0 appli protégée (67 en veille profonde, pas SMSGate) ; nettoyage mémoire automatique quotidien ; redémarrage automatique OFF ; économiseur de données OFF ; mode économie d'énergie OFF ; SMSGate « Non restreinte » ; Wi-Fi Freebox + 5G SA (« 5G préféré ») |
| Le téléphone | personnel, 216 applis, 70 % **sur batterie**, uptime 60 h 08 → dernier redémarrage le 11/09 vers 20:45 |
| File de l'app | 453 sortants : 335 delivered, 66 sent, 52 failed ; dernier sortant le 11/09 20:49 |
| Journal de l'app | 50 dernières lignes = SMS entrants et webhooks réussis des 13/09 18:01–22:55, aucune erreur |

## 2. Ce que la file de l'app montrait sur le 11/09

- 07:00 : Tracky soumet 10 RESTORE en 6 s ; le téléphone les relève à **07:07:33** (pas de push, pull de secours) ; en 4 s, 5 delivered et 5 failed.
- 07:40 → 18:00 : 8 reprises, 8 échecs « `Send result: RESULT_ERROR_GENERIC_FAILURE` », toujours vers les mêmes numéros.
- ~20:45 : redémarrage du téléphone ; 20:49 : RESTORE FG-669-DQ créée, relevée à **21:55** (« Sent », jamais remise : boîtier muet depuis le 06/09).

Croisement avec la base du relais depuis juin : 10 numéros de SIM n'avaient jamais reçu un SMS du S21 (…621085 : 36 échecs), leurs voisines
de la même série livrant à 100 %. Première conclusion (08:58) : « la destination ». **Elle a été révisée par les tests (§4).**

## 3. Ce qui a été changé sur le téléphone (09:05–09:20, avec accord)

| Où | Réglage | Valeur |
|---|---|---|
| SMSGate → Ping | Interval (seconds) | **60** — c'est aussi la fréquence de relève des ordres (15 min → 60 s) |
| SMSGate → Messages | Processing order | **FIFO** |
| SMSGate → Messages | Delays min / max | **10 / 15** s |
| SMSGate → Messages | Limits | **hour / 60** (les RESTORE, priorité 100, contournent délais et limite) |
| SMSGate → Home | Local server | **OFF** (Cloud server ON, Start on boot ON) |
| Android → Batterie → Limites arrière-plan | Mise en veille des applis inutilisées | **OFF** (SMSGate n'est pas proposée dans « jamais en veille » : déjà « Non restreinte ») |

Deux pièges rencontrés, à connaître : le ping ne démarre qu'après un **redémarrage de l'app** (Forcer l'arrêt → Ouvrir) ; et après cette
relance, la **diffusion d'application** de Mobile connecté affiche un écran noir ou « SMSGate s'arrête systématiquement » alors que l'app,
ouverte sur le téléphone lui-même, est normale (Home, ONLINE ; journal : « FCM registration finished », « SendMessagesWorker finished
successfully » à 09:20:28).

**Preuve** : `lastSeen` (lu sur `/3rdparty/v1/devices`) avance de 60 s en 60 s depuis 09:23:28 — 09:24:28, 09:25:28, 09:26:28, 09:27:28,
… 09:35:29. La preuve hebdomadaire de 09:00 vers la propre SIM du S21 est **delivered** (l'auto-envoi S21 → S21 marche : le destinataire
de la preuve quotidienne de T45 peut être cette SIM).

## 4. Tests SMS (09:30–09:35, `check123456` uniquement, aucun stop/start)

13 SMS internationaux facturés sur la ligne du S21 ; série arrêtée à la demande du propriétaire. À retenir : **aucune série de SMS sans
coût unitaire annoncé et nombre convenu**.

| Heure | Chemin | Numéro | Véhicule | Résultat |
|---|---|---|---|---|
| 09:30, 09:31 | app Messages | …621085 | HM-779-GA | partis, 2 réponses du boîtier |
| 09:32:19 | relais (production) | …621085 | HM-779-GA | **delivered en 8 s**, réponse à 09:32:28 |
| 09:34:11 | relais | …621101 | GS-187-NY (témoin) | delivered, réponse |
| 09:34:14 | relais | …621099 | **HD-584-BF** | **failed** à 09:34:24 |
| 09:34:17 | relais | …609501 | GS-014-NY | delivered, réponse |
| 09:34:20 | relais | …621100 | GR-294-VW | delivered, réponse |
| 09:34:23 | relais | …621105 | HM-769-GA | delivered, réponse (« GPS: no gps ») |
| 09:34:26 | relais | …605300 | HD-597-XY | delivered, réponse |
| 09:34:30 | relais | …621103 | **BP-434-RD** | **failed** à 09:34:54 |
| 09:34:33 / :36 / :39 | relais | …621087 / …621088 / …621098 | FZ-862-VY, FS-808-CE, FS-253-HR | `sent`, pas de remise — boîtiers éteints depuis le 31/08 |

Le téléphone a appliqué les réglages : ordre FIFO, un départ toutes les 10–13 s. Le relais a reçu toutes les réponses (`sms:received`).

## 5. Conclusion révisée

1. **Le défaut du 11/09 tenait d'abord au téléphone** : relève des ordres toutes les 15 min (7 min de retard le matin, 1 h 06 le soir avec le
   redémarrage), aucune régulation, application jamais redémarrée. C'est corrigé (§3) et prouvé (ping 60 s).
2. **8 des 10 SIM « injoignables » répondent** dès que le téléphone est en état. La conclusion « destination » du matin était fausse pour elles.
3. **2 SIM restent injoignables au départ** : HD-584-BF (…621099) et BP-434-RD (…621103), à 8 s et 30 s d'envois réussis vers leurs voisines,
   boîtiers en ligne (positions à 09:36), SIM activées, IMEI vu par le fournisseur = IMEI du boîtier. Aucune différence visible côté Tracky ni
   côté WhereverSIM. Pour ces deux véhicules, **le secours SMS n'existe pas aujourd'hui : TCP seul**. Reste, si le propriétaire le veut : un
   SMS depuis une SIM d'un autre opérateur (coût annoncé avant), sinon un ticket WhereverSIM avec les deux ICCID.
4. Les boîtiers roulent sur 208-20 (Bouygues) en LTE et répondent en quelques secondes : la chaîne relais → téléphone → boîtier → téléphone →
   relais fonctionne de bout en bout.

## 6. Ce qui reste, côté téléphone

- Relire `lastSeen` après 30 min écran éteint, sans toucher au téléphone (le propriétaire le pose et le branche).
- Dans la fenêtre de déploiement (doc 25 §4.2) : `CAPCOM6_DEVICE_ID` (SMSGate → Settings → Cloud server → Device ID), `CAPCOM6_SIM_NUMBER=1`,
  seuils 240 / 900 s, délais.
- Structurel, non traité : le S21 est un téléphone personnel (batterie, usage quotidien, SMS personnels relayés dans la base du relais) — un
  téléphone dédié, branché en permanence, reste la seule vraie fiabilisation de ce maillon (doc 12, T55).

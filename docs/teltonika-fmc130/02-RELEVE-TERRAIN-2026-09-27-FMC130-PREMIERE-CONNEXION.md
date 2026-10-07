# Relevé de terrain — première connexion d'un FMC130, 2026-09-27

> **Objet :** valider la chaîne APN → réseau → pare-feu → TCP → handshake → AVL avec un vrai
> boîtier, avant tout développement Teltonika dans Tracky.
> **Outil :** `outils/ecoute-teltonika.mjs` (écouteur jetable, hors Tracky), port 5027.
> **Boîtier :** Teltonika FMC130, IMEI `860848082352569`, sur Renault Master avec adaptateur
> CAN-CONTROL fraîchement posé.
> **Verdict :** ✅ chaîne de transport validée de bout en bout · ❌ adaptateur CAN muet.

---

## 1. Ce qui est prouvé

| Élément | Mesure |
|---|---|
| Première connexion | 12:06:06 UTC, depuis `46.114.215.195:28043` |
| Handshake | 2 octets de longueur (`00 0F`) + IMEI ASCII → serveur répond **`0x01`** |
| Codec | **Codec 8 Extended (0x8E)** — confirmé sur matériel réel |
| Paquets AVL | **347** en une session de **822 s** |
| Enregistrements | **4 825**, horodatés du **02/09 14:51** au **27/09 12:19** UTC |
| CRC-16 | **concordant sur les 347** — l'implémentation CRC-16/ARC est juste sur du trafic réel |
| Accusés | 4 octets big-endian = nombre d'enregistrements ; acceptés par le boîtier |
| Trames rejetées | **0** |
| Fix GPS | 13 à 17 satellites ; **0 enregistrement sans fix** |

L'encodage supposé à l'étape 0 (rapport § 6, vérifié sur les trames d'exemple de la
documentation) **se confirme au contact du matériel**, sans un seul écart.

## 2. Le jeu d'IO réellement émis — 12 éléments, tous permanents

Identique sur les 4 825 enregistrements, du 2 au 27 septembre :

| ID | Taille | Nom | Valeur observée |
|---:|---:|---|---|
| 16 | 4 o | Odomètre total | 71 908 → 309 807 |
| 21 | 1 o | Qualité du signal GSM | 4–5 |
| 66 | 2 o | Tension externe (mV) | **14 093 moteur tournant · 12 273–12 388 moteur coupé** |
| 67 | 2 o | Tension batterie interne (mV) | 4 127–4 128 |
| 68 | 2 o | Courant batterie | 0 |
| 69 | 1 o | État GNSS | 1 |
| 181 | 2 o | PDOP | 10–13 |
| 182 | 2 o | HDOP | 7–8 |
| 200 | 1 o | Veille | 0 |
| 239 | 1 o | Contact (ignition) | 1 |
| 240 | 1 o | Mouvement | 1 |
| 241 | 4 o | Opérateur GSM actif | **20801 / 20810 = Orange France** |

**Tous ces identifiants sont < 256, et il n'y a AUCUN élément de la catégorie NX
(longueur variable).**

## 3. ❌ L'adaptateur CAN-CONTROL ne fournit rien

Sur **92 enregistrements datés du 27/09**, donc postérieurs à la pose :

- **0 VIN** (recherche par la forme : 17 caractères du jeu ISO 3779)
- **0 IO dans les plages CAN** (801-838, 900-929, 930-1012, 1100-1125)
- **0 élément NX** — et c'est le constat décisif : **VIN, codes défaut et valeurs CAN
  longues ne peuvent voyager QUE dans la catégorie NX.** Zéro NX = zéro donnée CAN, quelle
  que soit la configuration.

Les 12 IO observés sont exactement le jeu permanent par défaut du FMC130 : la signature
d'un boîtier dont **la section CAN n'a jamais été activée**.

Pistes, dans l'ordre de coût croissant :
1. **Moteur non démarré** pendant tout le relevé (tension externe 12,3 V). Sur beaucoup de
   véhicules le bus CAN dort ou ne diffuse qu'une partie des trames contact mis / moteur
   coupé. Test le moins cher : démarrer une minute.
2. **Section CAN Adapter non activée** dans la configuration du boîtier, et paramètres CAN
   non cochés dans les I/O. Le FMC130 n'émet que ce qui est activé.
3. **Numéro de programme du CAN-CONTROL** absent ou faux pour le Master.
4. Adaptateur raccordé sur la prise OBD au lieu de ses fils dédiés.

⚠️ **L'identifiant IO réel du VIN sur ce couple FMC130 + CAN-CONTROL + Master reste donc
inconnu.** C'était le vecteur de test attendu pour l'étape 2 : il faudra un second passage
terrain une fois le CAN actif. L'écouteur est prêt à le capter et à nommer l'identifiant.

## 4. 🔴 Découverte qui change l'étape 5 : le Teltonika FERME sa socket

```
━━━ connexion fermée · IMEI 860848082352569 · 347 paquet(s) AVL · 822 s · 0 octet inutilisé ━━━
```

À 12:19:48, après avoir reçu l'accusé de son dernier relevé, le boîtier a **raccroché
proprement**. C'est l'opposé du Coban, qui maintient sa socket en permanence avec un
heartbeat toutes les 30 s.

**Conséquence directe pour la file de commandes (étape 5) et le blocage moteur (étape 6) :**
une trame Codec 12 ne peut partir que pendant les quelques secondes où la socket est
ouverte. À l'arrêt, la cadence mesurée est de **300 s** entre deux relevés — la fenêtre de
tir est donc de quelques secondes toutes les cinq minutes. Un `lvcanblockengine` ne sera
**pas** immédiat comme sur Coban.

**Bonne nouvelle : le mécanisme existe déjà dans Tracky.** `SocketRegistryService` émet
`TRACKER_CONNECTED_EVENT` à chaque socket neuve, et `EngineControlService` s'en sert déjà
pour relancer les RESTORE en attente à la reconnexion (T42, contre-expertise du 13/09).
L'architecture est donc déjà bonne pour un boîtier qui se reconnecte ; il faudra la
réutiliser, pas l'inventer.

Levier côté matériel si une fenêtre plus large est voulue : le paramètre **Open Link
Timeout** du Configurator (coût : data). À trancher à l'étape 5, pas avant.

## 5. Autres mesures utiles

- **Cadence** : 300 s exactement entre relevés à l'arrêt (12:09:45 → 12:14:45 → 12:19:45).
- **Rattrapage** : 25 jours d'arriéré déversés en ~13 min, ~17 enregistrements/s, par
  paquets de 14 enregistrements pour 1 205 octets. Un boîtier qui retrouve un serveur
  après une coupure longue **inonde** : l'ingestion Tracky devra l'encaisser (sampling,
  anti-replay) sans prendre ces positions pour du temps réel.
- **Chemin réseau** : radio **Orange France** (IO 241 = 208-01/208-10), sortie data
  **Telefónica Allemagne** (`46.114.215.195`) — signature de l'APN
  `iotde.telefonica.com`. C'est la preuve par la mesure de l'APN qui fonctionne.
- **APN de production** : `iotde.telefonica.com`, **sans login ni mot de passe**.
  ⚠️ La valeur `wsim` présente dans le code (`tracker-provisioning.service.ts:36` et les
  fixtures de test) est une **valeur de test**, pas l'APN du parc.
- **Le boîtier frappait déjà le port 5027 avant l'ouverture du pare-feu** : le journal ufw
  porte 10 `[UFW BLOCK] DPT=5027` de 12:04:22 à 12:04:34, toutes les 3 s. Sa configuration
  était donc correcte dès le départ ; le pare-feu était le seul obstacle.

## 6. Ce que l'écouteur a démontré sur lui-même

Éprouvé en conditions réelles sur 347 paquets et 4 825 enregistrements, **sans un seul
plantage** : découpage par préfixe de longueur, reconstitution de trames arrivant en
plusieurs segments TCP, vérification CRC, catégories N1/N2/N4/N8/NX, accusés. Le décodeur
Codec 8 Extended de l'étape 2 peut être écrit avec confiance sur cette base — c'est
désormais du code validé contre du matériel, plus seulement contre la documentation.

## 7. Fin de séance

À 12:19:48 le boîtier s'est déconnecté et **n'est pas revenu** (constaté jusqu'à 12:36:27,
soit 17 min). Diagnostic établi par la mesure, pas par supposition :

- écouteur, port 5027, session tmux et règle ufw **vérifiés vivants** ;
- compteur de SYN bloqués sur 5027 **plat (10 → 10)** : le boîtier n'émet **rien**, il
  n'est pas refusé — il est absent ;
- donc la cause est **en amont** du protocole : très probablement la session Bluetooth du
  Configurator, qui suspend le lien GPRS sur les FMB/FMC, ou une configuration sauvegardée
  entre-temps.

Le port 5023 et le parc Coban sont restés intacts pendant toute la séance.

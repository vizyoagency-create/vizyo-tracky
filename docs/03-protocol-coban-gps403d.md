# 03 — Protocole Coban GPS403D

> **Statut :** V1 — issue du reverse-engineering de Traccar (`Gps103ProtocolDecoder.java`), des manuels Coban GPS103-A/B et GPS403, et des trames brutes partagées par des intégrateurs sur les forums Traccar/OpenGTS.
> **Périmètre :** tout ce que Vizyo Tracky doit savoir pour parler au GPS403D en TCP sur le port `5001`.
> **À valider :** certaines trames doivent être confirmées avec de vraies captures Wireshark du parc Tracky (voir §11).

---

## 1. Vue d'ensemble

### 1.1 Identité du matériel

Le **Coban GPS403D** (rebrandé Baanool GPS403D) est un traceur véhicule 12–24 V avec coupure moteur à distance, entrée/sortie numériques (ACC, porte, SOS, sirène), micro pour écoute cabine, et batterie de secours. Il partage son firmware et son protocole réseau avec toute la famille Coban **GPS103 / GPS303 / GPS304 / GPS306 / GPS310 / GPS311 / GPS312 / TK103 / GPS403 / GPS405 / GPS408**.

Dans l'écosystème open-source, ce protocole est connu sous le nom **`gps103`** (Traccar, OpenGTS, gps-trace, GPSWOX). Le port TCP standard est **5001**.

### 1.2 Canaux de communication

Le boîtier dispose de **trois canaux** qui partagent la même syntaxe de commande :

| Canal  | Direction         | Usage                                                                                       |
| ------ | ----------------- | ------------------------------------------------------------------------------------------- |
| SMS    | bidirectionnel    | Config initiale (APN, serveur), récupération si GPRS down, commandes au numéro autorisé     |
| GPRS   | montant (TCP)     | Remontée des positions, alarmes, heartbeats au serveur Tracky                               |
| GPRS   | descendant (TCP)  | Commandes du serveur vers le boîtier, via la socket **déjà ouverte** par le boîtier         |

**Point critique :** le boîtier est **client TCP**, jamais serveur. Le serveur Tracky ne peut pas initier de connexion vers le boîtier — il doit attendre que le boîtier se connecte, stocker la socket active par IMEI, puis écrire dedans pour envoyer des commandes.

### 1.3 Modes d'envoi des positions

Le boîtier a deux modes de reporting, activables par SMS :

- **`tracker` (défaut)** : envoie une position à chaque `fix` configuré (ex. `fix030s***n123456` = toutes les 30 s en continu)
- **`monitor`** : micro ouvert, le boîtier se laisse appeler pour écouter la cabine (pas de positions GPRS)

Le mode **`protocol 18`** (`protocol123456 18`) enrichit les trames avec l'état ACC, porte, niveaux carburant, température. **C'est le mode à activer pour Tracky** — sans lui, beaucoup de champs sont vides.

---

## 2. Architecture réseau

### 2.1 Handshake TCP complet

Séquence observée en production (trames hexadécimales issues des logs Traccar, forum Coban 306A) :

```
[T+0.000] TCP SYN          : boîtier → serveur:5001
[T+0.005] TCP SYN/ACK      : serveur → boîtier
[T+0.010] TCP ACK          : boîtier → serveur

[T+0.100] boîtier → serveur : "##,imei:865328021056352,A;"
          HEX : 23 23 2c 69 6d 65 69 3a 38 36 35 33 32 38 30 32 31 30 35 36 33 35 32 2c 41 3b

[T+0.120] serveur → boîtier : "LOAD"
          HEX : 4c 4f 41 44

[T+0.200] boîtier → serveur : "imei:865328021056352,tracker,..."  (première position)

[T+42.000] boîtier → serveur : "865328021056352;"                 (heartbeat nu)
           HEX : 38 36 35 33 32 38 30 32 31 30 35 36 33 35 32 3b

[T+42.005] serveur → boîtier : "ON"
           HEX : 4f 4e
```

**Règles à coder dans Tracky :**

1. Quand le serveur reçoit une trame qui **contient `imei:` et fait ≤ 30 octets**, c'est le login packet → répondre **`LOAD`** (4 octets, sans retour chariot).
2. Quand le serveur reçoit une trame qui **commence par un chiffre** (l'IMEI nu suivi de `;`), c'est un heartbeat → répondre **`ON`** (2 octets).
3. Toute autre trame contenant `imei:` est une position, une alarme, un rapport OBD ou une photo → parser selon §3.
4. Si le boîtier envoie une alarme `help me` (SOS), le serveur doit répondre **`**,imei:<IMEI>,E;`** pour acquitter la détresse (sinon le boîtier répète toutes les 3 min).

### 2.2 Cycle de vie de la socket

- Le boîtier **garde la socket ouverte en permanence** tant que le GPRS est stable. Heartbeat toutes les ~60 s.
- Si le réseau tombe, le boîtier **reconnecte automatiquement** (firmware Simcom900B).
- Chaque reconnexion **ré-envoie un login packet** (`##,imei:...,A;`) — Tracky doit donc nettoyer la map `imei → socket` à chaque déconnexion et la repeupler à chaque `LOAD`.
- **Le boîtier ne signale pas explicitement une déconnexion propre** — Tracky doit considérer qu'un silence > 3 × `heartbeatInterval` = boîtier offline.

### 2.3 Framing au niveau applicatif

Le protocole est **texte ASCII**, délimité par `;` ou `\r\n`. Chaque trame est une ligne. Pour NestJS, cela signifie un `net.Socket` avec un buffer accumulateur qui split sur `;` — Traccar utilise exactement ce découpage :

```java
// Gps103Protocol.java (Traccar, côté Netty)
pipeline.addLast("frameDecoder",
    new CharacterDelimiterFrameDecoder(1024, "\r\n", "\n", ";"));
```

En NestJS/Node pur :

```ts
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('ascii');
  let idx: number;
  while ((idx = buffer.search(/[;\r\n]/)) !== -1) {
    const frame = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (frame.length > 0) handleFrame(frame, socket);
  }
});
```

---

## 3. Trames montantes (boîtier → serveur)

### 3.1 Login packet

```
##,imei:<IMEI 15 digits>,A;
```

- Envoyé **une seule fois** juste après l'établissement TCP.
- `A` = demande d'authentification / heartbeat initial.
- Réponse serveur : `LOAD`.

### 3.2 Heartbeat nu

```
<IMEI 15 digits>;
```

- Envoyé périodiquement (typiquement toutes les 60 s) quand aucune position n'est à remonter.
- Réponse serveur : `ON`.
- Sert à maintenir la socket ouverte côté NAT opérateur.

### 3.3 Trame de position (format principal)

C'est le format que Tracky va voir 99 % du temps. Syntaxe :

```
imei:<IMEI>,<alarm>,<local_date>,<rfid>,<F|L>,<utc_time>,<valid>,<lat_ddmm.mmmm>,<N|S>,<lon_dddmm.mmmm>,<E|W>,<speed>,<course>,<altitude>,<ignition>,<door>,<fuel1>,<fuel2>,<temperature>,;
```

**Exemple réel** (capté par un membre du forum Traccar) :

```
imei:864035050002451,tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;
```

| Champ             | Valeur                | Notes                                                                                    |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `imei:`           | `864035050002451`     | 15 chiffres, identifiant unique du boîtier                                               |
| `alarm`           | `tracker`             | voir §3.6 pour la liste                                                                  |
| `local_date`      | `201223064947`        | `yymmddhhmmss` en heure **locale** du boîtier (config `time zone`)                       |
| `rfid`            | vide                  | lecteur RFID optionnel                                                                   |
| type GPS          | `F`                   | `F` = fix GPS, `L` = fix LBS (cellulaire), suivi de cellules LAC/CID                     |
| `utc_time`        | `064947`              | `hhmmss` UTC (sert à calculer le fuseau par delta avec `local_date`)                     |
| `valid`           | `A`                   | `A` = GPS valide, `V` = invalide                                                         |
| `lat_ddmm.mmmm`   | `1935.70640`          | **format NMEA** : 19° + 35.70640/60 = 19.595107°                                         |
| hémisphère lat    | `N`                   | `N` ou `S`                                                                               |
| `lon_dddmm.mmmm`  | `09859.94436`         | **format NMEA** : 098° + 59.94436/60 = 98.999073°                                        |
| hémisphère lon    | `W`                   | `E` ou `W`                                                                               |
| `speed`           | `0.025`               | **en nœuds** — à convertir : `km/h = knots × 1.852`                                      |
| `course`          | (optionnel)           | cap en degrés 0–360                                                                      |
| `altitude`        | (optionnel)           | mètres                                                                                   |
| `ignition`        | `0` / `1`             | état ACC (mode `protocol 18` uniquement)                                                 |
| `door`            | `0` / `1`             | capteur porte (mode `protocol 18`)                                                       |
| `fuel1`, `fuel2`  | `XX.XX%`              | niveau carburant AD1/AD2 (mode `protocol 18`)                                            |
| `temperature`     | `±NN`                 | capteur 1-Wire si branché                                                                |

**⚠️ Pièges à connaître :**

- Le champ `speed` est en **nœuds**, pas en km/h. Conversion obligatoire.
- Les coordonnées sont en **format NMEA `ddmm.mmmm`**, pas en décimal. La formule est `degrés = int(val/100) + (val mod 100) / 60`, avec inversion de signe pour S/W.
- Le `local_date` peut utiliser `yymmdd` **ou** `yy/mm/dd ` (avec slashes et espace) selon le firmware. Le décodeur Traccar gère les deux via `.number("(dd)/?(dd)/?(dd) ?")`.
- Le `utc_time` peut être absent (chaîne vide) sur certains firmwares — Tracky doit alors considérer que `local_date` est déjà en UTC, ou calculer le fuseau depuis la config.
- Certains firmwares ajoutent un trailing `,;` ou `;` simple — le parser doit tolérer les deux.

### 3.4 Trame de position alternative (firmware plus récent)

Certains GPS403D envoient un format différent, terminé par `*` au lieu de `;` :

```
imei:<IMEI>,<something>,<event>,<sensorId>,<sensorVoltage>,<hhmmss>,<ddmmyy>,<rssi>,<gps_status>,<lat_decimal>,<lon_decimal>,<speed_kph>,<course>,<altitude>,<hdop>,<satellites>,<ignition>,<charge>,<error>*
```

Différences clés avec §3.3 :

- Coordonnées en **décimal** (pas en NMEA)
- Vitesse en **km/h** (pas en nœuds)
- Date en `ddmmyy` (pas `yymmdd`)
- Champs supplémentaires : RSSI, HDOP, nombre de satellites, état charge batterie
- Terminateur `*`

Le parser Tracky doit détecter le terminateur pour choisir la branche. Exemple de logique (inspirée du décodeur Traccar) :

```ts
if (frame.endsWith('*')) {
  return decodeAlternative(frame);
} else if (frame.substring(21, 24).includes('OBD')) {
  return decodeObd(frame);
} else if (frame.startsWith('vr', 21)) {
  return decodePhoto(frame);
} else {
  return decodeRegular(frame);
}
```

### 3.5 Trame OBD (si module OBD-II branché)

```
imei:<IMEI>,OBD,<yymmdd><hhmmss>,<odometer>,<instant_fuel>,<avg_fuel>,<engine_hours>,<speed_kph>,<engine_load%>,<coolant_temp>,<throttle%>,<rpm>,<battery>,<dtc_codes>;
```

Non applicable au GPS403D standard (pas d'OBD-II), sauf si un adaptateur est ajouté. À ignorer dans un premier temps pour Tracky.

### 3.6 Alarmes (valeurs du champ `alarm`)

Liste exhaustive issue du décodeur Traccar `Gps103ProtocolDecoder.decodeAlarm()` :

| Valeur brute         | Signification                       | Action Tracky                                                  |
| -------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `tracker`            | position normale (pas d'alarme)     | RAS                                                            |
| `help me`            | SOS — bouton pressé 3 s             | **Acquitter** avec `**,imei:<IMEI>,E;` + notifier manager      |
| `low battery`        | batterie de secours < ~3.6 V        | Notifier + log                                                 |
| `stockade`           | sortie de geofence                  | Notifier                                                       |
| `move`               | mouvement détecté en mode parking   | Notifier                                                       |
| `speed`              | dépassement de vitesse              | Notifier                                                       |
| `door alarm`         | porte ouverte en mode armé          | Notifier                                                       |
| `ac alarm`           | alimentation principale coupée      | Notifier urgence (tentative de vol du boîtier)                 |
| `accident alarm`     | choc détecté (accéléromètre)        | Notifier urgence                                               |
| `sensor alarm`       | capteur de vibration déclenché      | Notifier                                                       |
| `bonnet alarm`       | capot ouvert                        | Notifier                                                       |
| `footbrake alarm`    | pédale de frein pressée en mode armé| Notifier                                                       |
| `brake` / `brake alarm` | freinage brusque détecté         | Telemetry coach conduite                                        |
| `accelerate`         | accélération brusque détectée       | Telemetry coach conduite                                        |
| `sharp turn`         | virage brusque détecté              | Telemetry coach conduite                                        |
| `collision`          | collision détectée (accéléromètre)  | Notifier urgence (distinct de `accident alarm`)                |
| `acc on`             | contact mis                         | Mettre à jour l'état ignition dans la DB                       |
| `acc off`            | contact coupé                       | Mettre à jour l'état ignition                                  |
| `T:<valeur>`         | relevé de température (ex. `T:23.5`)| Stocker comme telemetry                                        |
| `oil <valeur>`       | niveau de carburant                 | Stocker comme telemetry                                        |
| `DTC`                | code défaut OBD                     | Stocker comme telemetry                                        |
| `rfid`               | badge RFID lu                       | Le champ RFID contient l'ID du badge                           |

### 3.7 Trame photo (optionnel)

Si une caméra est branchée, le boîtier peut envoyer des paquets `vr<N>` contenant du JPEG en hexadécimal fragmenté. Non applicable au GPS403D standard. Ignorer côté Tracky pour la V1.

---

## 4. Commandes descendantes (serveur → boîtier)

### 4.1 Format générique

```
**,imei:<IMEI>,<code>[,<params>];
```

- Préfixe obligatoire : `**,`
- Toujours terminé par `;`
- Pas de `\r\n` nécessaire (mais toléré)
- Envoi sur la **socket existante** du boîtier (jamais d'ouverture de nouvelle connexion)

### 4.2 Table des commandes (source de vérité : `Gps103ProtocolEncoder.java` de Traccar)

**Important** : le firmware Coban accepte **à la fois** les codes à 3 chiffres (version documentée "in" du manuel constructeur) **et** les codes mono-lettre (version "out"). **Traccar implémente uniquement la version mono-lettre** — c'est la référence à suivre pour Tracky, parce qu'elle a 10 ans de production éprouvée derrière elle.

**Formule de correspondance lettre ↔ code numérique** (utile comme modèle mental mais pas universelle) :

```
code_numerique = 100 + index_lettre_base_0
A=100, B=101, C=102, D=103, E=104, F=105, G=106, H=107,
I=108, J=109, K=110, L=111, M=112, N=113, ...
```

La formule tient pour la majorité des commandes listées dans les manuels, mais il y a des **exceptions** : par exemple `REQUEST_PHOTO` = `160` ne suit pas la formule. Tracky doit donc traiter les codes comme une **table de correspondance**, pas comme un calcul.

#### 4.2.1 Commandes implémentées par Traccar (haute confiance)

Extraction directe du fichier `Gps103ProtocolEncoder.java` :

| Fonction Tracky                 | Type Traccar             | Payload émis                          | Paramètres                                    | Confiance   |
| ------------------------------- | ------------------------ | ------------------------------------- | --------------------------------------------- | ----------- |
| **Couper moteur**               | `TYPE_ENGINE_STOP`       | `**,imei:<IMEI>,J`                    | —                                             | ✅ Traccar |
| **Restaurer moteur**            | `TYPE_ENGINE_RESUME`     | `**,imei:<IMEI>,K`                    | —                                             | ✅ Traccar |
| **Armer (alarme)**              | `TYPE_ALARM_ARM`         | `**,imei:<IMEI>,L`                    | —                                             | ✅ Traccar |
| **Désarmer (alarme)**           | `TYPE_ALARM_DISARM`      | `**,imei:<IMEI>,M`                    | —                                             | ✅ Traccar |
| **Demander position unique**    | `TYPE_POSITION_SINGLE`   | `**,imei:<IMEI>,B`                    | —                                             | ✅ Traccar |
| **Tracking périodique**         | `TYPE_POSITION_PERIODIC` | `**,imei:<IMEI>,C,<XX><s\|m\|h>`      | `frequencySeconds` → formaté par `formatValue`| ✅ Traccar |
| **Stop tracking périodique**    | `TYPE_POSITION_STOP`     | `**,imei:<IMEI>,D`                    | —                                             | ✅ Traccar |
| **Demande photo**               | `TYPE_REQUEST_PHOTO`     | `**,imei:<IMEI>,160`                  | —                                             | ✅ Traccar |
| **Commande brute (custom)**     | `TYPE_CUSTOM`            | `**,imei:<IMEI>,<payload>`            | `payload` libre                               | ✅ Traccar |

**⚠️ Particularités importantes héritées de Traccar :**

1. **Pas de `;` terminal.** Traccar émet les commandes **sans** le `;` de fin, c'est-à-dire `**,imei:XXX,J` et non `**,imei:XXX,J;`. Le firmware Coban accepte les deux formats en production. Pour Tracky, on **ajoute le `;` quand même** par alignement avec les manuels constructeur et pour la cohérence avec le mode `CUSTOM` (où les payloads multi-champs comme geofence contiennent déjà des `;` intermédiaires). C'est harmless.

2. **Pas de `\r\n` non plus.** Traccar n'ajoute aucun retour chariot. Une commande = une écriture raw de la string sur la socket, le firmware parse au fil de l'eau.

3. **Format de la fréquence pour `TYPE_POSITION_PERIODIC`.** Traccar convertit un nombre de secondes en chaîne `XXs` / `XXm` / `XXh` via cette logique (extrait de `Gps103ProtocolEncoder.formatValue`) :

   ```java
   if (frequency / 60 / 60 > 0) return String.format("%02dh", frequency / 60 / 60);
   else if (frequency / 60 > 0)  return String.format("%02dm", frequency / 60);
   else                          return String.format("%02ds", frequency);
   ```

   Soit : 30 s → `"30s"`, 120 s → `"02m"`, 3600 s → `"01h"`. **Attention** : la conversion écrase les restes (90 s → `"01m"`, pas `"01m30s"`). Tracky doit imiter ce comportement pour rester prévisible.

#### 4.2.2 Commandes non implémentées par Traccar (à envoyer via `CUSTOM`)

Ces commandes sont documentées par les manuels Coban / Flespi / forums mais **ne sont pas dans l'encoder Traccar**. Elles doivent être envoyées comme payload brut via `TYPE_CUSTOM` :

| Fonction                    | Payload à envoyer (custom)                             | Confiance    | Source                          |
| --------------------------- | ------------------------------------------------------ | ------------ | ------------------------------- |
| Annuler SOS / mute alarmes  | `**,imei:<IMEI>,E;`                                    | ✅ Traccar (hardcodé dans le decoder pour ACK SOS) | `Gps103ProtocolDecoder:L174` |
| Tracking par distance       | `**,imei:<IMEI>,F,<XXXX>m;`                            | ⚠️ Manuel    | GPS103-A/B manual               |
| Alarme movement             | `**,imei:<IMEI>,G;`                                    | ⚠️ Manuel    | GPS103-A/B manual               |
| Alarme overspeed            | `**,imei:<IMEI>,H,<NNN>;`                              | ⚠️ Manuel    | GPS103-A/B manual               |
| Geofence rectangle          | `**,imei:<IMEI>,114,<lat1>,<lon1>;<lat2>,<lon2>;`      | ⚠️ Flespi    | Flespi protocol docs            |
| Changer serveur IP          | `**,imei:<IMEI>,122,<IP>,<PORT>;`                      | ⚠️ Forum     | Forum Traccar "COBAN 303G"      |

**Légende de la confiance :**
- ✅ **Traccar** : implémenté dans le code source Traccar, éprouvé en production depuis plusieurs années
- ⚠️ **Manuel** : documenté par le manuel constructeur, probablement fonctionnel mais non testé dans Traccar
- ⚠️ **Flespi** : documenté par Flespi (plateforme commerciale qui parse le Coban), fiable mais second-hand
- ⚠️ **Forum** : mentionné par des intégrateurs, à valider avec une capture réelle avant prod

**Règle Tracky pour la V1** : n'exposer dans l'UI que les commandes ✅ Traccar. Les autres restent derrière un flag `custom_commands_enabled` réservé aux admins le temps de les valider une par une avec des captures Wireshark.

### 4.3 Points de friction documentés

Issus des forums Traccar et tests d'intégrateurs :

1. **Variante `in` vs `out` du firmware.** Certains GPS103/403 ne répondent qu'aux codes numériques (`119`), d'autres qu'aux codes lettres (`J`). Pour basculer un boîtier de `in` → `out`, il faut d'abord envoyer un SMS : `protocol123456 18 out`. **Tracky doit documenter cette étape dans la procédure de provisionnement.**
2. **Pas d'ACK applicatif explicite pour la plupart des commandes.** Le boîtier exécute silencieusement. La seule confirmation est **l'état remonté dans la trame de position suivante** (`ignition` pour engine stop/resume, etc.). Il faut donc une **boucle de polling applicatif** : "commande envoyée → attente max X secondes → vérif de l'état dans la prochaine position → marquer la commande comme `delivered` ou `failed`".
3. **Gard-fou matériel sur la coupure moteur.** Le firmware Coban refuse d'exécuter `J` / `119` si la vitesse du véhicule au moment de la commande dépasse un certain seuil (documenté comme ~20 km/h par le fabricant, réponse du support Coban : *"when you use the commands to stop engine, this action could not be finished as soon as you send out SMS, but when the speed of car is less than certain speed, and the engine will be cut, because it will be dangerous to stop car suddenly"*). **Tracky doit doublonner cette vérification côté serveur** — voir §7.

### 4.4 Exemple de session commande complète

```
[serveur reçoit position]
< imei:864035050002451,tracker,240109143022,,F,133022,A,4852.12345,N,00221.98765,E,0.000,;

[manager clique "Couper moteur" dans le dashboard Tracky]
[serveur vérifie : vitesse = 0 km/h, last_fix < 30s, ignition = 1 → OK]
> **,imei:864035050002451,J;

[serveur attend jusqu'à 60s la prochaine position]
< imei:864035050002451,tracker,240109143052,,F,133052,A,4852.12345,N,00221.98765,E,0.000,,,0,0,,,;
                                                                            ↑
                                                                    ignition = 0 → confirmé

[serveur marque command_id=42 comme delivered + notifie dashboard]
```

---

## 5. Commandes SMS (référence complète)

Toutes les commandes SMS sont envoyées au numéro de la SIM du boîtier. Le mot de passe par défaut est `123456`. **Il doit être changé à la mise en service.** Pour les commandes qui prennent des paramètres, `space` = appui sur la touche espace du clavier.

### 5.1 Initialisation et authentification

| Action                           | Commande SMS                                        | Réponse                             |
| -------------------------------- | --------------------------------------------------- | ----------------------------------- |
| Reset usine                      | `begin123456`                                       | `begin ok`                          |
| Changer mot de passe             | `password123456 <nouveau>`                          | `password OK`                       |
| Autoriser un numéro (master)     | `admin123456 <numero>` (format international sans `+`) | `admin OK`                          |
| Supprimer un numéro autorisé     | `noadmin123456 <numero>`                            | `noadmin OK`                        |
| Fuseau horaire                   | `time zone123456 <offset>` (ex. `time zone123456 1` pour UTC+1) | `time OK`             |
| Vérifier l'IMEI                  | `imei123456`                                        | 15 chiffres                         |

### 5.2 Configuration GPRS (obligatoire pour Tracky)

| Action                        | Commande SMS                                        | Exemple                                              |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| APN                           | `apn123456 <nom_apn>`                               | `apn123456 orange.fr`                                |
| User/mot de passe APN (rare)  | `up123456 <user> <password>`                        | `up123456 orange orange`                             |
| Serveur Tracky (IP + port)    | `adminip123456 <ip> <port>`                         | `adminip123456 51.83.12.34 5001`                     |
| Basculer en mode GPRS         | `gprs123456` (TCP) / `gprs123456,1,1` (UDP)         | —                                                    |
| Basculer en mode SMS          | `sms123456`                                         | —                                                    |
| Activer le "protocol 18"      | `protocol123456 18`                                 | Active ACC, porte, carburant dans les trames        |
| Basculer mode commande `out`  | `protocol123456 18 out`                             | Active les commandes mono-lettre (J/K/L/M)          |

### 5.3 Reporting de position

| Action                        | Commande SMS                                        | Notes                                                |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Position ponctuelle           | (appel de voix depuis numéro autorisé)              | Le boîtier répond par SMS lat/lon                    |
| Tracking auto N fois          | `fix030s005n123456`                                 | 30 s × 5 = 5 positions à 30 s d'intervalle           |
| Tracking continu              | `fix030s***n123456`                                 | Toutes les 30 s, indéfiniment (**intervalle mini : 20 s**) |
| Arrêt du tracking             | `nofix123456`                                       | —                                                    |
| Position en adresse textuelle | `address123456`                                     | Nécessite APN configuré                              |

### 5.4 Alarmes

| Action                        | Commande SMS                                        | Activation                                           |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Overspeed                     | `speed123456 080`                                   | Alarme à 80 km/h                                     |
| Annuler overspeed             | `nospeed123456`                                     | —                                                    |
| Movement (anti-remorquage)    | `move123456`                                        | Alarme si déplacement > 200 m après 3-10 min d'immobilité |
| Annuler movement              | `nomove123456`                                      | —                                                    |
| Geofence rectangle            | `stockade123456 <lat1>,<lon1>;<lat2>,<lon2>`        | Coin haut-gauche ; coin bas-droit                    |
| Annuler geofence              | `nostockade123456`                                  | —                                                    |
| Armer l'alarme                | `arm123456`                                         | Ne marche que si ACC OFF                             |
| Désarmer                      | `disarm123456`                                      | —                                                    |
| Mode silencieux               | `silent123456`                                      | Alarmes envoyées en SMS sans sirène                  |
| Quitter silencieux            | `loud123456`                                        | —                                                    |

### 5.5 Coupure moteur (SMS)

| Action                        | Commande SMS                                        | Réponse                                              |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Couper moteur                 | `stop123456`                                        | `Stop engine Succeed`                                |
| Remettre moteur               | `resume123456`                                      | `Resume engine Succeed`                              |

**Note critique :** ces commandes SMS subissent le **même gard-fou 20 km/h** que les commandes TCP. Le boîtier met la commande en attente et l'exécute dès que la vitesse redescend.

### 5.6 Diagnostic

| Action                        | Commande SMS                                        | Réponse                                              |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| État complet du véhicule      | `check123456`                                       | Power / Battery / GPS / ACC / Door / GSM signal      |
| Reset GSM + GPS               | `reset123456`                                       | `reset ok`                                           |

### 5.7 Séquence complète de mise en service (copier-coller pour installateur)

```
1. begin123456
2. password123456 <nouveau_mdp>
3. time zone<nouveau_mdp> 1
4. apn<nouveau_mdp> <apn_opérateur>
5. up<nouveau_mdp> <user_apn> <pass_apn>        ← si nécessaire, sinon ignorer
6. adminip<nouveau_mdp> <ip_tracky> 5001
7. fix030s***n<nouveau_mdp>
8. gprs<nouveau_mdp>
9. protocol<nouveau_mdp> 18
10. protocol<nouveau_mdp> 18 out
11. check<nouveau_mdp>                          ← doit répondre avec tous les états OK
```

---

## 6. Mapping format → types TypeScript

Pour référence dans l'implémentation NestJS de Tracky.

```ts
// packages/shared/src/protocol/coban.types.ts

export type CobanFrameType =
  | 'login'
  | 'heartbeat'
  | 'position'
  | 'alarm'
  | 'obd'
  | 'photo'
  | 'unknown';

export interface CobanLoginFrame {
  type: 'login';
  imei: string;
}

export interface CobanHeartbeatFrame {
  type: 'heartbeat';
  imei: string;
}

export interface CobanPositionFrame {
  type: 'position';
  imei: string;
  alarm: CobanAlarmType;
  deviceTime: Date;          // reconstitué depuis local_date + utc_time
  valid: boolean;             // 'A' → true, 'V' → false
  latitude: number;           // décimal, converti depuis NMEA
  longitude: number;          // décimal
  speedKph: number;           // converti depuis nœuds (speed × 1.852)
  course?: number;
  altitude?: number;
  ignition?: boolean;
  door?: boolean;
  fuel1?: number;
  fuel2?: number;
  temperature?: number;
  rfid?: string;
  raw: string;                // toujours conserver la trame brute pour debug
}

export type CobanAlarmType =
  | 'none'                    // 'tracker'
  | 'sos'                     // 'help me'
  | 'low_battery'
  | 'geofence'                // 'stockade'
  | 'movement'                // 'move'
  | 'overspeed'               // 'speed'
  | 'door'                    // 'door alarm'
  | 'power_cut'               // 'ac alarm'
  | 'accident'                // 'accident alarm'
  | 'collision'               // 'collision' (distinct de accident)
  | 'vibration'               // 'sensor alarm'
  | 'bonnet'                  // 'bonnet alarm'
  | 'foot_brake'              // 'footbrake alarm'
  | 'harsh_braking'           // 'brake' / 'brake alarm'
  | 'harsh_acceleration'      // 'accelerate'
  | 'harsh_turn'              // 'sharp turn'
  | 'acc_on'
  | 'acc_off'
  | 'temperature'             // 'T:<val>'
  | 'fuel'                    // 'oil <val>'
  | 'rfid'
  | 'dtc'
  | 'unknown';

export type CobanCommand =
  // ✅ Supportées par Traccar (haute confiance)
  | { type: 'engine_stop' }                               // → J
  | { type: 'engine_resume' }                             // → K
  | { type: 'alarm_arm' }                                 // → L
  | { type: 'alarm_disarm' }                              // → M
  | { type: 'position_single' }                           // → B
  | { type: 'position_periodic'; frequencySeconds: number } // → C,XXs|XXm|XXh
  | { type: 'position_stop' }                             // → D
  | { type: 'request_photo' }                             // → 160
  // ⚠️ Hardcodées ailleurs mais envoyables via custom
  | { type: 'sos_ack' }                                   // → E (envoyé auto par le decoder sur 'help me')
  // 🚧 Non supportées par Traccar, à envoyer via custom après validation
  | { type: 'custom'; raw: string };

/**
 * Formate une fréquence en secondes en chaîne compatible Coban.
 * Reproduit exactement `Gps103ProtocolEncoder.formatValue` de Traccar.
 *
 * @example
 * formatFrequency(30)   // "30s"
 * formatFrequency(120)  // "02m"
 * formatFrequency(3600) // "01h"
 * formatFrequency(90)   // "01m"  ⚠️ écrase le reste, comme Traccar
 */
export function formatFrequency(seconds: number): string {
  if (Math.floor(seconds / 3600) > 0) {
    return String(Math.floor(seconds / 3600)).padStart(2, '0') + 'h';
  }
  if (Math.floor(seconds / 60) > 0) {
    return String(Math.floor(seconds / 60)).padStart(2, '0') + 'm';
  }
  return String(seconds).padStart(2, '0') + 's';
}
```

### 6.1 Conversion coordonnées NMEA → décimal

```ts
// packages/shared/src/protocol/coban.parser.ts

export function nmeaToDecimal(value: string, hemisphere: 'N' | 'S' | 'E' | 'W'): number {
  // value ex: "1935.70640" → 19° 35.70640' → 19.595107
  const numeric = parseFloat(value);
  const degrees = Math.floor(numeric / 100);
  const minutes = numeric - degrees * 100;
  let decimal = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') decimal = -decimal;
  return decimal;
}

export function knotsToKph(knots: number): number {
  return knots * 1.852;
}
```

---

## 7. ⚠️ Règles de sécurité Tracky (coupure moteur)

### 7.1 Contexte

Le hardware Coban **a déjà un gard-fou interne** qui met la coupure moteur en attente tant que la vitesse dépasse un seuil (documenté comme ~20 km/h). **Ce n'est pas suffisant** : le firmware est une boîte noire, sa version peut varier, et une coupure moteur à 30 km/h sur l'autoroute peut tuer un conducteur.

Vizyo Tracky **doit ajouter une couche de vérification applicative côté serveur**, qui est :

1. Documentée (cette section)
2. Testable (contrats Jest)
3. Auditée (chaque refus et chaque exécution sont loggés en base avec contexte complet)

### 7.2 Contrat de la fonction `canCutEngine()`

```ts
// apps/api/src/modules/commands/engine-cut.guard.ts

interface EngineCutContext {
  vehicleId: string;
  lastPosition: {
    timestamp: Date;
    speedKph: number;
    ignition: boolean;
    valid: boolean;           // fix GPS valide (A/V du protocole)
  } | null;
  requestedBy: {
    userId: string;
    role: 'admin' | 'fleet_manager';
  };
  now: Date;
}

export interface EngineCutDecision {
  allowed: boolean;
  reason?:
    | 'no_position'
    | 'stale_position'         // dernière position > 60s
    | 'invalid_fix'            // GPS pas valide
    | 'speed_too_high'         // > 20 km/h (marge sous le seuil hardware)
    | 'ignition_off'           // déjà coupé
    | 'insufficient_role';
  context: EngineCutContext;
}

export function canCutEngine(ctx: EngineCutContext): EngineCutDecision {
  const MAX_SPEED_KPH = 20;
  const MAX_POSITION_AGE_MS = 60_000;

  if (ctx.requestedBy.role !== 'admin' && ctx.requestedBy.role !== 'fleet_manager') {
    return { allowed: false, reason: 'insufficient_role', context: ctx };
  }
  if (!ctx.lastPosition) {
    return { allowed: false, reason: 'no_position', context: ctx };
  }
  if (!ctx.lastPosition.valid) {
    return { allowed: false, reason: 'invalid_fix', context: ctx };
  }
  const ageMs = ctx.now.getTime() - ctx.lastPosition.timestamp.getTime();
  if (ageMs > MAX_POSITION_AGE_MS) {
    return { allowed: false, reason: 'stale_position', context: ctx };
  }
  if (ctx.lastPosition.speedKph > MAX_SPEED_KPH) {
    return { allowed: false, reason: 'speed_too_high', context: ctx };
  }
  if (!ctx.lastPosition.ignition) {
    return { allowed: false, reason: 'ignition_off', context: ctx };
  }
  return { allowed: true, context: ctx };
}
```

### 7.3 Règles complémentaires

- **Audit log obligatoire** : chaque `EngineCutDecision` (allowed ou non) est persistée dans `audit_log` avec `userId`, `vehicleId`, `decision`, `context`, `timestamp`. Jamais de delete sur cette table.
- **Double confirmation UI** : côté Angular, deux clics séparés espacés d'un modal de confirmation explicite *"Je confirme vouloir immobiliser le véhicule IMMATRICULATION. Le conducteur sera impacté."*
- **Coupure programmée** : la fonctionnalité "planifier une coupure dans 10 minutes" doit re-exécuter `canCutEngine()` au moment T+10min avec les données fraîches — pas au moment de la programmation.
- **Restore** : la commande `engine_resume` n'a **aucune vérification de sécurité** (c'est toujours sûr de redémarrer un véhicule). Seule la coupure est gardée.
- **Fallback si timeout** : si la commande est envoyée mais qu'aucune trame confirmant `ignition=0` n'arrive dans les 120 s, la commande est marquée `timeout` et le manager est notifié. Ne pas re-tenter automatiquement.

### 7.4 Limites connues à documenter aux clients

- Tracky **ne peut pas couper un moteur si le véhicule n'est pas en zone de couverture GPRS** (tunnel, sous-sol). La commande sera mise en queue côté serveur mais ne partira que quand le boîtier se reconnectera.
- Si le conducteur **débranche physiquement** le boîtier, Tracky reçoit une alarme `ac alarm` (power cut) mais ne peut évidemment plus agir. Le boîtier continue sur sa batterie de secours ~2 h puis s'éteint.
- **Le gard-fou 20 km/h est contourné si la dernière position remonte à > 60 s** (c'est pour ça qu'on refuse dans ce cas). Un véhicule qui roulait à 90 km/h il y a 45 s et qui s'arrête juste ne sera pas détecté comme "rapide" → on joue la sécurité, on refuse.

---

## 8. Implémentation côté serveur Tracky

### 8.1 Architecture cible

```
┌──────────────────────────────────────────────────────────┐
│                   apps/api (NestJS)                      │
│                                                          │
│  ┌────────────────┐      ┌─────────────────────────┐     │
│  │ CobanTcpServer │──────│ CobanSessionRegistry    │     │
│  │ (port 5001)    │      │ Map<IMEI, Socket>       │     │
│  └────────┬───────┘      └──────────┬──────────────┘     │
│           │                         │                    │
│           ▼                         ▼                    │
│  ┌────────────────┐      ┌─────────────────────────┐     │
│  │ CobanDecoder   │      │ CobanEncoder            │     │
│  │ (parser)       │      │ (builder de commandes)  │     │
│  └────────┬───────┘      └──────────┬──────────────┘     │
│           │                         ▲                    │
│           ▼                         │                    │
│  ┌────────────────┐      ┌──────────┴──────────────┐     │
│  │ PositionService│      │ CommandService          │     │
│  │ (persist+WS)   │      │ (guard + queue + audit) │     │
│  └────────┬───────┘      └──────────┬──────────────┘     │
│           │                         │                    │
│           ▼                         ▼                    │
│  ┌─────────────────────────────────────────────────┐     │
│  │      PostgreSQL + PostGIS  (via Prisma 7)       │     │
│  └─────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
           ▲                                  ▲
           │ positions/alerts                 │ commands REST
           │ (Socket.IO)                      │ (HTTP)
           ▼                                  │
┌──────────────────────────────────────────────┴───────────┐
│                     apps/web (Angular)                   │
└──────────────────────────────────────────────────────────┘
```

### 8.2 Modules NestJS concernés

- `CobanTcpModule` — serveur TCP brut (`net.createServer`), lifecycle géré par Nest (`OnModuleInit` / `OnModuleDestroy`)
- `CobanSessionModule` — registry global des sockets actives, `Map<imei, { socket, lastSeen, lastPosition }>`
- `CobanProtocolModule` — decoder + encoder purs (pas d'I/O), 100 % testables
- `PositionsModule` — persistance Prisma + broadcast Socket.IO
- `CommandsModule` — guard `canCutEngine`, queue BullMQ pour commandes différées, polling de confirmation
- `AuditModule` — append-only log, pas de delete

### 8.3 Structure du serveur TCP

```ts
// apps/api/src/modules/coban-tcp/coban-tcp.server.ts

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createServer, Server, Socket } from 'net';
import { CobanSessionRegistry } from '../coban-session/coban-session.registry';
import { CobanProtocolService } from '../coban-protocol/coban-protocol.service';
import { PositionsService } from '../positions/positions.service';

@Injectable()
export class CobanTcpServer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CobanTcpServer.name);
  private server: Server;
  private readonly port = Number(process.env.COBAN_TCP_PORT ?? 5001);

  constructor(
    private readonly sessions: CobanSessionRegistry,
    private readonly protocol: CobanProtocolService,
    private readonly positions: PositionsService,
  ) {}

  onModuleInit(): void {
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.listen(this.port, () => {
      this.logger.log(`Coban TCP server listening on :${this.port}`);
    });
  }

  onModuleDestroy(): void {
    this.server?.close();
  }

  private handleConnection(socket: Socket): void {
    let buffer = '';
    let imei: string | null = null;
    socket.setKeepAlive(true, 30_000);

    socket.on('data', (chunk) => {
      buffer += chunk.toString('ascii');
      let idx: number;
      while ((idx = buffer.search(/[;\r\n]/)) !== -1) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!raw) continue;

        const frame = this.protocol.decode(raw);
        this.logger.debug(`← ${raw}`);

        switch (frame.type) {
          case 'login':
            imei = frame.imei;
            this.sessions.attach(imei, socket);
            socket.write('LOAD');
            break;
          case 'heartbeat':
            if (frame.imei === imei) this.sessions.touch(imei);
            socket.write('ON');
            break;
          case 'position':
            if (imei) this.positions.handle(imei, frame).catch((e) =>
              this.logger.error('position handling failed', e));
            if (frame.alarm === 'sos') {
              socket.write(`**,imei:${imei},E;`);
            }
            break;
          default:
            this.logger.warn(`unhandled frame type ${frame.type}: ${raw}`);
        }
      }
    });

    socket.on('close', () => {
      if (imei) this.sessions.detach(imei);
    });
    socket.on('error', (err) => {
      this.logger.error(`socket error for ${imei ?? 'unknown'}`, err);
    });
  }
}
```

### 8.4 Envoi d'une commande

```ts
// apps/api/src/modules/commands/commands.service.ts

async sendEngineStop(vehicleId: string, userId: string): Promise<CommandResult> {
  const vehicle = await this.prisma.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    include: { lastPosition: true, user: true },
  });

  const decision = canCutEngine({
    vehicleId,
    lastPosition: vehicle.lastPosition,
    requestedBy: { userId, role: /* ... */ },
    now: new Date(),
  });

  // audit TOUJOURS, même si refusé
  await this.audit.log({
    action: 'engine_stop_requested',
    userId,
    vehicleId,
    decision,
  });

  if (!decision.allowed) {
    throw new ForbiddenException(`Engine cut refused: ${decision.reason}`);
  }

  const socket = this.sessions.get(vehicle.imei);
  if (!socket) {
    throw new ServiceUnavailableException('Vehicle offline');
  }

  const command = `**,imei:${vehicle.imei},J;`;
  socket.write(command);

  // enregistrement + attente de confirmation via prochaine position
  const commandRecord = await this.prisma.command.create({
    data: {
      vehicleId,
      userId,
      type: 'engine_stop',
      rawPayload: command,
      status: 'sent',
      sentAt: new Date(),
    },
  });

  // Poll de confirmation dans un worker BullMQ avec timeout 120s
  await this.commandQueue.add('await-confirmation', {
    commandId: commandRecord.id,
    expectedIgnition: false,
    timeoutMs: 120_000,
  });

  return { commandId: commandRecord.id, status: 'sent' };
}
```

---

## 9. Exemples de trames réelles (à compléter)

### 9.1 Sources vérifiées

Toutes les trames ci-dessous sont issues de **logs publics de vrais boîtiers** (forums Traccar / OpenGTS).

**Login + heartbeat (forum Coban 306A) :**

```
← 23 23 2c 69 6d 65 69 3a 38 36 35 33 32 38 30 32 31 30 35 36 33 35 32 2c 41 3b
  "##,imei:865328021056352,A;"
→ 4c 4f 41 44
  "LOAD"

← 38 36 35 33 32 38 30 32 31 30 35 36 33 35 32 3b
  "865328021056352;"
→ 4f 4e
  "ON"
```

**Position valide (forum Traccar "Protocol Identification") :**

```
← imei:864035050002451,tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;
```

Parsé :

- IMEI : `864035050002451`
- alarm : `tracker` (pas d'alarme)
- date locale : 2020-12-23 06:49:47
- UTC : 06:49:47 (donc fuseau = 0, boîtier pas configuré)
- validité : `A` (GPS valide)
- latitude : 19.595107° N
- longitude : -98.999073° (W = négatif)
- vitesse : 0.025 nœuds = 0.046 km/h (immobile)

**Tentative de login depuis un Arduino custom (forum Traccar) :**

```
→ ##,imei:866771024070798,A;
← LOAD
→ 866771024070798;
← ON
→ **,imei:866771024070798,B
→ imei:866771024070798,tracker,1312170400,,F,230030.000,A,2455.3288,N,06705.8537,E,0.00,0,,0,0,0.00%,,;
← ON
```

### 9.2 À capturer dans le parc Tracky (TODO Wireshark)

Cases à remplir dans cette section dès que les captures sont disponibles :

- [ ] Login packet d'un GPS403D en production réelle
- [ ] Suite de 5 trames de position pendant déplacement autoroute
- [ ] Heartbeat nu capturé entre deux positions
- [ ] Alarme `help me` (SOS) suivie de l'ACK serveur `E;`
- [ ] Commande `J` (engine stop) envoyée + position suivante confirmant `ignition=0`
- [ ] Commande `K` (engine resume) + position suivante confirmant `ignition=1`
- [ ] Tentative de coupure moteur à > 20 km/h → observer ce que fait réellement le boîtier (exécute quand même ? attend ? ignore silencieusement ?)
- [ ] Alarme `low battery` + contenu exact du champ
- [ ] Alarme `ac alarm` (power cut) simulée en débranchant l'alimentation principale
- [ ] Trame avec `protocol 18` activé, pour voir tous les champs ignition/door/fuel
- [ ] Réponse du boîtier aux commandes numériques (`119`) vs mono-lettre (`J`) — identifier le firmware du parc

**Procédure Wireshark recommandée** (à faire depuis le serveur Tracky de test) :

```bash
# Capturer tout ce qui entre/sort sur le port 5001
sudo tcpdump -i any -w coban_capture.pcap 'port 5001'

# Puis ouvrir dans Wireshark avec :
# - Follow TCP Stream sur chaque session
# - Filtre : tcp.port == 5001 && ip.src == <IP_boitier>
# - Décodage : "Decode As... → Data (text)"
```

---

## 10. Checklist de validation avant passage en production

Cette checklist doit être verte **pour chaque nouveau modèle de boîtier** (GPS403D mais aussi variantes futures).

### 10.1 Tests fonctionnels

- [ ] Boîtier se connecte au serveur Tracky en < 30 s après démarrage
- [ ] Login packet reçu et parsé, `LOAD` envoyé
- [ ] Position reçue dans les 60 s suivant le login
- [ ] Coordonnées cohérentes avec la position réelle (vérifier sur Google Maps à ±10 m)
- [ ] Vitesse affichée correcte après conversion nœuds → km/h
- [ ] Heartbeat reçu toutes les ~60 s, `ON` envoyé
- [ ] Reconnexion automatique après coupure réseau simulée (avion mode 30 s puis retour)
- [ ] Alarme SOS (appui 3 s bouton) → alarme reçue + ACK `E;` envoyé + plus d'alarme répétée après ACK
- [ ] Mode `protocol 18` activé → champs `ignition`, `door`, carburant présents dans les trames
- [ ] Commande `engine_stop` à vitesse 0 km/h → coupure effective, confirmée par `ignition=0` dans position suivante
- [ ] Commande `engine_stop` à vitesse > 20 km/h → **refusée par le guard Tracky** (le hardware ne doit jamais être sollicité dans ce cas)
- [ ] Commande `engine_resume` → moteur redémarre, `ignition=1` confirmé
- [ ] Audit log rempli pour chaque commande (allowed ET refused)
- [ ] Double confirmation UI en place dans Angular avant envoi

### 10.2 Tests non-fonctionnels

- [ ] Serveur Tracky tient 500 boîtiers connectés simultanément en heartbeat
- [ ] Latence commande → exécution < 5 s (P95)
- [ ] Pas de fuite mémoire sur 24 h de run continu (`Map` de sessions propre)
- [ ] Logs structurés (Pino) contiennent IMEI + trame brute pour tout le trafic
- [ ] Déconnexions détectées et `sessions.detach()` appelé

### 10.3 Tests de sécurité

- [ ] Un user non-manager ne peut pas appeler `engine_stop` (403)
- [ ] Un manager ne peut pas couper un véhicule d'une autre flotte (multi-tenancy)
- [ ] Les trames malformées ne crashent pas le serveur (fuzz-test du parser)
- [ ] Les IMEI inconnus sont rejetés (pas d'auto-registration)
- [ ] Le password des SMS boîtier est chiffré en base (pas en clair)

---

## 11. Références

### 11.1 Code source étudié

- **Traccar `Gps103ProtocolDecoder.java`** — version master au 2026-04, 408 lignes. Contient les trois `PatternBuilder` (position standard, OBD, alternatif) et la table `decodeAlarm()`. Source principale pour comprendre le format.
  https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/protocol/Gps103ProtocolDecoder.java
- **Traccar `Gps103ProtocolEncoder.java`** — 71 lignes, licence Apache 2.0. Implémente 9 types de commandes via un pattern `StringProtocolEncoder` (`TYPE_CUSTOM`, `TYPE_POSITION_STOP`, `TYPE_POSITION_SINGLE`, `TYPE_POSITION_PERIODIC`, `TYPE_ENGINE_STOP`, `TYPE_ENGINE_RESUME`, `TYPE_ALARM_ARM`, `TYPE_ALARM_DISARM`, `TYPE_REQUEST_PHOTO`). Les codes sont mono-lettres `B`/`C`/`D`/`J`/`K`/`L`/`M` sauf `REQUEST_PHOTO` qui utilise `160`. **Source de vérité pour §4.2.1.**
  https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/protocol/Gps103ProtocolEncoder.java
- **Traccar `Command.java`** — liste canonique des types de commandes que Tracky peut répliquer.
  https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/model/Command.java

### 11.2 Documentation fabricant

- **Manuel GPS103-A/B** (PDF Technolysis, le plus complet trouvé) : liste exhaustive des commandes SMS, procédure d'initialisation, diagrammes de câblage, tableau des alarmes.
  https://www.technolysis-hts.gr/wp-content/uploads/2015/10/GPS103-B-manual.pdf
- **Manuel GPS403 (Coban Net Domain Technologies)** : procédure de mise en service spécifique au GPS403 (l'IMEI forme le mot de passe initial, pas `123456`).
  https://plataformagps.ndtgps.com/Devices/Trackers/Coban/GPS403?lang=es
- **Protocoles Traccar (index)** : catalogue des `.doc` et `.xls` constructeurs sous licence propriétaire mais téléchargeables — notamment `GPRS data protocol.xls` pour gps103 et `PROTOCOL123456 out.doc` (version "out" des commandes, à parser pour enrichir la liste §4.2).
  https://www.traccar.org/protocols/

### 11.3 Threads forums qui ont éclairé des zones d'ombre

- **Flespi — Coban protocol** : plateforme commerciale de télématique qui parse le Coban en production. Source la plus fiable pour les **mots-clés d'alarme complets** (including `accelerate`, `brake`, `sharp turn`, `collision` absents du décodeur Traccar) et la **confirmation des codes numériques** (`109` = engine stop, `114` = geofence, `122` = change server IP). A permis de corriger plusieurs erreurs de la V1.
  https://flespi.com/protocols/coban
- **"Gps103 command" (2 pages)** — confirmation que les commandes se réinjectent sur la **même socket** que celle du boîtier, et que les codes numériques (`111`, `112`, `119`) et mono-lettres (`L`, `M`, `J`) coexistent selon firmware.
  https://www.traccar.org/forums/topic/gps103-command/
- **"gps103 commands issue"** — confirmation que Traccar utilise exclusivement les mono-lettres, et explication du SMS `protocol123456 18 out` pour basculer le firmware.
  https://www.traccar.org/forums/topic/gps103-commands-issue/
- **"Stopped engine in TK103"** — réponse du support Coban confirmant le **gard-fou matériel de vitesse** avant coupure moteur (clé pour §7).
  https://www.traccar.org/forums/topic/stopped-engine-in-tk103/
- **"Coban 306A"** — trames hexadécimales brutes du handshake `LOAD` / `ON` reproduites en §2.1 et §9.1.
  https://www.traccar.org/forums/topic/coban-306a/
- **"Protocol Identification"** — exemple canonique d'une trame de position gps103 valide reproduite en §9.1.
  https://www.traccar.org/identify-protocol/

### 11.4 Documents à récupérer pour compléter la doc

- [ ] Manuel constructeur **GPS403D spécifique** (pas GPS103-A/B) — contacter le fournisseur chinois ou Baanool directement
- [ ] **Captures Wireshark** du parc Tracky (cf. §9.2)
- [ ] Fichier **`GPRS data protocol.xls`** de Traccar téléchargé et parsé pour enrichir §4.2
- [ ] Fichier **`PROTOCOL123456 out.doc`** de Traccar pour confirmation exhaustive des codes

---

## 12. Journal des modifications

| Version | Date       | Auteur   | Notes                                                                          |
| ------- | ---------- | -------- | ------------------------------------------------------------------------------ |
| V1      | 2026-04-09 | Youness  | Première rédaction complète depuis reverse Traccar + forums + manuels          |
| V2      | 2026-04-09 | Youness  | Correction critique de §4.2 : `engineStop=109` (pas `119`), `engineResume=110`. Ajout de la formule `code = 100 + (index lettre)`. Ajout des alarmes `accelerate`, `brake`, `sharp turn`, `collision` depuis Flespi. Nouvelle commande geofence (`N` / `114`). Source Flespi ajoutée aux références. |
| V3      | 2026-04-09 | Youness  | **Source de vérité confirmée** : `Gps103ProtocolEncoder.java` récupéré et intégré. §4.2 entièrement refondue en deux sous-sections : 4.2.1 (commandes éprouvées par Traccar, 9 types) et 4.2.2 (commandes à envoyer via `CUSTOM`, à valider). Ajout de `TYPE_REQUEST_PHOTO = 160` (exception à la formule lettre→numérique). Documentation du format de fréquence `formatValue` (30s/02m/01h). Correction importante : Traccar **n'envoie pas** le `;` terminal — on le garde dans Tracky par cohérence mais c'est optionnel. Ajout de la fonction utilitaire `formatFrequency()` dans les types TS. Type `CobanCommand` aligné sur Traccar. |

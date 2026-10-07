# Infrastructure de test Teltonika, et diagnostic à distance par SMS

> **Pour qui :** reprendre le test FMC130 sans être devant le véhicule.
> **Date :** 2026-09-27 · **Boîtier :** FMC130, IMEI `860848082352569` (nom Bluetooth
> `FMC130_2352569`).

---

## 1. Les identifiants du montage

| Quoi | Valeur |
|---|---|
| **Boîtier** | Teltonika FMC130, IMEI `860848082352569` |
| **Nom Bluetooth** | `FMC130_2352569` · code PIN par défaut Teltonika : `5555` |
| **SIM (ICCID)** | `8934••••••••••••256` |
| **SIM (numéro)** | **`+3459••••••••759`** ← c'est à ce numéro qu'on envoie les SMS |
| **SIM (état)** | Activée · **471 Ko** consommés ce mois, **aucun plafond** enregistré |
| **APN** | `iotde.telefonica.com` — **sans login ni mot de passe** |
| **Serveur de test** | `72.62.26.240` port **`5027`** — TCP |
| **Serveur Coban (prod)** | `72.62.26.240` port **`5023`** — à ne pas confondre, à ne jamais toucher |
| **Codec attendu** | 8 Extended (`0x8E`) |

> 🔒 **Numéro de la SIM et ICCID masqués dans le dépôt (07/10/2026).** Un numéro de SIM, avec un
> accès SMS laissé à sa valeur d'usine, suffit à commander le boîtier, donc le véhicule. C'est la
> leçon du 24/09 avec le mot de passe Coban (« diffusé par courriel »). Le dépôt est lu par
> plusieurs sessions et agents : ces numéros n'y ont pas leur place. Les valeurs complètes sont
> dans le portail de l'opérateur de la SIM, et dans la copie de travail d'origine de ce document
> (worktree `wt-teltonika`, fichier non suivi, conservé tant qu'elles ne sont pas rangées ailleurs).

⚠️ **`wsim` n'est pas l'APN de ce parc.** C'est une valeur de test présente dans le code
(`tracker-provisioning.service.ts` et ses fixtures). L'APN réel est
`iotde.telefonica.com` — mesuré sur 29 SIM activées en production.

---

## 2. Le chemin complet, et ce que je peux voir à chaque étape

```
  ┌──────────────┐
  │   FMC130     │  1. il ouvre une session data via l'APN
  │  dans le     │
  │   camion     │
  └──────┬───────┘
         │ 2. radio : Orange France (mesuré, IO 241 = 208-01)
         ▼
  ┌──────────────────────┐
  │  Réseau Telefónica   │  3. la data « sort » en Allemagne
  │  IoT (iotde…)        │     (notre IP vue : 46.114.215.195)
  └──────┬───────────────┘
         │ 4. internet
         ▼
  ┌──────────────────────┐
  │  VPS 72.62.26.240    │  5. pare-feu ufw : 5027/tcp AUTORISÉ
  │  ┌────────────────┐  │
  │  │ ufw            │  │  ◄── je vois ici les SYN REFUSÉS (/var/log/ufw.log)
  │  ├────────────────┤  │
  │  │ node, port 5027│  │  ◄── je vois ici tout ce qui ENTRE vraiment
  │  │ ecoute-        │  │      (handshake, trames AVL, IO, VIN…)
  │  │ teltonika.mjs  │  │
  │  └───────┬────────┘  │
  │          ▼           │
  │  /opt/ecoute-        │  ◄── le journal complet, tout y est
  │     teltonika.log    │
  └──────────────────────┘
```

### 🔴 Le point le plus important à comprendre

**Je ne vois RIEN au-dessus de l'étape 5.** Mon poste d'observation est le serveur.
Je peux dire avec certitude :

- ✅ « un paquet est arrivé » → je le décode entièrement
- ✅ « un paquet est arrivé mais le pare-feu l'a refusé » → ligne `[UFW BLOCK]`
- ❌ **« le boîtier n'a rien envoyé » et « le boîtier a envoyé vers ailleurs » produisent
  exactement le même silence chez moi.**

C'est toute la difficulté d'aujourd'hui : depuis 12:19, je vois du silence, et le silence
ne dit pas *pourquoi*. C'est précisément ce que le SMS résout — voir § 4.

---

## 3. Comment on teste, côté serveur

### Ce qui tourne en ce moment

| Élément | État |
|---|---|
| Écouteur | `node /opt/ecoute-teltonika.mjs --port 5027`, **pid 4030432** |
| Démarré depuis | **2 h 35** sans interruption — jamais redémarré, jamais planté |
| Session tmux | `teltonika` |
| Journal | `/opt/ecoute-teltonika.log` (12,5 Mo) |
| Pare-feu | `5027/tcp ALLOW Anywhere` (v4 et v6) |

### Les quatre commandes de contrôle

**Est-ce que l'écouteur tourne et tient le port ?**
```bash
ssh root@72.62.26.240 "ss -lntp | grep 5027"
```

**Est-ce qu'un boîtier est connecté en ce moment ?**
```bash
ssh root@72.62.26.240 "ss -tnp state established '( sport = :5027 )'"
```

**Qu'est-ce qui s'est passé en dernier ?**
```bash
ssh root@72.62.26.240 "tail -n 60 /opt/ecoute-teltonika.log"
```

**Est-ce que le boîtier frappe et se fait refuser ?** (distingue « absent » de « bloqué »)
```bash
ssh root@72.62.26.240 "grep 'DPT=5027' /var/log/ufw.log | tail -5"
```

**Pour regarder défiler en direct :**
```bash
ssh root@72.62.26.240 "tmux attach -t teltonika"
```
*(`Ctrl+B` puis `D` pour se détacher sans tuer l'écouteur.)*

---

## 4. 🔑 Vérifier la configuration à distance, par SMS

C'est **le seul canal qui ne dépend pas de la liaison data**. Si le boîtier ne parle plus
au serveur, le SMS passe quand même — c'est une porte d'entrée indépendante.

### 4.1 La syntaxe, exactement

Quand **aucun login/mot de passe SMS n'est configuré** dans le boîtier (cas par défaut),
il faut **DEUX ESPACES en tête** de chaque message :

```
  getinfo
^^
deux espaces obligatoires
```

Si un login et un mot de passe ont été posés, le format devient :
`login motdepasse commande`

> ⚠️ C'est la différence avec le GPRS, où la commande part **nue**, sans espace ni mot de
> passe. Ne pas confondre les deux grammaires.

### 4.2 Les commandes de lecture — à envoyer au `+3459••••••••759`

| Envoyer | Ce que ça répond | Pourquoi c'est utile |
|---|---|---|
| `  getinfo` | infos système, version firmware | **le boîtier est-il vivant et joignable ?** |
| `  getstatus` | état du modem GSM et de la session data | **a-t-il de la data, oui ou non ?** ← la question du jour |
| `  getgps` | position, date, satellites | le GPS fonctionne-t-il |
| `  getver` | version du code, IMEI, MAC Bluetooth | vérifier qu'on parle au bon boîtier |
| `  getparam 2001` | **l'APN** | doit rendre `iotde.telefonica.com` |
| `  getparam 2004` | **l'adresse du serveur** | doit rendre `72.62.26.240` |
| `  getparam 2005` | **le port** | doit rendre `5027` |
| `  getparam 2006` | **le protocole** | doit rendre `0` (= TCP) |

### 4.3 Les commandes de réparation

Une seule SMS suffit pour les quatre paramètres (séparés par `;`, 160 caractères max) :

```
  setparam 2001:iotde.telefonica.com;2004:72.62.26.240;2005:5027;2006:0
```

Puis redémarrer le boîtier pour qu'il reparte proprement :

```
  cpureset
```

### 4.4 Le tableau des identifiants de paramètres

| ID | Paramètre | Valeur attendue ici |
|---:|---|---|
| 2001 | APN | `iotde.telefonica.com` |
| 2002 | Utilisateur APN | *(vide)* |
| 2003 | Mot de passe APN | *(vide)* |
| 2004 | Domaine / IP du serveur | `72.62.26.240` |
| 2005 | Port | `5027` |
| 2006 | Protocole | `0` = TCP (1 = UDP) |
| 10050 | Période mini, véhicule en mouvement | défaut **300 s** — c'est la cadence qu'on a mesurée |
| 10055 | Période d'envoi | défaut 120 s |

### 4.5 Envoyer ces SMS **depuis Tracky**, sans être au camion

Tracky possède déjà une passerelle SMS (vizyo-texto) et un endpoint d'envoi libre,
réservé au SUPER_ADMIN :

```
POST /api/admin/sms/send
{ "to": "+3459••••••••759", "message": "  getstatus" }
```

⚠️ **Deux points de vigilance :**

1. **Les deux espaces de tête doivent survivre au transport.** Vérifier dans
   `/api/admin/sms/logs` que le corps envoyé les porte bien — un `trim()` quelque part
   rendrait la commande muette, et le boîtier ne répondrait simplement pas.
2. **Le relais a une allowlist.** Si le numéro n'y est pas, l'envoi est refusé en 403.
   L'ajouter d'abord : `POST /api/admin/sms/allowlist`.

**La réponse du boîtier revient dans Tracky** : le webhook SMS entrant l'enregistre, elle
est lisible dans `GET /api/admin/sms/logs`. Donc tout le diagnostic est faisable à
distance, sans retourner au véhicule.

*(Le plus simple reste d'envoyer depuis un téléphone personnel si le numéro long M2M
l'accepte — mais le chemin Tracky a l'avantage de journaliser la question ET la réponse.)*

---

## 5. Pourquoi ça marchait, et pourquoi ça ne marche plus

### La chronologie, avec les preuves

| Heure (UTC) | Fait | Preuve |
|---|---|---|
| **12:04:22 → 12:04:34** | Le boîtier **frappe déjà** le port 5027, toutes les 3 s — le pare-feu le refuse (la règle n'existe pas encore) | 10 lignes `[UFW BLOCK] DPT=5027` |
| 12:05:13 | J'ouvre le pare-feu et je démarre l'écouteur | journal de l'outil |
| **12:06:06** | **Connexion, handshake accepté** (`0x01`) | journal |
| 12:06 → 12:19 | 347 paquets, **4 825 enregistrements** du 02/09 au 27/09, **CRC bon sur tous, 0 rejet** | journal |
| 12:09:45 · 12:14:45 · 12:19:45 | 3 relevés **en direct**, à 300 s d'intervalle | journal |
| **12:19:48** | Le boîtier **ferme proprement** sa socket après l'accusé | `connexion fermée · 347 paquets · 822 s` |
| 12:19:48 → **14:39** | **Plus un seul paquet. Plus un seul SYN.** | compteur ufw figé à 10 |
| ~13:00 | Coupure/remise de l'alimentation (reboot complet) | — |
| après le reboot | **toujours zéro SYN** | compteur ufw toujours à 10 |

### Ce que ça démontre

**1. La configuration était bonne avant.** Les 10 SYN de 12:04 le prouvent : le boîtier
visait déjà la bonne IP et le bon port, avec une session data ouverte. Le pare-feu fermé
était le seul obstacle. **Rien de ce qui était réglé à ce moment-là n'était à changer.**

**2. La chaîne technique est validée.** 347 paquets sans une erreur de CRC : l'APN, le
réseau, le pare-feu, le TCP, le handshake et le Codec 8 Extended fonctionnent tous.

**3. Quelque chose a changé entre 12:19 et 13:00.** C'est la fenêtre où la configuration a
été modifiée en Bluetooth.

**4. Le reboot est l'élément décisif.** Un FMC130 qui redémarre avec une configuration
valide **retente sa connexion dans la minute** — on l'a vu faire à 12:04, toutes les 3
secondes. Après le redémarrage de 13:00 : **zéro tentative**. Ce n'est pas un boîtier qui
essaie et n'arrive pas. C'est un boîtier qui **n'essaie pas**.

### Les deux causes possibles — et pourquoi je ne peux pas trancher d'ici

| Hypothèse | Ce que je verrais | Ce que je vois |
|---|---|---|
| **A. Plus de session data** (APN changé ou invalide) | rien | rien |
| **B. Il pointe vers un autre serveur/port** | rien | rien |

**Les deux produisent le même silence.** C'est pour ça que le SMS est nécessaire : il
répond directement à la question. `  getstatus` distingue A de B en un message.

### Ce qui est **éliminé**

- ❌ **Plafond de données atteint** : la SIM a consommé **471 Ko** ce mois (les autres du
  parc sont à 19–23 Mo), et aucun plafond n'est enregistré. *Détail parlant : 4 825
  enregistrements × ~86 octets ≈ 415 Ko — le rattrapage de ce matin explique presque
  exactement cette consommation.*
- ❌ **SIM désactivée** : elle est « Activée » côté opérateur.
- ❌ **Panne d'alimentation** : les LED clignotent, le boîtier tourne.
- ❌ **Mon côté** : écouteur en vie depuis 2 h 35 sans interruption, port tenu, règle ufw
  en place, aucun refus enregistré.
- ❌ **Session Bluetooth qui suspendait la data** : elle a été déconnectée, sans effet.

### Une observation qui oriente fortement

Le Bluetooth a **cessé d'être découvrable** au même moment, et n'est réapparu qu'après le
redémarrage. Une configuration sauvegardée qui touche à la fois aux réglages GPRS **et**
au Bluetooth explique les deux symptômes d'un seul coup. C'est l'hypothèse la plus
économique.

---

## 6. Le plan pour reprendre

1. **Envoyer `  getstatus` au `+3459••••••••759`.** Réponse = on sait si le boîtier a de la
   data. C'est l'unique question bloquante.
2. **Envoyer `  getparam 2004` et `  getparam 2005`.** Réponse = on sait vers où il pointe.
3. Selon les réponses, **une seule SMS de réparation** :
   `  setparam 2001:iotde.telefonica.com;2004:72.62.26.240;2005:5027;2006:0`
   puis `  cpureset`.
4. Je vois la reconnexion arriver dans la minute, et je le dis.
5. **Alors seulement**, reprendre la question du CAN : moteur démarré + section CAN Adapter
   activée dans le Configurator, pour obtenir enfin **l'identifiant IO du VIN** — le seul
   élément qui manque encore au chantier.

> Si le boîtier ne répond à aucun SMS, c'est qu'un login/mot de passe SMS a été posé, ou
> qu'une liste de numéros autorisés a été activée dans la configuration. Dans ce cas il
> faut revenir au véhicule, en **USB** (le Configurator voit le boîtier en USB
> indépendamment du Bluetooth et de la data).

---

## 7. Rappel de sécurité

L'écouteur de test est **totalement séparé de Tracky** : port 5027, processus autonome,
aucun accès à la base. Le port **5023** et le parc Coban en production n'ont **pas été
touchés** une seule fois de la journée — vérifié à chaque étape.

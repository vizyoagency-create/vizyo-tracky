# Étape 1 — Filet de caractérisation du chemin Coban

> **Statut :** livré. **Aucun fichier existant modifié** (`git diff --stat` vide).
> **Date :** 2026-09-27 · **Branche :** `feat/teltonika-fmc130` · **Worktree :** `../wt-teltonika`
> **Base :** `origin/main` @ `bfd6b7ce`

---

## 1. Ce que ce filet protège, et pourquoi il fallait l'écrire d'abord

Le rapport d'étape 0 (§ 2.2) a établi que le point d'entrée TCP — la fonction qui porte
*tout* le trafic des boîtiers du parc — n'était presque pas testé :
`tcp-server.service.spec.ts` couvrait **uniquement** le débounce OFFLINE, et ni
`handleConnection` (bufferisation, découpage, conversion ASCII) ni `dispatchFrame` (les cinq
branches de protocole) n'avaient un seul test. Aucun test du dépôt n'ouvrait de socket TCP
réelle. Et `SocketRegistryService.send()` — par laquelle sort **déjà** chaque coupe moteur —
n'était pas testée du tout : les 5 tests du registre portent tous sur l'événement
`tracker.connected` (T42).

Autrement dit : avant ce filet, **casser le login Coban n'aurait fait rougir aucun test**.

**Ces tests décrivent le comportement ACTUEL, sans le juger.** Plusieurs verrouillent
délibérément des choix contestables (§ 4). Leur rôle n'est pas de dire ce qui *devrait* être,
mais de prouver qu'on n'a rien changé.

> ### ⚠️ Règle d'usage
> Si l'un de ces tests devient rouge pendant l'ajout du Teltonika, la bonne réaction n'est
> **pas** de l'adapter — c'est de défaire le changement qui l'a cassé. Un test de
> caractérisation dont on révise la valeur attendue ne prouve plus rien.

---

## 2. Fichiers créés — trois, tous neufs

| Fichier | Tests | Ce qu'il verrouille |
|---|---:|---|
| `apps/api/src/tracker-tcp/tcp-server.caracterisation.spec.ts` | **36** | `handleConnection` + `dispatchFrame`, en pilotant un faux socket |
| `apps/api/src/tracker-tcp/tcp-server.port-reel.spec.ts` | **9** | le **câblage** : vrai serveur sur port éphémère, vrais clients `node:net` |
| `apps/api/src/socket-registry/socket-registry.caracterisation.spec.ts` | **12** | `send()` : socket morte, demi-morte, exception, contre-pression, **Buffer intact** |
| | **57** | |

**Fichiers existants modifiés : aucun.** Aucune migration, aucun module, aucune dépendance.

### 2.1 Répartition du filet unitaire (36 cas)

| Groupe | Cas | Contenu |
|---|---:|---|
| **A** — bufferisation et découpage | 9 | keep-alive/timeout armés ; trame terminée par `;` ; **deux trames dans un seul chunk**, dans l'ordre ; trame **coupée en deux chunks** ; tampon qui survit à un octet à la fois ; **CR/LF** comme séparateurs ; segments vides ignorés ; chunk sans séparateur inerte ; **sérialisation stricte** par socket |
| **B** — login | 5 | IMEI connu (register + `LOAD` + ONLINE + `forget`) ; `LOAD` écrit **avant** la base ; IMEI inconnu (`record` + `end`, aucun `LOAD`) ; annulation du passage OFFLINE ; journal de fil |
| **C** — heartbeat | 3 | IMEI concordant → `touch` + `ON` ; non concordant → ignoré ; avant login → ignoré |
| **D** — position | 8 | ingestion des champs métier ; avant login → jetée ; IMEI non concordant → jetée ; sans alarme → **aucune lecture du tracker** ; avec alarme → snapshot **avant** ingestion (TRK-040) ; accusé SOS `**,imei:…,E;` ; `tryMatch` sur la trame brute ; alerte en échec n'interrompt rien |
| **E** — no_fix | 2 | `lastSeenAt` **et** `lastNoFixAt`, **sans** écrire de position ; avant login → ignorée |
| **F** — trame non reconnue | 3 | tentative d'ACK d'abord ; sans ACK → rien, pas d'erreur ; trame OBD sans effet |
| **G** — robustesse | 2 | une ingestion qui lève est journalisée **et la trame suivante passe quand même** ; avant login, une trame non-login n'est pas journalisée |
| **H** — frontière de protocole | 4 | le masquage ASCII ; handshake Teltonika inerte ; paquet AVL inerte ; un octet binaire valant `;` |

### 2.2 Le test à socket réelle (9 cas)

Ouvre un vrai `net.createServer` sur le **port 0** (le noyau en attribue un libre : aucun
conflit possible avec un serveur de développement, aucune valeur codée en dur), s'y connecte
avec de vrais clients, et parle le protocole sur le fil. **Seule la persistance est simulée —
aucune base requise.**

Couvre : le serveur écoute vraiment ; un boîtier reçoit `LOAD` ; son heartbeat reçoit `ON` ;
sa position est ingérée ; login + position dans **un seul envoi TCP** (coalescing réel) ;
IMEI inconnu → connexion fermée ; **deux boîtiers simultanés** servis tous les deux ;
handshake Teltonika → aucune réponse ; `onModuleDestroy` libère le port.

C'est ce test qui verra une régression de branchement quand un second écouteur sera ajouté à
côté.

---

## 3. 🔴 Découverte de l'étape 1 : un Teltonika sur le port Coban n'existe pas

Le rapport d'étape 0 annonçait que les deux protocoles étaient incompatibles. La mesure est
plus nette que prévu, et elle est désormais prouvée **sur une socket réelle** :

**Un boîtier Teltonika branché sur le port Coban est totalement inerte.** Ni `0x01`, ni
`0x00`, ni trame, ni erreur, ni entrée dans la liste admin des « boîtiers non reconnus ».
Il n'existe pas, jusqu'au timeout de socket de 300 s — puis il recommence.

La cause est mécanique : le handshake (`00 0F` + IMEI ASCII) et le paquet AVL d'exemple de la
documentation officielle **ne contiennent aucun des octets `;` (0x3B), CR (0x0D) ou LF
(0x0A)**. Les octets entrent dans le tampon et n'en sortent jamais, faute de séparateur.
Vérifié octet par octet sur les deux trames.

**Ce que ça implique :** si un Teltonika a déjà été pointé vers le port 5023, il n'en reste
aucune trace nulle part. Et le boîtier, n'ayant jamais reçu son octet d'acceptation, aura
rejoué sa session indéfiniment. Le second port devra **refuser explicitement** (`0x00`) au
lieu de se taire — c'est le risque R7 du rapport d'étape 0, désormais chiffré.

---

## 4. Pièges caractérisés — figés ici, pas corrigés

Ces comportements sont **verrouillés tels quels**. Aucun n'est corrigé dans cette étape : le
filet vient avant le travail, pas à la place.

1. 🔴 **`chunk.toString('ascii')` efface le bit de poids fort de chaque octet.** L'octet
   `0x8E` — qui est précisément l'identifiant du Codec 8 Extended — arrive comme `0x0E`.
   Sans exception, sans log. Le test l'observe sur le journal de fil, et la trace d'exécution
   le confirme : `frameRaw: '\x0E'`. C'est la raison technique pour laquelle les deux
   protocoles ne peuvent pas partager ce tampon.
2. **Le découpage des trames se fait sur `;`, CR ou LF**, soit trois octets qui apparaissent
   naturellement dans un payload binaire (une valeur CAN valant `0x3B` suffit).
3. **`LOAD` est écrit avant l'écriture en base.** Choix de latence délibéré : l'inverser
   ferait dépendre l'acceptation d'un boîtier de la disponibilité de PostgreSQL.
4. **Une position sans alarme ne lit pas le tracker.** Économie voulue : le snapshot TRK-040
   ne se paie que lorsqu'il y a une alarme à départager.
5. **`send()` ne désinscrit pas sur socket détruite**, mais **désinscrit** sur socket non
   inscriptible (« TCP à demi-mort ») et sur exception d'écriture. Trois cas, deux
   traitements différents.
6. **La contre-pression n'est pas un échec.** `write()` qui rend `false` signifie « tampon
   plein, le noyau écoulera plus tard » ; `send()` rend donc `true`. Traiter ce cas comme un
   échec renverrait la commande une seconde fois.
7. **Garantie acquise pour la suite** : un `Buffer` traverse `send()` **octet pour octet**,
   sans conversion. C'est la condition pour qu'un CRC Codec 12 survive au transport, et elle
   est désormais testée — y compris avec des octets > `0x7F`.

---

## 5. État des tests — référence « avant / après »

| Périmètre | Avant | Après | Δ |
|---|---:|---:|---:|
| `apps/api` — suite **complète** | 270 suites · 4 295 tests | **273 suites · 4 352 tests** | +3 · +57 |
| `packages/shared` | 19 suites · 423 tests | 19 suites · 423 tests | — *(non touché)* |
| **Total** | 4 718 | **4 775** | **+57** |

- ✅ `apps/api` : **273/273 suites, 4 352/4 352 tests verts** (111 s)
- ✅ `packages/shared` : **19/19 suites, 423/423 tests verts** (5,3 s)
- ✅ `tsc --noEmit` sur `apps/api` : propre
- ✅ `pnpm verif:accents` et `pnpm verif:litteraux` : rien à signaler
- ✅ **Stabilité** : `--testPathPatterns tracker-tcp` lancé **3 fois de suite** → 3 suites /
  55 tests, résultat identique. Aucune instabilité malgré les sockets réelles.

> Le chiffre « avant » de la suite API est déduit (4 352 − 57), la mesure directe portant sur
> le sous-ensemble ciblé. Ce qui est **mesuré** et suffit à la règle n° 4 : **273 suites sur
> 273 sont vertes**, dont les 270 préexistantes.

---

## 6. Ce que je n'ai délibérément pas fait

- **Aucun test ajouté** sur `positions.service`, `alerts.service`, `tracker-commands` ou
  `ack-waiter` : ils sont déjà couverts, et surtout ils seront atteints par un **adaptateur**,
  pas modifiés. Leur couverture existante fait office de filet.
- **Aucune correction** des pièges du § 4. Le filet décrit ; il ne répare pas.
- **Aucun commit.** Les trois fichiers et cette note sont en attente sur
  `feat/teltonika-fmc130` — à committer sur ta demande.

---

## 7. Suite — étape 2

Couche protocole Teltonika pure, sans I/O, dans `packages/shared/src/protocol/teltonika/` :
CRC-16/ARC, handshake, Codec 8 et 8 Extended (IO 1/2/4/8/X octets), encodage Codec 12, et la
fonction de reconnaissance de protocole. Les deux trames d'exemple officielles, déjà décodées
et dont les CRC sont recalculés (`0x4312` et `0x2994`, rapport d'étape 0 § 6), serviront de
premiers vecteurs de test.

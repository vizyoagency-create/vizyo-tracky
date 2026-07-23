# Intégration Tracky × Maestroo — Divergences de données & résolveur de conflits

> Analyse demandée le 2026-07-24 : « si un client modifie une donnée dans Tracky ou dans Maestroo,
> je veux un tableau des différences et un bouton qui synchronise dans un sens ou dans l'autre —
> comme un résolveur de conflits git, mais pour des données. Trouver la vraie solution, ET recenser
> les autres cas du même type. »
>
> Statut : **ANALYSE — rien n'est implémenté.** Les décisions D9–D15 (§7) sont à trancher d'abord.

---

## 1. Le problème, précisément

Depuis le provisionnement (doc 23 §13.5–13.6), l'identité des véhicules circule Tracky → Maestroo :
au consentement, puis toutes les 30 min. La règle actuelle est **non destructive** : on ne remplit
que les champs vides, on n'écrase jamais une valeur que le client a posée côté Maestroo.

Cette règle, correcte pour ne rien piétiner, a une conséquence inévitable : **dès qu'un humain
corrige une valeur d'un côté, les deux apps divergent pour toujours, en silence.**

Exemple concret (MH Cars, données réelles) : les 7 véhicules sont « Renault Trucks / Master ».
Si le client corrige en « Renault » dans Maestroo, Tracky dit toujours « Renault Trucks ». La sync
ne l'écrasera jamais (c'est voulu), ne le signalera jamais (c'est le trou), et dans six mois
personne ne saura quelle valeur est la bonne.

## 2. Pourquoi la sync actuelle ne PEUT PAS résoudre ça

Pour trancher un écart, il faut savoir **qui a changé quoi**. Or comparer seulement les deux valeurs
courantes ne le dit pas :

- Tracky dit « Renault Trucks », Maestroo dit « Renault ». Qui a raison ?
  - Si Tracky disait « Renault Trucks » à la dernière sync et que Maestroo a changé → c'est une
    correction du client côté Maestroo.
  - Si Maestroo disait « Renault Trucks » et que Tracky vient de changer → c'est une correction côté
    Tracky.
  - Si les deux ont changé → vrai conflit, un humain doit choisir.
- **Sans mémoire de « ce qui avait été synchronisé », ces trois situations sont indiscernables.**

C'est exactement le problème que git résout avec l'ancêtre commun : un merge à 3 voies a besoin de
`base`, `ours`, `theirs`. Notre sync n'a pas de `base`. La vraie solution commence là.

## 3. La vraie solution : merge à 3 voies avec base stockée

### 3.1 La base

Côté **Maestroo** (le consommateur, qui reçoit déjà les payloads Tracky), on stocke par véhicule un
**instantané des valeurs Tracky telles qu'appliquées à la dernière sync** — la `base`. Nouvelle
table `TrackySyncState` (organizationId + plate → snapshot Json + date) ou colonne sur le miroir.

À chaque sync (seed initial comme reseed du cron), pour chaque champ partagé :

| Tracky vs base | Maestroo vs base | Situation | Action |
|---|---|---|---|
| identique | identique | rien n'a bougé | rien |
| **différent** | identique | Tracky a changé | **fast-forward** : appliquer à Maestroo + mettre à jour la base |
| identique | **différent** | Maestroo a changé | **candidat write-back** : proposer la mise à jour de Tracky (jamais automatique — cf. 3.3) |
| différent | différent, **valeurs égales** | convergence | mettre à jour la base, rien d'autre |
| différent | différent, **valeurs ≠** | **CONFLIT** | enregistrer dans `TrackySyncConflict`, afficher dans le tableau |

Ce tableau remplace la règle actuelle « ne toucher que les champs vides » par une règle plus fine :
**on ne touche que ce dont on peut prouver que Tracky est le seul à l'avoir changé.** Le
comportement visible pour le client s'améliore (les corrections Tracky arrivent enfin), sans
jamais perdre une correction Maestroo.

### 3.2 Le tableau et la résolution (l'UI demandée)

Sur `/integrations/tracky` (Maestroo), carte **« Écarts de données »** :

> véhicule · champ · valeur Tracky · valeur Maestroo · détecté le — par ligne, deux boutons :
> **« Garder Tracky »** (écrase Maestroo + base) / **« Garder Maestroo »** (écrit vers Tracky —
> cf. 3.3). Actions groupées « tout garder Tracky / tout garder Maestroo » avec confirmation.

Chaque résolution est **CAS** (compare-and-set) : elle porte les deux valeurs vues au moment de la
détection. Si l'une a encore bougé entre-temps, la résolution est refusée et le conflit re-détecté —
comme git refuse un merge sur un arbre modifié. Sans ça, on appliquerait des valeurs périmées.

Côté **Tracky** `/integrations`, le même tableau en **lecture seule** (« ces écarts se résolvent
depuis Maestroo ») : un seul lieu de résolution évite les courses entre deux humains — ou le même
humain dans deux onglets. On pourra l'ouvrir des deux côtés plus tard si le besoin est réel.

### 3.3 Le write-back Maestroo → Tracky : le vrai sujet de sécurité

« Garder Maestroo » écrit dans la base de **Tracky**, qui pilote des opérations réelles (coupures
moteur, plannings, rapports). C'est la première écriture entrante depuis le partenaire, et elle doit
être bornée par construction :

1. **Nouveau scope consenti** `VEHICLE_WRITEBACK` (OFF par défaut), allumé par le fleet-admin sur
   l'écran Intégrations de Tracky — le consentement de partage n'emporte PAS le droit de modifier.
   Tracky garde l'interrupteur, cohérent avec tout le reste.
2. **Allowlist de champs** : `brand`, `model`, `year`, `energy`, `seats`. **JAMAIS** la plaque (clé
   de jointure + opérationnelle : SMS, rapports), **jamais** le kilométrage (fait mesuré),
   **jamais** rien d'opérationnel (tracker, planning, coupure).
3. **Canal signé existant** : `POST /partner/v1/…` avec `@PartnerOp('partner.conflict.resolve')`
   distinct, idempotent par identifiant de conflit.
4. **Audit des deux côtés** : `PartnerLinkEvent` + `SystemActivityLog` côté Tracky (« champ X du
   véhicule Y modifié par le partenaire, résolu par l'utilisateur Maestroo Z »), la table de
   conflits côté Maestroo (qui a cliqué, quand, quelle valeur).
5. **Révocation** : scope éteint ⇒ les résolutions « Garder Maestroo » deviennent impossibles
   (bouton grisé avec la raison), l'historique reste.

### 3.4 Le piège des traductions non-bijectives

`type` et `energy` ne se comparent PAS naïvement : Tracky `CAR` → Maestroo `VAN`, mais Maestroo
`VAN` peut venir de `CAR`, `VAN`… Comparer « CAR ≠ VAN » fabriquerait des conflits fantômes sur
chaque véhicule.

Règles :
- la détection compare **la traduction de la valeur Tracky** à la valeur Maestroo (espace
  canonique = vocabulaire Maestroo) ;
- le write-back d'un champ traduit n'est permis que si la **réversion est univoque**
  (`TRUCK_MEDIUM` → `TRUCK` : oui ; `OTHER` → ? : non ⇒ bouton « Garder Maestroo » désactivé pour ce
  champ, avec l'explication).

## 4. Les AUTRES cas du même type (recensement demandé)

Classés par **classe de champ**, parce que c'est la classe qui dicte la stratégie — pas le champ.

### C1 — Identité déclarative des véhicules (le cas discuté)
`brand`, `model`, `year`, `energy`, `seats`. → **Résolveur §3.** C'est le pilote de tout le reste.

### C2 — ⚠️ La plaque, éditable des deux côtés — BUG LATENT DÈS AUJOURD'HUI
La plaque est la **clé de jointure** de la sync, et elle est modifiable dans Tracky
(`UpdateVehicleDto.plate`) comme dans Maestroo (`registration`). Si le client corrige une faute de
frappe dans Tracky (`EP-047-TY` → `EP-047-TV`), le prochain reseed **ne trouve plus** l'ancien
véhicule côté Maestroo et en **crée un doublon** — l'ancien reste avec ses coûts, le nouveau naît
vide. Aucun résolveur ne rattrape ça proprement après coup.
**Solution** : joindre sur un **identifiant stable** — le `Vehicle.id` Tracky, stocké côté Maestroo
(`trackyVehicleId`) au seed. La plaque redevient une donnée comme une autre (et un renommage devient
un simple fast-forward). Migration douce : joindre par id si présent, sinon par plaque puis adopter
l'id. **À faire AVANT le résolveur** — c'est sa fondation.

### C3 — Suppressions et archivages asymétriques
- Véhicule **supprimé dans Tracky** : il sort simplement du seed. Côté Maestroo il reste, figé, sans
  aucun signal — le client calcule des PRK sur un véhicule qui n'existe plus.
  **Solution** : le reseed envoie la liste complète ; ce qui a disparu est marqué « retiré de
  Tracky » et remonte dans le tableau d'écarts avec une action « Archiver ici aussi ? ». Jamais de
  suppression automatique (classe C : adopté, dé-enrichi seulement à la révocation).
- Véhicule **archivé dans Maestroo** : aujourd'hui le seed le met à jour sans le désarchiver — bon
  comportement, à VERROUILLER par un test (un futur `status: 'ACTIVE'` ajouté au seed « pour
  simplifier » le ressusciterait).
- Maestroo n'a pas de hard delete aujourd'hui. Si un jour il en a un : **tombstone** obligatoire,
  sinon le cron ressuscite le supprimé toutes les 30 min.

### C4 — Le kilométrage : mesuré vs corrigé
Aujourd'hui Tracky écrase toujours (fait mesuré par le boîtier — justifié). Cas limite : boîtier HS
un mois, le client corrige à la main dans Maestroo, le boîtier revient avec un compteur en retard et
écrase la correction. **Solution** : Tracky reste autoritaire, mais un écart > seuil (~15 %) entre
la valeur mesurée et une valeur corrigée à la main passe par le tableau d'écarts au lieu d'écraser
en silence. Pas de write-back du compteur, jamais.

### C5 — La consommation : calibrée vs déclarative
Tracky a une consommation **calibrée** (méthode du plein — quasi mesurée) ; Maestroo une
`avgConsumption` déclarative qui alimente le PRK. Aujourd'hui envoyée seulement à la création.
**Solution** : la calibrée, quand elle existe, prime la déclarative (fast-forward avec info dans le
journal) ; la non-calibrée ne pousse qu'à la création, comme aujourd'hui.

### C6 — Le profil utilisateur en TROIS exemplaires
`firstName`/`lastName` existent dans Vizyo Auth (displayName), Tracky ET Maestroo. L'activation les
redemande même au client (MH Cars : « Administrateur / Anouar » côté Tracky…). Trois copies, zéro
sync. **Solution** : ce n'est PAS un cas pour le résolveur — c'est un cas « source unique » :
**Vizyo Auth est l'autorité du profil**, les deux apps devraient lire/synchroniser depuis `/me` au
login (Maestroo le fait déjà partiellement). Chantier Vizyo Auth, séparé, à ne pas mélanger.

### C7 — L'identité société
Nom copié au provisionnement (`fleetName` → `Organization.name`), puis divergence libre ; SIRET,
adresse, e-mail de contact pareil. Basse fréquence, même classe que C1. **Solution** : intégrable au
résolveur plus tard (mêmes mécanique et table), pas dans le premier lot.

### C8 — Les conducteurs (phase à venir)
Le scope `DRIVER_IDENTITY` existe déjà ; le jour où on synchronise les conducteurs, on a exactement
C1 + C2 (quelle clé de jointure ? un conducteur n'a pas de plaque) + l'affectation
conducteur↔véhicule qui existe des deux côtés. **Solution** : ne PAS commencer les conducteurs avant
que le résolveur véhicules soit éprouvé ; réutiliser la même table de conflits (elle doit être
générique : `entityKind` + `entityKey` + `field`).

## 5. Le traçage d'activité (« voir si un utilisateur est connecté sur Maestroo »)

D'abord, une clarification importante sur le mot de passe : **Maestroo n'adopte pas le mot de passe
de Tracky — c'est mieux que ça.** Les deux apps s'authentifient contre le MÊME compte Vizyo Auth :
il n'existe qu'UN mot de passe, pas deux copies. Le changer n'importe où le change partout, et
aucune des deux apps ne le stocke. (C'est précisément pourquoi l'activation exige le mot de passe
Tracky : même compte.)

Pour la visibilité, tout existe déjà côté Maestroo (`AuthAuditLog` avec `LOGIN_SUCCESS`,
`User.lastLoginAt`). Il manque le **pont** vers votre espace Tracky :

1. **« Compte activé »** : à l'activation de l'espace, Maestroo notifie Tracky (webhook signé
   existant, nouveau type `space.activated`) → nouvelle colonne dans `/admin/consent` : sollicité →
   ouvert → autorisé → **activé**. Le funnel commercial complet.
2. **« Dernière connexion Maestroo »** : endpoint signé côté Maestroo (`partner.activity.summary`,
   lecture seule : lastLoginAt + nombre de connexions 30 j par membre de l'org liée), affiché dans
   `/admin/partner-links`. **Pull à l'affichage**, pas de flux : pas de données de connexion
   stockées en double, et une panne du partenaire n'affiche « inconnu » au lieu de mentir.
3. RGPD : ce sont des données de connexion d'un service opéré par Vizyo, montrées au super-admin
   Vizyo — légitime, mais à mentionner dans la politique de confidentialité Maestroo.

## 6. Ordre de construction proposé

1. ✅ **C2 d'abord** (id stable `trackyVehicleId`) — fondation, corrige un bug latent — *fait le
   2026-07-24*.
2. ✅ **La base + la matrice** (§3.1) avec conflits DÉTECTÉS et JOURNALISÉS mais fast-forward seul
   actif — on observe ce que ça détecte en réel sur MH Cars avant d'ouvrir les vannes — *fait le
   2026-07-24 : `TrackySyncState`/`TrackySyncConflict` + `sync-matrix.ts` (fonctions pures) côté
   Maestroo ; écarts remontés dans `SystemActivityLog` côté Tracky ; purgés à la révocation et à
   l'extinction de `VEHICLE_IDENTITY`.*
3. **Le tableau + « Garder Tracky »** (résolution côté Maestroo uniquement, aucun write-back).
4. **Le write-back** (« Garder Maestroo ») derrière le scope `VEHICLE_WRITEBACK` + allowlist.
5. **C3/C4/C5** dans le tableau (retraits, kilométrage à seuil, consommation calibrée).
6. Traçage d'activité (§5) — indépendant, peut se faire en parallèle de 2–3.

## 7. Décisions à trancher (D9–D15)

- **D9 — Périmètre du write-back v1** : brand/model/year/energy/seats uniquement (proposé), ou plus ?
- **D10 — Où se résout un conflit** : Maestroo seulement (proposé), ou les deux côtés ?
- **D11 — Le write-back exige-t-il un scope consenti côté Tracky** (`VEHICLE_WRITEBACK`, OFF par
  défaut — proposé), ou est-il implicite dès que le lien est actif ?
- **D12 — Fast-forward automatique** des changements Tracky (proposé : oui, c'est la source
  télématique), ou tout passe par le tableau ?
- **D13 — Un véhicule retiré de Tracky** : proposition « marqué + action manuelle d'archivage »,
  jamais de suppression auto. Confirmer.
- **D14 — Notification** : les conflits en attente déclenchent-ils un e-mail/badge, ou seulement le
  tableau ? (proposé : badge dans les deux apps, e-mail hebdo si > 0 non résolu.)
- **D15 — Rétention** de l'historique des résolutions : illimitée (proposé — c'est de l'audit) ?

# Suivi de la revue Agenda — ce qui a été fait, et ce que la recette a trouvé en plus

**Date :** 2026-09-24 · **Échéance :** mise en service chez cdef31 le **lundi 2026-09-28**
**Point de départ :** [`AUDIT-CRITIQUE-AGENDA-2026-09-22.md`](./AUDIT-CRITIQUE-AGENDA-2026-09-22.md)
(audit daté — il reste le compte rendu de ce qui était vrai le 22/09 ; ce document-ci dit ce qui a
changé depuis).
**Version visuelle**, tenue à jour du même contenu :
<https://claude.ai/artifact/3pEq4crDmu3G1SrQ5eihuM> (tableau de bord — les trois gestes y sont
cochés, les sept défauts de recette détaillés).

---

## Verdict au 24/09

**Les trois bloquants sont levés. Le module est en production et éprouvé à l'écran.**

Mais la leçon du 22/09 se répète, en plus fort : **quatre défauts supplémentaires sont sortis en se
SERVANT de l'écran, aucun en le lisant.** Deux campagnes d'audit statique sur ce module ne les
avaient pas vus — dont le plus dangereux de toute la revue (voir R-4).

| Mesure (prod) | 22/09 | 24/09 | **27/09** |
|---|---|---|---|
| Comptes cdef31 qui ne verront rien dans l'agenda | **5 sur 6** | **0** | **0** |
| Travaux d'agent local bloqués | **7** | **0** (file vide) | **0** (file vide) |
| Réservations **fermes** à venir posées par la machine | **119** | **0** | **0** — 3 nuits de plus |
| Courriels d'exploitation (14 j) | **81** | **0 depuis la coupure** | **0** |
| Destinataires de l'avis « demande à valider » chez cdef31 | *tous les valideurs* | `standard@` seul | **`standard@` + `j.hendriks@`** |
| Objets de recette laissés en production | — | **12** | **0** |
| Lignes `CRITICAL` ouvertes nées de ce chantier | — | **8** | **0** |

> 🗓️ **Ce document a été relu en production le 27/09, la veille de la mise en service.** Deux de ses
> affirmations étaient devenues fausses et sont barrées ci-dessous. Le détail — dont un courriel de
> recette parti chez le vrai client, et l'inventaire complet des envois — est dans la section
> [2026-09-27](#2026-09-27--la-veille-de-la-mise-en-service).

---

## Les trois P0 — levés

### P0-1 — Les comptes ouvraient un agenda vide ✅

Les 4 comptes `FLEET_MANAGER` ont reçu `agenda_view`, `agenda_manage`, `reservations_view`,
`reservations_request`, `reservations_manage` et `ai_optimize`. `emu@` (veilleur) est resté fermé,
conformément à D5. L'état d'avant est conservé en base (`_sauvegarde_perms_cdef31_20260923`).

🔑 **Aucune reconnexion n'est nécessaire** : le front rappelle `/api/users/me` au montage du shell
**et au retour de focus de l'onglet** (`refreshMe`). Le prochain chargement de page suffit.

⚠️ **Le piège de lecture, qui a failli nous tromper deux fois.** Lire `users.permissions` seul fait
disparaître le fleet-admin, dont le JSON est souvent VIDE : une clé absente ne vaut pas `false`,
elle vaut le **défaut du rôle**. `j.hendriks@` ressort « agenda : non » sur une requête naïve alors
qu'il a tout par héritage.

### P0-2 — Les agents locaux étaient à l'arrêt ✅

Cause exacte, écrite en base : une pause posée le **17/09 à 08:50**, motif
*« session Claude Code non authentifiée : 401 OAuth access token has expired »*, `jusqua` vide,
jamais levée — **5 j 23 h**. Levée le 23/09, puis rattrapage lancé à la main :
**11 travaux livrés, 0 reposé, 0 en échec**, coût équivalent API ~1,67 $ **absorbé par
l'abonnement du poste** (donc 0 €, conforme à la politique « récurrent = local »).

La sentinelle qui surveille désormais **la file elle-même** (et plus seulement les passages
manqués) a crié pendant l'opération : `agents-locaux CRITICAL` à 09:50, « File des agents du poste
bouchée : 8 travaux en attente ». Elle fonctionne.

### P0-3 — L'agenda était rempli à 99 % par la machine ✅

**L'agent ne réserve plus fermement**, quel que soit le réglage `autonomy` en base
(`AUTONOMIE_FERME_AUTORISEE = false`, un seul endroit à rebrancher si la calibration s'améliore).

Les **116 réservations fermes à venir** ont été reprises depuis la feuille « Réorganiser »
(simulation d'abord — son compte était identique à une sauvegarde SQL faite séparément, deux
sources concordantes), puis l'agent a été relancé : **107 propositions, 0 réservation ferme**.
Filet conservé : `_sauvegarde_resa_auto_cdef31_20260923`.

🔴 **La mesure qui a renversé la décision, et qu'il faut connaître : `confidence` est sur 0→1
quand `confidenceThreshold` est sur 0→100.** Les propositions `pending` sont donc celles que
l'agent a jugées **PAS assez sûres** (0,40–0,70), pas une réserve de bonnes prévisions
(`auto_applied` : 0,80–1,00). J'allais conclure « annuler les fermes, les fantômes prendront le
relais » : c'était faux, ça aurait retiré les meilleures pour ne garder que les plus faibles.
La bonne manœuvre était **annuler PUIS relancer l'agent** — il ne peut pas poser de proposition
sur un créneau occupé (`isVehicleFree`).

---

## Les décisions tranchées

| | Décision | Résultat |
|---|---|---|
| **D1** | L'agent garde-t-il le droit de réserver seul ? | **Non** — suggestions seules, pour tout le monde |
| **D2** | Que fait-on des réservations automatiques ? | **Reprises** (116) puis rendues en propositions |
| **D3** | Qui voit quoi chez cdef31 ? | Les 4 managers en complet ; veilleur inchangé |
| **D5** | Le veilleur voit-il l'agenda ? | **Non**, inchangé |
| **D6** | Le lien public reste-t-il actif ? | **Oui** — éprouvé de bout en bout |
| **D7** | Seuil d'alerte sur la file ? | 12 h (avertissement) / 36 h (critique), exercé |

---

## R — ce que la recette a trouvé, et que l'audit n'avait pas vu

> Ces quatre défauts sont sortis **en se servant de l'écran**. Aucun n'était visible en lisant le
> code. C'est la leçon centrale de cette revue.

### 🔴 R-4 — Créer un évènement proposait les véhicules de TOUS les clients

Le plus dangereux de toute la revue. Bandeau société réglé sur « Client test », la liste déroulante
du formulaire « Nouvel évènement » proposait **51 véhicules** — dont ceux du cdef31 (`HD-292-SH`,
`FV-941-LZ`, `DZ-034-CA`) et de mh cars (`EZ-259-DB`).

Poser une maintenance, **ou un incident IMMOBILISANT**, sur le véhicule d'un autre client tenait à
un choix dans une liste. Et **le serveur l'aurait accepté** : un super-admin a bien le droit sur
ces véhicules. Rien ne l'arrêtait en aval.

Le composant exposait déjà `scopedVehicles()` ; le gabarit itérait `vehicles()`. Corrigé
(`908d20a0`) : après correctif, **8 véhicules**, Client test seulement.

🔑 **Réflexe à garder : chercher `of vehicles()` dans tout gabarit qui propose une liste.**
N'affecte que les super-admins — c'est-à-dire exactement le compte depuis lequel on administre
plusieurs clients.

### 🔴 R-2 — Valider ou refuser une demande ne laissait aucune trace

Le **dépôt** d'une demande publique était journalisé (`public_booking_submitted`) ; la **décision**
ne l'était pas. C'est l'inverse de ce qu'il faut : chez un client dont le standard valide les
demandes des conducteurs, c'est la décision qui engage.

Découvert parce que deux demandes de « Client test » étaient passées à `CONFIRMED` et que **rien ne
permettait de dire qui les avait validées**.

Trois actions distinctes depuis — `reservation_validee`, `reservation_refusee`,
`reservation_annulee`. Refuser une demande en attente et annuler une réservation déjà ferme passent
par le même appel : c'est le statut d'AVANT qui les sépare, et les confondre raconterait une
histoire fausse.

### 🔴 R-3 — Le glisser-déposer était inerte au doigt

Sous **640 px**, la grille masque les pilules texte au profit de pastilles de couleur (décision
d'espace : une cellule de 44 px ne tient pas trois libellés). Or le geste était attaché aux
**pilules**. Sur un téléphone, il n'y avait littéralement **rien à saisir**.

⚠️ **La fonction avait été livrée la veille sous le titre « au doigt comme à la souris ».** Elle ne
marchait pas sur l'appareil qu'elle visait en premier — le standard traverse son dépôt avec un
téléphone, c'était l'argument même de son existence.

🔑 **Un test qui n'a pas pu tourner n'est pas un test réussi.** La fenêtre Chrome maximisée refuse
`resize_window` (viewport bloqué à 1920 px) : le tactile n'avait été vérifié que sur la page
publique, qui n'a pas ce seuil. Le défaut ne s'est vu qu'en **lisant les règles CSS**.

### R-1 — Le motif saisi n'apparaissait nulle part

On tape « Ramassage scolaire secteur nord » — le formulaire le propose lui-même en exemple — et le
calendrier affiche « Réservation ». Le texte était enregistré dans `metadata.reason`, mais toutes
les surfaces lisent `title`. Corrigé **à la source** (`title ← reason` quand aucun titre explicite),
plutôt qu'à l'affichage : patcher chaque endroit aurait garanti d'en oublier un.

### R-5 — Les annulations à venir encombraient l'agenda

Défaut **créé par la reprise en masse elle-même** : les 116 annulations se sont affichées **barrées**
sur les deux semaines suivantes. L'outil censé désencombrer l'agenda le rendait moins lisible
qu'avant de s'en servir.

Une annulation dont le créneau n'a pas encore commencé n'aura pas lieu : on ne l'affiche plus. Le
**passé** garde sa trace barrée — là, l'annulation explique un trou dans l'activité.

### R-6 — La carte QR imprimait un domaine qui n'existe pas

Le pied affichait `tracky.vizyoagency.com` (défaut hérité de la carte de déverrouillage) alors que
l'application est servie sur **`app-tracky.vizyoagency.com`**. Le QR encodait la bonne URL — le scan
marchait —, mais cette carte est faite pour être **imprimée et affichée au dépôt** : un conducteur
qui ne peut pas scanner retape ce qu'il lit, et tombait sur un 404.

### R-7 — « À venir & en retard » dépendait du mois affiché

Les trois compteurs viennent de `/agenda/summary` (en retard + 30 jours) ; la liste juste en dessous
se servait dans les événements du **mois affiché**. D'où « 1 À VENIR (30J) » au-dessus d'une liste
vide, et une liste qui changeait de sens en feuilletant les mois.

---

## Hors agenda — traité en chemin

### 🔴 Le compte admin du cdef31 était injoignable depuis le 27/07

`admin@cdef31.org` : **7 `FAILED` (code `suppressed`), 1 rebond dur, 1 courriel bloqué en file —
zéro remis en 8 semaines**, pendant que `mh cars` en recevait 9.

🔑 **La liste de suppression Resend était le SYMPTÔME, pas la cause.** Après l'avoir vidée, un envoi
de test a **rebondi immédiatement** : la boîte elle-même n'existait plus. Le compte a été basculé sur
`j.hendriks@cdef31.org` (Vizyo Auth **et** Tracky, `authUserId` préservé donc rôle, flotte et
permissions intacts ; `AuditLog` laissé tel quel — c'est l'historique). Mot de passe réinitialisé
par l'intéressé, 5 sessions révoquées.

⚠️ **Contrôle à faire avant toute mise en service client** :
`SELECT "toAddress", status, count(*) FROM email_logs WHERE "toAddress" ILIKE '%<domaine>%' GROUP BY 1,2`.
Chez cdef31 : `standard@` **DELIVERED**, `admin@` injoignable, et les **3 autres managers n'ont
jamais reçu un seul courriel** — donc joignabilité **inconnue**, ce qui n'est pas « bon ».

### Valider et être prévenu étaient le même réglage

Ouvrir la validation à quatre gestionnaires leur envoyait mécaniquement **quatre courriels par
demande**, aux boîtes du client, sans qu'aucun réglage ne puisse l'en empêcher.

Séparé : le **droit** reste `reservations_manage`, l'**avis** est `users.reservationNoticeEnabled`,
réglable depuis « Paramètres de l'agenda » sous le lien public. ⚠️ **Le serveur refuse de couper le
dernier destinataire** — une demande qui n'atteint personne resterait en plan sans que quiconque le
sache.

Chez cdef31 : **`standard@` seul est prévenu** ; les cinq autres valident sans recevoir d'avis.

### Les alertes d'exploitation passent au push

**81 courriels en 14 jours** (dont 65 « erreur critique ») partaient sans interrupteur. Les trois
émetteurs **poussent d'abord**, puis consultent le réglage — couper l'e-mail ne peut donc pas rendre
sourd. Un garde refuse de fermer les deux canaux. Résultat mesuré : **0 courriel d'exploitation**
depuis la coupure.

### Deux défauts de `deploy.sh`

1. **Il sortait en code 0 sans avoir déployé** — un appelant automatisé l'aurait cru réussi.
2. **Il détruisait sa propre source** : l'élagage des vieux repères passait AVANT la pose du
   nouveau ; quand l'image en service n'était nommée que par un de ces repères, le `docker tag`
   suivant visait un fantôme et `set -e` tuait le déploiement.

⚠️ Et un troisième, évité de justesse en corrigeant : un conteneur peut tourner sur une image
**supprimée sous lui** (`docker inspect` rend toujours un ID). Se rabattre sur `latest` dans ce cas
poserait le repère sur **l'image qu'on s'apprête à déployer** — le repli ramènerait exactement à la
version qu'on voulait quitter. Le script le dit et ne pose rien. 131 → **137 contrôles**, l'ordre
prouvé **par mutation**.

---

## Ce qui reste

| | Sujet | Pourquoi ce n'est pas bloquant |
|---|---|---|
| ✅ | ~~**Le tactile réel n'a pas pu être éprouvé**~~ | La fenêtre Chrome refuse tout redimensionnement ; c'était la seule case qu'on ne pouvait pas cocher d'ici — et le terrain où R-3 s'est produit. **Validé par le propriétaire sur un vrai téléphone le 27/09 au soir.** |
| ⚠️ | Joignabilité des 3 managers cdef31 | ~~Décision prise de ne rien leur envoyer.~~ **Tranché malgré nous le 24/09** — voir la section du 27/09 : `r.garrigue@` et `t.boulay@` sont **joignables**, `astreinte@` est une **boîte morte**. |
| 🟡 | Rattrapage des tracés | ~~9 871 restants, 364/jour, ≈ 27 jours.~~ **8 798 au 27/09, 367/jour mesurés, ≈ 24 jours.** Voir ci-dessous. |
| ✅ | ~~Compteur « EN RETARD » ≠ liste~~ | Le compteur ne comptait que les `PLANNED`, la liste incluait `OPEN`/`IN_PROGRESS`. **Corrigé le 27/09 au soir** (`e030e80c`) : une seule règle des deux côtés, `estUneEcheance`. Voir la section *27/09 au soir*. |
| ✅ | ~~P1-4, P1-5, P2-1 de l'audit du 22/09~~ — et P2-3 → P2-7 | **Corrigés le 27/09 au soir** (`7e104eef`, `b7bf1b74`, `e030e80c`), **pas déployés**. Voir la section *27/09 au soir*. |
| 🧹 | 11 objets de recette sur « Client test » | ~~Marqués `seed-agenda-2026-09-23`, à supprimer.~~ **Supprimés le 27/09**, avec un 12ᵉ resté chez cdef31. |

### Le rattrapage des tracés — pourquoi on ne l'accélère pas

**Le recalage tape `router.project-osrm.org`, le serveur de DÉMONSTRATION gratuit d'OSRM.**
L'enveloppe de 15 par passage est une limite de **courtoisie**, pas une limite technique — le
commentaire du code le dit : « sans jamais bousculer le service public d'OSRM ».

La monter à 50 (le plafond) donnerait ~8 jours au lieu de 27, mais quadruplerait la charge sur le
service de quelqu'un d'autre. ⚠️ **L'IP de ce VPS s'est déjà fait bannir d'`overpass-api.de`
exactement comme ça** — c'est pourquoi l'agent des limites de vitesse tourne depuis le poste.

Deux vraies pistes, **après lundi** :

1. **Un agent de recalage sur le poste**, sur le patron de l'agent des limites de vitesse. Le code
   note que depuis le poste « la même requête passe et **répond trois fois plus vite** ». Chantier
   balisé : outil, tâche planifiée, journal de passages. *Aucun outil de ce type n'existe encore.*
2. **Auto-héberger OSRM** (`OSRM_BASE_URL`). Lève toute limite, mais plusieurs Go de RAM sur un VPS
   2 vCPU que l'hébergeur a déjà bridé une fois. **Déconseillé.**

🔑 **Et une erreur de mesure à ne pas refaire : un compteur n'est pas un débit.** Estimer le rythme
en comparant deux comptages à 24 h d'écart **soustrait silencieusement les nouveaux arrivants** —
ça donnait « 97/jour ». Mesurer ce qui a été **traité** (`polylineMatchedAt > now() - 24h`, en
écartant les trajets recalés à leur création) donne **364/jour**. Presque quatre fois plus.

---

---

## 2026-09-27 — la veille de la mise en service

> Relecture complète de la production, trois jours après. **`origin/main` n'a pas bougé** depuis le
> 24/09 : aucun code d'agenda n'a été touché. Ce qui suit est mesuré, pas déduit — et **deux
> affirmations de ce document étaient devenues fausses**.

### 🔴 Un courriel de recette est parti chez le vrai client — et ce n'était pas le 21

L'évènement créé le **24/09 à 00:53:48** est `cdef31` / « Demande publique », métadonnée
`freeText: "J'ai besoin d'une voiture pour demain"` : **la demande de recette a été déposée par le
lien public du vrai client**, pas par celui de « Client test ». Elle a expédié
`reservation_request_pending` à **5 adresses de cdef31** — `j.hendriks@`, `r.garrigue@`,
`t.boulay@`, `standard@` remis, `astreinte@` **rebondi**. La séparation avis/droit a été déployée
**trois minutes plus tard**, à 00:56.

🔑 **La règle qui manquait, et qui manque encore dans le code : toute recette du lien public se fait
sur « Client test ».** Il n'existe **aucun garde-fou** — pas de liste blanche, pas de mode test, pas
de redirection dans `email.service.ts` : un envoi part vers la vraie boîte du vrai client, toujours.
C'est la cause racine, et elle n'est pas corrigée.

⚠️ **Effet secondaire : l'erreur a répondu à la question que ce document laissait ouverte.**
`r.garrigue@` et `t.boulay@` sont `DELIVERED`, donc **joignables**. `astreinte@cdef31.org` a
**rebondi dur** : c'est une **boîte morte**, comme `admin@` l'était. Il faut la vraie adresse auprès
du client — sans elle, ce compte ne peut recevoir ni avis ni réinitialisation de mot de passe.

### Les destinataires de l'avis : `standard@` **et** `j.hendriks@`

Décision du propriétaire le 27/09, qui remplace le « `standard@` seul » du 24/09.

| Compte | Rôle | Peut valider | Reçoit l'avis |
|---|---|---|---|
| `standard@` | FLEET_MANAGER | ✅ | ✅ |
| `j.hendriks@` | FLEET_ADMIN | ✅ | ✅ |
| `astreinte@` · `r.garrigue@` · `t.boulay@` | FLEET_MANAGER | ✅ | ❌ |
| `emu@` | NIGHT_WATCHMAN | ❌ (explicite, D5) | ❌ |

### 🔑 L'adresse du rapport hebdomadaire n'est écrite nulle part — et la bascule l'a réparée

`fleets.weeklyReportEmail` est **vide pour toutes les sociétés** et
`fleet_report_schedules.recipients` est **`{}`** partout. `report-schedule.service.ts:308` retombe
donc sur `adminEmails()` — **les FLEET_ADMIN actifs de la société**. C'est pour cela que le rapport
partait vers `admin@cdef31.org` : c'était l'adresse du fleet-admin.

**La bascule du 23/09 a donc corrigé TRK-094 sans qu'on le sache** : le seul FLEET_ADMIN de cdef31
est désormais `j.hendriks@`, adresse prouvée `DELIVERED`. ⚠️ Le centre d'alerte prédisait encore un
rebond le 28/09 — **cette prédiction était périmée**, elle avait été écrite sans savoir que le
propriétaire du compte avait changé d'adresse. *Une prédiction datée doit être relue quand son
support a bougé.*

Conséquence à connaître : l'adresse restant **dérivée**, l'ajout d'un second fleet-admin chez cdef31
le mettrait **silencieusement** en destinataire du rapport. Décision du propriétaire : on laisse
dérivé, c'est le bon comportement.

### L'inventaire des envois qui peuvent atteindre un client

| Modèle | Déclencheur | Va vers | État au 27/09 |
|---|---|---|---|
| `weekly_report` | cron, **lundi 08:00 Paris** | dérivé : FLEET_ADMIN actifs | cdef31 → `j.hendriks@` · mh cars → `mhcars31@` · **Client test, A2R, Ahmed : coupés** |
| `reservation_request_pending` | demande par le lien public | `standard@` + `j.hendriks@` | ✅ |
| `reservation_requested` / `_confirmed` | dépôt / validation | le demandeur | ✅ |
| `device_verification` · `password_reset` | geste de l'utilisateur | lui-même | ✅ |
| `critical_error_alert` · `error_rate_alert` · `agents_pause` | exploitation | `contact@vizyoagency.com`, débrayable | ✅ 0 depuis la coupure |
| rappels d'entretien | cron 07:00 | fleet-admins | ✅ **inerte** : cdef31 a 0 plan |
| `alert` · `lead*` · `quote*` · `invitation` · `installation_*` | flux dédiés | — | dormants ou hors cdef31 |

### Le ménage du 27/09 — vérifié après écriture

| | Avant | Après |
|---|---|---|
| Objets de recette sur Client test | 11 | **0** |
| La demande de recette restée sur cdef31 | 1 | **0** |
| Courriels bloqués en `QUEUED` | 1 | **0** |
| `agents-locaux` CRITICAL ouvertes | 2 | **0** |
| `email-bloque` CRITICAL ouvertes | 6 | **0** |
| `autonomy` en base pour cdef31 | `auto_high_confidence` | **`suggest`** |

Deux précisions : **aucune table ne référence `vehicle_events`**, la suppression ne cascadait donc
sur rien ; et **cdef31 est la seule société à avoir une ligne `agenda_agent_settings`**, le piège du
rebranchement n'existe nulle part ailleurs. Les **77 réservations annulées** du 23/09 sont
conservées : ce n'est pas de la recette mais la trace de D2, et elles sont invisibles au calendrier
(R-5).

### 🔴 Deux défauts de plus, dans du code écrit pendant cette revue

**T83 — la sentinelle de file ne referme pas ses propres lignes.** Deux `agents-locaux` `CRITICAL`
du 23/09 11:50 étaient **encore ouvertes** au 27/09 alors que la file est vide depuis. Elle crie
quand la file se bouche et se tait quand elle se vide, sans jamais dire que c'est réglé. Closes à la
main ; le correctif reste à écrire, sinon ça reviendra à la prochaine pause.

**L'écran d'arriéré surestime le rythme — l'erreur que ce document dénonçait, recommise dedans.**
`background-tasks.service.ts` calcule `parJour` avec `polylineMatchedAt >= now() - 24h`, **sans
écarter les trajets recalés à leur création**. Mesuré sur 7 jours : **463/jour affichés contre
367/jour de vrai rattrapage** (+26 %), soit ~19 jours annoncés au lieu de **~24 jours réels**.
🔑 *Écrire la leçon ne suffit pas : il faut la relire en codant l'écran qui la mesure.*

### Ce qui reste avant demain

| | Sujet | Qui |
|---|---|---|
| ✅ | **Le tactile réel** — glisser-déposer au doigt sur un vrai téléphone | **validé par le propriétaire le 27/09 au soir**. La dernière case s'est cochée là où elle devait : sur l'appareil. |
| ⚠️ | La vraie adresse de `astreinte@cdef31.org` | à demander au client |
| ✅ | P1-4, P1-5, P2-1, P2-3 → P2-7, compteur « en retard » ≠ liste | **corrigés, testés et poussés le 27/09 au soir** (`7e104eef`, `b7bf1b74`, `e030e80c`) — voir ci-dessous. **Pas déployés** : décision du moment de mise en production laissée au propriétaire, la veille du go-live. |

### 28/09 01:00 — la preview sur la démo, avant de mettre en ligne

Décision du propriétaire : **déployer lundi vers 10 h, mais tester avant sur de vraies données.**
La démo (`demo-tracky.vizyoagency.com`) est faite pour ça : la vraie flotte pseudonymisée
(« Transports Méridien », 37 véhicules, 16 884 trajets), isolée de tout véhicule et de toute clé
SMS/push. Les images de `main` (`cd472914`) ont été construites sur le VPS **sans recréer la
production** (même image `11ad5120fb74` avant et après, vérifié), la démo seule recréée, saine en
20 s, les marqueurs du nouveau code présents dans ses deux conteneurs. Plan de recette, une case
par geste : [`RECETTE-PREVIEW-DEMO-2026-09-28.md`](./RECETTE-PREVIEW-DEMO-2026-09-28.md).

⚠️ **L'agenda de la démo part vide, par construction** : `vehicle_events`, propositions, réglages
d'agent et liens publics sont exclus de l'import (ce sont les tables qui portent noms, téléphones
et textes libres). On y crée ses objets, et on fait tourner l'agent sur les vrais trajets.

⚠️ Les six lignes d'erreur au démarrage de la démo sont **structurelles** (webhooks fermés faute de
secret, SMS en `noop`, kill-switch des coupes) — celles que son compose annonce. Rien du nouveau code.

### 27/09 au soir — les six derniers points de l'audit, corrigés

Tous mesurés avant d'être touchés ; aucune migration dans le lot ; `ng build` passé (seul lui voit
les gabarits Angular). +12 tests.

| | Ce qui était faux | Ce qui est vrai maintenant |
|---|---|---|
| **P2-1** | « Terminé » / « Supprimer » sur une MISSION depuis le panneau du jour **libérait le véhicule pendant une mission qui existait toujours** ; le serveur ne refusait que la RÉSERVATION | Refusé côté serveur avec le bon geste dans le message (« se pilote depuis l'onglet Missions »), et le panneau n'offre plus ces boutons sur une mission. Dormant chez cdef31 (0 mission), actif chez mh cars (7). |
| **compteur ≠ liste** | « En retard » ne comptait que les PLANNED ; la liste affichait aussi OPEN et IN_PROGRESS — « 1 en retard » au-dessus de trois lignes rouges | **Une seule règle**, `estUneEcheance` (`agenda.utils.ts`), appliquée des deux côtés : PLANNED, et OPEN à échéance passée. Un IN_PROGRESS n'est ni à venir ni en retard — il est en cours, et c'est « Incidents ouverts » et le panneau du jour qui le portent. Le contrat du DTO disait déjà « PLANNED/OPEN » : le contrat était juste, le code non. |
| **P2-4** | Filtrer par groupe ou véhicule ne changeait pas les compteurs | Même périmètre que la liste (`vehicleId` / `groupId` sur `/agenda/summary`). Le filtre de **type** reste hors des compteurs, exprès : chacun est typé par nature. |
| **P2-3** | `take: 1000`, trié par date : au-delà, **la fin du mois disparaissait en silence** | Plafond à 3 000 (un parc de 30 véhicules à deux réservations par jour en produirait 2 500 sur six semaines), et **quand il mord, le journal le dit** avec la société et la fenêtre. |
| **P2-5** | 2 049 `expired` + 172 `dismissed` jamais purgées, ~30 lignes par nuit et par société | Purge horaire, bornée par lot, des propositions closes depuis plus d'un trimestre. **Jamais** `pending`, `applied`, `auto_applied` — elles pointent une réservation créée, c'est l'historique qui a permis la mesure du 23/09. Mesuré : au premier passage elle n'efface **rien** (plus ancienne close : 09/07, 81 j). |
| **P2-6** | `GET /reservations/suggest` et son client web : aucun appelant | Retirés. `ReservationsService.suggest()` reste — l'optimiseur de placement s'en sert. Une route sans consommateur est de la surface d'attaque, pas une fonctionnalité. |
| **P2-7** | Un type de pastille `report` que rien ne produisait, et un `case 'report': break` « à brancher plus tard » | Retiré de l'union. On l'ajoutera avec son producteur. |
| **P1-4** | La feuille Optimisation avait **son** sélecteur de société : l'en-tête pouvait dire cdef31 pendant que la feuille changeait le métier de mh cars ; et `loadedOnce` ne chargeait qu'à la première ouverture | Une seule source : la société du **bandeau**, affichée dans la feuille. Chaque ouverture relit métier et mutualisations. |
| **P1-5** | Un rechargement pendant ou après l'analyse de capacité perdait le résultat → **analyse repayée** | Mémorisé dans le navigateur dès qu'il arrive, par société, restauré avec sa date, oublié une fois appliqué. 🔑 **La clé porte la société réelle** (bandeau pour un super-admin, compte pour les autres) : ma première version utilisait une clé commune à tous les non-super-admins — deux comptes de sociétés différentes sur le même navigateur auraient lu les plaques et modèles l'un de l'autre. Trouvé en relisant avant de committer. |

### Le ménage et les correctifs du 27/09 au soir

**Corrigés, testés, poussés (`2f35014e`) — mais PAS déployés**, décision assumée : on ne recrée pas
la production la veille d'une mise en service pour de l'observabilité. À déployer après lundi.

- **T83** — une file redevenue saine archive maintenant sa ligne, par type, et oublie son
  refroidissement (sinon une rechute dans les 23 h resterait muette, et la fermeture n'aurait servi
  qu'à masquer la panne). Et l'âge part du plus tard de la création du travail **et** de la fin de la
  dernière pause : une file ne reproche que les heures où quelque chose pouvait la consommer.
  La fermeture, elle, n'est **pas** muette sous pause — une file vidée a cessé d'être bouchée.
- **`parJour`** — l'écran exclut désormais les tracés recalés à leur création. 13 tests ajoutés.
- ⚠️ **Un mensonge du harnais trouvé en écrivant ces tests** : le double de
  `pauseAgentsLocaux.findFirst` rendait la première ligne quoi qu'il arrive, donc une pause **déjà
  levée** passait encore pour active et la sentinelle se taisait à tort. Le test était juste, le mock
  avait tort.

**Ménage de la production, vérifié après écriture** : 11 objets de recette sur « Client test », ma
demande de recette restée sur cdef31, et les **77 réservations annulées à venir** supprimées ; le
courriel bloqué en `QUEUED` clos ; les **8 `CRITICAL`** de ce chantier refermées ; `autonomy` aligné
sur `suggest`. Le filet `_sauvegarde_resa_auto_cdef31_20260923` garde ses **116 lignes**, et les
**43 annulations passées** restent barrées là où elles expliquent un trou d'activité.
🔑 **Aucune table ne référence `vehicle_events`** : les suppressions ne cascadaient sur rien.

**`astreinte@cdef31.org`, ce qu'il était possible de faire** : `reservationNoticeEnabled` est le
**seul** interrupteur e-mail par compte du modèle `User`, et il est coupé. L'adresse n'apparaît dans
**aucun** réglage (ni `weeklyReportEmail`, ni `recipients`). Restent deux émetteurs **sans
interrupteur par compte** — `depot-incident.service.ts` et `mission-requests.service.ts`, qui visent
tous les `FLEET_ADMIN` + `FLEET_MANAGER` — mais ils sont **inertes chez cdef31** : 0 compte dépôt,
0 mission, 0 demande de mission. ⚠️ Les deux chemins restants (`password_reset`,
`device_verification`) sont déclenchés par l'utilisateur : **ce compte ne peut donc pas franchir une
vérification d'appareil**, et c'est ça le vrai problème, pas la notification.

---

## 2026-09-28, 07 h – 09 h — la recette sur la démo, et ce qu'elle a trouvé

Chrome piloté sur `demo-tracky.vizyoagency.com` (compte du propriétaire, bandeau « Transports
Méridien »), plan `RECETTE-PREVIEW-DEMO-2026-09-28.md`, sections 0 à 4 et 7 exercées geste par
geste, **requêtes réseau lues à chaque étape**. Le tactile avait été validé la veille au téléphone
par le propriétaire. Les cases cochées et les verdicts sont dans le plan lui-même.

### Ce qui marche, prouvé à l'écran et dans le réseau

- **Compteurs et liste** suivent le même périmètre : `GET /agenda/summary?…&vehicleId=` part à
  chaque changement de filtre (P2-4) ; le filtre de type laisse les compteurs en place.
- **Glisser-déposer** à la souris : `PATCH` 200, heure et durée conservées ; vers le passé : refusé.
- **Réservation** depuis la barre : le motif devient le titre (R-1) ; **carte QR** avec le domaine
  de la démo (R-6) ; **lien public** → demande de 11 places → deux véhicules de 9 pré-retenus (même
  `bookingRef`) ; `reservation_requested` au demandeur, `reservation_request_pending` aux deux
  valideurs cochés, `public_booking_submitted` dans l'activité ; **valider** →
  `reservation_validee` + courriel de confirmation ; **refuser** → `reservation_refusee` ; couper le
  **dernier** destinataire → `PUT` 400 et toast (garde tenue).
- **L'agent** sur les vrais trajets : activé, métier GENERIC enregistré (`PUT agent-settings` 200,
  `PATCH fleet-metier` 200), « Lancer l'analyse » → **453 propositions, 0 réservation ferme**, en
  pointillé sur la grille ; panneau du jour « Proposé par l'agent » → **Réserver** (`POST …/apply`
  201 : pilule ferme, pointillé décrémenté) et **Écarter** (`POST …/dismiss` 201) ; la liste
  « Propositions IA » ne montre que des départs à venir ; **Réorganiser** → 30 j → posées par
  l'agent → simulation juste, appliquée (`POST /reservations/reorganiser` 200 × 2), et **les deux
  annulations ont disparu de la grille** (R-5).
- `/admin/background-tasks` : le catalogue rend le rattrapage des récits avec son rythme et son
  périmètre, sans erreur de rendu.

### Ce qu'elle a trouvé — neuf défauts corrigés le matin même, sur `main`

| | Constat | Correctif |
|---|---|---|
| 🔴 **F18** | **« Posées par l'agent » englobait les demandes du lien public.** Le flux public écrit `source: SYSTEM` comme l'agent ; « Réorganiser → posées par l'agent → tout annuler » aurait annulé une demande de conducteur validée par le standard. Chez un client où l'agent ne réserve rien (cdef31, autonomie « suggestions »), **les SYSTEM sont même exclusivement ça**. Vu à l'écran : « GD-057-AG · agent » sur ma demande publique. | `origineReservation()` dans `reservations.service.ts` : `agent` / `public` (`metadata.public`) / `manuelle` ; le filtre `auto` ne prend plus que l'agent ; l'aperçu porte `origine` et l'écran étiquette « lien public ». Test ajouté. |
| 🔴 **F19** | **La grille ne montrait que les 200 premières propositions** (`take: 200` dans `list()`, tri par départ) : 453 préparées, badge « 200 », et **plus rien après le 3 octobre** — sans un mot. Même famille que P2-3. | Plafond porté à 1 000, et le journal le dit quand il mord (`PROPOSITIONS_LISTE_MAX`). |
| **F1** | **Un incident déclaré à l'instant passait « EN RETARD » dans la seconde** : la règle commune du 27/09 (« PLANNED, ou OPEN à échéance passée ») comptait un OPEN dont `startAt` = maintenant. Mon propre défaut, né en corrigeant « compteur ≠ liste ». | Seul un PLANNED est une échéance, des deux côtés (`estUneEcheance`, `summary`) ; le **contrat du DTO** est corrigé — c'est lui qui avait tort le 24/09, pas seulement le code. Un OPEN vit dans « Incidents ouverts », comme un IN_PROGRESS. Tests réécrits. |
| **F2** | Les badges **● activité / ~ prévu**, empilés en colonne, recouvraient la première pilule : « Vidange + filtres (recette — J… » passait sous « ● 13 / ~18 ». | Badges en ligne, sur la rangée du numéro du jour (`agenda-calendar.component.ts`). |
| **F5** | La carte du jour d'une réservation montrait **le motif deux fois** (il est devenu le titre le 24/09). | `reservationReason()` tait le motif quand il est le titre. |
| **F6** | **Paramètres → Métier affichait « Transport d'enfants » pour une flotte GENERIC** : `[value]` sur le `<select>` est posé avant que les options existent (`@for`), le navigateur retombe sur la première. Rien n'était écrit à tort (le `PATCH` ne part qu'au changement), mais on lisait un réglage faux. | `[selected]` sur chaque option. |
| **F7** | **Deux ascenseurs emboîtés** dans la feuille Paramètres (`.aas-body` 62 dvh dans `.bs-content`) : à la molette, « Qui reçoit les demandes à valider » et les boutons du bas restaient hors d'atteinte. | Un seul ascenseur (celui de la feuille), pied en `position: sticky`. |
| **F14** | La ligne d'un destinataire était un `<label>` entier : **un clic sur l'adresse basculait l'avis, et le `PUT` partait aussitôt** — j'ai coupé l'avis d'un gestionnaire par un clic égaré (rétabli). | Seul l'interrupteur agit ; l'adresse est son `aria-label`. |
| **F15** | La file « À valider » appelait `GET /reservations?status=REQUESTED` **sans le filtre société** du bandeau (super-admin) — « Demander » le portait, « À valider » l'avait oublié. | `fleetId` passé. |

**Vérifié** (commit `c158ea70`, poussé sur `main` à 07:56) : types, `ng build`, suite API complète
(4 332 tests — un seul rouge, `partner-invitation` « ouvert, puis envoyé », une marge d'une seconde
entre le `describe` et le test qui cède sous une suite chargée : portée à une minute, sans rapport
avec l'agenda), suite web (781). Aucune migration, aucun fournisseur DI nouveau — pas de smoke-boot.
**Rejoué sur la démo à 08:05** (images reconstruites sur le VPS, démo seule recréée, marqueurs
`origineReservation` / `PROPOSITIONS_LISTE_MAX` / `ro-tag--public` lus dans ses conteneurs, la prod
toujours sur `11ad5120fb74`) : « 0 en retard » avec l'incident ouvert, **451** propositions visibles
jusqu'au 11/10, badges en ligne, métier « Générique », un seul ascenseur jusqu'aux boutons, un clic
sur une adresse n'envoie plus rien, `GET /reservations?status=REQUESTED&fleetId=…`, et dans
Réorganiser une demande publique fraîche porte « lien public » sous « Toutes » et **n'apparaît pas**
sous « Posées par l'agent ».

### 🚀 Déployé le 28/09 à 08:22 (Paris), sur le go du propriétaire

`deploy.sh --attendre --force` (fenêtre du matin encore ouverte jusqu'à 09:00 : passée outre en le
disant, **personne en ligne** — 0 session, 0 activité sur 20 min — et les reprises de 07:00 faites).
Verdict du script : 150 migrations, aucune en attente ; API saine en 10 s, 0 redémarrage ; démo
recréée et saine ; journal `46ec3f32`, 311 s. Marqueurs lus dans les conteneurs de prod
(`origineReservation`, `PROPOSITIONS_LISTE_MAX`, `purgerPropositions`, `MAX_EVENEMENTS_PAR_FENETRE`
côté API ; `ro-tag--public`, `op-fleet` côté web), 0 erreur dans le journal de l'API. À l'écran,
cdef31 : compteurs 0 / 0 / 0, 309 propositions, et **la feuille Optimisation dit « Société :
CDEF31 »** (P1-4, invisible sur la démo).

⚠️ **Un repère de repli n'a pas pu être posé pour `tracky-api` et `tracky-web`** : leurs images
(`11ad5120fb74`, `208474b25fd1`) n'existaient plus (nettoyage d'images pendant que les conteneurs
tournaient dessus) — le repli automatique aurait été impossible si la santé n'était pas venue.
Elle est venue. À regarder : le ménage d'images ne doit jamais retirer l'image d'un conteneur en
service.

### Ce qui reste à reprendre — après la mise en service, rien de bloquant

- **F3** — les badges ● / ~ des cellules ignorent les filtres véhicule / groupe (ils parlent de tout
  le parc) ; à scoper, ou à dire.
- **F13** — une demande publique de 11 places pré-retient **deux** véhicules de 9 : la file « À
  valider » les montre comme deux demandes indépendantes (même `bookingRef`). À regrouper : une
  carte, un choix, une décision.
- **F16** — un **refus** ne prévient pas le demandeur (la validation, si).
- **F17** — l'activité système note `actor: 'utilisateur'` sur une décision, le nom n'est qu'en
  `meta.parUtilisateur` ; c'est la convention de tout le dépôt (`opérateur`, `conducteur`…) : à
  changer d'un coup, ou pas.
- **F20** — le lien « Agent IA — DÉCOUVRIR » de la barre latérale mène à `/agenda`, rien de plus.

### Ce que la démo n'a pas pu éprouver, et pourquoi

| | Pourquoi | Ce qui en tient lieu |
|---|---|---|
| **§5 Optimisation** (P1-4, P1-5) | le bouton n'existe que si la fonctionnalité IA « capacité » est ouverte à la société (`aiStatus.can('capacity')`), et elle ne l'est pas sur la démo | `ng build` + tests unitaires de la feuille ; **à regarder en prod après déploiement**, société cdef31 |
| **§6 Missions** | la démo n'a aucun compte dépôt | 3 tests API (refus MISSION) + gabarit vérifié à la construction |
| **§8 Rôles** | il faut se connecter avec les comptes `demo-*` — je ne saisis jamais un mot de passe | matrice des permissions relue le 22/09, inchangée |
| **Hors service** (§3) | non exercé ce matin | même code que la prod (`computeSuggestions`), éprouvé en prod le 24/09 |
| `/admin/errors` | route super-admin : sur la démo, le compte est renvoyé à la connexion | lecture directe de `error_logs` de la démo en SQL : voir le plan, § 7 |

### Les demandes du propriétaire, à concevoir (28/09, en regardant la recette)

> « Un véhicule en garage, ça peut prendre une semaine. » — et il faut « penser comme les users :
> la page doit être pratique, pas une tâche ».

- **F8 / F9 — des évènements et des réservations sur plusieurs jours.** Le modèle porte déjà
  `startAt` / `endAt` ; ce sont les formulaires (une date) et la disponibilité du jour (qui ne regarde
  que `startAt`) qu'il faut faire raisonner sur l'intervalle. Une maintenance du 5 au 12 doit
  immobiliser le véhicule **tous les jours** de l'intervalle, dans le panneau du jour comme dans les
  suggestions.
- **F10 — celui qui valide doit pouvoir changer les dates** (une réservation validée reste éditable
  côté API depuis le 24/09 — `update()` — et une maintenance aussi : c'est l'écran qui ne l'offre pas).
- **F11 — « cette maintenance est-elle terminée ? »** : à l'ouverture de l'agenda, une liste des
  maintenances en cours dont la fin est passée (ou sans fin depuis plus d'un jour), avec **Oui,
  terminée** / **Non, nouvelle date de fin**. C'est ce qui fait de la page un outil et non une
  corvée : la clôture vient à l'utilisateur, il ne va pas la chercher.

Ces quatre points sont **un lot** — ils changent le même modèle de disponibilité — et ils ne se
font pas la matinée d'une mise en service.

---

## 2026-09-28, matinée — le lot produit, les trois petits points, et le ménage d'images

Demandé par le propriétaire juste après la mise en service de 08:22 : « regarde le ménage
d'images, il faut garder l'image du conteneur en service », puis « le lot produit (multi-jours,
dates éditables par le valideur, liste « maintenance terminée ? ») et les petits points
F3 / F13 / F16 — redéploie, et teste tout en preview sur Chrome, sur la prod directement, sans
envoyer de mails au @cdef31.org ».

### 🔴 V42 — l'image disparaissait sous son conteneur : ce n'était pas le ménage

Une sonde sur le VPS (Docker 29.1.3, magasin d'images containerd) a tranché en trois builds :
**reconstruire `x:latest` pendant qu'un conteneur tourne sur l'ancien `latest` fait disparaître
l'ancienne image comme objet** — `docker image inspect <id>` répond « No such image », aucune
image « dangling » n'apparaît, le conteneur continue sur son instantané. Le ménage nocturne
(`docker image prune -af --filter until=72h`) épargne toute image utilisée par un conteneur, et
72 h n'étaient pas passées : il n'y était pour rien. C'est la construction elle-même — celle de
`deploy.sh` comme celle d'une preview sur la démo entre deux déploiements (23/09 13:36 et 28/09
08:17 : « aucun repère posable », repli automatique impossible). **Une image qui porte un second
nom survit** : mesuré avec la même sonde.

`deploy.sh` nomme donc l'image de chaque conteneur en service après chaque santé —
`tracky-api:en-service`, `tracky-web:en-service`, `tracky-lp:en-service`, `demo-en-service` pour la
démo — après un déploiement, après un repli automatique, après la démo. Le nom suit le conteneur ;
les repères `avant-*` ont toujours une image sous eux. Treize contrôles de plus au harnais (170
verts), les noms posés à la main sur la prod et la démo en attendant le passage suivant
(`10e6c663`). La procédure historique de `docs/DEPLOYMENT-VPS.md.md` (compose à la main + prune)
est marquée comme telle.

### Le lot produit

| | Ce qui manquait | Ce qui est fait |
|---|---|---|
| **F8** multi-jours | Le formulaire « Évènement » n'avait qu'une date ; une maintenance « du 5 au 12 » n'existait pas, et la grille ne posait une pilule que sur le jour de début. | Champ **« Jusqu'au »** (+ heure de fin hors journée entière) ; le serveur refuse une fin avant le début (création et modification) ; la grille pose une **« suite »** en pointillé sur chaque jour de l'intervalle (`joursCouverts`, borné à 62 j, la suite n'est pas saisissable — c'est le début qu'on déplace) ; la carte du jour dit « du 5 au 12 ». |
| **F9** réservation multi-jours | Le sélecteur savait déjà faire (deuxième clic sur un jour ultérieur), personne ne le trouvait ; la file « À valider » n'écrivait que l'heure de fin. | Une ligne sous le champ le dit ; la file et la carte du jour écrivent la date quand la fin change de jour. |
| **F10** dates éditables | Une réservation validée s'éditait ; une maintenance ou un incident, non — seulement « en cours / terminé / supprimer ». | Bouton **Modifier** sur la carte du jour : même dialogue que la création, pré-rempli (dates, fin, titre, catégorie, sévérité, immobilisation, km, description) ; véhicule et type figés. |
| **F11** « terminée ? » | Une maintenance en cours dont la date de retour était passée restait « en cours » tant que personne n'ouvrait sa carte de jour. | Section **« À clore »** en tête d'agenda, pour qui gère : chaque maintenance ou incident encore ouvert dont la fin prévue est passée (ou sans fin, commencé avant aujourd'hui), avec **« Oui, terminée »** (clos à l'instant, fin réelle = maintenant) et **« Non — nouvelle date de fin »** (date, et il disparaît jusque-là). Elle revient chaque jour jusqu'à la réponse. |
| **F3** | Les badges ● / ~ des cellules ignoraient les filtres véhicule / groupe. | Ils suivent le même périmètre que la grille et le panneau du jour. |
| **F13** | Une demande de 11 places pré-retient 2 véhicules : deux cartes indépendantes dans « À valider », qu'on pouvait valider à moitié. | Une carte par `bookingRef`, les plaques dessous, **« Valider les 2 » / « Refuser les 2 »** ; une validation à moitié faite se dit. |
| **F16** | Le demandeur public apprenait la validation, jamais le refus : il attendait. | `cancel()` d'une demande émet `reservation.refused` ; le notifier envoie **`reservation_refused`** (« Votre demande n'a pas pu être retenue », créneau, destination, « redemandez sur un autre créneau ») — au catalogue, prévisualisable, politique « automatique ». |

Tests ajoutés : fin après début (4, API), refus → événement (2), notifier refus (2), catalogue
(1 clé), `joursCouverts` (7, web). Types, `ng build`, suite API (4 341) et suite web (788) verts.

**Déployé à 09:25** (`9e8b57e6`, `deploy.sh --attendre`, personne d'autre en ligne, aucune
migration, API saine en 15 s — et cette fois les repères de repli posés sur les trois images :
V42 tient). **Recette sur la prod, société Client test, de 09:28 à 09:40** — les cases sont dans
`RECETTE-PREVIEW-DEMO-2026-09-28.md` § 11 : F8, F10, F11 (les deux réponses), F9, F13 validés à
l'écran et dans le réseau ; F3 non observable sur des véhicules fictifs. **Un défaut trouvé** :
une demande groupée (deux véhicules, même `bookingRef`) faisait partir **deux** courriels de refus
au demandeur — et en aurait fait partir deux de confirmation. Corrigé le même matin
(`34694997`, +3 tests) : le notifier n'écrit qu'à la dernière décision du groupe, la confirmation
nomme tous les véhicules retenus. Redéployé dans la foulée (le script a patienté sur le passage
d'automatisation de 09:45, comme prévu). Aucun courriel n'a quitté la société Client test :
`email_logs` ne porte que l'adresse du propriétaire sur toute la fenêtre.

Vu en passant, en lecture seule : sur cdef31, « À clore » remonte dès la première ouverture une
**vraie maintenance ouverte depuis le 21 août sans date de fin** (DZ-034-CA, Garage Renault) —
le cas exact que la liste devait faire remonter. C'est à cdef31 d'y répondre.

---

## 2026-09-28, midi — les sièges auto : un stock de la société, deux types, jamais substituables

### Ce que le propriétaire a demandé, et pourquoi l'ancien modèle était faux

Jusqu'ici un siège enfant était **une caractéristique du véhicule** (`Vehicle.childSeats`) : un
nombre à renseigner voiture par voiture dans *Parc & capacités*, que l'IA de capacité devinait
d'après le modèle (« Kangoo : 3 places-enfant »), et qu'une réservation filtrait avec
`minChildSeats`. Mesuré en prod le 28/09 : **2 sièges déclarés sur 30 véhicules** chez cdef31, et
**0 réservation** n'a jamais porté ce critère. Le modèle ne décrivait pas le métier.

Le métier : la société **possède un stock de sièges**, du matériel mobile qu'elle installe dans le
véhicule retenu. Et il y a **deux sortes de sièges qui ne se remplacent jamais** — « Bébé »
(coque, cosy, nacelle) et « Enfant » (siège, rehausseur) : *un enfant petit petit ne peut pas
aller dans un siège petit moyen*, ni l'inverse. Décisions du propriétaire : libellés « Bébé » /
« Enfant », **aucune substitution dans aucun sens**, stock réglé dans **« Paramètres de l'agenda »**.

### Ce qui a été refait (commit de midi, `main`)

| Couche | Avant | Après |
|---|---|---|
| Base | `vehicles.childSeats` par véhicule | `fleets.childSeatsBaby` / `childSeatsChild` (migration `20260928120000_stock_sieges_auto_par_societe`, défaut 0 ; l'ancienne colonne reste, ignorée) |
| Critères | `minChildSeats` (filtre de véhicule) | `childSeatsBaby` / `childSeatsChild` (besoin pris sur le stock) — écrits **propres** en base (`criteresPropres`) |
| Règle | aucune | `ChildSeatsService` : engagés = somme des besoins des réservations **fermes** qui chevauchent le créneau, **une demande groupée (même `bookingRef`) comptée une fois** ; disponible = stock − engagés, type par type ; refus 409 qui nomme le type et le compte manquants |
| Réservation interne | — | vérifié à la **demande** (pas seulement à la validation : celui qui dépose l'apprend tout de suite), à la **validation** (le stock a pu partir depuis ; la demande et ses sœurs s'excluent) et à l'**édition** (créneau ou besoin revu) ; jamais en rétroactif |
| Lien public | — | deux champs + dictée (« 2 sièges bébé et un rehausseur » → 2 / 1 ; « 2 sièges bébé » n'est **plus** compté comme 2 places) ; vérifié **demandes en attente comprises** ; refus **sans chiffre** (anti-sondage) mais qui nomme le type ; besoin dans `metadata.criteria`, dans l'avis aux valideurs et dans l'accusé de réception |
| IA de placement | payload `childSeats` par candidat | payload `childSeats` = { stock, engaged, available } + prompt réécrit (deux types, aucune substitution, un siège occupe une place assise) ; **si le stock ne suffit pas, le service tranche avant l'appel** — aucun jeton pour une réponse certaine, note explicite |
| IA de capacité | devinait `childSeats` | ne le déduit plus, ne l'écrit plus (`applyCapacity` ignore un `childSeats` reçu) ; schéma et prompt pack `docs/sprint-9-ai/prompts/*.md` alignés |
| Écrans | Sièges-enfant dans la fiche véhicule, *Parc & capacités*, la feuille Optimisation | **Paramètres de l'agenda → « Sièges auto de la société »** (Bébé / Enfant, bouton dédié) ; feuille de réservation : deux champs + ligne « Disponibles sur ce créneau : 1 bébé sur 2 · 3 enfant sur 4 » relue à chaque changement de créneau ; file « À valider » et carte du jour : « Sièges auto à installer : 1 bébé · 2 enfant » ; page publique : deux champs + exemple dicté |

Tests ajoutés : `child-seats.service.spec.ts` (9), réservations (7), lien public (5), placement
(2) ; les anciens verrous `childSeats` réécrits. Types, `ng build`, API (217 sur les suites
touchées), web (788) et **rejeu des 151 migrations** verts.

⚠️ **Le stock part à zéro chez tout le monde.** Tant que cdef31 n'a pas compté ses sièges dans
Paramètres de l'agenda, toute réservation qui en demande est refusée — avec un message qui envoie
au bon écran. C'est voulu : on ne promet pas un siège qu'on n'a pas compté. À dire au client.

En chemin, sur le poste : le Postgres de dev n'écoutait plus sur 5436 — Windows avait réservé les
plages 5308–5407 et 5433–5532 (`netsh interface ipv4 show excludedportrange`). Rejeu fait avec le
conteneur relancé sur **15436** (`POSTGRES_PORT` + `DATABASE_URL` surchargés, sans toucher aux
`.env`) ; le conteneur y reste tant que la plage n'est pas libérée (`winnat`, ou redémarrage).

### Le « check de tout » — deux trous dans la disponibilité, fermés avant de déployer

Le propriétaire a demandé de « ne pas mettre un véhicule dispo dans l'agenda, idem pour les voitures
dormantes depuis longtemps ». La lecture du code (`computeSuggestions`, `isVehicleFree`, le lien
public, l'IA) montre que les **quatre surfaces automatiques** écartent bien hors service et dormants.
Deux chemins passaient à côté :

- **Le panneau du jour** (« N / 30 véhicules disponibles ») ne connaissait que « immobilisé » et
  « réservé » : un véhicule **déclaré hors service** ou **muet depuis des semaines** comptait comme
  disponible — « 30 / 30 » sur un parc où quatre voitures sont accidentées. Il porte maintenant
  quatre raisons, par force décroissante : hors service (déclaré) > boîtier muet (déduit, seuil 7 j,
  le même prédicat que le vivier) > immobilisé > réservé — avec le motif et la durée du silence.
- **Le choix explicite d'un véhicule** (feuille de réservation, validation avec réaffectation,
  édition) ne vérifiait pas le hors service : l'API acceptait de réserver **fermement** une voiture
  accidentée dont le boîtier parle encore. `assertEnService` refuse (409, plaque + motif) à la
  demande, à la validation et à la réaffectation — jamais en rétroactif. La feuille grise ces
  véhicules comme les dormants, avec leur motif.

Le choix d'un véhicule **dormant** par un humain reste possible côté API (la feuille le grise, mais
un véhicule sans boîtier ou garé pour un pont est bien là) ; l'agent, lui, ne l'engage jamais.
Tests : +4 (API). Types, `ng build`, suites vertes.

### Preview sur la démo (12:00 – 12:10, Transports Méridien) — tout vu à l'écran et dans le réseau

`git pull` + `compose build` sur le VPS (rien recréé, les noms `en-service` posés par V42 ont
tenu), puis `up -d` de la démo seule : migration `20260928120000_stock_sieges_auto_par_societe`
appliquée au démarrage, API saine, les trois lignes d'erreur structurelles et rien d'autre.

| Geste | Vu |
|---|---|
| Paramètres de l'agenda → « Sièges auto de la société » | bloc présent, 0 / 0 avec l'avertissement ; saisie 2 / 3 → `PUT /agenda/child-seats` 200, toast « 2 bébé · 3 enfant », avertissement disparu |
| Réserver → champs Bébé / Enfant | `GET …/availability` 200 ; « Disponibles sur ce créneau : 2 bébé sur 2 · 3 enfant sur 3 » relu à chaque créneau |
| Bébé = 3 | ligne orange « il en manque pour cette demande » ; Réserver → **409** « Sièges auto insuffisants sur ce créneau : il manque 1 siège(s) « Bébé » (2 disponible(s) sur 2). Les deux types ne se remplacent pas. » |
| Bébé = 1, Enfant = 2 | **201**, réservation ferme 13:00 → 14:00 ; en base `criteria = {"childSeatsBaby":1,"childSeatsChild":2}` (propre) |
| Panneau du jour | « 31 / 37 véhicules disponibles » avec, nommés : 3 × « Hors service · boîtier débranché », 1 × « Hors service · immobilisé durablement », 1 × « Immobilisé · Pare-brise fissuré », 1 × « Réservé · 13h → 14h » ; carte « Sièges auto à installer : 1 bébé · 2 enfant » |
| Feuille de réservation, sélecteur | « 4 véhicule(s) grisé(s) : déclaré(s) hors service » |
| Lien public, dictée « 6 places avec 2 sièges bébé et 1 rehausseur pour Albi demain matin » | Places 6, Bébé 2, Enfant 1, Albi, 29/09 09:00 → 12:00 — tous « déduit » ; « 2 sièges bébé » n'est plus lu comme 2 places |
| Lien public, Bébé = 3 | **400** « Les sièges auto « Bébé » demandés ne sont pas tous disponibles sur ce créneau… » — sans chiffre |
| Lien public, Bébé = 1 | **201** « Demande envoyée » ; `criteria = {"childSeatsBaby":1,"childSeatsChild":1}`, `seatsNeeded 6` ; courriels : accusé au demandeur + avis aux **trois valideurs de la démo** (adresses de démo, aucune @cdef31.org) |
| File « À valider » | carte « Sièges auto à installer : 1 bébé · 1 enfant · 6 places demandées » ; Valider → **201** (le stock de demain suffit) |

Deux retouches d'écran vues en passant, corrigées avant le déploiement (`d09aa605`) : l'icône du
bloc « Sièges auto à installer » passait au-dessus du libellé ; sur la page publique le libellé
« Sièges enfant · siège, rehausseur · déduit » se repliait et désalignait les deux champs.

### 🚀 Déployé le 28/09 à 13:41 (Paris) — et le créneau de déploiement est plus étroit qu'on ne le croyait

`deploy.sh --attendre` (`d09aa605`) : migration jouée dans un conteneur éphémère avant toute
recréation, API saine en 10 s, noms `en-service` posés sur les trois images (V42), démo recréée et
saine (16 s), journal écrit, artefacts vérifiés **dans les conteneurs** (`child-seats.controller.js`,
chaîne « Enregistrer le stock » dans le chunk web, colonnes présentes en base, 0 erreur au journal
API). Personne d'autre en ligne : la seule session était la mienne.

⚠️ **Première tentative refusée, et c'est une mesure utile.** Lancé à 12:06, le script a attendu le
passage d'automatisation de 11:45, puis celui de 12:45, et s'est arrêté à 13:11 sur sa borne des
65 min (« un passage ne dure jamais autant »). Mesuré au journal : les passages de 10:45 et 11:45 ont
duré **52 et 58 min** — ils finissent à HH:37–HH:43, et la garde refuse de recréer entre HH:42 et
HH:46. **La fenêtre où un déploiement peut passer fait donc 0 à 5 minutes par heure**, et le script
doit déjà être en attente, avec ses images **pré-construites**, quand elle s'ouvre. C'est ce qui a
été fait pour la seconde tentative : `compose build` à l'avance (13:12–13:17), script relancé à
13:17, recréation à 13:41:06. À garder en tête pour les prochains passages en journée.

### Recette prod (13:44 – 13:58, société Client test, bandeau vérifié avant chaque geste)

| Geste | Vu |
|---|---|
| Paramètres de l'agenda (Client test) | bloc « Sièges auto de la société » 0 / 0 → 2 / 3, `PUT` 200, toast |
| Réserver, 14:00 → 15:00 | « Disponibles sur ce créneau : 2 bébé sur 2 · 3 enfant sur 3 » (`GET …/availability` 200) ; Bébé = 3 → **409** « il manque 1 siège(s) « Bébé » (2 disponible(s) sur 2) » ; 1 / 2 → **201**, `criteria` propres en base |
| Panneau du jour | « 7 / 8 véhicule(s) disponible(s) », « TEST-004-XX · Réservé · 14h → 15h », carte « Sièges auto à installer · 1 bébé · 2 enfant » |
| Lien public de **Client test** (jamais celui de cdef31) | en-tête « CLIENT TEST » ; dictée « 5 places avec 2 sièges bébé et un rehausseur pour Albi demain matin » → 5 / 2 / 1 / Albi, tous « déduit » (`parse` 201) ; Bébé = 3 → **400** « Les sièges auto « Bébé » demandés ne sont pas tous disponibles… » ; Bébé = 1 → **201** « Demande envoyée » ; journal : « 5 place(s), 1 siège(s) bébé, 1 siège(s) enfant → Albi » |
| Courriels | **deux, tous deux à l'adresse du propriétaire** (accusé au demandeur, avis au valideur — le seul valideur de Client test), `DELIVERED` ; **aucune adresse @cdef31.org** sur toute la fenêtre |
| File « À valider » | carte « Sièges auto à installer : 1 bébé · 1 enfant · 5 places demandées » ; Valider → **201** |
| Format mobile | l'app rendue à 412 px (cadre dans la page, même session) : feuille de réservation empilée, ligne « Disponibles… : 1 bébé sur 2 · 1 enfant sur 3 » (la réservation de 14 h engage bien 1 bébé et 2 enfant), Paramètres de l'agenda lisibles ; page publique à 375 px dans le navigateur intégré : champs empilés, libellés sur une ligne |

Ménage : les deux réservations de recette supprimées, le stock de Client test remis à 0 / 0 — la
société est rendue comme trouvée. **Le stock de cdef31 est à 0 / 0** : à eux de le compter dans
Paramètres de l'agenda avant de demander un siège ; jusque-là, une réservation avec siège est
refusée en le disant.

---

## 2026-09-28, après-midi — un siège est installé dans un véhicule, ou laissé en stock

### La précision du propriétaire

« Je pouvais faire les deux : assigner un siège auto bébé ou normal à une voiture, ou le laisser
dans le stock. Si la voiture n'a pas de siège équipé, alors regarder le stock — et un paramètre
pour gérer cela. » Le modèle du midi ne connaissait que le stock ; celui-ci connaît les deux.

### Le modèle

- La société **possède** des sièges (`fleets.childSeatsBaby/Child`, inchangés en valeur). Chacun est
  soit **installé** dans un véhicule (`vehicles.childSeatsBaby/Child`, à bord, prêt), soit **en
  stock** = possédés − installés (dérivé, jamais stocké). Deux types, jamais interchangeables.
- **Le réglage** `fleets.childSeatPolicy` — « Si le véhicule choisi n'a pas les sièges à bord » :
  **« Sièges installés + stock »** (défaut : les sièges à bord comptent d'abord, le stock complète
  ce qui manque, sans promettre plus qu'il n'en reste sur le créneau) ou **« Sièges installés
  seulement »** (le stock n'est jamais promis — personne ne peut installer un siège avant le départ).
- Sur un créneau, les sièges à bord ne se disputent jamais entre réservations (deux réservations du
  même véhicule se heurtent déjà sur le véhicule) : **seul le stock se compte** — stock − ce que les
  réservations fermes chevauchantes prennent dessus (leur besoin − les sièges à bord de leur
  véhicule ; une demande groupée = un besoin contre la somme de ses véhicules).
- Invariant : possédés ≥ installés. Réduire le total sous ce qui est à bord est refusé ; équiper un
  véhicule au-delà du total **relève** le total (« 2 à bord » dit qu'on en possède au moins 2).

### Où ça se voit

| Surface | Ce qui change |
|---|---|
| Paramètres de l'agenda | « Sièges auto de la société » : possédés (Bébé / Enfant), la ligne « installés · en stock », le réglage, puis **« À bord des véhicules »** — une ligne par véhicule équipé (Bébé / Enfant / OK) et « Équiper un véhicule… » pour en ajouter |
| Feuille de réservation | le sélecteur dit « · à bord : 1 bébé, 2 enfant » ; la ligne sous les champs dit ce que le véhicule choisi a à bord puis le stock disponible (ou, sous « installés seulement », que le stock n'est pas promis) ; « Auto » prend en premier un véhicule déjà équipé |
| Refus (409) | « il manque 1 siège(s) « Bébé » (0 à bord, 1 disponible(s) en stock sur 2) » — ou, sous « installés seulement », « … à bord de AB-123-CD, et la société ne prend pas les sièges sur le stock … Choisissez un véhicule équipé, ou changez le réglage » |
| File « À valider », panneau du jour | « Sièges auto : 1 bébé · 2 enfant (1 bébé à bord · 2 enfant du stock) » — celui qui prépare la voiture sait quoi sortir |
| Lien public | le besoin entre dans les critères du vivier ; une combinaison de deux véhicules additionne leurs sièges à bord avant de prendre au stock ; refus sans chiffre, type nommé |
| IA de placement | le payload porte la politique, le stock du créneau, et par candidat l'à-bord et le reste à prendre au stock ; le prompt préfère un véhicule déjà équipé à adéquation égale et le dit dans `reasoning` ; sous « installés seulement », un candidat sans les sièges à bord ne couvre pas |
| Parc & capacités | « Sièges auto à bord » en lecture seule, avec le renvoi vers Paramètres de l'agenda (une seule règle, un seul endroit) |

Migration `20260928150000_sieges_auto_installes_par_vehicule_et_politique` (enum, colonne sur
`fleets`, deux colonnes sur `vehicles`). Tests : `child-seats.service.spec.ts` réécrit (13),
réservations (+1), lien public (+2), placement (2 réécrits). Types, `ng build`, API (176 sur les
suites touchées), web (788), rejeu des 152 migrations verts.

### Preview sur la démo (14:45 – 15:35, Transports Méridien)

GD-057-AG équipé d'un siège bébé depuis la feuille (« Équiper un véhicule… » → Bébé 1 → OK,
`PUT …/vehicles/:id` 200 ; « installés : 1 bébé · 0 enfant — en stock : 1 bébé · 3 enfant »).
Réserver, GD-057-AG choisi : « À bord de GD-057-AG : 1 bébé · 0 enfant — stock disponible sur ce
créneau : 1 bébé sur 1 · 3 enfant sur 3 » ; Bébé = 3 → **409** « il manque 1 siège(s) « Bébé » (1 à
bord, 1 disponible(s) en stock sur 1) » ; Bébé = 2 → **201**. Réglage « Sièges installés seulement »
(PUT 200) puis GR-903-GS (non équipé) + Bébé = 1 : la ligne dit « il en manque à bord de ce
véhicule », le serveur refuse. Deux défauts vus et corrigés avant le déploiement : la carte du jour
disait « 2 bébé du stock » pour le véhicule qu'on venait d'équiper (la page gardait sa liste de
véhicules → relue à la fermeture de la feuille, `436d9ffe`) ; une demande « Auto » vidée par les
sièges disait « aucun véhicule libre » (`00606db4`).

### 🚀 Déployé le 28/09 à 17:41 — après trois heures de guichet fermé

Lancé à 14:51 (images pré-construites), le script a attendu le passage de 14:45 (fini 15:38),
buté sur la fenêtre HH:42–46, attendu celui de 15:45 (fini 16:42, **dans** la fenêtre), puis s'est
arrêté sur sa borne de 65 min à 16:47 — la migration, elle, était déjà appliquée (conteneur
éphémère, l'API en place intacte). Relancé à 16:48, il a attendu le passage de 16:45 (fini 17:37)
et recréé à 17:41:45 : API saine en 26 s, noms `en-service` posés, démo recréée, journal écrit,
artefacts vérifiés dans les conteneurs (`child-seats.service.js` porte « Sièges installés
seulement », le chunk web porte « Équiper un véhicule »), colonnes présentes, 0 erreur au journal.
Passages du jour : fins à 14:09, 15:38, 16:42, 17:37 — de 24 à 58 min.

### Recette prod (17:45 – 18:00) — Client test, puis cdef31 sans un courriel

| Où | Geste | Vu |
|---|---|---|
| Client test | Paramètres : possédés 2 / 3, TEST-004-XX équipé 1 bébé | PUT 200 ×2, « installés : 1 bébé — en stock : 1 bébé · 3 enfant » |
| Client test | Réserver TEST-004-XX, Bébé = 2 | « À bord de TEST-004-XX : 1 bébé · 0 enfant — stock disponible : 1 bébé sur 1 » → **201**, `criteria {"childSeatsBaby":2}` |
| Client test | Réserver « Auto », Bébé = 1, même créneau (équipé pris, stock à 0) | ligne « le stock seul ne suffit pas : il faudra un véhicule déjà équipé » → **400** « Aucun véhicule libre ne peut recevoir les sièges auto demandés sur ce créneau (7 véhicule(s) écarté(s) : pas assez de sièges à bord, et le stock ne complète pas ou ne suffit plus)… » |
| Client test | Réglage « Sièges installés seulement », puis TEST-003-XX + Bébé = 1 | « il en manque à bord de ce véhicule » → **409** « … (0 à bord) à bord de TEST-003-XX, et la société ne prend pas les sièges sur le stock (réglage « Sièges installés seulement »)… » |
| Client test | Lien public (celui de Client test), dictée « 5 places avec 1 siège bébé pour Albi demain matin », réglage strict | **201** ; le serveur a retenu **TEST-004-XX**, le seul équipé ; file « Sièges auto : 1 bébé (1 bébé à bord) » ; Valider → 201 |
| cdef31 | Paramètres : possédés 2 bébé, **AL-927-QM** (véhicule réel) équipé 1 bébé | PUT 200 ×2 |
| cdef31 | Réserver « Auto », Bébé = 1 → **Suggérer avec l'IA** | 77 s, 0,08 € (claude-sonnet-5, 4 135 → 7 586 jetons) : **#1 AL-927-QM 95 %** « siège bébé déjà installé à bord (aucune manipulation de stock nécessaire) … choix idéal et immédiatement opérationnel » ; #2 FY-038-TS 90 % « dimensionnement le plus juste pour 1 enfant … + 1 siège bébé à prendre au stock disponible » ; #3, #4 idem |
| cdef31 | Réserver (AL-927-QM pré-sélectionné) | **201**, CONFIRMED directement — **aucun courriel** (une réservation interne n'en envoie pas) |
| Courriels | sur toute la fenêtre | trois, tous à l'adresse du propriétaire (accusé, avis au valideur, confirmation — Client test) ; **aucune adresse @cdef31.org** |

Ménage : réservations de recette supprimées (2 sur Client test, 1 sur cdef31), sièges à bord remis
à 0 (TEST-004-XX, AL-927-QM), possédés et réglage remis à 0 / 0 et « installés + stock » sur les
deux sociétés — rendues comme trouvées. La démo garde sa politique par défaut.

---

## 2026-09-28, soir — la refonte UX du module, en onze points

### La commande

Onze points et cinq captures, le soir même de la mise en service : « l'utilisation doit être
évidente, fluide et rapide, même pour un utilisateur qui découvre complètement le module ». La
conception, décidée avant de coder à partir d'une lecture complète du module tel qu'il était, est
dans [`REFONTE-UX-AGENDA-2026-09-28.md`](./REFONTE-UX-AGENDA-2026-09-28.md) : le diagnostic en une
page, l'architecture cible, les décisions point par point. Ce qui suit dit ce qui a été livré et
ce que la recette a vu.

### Ce qui change pour le gestionnaire

| Avant | Après |
|---|---|
| Huit boutons en tête de page | **Quatre entrées** : Réserver · Demandes (si > 0) · + Événement · ⋯ (QR de réservation, Réorganiser, Paramètres) |
| Les gestes IA dispersés dans des feuilles | **Sélecteur de vues** Calendrier · Missions · Parc · Assistant IA — « Mission » n'est plus un filtre de type, c'était déjà une vue |
| Un grand calendrier de 42 jours pour choisir un créneau | **Début (date · heure) → Fin (date · heure)**, six raccourcis (Même jour, +1 jour, +1 semaine, Matin, Après-midi, Journée), une ligne de lecture « 7 jours · mar. 29 sept. 08:00 → lun. 5 oct. 18:00 » |
| Une réservation de sept jours = sept pilules identiques | Pilule du premier jour « titre · 7 j », suites « ↳ titre (2/7) » ; carte du jour « 7 jours · jour 3/7 » ; durée dans À venir et dans la file de validation |
| Pas de groupe sur une réservation | Champ **« Groupe qui utilise le véhicule »**, pré-rempli avec le groupe du véhicule, modifiable à la demande, à la validation (par carte) et à l'édition, texte libre possible ; **jamais écrit sur le véhicule** ; le filtre groupe de l'agenda retient une réservation par son groupe ou par celui de son véhicule |
| Optimisation : « on ne sait pas ce qu'Analyser va changer » | Vue Assistant IA, étape 1 : ce que ça lit / propose / change, **une analyse par jour et par société** (refus 429 daté), résultat **conservé en base** (`ai_capacity_analyses`), appliqué fiche par fiche |
| Propositions IA : une carte par proposition, on se perd | **Regroupées par véhicule**, une ligne par proposition (jour · heure · destination · confiance · ✓ ✗), « Tout réserver / Tout écarter » par véhicule, repliées sauf le premier, « Tout replier / Tout déplier » |
| Le paramétrage des véhicules dans trois écrans | Vue **Parc** : stock de sièges dessiné (siège plein = à bord, creux = en stock), cartes véhicule (places, sièges, équipements, groupe, état), réglage rapide au clic (places, énergie, équipements, sièges à bord) ; le bloc sièges des Paramètres devient un résumé qui y renvoie |
| Réorganiser ouvre sur « Aucune réservation ne correspond » | Trois cas nommés (garage → réaffecter · journée tombée → annuler · horaires → décaler), **comptes sur chaque choix**, véhicule ciblable, action **Réaffecter** (« auto » = premier véhicule libre et conforme, jamais celui d'origine), vide expliqué |
| Une immobilisation écrasait les réservations sans le dire | Formulaire d'indisponibilité en deux colonnes, nature expliquée, et **« Réservations pendant cette période »** : laisser / réaffecter / annuler par ligne, appliquées après la création, tracées dans l'événement (`metadata.reservations`) |
| Le QR déborde de l'écran | Carte réduite par son unité selon la hauteur, deux colonnes dès 700 px : tout visible sans défiler |

Côté serveur : `POST /reservations/:id/reaffecter`, `GET /ai/capacity/latest`, la garde 24 h sur
`POST /ai/capacity/suggest` (`force` réservé au super-admin), `metadata.group` sur les réservations
(vérifié dans la société), `totaux` et `parVehicule` dans la simulation de réorganisation. Une
migration : la table `ai_capacity_analyses`. Les feuilles Optimisation et Propositions de l'agent
sont supprimées.

### Vérifié avant de déployer

`pnpm verify` complet — **une fois l'allowlist de l'import de démo mise à jour** : le spec exigeait
une décision pour les colonnes sièges auto ajoutées à midi (Fleet, Vehicle : copiées) et pour la
table d'analyses (exclue — elle porte des ids de la production) ; trois tests étaient rouges depuis
l'après-midi sans que personne ne lance la suite entière. Puis : typecheck, 153 migrations
rejouées, smoke-boot, 4 398 tests API (dont 91 sur les réservations et 31 sur l'IA), 791 tests web.

### Preview sur la démo (20:50 – 21:30, Transports Méridien, dans Chrome)

Requêtes lues à chaque geste. Tout ce qui est livré marche ; **trois défauts** trouvés et corrigés
avant le déploiement (`ee134038`) :

| Parcours | Vu |
|---|---|
| En-tête, menu ⋯, sélecteur de vues | quatre entrées, le menu porte QR · Réorganiser · Paramètres ; Assistant IA badgé 418 |
| Assistant IA, propositions | 418 propositions sur 20 véhicules, groupées ; Écarter → `dismiss` 201, Réserver → `apply` 201, repli d'un véhicule d'un clic ; sous-utilisés sur 28 jours en trois colonnes. **Défaut 1** : tout déplié = 418 lignes → repliées sauf le premier véhicule, « Tout replier / Tout déplier » |
| Parc | 37 véhicules, 2 sans places, 4 hors service, stock dessiné ; CQ-903-GL réglé depuis la carte (9 places, climatisation + attelage, 1 siège bébé à bord) → fiche et stock relus (2 bébé à bord · 0 en stock) |
| Réserver, multi-jours | « +1 semaine » puis « Journée » → « 8 jours · lun. 28 sept. 08:00 → lun. 5 oct. 18:00 ». **Défaut 2** : pris le soir, « Journée » met le début à 08:00 du jour même, le serveur refuse, et **défaut 3** : le refus s'affichait au fond du corps défilant, invisible → le sélecteur prévient sous les champs, l'erreur vit dans le pied. Début au 29/09 → `request` 201, HG-270-RN, groupe « Secteur Ouest » posé par défaut |
| Calendrier, carte du jour | pilules « Recette refonte — 8 jours · 7 j » puis « ↳ … (2/7) » à « (7/7) » ; le 1ᵉʳ octobre : « 7 jours · jour 3/7 · Groupe : Secteur Ouest » |
| Éditer, groupe libre | « Autre… » → « Foyer des Lilas » → `PATCH` 200, la carte du jour l'affiche |
| Valider, groupe | la demande publique GD-057-AG ouvre avec « Saisonniers » (le groupe du véhicule) ; changé en « Secteur Nord » → `confirm` 201, `metadata.group` = Secteur Nord |
| Réorganiser | totaux « 2 saisies à la main · 2 du lien public · 1 de l'agent », véhicules avec leurs comptes ; HG-270-RN + Réaffecter (auto) → « 1 réservation serait réaffectée » → appliqué : la réservation de 7 jours passe sur **GR-903-GS**, groupe conservé |
| Indisponibilité + réservations | GD-057-AG, maintenance du 29/09 au 02/10, « Immobilise » : le bloc liste ses deux réservations (« Ramassage secteur nord », « Demande publique → Albi · Secteur Nord ») ; bouton « Créer et reprendre 2 réservation(s) » ; après création : `reaffecter` 201 (→ VH-091-DL), `cancel` 201, `metadata.reservations` sur l'événement |
| QR, mobile | non exercés dans Chrome : l'onglet est passé en arrière-plan (viewport 843 × 100, `visibilityState: hidden`) — la fin de la recette s'est faite au DOM et au réseau ; à rejouer sur la prod |

État laissé sur la démo : une maintenance « Passage au garage (recette refonte) » sur GD-057-AG,
la réservation de 7 jours sur GR-903-GS, CQ-903-GL renseigné — tout ça sur la flotte fictive.

Vu ensuite, l'onglet redevenu capturable : QR sur grand écran en deux colonnes (modale de 127 à 698 px
dans 826, rien à défiler) ; en 412 px (cadre injecté) : quatre entrées en tête, vues sur une ligne
défilante, QR de 97 à 730 px sans défilement, sélecteur de créneau Début/Fin empilés avec ses
raccourcis. Un quatrième correctif (`c8c549b3`, pour le prochain déploiement) : sur téléphone l'onglet
« Assistant IA » s'écrit « IA » pour que les quatre vues tiennent.

### 🚀 Déployé le 28/09 à 21:13 (Paris) — `ee134038`

`deploy.sh --attendre` lancé à 21:11, juste après le build des images pour la démo (V42) : migration
`ai_capacity_analyses` jouée en conteneur éphémère, recréation à 21:13:48, **API saine en 11 s, 0
redémarrage**, repères `en-service` posés, démo mise à jour dans la foulée. Personne d'autre que le
super-admin en ligne dans le quart d'heure précédent (1 compte dans l'heure). Artefacts vérifiés
dans les conteneurs (`capacity/latest` dans l'API, « Tout replier » dans le web).

### Recette prod (21:15 – 21:25) — Client test, puis cdef31 sans un courriel

| Société | Geste | Résultat |
|---|---|---|
| Client test | page rechargée après la bannière de mise à jour | quatre entrées (Réserver · Événement · ⋯), vues Calendrier · Missions · Parc — pas d'Assistant IA : aucune fonction IA ouverte et aucune proposition, la vue n'aurait rien à dire |
| Client test | vue Parc | 8 véhicules, stock à 0/0, réglage « installés + stock » |
| Client test | Réserver : 29/09, « +1 jour », « Journée », TEST-006-XX, motif « Recette refonte prod » | « 2 jours · mar. 29 sept. 08:00 → mer. 30 sept. 18:00 » → `request` **201** ; grille : « Recette refonte prod · 2 j » puis « ↳ … (2/2) » ; pas de groupe (la société n'en a pas) |
| Client test | Réorganiser | « Tous les véhicules (1) · TEST-006-XX (1) », « 1 saisie à la main · 0 du lien public · 0 de l'agent », « 1 réservation serait annulée » — rien appliqué |
| Client test | QR (⋯) | deux colonnes, modale de 127 à 698 px dans 826 : rien à défiler |
| cdef31 | vue Assistant IA | quatre blocs ; 351 propositions sur 25 véhicules, repliées sauf le premier (18 lignes) ; « Aucune analyse pour l'instant » |
| cdef31 | **Analyser le parc** (une seule fois, aucun courriel) | pastille « IA en cours… » puis « Résultats prêts — 26 fiche(s) véhicule à compléter » en 54 s (claude-sonnet-5, **0,055 $**) ; badge « 26 à appliquer » ; ligne « Dernière analyse le 28/09 à 21:20 — prochaine possible le mardi 29 sept. à 21:20 » ; bouton grisé avec le motif. Rien d'appliqué : c'est au gestionnaire de cocher demain. Exemples : GR-270-HZ C3 → 5 places (90 %), FR-428-DQ Expert → 9 places + porte latérale (50 %, « fourgon ou combi, à confirmer ») |
| cdef31 | vue Parc | 30 véhicules, 1 sans places renseignées, 4 hors service, stock 0/0 |
| cdef31 | Réorganiser | « Tous les véhicules (0) … Aucune réservation à venir dans les 30 prochains jours : rien à réorganiser. C'est le bon état. » |
| base | `ai_capacity_analyses` | 1 ligne (cdef31, 26 propositions, 0 appliquée) |

Ménage : la réservation de recette de Client test supprimée en base (`DELETE /agenda/events/:id`
refuse une réservation, 400 — c'est voulu : une réservation s'annule, elle ne s'efface pas depuis
l'écran). Aucun courriel vers `@cdef31.org` sur la fenêtre (vérifié dans `email_logs`).

## 2026-09-29, nuit et matin — cinq revues contradictoires, deux déploiements, l'activité et « 12 places »

### Les passes de revue (00:30 – 05:15)

Le propriétaire : « prends le temps de bien finir ». La refonte du 28/09 au soir a été relue par des
relecteurs indépendants, chaque constat soumis à deux sceptiques chargés de le réfuter ; seuls les
constats que les deux n'ont pas pu réfuter ont été corrigés, puis la correction elle-même relue.

| Passe | Confirmés | Graves | Moyens | Mineurs | Ce qui dominait |
|---|---|---|---|---|---|
| 1 — revue | 51 | 9 | 26 | 16 | réaffectation sans contrôle des places ni des conflits, analyse IA hors périmètre, « Appliquer » qui écrasait la fiche, Réorganiser qui appliquait des critères changés depuis la simulation, « Aucun groupe » ignoré |
| 2 — contre-revue | 29 | 1 | 12 | 16 | prolonger une réservation commencée bloqué par son propre trajet, coupe `aPartirDe`, verrou de l'analyse |
| 3 | 21 | 0 | 9 | 12 | droits par véhicule (valider, annuler, modifier, PATCH véhicule), courriel « annulée », `ids` des refusées, ordre d'écriture de Décaler |
| 4 | 8 | 0 | 2 | 6 | `attendu` ne comparait que le nombre, incident antidaté invisible jusqu'au rechargement, courriel « confirmée » après un refus partiel |
| 5 — lot activité / 12 places | 14 (+2 disputés) | 0 | 3 | 11 | courriel « retenue en partie » qui masquait un simple changement, journal d'un événement qui nommait des champs inchangés, répartition qui oubliait un conducteur par véhicule, owner visible dans le fil agenda d'un autre super-admin |

Ce que le code fait désormais, en bref :

- **Réaffecter** coupe à max(maintenant, début de l'indisponibilité) : une réservation qui déborde
  est **scindée** (avant : reste ; après : part sur la cible, `suiteDe`), une demande en attente qui
  déborde est refusée (elle se valide ou se refuse d'abord), les places demandées et les conflits
  de la cible sont contrôlés.
- **Droit `reservations_manage` par véhicule** pour valider, annuler, modifier, réaffecter
  (exception : retirer sa propre demande en attente) ; `vehicles_edit` par véhicule sur
  `PATCH /vehicles/:id`, la synchro et l'application des capacités.
- **Réorganiser** n'écrit que sur le lot affiché : `attendu` (409 si le lot a changé), `ids`
  pour ne reprendre que les refusées, demandes en attente refusées dès la simulation.
- **Courriels** : `reservation.modified` / `reservation.cancelled`, un seul par demande groupée,
  jamais pour une réservation interne, close ou passée.
- **Propositions de l'agent** prises sous condition (`pending → applied`) avant de réserver,
  rendues si la réservation échoue : deux onglets ne tranchent plus la même proposition.
- **Analyse du parc** : sociétés en périmètre complet seulement, verrou par société, propositions
  en ajout seulement, « fiche modifiée depuis l'analyse » sautée sauf « Appliquer quand même ».

Vérifié avant de pousser : `pnpm verify` — typecheck, 153 migrations rejouées, smoke-boot, **4 540
tests API** (272 suites) — et **826 tests web**, `ng build` sans erreur. Le garde-fou « serveur de
dev » a bloqué l'étape Tests (un Next.js d'un autre dépôt tournait) : relancée avec
`ALLOW_DEV_DURING_TESTS=1`, RAM surveillée.

### Seconde passe dans Chrome, le 28/09 (21:40 – 22:20) — « prends le temps »

Après le déploiement, chaque vue et chaque feuille rejouées sur la démo, en grand écran, en 412 px
(cadre injecté) et en thème sombre, l'onglet redevenu visible. Huit retouches, toutes visuelles ou
de lecture — aucune règle serveur ne bouge :

| # | Vu | Fait |
|---|---|---|
| D1 | sous-titre « Entretiens planifiés et incidents de votre flotte » sous une page qui parle aussi de réservations, de missions, de parc | « Réservations, entretiens, incidents et missions de votre flotte » |
| D2 | dans une cellule étroite, « ↳ Recette refonte — 8 jours (… » : la fraction, en fin de pilule, était coupée | la durée et la position passent AVANT le titre : « 7 j · titre », « ↳ 2/7 · titre » (test ajusté) |
| D3 | 31 propositions de l'agent un jeudi = 31 cartes dans le panneau du jour | une ligne par proposition (plaque · heures · destination · ✓ ✗), le pourquoi au survol, trois visibles puis « Voir les 28 autres » |
| D4 | sur un poste, une feuille du bas fait 1 500 px de large — des champs d'un mètre | la feuille est centrée et bornée à 960 px dès 1 024 px (`bottom-sheet`, toute l'application) |
| D5 | ouvert directement en édition, le sélecteur de véhicule affichait « Auto » alors que le signal portait GR-903-GS | `[selected]` sur chaque option — le piège `[value]` + `@for` déjà rencontré le matin sur le métier |
| D6 | 32 lignes d'usage prévu et 7 indisponibles avant d'atteindre les réservations du jour | listes bornées (6 indisponibles, 5 prévus, 8 réels) avec « Voir les N autres » |
| D7 | les réservations et événements du jour — ce qui est acté — arrivaient en dernier, sous les prévisions | ils viennent juste après la disponibilité ; prévisions et propositions après |
| D8 | en 412 px, « GD-057- / AG » : une plaque coupée sur deux lignes | plaques insécables partout dans le panneau |

Vu et laissé tel quel : le calendrier mobile ne montre que des pastilles (voulu depuis le 24/09),
le formulaire d'indisponibilité sur une colonne en 412 px, la vue Parc et l'Assistant IA en sombre.

### 🚀 Déployé le 29/09 à 05:36 (Paris) — `0c6767c7`, avec `--force`, à la demande du propriétaire

« Personne n'est connecté, on va risquer. » Le script refuse de 05:30 à 09:00 (reprises du
coupe-circuit) ; `--force` passe outre **toutes** les gardes, y compris celle qui protège le passage
d'automatisation. Le risque a donc été mesuré avant, pas pris à l'aveugle :

- reprises du matin : **05:00 (5 véhicules, passée) et 07:00 (30 véhicules)** — lues dans
  `vehicle_schedules` ;
- passages de nuit : 30 s à 8 min ; celui de 04:45 fini, le suivant à 05:45 ;
- en ligne : le seul compte du propriétaire dans les 20 dernières minutes (`user_activities`).

Images pré-construites de 05:29 à 05:32 (rien de recréé), puis `deploy.sh --force` à 05:32:52 :
recréation à 05:36:47, **API saine en 10 s, 0 redémarrage**, démo à jour et saine à 05:37:21 — huit
minutes avant le passage de 05:45 (fini en 28 s), une heure vingt avant la reprise de 07:00.
Artefacts vérifiés dans les conteneurs (la prise sous condition dans l'API de prod et de démo, la
nouvelle vue dans le web).

### Recette prod (05:40 – 06:05) — Client test, dans Chrome

⚠️ L'onglet servait encore l'**ancienne** version : le service worker Angular garde chaque client
sur sa version jusqu'à la bannière « Mise à jour disponible ». Le bouton, cliqué dans un onglet en
arrière-plan, n'a pas rechargé ; une nouvelle navigation a pris la version neuve. Chez un
utilisateur, la bannière apparaît dans la minute (`PwaUpdateService`, vérification toutes les 60 s).

| Geste | Résultat |
|---|---|
| Rejouer la demande « 12 places » du propriétaire (05:10, sur téléphone) | refus « Aucun véhicule libre… » reproduit — voir plus bas |
| Réserver 30/09 09:00 → 02/10 17:00, 4 places, Auto, groupe libre « Groupe recette » | `request` 201, TEST-006-XX (9 places), titre = motif, `metadata.group` = Groupe recette |
| Carte du jour du 30/09 | « 6 / 8 disponibles », « 3 jours · jour 1/3 », « Groupe : Groupe recette » |
| Éditer | véhicule actuel présélectionné, pas d'« Auto » en édition, groupe et motif repris ; fin repoussée au 03/10 → `PATCH` 200, « 4 jours » |
| Maintenance TEST-006-XX le 01/10, « Immobilise » | le bloc liste la réservation, défaut « Réaffecter » → **scission** : TEST-006-XX 30/09 09:00 → 01/10 00:00, suite sur TEST-007-XX 01/10 00:00 → 03/10 17:00, même groupe, `suiteDe` posé |
| Réorganiser, TEST-007-XX, Annuler | « 1 réservation serait annulée » → appliqué : la suite seule est annulée, la réservation du propriétaire (TEST-004-XX) intacte |
| Parc, Missions, QR, Paramètres | places de chaque véhicule ; aucune mission ; QR sans défilement (571 px pour 571) ; les sièges renvoient à la vue Parc |
| 412 px (cadre injecté) | aucune largeur au-delà de 412, vues sur une ligne, pastilles de filtre défilantes dans leur rangée |
| `email_logs` | **0 courriel** sur les 90 minutes |

Ménage : la partie restante annulée, la maintenance supprimée.

### 🔎 « 12 places » : le propriétaire ne s'est pas trompé de geste — le message, si

À 05:10, sur Client test : « Places min. » 12, véhicule Auto → « Aucun véhicule libre ne correspond
aux critères sur ce créneau. », alors que la carte du jour disait **« 7 / 8 véhicule(s)
disponible(s) »**. Le parc : trois véhicules de 9 places, quatre de 5, un de 4. **Le refus était
juste : aucun véhicule n'a 12 places.** Mais le filtre écartait les véhicules trop petits sans les
compter, et le message parlait d'un créneau — on cherche un conflit d'horaire qui n'existe pas. Et
le « 7 / 8 » compte des véhicules, pas des places.

### 🔎 L'activité : Joost ne voyait AUCUNE action d'agenda

Cartographie (quatre lecteurs indépendants, données prod lues en `SELECT`) :

- sa page `/fleet-admin/activity` ne lit **que la navigation** (`user_activities` : pages, clics,
  défilement) et les commandes moteur — jamais le journal métier ;
- le journal métier (`system_activity_logs`) n'enregistrait que valider / refuser / annuler, la
  scission, la réorganisation appliquée et la demande publique — **ni la création, ni la
  modification, ni la réaffectation simple, ni les maintenances et incidents, ni les propositions
  de l'agent** ;
- les lignes enregistrées ne portaient **pas l'auteur** (`triggeredByUserId` vide, « UTILISATEUR »
  à l'écran), dataient le créneau **en UTC**, et la réorganisation prenait la société du filtre de
  l'écran (souvent vide) au lieu de celle des réservations ;
- l'onglet Système de `/admin/activity` n'avait ni puce « Réservations », ni filtre société ;
- ces lignes partaient à la purge au bout de **30 jours**.

Relevé de la recette : la scission de 05:51 apparaît bien (`reservation_scindee`, société juste),
mais sans auteur et « jusqu'à 2026-09-30T22:00:00.000Z ».


### Ce qui a été fait pour les deux (07:00 – 07:35) — lot `c10e27d5`

Six lots aux fichiers disjoints, chacun relu par un relecteur indépendant puis repris ; puis une
**cinquième revue contradictoire** du lot entier (14 confirmés, 2 disputés, **aucun grave**),
corrigée elle aussi.

**Activité.**
- **Le journal** (catégories `RESERVATION` et `AGENDA`) note désormais chaque geste : demande,
  création, consignation, validation, refus, **retrait par son auteur** (ce n'est pas un refus),
  annulation, modification (seulement si un champ change vraiment), réaffectation, décalage,
  scission, réorganisation (**un résumé par société du lot**), événement créé / modifié / clos /
  supprimé (écrit AVANT la suppression), incident, proposition de l'agent réservée / écartée
  (Écarter est idempotent), sièges auto, capacités appliquées par l'IA ou modifiées à la main,
  plans d'entretien, réglages de l'agent. Toujours : la société de la **ressource**, l'**auteur**
  (`triggeredByUserId`), l'heure de **Paris**. Un journal qui échoue ne fait jamais échouer le geste.
- **Chez Joost** : un onglet **« Agenda »**, par défaut, sur `/fleet-admin/activity`
  (`GET /api/fleet-admin/activity/agenda`, borné à sa société). Un super-admin ou le propriétaire
  y apparaît **« Équipe Tracky »** : le geste se voit, jamais l'identité — et le propriétaire reste
  caché aux autres super-admins, comme partout.
- **Chez le propriétaire** : `/admin/activity` › Système filtrable par société et période, puces
  Réservations / Agenda, badges lisibles, et le même statut que le client (« Avec refus » pour une
  réorganisation appliquée en partie, plus « ignoré »).
- **Conservation** : `RESERVATION` et `AGENDA` gardées **365 jours**, comme l'audit `MUTATION`.

**12 places.**
- Un constructeur unique (`aucun-vehicule.message.ts`) pour la demande, la réaffectation et l'IA
  de placement : « Aucun véhicule de 12 places ou plus (conducteur compris) : le plus grand en a 9.
  Sur ce créneau, 7 véhicules sont libres, de 4 à 9 places : répartissez le groupe… ». Les sièges
  auto passent avant la taille ; les places non renseignées et les boîtiers muets sont dits.
- **Un conducteur par véhicule** : « 9 + 4 = 13 places » ne couvre pas 13 places demandées (12
  passagers, 11 offerts). Le serveur et la feuille comptent de la même façon.
- Un véhicule choisi à la main plus petit que « Places min. » est refusé (demande, édition,
  validation qui déplace, réaffectation vers un véhicule choisi — jamais en rétroactif ni sur des
  places inconnues).
- La feuille : les places dans chaque option, « Places min. (conducteur compris) », l'avertissement
  **avant** l'envoi, et **« Répartir le groupe : A (9 pl.) + B (5 pl.) »** → une demande interne par
  véhicule, séquentielles, avec un bilan clair ; **aucun courriel**.
- La carte du jour : « 7 / 8 libres · jusqu'à 9 places par véhicule ».

**Et aussi** : les correctifs de la quatrième revue (`lotIds` de Réorganiser renvoyés en `ids`,
incident antidaté relu, course de société, demande en attente non réaffectable laissée par défaut,
droits par véhicule dans la vue Parc, courriel « retenue en partie » avec un motif explicite),
« Mettre à jour maintenant » qui recharge au bout de 5 s même si le service worker se tait, et
« Voir l'historique » d'une coupure non confirmée qui ouvre l'onglet Moteurs (pour les seuls rôles
qui ont la page).

Vérifié : `pnpm verify` — typecheck, 153 migrations, smoke-boot, **4 717 tests API**, **876 tests
web** — et `ng build`.

La reprise de 07:00, sur l'API déployée à 05:36 : **24 remises en marche, 24 réussies**.

### 🚀 Déployé le 29/09 à 08:12 (Paris) — `c10e27d5`, `--force` pour la seule fenêtre du matin

Images pré-construites à 07:37 ; le passage de 07:45 a duré **21 min 52** (la nuit : 23 s) — le
déploiement a attendu sa fin (08:06) plutôt que de le tuer : `--force` passe outre TOUTES les gardes,
passage compris. Au départ : un seul compte en ligne (le propriétaire), aucun compte cdef31, dernière
reprise du jour (07:00) passée. Aucune migration nouvelle. Recréation à 08:12:04, **API saine en 10 s,
0 redémarrage**, démo à jour et saine à 08:12:52. Artefacts vérifiés dans les conteneurs.

### Recette prod (08:13 – 08:20) — Client test, dans Chrome, navigation neuve (nouvelle version)

| Geste | Résultat |
|---|---|
| Carte du jour du 29/09 | « **7 / 8 véhicules libres aujourd'hui · jusqu'à 9 places par véhicule** » |
| Réserver, 30/09 09:00 → 12:00, « Places min. » 12 | libellé « Places min. (conducteur compris) », options « TEST-004-XX · 5 pl. · Fictif Kangoo » ; sous le champ : « Aucun véhicule n'a 12 places : le plus grand en a 9. » puis « **Répartir le groupe : TEST-001-XX (9 pl.) + TEST-008-XX (4 pl.) = 13 places, dont 2 conducteurs : 11 places passagers pour 11 passagers** » |
| « Réserver » en Auto malgré tout | 400 : « **Aucun véhicule de 12 places ou plus (conducteur compris) : le plus grand en a 9. Sur ce créneau, 7 véhicules sont libres, de 4 à 9 places : répartissez le groupe sur plusieurs véhicules (une réservation par véhicule).** » |
| « Réserver ces 2 véhicules » | deux réservations fermes, « Recette 12 places (1/2) » sur TEST-001-XX et « (2/2) » sur TEST-008-XX, 09:00 → 12:00, sans plancher de places |
| `/fleet-admin/activity` (bandeau Client test) | onglet **Agenda** par défaut : « 08:14 · Équipe Tracky · Réservation créée · TEST-008-XX — Réservation créée — TEST-008-XX, 30/09/2026 09:00 → 12:00 · « Recette 12 places (2/2) » » ; les lignes d'avant le déploiement restent telles qu'écrites (« Tracky », dates UTC) |
| `/admin/activity` › Système | sélecteur Société = Client test (celui du bandeau), puces Réservations / Agenda, « Réservation créée **par Administrateur TRACKY** » avec plaque et société |
| Annuler les deux (ménage) | `cancel` 201 ×2 → « Réservation annulée — Équipe Tracky » dans le fil ; la réponse de l'API ne porte **aucun** identifiant d'utilisateur ni `meta` (clés : id, at, category, action, actionLabel, status, actorName, actorKind, vehiclePlate, detail) |
| Fil agenda de cdef31 (lecture seule, ce que Joost voit) | les passages de l'agent (« Agent de l'agenda »), la demande publique du 23/09 (« Demande publique »), la réorganisation du 23/09 ; les gestes antérieurs n'avaient pas été journalisés — tout nouveau geste y figurera |
| 412 px (cadre injecté) | page Activité sans débordement, onglet « En ligne » présent sous 1 024 px |
| `email_logs` | **0 courriel** sur les 4 dernières heures |

## 2026-09-29, après-midi — le menu « ⋯ », Réorganiser vide chez cdef31, l'IA désactivée par le client

### Le menu « ⋯ » sortait de l'écran (retour du propriétaire, capture) — en prod à 12:42 (Paris)

`.ag-dd-menu--right { left: auto; right: 0 }` était déclarée AVANT la règle de base
`.ag-dd-menu { left: 0 }` dans la feuille du composant : à spécificité égale, la dernière gagnait,
et le menu s'ouvrait vers la droite depuis le bouton. Mesuré en prod à 1 536 px : de 1 468 à 1 698 px
(162 px hors de l'écran) ; corrigé (deux classes) : de 1 274 à 1 504 px ; en 412 px : de 160 à 386.
`deploy.sh --attendre` : recréation à 12:41:54 (juste avant la garde de HH:42), API saine en 15 s,
passage de 12:45 parti normalement.

### « Réorganiser est vide chez cdef31, on n'y comprend rien » — le diagnostic

Réorganiser ne travaille QUE sur des réservations (fermes ou en attente) à venir. Chez cdef31, en
base : **0 réservation à venir** ; 326 passées (324 posées par l'agent avant le 23/09) ; aucune
réservation créée depuis le 16/09. Le 23/09, les 116 réservations fermes de l'agent ont été annulées
(l'agent ne réserve plus : 57 % seulement avaient roulé sur leur créneau). Ce que cdef31 a, ce sont
**317 propositions de l'agent** en attente (29/09 → 12/10) — des suggestions, pas des réservations :
Réorganiser ne les voit pas.

Ce que l'écran en disait : 30 véhicules à « (0) », « Toutes 0 », « Posées par l'agent 0 », deux
conseils sans objet (« relisez la liste avant d'appliquer », « choisissez d'abord le véhicule qui part
au garage »), et seulement tout en bas : « Aucune réservation à venir… C'est le bon état. »

Relevé en passant : 59 propositions `auto_applied` à venir pointent des réservations qui n'existent
plus (ménage du 23/09) — sans effet à l'écran.

Refonte de la feuille : en attente de la décision du propriétaire (pistes dans la réponse du 29/09).

### L'IA désactivée par le client : plus rien d'IA dans l'agenda

Demande : « quand on désactive l'IA, il ne faut plus voir toutes les options IA ; c'est le client qui
désactive, donc on enlève les suggestions ; dans les paramètres, tu grises ou fais disparaître les
boutons de l'agent ».

**La règle, en un endroit** : l'IA « coupée » = le choix du client (`Fleet.aiEnabled`).
`/api/ai/status` le porte désormais seul (`fleetEnabled`, ajout sans rupture) ; `enabled` y mêlait
la présence d'une clé au serveur — sur la démo (aucune clé, option imposée), la page, la feuille, la
barre latérale et l'Activité en tiraient chacune une conclusion différente (trouvé par la revue).
`AiStatusService.societeActive()` le lit ; un bouton qui APPELLE l'IA reste gardé par `can(feature)`.
Rien d'autre ne change au serveur : l'agent peut tourner, on n'en montre plus rien, et tout revient à
la réactivation, sans recharger.

| Surface | IA coupée |
|---|---|
| Agenda | propositions non lues ni montrées (pointillés, légende, panneau du jour, badge) ; plus d'onglet « Assistant IA » (il restait dès qu'il y avait des propositions), `?vue=ia` → Calendrier ; pastille des travaux IA muette (sauf un travail lancé sur une autre société) ; « Posées par l'agent » absent de Réorganiser s'il ne compte rien ; plus de « suggestions de l'IA » ni d'« IA de placement » dans les textes |
| Paramètres de l'agenda | tout le bloc de l'agent (activation, métier, analyse nocturne, fréquence, autonomie, auto-complétion, déclencheurs, coûts, passages, « Lancer un passage ») remplacé par une note ; restent « Assistance IA » (le chemin pour réactiver) et les sièges auto ; réglages conservés, jamais envoyés ; statut relu à chaque ouverture |
| Barre latérale | plus de carte « Agent IA — Découvrir » |
| Paramètres › Abonnement | carte « Agent IA » : « Désactivé », sans lien |
| Activité › Agenda | plus de lignes « Passage de l'agent » |

Aussi : `AiStatusService` ignore une réponse dépassée (deux changements de société rapprochés) et
oublie le statut au changement de compte dans le même onglet.

Méthode : trois lots relus et repris, puis une revue contradictoire transversale (3 confirmés,
1 disputé, 8 réfutés — tous traités). Vérifié : `pnpm verify` — 4 719 tests API, 423 partagés,
923 web — et `ng build`.

### 🚀 Déployé le 29/09 à 17:06 (Paris) — `7d64b18c`, sur l'ordre du propriétaire

Des clients travaillaient (un gestionnaire de cdef31, un administrateur d'A2R) : un guetteur côté
serveur a d'abord attendu « aucun passage + aucun geste client depuis 10 min + minute ≤ 33 »
(`deploy.sh` met 4 à 6 min avant de recréer) — de 14:57 à 17:00, sans fenêtre : les passages de
journée durent 50 à 57 min. Sur « déploie maintenant, ne t'en fais pas », `deploy.sh --force` à
17:00:49 : le passage de 16:45 a été **interrompu** (annoncé avant ; ses trajets repassent à 17:45),
recréation à 17:06:09, **API saine en 15 s, 0 redémarrage**, démo à jour. La démo avait été mise à
jour seule à 15:35 pour la préversion (IA active sans clé : note « aucun moteur », agent visible).

### Recette prod (17:07 – 17:20) — Chrome, cdef31 en lecture seule puis Client test

| | cdef31 (IA active) | Client test (IA coupée) |
|---|---|---|
| `/api/ai/status` | `fleetEnabled: true` | `fleetEnabled: false` |
| Onglets de l'agenda | Calendrier · Missions · Parc · **Assistant IA 307** | Calendrier · Missions · Parc |
| Légende « Proposé par l'agent » | oui | non |
| Carte « Agent IA » (barre latérale) | oui | non |
| Paramètres de l'agenda | bloc de l'agent complet, « Lancer un passage » | la note « L'IA est désactivée… ils reviennent dès que l'IA est réactivée » ; restent Assistance IA, sièges auto, liens publics, destinataires |
| Réorganiser | — | origine « Toutes » seule, plus de « · N de l'agent » |
| Feuille Réserver | — | pas de « Suggérer avec l'IA », aucune mention d'IA |
| Vue Parc | — | plus d'« IA de placement » |
| Paramètres › Abonnement | — | carte « Agent IA » sans le lien « Ouvrir l'agenda IA » |

Aucune écriture sur cdef31 ; le bandeau remis sur cdef31 à la fin.


### Réorganiser : pistes 1, 2 et 4 du propriétaire — en prod à 18:10, retouche à 18:24

Le propriétaire a retenu trois des quatre pistes proposées (la 3 — faire agir Réorganiser sur les
propositions de l'agent — reste ouverte).

- **Piste 4 — l'entrée du menu « ⋯ » grisée, avec sa raison.** Nouveau
  `GET /api/reservations/reorganisables` (droit `reservations_manage`) : les réservations vivantes qui
  chevauchent les 30 prochains jours, même règle (`chevaucheFenetre`, partagée avec la simulation) et
  même périmètre que Réorganiser, plus le nom de la société. Relu à l'ouverture du menu, au
  changement de société et après chaque changement de réservation ; inconnu = entrée active. Chez
  cdef31 : « Réorganiser des réservations » grisé, et dessous « Aucune réservation à venir sur 30 jours
  — les 307 propositions de l'agent se traitent dans l'Assistant IA ».
- **Piste 1 — « Rien à réorganiser » en tête.** Quand rien ne chevauche les 30 jours (compte du menu,
  ou simulation « Toutes » sur 30 jours vide), la feuille ne montre plus que : « Rien à réorganiser —
  Aucune réservation à venir chez cdef31 dans les 30 prochains jours », ce que fait Réorganiser, « Les
  307 propositions de l'agent ne sont pas des réservations… » et « Ouvrir l'Assistant IA » ; « Fermer »
  en pied. Jamais pour une feuille ouverte depuis un geste (véhicule, période, refusées). Décision en
  fonction pure testée (`rienAReorganiser`).
- **Piste 2 — seuls les véhicules qui ont des réservations** dans la liste « Véhicule » (le véhicule
  en panne en pleine réservation y est, par sa réservation en cours ; le véhicule choisi reste), avec
  « 1 véhicule a des réservations dans les 30 prochains jours : seul celui-là est proposé ». Les
  conseils « relisez la liste » et « choisissez d'abord le véhicule » ne s'affichent plus sans objet.

**Trouvé en recette (démo, puis prod) et corrigé avant la fin :**

| Vu | Corrigé |
|---|---|
| démo, « Tous les véhicules » + Annuler : « 1 véhicule a des réservations » et, juste dessous, « Aucune réservation à venir » — la seule réservation était EN COURS, qu'Annuler ne prend pas | l'explication « 1 réservation déborde sur la fenêtre mais commence avant… » vaut aussi pour « Tous », avec « Réaffecter celle de GR-903-GS » (choisit le véhicule et l'action) |
| démo, 7 jours : « Une réservation plus loin, dans les 30 prochains jours » — la même, déjà dans la fenêtre | plus loin = les 30 jours moins la fenêtre |
| prod, entrée active : « Réorganiser des / réservations » sur deux lignes (56 px contre 37) | le libellé ne se coupe plus, le menu s'élargit (234 px) |
| prod, juste après le déploiement : l'onglet servait encore l'ancienne version (navigation moins d'une minute après, le service worker n'avait pas encore vu la nouvelle) | rien à corriger : une seconde navigation l'a prise — à savoir pour les recettes |

**Recette prod (18:11 – 18:30), Chrome :**

| | Résultat |
|---|---|
| cdef31, `reorganisables` | `{ total: 0, jours: 30, societe: "cdef31" }` |
| cdef31, menu « ⋯ » | Réorganiser grisé (désactivé, opacité 0,62, curseur interdit), raison dessous et en info-bulle ; QR et Paramètres actifs ; en 412 px, menu de 160 à 386, sans débordement |
| cdef31, feuille (ouverte au DOM pour le test — une simulation, aucune écriture) | la carte seule, sans critères ; « Ouvrir l'Assistant IA » ferme la feuille et affiche l'Assistant IA 307 |
| Client test (IA coupée), menu | entrée active (compte 1 : la réservation de 8 jours de TEST-004-XX, en cours), une ligne |
| Client test, feuille | « Tous les véhicules (1) · TEST-004-XX (1) » ; pas de « Posées par l'agent » ; « Rien à annuler… 1 réservation déborde… » ; « Réaffecter celle de TEST-004-XX » → simulation « 1 réservation serait réaffectée », scindée — non appliquée |

Déploiements : 18:10 avec `--force` (le propriétaire : « tu peux déployer quand tu veux ») — le
passage de 17:45, commencé 25 min plus tôt, a été interrompu ; puis 18:24 sans `--force`, aucun
passage en cours. Aucun courriel.

### Réorganiser : piste 3 — les propositions de l'agent — en prod à 20:10

« Fais la piste 3 aussi et teste sur Chrome. » L'agenda de cdef31 porte **307 propositions de
l'agent sur 25 véhicules** (du 30/09 au 12/10) et **aucune réservation à venir** : Réorganiser, qui
ne prenait que des réservations, n'y trouvait rien. Il écarte désormais un LOT de propositions.

**Vérifié d'abord** : une proposition écartée ne revient pas. L'agent ne repropose jamais un créneau
déjà traité — unicité société × véhicule × début, quel que soit le statut (`runForFleet`) — et ses
verdicts IA ne touchent que les propositions `pending`. Écarter en lot tient donc plus d'une nuit.

**Serveur — `POST /api/agenda/agent/proposals/ecarter`** (`reservations_manage`) :
- simulation par défaut ; à l'application, `ids` **obligatoire** = les `lotIds` montrés (une
  proposition arrivée depuis — un passage de l'agent — n'est jamais écartée sans avoir été vue) ;
- à venir seulement, et qui **chevauche** la fenêtre (une immobilisation à 10:00 emporte le trajet
  08:00–12:00) ;
- écriture sous condition `pending` : réservée ou écartée ailleurs entre-temps = non touchée,
  comptée `dejaTraitees` ; après l'écriture, la liste par véhicule compte ce qui RESTE ;
- société de l'appelant (celle du bandeau pour un super-admin ; `fleetId` **ignoré** pour les autres
  rôles, comme pour les réservations — voir plus bas) ; seuls les véhicules dont il gère les
  réservations (`gereLesReservationsDe`, la règle d'`exigerGestion`), les autres comptés à part
  (`horsGestion`) ; plafond 500, dit ;
- **UNE ligne de journal par lot** (`AGENDA` / `propositions_ecartees`, « Propositions de l'agent
  écartées en lot »), pas une par proposition — 307 lignes noieraient l'activité de Joost ; rien si
  sans effet ; aucun courriel.

**Écran :**
- feuille : onglet **« Réservations | Propositions de l'agent »** en tête (IA active seulement),
  même fenêtre et même véhicule pour les deux, chaque bouton avec son compte ; titre « Réorganiser »
  quand l'onglet est là ; la feuille **s'ouvre sur les propositions quand il n'y a qu'elles**
  (`quoiALOuverture`) ; « Écarter ces N propositions » renvoie le lot montré, puis la page relit ses
  propositions (calendrier, badge, Assistant IA) ; la carte « Rien à réorganiser » de l'onglet
  Réservations mène aux propositions (« Voir les propositions de l'agent ») ;
- menu « ⋯ » : grisé seulement s'il n'y a **ni** réservation **ni** proposition ; chez cdef31, actif,
  avec « Aucune réservation à venir · 307 propositions de l'agent » dessous (`menuReorganiser`) ;
- **« un véhicule part au garage »** : après la création d'une immobilisation (ou les jours ajoutés
  d'une prolongation) qui recouvre des propositions du véhicule, un avis le dit (« Elles ne pourront
  pas être réservées ») et Réorganiser s'ouvre sur elles, période réglée — simulation d'abord.

**Trouvé en recette et corrigé avant la mise en prod :**

| Vu | Corrigé |
|---|---|
| démo : une maintenance « toute la journée » sans retour (00:00 → 00:00 le lendemain) se lisait « Période de l'immobilisation : du mer. 30 sept. au jeu. 1 oct. » | une fin à minuit pile appartient au jour d'avant : « le mer. 30 sept. » (`libellePeriode`, 5 tests ; vaut aussi pour le renvoi des réservations refusées) |
| `pnpm verify` : 4737/4738, un test R3 (décaler, un courriel par demande) rouge — vert relancé seul | chaque ligne du test lisait l'horloge : sous charge, 1 ms d'écart inversait l'ordre d'écriture (T0). Un seul instant pour le lot (`576faecc`) |
| relecture : le filtre société de l'écran est relu du navigateur **quel que soit le rôle** et jamais effacé à la déconnexion — un gestionnaire après une session super-admin sur le même poste aurait pris un 403 | le lot ignore `fleetId` hors super-admin (serveur) et ne l'envoie que pour un super-admin (écran). ⚠️ Le même défaut touche `GET /agenda/agent/proposals` (liste vide, en silence) : signalé à part, pas corrigé ici |

**Recette démo (Transports Méridien, 449 propositions sur 30 véhicules) — écritures sur la démo :**

| | Résultat |
|---|---|
| menu (1 réservation en cours) | actif, sans ligne |
| feuille | « Réservations 1 · Propositions de l'agent 449 », ouverte sur Réservations |
| onglet Propositions | 449 sur 30 véhicules, aperçu avec destination ; 7 jours → 258 ; FQ-639-GV → 4, « Réservations 0 » |
| « Écarter ces 4 propositions » | « 4 propositions écartées sur FQ-639-GV », liste → 254, badge IA 449 → 445 ; en base 4 `dismissed`, les 2 hors fenêtre toujours `pending` |
| journal | une ligne `propositions_ecartees` (4 ids) ; visible dans Activité de la flotte → Agenda (« Équipe Tracky », super-admin) |
| maintenance immobilisante demain sur CY-240-VN | avis « 2 propositions de l'agent sur CY-240-VN pendant l'immobilisation », feuille sur l'onglet Propositions, période réglée ; écartées ; aucune reproposée sur ce jour |
| effet de bord observé (existant) | créer la maintenance a déclenché un passage de l'agent (`triggerMaintenance`) : +78 propositions sur d'autres jours — le lot montré n'en contenait aucune |
| 412 px | aucun débordement ; plafond dit (« 521 », « Écarter ces 500 propositions », « Plus de 500 propositions… ») |

**Recette prod (20:11 – 20:13), Chrome :**

| | Résultat |
|---|---|
| cdef31, menu | « Réorganiser des réservations » **actif**, « Aucune réservation à venir · 307 propositions de l'agent » |
| cdef31, feuille (simulations seules, **rien écarté**) | ouverte sur « Propositions de l'agent 307 », 25 véhicules ; « Réservations » → carte « Rien à réorganiser… Les 307 propositions de l'agent, elles, se reprennent d'ici » ; GR-294-VW sur 7 jours → 11 |
| cdef31, base après | 307 `pending`, 0 ligne `propositions_ecartees` |
| Client test (IA coupée) | titre « Réorganiser des réservations », pas d'onglet, aucune mention de l'agent |

Déploiement : 20:10 avec `--force`, `39187df5` — `deploy.sh` avait d'abord refusé (passage de 19:45
en cours depuis 20 min) ; personne d'autre que le super-admin en ligne dans la demi-heure. Le
passage de 19:45 a été **interrompu** (centre d'alerte : « Passage d'automatisation interrompu »,
critique, poussé aux super-admins) — ses trajets passent au suivant. Aucun courriel.

**Observé, laissé tel quel :** l'agent propose des créneaux qui se chevauchent pour UN véhicule le
même jour (GR-294-VW le 30/09 : 08:03–17:15, 08:25–17:24, 08:47–17:24) — réserver l'une fera refuser
les autres. Un dédoublonnage par véhicule dans `runForFleet` serait la suite logique.

### Le filtre société resté d'une session super-admin — corrigé sur branche, **NON DÉPLOYÉ**

Le défaut signalé en relisant la piste 3 (dernière ligne du tableau ci-dessus). Le filtre société
(`vizyo-fleet-filter`) vit dans le localStorage du **navigateur** : il était relu **quel que soit le
rôle** et jamais effacé à la déconnexion. Un gestionnaire qui se connectait après une session
super-admin sur le même poste envoyait donc la société d'un AUTRE client. `GET /agenda/agent/proposals`
répondait 403, et l'écran avalait l'erreur : grille sans pointillés, badge de l'Assistant IA et
onglet des propositions de Réorganiser vides, sans un mot. Le même 403 guettait
`GET /agenda/agent/runs` et `POST /agenda/agent/run`.

**Serveur.** L'agent (`list`, `listRuns`, `runOnDemand`, `ecarterEnLot`) et ses réglages (`get`,
`set`, `destinatairesAvis`) **ignorent `fleetId` hors super-admin**, comme les réservations
(`scopedWhere`) : un gestionnaire lit et règle SA société, et le 403 lui devient impossible. Un
compte de flotte sans société (anomalie) prend 403 « Aucune flotte associée » au lieu de 400.
**Le 403 reste là où la société vient d'une DONNÉE**, dans `reglerAvis` (la société du compte dont
on bascule l'avis) : l'ignorer écrirait sur le compte d'un autre client.

**Écran.** Correction à la source, dans `FleetFilterService`. Pour un compte connecté qui n'est pas
super-admin, `selectedFleetId()` vaut null **dès la première lecture** (sans attendre d'effet), la
valeur restée est effacée (mémoire et stockage), et `set()` n'en pose plus. Les 35 fichiers qui
lisent ce service sont couverts d'un coup. Les gardes posées une à une (feuille de réservation,
Paramètres, Parc, Assistant IA) restent : elles sont désormais redondantes, mais toujours justes.
Déconnecté, rien ne bouge : une page encore ouverte ne recharge rien, et un super-admin qui se
reconnecte retrouve sa société.

**Vérifié.** Les nouveaux tests échouent sur le code d'avant (API : 4 × « Flotte hors périmètre » ;
web : 4 × « Expected 'aaaa…' to be null ») et passent après. Mutation de `reglerAvis` (société du
compte ignorée) : son test du 403 rougit. `ng build --configuration development` : aucune erreur.
`pnpm verify` (second passage) : tout vert — types 3/3, 153 migrations rejouées sur base vierge,
smoke 5/5, shared 423, web 954, api 4 746.

**Trouvé en vérifiant — un test qui laissait un compte fantôme.** Le premier `pnpm verify` a
échoué sur 1 test web sur 954, « Page Rapports — bascule de société », selon l'ordre aléatoire
de Jasmine. `auth-retour-onglet.spec` laissait, APRÈS son nettoyage, un jeton réécrit par le
renouvellement qu'il avait lancé (charge utile : `exp` seul). Le vrai `AuthService` des specs
suivants le décodait en compte connecté SANS rôle, pour qui le filtre société n'existe plus. Le
défaut a été reproduit à l'identique en posant ce jeton, puis corrigé des deux côtés : le test du
jeton expiré attend son renouvellement (`await auth.tryRefresh()`) ; les deux specs qui changent
de société (Rapports, `AiStatusService`) déclarent un compte super-admin au lieu d'hériter du
stockage, et celui des Rapports efface le filtre qu'il pose.

**Reste, hors de ce lot.** Les autres `resolveFleetId` stricts de l'API (sièges, liens de
réservation, optimiseur IA, alertes de vitesse, rapport hebdomadaire) répondent toujours 403 à un
`fleetId` étranger venant d'un non-super-admin. L'écran ne leur en envoie plus, mais un autre client
de l'API le pourrait.

### Relecture contradictoire de la piste 3 — un défaut important, quatorze mineurs, tous corrigés

Une relecture indépendante (lecture seule, sans rien exécuter) du code de la piste 3 : **aucun
bloquant**, **un défaut important**, quatorze mineurs. Chacun a été vérifié dans le code — et le
principal mesuré en base — avant d'être corrigé.

**L'important : « une proposition écartée ne revient pas » était faux.** L'heure d'un motif est une
MOYENNE sur les semaines d'apprentissage (`recurrence-detector` : `Math.round(sumStart / activeWeeks)`)
: elle dérive d'une nuit à l'autre. Le dédoublonnage de l'agent portait sur le début EXACT (unicité
société × véhicule × début). Une journée écartée (« une journée tombe ») se repeuplait donc le
lendemain, deux minutes plus tôt. Le même mécanisme doublait les propositions en attente — et deux
motifs du même véhicule se superposaient. **Mesuré chez cdef31 le 29/09 : 181 des 307 propositions
en attente en chevauchaient une autre du même véhicule** (19 véhicules, jusqu'à 5 le même jour pour
HD-686-QX le 30/09). Des paires se chevauchant : 48 venaient de nuits différentes vers la même
destination (la dérive), 54 de la même nuit vers des destinations différentes (deux motifs) — un
véhicule ne fait qu'un trajet à la fois, « Tout réserver » en aurait refusé la plupart.

→ `runForFleet` ne crée plus une occurrence qui **chevauche** une proposition connue du même véhicule,
quel que soit son statut (en attente, écartée, réservée), ni une créée plus tôt dans le même passage.
Les motifs arrivent triés par confiance : le plus sûr passe d'abord. Une lecture de plus par passage.
**Les propositions déjà en base ne sont pas touchées** (les 181 restent : leur ménage est une décision
du propriétaire).

**Les mineurs :**

| Relevé | Corrigé |
|---|---|
| un véhicule choisi qu'on ne gère pas : 403 **pendant la simulation d'arrière-plan** (onglet Réservations à l'écran) → toast rouge « Action impossible » | en simulation, lot vide qui le dit (`vehiculeNonGere`) ; 403 seulement à l'écriture ; la simulation d'arrière-plan est silencieuse (`X-Quiet-Errors`) et relancée en arrivant sur l'onglet si elle a échoué |
| choisir « Tous » puis le véhicule depuis l'onglet Propositions **levait en silence** la limite aux réservations refusées (T3) | la limite vaut sur le véhicule du pré-réglage, sans être levée par un choix de véhicule ; seul « Élargir » la lève |
| menu et onglet se contredisaient (« 307 » au menu, « 287 » dans l'onglet ; « 12 » à un gestionnaire dont la feuille ne trouvait rien) | le compte du menu est lu par la simulation (mêmes véhicules gérés, même fenêtre) ; inconnu = entrée active |
| `dejaTraitees` appelait « déjà traitée » une proposition prise par « Réserver » puis RENDUE, ou commencée | statut relu après l'écriture : `dejaTraitees` (écartée ailleurs, réservée, expirée) et `restees` (toujours en attente) |
| « Propositions de l'agent écartées en lot » en bleu « modification » dans les deux fils | gris, comme l'écart à l'unité (test ajouté : la cohérence entre écrans ne le voyait pas) |
| « Écarter » ignorait un « Tout réserver / Tout écarter » en cours dans l'Assistant IA | le bouton attend son bilan, et le dit |
| toast vert « 0 proposition écartée » | avertissement qui dit pourquoi |
| libellé du menu « Réorganiser des réservations » sous un titre de feuille « Réorganiser » | « Réorganiser » quand il y a des propositions, comme la feuille |
| incident sans fin : « du 29 sept. au 29 oct. », une fin que personne n'a saisie (renvoi des réservations aussi) | « à partir du …, sans date de fin » ; même fenêtre envoyée |
| identifiants mal formés → 500 de la base (entrée au centre d'alerte) | 400 |
| une requête de droits par véhicule, à chaque simulation | une seule (`vehiculesAutorises`, règle de `canOnVehicle`) |
| à 390 px, « Propositions de l'agent 307 » sur deux lignes | « Propositions » sur téléphone |
| la page ouvrait la feuille sur un véhicule dont on ne gère pas les réservations (droit global) | droit sur CE véhicule |
| simulation (une lecture) répondait 201 | 200, comme `reservations/reorganiser` |
| **aucune spec de composant** pour la feuille | 10 cas : ouverture sur l'onglet, lot EXACT renvoyé, compte-rendu conservé quand la page relit, IA coupée, pré-réglage, T3, silence d'arrière-plan, relance, garde de lot, avertissement, véhicule non géré |

**Écart qui existait déjà, laissé en l'état** : `apply` et `dismiss` à l'unité ne vérifient pas le droit
de gérer les réservations du véhicule (`apply` vérifie seulement l'accès), et `list()` n'est pas borné
aux véhicules accessibles. Le lot est désormais plus strict que le geste unitaire. À traiter à part.
**→ Traité le 30/09 (section suivante), en production à 03:21.**

**Fusion avec le correctif du filtre société (même soir).** Le correctif de la session parallèle
(`f4bf992a` + `0e8e8169`, ci-dessus) a été relu fichier par fichier, puis rejoué SUR la relecture : deux
conflits seulement — le début de `ecarterEnLot` (gardé : la société n'est validée, et même lue, que
pour un super-admin ; leur `resolveFleetId` ignore désormais `fleetId` pour les autres) et la fin de
la spec du runner (deux blocs ajoutés au même endroit : les deux gardés). Leurs tests et les miens
tiennent ensemble — voir « Vérifié » ci-dessous.

**Vérifié.** Relecture seule : `pnpm verify` vert (API 4 752, web 965, shared 423, 153 migrations,
smoke 5/5). Code fusionné : API 4 760/4 760, shared 423, migrations et smoke verts ; web **3 échecs**
au premier passage — la spec de la feuille ne tenait qu'après celle des utilitaires, qui enregistre la
locale `fr` (ordre aléatoire de Jasmine) : elle l'enregistre elle-même. Au passage, le faux
`AuthService` de leur spec Rapports n'avait pas `isAuthenticated` (4 TypeError du traqueur d'activité
par passage, sans échec) : complété. Puis web 970/970 et `ng build` sans erreur. Greffé sur
`origin/main` en quatre commits (`16950680`, `88a8a615`, `a125b143`, `ba07aa2a`).

**Recette démo (21:49 – 22:00, Transports Méridien) :**

| | Résultat |
|---|---|
| menu « ⋯ » | « Réorganiser » (IA active, des propositions) |
| 412 px | « Réservations 1 · Propositions 487 », une ligne chacun (40 px au lieu de 54) |
| incident SANS fin sur DS-941-JG | « 35 propositions de l'agent sur DS-941-JG pendant l'immobilisation » ; feuille : « Période de l'immobilisation : à partir du mar. 29 sept., 21:51 (30 jours) » — plus de fin inventée |
| passage de l'agent déclenché par l'incident (nouveau code) | 0 créée, 559 ignorées, 0 chevauchement neuf (l'horizon était couvert ; le passage de nuit fera le vrai volume) |
| « rien d'écarté », pour de vrai | 20 propositions écartées « ailleurs » par l'API après la simulation, puis « Écarter ces 20 » : avertissement « Aucune proposition écartée — 20 déjà traitées entre-temps (réservées ou écartées ailleurs) : laissées telles quelles », aucune ligne de journal |
| simulation | répond 200 (201 avant) |
| fil Agenda | « Propositions de l'agent écartées en lot » gris, comme l'écart à l'unité ; « Incident signalé » reste rouge |
| ménage | l'incident de test clôturé (« Marqué terminé ») |

**🚀 Déployé le 29/09 à 22:06 (Paris) — `ba07aa2a`, SANS `--force`.** `deploy.sh --attendre` : le
passage de 21:45 a fini normalement (`done`, 17 min), puis construction, migration, recréation ; API
saine en 10 s ; démo à jour. Personne en ligne dans la demi-heure. Artefacts vérifiés DANS les
conteneurs (règle de chevauchement, droits groupés, `resolveFleetId` fusionné, filtre société,
textes de la feuille). Le correctif du filtre société est donc **en production** avec la relecture.

**Recette prod (22:07 – 22:10), Chrome** — une première navigation a servi l'ancienne version (le
service worker, comme à chaque déploiement) ; la seconde a pris `main-6YJBPLQT.js` :

| | Résultat |
|---|---|
| cdef31, menu « ⋯ » | « Réorganiser — Aucune réservation à venir · 307 propositions de l'agent » |
| cdef31, feuille (simulations seules, **rien écarté**) | onglet « Propositions de l'agent 307 », bilan 307 sur 25 véhicules — le menu et l'onglet disent le même nombre ; nouveau texte « ne repropose pas un trajet qui chevauche… » |
| cdef31, base après | 307 en attente, 0 ligne `propositions_ecartees` |
| Client test (IA coupée) | « Réorganiser des réservations », pas d'onglet, aucune mention de l'agent, **aucune** requête de propositions |
| journaux de l'API depuis le déploiement | aucune erreur ; une dégradation sans rapport (HD-584-BF en TCP seul, déjà connue) |

## 2026-09-30, nuit — le droit par véhicule sur les propositions, et le ménage des doublons chez cdef31

### La commande

> « oui fais le 2 et nettoie les 181 doublons, et aussi fusionne etc les corrections de l'autre chat
> (Ignore stale SA fleet filter for non-…) ! »

Trois choses :

1. **« le 2 »** — l'écart relevé à la relecture de la piste 3 (voir plus haut, « Écart qui existait
   déjà ») : Réserver / Écarter une proposition à l'unité ne vérifiait pas le droit de gérer les
   réservations de SON véhicule, et la liste montrait les propositions de tout le parc.
2. **« nettoie les 181 doublons »** — les propositions en attente qui en chevauchent une autre du même
   véhicule, créées avant la règle de non-chevauchement du 29/09.
3. **« fusionne … les corrections de l'autre chat »** — déjà fait : le correctif du filtre société
   (`f4bf992a` + `0e8e8169`) a été fusionné et déployé le 29/09 à 22:06 (section précédente). La
   session parallèle n'a plus rien produit depuis 21:27 : rien d'autre à fusionner.

### Point 2 — réserver ou écarter une proposition, c'est gérer SON véhicule

| Avant | Maintenant |
|---|---|
| `apply` (Réserver) vérifiait l'accès au véhicule, pas le droit de gérer ses réservations | `exigerGestionDuVehicule` : la règle des réservations (`gereLesReservationsDe`, le scope le plus spécifique gagne) ; 403 qui nomme la plaque, rien n'est pris |
| `dismiss` (Écarter) ne regardait que la société | même périmètre véhicule (`assertVehicleAccess`) et même droit que Réserver |
| `list` (grille, badge de l'Assistant IA) montrait les propositions de tout le parc | bornée aux véhicules VISIBLES (`vehiculesAccessibles`, le périmètre de `scopedWhere`) ; le lot de Réorganiser aussi |
| boutons ✓ ✗, « Tout réserver / Tout écarter » sous un droit GLOBAL | contrôlés VÉHICULE par véhicule (`perms.can('reservations_manage', vehicleId)`), dans l'Assistant IA et le panneau du jour, boutons et méthodes |

Un gestionnaire qui ne peut que DEMANDER sur un groupe voyait les boutons sur tout le parc, et
réservait fermement ou écartait à l'unité ce que Réorganiser lui refusait en lot. Le lot était plus
strict que le geste unitaire : c'est fini.

### Le nettoyage des doublons

`POST agenda/agent/proposals/nettoyer-chevauchements` — **super-admin seulement** (geste de
maintenance), avec les garde-fous de Réorganiser : simulation par défaut ; à l'écriture, `ids` = le
lot montré, OBLIGATOIRE ; lot recalculé puis restreint à `ids` ; écriture sous condition « en
attente » ; statuts relus après coup ; UNE ligne de journal pour la société, qui dit pourquoi.

Dans chaque groupe de propositions en attente qui se chevauchent pour un véhicule, **la plus sûre
reste** (`propositionsEnChevauchement`) : validée par l'IA d'abord, puis la plus confiante, puis la
plus ancienne (vue le plus longtemps), puis la plus tôt. Une chaîne A–B–C (A chevauche B, B chevauche
C, pas A et C) garde A et C quand A est la plus sûre. **Les créneaux déjà pris** (réservation ferme,
immobilisation — la règle de `isVehicleFree`) sont gardés d'office : une proposition qui en chevauche
un ne se réserve pas, elle ne l'emporte jamais sur sa jumelle libre (relecture, ci-dessous).

### Relecture contradictoire — aucun bloquant, deux importants, tous traités

| Relevé | Traité |
|---|---|
| **Important** — le journal de Réorganiser disait « tous les véhicules » pour un gestionnaire limité à un groupe : `horsGestion` ne comptant plus les véhicules invisibles, il valait 0 | « tous les véhicules » seulement si l'auteur VOIT tout le parc et le gère en entier ; testé dans les deux sens |
| **Important** — le nettoyage ne lisait que les propositions en attente : il pouvait garder une proposition sous une réservation (« Réserver » → 409) et écarter sa jumelle libre, ou laisser le doublon d'une proposition déjà réservée | les réservations fermes (CONFIRMED / IN_PROGRESS) et les immobilisations (fin effective) sont lues et gardées d'office ; le lot compte à part `sousUnBloquant`. Mesuré : **0** créneau pris à venir chez cdef31 (effet nul aujourd'hui), 5 sur la démo dont 2 sous des propositions |
| une proposition d'un véhicule SUPPRIMÉ (pas de clé étrangère) ou passé dans une autre société restait listée, mais ne s'écartait plus (`dismiss` vérifie désormais le véhicule) | elle sort de la liste et expire seule ; « Réserver » refuse (400) un véhicule d'une autre société, même pour un super-admin (sinon réservation de l'ANCIENNE société). 0 cas en prod aujourd'hui |
| la garde « seul le lot montré est écrit » du nettoyage n'était prouvée par aucun test ; plafond, périmètre vide, pluriel non testés | 11 cas de plus |
| compteurs du dernier passage (toute la société) sous « Aucune proposition en attente » d'un gestionnaire limité | « … proposée(s) pour la société » |
| textes : `restees`, avertissement de `bilanDesMontrees`, « le même choix que l'agent » | corrigés (l'agent garde la proposition CONNUE ; le nettoyage, qui voit le groupe entier, la plus sûre) |

**Laissé en l'état, dit :** si `GET /api/users/me/access` échoue, un gestionnaire limité ne voit plus
les boutons de propositions (le contrôle par véhicule ne trouve aucune entrée) jusqu'au prochain retour
sur l'onglet, qui relit ses droits. Passager ; le serveur, lui, ne s'en sert pas.

**Vérifié.** `pnpm verify` vert deux fois (avant et après la relecture) : API **4 784/4 784**, web
970/970, shared 423, 153 migrations rejouées, smoke 5/5 ; `ng build` sans erreur. Les fixtures du
journal métier prenaient une proposition du client sur un véhicule rendu « f1 » : alignées (le véhicule
d'une proposition du client est dans la société du client). Greffé sur `origin/main` : `a3c99795`.

### Répétition sur la démo (03:14 – 03:20, Transports Méridien)

Images construites sur le VPS sans rien recréer, puis la démo SEULE recréée (saine, nouvelle version
`main-6UL5YPRV.js`, route présente dans le conteneur). Nettoyage joué par l'API depuis la session
super-admin, simulation puis écriture du lot montré :

| | Résultat |
|---|---|
| simulation | 486 en attente → **164 à écarter** (dont 2 sous une réservation ou une immobilisation), 25 véhicules, pas de plafond |
| écriture (`ids` = les 164 montrées) | 164 écartées, 0 déjà traitée, 0 restée |
| base après | **322 en attente, 0 chevauchement**, 0 proposition sous un créneau pris ; les 30 véhicules gardent au moins une proposition |
| journal | UNE ligne : « 164 propositions de l'agent écartées au nettoyage des doublons — 162 chevauchaient une proposition plus sûre du même véhicule, 2 une réservation ferme ou une immobilisation (25 véhicules ; 322 restent en attente). » — auteur « Équipe Tracky » dans l'activité de la société |
| écran (nouvelle version) | badge « Assistant IA 322 » |

**🚀 Déployé le 30/09 à 03:21 (Paris) — `a3c99795`, SANS `--force`,** sur l'ordre du propriétaire
(« ok continue, déploie et nettoie cdef31 » ; seul en ligne). `deploy.sh --attendre` : le passage de
02:45 avait fini à 02:48 ; construction, migration, recréation ; API saine en 15 s, 0 redémarrage ; démo
à jour. Artefacts vérifiés DANS les conteneurs (`creneauxPris`, `exigerGestionDuVehicule`, route
`nettoyer-chevauchements`, `vehiculesAccessibles`, `main-6UL5YPRV.js`). Aucune erreur API depuis.

### Le ménage chez cdef31 (03:22 – 03:24) — à la demande du propriétaire

Depuis la session super-admin de la prod, par l'API — simulation, puis écriture des SEULES propositions
montrées :

| | Résultat |
|---|---|
| simulation | 338 en attente → **106 à écarter**, 19 véhicules (GS-187-NY et GT-493-KS : 15 chacun), **0** sous un créneau pris, pas de plafond — le chiffre de la mesure à blanc du 29/09 |
| écriture (`ids` = les 106 montrées) | 106 écartées, 0 déjà traitée, 0 restée |
| base après | **232 en attente, 0 chevauchement** ; les 25 véhicules gardent au moins une proposition ; écartées 412 → 518 |
| HD-686-QX (5 propositions empilées le 30/09) | une par jour : le 30/09, 14:07 → 16:30 Launaguet, 90 % — la plus sûre |
| journal de la société | UNE ligne, 03:23, « Équipe Tracky » : « 106 propositions de l'agent écartées au nettoyage des doublons — elles chevauchaient une proposition plus sûre du même véhicule (19 véhicules ; 232 restent en attente). » |
| écran (nouvelle version) | badge « Assistant IA 232 » ; 0 chevauchement parmi les 232 lues par l'écran |
| courriels | **0** depuis 03:10 — une proposition n'en envoie jamais |

L'agent ne les recréera pas : il ne propose plus une occurrence qui chevauche une proposition CONNUE du
même véhicule, quel que soit son statut — écartée comprise (relecture du 29/09).

## 2026-09-30, matin — le dernier tour : voir avant d'appliquer, un vrai bouton à glisser, les modales de l'application, le bon logo

### La commande

> « continue de tester l'agenda sur chrome, c'est bon c'est le dernier tour […] ouvre réorganisations et
> tests sur la flotte CDEF (il faut pouvoir avoir une vue de la réorganisation sans appliquer, en gros on
> affiche ce que ça change et le temps gagné, mais uniquement si user valide avec modal de confirmation
> en mode slide comme pour le coupe moteur), sans envoyer de mails au CDEF, et ensuite dans le QR code le
> logo de Tracky n'est pas le bon ! Pour la modal de confirmation d'une annulation de réservation doit
> être comme les autres de l'application ! PS : je pense qu'on peut mieux faire pour le bouton glissé,
> actuellement une ligne avec un point, je veux un vrai bouton avec une animation montrant qu'il faut
> glisser le doigt […] »

### Ce qui a changé

| Demande | Fait |
|---|---|
| Voir ce que la réorganisation change, sans appliquer | sous le bilan de la simulation, « **Ce que ça change** » : ce qui part et où (réaffecter : « N réservations quittent X : elles partent sur Y / sur le premier véhicule libre et conforme »), annuler (« une demande en attente est refusée »), décaler, les refus, le plafond, **qui est prévenu** (le serveur le compte désormais : `courriels` dans la simulation, un par demande du lien public, courriel OU SMS) |
| Le temps gagné | une ESTIMATION qui dit sa base : 2 min par réservation reprise à la main (l'ouvrir, trouver un véhicule libre, l'enregistrer), 1 min par décalage, 30 s par annulation, 10 s par proposition écartée une à une |
| N'appliquer qu'après une confirmation « slide » | les boutons de la feuille n'écrivent plus : ils ouvrent la confirmation à GLISSER (celle de la coupe moteur), qui redit le lot, les messages et le temps gagné. Seule la lecture MONTRÉE part : remplacée ou relancée pendant que la modale est ouverte, rien n'est écrit, et on le dit |
| Un vrai bouton à glisser | piste arrondie, pastille à chevrons qui se remplit derrière elle, libellé à reflet ; au repos, un DOIGT se pose sur la pastille et glisse le long de la piste. Le range natif reste dessous, invisible : doigt, souris, clavier et garde T50 |
| La confirmation d'annulation comme les autres | annuler une réservation / refuser une demande / supprimer un évènement : la modale de l'application (danger, irréversible, créneau et plaque rappelés, « Le demandeur est prévenu (courriel ou SMS) » ou « Personne n'est prévenu »), plus la boîte native du navigateur |
| Le logo du QR | le logo officiel (`vizyo-tracky-icon-green`, avec la goutte dans le creux du V) dans l'en-tête et au centre de la carte, embarqué pour s'afficher aussi dans la fenêtre d'impression. L'écran de chargement animé garde l'ancien tracé (il faut une version vectorielle du bon logo pour son animation) |

### Relecture contradictoire — 1 bloquant, 2 importants, des mineurs, tous traités

| Relevé | Traité |
|---|---|
| **Bloquant** — annuler une demande EN ATTENTE, c'est la refuser, et le refus part toujours (`annoncerRefus` n'a ni borne de date ni de consignation) : la modale disait « aucun courriel » pour une vieille demande publique. Et le notifier envoie un **SMS facturé** quand le contact est un numéro | règle corrigée (en attente + publique + contact = prévenu, toujours) et testée ; « courriel ou SMS » partout ; la modale dit « Refuser cette demande ? » (« Retirer votre demande ? » pour la sienne) |
| **Important** — l'invitation décalait la pastille de 46 px hors du pouce natif : un doigt posé dessus tombait sur la piste, le curseur sautait, la garde T50 refusait le geste sans un mot | c'est le doigt qui glisse ; la pastille ne fait qu'un à-coup de 8 px ; tout s'arrête sous la souris ou le focus ; départ admis porté à 25 % (pouce de 60 px, téléphone étroit) ; un geste refusé le dit (« Partez du bouton rond… ») |
| **Important** — au clavier, le navigateur émet `change` à chaque pas : pris pour un relâché, il remettait le curseur à zéro — ni la coupe moteur (depuis le 13/09) ni Réorganiser ne se confirmaient au clavier | `change` n'est un relâché qu'après un appui du pointeur ; au clavier, la flèche maintenue confirme en arrivant au bout (test au plus près du navigateur : `input` + `change` à chaque pas) |
| Échap fermait la modale ET la feuille ; le focus restait dans la feuille ; un double-clic refermait la modale | Échap capturé par la modale seule ; focus sur « Annuler »/« Revenir » à l'ouverture ; clic sur le voile ignoré 400 ms |
| « X est libéré » faux s'il reste des réservations (refus, filtre d'origine, limite aux refusées) ; plafond non dit ; « sur N véhicules » surestimé quand plafonné | « N réservations quittent X » ; le plafond est dit ; le nombre de véhicules n'est plus dit quand le lot est plafonné |
| Une erreur à l'écriture laissait la lecture applicable : un second glissement pouvait rejouer le lot (en décalage, double décalage) | après toute erreur, la lecture n'est plus applicable et l'état est relu |
| Une confirmation restée ouverte réapparaissait, périmée, à la réouverture | vidée à la fermeture de la feuille |
| libellé du bouton rogné des deux côtés sur un téléphone | libellé court, coupé proprement, centré « safe » |

**Laissé, dit :** si un collègue valide une demande pendant que la confirmation est ouverte, le compte de
messages annoncé peut être dépassé (le lot est vérifié par identifiants, pas par statut). Aucun cas
possible chez cdef31 aujourd'hui (aucune réservation publique).

**Vérifié.** `pnpm verify` vert trois fois dans la matinée ; le dernier, après la relecture : API
**4 785/4 785**, web **986/986**, shared 423, 153 migrations rejouées, smoke 5/5 ; `ng build` sans erreur ;
`verif:confirmations` et `verif:couleurs-kit` sans nouvelle entrée (le seul `#fff` ajouté est devenu un jeton).
Trois commits sur `origin/main` : `67b59383` (le dernier tour), `6f805a14` (la relecture), `f77754d0` (le défaut trouvé en recette, ci-dessous).

### Recette sur la démo (08:15 – 09:00, Transports Méridien, Chrome)

| | Résultat |
|---|---|
| QR de réservation | logo officiel dans l'en-tête et au centre |
| Réorganiser, propositions (VE-678-QY) | « Ce que ça change » + temps gagné ; la confirmation redit tout ; **glissé à la souris** : 2 écartées, une ligne de journal |
| Réorganiser, réservations (GR-903-GS, réaffecter) | « 1 réservation quitte GR-903-GS… », « Personne n'est prévenu » (compte du serveur) ; confirmation ouverte puis « Revenir » |
| **Au clavier** (FQ-639-GV) | Maj+Tab jusqu'au curseur, flèche droite maintenue : confirmé, 4 écartées — impossible avant la relecture |
| Défaut trouvé : la confirmation ROUVERTE montrait la pastille au bout | la flèche maintenue répétait après la confirmation (curseur à 100, gardé jusqu'à la réouverture) → la modale n'écoute plus le curseur une fois confirmée et repart de zéro à chaque ouverture (`f77754d0`, test) |
| Supprimer un évènement | la modale de l'application (« Supprimer cet évènement ? », créneau sur plusieurs jours rappelé, Irréversible) ; les deux maintenances de test d'hier supprimées par elle ; Échap ne ferme que la modale |
| Annuler une réservation | la demande publique « → Albi » (confirmée, finie) : « Personne n'est prévenu », « Garder » ; une réservation interne passée annulée jusqu'au bout (« Réservation annulée ») |
| Coupe moteur (démo, rien n'atteint un véhicule) | le nouveau bouton, rouge, « Glissez pour couper le moteur » ; focus sur Annuler ; Échap referme |

**🚀 Déployé le 30/09 à 09:05 (Paris) — `f77754d0`, SANS `--force`** (sur l'ordre du propriétaire ; fenêtre du
matin passée ; passage de 08:45 fini à 08:49). Un administrateur de cdef31 avait un onglet ouvert, en
arrière-plan, sans un clic depuis 08:55 : redémarrage de 15 s sans effet pour lui. API saine en 15 s,
0 redémarrage ; démo à jour. Artefacts vérifiés DANS les conteneurs (`main-B53JJQY7.js`, verrou de
confirmation, compte des messages). Aucune erreur API depuis.

### Recette sur CDEF (09:10 – 09:20) — en lecture seule, rien d'appliqué

| | Résultat |
|---|---|
| QR de réservation | logo officiel (société « cdef31 », domaine app-tracky) |
| Réorganiser, propositions | 213 dans les 30 jours, 25 véhicules : « Ce que ça change », « Personne n'est prévenu », « Temps gagné : ≈ 36 min » ; confirmation ouverte (curseur à 0, focus sur « Revenir », doigt animé), puis **Revenir** |
| Réorganiser, réservations | une réservation EN COURS sur GR-294-VW (posée par le client ce matin) : Annuler/Décaler l'expliquent ; Réaffecter en simulation : « 1 réservation quitte GR-294-VW… », « Personne n'est prévenu » ; feuille fermée |
| Base après | depuis 09:00 chez cdef31 : **0 geste écrit, 0 ligne de journal, 0 proposition modifiée ; 0 message envoyé** (tous clients confondus) |

---

## 2026-09-30, midi — le garde-fou d'envoi, et la démo prête à filmer

### La commande

> « fais le garde-fou d'envoi de courriels, dis-moi si je peux commencer à faire un tuto de l'agenda
> pour le CDEF mais aussi pour mon site de vente (LP) […] dis-moi simplement oui ou non, ce qui
> manque, et ensuite oui ! »

### Le trou

Le 24/09, une demande de RECETTE déposée par le lien public du vrai client a envoyé l'avis « demande
à valider » à cinq personnes de cdef31 : rien, dans le code, ne distinguait un essai d'une vraie
demande. Depuis, toute recette se faisait sur « Client test » ou sur la démo — et filmer un tutoriel
chez un vrai client restait impossible sans le prévenir de chaque geste.

### Ce qui a été fait

| | |
|---|---|
| **Mode recette d'une société** (`Fleet.envoisSuspendusJusqua`) | un super-admin le pose depuis l'agenda (menu ⋯ → « Mode recette (2 h) ») : jusqu'à l'heure dite, les avis de réservation, de demande publique, de mission et de dépôt de CETTE société sont **retenus** — courriel, SMS au demandeur (facturé) et push « demande à valider » aux téléphones de l'équipe. Il **expire seul** (1 à 24 h) : un oubli ne coupe jamais les avis pour de bon. « Rétablir les avis » le lève tout de suite |
| Ce qui n'est JAMAIS retenu | courriels de compte (invitation, mot de passe, appareil, 2FA), alertes, rapport du lundi — liste fermée, testée (`MODELES_RETENUS_EN_RECETTE`) |
| Le bandeau | tous les utilisateurs de la société le voient dans l'agenda : « Mode recette jusqu'à 14:40 (tests en cours) — les avis de réservation et de mission ne partent pas : ni courriel, ni SMS, ni notification ». Le client sait pourquoi rien n'arrive |
| La trace | un courriel retenu s'écrit au centre des e-mails avec le statut **« Retenu »** (`EmailStatus.BLOCKED`, filtre « Retenus ») et au journal système (`email_retenu`, `sms_retenu` numéro masqué, `push_retenu`) ; poser/lever le mode écrit UNE ligne au journal de la société (« Avis retenus (mode recette) » / « Avis rétablis », auteur, heure de fin). Les volumes et taux d'envoi ne comptent pas les retenus |
| Liste blanche (`EMAIL_LISTE_BLANCHE`) | pour un poste de dev muni d'une vraie clé Resend : seuls ces destinataires reçoivent un courriel. **Vide en prod ET sur la démo** — la démo invite des prospects à leurs vraies adresses, une liste blanche retiendrait leurs invitations |
| Panne de lecture | le garde-fou ne lève jamais : base illisible → l'avis PART (il ne devient pas, lui, une coupure des avis) |

**Vérifié.** `pnpm verify` vert : API **4 821/4 821** (276 suites), web **987/987**, shared 423, 154 migrations
rejouées (le schéma rejoué = `schema.prisma`), smoke 5/5 ; `ng build` sans erreur ; `verif:*` sans nouvelle entrée.
Le premier passage avait trouvé UN défaut : `demo/import/allowlist.spec` exige une décision pour chaque colonne
neuve — `envoisSuspendusJusqua` est IMPOSÉE à null dans l'import de la démo (le mode recette d'une société réelle
ne suit jamais dans la démo, qui a le sien). Commit `813e2bad` sur `origin/main`.

**🚀 Déployé le 30/09 à 14:17 (Paris) — `813e2bad`, SANS `--force`**, par un guetteur côté serveur (images
pré-construites ; `deploy.sh` lancé au premier moment calme : aucun passage, aucun geste client depuis
10 min, minute ≤ 38). Le passage de 12:45 a fini à 13:40 (trop tard pour l'heure) ; celui de 13:45 à 14:11 →
déploiement à 14:11, API saine à 14:17 en 15 s, 0 redémarrage, démo à jour. Vérifié DANS les conteneurs :
`dist/email/garde-fou-envois.service.js`, « Mode recette » dans le bundle de l'agenda, « Retenus » dans celui
des e-mails ; colonne et valeur `BLOCKED` en base (prod et démo) ; 0 erreur API depuis.

### Recette en prod (14:25 – 14:31) — Client test, dans Chrome, puis en base

| | Résultat |
|---|---|
| Garde-fou COMPILÉ lancé dans le conteneur contre la vraie base (lecture seule), AVANT | tout part ; liste blanche vide en prod |
| Menu ⋯ → « Mode recette (2 h) » | posé jusqu'à 16:25 ; bandeau violet ; une ligne « Avis retenus (mode recette) » au journal, signée « Équipe Tracky » ; l'entrée devient « Rétablir les avis — avis retenus jusqu'à 16:25 » |
| Garde-fou compilé, PENDANT | « demande à valider », SMS au demandeur, push à l'équipe : **retenus** ; invitation, alerte : **partent** ; cdef31 (témoin) : rien de retenu |
| Une demande par le lien public de Client test (données factices, `recette-garde-fou@demo.vizyoagency.com`) | la demande arrive (TEST-006-XX, en attente) ; accusé de réception au demandeur, « demande à valider » au valideur : **Retenu** (`BLOCKED`, aucun identifiant Resend) ; push : retenu ; **0 SMS, 0 push, 0 courriel parti** |
| Centre des e-mails → « Retenus » | les deux lignes, pastille violette « Retenu », « ID Resend — » ; les volumes (141 envoyés sur 30 j) ne les comptent pas |
| Refuser la demande (feuille « À valider ») | le refus au demandeur : **Retenu** aussi |
| « Rétablir les avis » (bandeau) | bandeau retiré, toast « Avis rétablis » ; base à null ; ligne « Avis rétablis » au journal ; garde-fou compilé : tout repart |
| Activité de Client test, fil « Agenda » | toute la séance, dans l'ordre : avis retenus, demande reçue, demande refusée, avis rétablis |

**Défaut trouvé pendant cette recette** : dans la feuille « À valider », « Refuser » écrivait d'UN clic —
et un refus de demande publique prévient le demandeur (courriel ou SMS, toujours). Le panneau du jour
demandait déjà « Refuser cette demande ? » ; la file ne demandait rien (depuis sa création, `e5501a13`).
→ La même modale de l'application : « Refuser cette demande ? » (« Refuser les N véhicules de cette
demande ? », « Retirer votre demande ? » pour la sienne), le demandeur, les plaques et le créneau, et qui
est prévenu ; focus sur « Garder ». Spec neuve `reservation-sheet.refus.spec.ts` (rien ne part avant la
confirmation, « Garder » n'écrit rien, un refus par véhicule, public / interne / la sienne). Web 992/992.

### La démo prête à filmer

Les 8 évènements de test laissés sur la démo par les recettes (« Vidange + filtres (recette — hier) »,
« Pare-brise fissuré (recette) », « Recette refonte — 8 jours », « Demande publique →
CarcassonneCarcassonne » ×2…) ont été retirés, après sauvegarde JSON des lignes. Restent 7 évènements
réalistes (« Ramassage secteur nord », « Demande publique → Albi », « Trajet récurrent »…). Le journal
de la démo garde la trace des gestes de recette (on n'efface pas un journal).

---

## Ce qu'il ne faut pas défaire

- **L'agent ne réserve plus fermement.** Le réglage `autonomy` est passé à `suggest` en base le
  27/09 pour que les deux disent la même chose, mais ce n'est pas lui qui décide :
  c'est `AUTONOMIE_FERME_AUTORISEE` qui décide, à un seul endroit. Mesure qui l'a tranché : sur 321
  réservations automatiques passées, **le véhicule avait réellement roulé sur le créneau 57 fois sur
  100, et pas du tout ce jour-là 23 fois sur 100** ; l'heure dérape de 47 min en médiane.
- **L'exclusion des véhicules hors service et dormants est en UN seul endroit**
  (`computeSuggestions`), ce qui couvre les 4 surfaces d'un coup : disponibilité, suggestion, lien
  public, attribution automatique. Éprouvée en production : un véhicule accidenté, **seul candidat
  restant**, a été écarté au profit d'un autre.
- **Le lien public classe au lieu d'exclure** (rang 1 : aucun engagement · rang 2 : pris ailleurs ·
  rang 3 : déplace une proposition, signalée au valideur). Avant, un parc pré-rempli faisait
  **refuser** une demande humaine.
- **Le refus du dernier destinataire**, et celui de fermer les deux canaux d'alerte. Deux gardes de
  la même famille : on ne laisse pas l'application devenir muette par un réglage.
- **Un geste d'agenda écrit sa ligne au journal** (`RESERVATION` / `AGENDA`) avec la société de la
  RESSOURCE, l'auteur et l'heure de Paris ; le client la lit dans son onglet « Agenda », un
  super-admin y apparaît « Équipe Tracky ». Un geste neuf qui n'écrit pas sa ligne est invisible au
  client — c'était le cas de la création et de la modification jusqu'au 29/09.
- **Un conducteur par véhicule** : « Places min. » compte le conducteur ; répartir un groupe sur N
  véhicules coûte N conducteurs (9 + 4 ne couvre pas 13). Serveur et feuille comptent pareil.
- **« IA coupée » = le choix du client** (`Fleet.aiEnabled`, `fleetEnabled` dans `/api/ai/status`,
  `AiStatusService.societeActive()`), jamais `enabled` seul (qui exige aussi une clé au serveur) ;
  IA coupée, l'agenda ne montre plus rien de l'agent ni de l'Assistant IA, et Paramètres masque
  ses réglages. Un bouton qui appelle l'IA reste gardé par `can(feature)`.
- **Un geste de masse n'écrit que le lot montré.** Réorganiser renvoie les identifiants de sa
  simulation (`lotIds` → `ids`) : obligatoires pour écarter des propositions, liste blanche pour les
  réservations (avec `attendu`). Sans eux, un passage de l'agent ou une demande du lien public arrivés
  entre la simulation et le clic partiraient sans avoir été vus. Et un lot de propositions écrit UNE
  ligne de journal, pas une par proposition.
- **Le filtre société n'existe que pour un super-admin.** Pour tout autre compte connecté,
  `FleetFilterService.selectedFleetId()` vaut null et le stockage est effacé ; l'agent et ses
  réglages ignorent `fleetId` hors super-admin. Le 403 ne reste que là où la société vient d'une
  donnée (le compte visé par `reglerAvis`).
- **Une proposition ne se superpose pas à une autre du même véhicule** (`runForFleet`, relecture du
  29/09). Le dédoublonnage par début EXACT ne suffit pas : l'heure d'un motif est une moyenne qui
  dérive d'une nuit à l'autre. Retirer cette règle ramène les journées écartées le lendemain, et les
  181 chevauchements relevés chez cdef31.
- **Réserver ou écarter une proposition = GÉRER les réservations de SON véhicule** (serveur :
  `exigerGestionDuVehicule` ; écran : `perms.can('reservations_manage', vehicleId)`), et la liste des
  propositions est bornée aux véhicules VISIBLES. Revenir à un droit global rend le geste unitaire plus
  large que le lot de Réorganiser — un gestionnaire limité réservait fermement hors de son groupe.
- **Le nettoyage des chevauchements garde d'office les créneaux déjà pris** (réservations fermes,
  immobilisations, fin effective). Sans eux, il garde une proposition non réservable et écarte sa
  jumelle libre. Et il n'écrit que le lot montré (`ids`), comme Réorganiser.
- **Un geste de masse se confirme par un GLISSEMENT, et la confirmation dit ce qui part** (Réorganiser
  comme la coupe moteur) : ce que ça change, qui est prévenu (courriel OU SMS : le notifier envoie un SMS
  facturé quand le contact est un numéro), le temps gagné (une estimation qui dit sa base). Seule la
  lecture MONTRÉE part : remplacée ou relancée pendant que la modale est ouverte, rien n'est écrit.
- **Le curseur à glisser** : `change` n'est un relâché qu'après un appui du pointeur (le navigateur en
  émet un à CHAQUE pas clavier — sinon le clavier ne confirme jamais) ; la pastille reste sous le pouce
  natif (l'invitation ne la pousse que de 8 px, c'est le doigt qui glisse) ; la modale n'écoute plus le
  curseur une fois confirmée et repart de zéro à chaque ouverture.
- **Plus de `confirm()` natif dans l'agenda** : la modale de l'application, qui dit si le demandeur est
  prévenu. Un refus de demande publique prévient TOUJOURS (`annoncerRefus` n'a aucune borne). Et
  **refuser se confirme PARTOUT** — panneau du jour comme file « À valider » (30/09) : un refus d'un
  clic est un courriel ou un SMS parti chez quelqu'un.
- **Un avis de réservation ou de mission passe par le garde-fou d'envoi** (`GardeFouEnvoisService`) :
  le courriel par `EmailService.send` (un seul chemin d'envoi), le SMS au demandeur et le push
  « demande à valider » par le notifier. Un nouveau canal d'avis qui ne lui pose pas la question
  sonne chez le client pendant une séance de tests. Et le mode recette EXPIRE seul : jamais de
  coupure sans échéance.

# Suivi de la revue Agenda — ce qui a été fait, et ce que la recette a trouvé en plus

**Date :** 2026-09-24 · **Échéance :** mise en service chez cdef31 le **lundi 2026-09-28**
**Point de départ :** [`AUDIT-CRITIQUE-AGENDA-2026-09-22.md`](./AUDIT-CRITIQUE-AGENDA-2026-09-22.md)
(audit daté — il reste le compte rendu de ce qui était vrai le 22/09 ; ce document-ci dit ce qui a
changé depuis).

---

## Verdict au 24/09

**Les trois bloquants sont levés. Le module est en production et éprouvé à l'écran.**

Mais la leçon du 22/09 se répète, en plus fort : **quatre défauts supplémentaires sont sortis en se
SERVANT de l'écran, aucun en le lisant.** Deux campagnes d'audit statique sur ce module ne les
avaient pas vus — dont le plus dangereux de toute la revue (voir R-4).

| Mesure (prod, 24/09) | 22/09 | 24/09 |
|---|---|---|
| Comptes cdef31 qui ne verront rien dans l'agenda | **5 sur 6** | **0** |
| Travaux d'agent local bloqués | **7** | **0** (file vide) |
| Réservations **fermes** à venir posées par la machine | **119** | **0** |
| Courriels d'exploitation (14 j) | **81** | **0 depuis la coupure** |
| Destinataires de l'avis « demande à valider » chez cdef31 | *tous les valideurs* | **`standard@` seul** |

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
| ⚠️ | **Le tactile réel n'a pas pu être éprouvé** | La fenêtre Chrome refuse tout redimensionnement. C'est la seule case qu'on ne peut pas cocher depuis ici — et c'est le terrain où R-3 s'est produit. **À faire sur un vrai téléphone.** |
| ⚠️ | Joignabilité des 3 managers cdef31 | Décision prise de ne rien leur envoyer. `standard@`, lui, est confirmé joignable. |
| 🟡 | Rattrapage des tracés | **9 871 restants, 364/jour, ≈ 27 jours.** Voir ci-dessous. |
| 🟡 | Compteur « EN RETARD » ≠ liste | Le compteur ne compte que les `PLANNED`, la liste inclut `OPEN`/`IN_PROGRESS`. Visible, pas grave. |
| 🟡 | P1-4, P1-5, P2-1 de l'audit du 22/09 | Inchangés. |
| 🧹 | 11 objets de recette sur « Client test » | Marqués `seed-agenda-2026-09-23`, à supprimer. |

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

## Ce qu'il ne faut pas défaire

- **L'agent ne réserve plus fermement.** Le réglage `autonomy` reste en base et ne suffit plus :
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

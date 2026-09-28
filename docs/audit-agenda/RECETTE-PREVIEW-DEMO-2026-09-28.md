# Recette de l'agenda sur la démo — avant le déploiement du 28/09

**Où :** <https://demo-tracky.vizyoagency.com> · **Quoi :** le code de `main` (`cd472914`) que la
production **n'a pas encore** — les six derniers constats de l'audit, T83 et le rythme de l'arriéré ·
**Pourquoi là :** une pile séparée sur le même VPS, la vraie flotte pseudonymisée (« Transports
Méridien », 37 véhicules, 16 884 trajets du 15/04 au 27/09), **aucun port boîtier, aucune clé
SMS / push / Stripe** — rien de ce qu'on y fait ne peut atteindre un client.

> **Verdict du 28/09, 07 h – 09 h** : sections 0 à 4 et 7 exercées dans Chrome, requêtes réseau
> lues à chaque geste. Tout ce qui est livré marche ; la recette a trouvé **neuf défauts** (deux
> sérieux : « posées par l'agent » englobait les demandes publiques ; la grille s'arrêtait à 200
> propositions), **tous corrigés le matin même** et rejoués sur la démo avant le déploiement.
> Le détail : `SUIVI-REVUE-AGENDA-2026-09-24.md`, section du 28/09.
>
> Légende : `[x]` vu à l'écran et dans le réseau · `[~]` partiellement · `[ ]` non exercé (pourquoi
> en marge) · **F-n** = constat, numéroté dans le suivi de revue.

> ⚠️ **Ce que la démo ne contient pas, par construction** : `vehicle_events`, propositions, réglages
> d'agent et liens publics sont **exclus de l'import** (décision du 07/09 : ce sont les tables qui
> portent noms, téléphones et textes libres des demandeurs). L'agenda part **vide**. On y crée nos
> objets, et on fait tourner l'agent sur les vrais trajets pour obtenir de vraies propositions.
> C'est la seule façon d'avoir des données réelles sans sortir les données personnelles du client
> de la production.

> ⚠️ **Les courriels PARTENT depuis la démo** (clé Resend partagée avec la prod), vers les adresses
> `@demo.vizyoagency.com` et les tiennes. C'est voulu : ça permet d'éprouver la chaîne complète sans
> toucher une boîte cliente. **Ne jamais saisir une adresse `@cdef31.org` dans un formulaire de la
> démo.**

## 0. Se connecter

Compte : **`admin@vizyoagency.com`** (super-admin, mot de passe habituel — Vizyo Auth) ou
`demo-gestionnaire@demo.vizyoagency.com` (mot de passe : `DEMO_ACCOUNTS_PASSWORD` de `.env.demo`
sur le VPS). Bandeau société → **Transports Méridien**.

- [x] La page `/agenda` s'ouvre, trois compteurs à **0 / 0 / 0**, liste « À venir & en retard » vide, grille vide.

## 1. Les compteurs et la liste disent la même chose *(compteur ≠ liste, P2-4)*

Créer depuis « Évènement » :
- [x] une **maintenance** PLANNED datée **d'hier** → compteur « En retard » = 1, la ligne apparaît en rouge dans la liste ;
- [x] une **maintenance** PLANNED dans **10 jours** → « À venir (30j) » = 1, ligne dans la liste ;
- [x] un **incident** (OPEN) daté d'aujourd'hui → « Incidents ouverts » = 1 — **F1** : il passait aussi « EN RETARD » dans la seconde (règle du 27/09 : « OPEN à échéance passée »). Corrigé : un OPEN n'est **jamais** en retard, seul un PLANNED a une échéance ;
- [x] passer la maintenance d'hier « En cours » depuis le panneau du jour → elle **sort** de la liste et du compteur « En retard » (elle est en cours, ni à venir ni en retard) ;
- [x] filtrer par **véhicule** dans la barre → les trois compteurs **suivent** le véhicule choisi (`GET /agenda/summary?…&vehicleId=` à chaque changement) ; retirer le filtre → ils reviennent ;
- [x] filtrer par **type** « Incident » → la liste ne montre que l'incident, **les compteurs ne changent pas** (voulu : chacun est typé par nature).
- **F2** (style) : les badges ● / ~ de la cellule recouvraient la première pilule (« Vidange + filtres (recette — J… » sous « ● 13 / ~18 »). Corrigé : badges en ligne. **F3** (mineur, à reprendre) : ces badges ignorent les filtres véhicule / groupe.

## 2. Le glisser-déposer *(livré le 23-24/09, validé au doigt le 27/09)*

- [x] souris : glisser la maintenance de dans 10 jours sur un autre jour → `PATCH` 200, heure et durée conservées, toast de confirmation ;
- [x] tenter de la glisser **dans le passé** → refusée, message ;
- [x] `/agenda` sur le téléphone : appui long sur la pastille → déplacement au doigt *(validé par le propriétaire le 27/09)*.

## 3. Les réservations, de bout en bout *(P0-1, R-1, R-2)*

- [x] **Réserver** depuis la barre : créneau demain 9 h–12 h, motif « Ramassage secteur nord », véhicule libre → la carte du jour affiche **le motif** (R-1) — **F5** : deux fois (titre + ligne de détail). Corrigé ;
- [x] Paramètres de l'agenda → **Liens publics** → créer un lien → **QR réservation** dans la barre → la carte imprimable montre le domaine **`demo-tracky.vizyoagency.com`** (R-6) ;
- [x] ouvrir le lien public → déposer une demande (« Client test », 11 places → **deux** véhicules de 9 pré-retenus, même `bookingRef`) → `reservation_requested` au demandeur, `reservation_request_pending` aux deux valideurs cochés, `public_booking_submitted` dans l'activité — **F13** (à reprendre) : la file « À valider » montre les deux véhicules comme deux demandes indépendantes ;
- [x] Paramètres de l'agenda → **Destinataires de l'avis** : couper le **dernier** est **refusé** (`PUT` 400) avec le motif — **F14** : la ligne entière était un `<label>`, un clic sur l'adresse basculait l'avis et le `PUT` partait aussitôt. Corrigé : seul l'interrupteur agit ;
- [x] bouton **Demandes** → valider → `reservation_validee` + courriel `reservation_confirmed` au demandeur (R-2) — **F15** : la file était appelée sans le filtre société du bandeau. Corrigé. **F17** (convention du dépôt) : `actor: 'utilisateur'`, le nom en `meta` ;
- [x] déposer une seconde demande, la **refuser** → ligne `reservation_refusee` — **F16** (à reprendre) : le demandeur n'est pas prévenu d'un refus ;
- [ ] mettre un véhicule **hors service** (fiche véhicule) puis déposer une demande sur un créneau où il est le seul libre → il est **écarté** *— non exercé ce matin : même code que la prod (`computeSuggestions`), éprouvé en prod le 24/09.*

## 4. L'agent, sur les vrais trajets *(P0-3, 3a, 3b)*

- [x] Paramètres de l'agenda → **activer l'agent**, heure nocturne quelconque → **Lancer l'analyse** (`PUT agent-settings` 200, `PATCH fleet-metier` 200) — **F6** : le sélecteur **Métier** affichait « Transport d'enfants » pour une flotte GENERIC (`[value]` posé avant les options du `@for`). Corrigé (`[selected]`). **F7** : deux ascenseurs emboîtés dans la feuille, la molette n'atteignait pas le bas. Corrigé ;
- [x] le bilan du passage : « **453 proposition(s) préparée(s)** — l'avis de l'IA arrivera au prochain passage du poste », **0 réservation ferme** ;
- [x] des **pastilles en pointillé** apparaissent sur la grille ; le panneau du jour porte « Proposé par l'agent » avec **Réserver / Écarter** — **F19** 🔴 : seules les **200** premières propositions étaient rendues (`take: 200`), plus rien après le 3 octobre, badge « 200 ». Corrigé : 1 000 + avertissement journalisé ;
- [x] **Réserver** une proposition → `POST …/apply` 201, elle devient ferme, disparaît des pointillés (39 → 38) ; **Écarter** une autre → `POST …/dismiss` 201, elle s'en va ;
- [x] onglet **Propositions IA** : la liste ne montre que des départs **à venir** (premier : lundi 08:39, il était 07:26) ;
- [x] **Réorganiser** → 30 jours → posées par l'agent → **simulation** juste, puis **appliquer** → `POST /reservations/reorganiser` 200 × 2, **les deux annulations ont disparu de la grille** (R-5) — **F18** 🔴 : le lot contenait **ma demande publique validée**, étiquetée « agent » (`source: SYSTEM` des deux côtés). Corrigé : `origineReservation()` — agent / lien public / manuelle ; « posées par l'agent » ne prend plus que l'agent.

## 5. La feuille Optimisation *(P1-4, P1-5)* — non exerçable sur la démo, **jouée sur la prod (cdef31, lecture seule) à 10:46**

Le bouton « Optimisation » n'existe que si la fonctionnalité IA « capacité » est ouverte à la
société (`aiStatus.can('capacity')`) — elle ne l'est pas sur la démo, elle l'est chez cdef31.

- [x] bandeau sur cdef31 → la feuille affiche **« Société : CDEF31 »**, métier « Transport d'enfants » (celui de la société) ;
- [ ] bandeau sur « Toutes » → message « choisissez une société » *(non rejoué)* ;
- [ ] changer le métier *(non fait : réglage réel du client)* ;
- [x] **Analyser** → `POST /api/ai/capacity/suggest` 201 en ~40 s, pastille « RÉSULTATS PRÊTS — 26 véhicule(s) dont la capacité peut être complétée » ;
- [x] **recharger la page (F5)** → rouvrir la feuille → **le résultat est toujours là** : « Résultat conservé de l'analyse du 28/09 à 10:46 — rien n'a été repayé », **aucun nouvel appel réseau** ;
- [ ] **Appliquer** *(non fait : écrirait les capacités des véhicules du client)* ;
- [x] `ai_usage_logs` : **une seule** ligne `capacity` (10:46:40, 0,063 $), pas deux.

## 6. Les missions *(P2-1, P2-2)* — **non exerçable sur la démo** (aucun compte dépôt)

Tenu par 3 tests API (refus de toucher une MISSION depuis l'agenda) et le gabarit vérifié à la
construction.

- [ ] onglet **Missions** → créer une mission demain → son ombre apparaît sur la grille, libellée **« Mission »** avec l'icône camion (P2-2) ;
- [ ] panneau du jour sur cette mission → **aucun bouton** « En cours / Terminé / Supprimer », mention « Se pilote depuis l'onglet Missions » (P2-1) ;
- [ ] onglet Missions → **Terminer** la mission → l'ombre passe « Terminé » sur la grille.

## 7. Ce qui se voit côté admin *(T83, rythme, P2-5)*

- [~] `/admin/background-tasks` → la page rend le **rattrapage des récits** (9 à écrire, périmètre, cadence) sans erreur ; le chiffre « par jour » de l'arriéré vit sur l'écran « Voir l'écran → », non ouvert ce matin ;
- [ ] l'entrée **« Agent nocturne d'optimisation d'agenda »** dit qu'à chaque heure il **expire** et **purge** *(texte non relu ce matin ; il est verrouillé par `catalogue-exhaustif.spec.ts`)* ;
- [~] `/admin/errors` : **route super-admin, la démo renvoie à la connexion**. Remplacé par une lecture SQL de `error_logs` de la démo sur les 4 dernières heures — voir le suivi de revue.

## 8. Les rôles *(D3, D5)* — **non exercé** : il faut se connecter avec les comptes `demo-*`, et je ne saisis jamais un mot de passe

- [ ] `demo-gestionnaire@` : voit l'agenda, réserve, valide ; **pas** de Paramètres de l'agenda ;
- [ ] `demo-veilleur@` : `/agenda` **refusé** (comme `emu@` chez cdef31) ;
- [ ] `demo-lecteur@` : lit, ne crée rien.

## 9. Ce qu'on ne peut PAS éprouver sur la démo, et pourquoi

| | Pourquoi |
|---|---|
| Les **vraies** réservations et propositions de cdef31 | exclues de l'import (données personnelles) — vues en prod le 24/09, inchangées depuis |
| L'e-mail vers `standard@` / `j.hendriks@` | on n'écrit jamais au client depuis une recette (faute du 24/09) — prouvé `DELIVERED` le 24/09 |
| Le rapport hebdomadaire | cron du lundi 08:00 ; il part de la prod vers `j.hendriks@`, adresse prouvée |
| La purge P2-5 | sur la prod elle n'efface **rien** avant le 07/10 (plus ancienne close : 09/07) — mesuré |
| La feuille Optimisation, les missions, les rôles | voir §5, §6, §8 |

## 11. Le lot du 28/09 (multi-jours, « terminée ? », F3 / F13 / F16) — recette SUR LA PROD, société « Client test »

> ⚠️ **Règle absolue : aucun courriel vers `@cdef31.org`.** Tout se fait sur la société
> **Client test** (bandeau), dont les valideurs prévenus sont vérifiés AVANT toute demande
> (Paramètres de l'agenda → « Qui reçoit les demandes à valider ») ; le contact des demandes est
> l'adresse du propriétaire. Aucune action d'écriture sous le bandeau cdef31.

> **Joué le 28/09 de 09:28 à 09:40 sur la prod, société Client test, déploiement `9e8b57e6`** (Chrome,
> requêtes lues à chaque geste). Un seul compte dans cette société — le propriétaire, prévenu :
> `email_logs` ne porte que son adresse sur toute la fenêtre.

- [x] bandeau → **Client test** ; Paramètres → « Qui reçoit » ne liste que `younesshaddou31@gmail.com` ;
- [x] **F8** — « Passage au garage (recette) » du 29/09 au 05/10 sur TEST-006-XX, immobilise → `POST` 201, 7 pilules (la 1re pleine, 6 suites pointillées), panneau du 1er oct. : « 7 / 8 disponibles », TEST-006-XX **immobilisé**, carte « du 29 sept. au 5 oct. » ;
- [x] **F8** — Modifier → « Jusqu'au » 28/09 (avant le début) → toast « La fin doit être après le début », aucun `PATCH` ;
- [x] **F10** — Modifier → « Jusqu'au » 07/10 → `PATCH` 200, carte « du 29 sept. au 7 oct. », 9 pilules ;
- [x] **F11** — « Courroie (recette) » datée du 27/09 jusqu'au 27/09 → « En cours » → **« À clore »** : « TEST-003-XX Courroie — fin prévue le dim. 27 sept., dépassée » → **Non — nouvelle date de fin** 30/09 → `PATCH` 200, toast « Fin repoussée jusqu'au mer. 30 sept. », la ligne sort, la grille s'étale du 27 au 30 ;
- [x] **F11** — incident « Pneu crevé (recette) » daté du 27/09 sans fin → « en cours depuis le dim. 27 sept., sans date de fin » → **Oui, réglé** → `PATCH` 200, « Incidents ouverts » 1 → 0, la section disparaît ;
- [x] **F9** — Réserver : 29 puis 30 dans le sélecteur → `POST /reservations/request` 201, pilule sur les deux jours, carte « mar. 29 sept. 10:00 → mer. 30 sept. 11:00 » (la ligne « du … au » en double a été retirée le même matin, `34694997`) ;
- [x] **F3** — non observable sur Client test (véhicules fictifs) ; **vu sur cdef31 à 10:44, en lecture seule** : filtre sur DZ-034-CA (au garage depuis août) → tous les badges ● / ~ disparaissent ; « Tous les véhicules » → ils reviennent sur chaque cellule ;
- [x] **F13** — lien public → 11 places, Albi, 01/10 09:00 → 12:00, contact = propriétaire → `submit` 201, deux lignes REQUESTED (`bookingRef 29d341ae4b14b4de`), « Demandes » : **une** carte « 2 véhicules — TEST-007-XX TEST-001-XX · un seul demandeur, 2 véhicules pré-retenus », **Refuser les 2** → deux `cancel` 201, file vide ;
- [x] **F16** — `reservation_refused` **DELIVERED** au propriétaire à 09:37:11 — 🔴 **deux fois** (un courriel par véhicule du groupe). Corrigé et redéployé le même matin (`34694997`) : le notifier n'écrit qu'à la dernière décision du groupe, et la confirmation nomme tous les véhicules retenus ;
- [x] `/admin/background-tasks` et le journal de l'API : 0 erreur après déploiement ;
- [x] **rejeu après `34694997` (10:40)** — nouvelle demande de 11 places → « Refuser les 2 » → deux `cancel` 201 et **un seul** `reservation_refused` (10:40:58) ;
- [x] ménage : les 4 évènements « (recette) » et les 4 lignes de demandes publiques de test supprimés de Client test à 10:45 (`DELETE` ciblé sur la société, la date et le titre) — 0 ligne restante.
- Vu en passant, sur cdef31 (lecture seule) : **« À clore » remonte une vraie maintenance ouverte depuis le 21 août sans date de fin** (DZ-034-CA, Garage Renault) — exactement le cas que la liste devait faire remonter ; c'est à cdef31 d'y répondre.

## 10. Après la recette : le déploiement

1. **Mesurer qui est en ligne** (sessions, activités, requêtes réelles) — si la veilleuse ou un compte
   client est actif, on attend.
2. `bash /opt/vizyo-tracky/deploy/vps/deploy.sh --attendre` — jamais `compose up`. Il refuse de
   lui-même 05:30–09:00 et HH:42–46.
3. Vérifier **les artefacts dans les conteneurs** (`purgerPropositions`, `PROPOSITIONS_LISTE_MAX`,
   `origineReservation` côté API ; `op-fleet`, `estUneEcheance`, `ro-tag--public` côté web), la
   santé, le journal — pas `docker ps`.
4. Ouvrir `/agenda` sur cdef31 : compteurs, liste, pointillés, panneau du jour, **et la feuille
   Optimisation** (§5, non vue sur la démo). **Regarder l'écran.**
5. La démo suit d'elle-même (`deploy.sh` la recrée après que la prod est saine).

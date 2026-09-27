# Recette de l'agenda sur la démo — avant le déploiement du 28/09 à 10 h

**Où :** <https://demo-tracky.vizyoagency.com> · **Quoi :** le code de `main` (`cd472914`) que la
production **n'a pas encore** — les six derniers constats de l'audit, T83 et le rythme de l'arriéré ·
**Pourquoi là :** une pile séparée sur le même VPS, la vraie flotte pseudonymisée (« Transports
Méridien », 37 véhicules, 16 884 trajets du 15/04 au 27/09), **aucun port boîtier, aucune clé
SMS / push / Stripe** — rien de ce qu'on y fait ne peut atteindre un client.

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

- [ ] La page `/agenda` s'ouvre, trois compteurs à **0 / 0 / 0**, liste « À venir & en retard » vide, grille vide.

## 1. Les compteurs et la liste disent la même chose *(compteur ≠ liste, P2-4)*

Créer depuis « Évènement » :
- [ ] une **maintenance** PLANNED datée **d'hier** → compteur « En retard » = 1, la ligne apparaît en rouge dans la liste ;
- [ ] une **maintenance** PLANNED dans **10 jours** → « À venir (30j) » = 1, ligne dans la liste ;
- [ ] un **incident** (OPEN) daté d'aujourd'hui → « Incidents ouverts » = 1 ; **il n'apparaît PAS** dans « En retard » tant que sa date n'est pas passée ;
- [ ] passer la maintenance d'hier « En cours » depuis le panneau du jour → elle **sort** de la liste et du compteur « En retard » (elle est en cours, ni à venir ni en retard) ;
- [ ] filtrer par **véhicule** dans la barre → les trois compteurs **suivent** le véhicule choisi (0 pour un véhicule sans évènement) ; retirer le filtre → ils reviennent ;
- [ ] filtrer par **type** « Incident » → la liste ne montre que l'incident, **les compteurs ne changent pas** (voulu : chacun est typé par nature).

## 2. Le glisser-déposer *(livré le 23-24/09, validé au doigt le 27/09)*

- [ ] souris : glisser la maintenance de dans 10 jours sur un autre jour → heure et durée conservées, toast de confirmation ;
- [ ] tenter de la glisser **dans le passé** → refusée, message ;
- [ ] `/agenda` sur le téléphone : appui long sur la pastille → déplacement au doigt.

## 3. Les réservations, de bout en bout *(P0-1, R-1, R-2)*

- [ ] **Réserver** depuis la barre : créneau demain 9 h–12 h, motif « Ramassage secteur nord », véhicule libre → la carte du jour affiche **le motif** (R-1) ;
- [ ] Paramètres de l'agenda → **Liens publics** → créer un lien → **QR réservation** dans la barre → la carte imprimable montre le domaine **`demo-tracky.vizyoagency.com`** (R-6) ;
- [ ] ouvrir le lien public dans un onglet privé → déposer une demande (nom « Test recette », **ton** e-mail) → l'avis « Demande de réservation à valider » arrive aux valideurs de la démo (`demo-admin@`, `demo-gestionnaire@`… et **toi**) ;
- [ ] Paramètres de l'agenda → **Destinataires de l'avis** : décocher tout le monde sauf un → couper le **dernier** est **refusé** avec le motif ;
- [ ] bouton **Demandes** → valider → le demandeur reçoit la confirmation ; dans l'activité système, une ligne **`reservation_validee`** avec ton nom (R-2) ;
- [ ] déposer une seconde demande, la **refuser** → ligne `reservation_refusee` ;
- [ ] mettre un véhicule **hors service** (fiche véhicule) puis déposer une demande sur un créneau où il est le seul libre → il est **écarté**, motif affiché ; ou « aucun véhicule » si c'était le seul.

## 4. L'agent, sur les vrais trajets *(P0-3, 3a, 3b)*

- [ ] Paramètres de l'agenda → **activer l'agent**, heure nocturne quelconque → **Lancer l'analyse** ;
- [ ] le bilan du passage dit « N habitudes · **0 réservée** · N proposées · N ignorées (dont hors service…) » — **jamais une réservation ferme** ;
- [ ] des **pastilles en pointillé** apparaissent sur la grille ; le panneau du jour porte « Proposé par l'agent » avec **Réserver / Écarter** ;
- [ ] **Réserver** une proposition → elle devient ferme, disparaît des pointillés ; **Écarter** une autre → elle s'en va ;
- [ ] onglet **Propositions IA** : la liste ne montre que des départs **à venir** ;
- [ ] **Réorganiser** → 30 jours → posées par l'agent → **simulation** : le compte est juste (la réservation issue de la proposition), puis **appliquer** → annulée ; **elle n'encombre pas la grille** (R-5 : une annulation à venir est masquée).

## 5. La feuille Optimisation *(P1-4, P1-5)*

- [ ] en super-admin, bandeau sur Transports Méridien → la feuille affiche **« Société : Transports Méridien »** (plus de sélecteur) ; bandeau sur « Toutes » → message « choisissez une société dans le bandeau », bouton Analyser grisé ;
- [ ] le **métier** affiché est celui de la société ; le changer → toast, et la valeur **tient** à la réouverture ;
- [ ] **Analyser** (IA) → pastille en haut ; « Voir » → la feuille rouvre **avec** le résultat ;
- [ ] **recharger la page (F5)** → rouvrir la feuille → **le résultat est toujours là**, avec « Résultat conservé de l'analyse du … — rien n'a été repayé » ;
- [ ] **Appliquer** une proposition → le bandeau « conservé » disparaît, la fiche véhicule porte les places ;
- [ ] `/admin/ai-usage` : **une seule** analyse de capacité facturée, pas deux.

## 6. Les missions *(P2-1, P2-2)*

- [ ] onglet **Missions** → créer une mission demain (véhicule libre, dépôt destinataire = `demo-…`) → son ombre apparaît sur la grille, libellée **« Mission »** avec l'icône camion (P2-2) ;
- [ ] panneau du jour sur cette mission → **aucun bouton** « En cours / Terminé / Supprimer », mention « Se pilote depuis l'onglet Missions » (P2-1) ;
- [ ] onglet Missions → **Terminer** la mission → l'ombre passe « Terminé » sur la grille.

## 7. Ce qui se voit côté admin *(T83, rythme, P2-5)*

- [ ] `/admin/background-tasks` → bloc **Arriéré** : le rythme affiché est « par jour » **hors trajets neufs** (sur la démo : petit, mais cohérent avec le restant) ;
- [ ] l'entrée **« Agent nocturne d'optimisation d'agenda »** dit qu'à chaque heure il **expire** et **purge** ;
- [ ] `/admin/errors` : aucune ligne `agents-locaux` ni `AGENDA_AGENT` née pendant la recette.

## 8. Les rôles *(D3, D5)*

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

## 10. Après la recette : le déploiement de 10 h

1. **Mesurer qui est en ligne** (sessions, activités, requêtes réelles) — si la veilleuse ou un compte
   client est actif, on attend.
2. `bash /opt/vizyo-tracky/deploy/vps/deploy.sh --attendre` — jamais `compose up`. Il refuse de
   lui-même 05:30–09:00 et HH:42–46.
3. Vérifier **les artefacts dans les conteneurs** (`purgerPropositions`, `MAX_EVENEMENTS_PAR_FENETRE`
   côté API ; `op-fleet`, `estUneEcheance` côté web), la santé, le journal — pas `docker ps`.
4. Ouvrir `/agenda` sur cdef31 : compteurs, liste, pointillés, panneau du jour. **Regarder l'écran.**
5. La démo suit d'elle-même (`deploy.sh` la recrée après que la prod est saine).

# B1 — Les 29 pages de la refonte

Toutes les pages client sont refondues en 3 déclinaisons : **PC**, **iPhone 390 × 844**, **Android 412 × 915**.

Ce document liste, page par page, ce qui change et pourquoi. Il ne remplace pas les maquettes : il dit ce qu'on y cherche.

**Prérequis : `B0-SOCLE.md` terminé.**

---

## Le système de référence

À ne pas réinventer, établi sur les 3 premières pages :

- **Sections d'une planche** : `01` PC · `02` PC (2ᵉ état) · `03` iPhone · `04` Android
- **PC** : sidebar 244 px + topbar 60 px, panneau maître à gauche, fiche à droite
- **iOS** : barre d'onglets 82 px, feuilles à coins 22 px, poignée 36 × 5, en-tête Annuler / Terminé, densité de liste 44 px
- **Android** : nav système 3 boutons 48 px, top app bar, feuilles 28 px, poignée 32 × 4, densité 56 px, puces filtres avec coche, FAB étendu
- **Marqueurs et plaques** : logos de marque `app/brands/*.png` en pastille blanche

**Les 3 écarts iOS/Android sont volontaires**, pas des oublis : poignée 36 × 5 vs 32 × 4 · rayon 22 vs 28 px · densité 44 vs 56 px. Les aplatir donne une application étrangère sur les deux plateformes.

**Contrôle qualité, sur chaque colonne `overflow:hidden`** : vérifier `scrollHeight === clientHeight`. Ne jamais laisser une carte bordée coupée.

---

## Ordre d'implémentation

| # | Lot | Pourquoi cet ordre |
|---|---|---|
| 1 | Kit partagé (24 composants) | Ils apparaissent partout ; les pages faites avant les redéfiniraient |
| 2 | Tableau de bord | Première chose vue, valide le kit |
| 3 | Carte | La plus complexe, la plus autonome, déjà validée |
| 4 | Lieux clés | Prolonge la carte, réutilise ses composants |
| 5 | Détail véhicule | 10 onglets, gros morceau |
| 6 | Véhicules, Alertes | Listes denses |
| 7 | Analyse, Agenda | Graphes et exports |
| 8 | Administration | Utilisateurs, paramètres, horaires |
| 9 | Hors session, conducteur | Mobile d'abord |
| 10 | Surfaces bloquantes | Portes, coupure, rejeux, édition |
| 11 | **Shell** | En dernier : il fige les décisions de plateforme |
| 12 | E-mails | Indépendant, parallélisable |

Le shell en dernier est contre-intuitif mais délibéré : le brancher trop tôt force à trancher la navigation avant d'avoir vu les pages vivre.

---

## A — Hors session · 7 pages

Maquettes : `Connexion et Installation Refonte.dc.html`, `Installation Refonte.dc.html`, `Demander un Vehicule Refonte.dc.html`, `Espace Conducteur Refonte.dc.html`.

| Route | Ce qui change |
|---|---|
| `/login` | Détection Verr. Maj · compteur d'essais restants · entrée « QR véhicule » pour les conducteurs sans compte · Face ID / empreinte |
| `/forgot-password` | Parcours en 2 écrans, message identique que l'e-mail existe ou non |
| `/accept-invite` | Robustesse : lien expiré, déjà utilisé, compte existant |
| `/install` | **Détection automatique de la plateforme** au lieu du sélecteur à 3 onglets · QR desktop → mobile |
| `/book/:token` | 4 réponses du lien avec sortie : être prévenu, appeler, redemander un lien. Plus d'écran cul-de-sac |
| `/reserve/:token` | **La dictée devient le chemin principal** — bouton 112 px avec ondes, le formulaire ne sert qu'à corriger · transcription visible · interprétation des dates explicitée · contact manquant signalé **avant** le bouton · « vous ne choisissez pas le véhicule » enfin dit · 4 cas d'échec avec sortie |
| `/driver/unlock` | Déverrouillage de proximité, une main, gants |

⚠️ A5–A7 sont **quasi exclusivement mobiles** (ouverts depuis un SMS ou un QR). Concevoir mobile d'abord, le PC est un repli.

---

## B — Espace conducteur · 1 page

| Route | Ce qui change |
|---|---|
| `/driver` | Usage 100 % téléphone. Cibles ≥ 44 px, contraste extérieur, une main. **Ajout bloc A** : la mission du jour + la mention d'information « ce dépôt suit votre position pendant la mission » |

---

## C — Supervision · 6 pages

Maquettes : `Tableau de bord`, `Carte`, `Vehicules`, `Detail Vehicule`, `Lieux Cles`, `Alertes`.

| Route | Ce qui change |
|---|---|
| `/dashboard` | 4 tuiles de KPI en tête, widgets en grille |
| `/map` | Pastilles de véhicule redessinées (à reprendre en SVG), calques, feuille de position |
| `/vehicles` | Onglets liste / groupes / capacités / mode privé. Sur mobile : cartes + filtres en feuille |
| `/vehicles/:id` | **10 onglets regroupés en 4 familles** — Suivi (Carte, Historique) · Analyse (Rapports, Scores) · Sécurité (Alertes, Surveillance, Géofences) · Exploitation (Maintenance, Horaires, Commandes). Rien supprimé |
| `/places` | Pendant « liste » de la carte |
| `/alerts` | Onglets Alertes / Géofences / Réglages |

---

## D — Analyse · 5 pages

Maquettes : `Analyse Refonte`, `Agenda Refonte`, `Activite et Couts IA Refonte`.

| Route | Ce qui change |
|---|---|
| `/reports` | Barème A→E explicité · exports PDF/CSV/Excel · sur mobile, sparklines + drill-down, **jamais de scroll horizontal** |
| `/scores` | Podium, classement, carte « ce qui coûte des points », tendance 7 semaines, lien de partage en lecture seule |
| `/agenda` | **Ajout bloc A : 3ᵉ onglet Missions** (cf. `A2-MISSIONS.md`). Propositions de l'agent IA, réglages, réservation avec suggestion |
| `/fleet-admin/activity` | **Le résultat avant l'événement** — « refusée · véhicule en mouvement 74 km/h » au lieu d'un mot de statut · les échecs remontent en tête · la présence devient un panneau permanent, plus un onglet |
| `/admin/ai-usage` | Le forfait d'abord, la consommation ensuite · « en cas de dépassement, rien ne se coupe et rien n'est facturé en plus » · chaque euro rattaché à un résultat |

---

## E — Administration · 10 pages

Maquettes : `Utilisateurs`, `Parametres et Compte`, `Regles Alerte et Assistance`, `Horaires Vie Privee et Integrations`, `Installation Refonte`.

| Route | Ce qui change |
|---|---|
| `/users` | **Ajout bloc A : rôle Dépôt** (cf. `A5-COMPTES.md`) · invitations en attente et expirées · tiroir d'édition |
| `/users/overview` | Matrice **repensée en liste par rôle** sur mobile — impossible telle quelle sur téléphone |
| `/installations` | Le jour en cours au centre · anneau de progression + 4 compteurs · « ce qu'on attend de vous » · SIM manquante expliquée |
| `/integrations` | Volume réellement transmis par catégorie (« 42 véhicules, 3 412 trajets ») · consentement en deux blocs, sensible décoché |
| `/fleet-schedules` | **Frise 24 h par groupe** au lieu de colonnes de texte · l'anomalie d'abord (bandeau « roulent encore ») |
| `/privacy-coverage` | Les 3 états avec les mêmes mots que dans l'éditeur d'horaires · bouton *Définir les horaires* sur les véhicules « mixte sans cadre » |
| `/settings` | **Navigation à deux niveaux** avec recherche — « Mon espace » vs « Ma flotte », la question la plus posée · enregistrement automatique visible · pastille « modifié » par section |
| *(carte dans `/settings`)* | Règles de notification — prévision du volume, heures calmes |
| `/settings/audio-monitoring` | Mode assistance |
| `/account` | Profil, sessions ouvertes avec appareil inconnu signalé, sécurité |

---

## F — Surfaces bloquantes · 12

Maquettes : `Portes Acces`, `Demarrage et Shell Auth`, `Coupure Moteur et Surveillance`, `Rejeux`, `Edition Vehicule`.

| Surface | Ce qui change |
|---|---|
| Consentement RGPD | **La séquence devient visible** — « étape N sur 3 », calculée · note conducteurs actionnable avec modèle téléchargeable |
| Autorisations navigateur | Localisation justifiée par son usage · **fin de l'impasse** : « Continuer sans déverrouillage QR » |
| Vérification d'appareil | Code à 6 cases séparées, collage depuis l'e-mail |
| Proposition 2FA | Sort de la pile : voile à 22 %, 3 sorties visibles. Feuille iOS, dialogue M3 |
| Assistant de démarrage | **5 étapes → 2** pour tout le monde. Les étapes véhicule, invitation et récapitulatif disparaissent |
| Coupure moteur | **Compte à rebours pendant les 90 s** · la raison du refus sort du `title` · l'état non confirmé a 3 sorties · avertissement boîtier muet en 3 étapes numérotées |
| Panneau surveillance | **Saisie en heure locale** (défaut UTC, cf. B0) · week-end en surveillance permanente · dénouement de chaque déclenchement |
| QR véhicule | Explique son usage et son format d'impression (60 × 90 mm) · 262 px sur Android |
| Rejeu de trajet | **Multiplicateurs partout** avec la durée réelle à côté · excès confirmé vs pointe à vérifier · la frise porte l'analyse |
| Rejeu de période | **Une barre par jour** · les trajets listés et cliquables · échelle 16× ajoutée |
| Créer / éditer un véhicule | **Le boîtier devient facultatif** — « Sans boîtier pour l'instant » · compteur `15 / 15` sur l'IMEI · « 2 champs requis sur 11 » |
| Éditeur d'horaires | **Bloc imbriqué derrière un filet vert** — impossible de régler les plages en croyant protéger alors que rien n'est protégé · « 122 h sur 168 sans collecte » |

---

## G — Le shell · 2

Maquette : `Shell et Design System Refonte`.

| Surface | Ce qui change |
|---|---|
| Shell authentifié | Une seule définition de référence · bandeau hors ligne qui **pousse** le contenu, barre de progression en 2 px qui **se superpose** · 3 modes spéciaux (veilleur, simplifié, super-admin) · **ajout bloc A : mode dépôt** (cf. `A1` § 5) |
| Shell hors session | Panneau droit conservé tel quel. Un seul changement : l'accroche passe de « Suivez et sécurisez votre flotte » à « Vous savez où sont vos véhicules. Et pourquoi ils s'arrêtent. » |

**Décisions de plateforme, à ne pas revisiter :**
- iOS : 5 onglets en bas, **pas de hamburger** — il concurrence le geste de retour
- Android : tiroir M3, **pas de barre d'onglets** — les 3 boutons système occupent déjà le bas

---

## H — Kit partagé · 23 composants

Maquette : `Kit Partage Refonte`. Détail dans `B0-SOCLE.md`.

**Modales et feuilles** — `confirm-modal`, `bottom-sheet`, `trip-note-modal`, `pdf-export-modal`, `update-required-modal`, `plan-upsell`, `push-prompt`
**Saisie** — `date-range-picker`, `datetime-range`, `driver-picker`
**Retour visuel** — `toast`, `skeleton`, `spinner`
**Badges** — `alerts-bell`, `connectivity-badge`, `group-badge`, `install-banner`, `install-review-badge`, `super-admin-context`
**Données** — `charts`, `mini-map`, `metric-card`
**Marque** — `brand-logo`, `logo`, `theme-toggle`

**Les 5 règles** : aucune couleur en dur · squelette et non rond · une erreur porte un recours · nommer ce qui est perdu · modale sur PC, feuille sur mobile.

---

## I — E-mails · 19 gabarits

Maquette : `Emails Refonte`.

Les 7 problèmes du `shell()` actuel : fond sombre forcé · vert en aplats · emoji dans un e-mail de sécurité · sujet entre crochets · Google Fonts par `<link>` (supprimé par Gmail, Outlook, Yahoo — Manrope n'arrive jamais) · aucun preheader · accents perdus.

**Décision sur les animations : rien qui bouge.** Les `@keyframes` ne marchent que dans Apple Mail ; 85 % des destinataires ne les verront pas. Le mouvement est remplacé par de la hiérarchie. C'est ce qui distingue le transactionnel du marketing.

**Ajout bloc A** : gabarits `mission_assigned` et `invitation` version dépôt (cf. `A2` § 3.3 et `A5` § 6).

---

## J — Interfaces alternatives

Maquette : `Veilleur et Mode Simplifie Refonte`.

**Mode veilleur** — 3 permissions, une seule écriture : **redémarrer** un véhicule. Il ne peut pas couper (rallumer débloque une exception réversible, couper immobilise un bien). Accordéons par groupe, bouton Redémarrer sur la ligne, confirmation en un toucher avec deux garanties : *réversible*, *consigné à votre nom*.

**Interface simplifiée** — carte plein écran, 3 cibles de 88 px en langage courant. 4 règles : jamais plus de 3 boutons · langage courant · les garde-fous restent · la sortie vers l'interface complète est toujours visible.

⚠️ **Défaut à corriger** : le réglage promet « toutes les pages restent accessibles », mais `dashboard-layout.component.ts` filtre le menu à 5 entrées — Rapports, Scores, Agenda et le tableau de bord disparaissent. La promesse et le code se contredisent. **Le menu doit tout garder.**

**Règle non négociable** : en mode simplifié, Paramètres reste toujours dans le menu, détaché, en violet, sous-titré « Revenir en interface complète ». Sans cette garantie, l'utilisateur est enfermé dans un mode qu'il n'a pas compris.

---

## Ce que les maquettes contiennent au-delà du visuel

C'est là qu'est la vraie valeur, et ce serait dommage de la perdre :

- **Des décisions justifiées.** Chaque planche porte des légendes qui expliquent *pourquoi*. Ces raisons doivent survivre à l'implémentation.
- **Des données réelles.** Les DTO ont été lus : `FleetPlaceDto`, `PARTNER_SCOPES` (10 scopes avec leurs libellés FR), `InstallationPlanStatus` (5 états), les 6 états de commande moteur. Les maquettes montrent les **vrais** états.
- **Des manques comblés.** La sortie du cul-de-sac « localisation refusée », les 3 sorties de « coupure non confirmée », la note conducteurs téléchargeable, le volume réellement transmis par intégration.

---

## Critères de recette, valables pour chaque page

| # | Vérification |
|---|---|
| 1 | Aucun style en ligne recopié d'une maquette |
| 2 | Icônes issues de `design/ICONS.md`, aucune inventée |
| 3 | Aucun libellé replié ou tronqué en Poppins |
| 4 | Les 6 états démontrables sur les composants de la page |
| 5 | `scrollHeight === clientHeight` sur chaque colonne `overflow:hidden` |
| 6 | Thème clair et sombre, contraste ≥ 4,5:1 sur le texte |
| 7 | iPhone 390 px : cibles ≥ 44 px, pas de débordement |
| 8 | Android 412 px : pas de barre d'onglets, FAB si la page a une action principale |

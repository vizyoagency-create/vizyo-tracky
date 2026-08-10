# Les 28 planches de référence

À placer dans `design/maquettes/` du dépôt `vizyo-tracky`.

Chaque planche montre le même écran en plusieurs déclinaisons, dans cet ordre :
`01` PC · `02` PC (2ᵉ état ou modales) · `03` iPhone 390 × 844 · `04` Android 412 × 915.

Les légendes portées dans les planches expliquent **pourquoi** chaque décision a été prise. Ces raisons doivent survivre à l'implémentation.

---

## Correspondance planche → routes

### Bloc A — Espace dépôt

| Planche | Routes / surfaces | Spec |
|---|---|---|
| `Espace Depot Refonte` | `/depot`, `/depot/missions`, `/depot/history`, `/depot/documents` + 6 modales | `A3`, `A4` |
| `Agenda Refonte` § 05–06 | `/agenda` onglet Missions, création, conflit | `A2` |
| `Utilisateurs Refonte` | `/users` — rôle Dépôt, matrice, invitation | `A5` |

### Bloc B — Refonte

| Planche | Routes / surfaces | § de `B1` |
|---|---|---|
| `Kit Partage Refonte` | 24 composants partagés | H |
| `Tableau de bord Refonte` | `/dashboard` | C |
| `Carte Refonte` | `/map` | C |
| `Lieux Cles Refonte` | `/places` | C |
| `Vehicules Refonte` | `/vehicles` | C |
| `Detail Vehicule Refonte` | `/vehicles/:id` — 10 onglets en 4 familles | C |
| `Alertes Refonte` | `/alerts` | C |
| `Analyse Refonte` | `/reports`, `/scores` | D |
| `Agenda Refonte` § 01–04 | `/agenda` — mois, échéances, agent IA | D |
| `Activite et Couts IA Refonte` | `/fleet-admin/activity`, `/admin/ai-usage` | D |
| `Utilisateurs Refonte` | `/users`, `/users/overview` | E |
| `Parametres et Compte Refonte` | `/settings`, `/account` | E |
| `Regles Alerte et Assistance Refonte` | règles de notification, `/settings/audio-monitoring` | E |
| `Horaires Vie Privee et Integrations Refonte` | `/fleet-schedules`, `/privacy-coverage`, `/integrations` | E |
| `Installation Refonte` | `/install`, `/installations` | A, E |
| `Connexion et Installation Refonte` | `/login`, `/forgot-password`, `/accept-invite` | A |
| `Demander un Vehicule Refonte` | `/book/:token`, `/reserve/:token` | A |
| `Espace Conducteur Refonte` | `/driver`, `/driver/unlock` | B |
| `Portes Acces Refonte` | consentement RGPD, autorisations, vérification d'appareil, 2FA | F |
| `Demarrage et Shell Auth Refonte` | assistant de démarrage, shell hors session | F, G |
| `Coupure Moteur et Surveillance Refonte` | coupure moteur, panneau surveillance, QR véhicule | F |
| `Rejeux Refonte` | rejeu de trajet, rejeu de période | F |
| `Edition Vehicule Refonte` | créer/éditer un véhicule, éditeur d'horaires | F |
| `Shell et Design System Refonte` | shell authentifié + 4 modes | G |
| `Emails Refonte` | 19 gabarits | I |
| `Veilleur et Mode Simplifie Refonte` | mode veilleur, interface simplifiée | J |
| `Loaders-Splash` | écrans de chargement, splash | H |

---

## Comment lire une planche

Ce sont des **Design Components** : `<x-dc>` + styles en ligne + un `support.js` qui les rend dans le navigateur.

**Pour lire le contenu** : ouvrir le `.dc.html` dans un éditeur. Tout est dans le template, en clair — pas de compilation, pas de build.

**Pour voir le rendu** : ouvrir le fichier dans un navigateur (`support.js` est inclus dans ce dossier).

### Trois pièges de traduction

1. **Manrope → Poppins.** Les planches utilisent Manrope. Poppins est plus large : tout libellé serré peut déborder. Voir `B0-SOCLE.md` § « Écart 1 ».
2. **Variables CSS → Tailwind.** Les planches utilisent `--accent`, `--tx2`, `--surface2`. Le code utilise des classes utilitaires. La table de correspondance est `design/TOKENS.md`.
3. **`<symbol>` SVG → lucide-angular.** Les `ic-*` sont dessinés dans le style Lucide mais ce ne sont pas des composants Lucide. La table est `design/ICONS.md`.

⚠️ **Exception aux icônes** : les pastilles de véhicule de la carte (CAR, TRUCK, VAN, MOTORCYCLE, BICYCLE, BUS, CONSTRUCTION, OTHER) ont été redessinées pour rester lisibles en petit avec rotation selon le cap. À reprendre **telles quelles en SVG** depuis `Carte Refonte`.

---

## Les logos de marque

`brands/*.png` — 7 logos utilisés dans les pastilles de véhicule des planches Carte, Véhicules et Détail véhicule.

Ce sont des **substituts de conception**. En production, la pastille affiche le logo correspondant à `Vehicle.brand`, avec un repli sur l'initiale quand la marque est absente ou inconnue. Ne pas coder en dur ces 7 marques.

---

## Ce que les planches ne sont pas

- Ce n'est pas du code à copier. Aucun style en ligne ne doit finir dans le dépôt.
- Ce n'est pas une source de vérité pour les données. Les valeurs affichées sont plausibles, pas réelles — mais les **états** viennent des vrais DTO (`InstallationPlanStatus`, `PARTNER_SCOPES`, les 6 états de commande moteur).
- Ce n'est pas exhaustif sur les états. Les 6 états obligatoires (chargement, rempli, vide, erreur, partiel, interdit) sont une exigence de `B0`, pas toujours dessinée planche par planche.

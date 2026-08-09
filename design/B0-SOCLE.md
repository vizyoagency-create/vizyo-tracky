# B0 — Le socle : prérequis absolu de la refonte

> **Aucun écran ne se code avant que les trois tables de ce document existent.** C'est une demi-journée qui évite de reprendre 26 écrans deux fois.

## Le problème

Les 26 maquettes sont cohérentes entre elles et fondées sur les vrais DTO du projet. Mais elles ne parlent pas la même langue que le code : trois écarts structurels font échouer toute traduction littérale.

Sans les tables ci-dessous, chaque écran inventera sa propre correspondance — et la refonte recréera la dispersion qu'elle devait supprimer.

---

## Écart 1 — La police

| | Maquettes | Application |
|---|---|---|
| Titres, interface | **Manrope** | **Poppins** |
| Données, plaques | JetBrains Mono | JetBrains Mono ✓ |

Poppins est **métriquement plus large** que Manrope à taille égale. Tout libellé qui tient juste dans une maquette peut déborder dans l'application.

### Zones à risque, par gravité

1. **Navigation latérale** — « Tableau de bord », « Scores de conduite », « Activité flotte », « Horaires flotte ». Le `.navlink` a `white-space: nowrap` et `height: 40px` : le texte ne se repliera pas, il **débordera** ou sera tronqué.
2. **Pastilles d'état** — « Attente d'arrêt », « SIM manquante », « Non confirmée », calibrées au caractère près.
3. **Tuiles de KPI** — libellés sur une ligne : « Coupés maintenant », « protégés hors travail ».
4. **Boutons à deux mots** — « Voir la fiche », « Définir les horaires ».

### La planche de contrôle — première tâche du projet

Recréer dans l'application réelle, en Poppins :

- la navigation latérale complète (14 entrées)
- 10 pastilles d'état, les plus longues
- 4 tuiles de KPI

Mesurer. Deux issues possibles :

- ajuster les tailles d'interface globalement (probablement −0,02 à −0,04 rem sur les libellés)
- ou élargir la nav de 244 à ~260 px

**Noter la décision dans `design/DECISIONS.md`.** Elle vaut pour les 26 écrans.

⚠️ **Ne pas commencer par le Tableau de bord.** Commencer par cette planche.

---

## Écart 2 — Les jetons de couleur

Les maquettes utilisent des variables CSS brutes :

```
--bg  --bg2  --surface  --surface2  --surface3
--border  --border2
--tx  --tx2  --tx3
--accent  --accent2  --accent-soft  --accent-ink
--red  --red-soft  --amber  --amber-soft
--violet  --violet-soft  --blue  --blue-soft
```

L'application utilise des classes utilitaires Tailwind (`bg-bg-primary`, `text-fg-primary`, `bg-track-*`…).

**Produire `design/TOKENS.md`** : une table à deux colonnes, maquette → Tailwind, exhaustive. C'est le premier fichier du projet.

### Deux points non négociables

**`--accent-ink` existe pour une raison.** Sur un fond `--accent` (vert vif), l'encre doit être foncée, jamais blanche. L'erreur inverse a été commise sur 4 tuiles pendant la conception : contraste tombé à 1,72:1.

**Une couleur = une signification :**

| Couleur | Sens |
|---|---|
| vert | succès, actif, à l'heure |
| rouge | échec, danger, retard |
| ambre | attente, à vérifier |
| bleu | information |
| violet | IA, super-admin, **dépôt** |
| gris | inactif, indisponible |

Cette règle vaut plus que n'importe quelle valeur hexadécimale.

---

## Écart 3 — Les icônes

Les maquettes définissent des `<symbol>` SVG en ligne (`ic-power`, `ic-truck`, `ic-shield`…). L'application utilise **lucide-angular**.

Les pictogrammes ont été dessinés dans le style Lucide (trait 1,9 px, bouts arrondis) précisément pour que la correspondance soit directe. Mais elle doit être **écrite**, pas devinée.

**Produire `design/ICONS.md`** : `ic-power` → `Power`, `ic-poweroff` → `PowerOff`, `ic-truck` → `Truck`, `ic-van` → `Truck` (Lucide n'a pas de camionnette distincte — décision à acter), etc.

⚠️ **Exception** : les pastilles de véhicule sur la carte (CAR, TRUCK, VAN, MOTORCYCLE, BICYCLE, BUS, CONSTRUCTION, OTHER) ne sont pas des icônes Lucide. Elles ont été redessinées pour rester lisibles en petit avec rotation selon le cap. **À reprendre telles quelles en SVG** depuis la planche Carte.

---

## Les composants partagés, avant les pages

`Kit Partage Refonte.dc.html` liste **24 classes partagées**, strictement identiques dans les 26 planches (0 divergence, vérifié). La valeur lue dans n'importe quelle planche est la bonne.

Ordre d'attaque, par nombre de pages touchées :

| # | Composant | Pages |
|---|---|---|
| 1 | `connectivity-badge` | 9 |
| 2 | `confirm-modal` | 14 |
| 3 | `toast` + `skeleton` | toutes |
| 4 | `bottom-sheet` | 11 |
| 5 | les 18 autres | — |

**Pourquoi avant les pages** : ces éléments apparaissent des centaines de fois. Chaque page implémentée avant eux les redéfinira localement.

---

## Les 6 états obligatoires

Le socle impose que **chaque composant sache montrer** :

`chargement` · `rempli` · `vide` · `erreur` · `partiel` · `interdit`

C'est le manque le plus fréquent du code actuel : beaucoup de composants ne gèrent que « rempli » et « chargement ».

**`interdit` en particulier** : aujourd'hui on masque silencieusement, alors qu'il faut nommer la permission manquante. Un bouton qui disparaît sans explication produit un ticket de support ; un bouton désactivé qui dit « demande la permission *Couper le moteur* » n'en produit aucun.

En faire une exigence de revue, pas une intention.

---

## Les 4 défauts de code à corriger au passage

Relevés en lisant la source, indépendants de la refonte.

### 1. Couleurs en dur

`connectivity-badge.component.ts` renvoie ses propres hex : `#10b981`, `#0ea5e9`, `#ef4444`, `#f59e0b`, `#64748b`, `#9ca3af`. Idem dans le rejeu de trajet. Elles ne suivent pas le thème clair et doublent les jetons.

Deux distinctions à ajouter au passage : *Dormant* passe en violet (boîtier muet depuis plus d'une semaine ≠ panne réseau — deux problèmes ne partagent pas l'ambre), *Non configuré* prend un contour tireté (absence d'installation, pas un état de terrain).

### 2. Surveillance réglée en UTC — le plus grave

`surveillance-panel.component.ts` affiche `Début (HH:mm UTC)`. On demande à un gestionnaire de convertir mentalement, et la conversion change deux fois par an.

Conséquence réelle : une surveillance réglée « 18:00 » démarre à 20:00 en été. **Deux heures pendant lesquelles le véhicule n'est pas protégé, sans que personne ne le sache.**

→ Heure locale en saisie, UTC en note de pied.

### 3. Accents perdus

Assistant de démarrage (« Pret a piloter votre flotte ? »), e-mails, sujets. Même défaut à trois endroits — c'est un motif récurrent du projet, à traiter en une passe.

### 4. Compteurs d'étapes codés en dur

`onboarding-wizard.component.ts` déclare `Step = 1|2|3|4|5` alors que le parcours réel dépend du rôle : un non-admin fait 1 → 2 → 5, et la barre bondit de 40 % à 100 %.

Même remarque pour les portes d'accès : « étape N sur 3 » doit être **calculé** — la vérification d'appareil n'apparaît que si la 2FA est active *et* la connexion inhabituelle. Un utilisateur habituel doit voir « 1 sur 2 ».

*Note : la décision client sur l'assistant est de passer à 2 étapes pour tout le monde. Le défaut se résout en supprimant, pas en corrigeant.*

---

## Livrables de l'étape 0

| Fichier | Contenu |
|---|---|
| `design/DECISIONS.md` | La décision Poppins, mesurée |
| `design/TOKENS.md` | Variables maquette → classes Tailwind |
| `design/ICONS.md` | `ic-*` → noms Lucide, exception carte notée |

Ces trois artefacts sont le contrat. Toute séance suivante y fait référence.

---

## Critères de recette

| # | Vérification | Attendu |
|---|---|---|
| 1 | Planche de contrôle en Poppins | Aucun libellé replié ni tronqué |
| 2 | `design/TOKENS.md` | Chaque variable de maquette a sa correspondance |
| 3 | `design/ICONS.md` | Chaque `ic-*` a son nom Lucide, ou une décision écrite |
| 4 | `connectivity-badge` | Zéro hex en dur, thème clair correct |
| 5 | Surveillance | Saisie en heure locale |
| 6 | Un composant du kit | Les 6 états démontrables |

# Prompt pour Claude Code

Deux blocs : le prompt d'ouverture, à coller une fois, puis les relances de séance.

---

## 0. Avant d'ouvrir Claude Code

Copier dans le dépôt `vizyo-tracky` :

```
design/
  00-LISEZ-MOI.md
  A0-VUE-ENSEMBLE.md
  A1-ROLE-DEPOT.md
  A2-MISSIONS.md
  A3-ESPACE-DEPOT.md
  A4-PARTAGE.md
  A5-COMPTES.md
  B0-SOCLE.md
  B1-PAGES.md
  maquettes/            ← les 27 fichiers .dc.html
```

---

## 1. Le prompt d'ouverture

Coller ce bloc en **première** demande.

```
Tu vas implémenter deux chantiers dans ce dépôt, dans cet ordre :

  BLOC A — l'espace dépôt : une fonctionnalité qui n'existe pas encore.
  BLOC B — la refonte des 29 pages existantes.

## Le dépôt

Angular standalone, signals, contrôle de flux @if/@for, Tailwind,
lucide-angular pour les icônes, maplibre-gl pour la carte.
API NestJS + Prisma. Permissions partagées dans packages/shared.

## Tes spécifications

Tout est dans `design/`. Commence par lire `design/00-LISEZ-MOI.md`,
qui donne l'ordre de lecture et les dépendances entre documents.

Les maquettes sont dans `design/maquettes/`. Chaque planche montre le même
écran en 3 déclinaisons (PC, iPhone, Android) et porte des légendes qui
expliquent POURQUOI chaque décision a été prise. Ces raisons doivent
survivre à l'implémentation.

## L'ordre de travail, non négociable

ÉTAPE 0 — `design/B0-SOCLE.md`, section « planche de contrôle ».
  Trois tables à produire avant toute ligne d'écran :
  design/DECISIONS.md (Poppins mesuré), design/TOKENS.md, design/ICONS.md.
  Ne touche à aucun écran avant que ces trois fichiers existent.

ÉTAPE 1 — BLOC A, lot A1 : le rôle DEPOT et son isolation.
  `design/A1-ROLE-DEPOT.md`.
  Les 12 tests d'isolation de la section 8 doivent être VERTS
  avant de passer à A2. C'est la condition de passage, pas une suggestion.

ÉTAPE 2 — A2 missions, puis A5 comptes, puis A3 écrans, puis A4 partage.
  Chaque document porte ses propres critères de recette en dernière section.

ÉTAPE 3 — BLOC B, dans l'ordre de `design/B1-PAGES.md` § « Ordre
  d'implémentation ». Le kit partagé avant les pages, le shell en dernier.

À chaque lot terminé : lance les critères de recette du document,
puis commite. Ne cumule jamais deux lots non vérifiés.

## Trois règles absolues

RÈGLE 1 — Les maquettes sont une RÉFÉRENCE DE CONCEPTION, pas du code
à copier. Elles utilisent des styles en ligne et Manrope. L'application
utilise Tailwind et Poppins. Tu traduis les décisions, tu ne recopies pas
le HTML. Aucun style en ligne recopié ne doit finir dans le code.

RÈGLE 2 — Le périmètre du rôle DEPOT se contrôle CÔTÉ REQUÊTE, jamais
côté affichage. Le `where` Prisma porte toujours depotUserId. Filtrer
dans un template est une faille, pas une protection. Hors périmètre,
l'API répond 403 — jamais 200 avec un tableau vide.

RÈGLE 3 — Poppins est plus large que Manrope. Après chaque écran, vérifie
qu'aucun libellé ne se replie ni ne déborde. C'est le défaut le plus probable.

## Ce que tu ne fais pas sans me demander

- Modifier un DTO ou un contrat API existant (les NOUVEAUX DTO du bloc A
  sont spécifiés, tu les crées librement)
- Changer une logique métier existante (calculs, permissions, alertes)
- Supprimer une fonctionnalité existante
- Ajouter une dépendance npm
- Élargir le périmètre du rôle DEPOT au-delà de ce que dit A1

Si une maquette semble impliquer un de ces changements, arrête-toi et demande.

## Commence maintenant

Lis `design/00-LISEZ-MOI.md`, puis `design/B0-SOCLE.md`.
Exécute l'étape 0 et rends-moi compte avant de continuer.
```

---

## 2. Les relances de séance

### Reprise générale

```
Reprends `design/` à la première étape non terminée.
Rappelle-toi les 3 règles : référence ≠ copie · isolation côté requête · Poppins.
```

### Démarrer un lot du bloc A

```
Lot A2 — les missions. Lis `design/A2-MISSIONS.md` en entier.
Vérifie d'abord que les 12 tests d'isolation d'A1 sont verts.
Puis implémente dans l'ordre : modèle Prisma, module API, onglet agenda,
modale de création, modale de conflit, déclinaisons mobiles.
Termine par les critères de recette de la section 10.
```

### Démarrer une page du bloc B

Mauvaise formulation :

> « Implémente la maquette Tableau de bord Refonte.dc.html »

Claude Code traduira du HTML inline en Angular, gardera Manrope, inventera
des correspondances de couleur, et produira un composant étranger au code.

Bonne formulation :

```
Voici `design/maquettes/Tableau de bord Refonte.dc.html` comme référence
de conception, et `design/TOKENS.md`.

Modifie `features/dashboard/dashboard.component.ts` pour adopter cette
structure : 4 tuiles de KPI en tête, puis les widgets en grille.

Utilise nos classes Tailwind existantes et lucide-angular selon
`design/ICONS.md`. Ne recopie aucun style en ligne.
Vérifie ensuite les 8 critères de recette de `design/B1-PAGES.md`.
```

---

## 3. Si Claude Code dérive

Six rappels qui remettent d'aplomb.

**Sur la refonte :**
- « Tu recopies la maquette au lieu de traduire la décision. Utilise nos classes Tailwind. »
- « Cette icône n'est pas dans `design/ICONS.md`. Vérifie l'étape 0. »
- « Ce libellé déborde en Poppins. Mesure-le avant de continuer. »

**Sur le bloc A :**
- « Tu filtres côté affichage. Le `where` Prisma doit porter `depotUserId`. »
- « Tu renvoies un tableau vide hors périmètre. C'est un `403`. »
- « Ce champ n'est pas dans `DepotMissionDto`. Il ne doit pas quitter le serveur. »

---

## 4. Les points de contrôle à ne pas laisser passer

À vérifier soi-même, ce sont les endroits où une erreur coûte cher.

| Moment | Vérification |
|---|---|
| Fin d'étape 0 | Les 3 fichiers `design/*.md` existent et sont remplis |
| Fin A1 | Les 12 tests d'isolation passent, **et** la revue manuelle des contrôleurs est faite |
| Fin A2 | Créer une mission rend vraiment le véhicule indisponible dans `/reserve/:token` |
| Fin A4 | Le lien expire réellement — attendre 16 minutes, pas simuler |
| Fin A4 | Inspecter la réponse publique : aucune plaque, aucun nom, aucun tracé |
| Fin du kit | Un composant démontre ses 6 états |
| Avant le shell | Les pages vivent sans lui |

---

## 5. Ordre de livraison conseillé

| Séance | Contenu | Livrable visible |
|---|---|---|
| 1 | Étape 0 | Les 3 tables, la planche de contrôle mesurée |
| 2 | A1 | Tests d'isolation verts |
| 3 | A2 | Une mission créée bloque un véhicule |
| 4 | A5 | Un dépôt invité se connecte |
| 5–6 | A3 | L'espace dépôt sur 3 plateformes |
| 7 | A4 | Le partage complet |
| 8 | Kit partagé | 24 composants unifiés |
| 9+ | Bloc B | Une page par séance environ |

Le bloc A est démontrable au client dès la séance 7. Le bloc B se livre page par page sans jamais casser l'existant.

# Livrable d'implémentation Tracky

Dossier de spécification pour Claude Code. Rédigé le 9 août 2026.

Deux blocs indépendants, à traiter dans cet ordre :

- **Bloc A — Espace dépôt** : une fonctionnalité qui n'existe pas encore. Nouveau rôle, nouveau modèle de données, nouveaux écrans, nouveau lien public. C'est la priorité.
- **Bloc B — Refonte de l'interface** : les 29 pages existantes, redessinées. Aucun changement de logique métier, uniquement de la structure et du style.

---

## Les documents

### Bloc A — Espace dépôt

| Fichier | Contenu | Dépend de |
|---|---|---|
| `A0-VUE-ENSEMBLE.md` | Le besoin, les 5 lots, l'ordre, ce qui bloque quoi | — |
| `A1-ROLE-DEPOT.md` | Le rôle `DEPOT`, ses permissions, l'isolation backend | — |
| `A2-MISSIONS.md` | Le modèle `Mission`, l'agenda, l'indisponibilité véhicule | A1 |
| `A3-ESPACE-DEPOT.md` | Les écrans : carte live, historique, documents (PC / iOS / Android) | A1, A2 |
| `A4-PARTAGE.md` | Le lien public temporaire — **le lot le plus sensible** | A2, A3 |
| `A5-COMPTES.md` | Invitation, création de compte, impacts sur `/users` | A1 |

### Bloc B — Refonte

| Fichier | Contenu | Dépend de |
|---|---|---|
| `B0-SOCLE.md` | Étape 0 : police, jetons, icônes. **Prérequis absolu** | — |
| `B1-PAGES.md` | Les 29 pages, ce qui change sur chacune, dans l'ordre | B0 |

### Le prompt

| Fichier | Contenu |
|---|---|
| `PROMPT-CLAUDE-CODE.md` | À coller en première demande dans le dépôt `vizyo-tracky` |

---

## Les maquettes de référence

Toutes dans le projet de design, à copier dans `design/` du dépôt avant de commencer.

**Bloc A :**

| Maquette | Ce qu'elle montre |
|---|---|
| `Espace Depot Refonte.dc.html` | 7 sections : carte live PC, modales, onboarding, historique PC, iOS ×5, Android ×5 |
| `Agenda Refonte.dc.html` § 05–06 | Liste des missions, création, conflit de créneau |
| `Utilisateurs Refonte.dc.html` | Rôle Dépôt dans la liste, la matrice, la feuille d'invitation |
| `Video Depot.dc.html` | Film explicatif 25 s (support commercial, pas une spec) |

**Bloc B :** les 26 planches listées dans `B1-PAGES.md`.

---

## Comment lire une spécification

Chaque document du bloc A suit la même structure :

1. **Le besoin** — pourquoi cette fonctionnalité existe
2. **Pages concernées** — routes, fichiers, maquettes
3. **Modèle de données** — Prisma, DTO partagés
4. **Backend** — endpoints, gardes, règles d'isolation
5. **Frontend** — composants, états, interactions
6. **Règles métier** — ce qui est non négociable
7. **États et cas particuliers** — la liste exhaustive
8. **Critères de recette** — ce qu'on vérifie avant de cocher

---

## Trois règles qui traversent tout le livrable

**RÈGLE 1 — Les maquettes sont une référence de conception, pas du code.**
Elles utilisent des styles en ligne et Manrope. L'application utilise Tailwind et Poppins. On traduit les décisions, on ne recopie pas le HTML.

**RÈGLE 2 — Le périmètre du dépôt se contrôle côté requête, jamais côté affichage.**
Un dépôt qui devine un `vehicleId` ne doit rien obtenir. Filtrer dans le template est une faille, pas une protection.

**RÈGLE 3 — Une couleur = une signification.**
vert = succès/actif · rouge = échec/danger · ambre = attente/à vérifier · bleu = information · violet = IA/super-admin/dépôt · gris = inactif.

---

## Ce qui n'est pas dans ce livrable

- Les routes `admin/*` gardées par `superAdminGuard` — hors périmètre client
- La facturation du rôle dépôt — à définir commercialement
- L'application mobile native — les déclinaisons iOS/Android décrivent la PWA sur chaque plateforme

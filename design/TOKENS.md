# Jetons de couleur — maquette → application

> Étape 0 du livrable (`B0-SOCLE.md` § « Écart 2 »). Table de correspondance exhaustive
> entre les variables CSS des maquettes et le système du dépôt.
>
> **Aucun écran ne recopie une valeur hexadécimale d'une maquette.** On traduit vers la
> colonne de droite.

---

## Comment le système est construit

Le dépôt n'a pas de fichier de configuration Tailwind : il utilise **Tailwind 4**, dont la
configuration vit dans `apps/web/src/styles.css`. Trois couches :

1. **`@theme`** (`styles.css:12-26`) — les valeurs de marque, qui deviennent des classes
   utilitaires. `--color-tracky` → `bg-tracky`, `text-tracky`.
2. **`@theme inline`** (`styles.css:28-37`) — les alias sémantiques qui pointent vers les
   variables de thème. `--color-bg-primary` → `bg-bg-primary`.
3. **`:root` / `[data-theme='light']`** (`styles.css:39-93`) — les valeurs réelles, qui
   basculent avec le thème, plus des alias en nom court (`--bg-primary`, `--fg-primary`…)
   utilisés directement dans les styles de composants.

Une même couleur est donc atteignable de trois façons : la classe utilitaire
(`text-fg-secondary`), la variable longue (`var(--text-secondary)`) ou l'alias court
(`var(--fg-secondary)`). **Préférer la classe utilitaire** dans les templates, la variable
dans les blocs `styles:` des composants.

---

## La table de correspondance

### Fonds

| Maquette | Application | Classe Tailwind | Sombre | Clair |
|---|---|---|---|---|
| `--bg` | `--surface-primary` · alias `--bg-primary` | `bg-bg-primary` | `#080B0A` | `#FBFCFB` |
| `--bg2` | `--surface-rail` | *(pas de classe — `var()` directe)* | `#0B0F0E` | `#F2F5F3` |
| `--surface` | `--surface-secondary` · alias `--bg-secondary` | `bg-bg-secondary` | `#101514` | `#FFFFFF` |
| `--surface2` | `--surface-tertiary` · alias `--bg-tertiary` | `bg-bg-tertiary` | `#161D1B` | `#F6F9F7` |
| `--surface3` | *(pas d'équivalent — cf. point ouvert O1)* | — | — | — |

`--bg2` est le fond du rail de navigation et de la barre du haut. Le commentaire de
`styles.css:44` le nomme explicitement « DS bg-2 » : la correspondance est celle voulue à
l'origine, pas une approximation.

### Bordures

| Maquette | Application | Classe Tailwind | Sombre | Clair |
|---|---|---|---|---|
| `--border` | `--border-color` · alias `--border-subtle` | `border-border-subtle` | `rgba(255,255,255,.08)` | `rgba(10,25,18,.09)` |
| `--border2` | `--border-strong-color` · alias `--border-strong` | `border-border-strong` | `rgba(255,255,255,.14)` | `rgba(10,25,18,.16)` |

Les bordures sont en alpha, pas en opaque : elles se posent sur n'importe quelle surface
sans recalcul. Ne pas les remplacer par des hex.

### Texte

| Maquette | Application | Classe Tailwind | Sombre | Clair |
|---|---|---|---|---|
| `--tx` | `--text-primary` · alias `--fg-primary` | `text-fg-primary` | `#EAEFED` | `#0A1311` |
| `--tx2` | `--text-secondary` · alias `--fg-secondary` | `text-fg-secondary` | `#9BA5A1` | `#56635E` |
| `--tx3` | `--text-tertiary` · alias `--fg-tertiary` | `text-fg-tertiary` | `#69736E` | `#8A938F` |

`--tx3` porte le pied de menu « Propulsé par Vizyo Tracky » à 12 px (A1 § 5, A3 § 7).

### Accent — le vert de marque

| Maquette | Application | Classe Tailwind | Sombre | Clair |
|---|---|---|---|---|
| `--accent` | `--color-tracky-light` · alias `--tracky-light` | `bg-tracky-light` `text-tracky-light` | `#10E0A0` | `#0A9E6C` |
| `--accent2` | `--color-tracky-dark` · alias `--tracky-dark` | `bg-tracky-dark` | `#047857` | `#047857` |
| `--accent-soft` | `color-mix(in srgb, var(--color-tracky-light) 12%, transparent)` | *(motif, pas de classe)* | — | — |
| `--accent-ink` | `--accent-ink` | `text-[var(--accent-ink)]` | `#04130D` | ⚠️ cf. § « non négociable » |

`--color-tracky` et `--color-tracky-light` portent la même valeur — le premier est le nom
historique, le second celui employé dans le code récent. Utiliser `--color-tracky-light`.

Le lavis d'accent (`--accent-soft`) n'est pas un jeton mais un **motif** déjà établi dans
`styles.css` : `color-mix(in srgb, <couleur> 12%, transparent)` pour un fond,
`… 26-28%, transparent` pour une bordure. Voir `.vt-icon-tile` (`styles.css:1062`) et
`.vt-status--on` (`styles.css:1081`). Reprendre ce motif, ne pas inventer d'opacité.

### Rouge — échec, danger, retard

| Maquette | Application | Sombre | Clair |
|---|---|---|---|
| `--red` | `--danger` | `#F2706B` | `#D9544E` |
| `--red-soft` | `color-mix(in srgb, var(--danger) 12%, transparent)` | — | — |

Motifs prêts : `.vt-status--danger`, `.vt-icon-tile--danger`.

### Ambre — attente, à vérifier

| Maquette | Application | Sombre | Clair |
|---|---|---|---|
| `--amber` | `--warning` | `#F5B33D` | `#C98708` |
| `--amber-soft` | `color-mix(in srgb, var(--warning) 12%, transparent)` | — | — |

Motifs prêts : `.vt-status--warning`, `.vt-icon-tile--warning`.

### Violet — IA, super-admin, **dépôt** · ⚠️ à créer

| Maquette | Application | Sombre | Clair |
|---|---|---|---|
| `--violet` | `--violet` *(nouveau)* | `#A78BFA` | `#7C3AED` |
| `--violet-soft` | `color-mix(in srgb, var(--violet) 12%, transparent)` | — | — |

### Bleu — information · ⚠️ à créer

| Maquette | Application | Sombre | Clair |
|---|---|---|---|
| `--blue` | `--blue` *(nouveau)* | `#38BDF8` | `#0369A1` |
| `--blue-soft` | `color-mix(in srgb, var(--blue) 12%, transparent)` | — | — |

### Gris — inactif, indisponible

Pas de jeton dédié : le gris est porté par les surfaces et les textes secondaires /
tertiaires. Un élément inactif prend `--surface-tertiary` en fond et `--text-tertiary` en
texte — motif `.vt-status--offline` (`styles.css:1088`).

### Squelettes de chargement

| Rôle | Variable | Sombre | Clair |
|---|---|---|---|
| Base | `--sk` | `rgba(255,255,255,.06)` | `rgba(10,25,18,.055)` |
| Reflet du balayage | `--sk-hi` | `rgba(255,255,255,.10)` | `rgba(10,25,18,.085)` |

Primitive `.sk` (`styles.css:990`). Règle du kit : **squelette, jamais rond de chargement**.

---

## Les deux points non négociables de B0

### 1 — `--accent-ink` : l'encre sur fond accent doit être foncée

B0 le pose sans nuance : « Sur un fond `--accent` (vert vif), l'encre doit être foncée,
jamais blanche. L'erreur inverse a été commise sur 4 tuiles pendant la conception :
contraste tombé à 1,72:1. »

**Ce chiffre se vérifie exactement sur la palette du dépôt.** Blanc sur `#10E0A0` (l'accent
du thème sombre) donne **1,72:1**. La règle de B0 est née de cette palette précise.

**Contrastes mesurés** (WCAG 2.1, calcul sur les valeurs réelles de `styles.css`) :

| Thème | Fond accent | Encre | Contraste | Verdict |
|---|---|---|---|:-:|
| Sombre | `#10E0A0` | `#04130D` *(actuel)* | **11,04:1** | ✅ |
| Sombre | `#10E0A0` | `#FFFFFF` | 1,72:1 | ❌ le cas cité par B0 |
| **Clair** | `#0A9E6C` | `#FFFFFF` *(actuel)* | **3,43:1** | ❌ **sous le seuil** |
| **Clair** | `#0A9E6C` | `#04130D` | **5,54:1** | ✅ |

> ⚠️ **Défaut relevé.** Le thème **sombre** applique correctement la règle. Le thème
> **clair** ne l'applique pas : `styles.css:69` déclare `--accent-ink: #FFFFFF`, soit
> **3,43:1** — sous le 4,5:1 exigé par le critère de recette n° 6 de `B1-PAGES.md`.
>
> 43 usages de `--accent-ink` sont concernés : boutons primaires, avatars, pastilles d'état.
> Le jeton étant unique, la correction se fait **en un seul endroit** et les 43 suivent.
>
> **Décision** : `--accent-ink` passe à `#04130D` en thème clair. C'est l'application de la
> règle que B0 déclare non négociable, et une correction d'accessibilité — pas un choix
> esthétique. Effet visible : en thème clair, le texte des boutons primaires passe du blanc
> au vert très foncé.

### 2 — Une couleur = une signification

| Couleur | Sens | Jeton |
|---|---|---|
| vert | succès, actif, à l'heure | `--color-tracky-light` |
| rouge | échec, danger, retard | `--danger` |
| ambre | attente, à vérifier | `--warning` |
| bleu | information | `--blue` *(à créer)* |
| violet | IA, super-admin, **dépôt** | `--violet` *(à créer)* |
| gris | inactif, indisponible | surfaces + `--text-tertiary` |

B0 : « Cette règle vaut plus que n'importe quelle valeur hexadécimale. »

**Conséquence directe sur le bloc A** — le violet est la couleur du dépôt :
- avatar d'un compte dépôt dans `/users` (A5 § 3)
- marqueur ◆ de la matrice de permissions (A5 § 4)
- marqueur tireté du dépôt de départ sur la carte live (A3 § 1)
- état *Dormant* du `connectivity-badge` (D7 dans `DECISIONS.md`)

**Conséquence sur le mode simplifié** — B1 § J : « Paramètres reste toujours dans le menu,
détaché, **en violet**, sous-titré *Revenir en interface complète*. »

---

## Ce qui est ajouté à `styles.css`

Bloc à insérer dans `:root, [data-theme='dark']` :

```css
  /* Violet — IA, super-admin, dépôt (B0 § Écart 2). 6,77:1 sur --surface-secondary. */
  --violet: #A78BFA;
  /* Bleu — information (B0 § Écart 2). 8,60:1 sur --surface-secondary. */
  --blue: #38BDF8;
```

Bloc à insérer dans `[data-theme='light']` :

```css
  --accent-ink: #04130D; /* était #FFFFFF — 3,43:1, sous le seuil (cf. TOKENS.md) */
  --violet: #7C3AED;     /* 5,70:1 sur --surface-secondary */
  --blue: #0369A1;       /* 5,93:1 sur --surface-secondary */
```

Contrastes mesurés sur `--surface-secondary` (`#101514` en sombre, `#FFFFFF` en clair), la
surface des cartes — celle sur laquelle ces couleurs apparaissent réellement.

Les déclinaisons `-soft` ne sont **pas** déclarées comme jetons : elles suivent le motif
`color-mix` déjà établi, ce qui évite de doubler chaque couleur.

---

## Points ouverts

**O1 — `--surface3` n'a pas d'équivalent.** Le dépôt s'arrête à trois niveaux de surface
(`primary`, `secondary`, `tertiary`) plus le rail. Les maquettes en déclarent un quatrième.
Aucun écran du bloc A n'en a besoin. **Décision différée** : le jeton ne sera créé que si
une maquette du bloc B prouve son usage — créer un niveau d'élévation que personne n'emploie
est du bruit. En attendant, `--surface3` se lit comme `--surface-tertiary`.

**O2 — `--danger` et `--warning` en thème clair sont sous 4,5:1.** Mesurés sur
`--surface-secondary` clair : `--danger` `#D9544E` → **3,94:1**, `--warning` `#C98708` →
**3,02:1**. Tous deux passent le seuil 3:1 des composants d'interface mais échouent celui du
texte. B0 ne les mentionne pas, et les corriger déplacerait la palette d'alerte de toute
l'application — hors périmètre de l'étape 0. **À trancher au lot B-kit**, quand les
maquettes diront quelles valeurs elles portent.

**O3 — `#3b82f6` en dur dans `.tk-popup-btn--info`** (`styles.css:888`). C'est le seul bleu
du dépôt aujourd'hui, hors jeton. À basculer sur `--blue` au lot B0′, avec les autres
couleurs en dur.

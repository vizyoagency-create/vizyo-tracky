# VIZYO Manager — Direction Artistique (Couleurs & Gradients)

> **Mission** : Refonte visuelle complète de Vizyo Manager pour l'aligner avec la nouvelle identité violette du logo. Ce fichier remplace **toutes** les couleurs et gradients existants. Conserver la typographie (DM Sans), les espacements, rayons, et structure UI actuels.

> **Inspiration** : Vizyo Tracky (même ambiance dark moderne, glow doux, surfaces stratifiées) — adaptée au violet de marque.

---

## 1. Couleur primaire (extraite du logo)

| Token | Hex | Usage |
|---|---|---|
| `--primary` | `#7C5CFA` | Violet de marque, boutons primaires, liens actifs, focus |
| `--primary-hover` | `#6B4AE8` | État hover |
| `--primary-active` | `#5A3DD1` | État pressed |
| `--primary-soft` | `rgba(124, 92, 250, 0.10)` | Backgrounds subtils (badges, hover rows) |
| `--primary-glow` | `rgba(124, 92, 250, 0.06)` | Aura focus inputs, halos |

> **Source** : Le `#7C5CFA` est le point milieu visuel du gradient logo (`#A78BFA` → `#4338CA`). Il sert d'ancre quand un aplat est requis (icônes, dots, accents inline).

---

## 2. Gradient signature

Direction et stops repris **à l'identique** du SVG du logo.

```css
--gradient-primary: linear-gradient(45deg, #A78BFA 0%, #4338CA 100%);
```

### Variantes officielles

```css
/* Diagonal — défaut, boutons & CTA hero */
--gradient-primary: linear-gradient(45deg, #A78BFA 0%, #4338CA 100%);

/* Vertical — bandeaux, hero sections */
--gradient-primary-v: linear-gradient(180deg, #A78BFA 0%, #4338CA 100%);

/* Horizontal — barres de progression, séparateurs accent */
--gradient-primary-h: linear-gradient(90deg, #A78BFA 0%, #4338CA 100%);

/* Soft — surfaces décoratives, cards premium */
--gradient-primary-soft: linear-gradient(135deg, rgba(167, 139, 250, 0.12) 0%, rgba(67, 56, 202, 0.18) 100%);

/* Hover (CTA) — légèrement plus saturé */
--gradient-primary-hover: linear-gradient(45deg, #9575F8 0%, #3A30B8 100%);

/* Conique pour avatars / badges premium */
--gradient-primary-conic: conic-gradient(from 180deg at 50% 50%, #A78BFA, #4338CA, #A78BFA);
```

### Règles d'application

| Élément | Gradient ou Aplat |
|---|---|
| Boutons primaires (`btn-primary`) | **Gradient** (`--gradient-primary`) |
| Logo lockup interface | **Gradient** |
| Liens / textes accentués | **Aplat** `--primary` |
| Icônes inline | **Aplat** `--primary` |
| Badges actifs | **Aplat** `--primary` + bg `--primary-soft` |
| Onglet actif (border-bottom) | **Aplat** `--primary` |
| Bordure focus inputs | **Aplat** `--primary` + glow `--primary-glow` |
| Hero / CTA section bg | **Soft gradient** (`--gradient-primary-soft`) |
| Progress bars | **Gradient horizontal** |
| Avatars utilisateurs sans photo | **Gradient conique** |

> **Anti-pattern** : ne **jamais** appliquer le gradient sur du texte de paragraphe (illisible). Réservé titres hero, logos, surfaces.

---

## 3. Échelle violette complète

À utiliser pour les nuances (badges, états, hiérarchie). Inspirée Tailwind `violet` ajustée pour matcher le logo.

```css
--violet-50:  #F5F2FF;
--violet-100: #ECE5FF;
--violet-200: #D9CCFF;
--violet-300: #BDA8FA;
--violet-400: #A78BFA;  /* stop clair du gradient logo */
--violet-500: #7C5CFA;  /* primary */
--violet-600: #6B4AE8;
--violet-700: #5A3DD1;
--violet-800: #4338CA;  /* stop foncé du gradient logo */
--violet-900: #322995;
--violet-950: #1E1A5C;
```

---

## 4. Surfaces & fond (refonte dark theme)

L'ambiance reste dark mais **bascule du bleu nuit vers un noir bleuté tirant violet** pour résonner avec la couleur de marque.

```css
/* Backgrounds */
--bg:           #0A0814;   /* fond global, presque noir avec teinte violette */
--bg-2:         #0F0C1F;   /* sections alternées, panneaux */
--bg-3:         #14102B;   /* zones surélevées, dropdowns */

/* Surfaces (cartes) */
--surface:        #15112E;   /* card par défaut */
--surface-hover:  #1B1638;   /* card au hover */
--surface-elevated: #1F1A42; /* modal, popover */

/* Bordures */
--border:        #261F4F;    /* bordure standard */
--border-strong: #322A66;    /* bordure mise en évidence */
--border-subtle: #1A1539;    /* bordure très discrète */

/* Inputs */
--input-bg:     #0E0B22;
--input-border: #261F4F;
--input-border-focus: var(--primary);
```

### Mapping ancien → nouveau

| Ancien (bleu) | Nouveau (violet) |
|---|---|
| `--bg: #060a1a` | `--bg: #0A0814` |
| `--bg2: #0a0f25` | `--bg-2: #0F0C1F` |
| `--card: #0d1538` | `--surface: #15112E` |
| `--border: #1a2555` | `--border: #261F4F` |
| `--border-light: #1e2d60` | `--border-strong: #322A66` |
| `--input-bg: #080e28` | `--input-bg: #0E0B22` |
| `--input-border: #1a2555` | `--input-border: #261F4F` |

---

## 5. Texte

```css
--text:       #F1EEFF;   /* titres, texte principal — légère teinte violette */
--text-2:     #CFC8E6;   /* texte secondaire */
--text-muted: #7B7299;   /* labels, placeholders forts */
--text-dim:   #4D4670;   /* texte très discret, footer */
--text-on-primary: #FFFFFF;  /* sur fond gradient/primary */
```

### Mapping ancien → nouveau

| Ancien | Nouveau |
|---|---|
| `--text: #e2e8f0` | `--text: #F1EEFF` |
| `--text2: #cbd5e1` | `--text-2: #CFC8E6` |
| `--text-muted: #64748b` | `--text-muted: #7B7299` |
| `--text-dim: #3a4a6b` | `--text-dim: #4D4670` |

---

## 6. Couleurs sémantiques

Calibrées pour rester **lisibles sur fond violet sombre** et harmonieuses avec la marque.

```css
/* Success — vert émeraude (peu modifié, déjà harmonieux) */
--success:        #22C55E;
--success-soft:   rgba(34, 197, 94, 0.10);
--success-border: rgba(34, 197, 94, 0.30);

/* Warning — ambre tirant chaud */
--warning:        #F59E0B;
--warning-soft:   rgba(245, 158, 11, 0.10);
--warning-border: rgba(245, 158, 11, 0.30);

/* Error — rouge corail */
--error:          #EF4444;
--error-soft:     rgba(239, 68, 68, 0.10);
--error-border:   rgba(239, 68, 68, 0.30);

/* Info — cyan (contraste avec le violet, pas de conflit) */
--info:           #06B6D4;
--info-soft:      rgba(6, 182, 212, 0.10);
--info-border:    rgba(6, 182, 212, 0.30);
```

> **Règle** : ne **jamais** utiliser de bleu dans l'app (conflit identitaire avec la marque). Le seul bleu autorisé est `--info` (cyan), uniquement pour les alertes informatives.

---

## 7. Glows, halos & shadows colorées

```css
/* Glow boutons primaires (ambiance Tracky) */
--glow-primary:        0 0 40px rgba(124, 92, 250, 0.35);
--glow-primary-strong: 0 0 60px rgba(124, 92, 250, 0.50);

/* Shadow standards */
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.40);
--shadow:    0 4px 12px rgba(0, 0, 0, 0.40);
--shadow-md: 0 8px 24px rgba(0, 0, 0, 0.45);
--shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.50);

/* Shadow teintées violet pour cartes premium / modal */
--shadow-primary:    0 8px 32px rgba(67, 56, 202, 0.25);
--shadow-primary-lg: 0 20px 60px rgba(67, 56, 202, 0.35);

/* Ring focus accessible */
--ring-focus: 0 0 0 3px rgba(124, 92, 250, 0.35);
```

### Application

- Bouton primaire au hover → ajouter `box-shadow: var(--glow-primary)`
- Modal / dropdown → `box-shadow: var(--shadow-md), var(--shadow-primary)`
- Input focus → `box-shadow: var(--ring-focus)` (remplace l'outline)

---

## 8. Radial gradients d'ambiance (background pages)

Pour les pages clés (login, dashboard, hero), ajouter ces halos **derrière** le contenu pour donner de la profondeur.

```css
/* Halo principal — top-left */
.page::before {
  content: '';
  position: absolute;
  top: -40%;
  left: -20%;
  width: 700px;
  height: 700px;
  background: radial-gradient(circle, rgba(124, 92, 250, 0.10) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

/* Halo secondaire — bottom-right (teinte indigo profond) */
.page::after {
  content: '';
  position: absolute;
  bottom: -30%;
  right: -10%;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(67, 56, 202, 0.08) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}
```

### Grille décorative (login, pages vides)

```css
.grid-bg {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(124, 92, 250, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(124, 92, 250, 0.04) 1px, transparent 1px);
  background-size: 60px 60px;
  pointer-events: none;
  mask-image: radial-gradient(ellipse at center, black 40%, transparent 80%);
}
```

---

## 9. Bloc CSS variables — copier-coller intégral

À placer dans `:root` (ou `styles.css` global Angular).

```css
:root {
  /* ===== PRIMARY (violet de marque) ===== */
  --primary:        #7C5CFA;
  --primary-hover:  #6B4AE8;
  --primary-active: #5A3DD1;
  --primary-soft:   rgba(124, 92, 250, 0.10);
  --primary-glow:   rgba(124, 92, 250, 0.06);

  /* ===== GRADIENTS ===== */
  --gradient-primary:        linear-gradient(45deg, #A78BFA 0%, #4338CA 100%);
  --gradient-primary-v:      linear-gradient(180deg, #A78BFA 0%, #4338CA 100%);
  --gradient-primary-h:      linear-gradient(90deg, #A78BFA 0%, #4338CA 100%);
  --gradient-primary-soft:   linear-gradient(135deg, rgba(167, 139, 250, 0.12) 0%, rgba(67, 56, 202, 0.18) 100%);
  --gradient-primary-hover:  linear-gradient(45deg, #9575F8 0%, #3A30B8 100%);
  --gradient-primary-conic:  conic-gradient(from 180deg at 50% 50%, #A78BFA, #4338CA, #A78BFA);

  /* ===== ÉCHELLE VIOLET ===== */
  --violet-50:  #F5F2FF;
  --violet-100: #ECE5FF;
  --violet-200: #D9CCFF;
  --violet-300: #BDA8FA;
  --violet-400: #A78BFA;
  --violet-500: #7C5CFA;
  --violet-600: #6B4AE8;
  --violet-700: #5A3DD1;
  --violet-800: #4338CA;
  --violet-900: #322995;
  --violet-950: #1E1A5C;

  /* ===== SURFACES ===== */
  --bg:               #0A0814;
  --bg-2:             #0F0C1F;
  --bg-3:             #14102B;
  --surface:          #15112E;
  --surface-hover:    #1B1638;
  --surface-elevated: #1F1A42;

  /* ===== BORDURES ===== */
  --border:        #261F4F;
  --border-strong: #322A66;
  --border-subtle: #1A1539;

  /* ===== INPUTS ===== */
  --input-bg:           #0E0B22;
  --input-border:       #261F4F;
  --input-border-focus: var(--primary);

  /* ===== TEXTE ===== */
  --text:            #F1EEFF;
  --text-2:          #CFC8E6;
  --text-muted:      #7B7299;
  --text-dim:        #4D4670;
  --text-on-primary: #FFFFFF;

  /* ===== SÉMANTIQUE ===== */
  --success: #22C55E; --success-soft: rgba(34, 197, 94, 0.10); --success-border: rgba(34, 197, 94, 0.30);
  --warning: #F59E0B; --warning-soft: rgba(245, 158, 11, 0.10); --warning-border: rgba(245, 158, 11, 0.30);
  --error:   #EF4444; --error-soft:   rgba(239, 68, 68, 0.10); --error-border:   rgba(239, 68, 68, 0.30);
  --info:    #06B6D4; --info-soft:    rgba(6, 182, 212, 0.10); --info-border:    rgba(6, 182, 212, 0.30);

  /* ===== EFFETS ===== */
  --glow-primary:        0 0 40px rgba(124, 92, 250, 0.35);
  --glow-primary-strong: 0 0 60px rgba(124, 92, 250, 0.50);
  --shadow-sm:           0 1px 2px rgba(0, 0, 0, 0.40);
  --shadow:              0 4px 12px rgba(0, 0, 0, 0.40);
  --shadow-md:           0 8px 24px rgba(0, 0, 0, 0.45);
  --shadow-lg:           0 16px 48px rgba(0, 0, 0, 0.50);
  --shadow-primary:      0 8px 32px rgba(67, 56, 202, 0.25);
  --shadow-primary-lg:   0 20px 60px rgba(67, 56, 202, 0.35);
  --ring-focus:          0 0 0 3px rgba(124, 92, 250, 0.35);
}
```

---

## 10. Configuration Tailwind

À fusionner dans `tailwind.config.ts`.

```ts
import type { Config } from 'tailwindcss';

export default {
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#7C5CFA',
          hover:   '#6B4AE8',
          active:  '#5A3DD1',
          soft:    'rgba(124, 92, 250, 0.10)',
        },
        violet: {
          50:  '#F5F2FF',
          100: '#ECE5FF',
          200: '#D9CCFF',
          300: '#BDA8FA',
          400: '#A78BFA',
          500: '#7C5CFA',
          600: '#6B4AE8',
          700: '#5A3DD1',
          800: '#4338CA',
          900: '#322995',
          950: '#1E1A5C',
        },
        bg: {
          DEFAULT: '#0A0814',
          2:       '#0F0C1F',
          3:       '#14102B',
        },
        surface: {
          DEFAULT:  '#15112E',
          hover:    '#1B1638',
          elevated: '#1F1A42',
        },
        border: {
          DEFAULT: '#261F4F',
          strong:  '#322A66',
          subtle:  '#1A1539',
        },
        text: {
          DEFAULT: '#F1EEFF',
          2:       '#CFC8E6',
          muted:   '#7B7299',
          dim:     '#4D4670',
        },
        success: '#22C55E',
        warning: '#F59E0B',
        error:   '#EF4444',
        info:    '#06B6D4',
      },
      backgroundImage: {
        'gradient-primary':       'linear-gradient(45deg, #A78BFA 0%, #4338CA 100%)',
        'gradient-primary-v':     'linear-gradient(180deg, #A78BFA 0%, #4338CA 100%)',
        'gradient-primary-h':     'linear-gradient(90deg, #A78BFA 0%, #4338CA 100%)',
        'gradient-primary-soft':  'linear-gradient(135deg, rgba(167, 139, 250, 0.12) 0%, rgba(67, 56, 202, 0.18) 100%)',
        'gradient-primary-hover': 'linear-gradient(45deg, #9575F8 0%, #3A30B8 100%)',
      },
      boxShadow: {
        'glow-primary':        '0 0 40px rgba(124, 92, 250, 0.35)',
        'glow-primary-strong': '0 0 60px rgba(124, 92, 250, 0.50)',
        'primary':             '0 8px 32px rgba(67, 56, 202, 0.25)',
        'primary-lg':          '0 20px 60px rgba(67, 56, 202, 0.35)',
        'ring-primary':        '0 0 0 3px rgba(124, 92, 250, 0.35)',
      },
    },
  },
} satisfies Config;
```

---

## 11. Migration : table de remplacement

À exécuter sur **toute la codebase** Angular et HTML maquettes.

| Recherche (ancien) | Remplacement (nouveau) |
|---|---|
| `#3772ff` | `#7C5CFA` |
| `#2b5fd9` | `#5A3DD1` |
| `rgba(55,114,255,` | `rgba(124, 92, 250,` |
| `rgba(55, 114, 255,` | `rgba(124, 92, 250,` |
| `--blue:` | `--primary:` |
| `--blue-soft:` | `--primary-soft:` |
| `--blue-glow:` | `--primary-glow:` |
| `var(--blue)` | `var(--primary)` |
| `var(--blue-soft)` | `var(--primary-soft)` |
| `var(--blue-glow)` | `var(--primary-glow)` |
| `linear-gradient(135deg,var(--blue),#2b5fd9)` | `var(--gradient-primary)` |
| `linear-gradient(135deg, #3772ff, #2b5fd9)` | `var(--gradient-primary)` |
| `--bg:#060a1a` | `--bg:#0A0814` |
| `--card:#0d1538` | `--surface:#15112E` |
| `--border:#1a2555` | `--border:#261F4F` |

### Commande sed (à adapter par fichier)

```bash
# Dossier front Angular
cd vizyo-manager-frontend

# Remplacements globaux
find src -type f \( -name "*.scss" -o -name "*.css" -o -name "*.ts" -o -name "*.html" \) -exec sed -i \
  -e 's/#3772ff/#7C5CFA/gi' \
  -e 's/#2b5fd9/#5A3DD1/gi' \
  -e 's/rgba(55,\s*114,\s*255,/rgba(124, 92, 250,/g' \
  -e 's/--blue:/--primary:/g' \
  -e 's/--blue-soft:/--primary-soft:/g' \
  -e 's/--blue-glow:/--primary-glow:/g' \
  -e 's/var(--blue)/var(--primary)/g' \
  -e 's/var(--blue-soft)/var(--primary-soft)/g' \
  -e 's/var(--blue-glow)/var(--primary-glow)/g' \
  {} \;
```

---

## 12. Logos — fichiers source

Les SVG livrés (à placer dans `src/assets/logos/`) :

| Fichier | Usage |
|---|---|
| `vizyo-manager-icon-purple.svg` | Favicon, app icon, splash |
| `vizyo-manager-icon-purple-lockup-gradient-purple.svg` | Sidebar nav, header (fond clair) |
| `vizyo-manager-icon-purple-lockup-gradient-white.svg` | Header (fond gradient/foncé) |
| `vizyo-manager-icon-purple-lockup-gradient-black.svg` | Documents, exports PDF |
| `vizyo-manager-icon-purple-lockup-gradient-gradient-purple.svg` | Login, écrans hero |

**Règle** : ne **jamais** recolorer le logo via CSS `filter`. Toujours utiliser la variante adéquate.

---

## 13. Checklist d'application (pour Claude Code)

- [ ] Remplacer `:root` dans `src/styles.css` par le bloc §9
- [ ] Mettre à jour `tailwind.config.ts` avec le snippet §10
- [ ] Exécuter le `sed` de migration §11
- [ ] Copier les SVG du logo dans `src/assets/logos/`
- [ ] Remplacer les `<div class="logo-icon">M</div>` placeholders par `<img src="/assets/logos/vizyo-manager-icon-purple-lockup-gradient-purple.svg" alt="Vizyo Manager">`
- [ ] Vérifier que tous les boutons primaires utilisent `background: var(--gradient-primary)` (pas l'aplat)
- [ ] Vérifier focus states inputs : `border-color: var(--primary)` + `box-shadow: var(--ring-focus)`
- [ ] Ajouter les radial gradients d'ambiance §8 sur : login, dashboard home, vizyo-leads
- [ ] Build et vérifier qu'aucun bleu (`#3772ff`, `#2b5fd9`, `--blue`) ne subsiste : `grep -rn "blue\|3772ff\|2b5fd9" src/`
- [ ] Mettre à jour `theme-color` dans `index.html` : `<meta name="theme-color" content="#7C5CFA">`
- [ ] Mettre à jour favicon avec `vizyo-manager-icon-purple.svg`

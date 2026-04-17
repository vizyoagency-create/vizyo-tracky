# VIZYO Leads — Direction Artistique (Couleurs & Gradients)

> **Mission** : Refonte visuelle de Vizyo Leads pour l'aligner avec la nouvelle identité orange du logo. Ce fichier remplace **toutes** les couleurs et gradients existants. Conserver la typographie (DM Sans), les espacements, rayons, et structure UI actuels.

> **Cohérence** : Même structure et philosophie que la DA Vizyo Manager (fichier `VIZYO_MANAGER_DA_COLORS.md`). Seule la couleur primaire change. Les deux produits doivent se reconnaître comme une famille.

---

## 1. Couleur primaire (extraite du logo)

| Token | Hex | Usage |
|---|---|---|
| `--primary` | `#FF6A00` | Orange de marque, boutons primaires, liens actifs, focus |
| `--primary-hover` | `#F15E00` | État hover |
| `--primary-active` | `#D94F00` | État pressed |
| `--primary-soft` | `rgba(255, 106, 0, 0.10)` | Backgrounds subtils (badges, hover rows) |
| `--primary-glow` | `rgba(255, 106, 0, 0.06)` | Aura focus inputs, halos |

> **Source** : Le `#FF6A00` est le point milieu visuel du gradient logo (`#FF8C00` → `#FF4500`). Il sert d'ancre quand un aplat est requis (icônes, dots, accents inline).

---

## 2. Gradient signature

Direction et stops repris **à l'identique** du SVG du logo.

```css
--gradient-primary: linear-gradient(45deg, #FF8C00 0%, #FF4500 100%);
```

### Variantes officielles

```css
/* Diagonal — défaut, boutons & CTA hero */
--gradient-primary: linear-gradient(45deg, #FF8C00 0%, #FF4500 100%);

/* Vertical — bandeaux, hero sections */
--gradient-primary-v: linear-gradient(180deg, #FF8C00 0%, #FF4500 100%);

/* Horizontal — barres de progression, séparateurs accent */
--gradient-primary-h: linear-gradient(90deg, #FF8C00 0%, #FF4500 100%);

/* Soft — surfaces décoratives, cards premium */
--gradient-primary-soft: linear-gradient(135deg, rgba(255, 140, 0, 0.12) 0%, rgba(255, 69, 0, 0.18) 100%);

/* Hover (CTA) — légèrement plus saturé / dense */
--gradient-primary-hover: linear-gradient(45deg, #FF7A00 0%, #E03D00 100%);

/* Conique pour avatars / badges premium */
--gradient-primary-conic: conic-gradient(from 180deg at 50% 50%, #FF8C00, #FF4500, #FF8C00);
```

### Règles d'application

| Élément | Gradient ou Aplat |
|---|---|
| Boutons primaires (`btn-primary`) | **Gradient** (`--gradient-primary`) |
| Logo lockup interface | **Gradient** (utiliser SVG source, ne pas recolorer en CSS) |
| Liens / textes accentués | **Aplat** `--primary` |
| Icônes inline | **Aplat** `--primary` |
| Badges actifs (statut lead) | **Aplat** `--primary` + bg `--primary-soft` |
| Onglet actif (border-bottom) | **Aplat** `--primary` |
| Bordure focus inputs | **Aplat** `--primary` + glow `--primary-glow` |
| Hero / CTA section bg | **Soft gradient** (`--gradient-primary-soft`) |
| Progress bars (ex: pipeline lead) | **Gradient horizontal** |
| Avatars utilisateurs sans photo | **Gradient conique** |

> **Anti-pattern** : ne **jamais** appliquer le gradient sur du texte de paragraphe (illisible). Réservé titres hero, logos, surfaces.

> **Attention** : l'orange est très saturé. Limiter les grandes surfaces en aplat `--primary` — privilégier toujours le gradient ou les versions `soft`.

---

## 3. Échelle orange complète

À utiliser pour les nuances (badges, états, hiérarchie).

```css
--orange-50:  #FFF4EB;
--orange-100: #FFE4CC;
--orange-200: #FFC899;
--orange-300: #FFA866;
--orange-400: #FF8C00;  /* stop clair du gradient logo */
--orange-500: #FF6A00;  /* primary */
--orange-600: #F15E00;
--orange-700: #D94F00;
--orange-800: #FF4500;  /* stop foncé du gradient logo */
--orange-900: #B33400;
--orange-950: #6E1F00;
```

---

## 4. Surfaces & fond (dark theme)

L'ambiance reste dark **neutre/froide** pour faire ressortir l'orange. Contrairement au Manager (teinte violette), les surfaces de Leads gardent un bleu nuit froid — l'orange chaud ressort mieux sur fond froid que sur fond chaud.

```css
/* Backgrounds */
--bg:           #0A0E1A;   /* fond global, noir tirant bleu froid */
--bg-2:         #0F1424;   /* sections alternées, panneaux */
--bg-3:         #141A30;   /* zones surélevées, dropdowns */

/* Surfaces (cartes) */
--surface:          #151B33;   /* card par défaut */
--surface-hover:    #1B2240;   /* card au hover */
--surface-elevated: #1F2749;   /* modal, popover */

/* Bordures */
--border:        #252E55;   /* bordure standard */
--border-strong: #2F3A6B;   /* bordure mise en évidence */
--border-subtle: #1A2040;   /* bordure très discrète */

/* Inputs */
--input-bg:           #0E1326;
--input-border:       #252E55;
--input-border-focus: var(--primary);
```

### Philosophie

- **Manager** : surfaces violet profond (teinte primary assumée)
- **Leads** : surfaces bleu-nuit **neutres** (l'orange doit pop sans saturer)
- Les deux partagent la même structure, seule la température des surfaces diffère

---

## 5. Texte

```css
--text:       #E8ECF5;   /* titres, texte principal — neutre froid */
--text-2:     #C8CFDB;   /* texte secondaire */
--text-muted: #7B85A0;   /* labels, placeholders forts */
--text-dim:   #4D5674;   /* texte très discret, footer */
--text-on-primary: #FFFFFF;  /* sur fond gradient/primary */
```

> Les textes de Leads sont **neutres** (pas teintés orange) pour garder la lisibilité et laisser l'orange être l'unique accent visuel fort.

---

## 6. Couleurs sémantiques (attention conflit avec primary orange)

**Problème identifié** : `--warning` (habituellement ambre orangé) et `--error` (rouge) sont proches du primary orange. Risque de confusion visuelle.

**Solution** :
- `--warning` → décalé vers **jaune** (plus jaune, moins orange)
- `--error` → décalé vers **rouge framboise** (plus rouge, pas orangé)
- `--success` → vert émeraude inchangé
- `--info` → **bleu ciel** (parfait contraste avec l'orange, couleur complémentaire)

```css
/* Success — vert émeraude */
--success:        #22C55E;
--success-soft:   rgba(34, 197, 94, 0.10);
--success-border: rgba(34, 197, 94, 0.30);

/* Warning — JAUNE (décalé volontairement pour éviter conflit orange) */
--warning:        #FACC15;
--warning-soft:   rgba(250, 204, 21, 0.10);
--warning-border: rgba(250, 204, 21, 0.30);

/* Error — ROUGE FRAMBOISE (décalé vers le rose, hors palette orange) */
--error:          #E11D48;
--error-soft:     rgba(225, 29, 72, 0.10);
--error-border:   rgba(225, 29, 72, 0.30);

/* Info — bleu ciel (complémentaire de l'orange, excellent contraste) */
--info:           #38BDF8;
--info-soft:      rgba(56, 189, 248, 0.10);
--info-border:    rgba(56, 189, 248, 0.30);
```

### Règles strictes

- Ne **jamais** utiliser `--primary` (orange) pour signifier "warning" ou "attention" → confusion avec la marque
- `--info` bleu ciel est **acceptable** ici (complément colorimétrique) — c'est même un atout, il structure l'UI sans rivaliser avec le primary
- Pour un statut lead "en attente / à traiter" : utiliser `--warning` jaune, pas l'orange primary

---

## 7. Glows, halos & shadows colorées

```css
/* Glow boutons primaires */
--glow-primary:        0 0 40px rgba(255, 106, 0, 0.35);
--glow-primary-strong: 0 0 60px rgba(255, 106, 0, 0.50);

/* Shadow standards */
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.40);
--shadow:    0 4px 12px rgba(0, 0, 0, 0.40);
--shadow-md: 0 8px 24px rgba(0, 0, 0, 0.45);
--shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.50);

/* Shadow teintées orange pour cartes premium / modal (usage modéré) */
--shadow-primary:    0 8px 32px rgba(255, 69, 0, 0.20);
--shadow-primary-lg: 0 20px 60px rgba(255, 69, 0, 0.30);

/* Ring focus accessible */
--ring-focus: 0 0 0 3px rgba(255, 106, 0, 0.35);
```

> **Note** : utiliser les shadows teintées orange **avec parcimonie** (uniquement hero/modal clé). Sur un fond bleu-nuit, l'orange glow est très présent — ne pas saturer l'écran.

---

## 8. Radial gradients d'ambiance (background pages)

Pour les pages clés (login, dashboard, pipeline leads), ajouter ces halos **derrière** le contenu.

```css
/* Halo principal — top-left (orange saturé) */
.page::before {
  content: '';
  position: absolute;
  top: -40%;
  left: -20%;
  width: 700px;
  height: 700px;
  background: radial-gradient(circle, rgba(255, 106, 0, 0.08) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

/* Halo secondaire — bottom-right (orange profond / rouge) */
.page::after {
  content: '';
  position: absolute;
  bottom: -30%;
  right: -10%;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(255, 69, 0, 0.06) 0%, transparent 70%);
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
    linear-gradient(rgba(255, 106, 0, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 106, 0, 0.04) 1px, transparent 1px);
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
  /* ===== PRIMARY (orange de marque) ===== */
  --primary:        #FF6A00;
  --primary-hover:  #F15E00;
  --primary-active: #D94F00;
  --primary-soft:   rgba(255, 106, 0, 0.10);
  --primary-glow:   rgba(255, 106, 0, 0.06);

  /* ===== GRADIENTS ===== */
  --gradient-primary:        linear-gradient(45deg, #FF8C00 0%, #FF4500 100%);
  --gradient-primary-v:      linear-gradient(180deg, #FF8C00 0%, #FF4500 100%);
  --gradient-primary-h:      linear-gradient(90deg, #FF8C00 0%, #FF4500 100%);
  --gradient-primary-soft:   linear-gradient(135deg, rgba(255, 140, 0, 0.12) 0%, rgba(255, 69, 0, 0.18) 100%);
  --gradient-primary-hover:  linear-gradient(45deg, #FF7A00 0%, #E03D00 100%);
  --gradient-primary-conic:  conic-gradient(from 180deg at 50% 50%, #FF8C00, #FF4500, #FF8C00);

  /* ===== ÉCHELLE ORANGE ===== */
  --orange-50:  #FFF4EB;
  --orange-100: #FFE4CC;
  --orange-200: #FFC899;
  --orange-300: #FFA866;
  --orange-400: #FF8C00;
  --orange-500: #FF6A00;
  --orange-600: #F15E00;
  --orange-700: #D94F00;
  --orange-800: #FF4500;
  --orange-900: #B33400;
  --orange-950: #6E1F00;

  /* ===== SURFACES ===== */
  --bg:               #0A0E1A;
  --bg-2:             #0F1424;
  --bg-3:             #141A30;
  --surface:          #151B33;
  --surface-hover:    #1B2240;
  --surface-elevated: #1F2749;

  /* ===== BORDURES ===== */
  --border:        #252E55;
  --border-strong: #2F3A6B;
  --border-subtle: #1A2040;

  /* ===== INPUTS ===== */
  --input-bg:           #0E1326;
  --input-border:       #252E55;
  --input-border-focus: var(--primary);

  /* ===== TEXTE ===== */
  --text:            #E8ECF5;
  --text-2:          #C8CFDB;
  --text-muted:      #7B85A0;
  --text-dim:        #4D5674;
  --text-on-primary: #FFFFFF;

  /* ===== SÉMANTIQUE (décalées pour éviter conflit avec primary orange) ===== */
  --success: #22C55E; --success-soft: rgba(34, 197, 94, 0.10); --success-border: rgba(34, 197, 94, 0.30);
  --warning: #FACC15; --warning-soft: rgba(250, 204, 21, 0.10); --warning-border: rgba(250, 204, 21, 0.30);
  --error:   #E11D48; --error-soft:   rgba(225, 29, 72, 0.10); --error-border:   rgba(225, 29, 72, 0.30);
  --info:    #38BDF8; --info-soft:    rgba(56, 189, 248, 0.10); --info-border:    rgba(56, 189, 248, 0.30);

  /* ===== EFFETS ===== */
  --glow-primary:        0 0 40px rgba(255, 106, 0, 0.35);
  --glow-primary-strong: 0 0 60px rgba(255, 106, 0, 0.50);
  --shadow-sm:           0 1px 2px rgba(0, 0, 0, 0.40);
  --shadow:              0 4px 12px rgba(0, 0, 0, 0.40);
  --shadow-md:           0 8px 24px rgba(0, 0, 0, 0.45);
  --shadow-lg:           0 16px 48px rgba(0, 0, 0, 0.50);
  --shadow-primary:      0 8px 32px rgba(255, 69, 0, 0.20);
  --shadow-primary-lg:   0 20px 60px rgba(255, 69, 0, 0.30);
  --ring-focus:          0 0 0 3px rgba(255, 106, 0, 0.35);
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
          DEFAULT: '#FF6A00',
          hover:   '#F15E00',
          active:  '#D94F00',
          soft:    'rgba(255, 106, 0, 0.10)',
        },
        orange: {
          50:  '#FFF4EB',
          100: '#FFE4CC',
          200: '#FFC899',
          300: '#FFA866',
          400: '#FF8C00',
          500: '#FF6A00',
          600: '#F15E00',
          700: '#D94F00',
          800: '#FF4500',
          900: '#B33400',
          950: '#6E1F00',
        },
        bg: {
          DEFAULT: '#0A0E1A',
          2:       '#0F1424',
          3:       '#141A30',
        },
        surface: {
          DEFAULT:  '#151B33',
          hover:    '#1B2240',
          elevated: '#1F2749',
        },
        border: {
          DEFAULT: '#252E55',
          strong:  '#2F3A6B',
          subtle:  '#1A2040',
        },
        text: {
          DEFAULT: '#E8ECF5',
          2:       '#C8CFDB',
          muted:   '#7B85A0',
          dim:     '#4D5674',
        },
        success: '#22C55E',
        warning: '#FACC15',
        error:   '#E11D48',
        info:    '#38BDF8',
      },
      backgroundImage: {
        'gradient-primary':       'linear-gradient(45deg, #FF8C00 0%, #FF4500 100%)',
        'gradient-primary-v':     'linear-gradient(180deg, #FF8C00 0%, #FF4500 100%)',
        'gradient-primary-h':     'linear-gradient(90deg, #FF8C00 0%, #FF4500 100%)',
        'gradient-primary-soft':  'linear-gradient(135deg, rgba(255, 140, 0, 0.12) 0%, rgba(255, 69, 0, 0.18) 100%)',
        'gradient-primary-hover': 'linear-gradient(45deg, #FF7A00 0%, #E03D00 100%)',
      },
      boxShadow: {
        'glow-primary':        '0 0 40px rgba(255, 106, 0, 0.35)',
        'glow-primary-strong': '0 0 60px rgba(255, 106, 0, 0.50)',
        'primary':             '0 8px 32px rgba(255, 69, 0, 0.20)',
        'primary-lg':          '0 20px 60px rgba(255, 69, 0, 0.30)',
        'ring-primary':        '0 0 0 3px rgba(255, 106, 0, 0.35)',
      },
    },
  },
} satisfies Config;
```

---

## 11. Migration : table de remplacement

À exécuter sur **toute la codebase** Vizyo Leads (Angular + éventuelles maquettes HTML).

### Étape 1 — Audit préalable

Avant toute modification, identifier les couleurs actuelles du projet :

```bash
cd vizyo-leads-frontend

# Lister tous les codes couleur hex utilisés
grep -rhoE "#[0-9a-fA-F]{3,8}" src/ | sort -u

# Lister toutes les variables CSS custom
grep -rhoE "\-\-[a-z0-9-]+" src/styles.css src/**/*.scss 2>/dev/null | sort -u
```

→ Partager la liste avant migration pour mapper précisément ancien → nouveau.

### Étape 2 — Patterns à remplacer (à adapter après audit)

| Recherche (à adapter selon audit) | Remplacement |
|---|---|
| Ancien primary hex | `#FF6A00` |
| Ancien primary gradient | `var(--gradient-primary)` |
| `--brand:` / `--accent:` (si existant) | `--primary:` |
| `var(--brand)` / `var(--accent)` | `var(--primary)` |

### Étape 3 — Commande sed générique (après confirmation du mapping)

```bash
cd vizyo-leads-frontend

# Template à adapter avec les vraies couleurs identifiées à l'étape 1
find src -type f \( -name "*.scss" -o -name "*.css" -o -name "*.ts" -o -name "*.html" \) -exec sed -i \
  -e 's/ANCIEN_HEX_PRIMARY/#FF6A00/gi' \
  -e 's/ANCIEN_HEX_PRIMARY_DARK/#D94F00/gi' \
  {} \;
```

> **Règle** : ne **jamais** exécuter un sed aveugle. Toujours faire : audit → mapping → diff → commit atomique.

---

## 12. Logos — fichiers source

Les SVG livrés (à placer dans `src/assets/logos/`) :

| Fichier | Usage |
|---|---|
| `vizyo-leads-icon-orange.svg` | Favicon, app icon, splash |
| `vizyo-leads-icon-orange-lockup-orange.svg` | Sidebar nav, header (fond clair/sombre neutre) |
| `vizyo-leads-icon-orange-lockup-gradient-orange.svg` | Login, écrans hero |
| `vizyo-leads-icon-orange-lockup-white.svg` | Header sur fond gradient/orange foncé |
| `vizyo-leads-icon-orange-lockup-black.svg` | Documents, exports PDF, emails |

**Règles** :
- Ne **jamais** recolorer le logo via CSS `filter`. Toujours utiliser la variante adéquate.
- Le **viseur/crosshair** est un élément de marque distinctif (signature "targeting" / ciblage commercial). Toujours le conserver intact.

### Emails (contrainte Gmail-safe)

Pour les emails, utiliser **exclusivement** la variante `black` ou `orange` (aplat), **jamais** la variante gradient (non supportée par tous les clients mail).

```html
<!-- ✅ OK dans un email -->
<img src="https://manager.vizyoagency.com/assets/logos/vizyo-leads-icon-orange-lockup-orange.svg" alt="Vizyo Leads">

<!-- ❌ PAS dans un email -->
<img src=".../vizyo-leads-icon-orange-lockup-gradient-orange.svg" alt="Vizyo Leads">
```

---

## 13. Cohérence écosystème Vizyo

| Produit | Primary | Gradient | Surfaces |
|---|---|---|---|
| **Vizyo Manager** | `#7C5CFA` (violet) | `#A78BFA → #4338CA` | Teinte violette (`#0A0814`) |
| **Vizyo Leads** | `#FF6A00` (orange) | `#FF8C00 → #FF4500` | Neutre froide (`#0A0E1A`) |
| **Vizyo Auth** (à définir) | TBD | TBD | TBD |

### Règles inter-produits

- Même typographie : **DM Sans** partout
- Même structure UI : cards, boutons, inputs, espacements identiques
- Même philosophie dark theme : contraste fort, glow doux, grille décorative subtile
- Seules les **couleurs primaires et la teinte des surfaces** distinguent les produits
- L'utilisateur doit reconnaître la famille Vizyo au premier coup d'œil tout en identifiant le produit par sa couleur

---

## 14. Checklist d'application (pour Claude Code)

- [ ] **Audit** couleurs actuelles de Vizyo Leads : `grep -rhoE "#[0-9a-fA-F]{3,8}" src/ | sort -u`
- [ ] **Mapping** ancien → nouveau validé avant modifications
- [ ] Remplacer `:root` dans `src/styles.css` par le bloc §9
- [ ] Mettre à jour `tailwind.config.ts` avec le snippet §10
- [ ] Exécuter la migration §11 (commits atomiques)
- [ ] Copier les SVG du logo dans `src/assets/logos/`
- [ ] Remplacer toutes les occurrences du logo placeholder par `<img src="/assets/logos/vizyo-leads-icon-orange-lockup-orange.svg" alt="Vizyo Leads">`
- [ ] Vérifier que tous les boutons primaires utilisent `background: var(--gradient-primary)`
- [ ] Vérifier focus states inputs : `border-color: var(--primary)` + `box-shadow: var(--ring-focus)`
- [ ] Vérifier warning/error : remplacer tout orange habituel par le **jaune** (warning) et **framboise** (error)
- [ ] Ajouter les radial gradients d'ambiance §8 sur : login, dashboard, pipeline leads
- [ ] Mettre à jour emails transactionnels (Gmail-safe, logo aplat uniquement)
- [ ] Mettre à jour `theme-color` dans `index.html` : `<meta name="theme-color" content="#FF6A00">`
- [ ] Mettre à jour favicon avec `vizyo-leads-icon-orange.svg`
- [ ] Vérifier manifest PWA : `theme_color` et `background_color`
- [ ] Build et audit final : `grep -rn "OLD_BRAND_COLOR" src/` (0 résultat attendu)

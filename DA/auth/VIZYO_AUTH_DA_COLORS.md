# VIZYO Auth — Direction Artistique (Couleurs & Gradients)

> **Mission** : Refonte visuelle de Vizyo Auth pour l'aligner avec la nouvelle identité rouge framboise du logo. Ce fichier remplace **toutes** les couleurs et gradients existants. Conserver la typographie (DM Sans), les espacements, rayons, et structure UI actuels.

> **Cohérence** : Même structure et philosophie que les DA Manager (`VIZYO_MANAGER_DA_COLORS.md`) et Leads (`VIZYO_LEADS_DA_COLORS.md`). Seule la couleur primaire change. Les trois produits doivent se reconnaître comme une famille.

> **Sémantique marque** : le rouge framboise évoque **sécurité**, **protection**, **barrière**, **authentification** — parfaitement aligné avec le rôle d'identity provider du produit (cadenas dans le logo).

---

## 1. Couleur primaire (extraite du logo)

| Token | Hex | Usage |
|---|---|---|
| `--primary` | `#E11D48` | Rouge framboise de marque, boutons primaires, liens actifs, focus |
| `--primary-hover` | `#C81840` | État hover |
| `--primary-active` | `#A81438` | État pressed |
| `--primary-soft` | `rgba(225, 29, 72, 0.10)` | Backgrounds subtils (badges, hover rows) |
| `--primary-glow` | `rgba(225, 29, 72, 0.06)` | Aura focus inputs, halos |

> **Source** : Le `#E11D48` est le point milieu visuel du gradient logo (`#FB7185` → `#9F1239`). Valeur Tailwind `rose-600`, excellente lisibilité sur dark theme.

---

## 2. Gradient signature

Direction et stops repris **à l'identique** du SVG du logo.

```css
--gradient-primary: linear-gradient(45deg, #FB7185 0%, #9F1239 100%);
```

### Variantes officielles

```css
/* Diagonal — défaut, boutons & CTA hero */
--gradient-primary: linear-gradient(45deg, #FB7185 0%, #9F1239 100%);

/* Vertical — bandeaux, hero sections */
--gradient-primary-v: linear-gradient(180deg, #FB7185 0%, #9F1239 100%);

/* Horizontal — barres de progression, séparateurs accent */
--gradient-primary-h: linear-gradient(90deg, #FB7185 0%, #9F1239 100%);

/* Soft — surfaces décoratives, cards premium */
--gradient-primary-soft: linear-gradient(135deg, rgba(251, 113, 133, 0.12) 0%, rgba(159, 18, 57, 0.18) 100%);

/* Hover (CTA) — légèrement plus saturé */
--gradient-primary-hover: linear-gradient(45deg, #F45D73 0%, #8B0E31 100%);

/* Conique pour avatars / badges premium */
--gradient-primary-conic: conic-gradient(from 180deg at 50% 50%, #FB7185, #9F1239, #FB7185);
```

### Règles d'application

| Élément | Gradient ou Aplat |
|---|---|
| Boutons primaires (`btn-primary`) | **Gradient** (`--gradient-primary`) |
| Logo lockup interface | **Gradient** (utiliser SVG source, ne pas recolorer en CSS) |
| Liens / textes accentués | **Aplat** `--primary` |
| Icônes inline | **Aplat** `--primary` |
| Badges actifs (session, 2FA, etc.) | **Aplat** `--primary` + bg `--primary-soft` |
| Onglet actif (border-bottom) | **Aplat** `--primary` |
| Bordure focus inputs | **Aplat** `--primary` + glow `--primary-glow` |
| Hero / login / écrans "secured" | **Soft gradient** (`--gradient-primary-soft`) |
| Progress bars (force mot de passe) | **Gradient horizontal** |
| Avatars utilisateurs sans photo | **Gradient conique** |

> **Anti-pattern** : ne **jamais** appliquer le gradient sur du texte de paragraphe (illisible). Réservé titres hero, logos, surfaces.

> **Attention sémantique** : le rouge framboise ici est la **couleur de marque**, pas un signal d'erreur. Ne jamais utiliser `--primary` pour signifier "erreur" / "échec" → utiliser `--error` (voir §6).

---

## 3. Échelle framboise complète

À utiliser pour les nuances (badges, états, hiérarchie). Alignée Tailwind `rose`.

```css
--rose-50:  #FFF1F2;
--rose-100: #FFE4E6;
--rose-200: #FECDD3;
--rose-300: #FDA4AF;
--rose-400: #FB7185;  /* stop clair du gradient logo */
--rose-500: #F43F5E;
--rose-600: #E11D48;  /* primary */
--rose-700: #BE123C;
--rose-800: #9F1239;  /* stop foncé du gradient logo */
--rose-900: #881337;
--rose-950: #4C0519;
```

---

## 4. Surfaces & fond (dark theme)

L'ambiance reste dark **neutre/froide** pour faire ressortir le rouge framboise. Comme pour Leads (mais contrairement au Manager qui teinte violet), les surfaces d'Auth gardent un bleu nuit froid — le rouge chaud ressort mieux sur fond froid et conserve son aspect "alerte contrôlée / sécurité" sans écraser l'UI.

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
- **Auth** : surfaces bleu-nuit **neutres** (idem Leads, le rouge doit rester accent sans envahir)

> **Note** : Leads et Auth partagent exactement les mêmes tokens de surfaces. C'est volontaire — ça réduit la charge cognitive et donne une cohérence visuelle maximale entre les produits "métier" de l'écosystème.

---

## 5. Texte

```css
--text:       #E8ECF5;   /* titres, texte principal — neutre froid */
--text-2:     #C8CFDB;   /* texte secondaire */
--text-muted: #7B85A0;   /* labels, placeholders forts */
--text-dim:   #4D5674;   /* texte très discret, footer */
--text-on-primary: #FFFFFF;  /* sur fond gradient/primary */
```

> Les textes d'Auth sont **neutres** (pas teintés rouge) pour garder la lisibilité et laisser le rouge être l'unique accent visuel fort. Indispensable sur un produit de sécurité où la clarté prime.

---

## 6. Couleurs sémantiques (attention conflit avec primary framboise)

**Problème identifié** : `--error` (habituellement rouge framboise) est la couleur primary. Risque de confusion entre "marque" et "erreur".

**Solution** :
- `--error` → décalé vers **rouge vif orangé** (plus chaud, plus "alerte classique")
- `--warning` → ambre standard (aucun conflit)
- `--success` → vert émeraude inchangé
- `--info` → bleu ciel (complément froid parfait du rouge framboise)

```css
/* Success — vert émeraude */
--success:        #22C55E;
--success-soft:   rgba(34, 197, 94, 0.10);
--success-border: rgba(34, 197, 94, 0.30);

/* Warning — ambre (pas de conflit ici) */
--warning:        #F59E0B;
--warning-soft:   rgba(245, 158, 11, 0.10);
--warning-border: rgba(245, 158, 11, 0.30);

/* Error — ROUGE VIF ORANGÉ (décalé pour tranche avec primary framboise) */
--error:          #EF4444;
--error-soft:     rgba(239, 68, 68, 0.10);
--error-border:   rgba(239, 68, 68, 0.30);

/* Info — bleu ciel (contraste frais avec le rouge) */
--info:           #38BDF8;
--info-soft:      rgba(56, 189, 248, 0.10);
--info-border:    rgba(56, 189, 248, 0.30);
```

### Règles strictes

- Ne **jamais** utiliser `--primary` pour signifier "erreur" → confusion avec la marque
- Ne **jamais** utiliser `--error` pour un bouton CTA → confusion avec action destructrice
- Pour un message "Connexion échouée" / "Mot de passe incorrect" : utiliser `--error` (`#EF4444`), pas le primary
- Pour un badge "Compte bloqué" / "Session expirée" : utiliser `--error`
- Pour un bouton "Supprimer le compte" / "Révoquer la session" : utiliser `--error` (action destructrice)
- Pour un bouton "Se connecter" / "Activer 2FA" / "Confirmer" : utiliser `--primary` (gradient)

### Distinction visuelle primary vs error

| | `--primary` | `--error` |
|---|---|---|
| Hex | `#E11D48` (framboise) | `#EF4444` (rouge orangé) |
| Teinte | Vers le rose/magenta | Vers l'orange |
| Usage | Marque, CTA positifs | Erreurs, destructif |

Les deux rouges sont suffisamment distincts à l'œil nu pour éviter la confusion — à condition de **ne jamais les juxtaposer** dans une même section d'écran.

---

## 7. Glows, halos & shadows colorées

```css
/* Glow boutons primaires */
--glow-primary:        0 0 40px rgba(225, 29, 72, 0.35);
--glow-primary-strong: 0 0 60px rgba(225, 29, 72, 0.50);

/* Shadow standards */
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.40);
--shadow:    0 4px 12px rgba(0, 0, 0, 0.40);
--shadow-md: 0 8px 24px rgba(0, 0, 0, 0.45);
--shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.50);

/* Shadow teintées framboise pour cartes premium / modal (usage modéré) */
--shadow-primary:    0 8px 32px rgba(159, 18, 57, 0.25);
--shadow-primary-lg: 0 20px 60px rgba(159, 18, 57, 0.35);

/* Ring focus accessible */
--ring-focus: 0 0 0 3px rgba(225, 29, 72, 0.35);
```

> **Note** : le rouge framboise glow est fort visuellement. Réserver aux éléments clés (CTA hero login, modal 2FA, validation) — ne pas l'étaler sur toute l'interface.

---

## 8. Radial gradients d'ambiance (background pages)

Pour les pages clés (login, register, 2FA, dashboard session), ajouter ces halos **derrière** le contenu.

```css
/* Halo principal — top-left (framboise clair) */
.page::before {
  content: '';
  position: absolute;
  top: -40%;
  left: -20%;
  width: 700px;
  height: 700px;
  background: radial-gradient(circle, rgba(251, 113, 133, 0.08) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

/* Halo secondaire — bottom-right (bordeaux profond) */
.page::after {
  content: '';
  position: absolute;
  bottom: -30%;
  right: -10%;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(159, 18, 57, 0.06) 0%, transparent 70%);
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
    linear-gradient(rgba(225, 29, 72, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(225, 29, 72, 0.04) 1px, transparent 1px);
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
  /* ===== PRIMARY (framboise de marque) ===== */
  --primary:        #E11D48;
  --primary-hover:  #C81840;
  --primary-active: #A81438;
  --primary-soft:   rgba(225, 29, 72, 0.10);
  --primary-glow:   rgba(225, 29, 72, 0.06);

  /* ===== GRADIENTS ===== */
  --gradient-primary:        linear-gradient(45deg, #FB7185 0%, #9F1239 100%);
  --gradient-primary-v:      linear-gradient(180deg, #FB7185 0%, #9F1239 100%);
  --gradient-primary-h:      linear-gradient(90deg, #FB7185 0%, #9F1239 100%);
  --gradient-primary-soft:   linear-gradient(135deg, rgba(251, 113, 133, 0.12) 0%, rgba(159, 18, 57, 0.18) 100%);
  --gradient-primary-hover:  linear-gradient(45deg, #F45D73 0%, #8B0E31 100%);
  --gradient-primary-conic:  conic-gradient(from 180deg at 50% 50%, #FB7185, #9F1239, #FB7185);

  /* ===== ÉCHELLE ROSE / FRAMBOISE ===== */
  --rose-50:  #FFF1F2;
  --rose-100: #FFE4E6;
  --rose-200: #FECDD3;
  --rose-300: #FDA4AF;
  --rose-400: #FB7185;
  --rose-500: #F43F5E;
  --rose-600: #E11D48;
  --rose-700: #BE123C;
  --rose-800: #9F1239;
  --rose-900: #881337;
  --rose-950: #4C0519;

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

  /* ===== SÉMANTIQUE (error décalé pour éviter conflit avec primary framboise) ===== */
  --success: #22C55E; --success-soft: rgba(34, 197, 94, 0.10); --success-border: rgba(34, 197, 94, 0.30);
  --warning: #F59E0B; --warning-soft: rgba(245, 158, 11, 0.10); --warning-border: rgba(245, 158, 11, 0.30);
  --error:   #EF4444; --error-soft:   rgba(239, 68, 68, 0.10); --error-border:   rgba(239, 68, 68, 0.30);
  --info:    #38BDF8; --info-soft:    rgba(56, 189, 248, 0.10); --info-border:    rgba(56, 189, 248, 0.30);

  /* ===== EFFETS ===== */
  --glow-primary:        0 0 40px rgba(225, 29, 72, 0.35);
  --glow-primary-strong: 0 0 60px rgba(225, 29, 72, 0.50);
  --shadow-sm:           0 1px 2px rgba(0, 0, 0, 0.40);
  --shadow:              0 4px 12px rgba(0, 0, 0, 0.40);
  --shadow-md:           0 8px 24px rgba(0, 0, 0, 0.45);
  --shadow-lg:           0 16px 48px rgba(0, 0, 0, 0.50);
  --shadow-primary:      0 8px 32px rgba(159, 18, 57, 0.25);
  --shadow-primary-lg:   0 20px 60px rgba(159, 18, 57, 0.35);
  --ring-focus:          0 0 0 3px rgba(225, 29, 72, 0.35);
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
          DEFAULT: '#E11D48',
          hover:   '#C81840',
          active:  '#A81438',
          soft:    'rgba(225, 29, 72, 0.10)',
        },
        rose: {
          50:  '#FFF1F2',
          100: '#FFE4E6',
          200: '#FECDD3',
          300: '#FDA4AF',
          400: '#FB7185',
          500: '#F43F5E',
          600: '#E11D48',
          700: '#BE123C',
          800: '#9F1239',
          900: '#881337',
          950: '#4C0519',
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
        warning: '#F59E0B',
        error:   '#EF4444',
        info:    '#38BDF8',
      },
      backgroundImage: {
        'gradient-primary':       'linear-gradient(45deg, #FB7185 0%, #9F1239 100%)',
        'gradient-primary-v':     'linear-gradient(180deg, #FB7185 0%, #9F1239 100%)',
        'gradient-primary-h':     'linear-gradient(90deg, #FB7185 0%, #9F1239 100%)',
        'gradient-primary-soft':  'linear-gradient(135deg, rgba(251, 113, 133, 0.12) 0%, rgba(159, 18, 57, 0.18) 100%)',
        'gradient-primary-hover': 'linear-gradient(45deg, #F45D73 0%, #8B0E31 100%)',
      },
      boxShadow: {
        'glow-primary':        '0 0 40px rgba(225, 29, 72, 0.35)',
        'glow-primary-strong': '0 0 60px rgba(225, 29, 72, 0.50)',
        'primary':             '0 8px 32px rgba(159, 18, 57, 0.25)',
        'primary-lg':          '0 20px 60px rgba(159, 18, 57, 0.35)',
        'ring-primary':        '0 0 0 3px rgba(225, 29, 72, 0.35)',
      },
    },
  },
} satisfies Config;
```

---

## 11. Migration : table de remplacement

À exécuter sur **toute la codebase** Vizyo Auth.

### Étape 1 — Audit préalable

Avant toute modification, identifier les couleurs actuelles du projet :

```bash
cd vizyo-auth-frontend

# Lister tous les codes couleur hex utilisés
grep -rhoE "#[0-9a-fA-F]{3,8}" src/ | sort -u

# Lister toutes les variables CSS custom
grep -rhoE "\-\-[a-z0-9-]+" src/styles.css src/**/*.scss 2>/dev/null | sort -u
```

→ Partager la liste avant migration pour mapper précisément ancien → nouveau.

### Étape 2 — Patterns à remplacer (à adapter après audit)

| Recherche (à adapter selon audit) | Remplacement |
|---|---|
| Ancien primary hex | `#E11D48` |
| Ancien primary gradient | `var(--gradient-primary)` |
| `--brand:` / `--accent:` (si existant) | `--primary:` |
| `var(--brand)` / `var(--accent)` | `var(--primary)` |

### Étape 3 — Commande sed générique (après confirmation du mapping)

```bash
cd vizyo-auth-frontend

# Template à adapter avec les vraies couleurs identifiées à l'étape 1
find src -type f \( -name "*.scss" -o -name "*.css" -o -name "*.ts" -o -name "*.html" \) -exec sed -i \
  -e 's/ANCIEN_HEX_PRIMARY/#E11D48/gi' \
  -e 's/ANCIEN_HEX_PRIMARY_DARK/#A81438/gi' \
  {} \;
```

> **Règle** : ne **jamais** exécuter un sed aveugle. Toujours faire : audit → mapping → diff → commit atomique.

---

## 12. Logos — fichiers source

Les SVG livrés (à placer dans `src/assets/logos/`) :

| Fichier | Usage |
|---|---|
| `vizyo-auth-icon-red-lockup-red.svg` | Sidebar nav, header (fond clair/sombre neutre) |
| `vizyo-auth-icon-white-lockup-gradient-red.svg` | Login, register, écrans hero |
| `vizyo-auth-icon-white-lockup-white.svg` | Header sur fond gradient/framboise foncé |
| `vizyo-auth-icon-white-lockup-black.svg` | Documents, exports PDF, emails |

**Règles** :
- Ne **jamais** recolorer le logo via CSS `filter`. Toujours utiliser la variante adéquate.
- Le **cadenas** est un élément de marque distinctif (signature "sécurité/authentification"). Toujours le conserver intact.

### Emails (contrainte Gmail-safe)

Pour les emails (confirmation, reset password, alerte sécurité), utiliser **exclusivement** la variante `black` ou aplat `red`, **jamais** la variante gradient (non supportée par tous les clients mail).

```html
<!-- ✅ OK dans un email -->
<img src="https://manager.vizyoagency.com/assets/logos/vizyo-auth-icon-red-lockup-red.svg" alt="Vizyo Auth">

<!-- ❌ PAS dans un email -->
<img src=".../vizyo-auth-icon-white-lockup-gradient-red.svg" alt="Vizyo Auth">
```

---

## 13. Cohérence écosystème Vizyo

| Produit | Primary (aplat) | Gradient | Surfaces | Sémantique |
|---|---|---|---|---|
| **Vizyo Manager** | `#7C5CFA` (violet) | `#A78BFA → #4338CA` | Teinte violette (`#0A0814`) | Standard |
| **Vizyo Leads** | `#FF6A00` (orange) | `#FF8C00 → #FF4500` | Neutre froide (`#0A0E1A`) | `--warning` en jaune, `--error` en framboise |
| **Vizyo Auth** | `#E11D48` (framboise) | `#FB7185 → #9F1239` | Neutre froide (`#0A0E1A`) | `--error` en rouge vif orangé |

### ⚠ Alerte cohérence : collision avec Vizyo Tracky

Le logo **Vizyo Tracky** (`vizyo-tracky-icon-red.svg`) utilise **exactement le même gradient** que Vizyo Auth (`#FB7185 → #9F1239`).

**Question à trancher** :
- Option A : assumer que Tracky et Auth partagent l'identité rouge (famille sécurité/monitoring)
- Option B : différencier — par exemple basculer Tracky sur un **rouge plus vif** (tendance coral, `#F43F5E → #BE123C`), et garder Auth sur le **framboise profond** actuel

→ Cette DA est écrite en partant de **l'option A** (identité partagée). Si option B retenue, adapter le gradient de Tracky et garder Auth tel quel.

### Règles inter-produits

- Même typographie : **DM Sans** partout
- Même structure UI : cards, boutons, inputs, espacements identiques
- Même philosophie dark theme : contraste fort, glow doux, grille décorative subtile
- Leads et Auth partagent **les mêmes tokens de surfaces et texte** (`--bg`, `--surface`, `--text`...) — seuls primary/gradient diffèrent
- Manager a ses propres surfaces violettes (exception assumée)
- L'utilisateur doit reconnaître la famille Vizyo au premier coup d'œil tout en identifiant le produit par sa couleur primary

---

## 14. Checklist d'application (pour Claude Code)

- [ ] **Audit** couleurs actuelles de Vizyo Auth : `grep -rhoE "#[0-9a-fA-F]{3,8}" src/ | sort -u`
- [ ] **Mapping** ancien → nouveau validé avant modifications
- [ ] Remplacer `:root` dans `src/styles.css` par le bloc §9
- [ ] Mettre à jour `tailwind.config.ts` avec le snippet §10
- [ ] Exécuter la migration §11 (commits atomiques)
- [ ] Copier les SVG du logo dans `src/assets/logos/`
- [ ] Remplacer toutes les occurrences du logo placeholder par `<img src="/assets/logos/vizyo-auth-icon-red-lockup-red.svg" alt="Vizyo Auth">`
- [ ] Vérifier que tous les boutons primaires (Se connecter, S'inscrire, Activer 2FA, etc.) utilisent `background: var(--gradient-primary)`
- [ ] Vérifier focus states inputs : `border-color: var(--primary)` + `box-shadow: var(--ring-focus)`
- [ ] **Vérifier distinction primary vs error** : aucun bouton "Supprimer" ou "Révoquer" ne doit utiliser `--primary` → seulement `--error`
- [ ] Vérifier que les messages d'erreur ("Identifiants incorrects", etc.) utilisent `--error` (`#EF4444`) et non `--primary`
- [ ] Ajouter les radial gradients d'ambiance §8 sur : login, register, 2FA, mot de passe oublié
- [ ] Mettre à jour emails transactionnels (confirmation compte, reset password, alerte sécurité) — Gmail-safe, logo aplat uniquement
- [ ] Mettre à jour `theme-color` dans `index.html` : `<meta name="theme-color" content="#E11D48">`
- [ ] Mettre à jour favicon avec `vizyo-auth-icon-red-lockup-red.svg`
- [ ] Vérifier manifest PWA : `theme_color` et `background_color`
- [ ] Build et audit final : `grep -rn "OLD_BRAND_COLOR" src/` (0 résultat attendu)

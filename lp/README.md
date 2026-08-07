# Vizyo Tracky — site vitrine

Site statique multi-pages généré par un mini-générateur **zéro-dépendance** (`build.mjs`).
La sortie est du **HTML pur** dans `public/`, déployable tel quel.

## Lancer / prévisualiser
```bash
node build.mjs           # régénère toutes les pages + sitemap.xml + robots.txt
node build.mjs --sync-pricing   # idem, mais rebake les prix depuis l'API (source de vérité)
npx serve public -l 3852 # prévisualise sur http://localhost:3852
```

## Comment ça marche
`design/<page>.html` (export **x-dc** de claude.ai/design, avec `<helmet>` + bindings React)
→ `build.mjs` retire le runtime React, injecte le `<head>` SEO (title/description/canonical/
OG/JSON-LD/geo), remplace les sections mortes par les vraies (formulaire lead, devis signable),
ajoute le bouton « Connexion » → **`public/<page>.html`**, autonome et sans dépendance runtime.

⚠️ Ne jamais copier un export design directement dans `public/` : on perdrait toute la couche
SEO et on réintroduirait React depuis un CDN. Le design va dans `design/`, puis `node build.mjs`.

## Où éditer quoi (1 seule source de vérité par sujet)
| Je veux changer… | Fichier |
|---|---|
| Les **prix**, options (Live, rétention), install, offre de lancement | [`src/data/pricing.mjs`](src/data/pricing.mjs) |
| Les **villes** SEO (ajouter/activer, zones, contenu local) | [`src/data/cities.mjs`](src/data/cities.mjs) |
| Contacts, URL, région | [`src/data/site.mjs`](src/data/site.mjs) |
| Le **contenu** d'une page (en-tête, pied de page inclus) | [`design/<page>.html`](design/) |
| Le `<head>` SEO, le manifeste des pages, le sitemap | [`build.mjs`](build.mjs) |
| L'**interactivité** de toutes les pages (thème, menu, simulateur…) | [`public/assets/vt.js`](public/assets/vt.js) |

> Après toute modification : relancer `node build.mjs`.

## Ajouter une ville
Ajouter un objet dans `src/data/cities.mjs` (slug, name, dept, deptNum, lat, lng, `zones`,
`intro`, `context`) avec `generate: true`, créer `design/gps-flotte-<slug>.html`, puis
`node build.mjs`. Le `context` doit être **unique** par ville (sinon Google considère du
contenu dupliqué).

## Pages AUTONOMES (hors build) — ne pas chercher leur source dans `design/`
Certaines pages ne passent pas par `build.mjs` : elles sont déjà du HTML final, autonome,
et vivent directement dans `public/`. `build.mjs` ne les génère pas, donc il ne les écrase
pas non plus — mais il ne leur injecte rien non plus (pas de `<head>` SEO généré, pas de
bouton « Connexion » automatique : tout est dans le fichier).

| Page | Rôle | Indexation |
|---|---|---|
| `public/decouvrir-depot.html` | Pour le **client d'un transporteur** équipé Tracky : ce que son dépôt peut suivre. Lien envoyé au cas par cas. | `noindex,follow` |
| `public/assets/tracky-svc/*.html` | Scènes animées (supervision, analyse, administration, dépôt), embarquées en `<iframe>`. | `noindex,nofollow` |
| `public/assets/tracky-video/` | Bac à sable d'animations (non lié depuis le site). | — |

⚠️ Une page autonome **n'entre pas dans `sitemap.xml`** (il est généré depuis le manifeste
`PAGES` de `build.mjs`). C'est voulu ici : ces pages sont en `noindex`.

## Tarifs (modèle)
Socle inclus (suivi standard + 90 j de rétention + SIM/data). En option facturée :
**Live temps réel** et **rétention longue (1/2/3 ans)** — car ils augmentent le stockage.
Formule **Sérénité** (tout inclus, 36 mois) ou **Liberté** (sans engagement, 12 mois).
Tarif **bloqué à la souscription**.

## Fichiers générés (ne pas éditer à la main, écrasés au build)
`index.html`, `fonctionnalites.html`, `tarifs.html`, `secteur-public.html`, `securite.html`,
`partenariat-maestroo.html`, `decouvrir.html`, `mentions-legales.html`, `gps-flotte-*.html`,
`sitemap.xml`, `robots.txt`.

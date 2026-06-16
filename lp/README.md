# Vizyo Tracky — site vitrine

Site statique multi-pages généré par un mini-générateur **zéro-dépendance** (`build.mjs`).
La sortie est du **HTML pur** à la racine, déployable tel quel.

## Lancer / prévisualiser
```bash
node build.mjs          # régénère toutes les pages + sitemap.xml + robots.txt
npx serve -l 3847        # prévisualise sur http://localhost:3847
```

## Où éditer quoi (1 seule source de vérité par sujet)
| Je veux changer… | Fichier |
|---|---|
| Les **prix**, options (Live, rétention), install, offre de lancement | [`data/pricing.mjs`](data/pricing.mjs) |
| Les **villes** SEO (ajouter/activer, zones, contenu local) | [`data/cities.mjs`](data/cities.mjs) |
| Contacts, URL, **navigation** | [`data/site.mjs`](data/site.mjs) |
| En-tête / pied de page (toutes pages) | [`partials/`](partials/) |
| Le contenu d'une page | [`pages/`](pages/) |
| Styles / scripts (toutes pages) | [`assets/tracky.css`](assets/tracky.css), [`assets/tracky.js`](assets/tracky.js) |
| Les **vidéos** | [`assets/video/README.md`](assets/video/README.md) |

> Après toute modification : relancer `node build.mjs`.

## Ajouter une ville
Ajouter un objet dans `data/cities.mjs` (slug, name, dept, deptNum, lat, lng, `zones`,
`intro`, `context`) avec `generate: true`, puis `node build.mjs`.
Le `context` doit être **unique** par ville (sinon Google considère du contenu dupliqué).

## Tarifs (modèle)
Socle inclus (suivi standard + 90 j de rétention + SIM/data). En option facturée :
**Live temps réel (10 s)** et **rétention longue (1/2/3 ans)** — car ils augmentent le
stockage. Engagement **annuel renouvelable, tarif bloqué à la souscription**.

## Déploiement (à valider)
- `index.html` est la **nouvelle page d'accueil**.
- L'ancienne `vizyo-tracky.html` (URL déjà indexée par Google) est **conservée intacte**.
  Avant la mise en prod : la rediriger en **301 vers `/`** (ou la régénérer) pour ne pas
  perdre le référencement existant.
- Penser à soumettre `sitemap.xml` dans Google Search Console.

## Fichiers générés (ne pas éditer à la main, écrasés au build)
`index.html`, `fonctionnalites.html`, `tarifs.html`, `secteur-public.html`,
`securite.html`, `gps-flotte-*.html`, `sitemap.xml`, `robots.txt`.

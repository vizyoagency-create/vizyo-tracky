# Rapport Lot 1 — Nettoyage technique SEO / indexation

Date : 19 septembre 2026
Branche de travail : `main`
État : corrections locales terminées et vérifiées ; production non déployée.

## Résumé

Le Lot 1 a été appliqué localement sans changement de design, de texte marketing, de prix, de fonctionnalité produit ou de campagne Ads. Les corrections couvrent l'URL d'accueil canonique du site marketing, les redirections historiques, la désindexation de l'ensemble de l'application Angular, les vrais endpoints `robots.txt` et `sitemap.xml` de l'application et le publisher du JSON-LD `WebApplication`.

La production n'a pas été modifiée. Un déploiement reste nécessaire pour publier ces corrections. La procédure existante impose un push sur `origin/main`, puis l'exécution de `deploy/vps/deploy.sh` sur le VPS ; aucune commande Docker manuelle ne doit être utilisée en production.

## État initial confirmé

- `https://tracky.vizyoagency.com/index.html` : 200, canonical vers `/`.
- Les liens internes du site marketing contenaient 162 références à `index.html` dans les sources et autant dans les fichiers générés.
- `https://tracky.vizyoagency.com/vizyo-tracky.html` : deux redirections avant la réponse finale, avec un premier `Location` en HTTP.
- `https://tracky.vizyoagency.com/fiabilite-gps.html` : même détour par HTTP.
- `https://app-tracky.vizyoagency.com/`, `/login` et `/admin` : 200, meta robots `index,follow`, sans `X-Robots-Tag` bloquant.
- `https://app-tracky.vizyoagency.com/robots.txt` : 200 `text/html`, shell Angular.
- `https://app-tracky.vizyoagency.com/sitemap.xml` : 200 `text/html`, shell Angular.
- JSON-LD applicatif : `publisher.url` pointait vers `https://vizyo-tracky.vizyoagency.com`, hôte inexistant.

## Modifications effectuées

### Site marketing

- Tous les liens internes `index.html` et `index.html#ancre` ont été remplacés par `/` et `/#ancre` dans les sources du générateur.
- La page autonome `decouvrir-depot.html` a reçu la même correction.
- Le générateur officiel `lp/build.mjs` a régénéré les pages publiques et le sitemap.
- `/index.html` redirige en 301 vers `https://tracky.vizyoagency.com/` uniquement lorsqu'il s'agit d'une requête cliente explicite. La résolution interne de `/` continue de servir la home en 200.
- Les anciennes URLs redirigent directement vers leurs destinations HTTPS :
  - `/vizyo-tracky.html` → `https://tracky.vizyoagency.com/` ;
  - `/fiabilite-gps.html` → `https://tracky.vizyoagency.com/securite.html`.

### Application

- Le shell Angular déclare désormais `meta robots="noindex,follow"`.
- Nginx ajoute `X-Robots-Tag: noindex, follow` au shell et aux routes applicatives servies par le fallback SPA.
- La règle couvre les routes authentifiées, admin, publiques à jeton et inconnues : `/admin`, `/admin/*`, `/dashboard`, `/vehicles`, `/driver`, `/t/:token`, `/s/:token`, `/book/:token`, `/reserve/:token`, etc.
- `/robots.txt` retourne un vrai fichier `text/plain` avec `User-agent: *` et `Allow: /`. Le crawl reste autorisé afin que les moteurs puissent lire le `noindex`.
- `/sitemap.xml` retourne 404, car aucune URL applicative n'a vocation à être indexée.
- Le JSON-LD `WebApplication` conserve son nom, son URL, `BusinessApplication` et `Web, iOS, Android`. Le publisher est aligné sur l'entité publique existante : `Vizyo Tracky`, `https://tracky.vizyoagency.com/`.

## Fichiers modifiés

- `apps/web/src/index.html`
- `deploy/vps/nginx.lp.conf`
- `deploy/vps/nginx.web.conf`
- 22 sources HTML sous `lp/design/` : pages fonctionnelles, légales, partenariat, sécurité, tarifs, Occitanie et villes.
- `lp/public/decouvrir-depot.html`, page autonome.
- 21 pages HTML générées sous `lp/public/` contenant auparavant un lien vers `index.html`.
- `lp/public/sitemap.xml`, régénéré avec 20 URLs et `lastmod` au 19 septembre 2026.

Le fichier `CLAUDE.md`, déjà modifié avant ce Lot, n'a pas été touché.

## Règles Nginx modifiées

### `nginx.lp.conf`

- 301 conditionnelle de `/index.html` vers la home HTTPS, sans capturer la résolution interne de `/`.
- Destinations HTTPS absolues pour les deux redirections historiques.

### `nginx.web.conf`

- `X-Robots-Tag: noindex, follow` au niveau du serveur et répété sur la réponse du shell `index.html`.
- endpoint exact `/robots.txt` en `text/plain`.
- endpoint exact `/sitemap.xml` en 404.

Les deux fichiers passent `nginx -t` avec l'image officielle `nginx:alpine`. La configuration marketing conserve un avertissement préexistant de type MIME `text/html` dupliqué dans `gzip_types`, sans échec de validation.

## Google Search Console

Search Console a été ouvert dans Chrome avec le compte Vizyo Agency. Aucune propriété Vizyo Tracky n'est disponible. Le sélecteur contient seulement :

- la propriété Domaine vérifiée `dg-epaviste-depanneur.fr` ;
- la propriété URL non confirmée `https://climafroid31.fr/`.

Conséquences : sitemap non soumis, URLs non inspectées, indexation/exclusions, canonical Google, dernière exploration, Core Web Vitals, HTTPS, actions manuelles et sécurité non vérifiables. Aucune propriété n'a été créée et aucune modification DNS n'a été tentée.

Action nécessitant validation : créer de préférence une propriété Domaine `vizyoagency.com`, ce qui demandera vraisemblablement un enregistrement DNS TXT.

## Résultats des tests

| Test | Résultat |
|---|---|
| Génération site marketing `node build.mjs` | Réussi, 22 pages ; sitemap de 20 URLs |
| `nginx -t` marketing | Réussi |
| `nginx -t` application | Réussi |
| Crawl local des 20 URLs sitemap | 20/20 en 200, 20/20 canoniques, 20/20 `index,follow` |
| Liens internes vers `index.html` | 0 restant dans `lp/design` et `lp/public` |
| Routes application testées | Toutes en 200 avec `X-Robots-Tag: noindex, follow` |
| `pnpm lint` | Bloqué : le script API appelle `eslint --fix`, mais le binaire `eslint` n'est pas installé/résolu |
| `pnpm typecheck` | Réussi après régénération locale du client Prisma |
| `pnpm test` partagé | 423 tests réussis |
| `pnpm test` API | 4 243 tests réussis, 268 suites |
| `pnpm test` Angular | 743 tests réussis |
| `pnpm build` | Réussi sur les 3 packages |

Le build Angular signale des avertissements préexistants de budgets CSS/bundle et deux dépendances CommonJS. Ils ne sont pas causés par ce Lot.

## Vérifications HTTP locales après correction

| URL / route | Résultat local attendu |
|---|---|
| Marketing `/` | 200 HTML |
| Marketing `/index.html` | 301 direct vers la home HTTPS |
| Marketing `/vizyo-tracky.html` | 301 direct vers la home HTTPS |
| Marketing `/fiabilite-gps.html` | 301 direct vers `/securite.html` en HTTPS |
| Marketing `/robots.txt` | 200 `text/plain` |
| Marketing `/sitemap.xml` | 200 `text/xml` |
| Application `/`, `/login` | 200, meta et header `noindex,follow` |
| Application `/admin`, `/admin/security`, `/admin/observability` | 200, header `noindex, follow` |
| Application `/dashboard`, `/vehicles`, `/driver` | 200, header `noindex, follow` |
| Application `/t/test-token`, `/s/test-token`, `/book/test-token`, `/reserve/test-token` | 200, header `noindex, follow` |
| Application `/robots.txt` | 200 `text/plain`, crawl autorisé |
| Application `/sitemap.xml` | 404 |

## État de production

Production inchangée à la fin de cette passe. Les contrôles live montrent encore l'état initial :

- `/index.html` répond 200 ;
- les deux anciennes URLs passent encore par HTTP et deux redirections ;
- l'application expose encore `index,follow` sur `/`, `/login` et `/admin` ;
- `robots.txt` et `sitemap.xml` de l'application renvoient encore le shell HTML en 200.

## Points restants et validations nécessaires

1. Valider la création de la propriété Domaine Search Console `vizyoagency.com` et l'ajout DNS TXT associé.
2. Valider le commit/push et le déploiement de production par la procédure `deploy/vps/deploy.sh` uniquement.
3. Après déploiement : rejouer les contrôles HTTP live, vérifier les logs et l'artefact compilé dans les conteneurs.
4. Après disponibilité de la propriété Search Console : soumettre le sitemap marketing et inspecter les cinq URLs prioritaires demandées.
5. Corriger séparément l'environnement de lint si souhaité ; ce point est hors du périmètre SEO du Lot 1.

## Lot 2

Aucun travail de pages locales, de contenu GEO ou de redesign n'a été commencé. Une fois le Lot 1 déployé et Search Console disponible, le Lot 2 pourra se concentrer sur le maillage du cluster Occitanie, la différenciation des pages locales et les signaux de confiance.

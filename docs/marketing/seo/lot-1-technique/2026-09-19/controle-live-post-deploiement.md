# Contrôle live post-déploiement — Lot 1 SEO

Date : 19 septembre 2026

## Verdict de la première tentative

Le commit `8e289f38` était présent sur le VPS et la partie application avait été correctement
recréée, mais le site marketing était resté sur son image du 7 août. Le Lot 1 était donc
partiellement déployé et ne pouvait pas être validé globalement.

## Conforme en production

- Application, login, routes admin, routes métier et routes publiques à jeton : meta
  `noindex,follow` et header `X-Robots-Tag: noindex, follow`.
- `https://app-tracky.vizyoagency.com/robots.txt` : 200 `text/plain`, crawl autorisé.
- `https://app-tracky.vizyoagency.com/sitemap.xml` : 404.
- Publisher du JSON-LD : `Vizyo Tracky`, `https://tracky.vizyoagency.com/`.
- Sitemap marketing structurellement valide : 20 URLs HTTPS uniques, toutes en 200 avec
  canonical concordant et `index,follow`.
- DNS, redirection HTTP vers HTTPS, certificats TLS, API et autres conteneurs du VPS sains.

## Non conforme lors du contrôle

- `/index.html` répondait 200 au lieu d'une 301 vers `/`.
- `/vizyo-tracky.html` et `/fiabilite-gps.html` faisaient deux redirections, dont une étape HTTP.
- 152 liens vers `index.html` restaient servis sur les 20 pages du sitemap.
- Le sitemap actif portait encore `lastmod=2026-07-21` au lieu de `2026-09-19`.

## Cause racine

Le script officiel construisait et recréait seulement `tracky-api` et `tracky-web`. La pile
séparée `docker-compose.lp.yml` n'était ni construite, ni recréée, ni contrôlée, ni journalisée.
Le dépôt du VPS contenait les bonnes corrections, mais le conteneur `tracky-lp` actif embarquait
encore l'ancienne configuration et les anciens fichiers.

## Correction de procédure

- Le déploiement complet inclut désormais `tracky-lp` dans les repères de repli, le build, la
  recréation, l'attente de santé, le repli automatique et le journal.
- Le compose marketing possède une sonde vérifiant la home et le sitemap.
- La déclaration `gzip_types` ne répète plus `text/html`, type déjà géré nativement par Nginx.
- Le mode `--marketing-seul` permet de publier uniquement le site public sans recréer l'API ou
  l'application Web, sans migration et sans seconde interruption applicative.
- Les tests du script couvrent le succès, l'échec de santé marketing, le repli des trois images,
  le journal et l'isolation du mode marketing.

## Contrôles obligatoires après le prochain déploiement marketing

1. `tracky-lp` porte un nouvel identifiant, zéro redémarrage et l'état `healthy`.
2. `/index.html` effectue exactement une 301 vers la home HTTPS.
3. Les deux anciennes URLs effectuent exactement une 301 vers leur destination HTTPS.
4. Le crawl des 20 URLs du sitemap rend 20/20 en 200, sans redirection, avec canonical concordant.
5. Le sitemap actif porte `lastmod=2026-09-19` et reste en `text/xml`.
6. Aucun lien HTML interne vers `index.html` ne reste servi.
7. L'application conserve son `noindex,follow`, son vrai `robots.txt` et son sitemap en 404.
8. Aucun autre conteneur n'est recréé lors d'un déploiement `--marketing-seul`.

La validation finale du Lot 1 reste conditionnée à ces huit contrôles live.

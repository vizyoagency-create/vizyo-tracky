# Vérifier avant de déployer

Trois commandes, dans cet ordre. La deuxième est celle qui manquait le 22/07/2026 et qui
a coûté une panne d'ingestion GPS en production.

```bash
pnpm verify
```

équivaut à `pnpm typecheck && pnpm smoke && pnpm test`. Détail de ce que chacune couvre —
et surtout de ce qu'elle **ne** couvre pas.

---

## 1. `pnpm typecheck` — les types

Rapide, déterministe. Vert = les types collent.

**Ne voit pas** : le câblage NestJS. Un module qui oublie un `imports:` passe le typecheck
sans broncher — les décorateurs ne sont pas vérifiés statiquement.

## 2. `pnpm smoke` — le démarrage de l'application (~25 s)

Construit le graphe d'injection complet (`AppModule`) et vérifie qu'il se résout.

**C'est le test qui manquait.** Le 22/07/2026, le module `api-traffic` est parti en
production sans importer `AuthModule` alors que son contrôleur utilise `JwtAuthGuard`.
L'API a redémarré en boucle, l'ingestion GPS est tombée. Le typecheck était vert et les
1000+ tests unitaires étaient verts : aucun n'instancie l'application entière. Les tests
unitaires fournissent leurs dépendances à la main, donc par construction ils ne peuvent
pas voir un `imports:` manquant.

Vérifié par mutation le 23/07/2026 : en retirant `imports: [AuthModule]` d'
`ObservabilityModule`, le smoke-boot échoue en 6 s avec le message exact de la panne
(« Nest can't resolve dependencies of the JwtAuthGuard »).

Il n'ouvre aucune connexion : `.compile()` instancie les providers sans appeler
`onModuleInit`. Il valide le **câblage**, pas le comportement.

**Réflexe quand il casse** : lisez le nom du module dans le message d'erreur Nest, et
ajoutez-y le `imports:` manquant. Ne neutralisez pas le test — il décrit une panne de
démarrage bien réelle.

## 3. `pnpm test` — les tests unitaires

~1080 tests. **Attention : ce n'est PAS un signal binaire fiable.**

### La suite est instable, et il faut le savoir

Mesuré le 23/07/2026 sur `main` sans aucune modification : un run échoue sur
`report-excel` (3 tests), un autre sur `partner-invitation` (1 test). **Suites
différentes d'un run à l'autre, chacune verte quand on la lance seule.** Les workers Jest
sont réutilisés entre fichiers : un timer laissé actif par une suite se réveille pendant
une autre et la fait tomber.

### Comment lire un échec, concrètement

1. Relancez la suite fautive **seule** :
   ```bash
   pnpm --filter @vizyo/tracky-api exec jest --testPathPatterns <nom-de-la-suite>
   ```
2. **Elle passe seule ?** → instabilité connue, sans rapport avec votre changement.
3. **Elle échoue seule ?** → c'est un vrai bug, à corriger.
4. Doute sur une régression ? Comparez à une **référence** : lancez la même suite sur le
   commit d'avant votre travail. Ne comparez jamais au vert absolu, il n'existe pas ici.

### Pièges d'outillage à connaître

- Le package s'appelle **`@vizyo/tracky-api`**, pas `@tracky/api`. Un mauvais filtre
  affiche `No projects matched the filters` **et sort en exit 0** — le run semble réussi
  alors qu'aucun test n'a tourné.
- L'option Jest est `--testPathPatterns` (au pluriel) sur cette version.
- Dans un worktree neuf, `pnpm install` échoue sur le postinstall `opencollective` sous
  Git Bash : utilisez `pnpm install --ignore-scripts` puis `pnpm --filter
  @vizyo/tracky-api exec prisma generate`.

---

## Ce qu'aucune des trois ne couvre

- **Les migrations Prisma** — elles s'appliquent au démarrage du conteneur (`CMD` du
  Dockerfile api). Une migration invalide ne se voit qu'au déploiement.
- **Le comportement réel de l'application** — le smoke-boot valide le câblage, pas la
  logique métier. Un service qui démarre bien peut faire n'importe quoi.
- **Le frontend** — `pnpm test` couvre l'API. Pour le web : `ng build` + les tests
  karma/jasmine en headless.
- **La configuration de production** — les variables d'environnement du VPS ne sont pas
  celles du dépôt. Exemple vécu : `VIZYO_AUTH_API_URL` vaut une adresse **interne** en
  production, ce qui rendait la sonde de dépendances aveugle aux pannes de routage.
  Vérifiez toujours `deploy/vps/.env.prod`, jamais `.env.example`.

## Après un déploiement en production

Le déploiement est **manuel** (aucun workflow GitHub sur ce dépôt) : pousser `main` ne
déploie rien. Une fois déployé, vérifiez que l'API a réellement démarré — un conteneur
peut être « up » tout en redémarrant en boucle :

```bash
docker compose -f deploy/vps/docker-compose.prod.yml logs api --tail 100 | grep -icE "UnknownDependencies|Nest can't resolve"
```

Zéro attendu. Puis `curl -s -o /dev/null -w "%{http_code}" https://<api>/api/health` → 200.

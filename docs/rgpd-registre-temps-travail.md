# RGPD 4.5 — Registre du temps de travail (design, à valider avant implémentation)

> Objectif CNIL : pouvoir justifier le temps de travail **5 ans** SANS conserver les positions
> (elles-mêmes soumises à des rétentions courtes). Aujourd'hui, toute notion de temps d'activité
> dérive des `Trip`/`Position` → quand la purge 4.1 s'appliquera, la preuve disparaîtrait avec.

## Principe
Un **agrégat journalier par conducteur**, calculé chaque nuit à partir des trajets de la veille,
**sans aucune coordonnée** : uniquement des durées et des bornes horaires.

## Modèle proposé
```prisma
/// Agrégat JOURNALIER du temps de travail d'un conducteur — AUCUNE position, uniquement des
/// durées (justification employeur, rétention propre 5 ans).
model WorkTimeEntry {
  id              String   @id @default(uuid()) @db.Uuid
  fleetId         String   @db.Uuid
  driverId        String   @db.Uuid   // conserve la référence même après anonymisation (fiche anonyme)
  day             DateTime @db.Date   // jour civil (fuseau de la flotte)
  firstTripStart  DateTime            // 1re prise de service observée
  lastTripEnd     DateTime            // dernière fin de trajet
  drivingSeconds  Int                 // somme des durées de trajets
  tripsCount      Int
  vehiclePlates   String[]           // plaques utilisées ce jour (pas de localisation)
  createdAt       DateTime @default(now())
  @@unique([driverId, day])
  @@index([fleetId, day])
}
```

## Mécanique
- **Cron nocturne** (04h00) : agrège les `Trip` de J-1 par `driverId` (fuseau flotte), upsert
  idempotent `(driverId, day)`. Rattrapage : à chaque run, ré-agrège aussi les 7 derniers jours
  (trajets re-segmentés/attribués tardivement).
- **Rétention propre** : purge des entrées > **5 ans** (1825 j) dans le même cron — la seule
  rétention longue, assumée et documentée.
- **Export CSV** : `GET /drivers/:id/work-time.csv?from&to` (admin, audité EXPORT) — colonnes
  jour / début / fin / conduite (h) / trajets / véhicules. Sert de registre remis à l'employeur.
- **Anonymisation (4.4)** : les entrées sont CONSERVÉES (fiche anonyme) — c'est une obligation
  employeur, pas une donnée de géolocalisation ; le nom n'apparaît plus nulle part.
- **Vie privée usage mixte** : seuls les trajets COLLECTÉS alimentent l'agrégat — les périodes
  privées (non collectées) n'y figurent par construction jamais.

## Points à valider (Youness)
1. Le registre est-il **opt-in par flotte** (recommandé : oui, comme le cadre horaire) ?
2. `driverSource='AUTO'` suffit-il, ou ne compter que les trajets attribués ?
3. Pause déjeuner : `drivingSeconds` = conduite pure (proposé) vs amplitude `first→last` (les 2 colonnes existent, l'export les montre côte à côte).
4. Qui peut exporter : fleet-admin seul, ou gestionnaire aussi ?

# Sprint 0.2 — Plan de correction CPU VPS

> Prerequis : lire `DIAGNOSTIC.md` pour le contexte complet.
> Principe : correctifs par impact decroissant, infra d'abord (gain immediat), applicatif ensuite.

---

## Sequence recommandee

```
1. Arreter les conteneurs parasites (I1, I2, I3)        → gain estime : 100-200% CPU
2. Appliquer les correctifs applicatifs (A1, A2, A3)     → gain estime : 10-30% CPU
3. Mesurer le CPU apres correction                       → objectif : < 150% sustained
4. Si CPU < 80% sustained → demander levee throttle Hostinger
5. Si CPU encore > 80% → evaluer CPU limits Docker (I6) ou migration VPS
```

---

## Correctifs INFRA (action humaine requise)

### I1 — Arreter les 5 conteneurs DEV Maalem

**Risque** : AUCUN — ce sont des conteneurs de dev qui n'ont pas de raison de tourner en prod.
**Impact** : ~50-100% CPU recupere.

```bash
# Verifier qu'ils ne servent a personne
docker logs maalem-dev-postgres --since 1h 2>&1 | tail -5
docker logs maalem-dev-minio --since 1h 2>&1 | tail -5

# Arreter (pas supprimer — reversible)
docker stop maalem-dev-postgres maalem-dev-minio maalem-dev-redis maalem-dev-admin maalem-dev-web
```

**Rollback** : `docker start maalem-dev-postgres maalem-dev-minio maalem-dev-redis maalem-dev-admin maalem-dev-web`

### I2 — Arreter le Redis DEV Tracky (doublon)

**Probleme** : `vizyo-tracky-redis` vient du `docker-compose.yml` (dev), demarre par erreur.
Le vrai Redis prod est `tracky-redis` (de `docker-compose.prod.yml`).

**Risque** : FAIBLE — verifier d'abord que tracky-api est connecte a `tracky-redis` et non a `vizyo-tracky-redis`.

```bash
# Verifier quel Redis est utilise par tracky-api
docker exec tracky-api env | grep REDIS
# Doit pointer vers tracky-redis (nom de service dans docker-compose.prod.yml)

# Si confirme → arreter le doublon
docker stop vizyo-tracky-redis
```

**Rollback** : `docker start vizyo-tracky-redis`

### I3 — Verifier et arreter le Postgres Leads doublon

**Probleme** : `vizyo-leads-postgres-1` et `vizyo-leads-postgres` — probablement un scale-up accidentel ou un ancien conteneur.

```bash
# Verifier lequel est utilise
docker exec vizyo-leads-api env | grep DATABASE
# Arreter le non-utilise
docker stop vizyo-leads-postgres-1  # ou vizyo-leads-postgres selon le resultat
```

**Rollback** : `docker start vizyo-leads-postgres-1`

### I5 — Session claude residuelle

Le process `claude` actuel (cette session) consomme 5.9% CPU.
**Action** : une fois le diagnostic termine, ne pas laisser de session claude ouverte sur le VPS.

### I6 — CPU limits Docker (a evaluer apres I1-I3)

Si apres nettoyage des conteneurs parasites le CPU reste > 80%, envisager des limites :

```yaml
# Dans docker-compose.prod.yml
services:
  api:
    deploy:
      resources:
        limits:
          cpus: '1.0'
  postgres:
    deploy:
      resources:
        limits:
          cpus: '0.5'
```

**Risque** : MOYEN — un mauvais calibrage peut degrader les performances. A tester.

---

## Correctifs APPLICATIFS (sans risque, reversibles)

### A1 — Purge de `position_sampling_decisions` (733K lignes, 234 MB)

**Probleme** : aucun job de nettoyage n'existe. Table en croissance infinie (~40K lignes/jour).
**Correctif** : ajouter la purge (7 jours) dans `LogCleanupService` (deja cron @3AM).

```typescript
// Dans log-cleanup.service.ts, ajouter :
const samplingThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const samplingResult = await this.prisma.positionSamplingDecision.deleteMany({
  where: { receivedAt: { lt: samplingThreshold } },
});
```

**Risque** : AUCUN — donnees d'audit non critiques, commentaire code dit "rolling-7d".
**Reversibilite** : revert du commit.
**Gain** : liberation ~200 MB, reduction charge INSERT + index.

### A1b — Purge immediate one-shot (action humaine)

Avant que le cron ne fasse effet, purger les vieilles donnees manuellement :

```bash
docker exec tracky-postgres psql -U tracky tracky_prod -c "
  DELETE FROM position_sampling_decisions
  WHERE \"receivedAt\" < NOW() - INTERVAL '7 days';
"
# Puis VACUUM pour liberer l'espace
docker exec tracky-postgres psql -U tracky tracky_prod -c "
  VACUUM ANALYZE position_sampling_decisions;
"
```

### A2 — Eliminer le double lookup tracker sur alarmes

**Probleme** : `tcp-server.service.ts:203` refait un `findUnique(tracker)` apres `positions.ingest()`.
**Correctif** : faire passer le tracker deja charge dans `ingest()` vers le handler d'alarme,
ou retourner le tracker depuis `ingest()`.

**Risque** : AUCUN — meme donnee, juste evite une requete.
**Reversibilite** : revert du commit.

### A3 — Augmenter le flush interval du batch buffer

**Probleme** : `setInterval(flush, 100)` dans `position-batch-buffer.service.ts` — wake-up toutes les 100ms meme quand le buffer est vide.
**Correctif** : passer de 100ms a 500ms ou 1s (le batch de 50 sert de seuil immediat de toute facon).

**Risque** : AUCUN — la latence de persistance passe de ~100ms a ~500ms max, invisible cote UX
(la denormalisation `Tracker.last*` et le broadcast WS restent synchrones).
**Reversibilite** : changer la constante.

### A4 — Reduire la frequence d'ecriture des sampling decisions

**Option courte terme** : ne persister les decisions que pour les trames `INSERTED` (pas les `SKIPPED`).
Les SKIPPED representent ~70% des decisions mais n'ont de valeur que pour le debug.

**Option long terme** : passer a un compteur agrege plutot qu'un INSERT par trame.

**Risque** : FAIBLE — perte de detail d'audit sur les trames skippees.
**Reversibilite** : revert du commit.

---

## Sequence de sortie de throttle Hostinger

```
1. Appliquer I1 + I2 + I3 (arreter conteneurs parasites)
2. Appliquer A1 + A1b (purge sampling decisions)
3. Deployer A2 + A3 (correctifs code)
4. Attendre 30 min, mesurer : `docker stats --no-stream`
5. Si CPU sustained < 80% sur 30 min → contacter Hostinger pour lever le throttle
6. Re-mesurer apres levee du throttle (le CPU reel pourrait etre plus bas sans le surcout du throttle)
7. Si CPU encore > 80% → evaluer I6 (CPU limits) ou migration vers VPS 4 vCPU
```

---

## Actions NON recommandees a ce stade

| Action                          | Pourquoi pas maintenant                              |
|---------------------------------|------------------------------------------------------|
| Redemarrer tracky-api           | Ne resout pas la cause racine                        |
| Migration DB / partitioning     | Les tables sont petites (341K positions), premature  |
| Upgrade VPS                     | D'abord nettoyer les parasites, on aura peut-etre assez |
| Modifier le sampling adaptatif  | Il fonctionne bien, le probleme est l'audit non purge |
| Ajouter un cache Redis          | Les lookups tracker sont rapides, c'est la frequence le probleme |

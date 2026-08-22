# C2 — Activer l'analyse de lieux (passation vers une autre session)

*Écrit le 2026-08-22. Tout ce qui suit est **mesuré en production**, pas estimé.*

---

## En une phrase

La chaîne technique est **construite, déployée et testée**. Il ne reste qu'un interrupteur à
basculer, une simulation à lire avant, et une vérification à faire après. Ce document existe pour
que la session qui le fera n'ait rien à redécouvrir — et surtout ne refasse pas les erreurs déjà
payées ailleurs sur ce chantier.

---

## 1. Ce que fait l'analyse de lieux

Pour chaque lieu clé d'une flotte (station-service, parking, dépôt), l'IA écrit un **résumé**, des
**points saillants** et des **recommandations**, à partir de deux sources :

- **OpenStreetMap** — ce que le lieu est objectivement (horaires, services, accès) ;
- **l'usage réel par la flotte** — passages, véhicules concernés, prix relevés, zones mortes GPS.

C'est cette seconde source qui rend l'analyse utile : un modèle seul ne sait rien des véhicules du
client.

**Où ça s'affiche** : sur la fiche du lieu, dans l'écran `/places`. Donc **visible par le client**,
et c'est précisément pourquoi le propriétaire a voulu décider lui-même de l'activation.

---

## 2. L'état exact aujourd'hui — les chiffres, pas des ordres de grandeur

| Fait | Valeur mesurée le 22/08 |
|---|---|
| `place_automation_settings.enabled` | **`false`** — jamais activée |
| Analyses existantes en base | **0** |
| Lieux au total | **10**, tous des stations-service |
| Flottes | **5**, dont **une seule** avec `aiEnabled = true` |
| **Lieux réellement éligibles** | **2** — `Station-service — Toulouse` et `Auchan — Launaguet`, flotte **cdef31** |

⚠️ **Une estimation antérieure parlait de « ~11 lieux par mois ». Elle était fausse** : elle comptait
les 10 lieux du parc sans tenir compte du filtre `aiEnabled` par société, qui en écarte 8. Le
périmètre réel de la première activation est de **deux lieux, sur une seule flotte**. Le risque
client est donc très contenu — mais il n'est pas nul, et ce n'est pas à l'architecte d'en décider.

Réglages en place : passage quotidien à **3 h (Paris)**, délai minimum **30 jours** par lieu,
plafond **20 analyses** et **1 €** par passage, `skipUnchanged = true` (un lieu dont les faits n'ont
pas bougé n'est pas réanalysé).

---

## 3. La chaîne, et pourquoi elle ne coûte rien

Elle emprunte la file de travaux locaux décrite dans `C1-TRAVAUX-IA-LOCAUX.md` :

```
03:10  PRODUCTEUR   le serveur collecte les faits (OSM + base, gratuit)
       (cron lieux)  et enfile un travail complet dans `travaux_ia_locaux`

06:30  COURRIER     l'agent du poste appelle le modèle sur l'ABONNEMENT
       (Windows)     et écrit la réponse brute — 0 crédit d'API

07:10  CONSOMMATEUR le serveur valide avec son `persist()` habituel
       (cron lieux)  (mêmes bornes sur la sortie du modèle) et range
```

Le coût est **0 $**, tracé en base avec `executor: 'local'`. Le plafond de 1 € par passage est
conservé mais **ne mord plus** — ses tests le disent explicitement.

⚠️ **Le consommateur tourne toutes les heures, même automatisation coupée.** C'est délibéré : un
travail déjà rédigé par le poste doit être rangé, pas abandonné dans la file.

---

## 4. Ce qu'il reste à faire — trois gestes

### Geste 1 — SIMULER avant d'activer (aucun appel modèle)

Un endpoint de simulation existe déjà. Il évalue tout — candidats, exclusions, estimation — sans
rien émettre :

```
POST /api/fleet-places/automation/simulate      (SUPER_ADMIN)
```

Lire le résultat AVANT de basculer quoi que ce soit. Attendu : **2 candidats**, action
`would_analyze`. Si le compte diffère, comprendre pourquoi avant de continuer.

### Geste 2 — ACTIVER

Écran `/places` → réglages de l'automatisation (SUPER_ADMIN), ou :

```
PUT /api/fleet-places/automation     { "enabled": true }
```

⚠️ **Passer par l'API ou l'écran, jamais par un `UPDATE` SQL direct.** Le service borne les valeurs
et invalide ce qu'il faut ; un écrit direct court-circuite tout ça.

### Geste 3 — VÉRIFIER la chaîne complète, sur des faits

Ne pas conclure sur la lecture du code. Ce qui prouve que ça marche :

```sql
-- 1. le travail est parti (après 03:10)
SELECT type, statut, "creeA" FROM travaux_ia_locaux WHERE type = 'analyse-lieu';

-- 2. le courrier a livré (après 06:30) — statut 'fait'

-- 3. le serveur a rangé (après 07:10) : la ligne a disparu ET l'analyse existe
SELECT p.name, left(a.summary, 120), a."costEur", a."aiModel", a.origin
FROM place_analyses a JOIN fleet_places p ON p.id = a."placeId";

-- 4. le coût est bien nul et tracé en local
SELECT executor, action, count(*), sum("costUsd")
FROM ai_usage_logs WHERE action = 'place_analysis' GROUP BY 1,2;
```

Attendu : `costEur = 0`, `executor = local`, un résumé qui parle **des vrais passages de la flotte**
et non d'un texte générique sur les stations-service.

**Puis regarder l'écran `/places` à 375 px** — c'est une règle du chantier : aucune conclusion sur
lecture de code, et rien n'est livré tant que le rendu mobile n'a pas été vu.

---

## 5. Les pièges déjà payés — ne pas les repayer

| Piège | Ce qu'il coûte |
|---|---|
| **DDL appliqué à la main en production** | L'entrypoint fait `prisma migrate deploy` : une table créée à la main met l'API en boucle de redémarrage (P3009, ~8 min d'indisponibilité le 21/08). Écrire le fichier de migration, commit, laisser le déploiement l'appliquer. |
| **Un test sans témoin ne prouve rien** | « Le véhicule n'apparaît pas » est passé au vert pour une mauvaise raison : il était déjà écarté par une autre règle. Toujours vérifier que le cas NÉGATIF change bien quelque chose. |
| **Conclure sur `enabled: true`** | L'activation ne suffit pas : la flotte doit avoir `aiEnabled`, le lieu doit être dû (30 j), et ses faits doivent avoir changé. Trois filtres avant le moindre appel. |
| **Accents dans les chaînes affichées** | `npm run verif:accents` est bloquant. Cinq gardes tournent : `accents`, `litteraux`, `variables`, `contraste`, `confirmations`. |
| **Backtick dans un commentaire de `template:`/`styles:`** | Casse la construction Angular. Payé six fois. |

---

## 6. Si ça se passe mal — le retour arrière

`PUT /api/fleet-places/automation { "enabled": false }`. Rien d'autre à défaire : les analyses déjà
écrites restent (ce sont des faits produits, pas des brouillons), et la file se vide toute seule.
Pour retirer une analyse d'une fiche, la supprimer explicitement — mais **regarder avant** : elle a
peut-être de la valeur.

---

## 7. Contexte utile

- `design/C1-TRAVAUX-IA-LOCAUX.md` — la file de travaux locaux, son contrat, ses garanties.
- `ROADMAP-AGENTS-LOCAUX.md` § « Registre des points ouverts » — décisions en attente et
  vérifications dues. **Y inscrire le résultat**, sinon il se perd.
- Les gardes : `apps/api/src/vehicles/hors-service-surfaces.spec.ts` et
  `apps/api/src/background-tasks/catalogue-exhaustif.spec.ts` figent ce qui ne doit pas régresser.
- Deux sessions travaillent sur ce dépôt. **`git fetch` + rebase avant de pousser** — un push a
  déjà été rejeté pour cette raison le 22/08.

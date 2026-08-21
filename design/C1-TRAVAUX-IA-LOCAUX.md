# C1 — File de travaux IA locaux : le serveur prépare, le poste rédige, le serveur range

*Écrit le 2026-08-21, avant implémentation. Décision propriétaire : « tout ce qui peut être
traité de manière récurrente doit être réalisé par des agents locaux ; l'API est réservée aux
interactions nécessitant une réponse immédiate ».*

## Le problème exact

Deux services IA récurrents sont aujourd'hui **coupés** faute d'un coût d'API justifiable :
le **rapport d'activité hebdomadaire** (0,156 $/appel, le plus cher de l'application) et
l'**analyse de lieux** (jamais lancée en production pour cette raison).

Les faire tourner sur l'abonnement du poste les rend gratuits. Mais les agents locaux
existants (récits, limites) fonctionnent parce que leur logique a pu être extraite en
modules purs. Ici c'est impossible : `buildPayload()` du rapport agrège l'activité
utilisateur via des dizaines de requêtes Prisma, `facts()` des lieux pareil. **Recopier ces
requêtes dans un agent `.cjs`, c'est la divergence garantie** — le défaut qu'on a passé
trois jours à éradiquer (récits orphelins, analyses inventées, limites fantômes).

## Le principe : l'agent est un courrier, jamais un cuisinier

```
SERVEUR (cron existant)          POSTE (1 passage/jour)         SERVEUR (cron existant)
┌────────────────────┐          ┌─────────────────────┐        ┌──────────────────────┐
│ PRODUCTEUR         │          │ COURRIER            │        │ CONSOMMATEUR         │
│ échéance atteinte  │─enfile──▶│ lit `a-faire`       │──lit──▶│ lit `fait`           │
│ buildPayload()     │          │ claude -p (schéma)  │        │ sanitize() EXISTANT  │
│ + system + schema  │          │ écrit `resultat`    │        │ persiste (create     │
│ dans la ligne      │          │ NE TOUCHE RIEN      │        │   EXISTANT), efface  │
└────────────────────┘          │ D'AUTRE             │        └──────────────────────┘
                                └─────────────────────┘
```

Trois garanties structurelles :

1. **Aucune logique métier sur le poste.** La ligne de travail porte TOUT (prompt système,
   schéma JSON, données) ; l'agent ne sait même pas ce qu'est un rapport. Ajouter un futur
   type de travail = zéro modification de l'agent.
2. **L'agent n'écrit jamais dans une table métier.** Seulement `resultat` de sa ligne. La
   validation (`sanitize`) et la persistance restent les fonctions serveur EXISTANTES —
   une réponse malformée du modèle est rejetée exactement comme avant.
3. **Même traçabilité de coût** que les récits : `ai_usage_logs` avec `executor: 'local'`,
   coût absorbé.

## La table (migration additive, à la main — convention du dépôt)

```sql
CREATE TABLE travaux_ia_locaux (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,              -- 'rapport-activite' | 'analyse-lieu' | ...
  statut      text NOT NULL DEFAULT 'a-faire',  -- a-faire | pris | fait | echec
  payload     jsonb NOT NULL,             -- { system, schema, userPayload, maxTokens }
  contexte    jsonb NOT NULL,             -- ce que le consommateur doit savoir pour persister
  resultat    jsonb,
  erreur      text,
  tentatives  int NOT NULL DEFAULT 0,
  "creeA"     timestamptz NOT NULL DEFAULT now(),
  "prisA"     timestamptz,
  "finiA"     timestamptz
);
CREATE INDEX travaux_ia_locaux_statut_type ON travaux_ia_locaux (statut, type);
```

## Robustesse — chaque règle vient d'un incident déjà payé

| Règle | Incident source |
|---|---|
| `pris` depuis plus de 2 h → redevient `a-faire` | agent tué trois fois en deux jours (reboot, crashs session) |
| 3 tentatives puis `echec` + UNE alerte | les 39 alertes Overpass en onze minutes |
| producteur idempotent (pas d'enfilage si un travail équivalent est en file) | double analyse = double coût |
| l'agent journalise dans `passages_agents_locaux` | l'écran doit voir le TRAVAIL, pas une promesse |
| travail consommé = ligne effacée (le rapport persisté EST la trace) | table qui enfle sans borne |

## Cadence — le minimum de lancements qui couvre le besoin

- **Producteur / consommateur** : les crons horaires EXISTANTS des deux services (aucun
  nouveau `@Cron`, le garde d'exhaustivité reste vert par construction).
- **Courrier** : UN passage par jour à 06:30, no-op immédiat si la file est vide.
  Le rapport hebdo s'enfile le lundi à ~06:20, le courrier le rédige à 06:30, le
  consommateur le range à 07:20 — prêt avant le café. Les analyses de lieux (~11/mois)
  s'absorbent dans le même passage quotidien, **zéro lancement supplémentaire**.

## Visibilité admin (exigence explicite du propriétaire)

- Entrée catalogue `courrier-ia` : `externe` + `poste:` → le garde `outils/*.cmd` FORCE sa
  présence, l'oubli casse la construction.
- État déduit du travail : file en attente / faits / échecs + dernier passage journalisé.
- Entrées des deux crons serveur mises à jour : leur `coutIa` passe de `facture` à `aucun`
  (ils ne touchent plus un modèle), la note raconte la bascule.

## Interrupteurs — qui décide quoi

| Interrupteur | Avant | Après | Pourquoi |
|---|---|---|---|
| flag `activityReport` | false | **false, inchangé** | il gate le chemin API direct (bouton) — coupé par décision du 20/08, la voie locale ne passe pas par lui |
| `activity_report_schedule.enabled` | false | **true** | c'est le producteur ; sans IA il n'est plus qu'une préparation de données |
| `place_automation.enabled` | false | **false — décision propriétaire en attente** | la chaîne sera prête ; l'activer change le contenu montré aux clients, ce n'est pas à l'architecte de le décider |

## Étapes

1. Migration SQL + modèle Prisma `TravailIaLocal`.
2. `TravauxIaService` (enfiler / reprendre-périmés / lister-faits) — petit, testé.
3. Producteur + consommateur dans `ActivityReportService` (le cron `:20` existant).
4. Idem `PlaceAnalysisService` / `PlaceAutomationService` (chaîne prête, automation OFF).
5. Agent `outils/agent-courrier-ia.cjs` + `.cmd` + tâche Windows quotidienne 06:30.
6. Catalogue + états + tests (file, gardes, catalogue).
7. Activation du planning rapport ; vérification live de bout en bout un lundi simulé
   (enfilage manuel) avant de laisser vivre.

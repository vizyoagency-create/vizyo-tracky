# Centre d'alerte Tracky — audit quotidien

Dispositif mis en place le **2026-08-03**. Il répond à une question simple :
*qu'est-ce qui casse en production, et qu'est-ce qu'on en fait ?*

## Les pièces

| Fichier | Rôle |
|---|---|
| [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md) | **Le référentiel.** Une fiche par famille d'erreur : signature, cause racine, correctif, statut. C'est la mémoire longue — elle survit à la purge de `error_logs` (30 j). |
| [`PROCEDURE-AUDIT.md`](./PROCEDURE-AUDIT.md) | **La méthode.** Ce que l'audit fait, dans quel ordre, avec les garde-fous et les pièges déjà payés. |
| [`collecte.sql`](./collecte.sql) | **Le collecteur.** Un instantané complet de la prod en une seule passe, lecture seule. |
| [`rapports/`](./rapports/) | Un rapport par jour, plus la référence manuelle d'amorçage. |
| `app/wiki.json` | **Le manifeste lu par l'application** : titres, sections, et le journal des passages. |

## Où ça se lit

**Dans Tracky** : `/admin/alerts` → bouton **Documentation**. Tout ce dossier y est consultable.
L'accueil est un **tableau de bord** : pour chaque famille d'erreur, *quand* elle a été vue,
*quoi* c'est, et *quoi faire*. Servi par `GET /api/admin/alerts/wiki` (SUPER_ADMIN), qui
parcourt le dossier sur le disque.

### Publier une mise à jour en production

L'API lit `/opt/tracky-centre-alerte` sur le VPS, monté en lecture seule. Publier =
copier les fichiers, **sans rebuild ni redémarrage** :

```bash
ssh root@72.62.26.240 "mkdir -p /opt/tracky-centre-alerte" && scp -r docs/centre-alerte/. root@72.62.26.240:/opt/tracky-centre-alerte/
```

⚠️ L'image Docker embarque aussi une copie (`deploy/vps/Dockerfile.api`), mais elle est
**figée** : sans la publication ci-dessus, un rapport écrit cette nuit n'apparaîtrait qu'au
prochain rebuild. Et si le dossier monté n'existe pas, Docker le crée vide et masque le
contenu de l'image — d'où le `mkdir -p`.

## Comment ça tourne

- **Automatique** — tâche planifiée `audit-centre-alerte-tracky`, tous les jours vers 3 h
  (heure locale). Si le poste est éteint, elle se déclenche au lancement suivant de Claude.
  Une garde anti-doublon empêche deux rapports le même jour.
- **À la main** — `/audit-centre-alerte` dans Claude Code, à tout moment.

## Les trois règles

1. **On ne vide pas le centre d'alerte.** Une erreur reste visible tant qu'elle n'est pas
   corrigée *et vérifiée*.
2. **L'audit propose, l'humain décide.** Aucun code applicatif n'est modifié, rien n'est commité.
3. **Un compteur à zéro n'est pas une preuve.** L'audit regarde aussi ce qui casse *sans* crier —
   c'est comme ça qu'a été trouvé [TRK-008](./REFERENCE-ERREURS.md#trk-008).

# `docs/` — où trouver quoi

> **Trois familles, et il faut les distinguer avant d'ouvrir un fichier.** Sans cet index, le
> document le plus récemment ouvert fait autorité — et ce n'est pas un critère.

| | Famille | Ce que c'est |
|:--:|---|---|
| 🟢 | **Vivant** | Se met à jour. C'est ce qui fait foi aujourd'hui. |
| 🔒 | **Servi par l'API** | Pas de la documentation à lire : des artefacts affichés dans `/admin`. |
| ⛔ | **Archive** | Un chantier terminé. Conservé pour l'histoire, **jamais pour s'en servir**. |

---

## 🟢 Vivant — ce qui fait foi

| Fichier | Ce qu'il porte |
|---|---|
| **[`SUIVI.md`](./SUIVI.md)** | **Le poste de commande** : ce qu'on fait ensuite, qui agit, où on en est. **Commence ici.** |
| [`centre-alerte/ROADMAP-CORRECTIFS.md`](./centre-alerte/ROADMAP-CORRECTIFS.md) | Les 56 fiches détaillées (28 centre d'alerte + 28 VPS). ⚠️ **Tenue automatiquement** par les audits de nuit. |
| [`centre-alerte/REFERENCE-ERREURS.md`](./centre-alerte/REFERENCE-ERREURS.md) | Le référentiel `TRK-nnn` : pourquoi chaque erreur existe. |
| [`vps-audit/REFERENCE-CONSTATS.md`](./vps-audit/REFERENCE-CONSTATS.md) | Le référentiel `VPS-nnn`. |
| [`DEPLOYMENT-VPS.md`](./DEPLOYMENT-VPS.md) | La procédure de déploiement courante. |
| [`REARCHITECTURE-ARBORESCENCE.md`](./REARCHITECTURE-ARBORESCENCE.md) | Le plan de rangement du dépôt. **Écrit, pas exécuté** (tâche R1). |
| [`chantier-cartes/SUIVI-CARTES-2026-09-07.md`](./chantier-cartes/SUIVI-CARTES-2026-09-07.md) | Le chantier cartes, terminé et prouvé. |
| [`environnement-demo/`](./environnement-demo/) | La démo en ligne : plan et exploitation. |

---

## 🔒 Servi par l'API — ne rien y déplacer

`centre-alerte/` et `vps-audit/` alimentent les écrans `/admin → Centre d'alerte` et
`/admin → Audit VPS`. **Leur chemin est écrit en dur dans six endroits chacun** : le `Dockerfile`
de l'API, le service `*-wiki.service.ts`, son `.spec`, le montage du compose et une tâche planifiée.

> ⚠️ Les déplacer est un chantier à part entière. Sur le VPS, ne **jamais** écrire dans
> `/opt/vizyo-tracky/docs/` : ce sont des fichiers suivis par git, et le `git pull` suivant
> échouerait — *le build d'après tournerait alors sur du code périmé, sans rien signaler*.

---

## 📚 Référence — stable, on s'en sert, ça ne bouge plus

| Domaine | Fichiers |
|---|---|
| Matériel et protocole | `03-protocol-coban-gps403d.md`, `05-hardware-bench.md`, `06-tcp-commands-console.md` |
| Passerelles | `07-sms-gateway.md`, `21-sim-management-whereversim.md` |
| Observabilité | `08-logging-and-observability.md`, `observability-guide.md` |
| Intégrations | `22-` à `25-integration-maestroo*.md`, `26-integration-vizyo-verify.md` |
| Conformité | `rgpd-retention-donnees.md`, `rgpd-registre-temps-travail.md`, `consent/` |
| Produit | `REFERENCE_COMMERCIALE.md`, `INVENTAIRE_PRODUIT_2026-07-08.md`, `A6-DEMANDES-ET-DEVIS.md` |
| Exploitation | `VERIFIER-AVANT-DE-DEPLOYER.md`, `12-tracking-adaptatif-runbook.md`, `14-tests-runbook.md` |
| Dette technique | `19-tech-debt-auth-httponly.md`, `20-position-partitioning-plan.md`, `18-web-push-deployment.md` |

---

## ⛔ Archives — n'y cherchez pas ce qu'il reste à faire

Chacune porte un bandeau en tête. Elles décrivent des chantiers **terminés** entre avril et août.

- **Roadmaps de version** : `04-roadmap.md`, `09-roadmap-v2.md`, `10-roadmap-correctifs-urgents.md`,
  `11-roadmap-tracking-adaptatif.md`, `13-roadmap-v1.5-finition.md`, `15-roadmap-v1.6-ui-tests.md`,
  `16-roadmap-correctifs-live-v1.md`, `17-roadmap-post-audit-mobile.md`, `roadmap-pwa.md`
- **Suivis de campagne** : `EXECUTION-TRACKER.md`, `TACHES.md`, `A-VALIDER-2026-08-16.md`
- **Passes de correction datées** : `centre-alerte/ROADMAP-CORRECTIFS-2026-08-25.md`, `-2026-09-01.md`,
  `-2026-09-04.md` *(la roadmap vivante est celle **sans date** dans son nom)*
- **À la racine du dépôt** : les 13 `.md` de la refonte d'août attendent leur rangement (tâche R1).

### Deux cas particuliers

| Fichier | Statut |
|---|---|
| `ROADMAP-RAPPORTS-2026-09.md` | Chantier des rapports d'activité, **dépassé le 3 septembre** par le chantier des excès de vitesse. Il le dit lui-même en tête. |
| `../TACHES-AMELIORATION.md` | **Encore vivant** (touché le 05/09) mais sans propriétaire clair : c'est l'objet de la tâche T23 — le tenir, ou le déréférencer. |
| `DEPLOYMENT-VPS.md.md` | Double extension, guide d'installation d'avril. À renommer lors du rangement (R1). |

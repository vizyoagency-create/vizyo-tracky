# Tracky — consignes de dépôt

## 📁 Où vont les fichiers — règle du propriétaire (2026-09-07)

> **Aucun fichier de documentation à la racine du dépôt. Tous les `.md` vivent dans `docs/`.**

**Deux exceptions, et deux seulement**, parce que ce sont des conventions d'outil que rien ne
remplace :

| Fichier | Pourquoi il reste à la racine |
|---|---|
| `README.md` | C'est le fichier qu'une forge affiche. |
| `CLAUDE.md` | Claude Code ne le lit **qu'**à la racine. *Une règle « rien à la racine » ne peut pas s'écrire ailleurs qu'à la racine.* |

**Tout le reste** — rapport, audit, roadmap, plan de reprise, suivi de campagne, notes de recette —
va dans `docs/`, dans le sous-dossier qui correspond. **Ne jamais créer un `.md` à la racine**, même
« temporairement » : c'est ainsi que 13 fichiers s'y sont accumulés entre le 22/08 et le 05/09.

Le plan de rangement en cours est décrit dans
[`docs/REARCHITECTURE-ARBORESCENCE.md`](./docs/REARCHITECTURE-ARBORESCENCE.md).

### 🔒 Deux dossiers de `docs/` sont FIGÉS

`docs/vps-audit/` et `docs/centre-alerte/` **ne sont pas de la documentation à lire : ce sont des
artefacts servis par l'API** (écrans `/admin` → *Audit VPS* et *Centre d'alerte*).

Leur chemin est écrit en dur dans **six endroits chacun** : `deploy/vps/Dockerfile.api`, le service
`*-wiki.service.ts`, son `.spec`, le montage de `deploy/vps/docker-compose.prod.yml`, et une tâche
planifiée. **Ne pas les déplacer, ne pas les renommer** sans traiter les six ensemble.

### ⚠️ Et sur le VPS, ne jamais écrire dans `/opt/vizyo-tracky/docs/`

`/opt/vizyo-tracky` est un **arbre de travail git** que le déploiement met à jour par `git pull`, et
`docs/vps-audit` / `docs/centre-alerte` y sont **suivis par git**. Y copier des fichiers les rend
*modifiés* → le `git pull` suivant échoue → **et le build d'après tourne sur du code périmé sans
rien signaler**.

Les copies servies vivent donc **hors de l'arbre git** (aujourd'hui `/opt/tracky-vps-audit` et
`/opt/tracky-centre-alerte`, montés `:ro`). Publication : `scp`, **sans rebuild**.
⚠️ Le `mkdir -p` avant le `scp` est **obligatoire** — sans le dossier, Docker le crée vide et
**masque** la copie embarquée dans l'image : écran blanc, sans message.
⚠️ **`scp` ne supprime pas** : un fichier retiré du dépôt survit sur le VPS jusqu'à un `rm` explicite.

## 🌿 Le dépôt est PARTAGÉ

Plusieurs sessions y travaillent en même temps — mesuré le 2026-09-07 : **7 commits en 6 heures**, et
`HEAD` a changé pendant une analyse.

- **`git add` par chemin explicite.** Jamais `git add -A`, jamais `git add .` : on emporterait le
  travail en cours de quelqu'un d'autre.
- **Vérifier la branche** (`git branch --show-current`) avant de committer, et la dire.
- ⚠️ `git checkout -- <fichier>` restaure depuis le `HEAD` **courant**, qui peut avoir changé sous
  vous.

## ✅ Vérification

`pnpm verify` (typecheck + tests + smoke-boot DI). ⚠️ Si la suite est instable, **la relancer
SEULE** avant de conclure quoi que ce soit.

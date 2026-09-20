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
- 🤝 **Les sessions ne sont pas toutes des sessions Claude.** Depuis le 07/09/2026, **OpenAI Codex**
  (l'application `ChatGPT.exe`) est aussi déclaré `trusted` sur cet arbre de travail **et** sur le
  worktree `../wt-allowlist`. Un fichier modifié que vous n'avez pas touché peut donc venir de lui.
  Règle de cohabitation : **un agent = un worktree** (`git worktree add ../wt-<sujet>`), jamais deux
  agents sur le même arbre en même temps — et jamais deux agents qui pilotent la souris ou Chrome
  (*computer-use*) simultanément : ils ont le même curseur et le même navigateur.

## 🚀 Déployer la production : `deploy.sh`, et rien d'autre (décision D1, 2026-09-13)

    ssh root@72.62.26.240 "bash /opt/vizyo-tracky/deploy/vps/deploy.sh"          # refuse si un passage tourne ou va partir
    ssh root@72.62.26.240 "bash /opt/vizyo-tracky/deploy/vps/deploy.sh --attendre"  # patiente au lieu de refuser

- **Jamais `docker compose up` à la main sur la pile de production.** L'automatisation des
  trajets part à HH:45 et dure jusqu'à 54 min ; recréer l'API pendant ce temps tue le passage.
  Le script lit la garde **deux fois** — au départ et juste avant la recréation (TRK-077) —, refuse
  de recréer entre HH:42 et HH:46, pose les repères de repli (`--repli <étiquette>` pour revenir),
  et journalise le conteneur créé. **Un conteneur qu'il n'a pas créé est signalé au centre
  d'alerte** (« déploiement hors script ») : contourner, ça se voit.
- Pousser sur `origin/main` d'abord : le script fait `git pull --ff-only` sur le VPS.
- **Depuis l'incident du 17/09** (migration ratée → API à terre 56 min → véhicules coupés au réveil) :
  le script **migre AVANT de recréer** le conteneur (conteneur éphémère de l'image neuve ; échec =
  rien n'est recréé, sortie 3), **attend que l'API soit `healthy`** et **revient seul à l'image
  d'avant** sinon (sortie 4), et **refuse de déployer entre 05:30 et 09:00 Paris** (les reprises du
  coupe-circuit dépendent de l'API ; `--force` passe outre, `--repli` n'est jamais retenu).
  Attendre le **verdict** du script en premier plan — jamais un guetteur `pgrep -f` qui se trouve
  lui-même. Récit : `docs/fiabilite-coupe-circuit-2026-09/31-INCIDENT-DEPLOIEMENT-2026-09-17-API-A-TERRE-56-MIN.md`.
- Après le déploiement, vérifier **l'artefact compilé dans le conteneur**, pas `docker ps`.
- Le script se teste à blanc : `pnpm verif:deploiement`. Les migrations se rejouent à blanc :
  `pnpm verif:migrations` (dans `pnpm verify`).

## 🛑 Toute commande `docker` sur le VPS est BORNÉE — sans exception (règle V34, 2026-09-20)

    ssh root@72.62.26.240 "timeout 20 docker logs --tail 200 tracky-api"      # ✅
    ssh root@72.62.26.240 "docker logs --tail 15 vizyo-auth-api"              # ❌ INTERDIT, même pour 15 lignes

- **`timeout 20` devant chaque `docker logs` / `exec` / `inspect` / `images` / `stats` / `ps`**, et
  **`--tail ≤ 2000`** : sur cet hôte, un `docker logs` lancé depuis une session SSH qui se ferme
  avant lui **ne rend jamais la main** et fait tourner `dockerd` à 100 % d'un cœur **pendant des
  jours**. **Sept occurrences sur sept** (VPS-016, du 05/08 au 19/09) viennent d'une commande de
  diagnostic tapée depuis le poste — par un agent ou un humain — sans `timeout`. La 7ᵉ (19/09 18:30,
  `docker logs --tail 500` sur `foodsqan-traefik`, dans un `bash -c "echo … ; docker logs … | cut"`)
  a pris le second cœur ; l'hébergeur a alors **retiré 80–90 % du CPU de la VM** pendant 12 h
  (VPS-045) : reprises du coupe-circuit passées par SMS payant, sauvegarde de 64 min, « Tracky down ».
- **Jamais de `docker` dans un `bash -c` enchaîné sans `timeout`** : si le premier bloque, tuer le
  client ne suffit pas — `bash` passe au suivant. Pour tuer un client bloqué : **le parent d'abord**
  (`ps -o pid,ppid,etimes,cmd -p …`, puis `kill <parent>` puis `kill <client>`), jamais
  `systemctl restart docker`.
- ⚠️ Il n'existe **aucun réglage global** (`DOCKER_CLIENT_TIMEOUT` n'existe pas dans le CLI Go) : la
  protection est **par convention, à chaque appel**. `deploy.sh`, `collecte.sh` et les scripts
  d'audit la portent ; une commande tapée à la main ne la porte que si vous l'écrivez.
- Avant tout diagnostic : `pgrep -a -x docker` — s'il rend quelque chose de plus vieux que 60 s,
  c'est déjà une occurrence, et c'est la première chose à traiter.

## ✅ Vérification

`pnpm verify` (typecheck + rejeu des migrations + smoke-boot DI + tests). ⚠️ Si la suite est
instable, **la relancer SEULE** avant de conclure quoi que ce soit. ⚠️ Une migration éditée après
avoir été appliquée sur la base de dev doit être **rejouée en entier** (`pnpm verif:migrations`) —
jamais « les deux instructions à la main » (incident du 17/09).

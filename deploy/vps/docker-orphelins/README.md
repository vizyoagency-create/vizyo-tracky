# docker-orphelins — le garde-fou de VPS-016

**Posé sur le VPS le 2026-09-20** (décision du propriétaire, règle V34). Trois fichiers, identiques à ceux
installés :

| Fichier | Sur le VPS |
|---|---|
| `docker-clients-orphelins.sh` | `/usr/local/sbin/docker-clients-orphelins.sh` (0755) |
| `docker-orphelins.service` | `/etc/systemd/system/docker-orphelins.service` |
| `docker-orphelins.timer` | `/etc/systemd/system/docker-orphelins.timer` — **actif** (`timers.target`) |

## Ce qu'il fait

Toutes les **5 minutes**, il tue tout client `docker logs` / `stats` / `events` / `attach` qui est
**sans terminal** (`tty = ?`) **et** vieux de **plus de 10 minutes** — le parent d'abord si c'est un
shell sans terminal qui porte encore du `docker` dans sa ligne de commande (sinon `bash` passe au
`docker logs` suivant, leçon du 2026-08-20). `SIGTERM`, puis `SIGKILL` 5 s après. Trace dans
`journalctl -t docker-orphelins` et dans `/run/docker-orphelins/dernier`.

Ce qu'il **ne touche pas** : un humain qui lit ses logs dans un terminal (`pts/N`), les `docker exec`
longs (la sauvegarde `pg_dump`), `compose`, `build`, `pull`, le démon lui-même, les conteneurs.

## Pourquoi

Sur cet hôte, un `docker logs` lancé depuis une session qui se ferme avant lui **ne rend jamais la
main** et fait tourner `dockerd` à 100 % d'un cœur **pendant des jours**. Sept occurrences sur sept du
05/08 au 19/09, toutes tapées depuis le poste, sans `timeout`. La 7ᵉ a pris le second cœur ; l'hébergeur
a alors retiré 80–90 % du CPU de la VM (VPS-045). La règle « `timeout 20` devant chaque `docker` » est
écrite dans `CLAUDE.md`, `PROCEDURE-AUDIT.md`, `REFERENCE-CONSTATS.md` — et a été oubliée sept fois.
**Il fallait un mécanisme.** Coût : un `ps` toutes les 5 min (mesuré 0,6 s de CPU sur la VM bridée du
20/09 ; ~20 ms en régime normal) — ~300× moins que les sondes de santé Docker.

## Banc du 2026-09-20 (sur la machine)

- faux client sans terminal, âge > seuil → **tué** ; chaîne `bash -c "bash -c <docker logs> ; …"` →
  **parent tué d'abord**, puis le client (journal : *« (parent 3453674 tué d abord) »*) ;
- faux client **avec** pseudo-terminal (`python3 pty.spawn`) → **vu = 1, tué = 0** (protégé) ;
- **vrai** `docker logs -f --tail 1 tracky-lp` sans terminal → tué, `pgrep -x docker` vide après ;
- premier passage réel (`--age 600`) : 0 vu, 0 tué, `Result=success`.

## Réinstaller / retirer

```bash
install -m 0755 docker-clients-orphelins.sh /usr/local/sbin/ && install -m 0644 docker-orphelins.service docker-orphelins.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now docker-orphelins.timer
```

```bash
systemctl disable --now docker-orphelins.timer   # retirer : le script reste, inoffensif sans minuterie
```

Essai à blanc : `docker-clients-orphelins.sh --simuler` (n'écrit rien, ne tue rien).

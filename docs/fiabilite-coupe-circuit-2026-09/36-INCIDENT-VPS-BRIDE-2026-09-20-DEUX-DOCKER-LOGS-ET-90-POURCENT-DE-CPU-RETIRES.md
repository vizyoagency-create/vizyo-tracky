# Incident du 19–20/09/2026 — deux `docker logs` oubliés, et l'hébergeur retire 90 % du CPU de la production

> **Cause racine : une habitude, pas un bug** — des commandes `docker logs` tapées sur le VPS depuis le
> poste (par des agents Claude/Codex, en diagnostic), **sans `timeout`**, dans des sessions qui se
> ferment avant elles. Sur cet hôte, un tel client **ne rend jamais la main** et fait tourner le démon
> Docker à 100 % d'un cœur. C'était la **7ᵉ fois depuis le 5 août** (VPS-016) ; la règle « `timeout`
> devant chaque `docker` » était écrite dans trois documents et n'a jamais suffi. Le 19/09 à 18:30, la
> 7ᵉ occurrence a pris le **second** cœur pendant que la 6ᵉ (depuis le 16/09) tenait le premier ; **3 h 40
> plus tard, Hostinger a bridé la VM par paliers jusqu'à 10 % de son CPU** — et ne l'a pas débridée
> quand la cause a disparu. Le propriétaire a été réveillé par « Tracky est down » ; les reprises du
> coupe-circuit du matin ont mis jusqu'à 220 s au lieu de 5, **deux sont passées par le SMS payant**, la
> sauvegarde a duré 64 min au lieu de 37 s. Tout est rentré dans l'ordre le 20/09 à 13:36 UTC, après un
> ticket. Ce document dit ce qui s'est passé, ce que ça a coûté, ce qui a été fait le jour même, et **ce
> qui empêche désormais que ça se reproduise — par un mécanisme, plus par une règle**.

Références : fiches [VPS-016, VPS-045, VPS-046, VPS-044, VPS-M104 → M107](../vps-audit/REFERENCE-CONSTATS.md) ;
rapport [audit VPS du 20/09](../vps-audit/rapports/2026-09-20.md) ; roadmap [V33 → V36](../centre-alerte/ROADMAP-CORRECTIFS.md).

---

## 1. Chronologie (UTC ; Paris = UTC + 2)

| Heure | Fait | Source |
|---|---|---|
| **16/09 12:41:08** | Depuis le poste, un `bash -c "echo … ; docker logs --tail 15 vizyo-auth-api \| cut … ; docker logs --since … vizyo-auth-api …"` (diagnostic d'un **autre** projet que Tracky). La session SSH se ferme ; le `bash -c` et son premier `docker logs` restent, adoptés par `init`. **6ᵉ occurrence de VPS-016 : un cœur sur deux, `dockerd` à 98 %.** | `ps`, `/proc/<pid>/environ`, `sar` |
| 17/09 03:18 | L'audit VPS la nomme à la minute, écrit le remède (V33 : `kill` du parent puis du client, 2 s) — **non exécuté** ; les audits des 18 et 19 n'aboutissent pas (interruption, poste endormi). | rapport du 17/09 |
| **19/09 18:26:48** | `deploy.sh --marketing-seul` (`ad0abff4`) — normal. | `journal.jsonl` |
| **19/09 18:30:17** | Depuis le poste, un script de diagnostic *« === PROXY/ROUTEURS === »* lance **`docker logs --tail 500 foodsqan-traefik`** sans `timeout`. Même mécanique. **7ᵉ occurrence : le second cœur.** `sar` : inactivité **37 % → 7 %** à 18:40. | `ps`, `sar` |
| 19/09 22:10 → 20/09 01:10 | **L'hyperviseur retire le CPU par paliers, à :10 de chaque heure** : part de CPU servie **97 → 79 → 54 → 32 → 11 %**. Deux plateaux plats. | `sar -u` (`%steal` 3 → 21 → 46 → 72 → 89 %) |
| 20/09 00:00–00:02 | Vizyo Auth injoignable (503 rendu en 57 s pour un délai de 8 s). | centre d'alerte, TRK-068 |
| 20/09 01:17 | L'audit du centre d'alerte voit les deux clients (84 h 37 et 6 h 47) et le steal à 89 % ; écrit *« à faire en premier : `kill 3366707 2060192` »*. | rapport CA du 20/09 |
| **20/09 03:00–03:04** | Reprises MH Cars : acquittées en **220 s, 219 s, 158 s** au lieu de 0,8–7 s la veille ; **2 passées par le secours SMS** (3 puis 2 tentatives). | `engine_control_commands` |
| 20/09 03:01 → 04:05 | Sauvegarde Tracky : **64 min** (37 s la veille), 3 min 59 de CPU (22 s). | `journalctl -u tracky-backup` |
| 20/09 04:00 → 04:08 | Import hebdomadaire de la **démo** : **échec** — *« column `managedByManagerAt` does not exist »* (§ 3.3, sans rapport avec le CPU). API de démo arrêtée 8 min 35 pour rien. | `tracky-demo-refresh.log` |
| 20/09 05:00–05:01 | Reprises CDEF31 ×27 : max 39 s (≤ 10 s la veille). | `engine_control_commands` |
| **20/09 ~05:25** | Le propriétaire, réveillé par **« Tracky est down »** (le site répondait, en 5 s), trouve les deux clients, **tue les deux parents puis les deux clients**. `dockerd` retombe à 1 %. Latence 5 s → 0,4–1,4 s. | mémoire du poste, `sar` |
| 05:30 → 11:10 | **Le CPU ne revient pas** : part servie ~21 %, plateau plat six heures, alors que la VM a de l'idle. | `sar -u` (steal 75–82 %) |
| 10:36 → 10:49 | L'audit VPS (rattrapage du 19) démarre… et **se bloque derrière son propre `docker system df`** — le collecteur lançait lui-même 31 clients `docker` sans `timeout` (VPS-M104). Tué proprement. | collecte partielle |
| 11:18 → 11:29 | Nouvelle collecte : 647 s (7×), charge **15,8 → 81,7** — sur une VM servie à 12 %, l'audit était la majorité de ce qu'elle recevait (VPS-M107). Verdict : **VPS-045, gravité 1 : c'est l'hôte.** | rapport du 20/09 |
| 12:48 | **14 conteneurs hors production arrêtés** (dev, démo) — charge 18 → 4, `docker ps` 20 s → 4 s ; le plafond de l'hôte tient. | `docker stop`, `sar` |
| 13:08 | **Garde-fou posé** : `docker-orphelins.timer` (§ 4.1). Banc en 4 branches. | `journalctl -t docker-orphelins` |
| 13:12 | V32 (a) `until=72h`, V14 apt à 01:30, V17 archives rangées. | — |
| **13:35 → 13:36** | Ticket par le chat hPanel : Hostinger **confirme** — *« a CPU limitation was active and it has now been successfully removed; your sustained high usage from 09-19 18:40 to 09-20 05:25 UTC is consistent with the trigger »* — et **lève la limitation**. Steal **89 → 1 %** dans la minute. `/api/health` 2 100 → 30 ms. | hPanel, `/proc/stat` |
| 13:38 | Les 14 conteneurs rallumés (bases d'abord) : 38/38. | `docker start` |
| 13:40 → 13:47 | Démo recréée sur les images courantes, 5 migrations jouées, **« Import réussi »**. | `tracky-demo-refresh.log` |
| 20/09 après-midi | `deploy.sh` corrigé : repère de repli sur l'image **en service** (V32 b), la démo **suit par défaut** (V36 b) — 131 contrôles verts. | `pnpm verif:deploiement` |

---

## 2. Ce que ça a coûté

- **Le coupe-circuit** : 30 reprises le matin du 20/09 → 11 en ≤ 10 s, 16 en 10–60 s, 1 en 60–180 s, **2 à 220 s**
  (la veille : 30/30 ≤ 10 s). **Deux SMS payants** pour deux véhicules que le TCP aurait remis en route. La
  course de TRK-083 (T71) — prédite le matin même par l'audit du centre d'alerte — s'est exercée.
- **La production** : latence ×50 (30 ms → 1,5–2 s), Vizyo Auth injoignable 2 min à minuit, sauvegarde 64 min,
  passages d'automatisation de nuit ×3 à ×12 à heure égale, **38 conteneurs en `health: starting`** — les sondes
  de santé Docker n'obtenaient plus le CPU pour démarrer (213 *« timed out starting »* dans l'heure de 05 h).
- **Le propriétaire** : réveillé, un diagnostic à faire à la main à 7 h 25 un dimanche.
- **L'audit lui-même** : trois passages pour un rapport, et le collecteur devenu candidat à être la 8ᵉ occurrence.
- **Ce qui n'a PAS cassé** : aucune coupe retenue, aucune donnée perdue, 0 refus d'interlock, la copie hors-site OK,
  le site répondait — *c'est pour ça que l'incident a mis 7 h à être vu*.

---

## 3. Les trois causes, et pourquoi trois documents n'ont pas suffi

### 3.1 La cause première : un `docker logs` sans `timeout`, depuis le poste — 7 fois sur 7

Sur cet hôte, un client `docker logs` dont la session s'est fermée reste bloqué en `futex_wait` **et le démon
tourne à 100 % d'un cœur pour lui, indéfiniment** (mécanisme établi le 18/08 : le client meurt, le travail côté
serveur non ; ici le client ne meurt même pas). Toutes les occurrences depuis le 5 août ont la même forme :
une commande de diagnostic tapée depuis le poste — par un agent le plus souvent, parfois par un humain — dans
un `bash -c` enchaîné, sans `timeout`, sur un conteneur **souvent d'un autre projet** (texto-relay,
vizyo-auth-api, foodsqan-traefik). La règle « `timeout 20` devant chaque `docker` » était écrite dans
`REFERENCE-CONSTATS.md` (05/08), `PROCEDURE-AUDIT.md` (20/08) et la mémoire des agents — **pas dans
`CLAUDE.md`**, le seul fichier que chaque session lit. Et une règle par convention protège ceux qui l'ont lue ;
elle ne protège pas le prochain.

### 3.2 La cause aggravante : le bridage de l'hébergeur — et il ne se lève pas seul

Hostinger applique une **limitation d'équité** : après 2 × 100 % de CPU pendant ~3 h 40, la part servie à la VM
est réduite par paliers (22:10, 23:10, 00:10, 01:10) jusqu'à **10 %**. La règle exacte (seuil, fenêtre) **n'est pas
exposée** ; ce qui est établi : **elle ne s'est pas levée quand notre consommation est retombée** — six heures de
plateau à ~21 % après les `kill`, puis levée **immédiate** sur demande. La mémoire du dispositif disait depuis le
10/08 : *« un `%steal` élevé ne prouve pas une contention d'hôte : une machine saturée en déclare mécaniquement
plus »* — vrai **pendant** la boucle, faux après : `dockerd` à 1 %, de l'idle, et le steal tenait. *Une règle
écrite sur un cas encode ce cas.*

### 3.3 La cause voisine, sans rapport avec le CPU : la démo ne suivait que sur option

`deploy.sh` avait un `--avec-demo`. Personne ne l'a passé le 17/09 (deux déploiements, dont le lot D qui ajoute
la colonne `managedByManagerAt`) ni le 19/09. L'importeur hebdomadaire du dimanche tourne, lui, sur
`tracky-api:latest` : il a parlé à une base de démo au schéma du 13/09 et a échoué. *Le compose de la démo
prévenait dans son en-tête — « la démo ne peut pas être en retard autrement que par l'oubli de cette seule
commande » — et c'est exactement ce qui est arrivé.* Une commande à ne pas oublier est une commande qu'on oublie.

---

## 4. Ce qui empêche désormais que ça se reproduise

### 4.1 Un mécanisme sur le VPS : `docker-orphelins.timer` (V34)

Toutes les **5 min**, `/usr/local/sbin/docker-clients-orphelins.sh` tue tout client `docker logs | stats | events |
attach` **sans terminal** et **vieux de plus de 10 min** — **le parent d'abord** si c'est un shell sans terminal
qui porte encore du `docker` (sinon `bash` passe au `docker logs` suivant, leçon du 20/08). `SIGTERM`, puis
`SIGKILL` 5 s après. Trace : `journalctl -t docker-orphelins`, `/run/docker-orphelins/dernier`. Coût : un `ps`
(~20 ms ; 0,6 s mesuré sur la VM bridée), ~300× moins que les sondes de santé. **Ne touche pas** : un humain qui
lit ses logs dans un terminal, les `docker exec` longs (sauvegarde), `compose`, `build`, les conteneurs.

Banc sur la machine, le jour même : faux client → tué ; chaîne `bash -c` → *« parent tué d'abord »* au journal ;
client avec pseudo-terminal → `vus=1 tués=0` ; un **vrai** `docker logs -f` orphelin → tué ; premier passage réel
`Result=success`. **La fenêtre de dégât passe de plusieurs jours à 15 minutes** — trop court pour que le bridage
de l'hébergeur se déclenche. Source : [`deploy/vps/docker-orphelins/`](../../deploy/vps/docker-orphelins/README.md).
Le collecteur d'audit **lit** le garde-fou à chaque passage (un garde-fou doit prouver qu'il tourne — VPS-M06).

### 4.2 La règle là où les commandes se tapent : `CLAUDE.md`

Section *« 🛑 Toute commande `docker` sur le VPS est BORNÉE »* : `timeout 20`, `--tail ≤ 2000`, jamais dans un
`bash -c` enchaîné sans `timeout`, `pgrep -a -x docker` avant tout diagnostic, parent d'abord pour tuer. Le
garde-fou rattrape ; la règle évite d'avoir à rattraper.

### 4.3 Le collecteur d'audit ne peut plus être la 8ᵉ occurrence (VPS-M104, M105, M106, M107)

Fonction `docker()` bornée à 45 s avec **disjoncteur** (au premier dépassement, tous les appels suivants rendent la
main aussitôt et le disent) ; le premier correctif était faux (`timeout … command docker` = rc 127 — `command` est
un builtin) et **n'avait pas été exécuté** : réparé, banc, rejoué en script entier ; quatre blocs qui jugeaient un
vide (« la production est injoignable » pendant qu'elle répondait 200) nommés ; **mode allégé** au-delà de 50 %
de steal (1ᵉʳ jet : −36 % de durée, insuffisant sur la charge — 2ᵉ jet à faire).

### 4.4 Le bridage a un seuil de réescalade écrit (VPS-045)

`A_TRAITER` gravité 1 si `steal` > 30 % sur trois relevés `sar` de suite **avec** `dockerd` < 10 % et 0 client ;
`APPLIQUE` après sept jours de steal < 10 %. Et la marche à suivre est connue : **le chat hPanel, en anglais,
« transfer to a human VPS specialist », l'extrait `sar` — la limitation a été levée en une minute.**

### 4.5 `deploy.sh` (V32 b, V36 b) — 131 contrôles

- **Le repère de repli pointe l'image du conteneur en service** (`docker inspect --format '{{.Image}}'`), plus
  `:latest` ; quand les deux diffèrent (image pré-construite ou retenue), le script le dit. Le ménage du VPS garde
  une étiquette 72 h (V32 a). Un `--repli` revient désormais sur ce qui **tournait**.
- **La démo suit la production par défaut**, après que la production est saine ; un échec de la démo est dit et
  journalisé (`"demo":"malade"`) sans jamais mettre la production en cause ; `--sans-demo` pour la laisser en
  place — en le sachant. Le collecteur signale une ligne de journal `demo=non|malade`.

### 4.6 Ce qui reste ouvert

- **V35 (1) — la règle exacte de Hostinger** est inconnue ; la protection est de ne plus jamais lui donner le
  déclencheur (4.1, 4.2).
- **VPS-M107, 2ᵉ jet** : un *mode minimal* du collecteur au-delà de 80 % de steal.
- **V29** (deux rotateurs de journaux), **V4** (redémarrage noyau) : possibles maintenant, hors 05:30–09:00 Paris.
- **Les agents locaux du poste** (T75) sont en pause depuis le 17/09 ; la chute de 935 à 120 sessions SSH par jour
  dit que ce sont eux qui parlent le plus à la machine — la ventilation de VPS-032 se confirmera à leur reprise.

---

## 5. Les leçons — pour les autres machines et les autres agents

1. **Une règle qui a échoué sept fois n'est pas une règle, c'est un souhait.** Le mécanisme (un timer de 15 lignes)
   a coûté une heure ; les sept occurrences ont coûté des jours de cœur, un bridage et un réveil.
2. **Un client qui ne rend pas la main est une charge permanente invisible** : `docker stats` ne montre pas
   `dockerd`, la latence publique ne bouge qu'à la fin — c'est VPS-M48 (08/08) rejoué : un incident plus long que
   la fenêtre d'observation efface sa propre référence.
3. **L'hébergeur est une couche** (VPS-027 le disait pour la lecture ; le 20/09 l'établit pour le CPU) : il peut
   retirer 90 % de la machine sur un critère qu'on ne voit pas, et ne pas rendre. Le steal se lit tous les jours.
4. **Une option de sécurité que personne ne passe n'existe pas** (`--avec-demo`). Le bon défaut est celui qui
   protège ; l'exception se demande.
5. **Un correctif écrit n'est pas un correctif posé** : celui du matin (M104) rendait 127 partout et n'avait jamais
   tourné. Rejouer le script entier, toujours (VPS-M35, troisième rappel).
6. **L'audit peut être la charge** : sur une VM à 12 %, une collecte de 90 s en prend 647 et double la charge. Un
   outil de mesure doit savoir qu'il mesure une machine qui n'a plus de quoi le porter.

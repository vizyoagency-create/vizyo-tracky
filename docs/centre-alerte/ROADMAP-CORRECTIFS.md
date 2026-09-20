# Roadmap des correctifs — centre d'alerte **et VPS** de production Tracky

> **Refondue le 2026-09-06**, à partir des **20 fiches ouvertes** du
> [référentiel](./REFERENCE-ERREURS.md) et des six derniers audits (01/09 → 06/09). Ce fichier dit
> **quoi faire, dans quel ordre, et ce qui est vérifiable aujourd'hui** — le référentiel, lui, dit
> *pourquoi*. Les deux ne se recopient pas.
>
> 🆕 **Élargie le 2026-09-06 aux constats du VPS de production.** Le fichier porte désormais **deux
> parties** :
> - **[Partie I](#-ce-qui-attend-une-décision-ou-un-geste-humain) — le centre d'alerte** (fiches
>   `TRK-nnn`), source : [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md) ;
> - **[Partie II](#partie-ii--vps-de-production--25-constats-confirmés-et-non-corrigés) — le VPS**
>   (fiches `VPS-nnn`), source : `docs/vps-audit/REFERENCE-CONSTATS.md`.
>
> *Les deux dispositifs sont distincts — l'un lit les erreurs de l'application, l'autre l'état de la
> machine — mais **les tâches, elles, atterrissent sur les mêmes épaules**. C'est la seule raison de
> les réunir ici : un backlog par instrument produit deux files que personne ne priorise l'une
> contre l'autre.*
>
> 📌 **Ce fichier est le SEUL sans date dans son nom, et c'est délibéré : c'est la roadmap
> VIVANTE.** `ROADMAP-CORRECTIFS-2026-08-25.md`, `-2026-09-01.md` et `-2026-09-04.md` sont les
> plans de passes de correction passées — ils décrivent ce qui a été fait ces jours-là et ne se
> mettent plus à jour. *Un dossier qui contient quatre roadmaps doit dire laquelle fait foi, sans
> quoi la plus récemment ouverte gagne — et ce n'est pas un critère.*

---

## 📋 Comment on suit ce fichier — la règle de tenue

> **Décision du propriétaire, 2026-09-06 : ce fichier est le fil directeur des corrections.**
> On ne travaille pas à côté de lui, et **on le coche au fur et à mesure**.

**Chaque tâche porte un identifiant stable** — `T-nn` pour le centre d'alerte, `V-nn` pour le VPS.
L'identifiant ne change jamais et **n'est jamais réutilisé**, même quand la tâche est close : c'est
lui qui permet de dire « T10 est fait » dans un commit, un rapport ou une conversation, six semaines
plus tard.

### Les quatre règles

1. **Une tâche ne DISPARAÎT jamais.** Faite, elle passe à `[x]` **✅ FAIT** et reste en place, avec
   sa date, son commit et sa preuve. *Une liste qui raccourcit ne se relit pas ; elle s'oublie.*
2. **« Fait » veut dire PROUVÉ, pas écrit.** Trois états distincts, et aucun ne remplace le suivant :

   | Marque | Ce que ça veut dire |
   |:--:|---|
   | `[~]` | **Écrit et commité** — pas en ligne. |
   | `[»]` | **Déployé** — en ligne, **mais la preuve n'est pas encore venue**. |
   | `[x]` | **✅ FAIT** — déployé **ET** vérifié sur l'artefact servi ou par la mesure. |

   > 🔑 *C'est la leçon payée quatre fois cette semaine : un correctif commité n'est pas déployé, et
   > un correctif déployé n'est pas prouvé.* Cocher `[x]` sans preuve, c'est fabriquer le
   > « ✅ FAIT » de `docs/vps-audit/ROADMAP.md` — celui qui annonçait VPS-013 clos alors que sa
   > propre section détaillée disait l'inverse.
3. **On coche DANS LE MÊME PASSAGE que la correction**, jamais « plus tard ». Le tableau de bord et
   le journal d'avancement se remplissent avec le commit du correctif, pas après.
4. **Les trois gestes de diffusion valent aussi pour ce fichier** : l'**écrire**, le **copier** sur
   le VPS (`scp -r docs/centre-alerte/. …`, sinon l'écran `/admin/alerts` ne le voit pas), le
   **committer**. *Sauter le troisième ne se voit nulle part.*

⚠️ **Ce qu'il ne faut PAS faire** — retirer une ligne close pour « alléger », déplacer une tâche
d'une section à l'autre sans le dire, ou cocher `[x]` sur la foi d'une fiche plutôt que d'une mesure.
*Si une fiche et l'artefact servi se contredisent, **l'artefact a raison**.*

---

## 🗂️ Tableau de bord — 112 tâches, l'avancement d'un coup d'œil

**Au 2026-09-20 (fin d'après-midi, 13 h 50 UTC) : 62 faites ·
19 déployées, preuve attendue · 0 commitée · 31 ouvertes** *(112 tâches — dont 3 ouvertes en gravité 1)* — *le compte fait foi dans `app/taches.json`.*

> ✅ **13 h 36 UTC — HOSTINGER CONFIRME ET LÈVE LA LIMITATION CPU (V35 FAIT).** Ticket envoyé par le chat hPanel à 15 h 35 Paris,
> réponse une minute plus tard : *« a Hostinger CPU limitation was active and it has now been successfully removed; your sustained
> high usage from 09-19 18:40 to 09-20 05:25 UTC is consistent with the trigger »* — règle exacte non exposée, *« may be reapplied
> after sustained usage »*. Steal **89 → 1 %**, `/api/health` **2 100 → 30 ms**, `docker ps` **20 → 0,14 s**. **Les 14 conteneurs
> sont rallumés** (13 h 38, 38/38). **V36 (a) faite** : démo recréée sur les images courantes, 5 migrations jouées, **« Import
> réussi » à 13 h 47**. Restent : V32 (b) et V36 (b) dans `deploy.sh`, V29, V30, V4 (redevenu possible).

> 🛡️ **L'APRÈS-MIDI DU 20/09 : SIX GESTES EN UNE HEURE, ET UN MÉCANISME LÀ OÙ IL N'Y AVAIT QU'UNE RÈGLE.** **V35 (2)** : 14
> conteneurs hors production arrêtés à 12:48 (`docker stop`, jamais `down` ; `dg-epaviste`, `dronely`, `maquettes` gardés :
> sites publics sans coût) → charge 18 → 4–8, `idle` 8 → 41 %, `docker ps` 20 → 4 s — *la VM demande moins, le plafond de
> l'hôte est toujours là* : **le ticket (V35 (1)) reste à faire**. **V34** : `docker-orphelins.timer` posé à 13:08 — toutes
> les 5 min, tout client `docker logs|stats|events|attach` sans terminal et > 10 min est tué, parent d'abord ; banc en 4
> branches sur la machine (un **vrai** `docker logs -f` orphelin tué, un client avec terminal épargné) ; source
> `deploy/vps/docker-orphelins/` ; règle écrite dans `CLAUDE.md`. **V32 (a)** `until=72h`, **V14** apt à 01:30 ± 15 min,
> **V17** archives rangées (13:12). Restent : **V35 (1)** ticket, **V36** démo (après rallumage), V29, V30, V4.

> 🔴🔴 **LE FAIT DU 20/09, VU DU VPS (11 h 18 UTC) : LES DEUX CLIENTS SONT MORTS (V33 ✅ ~05:25, par le propriétaire) — ET
> L'HÔTE N'A PAS RENDU LE CPU.** Part de CPU *servie* (100 − `%steal`) : **97 %** jusqu'au 19/09 22:00, puis **79 → 54 →
> 32 → 11 %** par paliers à :10 de chaque heure, **10 %** jusqu'à 05:20, puis un plateau plat à **~21 %** de 05:30 à 11:10
> alors que `dockerd` est à 1 %, qu'il n'y a **aucun client** et qu'il reste de l'idle — un plafond, pas une contention : 🆕
> **VPS-045 → V35** (ticket hébergeur + `stop` des 18 conteneurs hors production, **avant 18:00 UTC**). **Coût mesuré** : les
> 30 reprises de ce matin → **11 ≤ 10 s, 16 en 10–60 s, 3 > 60 s, 2 par SMS payant** (T71 / TRK-083 **exercé**, à confirmer
> au centre d'alerte) ; sauvegarde Tracky **64 min** (37 s la veille). 🔴 🆕 **VPS-046 → V36** : l'import hebdomadaire de la
> **démo** a échoué à 04:07:58 (« `managedByManagerAt` does not exist » — la pile démo n'a pas été recréée depuis le lot D,
> `deploy.sh` ne lance pas son `up -d`). ✅ Copie hors-site OK 4 nuits de suite. ⚠️ Trois passages d'audit VPS pour un
> rapport (18 interrompu, 19 en rattrapage jusqu'à ce matin, 20 à +528 min) ; le collecteur s'est bloqué derrière son propre
> `docker system df` sans `timeout` (VPS-M104), le correctif du matin était faux (M105), quatre blocs jugeaient un vide
> (M106), et l'audit pesait la majorité du CPU servi (M107) — **quatre correctifs posés, rejoués en script entier.**

> 🔴🔴 **LE FAIT DU 20/09 : DEUX NUITS PROBANTES DE PLUS (59 COUPES / 59) — ET LE VPS EST ÉTRANGLÉ PAR DEUX `docker logs`
> SANS `timeout` AU MOMENT OÙ PARTENT LES REPRISES DU MATIN.** *(Ce passage couvre deux jours : celui du 19 est parti en
> rattrapage à 14:12 UTC et a été interrompu par l'utilisateur.)* Nuits 18→19 et 19→20 sous `8e289f38` puis `ad0abff4` (= `main`) :
> 4 + 25 puis 4 + 26 coupes, **59 ACK TCP en 0,4–6,1 s**, 35 reprises du 19/09 ≤ 7,5 s, 0 SMS, 0 refus, 0 non confirmée ;
> **HM-769-GA coupé pour la première fois en 5 nuits** (fix retrouvé le 18/09, TRK-086 éteinte après 15 lignes — non corrigée) ;
> **T29 prouvé une 3ᵉ fois** (7 037 s d'attente le 19/09). 🔴 **Le S21 a dormi 2 h 22** (19/09 02:23:55 → 04:46) : 9 `CRITICAL`
> watchdog, 2 preuves `INDETERMINEE`, **remises à 04:46 quand le téléphone est revenu** (relais T45) → interlock vert le soir
> *(de justesse : la preuve précédente aurait eu 24 h 30 à 20:00)* — **et rien ne l'écrit** : 🆕 **TRK-089 → T76** (T68 rejoué sur
> une 2ᵉ source, verdict de preuve jamais relu) ; ✅ **T69 (3) et (4) exercés** (`passerelle-sms` ×3, `preuve-sms` ×2). 🔴🔴 **V33
> toujours vivant (84 h 37) ET un 2ᵉ client bloqué depuis le 19/09 18:30:17** (`docker logs --tail 500` foodsqan-traefik, script
> « PROXY/ROUTEURS », 4 min après le déploiement marketing — **VPS-016 nº 7 → 🆕 V34**) : 2ᵉ cœur pris à 18:40 (`%idle` 37 → 7 %),
> puis **`%steal` 3 → 21 → 46 → 72 → 89 %** de 22:10 à 01:10, charge **56 / 41 / 27** pour 6 % d'user ; Vizyo Auth injoignable
> 00:00–00:02 (TRK-068 exercé, 503 rendu en 57 s). 🔴 **T75 non fait** : agents en pause depuis 3 j, **75 h sans récit**, 3
> `CRITICAL` « passage manqué » malgré la pause (reste de T58). 📏 **T30 : 1 paire / 6 le 18/09** (141,7 sans instant — la lecture
> « 130 pile » était trop étroite). 🔵 HM-733-GA rallumé à la main 5 nuits sur 5 ; MH Cars aussi (EP-047-TY ×2). **La seule chose
> à faire en premier : `kill 3366707 2060192` sur le VPS — puis `claude auth login` et « Reprendre maintenant ».**

> 🟢🔴 **LE FAIT DU 18/09 : LA DEUXIÈME NUIT PROBANTE — ET L'INCIDENT DU 17 QUE LE CENTRE D'ALERTE N'A PAS VU.** Nuit 17→18
> sous `1d1521b2` (= `origin/main`) : preuve de **21:30 Paris** remise en 5 s, **0 refus d'interlock**, **28 coupes / 28 acquittées
> en 0,4–5,1 s** (EY-613-MF **par SMS en 5,1 s** — socket manquante 7 s), 0 `SENT_UNCONFIRMED`, **T62 exercé** (2 lignes
> « TCP seul », liste = T61) et **T69 (2) exercé** (14 `SENT` `restore-non-prouvee`) — **T65 : 6 OK / 0 non exercé, second
> passage OK**. **Dix tâches prouvées d'un coup** : T28, T29, T34, T40, T42, T45, T62, T65, T67, T69. 🔴 **Le matin du 17 (doc
> 31)** : l'API à terre de **04:56 à 05:52** (migration du lot A en double) a retardé de **53 à 67 min** les 24 reprises CDEF31 de
> 07:00 Paris — nées à 05:53, `scheduledAt` NUL, 20 par SMS (30 émis, 6 refusés vers les 2 SIM de T61), 29/29 acquittées à 06:08,
> **et pas une ligne ne dit le retard** : 🆕 **TRK-084 → T72 (gravité 1)**. **7 reprises non prouvées à +5 min, 14 notifications,
> 1 seule ligne** : l'anti-flood de `ErrorLogger` fond les véhicules dont le message ne porte pas la plaque → 🆕 **TRK-085 →
> T73**. 🆕 **TRK-086 → T74** : HM-769-GA sans fix depuis 33,7 h fait crier le recalcul horaire 8 fois en 7 h (trajet brut hors
> tranche, jamais figé). 🔴 **Le poste a perdu sa session Claude Code à 03:21** (401) : **T34 a fait son travail** (pause 08:50,
> e-mail, 1 ligne, 0 nouvelle `CRITICAL`) mais **0 récit depuis 22 h** et la reprise est manuelle → 🆕 **T75**. 📏 T30 : 0 doublon
> / 12 ; la pointe **au plafond** (130 pile), pas `absolu`, n'a pas d'instant. 🔴 **V33 : 36 h 37, `dockerd` 91,7 %** — pas fait.
> **La seule chose à faire en premier : `kill 3366707`, puis `claude auth login` sur le poste et « Reprendre maintenant ».**

> 🟢 **LE FAIT DU 17/09 : LA DEUXIÈME NUIT DU CHANTIER EST LA PREMIÈRE PROBANTE — ET LE SEUL DÉFAUT DE LA NUIT
> N'A LAISSÉ AUCUNE LIGNE.** Sous `87ae29c9` (T69, déployé le 16/09 05:24 UTC, 292 s) : la preuve de **21:30 Paris**
> est partie à 19:30 UTC et remise en 6 s *(T69 exercé le soir même)*, **0 refus d'interlock**, **28 coupes** — 4 MH Cars
> à 20:00 Paris *(première nuit armée, 5 plannings sur 7)* et 24 CDEF31 à 22:00 — dont **27 acquittées** (26 TCP en
> 0,4–5,4 s, **1 par SMS prouvée de bout en bout** : HM-733-GA, `engine_control_fallback` `delivered` + accusé entrant,
> 83 s), **4 reprises MH Cars à 05:00 Paris en ≤ 4,1 s** ; 22 reprises CDEF31 à lire à 07:10. **T65 : 5 OK / 2 non
> exercés / 0 rouge** — premier des deux passages pour le Go du banc. 🆕 **TRK-083 → T71 (gravité 2)** : GR-898-HY
> `SENT_UNCONFIRMED` alors que son `jt` est arrivé à 20:01:38,3 — **0,9 s avant** l'inscription du guetteur d'ACK,
> armé après deux écritures en base (8,5 s cette minute-là, `dockerd` à 92 %) ; *sur une RESTORE, la même course
> déclenche un SMS payant, une `CRITICAL` et une notification pour une remise en route réussie* ; jumeaux dans
> `tracker-commands` et `tracker-fix-mode`. 🆕 **TRK-082 → T70** : la sentinelle « excès sans alerte » juge par
> `tripId` alors que T30 déduplique par excès — 3 trajets FV-941-LZ recréés accusés à tort. 🔴 **T30 : 2 paires de
> doublons sur 9** le 16/09 (FM-772-JH — `absolu` sans instant, pointe redécoupée à 79 s > 30 s, trajets
> chevauchants). 📏 **T28** : le 15/09 rend **222** contre 273 — journée encore dans la fenêtre de recalcul
> (`lookbackHours` 26 h → figée à **J+2 00:00 UTC**) ; `collecte.sql` gagne `fenetre_recalcul_close` et
> `cloture_moins_2h_depuis_creation` : **250/250, 222/222, 212/212 — 100 % recalé dans les 2 h suivant la création**
> *(T13 : le flux neuf est réparé, ce qui bougeait était la jauge)*. ✅ **T9** : les 3 déclarations HM-… levées à 08:33
> par un humain, `GPS_LOST` 2 min après. 🔴 **V33 (gravité 1)** : `docker logs --tail 15 vizyo-auth-api` bloqué depuis
> le 16/09 **12:41** (14 h 48), `dockerd` **91,7 %**, charge 1,32 — **VPS-016 nº 6**, pas de cette passe, pas tué. 🔴
> **Le poste dort la nuit** (V6) : 16/09 02:05→05:55 et 17/09 00:05→05:15 Paris — `agent-recit-trajet` et
> `agent-qualite-gps` manqués le 16/09 **et jamais rattrapés**, cet audit parti à **05:18** au lieu de 03:00. 🔵 HM-733-GA
> et GS-187-NY rallumés à la main **2 nuits sur 2** — plannings CDEF31 à ajuster. 📏 V28 : **6 passages > 45 min le
> 16/09 sans V28** (7, 5, 6) — les durées diurnes sont la charge d'analyse, la fenêtre de garde reste étroite le jour.
> **La seule chose à faire en premier : `kill 3366707` sur le VPS, puis lire les 22 reprises CDEF31 à 07:10 Paris.**

> 🔴 **LE FAIT VPS DU 17/09 : `dockerd` BRÛLE DE NOUVEAU UN CŒUR — 6ᵉ OCCURRENCE DE VPS-016, OUVERTE 19 H 21 APRÈS LA
> CLÔTURE DE LA 5ᵉ, ET C'EST ENCORE UN `docker logs` SANS `timeout` DEPUIS LE POSTE.** Le 16/09 à **12:41:08 UTC**,
> une session SSH du poste (`82.67.153.51:26499`) a lancé un `bash -c` de diagnostic *« ── dernières lignes vizyo-auth-api »*
> dont le premier `docker logs --tail 15 vizyo-auth-api` (pid 3366708) ne s'est jamais terminé ; la session est morte, le
> `bash -c` (pid 3366707, PPID 1) vit. `sar` : **85 % d'inactivité à 12:40 → 42 % sur 12:40–12:50** (la boucle commence
> *avec* le client, 4 min **avant** la recréation du conteneur à 12:45), puis **37–40 % sans exception jusqu'à ce matin** ;
> `dockerd` **98,3 %**, cumul **+14,9 h** ; 09-16 à **63,33 %**, 09-17 partiel **38,65 %**. Seuil d'hier franchi → **gravité 1**,
> 🆕 **V33** (`kill` du parent puis de l'enfant, 2 s, **non exécuté** ; puis une ligne dans `CLAUDE.md` : `docker logs` =
> `timeout 20`). ⚠️ Le conteneur visé n'était **pas** un troué (VPS-041) : V29 ne ferme pas la classe. 🔴 **Le poste a dormi de
> 23:17 à 03:15 UTC** : audit à 03:18 (+56 min), **les deux audits lancés à la même seconde** (VPS-M57, 3ᵉ collision, 27 sessions
> SSH de l'autre pendant ma fenêtre), et **la copie hors-site du 16/09 n'a pas eu lieu** : **2 paires produites depuis la dernière
> copie réussie n'existent qu'ici** — le collecteur écrivait « 46 h, à jour » (corrigé) ; la 3ᵉ paire (gravité 1 de VPS-037) se
> joue à **04:30 ce matin** (`WakeToRun` toujours `False`, V6). 🔑 **Et une lecture d'hier était fausse (🆕 VPS-M103)** : les
> passages d'automatisation ne se sont pas raccourcis grâce au cœur rendu — **09-16 de 07h à 12h, à DEUX cœurs : 54 · 55 · 55 ·
> 53 min** ; 09-14 à un cœur, mêmes heures : 56 · 52 · 55 · 59. C'est **la nuit** qui les raccourcit ; le seul effet mesuré de V28
> est `deploy.sh` (226 s, puis **292 s** pour `87ae29c9` à 05:24). *Les passages > 45 min de jour sont un fait quotidien, cœurs
> ou pas — la fenêtre de T29 est prise toute la journée.* ✅ **VPS-M74 tranché** : les 3 correctifs de sécurité (polkitd ×3) ont
> été **installés à 06:52:26**. ✅ **VPS-044, ½ preuve** : `avant-20260916-0519-0c9672c9` = exactement les images d'hier — mais
> `until=24h` intact, elle meurt demain 00:40 : **V32 (a) est la condition de la mesure**. 🔵 Dispocar : `dev` rend 44 Ko (1ʳᵉ copie
> non vide), `prd` reste à 1 172 o (4ᵉ nuit). Mercredi complet **33** émetteurs, 7 / 7 sauvegardes, périmètre 38 / 4 / 12 identiques.
> 🔧 3 correctifs au collecteur (paires sans copie, arrière du déploiement, conteneurs recréés).

> 🟢🔴 **LE FAIT DU 16/09 : LE CHANTIER COUPE-CIRCUIT EST EN PRODUCTION — ET SA PREMIÈRE NUIT N'EST PAS
> PROBANTE.** `fa9ff1d1` à 17:35:05 puis `0c9672c9` à 18:14:50 UTC le 15/09 (`deploy.sh --attendre`, 226 s puis
> 1 986 s, journal complet, arbre VPS `main` propre), relais `724bcb8`, `ENGINE_AUTOMATIC_CUT_ENABLED=true` ; V28 tué à
> 17:20 — charge **0,55**, passage de 00:45 en **3 min**. À **20:00 UTC**, **l'interlock a refusé les 25 coupes CDEF31**
> : « dernière preuve de remise SMS trop ancienne (> 24 h) » — la dernière remise prouvée date du **14/09 07:00**, la
> preuve manuelle du soir (doc 25 §12) **n'a pas été envoyée**, la première preuve automatique (T45) tombe à **02:30 UTC**.
> **0 `CUT`, 0 `RESTORE`, 0 SMS**, 30 plannings restés `IN_WINDOW`, 25 véhicules mobiles toute la nuit — *le garde-fou a
> fait exactement ce qu'on lui a demandé*. Mais **il le dit toutes les 15 min en `CRITICAL`** (20 lignes, ~36 attendues)
> et **fait partir un e-mail par heure** (5 reçus) : 🆕 **TRK-081 → T68** — première ligne `CRITICAL`, rappels
> `DEGRADATION` horaires, ligne de clôture, *sans toucher à la garde*. **T65 lue pour la première fois** (six verdicts :
> ping S21 **OK à 60 s**, sentinelle Android 1 épisode expliqué — S21 verrouillé 13:49 → 17:51, T55 —, interlock rouge
> par construction, RESTORE et TCP seul non exercés, preuve quotidienne non exerçable avant 02:30) → **`»`**. ✅ **T67
> à moitié prouvé** : 0 rappel sur les 50 vieilles RESTORE depuis 18:06 (28 dus). 📏 **T28** : le 13/09 retrouvé
> **86 / 86 / 66 / 20 / 0** une 2ᵉ fois, **mais le 14/09 rend 259 contre 244** sans qu'un trajet soit né — la requête
> n'était pas versionnée : `collecte.sql` gagne **`recalage_journees_closes`** (journée civile de Paris sur `endedAt`),
> série repartie à 88 / 88 / 60 / 28 / 0. 📏 T30 : mardi = 5 excès, 5 alertes, 0 doublon. 🔴 **La seule chose à faire en
> premier : à 04:45 Paris, lire `verdict=OK` de la première preuve SMS — sinon l'envoyer à la main avant 19:30, et
> prévenir CDEF31 que ses véhicules n'ont pas été coupés cette nuit.**

> 🔴 **LE FAIT VPS DU 15/09 : 46ᵉ HEURE, DEUXIÈME JOURNÉE ENTIÈRE SOUS 50 %, ET LE PREMIER
> DÉPLOIEMENT MESURÉ SUR UN SEUL CŒUR A PRIS 32 MINUTES.** Le client de V28 et son parent sont
> vivants à 02 h 28 UTC (**165 294 s**), `dockerd` à 100 % (cumul **+24,1 h de CPU en 24 h 00**),
> `sysstat` rend **38,9 % d'inactivité sur le lundi 09-14 complet** (47,7 % samedi, 85–89 % la
> semaine d'avant) et le `steal` a doublé ; `journal.jsonl` porte `deploy.sh` de 08 h 20 en
> **1 916 s** contre 303–585 s la veille — *et aucune durée à deux cœurs n'existe encore*. Demain
> sera le 3ᵉ jour < 50 % : le seuil 🔴 du collecteur. 🔴 **La copie hors-site de Vizyo Verify a
> ÉCHOUÉ le 14/09 à 04 h 30** (`pairesCopiees 0`) : le copieur du poste s'est arrêté sur un
> **manifeste orphelin** (archive purgée par le VPS, manifeste pas encore — trois `find -mtime +14`
> séparés) et **n'a jamais atteint la paire du 09-14**, qui n'existe que sur le disque qu'elle
> protège — 🆕 **VPS-043 → V31** (côté poste, dépôt `vizyo-verify`) ; et le collecteur affichait
> « à jour » sur une ligne qui disait ÉCHEC (🆕 **VPS-M100**, corrigé). 🆕 **Un troisième compte de
> dépôt, `dispocarbk`**, créé dimanche 05 h 32 depuis la même adresse (`179.198.198.199`), script
> copié de `recevoir-dump` : **4 dumps de 1 172 octets, `prd` = `dev` à l'octet** — probablement
> deux bases vides, à vérifier côté Dispocar (V30 élargie). ✅ **V27 est tranchée sur le fait** : la
> démo **n'a jamais analysé** (`enabled=false` depuis le 07/09, `lastRunAt` NUL) — les « 121
> analyses » d'hier étaient importées de la production avec leurs horodatages (🆕 **VPS-M101**,
> corrigé). ✅ Le ménage a rendu les 3 paires du 09-13 (34 → 31 images) ; `tracky-api:latest`
> (11 h 47) **n'a jamais été déployé** — le conteneur tourne sur `avant-…-1140` (🆕 bloc du
> collecteur : journal T33 + « ce qui tourne contre `latest` », qui aurait sonné sur T66). Lundi
> complet **33 émetteurs**, 3 compteurs à 33, 7 sauvegardes sur 7. 🔧 3 correctifs au collecteur.

> 🔴🔴 **LE FAIT DU 15/09 : LE COUPE-CIRCUIT A TOURNÉ HIER SOIR SUR L'ANCIEN CODE, ET LA MISE EN PRODUCTION
> DE 11:40 N'A PAS EU LIEU.** La fenêtre T47 n'a pas eu lieu ; les 30 plannings CDEF31 réarmés par le client
> ont produit **24 `CUT` `SCHEDULER` à 20:00 UTC, toutes acquittées par TCP en 1 à 5 s** (HD-584-BF et BP-434-RD
> compris), le 25ᵉ (HM-769-GA) différé « hors champ GPS » — **et deux véhicules déclarés « boîtier débranché »**
> ont été coupés, dont **HM-733-GA rallumé à la main par son exploitant à 23:13** (T9 / **T14 : requalifier** —
> la déclaration retient les alarmes, pas le planificateur). **Les 22 `RESTORE` du matin partent à 05:00 UTC sur
> le même code : à lire à 07:10 Paris.** Et `deploy.sh`, lancé à 11:40 sur `feat/rdv-installation-v2`, a posé
> `avant-20260914-1140-9afdf52a`, construit jusqu'à 11:47:34, **puis la seconde lecture de la garde (T29) a
> retenu la recréation** — passage 11:45 → 12:44 (59 min) — sans qu'aucune trace ne le dise : `journal.jsonl`
> muet, conteneur intact, `leadDays` absent, et `origin/main` porte « **correctif déployé sur prod** ».
> *Le garde-fou marche ; son silence, non* → 🆕 **T66**. 45 commits de `main` hors production. ✅ **T27 → FAIT**
> (TRK-076, échéance du 15/09 atteinte : 180 h sans ligne, le même compte revenu 5 jours sur 6). ✅ TRK-069 :
> le test daté est tombé à 01:50 et **les 13 `CRITICAL` d'agents se sont archivées seules à 04:50** (22 / 22
> passages réussis). 📏 **T28** : le 13/09 retrouvé **86 / 86 / 66 / 20 / 0** (1 sur 2) ; 14/09 = 244 / 244 / 233 /
> 0 / 0. 📏 **T30** : lundi = 1 excès qualifié, 1 alerte, 0 doublon — détection saine, déduplication non
> exercée. 🆕 **TRK-080** : la sentinelle nº 9 parle pour la première fois, sur un réglage écrit **hors
> application** (T6) — faux positif d'intention, gravité 4. 🔴 **V28 : 44 h 38**, `dockerd` à 100 %, **7 passages
> d'automatisation > 45 min le 14/09** (3, 3, 0 les jours d'avant) et un déploiement de 32 min — *tant qu'il
> dure, la garde de T29 n'a de fenêtre qu'entre :35 et :42.*

> ✅ **LE FAIT DU 14/09 : LA BAISSE DU CENTRE D'ALERTE VIENT, POUR LA PREMIÈRE FOIS, DE CORRECTIFS QUI
> REFERMENT SEULS.** 202 → 198 actives : les 4 `CRITICAL` du témoin des tâches se sont archivées
> d'elles-mêmes à 13:35 après 165 h (**T25 · TRK-074 → 🟢**), les deux commandes SMS de 298 h portent
> `SENT_UNCONFIRMED` depuis le premier balayage de 20:30 et `commandes_en_attente` rend **0 ligne** pour
> la première fois (**T5 · TRK-062 → 🟢**), et **T31 tient sur cinq contrôles sans rechute** sur la
> condition exacte que `13471c53` ferme — la cause « plafond » avait été rouverte à 18:50 sur un échec
> ancien, une heure après sa levée, *avant* ce déploiement de 20:02. **T28** : première journée close
> mesurée « à la clôture » — **86 / 86 / 66 / 20 / 0**, à retrouver telle quelle les 15 et 16/09 ;
> rattrapage **180 = 12 × 15**. **T30** : 0 doublon, 0 excès — *indécidable un dimanche*.
> 🆕 **T58** *(TRK-069)* : l'échec `SyntaxError` de `courrier-ia` (17:52) est **muet** au centre d'alerte —
> la clé de refroidissement (agent, motif) avait été consommée à 02:50 par une **autre** cause ; test daté
> à 03:50 UTC. 🆕 **T59** *(TRK-079)* : deux robots EC2 à agent iPhone falsifié, deux appels avortés par
> la fermeture de page rapportés en `keepalive` comme des pannes de réseau — bruit, 4 lignes.
> 🔴 **T9 / T14** : les trois « Retour LLD » ont été **renommés** le 13/09 à 11:34–11:37 (HM-733-GA,
> HM-769-GA, HM-779-GA) **sans que la déclaration « boîtier débranché » soit levée** — trois véhicules
> neufs roulent sans alerte. 🔴🔴 **V28 : le client Docker du 13/09 04:34 est TOUJOURS là**, `dockerd` à
> **101 % d'un cœur** mesuré dans `/proc`, **20 h 47** après — *rien n'a changé, sinon seize heures de plus.*

> 🔴 **LE FAIT VPS DU 14/09 : 22 HEURES PLUS TARD, RIEN N'A CHANGÉ — SAUF LA MACHINE, QUI VIENT DE
> PASSER SA PREMIÈRE JOURNÉE ENTIÈRE SOUS 50 % D'INACTIVITÉ.** Le client de V28 et son parent sont
> vivants à 02:27 UTC (**78 814 s**), `dockerd` à 100 % (cumul **+16,3 h de CPU en 16 h 14**),
> `sysstat` rend **47,7 % d'inactivité sur le samedi 09-13 complet** contre 85–89 % les sept jours
> d'avant — le seuil 🟠 « marge entamée » du collecteur est franchi pour la première fois sur une
> journée entière, et **sept `deploy.sh` (303 à 585 s) ont tourné sur cette machine à un cœur**,
> lus dans le journal de T33. 🔁 **La lecture de V30 était à moitié fausse** : `recevoir-dump` est un
> **dépôt entrant** — le VPS reçoit chaque nuit les dumps chiffrés `age` de Vizyo Conductor
> (14 fichiers, `prd` + `dev`, rétention 14) dans `/var/backups/vizyo-conductor-distant/` ; *cette
> machine est le dépositaire hors-site d'une autre*, et le collecteur imprimait « AUCUNE SAUVEGARDE »
> dessus deux passages de suite faute de connaître `.age` (🆕 **VPS-M99**, corrigé). La session
> `vaultbk` de 100 h **ne porte aucune commande** — un canal, pas un dump. ✅ **V14 est confirmée par
> le code** : `apt-daily.timer` sonne deux fois par jour, `check_stamp` compare les dates civiles,
> donc la 1ʳᵉ sonnerie de chaque jour UTC rafraîchit — **19 % de chances à 02:20, mesuré 3 / 17 =
> 18 %** ; `01:30 + 15 min` rafraîchira chaque jour. ✅ VPS-M92 rend sa première mesure (**38 = 38,
> mêmes noms**), VPS-038 tient (samedi complet **32**), 7 sauvegardes sur 7, disque 52 → 54 Go = les
> 3 paires `avant-*` du 09-13 que le ménage rend demain. 🔧 2 correctifs au collecteur (VPS-M99,
> sessions SSH établies) — le banc a attrapé deux défauts avant publication.
>
> 🔴 **LE FAIT VPS DU 13/09 : LA 5ᵉ OCCURRENCE DE VPS-016 EST NOMMÉE À LA SECONDE — ET LA CAUSE DE
> LA CLASSE EST ENFIN MESURABLE.** Le client bloqué (`docker logs --tail 60 texto-relay`) vient d'un
> `bash -c` de diagnostic lancé par une **session SSH root du poste** (session 39478, 04 h 34 min 00
> UTC, un dimanche à 06 h 34 Paris), session morte, `bash` parent vivant rattaché à `init` ; les
> trois routines planifiées sont **exclues** (toutes bloquées par le quota jusqu'à 12 h 06). *L'outil
> n'est pas nommé — VPS-M01 — la classe l'est : un `docker logs` sans `timeout` depuis une session
> qui se ferme avant lui.* 🆕 **VPS-041 — deux rotateurs se partagent les journaux de conteneur** :
> la stanza `logrotate` posée le 25/08 (`copytruncate`) perce à chaque minuit un trou d'octets NUL de
> la taille exacte du fichier tronqué (`tracky-api json.log.1` : **8 405 652 NUL** = taille de
> `json.log.2`, même égalité sur 3 autres conteneurs) ; **5 fichiers courants à 34–92 % de NUL**, et
> `dockerd` a journalisé *« Error decoding log file »* **8 s avant** le blocage. **V29** : un seul
> rotateur, 10 s, risque nul. 🆕 **VPS-042 — un coffre Vaultwarden et deux comptes de dépôt** sont
> apparus le 09/09 (les clés les mieux bornées de la machine — `command=` + `restrict` — mais aucun
> catalogue, aucune limite mémoire, une sauvegarde visible seulement par son tirage depuis
> `179.198.198.199`, une session ouverte depuis 3,5 jours) : **V30**, à reconnaître. ✅ **VPS-038
> redescend en gravité 2 sur son seuil** (33 puis 32 émetteurs, 3 revenants le 11/09 après 11 jours) ;
> ✅ `tracky-demo-refresh.timer` a déclenché seul et **l'import régénère `demo_replay_frames`** —
> V27 n'a plus rien à mesurer. 🔧 **4 correctifs au collecteur** (VPS-M98, M92, M93, VPS-041).

> 🔴 **LE FAIT DU 13/09 : UN TROISIÈME CANAL IA À SEC, ET C'EST LE SEUL QUI COUPE AUSSI LES AUDITS.**
> La CLI Claude du poste a atteint son **plafond hebdomadaire** du 10/09 04:00 au 13/09 12:00 (Paris) :
> 36 passages d'agents en échec, 0 récit, 7 travaux IA morts, **et les audits des 11–12/09 (centre
> d'alerte) et 10–13/09 (VPS) n'ont pas tourné** — même CLI. 31 des 63 lignes nées en trois jours ont
> cette seule cause ; rien ne s'est cassé sur la plateforme, la reprise a pris 12 minutes. 🆕 **T31**
> (une cause, une ligne) et **T32** (la parade au plafond — *trois canaux, trois plafonds, zéro plan*).
>
> ✅ **Deux tests datés franchis pendant le silence** : **T11** (TRK-068 exercée le 12/09 00:00:23 —
> 503, `ERROR`, dépendance nommée, motif conservé, **pas de jumelle**) et **T17** (TRK-065 exercée le
> 11/09 — `comptesTechniquesEcartes: 1`, compte technique absent ; **53 au lieu de ~21** parce que le
> numérateur a été ×2,5 par la tempête `agents-locaux` : *c'est la forme qui prouve, pas le nombre*).
>
> 🆕 **T30 · TRK-078 — 1 alerte d'excès de vitesse sur 5 est un DOUBLON** : 11 sur 55 en 14 j, même
> véhicule, même instant d'excès à la seconde, deux identités de trajet — le recalcul réécrit le
> `tripId` qui sert de clé de déduplication. *La lecture du 10/09 (« même véhicule refaisant le même
> trajet ») est rectifiée.* À corriger **avant** de calibrer T4.
>
> 🔴 **V28 — sur le VPS, un client Docker lancé sans `timeout` par une autre session est bloqué
> depuis 04:34 UTC** (`docker logs --tail 60 texto-relay`, PID 159541, parent 159533) et `dockerd`
> tourne à 100 % d'un cœur : **5ᵉ occurrence de VPS-016**. Tuer le parent, puis retrouver qui l'a lancé.

> ⚖️ **LE FAIT VPS DU JOUR, 09/09 : DEUX TESTS ÉCRITS D'AVANCE TOMBENT ENTRE LEURS BRANCHES, ET LA
> FAUTE EST DANS LES TESTS.** Tous deux se réfèrent au jeudi 09-03 sur une table dont la rétention
> vaut **3,95 jours** : **le point de référence avait été effacé avant l'échéance** (🆕 VPS-M94).
> *Un test daté à J+3 sur une source qui n'en garde que 4 est indécidable par construction.*
> ✅ **Mais la question de fond, elle, est tranchée — sur la table où elle est décidable** :
> `positions` garde 62 jours et rend **×0,94 mardi contre mardi**, à 30 émetteurs contre 30. **Le
> cycle hebdomadaire tient, il n'y a pas de dérive.** 🔑 *La règle qui en sort vaut pour toutes les
> tâches de ce fichier : avant d'écrire « au passage du JJ/MM, X devra valoir Y », vérifier que la
> rétention de la source de X couvre l'échéance. Sinon **changer de source, pas de date**.*
>
> ✅ **Et `apt` rend enfin une mesure valide (VPS-033, 3ᵉ succès sur 15) — qui sert immédiatement à
> réfuter deux alarmes** : le « 1 correctif de sécurité en attente » est une ligne **ESM** derrière
> un abonnement non souscrit (🆕 VPS-M97), et le `75 → 75` **n'est pas une panne de l'installateur**
> — les 75 sont hors des `Allowed-Origins`, par configuration standard d'Ubuntu, et le journal
> montre 34 paquets installés le 09-02 et 20 le 09-05. *Un total qui ne bouge pas ne prouve rien.*

> ✅ **LE FAIT DU JOUR, 09/09 : T24 PASSE À ✅ FAIT, ET LA PREUVE ÉTAIT ÉCRITE D'AVANCE — AU MOT
> PRÈS.** La consigne du 08/09 exigeait *« 24 lignes, **dont une ou plusieurs MARQUÉES
> INTERROMPUES** — et si le compte monte à 24 sans qu'aucune ne soit marquée, on a maquillé le carnet
> au lieu de le tenir »*. Le **08/09 rend 24 passages sur 24, dont EXACTEMENT 1 `interrupted`** :
> celui de **05:45:00**, tué en vol par le déploiement de 05:45. **Les deux moitiés du test sont
> franchies séparément** — le compte monte à 24, *et* la ligne manquante n'a pas été fabriquée.
> 🔑 *Une consigne qui prévoit d'avance la façon dont on pourrait la satisfaire malhonnêtement est ce
> qui sépare une preuve d'un chiffre qui arrange.*
>
> ✅ **Et T26 passe à `»` DÉPLOYÉ** : le trajet du 8 juillet s'est tu — dernière ligne le 08/09 15:55,
> puis **8 passages horaires sans une seule**, après *une par passage sans exception*. ⚠️ **Sa double
> condition était invérifiable telle qu'elle avait été écrite la veille : elle est REFORMULÉE, pas
> déclarée satisfaite.** *Le correctif ne retire aucun candidat, il les exclut à la sélection — donc
> une lecture voit le vivier, et le vivier GROSSIT (17 → 20, dont 3 → 4 immortels). C'est la fuite
> lente annoncée, à la vitesse annoncée.*
>
> 🔴 **Le seul chiffre qui ment ce jour est celui de T13.** Le recalage rend **0,0 %** d'échec sur
> 24 h contre 85,5 % la veille — **mais le 07/09 lui-même est passé de 85,5 % à 1,2 % pour LES MÊMES
> trajets**, recalés *après* leur clôture par le rattrapage. La fenêtre n'a pas bougé : **le passé a
> bougé.** `trips` n'a pas d'`updatedAt`, donc rien ne distingue « bien fait tout de suite » de
> « rattrapé la nuit suivante ». **La série de dix points ne se prolonge pas**, et **T28 est ouverte**
> pour redéfinir la mesure *avant* que quiconque ne conclue sur T13.
>
> ---
>
> ✅ **LE FAIT DU 08/09 : V11 REMONTE DE `»` À ✅ FAIT, ET LA PREUVE EST VENUE EN QUATRE
> EXEMPLAIRES.** Requalifiée **vers le bas** la veille — *« la règle n° 2 vaut aussi quand elle
> dérange »* —, elle remonte aujourd'hui **sur mesure, pas sur promesse** : `LastTriggerUSec` porte
> **07/09 04 h 30 min 56 / 04 h 40 min 56 / 04 h 50 min 30 UTC**, `ExecMainExitTimestamp` est **non
> vide** sur les trois, et chacun des trois dossiers porte **deux** copies. 🔑 *Le discriminant de
> VPS-M81 s'est retourné : le 06/09 les trois démarrages tombaient à la **même seconde** — un geste ;
> le 07/09 ils tombent à **dix minutes d'intervalle**, chacun à la seconde près sur son propre
> `OnCalendar` — un mécanisme.* Et une quatrième preuve, non demandée : le journal des unités compte
> sa propre rétention, **« 1 conservée » puis « 2 conservées »**. **Le seul constat de gravité 1 du
> VPS est clos**, 46 jours après son ouverture.
>
> 🔑 **Ce que le couple 07/09 → 08/09 démontre, et qui vaut mieux que la tâche elle-même :** la
> requalification de la veille n'a pas retardé le correctif d'une heure — **le mécanisme était déjà
> bon**. Elle a seulement refusé d'appeler « prouvé » ce qui ne l'était pas encore. *Attendre
> 26 heures était le prix de cette preuve, pas un retard.*
>
> 🆕 **Deux tâches neuves ce jour** — **V27** *(VPS-040 · VPS-M91)* : le collecteur réclame une
> sauvegarde de la base de **démonstration**, ce qui coûterait **~13 Go** pour copier une base que
> le serveur **reconstruit lui-même** chaque dimanche. Et **V26 est débloquée** : le test de V11
> étant clos, plus rien n'empêche de ranger les dossiers — dont le **faux orange quotidien est
> désormais mesuré** (trois « PÉRIMÉE » à 93 h pendant que les dossiers vivants portent 21 h).

> 🖥️ **Le même état, en visuel : [`TABLEAU-DE-BORD.html`](./TABLEAU-DE-BORD.html)** — un fichier autonome, regénéré à chaque passage des deux routines quotidiennes, qui se filtre par gravité, par partie et par état. *Il ne remplace pas ce fichier-ci : il en donne l'état, jamais le pourquoi.*

### Partie I — centre d'alerte *(38 tâches dans ce tableau ; T34 → T39 et T58 → T75 vivent dans `app/taches.json`)*

| | ID | Fiche | La tâche | État |
|:--:|:--:|---|---|---|
| ☐ | **T1** | TRK-071 | 🔴🔴 Recharger **au moins un** des deux comptes IA | 🤝 HUMAIN |
| ☑ | **T2** | TRK-069 | 🔵 ~~Rallumer le poste~~ — **le poste a repris SEUL le 06/09 à 06:08** | ✅ **FAIT** |
| ☑ | **T3** | TRK-066 | 🔴 Trancher les **trois questions** du coupe-circuit | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **T4** | TRK-072 | Calibrer les notifications d'excès de vitesse — **D9 tranchée le 13/09 : « ne rien changer »**, seuils et destinataires conservés | ✅ **FAIT** *(décision)* |
| ☑ | **T5** | TRK-062 | `SENT_UNCONFIRMED` pour les commandes de boîtier — **migration `20260913200000`, les 2 résidentes de 298 h closes au premier balayage de 20:30**, `commandes_en_attente` à **0** le 14/09 | ✅ **FAIT ET PROUVÉ** `66d286f5` |
| ☑ | **T6** | TRK-065 | Prévenir `tyger.bcn@gmail.com` — **voulu** (notifications en phase de test) ; `PUSH_ROLLOUT=SUPER_ADMIN_ONLY`, **4 remises 100 % super-admin après 20:25** (14/09, un point) | ✅ **FAIT** *(décision + réglage)* |
| ☐ | **T7** | TRK-035 | Ouvrir la fenêtre de maintenance *(rôle non-superutilisateur)* | 🤝 HUMAIN |
| ☑ | **T8** | TRK-001 · 027 | 🔵 Contrôler les antennes *(3 véhicules)* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☐ | **T9** | — | 🔵 Déclarer ou dépanner `GLA•KC•31` et `FG-669-DQ` | 🤝 HUMAIN |
| `»` | **T10** | TRK-070 | Le niveau de l'escalade suit la **cause**, pas la gravité | 🗓️ **DÉPLOYÉ** `2112e9ae` |
| ☑ | **T11** | TRK-068 | ✅ **EXERCÉE le 12/09 00:00:23** — 503, `ERROR`, « Vizyo Auth est injoignable … Motif technique : aucune reponse en 8 s » ; `http CRITICAL` reste à 2 | ✅ **FAIT ET PROUVÉ** `c80632ba` |
| ☑ | **T12** | TRK-022 | Déduplication **générique** des alarmes du boîtier — **livrée le 19/08**, entrée périmée close sur la mesure (14 j : 2 alertes max par type et par véhicule et par jour) | ✅ **FAIT** |
| `»` | **T13** | TRK-016 | Recalage — flux neuf réparé, **mesure redéfinie (T28)**, historique en rattrapage **15 par passage** (6 586 restants sur 2–60 j au 14/09) | 🗓️ **DÉPLOYÉ** `4d1c4cb5` |
| ☑ | **T14** | TRK-053 | **REQUALIFIER** — occasion venue **entière** le 14/09 : 0 alarme (10ᵉ point) **mais deux déclarés COUPÉS par le planificateur à 22:00, un rallumé à la main** — la déclaration ne retient pas l'automatisation *(7 j de dépassement)* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **T15** | TRK-060 | Guetter : « Un point de mesure système… » | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **T16** | TRK-064 | ✅ **CLOSE** — la sentinelle **désigne des véhicules** (`vehiculesHorsNorme`) **et sait se taire** : « cdef31 » 0 ligne le 09/09 | ✅ **FAIT ET PROUVÉ** `8fa14cb4` |
| ☑ | **T17** | TRK-065 | ✅ **EXERCÉE le 11/09 06:30** — `comptesTechniquesEcartes: 1`, compte technique absent ; 53 sur un compte au lieu de 42 sur deux *(numérateur ×2,5)* | ✅ **FAIT ET PROUVÉ** `68034a1d` |
| ☑ | **T18** | TRK-066 | Guetter « SMS non remis au relais » *(+ motif conservé)* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **T19** | TRK-032 | **REQUALIFIER** — **20 j** d'attente | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **T20** | TRK-051 | Confier à un humain — **16 j**, **30 s** pour qui a l'écran | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **T21** | TRK-018 | Accusé de remise de la passerelle SMS | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **T22** | TRK-014 | Rectifier son `quoiFaire` — fait le 13/09, republié | ✅ **FAIT** |
| ☑ | **T23** | — | `TACHES-AMELIORATION.md` — il était **à la racine** : déplacé dans `docs/` par `git mv`, renvois réécrits | ✅ **FAIT** |
| ☑ | **T24** | TRK-073 | ✅ **La ligne au DÉPART** — *24/24 le 08/09, **dont 1 marquée `interrupted`***, la consigne écrite d'avance est tombée au mot près | ✅ **FAIT ET PROUVÉ** `dae97b03` |
| ☑ | **T25** | TRK-074 | Résolution automatique du témoin des tâches — **les 4 `CRITICAL` du 06/09 archivées seules le 13/09 à 13:35, après 165 h** ; 0 active le 14/09 | ✅ **FAIT ET PROUVÉ** `171857fc` |
| ☑ | **T26** | TRK-075 | ✅ **PROUVÉ** — **33,3 h et 32 passages sans une ligne** ; ⚠️ la seconde moitié n'a pas bougé et **ce n'est pas une purge** : *ce sont les mêmes 4 analyses, vieillies d'un jour* | ✅ **FAIT ET PROUVÉ** `dc35f1a3` |
| ☑ | **T27** | TRK-076 | La carte **survit à une perte de contexte WebGL** — **0 ligne depuis le 07/09 13:04 : 180 h, 168 h après le déploiement**, le même compte revenu 5 jours sur 6 ; *une perte de contexte rattrapée n'a pas été observée — preuve par l'échéance* | ✅ **FAIT** `09d04e2b` *(15/09)* |
| `☑` | **T28** | TRK-016 | Mesure du recalage **à la clôture, sur la journée close** — 13/09 = **86 / 86 / 66 / 20 / 0** retrouvé **2 / 2** (15 et 16/09) ; ⚠️ **14/09 : 244 → 259 sans trajet né entre-temps, définition non versionnée** → **`collecte.sql` porte `recalage_journees_closes`** depuis le 16/09, série repartie (13/09 = 88 / 88 / 60 / 28 / 0, 15/09 = 273 / 273 / 263 / 0 / 0) — à retrouver le 17/09 | 🗓️ **DÉPLOYÉ** `4d1c4cb5`  ✅ **FAIT le 18/09** : 15/09 = **222 / 222 / 192 / 0 / 0** au mot près, 14/09 250 **3/3**, 16/09 figé 216 — la mesure est définie, versionnée, reproductible |
| `☑` | **T29** | TRK-077 | Garde du déploiement **jouée deux fois**, refus HH:42–HH:46, repères de repli — **14/09 ~11:47 : la seconde lecture a retenu un vrai déploiement** (passage 11:45 → 12:44) ; prouvé **par l'absence** (conteneur intact, `:latest` orpheline), jamais par une ligne → T66 | 🗓️ **DÉPLOYÉ** `18c975ee`  ✅ **FAIT le 18/09** : recréations **13:37:04** et **15:37:05** une seconde après la fin des passages (attentes 3 355 s et 6 012 s), 23 `done` / 0 `interrupted` ; le refus écrit reste T66 |
| `»` | **T30** | TRK-078 | Déduplication de l'alerte de vitesse sur l'**excès** + rattachement des alertes au trajet recalculé — **0 doublon et 0 excès depuis (dimanche) : indécidable**, verdict au premier jour ouvré | 🗓️ **DÉPLOYÉ** `229b7861` |
| ☑ | **T31** | TRK-069 | Une cause commune = **UNE** ligne `DEGRADATION`, levée au premier succès — **et `13471c53` : cinq contrôles sans rechute** sur l'échec ancien (14/09) | ✅ **FAIT ET PROUVÉ** `a8f9575e` |
| ☑ | **T32** | TRK-071 · 069 | Parade au plafond de la CLI — **D3 à D7 tranchées le 13/09** (pas d'API pour les agents, tous les trajets narrés, le poste sait qu'il est au plafond = T34, Opus pour les audits, second abonnement plus tard = T35) | ✅ **FAIT** *(décisions)* |
| ☑ | **T33** | TRK-077 | **`deploy.sh` rendu INCONTOURNABLE — détecté, pas empêché** : journal des déploiements + sentinelle « déploiement hors script », **exercée volontairement** le 13/09 12:55 → ligne 12:57 | ✅ **FAIT** `18c975ee` |
| ~ | **T58** | TRK-069 | La clé de refroidissement d'un échec porte l'empreinte de sa cause ; `courrier-ia` lit le premier objet JSON équilibré | » **DÉPLOYÉ** `1539674c` le 15/09 |
| ~ | **T59** | TRK-079 | Un fetch avorté par la fermeture de la page ne remonte plus ; le canal anonyme ne remonte que les bugs JS | » **DÉPLOYÉ** `314e4193` le 15/09 |
| ~ | **T60** | main · 152883ec | `fenetre-utile.spec.ts` lit une seule horloge (figée) | » **DÉPLOYÉ** `979fdfec` le 15/09 |
| ☐ | **T61** | TRK-066 · S21 · doc 10 | 🆕 **Deux SIM restent injoignables par SMS depuis le S21** (HD-584-BF, BP-434-RD — `failed` au départ le 14/09 09:34, boîtiers en ligne) ; les 8 autres sont revenues après remise en état du téléphone (…621085 : delivered en 8 s) ; TCP seul pour ces deux-là ; 1 SMS depuis un autre opérateur ou ticket WhereverSIM | 🤝 HUMAIN |
| ~ | **T62** | TRK-066 · doc 35 | 🆕 **Une SIM injoignable par SMS met le véhicule en « TCP seul »** — coupe auto seulement boîtier connecté, RESTORE en TCP toutes les 5 min, un SMS-sonde par 6 h, une ligne par jour | » **DÉPLOYÉ** `b3ee67e2` le 15/09 |
| ☑ | **T63** | TRK-066 · doc 25 §2 | **C — Prérequis J-1 — FAITS le 15/09** (Device ID écrit, numéro de preuve, v1.43.0, créneau) ; reste vivant : **le S21 branché en permanence** (hors ligne 15:49→19:51 le 15/09) | ✅ **FAIT** |
| » | **T67** | TRK-066 · T51 | **La sentinelle des RESTORE relisait tout l'historique après la migration** (~50 `FAILED` de juillet-août, un CRITICAL toutes les 15 min à vie) — bornée à 24 h ; **16/09 : moitié prouvée** — 3 rappels jusqu'à 18:06, **0 depuis** (28 dus), les 50 ne sont plus relues ; reste : une RESTORE *de la nuit* produit sa ligne | » **DÉPLOYÉ** `0c9672c9` le 15/09 |
| `☑` | **T65** | TRK-066 · doc 25 §7 | **E — 24 h de preuve lues par la routine du centre d'alerte** (six verdicts) — **16/09 : LUE POUR LA PREMIÈRE FOIS** : ping OK, 1 épisode Android expliqué, interlock **rouge par construction** (aucune preuve < 24 h avant 02:30), RESTORE / TCP seul non exercés, preuve quotidienne non exerçable ; *pas encore de Go pour le banc* | 🗓️ **DÉPLOYÉ** *(preuve : deux passages OK consécutifs)*  ✅ **FAIT le 18/09** : lue trois passages de suite (16, 17, 18/09) — second passage OK acquis |
| » | **T69** | TRK-066 · T45 · T49 | 🆕 **Preuve SMS aussi à 21:30 (verdict 21:45) + notifications push aux super-admins** quand le coupe-circuit est bloqué — né de la 1re nuit (24 coupes retenues jusqu'à 04:30, personne d'averti) | » **DÉPLOYÉ** `87ae29c9` le 16/09 |
| ☐ | 🆕 **T71** | TRK-083 · T48 | 🔴 **Armer le guetteur d'ACK TCP AVANT l'écriture socket** (ou mémoire de 30 s dans `AckWaiter`) — *GR-898-HY a répondu `jt` 0,9 s avant l'inscription du guetteur (armé après `beginAttempt` + `writeSent`, 8,5 s ce soir-là) → `SENT_UNCONFIRMED` pour une coupe exécutée ; sur une RESTORE = SMS + `CRITICAL` + push à tort* ; jumeaux `tracker-commands` / `tracker-fix-mode` (TRK-014) | 🔧 À CODER · **gravité 2** |
| ☐ | 🆕 **T70** | TRK-082 · T30 | **La sentinelle « excès sans alerte » doit lire la même clé que T30** (l'excès, pas le `tripId`) — *3 trajets recréés par le recalcul accusés à tort, alors que leur excès a alerté sur le jumeau* ; double condition : silence sur ces cas ET parole sur un excès sans aucune alerte | 🔧 À CODER · gravité 3 |
| ☐ | **T68** | TRK-081 · T49 | 🆕 **L'interlock rouge toute une nuit écrit un `CRITICAL` par quart d'heure et un e-mail par heure** (20 lignes, 5 e-mails le 15/09 au soir) — `signalWithheldCut` : 1ʳᵉ ligne `CRITICAL`, rappels `DEGRADATION` horaires, ligne de clôture, réouverture `CRITICAL` si la raison change ; **sans toucher à la garde** | 🔧 À CODER |
| ☐ | **T66** | TRK-077 | 🆕 **`deploy.sh` journalise ses REFUS et abandons, et la sentinelle « déploiement » les dit** — le 14/09 un refus juste s'est lu comme un succès partout sauf dans le conteneur | 🔧 À CODER |

#### Chantier coupe-circuit — contre-expertise du 13/09 *(T40 → T57, nées le 13/09 au soir ; T34 → T39 vivent dans `app/taches.json`)*

| | ID | Fiche | La tâche | État |
|:--:|:--:|---|---|---|
| ~ | **T40** | TRK-066 · doc 19 P0-1 | 🔴🔴 P0 — La clé d'unicité RESTORE ne doit plus vivre pour toujours (RESTORE du lendemain avalée) — COMMITTÉ d5c19a17, en attente de fusion | » **DÉPLOYÉ** `d5c19a17` le 15/09 |
| ~ | **T41** | TRK-066 · doc 19 P0-2 | 🔴🔴 P0 — Donner une validité aux SMS CUT (ttl), une priorité aux RESTORE, un appareil explicite, et annuler le SMS CUT supplanté | » **DÉPLOYÉ** `8ab1d08e` le 15/09 |
| ~ | **T42** | TRK-066 · doc 19 P1-1 | 🔴 Relancer une RESTORE non prouvée à la reconnexion TCP du boîtier — et ne plus la rendre terminale après trois SMS | » **DÉPLOYÉ** `86c32fa9` le 15/09 |
| ☑ | **T43** | TRK-066 · doc 19 P1-2 | 🔴 Téléphone S21 **configuré le 14/09** (ping 60 s prouvé sur `lastSeen`, FIFO, délais 10/15 s, limite 60/h, Local server OFF, veille OFF) — restent les variables du relais (doc 25 §4.2) et 30 min écran éteint à relire | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ~ | **T44** | TRK-066 · doc 19 P1-2 | 🔴 Sentinelle Android : hystérésis, bornes d'environnement, fraîcheur par appareil, délai d'envoi séparé du délai de santé | » **DÉPLOYÉ** `86a2fc53` le 15/09 |
| ~ | **T45** | TRK-066 · doc 19 P1-3 | 🔴 Preuve SMS quotidienne réconciliée (T-30 min avant chaque fenêtre) — sans elle l'interlock refuse les coupes six jours sur sept | » **DÉPLOYÉ** `1aa1e0f9` le 15/09 |
| ☑ | **T46** | TRK-066 · doc 19 P1-4 | 🔴 Nettoyer le diff du chantier (reformatage prettier), rebaser sur main, résoudre le conflit — la production est déjà sur 66d286f5 | ✅ **FAIT** `d5c19a17` |
| ☑ | **T47** | TRK-066 · doc 19 P1-5 | **La fenêtre — JOUÉE le 15/09 au soir** (19:20–20:15) : V28 tué, 3 sauvegardes, variables, relais `724bcb8`, migration rejouée sur copie, `deploy.sh` → prod `fa9ff1d1` (19:35) puis `0c9672c9` ; kill-switch **true** ; S21 hors ligne 15:49→19:51 vu par la sentinelle | ✅ **FAIT** |
| ~ | **T48** | TRK-066 · doc 19 P2-1 · P2-4 | Course ACK/SMS : une preuve ne se rétrograde jamais en « envoyée » (écritures conditionnelles) ; une CUT PENDING orpheline est dispatchée | » **DÉPLOYÉ** `8a8cb2c4` le 15/09 |
| ~ | **T49** | TRK-066 · doc 19 P2-2 | Kill-switch et interlock : une ligne par véhicule et par heure, pas un CRITICAL par appel | » **DÉPLOYÉ** `93dba465` le 15/09 |
| ~ | **T50** | TRK-066 · doc 19 P2-3 | Glissement de confirmation réellement volontaire : 8 valeurs croissantes depuis < 10, End/Home/Page neutralisées, flèche maintenue acceptée | » **DÉPLOYÉ** `8bb24ca7` le 15/09 |
| ~ | **T51** | TRK-066 · doc 19 P2-5 · P2-6 | Une RESTORE non prouvée se rappelle toutes les 15 min ; SMS en file > 60 min annulé et retenté ; clic manuel borné à 20 s | » **DÉPLOYÉ** `b582fbf6` le 15/09 |
| ~ | **T52** | TRK-066 · doc 19 P2-8 · P2-9 | Santé par appareil (fait par T44, relais `784d766`) ; allowlist non bloquante pour une RESTORE (ajout à la volée + un nouvel essai) | » **DÉPLOYÉ** `428d1f39` le 15/09 |
| ~ | **T53** | TRK-066 · doc 19 P2-10 | Journal des tentatives exercé (CHECK + unicité rejoués depuis le SQL de la migration), index dans schema.prisma (T47), changement d'heure du 25/10 couvert — reste PostGIS réel et la rétention | » **DÉPLOYÉ** `b407481a` le 15/09 |
| ☑ | **T54** | TRK-066 · doc 19 §3 phase 5 | 🔴 Recette réelle : boîtier de banc, puis un canari MH Cars, puis un CDEF31 — un à la fois, présence physique, jamais les 37 | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☐ | **T55** | TRK-066 · doc 12 · doc 19 P2-8 | Second téléphone + seconde SIM (autre opérateur) — après T52, jamais sous le même deviceId | 🤝 HUMAIN |
| ☑ | **T56** | TRK-066 · doc 19 §15 | Promesses des documents 01–18 datées « tenu / tenu autrement / non implémenté » (doc 32) | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☐ | **T57** | TRK-066 · doc 19 §14 | Dépendances : lot séparé après stabilisation (maplibre critique, socket.io/ws, axios via twilio, multer) | 🔧 À CODER |
| ☐ | 🆕 **T76** | TRK-089 · TRK-081 · T68 | 🟠 **Le watchdog du téléphone : UNE `CRITICAL` par épisode, rappels `DEGRADATION` horaires, UNE ligne de sortie qui archive — et la preuve remise en retard doit refermer son verdict `INDETERMINEE`** *(19/09 : S21 hors ligne 2 h 22, 9 `CRITICAL`, 2 `INDETERMINEE`, preuves remises à 04:46, rien ne l'écrit)* | 🔧 À CODER · gravité 3 |

### Partie II — VPS *(37 tâches)*

| | ID | Fiche | La tâche | État |
|:--:|:--:|---|---|---|
| ☑ | **V0** | — | ✅ **Docs VPS versées sur `main`** *(06/09)* | ✅ **FAIT** |
| ☑ | **V1** | VPS-038 | 🔵 Porter les **3 IMEI encore muets** de la cohorte du 08-31 à l'exploitant *(3 sont revenus le 11/09 ; gravité **1 → 2** le 13/09)* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V2** | VPS-038 | 🔵 Sortir du parc les 6 boîtiers muets > 7 j | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☐ | **V3** | VPS-036 · 027 | 🔵 **Un seul ticket hébergeur** *(2 écritures root)* | 🔵 PRODUIT |
| ☐ | **V4** | VPS-010 | Planifier un redémarrage *(noyau -136 contre -139, 6 services, **3 correctifs de sécurité** ; 16/09 : **débloquée**, uptime 42,3 j ; **17/09 : re-bloquée par V33 — tuer le client AVANT**)* | 🔴 HUMAIN |
| ☐ | **V5** | VPS-M56 | Arbitrer le budget de collecte *(26 dépassements ; 16/09 : **143 s sans `dockerd`** = 147 s d'avant l'incident — le poste n° 1 est `/opt`, 42 s)* | 🟡 PRÉPARÉ |
| ☐ | **V6** | VPS-037 | 🔴 Second dépositaire de la copie hors-site — **16/09 : le poste dormait à 06:30, pas de copie, 2ᵉ paire de nuit sans copie en 3 jours** (gravité 3 → 2) ; geste immédiat côté poste : `WakeToRun` ; **17/09 : le poste a dormi 23:17 → 03:15 Z, 2 paires sans copie, la 3ᵉ (gravité 1) se joue à 04:30** | 🟡 PRÉPARÉ |
| ☐ | **V7** | VPS-005 | Limites mémoire — **31 conteneurs sur 38** *(dont le coffre, VPS-042)* | 🔴 HUMAIN |
| ☐ | **V8** | VPS-020 | Séparer les projets compose `deploy` | 🔴 HUMAIN |
| ☑ | **V9** | VPS-017 | 4,5 Go d'outillage dans `/root` | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V10** | VPS-018 | Retirer `/opt/vizyo-leads` | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V11** | VPS-013 | ✅ **3 bases de prod sauvegardées de façon reproductible** — *les 3 minuteries ont déclenché **seules**, aux 3 horaires attendus* | ✅ **FAIT ET PROUVÉ** *(08/09)* |
| ☐ | **V12** | VPS-012 | Restreindre la clé CI `vizyo-auth` *(10 s)* | 🟡 PRÉPARÉ |
| ☐ | **V13** | VPS-015 | `ExecStart` par `bash` **+ `OnFailure=` sur `tracky-backup`** | 🟢 AUTO |
| ☐ | **V14** | VPS-033 | **Fixer l'heure** du rafraîchissement `apt` — **geste confirmé par le code le 14/09** : deux sonneries/jour, la 1ʳᵉ du jour UTC rafraîchit ; 18 % de mesures valides prédits **et** mesurés | » **POSÉE 20/09 13:12** — drop-in `OnCalendar=01:30` + `RandomizedDelaySec=15m` (avant : 06,18:00 + 12 h aléatoires) ; preuve : « MESURE VALIDE » à 02:22 deux jours de suite |
| ☐ | **V15** | VPS-034 | Épingler Traefik par digest *(déjà relevé)* | 🔴 HUMAIN |
| ☑ | **V16** | VPS-026 | Épingler `alpine` par empreinte *(déjà relevée)* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V17** | VPS-030 | Ménage du VPS — copies sans rétention *(16/09 : **+161 Mo + 172 Ko** de dumps de la fenêtre du chantier, à **déplacer** dans un dossier daté, jamais supprimer)* | ✅ **FAIT 20/09 13:12** — 4 archives dans `/var/backups/instantanes-chantier-20260915/`, racine vide ; reste `/root/backups` (août, décision à part) |
| ☑ | **V18** | VPS-032 | Multiplexage SSH **côté poste** | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V19** | VPS-007 | `random_page_cost` — *déconseillé en l'état* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V20** | VPS-M79 | Étiqueter les images de repli au build | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V21** | VPS-029 | Trancher quel mécanisme gouverne le cache de build | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V22** | VPS-M36 | Échantillonner `wchan` 3× et publier la répartition | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☐ | **V23** | VPS-M73 | Afficher l'écart en jours sur `/admin → Audit VPS` | ⛔ BLOQUÉ |
| ☑ | **V24** | VPS-038 | **Sentinelle « boîtiers muets »** — *2 lignes à 06:30, pas 10 : **exact*** | ✅ **FAIT ET PROUVÉ** |
| ☑ | **V25** | VPS-M59 | **`chargeDeFond.note` s'affiche** + repli explicite — *a survécu au rebuild du 07/09* | ✅ **FAIT ET PROUVÉ** |
| ☑ | **V26** | VPS-013 · M88 | 🔓 **DÉBLOQUÉE** — ranger les **3 dossiers abandonnés** ; le faux orange est désormais **mesuré**, pas prédit | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V27** | VPS-040 · M91 | Trancher si la base de **démo** doit être sauvegardée *(le 🔴 vaut **15 Go** ; **15/09 : la question d'hier est close — la démo n'a JAMAIS analysé, `enabled=false` depuis le 07/09, `lastRunAt` NUL ; ses analyses sont importées** — il ne reste qu'une décision)* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☑ | **V28** | VPS-016 | ✅ **PROUVÉ 16/09 en quatre lectures** (`sar` 39 → 86 % à 18:40, `dockerd` 0,7 %, 0 client, `deploy.sh` **226 s**) — **Tuer le client Docker bloqué depuis le 13/09 04:34 UTC** (`docker logs texto-relay`, PID 159541, parent 159533 **vivant, PPID 1 — le parent d'abord**) — `dockerd` à 100 % d'un cœur, **5ᵉ occurrence** ; **15/09 02:28 : 46ᵉ heure, 2ᵉ journée entière sous 50 % (38,9 %), `deploy.sh` de 08:20 en 1 916 s contre 303–585 s — aucune durée à deux cœurs n'existe** — *à faire AVANT le prochain déploiement* | ✅ **CLOSE 15/09** — optimisation des tâches (voir la fiche) |
| ☐ | **V29** | VPS-041 | 🔴 **Un seul rotateur pour les journaux de conteneur** — retirer la stanza `logrotate` à `copytruncate` qui perce des trous de NUL *(16/09 : 4ᵉ nuit, 1,63 s de CPU, **6** courants troués — **tous des `-dev-`**, les 3 de production sont sortis par recréation ; ⚠️ `rotate 14` y est posé POUR TRK-035 → compenser par `max-file: 14` sur `tracky-postgres` ; **V28 faite : seule remédiation ouverte sur la classe de VPS-016**)* ; **17/09 : 5ᵉ nuit, 21,9 s de CPU — et la 6ᵉ occurrence de VPS-016 ne visait pas un troué** | 🟡 PRÉPARÉ |
| ☐ | **V30** | VPS-042 | 🔵 **Reconnaître le coffre Vaultwarden, `vaultbk`, `conductorbk`, 🆕 `dispocarbk`, `179.198.198.199` — et le rôle de DÉPOSITAIRE de DEUX applications** : *15/09 — 3ᵉ compte créé dimanche 05:32 depuis la même adresse, script copié de `recevoir-dump` ; **4 dumps de 1 172 octets, `prd` = `dev`** : base vide ? à vérifier côté Dispocar* ; session `vaultbk` 124 h ; limite mémoire | 🔵 PRODUIT |
| ☐ | **V31** | VPS-043 · 037 | 🔴 **Réparer le copieur hors-site de Verify** — *le 14/09 04:30 il s'est arrêté sur un **manifeste orphelin** (archive purgée par le VPS, manifeste pas encore) et **n'a pas atteint la paire de la nuit** (`pairesCopiees 0`) ; le collecteur affichait « à jour »* : côté poste, ne plus `throw` sur une paire incomplète + parcourir du plus récent au plus ancien ; côté VPS, purger **par paire**. Preuve : le 16/09, `statut OK` **et** `pairesCopiees ≥ 2` — **16/09 : le 15/09 04:30 a rendu `OK`, `pairesCopiees 2`** (les deux manifestes orphelins sont partis ensemble : branche « preuve de la copie », **mécanisme intact**) ; ⚠️ et le 16/09 **aucune tentative** (poste endormi → V6) | 🟢 AUTO |
| ☑ | 🆕 **V33** | VPS-016 | 🔴🔴 **Tuer le client `docker logs --tail 15 vizyo-auth-api` bloqué depuis le 16/09 12:41 UTC** (PID 3366708, parent `bash -c` 3366707 → `init`, **14 h 48** à 03:29 le 17/09, `dockerd` **91,7 %**, charge 1,32) — **6ᵉ occurrence de VPS-016**, même classe que V28 (diagnostic sans `timeout` depuis une session SSH du poste, cette fois sur `vizyo-auth-api`) ; a probablement fait ramer la base à 20:01 (TRK-083). `kill 3366707` (le parent), vérifier `pgrep -x docker` vide | ✅ **FAIT 20/09 ~05:25** — les deux parents puis les deux clients (nº 6 **et** nº 7) tués par le propriétaire ; `pgrep -x docker` vide ×4, `dockerd` 0–3 %, cumul figé 395,5 h. ⚠️ **Le CPU n'est pas revenu** : c'est l'hôte → **V35** |
| ☐ | 🆕 **V32** | VPS-044 | 🟠 **Rendre le repère de repli réel** — *16/09 : le ménage de 00:40 a **effacé l'image de 9afdf52a** (`avant-20260914-1140`, 37 h) 6 h 25 après le déploiement de 0c9672c9 ; `deploy.sh --repli` sur cette étiquette **échouerait** ; les `avant-20260915-*` restantes = images **pré-construites**, jamais en service* : (a) `until=72h` sur le ménage (10 s) ; (b) `deploy.sh` étiquette l'image du **conteneur**, pas `:latest` ; **17/09 : ½ preuve — `avant-20260916-0519` = l'image d'hier ✅, mais elle meurt le 18/09 00:40 sans (a)** ; **20/09 : 2ᵉ ½ preuve par la même chance (`avant-20260919-1537` = `84cc3fe36db2`)** | » **(a) FAITE 20/09 13:12** (`until=72h` ; preuve demain : l'étiquette du 19/09 survit au ménage) · 🔧 (b) à coder |
| ☑ | 🆕 **V33** | VPS-016 | 🔴 **Tuer le client Docker bloqué depuis le 16/09 12:41 UTC** — *6ᵉ occurrence, 19 h 21 après V28 : `docker logs --tail 15 vizyo-auth-api` (pid 3366708) depuis un `bash -c` de diagnostic du poste (pid 3366707, PPID 1 — **le parent d'abord**) ; `dockerd` 98 %, 09-17 partiel 38,65 %* ; puis **une ligne dans `CLAUDE.md`** : `docker logs` sur le VPS = `timeout 20` — 6 occurrences sur 6 | ✅ **FAIT 20/09 ~05:25** *(même ligne que ci-dessus — la ligne `CLAUDE.md` est **V34**, toujours ouverte)* |
| ☐ | 🆕 **V34** | VPS-016 | 🔴🔴 **Plus jamais un `docker logs` sans `timeout` depuis le poste** — *7 occurrences sur 7 viennent d'une session SSH du poste ; le 7ᵉ (19/09 18:30:17, `docker logs --tail 500 ae54b0ff3f79` = foodsqan-traefik, script « PROXY/ROUTEURS », 4 min après le déploiement marketing) a pris le 2ᵉ cœur (`%idle` 37 → 7 %) et l'hyperviseur reprend **89 %** du CPU depuis* : une ligne dans `CLAUDE.md`, la mémoire des agents, les deux scripts de diagnostic corrigés, `pgrep -x docker` lu AVANT chaque audit | 🔧 À CODER · **gravité 1** — **20/09 11:18 : diff de `CLAUDE.md` relu, la ligne n'y est toujours pas** (la mémoire du poste, si) |
| ☑ | 🆕 **V35** | VPS-045 · 016 | ✅ **FAIT 20/09 13:36** — *Hostinger : « a CPU limitation was active and it has now been successfully removed » ; steal 89 → 1 %, 14 conteneurs rallumés 13:38* — **L'hôte retient 80 à 90 % du CPU depuis le 19/09 22:10 UTC — et ne l'a pas rendu après la mort des deux clients** — *part servie 97 → 79 → 54 → 32 → 11 % par paliers à :10 (22:10 → 01:10), 10 % jusqu'à 05:20, puis un plateau plat à ~21 % de 05:30 à 11:10 alors que `dockerd` est à 1 % et qu'il reste de l'idle : un **plafond**, pas une contention. Coût mesuré : 30 reprises du matin → 11 ≤ 10 s, 16 en 10–60 s, 3 > 60 s, **2 par SMS payant** (T71 exercé) ; sauvegarde Tracky 64 min ; Vizyo Auth 503 à minuit* : (1) **ticket hébergeur** avec l'extrait `sar` ; (2) **`docker compose stop` sur les 18 conteneurs hors production** (`maalem-dev` ×6, `maestroo-dev` ×4, `tracky-demo` ×4, `dronely` ×2, maquettes, dg-epaviste — **jamais `foodsqan-traefik`**) avant 18:00 UTC ; (3) **ne rien ajouter** : ni déploiement, ni build, ni V4 | 🤝 HUMAIN · **gravité 1** |
| ☐ | 🆕 **V36** | VPS-046 · 040 | » **(a) FAITE 20/09 13:40** — *démo recréée sur `latest`, 5 migrations jouées, « Import réussi » 13:47 ; (b) `deploy.sh` à coder* — **Recréer la pile de démo sur les images courantes, et faire lancer ce `up -d` par `deploy.sh`** — *20/09 04:07:58 : l'import hebdomadaire a **échoué** — « The column `managedByManagerAt` does not exist » : l'importeur (`tracky-api:latest`, code du 19/09) contre une base de démo au schéma du 13/09 ; la pile démo n'a pas été recréée depuis 3 déploiements, `deploy.sh` ne lance pas le `up -d` de la démo que son compose déclare indispensable ; API démo arrêtée 8 min 35 pour rien, données figées au 13/09* : (a) `docker compose --env-file .env.demo -f docker-compose.demo.yml up -d` quand V35 est levée (ou après le `start` de la pile) ; (b) la ligne dans `deploy.sh` | 🟡 PRÉPARÉ · 🔧 |



> ⭐ **Les deux tâches les plus rentables de tout le fichier, si vous n'en faites que deux :**
> **T1** *(recharger un compte IA — rien d'autre ne débloque quoi que ce soit, **145 h au 09/09**)*
> et **T25** *(la résolution automatique du témoin des tâches — 4 `CRITICAL` traînent depuis 4 jours
> pendant que sa jumelle archive seule, et **c'est ce genre d'écran qui finit par faire dire « videz
> tout »**)*.
>
> *T24, qui occupait cette place depuis le 06/09, est **faite et prouvée** le 09/09.* 🔑 **Et elle
> laisse une leçon de méthode plus durable que le correctif :** sa consigne d'acceptation prévoyait
> **d'avance la façon dont on aurait pu la satisfaire malhonnêtement** (« si le compte monte à 24
> sans qu'aucune ne soit marquée, on a maquillé le carnet »). *C'est ce qui sépare une preuve d'un
> chiffre qui arrange* — et c'est reproductible sur n'importe quelle autre tâche de ce fichier.
>
> *T10, qui occupait cette place hier, est **déployée**.* ⚠️ **V11 y était aussi, annoncée « faite
> et prouvée » — elle est redescendue à **déployée** le 07/09 : ses trois minuteries n'avaient
> jamais déclenché seules. Sa vérification du 08/09 est, de fait, la troisième tâche la plus
> rentable du fichier : deux minutes de lecture pour clore ou rouvrir le seul constat de gravité 1
> du VPS.*

> ⚠️ **Six fiches apparaissent deux fois, et c'est voulu** — TRK-065 en **T6** *(prévenir la
> personne)* et **T17** *(guetter la ligne)* ; TRK-066 en **T3** *(trancher la garde)* et **T18**
> *(guetter le message)* ; TRK-062 en **T5** *(autoriser)* et dans les bloquées ; TRK-035 en **T7** ;
> TRK-027 dans **T8** ; VPS-038 en **V1** et **V2**. *Une fiche n'est pas une tâche : elle peut en
> porter deux, qui ne se font ni par les mêmes mains ni au même moment.*

> 👁️ **Les relevés récurrents ne sont PAS dans ce tableau** — ils ne se cochent pas, ils se
> reprennent à chaque passage. Ils vivent dans les deux sections **« À SURVEILLER »**
> ([Partie I](#-à-surveiller--rien-à-coder-une-mesure-à-relever-à-chaque-passage) ·
> [Partie II](#-à-surveiller--rien-à-appliquer-une-mesure-à-relever-à-chaque-passage)).

---

## Récapitulatif des six derniers audits

| Date | Actives | Le fait du jour, en une ligne |
|---|---|---|
| **15/09** | 194 | **Le coupe-circuit a tourné hier soir sur l'ancien code** (24 coupes TCP, 2 déclarés « débranchés » coupés, 1 rallumé à la main) **et la mise en production de 11:40 n'a pas eu lieu** — retenue par la garde de T29, sans trace, pendant que le commit dit « déployé » *(🆕 TRK-080, T66 ; T27 FAIT ; 13 `CRITICAL` archivées seules)* |
| **01/09** | 26 | Six véhicules ont perdu leur alimentation le 31/08 — **et l'écran avait promis le silence sans le tenir** : 7 alertes sur 8 écrites APRÈS la déclaration « boîtier débranché » *(🆕 TRK-052, TRK-053)* |
| **02/09** | 30 | Le parc n'a jamais été aussi bien réglé (44/44 cibles canoniques) — **mais l'écran des commandes raconte l'inverse** : 46 fois sur 46, la « cible atteinte » qui suit un échec porte une AUTRE cible *(🆕 TRK-059, TRK-060)* |
| **03/09** | 35 | **Le compte Anthropic tombe à sec**, et le dispositif classe l'incident en « appel malformé » : ni le niveau, ni l'écran « Coûts IA » ne nomment la seule action utile *(🆕 TRK-061, TRK-062)* |
| **04/09** | 44 | Premier `CRITICAL` en 12 jours : **une plaque à point médian fait répondre 500 à TOUS les exports** de 2 véhicules sur 44, depuis toujours *(🆕 TRK-063 → TRK-066)* |
| **05/09** | 65 | **Déploiement non annoncé de 17:01** : six correctifs d'un coup, deux prouvés le jour même (TRK-061, TRK-059) ; les alertes de vitesse enfin armées sur 2 sociétés sur 5 *(🆕 TRK-067, TRK-068)* |
| **07/09** | **94** | **La tâche tournait, son carnet de bord était vide, et le témoin a crié « à l'arrêt »** — 8 passages sur 24 perdus le 06/09 alors que **sept portent la preuve d'avoir tourné** *(🆕 TRK-073, TRK-074)* |
| **06/09** | **82** | **Les DEUX fournisseurs IA sont à sec en même temps** — le repli `claude → gpt` livré la veille a été exercé 6 min après sa mise en ligne et n'avait nulle part où aller *(🆕 TRK-070, TRK-071, TRK-072)* |
| **08/09** | **118** | **Un seul trajet du 8 juillet produit 15 des 17 défauts neufs** : ses positions viennent de franchir le front de purge, et trois commentaires promettent un silence que leur couche n'a pas le pouvoir d'accorder *(🆕 TRK-075, TRK-076)* |
| **09/09** | **138** | **Une preuve écrite d'avance tombe au mot près** — 24 passages sur 24 dont **1 marqué `interrupted`** *(T24 ✅)*, le trajet du 8 juillet se tait *(T26 `»`)*, et **le seul chiffre qui ment est celui du recalage : le passé a été réécrit** *(🆕 T28)* |
| **13/09** *(couvre 11→13)* | **202** | **Un troisième canal IA à sec, et c'est le seul qui coupe aussi les audits** — la CLI du poste au plafond hebdomadaire pendant 80 h : 31 des 63 lignes nées, 0 casse, et **les audits des 11-12/09 n'ont pas eu lieu**. Pendant le silence, **T11 et T17 se prouvent seules** ; 🆕 **TRK-078** : 1 alerte de vitesse sur 5 est un doublon, le recalcul réécrit la clé *(T30, T31, T32)* |
| **10/09** | **145** | **Les trois tests datés de la veille sont franchis** — 33 h sans « Analyse impossible » *(T26 ✅)*, le rattrapage porte **+433 trajets recalés** *(T13)*, et la sentinelle de vitesse livre sa forme neuve **un jour en avance, en se taisant sur la flotte qui n'avait rien à dire** *(T16 ✅)*. 🆕 **T29** : la garde du déploiement est **présente, correcte, et ne protège de rien** — lue au moment où l'on décide de construire, pas au moment où l'on va tuer |
| **14/09** | **198** | **Premier passage après les huit déploiements du 13/09, et la baisse vient de correctifs qui referment seuls** — 4 `CRITICAL` du témoin des tâches archivées d'elles-mêmes après 165 h *(T25 ✅)*, les 2 commandes SMS de 298 h closes au premier balayage et **0 commande en attente** *(T5 ✅)*, T31 tient sur cinq contrôles ; 🆕 **TRK-079** : deux robots EC2 rapportent en `keepalive` des appels avortés par la fermeture de page *(T59)* ; 🆕 **T58** : un échec `courrier-ia` muet sous une clé de refroidissement consommée par une autre cause ; les trois « Retour LLD » **renommés sans lever la déclaration** ; **V28 toujours là, 20 h 47** |

**Ce que la série raconte** — les actives passent de 26 à 82 en six jours, et **ce n'est pas une
dégradation de la plateforme** : **48 des 82** sont des `DEGRADATION` (Overpass, dépendance tierce
assumée), et parmi les 34 défauts, **12 lignes sont historiques et déjà closes** (TRK-067, éteinte
le 04/09) et **3 viennent d'un capteur né la veille** (TRK-069). *Un compteur qui monte parce qu'on
vient d'installer des instruments n'est pas le même compteur.*

> 🔑 **Le motif structurant de la semaine, vu quatre fois :** un correctif de message est déployé,
> **et le même défaut ressort par une chaîne voisine** — TRK-060, puis TRK-066, puis TRK-068, puis
> TRK-070. *Aucun appel sortant de ce dépôt n'a de gabarit de message d'échec ; on les corrige un
> par un, à raison d'un par jour.*

---

## L'ordre, et pourquoi c'est celui-là

Trois critères, appliqués dans cet ordre — **pas** la gravité seule :

1. **Est-ce que ça nuit MAINTENANT, en production ?**
2. **Est-ce que ça rend le dispositif AVEUGLE ?** Un instrument qui se tait pour une mauvaise raison
   coûte plus cher que le défaut qu'il devait voir : il transforme chaque passage suivant en fausse
   bonne nouvelle.
3. **Le geste est-il connu et borné ?** À nuisance égale, ce qui se corrige en une passe passe avant
   ce qui demande une décision produit ou une intervention terrain.

### Les cinq états d'une tâche

| État | Ce que ça veut dire |
|---|---|
| 🤝 **HUMAIN** | Décision produit, action terrain, ou geste hors code. Écrit ici, **jamais fait d'office**. |
| 🔧 **À CODER** | Cause racine connue, correctif spécifié, personne ne l'a écrit. |
| 🗓️ **DÉPLOYÉ, NON EXERCÉ** | En production, **mais l'occasion de le prouver n'est pas venue**. Une consigne datée attend. |
| 👁️ **SURVEILLER** | Rien à coder. Une mesure à relever à chaque passage, pour qu'une tendance devienne dicible. |
| ⛔ **BLOQUÉ** | Un prérequis manque : migration, fenêtre de maintenance, donnée non persistée. |

> ⚠️ **Le vocabulaire des statuts du référentiel n'a pas de case « déployé mais non prouvé ».**
> Il n'offre que `CORRECTIF_PROPOSE` (correctif écrit) et `CORRIGE` (livré **ET vérifié**). Quatre
> fiches vivent aujourd'hui entre les deux et restent donc marquées `CORRECTIF_PROPOSE` alors que
> leur code est **en ligne**. *C'est une limite connue du vocabulaire, pas une erreur de cotation —
> et c'est exactement ce que la colonne « état » de ce fichier sert à dire.*

---

# 🤝 CE QUI ATTEND UNE DÉCISION OU UN GESTE HUMAIN

*Rien de tout ceci ne se corrige par du code. C'est la liste la plus courte — et la plus bloquante.*

| | ID | Fiche | L'action, en une phrase | Depuis |
|:--:|:--:|---|---|---|
| ☐ | **T1** | [TRK-071](./REFERENCE-ERREURS.md#trk-071) | 🔴🔴 **Recharger au moins UN des deux comptes IA** — Anthropic **et** OpenAI sont vides | **76 h** |
| ☐ | **T2** | [TRK-069](./REFERENCE-ERREURS.md#trk-069) | 🔵 **Rallumer le poste** et lire le motif d'échec de `agent-recit-trajet` | 05/09 |
| ☐ | **T3** | [TRK-066](./REFERENCE-ERREURS.md#trk-066) | 🔴 **Trancher les trois questions du coupe-circuit** *(détail ci-dessous)* | 04/09 |
| ☐ | **T4** | [TRK-072](./REFERENCE-ERREURS.md#trk-072) | **Calibrer les notifications d'excès de vitesse** — 14/jour/super-admin, pour un produit calibré sur 2 à 3 | 06/09 |
| ☐ | **T5** | [TRK-062](./REFERENCE-ERREURS.md#trk-062) | **Autoriser la migration** `SENT_UNCONFIRMED` pour les commandes de boîtier | 03/09 |
| ☐ | **T6** | [TRK-065](./REFERENCE-ERREURS.md#trk-065) | **Prévenir `tyger.bcn@gmail.com`** — 21 notifications perdues faute d'appareil abonné | 04/09 |
| ☐ | **T7** | [TRK-035](./REFERENCE-ERREURS.md#trk-035) | **Ouvrir une fenêtre de maintenance** pour créer le rôle applicatif non-superutilisateur | 20/08 |
| ☐ | **T8** | [TRK-001](./REFERENCE-ERREURS.md#trk-001) · [TRK-027](./REFERENCE-ERREURS.md#trk-027) | 🔵 **Contrôler les antennes** de `FS-253-HR`, `FZ-862-VY`, `KSR•370` | 03/08 |
| ☐ | **T9** | *(hors fiche)* | 🔵 **Déclarer ou dépanner** `GLA•KC•31` (74 h) et `FG-669-DQ` (57 h), muets et **non déclarés** | 03/09 |

### Les trois questions du coupe-circuit (TRK-066) — à trancher, pas à deviner

Le 04/09 à 03:00, une commande moteur a échoué sur ses **DEUX** voies et **un véhicule est resté
mobile**. Le message est corrigé et déployé ; **la garde ne l'est pas, et ne doit pas l'être sans
vous** :

- **(a)** 10 s d'attente suffisent-elles sur un **dernier recours** ?
- **(b)** Faut-il un réessai, et comment le rendre **idempotent** ? *(rejouer une coupure moteur
  n'est pas anodin)*
- **(c)** Une immobilisation **demandée qui n'a pas eu lieu** mérite-t-elle `CRITICAL` plutôt
  qu'`ERROR` ?

---

# 🔧 À CODER — cause connue, correctif spécifié, personne ne l'a écrit

## ⚖️ Contre-expertise du chantier coupe-circuit — 13/09 au soir

> Lecture indépendante des deux branches du chantier (Tracky `codex/tracky-cutoff-reliability-2026-09-12`,
> Texto `codex/gateway-health-reliability-2026-09-13`) : [`docs/fiabilite-coupe-circuit-2026-09/19-CONTRE-EXPERTISE-INDEPENDANTE-2026-09-13.md`](../fiabilite-coupe-circuit-2026-09/19-CONTRE-EXPERTISE-INDEPENDANTE-2026-09-13.md).
> Verdict **NO-GO** en l'état, 53/100. Ce que la revue a établi, dans l'ordre de gravité :
>
> 1. **P0-1 (T40)** — la clé d'unicité `activeKey` d'une RESTORE partie par SMS et jamais acquittée n'était **jamais libérée** :
>    la RESTORE du lendemain (planning ou clic) était dédupliquée vers elle, rien n'était envoyé, le cron avançait son état.
>    Prouvé par test contre le service réel ; base : au moins une RESTORE SMS sans accusé presque chaque jour sur 30 jours.
>    **Corrigé et committé le 14/09** (`d5c19a17`, [doc 20](../fiabilite-coupe-circuit-2026-09/20-CORRECTIF-P0-CLE-RESTORE-2026-09-13.md)).
> 2. **P0-2 (T41)** — les SMS CUT partent sans validité (`ttl`) ni priorité ; une coupure retardée d'une heure s'exécute après le rallumage du matin.
> 3. **P1 (T42 → T47)** — pas de relance TCP à la reconnexion ; téléphone sans ping (`lastSeen` figé 552 s au repos) contre un seuil de 120 s ;
>    l'interlock exige une remise SMS de moins de 24 h alors que la seule preuve régulière est hebdomadaire **et que le relais ne pousse aucun statut** ;
>    branche en conflit avec `main` à cause d'un reformatage (nettoyé le 14/09, T46) ; procédure de déploiement sans `deploy.sh` ni prérequis téléphone.
> 4. **P2 (T48 → T53)** — course ACK/SMS, alertes en tempête, glissement confirmable d'un clic, RESTORE en `queued` alertée une seule fois, santé multi-appareils ambiguë, tentatives jamais testées.
>
> 🔑 **Ce que cette revue apprend, au-delà des tâches :** des suites vertes (3 920 tests) ne voyaient pas une régression qui se joue
> sur **deux matins consécutifs** — *un test d'un seul cycle ne peut pas trouver un défaut de cycle.* Et `/health` du serveur SMS
> ne teste que sa base : *une santé qui répond « pass » ne dit rien du téléphone qu'elle est censée surveiller.*

## P0 — nuit à la production maintenant

### `~` T10 · TRK-070 · gravité 2 · ✅ **COMMITÉ le 2026-09-06** (`2112e9ae`) — *pas encore déployé*

**Ce qui se passe** — Un compte IA à sec produit **deux** lignes à 14 ms d'intervalle : la première
en `DEGRADATION` (correctif C3 point 5 / TRK-061), la seconde en **`ERROR`** — qui la **recompte
comme un défaut**. `signalerReprise` décide son niveau sur la **gravité de la conversation**, jamais
sur la **cause** de l'escalade.

**Le geste** — Passer à `signalerReprise` un `kind` optionnel issu de `classerEchecIa` ; quand il est
renseigné, aligner le niveau sur celui de l'incident d'origine. Garder `ERROR` pour une escalade
décidée **sur le contenu** de la conversation. Traiter **tous** les chemins de `sansIaReponse` qui
suivent un `tracerErreur` — *leçon de TRK-004*.

**Pourquoi en premier** — Le geste est **borné à quelques lignes** et il referme le motif récurrent
de la semaine. Le journal système (`assistance_escalade`) doit continuer d'écrire dans les deux cas.

⚠️ **Double condition :** au prochain échec IA, **UNE** seule ligne `ASSISTANCE`, en `DEGRADATION`.
*Si les deux disparaissent, on a supprimé la trace de l'escalade au lieu de la classer.*

### `~` T11 · TRK-068 · gravité 2 · ✅ **COMMITÉ le 2026-09-06** (`c80632ba`) — *pas encore déployé*

**Ce qui se passe** — `auth-client.service.ts`, méthode `request()` : l'appel à Vizyo Auth est un
`fetch` **sans `try/catch` ni délai d'expiration**. Le rejet de transport remonte nu, NestJS en fait
un **500** là où une dépendance injoignable est un **503**, et le tout sort en `CRITICAL`.

**Le geste** — Envelopper le `fetch` : `AbortSignal.timeout()`, capture du rejet, puis
`ServiceUnavailableException` dont le message nomme **Vizyo Auth**, l'opération tentée et la
conséquence pour l'utilisateur, **motif technique conservé en fin de phrase**. Niveau `DEGRADATION`.
**Traiter le jumeau `verifyLoginCode()`**, qui appelle `fetch` en direct avec le même angle mort.

⚠️ **1 occurrence, 2 jours.** Fait mesuré, pas une tendance — mais le geste est connu et borné.

### ☐ T12 · TRK-022 · gravité 2 · 🔧 À CODER *(à clore)*

**Ce qui se passe** — Aucune déduplication **générique** des alarmes du boîtier. Le volet 1 est
**répondu** (1 317 → 1-2 par jour, plancher net à 6,16 h), mais la déduplication n'est posée **que
sur le chemin de la survitesse** — qui n'est qu'un cas parmi d'autres.

**Le geste** — Remonter la déduplication dans la fonction qui crée une alerte à partir d'une trame,
**par véhicule ET par type ET par fenêtre**. Le modèle existe déjà dix lignes plus loin (perte GPS,
24 h), avec un commentaire qui explique longuement pourquoi.

🔗 **Croisement neuf avec [TRK-072](./REFERENCE-ERREURS.md#trk-072)** : c'est ce chemin générique qui
décidera si la chaîne V5 sature à nouveau ses destinataires.

## P1 — le message ment, ou le compteur dérive

### ☐ T13 · TRK-016 · gravité 2 · 🔧 CHANTIER *(hors passe)*

**Le recalage cartographique échoue sur ~9 trajets sur 10, depuis avril.** Mesure fraîche sous les
lots V1→V9, prise le 06/09 : **87,9 %** (131 trajets sur 149).

Série ouvrée : 90,2 · 88,7 · 91,3 · 87,0 · 89,3 · 91,1 · 91,9 · 89,2 · 83,3 · **87,9**.

⚠️ **Le 83,3 % du 05/09 était une fluctuation, et la réserve écrite ce jour-là vient de
s'auto-vérifier.** Le chantier peut désormais s'ouvrir : le chiffre est frais et stable autour de
**~88 %**. Ce n'est pas une passe d'une heure — c'est un vrai sujet, à planifier.

### ☐ T14 · TRK-053 · gravité 1 · ⛔ déployé, **aucune occasion**

Correctif déployé le **01/09 à 09:17**. **Sans régression** : `alertes_depuis_declaration` = **7**,
identique aux 04, 05 et 06/09 — **3ᵉ point**. Ce qui manque est une **occasion** : les 10 véhicules
déclarés hors service sont muets, et *un correctif qui fait taire des boîtiers déjà silencieux ne
prouve rien*.

👉 **Décision proposée** : le **provoquer** au prochain retour de LLD, ou le **requalifier** le 08/09.

> 📏 **13/09 — le retour de LLD est venu, et il n'a prouvé que la moitié.** FR-629-AD, FW-298-WV et
> FZ-731-YF sont revenus le 11/09 (1 809 et 3 889 positions ; FW-298-WV vivant **sans fix depuis
> 41,8 h**) : **0 alerte, 0 ligne `gps-integrity`** — les chemins qui honoraient déjà la déclaration
> tiennent. Mais **aucune trame d'alarme** n'est arrivée de ces boîtiers, et c'est le seul chemin que
> TRK-053 touche. 🔴 **Et ces trois véhicules roulent avec toutes leurs alertes coupées** : lever la
> déclaration. **REQUALIFIER** : débrancher volontairement un boîtier déclaré, ou clore sur les tests
> — et le dire.

---

# 🗓️ DÉPLOYÉ, NON EXERCÉ — la consigne datée attend son occasion

*Ces quatre correctifs sont **en ligne**, marqueurs vérifiés sur l'**artefact servi** le 05/09.
Aucun n'a encore eu l'occasion de se prouver. **Ne pas les rouvrir ; les guetter.***

| | ID | Fiche | Ce qui le prouvera | Attendu |
|:--:|:--:|---|---|---|
| ☐ | **T15** | [TRK-060](./REFERENCE-ERREURS.md#trk-060) | Une ligne `system-metrics` commençant par « **Un point de mesure système n'a pas pu être enregistré** », et non par la pile de transport brute | au prochain incident DNS |
| ☐ | **T16** | [TRK-064](./REFERENCE-ERREURS.md#trk-064) | *Son sujet a changé* : la chaîne **est armée** sur 2 sociétés sur 5, et le silence de la sentinelle est **légitime** | — 👉 **à clore ?** |
| ☑ | **T17** | [TRK-065](./REFERENCE-ERREURS.md#trk-065) | ✅ **11/09 06:30** : ne cite plus `system@tracky.local`, porte `comptesTechniquesEcartes: 1` — **53 sur un compte**, pas ~21 : le numérateur a été ×2,5 (21+21 → 53+53), sans le correctif la ligne aurait dit 106 | ✅ **FAIT** |
| ☐ | **T18** | [TRK-066](./REFERENCE-ERREURS.md#trk-066) | La ligne `sms-gateway` commence par « **SMS non remis au relais** », nomme `vizyo-texto`, **et conserve le motif technique en fin de phrase** | au prochain échec du relais |

> ⚠️ **Pour TRK-066, la vérification porte sur ce qui RESTE, pas sur ce qui disparaît.** *Si le motif
> technique s'évapore, on a nettoyé l'écran au lieu de traduire le message.*

---

# 👁️ À SURVEILLER — rien à coder, une mesure à relever à chaque passage

*C'est ce qui rend l'audit cumulatif plutôt que quotidien. **Ne pas sauter ces relevés, même quand
rien ne bouge** — c'est l'absence de mouvement qui fait la preuve.*

| Mesure | Dernière valeur | Série | Ce qu'un changement signifierait |
|---|---|---|---|
| [TRK-035](./REFERENCE-ERREURS.md#trk-035) — écart `ins − del − live` | **13 250** | **10 points** identiques | Une hausse = un `TRUNCATE` (invisible dans `n_tup_del`) |
| `temoin_arme` | **4/4 `actif = O`** | stable depuis le 21/08 | 🔴 **Moins de 4 = tous les comptes du rapport deviennent des planchers, pas des mesures** |
| [TRK-014](./REFERENCE-ERREURS.md#trk-014) — acquittements matériels | **0 sur 437** | **9 points** | Le premier acquittement réel fermerait la fiche |
| Total famille `fix_continuous` | **437** | 514 · 505 · 491 · 475 · 455 · 437 | ⚠️ **Une baisse n'est PAS une amélioration** : compter les ÉMETTEURS d'abord |
| `cadence_resume` sous le minimum | **0 sur 44** | **6 points** | TRK-057 et TRK-008 tiennent |
| [TRK-037](./REFERENCE-ERREURS.md#trk-037) — Overpass | **48 `DEGRADATION` / 0 `ERROR`** | **5 points** | Une `ERROR` = le classement a régressé |
| [TRK-072](./REFERENCE-ERREURS.md#trk-072) — `OVERSPEED`/jour | **6** *(6/6 nées d'un trajet)* | 12 · 6 — **2 points seulement** | 🔴 Un retour à trois chiffres = le déluge de TRK-022 |
| [TRK-062](./REFERENCE-ERREURS.md#trk-062) — âge des 2 commandes SMS | **110,5 h / 113,9 h** | +24 h par jour, exactement | Elles ne se fermeront **jamais** seules |
| `gps_sans_fix` | **0 ligne** | 2 jours | ⚠️ **Ce zéro n'est pas une bonne nouvelle** : les 2 boîtiers muets sont sortis du filtre **par le bas** |

---

# 🗓️ LES TESTS DATÉS EN RETARD — provoquer ou requalifier

> 🔑 **Règle du dispositif : un test en attente depuis plus de 7 jours doit être PROVOQUÉ ou
> REQUALIFIÉ.** Un correctif jamais exercé rend le **même zéro** qu'un correctif qui marche.

| | ID | Fiche | Ce qu'il faut provoquer | En attente | Décision proposée |
|:--:|:--:|---|---|---|---|
| ☐ | **T19** | [TRK-032](./REFERENCE-ERREURS.md#trk-032) | une trame `ac alarm` pendant une coupure programmée | 🔴 **16 j** | **REQUALIFIER** — 7 coupures cette semaine, toutes hors plage. Soit on la fabrique en atelier, soit on ferme la fiche en « non reproductible en exploitation ». |
| ☐ | **T20** | [TRK-051](./REFERENCE-ERREURS.md#trk-051) | mode fix : badge ambre « cible atteinte (mesurée) » | 🔴 **12 j** | **CONFIER À UN HUMAIN** — geste d'interface, impossible à provoquer en lecture seule. **30 s pour qui a l'écran.** |
| ☐ | **T14** | [TRK-053](./REFERENCE-ERREURS.md#trk-053) | une alarme sur un véhicule déclaré hors service | 6 j | Encore dans la fenêtre. **À trancher le 08/09** si aucune occasion. |

---

# ⛔ BLOQUÉ PAR UN PRÉREQUIS

| | ID | Fiche | Ce qui bloque | Le prérequis |
|:--:|:--:|---|---|---|
| ☐ | **T5** | [TRK-062](./REFERENCE-ERREURS.md#trk-062) | `SENT_UNCONFIRMED` n'existe **pas** pour les commandes de boîtier — vérifié **absent de l'artefact servi 3 fois** | Une **migration d'énumération**, donc un accord humain. Spec prête. |
| ☐ | **T8** | [TRK-027](./REFERENCE-ERREURS.md#trk-027) | Le garde-fou juste est **physique** (contact coupé), pas temporel | **L'état du contact n'est PAS persisté sur une trame sans fix.** Il faut d'abord le persister. |
| ☐ | **T7** | [TRK-035](./REFERENCE-ERREURS.md#trk-035) *(voie 1)* | Le rôle applicatif est **superutilisateur ET propriétaire** — un `REVOKE` est sans effet sur lui | Fenêtre de maintenance + répétition : *un droit oublié casse l'ingestion GPS*. |
| ☐ | **T21** | [TRK-018](./REFERENCE-ERREURS.md#trk-018) | Les 4 correctifs sont livrés et **prouvés** (313 → **0** commandes `SENT`, 307 → **0** de plus de 24 h) | Reste : **la passerelle SMS n'expose aucun accusé de remise**. Même sujet que TRK-026 et TRK-062. |

---

# PARTIE II — VPS de production : 25 constats confirmés et non corrigés

> **Source** : les **124 fiches** de `docs/vps-audit/REFERENCE-CONSTATS.md`, dont **25 ouvertes** au
> 2026-09-06. **87 sont `APPLIQUE`** (corrigées et vérifiées) et **12 `ACCEPTE`** — dont 6 réfutées
> par la mesure et 6 assumées par écrit. *Aucune tâche ne se cache dans ces 99 : elles ont été
> relues une par une pour construire cette liste.*
>
> ✅ **Le référentiel VPS est sur `main` depuis le 2026-09-06** — 29 rapports, 631 Ko, 125 fiches.
> Il s'y arrêtait au **17/08** (289 Ko) et ne contenait **aucune** des fiches **VPS-030 à VPS-039**,
> *les deux gravités 1 comprises* : elles ne vivaient que sur `perf/garde-fou-tests-et-workers`.
> *C'était le mode d'échec des « six rapports jamais commités » du 11/08 sous une forme neuve —
> cette fois ils étaient commités, mais sur une branche que personne ne fusionnait.*
> Les fiches sont donc désormais consultables : [`REFERENCE-CONSTATS.md`](../vps-audit/REFERENCE-CONSTATS.md).

## Récapitulatif des huit derniers passages VPS

| Date | Disque | RAM | Collecte | Émetteurs | Le fait du jour, en une ligne |
|---|---:|---:|---:|---:|---|
| **25/08** | 53 % | 33 % | 142 s | — | Passe de correction : TRK-046/048/047 déployés |
| **26/08** | 54 % | 33 % | 137 s | 38 | Dernier passage avant **cinq jours manqués** *(VPS-M73)* |
| **01/09** | 53 % | 35 % | 138 s | 38 | *« La flotte est intacte, 15ᵉ jour sans perte »* — **écrit 18 h APRÈS l'arrêt des six** |
| **02/09** | 54 % | 35 % | 120 s | **32** | **Six boîtiers se sont tus le 31/08 en deux heures**, tous dans la même flotte *(🆕 VPS-038)* |
| **03/09** | 53 % | 38 % | 126 s | 32 | Seuil de réescalade écrit d'avance, échéance au 05/09 |
| **04/09** | 53 % | 33 % | 96 s | 31 | `vizyo-auth` reçoit une vraie unité de sauvegarde — **le créneau exact que le plan recommandait** |
| **05/09** | 53 % | 32 % | 133 s | 30 | **VPS-038 passe en gravité 1** ; trois bases vertes sur un **dump manuel** *(🆕 VPS-M80/M81)* |
| **06/09** | 53 % | 35 % | 116 s | **30** | **Premier passage sans perte nouvelle** ; deux blocs de la même section se contredisaient *(🆕 VPS-M84/M85)* |
| **07/09** | 53 % | 35 % | 94 s | 30 | V11 requalifiée `[x]` → `[»]` : les trois minuteries n'avaient jamais déclenché seules *(VPS-M87)* |
| **08/09** | 55 % | 40 % | 124 s | 30 | V11 **prouvée** (3 déclenchements autonomes) ; un parc de démo apparu sans annonce *(🆕 VPS-040)* |
| **09/09** | 56 % | 42 % | 147 s | 30 | Deux tests datés indécidables — la rétention efface le point de référence *(🆕 VPS-M94)* ; `apt` enfin mesurable |
| *10–12/09* | — | — | — | — | **Trois passages manqués** — quota hebdomadaire de l'agent, pas le poste éteint *(VPS-M73)* |
| **13/09** | 54 % | 45 % | **186 s** | **32** | **`dockerd` brûle un cœur depuis 04 h 34 (VPS-016, 5ᵉ), client nommé à la seconde ; deux rotateurs percent les journaux** *(🆕 VPS-041)* ; coffre + 2 comptes apparus le 09/09 *(🆕 VPS-042)* ; VPS-038 **gravité 1 → 2** |
| **14/09** | 57 % | 39 % | 189 s | 32 | 22ᵉ heure de VPS-016, **1ʳᵉ journée entière < 50 %** ; le VPS est le **dépôt** hors-site de Conductor, pas un tirage *(🆕 VPS-M99)* ; la loi de `apt` lue dans le code
| **15/09** | 58 % | 42 % | 182 s | **33** | **46ᵉ heure, 2ᵉ journée < 50 %, `deploy.sh` à 1 916 s** ; **la copie hors-site de Verify a échoué sur un manifeste orphelin et le collecteur disait « à jour »** *(🆕 VPS-043, VPS-M100)* ; 3ᵉ compte de dépôt `dispocarbk` ; la démo n'a jamais analysé *(🆕 VPS-M101)*

**Ce que la série raconte** — **la machine va bien et n'a jamais mal été** : 33/33 conteneurs sur
les huit passages, **0 OOM en 30 jours**, PSI `full` à 0,00, disque **stable à 53 %** avec 46 Go
libres, production en 99 · 102 · 47 · 118 ms. *Le VPS n'est pas le sujet ; ce qui vit dessus l'est.*

> 🔑 **Le motif structurant, vu quatre fois en six jours :** un contrôle rend **vert** sur une
> grandeur qui ne répond pas à la question posée. **VPS-M81** (l'âge d'un fichier ne distingue pas
> un mécanisme d'un geste), **VPS-M80** (un dénominateur calculé par le filtre défaillant),
> **VPS-M84** (deux seuils contradictoires dans la même section), **VPS-M85** (une réfutation menée
> avec la mauvaise grandeur). *Trois de ces quatre verts portaient sur le seul constat de gravité 1
> encore ouvert.*

## Les classes d'exécution VPS — qui a le droit de faire quoi

*Reprises telles quelles de `docs/vps-audit/ROADMAP.md` — **retiré le 06/09** — pour ne pas créer un
troisième vocabulaire. Ce sont désormais les seules classes d'exécution VPS.*

| Classe | Sens | Qui exécute |
|:--:|---|---|
| 🟢 **AUTO** | Additif, réversible, vérifiable immédiatement, **aucun impact production**. | Un agent, seul, **et il prouve le résultat**. |
| 🟡 **PRÉPARÉ** | La commande est écrite et mesurée, **l'application demande un arbitrage**. | Humain, après lecture. |
| 🔴 **HUMAIN** | **Destructif ou interrompt la production.** Jamais exécuté par un agent. | Humain, exclusivement. |
| 🔵 **PRODUIT** | Ce n'est pas une action sur le VPS. | Exploitant / équipe produit. |

> ⚠️ **Un agent qui a le droit de `prune` a le droit de se tromper de `prune`.** VPS-002 a établi
> qu'on perd une machine en coupant un accès avant d'avoir prouvé le suivant ; VPS-009, qu'une
> commande de nettoyage ne distingue pas un cache d'une base de données.

---

## ✅ V0 — FAIT le 2026-09-06 : les docs VPS sont sur `main`

**Vingt jours d'audit — 15 rapports, 10 fiches neuves, les deux gravités 1 — n'existaient pas sur
`main`.** Le montage `/opt/tracky-vps-audit` masquait le problème en production tant qu'il tenait :
l'écran `/admin → Audit VPS` lit le dossier monté, pas le dépôt. *Le jour où le montage aurait
sauté, l'écran aurait affiché une documentation du 17/08 sans rien signaler.*

**Ce qui a été fait** — le seul chemin `docs/vps-audit/` a été versé sur `main`
(`git checkout perf/garde-fou-tests-et-workers -- docs/vps-audit/`), **avec son historique**, et
non recopié à la main. Arborescences vérifiées identiques, rien d'autre n'a été importé.
**La branche `perf/garde-fou-tests-et-workers` est conservée** : elle porte encore 49 commits
uniques, dont du **code** (`scripts/guard-dev-servers.mjs`, le correctif VPS-M59 de
`admin-vps.component.ts`, `package.json`). *Une fusion complète est une décision ; un `checkout` de
chemin n'en est pas une.*

⚠️ **Ce qu'il RESTE à décider sur cette branche** — sa fusion entre en **conflit sur 4 fichiers** :
`admin-vps.component.ts`, `REFERENCE-ERREURS.md`, **`ROADMAP-CORRECTIFS.md`** (add/add) et
`app/wiki.json`. Les trois derniers sont les documents les plus édités du dépôt, et sa version
date du **21/08**. *Fusionner cette branche telle quelle écraserait la roadmap que vous lisez.*

---

## 🤝 CE QUI ATTEND UNE DÉCISION OU UN GESTE HUMAIN — *10 tâches*

*Rien de tout ceci ne se corrige par une commande. C'est la liste la plus bloquante.*

| | ID | Fiche | G | L'action, en une phrase | Classe | Depuis |
|:--:|:--:|---|:-:|---|:--:|---|
| ☐ | **V1** | VPS-038 | **2** *(1 → 2 le 13/09)* | 🔵 **Porter les 3 IMEI encore muets de la flotte `2ad69ac1…` à l'exploitant** *(3 sur 6 revenus le 11/09 après 11 j ; `…6714` s'annonce sans mesurer, à porter à part)* — muets depuis **5,6 jours**, avec l'heure de leur dernière trame | 🔵 PRODUIT | 31/08 |
| ☐ | **V2** | VPS-038 | **2** *(1 → 2 le 13/09)* | 🔵 **Sortir du parc les 6 boîtiers muets depuis > 7 j**, dont **3 sans aucun véhicule** (7,3 · 66,8 · 92,7 j) — un statut, **pas** un `DELETE` | 🔵 PRODUIT | 04/09 |
| ☐ | **V3** | VPS-036 · VPS-027 | 2 | 🔵 **Un seul ticket hébergeur** couvrant les deux ordres d'écriture root (`kill -KILL` du 28/08, `systemctl mask` du 01/09) : paternité, cadence, **puis la liste de ce que ce canal s'autorise sans préavis** | 🔵 PRODUIT | 28/08 |
| ☐ | **V4** | VPS-010 | 2 | **Planifier un redémarrage** vers 23 h 30 — noyau actif `6.8.0-136`, **trois** installés (`-137`, `-138`, `-139`), 6 services sur une bibliothèque remplacée dont `docker.service` | 🔴 HUMAIN | 04/08 |
| ☐ | **V5** | VPS-M56 | 2 | **Arbitrer le budget de collecte** — dépassé **20 fois**, 116 s pour 90. Trois réponses chiffrées, aucune n'est technique *(détail ci-dessous)* | 🟡 PRÉPARÉ | 04/08 |
| ☐ | **V6** | VPS-037 | 3 | **Donner un second dépositaire à la copie hors-site** — dépositaire unique, **le même poste que la planification de l'audit** | 🟡 PRÉPARÉ | 01/09 |
| ☐ | **V7** | VPS-005 | 2 | **Poser les limites mémoire** sur les 30 conteneurs sur 33 qui n'en ont pas (**0 sur 33** ont une limite CPU) | 🔴 HUMAIN | 04/08 |
| ☐ | **V8** | VPS-020 | 2 | **Séparer les projets compose** `deploy` — 7 conteneurs, **2 applications sans rapport** (4 Maestroo dev + 3 Vizyo Manager **prod**), confirmé ce jour | 🔴 HUMAIN | 08/08 |
| ☐ | **V9** | VPS-017 | 3 | **Trancher pourquoi 4,5 Go d'outillage de développement** vivent dans `/root` d'un serveur qui porte **sept bases de production** | 🔴 HUMAIN | 06/08 |
| ☐ | **V10** | VPS-018 | 4 | **Retirer `/opt/vizyo-leads`** — pile supprimée le 04/08, dépôt distant vérifié, **10,3 % du parcours nocturne** de l'audit | 🔴 HUMAIN | 12/08 |

### Les trois réponses au budget de collecte (V5 / VPS-M56) — à arbitrer, pas à deviner

Vingt dépassements sur vingt et un passages. **Recommandation de l'agent, non appliquée :
recalibrer à 120 s ET borner `/opt` à 25 s.**

- **(a) Alléger** — le seul gisement est `/opt` (36 s). Mais le réduire, c'est **perdre la mesure
  par sous-dossier** qui justifie VPS-018 et qui a chiffré à 10,3 % ce qu'on croyait valoir 25 %.
- **(b) Recalibrer** — assumer que 90 s décrivait la machine du 04/08, qui portait moins de code.
  ⚠️ *Un budget relevé dès qu'il gêne ne borne plus rien.*
- **(c) Ne rien faire** — le dépassement reste un symptôme lisible.

⚠️ **À ne pas faire** : relever le budget **en silence**. Un budget modifié sans que le rapport le
dise transforme un dépassement en conformité sans que rien n'ait changé.

---

## 🔧 À APPLIQUER — geste serveur borné, commande écrite, personne ne l'a lancée — *9 tâches*

### ☑ V11 · VPS-013 · gravité 1 · ✅ **FAIT ET PROUVÉ le 2026-09-06** — *trois unités systemd, exercées et confrontées à la base vivante*

**Ce qui se passe** — **29ᵉ passage.** Trois bases de **production** n'ont aucune sauvegarde
qu'un mécanisme reproduise : `vizyo-manager` (abonnements Stripe, factures, clients),
`texto-postgres` (passerelle SMS : `messages`, `allowlist_entries`) et `capcom6-mysql` (relais SMS).

Le dump du 04/09 à **04:52:04** — *la même seconde pour les trois* — les a fait passer au vert.
**Rien ne le rejouera** : aucun timer, aucun cron, aucun script. `vizyo-manager` : salve
précédente à **142 jours** ; `texto` et `capcom6` : **une seule copie chacun**.

> ✅ **ET SON AUTEUR EST CONNU — c'est l'agent d'audit lui-même, et il l'avait écrit.** Le journal
> d'exécution du 04/09 (tâche T1, dans le `ROADMAP.md` retiré ce jour) porte les trois archives,
> leur taille, leur vérification d'intégrité **et** leur confrontation à la base vivante
> (`allowlist_entries` : 47 en base = 47 dans le dump). Il y écrivait déjà, mot pour mot :
> *« c'est une copie ponctuelle. Aucun timer n'a été posé, donc ces trois bases seront de nouveau
> périmées demain. La fiche reste `A_TRAITER`. »*
>
> 🔑 **Les audits des 05 et 06/09 ont consacré un chapitre entier à chercher qui avait fait ce
> dump — la réponse était dans un fichier de leur propre dossier, avec la mise en garde qui allait
> avec.** *VPS-M81 n'a rien découvert de faux ; il a redécouvert, à grands frais, ce qui était déjà
> écrit.* C'est la raison pour laquelle le contenu de ce journal est versé ici plutôt que supprimé.

**Le geste** — dériver une unité systemd par base, **sur un gabarit qui existe déjà sur la machine
et qui a fait ses preuves** : `vizyo-auth-backup.timer`, posé le 04/09, **s'est déclenché seul deux
fois** (05/09 04:01:41, 06/09 04:04:10, `systemd[1]: Starting` au journal), rétention 30 j active.

```bash
systemctl cat vizyo-auth-backup.timer vizyo-auth-backup.service   # le gabarit a copier
```

**Coût mesuré** : **~17,8 Mo/jour** avant compression, sur **46 Go libres**.

⚠️ **Créneaux PRIS** : 03 h 00 (`tracky-backup`), 03 h 30 (`vizyo-verify-backup`), 04 h 00
(`vizyo-auth-backup`). **04 h 30 est libre.**
⚠️ **Ne PAS remettre un cron** : VPS-003 — deux planificateurs pour la même sauvegarde, deux
`pg_dump` concurrents à 3 h du matin — est né exactement de là.
⚠️ **Sauvegarder `vizyo-manager` AVANT** de toucher au projet compose (V8) : sa base est dans le
projet `deploy`, et `docker compose down --remove-orphans` la supprimerait.

### ☐ V12 · VPS-012 · gravité 2 · 🟡 PRÉPARÉ — *10 secondes*

**Ce qui se passe** — `github-actions-vizyo-auth` a un accès **root complet sans aucune option de
restriction**, et elle sert : **0 → 12 → 16 → 16** connexions sur quatre passages. Elle déploie
l'authentification de **toutes** les applications de la machine.

**Le geste** — poser les mêmes options que sur l'autre clé de CI (`no-port-forwarding`,
`no-agent-forwarding`, `no-X11-forwarding`, `no-user-rc`). **Geste déjà prouvé sans effet de bord
le 04/08.**

```bash
grep -n 'github-actions-vizyo-auth' /root/.ssh/authorized_keys   # relever la ligne AVANT
```

⚠️ **Ne PAS retirer la clé** : `connexions=0` sur une fenêtre de 7 jours ne veut pas dire
« inutilisée », mais « elle n'a pas servi ces sept jours-là ».
⚠️ **Ne PAS poser `command="…"`** : mesuré et écarté le 04/08 — casse les workflows multi-lignes.
⚠️ **Et ne PAS lire la baisse de `vizyo-vps-hostinger` (10 442 → 9 127) comme une accalmie** : c'est
une **fenêtre glissante de 7 jours** qui a laissé sortir une journée de déploiements.

### ☐ V13 · VPS-015 · gravité 2 · 🟢 AUTO — *le symptôme est fermé par accident, la cause est intacte*

**Ce qui se passe** — le déclenchement de la sauvegarde Verify dépend du **bit d'exécution** du
script. Le prochain `scp -r` sans `-p` le retirera, comme le 05/08.

**Le geste** — `ExecStart=/bin/bash /opt/vizyo-verify/deploy/vps/backup.sh`, pour que le bit cesse
d'être une condition de survie de la sauvegarde.

> 🔴 **LE PÉRIMÈTRE A DOUBLÉ LE 04/09, ET LE COLLECTEUR NE LE VOIT TOUJOURS PAS.** La même question,
> posée pour la première fois à `tracky-backup`, rend le même résultat :
>
> ```
> ExecStart=/opt/vizyo-tracky/deploy/vps/backup-db.sh     ← le script EN DIRECT
> OnFailure=                                              ← ABSENT
> ```
>
> **C'est la sauvegarde de `tracky_prod` — 5,7 Go, 41 copies, la base de production principale — et
> son échec n'alerte personne.** Le constat ne visait Vizyo Verify que parce que **personne n'avait
> posé la question à l'autre unité**. **Délai de détection d'un échec : ~23 h par construction, pour
> les DEUX sauvegardes.**
>
> *Piste concrète et gratuite* : le bloc « L'unité qui PRODUIT chaque sauvegarde a-t-elle réussi ? »
> lit déjà chaque unité. Lui faire afficher `OnFailure=` présent/absent coûte **un
> `systemctl show -p OnFailure` par unité** — quatre appels, aucune E/S disque.

### ☐ V14 · VPS-033 · gravité 2 · 🟡 PRÉPARÉ — *5 min*

**Ce qui se passe** — la mesure des correctifs de sécurité est perdue **4 passages sur 5** parce que
sa source est rafraîchie **à une heure tirée au hasard** dans une fenêtre de 12 h. Le 06/09 est la
**première mesure valide depuis onze passages**, et par chance.

```bash
systemctl edit apt-daily.timer   # [Timer] / RandomizedDelaySec=30m
```

⚠️ **Contrepartie réelle** : le délai aléatoire étale la charge sur les miroirs Ubuntu. Le réduire
sur **une** machine est sans effet mesurable ; le généraliser ne le serait pas. **Préférer `30m` à `0`.**

### ☐ V15 · VPS-034 · gravité 2 · 🔴 HUMAIN — *moitié gratuite*

**Ce qui se passe** — `foodsqan-traefik` tient `0.0.0.0:80` et `:443`, sert **25 domaines**, monte
`/run/docker.sock` (« lecture seule » — **ce qui ne restreint rien** : qui atteint la socket pilote
le démon), tourne sur l'étiquette flottante `traefik:latest` et **n'a aucune sonde de santé**.

**✅ Le digest est DÉJÀ relevé — relevé le 04/09, ne pas le re-préparer :**

```
traefik@sha256:82d3d16dde0474a51fef00b28de143d48b67f7a27453224d5e7b5aaefff26a97
```

```bash
docker inspect foodsqan-traefik --format '{{.Image}}'   # verifier qu il n a PAS change
```

⚠️ **L'ORDRE COMPTE** : relever le digest **avant** toute recréation, sinon on épingle la version
qui vient d'arriver au lieu de celle qu'on a validée.
🔑 **Et si ce digest a changé depuis le 04/09 sans qu'on ait rien fait, ce n'est pas un détail :
c'est que l'étiquette flottante a bougé sous la production — la première preuve directe que le
risque décrit par VPS-034 se réalise.**
⚠️ **Ne PAS retirer le montage** : Traefik perdrait la découverte de routes et **les 25 domaines
tomberaient**.
⚠️ **Ne PAS traiter ceci comme une urgence** : aucune intrusion constatée, 23 échecs SSH sur 7 j,
**0 sur `root`**, 0 IP bannie.

### ☐ V16 · VPS-026 · gravité 3 · 🟡 PRÉPARÉ

**Ce qui se passe** — la sauvegarde des **pièces d'identité** de Vizyo Verify télécharge
`alpine:latest` depuis Docker Hub pour s'exécuter, parce que le ménage de 00 h 40 vient de la
supprimer. **18ᵉ prédiction juste** : l'image a été tirée le 05/09 à 03:32, elle avait plus de 24 h
cette nuit, elle sera retéléchargée.

**Le geste** — épingler `alpine` **par empreinte** et la pré-tirer **hors** de la fenêtre de
sauvegarde ; ou vérifier si le `tar` + `gpg` a réellement besoin d'un conteneur.

**✅ L'empreinte ET les lignes à modifier sont DÉJÀ relevées — 04/09 :**

```
alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
→ lignes 163 et 165 de /opt/vizyo-verify/deploy/vps/backup.sh
```

### ☐ V17 · VPS-030 · gravité 3 · 🟡 PRÉPARÉ

**1,70 Go en 13 fichiers**, sous **aucune** rétention (1 679 Mo dans `/root/backups`, 57 Mo dans
`/opt/backups/tracky`). Ce sont des copies **supplémentaires** d'une base qui en a 40 ailleurs.

```bash
ls -1t /root/backups/tracky-avant-graphiques-*.sql.gz | tail -n +2   # liste, n efface rien
```

**✅ Le périmètre exact est DÉJÀ relevé — 04/09 : 10 fichiers, 1,4 Go**, en conservant
`tracky-avant-graphiques-20260819-030105.sql.gz`. *Ne pas re-préparer.*

⚠️ **Ne PAS `rm -rf /root/backups`** : le dossier porte aussi les **seules copies connues** d'un
état de la base Maestroo de développement — et elles pèsent 0,46 Mo.
⚠️ **Ne PAS toucher** à `/opt/backups/tracky/positions-avant-purge60j-*` : 57 Mo, **seule trace**
des lignes purgées le 21/07.

### ☐ V18 · VPS-032 · gravité 3 · 🟢 AUTO — *côté POSTE, pas côté serveur*

**9 143 sessions SSH** sur 7 jours, pic **4 528** en une journée. Multiplexer **côté poste** :

```
Host 72.62.26.240
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

**Risque nul pour le VPS** : aucun paquet, aucune configuration serveur, le seul effet côté serveur
est **moins de travail**. ⚠️ **Contrepartie** : un socket de contrôle vit 10 min sur le poste ; qui a
accès au compte local pendant ce temps réutilise la connexion **sans la clé**.
⚠️ **Ne RIEN borner côté serveur** (`MaxStartups`, `ClientAliveInterval`) : ça transformerait une
inefficacité en **panne intermittente** le jour où on en aura légitimement besoin.

### ☐ V19 · VPS-007 · gravité 4 · 🟡 PRÉPARÉ — *déconseillé en l'état*

`random_page_cost = 4` sur **6 bases sur 7** (seule `tracky-postgres` est à 1.1). ⚠️ **L'enjeu de
performance est nul** — ces bases pèsent 8 à 28 Mo et tiennent en cache à 99,99 % : *le planificateur
ne peut pas se tromper de façon mesurable sur une table qui n'a aucune page à aller chercher.*
**L'enjeu est de méthode**, et il est déjà réglé (le dénominateur est honnête depuis VPS-M80).

---

## 🗓️ À DÉPLOYER — écrit, testé, jamais mis en ligne

*Les deux entrées de cette section ont été **déployées le 2026-09-06 à 05 h 30 UTC**. Conservées avec
leur preuve : c'est ce qui distingue « livré » de « livré ET vérifié ».*

| Quoi | État | Preuve |
|---|---|---|
| ✅ **Sentinelle « boîtiers muets » (VPS-038)** — une ligne par société quand des boîtiers rattachés se taisent > 3 j | **DÉPLOYÉE** (`fb0642f8`). 48 tests verts, mutation du seuil → 1 échec exactement. **Smoke-boot** avant bascule : *« Nest application successfully started »*. | `tracky-api` : `restarts=0`, `healthy`, `/api/health` base connectée, **port 5023 ouvert**. Sentinelle présente dans le conteneur qui tourne. ⏳ **Elle parlera à la passe de 06:30 UTC** — attendu : **2 lignes** (`2ad69ac1…` 8 boîtiers, `88627f81…` 2), **pas 10** |
| ✅ **VPS-M59** — `chargeDeFond.note` s'affiche, **et un repli explicite** sur `/admin/vps` | **DÉPLOYÉ** (`9dce59ec`). `ng build` **NG_EXIT=0**. ⚠️ Le cherry-pick de `e803e5f6` conflictait : **`main` portait déjà la garde** — seuls le rendu de la note, la branche `@else` et le style manquaient, écrits avec les **jetons** de `main` et non les hexadécimaux de la branche | Sur l'**artefact servi** : `fond-note` **0 → 1 fichier**, *« mesure absente du manifeste »* **0 → 1**, témoin impossible **0**. `restarts=0` |

> 🔑 **La mesure qui a validé ces deux lignes avait d'abord été fausse.** Un premier contrôle du
> bundle rendait *« 397 fichiers contiennent la note »* — `grep -rlc` combine deux options
> contradictoires, et 397 était le **nombre total de fichiers du bundle**. *Un contrôle de
> déploiement doit porter un témoin impossible ; sans lui, on ne distingue pas « ça a marché » de
> « mon grep compte autre chose ».*

> 🔴 **VPS-M59 corrige un défaut plus grave que celui qu'il visait, et il faut le dire.** En ouvrant
> le gabarit, le passage du 04/09 a trouvé que **la garde que tout le monde croyait posée n'existait
> pas** : `@if (idx.previsions; as p)` était la seule, et `p.chargeDeFond.…` était lu **sans
> garde**. Un passage d'audit qui n'écrirait pas cette clé ferait retomber **toute la carte
> « Prévisions », tableau du disque compris** — c'est-à-dire **TRK-033 à l'identique**. Le service
> API sert le JSON **brut, sans validation** : *le type TypeScript est une promesse que le
> compilateur n'a aucun moyen de tenir.*
>
> ⚠️ **Et ce correctif a été reporté 11 fois comme « hors de portée de l'agent — code applicatif ».
> Il ne l'était pas.** Le rapport d'audit du 06/09 le listait encore comme angle mort ouvert, **deux
> jours après qu'il eut été écrit et compilé** — parce que personne n'avait lu le journal du 04/09.

---

## 👁️ À SURVEILLER — rien à appliquer, une mesure à relever à chaque passage

| Mesure | Dernière valeur | Série | Ce qu'un changement signifierait |
|---|---|---|---|
| **VPS-038** — émetteurs distincts / jour calendaire | **32** *(ven 09-11 : **33**)* | 39 · 39 · 38 · 38 · 32 · 32 · 32 · 30 ×7 · **33 · 32** | 🔴 Redescend en gravité 2 à **32 sur une journée complète**, en `SURVEILLANCE` à **38**. ⚠️ *Un compteur qui arrête de descendre n'est pas un compteur qui remonte* |
| **VPS-038** — registre, par **bande** | 6-24 h : 0 · 1-3 j : 1 · 3-7 j : 7 · > 7 j : 6 | total stable à **14** | ⚠️ **Ne JAMAIS comparer les totaux** (VPS-M78) : le 06/09, le total est identique et **un boîtier a changé de bande** |
| **VPS-011** — invocations de sondes | **65/min** (~93 600/j) | 24 conteneurs sondés **sur 33** | 9 sans aucune sonde, dont `foodsqan-traefik` qui tient 80/443 |
| **VPS-035** — trames/h/boîtier | **102,5** | bande 60–300 | ⚠️ **Un seuil par tête ne voit pas une flotte qui rétrécit** — croiser avec VPS-038 |
| **VPS-005** — conteneurs sans limite mémoire | **30 / 33** | **0 OOM en 30 j**, PSI `full` 0,00 | Pas d'urgence ; le jour où il y aura une OOM, **le choix de la victime ne nous appartiendra pas** |
| Disque | **53 %**, 46 Go libres | stable sur 8 passages | Cache de build 10,1 Go, borné par le ramasse-miettes de BuildKit |

---

## ⛔ VPS — BLOQUÉ PAR UN PRÉREQUIS

| | ID | Fiche | Ce qui bloque | Le prérequis |
|:--:|:--:|---|---|---|
| ☐ | **V20** | **VPS-M79** | Le ménage de 00 h 40 est mesuré **en volume** (6 images retirées en 24 h) mais reste **muet sur l'identité** — le cron fait `> /dev/null 2>&1` | Étiqueter les images de repli **au build** (`label!=repli=1`), donc toucher aux Dockerfile |
| ☐ | **V21** | **VPS-029** | Volet symptôme appliqué (filtre `unused-for=168h` remis le 20/08, **toujours en place** ce jour) ; **deux** mécanismes gouvernent toujours le cache de build | Décider lequel fait foi — `daemon.json` (permanent, autorégulé) ou le cron hebdomadaire |
| ☐ | **V22** | **VPS-M36** | Le `wchan` sert de preuve sur le constat le plus lourd, et le collecteur n'en prend **qu'un échantillon** | Échantillonner 3× à 1 s d'intervalle et publier la **répartition** — coût à chiffrer sur une collecte déjà hors budget |
| ☐ | **V23** | **VPS-M73** | Aucun écran ne dit **depuis combien de jours** le dernier passage remonte — cinq passages manqués (27→31/08) n'ont été vus qu'après coup | Code applicatif : afficher l'écart en jours sur `/admin → Audit VPS`. *La donnée est déjà là.* |

---

## 🧹 Dette de documentation relevée le 06/09

*Deux incohérences trouvées en construisant cette roadmap. Elles ne coûtent rien aujourd'hui, et
feront perdre une heure le jour où quelqu'un les suivra.*

1. **L'action de [TRK-014](./REFERENCE-ERREURS.md#trk-014) renvoie vers un correctif déjà livré.**
   Elle dit *« le correctif de TRK-012 reste en attente d'accord ; c'est lui qu'il faut livrer »* —
   or **TRK-012 est `CORRIGÉ` depuis le 25/08**. Le résidu de TRK-014 est désormais **une mesure**
   (0 acquittement sur 437), pas une tâche à livrer.
   👉 **Rectifier le `quoiFaire` de TRK-014.** ✅ **RECTIFIÉ le 13/09** (T22) : le `quoiFaire` dit désormais
   que TRK-012 est corrigé et déployé depuis le 23/08, qu'il ne reste rien à livrer, et que la fiche
   mesure un fait matériel à qualifier par un test sur boîtier.
2. **`TACHES-AMELIORATION.md` est référencé mais n'existe pas.** L'en-tête de la roadmap précédente y
   renvoyait pour la dette d'architecture (clés `AM-NNN`) ; le fichier est **absent du dépôt**.
   👉 **Le créer, ou retirer la référence** — *un renvoi vers un fichier fantôme est pire que pas de
   renvoi.* ✅ **RÉGLÉ le 13/09** (T23) : le fichier n'était pas absent, il était **à la racine du
   dépôt** (créé le 23/08, touché le 05/09), là où la règle du 07/09 interdit tout `.md` et où cet
   audit ne le cherchait pas. Déplacé par `git mv` dans `docs/TACHES-AMELIORATION.md`, renvois réécrits.
3. ✅ **`docs/vps-audit/ROADMAP.md` — RETIRÉ le 06/09.** Il datait du 04/09 et son tableau de
   synthèse annonçait **VPS-013 « ✅ FAIT »** (la fiche est `A_TRAITER` au 29ᵉ passage) et
   **VPS-038 en gravité 2** (elle est passée en **gravité 1** le 05/09). **Cette roadmap-ci fait
   désormais foi, seule.**
   👉 **Son contenu non obsolète a été versé ici avant suppression**, et il ne l'était pas qu'un
   peu : le **journal d'exécution du 04/09** (l'auteur du dump que VPS-M81 cherchait), les
   **quatre jeux de valeurs préparées** (digests Traefik et Alpine, périmètre exact des 1,4 Go,
   dépôt distant de `vizyo-leads` vérifié), l'**élargissement de VPS-015 à `tracky-backup`**, et le
   fait que **VPS-M59 est corrigé et compilé depuis le 04/09, mais jamais déployé**.
   ⚠️ **La copie de ce fichier survit sur `perf/garde-fou-tests-et-workers`.** Une fusion future de
   cette branche la ferait revenir. *Le retirer sur `main` ne suffit pas à le faire disparaître —
   c'est à savoir au moment de traiter cette branche.*
4. 🆕 **La Partie II est un instantané DÉRIVÉ, pas une source.** Elle a été construite le 06/09 à
   partir des 124 fiches du référentiel VPS. **Le référentiel dit *pourquoi*, ce fichier dit *quoi
   faire*** — même règle que pour la Partie I. *Si les deux se contredisent un jour, c'est le
   référentiel qui a raison, et c'est cette ligne-ci qui aura échoué.*

---

## Ce que cette refonte a appris

> 🔑 **Un compteur qui monte parce qu'on installe des instruments n'est pas le même compteur.**
> Les actives passent de 26 à 82 en six jours et les `CRITICAL` de 2 à 5 — mais 48 des 82 sont des
> dégradations assumées, 12 sont historiques et closes, et 3 viennent d'un capteur né la veille.
> *Lire un total sans lire sa composition fabrique une alarme sur une amélioration.*

> 🔑 **Le même défaut de message a été corrigé quatre fois, sur quatre chaînes différentes**
> (TRK-060, TRK-066, TRK-068, TRK-070) — un par jour, chacun découvert après coup. **Aucun appel
> sortant de ce dépôt n'a de gabarit de message d'échec.** Le vrai correctif n'est pas le cinquième
> message : c'est un **gabarit commun** que tout appel sortant devrait traverser — *nommer la
> dépendance, l'opération, la conséquence, et garder le motif technique en fin de phrase.*

> 🔑 **Un mécanisme de secours ne vaut que par la ressource qu'il vise.** Le repli `claude → gpt` est
> déployé, correct, testé — et parfaitement inutile parce que le second compte est vide lui aussi.
> *Livrer une redondance sans provisionner sa cible, c'est livrer une ligne de journal.*

## Ce que le rapprochement des deux dispositifs a appris — 06/09

> 🔑 **Les deux instruments souffrent du MÊME défaut, découvert indépendamment.** Côté centre
> d'alerte : *« aucun appel sortant de ce dépôt n'a de gabarit de message d'échec »* — quatre
> correctifs, quatre chaînes, un par jour. Côté VPS : *quatre contrôles rendaient **vert** sur une
> grandeur qui ne répondait pas à la question posée* (VPS-M80, M81, M84, M85). **Dans les deux cas,
> ce n'est pas le défaut qui se répète, c'est l'absence d'un gabarit commun** — de message d'un
> côté, de vérification de l'autre.

> 🔑 **La liste la plus courte est celle qui bloque.** Sur 25 constats VPS ouverts, **9 se
> corrigent par une commande écrite d'avance**, dont le plus rentable — trois unités systemd pour
> trois bases de production sans filet — coûte **20 minutes et 17,8 Mo par jour**. Les **10 autres
> attendent une décision humaine depuis 15 à 33 jours.** *Ce n'est pas un problème de capacité
> technique, et aucune passe de correction ne le résoudra.*

> 🔑 **Un catalogue qui vieillit ment plus vite qu'un référentiel — mais c'est son RÉSUMÉ qui ment,
> pas son détail.** `docs/vps-audit/ROADMAP.md`, retiré ce jour, annonçait **VPS-013 « ✅ FAIT »**
> dans son tableau de synthèse — alors que sa propre section détaillée disait l'inverse, en toutes
> lettres : *« copie ponctuelle, aucun timer, la fiche reste `A_TRAITER` »*. **Le fichier n'était
> pas faux : sa ligne de résumé l'était.** *C'est VPS-M84 sous une autre forme — deux endroits du
> même document répondent à la même question et ne disent pas la même chose, et c'est la version
> rassurante qu'on lit.*

> 🔑 **La note de passation la mieux écrite ne vaut rien si le passage suivant ne l'ouvre pas.**
> `ROADMAP.md` se terminait par une section **« POUR L'AGENT D'AUDIT DE DEMAIN »** qui répondait
> d'avance à quatre questions : qui avait fait le dump du 04/09, que `VPS-M59` était corrigé mais
> non déployé, que `tracky-backup` n'avait pas d'`OnFailure=` non plus, et que quatre tâches
> étaient déjà préparées avec leurs digests. **Les passages du 05 et du 06/09 ne l'ont pas lue.**
> Résultat : un chapitre entier réécrit pour retrouver une réponse déjà écrite (VPS-M81), et un
> angle mort republié comme ouvert alors qu'il était corrigé depuis deux jours (VPS-M59, 11ᵉ
> report).
> *La procédure d'audit impose de relire le dernier rapport et le référentiel. **Elle n'a jamais
> imposé de relire la roadmap** — et c'est exactement là que vivait la passation.* 👉 **C'est le
> premier argument pour n'avoir qu'UNE roadmap, et c'est pourquoi elle est ici.**

---

# 🧾 Journal d'avancement

> **Ajouté le 2026-09-06, sur décision du propriétaire : « on suit ce fichier, et on coche au fur
> et à mesure ».** Une ligne par tâche close, **en tête**, jamais retirée. C'est ici qu'on répond à
> « qu'est-ce qui a été fait, quand, et qu'est-ce qui le prouve ? » — sans relire 700 lignes.
>
> ⚠️ **Une ligne n'entre ici qu'avec sa PREUVE.** Un commit n'est pas une preuve de déploiement, et
> un déploiement n'est pas une preuve de fonctionnement. *C'est la seule règle de ce tableau, et
> c'est celle qui a manqué à `docs/vps-audit/ROADMAP.md` le jour où il a annoncé VPS-013 « ✅ FAIT ».*

| Date | ID | Tâche | État | Commit | La preuve |
|---|:--:|---|:--:|---|---|
| **20/09** *(14 h 30, code)* | **V32 (b)** · **V36 (b)** · récit **doc 36** | `deploy.sh` : repère de repli sur l'image **en service** ; la démo **suit par défaut** (`--sans-demo`) ; `collecte.sh` lit `demo=` ; règle + garde-fou dans `CLAUDE.md` ; récit de l'incident dans `docs/fiabilite-coupe-circuit-2026-09/36-…` | ~ **commitées, pas en ligne** (le VPS doit `git pull` avant le prochain déploiement) | *(voir commit du jour)* | ✅ `pnpm verif:deploiement` : **131 contrôles, tous verts** (95 avant) — dont : `tag sha256:cc1fec4a6ebb… tracky-api:avant-…` (plus jamais `tag tracky-api:latest …`), avertissement quand `latest ≠ image en service`, repli sur `latest` seulement sans conteneur ; démo : `…\|up\|up-lp\|up-demo` par défaut, `--sans-demo` → `"demo":"non"`, démo qui redémarre en boucle → **code 0, aucun `tag …:latest` de repli prod**, `"sante":"healthy","demo":"malade"`, `.env.demo` absent → `"demo":"absente"`, `--repli` → la démo suit aussi. |
| **20/09** *(13 h 35 → 13 h 47)* | **V35** · **V36 (a)** | Ticket Hostinger → limitation CPU confirmée et levée ; 14 conteneurs rallumés ; démo recréée + import | ☑ **V35 FAIT** · » V36 (a) faite, (b) `deploy.sh` à coder | *(voir commit du jour)* | ✅ **V35** : réponse Hostinger 15:36 Paris *« CPU limitation was active and it has now been successfully removed »* ; `/proc/stat` 13:37 steal **1 / 1 / 1 %**, idle 89–96 %, charge 1,24 ; `docker ps -q` 0,14 s ; `/api/health` 55 / 31 / 29 ms ; 13:38 `docker start` ×14 (bases d'abord) → 38/38 running, 14/14 `healthy`/`starting`, `dev.maestroo.app` 200, `dev.maalem-now.com` 200. ✅ **V36 (a)** : `up -d` 13:40:05 → `tracky-demo-api` sur `6b15f68b1061` (= `tracky-api:latest`), `_prisma_migrations` : 5 lignes à 13:40 jusqu'à `20260917120000_rdv_lot_d_synchro_manager`, `information_schema.columns` `managedByManagerAt` = 1 ; `systemctl start tracky-demo-refresh` → `Result=success`, journal *« Import réussi »* 13:47:15, 572 006 positions, `max(createdAt)` 19/09 21:59:57 ; démo 200 en 70 ms. |
| **20/09** *(gestes du propriétaire, 12 h 48 → 13 h 12)* | **V35 (2)** · **V34** · **V32 (a)** · **V14** · **V17** | 14 conteneurs hors prod arrêtés ; garde-fou `docker-orphelins.timer` ; `until=72h` ; apt à 01:30 ; archives du chantier rangées | » V35 **déployée** (ticket (1) à faire) · » V34 **déployée** · » V32 (a) · » V14 · ☑ **V17 FAIT** | *(voir commit du jour)* · source `deploy/vps/docker-orphelins/` | ✅ **V35 (2)** : `config.v2.json` 38 → **24 running**, `docker stop -t 20` en 110 s ; 9 URL de production 200/301/302/307 après ; `sar` 13:00 / 13:10 `%steal` **52 %**, `%idle` **41 %** (75–81 / 8–15 à 12:40–12:50) ; charge **18 → 4–8** ; `docker ps -q` 20 → **4 s** ; ⚠️ échantillon `/proc/stat` 10 s à 13:11 : steal 89 % — le plafond tient. ✅ **V34** : banc sur la machine — faux client tué (age 5 s), chaîne `bash -c` → *« (parent 3453674 tué d abord) »* au journal, client avec pty → `vus=1 tues=0`, **vrai** `docker logs -f --tail 1 tracky-lp` tué, `pgrep -x docker` vide ; `systemctl list-timers` : `docker-orphelins.timer` actif, prochain 13:14:08 ; premier passage réel `Result=success`, 0,6 s CPU. ✅ **V32 (a)** : `grep until /etc/cron.d/docker-image-prune` = `until=72h`. ✅ **V14** : `TimersCalendar={ OnCalendar=*-*-* 01:30:00 }`, `NextElapse 21/09 01:41:32`. ✅ **V17** : `find /var/backups -maxdepth 1 -type f` (hors dpkg/apt) = **0**. |
| **20/09** *(VPS, 11 h 18)* | **V33** · 🆕 **V35** · 🆕 **V36** · **V32** · **T71** · 🆕 **VPS-M104 → M107** | [VPS-016](../vps-audit/REFERENCE-CONSTATS.md) nº 6 et nº 7 clos ; 🆕 [VPS-045](../vps-audit/REFERENCE-CONSTATS.md) l'hôte retient 80–90 % du CPU ; 🆕 [VPS-046](../vps-audit/REFERENCE-CONSTATS.md) la démo n'est plus migrée ; VPS-044 ½ + ½ ; TRK-083 exercé | ☑ **V33 FAIT** · ☐ V35 **gravité 1** · ☐ V36 · » V32 (2ᵉ ✅ par la même chance) · » T71 **exercé** · 🔧 **collecteur corrigé ×4** | *(voir commit du jour)* | ✅ **V33** : `pgrep -a -x docker` **vide** à 10:44 · 11:14 · 11:29 · 11:36 ; `dockerd` 0 / 3 / 0,9 % ; cumul 395,4 → 395,5 h (figé) ; `sar` 05:20 → 05:40 idle 0,08 → 5,81 → 11,62 %. 🔴 **VPS-045** : `sar -u` part servie 96,7 (18:00) → 79,2 (22:10) → 54,2 (23:10) → 32,5 (00:10) → 11,3 (01:10) → 9,4–10,7 (02:00–05:20) → 15,3 (05:30) → 18,1–24,6 % (05:40–11:10, 34 relevés) ; `vmstat` 11:14 `us 6 sy 4 id 0 st 89–91 r 45–49` ; charge 15,8 → 81,7 pendant la collecte. 🔴 **T71** : `engine_control_commands` ≥ 20/09 00:00 : `RESTORE SCHEDULER ACKNOWLEDGED SMS n=2` (03:00:41 ack +220 s `attemptCount 3`, 03:01:32 ack +219 s `attemptCount 2`), `TCP n=28` médiane 13,8 s max 219,6 s ; tranches 11 / 16 / 1 / 2 — la veille 30 / 30 ≤ 10 s. 🔴 **VPS-046** : `tracky-demo-refresh.service exit-code status=1` 04:08:39 ; journal *« The column `managedByManagerAt` does not exist in the current database »* 04:07:58 ; `deploy.sh` relu : aucun `up -d` démo. ✅ **V32** : `tracky-api:avant-20260919-1537-1d1521b2` = `84cc3fe36db2` (créée 17/09 14:45:58) ; `until=24h` intact ; `deploy.sh` l. 278 étiquette `:latest`. ✅ copie hors-site : `copie.log` 17/09 OK 2 paires, 18 · 19 · 20/09 OK 1 ; JSON 20/09 04:30:31Z. |
| **20/09** | 🆕 **T76** · 🆕 **V34** · **V33** · **T65** · **T69** · **T29** · **T30** · **T75** | TRK-089 (watchdog crie toutes les 16 min, preuve remise en retard sans verdict) · VPS-016 nº 7 (2ᵉ `docker logs` bloqué depuis le poste) · nuits 3 et 4 probantes | ☐ **OUVERTES** *(V34 gravité 1)* · ☐ V33 **élargi aux deux clients** · » T65 4ᵉ lecture · ✅ T69 (3)(4) **exercés** · ✅ T29 **3ᵉ preuve** · » T30 1 paire · ☐ T75 **non fait** | *(voir commit du jour)* | 🟢 `engine_control_commands` 60 h : **59 `CUT` `SCHEDULER` / 59 ACK TCP 0,4–6,1 s** (18/09 18:00 ×4, 20:00–20:06 ×25 ; 19/09 18:00 ×4, 20:00–20:06 ×26), **35 `RESTORE` 19/09 ≤ 7,5 s**, 0 SMS, 0 `SENT_UNCONFIRMED`, 0 interlock ; HM-769-GA CUT 18/09 20:05:44 (3,2 s), RESTORE 19/09 05:00:07 (0,6 s). 🔴 `sms_logs` : preuves 19/09 02:30 et 04:30 `delivered` **04:46:41 / 04:46:53** (échos 04:46:41 / 04:46:52) ; `error_logs` : 9 `sms-gateway-watchdog` 02:29 → 04:36 (`androidLastSeenAt` 02:23:55), 2 `sms-daily-proof` 02:45 / 04:45, **0 ligne de retour** ; `notification_deliveries` : `passerelle-sms` 2 `SENT` ×3, `preuve-sms` 2 `SENT` ×2. 🔴🔴 `ps` : PID 3366708 **304 576 s** ; PID 2060212 `docker logs --tail 500 ae54b0ff3f79`, parent 2060192 « === PROXY/ROUTEURS === », `lstart` 19/09 18:30:17 ; `sar` 19/09 `%idle` 37,36 (18:30) → **7,33** (18:40) ; `%steal` 2,80 (22:00) → 20,80 → 45,81 → 67,47 (00:10) → **88,70** (01:10) ; `uptime` **56,34 / 40,61 / 26,64** ; `vmstat` st 90. ✅ `journal.jsonl` 19/09 16:36:39 `8e289f38` `dureeS` 7 037, `sante healthy`, recréation 16:36:28 une seconde après la fin du passage 15:45. 📏 `alerts` 18/09 FV-941-LZ 141,7 à 07:48:51 (`startAt` NUL, trajet `bfadd2a4`) et 09:18:30 (`d96d1397`, créé 08:58). 🔴 `pauses_agents_locaux` `leveeA` NULL, 26 passages « suspendu », 3 `CRITICAL` « manqué » 18/09 02:50, 03:50, 19/09 03:50. |
| **18/09** | 🆕 **T72** · 🆕 **T73** · 🆕 **T74** · 🆕 **T75** | TRK-084 (le retard d'une reprise n'existe nulle part) · TRK-085 (anti-flood qui fond les véhicules) · TRK-086 (recalcul horaire sur boîtier sans fix) · TRK-069 (session Claude expirée) | ☐ **OUVERTES** *(T72 gravité 1, T75 humaine)* | *(voir commit du jour)* | 🔴 24 `RESTORE` CDEF31 nées **05:53:00** au lieu de 05:00 (`scheduledAt` NULL ×24), 24 × « Socket TCP absente au premier dispatch », 20 SMS + 4 TCP, 29/29 acquittées à 06:08, passage 05:45 **absent** (23/24), **0 ligne** ; 6 RESTORE en double (06:02, 06:12, 15:57). 🔴 05:58 : 7 `alertedAt`, **14 `SENT` `restore-non-prouvee`**, **1 ligne** `engine-control-restore` ; 6 SMS `failed` → 4 lignes `sms-gateway-status` (`ErrorLogger` : `source|level|message[0:140]`, 60 s). 🔴 8 `ERROR` `TRIP_AUTOMATION` HM-769-GA 18:29 → 00:45, 35 trajets bruts (31/08, 11/09), `lastPositionAt` 16/09 15:28. 🔴 `passages_agents_locaux` : 401 dès 03:21, pause posée 08:50, 9 passages « suspendu », 0 récit depuis 16/09 22:00. |
| **18/09** | **T28** · **T29** · **T34** · **T40** · **T42** · **T45** · **T62** · **T65** · **T67** · **T69** | Dix tâches déployées passent à FAIT sur les mesures du 17/09 et de la nuit 17→18 | ☑ **FAIT ×10** | `4d1c4cb5` · `18c975ee` · `02d985c3` · `d5c19a17` · `86c32fa9` · `1aa1e0f9` · `b3ee67e2` · — · `0c9672c9` · `87ae29c9` | ✅ **T28** : 15/09 = **222/222/192/0/0** au mot près, 14/09 250 **3/3**, 16/09 figé 216. ✅ **T29** : recréations **13:37:04** et **15:37:05**, une seconde après la fin des passages (attentes 3 355 s et 6 012 s), 23 `done` / 0 `interrupted`. ✅ **T34** : pause `echecs-consecutifs` posée par la sentinelle 08:50, e-mail `DELIVERED`, 1 `DEGRADATION`, 9 passages suspendus sans `CRITICAL`. ✅ **T40** : RESTORE créées deux matins de suite après les CUT. ✅ **T42** : HD-584-BF / BP-434-RD ACK TCP **à la reconnexion** 06:06:56 / 06:06:59 après SMS épuisé. ✅ **T45** : 3/3 preuves `delivered` + écho, `statusUpdatedAt` sur 35/35 sortants. ✅ **T62** : 3 `failed` → `streak 3` → 2 lignes `engine-control-tcp-only` 20:00, coupes TCP seul. ✅ **T65** : 3 lectures (16, 17, 18/09). ✅ **T67** : 0 rappel ancien (55 h) **et** ligne à +5 min sur la RESTORE récente. ✅ **T69** : preuve 19:30 UTC 2 soirs sur 2 **et** 14 `SENT` `restore-non-prouvee` à 05:58. |
| **17/09** *(VPS)* | 🆕 **V33** · **V6** · 🆕 **VPS-M103** | [VPS-016](../vps-audit/REFERENCE-CONSTATS.md) ↑ gravité 1 — 6ᵉ occurrence ; VPS-037 — 2 paires sans copie ; une lecture d'hier réfutée | ☐ **OUVERTE** · ☐ · 🔧 **collecteur corrigé ×3** | *(voir commit du jour)* | 🔴 `docker logs --tail 15 vizyo-auth-api` lancé le **16/09 12:41:08 UTC** depuis `82.67.153.51:26499` (`bash -c` pid 3366707, PPID 1, vivant), **52 743 s** ; `sar` **85 → 42 %** sur 12:40–12:50 puis **37–40 %** jusqu'à 03:20 ; `dockerd` **98,3 %**, cumul **304,6 → 319,5 h** ; 09-16 **63,33 %**, 09-17 partiel **38,65 %** ; `kill` **non exécuté** (V33). 🔴 Poste en veille **23:16:59 → 03:15:38 Z**, audits lancés à **03:16:25** tous deux, JSON de copie du **15/09 04:30**, `verify_20260916` + `verify_20260917` sans copie. 🔑 `trip_automation_runs` 09-16 07h–12h **à deux cœurs** : 54 · 55 · 55 · 53 min = 09-14 à un cœur (VPS-M103). ✅ `unattended-upgrades` 06:52:26 : polkitd ×3 installés (VPS-M74). ✅ `avant-20260916-0519` = `cc1fec4a6ebb` / `c8d99972e2eb`. |
| **17/09** | **T65** · **T69** · **T38** · **T45** · **T67** | TRK-066 — deuxième nuit du chantier, la première probante | » **T65 : premier passage OK** (5 OK / 2 non exercés / 0 rouge) · » T69 moitié 1 **exercée** · » T45 relais **exercé** · » T67 seconde moitié non exercée | `87ae29c9` (T69, déployé 16/09 05:24) | 🎯 `sms_logs` : `gateway_daily_proof` `delivered` à 16/09 02:30, 04:30, **19:30** *(21:30 Paris)* et 17/09 02:30, `statusUpdatedAt` +6 s sur 6/6 sortants ; journal : « 1/1 acceptée » 02:30:00, « **verdict=OK** » 02:45:00 ; **0 ligne** `sms-daily-proof`, **0** `sms-gateway-watchdog`, **0** `engine-control-interlock` depuis 16/09 02:24 ; ping `lastSeen` 03:28:44 → 03:29:44 (**60 s**). `engine_control_commands` : **4 CUT MH Cars 18:00:01–18:00:50** (ACK TCP 0,8–5,0 s), **24 CUT CDEF31 20:00:02–20:06:00** — 22 ACK TCP 0,4–5,4 s, **HM-733-GA par SMS** (`engine_control_fallback` `delivered` 20:06:52, accusé entrant 20:06:53, **83 s**), **GR-898-HY `SENT_UNCONFIRMED`** (TRK-083) ; 3 RESTORE manuelles ACK (HM-733-GA 21:04, GS-187-NY 22:31/22:32) ; **4 RESTORE MH Cars 03:00:01–02, ACK 1,8–4,1 s** ; **0 SMS de RESTORE, 0 relance, 0 ligne `engine-control-*`** ; `engine_delivery_attempts` 83. **22 RESTORE CDEF31 dues à 05:00 UTC, à lire à 07:10 Paris.** |
| **17/09** | 🆕 **T71** · 🆕 **T70** · 🆕 **V33** | [TRK-083](./REFERENCE-ERREURS.md#trk-083) — course guetteur/ACK · [TRK-082](./REFERENCE-ERREURS.md#trk-082) — sentinelle sur l'ancienne clé · VPS-016 nº 6 | ☐ **OUVERTES** | — | **T71** : chronologie GR-898-HY à la ms — commande 20:01:30,711 ; `beginAttempt` 20:01:33,128 (+2,4 s) ; **`jt` du boîtier 20:01:38,339** ; `writeSent`/`sentAt` 20:01:39,251 (+6,1 s) ; `waitForAck` ≥ 20:01:39,3 (`engine-control.service.ts:1808 → 1950 → 1963 → 1985`) ; `TIMED_OUT` 20:01:54 ; 27 autres coupes : +5 à +90 ms, ACK 0,4–5,4 s ; véhicule coupé (69 positions vitesse 0, contact coupé). **T70** : 3 trajets FV-941-LZ créés à 06:45 / 07:45 / 16:45 par le recalcul, alertes du véhicule à 05:49 (`startAt` 05:22:37), 06:47 (06:32:37), 15:51 (15:25:57) ; `sentinelles-coherence.service.ts:499-506` juge par `tripId`. **V33** : `ps` — PID 3366708 `docker logs --tail 15 vizyo-auth-api`, parent 3366707 `bash -c …` → 1, `lstart` 16/09 12:41:08, `etimes` 53 318 ; `top` : `dockerd` 91,7 % ; `uptime` 1,32 / 1,73 / 1,85. |
| **17/09** | **T28** · **T13** · **T30** · **T9** | TRK-016 — la journée close ne se compare qu'à J+2 · TRK-078 — preuve négative · les 3 HM-… levées | » T28 **définition complétée** · » T13 flux neuf **100 %** · » T30 **preuve négative** · ☐ T9 **partie HM faite** | *(commit du jour — `collecte.sql`)* | **T28** : 15/09 = **222 / 222 / 192 / 0 / 0** contre 273 hier, 71 supprimés / 20 créés le 16/09 par le recalcul (`lookbackHours` = **26** en base) ; 14/09 = **250** 2/2 ; `fenetre_recalcul_close` ajoutée (O dès J+2 00:00 UTC), `cloture_moins_2h_depuis_creation` = **250/250, 222/222, 212/212**. **T30** : paires FM-772-JH 05:51/07:56 (130,3, `absolu`, `startAt` NUL, trajets `2b1822f6`/`3df5312f` chevauchants 12 min) et 15:05/15:50 (140,6, `startAt` 14:06:51 / 14:08:10 = 79 s, `a348005e` créé 15:45). **T9** : `system_activity_logs` `vehicle_back_in_service` 16/09 08:33:01/20/28 sur HM-769/779/733-GA ; `hors_service` 7 lignes ; `GPS_LOST` HM-769-GA 08:35:15. |
| **16/09** *(VPS)* | **V28** | VPS-016 — le client Docker bloqué, tué le 15/09 17:20 | ✅ **FAIT ET PROUVÉ** *(confirmé par l'audit VPS)* | — | 🎯 **Quatre lectures indépendantes** : `sar` 09-15 **37–40 %** d'inactivité jusqu'à 16:40 → **48,6 %** à 17:40 → **86,3 %** à 18:40, 86–89 % ensuite, **87,0 %** le 09-16 partiel ; `dockerd` **0,7 %**, cumul figé à **304,6 h** (+15,2 h = 02:23 → 17:23, à 3 min du journal du propriétaire) ; **0 client, 0 connexion socket** ; `journal.jsonl` : **`deploy.sh` fa9ff1d1 en 226 s** — première durée à deux cœurs — contre 303–585 s et 1 916 s ; `trip_automation_runs` 34 · 29 min → 15 · 5 · 3 · 1 min. Journée du 09-15 à **50,78 %** : le seuil 🔴 « trois jours » n'a pas été franchi. **VPS-016 → `SURVEILLANCE` gravité 2** ; la classe reste ouverte (V29). **V4 et V5 débloquées.** |
| **16/09** *(VPS)* | **V6** · **V31** | [VPS-037](../vps-audit/REFERENCE-CONSTATS.md) ↑ · VPS-043 — le poste dormait, pas de copie hors-site | ☐ **AGGRAVÉ (3 → 2)** · ☐ mécanisme intact | — | 🔴 Journal Windows : sortie de veille **02:20:45 UTC** (l'heure de l'audit), **rendormi dans la seconde**, réveil **04:34:19** → audit à **04:36** (+134 min, le collecteur ne le disait pas — corrigé) ; tâche `Vizyo-Verify-Copie-HorsSite` (04:30) **pas tournée** : `copie.log` au 15/09, JSON du VPS **15/09 04:30:10**, `NextRunTime 17/09`, `StartWhenAvailable` sans effet, **`WakeToRun=false`**. **La paire du 16/09 n'existe que sur le VPS — 2ᵉ fois en 3 jours** (09-14 : mécanisme ; 09-16 : sommeil). ✅ Le test de V31 est tombé du bon côté : **15/09 04:30 = `OK`, `pairesCopiees 2`** (manifestes 08-30 et 08-31 purgés ensemble) — mais le `throw` est intact. Geste immédiat (30 s, poste) : `WakeToRun` sur les deux tâches ; preuve : JSON du **17/09 04:30** avec `pairesCopiees 2`. |
| **16/09** *(VPS)* | 🆕 **V32** · 🆕 **VPS-044** · **V17** · 🆕 **VPS-M102** | [VPS-044](../vps-audit/REFERENCE-CONSTATS.md) — le repère de repli effacé par le ménage ; les dumps de la fenêtre hors rétention ; un `find /` de l'audit | ☐ **OUVERTES** + 🔧 **collecteur corrigé ×5** | *(voir commit du jour)* | `docker image inspect 5da87fd11e72` → **`No such image`** : l'image de **9afdf52a** (en service jusqu'au 15/09 17:35), étiquetée `avant-20260914-1140` (37 h), partie au ménage de **00:40**, 6 h 25 après 0c9672c9 — `deploy.sh --repli avant-20260914-1140-9afdf52a` (doc 25) **échouerait** ; `avant-20260915-1731/1741` = images **pré-construites** (17:28:41), `tracky-web:avant-…-1731` = build rdv-v2 du 09-14 11:46 **jamais déployé**. Retour possible par rebuild du SHA (~4 min), par aucune étiquette. **V17** : `/var/backups/vizyo-tracky/avant-chantier-20260915-1720.dump` (**161 Mo**, `.dump` hors motif de rétention) + 2 dumps à la **racine** de `/var/backups` + un `vizyo_leads` de **mars** — 4 fichiers invisibles au collecteur, **corrigé** (le banc a attrapé 43 faux positifs `dpkg`). Collecteur : dépôt < 2 Ko → 🟠 (Dispocar 3ᵉ nuit à 1 172 o) ; périmètre **comptes + dossiers** ; démo/dev en ⬜ VOULU (V27) ; **heure de départ vs planifiée**. ⚠️ **VPS-M102** : un `find /` non borné lancé en marge par l'audit, **3 min 30 à charge 2,84** — consigné, non tué. Collecte **143 s** (1,6×) : première mesure sans `dockerd`, **`/opt` = 42 s** (V5 se tranche). `apt` **valide** : 73 dont **3 sécurité** → test demain 06:52. |
| **16/09** | **T65** | TRK-066 — les 24 h de preuve lues par la routine | `»` **DÉPLOYÉ — LUE POUR LA 1ʳᵉ FOIS** | *(doc)* | Rapport du 16/09, section « Coupe-circuit — 24 h de preuve » avant « Chiffres », six verdicts datés 01:15 → 01:18 UTC : (1) preuve quotidienne **non exerçable** avant 02:30 UTC — et la preuve manuelle du soir **n'a pas été envoyée** (`sms_logs` : aucun sortant depuis le 14/09 07:00:02) ; (2) sentinelle Android **1 ligne** (17:37:00, S21 hors ligne depuis 13:49:42, débloqué 17:51) ; (3) `lastSeen` **01:16:22** puis **01:17:22** — OK à 60 s ; (4) interlock **rouge** — `GET /api/admin/sms/status` non lu (pas de jeton), dérivé de la base et confirmé par **20 lignes `engine-control-interlock`** ; (5) RESTORE non prouvées **0** — non exercé ; (6) TCP seul **0** — non exercé. *Pas de Go pour le banc.* |
| **16/09** | 🆕 **T68** · 🆕 **TRK-081** | L'interlock rouge toute la nuit le dit 36 fois en `CRITICAL` | ☐ **OUVERTE** | — | **20 lignes** `engine-control-interlock` `CRITICAL` de 15/09 20:00:00 à 16/09 01:09:00, **une toutes les 15 min**, même `reason` (« dernière preuve de remise SMS trop ancienne (> 24 h) »), alternance **24 refus / 1 refus** (paliers 30 min du cron, AL-927-QM décalé) ; `email_logs` : **5 e-mails** « erreurs critiques — engine-control-interlock » (20:10, 21:20, 22:30, 23:30, 00:30). `signalWithheldCut` (`engine-control.service.ts:1691`) écrit `CRITICAL` à chaque quart d'heure sans distinguer la première ligne. Correctif sur la forme seule ; la garde n'est pas en cause. |
| **16/09** | **T67** | TRK-066 — sentinelle des RESTORE bornée à 24 h | » **MOITIÉ PROUVÉE** | `0c9672c9` | Avant (17:35 → 18:14) : **3** `CRITICAL` `engine-control-restore` sur FV-941-LZ (RESTORE `FAILED` du **14/04**, `repeatedSuppressed: 49`), **50** vieilles RESTORE portent `alertedAt` ; après (18:14:50 → 01:15) : **0 ligne en 7 h 03** là où **28** rappels étaient dus. Reste : aucune RESTORE de la nuit n'a existé (interlock rouge) — la seconde moitié attend la première nuit avec coupes. |
| **16/09** | **T28** | TRK-016 — la mesure du recalage sur la journée close | `»` **DÉFINITION VERSIONNÉE** | *(collecte.sql)* | 13/09 = **86 / 86 / 66 / 20 / 0** une seconde fois (2 / 2). **14/09 = 259 / 259 / 248 / 0 / 0 contre 244 / 244 / 233 / 0 / 0 hier, les 259 existaient à 01:11 hier** (`createdAt`) ; quatre définitions de journée essayées, **aucune ne rend 244** ; seule `("endedAt" AT TIME ZONE 'Europe/Paris')::date` — qui décale de 4 h sur un `timestamp` sans fuseau — rend le 86 / 66 / 20. **`collecte.sql` gagne `recalage_journees_closes`** (journée civile de Paris, `AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris'`, `endedAt`, J-1 → J-3), **vérifiée en production** : 13/09 = 88 / 88 / 60 / 28 / 0 · 14/09 = 250 / 250 / 239 / 0 / 0 · 15/09 = 273 / 273 / 263 / 0 / 0. *On fixe la définition, pas le chiffre.* |
| **16/09** | **T38** · **T9** · **T55** | TRK-066 — première nuit en production | ☐ **NON PROBANTE** | — | 25 coupes **refusées** à 20:00 UTC, **0 `CUT` / 0 `RESTORE` / 0 SMS** depuis le déploiement, 30 plannings `IN_WINDOW` (`lastEvaluatedAt` figé 15/09 05:00), **HM-733-GA / HM-769-GA / HM-779-GA dans la liste des refusés** (T9 : coupés le premier soir vert) ; S21 verrouillé 13:49 → 17:51 la veille d'une nuit de preuve (T55), ping à 60 s depuis. **À faire avant 19:30 Paris** : `verdict=OK` des preuves de 02:45 et 04:45 UTC, sinon preuve à la main ; prévenir CDEF31. |
| **16/09** | **T30** · **T6 / T39** · **T13** | Relevés du jour | 📏 | — | T30 : **5** `OVERSPEED` (FV-941-LZ ×4, EP-047-TY), **0 doublon**, 0 orpheline, 1 alerte à `startAt` nul. T6 / T39 : **36 remises, 100 % `SUPER_ADMIN`** (3ᵉ point). T13 : **734** traces `rattrapage` (+299), **5 644** restants sur 10 016. `trip_automation_runs` : 24 / 24 le 15/09, 5 > 45 min **tous avant la mort de V28**, 00:45 en 3 min. |
| **15/09** *(VPS)* | **V28** | VPS-016 — le client Docker bloqué, 46ᵉ heure | ☐ **OUVERT — 165 294 s** | — | 🔴🔴 PID **159541** et parent **159533** vivants à **02:28:55 UTC**, `dockerd` **100 %** (cumul 265,3 → **289,4 h**, **+24,1 h de CPU en 24 h 00**), `sysstat` lundi 09-14 **complet : 38,9 % d'inactivité** (2ᵉ journée entière < 50 %), `steal` 2,4 → **4,1 %** ; `sar` 38–41 % à chaque relevé, fosses à 7,95 % (08:20) et 8,37 % (11:50). 🆕 **Coût mesuré** : `journal.jsonl` porte `deploy.sh` du 09-14 08:20:38 (`9afdf52a`) en **1 916 s = 31 min 56** contre 303–585 s les 7 passages du 09-13 — *ces 303–585 s étaient déjà à un cœur : aucune durée à deux cœurs n'existe, le premier `deploy.sh` après V28 sera la première*. Demain = 3ᵉ jour < 50 % = seuil 🔴 du collecteur. Geste inchangé, parent d'abord |
| **15/09** *(VPS)* | 🆕 **V31** · 🆕 **VPS-043** · 🆕 **VPS-M100** | [VPS-043](../vps-audit/REFERENCE-CONSTATS.md) — la copie hors-site de Verify s'est arrêtée sur un manifeste orphelin | ☐ **OUVERTE** + 🔧 **collecteur corrigé** | *(voir commit du jour)* | `DERNIERE-COPIE-LOCALE.json` (09-14 **04:30:06** UTC) : `statut ECHEC`, *« téléchargement de `verify-db_20260830-033156.sql.gz.gpg` en échec »*, **`pairesCopiees 0`**. `copie.log` du poste : 16 paires vues (15 + **1 manifeste orphelin** — le VPS purge par **trois `find -mtime +14` séparés**, l'archive part, le manifeste reste 46 s de plus), le copieur commence par la plus ancienne, `throw`, **la paire du 09-14 n'est jamais atteinte**. Le 09-11 le même mécanisme avait fait re-télécharger la paire 08-27 (signe avant-coureur). 🔑 Le collecteur imprimait `vizyo-verify ECHEC 21 h a jour` — le verdict ne lisait que l'âge de la **tentative** (VPS-M84 sur une ligne) → **VPS-M100, corrigé** (le statut décide, `detail` + `pairesCopiees` imprimés). **Test écrit d'avance** : le 16/09, `OK` + `pairesCopiees ≥ 2` (une chance sur deux, selon les secondes du manifeste 08-31) ou nouvel `ECHEC` sur `20260831` ; `OK` + 0 ne prouve rien. ⚠️ V6 ne remplace pas V31 |
| **15/09** *(VPS)* | **V30** | [VPS-042](../vps-audit/REFERENCE-CONSTATS.md) — un troisième compte de dépôt | 🔁 **ÉLARGIE** | — | `useradd` **09-14 05:32:03 UTC** : `dispocarbk` (uid 1001), clé `depot-sauvegarde@dispocar` avec `command="/usr/local/bin/recevoir-dump-dispocar",restrict` — **copie de `recevoir-dump`** (`diff` : motif `prd|dev-dispocar-*` seulement), **même adresse `179.198.198.199`** (42 connexions / 7 j = 18 + 17 + 7). Dépôt `/var/backups/dispocar-distant/` : **4 dumps `age` de 1 172 octets**, `prd` **=** `dev` à l'octet — essais 05:32 (5 connexions en 37 s), puis **01:30 / 01:32 UTC** cette nuit. Vu par le bloc `useradd` (VPS-M98) **et** le bloc « non réclamés » (VPS-M99) : la leçon des deux passages précédents a rendu. ⚠️ 1 172 o = la taille d'une **base vide** — à vérifier côté Dispocar, pas d'ici. `ordonnancement` : `dispocar-depot-dump` ajouté |
| **15/09** *(VPS)* | **V27** · 🆕 **VPS-M101** | [VPS-040](../vps-audit/REFERENCE-CONSTATS.md) — la démo n'a jamais analysé | ✅ **QUESTION CLOSE SUR LE FAIT** + 🔧 **collecteur corrigé** | *(voir commit du jour)* | `trip_automation_settings` sur `tracky_demo` : **`enabled = false`** (réglé **09-07 14:45**), **`lastRunAt` NUL**. Les 11 753 `trip_analyses` (max `computedAt` 09-12 22:48) sont **importées** de la production avec leurs horodatages : les « 121 arrivées » d'hier étaient des lignes copiées, le « 0 » d'aujourd'hui l'absence d'import — *ni activité ni arrêt, un miroir*. Le collecteur imprime désormais l'interrupteur par base (banc : prod `ACTIVE, dernier run 01:50` ; démo `COUPEE, dernier run JAMAIS`). Ne reste que la décision : ne pas sauvegarder (525 Mo/j) |
| **15/09** *(VPS)* | **V29** · **V26** · **V14** · **V1** | Les tâches VPS re-mesurées | ☐ **OUVERTES** | — | **V29 — 3ᵉ nuit** : `logrotate` 00:00:04 → 00:00:36, **13,2 s de CPU** (1,98 hier), **5** courants troués (`maestroo-dev-lp` entre, 2 sortent par rotation Docker), **17** à 0 octet, `texto-relay` 4ᵉ jour — *le compte tourne*. **V26 — 9ᵉ jour**, 261 h PÉRIMÉE ×3, 9 copies côté vivant. **V14** — 15ᵉ échec / 18, cache de 9 h (16:39), conforme à la loi. **V1** — lundi complet **33** (4ᵉ jour ≥ 32), 3 compteurs **33 / 33 / 33** ; `…6714` a produit des positions le 09-14 jusqu'à 14:23 puis trames seules (intermittent). ✅ Ménage 00:40 : 34 → **31** images (les 3 paires du 09-13 parties comme écrit) — `avant-0811` a survécu : le filtre `until` date **l'étiquette**, pas le build ; attendu 16/09 : **27 images, plus de `tracky-api:latest`** (jamais déployé, 11:47 — 🆕 bloc « ce qui tourne contre `latest` », qui aurait sonné sur T66). Collecte à l'heure (02:22:55), seule, 182 s |
| **15/09** | **T27** | TRK-076 — la carte survit à une perte de contexte WebGL | ✅ **FAIT** | `09d04e2b` *(déployé 08/09 01:01:57)* | **0 ligne `getSource` depuis le 07/09 13:04 — 180 h, 168 h après déploiement** ; échéance de 7 j atteinte ; le compte qui l'avait produite (`standard@cdef31.org`) revenu 5 jours sur 6 (2, 2, 9, 7, 10 requêtes) sans une ligne. *Preuve par l'échéance : une perte de contexte rattrapée n'a pas été observée, elle ne se provoque pas en lecture seule.* |
| **15/09** | **T29** · 🆕 **T66** | TRK-077 — la garde relue avant la recréation | `»` **DÉPLOYÉ — refus MESURÉ PAR L'ABSENCE** | `18c975ee` | 14/09 11:40 : repères `avant-20260914-1140-9afdf52a` posés, `feat/rdv-installation-v2` tirée (`dcfeb9a5`), images construites à 11:46:03 / **11:47:34** ; passage **11:45:00 → 12:44:23 (59 min)** en cours ; `journal.jsonl` muet depuis 08:20:38, `tracky-api` `StartedAt` 08:20:37 sur l'image `5da87fd…` = l'étiquette `avant-…-1140`, `leadDays` **absent** de `/app/apps/api/dist`. `origin/main` `02b8a6cf` (10:43) : « correctif **déployé sur prod** ». **Le refus est juste, son silence ne l'est pas** → T66 ouverte : journaliser refus et abandons, une `DEGRADATION` de la sentinelle « déploiement ». |
| **15/09** | **T38** · **T47** · **T14** | TRK-066 · TRK-053 — le coupe-circuit sur l'ancien code | ☐ **OUVERTES — occasion venue** | — | `engine_control_commands` 14/09 : **24 `CUT` `SCHEDULER` 20:00:01 → 20:00:08 UTC, toutes `ACKNOWLEDGED` / TCP (+1 à +5 s)**, dont HD-584-BF et BP-434-RD (T61) et **HM-733-GA, HM-779-GA déclarés « Retour de LLD »** ; HM-769-GA différé « hors champ GPS depuis 362 min » (TRK-046) ; **2 `RESTORE` `MANUAL` 21:13:19 (HM-733-GA) et 21:14:41 (GS-187-NY)**, `overrideUntil` 05:00. `vehicle_schedules` cdef31 **30 / 30**. Prod `9afdf52a`, **45 commits de `main` manquent** ; colonnes de T65 absentes en base. **22 `RESTORE` à 05:00 UTC sur le même code — à lire à 07:10 Paris.** |
| **15/09** | **T28** · **T30** · **T13** | TRK-016 · TRK-078 — les tests datés du lundi | `»` **DÉPLOYÉES** | `4d1c4cb5` · `229b7861` | **T28** : journée du 13/09 **retrouvée à l'identique 86 / 86 / 66 / 20 / 0** (re-mesure 1 sur 2) ; 14/09 = **244 / 244 / 233 / 0 / 0**, délai moyen 42 min, max 197. **T30** : 187 analyses, **1 qualifiée** (GR-270-HZ 141 km/h > 130 ; mh cars 0 segment ≥ +40, 0 pointe > 130) → **1 alerte, 0 doublon, 0 orpheline** — détection saine, déduplication non exercée. **T13** : 435 traces `rattrapage` (+255 = 17 × 15), 6 139 restants. |
| **15/09** | **T58** · **T31** | TRK-069 — le test daté de la veille | ☐ **COMMITÉ** *(T58)* · ✅ *(T31 tient)* | `1539674c` | `CRITICAL` « courrier-ia … SyntaxError » née à **01:50:00** (ancre du refroidissement 01:50, pas 02:50 — même mécanisme), refermée à **04:50** par le passage de 04:30 (« 2 travaux livrés », `activity_report_generated SUCCESS`) ; **13 `CRITICAL` archivées en un balayage à 04:50:00.214** ; **22 / 22 passages réussis** le 14/09. `agents-locaux` : 0 active. |
| **14/09** *(VPS)* | **V28** | VPS-016 — le client Docker bloqué, 22ᵉ heure | ☐ **OUVERT — 78 814 s** | — | 🔴🔴 PID **159541** et parent **159533** vivants à **02:27:35 UTC**, `dockerd` **101 %** (cumul 249,0 → **265,3 h**, +16,3 h de CPU en 16 h 14 = un cœur entier), `sysstat` samedi 09-13 **complet : 47,7 % d'inactivité** (85–89 % les 7 jours d'avant) — **1ʳᵉ journée entière sous le seuil 🟠 du collecteur** ; 09-14 partiel 40,2 %. Le journal `/opt/tracky-deploiements/journal.jsonl` (T33) porte **7 `deploy.sh` le 09-13, 303 à 585 s** — 48 min de build sur un seul cœur ; aucune durée à deux cœurs n'existe : **faire V28 avant le prochain déploiement**. Geste inchangé, parent d'abord |
| **14/09** *(VPS)* | **V30** · 🆕 **VPS-M99** | [VPS-042](../vps-audit/REFERENCE-CONSTATS.md) — la lecture du 13/09 corrigée par les scripts | 🔁 **REFORMULÉE** + 🔧 **collecteur corrigé** | *(voir commit du jour)* | `recevoir-dump` (lu) est un **DÉPÔT ENTRANT** : Vizyo Conductor (179.198.198.199) **pousse** chaque nuit ses dumps chiffrés `age` — instances `prd` et `dev`, une connexion chacune 01:00–01:08 UTC — dans `/var/backups/vizyo-conductor-distant/` (**14 fichiers**, 26–31 Ko, rétention 14 par instance, clé de déchiffrement absente d'ici). **Cette machine est le dépositaire hors-site de Conductor.** `vault-dump` (lu) **est** un tirage sortant (`sqlite3 .backup` + `tar` → stdout, 0,6 s/nuit). La session `vaultbk` de **100 h** ne porte **aucune commande** (canal vide, `do_poll`) : pas un dump bloqué. 🔑 Le collecteur imprimait `vizyo-conductor-distant AUCUNE SAUVEGARDE` le 13 **et** le 14/09 — filtre `.gz`/`.gpg` seulement, VPS-M88 un cran plus bas — **VPS-M99, corrigé** (`.age`, propriétaire du dossier, 3ᵉ lecture « dépôt d'une autre machine »), banc 1,7 s. V30 reformulée : reconnaître **le rôle** ; qui relit la copie du coffre côté Conductor ; fermer ou assumer la session ; 256 Mo sur `vizyo-vault` |
| **14/09** *(VPS)* | **V14** | [VPS-033](../vps-audit/REFERENCE-CONSTATS.md) — la mesure `apt` | ✅ **GESTE CONFIRMÉ PAR LE CODE** | — | `apt-daily.timer` : `OnCalendar=*-*-* 6,18:00` + `RandomizedDelaySec=12h` ; `check_stamp()` compare **minuit du jour du tampon à minuit d'aujourd'hui** → la **1ʳᵉ sonnerie de chaque jour UTC rafraîchit** (13–27 s de CPU), la 2ᵉ ne fait rien (1 s) — journal : 09-13 03:01:51 rafraîchit, 15:12 et 19:56 rien ; `LastTriggerUSec` ne montre que la dernière. Cache frais à 02:20 **ssi** la sonnerie de 18 h tombe entre 00:00 et 02:20 = **2 h 20 / 12 h ≈ 19 %** ; mesuré **3 succès / 17 = 18 %**. Le geste (`OnCalendar=*-*-* 01:30:00`, `RandomizedDelaySec=15m`) est compatible avec le tampon : rafraîchit chaque jour 50 min avant l'audit. *Ne marcherait pas : garder deux sonneries et réduire l'aléa* |
| **14/09** *(VPS)* | **V29** · **V26** · **V27** · **V1** | Les tâches VPS re-mesurées | ☐ **OUVERTES** | — | **V29 — la stanza a re-percé** (logrotate 00:00:10 → 00:00:29) : **6** courants troués (`maestroo-dev-web` s'ajoute), **18** à 0 octet (13 hier), `texto-relay` 3ᵉ jour à 0 — *geste à faire avant minuit*. **V26 — 8ᵉ jour**, 237 h PÉRIMÉE ×3, 8 copies chacun côté vivant. **V27 — question neuve** : depuis l'import de dimanche la démo ne produit **plus aucune analyse de trajet** (0 / 24 h contre 121, `max(computedAt)` = 09-12) — voulu ou effet de l'import ? **V1** — samedi complet **32** (3ᵉ jour ≥ 32), registre 11 / 11 / 11 (tous > 7 j : du temps qui passe), `…6714` 3ᵉ jour sans position. ✅ VPS-M92 : 1ʳᵉ différence de périmètre, **identique** ; collecte à l'heure (02:22), seule, 189 s |
| **14/09** | **T25** | [TRK-074](./REFERENCE-ERREURS.md#trk-074) — résolution automatique du témoin des tâches | ✅ **FAIT ET PROUVÉ** *(confirmé par l'audit)* | `171857fc` | 🎯 Les 4 `CRITICAL` du 06/09 (17:35 → 20:35) portent `resolvedAt = 13/09 13:35:00` et la note *« Tâche repassée le 13/09/2026 14:55 (résolution automatique) »* — **deux minutes après le déploiement de 13:33, après 165 h**. `resolvedAt` ×2 dans `dist/observability/scheduled-task-heartbeat.service.js` servi ; **0 ligne active** de cette source au 14/09 (11 au total, toutes archivées). ⚠️ Seconde moitié — une tâche réellement à l'arrêt continue d'en produire — **non exercée** : 24/24 `done` chaque jour depuis |
| **14/09** | **T5** | [TRK-062](./REFERENCE-ERREURS.md#trk-062) — `SENT_UNCONFIRMED` pour les commandes de boîtier | ✅ **FAIT ET PROUVÉ** *(confirmé par l'audit)* | `66d286f5` | 🎯 Les 2 commandes SMS du 01/09 (`shock_on`, `shock_off`, BP-434-RD) portent `SENT_UNCONFIRMED` et `expiredAt = 13/09 20:30:00` — **premier balayage après le déploiement de 20:25, après 298,3 h et 294,9 h**. `cloturerCommandesSmsSansReponse` et `SENT_UNCONFIRMED` dans `dist/tracker-commands/` servi. **`commandes_en_attente` rend 0 ligne** : première collecte sans aucun résident. ⚠️ Non exercé : une commande SMS **neuve** doit rester « envoyée » 4 h puis basculer, jamais avant — aucune envoyée depuis |
| **14/09** | **T31** | [TRK-069](./REFERENCE-ERREURS.md#trk-069) — une cause, une ligne | ✅ **FAIT ET PROUVÉ** *(et `13471c53` prouvé)* | `a8f9575e` · `13471c53` | 🎯 **La rechute que le second commit décrit s'est produite AVANT lui, et plus après.** La cause « plafond » a été rouverte à **18:50** sur l'échec ancien de `agent-recit-trajet` (05:48), une heure après sa levée par le rattrapage ; `13471c53` est en ligne à **20:02** ; depuis, **cinq contrôles (20:50 → 00:50) sans rechute** sur la même condition — *l'échec de 05:48 est toujours le dernier passage de cet agent* —, et la ligne de 18:50 s'est refermée seule à 22:50. 12 lignes `agents-locaux` archivées seules dans la journée ; **13 `CRITICAL`** attendent le premier passage réussi de `agent-recit-trajet` (03:15 Paris) et `courrier-ia` (06:30 Paris) |
| **14/09** | **T28** · **T13** | [TRK-016](./REFERENCE-ERREURS.md#trk-016) — la mesure « à la clôture » | `»` **DÉPLOYÉ — première mesure** | `4d1c4cb5` | 📏 **Journée close du 13/09 (Paris) : 86 trajets, 86 recalés, 66 signés `cloture` à moins de 2 h** (délai moyen 26 min, max 74), **20 d'origine inconnue** (antérieurs aux colonnes de 13:33), **0 sans recalage**. 🗓️ **Preuve attendue les 15 et 16/09 : retrouver 86 / 86 / 66 / 20 / 0** — si ça bouge, le rattrapage réécrit encore le passé ; la journée du 14/09 sera la première sans « origine inconnue ». Rattrapage : **180 traces signées `rattrapage` = 12 passages × 15**, au trace près ; fenêtre 2 → 60 j par `startedAt` : 10 211 trajets, **6 586 restants** |
| **14/09** | **T30** | [TRK-078](./REFERENCE-ERREURS.md#trk-078) — dédupliquer sur l'excès | `»` **DÉPLOYÉ — indécidable** | `229b7861` | Marqueurs `memeExcesDejaAlerte` et `rattacherAuTrajet` relus dans `dist/alerts/alerts.service.js` servi. Depuis 11:30 : **0 groupe** (véhicule, `startAt`) en double **ET 0 excès distinct** — un dimanche ; 9 groupes en double sur les 7 jours d'avant ; les 2 orphelines n'ont pas bougé. 🗓️ Verdict au **premier jour ouvré** : ~3 excès distincts et 0 doublon. *0 et 0 un jour ouvré = détection cassée* |
| **14/09** | **T58** | 🆕 [TRK-069](./REFERENCE-ERREURS.md#trk-069) — la clé de refroidissement doit porter la CAUSE ; `courrier-ia` lit le premier objet JSON équilibré | ☐ **OUVERT** | — | *(tâche neuve)* 🔴 Le passage `courrier-ia` de **17:52** est en échec (`SyntaxError: Unexpected non-whitespace character after JSON at position 407`, un `rapport-activite` reposé en tentative 2/3) et **le centre d'alerte n'en dit rien** : la clé (agent, motif) = (courrier-ia, échec) a été consommée à **02:50** par la ligne « weekly limit », pour 24 h. *Un échec d'une AUTRE cause sous la même clé est muet jusqu'au lendemain.* 🗓️ **Test daté : une `CRITICAL` « courrier-ia … SyntaxError » au contrôle de 03:50 UTC** (sauf réussite à 04:30 avant). Côté agent : l'extraction `\{[\s\S]*\}` prend du premier `{` au DERNIER `}` — une phrase ajoutée par le modèle après son objet fait reposer un rapport client |
| **14/09** | **T59** | 🆕 [TRK-079](./REFERENCE-ERREURS.md#trk-079) — les `fetch` avortés par la fermeture de page ne sont pas des pannes | ☐ **OUVERT** | — | *(tâche neuve)* 4 lignes `frontend-anon` (22:50, 23:14) : deux adresses **Amazon EC2**, agent *« iOS 18 + Safari 26 »* qui n'existe pas, deux appels échoués **à 8 ms** alors que le chunk cité est **PRÉSENT** dans le bundle servi et que le rapport `keepalive` est arrivé — **la page a été fermée**, les requêtes annulées rejettent le même `TypeError: Failed to fetch` qu'une panne. Bruit, gravité 4. Geste dans `report-client-error.ts` : ignorer les erreurs de transport quand la page se cache, et sur le canal anonyme ne remonter que les erreurs qui ne sont pas de transport |
| **14/09** | **T9** · **T14** | [TRK-053](./REFERENCE-ERREURS.md#trk-053) — les trois « Retour LLD » | ☐ **OUVERTES — le fait a changé** | — | 🔴 **Les trois véhicules déclarés ont été RENOMMÉS le 13/09 entre 11:34 et 11:37 UTC** — `FR-629-AD → HM-733-GA`, `FW-298-WV → HM-769-GA`, `FZ-731-YF → HM-779-GA` (plaques neuves, série HM 2026), *une heure et demie après le rapport d'hier* — **et la déclaration « boîtier débranché / Retour LLD » a survécu à l'édition**. Ce sont des véhicules neufs, en service (1 208 et 592 positions depuis le 11/09 ; HM-769-GA vivant sans fix depuis 57 h), **sans aucune alerte**. `alertes_depuis_declaration` = 7, **9ᵉ point**. Lever les trois déclarations ; question produit : modifier la plaque d'un véhicule déclaré hors service devrait proposer de lever la déclaration |
| **14/09** *(VPS)* | **V28** | VPS-016 — le client Docker bloqué | ☐ **OUVERT — 20 h 47** | — | 🔴🔴 PID **159541** et son parent **159533** vivants (`etimes = 74 823 s`), `dockerd` à **101 % d'un cœur** mesuré sur 5 s dans `/proc/913/stat`, charge 1,35 / 1,49 / 1,53 sur deux cœurs. **Rien n'a changé depuis hier, sinon seize heures de plus.** `kill 159533 && sleep 1 && kill 159541`, puis `pgrep -x docker` vide |
| **14/09** | **T6** · **T34** · **T36** · **T37** · **T38** · **T45** | Les relevés du jour | — | — | **T6** : 4 remises après 20:25, **100 % `SUPER_ADMIN`** (1 `SUPPRESSED` pour `tyger.bcn`), `PUSH_ROLLOUT=SUPER_ADMIN_ONLY` lu dans le conteneur — un point. **T34** : une seule pause, l'essai ; ⚠️ la porte a classé un **délai** de 30 s sur `claude auth status` comme « hors abonnement » (20:50 → 22:50, passage du rattrapage perdu) — corrigé sur le poste par `8f1a6c3e`. **T36** : 7 passages depuis 16:56, **0 `^C`** — un point sur sept. **T37** : 0 trajet sans récit du 09 au 12/09, 1/68 le 13/09 à 01:12 (à narrer à 03:15). **T38** : **0 commande moteur** les 12 et 13/09, dernière `SCHEDULER` le 11/09 — l'arrêt est effectif. **T45** : `sms_logs` porte **24 sortants `queued` sans suite** (dernier 11/09 18:49) et **1 seul `delivered`** en 7 j — le relais ne pousse aucun statut, la table Tracky le dit seule |
| **13/09** | **T33** | 🆕 [TRK-077](./REFERENCE-ERREURS.md#trk-077) — rendre `deploy.sh` incontournable | ☐ **OUVERT** *(décision D1 tranchée)* | — | *(tâche neuve, née d'une DÉCISION)* Le propriétaire a répondu à **D1** depuis le poste de commande le **13/09 à 10:48 UTC** : **« Le rendre incontournable »**, avec la consigne *« Ajouter une tâche à faire, prendre le temps de bien le faire pour ne pas créer des bugs ! et blocage »*. Un seul chemin pour recréer les conteneurs, qui porte la garde de T29 **relue juste avant la recréation** et qui **bloque** (sortie non nulle) sauf option forcée tracée. ⚠️ **Avec T29, pas avant** : rendre obligatoire une garde lue au mauvais moment protégerait de tout sauf du cas le plus probable |
| **13/09** *(VPS)* | **V28** | VPS-016 — 5ᵉ occurrence, **client nommé à la seconde** | ☐ **OUVERT** — *complété* | *(voir commit du jour)* | Le `bash -c` parent (159533) est **vivant, PPID 1, `do_wait`** : c'est le cas du 08-20, donc **le parent d'abord** (`kill 159533 && sleep 1 && kill 159541`). Session SSH **39478**, root depuis le poste `82.67.153.51`, ouverte **04:34:00,89 UTC** puis fermée ; `sar` : `%system` 3,5 → 22,3 (04:40) → 33,6 (04:50) et s'y tient ; cumul `dockerd` 241,2 → **249,0 h**. **Les trois routines planifiées sont exclues** (bloquées par le quota, reprises ensemble à 10:06). *L'outil n'est pas nommé (VPS-M01) ; la classe l'est.* 🔑 `dockerd` avait journalisé *« Error decoding log file: invalid character '\x00' »* à **04:33:52**, 8 s avant, sur le premier `docker logs` du même `bash` — voir V29 |
| **13/09** *(VPS)* | **V29** | 🆕 [VPS-041](../vps-audit/REFERENCE-CONSTATS.md) — un seul rotateur pour les journaux de conteneur | ☐ **OUVERT** | *(voir commit du jour)* | *(tâche neuve)* **Deux rotateurs sur les mêmes fichiers** : le pilote `json-file` (10 Mo × 3) **et** `/etc/logrotate.d/docker-containers` (posée le 25/08, `copytruncate`, minuit). `dockerd` garde son offset → chaque rotation perce un trou de NUL **de la taille exacte du fichier tronqué** : `tracky-api json.log.1` = **8 405 652 NUL**, `json.log.2` = **8 405 652 octets** ; même égalité sur `maalem-dev-api`, `maestroo-dev-api`, `tracky-postgres`. **5 fichiers courants à 34–92 % de NUL**, 13 courants à 0 octet (dont `texto-relay`). Geste : `mv` de la stanza hors de `logrotate.d`, **avant** tout `daemon.json` ; 10 s, risque nul ; contrepartie : fenêtre = `max-file 3`. ⚠️ Ce qui n'est PAS prouvé : que les NUL soient la cause *nécessaire* du blocage — ce qui l'est : `docker logs` est faux sur 5 conteneurs, et le mécanisme est le nôtre |
| **13/09** *(VPS)* | **V30** | 🆕 [VPS-042](../vps-audit/REFERENCE-CONSTATS.md) — reconnaître le coffre et ses deux comptes | ☐ **OUVERT** | *(voir commit du jour)* | *(tâche neuve)* `vizyo-vault` (Vaultwarden, **épinglé par empreinte** ✅, `vault.vizyoagency.com`, **memlimit 0**) créé le **09/09 20:56** ; `vaultbk` (22:21) et `conductorbk` (22:41) avec clés `command=` + `restrict` — **les mieux bornées de la machine** ; tirages nocturnes 01:00 / 01:08 / 01:35 UTC depuis **`179.198.198.199`** (4 nuits sur 4) ; **une session `vaultbk` ouverte depuis 3,5 jours**. Aucun catalogue, aucune ligne de couverture de sauvegarde (le §11 ne voit que des bases par image). 🔑 Le collecteur avait crié **« EMPREINTE NON DÉCLARÉE »** ×2 : il ne lisait que `/root` — **VPS-M98, corrigé** (tous les comptes + `useradd`). ❌ Ne rien retirer avant reconnaissance (VPS-002) |
| **13/09** *(VPS)* | **V27** · **V26** · **V1** | Les tâches VPS re-mesurées | ☐ **OUVERTES** | — | **V27 — plus rien à mesurer** : `tracky-demo-refresh.timer` a déclenché **seul** dimanche 04:00:04 (→ 04:04:35, *« Import réussi »*) et `demo_replay_frames` passe de 112 349 à **124 340 lignes** dans la minute : **l'import la régénère**. Ne pas sauvegarder (514 Mo/j, ~15 Go). **V26 — 7ᵉ jour** : 3 dossiers à **221 h PÉRIMÉE** pendant que les vivants portent **8 copies** chacun (3 → 8). **V1 — VPS-038 gravité 1 → 2 sur son seuil** : `positions` **33** le ven 09-11 et **32** le sam 09-12 (journées complètes) ; 3 des 6 revenus le 09-11 après 11 j (`…489431`, `…6763` émettent ; `…6714` s'annonce **sans position** depuis le 09-11 16:19) ; registre 14 → **11**, cumul `> 3 j` 13 → 11. Restent 3 IMEI de la cohorte |
| **13/09** *(VPS)* | *(VPS-M73 · M57)* | Trois passages manqués, et une collision | ⚖️ **CAUSE NEUVE** | — | Les 10 et 11/09 : *« weekly limit · resets Sep 13, 12pm »* en 5 s ; aucune exécution le 12. **Ce n'est pas le poste éteint, c'est le quota** — et à la remise à zéro le planificateur a relancé **les trois routines à la même seconde** (10:06:13–14 UTC) : collision VPS-M57 (2ᵉ), passage à 10 h au lieu de 02 h 20, machine déjà saturée par VPS-016 → **186 s** de collecte, dont **46 % de la machine pour `dockerd`** et 15,7 % pour l'audit. *Cf. T31/T32 côté centre d'alerte : même plafond, même CLI* |
| **13/09** | **T11** | [TRK-068](./REFERENCE-ERREURS.md#trk-068) — borner le `fetch` vers Vizyo Auth | ✅ **FAIT ET PROUVÉ** *(remonté de `[»]`)* | `c80632ba` | 🎯 **EXERCÉE le 12/09 à 00:00:23, et les quatre conditions écrites le 06/09 tombent au mot près** : `http \| ERROR \| Vizyo Auth est injoignable : l'appel POST /v1/auth/refresh n'a pas pu aboutir. La session de l'utilisateur ne peut pas etre verifiee : il va etre deconnecte. Motif technique : aucune reponse en 8 s.`, `statusCode: 503`. **503 et non 500 ; `ERROR` et non `CRITICAL` — et `http CRITICAL` reste à 2, pas de jumelle ; dépendance ET conséquence nommées ; motif technique conservé** (le délai de 8 s, c'est le correctif qui le pose). ⚠️ Un point : l'appel est parti vers 00:00:15, `logrotate.timer` sonne à 00:00:03 sur l'hôte — *trois points ou rien* |
| **13/09** | **T17** | [TRK-065](./REFERENCE-ERREURS.md#trk-065) — guetter la ligne hebdomadaire | ✅ **FAIT ET PROUVÉ** | `68034a1d` | 🎯 **EXERCÉE le 11/09 à 06:30:03** : *« 53 notifications n'ont pas pu être remises cette semaine faute d'appareil abonné, sur **1 compte actif** : tyger.bcn@gmail.com (53) »*, **`comptesTechniquesEcartes: 1`**, `system@tracky.local` **absent**. ⚠️ **53 n'est pas ~21, et il fallait compter avant de conclure** : en base, 21 + 21 la semaine du 28/08→04/09 (d'où le 42), **53 + 53** celle du 04/09→11/09 — le numérateur a été **×2,5 par la tempête `agents-locaux`** du plafond CLI. Sans le correctif la ligne aurait dit **106**. 🔑 *Une consigne qui prévoit un nombre suppose un débit ; quand le débit change, c'est la FORME qui prouve* |
| **13/09** | **T30** | 🆕 [TRK-078](./REFERENCE-ERREURS.md#trk-078) — dédupliquer l'alerte de vitesse sur l'excès, pas sur le `tripId` | ☐ **OUVERT** | — | *(tâche neuve)* 🔴 **11 doublons sur 55 alertes `OVERSPEED` en 14 j (20 %)** — même véhicule, même `payload.startAt` **à la seconde**, deux `tripId`. Le recalcul crée **150 à 190 trajets `recompute` par jour** en supprimant les précédents (`Alert.trip` est `onDelete: SetNull` : 2 alertes orphelines), chaque nouvelle identité est ré-analysée et ré-alerte ; il produit aussi des trajets qui **se chevauchent**. Cas lisible : EP-047-TY 11/09, alerte 10:14, trajet supprimé 10:53, seconde alerte 10:54. *La lecture du 10/09 est rectifiée.* Prérequis naturel de T28, à faire **avant** T4 |
| **13/09** | **T31** · **T32** | 🆕 TRK-069 · TRK-071 — le plafond hebdomadaire de la CLI du poste | ☐ **OUVERTES** | — | *(tâches neuves)* 🔴 **Du 10/09 04:00 au 13/09 12:00 (Paris), la CLI Claude du poste était au plafond** : 36 passages en échec (« You've hit your weekly limit »), 0 succès pour les trois agents qui rédigent, 7 travaux IA morts, **et les deux audits n'ont pas tourné** (centre d'alerte 11–12/09, VPS 10–13/09). Les deux agents sans modèle ont tourné (11/11, 2/2) ; reprise **12 min** après la remise à zéro, 30 récits en 4 min, rien de cassé. **T31** : 25 `CRITICAL` pour une cause → UNE ligne `DEGRADATION` par cause. **T32** : trois canaux, trois plafonds, zéro plan — décision d'exploitation |
| **13/09** | **T14** | [TRK-053](./REFERENCE-ERREURS.md#trk-053) — provoquer ou requalifier | ☐ **OUVERT — À REQUALIFIER** | — | 📏 **L'occasion est venue à moitié** : 3 « Retour LLD » revenus le 11/09, **0 alarme, 0 alerte** ; FW-298-WV vivant sans fix depuis 41,8 h sans une ligne `gps-integrity` (chemins déjà honorés). 🔴 **Les trois roulent avec toutes leurs alertes coupées** — lever la déclaration. Seul exercice possible : débrancher un boîtier déclaré |
| **13/09** | **T3** | [TRK-066](./REFERENCE-ERREURS.md#trk-066) — les questions du coupe-circuit | ☐ **OUVERT — question (d) ajoutée** | — | 📏 **Angle mort du 11/09 05:00** : **12 `RESTORE` sur 26 non confirmés** (10 SMS, 2 TCP) contre 1/26 les autres jours, **0 ligne** — et le silence était juste : **aucun n'était coupé la veille**, 4 ont roulé avant toute confirmation. Creux de connectivité (23–27 boîtiers sur 30, 03:00→08:45), réessai automatique à 09:39. Le jour où ça touche un véhicule *réellement coupé*, c'est le miroir de (c) |
| **13/09** *(VPS)* | **V28** | 🆕 VPS-016 — client Docker bloqué | ☐ **OUVERT** | — | *(tâche neuve)* 🔴🔴 `docker logs --tail 60 texto-relay` (PID 159541, parent `bash -c` 159533 rattaché à init, **sans `timeout`**) bloqué depuis **04:34 UTC**, `dockerd` à **100 % d'un cœur** (charge 1,68). **5ᵉ occurrence.** Pas cet audit (toutes ses commandes bornées). L'audit VPS, qui l'aurait vu à 02:21, n'a pas tourné depuis le 09/09 |
| **10/09** | **T26** | [TRK-075](./REFERENCE-ERREURS.md#trk-075) — remonter la décision d'alerter, borner le rejeu | ✅ **FAIT ET PROUVÉ** *(remonté de `[»]`)* | `dc35f1a3` | ✅ **33,3 h et 32 passages horaires consécutifs sans une seule ligne** `stage=compute`, après *une par passage sans exception* (27 au total). ⚠️ **La seconde moitié — « le vivier sous horizon doit passer de 4 à ~5 » — n'a PAS bougé, et il aurait été FAUX d'en conclure une purge.** Les quatre analyses ont **64, 64, 62 et 61 jours** contre 63, 63, 61 et 60 la veille : **ce sont les MÊMES**, aucune n'a disparu ; et aucune nouvelle n'a franchi la ligne des 60 jours parce qu'**il n'existe aucun candidat entre 54 et 60 jours** (le plus proche est à 53). Le vivier total, lui, grossit comme annoncé : **17 · 20 · 23**. 🔑 **La preuve anti-purge obtenue est PLUS FORTE que celle demandée** : on ne compte pas un total qui monte, on constate que *les mêmes lignes sont toujours là, vieillies d'exactement un jour*. ⚠️ *Une consigne datée qui suppose un DÉBIT CONSTANT sur une grandeur qui arrive EN PAQUETS fabrique un faux verdict dans les deux sens.* 🗓️ À guetter au **17/09**, sans que cela bloque : 4 → ~8 |
| **10/09** | **T16** | [TRK-064](./REFERENCE-ERREURS.md#trk-064) — la sentinelle des alertes de vitesse | ✅ **FAIT ET PROUVÉ** | `8fa14cb4` | **Test daté franchi AVEC UN JOUR D'AVANCE** : il était posé au 10/09 06:30, mais le passage du **09/09 06:30** tournait déjà sous le correctif. (1) La forme neuve est là au mot près — *« **3 véhicules** de « mh cars » annoncent une vitesse que la distance parcourue contredit bien plus souvent que le reste de la flotte : FV-941-LZ (84 % de ses 19 analyses)… La flotte entière est à 52 %, **ce qui est son régime ordinaire** »*, contexte `vehiculesHorsNorme` = 3, et 1 pour « A2R ». (2) 🔑 **LA MOITIÉ DIFFICILE EST FRANCHIE AUSSI : « cdef31 » n'a produit AUCUNE ligne**, alors qu'elle en produisait une la veille (23 analyses sur 82). *La sentinelle sait se taire — ce qu'un correctif qui aurait seulement changé le libellé n'aurait pas su faire.* ⚠️ Double condition dans le **bon sens** : 4 lignes → 3, mais les restantes en disent **plus** |
| **10/09** | **T29** | 🆕 [TRK-077](./REFERENCE-ERREURS.md#trk-077) — relire la garde du déploiement au moment où elle va tuer | ☐ **OUVERT** | — | *(tâche neuve)* 🔴 **Le garde-fou est PRÉSENT, CORRECT, et n'a rien empêché.** Chronologie à la seconde : garde franchie vers **17:43 à juste titre** (rien ne tournait), passage parti à **17:45:00.145**, image construite à **17:46:09**, `CRITICAL` écrite à **17:46:43.678**. Le script lit la table **une seule fois, au §1**, puis construit pendant plusieurs minutes avant de recréer les conteneurs — *or une construction ne tue personne, seule la recréation le fait*. 🔑 **Conséquence contre-intuitive : la garde protège de tout SAUF du cas le plus probable** — le déploiement lancé entre HH:40 et HH:45 la franchit à coup sûr **et** tue le passage à coup sûr. *Forme générale du « vérifier puis agir » : le contrôle doit être adjacent à l'ACTE, pas à la décision.* ⚠️ **Réserve** : `deploy.sh` ne pose aucune étiquette `avant-*`, donc rien ne prouve que ce déploiement soit passé par lui — **les deux lectures mènent au même geste** |
| **10/09** | **T13** | [TRK-016](./REFERENCE-ERREURS.md#trk-016) — le chantier du recalage | ☐ **OUVERT**, mais **le rattrapage est prouvé en marche** | — | **1 150 → 1 583 trajets anciens recalés, soit +433 pour ~360 prédits** — l'écart est du même ordre que le recalage *à la demande* du rejeu. Ni arrêt, ni bond qui obligerait à nommer un autre chemin. 🔴 **Et il a fallu écarter un PIÈGE DE DÉFINITION pour pouvoir l'écrire** : la même requête sur `createdAt` au lieu de `startedAt` rend **11 475 / 1 713**, soit un **dénominateur en hausse de 1 443 en un jour** — impossible sur une fenêtre glissante qui reçoit ~190 trajets/jour. C'est `startedAt` qui rend **+16** au dénominateur, donc c'est la définition de la veille. *Avec l'autre on publiait « +563 », un chiffre faux obtenu en comparant deux fenêtres différentes.* 🔑 **Avant de lire une variation, vérifier que la FENÊTRE n'a pas bougé autant que la mesure.** ⚠️ Le verdict sur T13 reste **suspendu à T28** |
| **10/09** | **T25** · **T5** | TRK-074 · TRK-062 — les deux absences qui durent | ☐ **OUVERTES** | — | **T25, 4ᵉ vérification négative** : « résolution automatique » toujours absente de l'artefact servi, **4 `CRITICAL` ouvertes depuis 76,6 h** alors que leur condition est close depuis le 06/09 20:45. 🔑 **Le contraste s'est durci le même jour** : la sentinelle jumelle a **ouvert ET refermé TROIS** lignes critiques toute seule (03:50, 08:50, 14:50). *Trois nées et closes d'un côté, quatre immobiles depuis cinq jours de l'autre.* — **T5, 7ᵉ vérification d'absence** : `SENT_UNCONFIRMED` toujours hors du `dist`, les 2 commandes à **203,6 h** et **207,0 h**, soit **+24,0 h par jour exactement pour la 5ᵉ fois** |
| **09/09** *(VPS)* | *(VPS-M94)* | 🆕 **Un test écrit d'avance contre un point de référence que la rétention efface avant l'échéance** | ⚖️ **RÈGLE POSÉE** *(constat neuf)* | *(voir commit du jour)* | **Deux tests datés arrivaient à échéance ce matin, et les deux tombent entre leurs branches — pour le 2ᵉ jour consécutif.** VPS-039 exigeait **≥ 38 %** ou **≤ 32 %** : la mesure rend **31,5 %**. Le rapport du 08/09 exigeait `MOVING` **≥ 25 %** ou **~18 %** : la mesure rend **24,3 %**, à **0,7 point** de sa borne. 🔑 **La cause n'est pas dans la machine, elle est dans les tests** : tous deux se réfèrent au **jeudi 09-03**, sur une table dont la rétention vaut **3,95 j** — `min(receivedAt) = 2026-09-05 03:30:02`, **le point de référence a été effacé avant l'échéance**. *Un test daté à J+3 sur une source qui n'en garde que 4 est indécidable par construction.* **Preuve mesurée** : le point du **09-05** valait **18,6 %** hier et **21,7 %** aujourd'hui — **+3,1 points, −9 049 lignes, zéro événement**, exactement ce que **VPS-M93** avait prédit la veille. ✅ **Et la question de fond EST tranchée, sur la table où elle est décidable** : `positions` garde **62 jours** et le collecteur publie déjà la comparaison au même jour de semaine — **×0,94 mardi contre mardi**, à **30 émetteurs contre 30**, dans la bande. *Le cycle hebdomadaire tient ; il n'y a pas de dérive.* ➜ **RÈGLE** : avant d'écrire un test daté, vérifier que la rétention de sa source couvre l'échéance **plus** la profondeur du point de comparaison. Sinon **changer de source, pas de date** |
| **09/09** *(VPS)* | **V14** | [VPS-033](../vps-audit/REFERENCE-CONSTATS.md) · 🆕 VPS-M97 — la mesure `apt` **réussit**, et elle réfute **deux** alarmes | ✅ **MESURE VALIDE** *(3ᵉ succès sur 15)* + 🔧 **collecteur corrigé** | *(voir commit du jour)* | Cache `apt` du **09/09 01:29:35**, soit **0 h** : **75 paquets, dont 0 estampillés sécurité.** 🔑 **Et la première chose que cette réussite a servi à faire est de réfuter deux alarmes.** **(1)** La 2ᵉ source annonçait *« dont 1 de sécurité »* : c'est la ligne **« 1 additional security update can be applied with ESM Apps »**, un abonnement **non souscrit** — donc **pas installable ici**. *Ce défaut n'était pas détectable avant aujourd'hui : les 14 passages précédents affichaient `apt` « NON MESURABLE », il n'y avait rien à confronter.* **🆕 VPS-M97, corrigé** — deux extractions distinctes, jamais additionnées ; banc sur 4 formes de fichier, **7 = 7 sur le cas normal, aucune régression**. **(2)** Le test de **VPS-M74** arrivait à échéance et aurait conclu *« panne établie »* sur `75 → 75` **alors que l'installateur fonctionne** : les 75 viennent tous de `noble-updates` et du dépôt Docker CE, **hors des `Allowed-Origins`** de `50unattended-upgrades` — le réglage **standard** d'Ubuntu. Le journal le prouve : **34 paquets installés le 09-02, 20 le 09-05** dont `openssh-server`. *Un total qui ne bouge pas ne prouve rien — le discriminant était le **journal**, pas le compte* |
| **09/09** *(VPS)* | *(VPS-M91 a · M96 · M95)* | 🔧 **Trois correctifs au collecteur, dont deux rattrapés au banc avant publication** | ✅ **CORRIGÉ** *(collecteur)* | *(voir commit du jour)* | **(a) VPS-M91 (a) — angle mort n° 1 du 08/09, traité.** Le verdict « jamais exécutée » couvre désormais les **25 unités** de `list-timers` et non les seules `*-backup`, **pour un coût NÉGATIF** : **2 appels `systemctl show` au lieu de ~22**. Première mesure : **22 succès, 0 échec, 0 armée-jamais-exécutée, 3 minuteries non démarrées, 0 active sans échéance.** 🔴 **Le banc a arrêté 3 fausses alertes** — `apport-autoreport`, `snapd.snap-repair` et `ua-timer` sont `enabled` **et** `inactive`, donc sans échéance, et c'est normal ; la 1ʳᵉ rédaction les déclarait *« rien ne la déclenchera : VPS-015 »*. *Un contrôle qui crie au loup se fait désactiver en trois jours (VPS-M13).* 🔑 **Et le bloc a produit un fait que rien d'autre ne disait** : `tracky-demo-refresh.service` a tourné le **08/09 à 16 h 14 min 37** pendant que **sa minuterie n'a jamais déclenché** (échéance dimanche 13/09) — un import complet depuis la production, un mardi après-midi, **hors de tout horaire déclaré**. **(b) 🆕 VPS-M96** : le contrôle croisé posé la veille confrontait `positions` (**4,7** lignes/émetteur/h) à `trips` (**0,1**) sur la base de démo et publiait **« 34 émetteurs d'écart »** — un faux, sur la famille de constats la plus lourde de la machine. Le **débit par émetteur** devient le discriminant de **grain** ; au-delà d'un facteur 10, 🔴 → **🟠, jamais VERT**. Banc **7 cas sur le code réel** ; **la divergence RÉELLE du 07/09 rejouée reste 🔴** : aucune régression. **(c) 🆕 VPS-M95** : `/opt` a **perdu 1,5 Go sans perdre un octet** — `/opt/maalem` a dépassé son `timeout` et **la somme a été publiée entière**. Le `17 / 18` était imprimé ; *annoncer le dénominateur ne suffit pas s'il faut le lire pour savoir que le numérateur est faux* |
| **09/09** *(VPS)* | **V26** · **V27** · **V5** | Les trois gestes VPS les plus rentables, re-mesurés | ☐ **OUVERTES** | — | **V26 — 3ᵉ jour où la prédiction du 07/09 se vérifie** : `capcom6`, `vizyo-manager` et `vizyo-texto` à **117 h ⚠️ PÉRIMÉE**, pendant que les dossiers vivants portent **3 copies de 21 h chacun** (2 → 3 : *le mécanisme tourne, c'est mesuré*). **Deux 🟠 faux par jour** côté couverture. **30 s, risque quasi nul.** **V27 — la réponse est quasiment acquise, et elle a changé de nature** : la reconstructibilité de `tracky_demo` n'est plus *documentée*, elle est **mesurée** (`ExecMainExitTimestamp = 08/09 16:14:37`, les 8 tables « recalé le 09-08 16:15 »). ➜ **ne pas la sauvegarder** : ~**14 Go** évités (459 Mo/j × 30 j). Reste **une** question, produit : `demo_replay_frames` (40 Mo) n'existe pas en production — l'import la regénère-t-il ? **V5 — la question a changé** : 147 s pour 90, mais **20 des 23 secondes supplémentaires n'ont acheté ni information ni fiabilité** (12 s sur `/opt/maalem` dont la mesure a **échoué**, 8 s sur une base de démo qui a produit 3 🔴 dont un faux). *Borner ce qu'on **mesure**, plutôt qu'indexer le budget sur la taille du périmètre* |
| **09/09** | **T24** | [TRK-073](./REFERENCE-ERREURS.md#trk-073) — marquer le passage au DÉPART | ✅ **FAIT ET PROUVÉ** | `dae97b03` + `dc35f1a3` | 🎯 **LA CONSIGNE ÉCRITE D'AVANCE EST TOMBÉE AU MOT PRÈS.** Elle exigeait *« 24 lignes, **dont une ou plusieurs MARQUÉES INTERROMPUES** — et si le compte monte à 24 sans qu'aucune ne soit marquée, on a maquillé le carnet »*. **Le 08/09 rend 24 passages sur 24, dont EXACTEMENT 1 `interrupted`** : celui de **05:45:00**, tué en vol par le déploiement de 05:45. **Les deux moitiés sont franchies séparément** — le compte monte à 24, *et* la ligne manquante n'a pas été fabriquée. Série : 05/09 **23** · 06/09 **16** · 07/09 **17** · 08/09 **24**. Déployé **08/09 17:12:05** (migration `20260908053000`). Vérifié sur l'**artefact servi** : `running` **×7**, `interrupted` **×2** dans `dist/trip-analysis/trip-automation.service.js`. 🔴 **L'effet de bord est réel et déjà traité** : depuis `f988c74e`, **une `CRITICAL` suffit à envoyer un e-mail**, donc tout déploiement pendant un passage en enverrait un — `deploy.sh` **refuse désormais de partir** quand une ligne `running` est ouverte (`fd87ca46`), **vérifié présent sur le VPS**, arbre git propre au commit `578038d0`. ⚠️ **`trip_automation_runs` ne garde que 100 lignes** : le 04/09 valait 22 le 06/09 et vaut **19** ce jour — la journée la plus ancienne **s'érode par le bas**, la mise en garde écrite hier vient de servir. ⚠️ **L'audit du 08/09 cherchait `EN_COURS` et le trouvait absent** — le correctif avait livré la même idée sous le nom `running` : *chercher le mot d'une spécification plutôt que le comportement qu'elle décrit fait manquer un correctif présent* |
| **09/09** | **T26** | [TRK-075](./REFERENCE-ERREURS.md#trk-075) — remonter la décision d'alerter, borner le rejeu | `»` **DÉPLOYÉ** *(moitié de la preuve venue)* | `dc35f1a3` | ✅ **Le trajet s'est tu** : dernière ligne le **08/09 15:55:05**, puis **8 passages horaires consécutifs sans aucune** ligne `stage: 'compute'` (tous `done`), après **une par passage sans exception** depuis le 07/09 03:45 — 27 au total. Artefact servi : `PositionsIntrouvables` ×2, `fige-retention` ×5, `fige-sans-positions` ×5, `horizonRetention` ×7. ⚠️ **LA SECONDE MOITIÉ DE LA DOUBLE CONDITION ÉTAIT INVÉRIFIABLE TELLE QU'ÉCRITE, ET ELLE EST REFORMULÉE PLUTÔT QUE DÉCLARÉE SATISFAITE.** « Les candidats tombent de 17 à 14 » suppose que le correctif retire des lignes : il n'en retire **aucune**, il **exclut** les candidats sous l'horizon *à la sélection*. Une lecture voit donc le **vivier**, et le vivier **GROSSIT** : **17 → 20**, dont **3 → 4** sous l'horizon. *C'est la fuite lente annoncée, à la vitesse annoncée : +3 candidats et +1 immortel par jour.* Et le rejeu **n'est pas éteint** — les 8 passages ont analysé **2 à 8 trajets chacun**, 30 analyses portent un `computedAt` postérieur. 🗓️ **Test qui tranche au 10/09** : **24 h pleines** sans une ligne, pendant que le vivier sous horizon passe de **4 à ~5** |
| **09/09** | **T28** | 🆕 [TRK-016](./REFERENCE-ERREURS.md#trk-016) — redéfinir la mesure du recalage | ☐ **OUVERT** | — | *(tâche neuve)* 🔴 **L'instrument a cessé de mesurer ce qu'il mesurait.** La fenêtre 24 h rend **0,0 %** d'échec (186 trajets, 0 sans recalage ; **témoin impossible posé** : longueur minimale **265** caractères, aucune chaîne vide — ce sont de vraies géométries) contre **85,5 %** la veille. **Mais le 07/09 lui-même est passé de 85,5 % à 1,2 % POUR LES MÊMES TRAJETS** : ils ont été recalés **après leur clôture**, par `recalerAnciensTraces` ou par le recalage à la demande du rejeu (`c2afb01f`). *La fenêtre n'a pas bougé — le passé a bougé.* 🔴 **Et `trips` n'a pas d'`updatedAt`** : rien ne distingue « bien fait tout de suite » de « rattrapé la nuit suivante ». **La série de dix points ne se prolonge pas.** Ce qui reste mesurable : **1 150 trajets d'historique déjà recalés sur 10 032**. ⏳ **Preuve attendue au 10/09** : ~**1 510** à 15 par passage — *s'il ne bouge pas, le rattrapage ne tourne pas ; s'il bondit très au-delà, un autre chemin recale en masse et il faut le nommer* |
| **09/09** | **T13** | [TRK-016](./REFERENCE-ERREURS.md#trk-016) — le chantier du recalage | ☐ **OUVERT, et sa prémisse est périmée** | — | **Le « ~88 % d'échec depuis avril » sur lequel ce chantier devait s'ouvrir ne décrit plus rien** : le flux neuf est réparé (0 % sur les trajets clôturés depuis le 08/09). Ce qui reste est **l'historique** — **8 882 trajets** non recalés — et **une mesure cassée**. 👉 **Faire T28 AVANT de rouvrir ou de clore T13** : sur une grandeur que le rattrapage réécrit, aucune conclusion n'est décidable |
| **08/09** *(VPS)* | **V11** | VPS-013 — trois bases de production sans sauvegarde reproductible | ✅ **FAIT ET PROUVÉ** *(remonté de `[»]`)* | *(unités systemd)* | ✅ **Les trois preuves écrites d'avance le 07/09 sont tombées, toutes les trois.** **(1)** `LastTriggerUSec` **renseigné** : `vizyo-manager-backup` **07/09 04:30:56**, `vizyo-texto-backup` **04:40:56**, `capcom6-backup` **04:50:30** — chacun **à la seconde près sur son propre `OnCalendar`**. **(2)** `ExecMainExitTimestamp` **non vide** (04:30:57 · 04:40:57 · 04:50:30), donc le `Result=success` est **adossé à une fin réelle** et non à la valeur par défaut de systemd *(VPS-M87)*. **(3)** **DEUX** copies dans chacun de `/var/backups/{vizyo_manager,vizyo_texto,sms}`, datées 06/09 puis 07/09. 🔑 **LE DISCRIMINANT DE VPS-M81, RETOURNÉ** : le 06/09 les trois démarrages tombaient dans la **même seconde** (06:35:47-48) — un `systemctl start` en rafale, donc un **geste** ; le 07/09 ils tombent à **10 min d'intervalle**. *Trois horloges distinctes qui sonnent chacune à son heure ne sont pas une main qui appuie trois fois.* 🔑 **Et une quatrième preuve, non demandée** : le journal imprime sa rétention et elle **compte** — « 0 supprimée(s), **1** conservée(s) » le 06/09, « **2** conservée(s) » le 07/09. Le second passage a **relu un dossier qu'un passage précédent avait peuplé** : un cycle, pas une exécution. ⚠️ **Aucune unité n'a été relancée à la main** entre les deux passages — le test est resté décidable |
| **08/09** *(VPS)* | **V27** | 🆕 [VPS-040](../vps-audit/REFERENCE-CONSTATS.md) · VPS-M91 — trancher si la base de **démonstration** doit être sauvegardée | ☐ **OUVERT** | — | *(tâche neuve)* Le parc `tracky-demo` a été déployé le **07/09 à 14 h 08** (4 conteneurs) et le collecteur écrit `🔴 AUCUNE SAUVEGARDE → la sauvegarder couterait 433MB par jour`. **Le suivre coûterait ~13 Go** (433 Mo/j × 30 j) **sur un disque à 55 %**, pour copier une base que `demo-refresh.sh` **reconstruit depuis la production** chaque dimanche — source qui est, elle, sauvegardée (✅ à jour, 42 copies). ⏳ **Question restante, produit et non machine** : `demo_replay_frames` (28 Mo, 115 265 lignes) n'existe **pas** en production — l'import les regénère-t-il ? ⚠️ **Ne pas éteindre le 🔴 en allongeant une liste blanche de noms** : ce serait reproduire la cause de VPS-M88. Le verdict doit rester **ORANGE** — *un faux vert sur une sauvegarde est la plus chère des erreurs de ce dispositif* |
| **08/09** *(VPS)* | **V26** | VPS-013 · VPS-M88 — ranger les dossiers de sauvegarde abandonnés | 🔓 **DÉBLOQUÉE** *(reste ouverte)* | — | **Le test de V11 est clos, donc le renommage ne rend plus rien indécidable.** 🔴 **Et le faux orange est désormais MESURÉ, pas prédit** : `capcom6`, `vizyo-manager` et `vizyo-texto` affichent **93 h ⚠️ PÉRIMÉE** pendant que `sms`, `vizyo_manager` et `vizyo_texto` portent chacun **2 copies de 21 h**. Pire, la table de **couverture** dit l'inverse sur les mêmes applications (« en retard (3 j) »), sauf `texto-postgres` que le rapprochement attrape. *Deux des trois sont faux côté couverture ; les trois le sont côté âge.* ⚠️ **Renommer, jamais supprimer**, et **seulement après** avoir constaté les copies fraîches — l'ordre inverse laisse `capcom6` sans aucune sauvegarde si le nouveau mécanisme tombe la même nuit |
| **08/09** *(VPS)* | *(VPS-M90)* | 🆕 Une bande de silence se vide toute seule, et VPS-M78 **recommandait** de la comparer | ✅ **CORRIGÉ** *(collecteur)* | *(voir commit du jour)* | Le vecteur des bandes passe de **`1/0/7/6` à `0/1/1/12`** en une nuit : lu bande à bande, *« six boîtiers déposés de plus »* — **un constat de gravité 1 entièrement fabriqué**. Les six muets depuis le 08-31 avaient simplement franchi leur **7ᵉ jour**. **Le cumul `> 3 j` vaut 13 hier et 13 aujourd'hui.** Correctif : publication des **cumuls**, **zéro requête**. ⚠️ **Le banc a réfuté ma première rédaction avant publication** — j'y écrivais qu'un cumul est insensible au vieillissement ; il ne l'est **que dans un sens** (`> 1 j` 13→14, `> 7 j` 6→12). *Une baisse de cumul est toujours réelle ; une hausse peut n'être que du temps qui passe* |
| **08/09** | **T27** | 🆕 [TRK-076](./REFERENCE-ERREURS.md#trk-076) — la carte survit à une perte de contexte WebGL | `»` **DÉPLOYÉ** | `09d04e2b` | **Corrigé hors session**, par une session parallèle, entre les audits du 07 et du 08. Déploiement **08/09 00:56:59** (`tracky-web`, image de 00:56:15). Vérifié sur l'**artefact servi** : `webglcontextlost` **et** `carteUtilisable` présents dans `/usr/share/nginx/html/chunk-3BYQORV7.js`. 🔑 *MapLibre 5.24 met `this.style` à `null` en gardant l'objet `Map` vivant : **les 19 gardes `if (!this.map) return` passaient toutes** — la garde demandait « la carte existe-t-elle ? » quand la question était « son style existe-t-il encore ? ».* ⏳ **Preuve de production non venue** — 26 min de recul à la collecte ; attendue : 0 ligne `getSource` sur 7 j **et** le bandeau de reprise au prochain cas |
| **08/09** | **T26** | 🆕 [TRK-075](./REFERENCE-ERREURS.md#trk-075) — remonter la décision d'alerter au bon étage, et borner le rejeu par la rétention | ☐ **OUVERT** | — | *(tâche neuve, aucune preuve à ce stade)* 15 lignes en 21 h, **toutes le même trajet** `b644fe50` (61,4 j, 0 position, front de purge à 60,9 j, `POSITIONS_RETENTION_DAYS=60` lu sur le conteneur **servi**). ⏳ **Preuve attendue, en double condition** : plus **aucune** ligne `stage: 'compute'` pour un trajet sous l'horizon, **ET** les candidats au rejeu de **17 → 14**, **sans** que `stats.rejouees` tombe à zéro |
| **08/09** | **T24** | [TRK-073](./REFERENCE-ERREURS.md#trk-073) — marquer le passage au DÉPART | ☐ **OUVERT, et sa preuve s'efface** | — | ⚠️ **Découverte d'outillage à porter à la tâche** : `trip_automation_runs` ne garde que **100 lignes** (`KEEP_RUNS`). Le 03/09 rend **21** passages aujourd'hui contre **23** mesurés le 06/09, et le total de la fenêtre vaut **exactement 100**. 🔑 *Le « 16 sur 24 » du 06/09 sera illisible dans quelques jours — une preuve qui doit être relue plus tard doit être **recopiée** hors d'une table qui s'élague.* Vérifié absent de l'artefact servi (`EN_COURS` : 0) ; 07/09 rend **17 sur 24** |
| **07/09** *(VPS)* | **V11** | VPS-013 — trois bases de production sans sauvegarde reproductible | 🔴 **REQUALIFIÉ** `[x]` → `[»]` | *(unités systemd)* | 🔴 **La preuve annoncée le 06/09 n'en était pas une, et la machine le dit en trois endroits.** `LastTriggerUSec` est **vide** sur `vizyo-manager-backup.timer`, `vizyo-texto-backup.timer` et `capcom6-backup.timer` ; `ExecMainStartTimestamp` et `ExecMainExitTimestamp` le sont aussi sur les trois services ; et le journal date l'unique exécution du **06/09 à 06 h 35 min 47-48, les trois à la même seconde** — un `systemctl start`, donc **un geste, pas un mécanisme** (VPS-M81). **Première échéance autonome : 07/09 à 04 h 34 / 04 h 40 / 04 h 50 UTC, soit 2 h après la collecte.** ⏳ **Preuve attendue au 08/09** : `LastTriggerUSec` renseigné, `ExecMainExitTimestamp` non vide, et **DEUX** copies dans `/var/backups/{vizyo_manager,vizyo_texto,sms}`. ⚠️ **Ne pas relancer à la main d'ici là** — cela rendrait le test indécidable |
| **07/09** *(VPS)* | **V25** | VPS-M59 — `chargeDeFond.note` s'affiche | ✅ **FAIT ET PROUVÉ** | `9dce59ec` | 🔑 **La preuve est venue, et elle est plus forte que celle qui était demandée.** `tracky-web` a été **reconstruit le 07/09 à 01 h 22 min 34**, et les deux chaînes témoins (`fond-note`, « mesure absente du manifeste ») sont **toujours dans l'artefact servi** — désormais `chunk-K6RYKC7I.js`, **un fichier différent** de celui d'hier (`chunk-K4HBXQ56.js`). *Ce n'est donc pas l'ancien artefact resté en place : c'est une construction neuve qui porte le correctif, donc la branche d'où l'on déploie le porte encore.* ⚠️ Prouve que le code est **servi**, pas qu'il s'affiche — barre que la roadmap se donne elle-même |
| **07/09** *(VPS)* | **V14** | VPS-033 — la mesure `apt` | ☐ **recommandation CHANGÉE** | — | **La validité de la mesure s'est jouée à 37 minutes.** Le cache lu ce passage (collecte 02 h 21) est **exactement celui** que le passage du 06/09 (collecte 04 h 05) avait déclaré valide : daté du **06/09 02 h 59 min 53**. *75 → 75 n'est pas une stabilité, c'est **une** mesure publiée deux fois.* `RandomizedDelaySec=30m` **rétrécit** la fenêtre sans la **placer** → le geste devient `OnCalendar=*-*-* 01:30:00` + `RandomizedDelaySec=15m` |
| **07/09** | **V24** | VPS-038 — sentinelle « boîtiers muets » | ✅ **FAIT ET PROUVÉ** | `fb0642f8` | 🔑 **La preuve attendue est tombée au mot près.** Passage du 06/09 à **06:30:01** : **exactement 2 lignes, pas 10** — `2ad69ac1` (cdef31, **8 boîtiers**, 17,8 → 5,7 j) et `88627f81` (A2R, **2 boîtiers**, `KSR•370` 23,2 j, `GLA•KC•31` 3,2 j, `deposesSansVehicule: 3`). Le regroupement par société tient |
| **07/09** | **T10** | TRK-070 — le niveau de l'escalade suit la CAUSE | `»` **DÉPLOYÉ** | `2112e9ae` | Déploiement **07/09 00:58:58**. Vérifié sur l'**artefact servi** : `causeTechnique` **×5** dans `dist/assistance/assistance.service.js`, et l'ancienne règle `urgent \|\| gravite === 'CRITICAL' ? …` **a disparu**. ⏳ **Preuve de production non venue** — aucun échec IA depuis le 05/09 17:00 |
| **07/09** | **T11** | TRK-068 — borner le `fetch` vers Vizyo Auth | `»` **DÉPLOYÉ** | `c80632ba` | Déploiement **07/09 00:58:58**. Vérifié sur l'**artefact servi** : `AbortSignal` et `ServiceUnavailableException` présents dans `dist/auth-client/auth-client.service.js`, `Vizyo Auth` nommé **6 fois**. ⏳ **Preuve de production non venue** — aucun rejet de transport depuis le 04/09 12:57 |
| **07/09** | **T2** | TRK-069 — rallumer le poste | ✅ **FAIT** | *(aucun — geste matériel)* | Le poste a repris **seul** le 06/09 à 06:08. 🔑 **Et c'est du même coup la preuve de l'auto-archivage annoncé par TRK-069** : les 4 lignes se sont archivées d'elles-mêmes (« Agent repassé … résolution automatique »), et une 5ᵉ — `agent-limites-vitesse` — est née à 18:50 et s'est refermée à 20:50. **Zéro geste humain** |
| **06/09** | **V11** | VPS-013 — trois bases de production sans sauvegarde reproductible | ✅ **FAIT ET PROUVÉ** | *(unités systemd)* | 3 unités dérivées du gabarit `vizyo-auth-backup`, exercées une fois chacune → **3 succès**. 🔑 **Confrontées à la base VIVANTE** : `vizyo_manager` **8 tables = 8** `CREATE TABLE` · `vizyo_texto` **47 lignes `allowlist_entries` = 47** · `sms` 9 tables. Archives **600**, dossiers **700**. Minuteries **actives** (04:30 / 04:40 / 04:50 UTC, `Persistent=true`). Elles portent déjà `ExecStart=/bin/bash` — le geste de **V13** |
| **06/09** | **T11** | TRK-068 — un appel à Vizyo Auth ne peut plus durer, ni remonter nu | `~` **COMMITÉ** | `c80632ba` | auth-client **16/16**, typecheck **3/3**, smoke-boot **5/5**. 🔑 **Deux mutations** — retrait du délai → **1 échec**, remontée nue du rejet → **4 échecs**. Le jumeau `verifyLoginCode` passe par le même chemin borné. ⏳ **Preuve attendue** : `statusCode 503`, niveau `ERROR`, motif technique **conservé** en fin de phrase |
| **06/09** | **T10** | TRK-070 — le niveau de l'escalade suit la CAUSE, pas la gravité de la conversation | `~` **COMMITÉ** | `2112e9ae` | Suite assistance **74/74**, typecheck **3/3**, smoke-boot DI **5/5**. 🔑 **Mutation de la règle de niveau → 1 échec exactement** : le test n'est pas tautologique. Les **trois** replis techniques traités ensemble *(leçon de TRK-004)*. ⏳ **Preuve attendue en production** : UNE seule ligne `ASSISTANCE`, en `DEGRADATION`, **et** le journal système garde son `assistance_escalade` |
| **06/09** | **V0** | Verser `docs/vps-audit/` sur `main` — 20 jours d'audit n'y existaient pas | ✅ **FAIT** | *(checkout de chemin, avec historique)* | Arborescences vérifiées identiques ; 29 rapports, 125 fiches, 631 Ko sur `main` |
| **06/09** | *(VPS-038)* | Sentinelle « boîtiers muets » | `[»]` **DÉPLOYÉE** | `fb0642f8` | 48 tests verts, mutation du seuil → 1 échec exactement ; smoke-boot OK ; `restarts=0`, `healthy`. ⏳ **Preuve attendue** : 2 lignes à la passe de 06:30 UTC, **pas 10** |
| **06/09** | *(VPS-M59)* | `chargeDeFond.note` s'affiche + repli explicite | `[»]` **DÉPLOYÉ** | `9dce59ec` | Sur l'**artefact servi** : `fond-note` 0 → 1, « mesure absente du manifeste » 0 → 1, **témoin impossible 0** ; `ng build` NG_EXIT=0 |

### Ce que le prochain passage doit faire de ce journal

1. **Relire le [tableau de bord](#-tableau-de-bord--55-tâches-lavancement-dun-coup-dœil) AVANT la
   collecte** — c'est là que vit la passation, et c'est précisément ce que les passages des 05 et
   06/09 n'ont pas fait, au prix d'un chapitre entier réécrit pour rien *(VPS-M81)*.
2. **Vérifier les `[»]` ci-dessus.** Ils passent `[x]` **le jour où la mesure tombe**, pas avant —
   et si elle ne tombe pas, le dire.
   ~~🔴 **Au 07/09, le plus urgent est V11** — `LastTriggerUSec`, `ExecMainExitTimestamp`, deux
   copies~~ → ✅ **LES TROIS SONT TOMBÉES LE 08/09.** V11 est **FAIT ET PROUVÉ**, et les unités
   n'ont **pas** été relancées à la main : le test est resté décidable.
   ~~**V25**, dont la preuve relève de la routine VPS~~ → **prouvé le 07/09**. Restent les deux
   déployés le matin du 07/09 :
   **T10** *(UNE seule ligne `ASSISTANCE`, en `DEGRADATION`, et le journal système garde son
   `assistance_escalade` — si les deux tombent, on a supprimé la trace)* et **T11** *(`503` et non
   `500`, niveau `ERROR` et non `CRITICAL`, motif technique **conservé** en fin de phrase)*.
   ⚠️ **Les deux attendent une OCCASION qui ne vient pas** : aucun échec IA depuis le 05/09 17:00,
   aucun rejet de transport depuis le 04/09 12:57. *Un correctif déployé qu'aucun événement
   n'exerce reste un correctif non prouvé — le dire vaut mieux que l'oublier.*
4. ~~🆕 **Relever la série de `trip_automation_runs`**~~ → ✅ **T24 EST CLOSE le 09/09.** Série
   complète : 02/09 **15** · 03/09 **23** · 04/09 **22** · 05/09 **23** · 06/09 **16** · 07/09 **17**
   · **08/09 24 sur 24, dont 1 `interrupted`**. ⚠️ **Cette série est désormais à recopier ici et
   nulle part ailleurs** : `trip_automation_runs` ne garde que **100 lignes**, et le 04/09 est déjà
   passé de 22 à **19 par le bas**. *Une preuve qui doit être relue plus tard doit vivre hors d'une
   table qui s'élague.*

6. 🆕 **Au 09/09, trois tests sont écrits d'avance pour le 10/09 :**
   - 🔬 **T26** — **24 h pleines sans une seule ligne** `stage: 'compute'` pour un trajet sous
     l'horizon, **pendant que** le vivier sous horizon passe de **4 à ~5**. *Si les lignes
     reviennent, le gel ne tient pas ; si le vivier sous horizon cesse de croître, on a purgé au lieu
     de borner.*
   - 🔬 **T28 / T13** — les trajets d'historique déjà recalés doivent passer de **1 150** à **~1 510**
     (15 par passage × 24 passages). *Immobile = le rattrapage ne tourne pas ; très au-delà = un
     autre chemin recale en masse, et il faut le nommer avant d'en tirer quoi que ce soit.*
   - 🔬 **La sentinelle « vitesse contredite » change de forme** (`8fa14cb4`, en ligne depuis 17:12) :
     au passage de **06:30**, le message doit désigner **les véhicules qui sortent du lot** (≥ 5
     analyses touchées **et** ≥ 50 % des leurs) et porter `vehiculesHorsNorme` au contexte — et non
     plus des flottes entières. ⚠️ **Il doit rester possible qu'elle se taise** : une flotte sans
     véhicule hors norme ne doit produire **aucune** ligne. *Un instrument qui ne peut plus rien dire
     rend le même silence qu'un instrument qui n'a rien à dire — c'est la leçon du témoin désarmé.*
5. 🆕 **Au 08/09 après la routine VPS, deux tests sont écrits d'avance pour le 09/09 :**
   - 🔬 **Le taux `MOVING` du mardi 09-08** doit rendre **≥ 25 %** si la reprise d'activité est en
     cours. La série des journées **complètes** fait ven 09-04 *(tronquée)* · sam **18,6 %** · dim
     **13,9 %** · lun **18,8 %**. *Le test du 07/09 prévoyait deux issues — « remonte vers 28 % » ou
     « reste sous 15 % » — et **la mesure est tombée entre les deux**. Ne pas choisir la branche qui
     arrange : un **lundi ouvré qui roule au niveau d'un samedi** reste à expliquer.* **Si le mardi
     rend encore ~18 %, deux jours ouvrés consécutifs sous le niveau du jeudi ne sont plus un effet
     de calendrier**, et la question passe côté produit.
     ⚠️ **Et lire la série avec VPS-M93** : son jour le plus ancien est **érodé par la rétention de
     3,95 j** et dérive de plusieurs points d'un passage à l'autre — le 09-04 est passé de 25,3 % à
     29,5 % **sans que rien n'arrive**, parce que ses 3 h 30 de nuit ont été purgées.
   - 🔬 **`tracky-demo-refresh.timer` n'a jamais tourné** (première échéance **dimanche 09-13**), et
     elle affiche pourtant `Result=success` — **VPS-M91**. *Ce n'est pas un défaut aujourd'hui ;
     c'est le rappel que le même affichage rendra la même chose le jour où une unité qui **devait**
     tourner ne tournera pas.*
3. **Cocher ce qui a été fait entre-temps**, même par un humain hors session : une tâche close qui
   reste `☐` fait rouvrir un chantier déjà terminé.

# Contrôle des correctifs déployés — consignes pour l'audit du 2026-08-25

> **À lire APRÈS `PROCEDURE-AUDIT.md` et AVANT la collecte.** Ce document ne remplace pas la
> procédure : il ajoute, pour ce passage précis, la vérification de **sept correctifs déployés
> en production le 24/08**. Cinq d'entre eux ont une **condition de faux succès** — une mesure
> qui semble prouver que ça marche alors qu'elle prouve autre chose.
>
> 🔑 **La question de ce passage n'est pas « le centre d'alerte est-il vide ? » mais « ce qu'on
> a déployé hier fait-il ce qu'on croit ? ».** Un correctif qui a l'air de marcher et ne marche
> pas coûte plus cher que pas de correctif du tout : il ferme le dossier.

---

## 0. La règle qui prime sur tout le reste, ce passage-ci

**Vérifier chaque correctif contre l'ARTEFACT SERVI, jamais contre la fiche ni le commit.**

En deux jours, **cinq statuts de fiches annonçaient l'inverse de la réalité** — dont deux qui
disaient « non déployé » pour du code en ligne depuis une semaine, et un qui disait « sonde
écrite, non déployée » alors qu'elle tournait depuis deux jours. Chacun a coûté une enquête
rouverte pour rien.

```bash
# Le seul contrôle qui fasse foi : le marqueur DANS le conteneur.
ssh root@72.62.26.240 'timeout 15 docker exec tracky-api grep -c "<marqueur>" /app/apps/api/dist/<chemin>.js'
```

⚠️ **Si une fiche et l'artefact se contredisent, l'artefact a raison — et la fiche doit être
corrigée dans le même passage.** *Un statut périmé fait rouvrir une enquête close.*

---

## 1. TRK-045 — cadence des boîtiers (déployé 06:37 et 07:39)

**Ce qui a été fait** : le firmware lit deux chiffres et jette l'unité (`05m` → 5 s). L'encodeur
n'émet plus que des secondes sur deux chiffres et **lève** au-delà de 99 s ; `HARD_CAP_S` passe
de 300 à 99 ; les quatre options « minutes » du catalogue sont retirées. Un **second** correctif
force une commande de récupération vers les boîtiers bloqués.

**À mesurer :**

```sql
-- Débit de la flotte, par heure. C'EST LE CHIFFRE QUI TRANCHE.
SELECT date_trunc('hour',"createdAt") AS heure, count(*) AS trames
FROM wire_logs WHERE direction='IN' AND "createdAt" > now() - interval '12 hours'
GROUP BY 1 ORDER BY 1;

-- Formes réellement émises : il ne doit plus JAMAIS y avoir de suffixe `m`.
SELECT substring(raw from ',C,[^;]*') AS forme, count(*) AS n
FROM wire_logs WHERE direction='OUT' AND raw LIKE '%,C,%'
  AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY n DESC;
```

| Attendu | Valeur |
|---|---|
| Débit | **≤ 5 000 trames/h** (référence d'avant l'incident : 6 826/h ; mesuré à 00:19 : ~4 400) |
| Formes émises | **uniquement** `,C,NNs;` — **zéro** `,C,NNm;` |
| Boîtiers à `currentFixIntervalS <= 6` | **0 ou 1** |

> 🔴 **PIÈGE — ne PAS juger au compteur `trackersFailing`.** Il dépend de **l'heure de la
> mesure** : `reconcile` exonère un boîtier qui émet vite **en mouvement**. À 01 h la flotte est
> à l'arrêt, donc tout émetteur rapide compte ; en journée le même parc donnerait un chiffre
> plus bas **sans que rien n'ait changé**. Le débit, lui, est stable par nature.

> 🔴 **Si le débit est remonté au-dessus de 6 800/h**, chercher d'abord une trame `,C,NNm;`
> dans les sortants : cela voudrait dire qu'un chemin d'émission a échappé au correctif.

---

## 2. TRK-015 — positions écartées par le garde-fou (déployé 11:53)

**Ce qui a été fait** : avant de rejeter une trame antérieure, on cherche une position à
l'horodatage **exact**. Jumeau → fantôme, on écarte comme avant. Aucun jumeau → on **persiste**
la ligne `positions` sans toucher à la baseline. Nouvelle décision `RECOVERED_BUFFER`.

```sql
SELECT decision, count(*) AS n FROM position_sampling_decisions
WHERE "receivedAt" > now() - interval '24 hours'
  AND decision IN ('SKIPPED_REPLAY','RECOVERED_BUFFER') GROUP BY 1;
```

> 🔴 **PIÈGE — LA DOUBLE CONDITION, et c'est la plus importante de ce document.**
> `RECOVERED_BUFFER` doit être **> 0** (on récupère) **ET** `SKIPPED_REPLAY` doit rester
> **> 0** (on écarte encore les vrais fantômes).
>
> **Si les DEUX tombent à zéro, le garde-fou a été supprimé et non réparé** — et la
> téléportation reviendra : distances négatives, polylignes triangulaires, saut en direct.
> Mesuré à 00:19 : 7 récupérées / 8 écartées sur 3 h. Les deux vivent.

> ⚠️ **Ne pas conclure d'un chiffre bas que le correctif est inutile.** Depuis que TRK-045 est
> corrigé, les boîtiers émettent 4 fois moins, donc rejouent 4 fois moins. La valeur de ce
> correctif est dans les **rafales** de coupure réseau (1 643 trames d'un bloc le 08/08, 15,7 km
> perdus d'un seul trajet), pas dans le flux quotidien.

---

## 3. TRK-018 — fin de vie des commandes moteur (déployé 15:08, AVEC MIGRATION)

**Ce qui a été fait** : statut neuf `SENT_UNCONFIRMED`, échéance **purement temporelle**
(30 min), balayage toutes les 10 min. Colonne `channel` (`TCP`/`SMS`) qui sort le routage du
champ `lastError`.

```sql
SELECT status, count(*) AS n,
       count(*) FILTER (WHERE "ackedAt" IS NOT NULL) AS acquittees
FROM engine_control_commands GROUP BY 1 ORDER BY n DESC;

-- Le contrôle qui compte : les coupures continuent-elles d'être DEMANDÉES ?
SELECT date_trunc('day',"createdAt") AS jour, action, count(*) AS n
FROM engine_control_commands WHERE "createdAt" > now() - interval '4 days'
GROUP BY 1,2 ORDER BY 1 DESC, 2;
```

| Attendu | Valeur |
|---|---|
| `SENT` restantes | **0**, ou quelques-unes de moins de 30 min |
| `SENT_UNCONFIRMED` | **≥ 314**, croissant lentement |
| Commandes avec `ackedAt` parmi elles | **0** — le témoin doit rester intact |

> 🔴 **PIÈGE — LA SECONDE DOUBLE CONDITION.** Le nombre de `SENT` doit tomber à zéro **SANS que
> le nombre de coupures DEMANDÉES ait baissé**. *Si les deux tombent ensemble, on a supprimé la
> fonctionnalité, pas le défaut.* Comparer le volume quotidien de `CUT`/`RESTORE` aux jours
> précédents.

> 🔴 **Vérifier qu'aucune commande n'a reçu `ackedAt` d'office.** Marquer ces lignes acquittées
> ferait disparaître la question. *Le témoin n'est pas le défaut.*

---

## 4. TRK-026 — accusé de remise SMS ⚠️ LE SEUL MAILLON NON PROUVÉ

**Ce qui a été fait** : trois webhooks abonnés côté capcom6 (`sms:sent`, `sms:delivered`,
`sms:failed` — c'est une **configuration**, pas du code), et Tracky va lire l'état auprès de la
passerelle avant de conclure.

**État au 24/08 23:40 : la chaîne est prouvée sur 3 maillons sur 4.** Le quatrième — *qu'un
webhook ABONNÉ soit un webhook REÇU* — n'a pas pu l'être : **aucun SMS sortant depuis 08:20**.
Les coupes de 18:00 UTC sont toutes passées en TCP, sans repli.

```sql
-- Côté Tracky
SELECT status, count(*) FROM sms_logs WHERE direction='OUT'
  AND "createdAt" > timestamp '2026-08-24 08:20:00' GROUP BY 1;
```
```bash
# Côté passerelle — base DIFFÉRENTE (vizyo_texto sur texto-postgres)
ssh root@72.62.26.240 'timeout 60 docker exec -i texto-postgres psql -U texto -d vizyo_texto -X -A -F "|" -q \
  -c "SELECT status, count(*) FROM messages WHERE direction=(chr(79)||chr(85)||chr(84)) GROUP BY 1"'
```

| Si… | Alors |
|---|---|
| Un SMS est parti ET porte `sent`/`delivered` | ✅ **la chaîne est prouvée de bout en bout** — l'écrire, c'est le résultat attendu depuis le 03/06 |
| Un SMS est parti et reste `queued` | 🔴 **le webhook est abonné mais ne parvient pas** — vérifier côté capcom6 AVANT de soupçonner le code |
| Aucun SMS n'est parti | ⚪ **non concluant** — ne rien conclure, reporter au prochain passage |

> ⚠️ **`queued` sur 0 message envoyé n'est pas un échec du correctif.** Ne pas rouvrir la fiche
> sur une absence de matière.

---

## 5. TRK-025 — suppressions de masse retenues (déployé 12:41)

**Ce qui a été fait** : la réconciliation lit `GET /v1/allowlist/audit` chez la passerelle et
remonte au centre d'alerte les blocages des **24 dernières heures**, en nommant l'appelant.

> ⚠️ **NE PAS ATTENDRE D'ALERTE.** Le tiers a cessé le **17/08 19:24** — plus aucune tentative
> depuis. Une absence de ligne `sms-allowlist` est le comportement **correct**, pas un échec.
>
> Le câblage a été prouvé autrement le 24/08 : depuis le conteneur `tracky-api`, la lecture du
> journal rend **HTTP 200** et trouve 8 blocages, tous **hors** de la fenêtre de 24 h. Refaire
> ce contrôle suffit :

```bash
ssh root@72.62.26.240 'timeout 60 docker exec tracky-api node -e "
(async () => {
  const r = await fetch(process.env.VIZYO_TEXTO_URL + \"/v1/allowlist/audit?limit=200\", {
    headers: { Authorization: \"Bearer \" + process.env.VIZYO_TEXTO_API_KEY } });
  const j = await r.json();
  const b = Array.isArray(j) ? j.filter(x => x.outcome === \"removals_blocked\") : [];
  console.log(\"HTTP\", r.status, \"| blocages:\", b.length, \"| dernier:\", b[0] && b[0].createdAt);
})();"'
```

**Si un blocage NEUF apparaît (postérieur au 17/08)** : c'est un fait grave — le tiers est
revenu. Le signaler en tête de rapport, avec l'adresse appelante.

---

## 6. TRK-035 — journalisation des connexions ⚠️ PIÈGE D'OUTILLAGE

**Ce qui a été fait le 25/08 à 00:0x** : `log_connections = on` et un préfixe portant
utilisateur, base et **adresse du client**. Sans redémarrage.

```bash
# ⚠️ LIRE LE FICHIER, PAS `docker logs` — voir le piège ci-dessous.
ssh root@72.62.26.240 'LP=$(timeout 15 docker inspect tracky-postgres --format "{{.LogPath}}"); \
  grep -oE "tracky@tracky_prod [0-9.]+|tracky@tracky_prod \[local\]" "$LP" | awk "{print \$2}" | sort | uniq -c | sort -rn'
```

| Origine attendue | Lecture |
|---|---|
| `172.23.0.3` | le conteneur API — trafic normal |
| `[local]` | un shell **DANS** le conteneur (sonde de santé, sessions d'administration) |
| **toute autre adresse** | 🔴 **un tiers — à instruire immédiatement** |

> 🔴 **PIÈGE PAYÉ LE 25/08 : `docker logs tracky-postgres` a rendu du VIDE** alors que le fichier
> contenait les lignes. Le référentiel VPS documente déjà que cette commande est peu fiable sur
> cet hôte. **Sans lire le fichier directement, on conclurait que le réglage est inerte et on le
> « re-corrigerait ».**

**Surveiller le volume** : mesuré à ~1,4 Mo/jour (deux lignes par connexion, sonde toutes les
30 s). Sur une rotation de 30 Mo → ~21 jours. Si le journal sature nettement plus vite,
le signaler : quelque chose ouvre des connexions en excès.

---

## 7. Retrait de l'onglet « Commandes » de la fiche véhicule

La console d'envoi vit désormais **uniquement** sur `/admin/trackers/:id`. Rien à mesurer en
base ; si un utilisateur signale une disparition, la réponse est : *c'est volontaire, la console
est dans l'espace d'administration.*

---

## 8. Régressions à écarter — ce qui a été touché hier

Sept déploiements en une journée, dont **un avec migration**. À contrôler :

```sql
-- Aucune commande de cadence ne doit rester bloquée
SELECT count(*) FROM tracker_commands WHERE status IN ('PENDING','SENT')
  AND "createdAt" < now() - interval '1 hour';

-- L'ingestion tourne-t-elle normalement ?
SELECT date_trunc('hour',"createdAt") AS h, count(*) FROM positions
WHERE "createdAt" > now() - interval '6 hours' GROUP BY 1 ORDER BY 1;
```

| Point | Attendu |
|---|---|
| `tracky-api` | `healthy`, **`restarts=0`** — un `restarts` > 0 signalerait une boucle de démarrage |
| Migration `20260824150000_trk018…` | présente dans `_prisma_migrations`, `rolled_back_at` **NULL** |
| Positions écrites | continues, ~1 000–1 500/h |
| Écart `ins − del − live` sur `error_logs` | **13 250**, inchangé (6ᵉ point attendu) |
| `n_tup_del` sur `error_logs` | **3 785**, inchangé |

> ⚠️ **Chaque redémarrage de l'API déconnecte TOUS les utilisateurs** (constaté 5 fois le 24/08 :
> `localStorage` perd jeton *et* refresh). Ce n'est pas une régression d'hier, c'est un défaut
> préexistant **non instruit** — à ne pas confondre avec un effet des correctifs.

---

## 9. Sources d'erreur NEUVES à instruire — apparues le 24/08

Mesuré à 00:19 UTC, 15 lignes actives :

| Source | Lignes | Statut |
|---|---|---|
| `trip-analysis` | 11 | connu — Overpass injoignable ([TRK-037](./REFERENCE-ERREURS.md#trk-037)), **laissé actif sur décision du propriétaire** |
| `schedule-cron` | **2** | 🆕 **à instruire** |
| `TRIP_AUTOMATION` | **1** | 🆕 **à instruire** |
| `sms-heartbeat` | 1 | connu — [TRK-026](./REFERENCE-ERREURS.md#trk-026), verdict `INDETERMINE` honnête |

> 🔴 **Les deux sources neuves sont la priorité d'enquête de ce passage**, après les contrôles
> ci-dessus. `schedule-cron` et `TRIP_AUTOMATION` ont été touchés par la campagne du 23/08
> (TRK-029, TRK-043) : vérifier d'abord si ces lignes sont **postérieures** aux correctifs — si
> oui, c'est le correctif qui est en cause, et c'est prioritaire sur tout le reste.

---

## 10. Décisions du propriétaire à respecter

- **Les 11 lignes `trip-analysis` (Overpass) restent ACTIVES.** Décision explicite du 24/08 :
  dépendance tierce, aucun correctif poussé, *archiver ferait baisser un compteur sans rien
  corriger.* **Ne pas les archiver.**
- **Une seule ligne a été archivée le 24/08** : `GPS_QUALITE` / KSR370 du 22/08, par
  `admin@vizyoagency.com`, avec motif — antérieure au correctif TRK-039, boîtier mort depuis le
  14/08. C'est une action **terrain**, pas logicielle.
- **Ne jamais supprimer de ligne `error_logs`.** Archiver ≠ supprimer ; l'archivage est
  réversible et laisse la ligne en base.

---

## 11. Ce qui reste ouvert, et ne doit pas être re-découvert comme neuf

| Fiche | État | Ce qui manque |
|---|---|---|
| [TRK-018](./REFERENCE-ERREURS.md#trk-018) | 🟠 correctifs 1-3 livrés | l'écran « immobilisations non confirmées » (correctif nº 4) |
| [TRK-035](./REFERENCE-ERREURS.md#trk-035) | 🟠 incident clos, sonde active | la **séparation réelle des rôles** — chantier avec fenêtre de maintenance ; ⚠️ **impossible par `REVOKE`**, `tracky` est superutilisateur ET propriétaire |
| Statuts de fiches | 🔴 motif récurrent | **5 statuts périmés en 2 jours** — un statut dérivé de l'artefact servi réglerait ça |
| Déconnexion au redéploiement | 🔴 non instruit | chaque redémarrage vide `localStorage` de tous les utilisateurs |

---

## 12. Rappels de sécurité — inchangés, et non négociables

- 🔴 **Tout client Docker borné DEUX fois** : `timeout 20 docker … --tail 2000`. Jamais plus de
  2 000. Vérifier en sortie : `pgrep -x docker`.
- ⚠️ **Un build Docker rend ce VPS injoignable en SSH pendant plusieurs minutes** (constaté le
  24/08 : charge 2,93 sur 2 cœurs, `sshd` ne peut plus forker). Ce n'est pas une panne — attendre
  et réessayer. **Ne pas conclure à un bannissement fail2ban** : le TCP passe, c'est la poignée
  de main qui n'aboutit pas.
- **Aucune écriture en base** hors archivage explicite. Le SQL de collecte est en lecture seule.
- **Committer par chemin explicite** : `git add docs/centre-alerte`, jamais `-A`. Le dépôt est
  partagé — `.gitignore` et `TACHES-AMELIORATION.md` portent du travail d'une autre session,
  **ne pas les toucher**.

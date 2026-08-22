# État du reste-à-faire — 2026-08-22 (au soir)

> Synthèse issue de l'audit « tâches restantes + fraîcheur de la documentation » du
> 22/08/2026, mené sur `main` (`1d859286`, PR #104). **Chaque item est tracé** vers un
> fichier:ligne ou un commit ; rien n'est inventé. Les numéros de ligne renvoient à
> l'état des fichiers à cette date (après pose des bandeaux du même jour).
>
> Contexte d'ensemble, vérifié : la refonte v2 est **fusionnée dans `main` depuis le
> 2026-08-16** (via `essai/centralisation`, `d8bd237d`/`e884e1ba`) et déployée ; la
> production court sur `main` du 22/08 au matin. **Les commits de l'après-midi du 22/08
> ne sont pas déployés** — dont les correctifs UI `1a0e6f2b` (bandeaux illisibles de
> `/admin/background-tasks`) et `d44feeef` (littéraux hors famille verte) : la prod
> affiche encore les bandeaux vert-sur-vert. Ne pas déployer sans décision du
> propriétaire.

---

## 1. Vérifications dues — datées, rien ne les remplace

| Échéance | Quoi | Source |
|---|---|---|
| **23/08 après 07:10** | **V4 — chaîne analyse-lieux de bout en bout, sur des faits** : travail dans `travaux_ia_locaux` après 03:10, livré par le courrier après 06:30, rangé après 07:10 avec `costEur = 0` et `executor = local`, résumé qui parle des vrais passages — puis l'écran `/places` à **375 px**. Ne pas conclure avant le cycle. Requêtes prêtes. | `ROADMAP-AGENTS-LOCAUX.md` registre V4 ; `design/C2-ACTIVATION-ANALYSE-LIEUX.md` § 4 geste 3 |
| Dès que possible (terrain) | **V3 — deux boîtiers vivants SANS position GPS** : `GS-014-NY` (IMEI 864035054756169) et `HD-686-QX` — antenne débranchée, mal placée ou HS. Accès physique requis. | registre V3 |
| Dès que possible (terrain) | **Antennes intermittentes** : `FZ-862-VY` et `FS-253-HR` (épisodes qui se rouvrent), plus `KSR370` (bruit de vitesse jusqu'à 256 km/h annoncés). Le contrôle terrain reste à faire. | `docs/centre-alerte/REFERENCE-ERREURS.md:1271` ; registre § KSR370 |
| Suivi continu | **Convergence du recalcul des trajets** : vérifier que les tranches « 7-30 j » (854) et « 30-50 j » (1 190) baissent ; 4 845 trajets sans analyse au 19/08 (2 158 → 1 339 trajets bruts au 20/08 — ça converge). | `ROADMAP-AGENTS-LOCAUX.md:74-76`, `:710-712` |
| Au prochain déploiement | **Migration `20260820180000_passages_agents_locaux`** : marquée « à déployer » le 20/08 ; les déploiements des 21-22/08 l'ont probablement embarquée — **à confirmer** sur `/admin/background-tasks` (le traitement `agent-qualite-gps` ne doit plus afficher « inconnu »). | `ROADMAP-AGENTS-LOCAUX.md:228`, `:713-716` |

## 2. Décisions du propriétaire en attente

### Produit / accès

1. **D1 — rôle DEPOT et assistance.** Écarté par allowlist default-deny alors que la
   consigne était « tous les utilisateurs connectés ». Un décorateur suffit à rouvrir.
   → confirmer l'écart ou l'inverser. — registre D1 ; `apps/api/src/assistance/assistance.controller.ts:31-35`
2. **D2 — rôle NIGHT_WATCHMAN et assistance.** Même situation (allowlist « aucune donnée
   pour ce rôle » posée à la demande du client, non élargie). — registre D2
3. **D4 — traces de l'assistance** : lots du demandeur réduits à leur résumé (pas de
   rejeu à l'identique, pas de seconde copie de données personnelles). Confirmer ou
   inverser. — registre D4

### Données / ingestion / boîtiers

4. **Vitesses physiquement impossibles acceptées à l'ingestion** (`valid = true` jusqu'à
   255,7 km/h sur KSR370) : rejeter, ou marquer `valid = false`, au-delà d'un seuil par
   type de véhicule ? Chemin le plus critique de l'app — prudence. — `ROADMAP-AGENTS-LOCAUX.md:532-550`
5. **Commandes tracker : honorer `availableVia`.** `dispatch()` envoie tout en TCP alors
   que 19 gabarits (dont les 3 du capteur de choc) sont déclarés `['sms']` — c'est
   pourquoi aucune alerte ACCIDENT/COLLISION n'a jamais existé. Chantier : router par
   SMS + réconcilier le statut `queued` (défaut d'observabilité, pas de livraison).
   — `ROADMAP-AGENTS-LOCAUX.md:552-620`
6. **Cadence TCP : valider la trame `**,imei:<IMEI>,C,05m;` sur UN boîtier** avant de
   généraliser (obtenir enfin les 300 s → batterie + forfait 2G, 36 boîtiers). Test non
   destructif décrit. — `docs/centre-alerte/REFERENCE-ERREURS.md:2504-2515`
7. **API muette si base injoignable au démarrage** (`$connect()` dans `onModuleInit` +
   `bufferLogs: true` = aucun journal, port fermé) : délai maximum avec message
   explicite, ou vidage du tampon avant l'init des modules ? — registre, `ROADMAP-AGENTS-LOCAUX.md:505-514`

### Sécurité / infra VPS

8. **Rotation de la clé de la passerelle SMS** partagée avec une instance de dev
   joignable d'Internet, puis tenant propre pour le dev. Fenêtre de coupure réelle
   (redémarrage conteneur) à placer hors des minutes d'automatisation moteur.
   — `docs/centre-alerte/REFERENCE-ERREURS.md:3785` ; `docs/centre-alerte/ROADMAP-CORRECTIFS.md:759-781`
9. **Le déploiement recrée `.env.prod.bak-*` avec la clé dedans** à chaque passage : le
   geste durable est qu'il cesse d'en produire. (Même motif ailleurs dans `/root` — hors
   périmètre Tracky, vaut un passage de l'audit VPS.) — `docs/centre-alerte/ROADMAP-CORRECTIFS.md:740-748`
10. **Retirer `DELETE`/`TRUNCATE` au rôle applicatif** (l'autre moitié de TRK-035 — le
    témoin constate, il n'empêche pas). Attention : le cron supprime légitimement
    170 000 `wire_logs`/nuit et tomberait avec — il faut un rôle dédié ou une exception.
    — `docs/centre-alerte/REFERENCE-ERREURS.md:59-61`
11. **Backup automatique + staging : jamais mis en place** (« TODO ultérieur » d'avril,
    jamais repris). À confirmer par l'audit VPS et à trancher. — `docs/DEPLOYMENT-VPS.md.md:905-931` ; `docs/EXECUTION-TRACKER.md:35`

### Permissions

12. **Enforcement backend des permissions UI-only** (8 permissions posées côté écran
    seulement ; `privacy_view_private_trips` explicitement signalée « indispensable ») et
    **`groups_manage` défini mais jamais lu**. Questions posées en avril, sans trace de
    décision (vérifié le 22/08 : aucun `privacy_view_private_trips` côté `apps/api/src`).
    — `PERMISSIONS_AUDIT.md` § 8 (Q1, Q7) ; `TEST_PLAN.md` § findings V1.12

### UI / design (refonte v2 — restes identifiés, jamais tranchés)

13. **`/vehicles` en liste groupée par groupe avec en-têtes** — décision de comportement
    non tranchée. — `SUIVI-REFONTE.md:1534` ; `REPRISE-B-PAGES.md:305`
14. **Étiquettes de plaque masquées sur téléphone** (choix de la planche) — à trancher. — `REPRISE-B-PAGES.md:228`
15. **Poignée `.bs-handle-wrap` de la feuille basse** — à trancher au niveau du kit. — `REPRISE-B-PAGES.md:408`
16. **Zoom MapLibre : cible de 29 px** — à revoir en recette sur le VPS. — `SUIVI-REFONTE.md:1083`
17. **Trois décisions sur `/admin/ai-usage`** (ratio de marge, compteurs de résultat,
    O5), volontairement laissées de côté. — `REPRISE-B-PAGES.md:606-624`
18. **O5 — `--text-tertiary` sous 4,5:1 dans LES DEUX thèmes** : trois options chiffrées
    (assombrir le jeton / créer `--texte-discret` / reprendre page par page). Tant que ce
    n'est pas tranché, la mesure au navigateur est le seul juge — `verif:contraste` ne
    peut pas voir ce défaut, par construction. — `design/TOKENS.md` § O5
19. **`verif:couleurs-kit` échoue sur un `#000` préexistant** — le viseur caméra
    (`apps/web/src/app/shared/ui/scanner-code/scanner-code.component.ts:139`). **Défendable** :
    un viseur de caméra est noir quel que soit le thème. **Proposition soumise au
    propriétaire** : ajouter dans `scripts/verif-couleurs-kit.mjs` une liste d'exceptions
    documentées (fichier:ligne + justification d'une phrase) plutôt que changer la
    couleur. Rien n'a été modifié en attendant. — sortie de `node scripts/verif-couleurs-kit.mjs` du 22/08
20. **`update-required-modal` + `push-prompt` + `trip-note-modal`** : « trois usages, un
    seul squelette », reporté à B-pages puis sans trace de réalisation — unifier ou y
    renoncer explicitement. — `REFONTE-TRACKY-V2.md:1208`

### Chantiers ouverts à prioriser (ou à geler explicitement)

21. **Maestroo** : décisions D9-D15 du résolveur de conflits (« rien n'est implémenté »),
    plus les 5 points que l'analyse ne tranche pas. — `docs/25-integration-maestroo-sync-conflits.md` § 7 ; `docs/22-integration-maestroo.md:628-638`
22. **Vizyo Verify** : chantier à démarrer (5 incréments côté Tracky), webhook de retour
    côté Verify encore un TODO non écrit. — `docs/26-integration-vizyo-verify.md:36-37`, `:111-209`
23. **Chantier commercial + RGPD (`docs/TACHES.md`)** : 1.3 ⏸️, **4.2 rétention par
    flotte** ⏸️ (bloquée par la décision D2 commerciale), 4.5 🔶 registre du temps de
    travail — 4 questions posées au propriétaire, 5.3 ⏸️. — `docs/TACHES.md:27,52,100,109,117` ; `docs/rgpd-registre-temps-travail.md:45-48`
24. **Offre de lancement : fin affichée `2026-09-30`** — à proroger ou laisser expirer
    (et régénérer les supports commerciaux datés de juillet avant tout usage).
    — `docs/INVENTAIRE_PRODUIT_2026-07-08.md:588` ; `docs/REFERENCE_COMMERCIALE.md`
25. **Dette auth httpOnly** (JWT en `localStorage`, plan de migration écrit) et
    **partitionnement de `positions`** (plan écrit, non exécuté) : faire, planifier ou
    abandonner. — `docs/19-tech-debt-auth-httponly.md:64-67` ; `docs/20-position-partitioning-plan.md:55-59`
26. **CI absente** (aucun workflow GitHub ; déploiement manuel) — assumé jusqu'ici, à
    confirmer comme choix durable. — `docs/14-tests-runbook.md:200` ; `docs/VERIFIER-AVANT-DE-DEPLOYER.md:92`

## 3. Recette manuelle humaine — de vrais clics, de vrais yeux

- **`RECETTE-A-FAIRE.md` en entier** (sections A → H : cas spécial véhicule, effets
  différés, notifications GPS réservées super-admin). Vérifié le 22/08 : ses points
  **correspondent toujours aux écrans actuels** (carte « Cas spécial · super-admin »,
  options Accidenté / Boîtier débranché / Immobilisé — `apps/web/src/app/features/vehicles/vehicle-detail.component.ts:441-467` ;
  `GPS_LOST` réservé super-admin — `apps/api/src/notifications/notification-dispatch.service.ts:235`).
  Tout a déjà été exercé par script en production ; **ce qui manque est le vrai clic**.
- **L'écran du mode veilleur n'a JAMAIS été mesuré** (bloqué à l'époque par le panneau
  navigateur — le client l'a lui-même réclamé en recette le 16/08) et **`/driver` n'a
  jamais été vu**. À 375 px, sur données réelles.
  — `SUIVI-REFONTE.md:630-637`, `:258-259`, `:957-959`, `:1607`
- **`/places` à 375 px** après le cycle V4 du 23/08. — `design/C2-ACTIVATION-ANALYSE-LIEUX.md` § 4
- Reliquat Maestroo : **démo visuelle de bout en bout** des 3 écrans, **T9 sur une vraie
  base**, et la vérification visuelle **au premier allumage**. — `docs/23-integration-maestroo-phase0-spec.md:1010,1012` ; `docs/24-integration-maestroo-deploiement.md:198`
- **Mise en service WhereverSIM** (migration, token, sync initial, test E2E) : aucune
  trace qu'elle ait été faite — à confirmer, sinon à faire. — `docs/21-sim-management-whereversim.md:89-96`

## 4. Chantiers techniques restants (côté agents locaux)

Dans l'ordre du catalogue de `ROADMAP-AGENTS-LOCAUX.md` :

- **Point 2 — retirer le bouton « Recalculer » de `/reports`** : ⏸ EN ATTENTE
  **volontaire** tant que la convergence du point 1 n'est pas prouvée (tranche 30-50 j
  vidée). Contrôle navigateur 375 px obligatoire à la fin. — `ROADMAP-AGENTS-LOCAUX.md:78-86`
- **Agent triage des propositions d'agenda** (priorité 4) : 1 328 propositions en
  attente qu'aucun humain ne triera. — `:327-334`
- **Agent rapport d'activité** (priorité 5) : sans objet tant que
  `activity_report_schedule.enabled = false` (plus aucun rapport depuis le 12/08 —
  réglage constaté « sans décision tracée », à confirmer). — `:336-344`, `:520-530`
- **Agent coaching conducteur** : ⏸ bloqué tant que le ratio d'analyses sans limite de
  vitesse connue (64 % au 19/08) n'est pas descendu sous ~20 %. — `:346-353`
- **Retrofit des agents limites-de-vitesse et récit sur `passages_agents_locaux`** —
  deux façons de répondre à « tourne-t-il ? » finiront par diverger. — `:231-232`
- **Petit correctif proposé, jamais appliqué** : classer `transient` le timeout de l'API
  publique des prix carburants (il archive du bruit). — `docs/centre-alerte/REFERENCE-ERREURS.md:1797-1805`
- **Garde-fou « contact »** pour les zones bénignes muettes : exige de persister l'ACC
  des trames `no_fix`, qui ne l'est pas. Non planifié. — `docs/centre-alerte/REFERENCE-ERREURS.md:4421-4424`
- **Classe « retour arrière ≤ 60 s »** (273 trames) : à instruire séparément au prochain
  passage — mécanisme possiblement différent. — `docs/centre-alerte/REFERENCE-ERREURS.md:3251-3256`

## 5. Dette technique assumée / surveillée

- **`pnpm lint` API cassé** — vérifié le 22/08 : `eslint` n'est pas installé dans
  `apps/api` (« 'eslint' n'est pas reconnu »). Connu depuis la refonte
  (`SUIVI-REFONTE.md:725`). Réparer ou retirer le script.
- **Trois budgets CSS dépassés au build production** (constat du 14/08, non re-mesuré
  depuis). — `SUIVI-REFONTE.md:733`
- **O4 — couleurs de couche de carte en dur, volontairement** (MapLibre ne résout pas
  les variables CSS ; le fond de carte est un choix utilisateur séparé du thème). Reste :
  une dizaine de valeurs dans `map.component.ts` à reprendre. — `design/TOKENS.md` § O4
- **Les cinq gardes bloquants passent au 22/08** (`accents`, `litteraux`, `variables`,
  `contraste` — 168 couples, `confirmations`) ; seul `verif:couleurs-kit` (non bloquant)
  est rouge, sur le viseur caméra (cf. décision n° 19).
- **`narrateEnabled` reste à `false` et le restera** (l'agent local produit les récits) ;
  8 973/10 070 analyses sans récit au 20/08 — attendu, le rattrapage est nocturne.
  — `ROADMAP-AGENTS-LOCAUX.md:724-726`
- **Limite assumée de l'agent qualité GPS** : corrélation PAR SOCIÉTÉ uniquement. — `:717-719`
- **La base de connaissances de l'assistance est un engagement d'entretien** — à mettre
  à jour à chaque fonctionnalité livrée, comme une doc d'API publique. — `:312-314`

## 6. Docs à trancher (propriétaire)

- **`docs/DEPLOYMENT-VPS.md.md`** : double extension (artefact). Proposition : renommer
  en `docs/INSTALLATION-VPS-INITIALE.md` (c'est un guide d'installation initiale, pas un
  doublon de `DEPLOYMENT-VPS.md` — 3 lignes communes sur ~1 140). **Pas renommé sans
  accord** ; bandeau posé en attendant.
- **`ROADMAP-AGENTS-LOCAUX.md`** s'annonce « à supprimer quand tout est livré » — pas
  encore : D1/D2/D4, V3/V4 et quatre agents restent ouverts.
- **`docs/09-roadmap-v2.md`** § 3-4 : backlog basse priorité d'avril + « décisions à
  prendre » jamais reprises — réévaluer ou clore.
- **`docs/03-protocol-coban-gps403d.md:898`** « TODO Wireshark » : couvert de fait par
  `wire_logs` (601 914 trames sur 4 jours analysées le 20/08) — à clore formellement.
- Les instantanés commerciaux (`INVENTAIRE_PRODUIT_2026-07-08.md`,
  `REFERENCE_COMMERCIALE.md`) sont datés — à régénérer avant usage client.

---

## Annexe — classement des marqueurs « à faire / TODO / en attente » des `.md`

Balayage du 22/08 (`grep -E 'A FAIRE|À FAIRE|TODO|EN ATTENTE|reste à'`, hors
`node_modules`). Les occurrences dans les **rapports datés** (`docs/centre-alerte/rapports/`,
`docs/vps-audit/rapports/`) sont des constats de journal, pas des tâches vivantes — ce
qui en reste vit dans `REFERENCE-ERREURS.md` et est repris ci-dessus. Beaucoup de
« reste à N » sont des **valeurs mesurées** (« le compteur reste à 0 »), pas des tâches.

| Marqueur | Classement |
|---|---|
| `design/C2-ACTIVATION-ANALYSE-LIEUX.md:86` (les trois gestes) | gestes 1-2 **faits le 22/08** ; geste 3 **dû le 23/08** (V4) |
| `design/A1-ROLE-DEPOT.md:85` | descriptif (« le veilleur reste à zéro ») — pas une tâche |
| `ROADMAP-AGENTS-LOCAUX.md:78` (bouton Recalculer) | **encore dû**, bloqué volontairement (§ 4) |
| `ROADMAP-AGENTS-LOCAUX.md:321` (à intégrer au direct) | **fait le 19/08** — écrans `6a83ec61`, notification `ac171fae` (table d'avancement corrigée ce jour) |
| `ROADMAP-AGENTS-LOCAUX.md:701` (`narrateEnabled`) | décision actée — pas une tâche |
| `SUIVI-REFONTE.md:517`, `:808` | prose de journal — pas des tâches |
| `SUIVI-REFONTE.md:1607` (écran veilleur à mesurer) | **encore dû** (§ 3) |
| `REFONTE-TRACKY-V2.md:1208` (3 modales, un squelette) | **à trancher** (§ 2 n° 20) |
| `REFONTE-TRACKY-V2.md:1647` | ligne de journal — pas une tâche |
| `docs/03-protocol-coban-gps403d.md:898` (TODO Wireshark) | **obsolète de fait** — couvert par `wire_logs` (§ 6) |
| `docs/07-sms-gateway.md:278` (SOS SMS → Alert) | **obsolète** — plan Twilio abandonné ; le mapping SOS TCP existe (`apps/api/src/alerts/alert-mapping.ts:19`) |
| `docs/14-tests-runbook.md:48,119,158,221` (TODO V1.6) | **faits autrement** — la suite compte ~2 500 tests ; les seuils/flows V1.6 n'ont jamais été repris tels quels |
| `docs/14-tests-runbook.md:200` (CI) | **encore dû si voulu** — décision n° 26 |
| `docs/23-…phase0-spec.md:1010,1012` | **encore dûs** — démo visuelle + T9 vraie base (§ 3) |
| `docs/24-…deploiement.md:198` | **encore dû**, conditionné au premier allumage Maestroo (§ 3) |
| `docs/26-integration-vizyo-verify.md:36-37` | **encore dû** — chantier à démarrer (§ 2 n° 22) |
| `docs/DEPLOYMENT-VPS.md.md:905,931` (backup/staging) | **encore dû / à confirmer** (§ 2 n° 11) |
| `docs/EXECUTION-TRACKER.md:35,47,237` | **obsolètes** — fichier figé au 15/04, bandeau posé |
| `docs/TACHES.md:94` (couche dynamique 3.1-3.4) | **fait** — 3.1-3.4 sont cochées ✅ dans le même fichier ; la parenthèse date d'avant |
| `docs/sprint-4/ANALYSE.md:18,54` · `docs/sprint-8/PLAN.md:19` | historiques / prose — pas des tâches |
| `docs/centre-alerte/REFERENCE-ERREURS.md:60` | **encore dû** — décision n° 10 |
| `REFERENCE-ERREURS.md:1271` | **encore dû** — terrain (§ 1) |
| `REFERENCE-ERREURS.md:1797` | **encore dû** — petit correctif `transient` (§ 4) |
| `REFERENCE-ERREURS.md:2509` | **encore dû** — test cadence sur un boîtier (§ 2 n° 6) |
| `REFERENCE-ERREURS.md:3251`, `:3320` | **encore dû** — classe « retour arrière ≤ 60 s » (§ 4) |
| `REFERENCE-ERREURS.md:3785` | **encore dû** — rotation de la clé SMS (§ 2 n° 8) |
| `REFERENCE-ERREURS.md:4423` | **encore dû** — garde-fou « contact » (§ 4) |
| `REFERENCE-ERREURS.md:2352,2388,3880,5067` | valeurs mesurées — pas des tâches |
| `docs/centre-alerte/ROADMAP-CORRECTIFS.md:740` | **encore dû** — le déploiement cesse de produire des `.bak` (§ 2 n° 9) |
| `docs/centre-alerte/rapports/*` (12 lignes) | constats de journaux datés — repris via `REFERENCE-ERREURS.md` |
| `docs/vps-audit/rapports/*` (6 lignes) | constats de journaux datés — le suivi vivant est côté audit VPS |

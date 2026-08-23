# Décisions à trancher — tableau de bord

> Créé le 2026-08-23 à partir de `ETAT-RESTE-A-FAIRE-2026-08-22.md` (qui garde le détail et les sources).
> **Mode d'emploi en 3 étapes :**
> 1. Remplis chaque ligne **Réponse** (A / B / plus tard).
> 2. Chaque décision marquée ⚡ se lance **dans un chat séparé** avec le modèle de prompt en bas de page.
> 3. À la fin, une session de **réunion** (dernier chapitre) vérifie tout, met à jour le registre et prépare le déploiement.

**Légende** : ⚡ = déclenche un chantier de code · ✍️ = une réponse suffit, je l'inscris au registre · 🟢 = ma recommandation.

---

## Produit / accès

### 1 · Assistance IA — rôle DEPOT ⚡
L'assistance est fermée au rôle DEPOT alors que la consigne disait « tous les utilisateurs connectés ». Un décorateur suffit à ouvrir.
**A.** Ouvrir · **B.** Confirmer la fermeture
**Réponse :**

### 2 · Assistance IA — rôle NIGHT_WATCHMAN ⚡
Même situation, mais le confinement vient d'une demande du client (« aucune donnée pour ce rôle »).
**A.** Ouvrir · **B.** Confirmer la fermeture 🟢
**Réponse :**

### 3 · Traces de l'assistance ✍️
On n'archive que le résumé des données du demandeur : pas de rejeu à l'identique, pas de seconde copie de données personnelles.
**A.** Confirmer 🟢 · **B.** Inverser (recopier les lots)
**Réponse :**

## Données / boîtiers

### 4 · Vitesses impossibles à l'ingestion ⚡
Des positions à 255 km/h sur un scooter entrent avec `valid = true` et polluent scores et alertes.
**A.** Marquer `valid = false` au-delà d'un seuil par type de véhicule 🟢 · **B.** Rejeter · **C.** Laisser
**Réponse :**

### 5 · Commandes tracker — honorer `availableVia` ⚡
19 gabarits déclarés « SMS » (dont le capteur de choc) partent en TCP et n'ont jamais fonctionné — d'où zéro alerte ACCIDENT depuis toujours.
**A.** Chantier : router par SMS + réconcilier le statut `queued` 🟢 · **B.** Plus tard
**Réponse :**

### 6 · Cadence TCP 300 s ⚡
Une trame candidate obtiendrait enfin les 5 min de cadence (batterie + forfait 2G, 36 boîtiers). Test non destructif décrit, sur UN boîtier d'abord.
**A.** Tester sur un boîtier 🟢 · **B.** Plus tard
**Réponse :**

### 7 · API muette si base injoignable au démarrage ⚡
Si la base ne répond pas au boot : aucun journal, port fermé, rien à diagnostiquer.
**A.** Corriger (délai borné + message explicite) 🟢 · **B.** Laisser
**Réponse :**

## Sécurité / VPS

### 8 · Rotation de la clé de la passerelle SMS ⚡
La clé est partagée avec une instance de dev joignable d'Internet. La rotation impose une courte coupure, à placer hors des minutes d'automatisation moteur.
**A.** Faire (avec fenêtre planifiée) 🟢 · **B.** Plus tard
**Réponse :**

### 9 · Sauvegardes `.env.prod.bak-*` avec la clé dedans ⚡
Chaque déploiement recrée un fichier de sauvegarde contenant les secrets.
**A.** Faire cesser 🟢 · **B.** Laisser
**Réponse :**

### 10 · Retirer DELETE/TRUNCATE au rôle applicatif ⚡
L'autre moitié de TRK-035 : le témoin constate les disparitions, il ne les empêche pas. Attention : les purges légitimes (170 000 lignes/nuit) exigent un rôle dédié.
**A.** Chantier rôle dédié + retrait 🟢 · **B.** Plus tard
**Réponse :**

### 11 · Backup automatique + staging ⚡
Jamais mis en place depuis avril. **Ma recommandation la plus forte de la liste.**
**A.** Faire en priorité 🟢 · **B.** Plus tard
**Réponse :**

## Permissions

### 12 · Enforcement backend des permissions UI-only ⚡
8 permissions ne sont vérifiées qu'à l'écran (dont `privacy_view_private_trips`, « indispensable » côté serveur) ; `groups_manage` n'est jamais lu.
**A.** Chantier enforcement 🟢 · **B.** Plus tard
**Réponse :**

## UI / design (restes de la refonte)

### 13 · `/vehicles` groupé par groupes ⚡
Liste avec en-têtes de groupe — comportement jamais tranché.
**A.** Faire · **B.** Garder la liste plate
**Réponse :**

### 14 · Plaques masquées sur téléphone ✍️
Choix de la planche actuelle : l'étiquette de plaque disparaît sur petit écran.
**A.** Garder · **B.** Réafficher
**Réponse :**

### 15 · Poignée de la feuille basse ✍️→⚡
`.bs-handle-wrap` à trancher au niveau du kit (affordance de glissement).
**A.** Garder telle quelle · **B.** Reprendre au kit
**Réponse :**

### 16 · Cible de zoom MapLibre 29 px 🫵
À juger pendant **ta recette en cours** : si le zoom se touche mal du pouce, dis-le, on l'agrandit.
**Réponse :**

### 17 · `/admin/ai-usage` — trois restes ✍️
Ratio de marge, compteurs de résultat, O5 — volontairement laissés de côté à la refonte.
**A.** Geler explicitement · **B.** Trancher maintenant (détail en réunion)
**Réponse :**

### 18 · O5 — `--text-tertiary` sous 4,5:1 partout ⚡
Le gris tertiaire est illisible dans les deux thèmes et `verif:contraste` ne peut pas le voir, par construction.
**A.** Créer `--texte-discret` (motif éprouvé de la famille `--texte-*`) 🟢 · **B.** Assombrir le jeton · **C.** Page par page
**Réponse :**

### 19 · Le `#000` du viseur caméra ⚡ (petit)
`verif:couleurs-kit` est rouge à cause du viseur — or un viseur est noir dans les deux thèmes.
**A.** Liste d'exceptions documentées dans le garde (fichier:ligne + justification) 🟢 · **B.** Changer la couleur
**Réponse :**

### 20 · Unifier les trois modales ⚡
`update-required-modal` / `push-prompt` / `trip-note-modal` : « trois usages, un squelette », promis puis oublié.
**A.** Unifier · **B.** Y renoncer explicitement 🟢 (les trois marchent)
**Réponse :**

## Chantiers à prioriser ou geler

### 21 · Maestroo — résolveur de conflits ✍️
Décisions D9–D15 : rien d'implémenté. C'est un chantier d'intégration complet.
**A.** Prioriser (planifier) · **B.** Geler explicitement
**Réponse :**

### 22 · Vizyo Verify ✍️
5 incréments côté Tracky, webhook côté Verify encore à écrire.
**A.** Démarrer · **B.** Geler
**Réponse :**

### 23 · Commercial + RGPD (`docs/TACHES.md`) ✍️
1.3, 4.2 (rétention par flotte, bloquée par une décision commerciale), 4.5 (registre du temps de travail — 4 questions posées), 5.3.
**A.** Réveiller (lesquels ?) · **B.** Laisser en pause
**Réponse :**

### 24 · Offre de lancement (fin 2026-09-30) ✍️
À proroger ou laisser expirer — et supports commerciaux de juillet à régénérer avant usage.
**A.** Proroger (nouvelle date ?) · **B.** Laisser expirer
**Réponse :**

### 25 · Dette auth httpOnly + partitionnement `positions` ⚡
Deux plans écrits, jamais exécutés (JWT en localStorage ; table positions qui grossit).
**A.** Planifier les deux · **B.** L'un des deux (lequel ?) · **C.** Abandonner explicitement
**Réponse :**

### 26 · CI GitHub ⚡
Aucun workflow : typecheck, tests et gardes ne tournent que si quelqu'un y pense.
**A.** CI minimale (typecheck + tests + cinq gardes sur chaque push) 🟢 · **B.** Rester en manuel, choix assumé
**Réponse :**

---

## Modèle de prompt pour lancer UN chantier dans un chat séparé

```
Dans le dépôt vizyo-tracky, worktree D:\www\vizyo-agency\vizyo-tracky\wt-allowlist
(ou un worktree isolé) — git fetch + rebase sur origin/main d'abord, d'autres
sessions poussent sur ce dépôt.

Applique la décision n° <N> du fichier DECISIONS-A-TRANCHER-2026-08-23.md :
« <titre> » — décision du propriétaire : <A/B/C + précisions>.
Le contexte détaillé et les sources sont dans ETAT-RESTE-A-FAIRE-2026-08-22.md § 2 (même n°).

Règles du chantier : NE DÉPLOIE PAS. Ne modifie aucun DTO/contrat d'API sans demander.
Aucun backtick dans un commentaire de template:/styles:. Les cinq gardes bloquants
(npm run verif:accents / litteraux / variables / contraste / confirmations) doivent
passer. Tout écran touché se vérifie DANS LE NAVIGATEUR à 375 px (session locale :
voir apps/web/e2e/helpers/session-locale.ts). N'écris jamais de fausses données,
n'efface rien sans regarder. À la fin : git fetch + rebase, committe et pousse,
et consigne le résultat dans DECISIONS-A-TRANCHER-2026-08-23.md (statut sur la
ligne Réponse) + le registre de ROADMAP-AGENTS-LOCAUX.md si pertinent.
```

## La réunion finale (dernier chat)

Quand les chantiers lancés sont poussés : une session relit ce fichier, vérifie chaque
décision appliquée (code + gardes + écrans), met à jour le registre et
`ETAT-RESTE-A-FAIRE`, puis prépare la liste de déploiement — **le déploiement lui-même
reste un geste du propriétaire**.

## Déjà cadré (hors décisions)

- **Geste 3** — vérifier la chaîne analyse-lieux : après le cycle du 23/08 (07:10).
- **Déploiement** : après les modifs, sur ton ordre.
- **Boîtiers `GS-014-NY` / `HD-686-QX`** sans position : peut-être simplement en parking couvert — à vérifier, pas urgent.
- **Recette manuelle** (`RECETTE-A-FAIRE.md` + mode veilleur + `/driver` + `/places` à 375 px) : en cours par le propriétaire.

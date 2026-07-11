# Comptes conducteurs + déverrouillage autorisé + refonte planning — Spec

> Branche : `feat/comptes-conducteurs`. Feature « tout d'un bloc » décidée avec le user le 2026-07-11.
> Origine : la LP promet « le conducteur s'identifie et déverrouille sa voiture s'il est autorisé » — absent du code aujourd'hui (pas de rôle DRIVER, pas de PIN, pas d'identification physique).
> ⚠️ Sensible (coupe-circuit moteur) : PAS de déploiement prod sans analyse + review + OK explicite du user.

## 0. Décisions validées (par le user)

| Sujet | Décision |
|---|---|
| Identification physique « qui prend quelle voiture » | **QR par véhicule + smartphone du conducteur** (0 matériel, marche iPhone PWA). RFID au boîtier = option matérielle future (le protocole Coban expose déjà `<rfid>`). |
| Pouvoir du conducteur | **Déverrouiller (RESTORE)** + **activer le mode vie privée** — chacun activable/désactivable par le fleet-admin. Pas de coupe (CUT) pour le conducteur. |
| Anti-abus | **Contrôle de proximité** : déverrouillage refusé si le téléphone n'est pas près de la dernière position GPS du véhicule. |
| Planning × action manuelle | Une action manuelle **ne désactive plus** le mode horaire : elle le **suspend jusqu'à la prochaine bascule** (puis reprise auto). **Symétrique** CUT/RESTORE. Seul le toggle explicite (fiche véhicule / horaires flotte) désactive vraiment. Filet anti-vol : case optionnelle « immobilisation durable ». |
| Ordre de build | **Tout d'un bloc** sur cette branche. |

## 1. État de l'existant (cartographié dans le code)

- `Driver` (`schema.prisma:720`) : entité métier, `userId String? @unique` **déjà prévu** avec le commentaire *« Phase 3 : promouvoir un driver en compte User rôle DRIVER »*. Attribution via `Vehicle.currentDriverId` + `Trip.driverId`/`driverSource` (AUTO/MANUAL).
- Coupe/déverrouillage : endpoint déjà `@Roles(...NIGHT_WATCHMAN) + @RequireVehiclePermission('engine_control', {paramName:'trackerId'})` (`engine-control.controller.ts:33`). RESTORE toujours permis, CUT à l'arrêt.
- Invitations : `invitations.service.ts` crée compte Vizyo Auth + User + `UserVehicleAccess` (scopes ALL/GROUPE/VÉHICULE) + permissions par case + clamp anti-escalade.
- Rôle restreint précédent : `NIGHT_WATCHMAN` (UI limitée, `watchman.guard.ts`) = patron du rôle conducteur.
- Coban : la trame de position **décode déjà `<rfid>`** (`coban.parser.ts:117,195`) — RFID prêt côté protocole (non persisté).
- Web : **PWA pure, pas de Capacitor** → QR par caméra (`getUserMedia`) OK sur iPhone ; NFC natif KO.

## 2. Architecture cible

### 2.1 Comptes conducteurs (réutilise ~90 % de l'existant)
1. `enum UserRole` + `DRIVER` (migration Postgres enum). `DRIVER_DEFAULTS` restreint (calqué `NIGHT_WATCHMAN_DEFAULTS`) : tout `false` sauf `vehicles_view`. `engine_control` et `privacy_manage` restent **accordables par case** (défaut OFF).
2. Invitation d'un conducteur (fleet-admin) : rôle `DRIVER` + périmètre **véhicule(s) précis** (recommandé) ou groupe + cases `engine_control` / `privacy_manage`. Anti-escalade : un FLEET_ADMIN peut inviter un DRIVER dans sa flotte uniquement.
3. À l'acceptation : compte Vizyo Auth + `User(role=DRIVER)` + `UserVehicleAccess` + **création/liaison d'un `Driver` (`Driver.userId`)** → le conducteur devient identité connectée ET entité attribuable aux trajets.
4. Endpoint moteur : ajouter `DRIVER` au `@Roles(...)`. La permission par-véhicule gère déjà le périmètre. **DRIVER = RESTORE seulement** (garde de rôle dans le service : refus du CUT pour un DRIVER).
5. UI conducteur minimale (patron veilleur) : « Mes véhicules » + bouton « Prendre / Déverrouiller » (scan QR) + toggle « Mode vie privée » si autorisé.

### 2.2 Déverrouillage par QR + proximité (« prise en main »)
- Chaque véhicule : un **QR** encodant un jeton signé du `vehicleId` (imprimable depuis l'admin ; jeton = HMAC pour empêcher la forge, mais l'autorisation reste le vrai verrou).
- Flux : conducteur connecté ouvre la PWA → **scanne le QR** → `POST /driver/unlock { token, coords }` → serveur : résout le véhicule → vérifie `canOnVehicle('engine_control', vehicleId)` → **contrôle proximité** (distance téléphone↔dernière position véhicule ≤ seuil) → **RESTORE** moteur + `Vehicle.currentDriverId = driver` → trajets attribués (`driverSource='CHECKIN'`) → audit `EngineControlCommand` (requestedBy = user du conducteur).
- « Rendre » (fin de service) : libère le conducteur courant (option : re-CUT si politique flotte — hors périmètre driver par défaut).
- QR = **sélecteur de véhicule + preuve de présence**, pas un secret. Le verrou = autorisation serveur + proximité.
- Lib QR : à ajouter côté web (BarcodeDetector si dispo + fallback JS). RFID = option matérielle future (persister `<rfid>` → table `DriverBadge(rfidUid → driverId)`).

### 2.3 Mode vie privée par le conducteur
- Le conducteur peut activer/désactiver le mode vie privée de **son** véhicule courant SI le fleet-admin lui a accordé `privacy_manage` (par périmètre). Réutilise `privacy-mode.service.ts`. Exposé dans l'UI conducteur.

### 2.4 Refonte planning × action manuelle (« synchro ») — INCRÉMENT 1
**Comportement actuel (bug ressenti)** : sur un véhicule au mode horaire actif, le bouton moteur ouvre une modale « …le désactivera automatiquement » et envoie `disableSchedule:true` → le backend met `enabled=false` (`engine-control-button.component.ts:391`, `engine-control.service.ts:297`). Toute action manuelle éteint donc le planning pour de bon.

**Comportement cible** :
- Le cron n'agit qu'aux **transitions** (`state === lastEvaluatedState` → skip, `schedule-cron.service.ts:139`) et `computeNextTransition()` existe déjà.
- Action manuelle (admin/manager/conducteur), **CUT ou RESTORE** → `overrideUntil = computeNextTransition(schedule).at` (prochaine bascule), **jamais** `enabled=false`. Le planning reprend seul à la bascule.
- Veilleur **CUT** → hold indéfini (inchangé, sécu nuit).
- `disableSchedule:true` (case explicite « immobilisation durable / hors planning », anti-vol) → `enabled=false` (conservé, opt-in).
- Toggle page Horaires (`vehicle-schedules.upsert enabled:false`) → désactivation réelle (inchangé).
- Fallback : `computeNextTransition` null (planning toujours ouvert/fermé) → override 1h (comportement dégénéré préservé).

**Scénario validé** (8h→22h) : 22h coupe auto ; 1h un conducteur autorisé rallume → suspension jusqu'à 8h ; 3h la voiture s'arrête (moteur éteint, pas ré-immobilisée) ; 8h le planning reprend ; 22h il recoupe. Le mode n'a jamais été désactivé.

## 3. Changements de modèle de données
- `enum UserRole += DRIVER` (migration enum Postgres, hand-written comme `GPS_LOST`).
- `Driver.userId` : déjà présent — on l'utilise (lien User↔Driver à l'acceptation d'invitation).
- `driverSource` : ajouter la valeur `'CHECKIN'` (String libre, pas d'enum) pour distinguer l'attribution par prise en main.
- QR : jeton dérivé signé (pas de colonne obligatoire) OU `Vehicle.unlockToken String?` si on veut le régénérer/révoquer. **À trancher au build.**
- (Futur) `DriverBadge(rfidUid, driverId)` pour l'option RFID.
- `DRIVER_DEFAULTS` dans `permissions.ts` + `default-permissions.ts`.

## 4. Sécurité / garde-fous
- Anti-escalade invitation : FLEET_ADMIN ↦ DRIVER dans sa flotte uniquement ; clamp permissions.
- DRIVER = RESTORE only (jamais CUT) — garde de rôle dans `engine-control.service`.
- Proximité obligatoire pour le déverrouillage conducteur (seuil env, ex. 150 m).
- QR signé (anti-forge) mais non secret ; l'autorisation + proximité sont les vrais verrous.
- Audit : chaque déverrouillage = `EngineControlCommand` (qui/quand/quel véhicule) + feed système.
- Scoping tenant/anti-IDOR conservé partout (le périmètre `UserVehicleAccess` filtre déjà).

## 5. Phasage (incréments sur la branche)
1. **Refonte planning × manuel** (backend + front + tests) — le plus décidé et sensible. ← EN COURS
2. **Rôle DRIVER + permissions** (enum, DRIVER_DEFAULTS, clamp, default-permissions) + migration.
3. **Invitation conducteur** (rôle DRIVER + périmètre + link `Driver.userId` à l'acceptation).
4. **Déverrouillage QR** : endpoint `/driver/unlock` + génération QR admin + scan PWA + proximité + attribution `CHECKIN`.
5. **Mode vie privée conducteur** (expose privacy toggle dans l'UI conducteur).
6. **UI conducteur** (shell restreint type veilleur, « Mes véhicules »).
7. Tests e2e + doc + revue adversariale avant demande de GO prod.

## 6. Vérification
- `pnpm -w typecheck` + `ng build` (web n'a pas de typecheck) ; `jest` côté api. Pas d'eslint dans le repo.

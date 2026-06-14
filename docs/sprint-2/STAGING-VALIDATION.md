# Sprint 2 — Procédure de validation STAGING (avant prod)

> ⚠️ **Aucune commande réelle sur un véhicule de prod. Jamais la flotte CDEF.** On valide sur un **tracker de test** (IMEI factice non lié à un boîtier réel) ou un **socket simulé**, en **staging**, provider SMS en `noop`.
> Cette procédure suppose appliquées les corrections de la revue (notamment #1 RESTORE, #3 SCHEDULER, #4 carte, #5 confirmation à l'arrêt).

## 0. Pré-requis
- Staging déployé sur la branche `feat/sprint-2-fiabilisation-commande` (migration `confirmationExpected` appliquée par `migrate deploy`).
- Un **véhicule + tracker de test** dans une flotte de test (PAS CDEF). IMEI factice (ex. `999000000000001`).
- Provider SMS = `noop` (aucun vrai SMS) : ne pas configurer `VIZYO_TEXTO_URL`/`TWILIO_*` en staging.
- Outil d'injection de trames : la **console TCP** (`docs/06-tcp-commands-console.md`) ou un petit script qui ouvre une socket vers le port tracker et envoie des trames `imei:<IMEI>,tracker,...` — c'est ce qui **simule le device** sans matériel réel.
- 2 onglets ouverts : **Détail véhicule** (bouton + pastille) et **Carte** (marqueur + popup) ; + la **liste** véhicules.

## 1. Anti multi-clic / verrou 409
1. Injecter une position **ignition ON, vitesse 0** (véhicule en marche, à l'arrêt) pour le tracker de test.
2. Sur le Détail, **Couper le moteur** → confirmer.
   - ✅ Toast **« Coupure envoyée — en attente de confirmation »** (pas « Moteur coupé »).
   - ✅ Pastille sous le bouton : **« En attente… »** (point ambré).
3. **Recliquer Couper** immédiatement (rouvrir le modal, confirmer).
   - ✅ Toast d'erreur **« Commande déjà en cours »** (HTTP 409). Aucune 2ᵉ trame.
4. Depuis le **popup carte**, tenter une 2ᵉ coupure sur le même véhicule → ✅ même message 409 (pas « Échec » générique, pas « Moteur coupé »).

## 2. Confirmation par ignition (le cœur)
1. Véhicule **en marche** (position ignition ON). Couper → pastille **« En attente… »**, badge carte/liste **non « coupé »** (l'état ne bascule pas à l'envoi).
2. Injecter une position **ignition OFF** (le moteur s'éteint = preuve).
   - ✅ La pastille passe **« Coupure confirmée »** (vert).
   - ✅ Le bouton bascule sur **« Rallumer le moteur »**.
   - ✅ Le badge **« coupé »** apparaît sur la **carte** (marqueur) et la **liste**.
3. Ne PAS injecter d'ignition OFF et **attendre > 90 s** (fenêtre `ENGINE_CONFIRM_WINDOW_S`).
   - ✅ La pastille passe **« Non confirmée — à vérifier »** (rouge).
   - ✅ Un **WARNING** apparaît au **centre d'alerte** (« Coupure moteur non confirmée »). Pas de FAILED.

## 3. État « non vérifiable » (véhicule à l'arrêt)
1. Véhicule **déjà à l'arrêt** (dernière position ignition OFF). Couper.
   - ✅ Pastille **« Envoyée — confirmation indisponible (véhicule à l'arrêt) »** (gris). **Jamais** « confirmée », **jamais** d'alerte.
   - ✅ Le verrou 409 ne se déclenche PAS sur une 2ᵉ tentative (coupure non bloquante).
   - 🔎 Affichage carte/liste : **selon la décision #2** (tri-état « non confirmée » vs « coupé » vs « normal »).

## 4. Rallumage nettoie l'état (post-fix #1)
1. Après une **coupure confirmée** (§2), **Rallumer** → confirmer.
   - ✅ Toast **« Rallumage envoyé »**.
   - ✅ Le badge **« coupé » disparaît immédiatement** (carte + liste + bouton repasse « Couper »), **sans** attendre une confirmation (le rallumage est toujours sûr).

## 5. Coupure EXTERNE détectée (synchro device → app, SMS manuel)
1. Sans aucune commande dans l'app, simuler une coupure externe : injecter une transition **ignition ON puis OFF** sans commande app préalable.
   - ✅ Une ligne **DEVICE_OBSERVED CUT** est créée (historique commandes).
   - ✅ Le badge **« coupé »** apparaît sur carte/liste/bouton (source de vérité = device).
2. Injecter **ignition ON** (moteur redémarre) → ✅ une **DEVICE_OBSERVED RESTORE** est créée et le badge se nettoie.

## 6. Multi-tenant (rapide)
- Avec un compte d'une **autre flotte**, tenter `PATCH /engine-control/.../commands` sur le tracker de test → ✅ **404** (pas de fuite cross-flotte). (Déjà couvert par tests auto, vérif de bon sens.)

## Points de contrôle « à l'œil » (résumé)
- [ ] 409 au 2ᵉ clic coupure (détail **et** carte).
- [ ] Badge « coupé » n'apparaît qu'**après** confirmation ignition.
- [ ] Pastille : en attente → confirmée / non confirmée / non vérifiable.
- [ ] Rallumage nettoie le badge **immédiatement**.
- [ ] Coupure externe (DEVICE_OBSERVED) bascule le badge.
- [ ] Aucune fausse alerte au centre d'alerte sur une coupure réussie.
- [ ] **Aucune** trame envoyée à un IMEI de prod pendant tout le test.

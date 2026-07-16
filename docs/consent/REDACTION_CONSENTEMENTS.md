# Consentements & permissions — rédaction v1 (à faire relire par un juriste / DPO)

> ⚠️ **Cette rédaction est un premier jet technique, PAS un avis juridique.** Avant
> mise en prod, faire valider par un juriste / DPO (RGPD, CNIL, ePrivacy). Les
> versions (`v1`, dates) doivent être figées et horodatées à l'acceptation.

Trois périmètres distincts, à construire dans cet ordre : **1) LP** (visiteurs
anonymes → cookies/traceurs) → **2) Application** (utilisateurs authentifiés →
CGU + politique de confidentialité + gate au login) → **3) Permissions device**
(localisation, notifications) au premier lancement.

---

## 1) LANDING PAGE — Bandeau consentement traceurs (visiteurs)

**Contexte** : la LP capture désormais IP + comportement (beacons `/api/partner/activity`)
et des leads. Base légale = **consentement** (traceurs non strictement nécessaires)
→ bandeau conforme ePrivacy/CNIL : refus aussi simple que l'acceptation, pas de
dépôt avant choix, choix mémorisé, retrait possible.

**Titre** : « Votre vie privée »

**Corps** :
> Nous utilisons des traceurs pour mesurer l'audience du site et améliorer notre
> accompagnement commercial (pages vues, clics, temps passé, adresse IP). Ces
> données nous aident à vous recontacter avec une offre pertinente. Vous pouvez
> accepter, refuser, ou personnaliser. Aucun traceur de mesure n'est activé sans
> votre accord. Détails dans notre [politique de confidentialité](/confidentialite.html).

**Boutons** : `Tout accepter` · `Tout refuser` · `Personnaliser`

**Catégories (dans « Personnaliser »)** :
- **Strictement nécessaires** (toujours actifs, sans consentement) : sécurité, envoi
  de formulaire, mémorisation du choix de consentement lui-même.
- **Mesure d'audience & prospection** (OFF par défaut) : beacons d'activité LP
  (clics, scroll, temps, hésitations) + rapprochement par IP. → **ne charger `vt.js`
  tracking QUE si accepté.**

**Impact technique LP** : `initTracking()` (beacons) ne doit s'exécuter **que si**
consentement « mesure » = accepté (lu depuis `localStorage vt-consent`). Le formulaire
lead reste toujours possible (nécessaire au service demandé), mais la **capture IP
à des fins de reconnaissance** relève de la mesure → à conditionner aussi.

---

## 2) APPLICATION — CGU + Confidentialité, acceptation obligatoire au login

**Contexte** : Vizyo Tracky traite des données de géolocalisation de véhicules et de
conducteurs (données personnelles + potentiellement sensibles selon usage). Chaque
utilisateur doit **accepter les CGU + la politique de confidentialité** pour accéder.
Refus → **pas d'accès** (blocage login), c'est assumé.

**Écran de consentement (après login, avant l'app)** — Titre : « Avant de commencer »

> Pour utiliser Vizyo Tracky, vous devez accepter :
>
> ☐ **Les Conditions Générales d'Utilisation** ([lire](/legal/cgu)) — règles d'usage
>   du service, responsabilités, disponibilité.
>
> ☐ **La Politique de confidentialité** ([lire](/legal/confidentialite)) — quelles
>   données sont traitées (position des véhicules, trajets, identités conducteurs,
>   journaux d'activité), pourquoi, combien de temps, vos droits (accès, rectification,
>   effacement, opposition), et le fait que **vos actions dans l'app sont journalisées**
>   (traçabilité / sécurité).
>
> En tant qu'exploitant, vous êtes responsable d'**informer vos conducteurs** et de
> respecter le cadre applicable (information, registre, AIPD si nécessaire).
>
> [ ] J'ai lu et j'accepte les CGU et la Politique de confidentialité.
>
> **[Accéder à Vizyo Tracky]** (désactivé tant que la case n'est pas cochée)
> · **[Refuser et me déconnecter]**

**Règles** :
- Enregistrer `UserConsent { userId, docType: 'CGU'|'PRIVACY', version, acceptedAt, ip, userAgent }`.
- **Gate serveur** : tant que la version courante des docs n'est pas acceptée → l'API
  renvoie `403 CONSENT_REQUIRED` sur les routes protégées (sauf logout + accept), et le
  front redirige vers l'écran de consentement. Ne PAS se contenter d'un gate front.
- **Re-consentement** : si on publie une nouvelle version (`version` incrémentée) →
  ré-afficher l'écran au prochain login.
- L'**owner plateforme** et le support sont soumis aux mêmes règles (traçabilité).

---

## 3) APPLICATION — Permissions device (premier lancement)

Au premier lancement (PWA/mobile), présenter un écran pédagogique **avant** les
prompts natifs (un prompt natif refusé est difficile à récupérer). Pour chaque
permission : expliquer POURQUOI, puis déclencher le prompt natif au clic.

- **Notifications** (alertes) : « Recevez les alertes critiques de votre flotte
  (SOS, excès de vitesse, sortie de zone, batterie faible) en temps réel, même
  application fermée. » → `Notification.requestPermission()` + abonnement push
  (`PushSubscription`, déjà en place — à améliorer). Refus = pas de push, mais
  alertes toujours visibles dans l'app + e-mail.
- **Localisation** (si l'app mobile l'utilise, ex. « me localiser sur la carte » /
  proximité conducteur) : « Pour vous situer sur la carte et faciliter les actions
  de proximité. » → permission géoloc navigateur/Capacitor. **Optionnelle** — la
  position des véhicules vient des boîtiers, pas du téléphone.
- Chaque choix est **traçable** (`UserPermission { userId, deviceId, kind, granted, at }`)
  et **révisable** dans les réglages.

**Gestion des devices** (réglages utilisateur) : lister les appareils connectés
(`deviceId`, nom, dernier accès, push actif) + **révoquer / supprimer un device**
(supprime l'abonnement push + invalide la session de ce device). Améliore l'existant
(`PushSubscription` a déjà `deviceId`).

---

## 4) Vue admin « Qui a consenti »

Dans l'onglet **Utilisateurs** (admin) : colonne / drawer par utilisateur —
- CGU : version acceptée + date (ou « ⚠️ non accepté »).
- Confidentialité : idem.
- Permissions : notifications (oui/non), localisation (oui/non).
- Devices : nombre + liste (dernier accès), action « révoquer ».
- Filtre « non conforme » (pas accepté la version courante) pour relancer.

---

## Modèle de données (proposition, à créer en migration)

```
model UserConsent {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @db.Uuid
  docType    String   // 'CGU' | 'PRIVACY'
  version    String   // ex. '2026-07-16'
  accepted   Boolean  @default(true)
  acceptedAt DateTime @default(now())
  ip         String?
  userAgent  String?
  @@index([userId, docType])
}

model UserPermission {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  deviceId  String?
  kind      String   // 'PUSH' | 'GEOLOCATION'
  granted   Boolean
  updatedAt DateTime @updatedAt
  @@unique([userId, deviceId, kind])
}
```
(Réutiliser `PushSubscription.deviceId` pour la gestion des devices ; ajouter
`lastSeenAt` / `label` si absent.)

## Ordre de construction (dans ce worktree feat/consent-rgpd)
1. Textes légaux (CGU + Confidentialité + politique cookies) — pages `/legal/*` + `/confidentialite.html` LP.
2. LP : bandeau consentement + gate du tracking sur le consentement.
3. App : `UserConsent` + gate login serveur (403 CONSENT_REQUIRED) + écran d'acceptation.
4. App : écran permissions (notif/loc) + `UserPermission` + gestion devices.
5. Admin : vue « qui a consenti » dans l'onglet Utilisateurs.

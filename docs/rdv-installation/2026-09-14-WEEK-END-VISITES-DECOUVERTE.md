# Prise de RDV d'installation — week-end, visites et découverte (2026-09-14)

**Branche : `feat/rdv-installation-v2` (worktree `../wt-rdv-installation`), rebasée sur `origin/main` et poussée sur `main` le 14/09 ; déploiement en production le 14/09 par `deploy.sh` (§ 4).**

Ce que le propriétaire a demandé le 14/09 : retravailler la page `/book/:token` et sa console,
**ouvrir le week-end** (paramétrable à la création du lien), **renvoyer vers la vitrine**
(`decouvrir.html`, `decouvrir-depot.html`, les vidéos), et **savoir qui ouvre le lien, quand,
et ce qu'il fait ensuite**.

---

## 1. Ce qui change, en une lecture

| Sujet | Avant | Maintenant |
|---|---|---|
| Week-end | Un seul horaire pour tous les jours cochés : cocher le samedi = 08:00–21:00 comme un mardi | Fenêtre propre au week-end (`weekendStartMinutes` / `weekendEndMinutes`, `null` = comme la semaine), proposée **09:00–13:00** à la création, modifiable ensuite |
| Console admin | Créer / copier / désactiver / supprimer ; formulaire à 4 champs | Formulaire complet (durée, jours, horaires semaine et week-end, horizon, délai, expiration, usage unique), **aperçu en une phrase** avant de générer, **modification** d'un lien existant, **panneau des visites** |
| Suivi | `openCount` + 1ʳᵉ / dernière ouverture | Une **ligne par visite** : appareil (téléphone / tablette / ordinateur, OS, navigateur), provenance (Gmail, WhatsApp, Messages SMS, appli Android…), IP tronquée, identité quand elle est connue, **chronologie des gestes** horodatée par le serveur |
| Page publique | Jours + créneaux + formulaire ; une seule sortie (mailto) | Pastille « week-end possible », jours de week-end marqués, **trois sorties réelles** (appeler l'atelier, être prévenu, demander un autre créneau), section **« Découvrir Tracky »** (4 scènes de la vitrine + présentation + espace dépôt) |
| « Prévenez-moi » | L'API acceptait l'inscription… et **personne n'était jamais prévenu**, rien n'était purgé | Entretien quotidien 07:40 : purge 90 j (décision client du 16/08), purge des visites 180 j, **e-mail « des créneaux sont disponibles »** une fois par inscription (nouveau modèle `installation_slot_available`) |

---

## 2. Les visites — ce qu'on retient, et ce qu'on ne retient pas

Le visiteur n'a pas de compte et n'a consenti à rien. Trois réductions, toutes à sens unique :

- **IP tronquée** (`92.184.x.x`) — même règle que les liens de partage de trajet / mission ;
- **jamais l'user-agent** : seulement ce qu'on en déduit (`mobile` / `iOS` / `Safari`) ;
- **du referrer, l'hôte seul** (`mail.google.com`, `com.whatsapp`), jamais l'URL.

L'identité n'est posée que quand elle est **connue**, et `identitySource` dit d'où elle vient :

| `identitySource` | Ce que ça veut dire | Affiché |
|---|---|---|
| `LIEN_DIRECT` | Le lien est nominatif : on sait **à qui on l'a envoyé**, pas qui a cliqué | « destinataire du lien (présumé) » |
| `RESERVATION` | Le visiteur a déposé une demande : nom + e-mail saisis | « a réservé » |
| `ABONNEMENT` | Il a laissé son e-mail pour être prévenu | « a demandé à être prévenu » |

Un abonnement ne rétrograde jamais une réservation (le `WHERE` énumère ce qu'il a le droit d'écraser).

### Les gestes (chronologie JSONB, ajoutée par `||`, plafonnée à 80)

| Type | Qui le pose | Cible |
|---|---|---|
| `ouverture` | serveur | `nouvelle` / `rechargement` |
| `jour`, `creneau`, `formulaire` | page | date / libellé du créneau / — |
| `decouverte` | page | `presentation`, `depot`, `video:<supervision\|analyse\|administration\|depot>` |
| `appel`, `courriel` | page | — / `nouveau-lien`, `creneau`, `question` |
| `reservation`, `reservation_echec`, `abonnement` | **serveur seulement** | libellé / motif / — |

⚠️ La page ne peut poser que **ses** gestes (`BOOKING_VISIT_EVENTS_PAGE`, vérifié par `class-validator`) :
un `POST … {"type":"reservation"}` depuis la page est refusé (400). Sinon n'importe qui écrirait « a réservé ».

### Trois pièges rencontrés pendant le chantier

1. **Le `Referer` de l'appel API, c'est nous.** L'appel part de notre propre page ; sa provenance
   est donc toujours `app-tracky…`. La vraie origine est `document.referrer`, que la page envoie
   en `?ref=` à la **première** ouverture seulement (au rechargement, c'est nous). Android
   transmet l'application d'origine en `android-app://<paquet>` → « Gmail (application) »,
   « Messages (SMS) », « WhatsApp »…
2. **Un rechargement n'est pas une visite.** Après « ce créneau vient d'être pris », la page
   recharge ses disponibilités en repassant `?visite=<id>` : la visite est réutilisée (geste
   `rechargement`), `openCount` ne bouge pas.
3. **Les robots.** Un aperçu WhatsApp / iMessage n'exécute pas le JavaScript et n'atteint jamais
   l'API ; mais un scanner de liens de passerelle courriel (Safe Links…) peut. Il est enregistré
   `robot: true`, compté à part, et n'alimente ni `openCount` ni le feed « Système ».

---

## 3. Décisions à confirmer par le propriétaire

| # | Point | Ce qui est fait | À trancher |
|---|---|---|---|
| D1 | Rétention des visites | **180 j** (`VISIT_RETENTION_DAYS`) = l'horizon maximal d'un lien ; documenté dans `rgpd-retention-donnees.md` | Confirmer ou raccourcir (90 j comme les abonnés ?) |
| D2 | Heure de l'entretien | **07:40** — le courriel « des créneaux sont disponibles » arrive quand on peut réserver | OK ? |
| D3 | Fenêtre week-end par défaut | **09:00–13:00** proposée quand on coche S ou D et « horaires différents » | OK ? |
| D4 | `INSTALLATION_PUBLIC_PHONE` | Toujours **vide en prod** → le bouton « Appeler l'atelier » **n'apparaît pas** (décision du 16/08 : numéro d'atelier, jamais d'une personne) | Renseigner un numéro d'atelier dans le `.env` prod si on veut la 1ʳᵉ sortie |
| D5 | Liens de découverte | Toujours affichés (pas d'option par lien) ; `?from=rdv-installation` lu par `vt.js` sur la vitrine | Faut-il pouvoir les masquer sur un lien ? |

---

## 4. Déployer

1. Fusionner `feat/rdv-installation-v2` dans `main`, pousser `origin/main`.
2. `deploy.sh` applique la migration `20260914120000_rdv_installation_weekend_et_visites`
   (`prisma migrate deploy` au démarrage du conteneur) : deux colonnes nullables + une table ;
   **aucune réécriture de ligne**, aucun lien existant ne change de comportement.
3. Variables : `VITRINE_BASE_URL` optionnelle (défaut `https://tracky.vizyoagency.com`) ;
   `INSTALLATION_PUBLIC_PHONE` inchangée (voir D4).
4. Vérifier après déploiement : `/admin/background-tasks` liste **« Entretien de la prise de RDV
   d'installation »** (07:40) ; `/admin/emails` → modèle « Créneau disponible » prévisualisable.

---

## 5. Recette faite le 14/09 (base de dev, worktree)

- **API** : `pnpm typecheck` (3 paquets) ✅ · smoke-boot DI ✅ · jest API **4 006 tests** ✅
  (dont 29 nouveaux sur le service, 12 sur le générateur, 13 sur `visiteur.ts`) ·
  web **721** ✅ · les six `verif:*` ✅.
- **Migration** appliquée sur la base de dev ; `prisma migrate diff` ne montre que les `DEFAULT`
  préexistants (même convention que `installation_slot_watchers`).
- **En direct** (curl puis navigateur) : création d'un lien L–V 08–18 + samedi 09–13 (le samedi
  n'offre que 09:00–11:00 et 11:00–13:00) ; refus d'une fenêtre week-end plus courte qu'un
  créneau ; ouverture « iPhone via Gmail » → visite `mobile · iOS · Safari · Gmail` ; geste
  `reservation` envoyé par la page → 400 ; rechargement → même visite ; réservation → identité
  certaine + `bookingId` ; même créneau une 2ᵉ fois → 409 + `reservation_echec` ; « prévenez-moi »
  → `abonnement` sans rétrograder ; aperçu WhatsApp → `robot`, compté à part.
- **Écran** : page publique desktop et 375 px (les jours empilent libellé / nombre de créneaux —
  le style global passait tout `<button>` en `inline-flex` sous 768 px, corrigé) ; console :
  création avec accents, modification (week-end → « comme la semaine »), panneau des visites
  avec provenance et chronologie.

---

## 6. Fichiers

| | |
|---|---|
| Schéma / migration | `apps/api/prisma/schema.prisma`, `prisma/migrations/20260914120000_rdv_installation_weekend_et_visites/` |
| API | `installation-booking/{installation-booking.service,installation-booking.slots,visiteur,installation-booking-entretien.service,public-booking.controller,installation-booking.controller}.ts`, `dto/installation-booking.dto.ts` |
| Courriel | `email/email.service.ts` (`installation_slot_available`), `email-admin.service.ts` + les deux specs de catalogue |
| Catalogue des traitements | `background-tasks/background-tasks.service.ts` (`installation-booking-entretien`) |
| Démo | `demo/import/allowlist.ts` (`InstallationBookingLinkVisit` exclu : données de clients) |
| Contrat partagé | `packages/shared/src/dto/installation-booking.dto.ts` |
| Web | `features/booking/public-booking.component.ts`, `features/observability/admin-installation-bookings.component.ts`, `core/services/installation-booking.service.ts` |
| Config | `config/env.validation.ts` (`VITRINE_BASE_URL`), `.env.example` |

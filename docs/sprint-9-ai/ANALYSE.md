# Sprint 9 — Copilote IA d'optimisation de flotte (ANALYSE)

> Bâti **par-dessus Sprint 8** (réservation & optimisation sur `VehicleEvent`). Objectif :
> ajouter une couche **IA (Claude)** qui propose les meilleurs placements/prévisions dans
> l'agenda et maximise l'optimisation, **métier par métier**, avec **CDEF en priorité**.
> Testé d'abord en **Console Anthropic** (tokens du client), préparé ici.

## 1. État réel du code (constaté, 2026-06-29)

- **Aucun champ « métier » sur la flotte.** `Fleet` (`schema.prisma:156`) a `name`/`clientId`
  mais rien qui distingue CDEF (enfants) / MH Cars (colis) / A2R (location). CDEF 31 n'existe
  que dans un seed d'installation.
- **Le vrai blocage CDEF = les places.** `Vehicle.seats` / `childSeats` existent (S8) mais sont
  **nullables et quasi vides** : le provisioning depuis le planning d'installation force
  `type='CAR'` et ne renseigne jamais les places (`installations.service.ts:320`). Le planning
  (`InstallationTask`) porte `brand` + `model` + `energy` **mais pas le nombre de places**.
  Or un même modèle (Jumpy/Expert) existe en **9 places (Traveller/navette) ou 2 places (fourgon)**
  → ce n'est pas une table de correspondance, c'est du **raisonnement** (parfait pour l'IA).
- **Le moteur S8 est solide et réutilisable.** `ReservationsService` (`suggest`, `findOverlaps`,
  `hasTripOverlap`, `resolveScope`), `FleetInsightsService` (`getUtilization`), `ForecastService`
  (`getForecast`), + la contrainte Postgres `EXCLUDE no_overlap_reservation` (anti-double-booking
  race-proof) + le scoping anti-IDOR S5. Le point de greffe IA est net, sans rien casser.

## 2. Principe directeur (NON négociable) : **l'IA propose, l'app valide**

- L'IA **ne touche jamais la base**. Elle **lit** (via les services déjà scopés par utilisateur)
  et rend une **proposition structurée** (JSON à schéma garanti — pas de texte libre à reparser).
- Les garde-fous S8 restent **juges** : `findOverlaps` + contrainte `EXCLUDE` + scoping.
  Même une hallucination IA **ne peut pas** créer un double-booking ni fuiter cross-tenant.
- **Humain dans la boucle** : les propositions atterrissent dans une file de validation
  (capacité = revue+accept ; placement = classement à valider), **jamais auto-appliquées**.
- **Console d'abord** : on prépare le *prompt pack* (system prompt + schéma + payload exemple),
  le client teste dans la Console avec **ses** tokens, on câble l'app après validation.

## 3. Architecture — mix app + IA, 2 capacités, CDEF d'abord

### Levier transverse : `Fleet.metier`
`enum FleetMetier { CHILDREN_TRANSPORT, PARCELS, RENTAL, GENERIC }` (défaut `GENERIC`).
C'est ce qui dit à l'IA « CDEF transporte des enfants » et bascule son objectif d'optimisation.
Réglé par un super-admin (source de vérité). Bonus : l'IA peut *proposer* le métier depuis le
nom + le parc, mais le champ reste autoritaire.

### Capacité 1 — Enrichissement de capacité (LE déblocage CDEF)
L'IA lit le parc (marque/modèle/énergie/type, depuis le véhicule + le planning d'install) + le
métier, et **propose** pour chaque véhicule : `places`, `places-enfant`, équipements probables —
avec **confiance + justification**, à confirmer par un humain. C'est ici que « Jumpy 9 vs 2 places »
se règle (l'IA raisonne par modèle/variante/énergie et **flag l'incertain** au lieu de deviner faux).
Sans ça, `suggest()` matche sur des `seats` vides → tout le reste tourne à vide pour CDEF.

### Capacité 2 — Optimiseur de placement / mutualisation (métier-aware)
Pour une demande (créneau + besoin) ou une vue « semaine », l'IA prend les candidats **déjà
filtrés disponibles** (`suggest`), leur utilisation (`insights` : sous-utilisés, créneaux libres),
la **prévision** (`forecast`), + le profil métier → et rend un **classement raisonné** :
quel véhicule, pourquoi, quels risques. CDEF : « course de 7 enfants → ë-Jumpy (8 places-enfant,
sous-utilisé) plutôt que 2 Clio ». Remplace le tri heuristique « sous-utilisés d'abord » actuel.
Côté **prévisions**, la même capacité peut produire un plan proactif (manques anticipés).

### MH Cars (colis) & A2R (location) — même moteur, en suivant
- MH Cars : optimisation par **charge** (cargo). Champs cargo à ajouter ensuite ; appui initial
  sur `type=VAN`/features. Le profil métier oriente l'IA vers volume/poids.
- A2R : optimisation par **disponibilité/durée** (location longue, éviter chevauchements
  maintenance) + tarif (`rentalRateEur`, ajout). Le moteur réservation gère déjà les créneaux.

## 4. Modèle & API (cf. skill claude-api)

- **`claude-opus-4-8`** (raisonnement déduction places / placement = son terrain). Haiku 4.5
  possible plus tard pour les cas simples.
- **Sortie structurée** (`output_config.format` JSON-schema / strict tool use) → JSON garanti.
- **Adaptive thinking** (`{type:"adaptive"}`, effort `high`) + **prompt caching** sur le préfixe
  stable (system + profil métier + schéma) → runs quotidiens peu chers.
- Clé `ANTHROPIC_API_KEY` **en env** (le client la fournit ; jamais en dur, jamais loggée).
  Sans clé → l'endpoint renvoie un 503 explicite (l'app ne casse pas).

## 5. Sécurité / garde-fous

Scoping S5 **inchangé** (l'IA ne reçoit que le périmètre de l'appelant → pas d'IDOR) · **dry-run**
(rien en base tant que pas confirmé) · `EXCLUDE`/`findOverlaps` juges finaux · perm dédiée
`ai_optimize` (lancer les propositions), l'**application** réutilise les perms existantes
(`vehicles_edit` pour écrire une capacité, `reservations_*` pour une réservation) =
défense en profondeur.

# A1 — Le rôle DEPOT : permissions et isolation

> **Prérequis absolu du bloc A.** Aucun écran ne se construit avant que les tests d'isolation de ce document soient verts.

## Pages concernées

| Élément | Fichier | Action |
|---|---|---|
| Source des permissions | `packages/shared/src/permissions/permissions.ts` | Modifier |
| Tests des permissions | `packages/shared/src/permissions/permissions.spec.ts` | Étendre |
| Enum Prisma | `apps/api/prisma/schema.prisma` → `enum UserRole` | Modifier |
| Résolveur | `apps/api/src/permissions/permissions-resolver.service.ts` | Étendre |
| Nouveau garde | `apps/api/src/depot/depot-scope.guard.ts` | Créer |
| Shell web | `layouts/dashboard-layout.component.ts` | Modifier |
| Routes | `apps/web/src/app/app.routes.ts` | Modifier |

Maquette : `Utilisateurs Refonte.dc.html` § 02 (matrice) et § 04 (Android).

---

## 1. Le slug

`permissions.ts:18` déclare aujourd'hui :

```ts
export type UserRoleSlug = 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER' | 'NIGHT_WATCHMAN' | 'DRIVER';
```

Ajouter `'DEPOT'` en dernière position. Côté Prisma, ajouter `DEPOT` à `enum UserRole` — migration additive, aucune donnée existante touchée.

**Position dans la hiérarchie : aucune.** `DEPOT` n'est pas « en dessous de VIEWER ». C'est un rôle **latéral** : son périmètre n'est pas un sous-ensemble de la flotte, c'est un axe différent (la mission). Ne pas le glisser dans les comparaisons de niveau existantes.

---

## 2. Les permissions

### Nouvelles permissions à créer

Ajouter à l'interface `UserPermissions` :

```ts
  /**
   * Espace dépôt (2026-08) — voir les missions dont on est le dépôt destinataire.
   * Le périmètre n'est PAS la flotte : il est calculé depuis Mission.depotUserId.
   * OFF par défaut pour tous les rôles sauf DEPOT.
   */
  missions_view: boolean;
  /** Créer / modifier / annuler une mission et désigner son dépôt destinataire. */
  missions_manage: boolean;
  /** Générer un lien public temporaire de suivi vers un client final. */
  mission_share: boolean;
  /** Voir le nom et le téléphone du conducteur d'une mission dont on est destinataire. */
  driver_contact_view: boolean;
```

### Le tableau des défauts

`DEPOT_DEFAULTS` : **tout à `false`**, sauf les quatre lignes ci-dessous.

| Permission | DEPOT | Portée réelle |
|---|---|---|
| `missions_view` | ✅ | Uniquement `Mission.depotUserId = moi` |
| `trips_view` | ✅ | Uniquement les `Trip` rattachés à ces missions |
| `mission_share` | ✅ | Uniquement pour ses propres missions |
| `driver_contact_view` | ✅ | Uniquement le conducteur de la mission en cours |
| `vehicles_view` | ❌ | **Jamais.** Pas d'accès flotte |
| `reports_view`, `reports_export` | ❌ | L'export dépôt passe par un endpoint dédié (§ A3) |
| `engine_control`, `privacy_manage`, `schedules_manage` | ❌ | Aucune écriture sur un véhicule |
| `alerts_*`, `geofences_*`, `groups_*` | ❌ | Hors périmètre |
| `users_*`, `drivers_*`, `sims_*`, `billing_manage` | ❌ | Hors périmètre |
| `agenda_view`, `reservations_*` | ❌ | L'agenda est l'outil du transporteur |
| `ai_*`, `audio_monitoring`, `qr_manage`, `places_view` | ❌ | Hors périmètre |

### Les défauts des rôles existants

| Rôle | `missions_view` | `missions_manage` | `mission_share` | `driver_contact_view` |
|---|---|---|---|---|
| `SUPER_ADMIN` | ✅ bypass | ✅ bypass | ✅ bypass | ✅ bypass |
| `FLEET_ADMIN` | ✅ bypass | ✅ bypass | ✅ bypass | ✅ bypass |
| `FLEET_MANAGER` | ✅ | ✅ | ✅ | ✅ |
| `VIEWER` | ✅ | ❌ | ❌ | ❌ |
| `NIGHT_WATCHMAN` | ❌ | ❌ | ❌ | ❌ |
| `DRIVER` | ✅ (les siennes) | ❌ | ❌ | — |

Le veilleur reste à zéro : son métier est nocturne, les missions sont diurnes, et il travaille sans aucune donnée de conducteur.

### Ce qu'un DEPOT peut accorder

```ts
effectiveGranterPermissions({ role: 'DEPOT' }) // → toutes à false
```

Un dépôt n'invite personne, ne délègue rien. À vérifier explicitement dans `permissions.spec.ts`.

---

## 3. L'isolation — le cœur du lot

### La règle

> Le périmètre d'un `DEPOT` se calcule **à chaque requête**, depuis `Mission`, jamais depuis `UserVehicleAccess` ni `Fleet`.

`PermissionsResolverService` résout aujourd'hui par véhicule via `UserVehicleAccess` (`VEHICLE > GROUP > ALL`). **Ce chemin ne s'applique pas au rôle DEPOT** : un dépôt n'a aucune ligne `UserVehicleAccess`, et il ne doit jamais en avoir.

Créer un résolveur distinct :

```ts
// apps/api/src/depot/depot-scope.service.ts

/** Les missions du dépôt, éventuellement bornées à un instant. */
async missionsFor(userId: string, at?: Date): Promise<Mission[]>

/**
 * Le dépôt peut-il voir la POSITION de ce véhicule maintenant ?
 * Vrai seulement s'il existe une mission where
 *   depotUserId = userId AND vehicleId = vehicleId
 *   AND startAt <= now AND endAt >= now
 *   AND status IN (IN_PROGRESS, LATE)
 */
async canSeeLivePosition(userId: string, vehicleId: string): Promise<boolean>

/** Le dépôt peut-il voir l'HISTORIQUE de ce trajet ? (mission terminée, pas de borne horaire) */
async canSeeTrip(userId: string, tripId: string): Promise<boolean>
```

### Les 6 règles d'isolation, non négociables

1. **Filtre en requête, pas en affichage.** Le `where` Prisma porte toujours `depotUserId`. Ne jamais charger puis filtrer en mémoire.

2. **`403`, jamais `200 []`.** Hors périmètre, l'API refuse. Un tableau vide laisse déduire que la ressource existe mais est vide ; un `403` ne dit rien. Cette distinction est la différence entre « il n'y a pas de camion » et « il y a un camion mais pas pour vous ».

3. **`404` sur un identifiant inconnu, `403` sur un identifiant hors périmètre — non.** Renvoyer `403` dans les deux cas. Distinguer les deux permet d'énumérer les identifiants valides.

4. **La fenêtre horaire est vérifiée côté serveur, à l'heure serveur.** Jamais depuis une date envoyée par le client.

5. **Le WebSocket a ses propres rooms.** Un `DEPOT` rejoint `depot:mission:<missionId>`, jamais `ops:fleet:<fleetId>`. Le serveur cesse d'émettre vers cette room à `endAt`, ou à la clôture manuelle de la mission. Un socket ouvert avant `endAt` ne doit pas continuer à recevoir après.

6. **Pas d'agrégat qui fuit.** Un compteur « 7 camions dans la flotte » sur un écran dépôt est une fuite. Tous les compteurs servis à un dépôt se calculent sur ses missions.

### Le garde

```ts
// apps/api/src/depot/depot-scope.guard.ts
@Injectable()
export class DepotScopeGuard implements CanActivate {
  // Si user.role !== 'DEPOT' → laisse passer (les autres gardes s'appliquent)
  // Si user.role === 'DEPOT' :
  //   - résout le paramètre de route (missionId | vehicleId | tripId)
  //   - interroge DepotScopeService
  //   - false → ForbiddenException (403)
}
```

À appliquer sur **tous** les contrôleurs qu'un dépôt peut atteindre, y compris ceux qui existent déjà (`positions`, `trips`). Une route oubliée est une faille.

---

## 4. Les endpoints

Créer un module `depot` avec son propre préfixe. **Ne pas réutiliser les contrôleurs de la flotte** : leurs DTO exposent des champs qu'un dépôt ne doit pas voir (coûts, scores, conducteur hors mission, groupe).

| Méthode | Route | Renvoie |
|---|---|---|
| `GET` | `/depot/missions?status=&from=&to=` | Les missions du dépôt, DTO restreint |
| `GET` | `/depot/missions/:id` | Une mission + son déroulé |
| `GET` | `/depot/missions/:id/position` | Position live — `403` hors fenêtre |
| `GET` | `/depot/trips/:id` | Le trajet d'une mission terminée |
| `GET` | `/depot/history?from=&to=` | Les trajets terminés + KPI |
| `POST` | `/depot/exports` | Génère un PDF/CSV borné aux missions du dépôt |
| `GET` | `/depot/documents` | Bons de livraison, rapports |
| `POST` | `/depot/incidents` | Signalement au transporteur |

### Le DTO restreint

`DepotMissionDto` — le contrat exact de ce qu'un dépôt reçoit. Tout champ absent d'ici ne doit jamais transiter.

```ts
interface DepotMissionDto {
  id: string;
  ref: string;                    // "M-2481"
  origin: string;                 // libellé seul, pas de FleetPlace complet
  destination: string;
  startAt: string;
  endAt: string;
  status: 'PLANNED' | 'IN_PROGRESS' | 'LATE' | 'DONE' | 'CANCELLED';
  vehicle: {
    plate: string;
    label: string | null;         // "Renault D 12 t"
    // PAS d'id interne, PAS d'imei, PAS de groupe, PAS de coûts
  };
  driver: {                       // seulement si driver_contact_view
    displayName: string;          // "Karim B." — prénom + initiale
    phone: string | null;         // masqué côté API : "06 12 •• •• 47"
  } | null;
  etaAt: string | null;
  delayMinutes: number | null;
  carrierName: string;            // Fleet.name, pour la marque
}
```

⚠️ **Le téléphone est masqué côté API**, pas côté template. Le numéro complet ne quitte pas le serveur ; un bouton « appeler » passe par un endpoint qui journalise l'accès.

---

## 5. Frontend

### Route et garde

```ts
{
  path: 'depot',
  canActivate: [authGuard, depotRoleGuard],
  loadChildren: () => import('./features/depot/depot.routes')
}
```

**Redirection post-login.** Un `DEPOT` qui se connecte arrive sur `/depot`, jamais sur `/dashboard`. À traiter au même endroit que la redirection du rôle `DRIVER` vers `/driver`.

**Verrouillage inverse.** Un `DEPOT` qui tape `/map`, `/vehicles` ou `/reports` est renvoyé sur `/depot`. Pas de page 403 : ces routes n'existent pas dans son monde.

### Shell

`dashboard-layout.component.ts` filtre déjà la nav par rôle (mode veilleur, mode simplifié). Ajouter un troisième cas :

| Élément du shell | En mode DEPOT |
|---|---|
| Entrées de nav | 4 seulement : Carte live · Missions · Historique · Documents |
| Sélecteur de société | Retiré |
| Cloche d'alertes | Retirée |
| Recherche globale | Retirée |
| Marque en tête | Nom du transporteur, pas Vizyo Tracky |
| Pied de menu | « Propulsé par Vizyo Tracky », 12 px, `--tx3` |
| Menu profil | Mon compte · Comment ça marche · Déconnexion |

---

## 6. États et cas particuliers

| Cas | Comportement attendu |
|---|---|
| Dépôt sans aucune mission | Page d'accueil avec état vide expliqué : « Aucune mission ne vous est assignée pour l'instant. Votre transporteur vous préviendra. » **Pas** une carte vide sans texte |
| Toutes les missions terminées | Carte live vide + renvoi vers l'historique |
| Mission planifiée, pas commencée | Visible dans la liste, **position indisponible** : « Le suivi démarrera à 08:15 » |
| Mission en retard | Statut `LATE`, position toujours servie (la fenêtre s'étend tant que le trajet n'est pas clos) |
| Mission annulée | Disparaît de la carte, reste dans l'historique avec la mention « Annulée » |
| Véhicule sans position (boîtier muet) | « Position indisponible depuis 14 min » — jamais une dernière position périmée présentée comme actuelle |
| Véhicule en mode vie privée pendant la mission | Ne devrait pas arriver (une mission est du temps professionnel). Si cela arrive : « Suivi suspendu », sans dire pourquoi |
| Dépôt désactivé par le transporteur | Déconnexion à la prochaine requête, message « Votre accès a été retiré par votre transporteur » |
| Deux missions simultanées sur le même véhicule | Interdit à la création (§ A2). Si les données existent : la plus récente prime |

---

## 7. Règles métier

1. Un `DEPOT` appartient à **une seule** `Fleet` (`User.fleetId`). Un dépôt qui travaille avec deux transporteurs a deux comptes. Décision client explicite : le multi-transporteur n'est pas au périmètre.
2. Un `DEPOT` **n'a jamais** de ligne `UserVehicleAccess`. À faire respecter par une contrainte applicative, testée.
3. La position live n'est servie que pour `status IN (IN_PROGRESS, LATE)`. `PLANNED` ne donne rien, même si `startAt` est passé de 2 minutes — c'est la première position détectée qui bascule le statut.
4. L'historique n'a pas de borne horaire : une mission terminée reste consultable jusqu'à la fin de la période de conservation (12 mois, § A3).
5. Le dépôt ne voit **jamais** l'identifiant interne d'un véhicule. La plaque est sa clé, et elle est publique.

---

## 8. Critères de recette

Tests d'isolation à écrire dans `apps/api/test/depot-isolation.e2e-spec.ts`. **Tous doivent passer avant A2.**

| # | Scénario | Attendu |
|---|---|---|
| 1 | `DEPOT` demande un véhicule de la flotte hors mission | `403` |
| 2 | `DEPOT` demande la position d'un de ses véhicules **avant** `startAt` | `403` |
| 3 | `DEPOT` demande la position **pendant** la fenêtre | `200` + position |
| 4 | `DEPOT` demande la position **après** `endAt` (mission `DONE`) | `403` |
| 5 | `DEPOT` demande une mission d'un autre dépôt | `403` |
| 6 | `DEPOT` appelle `GET /vehicles` | `403` |
| 7 | `DEPOT` appelle `POST /engine-control/*` | `403` |
| 8 | `DEPOT` appelle `GET /users` | `403` |
| 9 | Socket : `DEPOT` tente de rejoindre `ops:fleet:<id>` | Refus |
| 10 | Socket : émission après `endAt` | Aucun message reçu |
| 11 | `DEPOT` tente d'accorder une permission | `403` |
| 12 | Le DTO servi ne contient ni `vehicleId`, ni `imei`, ni coût | Assertion sur les clés |

Une revue manuelle complète le lot : parcourir **tous** les contrôleurs de `apps/api/src/` et lister ceux qu'un `DEPOT` authentifié peut atteindre. Chacun porte `DepotScopeGuard` ou refuse le rôle.

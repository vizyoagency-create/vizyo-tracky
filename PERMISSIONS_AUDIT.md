# Audit — Champ permissions sur User

Date : 2026-04-15

---

## 1. Migration d'ajout

- **Nom** : `20260412115609_add_user_permissions`
- **Chemin** : `apps/api/prisma/migrations/20260412115609_add_user_permissions/migration.sql`
- **Date** : 2026-04-12

**SQL :**
```sql
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "permissions" JSONB;
```

Le champ est nullable (`Json?` dans Prisma), pas de valeur par defaut en base. Les permissions par defaut sont injectees cote applicatif lors de la creation d'un utilisateur.

---

## 2. Utilisation dans le backend

### 2.1 Lectures

**1. `apps/api/src/auth/auth.service.ts:100`** — Chargement du user local apres verification JWT
```typescript
// resolveLocalUser()
permissions: (user.permissions as Record<string, boolean>) ?? null,
```
Contexte : le champ est lu depuis Prisma et casté en `Record<string, boolean> | null`. Il est ensuite transmis dans l'objet `AuthUser` qui circule dans tout le pipeline de requete.

**2. `apps/api/src/auth/auth.service.ts:49`** — Renvoyé dans la réponse de login
```typescript
// login()
user: {
  id: localUser.id,
  email: localUser.email,
  role: localUser.role,
  fleetId: localUser.fleetId,
  permissions: localUser.permissions,
},
```
Contexte : le champ permissions est envoyé au frontend dans la réponse POST `/api/auth/login`.

**3. `apps/api/src/users/users.controller.ts:63`** — Lecture implicite (création user, retour de la valeur écrite)
```typescript
permissions: getDefaultPermissions(dto.role) as unknown as Prisma.JsonObject,
```

**4. `apps/api/src/users/users.controller.ts:74`** — Retourné dans la réponse de création
```typescript
permissions: user.permissions,
```

**5. `apps/api/src/users/users.controller.ts:94`** — Select dans findAll
```typescript
select: { id: true, email: true, firstName: true, lastName: true, role: true, permissions: true, ... }
```

**6. `apps/api/src/users/users.controller.ts:116`** — Select dans findOne
```typescript
select: { id: true, email: true, ..., permissions: true, ... }
```

**7. `apps/api/src/users/users.controller.ts:161`** — Select dans update
```typescript
select: { id: true, email: true, ..., permissions: true, ... }
```

**IMPORTANT** : le champ `permissions` n'est **jamais verifié cote backend** pour autoriser/refuser une action. Il est uniquement :
1. Lu depuis la base
2. Transmis au frontend dans les reponses API
3. Le frontend gere l'affichage conditionnel via `PermissionsService.can()`

Le backend se repose **exclusivement** sur `UserRole` (enum) + `RolesGuard` pour l'autorisation. Les permissions JSON sont un mecanisme **UI-only** pour personnaliser l'affichage par utilisateur.

### 2.2 Ecritures

**1. Creation d'un user — `apps/api/src/users/users.controller.ts:63`**
```typescript
permissions: getDefaultPermissions(dto.role) as unknown as Prisma.JsonObject,
```
Declencheur : POST `/api/users` (FLEET_ADMIN ou SUPER_ADMIN). Les permissions par defaut du role sont appliquees automatiquement.

**2. Mise a jour d'un user — `apps/api/src/users/users.controller.ts:157-158`**
```typescript
// Si le role change → reset aux defaults du nouveau role
...(roleChanged ? { permissions: getDefaultPermissions(dto.role!) as unknown as Prisma.JsonObject } : {}),
// Si le role ne change pas → ecrit les permissions envoyees par le frontend
...(dto.permissions !== undefined && !roleChanged ? { permissions: dto.permissions as unknown as Prisma.JsonObject } : {}),
```
Declencheur : PATCH `/api/users/:id` (FLEET_ADMIN ou SUPER_ADMIN).
Logique :
- Si le role change : les permissions sont **ecrasees** par les defaults du nouveau role
- Si le role ne change pas et `dto.permissions` est fourni : les permissions sont mises a jour avec les valeurs envoyees

**3. Creation via Internal API — `apps/api/src/internal/internal.controller.ts:50-58`**
```typescript
// provisionFleet() → crée un user FLEET_ADMIN
await this.prisma.user.create({
  data: {
    authUserId: dto.adminAuthUserId,
    email: dto.adminEmail,
    ...
    role: UserRole.FLEET_ADMIN,
    fleetId: fleet.id,
  },
});
```
Note : le provisioning interne **ne definit pas** `permissions` → le champ reste `null`. Ce n'est pas un probleme car FLEET_ADMIN bypass toutes les permissions (le frontend retourne `true` pour tout).

**4. Seed — `apps/api/prisma/seed.ts`**
Le seed ne definit pas `permissions` pour le SUPER_ADMIN. Meme logique : SUPER_ADMIN bypass.

### 2.3 Types TypeScript

**Interface `UserPermissions` — `apps/api/src/users/default-permissions.ts`**

```typescript
export interface UserPermissions {
  vehicles_view: boolean;
  vehicles_create: boolean;
  vehicles_edit: boolean;
  vehicles_delete: boolean;
  groups_view: boolean;
  groups_manage: boolean;
  geofences_view: boolean;
  geofences_manage: boolean;
  alerts_view: boolean;
  alerts_acknowledge: boolean;
  reports_view: boolean;
  users_view: boolean;
  users_manage: boolean;
}
```

13 permissions, toutes booleennes.

**Interface `AuthUser` — `apps/api/src/auth/types/auth-user.ts`**
```typescript
permissions: Record<string, boolean> | null;
```
Note : type plus lache que `UserPermissions` — accepte n'importe quelle cle string.

**Interface frontend `AuthUser` — `apps/web/src/app/core/services/auth.service.ts`**
```typescript
permissions: Record<string, boolean> | null;
```
Meme type lache. Pas de reference a `UserPermissions` cote frontend.

### 2.4 Validation

**DTO `UpdateUserDto` — `apps/api/src/users/dto/update-user.dto.ts`**
```typescript
import type { UserPermissions } from '../default-permissions';

@IsObject()
@IsOptional()
permissions?: UserPermissions;
```

Validation : `@IsObject()` de class-validator. Verifie uniquement que c'est un objet, **pas** que les cles sont valides ou que les valeurs sont booleennes. Aucun schema Zod pour les permissions. Aucune validation des cles individuelles.

**DTO `CreateUserDto` — `apps/api/src/users/dto/create-user.dto.ts`**
Pas de champ `permissions` dans le DTO de creation. Les permissions sont injectees automatiquement par le controller via `getDefaultPermissions()`.

---

## 3. Utilisation dans le frontend

### 3.1 Lectures

**1. `apps/web/src/app/core/services/permissions.service.ts:12-21`** — Service central
```typescript
can(permission: string): boolean {
  const user = this.auth.user();
  if (!user) return false;
  if (user.role === 'FLEET_ADMIN' || user.role === 'SUPER_ADMIN') return true;
  return user.permissions?.[permission] === true;
}
```
Contexte : service injectable utilise par tous les composants. FLEET_ADMIN et SUPER_ADMIN bypass toutes les permissions.

**2. `apps/web/src/app/features/auth/login.component.ts:132`** — Stockage apres login
```typescript
permissions: data.user.permissions ?? null,
```

**3. `apps/web/src/app/core/services/auth.service.ts:102`** — Fallback JWT decode
```typescript
permissions: decoded.permissions ?? null,
```

**4. Usages de `perms.can()` dans les templates :**

| Fichier | Ligne | Permission testee | Contexte UI |
|---|---|---|---|
| `layouts/dashboard-layout.component.ts` | 263 | `users_view` | Afficher/masquer le lien "Utilisateurs" dans la sidebar |
| `features/vehicles/vehicles-list.component.ts` | 32 | `groups_view` | Afficher le tab switch Vehicules/Groupes |
| `features/vehicles/vehicles-list.component.ts` | 42 | `vehicles_create` | Bouton "Ajouter" vehicule |
| `features/vehicles/vehicles-list.component.ts` | 60-61 | `vehicles_create` | Message vide + CTA creation |
| `features/vehicles/vehicles-list.component.ts` | 94 | `vehicles_edit` | Bouton "Assigner tracker" |
| `features/vehicles/vehicles-list.component.ts` | 106 | `vehicles_edit` | Bouton "Modifier" vehicule |
| `features/vehicles/vehicles-list.component.ts` | 111 | `vehicles_delete` | Bouton "Supprimer" vehicule |
| `features/geofences/geofences-list.component.ts` | 26 | `geofences_manage` | Bouton "Nouvelle zone" |
| `features/geofences/geofences-list.component.ts` | 39 | `geofences_manage` | CTA creation dans etat vide |
| `features/geofences/geofences-list.component.ts` | 78 | `geofences_manage` | Actions edit/delete par geofence |
| `features/alerts/alerts.component.ts` | 27 | `alerts_acknowledge` | Bouton "Tout acquitter" |
| `features/alerts/alerts.component.ts` | 91 | `alerts_acknowledge` | Bouton "Acquitter" individuel |
| `features/users/users-list.component.ts` | 29 | `users_manage` | Bouton "Ajouter" utilisateur |
| `features/users/users-list.component.ts` | 42 | `users_manage` | CTA creation dans etat vide |
| `features/users/users-list.component.ts` | 75 | `users_manage` | Actions edit/delete par utilisateur |

### 3.2 Gestion UI

**UI de modification des permissions : `apps/web/src/app/features/users/user-drawer.component.ts`**

Le drawer d'edition/creation d'utilisateur contient une section de toggles pour chaque permission. Fonctionnement :

- A la creation : les permissions par defaut du role selectionne sont chargees (objet `ROLE_DEFAULTS` duplique cote frontend)
- A l'edition : les permissions existantes de l'utilisateur sont chargees depuis l'API
- Quand le role change : les permissions sont reinitalisees aux defaults du nouveau role
- Chaque permission est un toggle boolean (checkbox/switch)
- A la sauvegarde : le PATCH envoie `{ permissions: { ... } }` si le role n'a pas change, sinon le backend reinitialise automatiquement

**Duplication des defaults :**
```typescript
// Frontend : user-drawer.component.ts:23-26
const ROLE_DEFAULTS: Record<string, Record<string, boolean>> = {
  VIEWER: { vehicles_view: true, vehicles_create: false, ... },
  FLEET_MANAGER: { vehicles_view: true, vehicles_create: true, ... },
};
```
Ces valeurs sont dupliquees par rapport a `apps/api/src/users/default-permissions.ts`. Pas de source partagee.

---

## 4. Donnees reelles en base

*Inspection base non realisee, a faire manuellement.*

Commande a executer :
```sql
SELECT id, email, role, permissions FROM users WHERE permissions IS NOT NULL LIMIT 10;
```

Pour une version anonymisee :
```sql
SELECT
  LEFT(id::text, 8) || '...' AS id_prefix,
  role,
  permissions
FROM users
WHERE permissions IS NOT NULL
LIMIT 10;
```

---

## 5. Permissions identifiees

| Cle | Type | Lu dans (frontend) | Ecrit dans (backend) | Default VIEWER | Default FLEET_MANAGER |
|---|---|---|---|---|---|
| `vehicles_view` | bool | `vehicles-list` | `default-permissions.ts` | `true` | `true` |
| `vehicles_create` | bool | `vehicles-list` | `default-permissions.ts` | `false` | `true` |
| `vehicles_edit` | bool | `vehicles-list` | `default-permissions.ts` | `false` | `true` |
| `vehicles_delete` | bool | `vehicles-list` | `default-permissions.ts` | `false` | `true` |
| `groups_view` | bool | `vehicles-list` | `default-permissions.ts` | `false` | `true` |
| `groups_manage` | bool | *non utilise dans template* | `default-permissions.ts` | `false` | `true` |
| `geofences_view` | bool | *non utilise dans template* | `default-permissions.ts` | `true` | `true` |
| `geofences_manage` | bool | `geofences-list` | `default-permissions.ts` | `false` | `true` |
| `alerts_view` | bool | *non utilise dans template* | `default-permissions.ts` | `true` | `true` |
| `alerts_acknowledge` | bool | `alerts` | `default-permissions.ts` | `false` | `true` |
| `reports_view` | bool | *non utilise dans template* | `default-permissions.ts` | `true` | `true` |
| `users_view` | bool | `dashboard-layout` (sidebar) | `default-permissions.ts` | `false` | `false` |
| `users_manage` | bool | `users-list` | `default-permissions.ts` | `false` | `false` |

Notes :
- 4 permissions (`geofences_view`, `alerts_view`, `reports_view`, `groups_manage`) sont definies et stockees mais **jamais lues cote frontend** via `can()`. L'acces aux routes correspondantes est gere par le guard `authGuard` (tous les roles authentifies) + `@Roles()` cote backend.
- `users_view` et `users_manage` sont `false` pour les deux roles (VIEWER et FLEET_MANAGER), ce qui signifie que seuls FLEET_ADMIN et SUPER_ADMIN (bypass) voient la section Utilisateurs.

---

## 6. Roles vs Permissions

**Architecture actuelle : roles = autorisation backend, permissions = personnalisation UI**

Le systeme est **bicouche** :

1. **`UserRole` (enum)** — Controle d'acces backend. Le `RolesGuard` verifie le role sur chaque endpoint via `@Roles(...)`. C'est le seul mecanisme d'autorisation effectif.

2. **`permissions` (JSON)** — Controle d'affichage frontend uniquement. Le `PermissionsService.can()` cote Angular masque/affiche des boutons et sections. **Il n'y a aucune verification backend des permissions JSON.** Un utilisateur VIEWER avec `vehicles_delete: false` ne verra pas le bouton supprimer dans l'UI, mais s'il forge une requete DELETE `/api/vehicles/:id`, le backend repondra 403 via `@Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)` — le rejet est base sur le role, pas sur les permissions.

**Resolution :**
- SUPER_ADMIN et FLEET_ADMIN : bypass total (`can()` retourne toujours `true`)
- FLEET_MANAGER et VIEWER : `permissions[key] === true` pour chaque cle
- Pas de logique `permissions.canX ?? defaultForRole(role)`. Les defaults sont **ecrits en base** a la creation de l'utilisateur, pas resolus dynamiquement.

**Consequence :** modifier un default dans `default-permissions.ts` n'affecte **que les nouveaux utilisateurs**. Les utilisateurs existants conservent leurs permissions figees en base.

---

## 7. Recommandation d'extension

### 7.1 Interface TypeScript

Etendre `UserPermissions` dans `apps/api/src/users/default-permissions.ts` :

```typescript
export interface UserPermissions {
  // --- Existantes ---
  vehicles_view: boolean;
  vehicles_create: boolean;
  vehicles_edit: boolean;
  vehicles_delete: boolean;
  groups_view: boolean;
  groups_manage: boolean;
  geofences_view: boolean;
  geofences_manage: boolean;
  alerts_view: boolean;
  alerts_acknowledge: boolean;
  reports_view: boolean;
  users_view: boolean;
  users_manage: boolean;

  // --- Phase 1 : Vie privee ---
  privacy_view_private_trips: boolean;
  privacy_disable_schedule_in_private_mode: boolean;
}
```

### 7.2 Schema Zod de validation

Actuellement il n'y a pas de validation Zod pour les permissions. Pour l'ajouter :

```typescript
import { z } from 'zod';

export const userPermissionsSchema = z.object({
  vehicles_view: z.boolean(),
  vehicles_create: z.boolean(),
  vehicles_edit: z.boolean(),
  vehicles_delete: z.boolean(),
  groups_view: z.boolean(),
  groups_manage: z.boolean(),
  geofences_view: z.boolean(),
  geofences_manage: z.boolean(),
  alerts_view: z.boolean(),
  alerts_acknowledge: z.boolean(),
  reports_view: z.boolean(),
  users_view: z.boolean(),
  users_manage: z.boolean(),
  privacy_view_private_trips: z.boolean(),
  privacy_disable_schedule_in_private_mode: z.boolean(),
});

export type UserPermissions = z.infer<typeof userPermissionsSchema>;
```

Puis dans `UpdateUserDto`, remplacer `@IsObject()` par un custom validator utilisant ce schema.

### 7.3 Impact sur la migration Prisma

Aucune migration necessaire. Le champ est deja `Json?` (JSONB). L'ajout de nouvelles cles se fait au niveau applicatif.

Toutefois, les utilisateurs existants en base **n'auront pas** les nouvelles cles. Options :
1. **Migration de donnees** (recommande) : script SQL pour ajouter les nouvelles cles avec leurs defaults aux utilisateurs existants :
   ```sql
   UPDATE users
   SET permissions = permissions || '{"privacy_view_private_trips": false, "privacy_disable_schedule_in_private_mode": false}'::jsonb
   WHERE permissions IS NOT NULL;
   ```
2. **Resolution dynamique** : modifier le code pour merger les defaults a la lecture (`{ ...getDefaultPermissions(role), ...storedPermissions }`). Plus robuste mais change la semantique actuelle.

### 7.4 Impact sur le seed

Aucun impact direct. Le seed cree un SUPER_ADMIN sans permissions (null), et SUPER_ADMIN bypass toutes les verifications.

### 7.5 Impact sur les endpoints existants

- **`getDefaultPermissions()`** : ajouter les deux nouvelles cles aux defaults VIEWER et FLEET_MANAGER
- **POST `/api/users`** : aucun changement (utilise deja `getDefaultPermissions()`)
- **PATCH `/api/users/:id`** : aucun changement structurel, mais le `@IsObject()` sur `dto.permissions` ne validera pas les nouvelles cles specifiquement

**Defaults proposes :**
| Permission | VIEWER | FLEET_MANAGER |
|---|---|---|
| `privacy_view_private_trips` | `false` | `false` |
| `privacy_disable_schedule_in_private_mode` | `false` | `false` |

Note : `privacy_view_private_trips` a `false` par defaut pour tous. Seul un FLEET_ADMIN peut l'accorder a un FLEET_MANAGER si besoin. Les VIEWER ne devraient jamais y avoir acces.

**IMPORTANT** : actuellement le backend ne verifie **pas** les permissions JSON. Pour que `privacy_view_private_trips` soit effectif, il faudra ajouter une verification cote backend (dans le service Trips, pas seulement cote UI). C'est un changement de paradigme par rapport a l'existant ou les permissions sont UI-only.

### 7.6 Impact sur le frontend

1. **`ROLE_DEFAULTS` dans `user-drawer.component.ts:23-26`** : ajouter les deux nouvelles cles avec les memes defaults que le backend
2. **Template du drawer** : ajouter deux toggles supplementaires dans la section permissions, idealement dans un groupe "Vie privee" separe
3. **`PermissionsService`** : aucun changement structurel (accepte deja n'importe quelle cle string)
4. **Composants de trajets** : utiliser `perms.can('privacy_view_private_trips')` pour masquer/afficher les trajets prives

---

## 8. Questions ouvertes

1. **Enforcement backend** : les permissions actuelles sont UI-only. Pour `privacy_view_private_trips`, un enforcement backend est indispensable (un VIEWER ne doit pas pouvoir acceder aux trajets prives via l'API meme s'il forge la requete). Cela rompt avec le pattern actuel. Faut-il aussi back-porter l'enforcement pour les 13 permissions existantes, ou seulement pour les nouvelles ?

2. **Utilisateurs existants** : comment traiter les users deja en base qui n'ont pas les nouvelles cles ? La migration SQL (option 7.3.1) est le plus propre, mais si le nombre de clients/flottes est petit, un script seed supplementaire pourrait suffire.

3. **Duplication des defaults** : les defaults sont dupliques entre backend (`default-permissions.ts`) et frontend (`user-drawer.component.ts`). Les nouvelles permissions devront etre ajoutees aux deux endroits. Envisager de deplacer les defaults dans `@vizyo/tracky-shared` pour une source unique.

4. **Scope de `privacy_disable_schedule_in_private_mode`** : cette permission est decrite comme "uniquement activable par un FLEET_ADMIN pour un FLEET_MANAGER". Cela implique une logique de contrainte sur l'UI du drawer (masquer le toggle si le user edite n'est pas FLEET_MANAGER). Le backend devrait-il aussi valider cette contrainte ?

5. **`permissions: null` pour FLEET_ADMIN et SUPER_ADMIN** : les users crees via l'Internal API (provision fleet) et le seed n'ont pas de permissions en base. Le bypass `can()` gere cela cote frontend, mais si on ajoute un enforcement backend, il faut s'assurer que `null` est traite comme "all permissions granted" pour ces roles.

6. **FLEET_ADMIN sans permissions explicites** : `getDefaultPermissions()` retourne les defaults FLEET_MANAGER pour les roles non-VIEWER (y compris FLEET_ADMIN/SUPER_ADMIN via le `default` du switch). Si un FLEET_ADMIN est cree via le endpoint normal (pas Internal), il aura des permissions FLEET_MANAGER en base. Sans consequence actuelle (bypass), mais ambigu.

7. **`groups_manage`** : cette permission est definie et stockee mais le template frontend n'utilise jamais `perms.can('groups_manage')` — les boutons de gestion des groupes sont probablement toujours visibles ou caches par un autre mecanisme. A verifier si c'est un oubli ou intentionnel.

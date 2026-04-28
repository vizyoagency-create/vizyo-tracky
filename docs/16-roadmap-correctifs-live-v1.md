# 16 — Roadmap correctifs LIVE V1 (ACC + marker zoom + tracking présence)

> **Statut :** 🔴 À implémenter — issue terrain remontée le 2026-04-28
> **Auteur :** Younes (super-admin) — vehicule FL 787 KV testé en condition réelle
> **Pré-requis :** Sprints H1/H3 livrés (sampling adaptatif + fix mode), V1.6 livré
> **Branche cible :** `main` (correctif urgent — l'app n'est pas utilisable sans)

---

## 0. Synthèse des bugs

| # | Symptôme observé | Cause racine | Sévérité |
|---|------------------|--------------|----------|
| 1 | Modal popup affiche **"Rallumer le moteur"** alors que le véhicule roule à 121 km/h, badge "Contact OFF" affiché en permanence | Le tracker Coban n'a pas le fil ACC connecté. Le boîtier remonte `ignition=undefined`, le serveur fallback à `false`, le front affiche le bouton restore | 🔴 Bloquant |
| 2 | Le marker du véhicule **glisse / dérive visuellement** quand l'utilisateur zoome ou dézoome | `applyClusterVisibility` câblé sur `'zoom'` (continu, 60Hz pendant le geste) toggle la classe `.tracky-marker--mini` qui anime `width/height` (transition CSS 200ms). MapLibre calcule `translate(-50%, -50%)` sur la box DOM, donc le centre apparent dérive pendant l'animation | 🟠 Majeur |
| 3 | "La localisation n'est pas instantanée" + page **Commandes tracker** ne montre pas à quel boîtier la commande est envoyée | (a) Coban-403D émet ~1 trame / 30s, masqué par interpolation client 28s. (b) `list()` côté API ne joint pas `tracker.imei`/`vehicle.plate`. (c) Le pilotage adaptatif `fix...***n` ne tient pas compte de la **présence d'un utilisateur connecté** | 🟡 UX |

---

## 1. Bug 1 — ACC non connecté + bouton "Rallumer" parasite

### 1.1 Diagnostic technique

**Pipeline du bug :**

1. Trame Coban arrive sans bit ACC ni alarme `acc_on`/`acc_off` → [`positions.service.ts:59`](apps/api/src/positions/positions.service.ts:59) laisse `resolvedIgnition = undefined`.
2. [`positions.service.ts:263`](apps/api/src/positions/positions.service.ts:263) :
   ```ts
   const ignitionValue = resolvedIgnition ?? tracker.lastKnownIgnition ?? false;
   ```
   `lastKnownIgnition` reste `null` (jamais reçu de signal ACC), donc fallback sur `false`.
3. WS pousse `ignition: false` → [`map.component.ts:2548`](apps/web/src/app/features/map/map.component.ts:2548) affiche "Rallumer le moteur".
4. [`engine-control-button.component.ts:114`](apps/web/src/app/features/engine-control/engine-control-button.component.ts:114) — `isCutActive` peut renvoyer `true` si une vieille commande CUT existe sans RESTORE → bouton "Rallumer" affiché en permanence.

### 1.2 Solution

#### 1.2.1 Migration DB — flag `accConnected` sur `Tracker`

**Fichier :** `apps/api/prisma/schema.prisma`

```prisma
model Tracker {
  // ... champs existants
  /// V1.7 — Indique si le fil ACC du boitier (jaune) est physiquement connecte
  /// au +12V apres contact. Si false, le serveur infere `ignition` depuis la
  /// vitesse (>3 km/h => ON). Reglable par SUPER_ADMIN uniquement depuis la
  /// fiche vehicule. Default true (cas le plus courant en flotte pro).
  accConnected         Boolean   @default(true)
}
```

**Fichier :** `apps/api/prisma/migrations/20260428100000_v17_acc_connected/migration.sql`

```sql
-- V1.7 — Flag installation matérielle : fil ACC du tracker connecte ou non.
ALTER TABLE "trackers"
  ADD COLUMN "accConnected" BOOLEAN NOT NULL DEFAULT true;

-- Backfill : pour les trackers existants dont on ne sait pas si l'ACC est
-- branche, on suppose true (cas standard). Le SUPER_ADMIN ajustera au besoin.
COMMENT ON COLUMN "trackers"."accConnected" IS
  'true = fil ACC jaune connecte au +12V apres contact. false = ACC non cable, ignition inferee depuis la vitesse.';
```

#### 1.2.2 Heuristique vitesse côté backend

**Fichier :** `apps/api/src/positions/positions.service.ts`

Remplacer le bloc de résolution d'`ignition` (lignes 58-94) par :

```ts
// V1.7 — Resolution ignition avec heuristique vitesse pour les trackers
// dont le fil ACC n'est pas connecte (Tracker.accConnected = false).
let resolvedIgnition: boolean | undefined = frame.ignition;
if (resolvedIgnition === undefined) {
  if (frame.alarm === 'acc_on') resolvedIgnition = true;
  else if (frame.alarm === 'acc_off') resolvedIgnition = false;
}

// Heuristique vitesse : si pas de signal ACC fiable, inferer depuis la vitesse.
// Seuil 3 km/h aligne avec PositionSamplingService.MOVING_SPEED_KMH pour
// garder la coherence avec la classification d'etat (MOVING / IDLE / STOPPED).
let ignitionInferredFromSpeed = false;
if (!tracker.accConnected) {
  // ACC non connecte : la vitesse est la seule source de verite.
  if (frame.speedKph > 3) {
    resolvedIgnition = true;
    ignitionInferredFromSpeed = true;
  }
  // Si vitesse <= 3 km/h, on garde l'etat precedent (lastKnownIgnition).
  // Le passage a OFF se fait via timeout (cf. cron 1.2.5 plus bas).
}
```

**Et dans le bloc de fallback final (ligne 263) :**

```ts
const ignitionValue = resolvedIgnition
  ?? tracker.lastKnownIgnition
  ?? false;
```

Reste identique — la nouvelle logique alimente `resolvedIgnition` correctement.

#### 1.2.3 Cron : éteindre l'ignition inférée après 5 min sans mouvement

**Nouveau fichier :** `apps/api/src/positions/ignition-inferred-cleanup.service.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

const INFERRED_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * V1.7 — Pour les trackers `accConnected = false`, on infere `ignition = true`
 * tant que la vitesse > 3 km/h. A l'arret, sans signal ACC physique, il faut
 * un timeout pour repasser a `ignition = false` (sinon le marker reste vert
 * indefiniment quand le vehicule est gare).
 *
 * Tick chaque minute : si lastKnownIgnition === true, accConnected === false,
 * et lastValidFrameAt > 5min, on bascule a false et on broadcast.
 */
@Injectable()
export class IgnitionInferredCleanupService {
  private readonly logger = new Logger(IgnitionInferredCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    const cutoff = new Date(Date.now() - INFERRED_TIMEOUT_MS);
    const stale = await this.prisma.tracker.findMany({
      where: {
        accConnected: false,
        lastKnownIgnition: true,
        lastValidFrameAt: { lt: cutoff },
      },
      include: { vehicle: true },
    });

    for (const t of stale) {
      await this.prisma.tracker.update({
        where: { id: t.id },
        data: {
          lastKnownIgnition: false,
          lastIgnition: false,
          lastIgnitionChangeAt: new Date(),
        },
      });

      if (t.vehicle && t.lastLat != null && t.lastLng != null) {
        this.gateway.broadcastPosition(t.vehicle.fleetId, {
          trackerId: t.id,
          vehicleId: t.vehicle.id,
          fleetId: t.vehicle.fleetId,
          lat: t.lastLat,
          lng: t.lastLng,
          speedKmh: t.lastSpeedKmh ?? 0,
          heading: t.lastHeading ?? 0,
          timestamp: (t.lastPositionAt ?? new Date()).toISOString(),
          ignition: false,
          valid: t.lastValid ?? true,
        });
      }
      this.logger.log(`Tracker ${t.imei} (no ACC) : ignition timeout 5min, set to false`);
    }
  }
}
```

À déclarer dans `positions.module.ts` (provider).

#### 1.2.4 Endpoint SUPER_ADMIN pour toggle `accConnected`

**Fichier :** `apps/api/src/trackers/dto/update-tracker.dto.ts`

```ts
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateTrackerDto {
  @IsOptional()
  @IsString()
  model?: string;

  /** V1.7 — toggle SUPER_ADMIN : indique si le fil ACC est physiquement connecte. */
  @IsOptional()
  @IsBoolean()
  accConnected?: boolean;
}
```

**Fichier :** `apps/api/src/trackers/trackers.service.ts` — méthode `update`

Ajouter une garde role :

```ts
async update(id: string, dto: UpdateTrackerDto, requestedBy: RequestedBy): Promise<Tracker> {
  // ... checks existants

  // V1.7 — accConnected modifiable UNIQUEMENT par SUPER_ADMIN (responsabilite
  // installation hardware, decision a fort impact sur la fiabilite ignition).
  if (dto.accConnected !== undefined && requestedBy.role !== UserRole.SUPER_ADMIN) {
    throw new ForbiddenException('accConnected reserve au SUPER_ADMIN');
  }

  return this.prisma.tracker.update({
    where: { id },
    data: dto,
  });
}
```

#### 1.2.5 Frontend — toggle dans la fiche véhicule

**Fichier :** `apps/web/src/app/features/vehicles/vehicle-detail.component.ts`

Ajouter une carte visible **uniquement** pour SUPER_ADMIN, dans l'onglet "Configuration" ou en haut de la fiche :

```html
@if (auth.user()?.role === 'SUPER_ADMIN' && v.tracker) {
  <div class="vd-admin-card">
    <div class="vd-admin-card-header">
      <lucide-icon [img]="ShieldAlert" [size]="14" />
      <span>Réglage matériel (super-admin)</span>
    </div>
    <label class="vd-admin-toggle">
      <input
        type="checkbox"
        [checked]="v.tracker.accConnected"
        (change)="toggleAccConnected(v.tracker.id, $event)"
      />
      <span class="vd-admin-toggle-text">
        <strong>Fil ACC connecté</strong>
        <small>
          Le fil jaune (ACC) du tracker est branché au +12V après contact.
          Décocher si l'installation n'a pas câblé l'ACC — l'ignition sera
          alors inférée depuis la vitesse GPS (seuil 3 km/h).
        </small>
      </span>
    </label>
    @if (!v.tracker.accConnected) {
      <div class="vd-admin-warning">
        <lucide-icon [img]="AlertTriangle" [size]="12" />
        Mode dégradé actif : ignition basée sur la vitesse, fiabilité réduite à l'arrêt.
      </div>
    }
  </div>
}
```

**Méthode :**

```ts
async toggleAccConnected(trackerId: string, ev: Event): Promise<void> {
  const checked = (ev.target as HTMLInputElement).checked;
  const ok = window.confirm(
    checked
      ? 'Confirmer que le fil ACC est connecté ?\n\nL\'ignition sera lue depuis le boîtier (fiable).'
      : 'Confirmer que le fil ACC n\'est PAS connecté ?\n\nL\'ignition sera inférée depuis la vitesse (mode dégradé).',
  );
  if (!ok) {
    (ev.target as HTMLInputElement).checked = !checked;
    return;
  }
  try {
    await firstValueFrom(this.trackersApi.update(trackerId, { accConnected: checked }));
    this.toast.success('Configuration ACC mise à jour');
    await this.reload();
  } catch (e) {
    this.toast.error('Échec mise à jour', extractError(e));
    (ev.target as HTMLInputElement).checked = !checked;
  }
}
```

**Service à étendre :** `apps/web/src/app/core/services/trackers.service.ts` (créer si absent ou ajouter méthode `update`).

#### 1.2.6 Frontend — masquer le bouton "Rallumer" tant qu'il n'y a pas eu de CUT effective

**Fichier :** `apps/web/src/app/features/map/map.component.ts` — `buildPopupHtml` (ligne 2541+)

Logique actuelle : un bouton est toujours affiché (cut OU restore) basé sur `pos.ignition`. **Nouvelle règle :**

- Si une commande **CUT effective** est connue (via `realtime.engineCommandUpdates` OU `recentCommands`) **ET pas de RESTORE postérieure** → afficher "Rallumer".
- Sinon → afficher "Couper" (toujours, parce qu'on ne sait pas si l'ignition est fiable).

```ts
// V1.7 — bouton CUT/RESTORE base sur l'etat des commandes, pas sur ignition.
// Raison : avec accConnected=false, ignition est inferee et peut etre
// transitoirement faux (vehicule gare moteur encore tournant, etc.).
const cutActive = this.isCutActiveForTracker(pos.trackerId);
const engineBtn = cutActive
  ? `<button data-action="restore" ...>Rallumer le moteur</button>`
  : `<button data-action="cut" ...>Couper le moteur</button>`;
```

Avec une nouvelle méthode :

```ts
private isCutActiveForTracker(trackerId: string): boolean {
  const update = this.realtime.engineCommandUpdates().get(trackerId);
  if (!update) return false;
  if (update.status !== 'SENT' && update.status !== 'ACKNOWLEDGED') return false;
  return update.action === 'CUT';
  // RESTORE efface l'entree via le cleanup effect deja en place.
}
```

Et **mêmes modifs** dans [`engine-control-button.component.ts:109-128`](apps/web/src/app/features/engine-control/engine-control-button.component.ts:109) (mobile sheet via `vehicle-detail`) — retirer le fallback `!ign && lastCut` qui assume ignition fiable :

```ts
readonly isCutActive = computed(() => {
  const cmds = this.recentCommands();
  const lastCut = cmds.find(
    (c) => c.action === 'CUT' && (c.status === 'SENT' || c.status === 'ACKNOWLEDGED'),
  );
  const lastRestore = cmds.find(
    (c) => c.action === 'RESTORE' && (c.status === 'SENT' || c.status === 'ACKNOWLEDGED'),
  );
  // Source de verite UNIQUE : l'historique des commandes (pas l'ignition).
  return !!(lastCut && (!lastRestore || new Date(lastCut.createdAt) > new Date(lastRestore.createdAt)));
});
```

#### 1.2.7 Snapshot DTO — exposer `accConnected`

**Fichier :** `packages/shared/src/dto/snapshot.dto.ts`

```ts
export interface VehicleSnapshotDto {
  // ... champs existants
  /** V1.7 — Permet au front de savoir si l'ignition est inferee (mode degrade). */
  accConnected: boolean;
}
```

**Fichier :** `apps/api/src/vehicles/vehicles.service.ts` — `snapshot()` ligne 257+

```ts
return vehicles.map((v) => {
  const t = (v as Vehicle & { tracker: any }).tracker;
  return {
    // ... champs existants
    accConnected: t?.accConnected ?? true,
  };
});
```

### 1.3 Plan de test (à exécuter manuellement après deploy)

| Étape | Action | Résultat attendu |
|-------|--------|------------------|
| T1 | Connexion SUPER_ADMIN, ouvrir fiche véhicule FL 787 KV | Carte "Réglage matériel" visible |
| T2 | Décocher "Fil ACC connecté" + confirmer | Toast "Configuration ACC mise à jour", warning rouge "Mode dégradé actif" |
| T3 | Démarrer le véhicule et rouler à 30+ km/h | Marker passe à vert ; popup affiche "Contact ON" + bouton "Couper le moteur" |
| T4 | S'arrêter (vitesse 0), attendre 5 min | Marker passe à gris ; popup "Contact OFF" + bouton "Couper" (toujours, jamais "Rallumer" sans CUT préalable) |
| T5 | Couper le moteur via le bouton CUT, attendre ACK | Toast "Coupure demandée", commande SENT, ACK reçu, le bouton bascule en "Rallumer" |
| T6 | Rallumer | RESTORE envoyé, retour bouton "Couper" |
| T7 | Cocher à nouveau "Fil ACC connecté" | Comportement standard (lecture du bit ACC du boîtier) |

---

## 2. Bug 2 — Marker qui dérive avec le zoom

### 2.1 Diagnostic technique

**Trois causes cumulées :**

1. [`map.component.ts:1486`](apps/web/src/app/features/map/map.component.ts:1486) — `applyClusterVisibility` est attaché à `'zoom'`, qui fire **en continu pendant le geste utilisateur** (jusqu'à 60Hz).
2. [`map.component.ts:1647`](apps/web/src/app/features/map/map.component.ts:1647) — toggle `.tracky-marker--mini` à chaque appel.
3. [`styles.css:380`](apps/web/src/styles.css:380) — `transition: width 200ms, height 200ms` anime la box DOM. MapLibre positionne le marker via `transform: translate(-50%, -50%)` calculé sur la box, donc le centre apparent dérive pendant l'animation. Pas d'hystérésis autour de `z=10`.

### 2.2 Solution

#### 2.2.1 CSS — utiliser `transform: scale()` au lieu de `width/height`

**Fichier :** `apps/web/src/styles.css` ligne 376+

Remplacer :

```css
/* Mode mini (vue d'ensemble, zoom faible) — petit point colore, toujours visible */
.tracky-marker--mini {
  width: 18px;
  height: 18px;
  transition: width 200ms ease, height 200ms ease;
}
```

Par :

```css
/* V1.7 — Mode mini : on ne touche PAS aux dimensions (sinon MapLibre recalcule
 * le centre via translate(-50%,-50%) et le marker derive pendant l'animation).
 * On scale visuellement sans toucher la box layout — le centre reste stable. */
.tracky-marker--mini {
  transform: scale(0.32);
  transition: transform 200ms ease;
  transform-origin: center center;
}
.tracky-marker--mini .tracky-marker__pulse,
.tracky-marker--mini .tracky-marker__heading-ring,
.tracky-marker--mini .tracky-marker__acc,
.tracky-marker--mini .tracky-marker__plate {
  display: none;
}
```

⚠️ MapLibre applique déjà un `transform: translate(...)` sur le wrapper. Pour éviter qu'il soit écrasé par notre `scale`, ajouter sur le wrapper interne :

```css
.tracky-marker--mini .tracky-marker__core {
  /* inchange */
}
```

(le `scale` est sur `.tracky-marker` qui est le `element` passé à `new maplibregl.Marker({element})` — MapLibre wrap dans un `<div class="maplibregl-marker">` parent dont il pilote le `transform`. Notre `scale` sur l'enfant est compatible.)

#### 2.2.2 Event — `zoomend` au lieu de `zoom`

**Fichier :** `apps/web/src/app/features/map/map.component.ts:1486`

```ts
// V1.7 — Avant : 'zoom' fire en continu pendant le geste (60Hz), causait du flicker.
// Apres : 'zoomend' fire une seule fois quand l'utilisateur relache.
this.map.on('zoomend', () => this.applyClusterVisibility());
```

#### 2.2.3 Hystérésis pour éviter le toggling autour de `z=10`

**Fichier :** `apps/web/src/app/features/map/map.component.ts:1642`

```ts
private lastMiniState: boolean | null = null;
private static readonly ZOOM_MINI_ENTER = 9.5;  // dezoom : passe en mini
private static readonly ZOOM_MINI_EXIT  = 10.5; // zoom : repasse en normal

private applyClusterVisibility(): void {
  if (!this.map) return;
  const z = this.map.getZoom();

  // Hysteresis : pas de toggle si on est dans la zone tampon [9.5, 10.5].
  let mini: boolean;
  if (this.lastMiniState === null) {
    mini = z < 10;
  } else if (this.lastMiniState && z > MapComponent.ZOOM_MINI_EXIT) {
    mini = false;
  } else if (!this.lastMiniState && z < MapComponent.ZOOM_MINI_ENTER) {
    mini = true;
  } else {
    mini = this.lastMiniState;
  }

  if (mini === this.lastMiniState) return;
  this.lastMiniState = mini;

  // V1.7 — Si l'utilisateur a desactive le mode compact (toggle calques), on
  // ne passe jamais en mini meme a faible zoom (markers riches partout).
  const useMini = mini && this.compactMarkers();

  document.querySelectorAll('.tracky-marker').forEach((el) => {
    (el as HTMLElement).classList.toggle('tracky-marker--mini', useMini);
  });
  this.setLayerVisibility('vehicles-cluster-bg', useMini);
  this.setLayerVisibility('vehicles-cluster-count', useMini);
  this.setLayerVisibility('vehicles-unclustered', useMini);
}
```

#### 2.2.4 Toggle "Mode compact" dans les Calques

**Fichier :** `apps/web/src/app/features/map/map.component.ts`

Nouveau signal :

```ts
/** V1.7 — Si false, jamais de mode compact meme a faible zoom (markers riches partout). */
protected readonly compactMarkers = signal(true);
```

Dans le panneau Calques (ligne 495+, après "Heatmap densité (24h)") :

```html
<hr class="my-1 border-border-subtle" />
<label class="tracky-sheet-checkbox">
  <input type="checkbox" [checked]="compactMarkers()" (change)="toggleCompactMarkers()" />
  <span>Mode compact (zoom faible)</span>
</label>
```

Méthode :

```ts
protected toggleCompactMarkers(): void {
  const v = !this.compactMarkers();
  this.compactMarkers.set(v);
  this.preferences.update({ map: { ...this.preferences.prefs().map, compactMarkers: v } });
  this.lastMiniState = null; // force recalcul
  this.applyClusterVisibility();
}
```

Et dans `PreferencesService` (ligne 33+ et 60+) :

```ts
map: {
  // ... champs existants
  compactMarkers: boolean;
}
// Default :
map: {
  // ...
  compactMarkers: true,
}
```

### 2.3 Plan de test

| Étape | Action | Résultat attendu |
|-------|--------|------------------|
| T1 | Charger la carte, zoomer sur un véhicule (z=14) | Marker normal (56px), aucune dérive |
| T2 | Dézoomer progressivement jusqu'à z=8 | Marker rétrécit visuellement à z<9.5 (scale), centre **parfaitement stable** sur la position GPS |
| T3 | Rezoomer jusqu'à z=12 | Marker grandit à z>10.5, centre stable |
| T4 | Faire des allers-retours rapides z=9 ↔ z=11 | Pas de flicker, hystérésis empêche le toggling |
| T5 | Décocher "Mode compact (zoom faible)" dans Calques | Le mode mini est désactivé : markers riches même à z=5 |
| T6 | Recocher | Le mode mini reprend à z<9.5 |

---

## 3. Bug 3 — Tracking adaptatif basé sur la présence + page Commandes tracker

### 3.1 Diagnostic

**Frequency réelle :** Le boîtier Coban-403D émet **1 trame toutes les 30s** (mode `fix030s***N`). C'est négocié dynamiquement par le serveur via [`tracker-fix-mode.service.ts:159`](apps/api/src/tracker-fix-mode/tracker-fix-mode.service.ts:159) :

- `MOVING` ou `IDLE_ENGINE_ON` → 30s
- `STOPPED` + ignition OFF > 10 min → 300s

**Limite actuelle :** Le serveur ne sait pas si **un utilisateur est connecté** et regarde la carte. Donc même si personne ne consulte l'app, on garde 30s sur tous les véhicules en mouvement → conso data SIM inutile.

**Page Commandes tracker :** [`admin-commands.component.ts:84-100`](apps/web/src/app/features/tracker-commands/admin-commands.component.ts:84) liste les commandes mais **ne montre ni le tracker ni le véhicule**. L'API [`tracker-commands.service.ts:223`](apps/api/src/tracker-commands/tracker-commands.service.ts:223) ne joint que `requestedByUser`, pas `tracker.imei` ni `tracker.vehicle.plate`.

### 3.2 Solution — Pilotage par présence WS

**Principe :**

- Mode `MOVING` quand un user **est connecté** sur la fleet → **15s** (au lieu de 30s).
- Mode `MOVING` quand **personne** n'est connecté → 30s (économie data, état actuel).
- Mode `IDLE_ENGINE_ON` → 30s dans les deux cas.
- Mode `STOPPED + ignition OFF > 10 min` → 300s dans les deux cas.

#### 3.2.1 Nouveau service `FleetPresenceService`

**Nouveau fichier :** `apps/api/src/realtime/fleet-presence.service.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';

interface PresenceTransition {
  fleetId: string;
  active: boolean; // true = au moins 1 viewer ; false = plus aucun
}

/**
 * V1.7 — Suit la presence des viewers WS par fleetId.
 *
 * Quand un user se connecte au realtime gateway, on incrementre le compteur
 * pour sa fleet. A la deconnexion, on decrementre. Quand le compteur passe
 * 0 -> 1+ ou 1+ -> 0, on emet une transition pour declencher un re-eval du
 * fix mode adaptatif sur tous les trackers de la fleet.
 *
 * SUPER_ADMIN : compte comme viewer sur la wildcard 'fleet:*' — toute
 * connexion super-admin reveille TOUS les trackers en mode 15s.
 */
@Injectable()
export class FleetPresenceService {
  private readonly logger = new Logger(FleetPresenceService.name);
  private readonly counts = new Map<string, number>();
  private superAdminCount = 0;

  readonly transitions$ = new Subject<PresenceTransition>();

  add(fleetId: string | null, isSuperAdmin: boolean): void {
    if (isSuperAdmin) {
      this.superAdminCount += 1;
      if (this.superAdminCount === 1) {
        this.transitions$.next({ fleetId: '*', active: true });
      }
    }
    if (fleetId) {
      const next = (this.counts.get(fleetId) ?? 0) + 1;
      this.counts.set(fleetId, next);
      if (next === 1) {
        this.transitions$.next({ fleetId, active: true });
      }
    }
  }

  remove(fleetId: string | null, isSuperAdmin: boolean): void {
    if (isSuperAdmin) {
      this.superAdminCount = Math.max(0, this.superAdminCount - 1);
      if (this.superAdminCount === 0) {
        this.transitions$.next({ fleetId: '*', active: false });
      }
    }
    if (fleetId) {
      const next = Math.max(0, (this.counts.get(fleetId) ?? 0) - 1);
      if (next === 0) {
        this.counts.delete(fleetId);
        this.transitions$.next({ fleetId, active: false });
      } else {
        this.counts.set(fleetId, next);
      }
    }
  }

  /** True si au moins un user (incluant SUPER_ADMIN) regarde cette fleet. */
  isActive(fleetId: string): boolean {
    if (this.superAdminCount > 0) return true;
    return (this.counts.get(fleetId) ?? 0) > 0;
  }

  snapshot(): { fleetId: string; viewers: number }[] {
    const out = Array.from(this.counts, ([fleetId, viewers]) => ({ fleetId, viewers }));
    if (this.superAdminCount > 0) out.push({ fleetId: '*', viewers: this.superAdminCount });
    return out;
  }
}
```

#### 3.2.2 Câblage dans `RealtimeGateway`

**Fichier :** `apps/api/src/realtime/realtime.gateway.ts`

```ts
constructor(
  private readonly auth: AuthService,
  private readonly presence: FleetPresenceService,
) {}

async handleConnection(client: Socket): Promise<void> {
  try {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) { client.disconnect(); return; }
    const payload = this.auth.verifyAccessToken(token);
    const localUser = await this.auth.resolveLocalUser(payload.sub);

    const isSuperAdmin = localUser.role === 'SUPER_ADMIN';
    if (isSuperAdmin) client.join('fleet:*');
    if (localUser.fleetId) client.join(`fleet:${localUser.fleetId}`);

    // V1.7 — track presence pour piloter le fix mode adaptatif.
    client.data.fleetId = localUser.fleetId;
    client.data.isSuperAdmin = isSuperAdmin;
    this.presence.add(localUser.fleetId, isSuperAdmin);
  } catch (err) {
    client.disconnect();
  }
}

handleDisconnect(client: Socket): void {
  const fleetId = client.data?.fleetId as string | null | undefined;
  const isSuperAdmin = !!client.data?.isSuperAdmin;
  this.presence.remove(fleetId ?? null, isSuperAdmin);
}
```

#### 3.2.3 Modifier `desiredIntervalFor` dans `tracker-fix-mode.service.ts`

**Fichier :** `apps/api/src/tracker-fix-mode/tracker-fix-mode.service.ts:154`

```ts
desiredIntervalFor(
  state: AdaptiveTrackerState,
  tracker: Pick<Tracker, 'lastIgnitionChangeAt' | 'lastKnownIgnition'>,
  fleetId: string | null,
  now: Date = new Date(),
): number {
  const watching = fleetId ? this.presence.isActive(fleetId) : false;

  // V1.7 — quand un user regarde la carte, on serre l'intervalle a 15s sur
  // les vehicules en mouvement pour une UX plus reactive. Sinon on garde
  // 30s (economie data, etat baseline).
  if (state === 'MOVING') return watching ? 15 : 30;
  if (state === 'IDLE_ENGINE_ON') return 30;

  // STOPPED — only switch to 300s if ignition has been OFF for > 10 min.
  const ignitionOffSince = tracker.lastKnownIgnition === false ? tracker.lastIgnitionChangeAt : null;
  if (ignitionOffSince && now.getTime() - ignitionOffSince.getTime() > STOPPED_GRACE_MS) {
    return 300;
  }
  return 30;
}
```

Et **modifier le HARD_CAP_S = 300** + le min `Math.max(30, ...)` ligne 244 pour autoriser 15s :

```ts
private static readonly MIN_INTERVAL_S = 15; // V1.7 (etait 30)
const target = Math.min(Math.max(TrackerFixModeService.MIN_INTERVAL_S, desiredS), HARD_CAP_S);
```

#### 3.2.4 Re-eval sur transition de présence

**Fichier :** `apps/api/src/tracker-fix-mode/tracker-fix-mode.service.ts`

Souscrire au stream `presence.transitions$` et déclencher un re-eval pour chaque tracker actif de la fleet :

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly registry: SocketRegistryService,
  private readonly wireLogger: CobanWireLogger,
  private readonly sms: SmsGatewayService,
  private readonly presence: FleetPresenceService,
) {
  this.presence.transitions$.subscribe((t) => this.onPresenceTransition(t));
}

private async onPresenceTransition({ fleetId, active }: PresenceTransition): Promise<void> {
  // Lister les trackers actifs de la fleet (ou de TOUTES si '*' pour SUPER_ADMIN).
  const where: Prisma.TrackerWhereInput = {
    status: 'ONLINE',
    lastSampledState: 'MOVING', // seul cas affecte par la presence (15s vs 30s)
  };
  if (fleetId !== '*') where.vehicle = { fleetId };

  const trackers = await this.prisma.tracker.findMany({
    where,
    include: { vehicle: { include: { fleet: true } } },
  });

  for (const t of trackers) {
    if (!t.vehicle) continue;
    const desiredS = this.desiredIntervalFor('MOVING', t, t.vehicle.fleetId);
    if (desiredS === t.desiredFixIntervalS) continue;
    await this.requestChange(t as any, desiredS, `PRESENCE_${active ? 'ACTIVE' : 'IDLE'}`, {
      fleetId: t.vehicle.fleetId,
      vehicleId: t.vehicle.id,
      plate: t.vehicle.plate,
      reason: 'presence_transition',
      active,
    }).catch((e) => this.logger.warn(`requestChange failed: ${e.message}`));
  }
}
```

⚠️ **Attention au quota anti-flapping** (ligne 270, max 2 changes/jour) — si on transite souvent, on bloquera le passage 15s↔30s. **Solution :** ajouter une exception pour les changements liés à la présence (réseau de catégorisation distinct dans `TrackerCommand`) ou augmenter le quota à 6/jour.

#### 3.2.5 Page Commandes tracker — ajouter colonnes Tracker / Véhicule

**Fichier :** `apps/api/src/tracker-commands/tracker-commands.service.ts:223`

```ts
return this.prisma.trackerCommand.findMany({
  where,
  orderBy: { createdAt: 'desc' },
  take: limit,
  include: {
    requestedByUser: { select: { email: true, firstName: true, lastName: true } },
    tracker: {
      select: {
        id: true,
        imei: true,
        vehicle: { select: { id: true, plate: true, brand: true, model: true } },
      },
    },
  },
});
```

**Fichier :** `apps/web/src/app/core/services/tracker-commands.service.ts`

```ts
export interface TrackerCommandDto {
  // ... champs existants
  tracker?: {
    id: string;
    imei: string;
    vehicle: { id: string; plate: string; brand: string | null; model: string | null } | null;
  };
}
```

**Fichier :** `apps/web/src/app/features/tracker-commands/admin-commands.component.ts`

Ajouter les colonnes dans le template (après "Date") :

```html
<th class="p-3 text-left">Date</th>
<th class="p-3 text-left">Véhicule</th>
<th class="p-3 text-left">IMEI</th>
<th class="p-3 text-left">Template</th>
...

<!-- dans <tr> -->
<td class="p-3 text-fg-tertiary text-xs">{{ relativeTime(cmd.createdAt) }}</td>
<td class="p-3 text-fg-primary text-xs">
  @if (cmd.tracker?.vehicle?.plate; as plate) {
    <a [routerLink]="['/vehicles', cmd.tracker?.vehicle?.id]" class="text-tracky-light hover:underline">
      {{ plate }}
    </a>
  } @else { — }
</td>
<td class="p-3 font-mono text-xs text-fg-tertiary">
  @if (cmd.tracker?.imei; as imei) {
    {{ imei.slice(0, 4) }}…{{ imei.slice(-4) }}
  } @else { — }
</td>
```

### 3.3 Plan de test

| Étape | Action | Résultat attendu |
|-------|--------|------------------|
| T1 | Aucun user connecté à Tracky, vehicule en mouvement | Tracker reçoit `fix030s***N` (30s) — vérifier dans page Commandes |
| T2 | Connecter SUPER_ADMIN → ouvrir la map | Page Commandes affiche un nouveau `fix015s***N` envoyé au tracker (transition 30→15s, raison `PRESENCE_ACTIVE`) |
| T3 | Vérifier sur le terrain : marker se met à jour ~toutes les 15s au lieu de 30s | OK |
| T4 | Fermer Tracky (déconnexion WS) | Après transition `PRESENCE_IDLE`, page Commandes affiche un `fix030s***N` retour à 30s |
| T5 | Page Commandes tracker : colonnes Véhicule (plaque cliquable) + IMEI tronqué visibles | OK |
| T6 | Cliquer sur la plaque dans une ligne | Redirige vers `/vehicles/:id` |
| T7 | Vehicule à l'arrêt + ignition OFF + > 10 min sans bouger | Tracker reçoit `fix005m***N` (300s) indépendamment de la présence (économie batterie) |

---

## 4. Ordre d'exécution recommandé

| Phase | Lot | Risque | Estimation |
|-------|-----|--------|-----------|
| **P1** | Bug 2 — Marker zoom (CSS + zoomend + hystérésis + toggle Calques) | 🟢 Faible (UI only) | ~1h |
| **P2** | Bug 1 — Schema + heuristique vitesse + endpoint + UI fiche | 🟠 Moyen (migration + nouveau cron) | ~3h |
| **P3** | Bug 1 — Cleanup ignition timeout + bouton CUT/RESTORE basé sur commandes | 🟠 Moyen (logique commande complexe) | ~2h |
| **P4** | Bug 3 — Page Commandes tracker (joins) | 🟢 Faible | ~30min |
| **P5** | Bug 3 — FleetPresenceService + câblage gateway | 🟠 Moyen (nouveau singleton multi-instance) | ~2h |
| **P6** | Bug 3 — Re-eval sur transition + ajustement anti-flapping | 🔴 Risque (peut spam Coban) | ~2h |

**Total estimé :** ~10h dev. Tests manuels sur banc 403D : +2h.

---

## 5. Risques & Garde-fous

### 5.1 Multi-instance API
`FleetPresenceService` est **in-memory par instance**. Si Tracky tourne en multi-instance derrière un load-balancer, chaque instance verra une partie des connexions WS. **Solutions :**

- **Court terme :** vérifier que `pm2 ecosystem` lance une seule instance (cf. `docker-compose.yml`).
- **Long terme :** déplacer le compteur dans Redis avec `INCR fleet:presence:{fleetId}` + TTL.

### 5.2 Quota anti-flapping
Avec le pilotage présence, on peut transiter 30↔15s plusieurs fois par heure si plusieurs users entrent/sortent. Le quota actuel `FLAPPING_MAX_CHANGES = 2` par 24h va bloquer ces transitions. **Solution :**

- Catégoriser les `fix_continuous` commands par raison (`PRESENCE_*` vs `STATE_*`) et appliquer des quotas distincts.
- Ou augmenter le quota global à 8/jour.

### 5.3 Migration `accConnected`
Default `true` pour la rétrocompat. Le SUPER_ADMIN doit décocher manuellement pour les véhicules concernés. **À documenter** dans `12-tracking-adaptatif-runbook.md` après déploiement.

### 5.4 Mode dégradé (ACC non câblé)
L'ignition inférée a une **latence de 5 min** pour passer à OFF (cf. cron 1.2.3). Pour un véhicule qui s'arrête à 0 km/h moteur encore tournant (feu rouge), on garde `ignition=true` pendant 5 min — ce qui est le **bon** comportement (vehicule encore "actif"). Un client qui demande un CUT pendant cette fenêtre verra l'engine-control accepter (vitesse = 0, fix valide).

---

## 6. Checklist de déploiement

- [ ] Migration Prisma générée et testée en dev (`pnpm prisma migrate dev --name v17_acc_connected`)
- [ ] Tests unitaires :
  - `position-sampling.service.spec.ts` : ajouter cas `accConnected=false` + vitesse > 3 km/h
  - `tracker-fix-mode.service.spec.ts` : ajouter cas `presence active` + `MOVING`
  - Nouveau `fleet-presence.service.spec.ts` : ajouter cas multi-fleet + super-admin
- [ ] Tests e2e Playwright : scenarios T1-T7 du Bug 1 et Bug 3
- [ ] Documentation : update `12-tracking-adaptatif-runbook.md` avec les nouveaux modes 15s + accConnected
- [ ] Briefing terrain : informer les installateurs Vizyo qu'ils doivent **systématiquement** câbler le fil ACC sauf cas explicite (ex: véhicule électrique sans +12V après contact)
- [ ] Ajouter au monitoring (Grafana) : compteur de trackers `accConnected=false`, distribution `currentFixIntervalS` par fleet
- [ ] Validation pré-merge : tester sur banc 403D avec **et sans** fil ACC connecté

---

## 7. Annexe — Commande de debug rapide

Pour vérifier en live l'état d'un tracker pendant le test :

```bash
# Via psql sur la VM API
psql $DATABASE_URL -c "
  SELECT
    t.imei,
    v.plate,
    t.\"accConnected\",
    t.\"lastKnownIgnition\",
    t.\"lastSampledState\",
    t.\"desiredFixIntervalS\",
    t.\"currentFixIntervalS\",
    t.\"fixCommandFailing\",
    age(now(), t.\"lastValidFrameAt\") as last_frame_age
  FROM trackers t
  LEFT JOIN vehicles v ON v.id = t.\"vehicleId\"
  WHERE t.imei = '<IMEI>';
"
```

Pour forcer un re-test du fix mode sans attendre :

```bash
# Désactiver l'override admin et forcer le verbose mode
curl -X POST http://localhost:3000/api/admin/sampling/trackers/<trackerId>/verbose \
  -H "Authorization: Bearer $JWT" \
  -d '{"durationMinutes": 30}'
```

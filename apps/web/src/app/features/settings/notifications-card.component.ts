import { Component, computed, inject, type OnInit, signal } from '@angular/core';
import type {
  AlertSeverity,
  AlertType,
  NotificationPreferenceDto,
  UpdateNotificationPreferenceDto,
} from '@vizyo/tracky-shared';
import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  Check,
  ChevronDown,
  Info,
  LucideAngularModule,
  Send,
  Smartphone,
  Trash2,
} from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { NotificationsApiService, type PushSubscriptionDto } from '../../core/services/notifications.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/* ════════════════════════════════════════════════════════════════════════════
   LOGIQUE PURE — testee sans DOM (notifications-card.component.spec.ts).
   Volontairement hors de la classe : c'est cette derivation qui decide ce que
   l'utilisateur comprend de sa situation, elle merite un test, pas un clic.
   ════════════════════════════════════════════════════════════════════════════ */

/** Un type d'alerte tel qu'il est presente a l'utilisateur — jamais l'identifiant brut. */
export interface AlertTypeOption {
  type: AlertType;
  label: string;
}

export interface AlertTypeGroup {
  key: string;
  label: string;
  /** Une phrase, pas un slogan : elle sert a decider si on coupe le groupe entier. */
  hint: string;
  types: AlertTypeOption[];
}

/**
 * Regroupement des 22 types d'alerte en 4 familles.
 *
 * Pourquoi grouper : une liste plate de 22 interrupteurs sur un ecran de telephone est
 * illisible, et l'utilisateur ne reconnait pas `HARSH_BRAKING` ni `MOVEMENT_IDLE`. Les
 * familles suivent la question qu'il se pose reellement (« est-ce grave ? », « est-ce du
 * comportement de conduite ? »), pas l'ordre de l'enum Prisma.
 *
 * `UNKNOWN` est volontairement absent : c'est le repli de typage pour une alerte dont le
 * type n'est pas reconnu, pas une categorie qu'on propose de couper.
 */
export const ALERT_TYPE_GROUPS: readonly AlertTypeGroup[] = [
  {
    key: 'safety',
    label: 'Sécurité & urgence',
    hint: 'Ce qui justifie de sortir le téléphone de sa poche.',
    types: [
      { type: 'SOS', label: 'Appel de détresse (SOS)' },
      { type: 'ACCIDENT', label: 'Accident détecté' },
      { type: 'COLLISION', label: 'Choc / collision' },
      { type: 'POWER_CUT', label: 'Alimentation coupée' },
      { type: 'TOW', label: 'Remorquage / déplacement suspect' },
      { type: 'TAMPER', label: 'Boîtier manipulé' },
      { type: 'ILLEGAL_IGNITION', label: 'Démarrage non autorisé' },
    ],
  },
  {
    key: 'driving',
    label: 'Conduite',
    hint: 'Le comportement au volant. C\'est la famille la plus bavarde.',
    types: [
      { type: 'OVERSPEED', label: 'Excès de vitesse' },
      { type: 'HARSH_BRAKING', label: 'Freinage brusque' },
      { type: 'HARSH_ACCELERATION', label: 'Accélération brusque' },
      { type: 'HARSH_TURN', label: 'Virage brusque' },
      { type: 'FATIGUE', label: 'Conduite prolongée (fatigue)' },
    ],
  },
  {
    key: 'zones',
    label: 'Zones & mouvements',
    hint: 'Où va le véhicule, et quand il bouge sans raison.',
    types: [
      { type: 'GEOFENCE_ENTER', label: 'Entrée dans une zone' },
      { type: 'GEOFENCE_EXIT', label: 'Sortie de zone' },
      { type: 'MOVEMENT_IDLE', label: 'Mouvement moteur éteint' },
      { type: 'IDLE_TIME', label: 'Arrêt prolongé' },
      { type: 'SURVEILLANCE_TRIGGERED', label: 'Surveillance déclenchée' },
      { type: 'VIBRATION', label: 'Vibration détectée' },
    ],
  },
  {
    key: 'device',
    label: 'Véhicule & matériel',
    hint: 'L\'état du véhicule et du boîtier.',
    types: [
      { type: 'LOW_BATTERY', label: 'Batterie faible' },
      { type: 'GPS_LOST', label: 'Signal GPS perdu' },
      { type: 'BONNET', label: 'Capot ouvert' },
      { type: 'DOOR', label: 'Portière ouverte' },
      { type: 'MAINTENANCE_DUE', label: 'Entretien à échéance' },
    ],
  },
];

export interface AlertTypeGroupView extends AlertTypeGroup {
  /** Types du groupe encore actifs (non coupés). */
  activeCount: number;
  total: number;
  /** Vrai si TOUT le groupe est coupé — l'en-tête doit le dire sans avoir à déplier. */
  allMuted: boolean;
  /** Etat par type, prêt pour le template (pas de `.includes()` dans le HTML). */
  items: Array<AlertTypeOption & { enabled: boolean }>;
}

/**
 * Projette les groupes + la liste des types coupés en une vue affichable.
 * `mutedTypes` est la liste des types EXPLICITEMENT coupés : tout type absent est actif.
 */
export function buildGroupViews(
  groups: readonly AlertTypeGroup[],
  mutedTypes: readonly AlertType[],
): AlertTypeGroupView[] {
  const muted = new Set(mutedTypes);
  return groups.map((g) => {
    const items = g.types.map((t) => ({ ...t, enabled: !muted.has(t.type) }));
    const activeCount = items.filter((i) => i.enabled).length;
    return {
      ...g,
      items,
      activeCount,
      total: items.length,
      allMuted: activeCount === 0,
    };
  });
}

/**
 * Ajoute/retire un type de la liste des coupés, sans doublon et sans mutation.
 * `enabled = true` signifie « je veux recevoir ce type » donc on le RETIRE des coupés.
 */
export function toggleMutedType(
  mutedTypes: readonly AlertType[],
  type: AlertType,
  enabled: boolean,
): AlertType[] {
  if (enabled) return mutedTypes.filter((t) => t !== type);
  return mutedTypes.includes(type) ? [...mutedTypes] : [...mutedTypes, type];
}

/** Coupe (ou rallume) un groupe entier d'un seul geste. */
export function setGroupMuted(
  mutedTypes: readonly AlertType[],
  group: AlertTypeGroup,
  enabled: boolean,
): AlertType[] {
  return group.types.reduce<AlertType[]>(
    (acc, t) => toggleMutedType(acc, t.type, enabled),
    [...mutedTypes],
  );
}

export type PushBanner =
  /** Le navigateur ne peut pas recevoir de push (souvent : iOS Safari non installé). */
  | 'unsupported'
  /** VAPID absent côté serveur : demander la permission ne servirait à rien. */
  | 'server-off'
  /** L'utilisateur a refusé — un bouton « Activer » ne peut plus rien y faire. */
  | 'denied'
  /** Tout est possible, il reste à s'abonner sur CET appareil. */
  | 'not-subscribed'
  /** Cet appareil est abonné. */
  | 'active';

export interface PushDeviceState {
  banner: PushBanner;
  /** Vrai seulement si un bouton « Activer » a une chance d'aboutir. */
  canSubscribe: boolean;
  /** Cas iOS Safari non installé : le seul remède est « Ajouter à l'écran d'accueil ». */
  iosNeedsInstall: boolean;
}

/**
 * Décide ce qu'on montre pour l'appareil courant.
 *
 * L'ordre des cas n'est pas arbitraire : on affiche d'abord la cause qui rend les autres
 * sans objet. Proposer « Activer » à quelqu'un sur iOS Safari non installé produit un
 * échec silencieux — c'est précisément la cause classique de « ça ne marche pas ».
 */
export function derivePushDeviceState(input: {
  supported: boolean;
  /** `null` = statut serveur pas encore connu : on n'accuse pas le serveur trop tôt. */
  serverEnabled: boolean | null;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  isIOS: boolean;
  isStandalone: boolean;
}): PushDeviceState {
  const iosNeedsInstall = input.isIOS && !input.isStandalone;
  if (!input.supported) {
    return { banner: 'unsupported', canSubscribe: false, iosNeedsInstall };
  }
  if (input.serverEnabled === false) {
    return { banner: 'server-off', canSubscribe: false, iosNeedsInstall: false };
  }
  if (input.permission === 'denied') {
    return { banner: 'denied', canSubscribe: false, iosNeedsInstall: false };
  }
  if (!input.subscribed) {
    return { banner: 'not-subscribed', canSubscribe: true, iosNeedsInstall: false };
  }
  return { banner: 'active', canSubscribe: false, iosNeedsInstall: false };
}

/**
 * Reconnaît l'appareil courant dans la liste des abonnements.
 *
 * L'API tronque volontairement l'endpoint (il contient un secret) et le suffixe par
 * « ... ». On compare donc sur le préfixe. Sert à marquer « cet appareil » et surtout à
 * savoir qu'une révocation doit aussi désabonner LOCALEMENT — sinon l'écran affiche
 * « actif » alors que le serveur a oublié l'abonnement.
 */
export function isCurrentDeviceEndpoint(
  truncatedEndpoint: string | null | undefined,
  currentEndpoint: string | null | undefined,
): boolean {
  if (!truncatedEndpoint || !currentEndpoint) return false;
  const prefix = truncatedEndpoint.endsWith('...')
    ? truncatedEndpoint.slice(0, -3)
    : truncatedEndpoint;
  // Un préfixe trop court matcherait n'importe quel endpoint du même service push
  // (tous les endpoints FCM commencent pareil) : on exige une longueur significative.
  if (prefix.length < 30) return false;
  return currentEndpoint.startsWith(prefix);
}

/**
 * Ne garde que les abonnements de l'utilisateur COURANT.
 *
 * Le signal `devices` du service est partagé : l'écran Observabilité le remplit parfois
 * avec `scope=all`, c'est-à-dire les appareils de TOUS les comptes, clients compris. Tant
 * que le chargement `mine` de cette carte n'a pas répondu, la liste ci-dessous afficherait
 * donc les appareils d'autres personnes — avec un bouton « Révoquer » à côté, que le
 * backend accepte pour un SUPER_ADMIN. Un aller-retour lent suffit à ouvrir la fenêtre de
 * tir : on filtre ici, le drapeau `isMine` venant du serveur.
 */
export function ownDevices(devices: readonly PushSubscriptionDto[]): PushSubscriptionDto[] {
  return devices.filter((d) => d.isMine);
}

/**
 * Phrase affichée quand CET appareil est abonné : elle doit dire ce qui va réellement
 * arriver, pas ce que l'abonnement rend théoriquement possible.
 *
 * Le bug qu'on répare est né d'un écran qui affirmait « c'est actif » pendant que rien ne
 * partait. Un abonnement valide ne suffit pas : l'interrupteur maître peut être coupé, et
 * le rôle peut ne pas être dans le périmètre de déploiement en cours (`eligible=false`).
 * Dans ces deux cas, promettre une livraison serait rejouer exactement la même erreur.
 *
 * `preferencesUnavailable` est traité à part : le repli local porte `eligible: false` faute
 * d'avoir pu vérifier — ce n'est pas un verdict, et l'annoncer comme tel accuserait à tort
 * le déploiement. Le bandeau « réglages non chargés » dit déjà le nécessaire.
 */
export function activeDeliveryHint(
  pref: Pick<NotificationPreferenceDto, 'pushEnabled' | 'eligible'> | null,
  preferencesUnavailable: boolean,
): string {
  const nominal = 'Les alertes retenues ci-dessous arriveront ici.';
  if (!pref || preferencesUnavailable) return nominal;
  if (!pref.eligible) {
    return 'L\'abonnement est bien enregistré, mais le push n\'est pas encore ouvert à votre rôle : rien n\'arrivera d\'ici là.';
  }
  if (!pref.pushEnabled) {
    return 'L\'abonnement est bien enregistré, mais l\'interrupteur ci-dessous est coupé : rien n\'arrivera.';
  }
  return nominal;
}

export interface SeverityOption {
  value: AlertSeverity;
  label: string;
  hint: string;
}

/**
 * Le seuil est formulé en volume attendu, pas en jargon : « à partir de warning » ne dit
 * rien, « vous recevrez aussi les excès de vitesse » dit tout.
 */
export const SEVERITY_OPTIONS: readonly SeverityOption[] = [
  { value: 'critical', label: 'Critiques uniquement', hint: 'SOS, accident, alimentation coupée. Quelques notifications par semaine.' },
  { value: 'warning', label: 'Critiques et avertissements', hint: 'Ajoute les excès de vitesse et les sorties de zone. Plusieurs par jour.' },
  { value: 'info', label: 'Tout recevoir', hint: 'Y compris les alertes informatives. Volume élevé.' },
];

/* ════════════════════════════════════════════════════════════════════════════ */

/**
 * Carte « Notifications push » des Paramètres.
 *
 * Contexte réel : pendant des mois, aucune notification push n'est partie alors que
 * l'infrastructure (VAPID, abonnements, service worker) fonctionnait — l'aiguillage ne
 * routait rien. Cet écran est la contrepartie visible du correctif : il doit permettre de
 * répondre à « est-ce que je vais recevoir quelque chose, et quoi ? » sans ouvrir un log.
 *
 * Cible prioritaire : PWA installée sur téléphone. Aucun élément en position fixe ici —
 * les zones sûres iOS sont déjà gérées au niveau du conteneur `.content` (styles.css,
 * bloc `body.ios-pwa`) ; y ajouter un padding local produirait un double décalage.
 */
@Component({
  selector: 'app-notifications-card',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="nc-card">
      <div class="nc-head">
        <div class="nc-head-icon"><lucide-icon [img]="BellIcon" [size]="16" /></div>
        <div class="nc-head-text">
          <span class="nc-title">Notifications push</span>
          <span class="nc-sub">Recevez les alertes même quand l'application est fermée.</span>
        </div>
      </div>

      <div class="nc-body">
        <!-- ─── 1. Etat de cet appareil (autorisation navigateur + abonnement) ─── -->
        @if (deviceState().banner === 'unsupported') {
          <div class="nc-state nc-state-off">
            <lucide-icon [img]="BellOffIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Impossible sur cet appareil</p>
              <p class="nc-state-desc">{{ unsupportedReason() }}</p>
            </div>
          </div>
          @if (deviceState().iosNeedsInstall) {
            <div class="nc-ios">
              <p class="nc-ios-title">Sur iPhone et iPad, il faut installer Tracky</p>
              <ol class="nc-ios-steps">
                <li>Ouvrez Tracky dans <b>Safari</b>.</li>
                <li>Touchez <b>Partager</b> (le carré avec une flèche).</li>
                <li>Choisissez <b>Sur l'écran d'accueil</b>.</li>
                <li>Rouvrez Tracky depuis l'icône ainsi créée, puis revenez ici.</li>
              </ol>
              <p class="nc-ios-note">
                Apple ne permet les notifications web que depuis une application installée.
                Tant que Tracky est ouvert dans l'onglet Safari, aucune notification ne peut
                arriver — même autorisation accordée.
              </p>
            </div>
          }
        } @else if (deviceState().banner === 'server-off') {
          <div class="nc-state nc-state-off">
            <lucide-icon [img]="AlertIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Push indisponible</p>
              <p class="nc-state-desc">
                Le service d'envoi n'est pas activé côté serveur. Vos réglages ci-dessous sont
                conservés et s'appliqueront dès sa remise en service.
              </p>
            </div>
          </div>
        } @else if (deviceState().banner === 'denied') {
          <div class="nc-state nc-state-warn">
            <lucide-icon [img]="BellOffIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Autorisation refusée</p>
              <p class="nc-state-desc">
                Vous avez refusé les notifications pour Tracky. Le navigateur ne redemandera
                plus : réautorisez-les dans ses réglages de site, puis revenez sur cette page.
              </p>
            </div>
          </div>
        } @else if (deviceState().banner === 'not-subscribed') {
          <div class="nc-state nc-state-off">
            <lucide-icon [img]="BellOffIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Pas encore activé sur cet appareil</p>
              <p class="nc-state-desc">Une autorisation vous sera demandée par le navigateur.</p>
            </div>
          </div>
          <button type="button" class="nc-btn nc-btn-primary" [disabled]="busyDevice()" (click)="enable()">
            {{ busyDevice() ? 'Activation…' : 'Activer sur cet appareil' }}
          </button>
        } @else {
          <div class="nc-state nc-state-on">
            <lucide-icon [img]="BellRingIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Actif sur cet appareil</p>
              <!-- « Abonné » n'est pas « vous recevrez » : cf. activeDeliveryHint(). -->
              <p class="nc-state-desc">{{ deliveryHint() }}</p>
            </div>
          </div>
          <button type="button" class="nc-btn nc-btn-ghost" [disabled]="busyDevice()" (click)="disable()">
            Désactiver sur cet appareil
          </button>
        }

        <!-- ─── 2. Avertissements de portee (deploiement / serveur injoignable) ─── -->
        @if (prefsUnavailable()) {
          <p class="nc-notice nc-notice-warn">
            <lucide-icon [img]="AlertIcon" [size]="13" />
            Vos réglages n'ont pas pu être chargés. Les valeurs affichées sont celles par
            défaut et ne sont pas enregistrées tant que le serveur ne répond pas.
          </p>
        } @else if (pref() && !pref()!.eligible) {
          <p class="nc-notice">
            <lucide-icon [img]="InfoIcon" [size]="13" />
            Le push n'est pas encore ouvert à votre rôle. Vous pouvez préparer vos réglages
            dès maintenant : ils seront appliqués tels quels à l'ouverture.
          </p>
        } @else if (pref()?.isDefault) {
          <p class="nc-notice">
            <lucide-icon [img]="InfoIcon" [size]="13" />
            Réglage par défaut : seules les alertes critiques vous sont envoyées. Élargissez
            le seuil ci-dessous si vous en voulez davantage.
          </p>
        }

        @if (pref(); as p) {
          <!-- ─── 3. Interrupteur MAITRE ─── -->
          <div class="nc-row nc-row-master">
            <div class="nc-row-text">
              <p class="nc-row-title">Recevoir les notifications</p>
              <p class="nc-row-desc">Coupe tout, sans perdre les réglages ci-dessous.</p>
            </div>
            <label class="nc-toggle">
              <input
                type="checkbox"
                [checked]="p.pushEnabled"
                [disabled]="saving()"
                (change)="setPushEnabled($any($event.target).checked)"
                aria-label="Recevoir les notifications push"
              />
              <span class="nc-track"><span class="nc-thumb"></span></span>
            </label>
          </div>

          <!-- ─── 4. Seuil de severite ─── -->
          <div class="nc-block" [class.nc-dimmed]="!p.pushEnabled">
            <p class="nc-block-title">À partir de quelle gravité ?</p>
            <div class="nc-sev" role="radiogroup" aria-label="Gravité minimale">
              @for (opt of severityOptions; track opt.value) {
                <button
                  type="button"
                  role="radio"
                  class="nc-sev-opt"
                  [class.active]="p.minSeverity === opt.value"
                  [attr.aria-checked]="p.minSeverity === opt.value"
                  [disabled]="saving()"
                  (click)="setMinSeverity(opt.value)"
                >
                  <span class="nc-sev-mark">
                    @if (p.minSeverity === opt.value) { <lucide-icon [img]="CheckIcon" [size]="13" /> }
                  </span>
                  <span class="nc-sev-text">
                    <span class="nc-sev-label">{{ opt.label }}</span>
                    <span class="nc-sev-hint">{{ opt.hint }}</span>
                  </span>
                </button>
              }
            </div>
          </div>

          <!-- ─── 5. Types d'alerte, par famille ─── -->
          <div class="nc-block" [class.nc-dimmed]="!p.pushEnabled">
            <p class="nc-block-title">Quelles alertes ?</p>
            @for (g of groups(); track g.key) {
              <div class="nc-group">
                <button type="button" class="nc-group-head" (click)="toggleOpen(g.key)" [attr.aria-expanded]="isOpen(g.key)">
                  <span class="nc-group-text">
                    <span class="nc-group-label">{{ g.label }}</span>
                    <span class="nc-group-count" [class.off]="g.allMuted">
                      {{ g.allMuted ? 'tout coupé' : g.activeCount + ' sur ' + g.total }}
                    </span>
                  </span>
                  <span class="nc-chevron" [class.open]="isOpen(g.key)">
                    <lucide-icon [img]="ChevronIcon" [size]="16" />
                  </span>
                </button>
                @if (isOpen(g.key)) {
                  <p class="nc-group-hint">{{ g.hint }}</p>
                  <button
                    type="button"
                    class="nc-group-all"
                    [disabled]="saving()"
                    (click)="setGroup(g, g.allMuted)"
                  >
                    {{ g.allMuted ? 'Tout réactiver' : 'Tout couper' }}
                  </button>
                  @for (item of g.items; track item.type) {
                    <div class="nc-row">
                      <div class="nc-row-text">
                        <p class="nc-row-title">{{ item.label }}</p>
                      </div>
                      <label class="nc-toggle">
                        <input
                          type="checkbox"
                          [checked]="item.enabled"
                          [disabled]="saving()"
                          (change)="setType(item.type, $any($event.target).checked)"
                          [attr.aria-label]="item.label"
                        />
                        <span class="nc-track"><span class="nc-thumb"></span></span>
                      </label>
                    </div>
                  }
                }
              </div>
            }
          </div>
        }

        <!-- ─── 6. Appareils abonnes ─── -->
        <div class="nc-block">
          <p class="nc-block-title">Appareils abonnés</p>
          @if (devices().length === 0) {
            <p class="nc-empty">Aucun appareil abonné pour l'instant.</p>
          } @else {
            @for (d of devices(); track d.id) {
              <div class="nc-device">
                <div class="nc-device-icon"><lucide-icon [img]="PhoneIcon" [size]="15" /></div>
                <div class="nc-device-text">
                  <p class="nc-device-name">
                    {{ deviceLabel(d) }}
                    @if (isThisDevice(d)) { <span class="nc-badge">cet appareil</span> }
                  </p>
                  <p class="nc-device-meta">{{ d.endpointHost }} · vu le {{ shortDate(d.lastSeenAt) }}</p>
                </div>
                <button
                  type="button"
                  class="nc-icon-btn"
                  [disabled]="revoking() === d.id"
                  (click)="revoke(d)"
                  [attr.aria-label]="'Révoquer ' + deviceLabel(d)"
                >
                  <lucide-icon [img]="TrashIcon" [size]="16" />
                </button>
              </div>
            }
          }
        </div>

        <!-- ─── 7. Notification de test ───
             L'endpoint POST /notifications/test est reserve aux SUPER_ADMIN et exige un
             abonnement existant. On n'affiche donc le bouton que dans ce cas : proposer un
             bouton qui repondra 403 ou 400 est exactement le genre d'echec silencieux
             qu'on essaie de supprimer. -->
        @if (canTest()) {
          <div class="nc-block">
            <p class="nc-block-title">Vérifier que ça arrive</p>
            <p class="nc-block-desc">
              Envoie une notification de test à vos appareils abonnés. Elle ignore les réglages
              ci-dessus : c'est un test de la chaîne d'envoi, pas du filtrage.
            </p>
            <button type="button" class="nc-btn nc-btn-primary" [disabled]="testing()" (click)="sendTest()">
              <lucide-icon [img]="SendIcon" [size]="15" />
              {{ testing() ? 'Envoi…' : 'Envoyer une notification de test' }}
            </button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      /* Mobile d'abord : toutes les cibles tactiles font au moins 44px, aucun etat
         accessible uniquement au survol, aucune ligne horizontale a faire defiler. */
      .nc-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden; }
      .nc-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
      .nc-head-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: color-mix(in srgb, var(--tracky) 12%, transparent); color: var(--tracky-light); }
      .nc-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .nc-title { font-size: 13px; font-weight: 700; color: var(--fg-primary); }
      .nc-sub { font-size: 11px; color: var(--fg-tertiary); }
      .nc-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

      /* Etat de l'appareil */
      .nc-state { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
      .nc-state lucide-icon { flex-shrink: 0; margin-top: 1px; }
      .nc-state-text { min-width: 0; }
      .nc-state-title { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); margin: 0 0 2px; }
      .nc-state-desc { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0; }
      .nc-state-on { border-color: color-mix(in srgb, var(--tracky) 35%, var(--border-subtle)); }
      .nc-state-on lucide-icon { color: var(--tracky-light); }
      .nc-state-warn { border-color: color-mix(in srgb, #f59e0b 35%, var(--border-subtle)); }
      .nc-state-warn lucide-icon { color: #f59e0b; }
      .nc-state-off lucide-icon { color: var(--fg-tertiary); }

      /* Mode d'emploi iOS — la cause n°1 de « je ne recois rien » */
      .nc-ios { padding: 12px 14px; border-radius: 12px; background: var(--bg-tertiary); border: 1px dashed var(--border-strong, var(--border-subtle)); }
      .nc-ios-title { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); margin: 0 0 8px; }
      .nc-ios-steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
      .nc-ios-steps li { font-size: 11.5px; color: var(--fg-secondary); line-height: 1.5; }
      .nc-ios-note { font-size: 11px; color: var(--fg-tertiary); line-height: 1.5; margin: 10px 0 0; }

      .nc-notice { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0; }
      .nc-notice lucide-icon { flex-shrink: 0; margin-top: 2px; }
      .nc-notice-warn { color: #f59e0b; }

      /* Blocs */
      .nc-block { border-top: 1px solid var(--border-subtle); padding-top: 14px; }
      .nc-block-title { font-size: 12px; font-weight: 700; color: var(--fg-primary); margin: 0 0 4px; }
      .nc-block-desc { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0 0 10px; }
      /* Volontairement pas de champs desactives : l'interrupteur maitre coupe l'envoi,
         il ne doit pas empecher de preparer ses reglages. On attenue seulement. */
      .nc-dimmed { opacity: .55; }

      /* Lignes a interrupteur — 48px minimum de hauteur tactile */
      .nc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 6px 0; }
      .nc-row-master { padding: 12px 14px; border-radius: 12px; background: var(--bg-tertiary); }
      .nc-row-text { flex: 1; min-width: 0; }
      .nc-row-title { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); margin: 0; }
      .nc-row-desc { font-size: 11px; color: var(--fg-tertiary); margin: 2px 0 0; line-height: 1.45; }

      .nc-toggle { position: relative; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; width: 52px; height: 44px; }
      .nc-toggle input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
      .nc-track { width: 46px; height: 26px; border-radius: 9999px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); transition: background .2s; position: relative; display: inline-block; pointer-events: none; }
      .nc-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .2s; }
      .nc-toggle input:checked + .nc-track { background: var(--tracky); border-color: var(--tracky); }
      .nc-toggle input:checked + .nc-track .nc-thumb { left: 22px; }
      .nc-toggle input:disabled + .nc-track { opacity: .5; }
      .nc-toggle input:focus-visible + .nc-track { outline: 2px solid var(--tracky-light); outline-offset: 2px; }

      /* Seuil de severite — 3 lignes empilees, lisibles au pouce */
      .nc-sev { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
      .nc-sev-opt { display: flex; align-items: flex-start; gap: 10px; width: 100%; min-height: 52px; padding: 11px 13px; border-radius: 12px; border: 1px solid var(--border-subtle); background: var(--bg-tertiary); text-align: left; cursor: pointer; }
      .nc-sev-opt.active { border-color: var(--tracky); background: color-mix(in srgb, var(--tracky) 10%, var(--bg-tertiary)); }
      .nc-sev-opt:disabled { opacity: .6; cursor: default; }
      .nc-sev-mark { flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; border: 1.5px solid var(--border-strong, var(--border-subtle)); display: flex; align-items: center; justify-content: center; color: var(--accent-ink, #06281f); }
      .nc-sev-opt.active .nc-sev-mark { background: var(--tracky); border-color: var(--tracky); }
      .nc-sev-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .nc-sev-label { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
      .nc-sev-hint { font-size: 11px; color: var(--fg-tertiary); line-height: 1.45; }

      /* Familles de types */
      .nc-group { border-top: 1px solid var(--border-subtle); }
      .nc-group:first-of-type { border-top: none; }
      .nc-group-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 48px; padding: 10px 0; background: transparent; border: none; cursor: pointer; text-align: left; }
      .nc-group-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .nc-group-label { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
      .nc-group-count { font-size: 11px; color: var(--tracky-light); }
      .nc-group-count.off { color: var(--fg-tertiary); }
      .nc-chevron { color: var(--fg-tertiary); display: inline-flex; transition: transform .18s; }
      .nc-chevron.open { transform: rotate(180deg); }
      .nc-group-hint { font-size: 11px; color: var(--fg-tertiary); line-height: 1.45; margin: 0 0 8px; }
      .nc-group-all { min-height: 44px; padding: 0 14px; margin-bottom: 4px; border-radius: 10px; border: 1px solid var(--border-subtle); background: transparent; color: var(--fg-secondary); font-size: 12px; font-weight: 700; cursor: pointer; }
      .nc-group-all:disabled { opacity: .55; cursor: default; }

      /* Appareils */
      .nc-device { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); }
      .nc-device:last-child { border-bottom: none; }
      .nc-device-icon { width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--bg-tertiary); color: var(--fg-tertiary); }
      .nc-device-text { flex: 1; min-width: 0; }
      .nc-device-name { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); margin: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .nc-device-meta { font-size: 10.5px; color: var(--fg-tertiary); margin: 2px 0 0; overflow-wrap: anywhere; }
      .nc-badge { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--tracky) 16%, transparent); color: var(--tracky-light); }
      .nc-empty { font-size: 11.5px; color: var(--fg-tertiary); margin: 0; }
      .nc-icon-btn { width: 44px; height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 10px; border: 1px solid var(--border-subtle); background: transparent; color: var(--fg-tertiary); cursor: pointer; }
      .nc-icon-btn:disabled { opacity: .5; cursor: default; }

      /* Boutons */
      .nc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 46px; padding: 0 16px; border-radius: 12px; border: none; font-size: 13px; font-weight: 700; cursor: pointer; }
      .nc-btn:disabled { opacity: .6; cursor: default; }
      .nc-btn-primary { background: var(--tracky); color: var(--accent-ink, #06281f); }
      .nc-btn-ghost { background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-subtle); }

      /* A partir de la tablette, on laisse les boutons reprendre leur largeur naturelle. */
      @media (min-width: 640px) {
        .nc-btn { width: auto; align-self: flex-start; }
      }
    `,
  ],
})
export class NotificationsCardComponent implements OnInit {
  private readonly api = inject(NotificationsApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly BellIcon = Bell;
  protected readonly BellOffIcon = BellOff;
  protected readonly BellRingIcon = BellRing;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly InfoIcon = Info;
  protected readonly CheckIcon = Check;
  protected readonly ChevronIcon = ChevronDown;
  protected readonly TrashIcon = Trash2;
  protected readonly SendIcon = Send;
  protected readonly PhoneIcon = Smartphone;

  /** Copie mutable : `@for` attend un itérable simple, pas un tableau en lecture seule. */
  protected readonly severityOptions: SeverityOption[] = [...SEVERITY_OPTIONS];

  protected readonly pref = this.api.preferences;
  protected readonly prefsUnavailable = this.api.preferencesUnavailable;
  /** Jamais `api.devices` brut : ce signal est partagé avec Observabilité (`scope=all`). */
  protected readonly devices = computed(() => ownDevices(this.api.devices()));

  protected readonly busyDevice = signal(false);
  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  protected readonly revoking = signal<string | null>(null);

  /** Permission navigateur relue apres chaque action (elle change hors Angular). */
  private readonly permission = signal<NotificationPermission | 'unsupported'>('default');
  private readonly openGroups = signal<Set<string>>(new Set());

  protected readonly groups = computed(() =>
    buildGroupViews(ALERT_TYPE_GROUPS, this.pref()?.mutedTypes ?? []),
  );

  protected readonly deviceState = computed(() => {
    const diag = this.api.pushSupportDiagnostic();
    return derivePushDeviceState({
      supported: diag.supported,
      serverEnabled: this.api.pushEnabled(),
      permission: this.permission(),
      subscribed: this.api.isSubscribed(),
      isIOS: diag.isIOS,
      isStandalone: diag.isStandalone,
    });
  });

  protected readonly unsupportedReason = computed(
    () => this.api.pushSupportDiagnostic().reason ?? 'Ce navigateur ne gère pas les notifications web.',
  );

  /** Ce que cet appareil abonné va RÉELLEMENT recevoir (maître coupé, rôle hors périmètre). */
  protected readonly deliveryHint = computed(
    () => activeDeliveryHint(this.pref(), this.prefsUnavailable()),
  );

  /**
   * `POST /notifications/test` est gardé par `@Roles(SUPER_ADMIN)` et refuse un compte
   * sans abonnement. On reproduit la condition ici plutôt que d'afficher un bouton qui
   * échoue.
   */
  protected readonly canTest = computed(
    () => this.auth.user()?.role === 'SUPER_ADMIN' && this.devices().length > 0,
  );

  async ngOnInit(): Promise<void> {
    this.refreshPermission();
    // loadStatus() interroge le serveur (VAPID actif ?) et resynchronise l'abonnement
    // local — il peut avoir ete revoque silencieusement par iOS depuis la derniere visite.
    await this.api.loadStatus().catch(() => undefined);
    this.refreshPermission();
    await Promise.all([
      this.api.loadPreferences(),
      this.api.listDevices('mine').catch(() => undefined),
    ]);
  }

  private refreshPermission(): void {
    this.permission.set(
      typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    );
  }

  // ─── Abonnement de cet appareil ─────────────────────────────

  protected async enable(): Promise<void> {
    if (this.busyDevice()) return;
    this.busyDevice.set(true);
    try {
      const res = await this.api.subscribePush();
      this.refreshPermission();
      if (res.ok) {
        await this.api.listDevices('mine').catch(() => undefined);
        this.toast.success('Notifications activées sur cet appareil');
      } else {
        this.toast.error('Activation impossible', res.reason);
      }
    } catch {
      this.toast.error('Activation impossible', 'Réessayez dans un instant.');
    } finally {
      this.busyDevice.set(false);
    }
  }

  protected async disable(): Promise<void> {
    if (this.busyDevice()) return;
    this.busyDevice.set(true);
    try {
      await this.api.unsubscribePush();
      await this.api.listDevices('mine').catch(() => undefined);
      this.toast.success('Notifications désactivées sur cet appareil');
    } catch {
      this.toast.error('Désactivation impossible');
    } finally {
      this.busyDevice.set(false);
    }
  }

  // ─── Preferences ────────────────────────────────────────────

  protected setPushEnabled(value: boolean): void {
    void this.patch({ pushEnabled: value });
  }

  protected setMinSeverity(value: AlertSeverity): void {
    if (this.pref()?.minSeverity === value) return;
    void this.patch({ minSeverity: value });
  }

  protected setType(type: AlertType, enabled: boolean): void {
    const current = this.pref()?.mutedTypes ?? [];
    void this.patch({ mutedTypes: toggleMutedType(current, type, enabled) });
  }

  protected setGroup(group: AlertTypeGroup, enabled: boolean): void {
    const current = this.pref()?.mutedTypes ?? [];
    void this.patch({ mutedTypes: setGroupMuted(current, group, enabled) });
  }

  /**
   * Un seul point d'enregistrement : le service applique le changement de façon
   * optimiste et revient en arrière si le serveur refuse. On ne signale que l'échec —
   * un toast à chaque interrupteur transformerait le réglage en champ de confettis.
   */
  private async patch(payload: UpdateNotificationPreferenceDto): Promise<void> {
    this.saving.set(true);
    const ok = await this.api.savePreferences(payload);
    this.saving.set(false);
    if (!ok) {
      this.toast.error('Réglage non enregistré', 'Vérifiez votre connexion et réessayez.');
    }
  }

  // ─── Groupes deplies ────────────────────────────────────────

  protected isOpen(key: string): boolean {
    return this.openGroups().has(key);
  }

  protected toggleOpen(key: string): void {
    const next = new Set(this.openGroups());
    if (!next.delete(key)) next.add(key);
    this.openGroups.set(next);
  }

  // ─── Appareils ──────────────────────────────────────────────

  protected isThisDevice(d: PushSubscriptionDto): boolean {
    return isCurrentDeviceEndpoint(d.endpoint, this.api.currentSubscription()?.endpoint ?? null);
  }

  /** Libellé lisible depuis le user-agent — on ne montre jamais l'endpoint brut. */
  protected deviceLabel(d: PushSubscriptionDto): string {
    const ua = d.userAgent ?? '';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Appareil Android';
    if (/Windows/i.test(ua)) return 'Ordinateur Windows';
    if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
    if (/Linux/i.test(ua)) return 'Ordinateur Linux';
    return 'Appareil';
  }

  protected shortDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  protected async revoke(d: PushSubscriptionDto): Promise<void> {
    if (this.revoking()) return;
    this.revoking.set(d.id);
    try {
      const wasCurrent = this.isThisDevice(d);
      await this.api.deleteDevice(d.id);
      // Si on vient de révoquer CET appareil, il faut aussi couper l'abonnement local :
      // sinon le navigateur reste abonné à un endpoint que le serveur a oublié, et
      // l'écran continue d'afficher « actif » alors que plus rien n'arrivera.
      if (wasCurrent) await this.api.unsubscribePush().catch(() => undefined);
      this.toast.success('Appareil révoqué');
    } catch {
      this.toast.error('Révocation impossible');
    } finally {
      this.revoking.set(null);
    }
  }

  // ─── Test ───────────────────────────────────────────────────

  protected async sendTest(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    try {
      const res = await this.api.sendTestPush({
        title: 'Test Tracky',
        body: 'Si vous lisez ceci, les notifications fonctionnent sur cet appareil.',
        severity: 'INFO',
      });
      const sent = res.sent ?? 0;
      if (res.scheduled) {
        this.toast.success('Test programmé', `Envoi vers ${res.targetDevices} appareil(s).`);
      } else if (sent > 0) {
        this.toast.success('Test envoyé', `${sent} appareil(s) touché(s). Elle peut mettre quelques secondes à arriver.`);
      } else {
        // 0 envoi mais pas d'erreur HTTP : les abonnements existent mais le service push
        // les a refusés (endpoint périmé). Le dire plutôt que d'afficher un faux succès.
        this.toast.error('Aucune notification envoyée', 'Les abonnements enregistrés ont été refusés. Réactivez les notifications sur cet appareil.');
      }
    } catch {
      this.toast.error('Envoi du test impossible', 'Activez d\'abord les notifications sur cet appareil.');
    } finally {
      this.testing.set(false);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush, { PushSubscription as WebPushSubscription } from 'web-push';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint M) — Web Push notifications via VAPID.
 *
 * Mode no-op si VAPID_PUBLIC_KEY est vide. Pour generer les cles :
 *   npx web-push generate-vapid-keys
 *
 * Le frontend (Sprint M) utilise `getPublicKey()` pour s'abonner via Service
 * Worker. Le backend stocke les subscriptions dans `push_subscriptions` et
 * utilise `sendToUser(userId, payload)` pour broadcaster a tous les devices
 * d'un utilisateur.
 */

export interface PushPayload {
  title: string;
  body: string;
  /**
   * Grande icone affichee dans la notif. Optionnel — le SW utilise
   * `/pwa-icon-192.png` par defaut.
   */
  icon?: string;
  /**
   * Petite icone monochrome (Android : tintee blanc dans la status bar).
   * Optionnel — le SW utilise `/pwa-icon-192.png` par defaut.
   */
  badge?: string;
  data?: Record<string, unknown>;
  url?: string; // URL a ouvrir au clic
  /**
   * Severite — utilisee cote SW pour decider du pattern de vibration
   * et du flag `requireInteraction` (CRITICAL = notif persistante).
   */
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  /**
   * Tag de regroupement — un seul push par tag est affiche a la fois,
   * un nouveau push avec le meme tag remplace le precedent (utile pour
   * eviter d'empiler 5 notifs pour la meme alerte re-poussee/escaladee).
   * Convention : utiliser l'`alertId`.
   */
  tag?: string;
  /**
   * Compteur a afficher sur l'icone de l'app (badge "1", "2", ...).
   * Cote SW : appel a navigator.setAppBadge(N) si supporte.
   *   - iOS 18.4+ standalone PWA : oui
   *   - Android Chrome PWA : oui (Chrome 81+)
   *   - Desktop Chrome : oui
   *   - Firefox / Safari hors PWA : ignore silencieusement
   * Si undefined ou 0, on n'envoie pas setAppBadge (laisse l'etat actuel).
   * Si null, on clear le badge (setAppBadge() sans arg).
   */
  appBadge?: number | null;
}

@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private readonly enabled: boolean;
  private readonly publicKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.publicKey = this.config.get('VAPID_PUBLIC_KEY', { infer: true });
    const privateKey = this.config.get('VAPID_PRIVATE_KEY', { infer: true });
    const subject = this.config.get('VAPID_SUBJECT', { infer: true });
    this.enabled = !!(this.publicKey && privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(subject, this.publicKey, privateKey);
      this.logger.log('Web Push enabled (VAPID configured)');
    } else {
      this.logger.warn('Web Push disabled (VAPID_PUBLIC_KEY missing)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async subscribe(
    userId: string,
    sub: WebPushSubscription,
    userAgent?: string,
    deviceId?: string,
  ): Promise<void> {
    // V1.10 — dedup actif au moment de l'inscription :
    //
    // Quand un device se re-abonne (PWA reinstallee, browser mis a jour, ou simple
    // "Activer" apres unsubscribe), il recoit un NOUVEAU endpoint de la part du
    // push service. Sans dedup, les anciennes subs zombies s'accumulent en DB :
    // 5 iPhones "lastSeenAt il y a 1 mois", 3 Android, etc. Tous repondent 201
    // lors des envois (le push service accepte tout) mais aucun n'arrive sur le
    // device reel = "marche 2-3 fois puis stop, doublons partout".
    //
    // Strategie a 2 niveaux :
    //
    //   1. Si `deviceId` fourni (UUID stable localStorage genere cote client) :
    //      delete toutes les subs du meme (userId, deviceId) avant insert.
    //      Identification PARFAITE du device physique, survit aux updates browser.
    //
    //   2. Fallback `userAgent` (legacy clients sans deviceId encore stocke) :
    //      delete par (userId, userAgent). Marche dans 90% des cas mais l'UA
    //      change quand le browser se met a jour, laissant occasionnellement
    //      un doublon. Sera nettoye par la prochaine re-inscription avec
    //      deviceId une fois que tous les clients ont recu le bundle qui le
    //      genere.
    //
    // RFC 8030 : sur 410 Gone d'un push service, on purge dans le send loop.
    // C'est la source de verite ultime — la dedup ici evite l'accumulation,
    // 410 supprime ce qui passe au travers.
    if (deviceId) {
      const deleted = await this.prisma.pushSubscription.deleteMany({
        where: {
          userId,
          deviceId,
          endpoint: { not: sub.endpoint },
        },
      });
      if (deleted.count > 0) {
        this.logger.log(`[push] dedup-by-device: removed ${deleted.count} stale sub(s) for user=${userId.slice(0, 8)} device=${deviceId.slice(0, 8)}`);
      }
    } else if (userAgent) {
      const deleted = await this.prisma.pushSubscription.deleteMany({
        where: {
          userId,
          userAgent,
          endpoint: { not: sub.endpoint },
        },
      });
      if (deleted.count > 0) {
        this.logger.log(`[push] dedup-by-ua: removed ${deleted.count} stale sub(s) for user=${userId.slice(0, 8)} ua="${userAgent.slice(0, 50)}..."`);
      }
    }

    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
        deviceId,
      },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
        deviceId,
        lastSeenAt: new Date(),
      },
    });
  }

  async unsubscribe(endpoint: string, userId: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({
      where: { endpoint, userId },
    });
  }

  async listForUser(userId: string) {
    return this.prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Send a push to all subscriptions of a user. Returns the number of
   * successful deliveries. Subscriptions returning 410 Gone are pruned.
   *
   * V1.9 — options critiques pour Apple APNs (sans elles, iOS drop silencieusement) :
   *   - `TTL: 86400` : Apple expire les push avec TTL: 0 si device offline. 1 jour
   *     est le minimum raisonnable pour qu'une notif arrive apres ecran verrouille.
   *   - `urgency: 'high'` : sans ce header, Apple drop les push utilisateur en
   *     background (FCM est tolerant, APNs strict).
   *     Refs: web-push-libs/web-push#235, magicbell ios-pwa-push best practices.
   *   - `topic` : optionnel mais utile pour collapsing (ex: 5 events alerte X
   *     -> une seule notif visible). Max 32 chars URL-safe base64.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<SendResult> {
    const subs = await this.listForUser(userId);
    return this.sendToSubscriptions(subs, payload, 'user:' + userId.slice(0, 8));
  }

  /**
   * Send a push to a specific list of subscription IDs. Verifies that all
   * IDs belong to `ownerUserId` (security : un user ne peut pas pusher sur
   * les devices d'un autre, sauf si `bypassOwnerCheck` est vrai pour les
   * cas SUPER_ADMIN). Used by the test endpoint when the admin picks specific
   * devices to target.
   */
  async sendToSubscriptionIds(
    subscriptionIds: string[],
    ownerUserId: string,
    payload: PushPayload,
    opts: { bypassOwnerCheck?: boolean } = {},
  ): Promise<SendResult> {
    if (subscriptionIds.length === 0) return { sent: 0, failed: 0, results: [] };
    const subs = await this.prisma.pushSubscription.findMany({
      where: opts.bypassOwnerCheck
        ? { id: { in: subscriptionIds } }
        : { id: { in: subscriptionIds }, userId: ownerUserId },
    });
    return this.sendToSubscriptions(subs, payload, 'targeted:' + subs.length);
  }

  /**
   * Coeur d'envoi — accepte une liste de subscriptions deja resolues.
   * Logue chaque tentative (succes ET echec) avec endpoint host, status code
   * et duree, pour faciliter le debug via `docker logs tracky-api`.
   * Purge automatique des subs renvoyant 404/410 (Gone / Not Found).
   */
  private async sendToSubscriptions(
    subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>,
    payload: PushPayload,
    contextLabel: string,
  ): Promise<SendResult> {
    if (!this.enabled) {
      this.logger.warn(`[push] skipped (${contextLabel}) — VAPID disabled`);
      return { sent: 0, failed: 0, results: [] };
    }
    if (subs.length === 0) {
      this.logger.debug(`[push] no targets (${contextLabel})`);
      return { sent: 0, failed: 0, results: [] };
    }

    // V1.10 — Wrapping pour compatibilite ngsw-worker (Angular Service Worker).
    //
    // Probleme observe en prod : en standalone PWA Android, deux SW se battent
    // pour le scope `/` :
    //   - ngsw-worker.js (Angular, registre apres 30s d'idle pour cache+update)
    //   - /sw.js custom (registre au click "Activer push")
    // Spec W3C : un seul SW actif par scope, le dernier registre gagne. ngsw
    // arrive en general apres /sw.js et devient le SW actif.
    //
    // ngsw NE LIT QUE le champ `notification` au root du payload (cf. Angular
    // service-worker source : packages/service-worker/worker/src/driver.ts).
    // Notre /sw.js lit les champs A PLAT (title, body, severity, ...).
    //
    // Solution : envoyer LES DEUX formats dans le meme payload.
    //   - ngsw consomme `notification` et auto-affiche
    //   - /sw.js (si actif) reste compatible via Object.assign(data, json)
    // -> Notif s'affiche peu importe lequel des deux SW est actif. Bug Android
    //    "FCM repond 201 mais aucune notif" resolu.
    const isCritical = payload.severity === 'CRITICAL';
    const ngswNotification = {
      title: payload.title,
      body: payload.body,
      icon: payload.icon ?? '/pwa-icon-192.png',
      // notification-badge-96.png = silhouette V sur fond transparent, optimisee
      // pour le tint monochrome blanc force par Android dans la status bar.
      badge: payload.badge ?? '/notification-badge-96.png',
      data: {
        ...(payload.data ?? {}),
        url: payload.url,
        severity: payload.severity,
        appBadge: payload.appBadge,
      },
      tag: payload.tag,
      requireInteraction: isCritical,
      renotify: isCritical && !!payload.tag,
      vibrate: isCritical ? [200, 100, 200, 100, 200] : [100],
      // `actions` n'est rendu que sur Chrome desktop. Sur Android, les boutons
      // apparaissent uniquement si declares dans manifest.webmanifest -> on
      // les inclut quand meme pour Chrome desktop + iPhone Safari les ignore.
      actions: [
        { action: 'ack', title: 'Acquitter' },
        { action: 'view', title: 'Voir' },
      ],
    };
    const body = JSON.stringify({
      notification: ngswNotification, // <-- consume par ngsw-worker
      ...payload,                      // <-- consume par notre /sw.js (flat fields)
    });

    const options: webpush.RequestOptions = {
      TTL: 86400, // 24h — laisse le temps a une notif d'arriver apres verrouillage
      urgency: 'high', // requis APNs (Apple) pour delivery user-visible en background
    };
    if (payload.tag) {
      const safe = payload.tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
      if (safe.length > 0) options.topic = safe;
    }

    this.logger.log(`[push] sending (${contextLabel}) -> ${subs.length} subs, severity=${payload.severity ?? 'INFO'}, tag=${payload.tag ?? '-'}`);

    let sent = 0;
    let failed = 0;
    const results: SendResultEntry[] = [];

    for (const sub of subs) {
      const endpointHost = (() => {
        try { return new URL(sub.endpoint).hostname; } catch { return 'unknown'; }
      })();
      const t0 = Date.now();

      try {
        const res = await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          options,
        );
        const dt = Date.now() - t0;
        const code = res.statusCode ?? 201;
        sent++;
        this.logger.log(`[push] OK ${code} ${endpointHost} sub=${sub.id.slice(0, 8)} (${dt}ms)`);
        results.push({ id: sub.id, endpointHost, statusCode: code });
      } catch (err: unknown) {
        const dt = Date.now() - t0;
        const status = (err as { statusCode?: number }).statusCode ?? null;
        const message = (err as { body?: string; message?: string }).body
          || (err as { message?: string }).message
          || String(err);
        if (status === 404 || status === 410) {
          // Subscription expired or unregistered — prune.
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {/* ignore */});
          this.logger.warn(`[push] GONE ${status} ${endpointHost} sub=${sub.id.slice(0, 8)} -> purged (${dt}ms)`);
        } else {
          this.logger.warn(`[push] FAIL ${status ?? '?'} ${endpointHost} sub=${sub.id.slice(0, 8)} (${dt}ms): ${message.slice(0, 160)}`);
        }
        failed++;
        results.push({ id: sub.id, endpointHost, statusCode: status, error: message.slice(0, 200) });
      }
    }

    this.logger.log(`[push] done (${contextLabel}) sent=${sent} failed=${failed}`);
    return { sent, failed, results };
  }

  /**
   * SUPER_ADMIN — supprime une subscription (par n'importe quel user).
   * Pour les autres roles, le service `notifications.controller` filtre
   * par userId avant d'appeler ici.
   */
  async deleteSubscriptionById(id: string): Promise<void> {
    await this.prisma.pushSubscription.delete({ where: { id } }).catch(() => {/* peut deja avoir ete purge */});
  }
}

export interface SendResultEntry {
  id: string;
  endpointHost: string;
  statusCode: number | null;
  error?: string;
}

export interface SendResult {
  sent: number;
  failed: number;
  results: SendResultEntry[];
}

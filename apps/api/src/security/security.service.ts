import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthClientService } from '../auth-client/auth-client.service';
import { EmailService } from '../email/email.service';
import { GeoipService } from './geoip.service';
import {
  DEVICE_CODE_TTL_MINUTES,
  MIN_BASELINE_LOCATED,
  PROPOSE_COOLDOWN_DAYS,
  SECURITY_ENABLED,
  USUAL_POINTS_SAMPLE,
  USUAL_RADIUS_KM,
} from './security.constants';
import { deviceLabelFromUa, haversineKm, maskEmail } from './security.util';

interface ConnMeta {
  ip?: string | null;
  userAgent?: string | null;
  label?: string | null;
}

export interface ConnectionInput {
  userId: string;
  email: string;
  firstName?: string | null;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ConnectionDecision {
  /** 'allow' = accès libre ; 'challenge' = code e-mail requis (2FA activé + anomalie). */
  action: 'allow' | 'challenge';
  /** true = proposer (en douceur) d'activer le 2FA (utilisateur non opt-in, anomalie). */
  propose: boolean;
  location: { city: string | null; region: string | null; country: string | null };
  maskedEmail: string;
}

/**
 * Sécurité des connexions — 2FA app ADAPTATIF & OPT-IN.
 *
 * À chaque ouverture de session (le front appelle /connection), on géolocalise
 * l'IP (ville/région, base locale), on journalise la connexion et on DÉCIDE :
 *  - Utilisateur ayant activé le 2FA + anomalie (nouvel appareil / zone
 *    inhabituelle) + assez d'historique → challenge (code e-mail).
 *  - Utilisateur SANS 2FA + anomalie → proposition douce d'activer le 2FA.
 *  - Sinon → accès libre (et on apprend : l'appareil devient « connu »).
 *
 * « Assez d'historique » : un appareil n'est « nouveau » que si l'utilisateur a
 * DÉJÀ ≥1 appareil connu ; une zone n'est « inhabituelle » qu'avec ≥N positions
 * de référence. Le tout premier appareil est toujours accepté (apprentissage).
 */
@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  /** Décision de session courante par (userId::deviceId). Vidé au restart (fail-open). */
  private readonly decisionCache = new Map<string, 'allow' | 'challenge'>();
  /** (userId::deviceId) reconnus de confiance (perf). */
  private readonly trustedCache = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authClient: AuthClientService,
    private readonly email: EmailService,
    private readonly geoip: GeoipService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  private key(userId: string, deviceId: string): string {
    return `${userId}::${deviceId}`;
  }

  // ── Appareils de confiance ──────────────────────────────────────────────────

  async isDeviceTrusted(userId: string, deviceId: string): Promise<boolean> {
    if (this.trustedCache.has(this.key(userId, deviceId))) return true;
    const row = await this.prisma.trustedDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
      select: { id: true },
    });
    if (!row) return false;
    this.trustedCache.add(this.key(userId, deviceId));
    this.prisma.trustedDevice
      .update({ where: { userId_deviceId: { userId, deviceId } }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
    return true;
  }

  async hasAnyTrustedDevice(userId: string): Promise<boolean> {
    return (await this.prisma.trustedDevice.count({ where: { userId } })) > 0;
  }

  async trustDevice(userId: string, deviceId: string, meta: ConnMeta): Promise<void> {
    const label = meta.label ? meta.label.slice(0, 120) : null;
    const userAgent = meta.userAgent ? meta.userAgent.slice(0, 400) : null;
    await this.prisma.trustedDevice.upsert({
      where: { userId_deviceId: { userId, deviceId } },
      create: { userId, deviceId, ip: meta.ip ?? null, userAgent, label },
      update: { lastSeenAt: new Date(), ip: meta.ip ?? null, userAgent },
    });
    this.trustedCache.add(this.key(userId, deviceId));
  }

  // ── Zone habituelle ─────────────────────────────────────────────────────────

  private async usualPoints(userId: string): Promise<Array<{ lat: number; lng: number }>> {
    const rows = await this.prisma.loginEvent.findMany({
      where: { userId, lat: { not: null }, lng: { not: null } },
      select: { lat: true, lng: true },
      orderBy: { createdAt: 'desc' },
      take: USUAL_POINTS_SAMPLE,
    });
    return rows
      .filter((r): r is { lat: number; lng: number } => r.lat != null && r.lng != null)
      .map((r) => ({ lat: r.lat, lng: r.lng }));
  }

  private isFarFromUsual(
    points: Array<{ lat: number; lng: number }>,
    lat: number,
    lng: number,
  ): boolean {
    // Pas assez d'historique pour juger → on n'affirme jamais « inhabituel ».
    if (points.length < MIN_BASELINE_LOCATED) return false;
    let min = Infinity;
    for (const p of points) {
      const d = haversineKm(p.lat, p.lng, lat, lng);
      if (d < min) min = d;
      if (min <= USUAL_RADIUS_KM) return false; // proche d'une zone connue
    }
    return min > USUAL_RADIUS_KM;
  }

  // ── Décision à l'ouverture de session ───────────────────────────────────────

  async recordConnection(input: ConnectionInput): Promise<ConnectionDecision> {
    const { userId, email, firstName, deviceId, ip, userAgent } = input;
    const geo = this.geoip.lookup(ip);
    const located = geo.lat != null && geo.lng != null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        twoFactorEnabled: true,
        twoFactorPromptDismissed: true,
        twoFactorPromptedAt: true,
      },
    });
    const twoFA = !!user?.twoFactorEnabled;

    const known = deviceId ? await this.isDeviceTrusted(userId, deviceId) : false;
    const hasDevices = await this.hasAnyTrustedDevice(userId);
    const newDevice = !!deviceId && !known && hasDevices;

    let farFromUsual = false;
    if (located) {
      const points = await this.usualPoints(userId);
      farFromUsual = this.isFarFromUsual(points, geo.lat as number, geo.lng as number);
    }
    const anomaly = newDevice || farFromUsual;

    // Blocage : UNIQUEMENT pour les utilisateurs ayant activé le 2FA, sur anomalie.
    let action: 'allow' | 'challenge' = 'allow';
    if (SECURITY_ENABLED && twoFA) {
      if (!deviceId) action = 'challenge';
      else if (!hasDevices) action = 'allow'; // 1er appareil → apprentissage
      else if (anomaly) action = 'challenge';
      else action = 'allow';
    }

    // Proposition douce (non opt-in) : sur anomalie, si pas déjà écartée / pas trop récente.
    let propose = false;
    if (SECURITY_ENABLED && !twoFA && anomaly && !user?.twoFactorPromptDismissed) {
      const last = user?.twoFactorPromptedAt?.getTime() ?? 0;
      if (Date.now() - last >= PROPOSE_COOLDOWN_DAYS * 24 * 3600 * 1000) propose = true;
    }

    // Journalise la connexion (best-effort, ne casse jamais la session).
    try {
      await this.prisma.loginEvent.create({
        data: {
          userId,
          deviceId: deviceId ?? null,
          ip: ip ?? null,
          lat: geo.lat,
          lng: geo.lng,
          city: geo.city,
          region: geo.region,
          country: geo.country,
          userAgent: userAgent ? userAgent.slice(0, 400) : null,
          newDevice,
          farFromUsual,
          challenged: action === 'challenge',
          verified: false,
        },
      });
    } catch (e) {
      // Fail-open pour la session, mais VISIBLE au centre d'alerte : le journal des
      // connexions est la baseline du 2FA adaptatif ET la carte admin — s'il ne
      // s'écrit plus, la détection d'anomalie est aveugle en silence.
      this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'security-login-events', { userId });
    }

    const label = deviceLabelFromUa(userAgent);
    if (action === 'challenge' && deviceId) {
      this.decisionCache.set(this.key(userId, deviceId), 'challenge');
      // Envoie le code tout de suite (best-effort ; le front peut le renvoyer).
      // Si Vizyo Auth / Resend est en panne, l'utilisateur est BLOQUÉ au challenge
      // → l'échec DOIT remonter au centre d'alerte (sinon lockout invisible).
      void this.sendCode({ email, firstName }, label).catch((e) =>
        this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'security-2fa', {
          userId, note: 'envoi du code challenge à l\'ouverture de session',
        }),
      );
    } else if (deviceId) {
      // 'allow' → on fait confiance à l'appareil (apprentissage + baseline futur opt-in).
      this.decisionCache.set(this.key(userId, deviceId), 'allow');
      // Échec = l'appareil ne devient jamais « de confiance » → re-challenge en boucle
      // pour un utilisateur 2FA : à voir au centre d'alerte, pas en silence.
      await this.trustDevice(userId, deviceId, { ip, userAgent, label }).catch((e) =>
        this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'security-2fa', {
          userId, note: 'trustDevice (apprentissage appareil) a échoué',
        }),
      );
    }

    if (propose) {
      await this.prisma.user
        .update({ where: { id: userId }, data: { twoFactorPromptedAt: new Date() } })
        .catch(() => {});
    }

    return {
      action,
      propose,
      location: { city: geo.city, region: geo.region, country: geo.country },
      maskedEmail: maskEmail(email),
    };
  }

  /** Décision de gate (cheap, par requête) : bloque si un challenge est en cours. */
  gateBlocks(userId: string, deviceId: string | null): boolean {
    if (!SECURITY_ENABLED || !deviceId) return false;
    return this.decisionCache.get(this.key(userId, deviceId)) === 'challenge';
  }

  // ── Envoi / vérification du code ─────────────────────────────────────────────

  async sendCode(
    user: { email: string; firstName?: string | null },
    deviceLabel?: string | null,
  ): Promise<void> {
    const { code, expiresIn } = await this.authClient.sendLoginCode(user.email);
    const built = this.email.buildDeviceVerificationEmail({
      recipientName: user.firstName ?? null,
      code,
      expiresInMinutes: expiresIn ? Math.max(1, Math.round(expiresIn / 60)) : DEVICE_CODE_TTL_MINUTES,
      deviceLabel: deviceLabel ?? null,
    });
    await this.email.send({
      to: user.email,
      subject: built.subject,
      html: built.html,
      text: built.text,
      template: 'device_verification',
    });
  }

  async verifyCode(
    user: { id: string; email: string },
    code: string,
    deviceId: string,
    meta: ConnMeta,
  ): Promise<boolean> {
    const { ok } = await this.authClient.verifyLoginCode(user.email, code);
    if (!ok) return false;
    await this.trustDevice(user.id, deviceId, meta);
    this.decisionCache.set(this.key(user.id, deviceId), 'allow');
    // Marque la dernière connexion challengée comme vérifiée (best-effort, mais
    // tracé : sinon le journal d'audit montre des challenges « jamais vérifiés »).
    await this.prisma.loginEvent
      .updateMany({
        where: { userId: user.id, deviceId, challenged: true, verified: false },
        data: { verified: true },
      })
      .catch((e) =>
        this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'security-login-events', {
          userId: user.id, note: 'flag verified sur login_events',
        }),
      );
    return true;
  }

  // ── 2FA opt-in (par utilisateur) ─────────────────────────────────────────────

  async twoFactorStatus(userId: string): Promise<{ enabled: boolean; dismissed: boolean }> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorPromptDismissed: true },
    });
    return { enabled: !!u?.twoFactorEnabled, dismissed: !!u?.twoFactorPromptDismissed };
  }

  async enableTwoFactor(userId: string, deviceId: string | null, meta: ConnMeta): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true, twoFactorPromptDismissed: false },
    });
    // On fait confiance à l'appareil courant (sinon challenge immédiat sur SON device).
    if (deviceId) {
      await this.trustDevice(userId, deviceId, meta).catch(() => {});
      this.decisionCache.set(this.key(userId, deviceId), 'allow');
    }
  }

  async disableTwoFactor(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false },
    });
    this.clearUserDecisions(userId);
  }

  /** L'utilisateur écarte la proposition (« plus tard / ne plus demander »). */
  async dismissPrompt(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorPromptDismissed: true, twoFactorPromptedAt: new Date() },
    });
  }

  private clearUserDecisions(userId: string): void {
    const prefix = `${userId}::`;
    for (const k of this.decisionCache.keys()) {
      if (k.startsWith(prefix)) this.decisionCache.delete(k);
    }
  }

  // ── Vue admin ────────────────────────────────────────────────────────────────

  async adminUsersOverview(requesterIsOwner: boolean) {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, ...(requesterIsOwner ? {} : { isOwner: false }) },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        twoFactorEnabled: true,
        loginEvents: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { city: true, region: true, country: true, createdAt: true, ip: true, deviceId: true },
        },
        _count: { select: { loginEvents: true, trustedDevices: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return users.map((u) => {
      const last = u.loginEvents[0] ?? null;
      return {
        userId: u.id,
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
        role: u.role,
        twoFactorEnabled: u.twoFactorEnabled,
        lastLogin: last
          ? {
              at: last.createdAt,
              city: last.city,
              region: last.region,
              country: last.country,
              ip: last.ip,
            }
          : null,
        connections: u._count.loginEvents,
        devices: u._count.trustedDevices,
      };
    });
  }

  async adminUserLocations(userId: string, requesterIsOwner: boolean) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, lastName: true, isOwner: true, twoFactorEnabled: true },
    });
    if (!target) throw new ForbiddenException('Utilisateur introuvable.');
    if (target.isOwner && !requesterIsOwner) throw new ForbiddenException('Hors périmètre.');

    const events = await this.prisma.loginEvent.findMany({
      where: { userId, lat: { not: null }, lng: { not: null } },
      select: {
        lat: true,
        lng: true,
        city: true,
        region: true,
        country: true,
        createdAt: true,
        deviceId: true,
        newDevice: true,
        farFromUsual: true,
        challenged: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Résumé par ville (pour la légende).
    const byCity = new Map<string, number>();
    for (const e of events) {
      const c = e.city || e.region || e.country || '—';
      byCity.set(c, (byCity.get(c) ?? 0) + 1);
    }

    return {
      user: {
        id: target.id,
        name: [target.firstName, target.lastName].filter(Boolean).join(' ') || target.email,
        email: target.email,
        twoFactorEnabled: target.twoFactorEnabled,
      },
      points: events,
      cities: [...byCity.entries()]
        .map(([city, count]) => ({ city, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
}

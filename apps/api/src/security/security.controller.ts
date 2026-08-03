import { clientIp } from '../common/client-ip';
import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ErrorLogger } from '../observability/error-logger.service';
import { DEVICE_ID_HEADER } from './security.constants';
import { SecurityService } from './security.service';
import { deviceLabelFromUa, maskEmail } from './security.util';
import { VerifyCodeDto } from './dto/verify-code.dto';

/**
 * Sécurité des connexions (2FA app opt-in adaptatif). Toutes les routes sont
 * EXEMPTÉES du gate (même préfixe) : un utilisateur en cours de vérification doit
 * pouvoir recevoir/saisir son code.
 */
@Controller('security')
@UseGuards(JwtAuthGuard)
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Boot : enregistre la connexion (appareil + position) et décide (allow/challenge/propose). */
  @Post('connection')
  @HttpCode(200)
  connection(@Req() req: AuthenticatedRequest) {
    const u = req.user;
    return this.security.recordConnection({
      userId: u.id,
      email: u.email,
      firstName: u.firstName,
      deviceId: deviceHeader(req),
      ip: ip(req),
      userAgent: ua(req),
    });
  }

  /** Renvoyer un code manuellement (bouton « renvoyer »). */
  @Post('resend')
  @HttpCode(200)
  async resend(@Req() req: AuthenticatedRequest) {
    const u = req.user;
    try {
      await this.security.sendCode({ email: u.email, firstName: u.firstName }, deviceLabelFromUa(ua(req)));
      return { ok: true, email: maskEmail(u.email) };
    } catch (e) {
      // Le renvoi de code est le DERNIER recours d'un utilisateur bloqué au challenge :
      // des échecs répétés (Vizyo Auth down, Resend) doivent se voir au centre d'alerte.
      this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'security-2fa', {
        userId: u.id, note: 'renvoi du code (bouton « renvoyer »)',
      });
      return { ok: false, email: maskEmail(u.email) };
    }
  }

  /** Vérifie le code ; si ok, l'appareil devient de confiance et le gate se lève. */
  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: AuthenticatedRequest, @Body() dto: VerifyCodeDto) {
    const u = req.user;
    const deviceId = deviceHeader(req);
    if (!deviceId) return { ok: false };
    const ok = await this.security.verifyCode({ id: u.id, email: u.email }, dto.code, deviceId, {
      ip: ip(req),
      userAgent: ua(req),
      label: deviceLabelFromUa(ua(req)),
    });
    return { ok };
  }

  // ── 2FA opt-in (par utilisateur) ─────────────────────────────────────────────

  @Get('2fa/status')
  twoFactorStatus(@Req() req: AuthenticatedRequest) {
    return this.security.twoFactorStatus(req.user.id);
  }

  @Post('2fa/enable')
  @HttpCode(200)
  async enable(@Req() req: AuthenticatedRequest) {
    await this.security.enableTwoFactor(req.user.id, deviceHeader(req), {
      ip: ip(req),
      userAgent: ua(req),
      label: deviceLabelFromUa(ua(req)),
    });
    return { ok: true, enabled: true };
  }

  /**
   * Désactivation du 2FA — étape 1 : envoie un code e-mail de confirmation.
   * Exiger un code frais empêche une session volée de couper la protection en silence.
   */
  @Post('2fa/disable/send-code')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(200)
  async disableSendCode(@Req() req: AuthenticatedRequest) {
    const u = req.user;
    try {
      await this.security.sendDisableCode({ email: u.email, firstName: u.firstName });
      return { ok: true, email: maskEmail(u.email) };
    } catch (e) {
      this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'security-2fa', {
        userId: u.id, note: 'envoi du code de désactivation 2FA',
      });
      return { ok: false, email: maskEmail(u.email) };
    }
  }

  /** Désactivation du 2FA — étape 2 : confirme avec le code reçu (sinon 2FA maintenu). */
  @Post('2fa/disable')
  @HttpCode(200)
  async disable(@Req() req: AuthenticatedRequest, @Body() dto: VerifyCodeDto) {
    const u = req.user;
    const ok = await this.security.disableTwoFactor({ id: u.id, email: u.email }, dto.code);
    return { ok, enabled: !ok };
  }

  /** L'utilisateur écarte la proposition d'activer le 2FA. */
  @Post('2fa/dismiss')
  @HttpCode(200)
  async dismiss(@Req() req: AuthenticatedRequest) {
    await this.security.dismissPrompt(req.user.id);
    return { ok: true };
  }
}

function deviceHeader(req: AuthenticatedRequest): string | null {
  const v = req.headers[DEVICE_ID_HEADER];
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return (v[0] ?? '').trim() || null;
  return null;
}

function ip(req: AuthenticatedRequest): string | null {
  // ⚠️ Delegue a `clientIp` : lire le PREMIER hop de x-forwarded-for revenait a
  // faire confiance a une valeur ecrite par le client (cf. common/client-ip.ts).
  return clientIp(req);
}

function ua(req: AuthenticatedRequest): string | null {
  const v = req.headers['user-agent'];
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

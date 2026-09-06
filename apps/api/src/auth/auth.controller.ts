import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthClientService } from '../auth-client/auth-client.service';
import { EmailService } from '../email/email.service';
import { InvitationsService } from '../invitations/invitations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import type { AuthenticatedRequest } from './guards/jwt-auth.guard';
import { ACCESS_COOKIE_NAME, JwtAuthGuard } from './guards/jwt-auth.guard';
import type { Env } from '../config/env.validation';

// V1.10 (Sprint 6) — cookies httpOnly pour les JWT.
//   - tracky_at : access token, courte duree (~15 min selon Vizyo Auth).
//   - tracky_rt : refresh token, longue duree (~30 jours).
// Both : httpOnly (pas lisible par JS, defense XSS), secure en prod (HTTPS only),
// sameSite=lax (compatible OAuth-like + protege contre CSRF basique).
const REFRESH_COOKIE_NAME = 'tracky_rt';
// « Rester connecté » : marqueur (httpOnly) pour préserver le choix lors du refresh
// (rotation) — on ne le rend pas persistant si l'utilisateur n'a pas coché.
const REMEMBER_COOKIE_NAME = 'tracky_rem';
const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

// remember=true → cookies PERSISTANTS (survivent à la fermeture du navigateur, 30j
// pour le refresh). remember=false → cookies de SESSION (pas de maxAge : disparaissent
// à la fermeture) — pour un poste partagé.
function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  remember: boolean,
): void {
  const isProd = process.env.NODE_ENV === 'production';
  const common = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
  };
  res.cookie(ACCESS_COOKIE_NAME, accessToken, remember ? { ...common, maxAge: ACCESS_TTL_S * 1000 } : { ...common });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, remember ? { ...common, maxAge: REFRESH_TTL_S * 1000 } : { ...common });
  res.cookie(REMEMBER_COOKIE_NAME, remember ? '1' : '0', remember ? { ...common, maxAge: REFRESH_TTL_S * 1000 } : { ...common });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, { path: '/' });
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
  res.clearCookie(REMEMBER_COOKIE_NAME, { path: '/' });
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly authClient: AuthClientService,
    private readonly invitations: InvitationsService,
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * V1.5 (Sprint J) — Public endpoint to accept an invitation.
   * No JWT required — auth happens via the invitation token (signed JWT 24h).
   */
  @Post('accept-invitation')
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(
    @Body() dto: { token: string; password: string; displayName: string },
  ) {
    if (!dto?.token || !dto?.password || !dto?.displayName) {
      throw new BadRequestException('token, password et displayName requis');
    }
    return this.invitations.accept(dto.token, dto.password, dto.displayName);
  }

  @Post('login')
  // Anti brute-force : 10 essais/min/IP (le throttle global 100/min laissait ~144k essais/jour).
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.email, dto.password);
    // V1.10 (Sprint 6) — pose les cookies httpOnly. Le body continue de
    // contenir les tokens pour la backward compat des clients legacy /
    // SDK externes (header Authorization). Le frontend Tracky n'utilise
    // que les cookies via withCredentials. « Rester connecté » (défaut true)
    // pilote la persistance des cookies.
    setAuthCookies(res, result.accessToken, result.refreshToken, dto.remember !== false);
    return result;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: Partial<RefreshDto>,
    @Req() req: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ) {
    // V1.10 (Sprint 6) — lit le refresh token depuis le cookie en priorite,
    // fallback body pour backward compat. Pose les nouveaux cookies dans tous
    // les cas (rotation refresh token cote Vizyo Auth).
    // `dto?.` et non `dto.` : une requete SANS CORPS rend `dto` undefined, et la forme
    // directe levait un TypeError — donc un 500 la ou la reponse juste est un 400.
    const jetonCookie = req.cookies?.['tracky_rt'];
    const jetonCorps = dto?.refreshToken;
    if (!jetonCookie && !jetonCorps) {
      throw new BadRequestException('Refresh token absent (ni cookie ni body)');
    }

    /**
     * ── LE COOKIE A LA PRIORITÉ, PAS LE MONOPOLE (jumeau de `JwtAuthGuard`) ─────────────
     *
     * Cette ligne s'écrivait `req.cookies?.['tracky_rt'] ?? dto?.refreshToken` : le corps
     * ne servait QUE si le cookie était absent, jamais s'il était périmé. Or LE JETON DE
     * RAFRAÎCHISSEMENT TOURNE À CHAQUE APPEL — Vizyo Auth en rend un neuf, qu'on repose en
     * cookie ET que le client garde de son côté.
     *
     * Il suffit donc d'UNE rotation perdue en route pour que les deux divergent : un
     * onglet qui rafraîchit pendant qu'un autre dort, un cookie non réécrit parce que la
     * réponse n'est pas arrivée, un `SameSite` qui bloque l'écriture. À partir de là, le
     * cookie est mort pour toujours, le client en détient un valide, et le serveur refuse
     * sans jamais le regarder. L'utilisateur est déconnecté et ne peut rien y faire : le
     * cookie est httpOnly, il ne sait ni le lire ni l'effacer.
     *
     * ⚠️ AUCUNE CONFIANCE ÉLARGIE : les deux jetons partent au MÊME `authClient.refresh`,
     * qui reste seul juge. Un corps invalide est refusé exactement comme avant. On corrige
     * l'ORDRE d'essai, pas le contrôle.
     */
    let result;
    try {
      result = await this.authClient.refresh(jetonCookie ?? jetonCorps!);
    } catch (erreurCookie) {
      // Rien à réessayer : pas de cookie, pas de corps, ou le même jeton des deux côtés.
      if (!jetonCookie || !jetonCorps || jetonCorps === jetonCookie) throw erreurCookie;
      result = await this.authClient.refresh(jetonCorps);
    }
    // Préserve le choix « rester connecté » à la rotation (défaut true si marqueur absent).
    const remember = (req.cookies?.[REMEMBER_COOKIE_NAME] ?? '1') !== '0';
    setAuthCookies(res, result.accessToken, result.refreshToken, remember);
    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() dto: Partial<RefreshDto>,
    @Req() req: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ) {
    /**
     * ⚠️ LES COOKIES SONT VIDES EN PREMIER, ET RIEN NE PEUT L'EMPECHER.
     *
     * Releve le 2026-08-21 : un appel `POST /api/auth/logout` SANS CORPS rendait `dto`
     * undefined, `dto.refreshToken` levait un TypeError — et la levee se produisait AVANT
     * `clearAuthCookies`. Resultat : 500, cookies intacts, utilisateur toujours connecte.
     * C'est le pire endroit possible pour un defaut de robustesse : la deconnexion est
     * precisement l'appel qui doit reussir quoi qu'il arrive, y compris quand la session
     * est deja abimee — c'est meme SURTOUT dans ce cas qu'on l'appelle.
     *
     * Le corps est facultatif par contrat (le cookie prime) : un client qui n'en envoie pas
     * fait quelque chose de parfaitement legitime.
     */
    clearAuthCookies(res);
    const refreshToken = req.cookies?.['tracky_rt'] ?? dto?.refreshToken;
    if (refreshToken) {
      // Best effort logout cote Vizyo Auth (revoque le refresh token).
      await this.authClient.logout(refreshToken).catch(() => undefined);
    }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: AuthenticatedRequest) {
    return {
      id: req.user.id,
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      role: req.user.role,
      isOwner: req.user.isOwner,
      fleetId: req.user.fleetId,
    };
  }

  /**
   * POST /api/auth/forgot-password (public, pas de JWT)
   * Envoie un email avec un lien de reinitialisation.
   * Retourne toujours { ok: true } (pas d'enumeration d'emails).
   */
  @Post('forgot-password')
  // Anti-spam e-mail : 5 demandes/min/IP (chaque appel peut déclencher un envoi Resend).
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: { email: string }): Promise<{ ok: true }> {
    try {
      const email = dto.email?.toLowerCase().trim();
      if (!email) return { ok: true };

      const result = await this.authClient.requestPasswordReset(email);
      if (!result.token) return { ok: true }; // user not found — silent

      const localUser = await this.prisma.user.findUnique({
        where: { email },
        select: { firstName: true, lastName: true },
      });
      const recipientName = [localUser?.firstName, localUser?.lastName]
        .filter(Boolean).join(' ') || null;

      const vizAuthWebUrl = this.config.get('VIZYO_AUTH_WEB_URL', { infer: true });
      const appBaseUrl = this.config.get('APP_BASE_URL', { infer: true });
      const redirectUrl = `${appBaseUrl}/login?email=${encodeURIComponent(email)}`;
      const resetUrl = `${vizAuthWebUrl}/reset-password?token=${result.token}&redirect=${encodeURIComponent(redirectUrl)}`;

      const emailContent = this.emailService.buildPasswordResetEmail({
        recipientName,
        resetUrl,
        expiresInMinutes: 60,
      });

      await this.emailService.send({
        to: email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        template: 'password_reset',
      });
    } catch (err) {
      // Swallow errors to prevent email enumeration
      this.logger.warn({ error: (err as Error).message }, 'forgotPassword failed silently');
    }
    return { ok: true };
  }
}

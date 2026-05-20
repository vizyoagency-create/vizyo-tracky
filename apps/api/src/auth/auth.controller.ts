import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  const common = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
  };
  res.cookie(ACCESS_COOKIE_NAME, accessToken, { ...common, maxAge: ACCESS_TTL_S * 1000 });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, { ...common, maxAge: REFRESH_TTL_S * 1000 });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, { path: '/' });
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
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
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.email, dto.password);
    // V1.10 (Sprint 6) — pose les cookies httpOnly. Le body continue de
    // contenir les tokens pour la backward compat des clients legacy /
    // SDK externes (header Authorization). Le frontend Tracky n'utilise
    // que les cookies via withCredentials.
    setAuthCookies(res, result.accessToken, result.refreshToken);
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
    const refreshToken = req.cookies?.['tracky_rt'] ?? dto.refreshToken;
    if (!refreshToken) {
      throw new BadRequestException('Refresh token absent (ni cookie ni body)');
    }
    const result = await this.authClient.refresh(refreshToken);
    setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() dto: Partial<RefreshDto>,
    @Req() req: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.['tracky_rt'] ?? dto.refreshToken;
    clearAuthCookies(res);
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
      fleetId: req.user.fleetId,
    };
  }

  /**
   * POST /api/auth/forgot-password (public, pas de JWT)
   * Envoie un email avec un lien de reinitialisation.
   * Retourne toujours { ok: true } (pas d'enumeration d'emails).
   */
  @Post('forgot-password')
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
      });
    } catch (err) {
      // Swallow errors to prevent email enumeration
      this.logger.warn({ error: (err as Error).message }, 'forgotPassword failed silently');
    }
    return { ok: true };
  }
}

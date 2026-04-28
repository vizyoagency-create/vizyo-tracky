import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthClientService } from '../auth-client/auth-client.service';
import { EmailService } from '../email/email.service';
import { InvitationsService } from '../invitations/invitations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import type { AuthenticatedRequest } from './guards/jwt-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { Env } from '../config/env.validation';

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
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.authClient.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: RefreshDto) {
    return this.authClient.logout(dto.refreshToken);
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

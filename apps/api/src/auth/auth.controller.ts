import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { AuthClientService } from '../auth-client/auth-client.service';
import { InvitationsService } from '../invitations/invitations.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import type { AuthenticatedRequest } from './guards/jwt-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly authClient: AuthClientService,
    private readonly invitations: InvitationsService,
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
}

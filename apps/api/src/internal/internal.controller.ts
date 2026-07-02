import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { CreateFleetUserDto } from './dto/fleet-user.dto';
import { FleetIdDto, ProvisionFleetDto } from './dto/provision-fleet.dto';
import { InternalSecretGuard } from './internal-secret.guard';

@Controller('internal')
@UseGuards(InternalSecretGuard)
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authClient: AuthClientService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /**
   * Journal Système — ces routes machine (secret partagé, PAS de req.user) sont
   * précisément celles qu'un attaquant ayant volé INTERNAL_SECRET utiliserait :
   * provision de flotte, kill-switch client, création/suppression de comptes.
   */
  private recordInternal(action: string, fleetId: string | null, target: string | null, detail?: string): void {
    this.systemActivity.record({
      category: 'INTERNAL',
      action,
      status: 'SUCCESS',
      actor: 'vizyo-manager',
      target,
      detail: detail ?? null,
      fleetId,
    });
  }

  @Post('fleet/provision')
  @HttpCode(HttpStatus.CREATED)
  async provisionFleet(@Body() dto: ProvisionFleetDto) {
    const fleet = await this.prisma.fleet.create({
      data: {
        name: dto.fleetName,
        clientId: dto.clientId,
      },
    });

    await this.prisma.user.create({
      data: {
        authUserId: dto.adminAuthUserId,
        email: dto.adminEmail,
        firstName: dto.adminFirstName,
        lastName: dto.adminLastName,
        role: UserRole.FLEET_ADMIN,
        fleetId: fleet.id,
      },
    });

    this.recordInternal('fleet_provisioned', fleet.id, dto.fleetName, `Admin ${dto.adminEmail}`);
    return { fleetId: fleet.id };
  }

  @Post('fleet/suspend')
  @HttpCode(HttpStatus.OK)
  async suspendFleet(@Body() dto: FleetIdDto) {
    const r = await this.prisma.user.updateMany({
      where: { fleetId: dto.fleetId },
      data: { isActive: false },
    });
    this.recordInternal('fleet_suspended', dto.fleetId, `${r.count} compte(s) désactivé(s)`);
    return { status: 'suspended' };
  }

  @Post('fleet/activate')
  @HttpCode(HttpStatus.OK)
  async activateFleet(@Body() dto: FleetIdDto) {
    const r = await this.prisma.user.updateMany({
      where: { fleetId: dto.fleetId },
      data: { isActive: true },
    });
    this.recordInternal('fleet_activated', dto.fleetId, `${r.count} compte(s) réactivé(s)`);
    return { status: 'active' };
  }

  // ─── Fleet Users (appelés par Manager) ──────────────────

  @Get('fleet/:fleetId/users')
  async listFleetUsers(@Param('fleetId') fleetId: string) {
    return this.prisma.user.findMany({
      where: { fleetId },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('fleet/:fleetId/users')
  @HttpCode(HttpStatus.CREATED)
  async createFleetUser(@Param('fleetId') fleetId: string, @Body() dto: CreateFleetUserDto) {
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId } });
    if (!fleet) throw new NotFoundException('Fleet not found');

    const displayName = [dto.firstName, dto.lastName].filter(Boolean).join(' ') || undefined;
    const result = await this.authClient.register(dto.email, dto.password, displayName);

    let authUserId = result.id;
    if (!authUserId) {
      const tokens = await this.authClient.login(dto.email, dto.password);
      const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64').toString());
      authUserId = payload.sub as string;
    }

    const user = await this.prisma.user.create({
      data: {
        authUserId,
        email: dto.email.toLowerCase(),
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: UserRole.VIEWER,
        fleetId,
      },
    });

    this.recordInternal('fleet_user_created', fleetId, user.email);
    return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role };
  }

  @Delete('fleet/:fleetId/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFleetUser(@Param('fleetId') fleetId: string, @Param('userId') userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.fleetId !== fleetId) throw new NotFoundException('User not found in fleet');

    await this.authClient.removeUserFromApp(user.authUserId);
    await this.prisma.user.delete({ where: { id: userId } });
    this.recordInternal('fleet_user_deleted', fleetId, user.email, 'Suppression définitive (Tracky + Auth)');
  }
}

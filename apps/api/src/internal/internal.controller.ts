import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFleetUserDto } from './dto/fleet-user.dto';
import { FleetIdDto, ProvisionFleetDto } from './dto/provision-fleet.dto';
import { InternalSecretGuard } from './internal-secret.guard';

@Controller('internal')
@UseGuards(InternalSecretGuard)
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authClient: AuthClientService,
  ) {}

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

    return { fleetId: fleet.id };
  }

  @Post('fleet/suspend')
  @HttpCode(HttpStatus.OK)
  async suspendFleet(@Body() dto: FleetIdDto) {
    await this.prisma.user.updateMany({
      where: { fleetId: dto.fleetId },
      data: { isActive: false },
    });
    return { status: 'suspended' };
  }

  @Post('fleet/activate')
  @HttpCode(HttpStatus.OK)
  async activateFleet(@Body() dto: FleetIdDto) {
    await this.prisma.user.updateMany({
      where: { fleetId: dto.fleetId },
      data: { isActive: true },
    });
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

    return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role };
  }

  @Delete('fleet/:fleetId/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFleetUser(@Param('fleetId') fleetId: string, @Param('userId') userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.fleetId !== fleetId) throw new NotFoundException('User not found in fleet');

    await this.authClient.removeUserFromApp(user.authUserId);
    await this.prisma.user.delete({ where: { id: userId } });
  }
}

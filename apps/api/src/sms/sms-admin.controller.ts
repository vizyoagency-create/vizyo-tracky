import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SmsGatewayService } from './sms-gateway.service';
import { TrackerProvisioningService } from './tracker-provisioning.service';

/**
 * V1.5 (Sprint I) — Admin SMS endpoints.
 *
 * Toutes les routes sont reservees SUPER_ADMIN (decision §0.3 de la roadmap 13).
 * Les FLEET_ADMIN n'ont pas besoin d'acces SMS direct.
 */
@Controller('admin/sms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SmsAdminController {
  constructor(
    private readonly sms: SmsGatewayService,
    private readonly provisioning: TrackerProvisioningService,
  ) {}

  @Get('status')
  status() {
    return {
      enabled: this.sms.isEnabled(),
      mode: this.sms.isEnabled() ? 'twilio' : 'noop',
    };
  }

  @Post('send')
  async sendArbitrary(@Body() body: { to: string; message: string }) {
    if (!body?.to || !body?.message) {
      throw new BadRequestException('to et message sont requis');
    }
    return this.sms.send(body.to, body.message);
  }

  @Get('logs')
  async logs(@Query('limit') limitRaw?: string, @Query('imei') imei?: string) {
    const limit = Math.max(1, Math.min(parseInt(limitRaw ?? '100', 10) || 100, 500));
    const items = await this.sms.listLogs(limit, imei);
    return { items };
  }

  @Post('provision')
  async startProvisioning(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      imei: string;
      phoneNumber: string;
      apn: string;
      apnUser?: string;
      apnPasswd?: string;
      serverIp: string;
      serverPort: number;
      lowBatteryPhone?: string;
    },
  ) {
    return this.provisioning.start(body, req.user.id);
  }

  @Get('provision')
  async listProvisioning(@Query('limit') limitRaw?: string) {
    const limit = Math.max(1, Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200));
    return { items: await this.provisioning.list(limit) };
  }

  @Get('provision/:id')
  async getProvisioning(@Param('id', ParseUUIDPipe) id: string) {
    return this.provisioning.findOne(id);
  }

  @Post('provision/:id/cancel')
  async cancelProvisioning(@Param('id', ParseUUIDPipe) id: string) {
    await this.provisioning.cancel(id);
    return { ok: true };
  }
}

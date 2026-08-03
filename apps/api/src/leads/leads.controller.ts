import { clientIp } from '../common/client-ip';
import { Body, Controller, Post, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { LeadsService } from './leads.service';
import { CreateLeadDto } from './dto/create-lead.dto';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  /** Public — pas de JwtAuthGuard. Rate-limité à 5 req/min par IP. */
  @Post('contact')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async submitLead(@Body() dto: CreateLeadDto, @Req() req: Request) {
    // ⚠️ Plus de lecture du premier hop : il est ecrit par le client (cf. common/client-ip.ts).
    // `?? undefined` : le service attend `string | undefined`, pas `null`.
    return this.leadsService.createLead(dto, clientIp(req) ?? undefined);
  }
}

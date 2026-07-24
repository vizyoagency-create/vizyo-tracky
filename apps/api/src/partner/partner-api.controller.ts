import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerConfigService } from './partner.config';
import { PartnerTokenGuard, RequirePartnerScope, type PartnerRequest } from './partner-token.guard';
import { PartnerTokenService } from './partner-token.service';
import { PartnerWritebackService } from './partner-writeback.service';

/**
 * API partenaire : ce que Maestroo consomme réellement.
 *
 * ⚠️ Deux régimes d'authentification DIFFÉRENTS, volontairement séparés :
 *  - `/token` présente la CRÉDENCE DE LIEN (longue durée, propre au client) ;
 *  - tout le reste présente un JETON DE BAIL (10 min, révocable instantanément).
 * La crédence ne circule donc que sur un seul endpoint.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §8.1
 */
@Controller('partner/v1')
export class PartnerApiController {
  constructor(
    private readonly tokens: PartnerTokenService,
    private readonly config: PartnerConfigService,
    private readonly prisma: PrismaService,
    private readonly writebackSvc: PartnerWritebackService,
  ) {}

  /** Échange crédence de lien → jeton de bail. Renvoie les scopes AUTORITAIRES. */
  @Post('token')
  async token(
    @Headers('x-partner-link') linkId: string | undefined,
    @Headers('x-partner-secret') secret: string | undefined,
  ) {
    if (!this.config.enabled) throw new NotFoundException();
    if (!linkId || !secret) throw new BadRequestException('Credentials requises');
    return this.tokens.issue(linkId, secret);
  }

  /**
   * Sonde de liaison. Aucune donnée métier — sert au partenaire à savoir s'il est
   * toujours autorisé, et à nous à vérifier la chaîne de bout en bout.
   */
  @Get('ping')
  @UseGuards(PartnerTokenGuard)
  async ping(@Req() req: PartnerRequest) {
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: req.partner.fleetId },
      select: { name: true },
    });
    return {
      linkId: req.partner.linkId,
      fleetName: fleet?.name ?? null,
      scopes: req.partner.scopes,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Premier endpoint PORTANT UNE DONNÉE, volontairement minimal : il n'existe que
   * pour prouver la chaîne complète « je récupère → je stocke en quarantaine → on
   * révoque → tout disparaît » (incr. 0.6-0.7). Rien d'autre n'est exposé en lot 0.
   */
  @Get('vehicles/count')
  @UseGuards(PartnerTokenGuard)
  @RequirePartnerScope('VEHICLE_IDENTITY')
  async vehiclesCount(@Req() req: PartnerRequest) {
    const total = await this.prisma.vehicle.count({ where: { fleetId: req.partner.fleetId } });
    return { total };
  }

  /**
   * L'écriture ENTRANTE (étape 4, doc 25 §3.3) : le client a tranché un écart en
   * faveur de Maestroo, la valeur choisie atterrit ici.
   *
   * ⚠️ Le scope `VEHICLE_WRITEBACK` est VIVANT : le client l'éteint, cette route
   * répond 403 à la requête suivante. L'allowlist de champs et le CAS vivent
   * dans le service.
   */
  @Post('vehicles/writeback')
  @UseGuards(PartnerTokenGuard)
  @RequirePartnerScope('VEHICLE_WRITEBACK')
  async writeback(
    @Req() req: PartnerRequest,
    @Body()
    body: {
      vehicleId?: string;
      field?: string;
      value?: unknown;
      expectedValue?: unknown;
      resolutionId?: string;
    },
  ) {
    if (!body?.vehicleId || !body?.field || !body?.resolutionId) {
      throw new BadRequestException('vehicleId, field et resolutionId requis');
    }
    return this.writebackSvc.apply({
      fleetId: req.partner.fleetId,
      linkId: req.partner.linkId,
      vehicleId: body.vehicleId,
      field: body.field,
      value: body.value ?? null,
      expectedValue: body.expectedValue ?? null,
      resolutionId: body.resolutionId,
    });
  }
}

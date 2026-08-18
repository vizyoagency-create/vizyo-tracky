import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { TrackerOnboardingService } from './tracker-onboarding.service';
import { RattachementService } from './rattachement.service';
import { VerrouProvisioningRegistry } from './verrou-provisioning.registry';

/**
 * Mise en service d'un boîtier — résolution d'un code scanné ou saisi.
 *
 * Mêmes droits que la création de véhicule (`vehicles_create`) : c'est la première étape
 * du même geste. Y mettre `SUPER_ADMIN` seul obligerait chaque installateur à passer par
 * un administrateur pour poser un boîtier.
 */
@Controller('tracker-onboarding')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class TrackerOnboardingController {
  constructor(
    private readonly onboarding: TrackerOnboardingService,
    private readonly verrou: VerrouProvisioningRegistry,
    private readonly rattachement: RattachementService,
  ) {}

  /** Nom lisible du détenteur — l'e-mail seul ne dit pas à qui on doit demander. */
  private nomDe(u: { firstName: string | null; lastName: string | null; email: string }): string {
    const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return n || u.email;
  }

  /**
   * Que vaut ce code ? Rend l'identité du boîtier et la marche à suivre.
   *
   * En GET : c'est une pure lecture, sans effet de bord — donc rejouable, cachable par le
   * navigateur, et sans danger si l'installateur rafraîchit sa page en plein scan.
   */
  @Get('resoudre')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  resoudre(@Query('code') code: string, @Req() req: AuthenticatedRequest) {
    if (!code || code.trim().length === 0) {
      throw new BadRequestException('Indiquez un code à résoudre.');
    }
    if (code.length > 256) {
      // Un code-barré ne fait jamais 256 caractères : au-delà, c'est du bruit ou une
      // tentative d'engorger la recherche. On refuse tôt plutôt que d'interroger la base.
      throw new BadRequestException('Code trop long pour être un identifiant de boîtier.');
    }
    return this.onboarding.resoudre(code, { role: req.user.role, fleetId: req.user.fleetId ?? null });
  }

  /** Qui détient le verrou d'écoute aveugle, et depuis quand. */
  @Get('verrou')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  etatVerrou(@Req() req: AuthenticatedRequest) {
    return this.verrou.etat(req.user.id);
  }

  /**
   * Prend le verrou, ou le rafraîchit — c'est le même appel.
   *
   * Idempotent à dessein : le client bat toutes les 20 s avec cette route, sans avoir à
   * distinguer « je prends » de « je maintiens ». Deux verbes pour un seul geste
   * inviteraient à des désynchronisations entre l'état du client et celui du serveur.
   */
  @Post('verrou')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  prendreVerrou(@Req() req: AuthenticatedRequest, @Body() body: { contexte?: string }) {
    const contexte = typeof body?.contexte === 'string' ? body.contexte.slice(0, 40) : null;
    return this.verrou.prendre({
      userId: req.user.id,
      nom: this.nomDe(req.user),
      email: req.user.email,
      contexte,
    });
  }

  /**
   * Rend le verrou. `force=1` le retire à quelqu'un d'autre — SUPER_ADMIN uniquement.
   *
   * L'évincé n'est pas notifié dans l'instant : son prochain battement lui répondra
   * `parMoi: false` et son écran basculera, au pire vingt secondes plus tard.
   */
  @Delete('verrou')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  rendreVerrou(@Req() req: AuthenticatedRequest, @Query('force') force?: string) {
    if (force === '1') {
      if (req.user.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenException("Seul un super-administrateur peut libérer la session d'un autre compte.");
      }
      return this.verrou.forcer(req.user.email);
    }
    return this.verrou.rendre(req.user.id);
  }

  /**
   * Rattache le boîtier au véhicule — en le déclarant s'il n'existe pas encore.
   *
   * Le serveur TCP relit la base à chaque ouverture de session : déclarer maintenant
   * suffit pour que la prochaine trame soit acceptée, même si le boîtier se tait.
   */
  @Post('rattacher')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  rattacher(
    @Req() req: AuthenticatedRequest,
    @Body() body: { vehicleId?: string; imei?: string; msisdn?: string | null },
  ) {
    if (!body?.vehicleId || !body?.imei) {
      throw new BadRequestException('vehicleId et imei sont requis.');
    }
    return this.rattachement.rattacher({
      vehicleId: body.vehicleId,
      imei: body.imei,
      msisdn: body.msisdn ?? null,
      demandeur: {
        userId: req.user.id,
        email: req.user.email,
        role: req.user.role,
        fleetId: req.user.fleetId ?? null,
      },
    });
  }

  /**
   * Où en est l'attente de la première connexion ? Sondé pendant la fenêtre d'écoute.
   *
   * Volontairement léger : appelé toutes les 3 s pendant 60 s, il ne doit rien coûter.
   */
  @Get('attente')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  attente(@Query('trackerId') trackerId: string) {
    if (!trackerId) throw new BadRequestException('trackerId requis.');
    return this.rattachement.attente(trackerId);
  }
}

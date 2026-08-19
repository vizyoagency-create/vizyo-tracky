import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuditAlertesService, type FiltresAudit } from './audit-alertes.service';

/**
 * Audit des alertes — SUPER_ADMIN uniquement.
 *
 * La donnee est cross-flotte par nature : comprendre un deluge d'alertes suppose de voir
 * TOUS les vehicules, y compris ceux d'autres societes. C'est aussi pour ca que l'ecran
 * ne s'ouvre qu'au super-admin : il expose des trames brutes et des IMEI de tout le parc.
 */
@Controller('admin/audit-alertes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AuditAlertesController {
  constructor(private readonly audit: AuditAlertesService) {}

  /** Les alertes, avec leur trame brute a cote. */
  @Get()
  lignes(@Query() q: FiltresAudit) {
    return this.audit.lignes({
      ...q,
      page: q.page ? Number(q.page) : undefined,
      taille: q.taille ? Number(q.taille) : undefined,
    });
  }

  /** Le meme corpus, regroupe PAR CAUSE — la vue qui repond « d'ou ca vient ? ». */
  @Get('causes')
  causes(@Query() q: FiltresAudit) {
    return this.audit.causes(q);
  }
}

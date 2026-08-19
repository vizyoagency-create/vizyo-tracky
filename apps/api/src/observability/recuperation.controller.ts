import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RecuperationService } from './recuperation.service';

/**
 * Ce que nos services d'enrichissement ont récupéré — SUPER_ADMIN uniquement.
 *
 * La donnée est cross-flotte par construction : on compte des trajets et des portions de route
 * de tout le parc, sans distinction de société. C'est aussi pourquoi l'écran ne s'ouvre qu'au
 * super-administrateur.
 */
@Controller('admin/recuperation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class RecuperationController {
  constructor(private readonly recuperation: RecuperationService) {}

  @Get()
  etat() {
    return this.recuperation.etat();
  }
}

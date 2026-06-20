import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UnknownTrackerRegistry } from './unknown-trackers.registry';

/**
 * Vue admin "Boîtiers non reconnus" — liste les IMEI qui tentent de se connecter en GPRS mais
 * ne sont pas enregistrés (→ le boîtier retombe en SMS). Aide au provisioning : on voit quel
 * boîtier physique n'est pas (ou mal) créé, et on le crée en 1 clic depuis le front.
 * SUPER_ADMIN uniquement : la donnée est cross-flotte (un IMEI inconnu n'a pas de flotte).
 */
@Controller('admin/unknown-trackers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class UnknownTrackersController {
  constructor(private readonly registry: UnknownTrackerRegistry) {}

  @Get()
  list() {
    return this.registry.list();
  }

  /** Retire manuellement un IMEI de la liste (réapparaîtra s'il retente une connexion). */
  @Delete(':imei')
  forget(@Param('imei') imei: string) {
    this.registry.forget(imei);
    return { ok: true };
  }
}

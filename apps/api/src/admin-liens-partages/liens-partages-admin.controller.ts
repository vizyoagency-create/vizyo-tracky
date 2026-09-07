import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  DUREES_PROLONGATION,
  type DureeProlongation,
  type EtatLienPartage,
  type LienPartageAdminDto,
  type TypeLienPartage,
  type VueLiensPartagesDto,
} from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LiensPartagesAdminService } from './liens-partages-admin.service';

/**
 * LA VUE D'ENSEMBLE DES ACCÈS PUBLICS — SUPER_ADMIN uniquement.
 *
 * ⚠️ CROSS-SOCIÉTÉ PAR CONSTRUCTION, et c'est toute la raison de la restriction. La question
 * posée est « qu'est-ce qui est ouvert chez TOUS mes clients ? » : y répondre suppose de lire
 * les liens de chacun d'eux. Un administrateur de flotte a déjà sa vue, bornée à sa société,
 * dans l'écran Rapports — c'est là qu'il doit rester.
 */
@Controller('admin/liens-partages')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class LiensPartagesAdminController {
  constructor(private readonly liens: LiensPartagesAdminService) {}

  @Get()
  async vue(
    @Query('fleetId') fleetId?: string,
    @Query('etat') etat?: string,
    @Query('type') type?: string,
  ): Promise<VueLiensPartagesDto> {
    return this.liens.vue({
      fleetId: fleetId || undefined,
      etat: this.etatValide(etat),
      type: this.typeValide(type),
    });
  }

  /**
   * Prolonger l'échéance d'un lien.
   *
   * ⚠️ `POST` et non `PATCH` : ce n'est pas une édition de champ, c'est un GESTE — il ajoute
   * une ligne au journal, incrémente un compteur, et sera relu comme tel dans l'historique.
   */
  @Post(':type/:id/prolonger')
  async prolonger(
    @Req() req: AuthenticatedRequest,
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() body: { duree?: string },
  ): Promise<LienPartageAdminDto> {
    return this.liens.prolonger(this.typeObligatoire(type), id, this.dureeValide(body?.duree), req.user);
  }

  /** Révocation immédiate : le lien cesse de fonctionner à la requête suivante. */
  @Delete(':type/:id')
  async revoquer(
    @Req() req: AuthenticatedRequest,
    @Param('type') type: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.liens.revoquer(this.typeObligatoire(type), id, req.user);
  }

  /** Un filtre inconnu est ignoré — il ne doit jamais VIDER la liste en silence. */
  private etatValide(v: unknown): EtatLienPartage | undefined {
    return v === 'ACTIF' || v === 'EXPIRE' || v === 'REVOQUE' ? v : undefined;
  }

  private typeValide(v: unknown): TypeLienPartage | undefined {
    return v === 'TRAJET' || v === 'MISSION' ? v : undefined;
  }

  /**
   * Sur un CHEMIN, en revanche, un type inconnu ne peut pas être ignoré : il faudrait deviner
   * dans quelle table chercher. On refuse, plutôt que d'agir sur la mauvaise.
   */
  private typeObligatoire(v: string): TypeLienPartage {
    const t = this.typeValide(v);
    if (!t) throw new Error(`Type de lien inconnu : ${v}`);
    return t;
  }

  /**
   * Une durée inconnue retombe sur la PLUS COURTE, pas sur le défaut de création.
   *
   * ⚠️ La dissymétrie est voulue : à la création, un repli sur 24 h sert l'utilisateur qui n'a
   * rien choisi. Ici, le lien vit DÉJÀ — un client qui envoie n'importe quoi ne doit pas
   * obtenir sept jours de plus par accident. Le repli va vers ce qui expose le moins.
   */
  private dureeValide(v: unknown): DureeProlongation {
    return DUREES_PROLONGATION.includes(v as DureeProlongation) ? (v as DureeProlongation) : 'HOUR_1';
  }
}

import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VpsAuditWikiService } from './vps-audit-wiki.service';

/**
 * Documentation de l'audit VPS, en lecture, pour l'écran d'administration.
 *
 * SUPER_ADMIN uniquement — et le périmètre est ici plus sensible que celui du centre
 * d'alerte : ces rapports nomment des ports ouverts, des versions de paquets en retard et
 * des IP qui tentent de forcer SSH. C'est une carte des faiblesses de la machine ; elle ne
 * sort pas du cercle qui peut les corriger.
 */
@Controller('admin/vps/wiki')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class VpsAuditWikiController {
  constructor(private readonly wiki: VpsAuditWikiService) {}

  /** Sommaire : sections, documents et journal des passages d'audit. */
  @Get()
  async index() {
    return this.wiki.index();
  }

  /**
   * Contenu d'un document.
   *
   * Le slug passe en QUERY plutôt qu'en paramètre de route : il contient un `/`
   * (`rapports/2026-08-04.md`), qu'un `:param` couperait.
   */
  @Get('doc')
  async document(@Query('slug') slug?: string) {
    if (!slug || typeof slug !== 'string') {
      throw new BadRequestException('Paramètre `slug` requis');
    }
    return this.wiki.document(slug);
  }

  /** Diagnostic : où le service a cherché la documentation, et ce qu'il a trouvé. */
  @Get('debug')
  async debug() {
    return this.wiki.debugRoots();
  }
}

import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CentreAlerteWikiService } from './centre-alerte-wiki.service';

/**
 * Documentation du centre d'alerte, en lecture, pour l'écran d'administration.
 *
 * Préfixe `admin/alerts/wiki` : plus spécifique que les routes de `AdminAlertsController`
 * (`admin/alerts`), qui n'expose aucun paramètre joker à sa racine — aucune collision.
 *
 * SUPER_ADMIN uniquement. Ces documents nomment des véhicules, des IMEI et des adresses
 * e-mail de clients : ils suivent le même périmètre que le centre d'alerte lui-même, qui
 * est déjà réservé au super-administrateur pour la partie « erreurs applicatives ».
 */
@Controller('admin/alerts/wiki')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class CentreAlerteWikiController {
  constructor(private readonly wiki: CentreAlerteWikiService) {}

  /** Sommaire : sections, documents et journal des passages d'audit. */
  @Get()
  async index() {
    return this.wiki.index();
  }

  /**
   * Contenu d'un document.
   *
   * Le slug passe en QUERY plutôt qu'en paramètre de route : il contient un `/`
   * (`rapports/2026-08-03.md`), qu'un `:param` couperait. C'est aussi ce qui évite
   * d'avoir à ré-encoder le chemin côté client.
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

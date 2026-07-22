import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PartnerScope } from '@vizyo/tracky-shared';
import { PartnerConfigService } from './partner.config';
import { PartnerTokenService, type PartnerTokenContext } from './partner-token.service';

export const PARTNER_SCOPE_KEY = 'partner:scope';

/**
 * Catégorie de données requise par la route.
 *
 * ⚠️ Le scope est vérifié à CHAQUE requête, pas seulement à l'affichage : c'est ce qui
 * rend l'interrupteur du client réellement vivant (décision D3). Éteindre une catégorie
 * doit couper l'accès dans la seconde, sans redéploiement ni renouvellement de jeton.
 */
export const RequirePartnerScope = (scope: PartnerScope) => SetMetadata(PARTNER_SCOPE_KEY, scope);

export interface PartnerRequest extends Request {
  partner: PartnerTokenContext;
}

/**
 * Authentifie une requête partenaire par son jeton de bail (Bearer) et applique le
 * scope déclaré par la route.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §7, §8.1
 */
@Injectable()
export class PartnerTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: PartnerTokenService,
    private readonly config: PartnerConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Module éteint : indiscernable d'une route absente (même règle que la garde
    // de signature). Un 403 confirmerait que l'endpoint existe.
    if (!this.config.enabled) throw new NotFoundException();

    const req = context.switchToHttp().getRequest<PartnerRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing partner token');
    }

    const ctx = await this.tokens.resolve(header.slice('Bearer '.length).trim());
    req.partner = ctx;

    const required = this.reflector.getAllAndOverride<PartnerScope | undefined>(PARTNER_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Pas de scope déclaré = route de service (ping) : le jeton valide suffit.
    if (required && !ctx.scopes.includes(required)) {
      throw new ForbiddenException(`Scope ${required} non partage`);
    }
    return true;
  }
}

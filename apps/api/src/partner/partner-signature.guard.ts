import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PartnerConfigService } from './partner.config';
import { PartnerSignatureError, verifyPartnerRequest } from './partner-signature';

export const PARTNER_OP_KEY = 'partner:op';

/**
 * Déclare l'identifiant d'opération signé pour cette route.
 *
 * ⚠️ C'est le SERVEUR qui impose cette valeur : elle n'est jamais lue depuis la
 * requête. C'est ce qui rend le rejeu inter-endpoints impossible (cf.
 * `buildCanonicalString`). Deux routes ne doivent JAMAIS partager le même `op`.
 */
export const PartnerOp = (op: string) => SetMetadata(PARTNER_OP_KEY, op);

/**
 * Vérifie la signature HMAC des requêtes partenaires entrantes (secret de plateforme).
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §5
 */
@Injectable()
export class PartnerSignatureGuard implements CanActivate {
  private readonly logger = new Logger(PartnerSignatureGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: PartnerConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Kill-switch de déploiement : 404 et non 403. Un 403 confirmerait que la route
    // EXISTE ; un 404 ne dit rien. Tant que l'intégration n'est pas ouverte, elle
    // doit être indiscernable d'une route absente.
    if (!this.config.enabled) {
      throw new NotFoundException();
    }

    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();

    const op = this.reflector.getAllAndOverride<string | undefined>(PARTNER_OP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!op) {
      // Erreur de programmation, pas d'un appelant : une route signée SANS `op`
      // accepterait une signature valable ailleurs. On refuse de servir plutôt que
      // de dégrader silencieusement la garantie.
      this.logger.error(
        `Route partenaire sans @PartnerOp : ${context.getClass().name}.${context.getHandler().name}`,
      );
      throw new UnauthorizedException('Partner opération not declared');
    }

    try {
      verifyPartnerRequest(this.config.platformSecret, {
        method: req.method,
        op,
        // Le corps BRUT, jamais le JSON re-sérialisé : `JSON.stringify(req.body)`
        // ne redonne pas forcément les mêmes octets (ordre des clés, espaces,
        // échappement unicode) et la signature échouerait de façon aléatoire.
        rawBody: req.rawBody ? req.rawBody.toString('utf8') : '',
        timestamp: header(req, 'x-partner-timestamp'),
        signature: header(req, 'x-partner-signature'),
      });
      return true;
    } catch (err) {
      if (err instanceof PartnerSignatureError) {
        // La raison est journalisée pour le diagnostic mais JAMAIS renvoyée au
        // client : elle indiquerait à un attaquant quel critère il a franchi.
        this.logger.warn(`Signature partenaire rejetée (${err.reason}) sur ${op}`);
        throw new UnauthorizedException('Invalid partner signature');
      }
      throw err;
    }
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

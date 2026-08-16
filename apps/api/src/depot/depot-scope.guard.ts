import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { DEPOT_SCOPE_KEY, type DepotScopeSpec } from './depot-scope.decorator';
import { DepotScopeService } from './depot-scope.service';

/**
 * Espace depot (2026-08) — le garde qui borne un compte DEPOT a son perimetre.
 *
 * Comportement :
 *   - `user.role !== DEPOT` → laisse passer. Les autres gardes s'appliquent
 *     normalement ; ce garde n'a rien a dire sur les comptes de la flotte.
 *   - `user.role === DEPOT` → resout le parametre de route (missionId | vehicleId |
 *     tripId), interroge `DepotScopeService`, et refuse par un 403 si hors perimetre.
 *
 * ┌─ DEUX REGLES QUI NE SE NEGOCIENT PAS ─────────────────────────────────────┐
 * │                                                                            │
 * │ 1. `403`, JAMAIS `200 []`. Un tableau vide laisse deduire que la ressource  │
 * │    existe mais est vide ; un 403 ne dit rien. C'est la difference entre     │
 * │    « il n'y a pas de camion » et « il y a un camion, mais pas pour vous ».  │
 * │                                                                            │
 * │ 2. Identifiant INCONNU et identifiant HORS PERIMETRE renvoient le MEME      │
 * │    code et le MEME message. Distinguer 404 et 403 permettrait d'enumerer    │
 * │    les identifiants valides : on demande, et le code de retour repond.      │
 * │    D'ou un unique `ForbiddenException` au libelle neutre.                   │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * A appliquer sur TOUS les controleurs qu'un depot peut atteindre, y compris ceux
 * qui existaient deja (`positions`, `trips`). Une route oubliee est une faille —
 * d'ou la revue exhaustive des modules consignee dans design/DECISIONS.md § D10.
 *
 * Ordre : `@UseGuards(JwtAuthGuard, DepotScopeGuard)`. Il assume `req.user` resolu.
 *
 * Cf. design/A1-ROLE-DEPOT.md § 3.
 */
@Injectable()
export class DepotScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly scope: DepotScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;

    // Les comptes de la flotte ne sont pas concernes : ce garde ne borne que le depot.
    if (!user || user.role !== UserRole.DEPOT) return true;

    const spec = this.reflector.getAllAndOverride<DepotScopeSpec | undefined>(DEPOT_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Aucune declaration de perimetre sur une route qu'un DEPOT atteint : on REFUSE.
    // Default-deny volontaire — l'oubli d'un decorateur ne doit pas ouvrir la route.
    // C'est la difference entre « je n'ai pas pense a ce cas » et « j'ai ouvert ce cas ».
    if (!spec) {
      throw new ForbiddenException('Ressource hors de votre périmètre');
    }

    if (spec.kind === 'none') return true;

    const id = this.extraireParametre(req, spec.paramName);
    if (!id) {
      // Parametre absent : on refuse, sans distinguer du hors-perimetre.
      throw new ForbiddenException('Ressource hors de votre périmètre');
    }

    const autorise = await this.verifier(spec.kind, user.id, id);
    if (!autorise) {
      throw new ForbiddenException('Ressource hors de votre périmètre');
    }

    return true;
  }

  private verifier(
    kind: Exclude<DepotScopeSpec['kind'], 'none'>,
    userId: string,
    id: string,
  ): Promise<boolean> {
    switch (kind) {
      case 'mission':
        return this.scope.canSeeMission(userId, id);
      case 'vehiclePosition':
        return this.scope.canSeeLivePosition(userId, id);
      case 'trip':
        return this.scope.canSeeTrip(userId, id);
    }
  }

  /** params → body → query. Le premier qui porte une chaine non vide gagne. */
  private extraireParametre(req: AuthenticatedRequest, nom: string): string | undefined {
    const sources: Array<Record<string, unknown> | undefined> = [
      req.params as Record<string, unknown>,
      req.body as Record<string, unknown> | undefined,
      req.query as Record<string, unknown> | undefined,
    ];
    for (const source of sources) {
      const valeur = source?.[nom];
      if (typeof valeur === 'string' && valeur.length > 0) return valeur;
    }
    return undefined;
  }
}

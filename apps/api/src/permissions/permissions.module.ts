import { Global, Module } from '@nestjs/common';
import { PermissionsResolverService } from './permissions-resolver.service';

/**
 * V1.11 Phase 1 — Refonte permissions.
 *
 * Module global qui expose le service de resolution des permissions per-scope.
 * Sur le modele de VehicleAccessModule (memoization request-scoped, 1 query
 * par requete HTTP, exporte sans import explicite dans les modules feature).
 */
@Global()
@Module({
  providers: [PermissionsResolverService],
  exports: [PermissionsResolverService],
})
export class PermissionsModule {}

import { SetMetadata } from '@nestjs/common';

export const DEPOT_SCOPE_KEY = 'depot_scope';

/**
 * Espace depot (2026-08) — declare CE QUE le garde doit verifier sur une route
 * qu'un compte DEPOT peut atteindre.
 *
 * `kind` dit quelle question poser au `DepotScopeService` :
 *
 *   'mission'         — la mission appartient-elle a ce depot ? (sans borne horaire :
 *                       une mission planifiee ou terminee reste consultable)
 *   'vehiclePosition' — le depot peut-il voir la position de ce vehicule MAINTENANT ?
 *                       (mission IN_PROGRESS|LATE couvrant l'instant present)
 *   'trip'            — le trajet est-il rattache a une mission de ce depot ?
 *   'none'            — route sans ressource ciblee, deja bornee par son service
 *                       (ex. `GET /depot/missions` qui filtre sur depotUserId).
 *                       A n'employer que si le `where` porte depotUserId.
 *
 * L'absence de decorateur sur une route atteinte par un DEPOT vaut REFUS
 * (default-deny dans `DepotScopeGuard`) : un oubli ferme, il n'ouvre pas.
 */
export type DepotScopeSpec =
  | { kind: 'none' }
  | { kind: 'mission' | 'vehiclePosition' | 'trip'; paramName: string };

/** Route bornee a une ressource identifiee par un parametre. */
export const DepotScope = (
  kind: 'mission' | 'vehiclePosition' | 'trip',
  paramName = 'id',
): MethodDecorator & ClassDecorator => SetMetadata(DEPOT_SCOPE_KEY, { kind, paramName });

/**
 * Route sans ressource ciblee, dont le service porte deja `depotUserId` dans son
 * `where`. Le nom est volontairement explicite : on declare qu'on a verifie, on ne
 * se contente pas d'omettre le decorateur.
 */
export const DepotScopeBorneParLeService = (): MethodDecorator & ClassDecorator =>
  SetMetadata(DEPOT_SCOPE_KEY, { kind: 'none' });

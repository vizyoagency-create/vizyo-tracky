import { inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly auth = inject(AuthService);

  /**
   * Vérifie si l'utilisateur a une permission spécifique.
   * FLEET_ADMIN et SUPER_ADMIN bypass toutes les permissions.
   */
  can(permission: string): boolean {
    const user = this.auth.user();
    if (!user) return false;

    // Admins ont toutes les permissions
    if (user.role === 'FLEET_ADMIN' || user.role === 'SUPER_ADMIN') return true;

    // Vérifier la permission spécifique
    return user.permissions?.[permission] === true;
  }
}

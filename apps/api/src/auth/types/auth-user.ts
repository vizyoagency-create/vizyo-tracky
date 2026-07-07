import type { UserRole } from '@prisma/client';
import type { UserPermissions } from '@vizyo/tracky-shared';

export interface AuthUser {
  id: string;
  authUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  /** Owner plateforme : niveau au-dessus des SUPER_ADMIN, invisible aux autres super-admins. */
  isOwner: boolean;
  fleetId: string | null;
  isActive: boolean;
  permissions: UserPermissions | null;
}

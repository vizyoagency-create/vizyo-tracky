import type { UserRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  authUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  fleetId: string | null;
  isActive: boolean;
  permissions: Record<string, boolean> | null;
}

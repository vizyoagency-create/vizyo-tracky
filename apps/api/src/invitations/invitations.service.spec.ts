import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationsService } from './invitations.service';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000002';
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000010';
const FLEET_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000020';

describe('InvitationsService.create — validation', () => {
  let service: InvitationsService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock };
    // V1.10 (Sprint 6) — updateMany ajoute au mock car InvitationsService.create
    // auto-revoke les anciennes invitations PENDING pour le meme email (cf.
    // invitations.service.ts:94). Sans ce mock, "updateMany is not a function".
    invitation: { findFirst: jest.Mock; create: jest.Mock; updateMany: jest.Mock };
    fleet: { findUnique: jest.Mock };
  };
  let email: { isEnabled: jest.Mock; send: jest.Mock; buildInvitationEmail: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn() },
      invitation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({
          id: 'inv-1', email: data.email, role: data.role, fleetId: data.fleetId,
          tokenHash: 'hash', expiresAt: data.expiresAt, status: 'PENDING',
          createdById: data.createdById, acceptedAt: null, createdAt: new Date(),
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Demo' }) },
    };
    email = {
      isEnabled: jest.fn().mockReturnValue(false),
      send: jest.fn().mockResolvedValue({ ok: true }),
      buildInvitationEmail: jest.fn().mockReturnValue({
        subject: 's', html: '<p>h</p>', text: 't',
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: AuthClientService, useValue: { register: jest.fn(), login: jest.fn(), me: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'INVITATION_JWT_SECRET') return 'test-secret';
              if (key === 'VIZYO_AUTH_JWT_ACCESS_SECRET') return 'fallback-secret';
              if (key === 'APP_BASE_URL') return 'http://localhost:4200';
              return '';
            },
          },
        },
      ],
    }).compile();
    service = module.get(InvitationsService);
  });

  it('rejects invalid email format', async () => {
    await expect(service.create({
      email: 'not-an-email',
      role: UserRole.VIEWER,
      fleetId: FLEET_ID,
      requestedByUserId: ADMIN_USER_ID,
    })).rejects.toThrow(BadRequestException);
  });

  it('rejects when user with this email already exists', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'existing', email: 'a@b.com' });
    await expect(service.create({
      email: 'a@b.com',
      role: UserRole.VIEWER,
      fleetId: FLEET_ID,
      requestedByUserId: ADMIN_USER_ID,
    })).rejects.toThrow(ConflictException);
  });

  it('auto-revokes pending invitations for the same email on re-invite', async () => {
    // V1.10 (Sprint 6) — le code ne throw plus si une invitation PENDING
    // existe ; il l'auto-revoke via updateMany pour permettre un resend
    // (cf. invitations.service.ts:94 — "Auto-revoke any existing PENDING ...").
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === ADMIN_USER_ID) {
        return Promise.resolve({
          id: ADMIN_USER_ID, email: 'admin@b.com',
          role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID,
        });
      }
      return Promise.resolve(null);
    });
    prisma.invitation.updateMany.mockResolvedValue({ count: 1 });
    await service.create({
      email: 'a@b.com',
      role: UserRole.VIEWER,
      fleetId: FLEET_ID,
      requestedByUserId: ADMIN_USER_ID,
    });
    expect(prisma.invitation.updateMany).toHaveBeenCalledWith({
      where: { email: 'a@b.com', status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
  });

  it('FLEET_ADMIN cannot invite to a different fleet', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === FLEET_ADMIN_USER_ID) {
        return Promise.resolve({
          id: FLEET_ADMIN_USER_ID, email: 'admin@b.com',
          role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID,
        });
      }
      return Promise.resolve(null);
    });
    await expect(service.create({
      email: 'newuser@b.com',
      role: UserRole.VIEWER,
      fleetId: OTHER_FLEET,
      requestedByUserId: FLEET_ADMIN_USER_ID,
    })).rejects.toThrow(ForbiddenException);
  });

  it('FLEET_ADMIN cannot create a SUPER_ADMIN', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === FLEET_ADMIN_USER_ID) {
        return Promise.resolve({
          id: FLEET_ADMIN_USER_ID, email: 'admin@b.com',
          role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID,
        });
      }
      return Promise.resolve(null);
    });
    await expect(service.create({
      email: 'newuser@b.com',
      role: UserRole.SUPER_ADMIN,
      fleetId: FLEET_ID,
      requestedByUserId: FLEET_ADMIN_USER_ID,
    })).rejects.toThrow(ForbiddenException);
  });

  it('SUPER_ADMIN can invite to any fleet', async () => {
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === ADMIN_USER_ID) {
        return Promise.resolve({
          id: ADMIN_USER_ID, email: 'super@b.com',
          role: UserRole.SUPER_ADMIN, fleetId: null,
        });
      }
      return Promise.resolve(null);
    });
    const result = await service.create({
      email: 'newuser@b.com',
      role: UserRole.FLEET_MANAGER,
      fleetId: OTHER_FLEET,
      requestedByUserId: ADMIN_USER_ID,
    });
    expect(result.id).toBe('inv-1');
    expect(result.email).toBe('newuser@b.com');
    // En mode no-op (email.isEnabled = false), on expose le lien pour debug.
    expect(result.acceptUrlForDevDebug).not.toBeNull();
    expect(email.send).toHaveBeenCalledTimes(1);
  });
});

// ─── Audit A1 — escalade de privilèges via PATCH d'une invitation ──────────
// Avant le fix, update() appliquait role/permissions sans la garde de create().
// Ces tests prouvent qu'un FLEET_ADMIN ne peut pas promouvoir une invitation en
// SUPER_ADMIN ni la sortir de sa flotte, tandis qu'un SUPER_ADMIN garde la main.
describe('InvitationsService.update — privilege escalation guard (A1)', () => {
  const PENDING = {
    id: 'inv-1',
    status: 'PENDING',
    role: UserRole.VIEWER,
    fleetId: FLEET_ID,
    permissions: null,
  };

  async function makeService(prisma: unknown): Promise<InvitationsService> {
    const module = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EmailService,
          useValue: {
            isEnabled: jest.fn().mockReturnValue(false),
            send: jest.fn().mockResolvedValue({ ok: true }),
            buildInvitationEmail: jest
              .fn()
              .mockReturnValue({ subject: 's', html: 'h', text: 't' }),
          },
        },
        {
          provide: AuthClientService,
          useValue: { register: jest.fn(), login: jest.fn(), me: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'INVITATION_JWT_SECRET') return 'test-secret';
              if (key === 'VIZYO_AUTH_JWT_ACCESS_SECRET') return 'fallback-secret';
              if (key === 'APP_BASE_URL') return 'http://localhost:4200';
              return '';
            },
          },
        },
      ],
    }).compile();
    return module.get(InvitationsService);
  }

  it('rejects a FLEET_ADMIN promoting an invitation to SUPER_ADMIN', async () => {
    const prisma = {
      invitation: { findFirst: jest.fn().mockResolvedValue(PENDING), update: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: FLEET_ADMIN_USER_ID,
          role: UserRole.FLEET_ADMIN,
          fleetId: FLEET_ID,
          permissions: null,
        }),
      },
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID }) },
    };
    const service = await makeService(prisma);

    await expect(
      service.update(
        'inv-1',
        { role: UserRole.SUPER_ADMIN },
        { id: FLEET_ADMIN_USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.invitation.update).not.toHaveBeenCalled();
  });

  it('rejects a FLEET_ADMIN reassigning an invitation to another fleet', async () => {
    const prisma = {
      invitation: { findFirst: jest.fn().mockResolvedValue(PENDING), update: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: FLEET_ADMIN_USER_ID,
          role: UserRole.FLEET_ADMIN,
          fleetId: FLEET_ID,
          permissions: null,
        }),
      },
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: OTHER_FLEET }) },
    };
    const service = await makeService(prisma);

    await expect(
      service.update(
        'inv-1',
        { fleetId: OTHER_FLEET },
        { id: FLEET_ADMIN_USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.invitation.update).not.toHaveBeenCalled();
  });

  it('allows a FLEET_ADMIN to edit an invitation within its fleet (role VIEWER)', async () => {
    const prisma = {
      invitation: {
        findFirst: jest.fn().mockResolvedValue(PENDING),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ id: 'inv-1', ...data })),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: FLEET_ADMIN_USER_ID,
          role: UserRole.FLEET_ADMIN,
          fleetId: FLEET_ID,
          permissions: null,
        }),
      },
      fleet: { findUnique: jest.fn() },
    };
    const service = await makeService(prisma);

    await service.update(
      'inv-1',
      { role: UserRole.VIEWER },
      { id: FLEET_ADMIN_USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID },
    );
    expect(prisma.invitation.update).toHaveBeenCalledTimes(1);
  });

  it('allows a SUPER_ADMIN to promote an invitation to SUPER_ADMIN', async () => {
    const prisma = {
      invitation: {
        findFirst: jest.fn().mockResolvedValue(PENDING),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ id: 'inv-1', ...data })),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: ADMIN_USER_ID,
          role: UserRole.SUPER_ADMIN,
          fleetId: null,
          permissions: null,
        }),
      },
      fleet: { findUnique: jest.fn() },
    };
    const service = await makeService(prisma);

    await service.update(
      'inv-1',
      { role: UserRole.SUPER_ADMIN },
      { id: ADMIN_USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null },
    );
    expect(prisma.invitation.update).toHaveBeenCalledTimes(1);
  });
});

describe('InvitationsService.create — access scopes (matrice dès invitation)', () => {
  const VEHICLE_ID = '00000000-0000-0000-0000-0000000000a1';
  const FOREIGN_VEHICLE_ID = '00000000-0000-0000-0000-0000000000b2';
  let service: InvitationsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockImplementation(({ where }: any) =>
          where.email
            ? Promise.resolve(null) // pas d'utilisateur existant pour cet email
            : Promise.resolve({ id: ADMIN_USER_ID, role: UserRole.SUPER_ADMIN, permissions: null, fleetId: null }),
        ),
        create: jest.fn(),
      },
      invitation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'inv-1', ...data, createdAt: new Date() })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Demo' }) },
      vehicleGroup: { findMany: jest.fn().mockResolvedValue([]) },
      vehicle: { findMany: jest.fn().mockImplementation(({ where }: any) => {
        const ids: string[] = where.id.in;
        return Promise.resolve(ids.filter((id) => id === VEHICLE_ID).map((id) => ({ id })));
      }) },
    };
    const module = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { isEnabled: () => false, send: jest.fn().mockResolvedValue({ ok: true }), buildInvitationEmail: () => ({ subject: 's', html: 'h', text: 't' }) } },
        { provide: AuthClientService, useValue: { register: jest.fn(), login: jest.fn(), me: jest.fn() } },
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'APP_BASE_URL' ? 'http://localhost:4200' : 'secret') } },
      ],
    }).compile();
    service = module.get(InvitationsService);
  });

  it('persiste les scopes et dérive `permissions` depuis le scope ALL', async () => {
    await service.create({
      email: 'scoped@demo.com',
      role: UserRole.VIEWER,
      fleetId: FLEET_ID,
      requestedByUserId: ADMIN_USER_ID,
      accessScopes: [
        { type: 'ALL', permissions: { vehicles_view: true, engine_control: false } },
        { type: 'VEHICLE', vehicleId: VEHICLE_ID, permissions: { engine_control: true } },
      ],
    });
    const data = prisma.invitation.create.mock.calls[0][0].data;
    expect(Array.isArray(data.accessScopes)).toBe(true);
    expect(data.accessScopes).toHaveLength(2);
    // `permissions` (compat / User.permissions) = jeu complet dérivé du scope ALL.
    expect(data.permissions.vehicles_view).toBe(true);
    expect(data.permissions.engine_control).toBe(false);
    // La surcharge véhicule est conservée dans les scopes.
    const vScope = data.accessScopes.find((s: any) => s.type === 'VEHICLE');
    expect(vScope.vehicleId).toBe(VEHICLE_ID);
    expect(vScope.permissions.engine_control).toBe(true);
  });

  it('rejette un scope VEHICLE hors de la flotte de l\'invité (anti-IDOR)', async () => {
    await expect(service.create({
      email: 'scoped@demo.com',
      role: UserRole.VIEWER,
      fleetId: FLEET_ID,
      requestedByUserId: ADMIN_USER_ID,
      accessScopes: [{ type: 'VEHICLE', vehicleId: FOREIGN_VEHICLE_ID, permissions: { vehicles_view: true } }],
    })).rejects.toThrow(BadRequestException);
    expect(prisma.invitation.create).not.toHaveBeenCalled();
  });
});

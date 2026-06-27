import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { clampPermissions, getDefaultPermissions } from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AudioMonitoringController } from './audio-monitoring.controller';
import { AudioMonitoringGuard } from './audio-monitoring.guard';
import { RequestListenDto } from './dto/request-listen.dto';

/**
 * Sprint 4 — Sécurité de l'écoute audio à distance (LÉGALEMENT CRITIQUE, micro
 * embarqué). Ces tests sont le LIVRABLE du STOP avant revue humaine
 * (cf. docs/sprint-4/PLAN.md §4.5) : ils prouvent l'enforcement au niveau des
 * MÉCANISMES réels (chaîne de guards effectivement posée, pivot dev/prod du
 * AudioMonitoringGuard, motif obligatoire, défauts de permission, anti-escalade)
 * et NON juste une intention déclarée.
 *
 * On reflète :
 *  (1) le @Roles réellement posé sur `listen` (Sprint 4, phase de test interne :
 *      = [SUPER_ADMIN] seul — FLEET_ADMIN temporairement retiré, à rouvrir ensuite),
 *  (2) que la chaîne @UseGuards contient RolesGuard + AudioMonitoringGuard +
 *      PermissionsGuard (sinon @Roles / la gate seraient des no-op),
 *  (3) le comportement du AudioMonitoringGuard (prod + master OFF → 403 #2 ;
 *      prod + master ON + super-admin + flag super-admin OFF → 403 #3 par défaut ;
 *      prod + master ON + super-admin + flag super-admin ON → OK phase de test ;
 *      dev → OK sans flag).
 */

// NestJS stocke les guards via cette clé de métadonnée (constante interne).
const GUARDS_METADATA = '__guards__';
const FA = UserRole.FLEET_ADMIN;
const SA = UserRole.SUPER_ADMIN;
const FM = UserRole.FLEET_MANAGER;
const VIEWER = UserRole.VIEWER;
const NW = UserRole.NIGHT_WATCHMAN;

/** Lit le tableau @Roles posé sur une méthode du controller (ou [] si absent). */
function rolesOf(ctrl: { prototype: object }, method: string): UserRole[] {
  const target = (ctrl.prototype as Record<string, unknown>)[method] as object;
  return (Reflect.getMetadata(ROLES_KEY, target) ?? []) as UserRole[];
}

/** Lit les guards @UseGuards posés sur une méthode du controller (ou [] si absent). */
function methodGuards(ctrl: { prototype: object }, method: string): unknown[] {
  const target = (ctrl.prototype as Record<string, unknown>)[method] as object;
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
}

/**
 * Construit un AudioMonitoringGuard avec un ConfigService mocké : NODE_ENV → env,
 * AUDIO_MONITORING_ENABLED → masterFlag (#2), AUDIO_SUPERADMIN_ENABLED → superFlag
 * (#3, phase de test). Reflète l'idiome `config.get(k,{infer:true})`. superFlag
 * défaut 'false' (super-admin bloqué en prod par défaut).
 */
function guardWith(env: string, masterFlag: string, superFlag = 'false'): AudioMonitoringGuard {
  const config = {
    get: (key: string) =>
      key === 'NODE_ENV'
        ? env
        : key === 'AUDIO_MONITORING_ENABLED'
          ? masterFlag
          : key === 'AUDIO_SUPERADMIN_ENABLED'
            ? superFlag
            : undefined,
  } as unknown as ConfigService<Env, true>;
  return new AudioMonitoringGuard(config);
}

/** ExecutionContext minimal exposant `{ user: { role } }` via switchToHttp. */
function ctxWithRole(role: UserRole): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('Sprint 4 — Sécurité écoute audio (audio-monitoring)', () => {
  describe('A. @Roles posés sur listen (déclenchement)', () => {
    // Sprint 4 — phase de test interne : SUPER_ADMIN seul (FLEET_ADMIN retiré
    // temporairement, à rouvrir ensuite).
    it('listen = [SUPER_ADMIN] exactement (phase de test)', () => {
      expect(rolesOf(AudioMonitoringController, 'listen')).toEqual([SA]);
    });

    it('listen ne contient PAS FLEET_ADMIN (retiré pour la phase de test)', () => {
      expect(rolesOf(AudioMonitoringController, 'listen')).not.toContain(FA);
    });

    it('listen ne contient NI FLEET_MANAGER, NI VIEWER, NI NIGHT_WATCHMAN', () => {
      const roles = rolesOf(AudioMonitoringController, 'listen');
      expect(roles).not.toContain(FM);
      expect(roles).not.toContain(VIEWER);
      expect(roles).not.toContain(NW);
    });
  });

  describe('B. Chaîne de guards câblée (anti no-op)', () => {
    it('la classe AudioMonitoringController est gardée par JwtAuthGuard (auth requise)', () => {
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, AudioMonitoringController) ??
        []) as unknown[];
      expect(classGuards).toContain(JwtAuthGuard);
    });

    it('listen : @UseGuards contient RolesGuard, AudioMonitoringGuard ET PermissionsGuard', () => {
      const guards = methodGuards(AudioMonitoringController, 'listen');
      expect(guards).toContain(RolesGuard);
      expect(guards).toContain(AudioMonitoringGuard);
      expect(guards).toContain(PermissionsGuard);
    });
  });

  describe('C. AudioMonitoringGuard — pivot dev/prod (#2/#3)', () => {
    it('prod + master flag OFF + n’importe quel rôle → 403 (#2 : écoute impossible sans flag)', () => {
      // master OFF : même le flag super-admin ON ne débloque rien (#2 prime).
      for (const role of [FA, SA, FM, VIEWER, NW]) {
        expect(() =>
          guardWith('production', 'false', 'true').canActivate(ctxWithRole(role)),
        ).toThrow(ForbiddenException);
      }
    });

    it('prod + master ON + SUPER_ADMIN + flag super-admin OFF → 403 (#3 défaut)', () => {
      expect(() => guardWith('production', 'true', 'false').canActivate(ctxWithRole(SA))).toThrow(
        ForbiddenException,
      );
    });

    it('prod + master ON + SUPER_ADMIN + flag super-admin ON → passe (phase de test interne)', () => {
      expect(guardWith('production', 'true', 'true').canActivate(ctxWithRole(SA))).toBe(true);
    });

    it('prod + master ON + FLEET_ADMIN → passe le guard (rôle non super-admin)', () => {
      expect(guardWith('production', 'true', 'false').canActivate(ctxWithRole(FA))).toBe(true);
    });

    it('development + master OFF + SUPER_ADMIN → passe (véhicule de test, pas de flag exigé)', () => {
      expect(guardWith('development', 'false', 'false').canActivate(ctxWithRole(SA))).toBe(true);
    });
  });

  describe('D. Motif obligatoire (#4) — RequestListenDto', () => {
    it('reason vide → erreurs de validation (IsNotEmpty)', async () => {
      const errors = await validate(plainToInstance(RequestListenDto, { reason: '' }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it('reason renseigné → aucune erreur', async () => {
      const errors = await validate(plainToInstance(RequestListenDto, { reason: 'vol suspecté' }));
      expect(errors.length).toBe(0);
    });
  });

  describe('E. Défauts de permission (catalogue) — audio_monitoring', () => {
    it('VIEWER / FLEET_MANAGER / NIGHT_WATCHMAN = audio_monitoring false', () => {
      expect(getDefaultPermissions('VIEWER').audio_monitoring).toBe(false);
      expect(getDefaultPermissions('FLEET_MANAGER').audio_monitoring).toBe(false);
      expect(getDefaultPermissions('NIGHT_WATCHMAN').audio_monitoring).toBe(false);
    });

    it('FLEET_ADMIN / SUPER_ADMIN = audio_monitoring true', () => {
      expect(getDefaultPermissions('FLEET_ADMIN').audio_monitoring).toBe(true);
      expect(getDefaultPermissions('SUPER_ADMIN').audio_monitoring).toBe(true);
    });
  });

  describe('F. Anti-escalade (clampPermissions)', () => {
    it('un FLEET_MANAGER (sans audio_monitoring) NE PEUT PAS l’accorder', () => {
      const clamped = clampPermissions(
        { audio_monitoring: true },
        { role: 'FLEET_MANAGER', permissions: getDefaultPermissions('FLEET_MANAGER') },
        getDefaultPermissions('NIGHT_WATCHMAN'),
      );
      expect(clamped.audio_monitoring).toBe(false);
    });
  });
});

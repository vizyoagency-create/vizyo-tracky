/**
 * Le mot de passe Coban du boîtier n'est ramené par AUCUNE lecture par défaut (2026-10-07).
 *
 * Ce test garde la seule ligne qui le protège partout : l'option `omit` passée au client Prisma.
 * La retirer ferait réapparaître `devicePassword` dans la fiche véhicule (`include: { tracker:
 * true }`), dans les alertes diffusées en temps réel, et dans une vingtaine d'autres lectures.
 * Le comportement de Prisma lui-même (une lecture `include` ne rend pas le champ ; `select` ou
 * `omit: { devicePassword: false }` le rendent) a été prouvé le 07/10 sur une base Postgres
 * temporaire, migrée avec toutes les migrations.
 */
jest.mock('@prisma/client', () => {
  class PrismaClient {
    static derniereOption: unknown;
    constructor(options: unknown) {
      PrismaClient.derniereOption = options;
    }
  }
  return { PrismaClient };
});
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(public readonly options: unknown) {}
  },
}));

import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { PrismaService } from './prisma.service';

describe('PrismaService — champs omis de toutes les lectures', () => {
  it('omet Tracker.devicePassword par défaut', () => {
    new PrismaService({ get: () => 'postgresql://u:p@localhost:5432/x' } as unknown as ConfigService<Env, true>);
    const options = (PrismaClient as unknown as { derniereOption: { omit?: unknown } }).derniereOption;
    expect(options.omit).toEqual({ tracker: { devicePassword: true } });
  });
});

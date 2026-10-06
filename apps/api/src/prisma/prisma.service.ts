import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient, type Tracker } from '@prisma/client';
import type { Env } from '../config/env.validation';

/**
 * Un boîtier TEL QUE LES LECTURES LE RENDENT : sans son mot de passe (voir `OMIS_PAR_DEFAUT`).
 * C'est le type à employer partout où l'on manipule un boîtier lu ; `Tracker` (le modèle complet)
 * ne convient qu'au code qui a demandé `devicePassword` explicitement.
 */
export type TrackerLu = Omit<Tracker, 'devicePassword'>;

/**
 * ══ CHAMPS QU'AUCUNE LECTURE NE RAMÈNE PAR DÉFAUT (2026-10-07) ═══════════════════════════════
 *
 * `Tracker.devicePassword` est le mot de passe Coban du boîtier : qui le connaît, avec le numéro
 * de la SIM, coupe ou rallume le véhicule par SMS, sans Tracky ni trace. Or une vingtaine de
 * lectures chargent la ligne boîtier ENTIÈRE (`include: { tracker: true }`), et plusieurs la
 * renvoient telle quelle — la fiche véhicule (`GET /vehicles/:id`) à TOUS les rôles qui voient
 * le véhicule, veilleur et lecteurs compris. Retirer le champ route par route, c'est attendre la
 * vingt-et-unième qu'on oubliera.
 *
 * Il est donc omis ICI, pour toutes les lectures. Les seuls endroits qui en ont besoin (construire
 * un SMS : coupe-circuit, écoute, commandes, mode fix) le demandent EXPLICITEMENT — `select` nommé
 * ou `omit: { devicePassword: false }` — et le type le dit : sans cette demande, `devicePassword`
 * n'existe pas sur l'objet lu, et le compilateur refuse de le lire.
 */
const OMIS_PAR_DEFAUT = { tracker: { devicePassword: true } } as const;

type OptionsClient = {
  adapter: PrismaPg;
  log: Prisma.LogLevel[];
  omit: typeof OMIS_PAR_DEFAUT;
};

@Injectable()
export class PrismaService extends PrismaClient<OptionsClient> implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    const adapter = new PrismaPg({
      connectionString: config.get('DATABASE_URL', { infer: true }),
    });
    super({ adapter, log: ['warn', 'error'], omit: OMIS_PAR_DEFAUT });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected via @prisma/adapter-pg');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

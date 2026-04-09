import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.validation';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    const adapter = new PrismaPg({
      connectionString: config.get('DATABASE_URL', { infer: true }),
    });
    super({ adapter, log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected via @prisma/adapter-pg');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

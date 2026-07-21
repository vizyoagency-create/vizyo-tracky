import { Module } from '@nestjs/common';
import { PublicStatsController } from './public-stats.controller';

/** D5 — chiffres publics de la LP (PrismaService est @Global : aucun import requis). */
@Module({
  controllers: [PublicStatsController],
})
export class PublicStatsModule {}

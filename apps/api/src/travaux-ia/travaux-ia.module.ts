import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TravauxIaService } from './travaux-ia.service';

/**
 * File de travaux IA exécutés sur le poste du propriétaire — design/C1-TRAVAUX-IA-LOCAUX.md.
 * Importé par chaque domaine qui veut déléguer sa génération IA récurrente au poste
 * (rapport d'activité, analyse de lieux) sans qu'une ligne de logique métier ne le quitte.
 */
@Module({
  imports: [PrismaModule],
  providers: [TravauxIaService],
  exports: [TravauxIaService],
})
export class TravauxIaModule {}

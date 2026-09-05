import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TravauxIaService } from './travaux-ia.service';

/**
 * File de travaux IA exécutés sur le poste du propriétaire — design/C1-TRAVAUX-IA-LOCAUX.md.
 * Importé par chaque domaine qui veut déléguer sa génération IA récurrente au poste
 * (rapport d'activité, analyse de lieux) sans qu'une ligne de logique métier ne le quitte.
 *
 * Depuis le 2026-09-05 (design/C3, point 6) le service alerte (`ErrorLogger`,
 * `RefroidissementAlerteService`) et journalise l'usage (`AiUsageService`) quand un travail passe
 * en `echec` : ces trois fournisseurs viennent de modules `@Global` (`ObservabilityModule`,
 * `AiUsageModule`), rien à importer ici — et ils sont `@Optional()` dans le service. La purge
 * quotidienne est un `@Cron` du service : `ScheduleModule.forRoot()` (app.module) le découvre dans
 * tout fournisseur enregistré, sans déclaration supplémentaire.
 */
@Module({
  imports: [PrismaModule],
  providers: [TravauxIaService],
  exports: [TravauxIaService],
})
export class TravauxIaModule {}

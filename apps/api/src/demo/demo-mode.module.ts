import { Global, Module } from '@nestjs/common';
import { DemoModeService } from './demo-mode.service';

/**
 * Le drapeau « démonstration », et rien d'autre.
 *
 * @Global, comme `OwnerVisibilityModule` : le serveur TCP, `/health` et deux sentinelles le
 * lisent, et aucun d'eux n'a de raison d'importer le module de démo entier (rejeu, importeur,
 * écran d'administration). Séparer le drapeau du reste évite aussi tout cycle d'imports :
 * ce module n'importe rien.
 */
@Global()
@Module({
  providers: [DemoModeService],
  exports: [DemoModeService],
})
export class DemoModeModule {}

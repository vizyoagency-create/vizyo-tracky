import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { PositionsModule } from '../positions/positions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UserActivityModule } from '../user-activity/user-activity.module';
import { DemoAdminService } from './demo-admin.service';
import { DemoConsoleController } from './demo-console.controller';
import { DemoConsoleService } from './demo-console.service';
import { DemoController } from './demo.controller';
import { DemoReplayService } from './demo-replay.service';

/**
 * Environnement de démonstration (2026-09) — docs/environnement-demo/PLAN-2026-09-07.md.
 *
 * Le rejeu de trames (`DemoReplayService`) et l'écran d'administration. Inerte sans
 * `DEMO_MODE=true` : le rejeu ne démarre pas, l'écran répond `{ demo: false }`.
 *
 * L'IMPORTEUR n'est pas ici : c'est un processus à part (`import/import.cli.ts`), sans Nest,
 * qui ne démarre ni les crons ni le serveur TCP — et qui tourne dans un conteneur éphémère,
 * le seul à voir la production.
 */
@Module({
  imports: [AuthModule, PositionsModule, RealtimeModule, InvitationsModule, UserActivityModule],
  controllers: [DemoController, DemoConsoleController],
  providers: [DemoReplayService, DemoAdminService, DemoConsoleService],
  exports: [DemoReplayService],
})
export class DemoModule {}

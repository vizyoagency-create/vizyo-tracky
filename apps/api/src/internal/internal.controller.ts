import { Body, ConflictException, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { telephoneClientE164 } from '../installation-booking/contact';
import { UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { AuthAccountSyncService } from '../users/auth-account-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { ArchiveFleetDto, DestroyFleetDto, PatchFleetDto, PutFleetDto } from './dto/fleet-sync.dto';
import { CreateFleetUserDto } from './dto/fleet-user.dto';
import { FleetIdDto, ProvisionFleetDto } from './dto/provision-fleet.dto';
import { FleetSyncService } from './fleet-sync.service';
import { InternalSecretGuard } from './internal-secret.guard';

@Controller('internal')
@UseGuards(InternalSecretGuard)
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authClient: AuthClientService,
    private readonly accountSync: AuthAccountSyncService,
    private readonly systemActivity: SystemActivityService,
    private readonly fleetSync: FleetSyncService,
  ) {}

  // ─── Lot D — synchronisation Vizyo Manager → Tracky (conception RDV v2, § 2.5 / § 4.4) ──────
  //
  // Manager est la source de vérité de l'identité du client ; ces routes la reflètent. Toute la
  // logique vit dans `FleetSyncService` (journalisée, idempotente) ; ici, seulement le câblage.

  /** Les flottes sans `clientId` — pour « Adopter une flotte Tracky existante » dans Manager. */
  @Get('fleets')
  async listFleets(@Query('unlinked') unlinked?: string) {
    if (unlinked !== 'true' && unlinked !== '1') {
      throw new ConflictException('Seule la liste des flottes non reliées est servie ici : ?unlinked=true');
    }
    return this.fleetSync.unlinked();
  }

  /** Ce qui a changé dans Manager : nom, contact, e-mail de notification, e-mail de connexion (après Auth). */
  @Patch('fleet/:fleetId')
  patchFleet(@Param('fleetId') fleetId: string, @Body() dto: PatchFleetDto) {
    return this.fleetSync.patch(fleetId, dto);
  }

  /** L'état complet, idempotent — « Resynchroniser », « Adopter » (pose le `clientId`). */
  @Put('fleet/:fleetId')
  putFleet(@Param('fleetId') fleetId: string, @Body() dto: PutFleetDto) {
    return this.fleetSync.put(fleetId, dto);
  }

  @Post('fleet/:fleetId/archive')
  @HttpCode(HttpStatus.OK)
  archiveFleet(@Param('fleetId') fleetId: string, @Body() dto: ArchiveFleetDto) {
    return this.fleetSync.archive(fleetId, dto ?? {});
  }

  @Post('fleet/:fleetId/unarchive')
  @HttpCode(HttpStatus.OK)
  unarchiveFleet(@Param('fleetId') fleetId: string, @Body() dto: ArchiveFleetDto) {
    return this.fleetSync.unarchive(fleetId, dto ?? {});
  }

  /** Effacement définitif — depuis l'archive uniquement, nom retapé (Q12, § 8.4). */
  @Delete('fleet/:fleetId')
  @HttpCode(HttpStatus.OK)
  destroyFleet(@Param('fleetId') fleetId: string, @Body() dto: DestroyFleetDto) {
    return this.fleetSync.destroy(fleetId, dto);
  }

  /**
   * Journal Système — ces routes machine (secret partagé, PAS de req.user) sont
   * précisément celles qu'un attaquant ayant volé INTERNAL_SECRET utiliserait :
   * provision de flotte, kill-switch client, création/suppression de comptes.
   */
  private recordInternal(action: string, fleetId: string | null, target: string | null, detail?: string): void {
    this.systemActivity.record({
      category: 'INTERNAL',
      action,
      status: 'SUCCESS',
      actor: 'vizyo-manager',
      target,
      detail: detail ?? null,
      fleetId,
    });
  }

  /**
   * Provision d'une flotte par Vizyo Manager (conception RDV v2, § 1.2 C1–C3).
   *
   * ┌─ TROIS DÉFAUTS RÉPARÉS ────────────────────────────────────────────────────────────────┐
   * │ C1 `clientId` est stocké (Manager l'envoie depuis le lot D) : Tracky sait enfin quelle   │
   * │    flotte appartient à quel client.                                                      │
   * │ C2 Prénom / nom / téléphone du CONTACT, plus le nom de la société en guise de prénom.   │
   * │ C3 TRANSACTION + IDEMPOTENCE : avant, la flotte était créée PUIS l'admin — un e-mail    │
   * │    déjà pris laissait une flotte orpheline, et rejouer en créait une deuxième. Désormais │
   * │    un admin déjà connu (même e-mail ou même compte Auth) rend SA flotte, sans rien créer. │
   * └────────────────────────────────────────────────────────────────────────────────────────┘
   */
  @Post('fleet/provision')
  @HttpCode(HttpStatus.CREATED)
  async provisionFleet(@Body() dto: ProvisionFleetDto) {
    const email = dto.adminEmail.trim().toLowerCase();
    const existant = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { authUserId: dto.adminAuthUserId }] },
      select: { id: true, email: true, fleetId: true, role: true },
    });
    if (existant) {
      if (!existant.fleetId) {
        throw new ConflictException(`Le compte ${existant.email} existe déjà dans Tracky sans flotte : rattachez-le à la main.`);
      }
      // Idempotent : la même demande rejouée (ou un client déjà provisionné) rend sa flotte.
      if (dto.clientId) {
        await this.prisma.fleet.update({ where: { id: existant.fleetId }, data: { clientId: dto.clientId } }).catch(() => undefined);
      }
      this.recordInternal('fleet_provision_existing', existant.fleetId, dto.fleetName, `Admin ${existant.email} déjà provisionné — flotte existante rendue`);
      return { fleetId: existant.fleetId, existed: true };
    }

    const phone = telephoneClientE164(dto.adminPhone) ?? null;
    const fleet = await this.prisma.$transaction(async (tx) => {
      // Lot D : une flotte provisionnée par Manager est pilotée par Manager dès sa naissance —
      // son admin porte `managedByManager`, ses champs d'identité se modifient là-bas.
      const f = await tx.fleet.create({ data: { name: dto.fleetName.trim(), clientId: dto.clientId ?? null, managedByManagerAt: new Date() } });
      await tx.user.create({
        data: {
          authUserId: dto.adminAuthUserId,
          email,
          firstName: dto.adminFirstName?.trim() || null,
          lastName: dto.adminLastName?.trim() || null,
          phone,
          role: UserRole.FLEET_ADMIN,
          fleetId: f.id,
          managedByManager: true,
        },
      });
      return f;
    });

    this.recordInternal('fleet_provisioned', fleet.id, dto.fleetName, `Admin ${email}${dto.clientId ? ` · client Manager ${dto.clientId}` : ''}`);
    return { fleetId: fleet.id, existed: false };
  }

  @Post('fleet/suspend')
  @HttpCode(HttpStatus.OK)
  async suspendFleet(@Body() dto: FleetIdDto) {
    // ⚠️ CE KILL-SWITCH NE COUPAIT PAS LE LOGIN.
    //
    // Il basculait `isActive` en masse dans Tracky sans rien dire a Vizyo Auth, qui est
    // la seule autorite du login. Une flotte « suspendue » gardait donc des comptes
    // parfaitement capables de se connecter — exactement l'inverse de ce que Manager
    // croit declencher en appuyant sur ce bouton.
    //
    // Meme defaut que l'archivage individuel, a l'echelle d'un client entier.
    const members = await this.prisma.user.findMany({
      where: { fleetId: dto.fleetId },
      select: { id: true, email: true, authUserId: true },
    });
    const r = await this.prisma.user.updateMany({
      where: { fleetId: dto.fleetId },
      data: { isActive: false },
    });
    const failed = await this.syncFleetStatus(members, false, 'fleet_suspend');
    this.recordInternal(
      'fleet_suspended',
      dto.fleetId,
      `${r.count} compte(s) désactivé(s)`,
      failed > 0 ? `⚠️ ${failed} compte(s) NON suspendu(s) dans Vizyo Auth — ils peuvent encore se connecter` : undefined,
    );
    return { status: 'suspended', authFailures: failed };
  }

  @Post('fleet/activate')
  @HttpCode(HttpStatus.OK)
  async activateFleet(@Body() dto: FleetIdDto) {
    // Symetrique du kill-switch : sans cet appel, une flotte reactivee resterait
    // verrouillee au login tout en s'affichant active dans Tracky.
    const members = await this.prisma.user.findMany({
      where: { fleetId: dto.fleetId },
      select: { id: true, email: true, authUserId: true },
    });
    const r = await this.prisma.user.updateMany({
      where: { fleetId: dto.fleetId },
      data: { isActive: true },
    });
    const failed = await this.syncFleetStatus(members, true, 'fleet_activate');
    this.recordInternal(
      'fleet_activated',
      dto.fleetId,
      `${r.count} compte(s) réactivé(s)`,
      failed > 0 ? `⚠️ ${failed} compte(s) NON reactive(s) dans Vizyo Auth — ils restent bloques au login` : undefined,
    );
    return { status: 'active', authFailures: failed };
  }

  /**
   * Aligne Vizyo Auth sur l'etat Tracky pour tous les membres d'une flotte.
   *
   * SEQUENTIEL a dessein : une flotte compte quelques dizaines de comptes, et lancer
   * autant d'appels HTTP en parallele sur Vizyo Auth transformerait un kill-switch en
   * micro-attaque par deni de service contre notre propre service d'authentification.
   *
   * @returns le nombre d'echecs — remonte a l'appelant ET journalise, jamais avale.
   */
  private async syncFleetStatus(
    members: Array<{ email: string; authUserId: string | null }>,
    isActive: boolean,
    context: string,
  ): Promise<number> {
    let failed = 0;
    for (const m of members) {
      const ok = await this.accountSync.applyStatus(m.authUserId, isActive, `${context}:${m.email}`);
      if (!ok) failed += 1;
    }
    return failed;
  }

  // ─── Fleet Users (appelés par Manager) ──────────────────

  @Get('fleet/:fleetId/users')
  async listFleetUsers(@Param('fleetId') fleetId: string) {
    return this.prisma.user.findMany({
      where: { fleetId },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('fleet/:fleetId/users')
  @HttpCode(HttpStatus.CREATED)
  async createFleetUser(@Param('fleetId') fleetId: string, @Body() dto: CreateFleetUserDto) {
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId } });
    if (!fleet) throw new NotFoundException('Fleet not found');

    const displayName = [dto.firstName, dto.lastName].filter(Boolean).join(' ') || undefined;
    const result = await this.authClient.register(dto.email, dto.password, displayName);

    let authUserId = result.id;
    if (!authUserId) {
      const tokens = await this.authClient.login(dto.email, dto.password);
      const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64').toString());
      authUserId = payload.sub as string;
    }

    const user = await this.prisma.user.create({
      data: {
        authUserId,
        email: dto.email.toLowerCase(),
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: UserRole.VIEWER,
        fleetId,
      },
    });

    this.recordInternal('fleet_user_created', fleetId, user.email);
    return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role };
  }

  @Delete('fleet/:fleetId/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFleetUser(@Param('fleetId') fleetId: string, @Param('userId') userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.fleetId !== fleetId) throw new NotFoundException('User not found in fleet');

    await this.authClient.removeUserFromApp(user.authUserId);
    await this.prisma.user.delete({ where: { id: userId } });
    this.recordInternal('fleet_user_deleted', fleetId, user.email, 'Suppression définitive (Tracky + Auth)');
  }
}

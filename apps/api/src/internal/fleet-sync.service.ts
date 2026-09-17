import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { telephoneClientE164 } from '../installation-booking/contact';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AuthAccountSyncService } from '../users/auth-account-sync.service';
import type { ArchiveFleetDto, DestroyFleetDto, PatchFleetDto, PutFleetDto } from './dto/fleet-sync.dto';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * SYNCHRONISATION VIZYO MANAGER → TRACKY (lot D de la conception RDV v2, § 2.5, § 4.4, § 8.4)
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Un client Manager et une flotte Tracky sont LA MÊME CHOSE vue de deux côtés. Manager est la
 * source de vérité de l'identité du client (nom, contact, e-mail de connexion, statut) ; Tracky
 * la REFLÈTE : à sens unique, par événement (Manager pousse à chaque écriture), rejouable (`PUT`
 * = l'état complet, idempotent), journalisée dans le journal Système (catégorie `INTERNAL`).
 *
 * ┌─ CE QUE MANAGER PILOTE, ET QUE TRACKY NE MODIFIE PLUS SEUL ──────────────────────────────┐
 * │ `fleet.name`, `fleet.contactPhone`, `fleet.weeklyReportEmail` (e-mail de notification),   │
 * │ l'identité de l'ADMIN provisionné (`users.managedByManager`) : prénom, nom, téléphone,     │
 * │ e-mail de connexion. Chaque poussée pose `managedByManagerAt` — « synchronisé depuis     │
 * │ Vizyo Manager le … » à l'écran, champs verrouillés quand `clientId` est posé.              │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Les flottes SANS `clientId` (créées avant ce chantier, seeds, « Client test ») ne sont pas
 * synchronisées : `GET fleets?unlinked=true` les liste pour le bouton Manager « Adopter une flotte
 * Tracky existante », qui pose le `clientId` par `PUT` — jamais de doublon (C3).
 */
export interface FleetSyncResult {
  fleetId: string;
  name: string;
  clientId: string | null;
  adminUserId: string | null;
  adminEmail: string | null;
  managedByManagerAt: string;
  changed: string[];
}

const ACTEUR = 'vizyo-manager';

@Injectable()
export class FleetSyncService {
  private readonly logger = new Logger(FleetSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountSync: AuthAccountSyncService,
    private readonly authClient: AuthClientService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  // ─── Lecture ─────────────────────────────────────────────────────────────────

  /** Les flottes qu'aucun client Manager ne réclame — pour « Adopter » (jamais les archivées). */
  async unlinked() {
    const rows = await this.prisma.fleet.findMany({
      where: { clientId: null, archivedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, createdAt: true,
        _count: { select: { vehicles: true, users: true } },
        users: { where: { role: UserRole.FLEET_ADMIN }, select: { email: true, firstName: true, lastName: true }, orderBy: { createdAt: 'asc' }, take: 3 },
      },
    });
    return rows.map((f) => ({
      fleetId: f.id,
      name: f.name,
      createdAt: f.createdAt.toISOString(),
      vehicles: f._count.vehicles,
      users: f._count.users,
      admins: f.users.map((u) => ({ email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null })),
    }));
  }

  // ─── Poussées ────────────────────────────────────────────────────────────────

  /** `PATCH fleet/:id` — ce qui a changé dans Manager. */
  async patch(fleetId: string, dto: PatchFleetDto): Promise<FleetSyncResult> {
    return this.appliquer(fleetId, dto, 'fleet_synced');
  }

  /**
   * `PUT fleet/:id` — l'état complet (« Resynchroniser », « Adopter »). Idempotent : rejouer le même
   * état ne change rien et ne journalise qu'une ligne « à jour ». `active` aligne aussi le statut
   * des membres (flotte entière, C11), Vizyo Auth compris.
   */
  async put(fleetId: string, dto: PutFleetDto): Promise<FleetSyncResult & { authFailures: number }> {
    const resultat = await this.appliquer(fleetId, dto, 'fleet_resynced');
    let authFailures = 0;
    if (dto.active !== undefined) {
      authFailures = await this.alignerStatut(fleetId, dto.active, 'fleet_resync');
      if (dto.active) resultat.changed.push('active'); else resultat.changed.push('suspended');
    }
    return { ...resultat, authFailures };
  }

  private async appliquer(fleetId: string, dto: PatchFleetDto | PutFleetDto, action: string): Promise<FleetSyncResult> {
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: { id: true, name: true, clientId: true, contactPhone: true, weeklyReportEmail: true, archivedAt: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    if (dto.clientId && fleet.clientId && fleet.clientId !== dto.clientId) {
      // Deux clients Manager pour une flotte : impossible — c'est un doublon côté Manager, à
      // résoudre là-bas. On ne réécrit JAMAIS un rattachement existant.
      throw new ConflictException(`Cette flotte est déjà rattachée au client Manager ${fleet.clientId}.`);
    }

    const admin = await this.adminDe(fleetId);
    const changed: string[] = [];
    const now = new Date();

    const fleetData: { name?: string; clientId?: string; contactPhone?: string | null; weeklyReportEmail?: string | null; managedByManagerAt: Date } = { managedByManagerAt: now };
    if (dto.name !== undefined && dto.name.trim() && dto.name.trim() !== fleet.name) { fleetData.name = dto.name.trim(); changed.push('name'); }
    if (dto.clientId && dto.clientId !== fleet.clientId) { fleetData.clientId = dto.clientId; changed.push('clientId'); }
    if (dto.notificationEmail !== undefined) {
      const email = dto.notificationEmail ? dto.notificationEmail.trim().toLowerCase() : null;
      if (email !== fleet.weeklyReportEmail) { fleetData.weeklyReportEmail = email; changed.push('notificationEmail'); }
    }
    if (dto.contact?.phone !== undefined) {
      const phone = dto.contact.phone ? telephoneClientE164(dto.contact.phone) : null;
      if (dto.contact.phone && !phone) throw new ConflictException(`Téléphone illisible : « ${dto.contact.phone} ».`);
      if (phone !== fleet.contactPhone) { fleetData.contactPhone = phone; changed.push('contactPhone'); }
    }

    const userData: { firstName?: string | null; lastName?: string | null; phone?: string | null; email?: string; managedByManager: true } = { managedByManager: true };
    if (admin) {
      if (dto.contact?.firstName !== undefined) {
        const v = dto.contact.firstName?.trim() || null;
        if (v !== admin.firstName) { userData.firstName = v; changed.push('admin.firstName'); }
      }
      if (dto.contact?.lastName !== undefined) {
        const v = dto.contact.lastName?.trim() || null;
        if (v !== admin.lastName) { userData.lastName = v; changed.push('admin.lastName'); }
      }
      if (dto.contact?.phone !== undefined) {
        const v = dto.contact.phone ? telephoneClientE164(dto.contact.phone) : null;
        if (v !== admin.phone) { userData.phone = v; changed.push('admin.phone'); }
      }
      if (dto.adminEmail !== undefined) {
        const email = dto.adminEmail.trim().toLowerCase();
        if (email !== admin.email) {
          const pris = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
          if (pris && pris.id !== admin.id) {
            throw new ConflictException(`L'e-mail ${email} est déjà utilisé par un autre compte Tracky.`);
          }
          userData.email = email;
          changed.push('admin.email');
        }
      }
    } else if (dto.contact !== undefined || dto.adminEmail !== undefined) {
      this.logger.warn(`Synchro de ${fleet.name} : aucun admin FLEET_ADMIN — contact et e-mail non appliqués`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.fleet.update({ where: { id: fleetId }, data: fleetData });
      if (admin) await tx.user.update({ where: { id: admin.id }, data: userData });
    });

    this.systemActivity.record({
      category: 'INTERNAL',
      action,
      status: 'SUCCESS',
      actor: ACTEUR,
      target: fleetData.name ?? fleet.name,
      detail: changed.length > 0 ? `Synchronisé depuis Vizyo Manager : ${changed.join(', ')}` : 'Synchronisation reçue : déjà à jour',
      fleetId,
      meta: { changed, clientId: dto.clientId ?? fleet.clientId },
    });

    return {
      fleetId,
      name: fleetData.name ?? fleet.name,
      clientId: fleetData.clientId ?? fleet.clientId,
      adminUserId: admin?.id ?? null,
      adminEmail: userData.email ?? admin?.email ?? null,
      managedByManagerAt: now.toISOString(),
      changed,
    };
  }

  /**
   * L'admin piloté par Manager : celui déjà marqué `managedByManager`, sinon le plus ancien
   * FLEET_ADMIN (flottes provisionnées avant le lot D) — qui devient marqué à la première poussée.
   */
  private async adminDe(fleetId: string) {
    const select = { id: true, email: true, firstName: true, lastName: true, phone: true, authUserId: true } as const;
    const marque = await this.prisma.user.findFirst({ where: { fleetId, managedByManager: true }, select, orderBy: { createdAt: 'asc' } });
    if (marque) return marque;
    return this.prisma.user.findFirst({ where: { fleetId, role: UserRole.FLEET_ADMIN }, select, orderBy: { createdAt: 'asc' } });
  }

  // ─── Statut, archivage, effacement ──────────────────────────────────────────

  /**
   * Suspend ou réactive TOUS les membres (C11 : avant, `deactivate()` ne touchait que l'admin), et
   * aligne Vizyo Auth — la seule autorité du login. Séquentiel : quelques dizaines de comptes, pas
   * une rafale contre notre propre service d'authentification. Rend le nombre d'échecs Auth.
   */
  async alignerStatut(fleetId: string, active: boolean, contexte: string): Promise<number> {
    const membres = await this.prisma.user.findMany({ where: { fleetId }, select: { email: true, authUserId: true } });
    await this.prisma.user.updateMany({ where: { fleetId }, data: { isActive: active } });
    let echecs = 0;
    for (const m of membres) {
      const ok = await this.accountSync.applyStatus(m.authUserId, active, `${contexte}:${m.email}`);
      if (!ok) echecs += 1;
    }
    return echecs;
  }

  /**
   * Archiver (Q12) : la société disparaît des écrans (lot E pour l'exclusion partout), ses membres
   * ne se connectent plus, ses liens de réservation se ferment. Réversible par `unarchive`.
   */
  async archive(fleetId: string, dto: ArchiveFleetDto): Promise<{ status: 'archived'; authFailures: number; alreadyArchived: boolean }> {
    const fleet = await this.fleetOr404(fleetId);
    if (fleet.archivedAt) return { status: 'archived', authFailures: 0, alreadyArchived: true };
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.fleet.update({ where: { id: fleetId }, data: { archivedAt: now, archivedBy: dto.by?.trim() || ACTEUR } });
      await tx.installationBookingLink.updateMany({ where: { fleetId, active: true }, data: { active: false } });
    });
    const authFailures = await this.alignerStatut(fleetId, false, 'fleet_archive');
    this.systemActivity.record({
      category: 'INTERNAL', action: 'fleet_archived', status: 'SUCCESS', actor: dto.by?.trim() || ACTEUR,
      target: fleet.name, fleetId,
      detail: `Société archivée : membres suspendus, liens de réservation fermés${authFailures ? ` — ⚠️ ${authFailures} compte(s) non suspendu(s) dans Vizyo Auth` : ''}`,
      meta: { authFailures },
    });
    return { status: 'archived', authFailures, alreadyArchived: false };
  }

  async unarchive(fleetId: string, dto: ArchiveFleetDto): Promise<{ status: 'active'; authFailures: number; wasArchived: boolean }> {
    const fleet = await this.fleetOr404(fleetId);
    if (!fleet.archivedAt) return { status: 'active', authFailures: 0, wasArchived: false };
    await this.prisma.fleet.update({ where: { id: fleetId }, data: { archivedAt: null, archivedBy: null } });
    const authFailures = await this.alignerStatut(fleetId, true, 'fleet_unarchive');
    this.systemActivity.record({
      category: 'INTERNAL', action: 'fleet_unarchived', status: 'SUCCESS', actor: dto.by?.trim() || ACTEUR,
      target: fleet.name, fleetId,
      detail: `Société désarchivée : membres réactivés (les liens de réservation restent fermés)${authFailures ? ` — ⚠️ ${authFailures} compte(s) non réactivé(s) dans Vizyo Auth` : ''}`,
      meta: { authFailures },
    });
    return { status: 'active', authFailures, wasArchived: true };
  }

  /**
   * Effacer DÉFINITIVEMENT (Q12, § 8.4) — depuis l'archive uniquement, nom retapé.
   *
   * Ce qui part : la flotte et tout ce que ses clés étrangères entraînent (comptes, véhicules,
   * groupes, géofences, alertes, conducteurs, plannings, liens, demandes, abonnements…), les
   * trajets et positions de ses boîtiers, et les tables qui portent `fleetId` sans clé étrangère
   * (règles d'alerte, entretiens, lieux, pleins, invitations, zones GPS, sessions…).
   * Ce qui reste : les BOÎTIERS (objets physiques réaffectables — dissociés, pas détruits), les SIM
   * (idem), et les JOURNAUX (journal Système, e-mails, push, usage IA) — c'est l'audit.
   * Les comptes sont retirés de l'application Tracky dans Vizyo Auth (best-effort, séquentiel).
   */
  async destroy(fleetId: string, dto: DestroyFleetDto): Promise<{ status: 'deleted'; deleted: Record<string, number>; authRemoved: number; authFailures: number }> {
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: { id: true, name: true, archivedAt: true, clientId: true, users: { select: { authUserId: true, email: true } }, vehicles: { select: { id: true, tracker: { select: { id: true } } } } },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    if (!fleet.archivedAt) throw new ConflictException("Une société s'efface depuis l'archive : archivez-la d'abord.");
    if (dto.confirmName.trim() !== fleet.name) {
      throw new ConflictException('Le nom retapé ne correspond pas au nom de la société.');
    }
    const trackerIds = fleet.vehicles.map((v) => v.tracker?.id).filter((id): id is string => !!id);
    const deleted: Record<string, number> = {};

    // 1. Les boîtiers sont dissociés (SetNull par la suppression des véhicules), pas détruits ;
    //    leurs positions et trajets, eux, appartiennent à ce client : effacés (par lots).
    if (trackerIds.length > 0) {
      deleted['positions'] = 0;
      for (;;) {
        const lot = await this.prisma.position.findMany({ where: { trackerId: { in: trackerIds } }, select: { id: true }, take: 20_000 });
        if (lot.length === 0) break;
        const r = await this.prisma.position.deleteMany({ where: { id: { in: lot.map((p) => p.id) } } });
        deleted['positions'] += r.count;
        if (lot.length < 20_000) break;
      }
    }

    // 2. Les tables à `fleetId` dénormalisé (sans clé étrangère) — ce qu'une cascade ne voit pas.
    const parFleetId = [
      'workTimeEntry', 'alertRule', 'invitation', 'privacyModeEvent', 'vehicleEvent', 'maintenancePlan', 'trip',
      'gpsDeadZone', 'gpsLossEvent', 'fleetPlace', 'placeAnalysis', 'tripAnalysis', 'tripFuelStop', 'fuelFillUp',
      'agendaAgentProposal', 'agendaAgentRun', 'audioMonitoringCommand', 'installationBookingLinkVisit',
      'userSession', 'userActivity', 'notificationDelivery', 'assistanceConversation', 'aiAgentTrace', 'gpsZoneDiagnostic',
    ] as const;
    for (const modele of parFleetId) {
      const delegate = (this.prisma as unknown as Record<string, { deleteMany?: (args: { where: { fleetId: string } }) => Promise<{ count: number }> }>)[modele];
      if (!delegate?.deleteMany) continue;
      try {
        const r = await delegate.deleteMany({ where: { fleetId } });
        if (r.count > 0) deleted[modele] = r.count;
      } catch (e) {
        this.logger.warn(`Effacement ${fleet.name} : ${modele} non purgé (${e instanceof Error ? e.message : e})`);
      }
    }

    // 3. La flotte elle-même : les clés étrangères en cascade emportent le reste.
    await this.prisma.sim.updateMany({ where: { fleetId }, data: { fleetId: null } }).catch(() => undefined);
    await this.prisma.fleet.delete({ where: { id: fleetId } });
    deleted['fleet'] = 1;
    deleted['users'] = fleet.users.length;
    deleted['vehicles'] = fleet.vehicles.length;

    // 4. Vizyo Auth : les comptes quittent l'application Tracky (best-effort, jamais bloquant).
    let authRemoved = 0; let authFailures = 0;
    for (const u of fleet.users) {
      if (!u.authUserId) continue;
      try { await this.authClient.removeUserFromApp(u.authUserId); authRemoved += 1; }
      catch (e) { authFailures += 1; this.logger.warn(`Vizyo Auth : ${u.email} non retiré de Tracky (${e instanceof Error ? e.message : e})`); }
    }

    this.systemActivity.record({
      category: 'INTERNAL', action: 'fleet_destroyed', status: 'SUCCESS', actor: dto.by?.trim() || ACTEUR,
      target: fleet.name, fleetId: null,
      detail: `Société EFFACÉE définitivement (${fleet.users.length} compte(s), ${fleet.vehicles.length} véhicule(s), ${deleted['positions'] ?? 0} position(s))${authFailures ? ` — ⚠️ ${authFailures} compte(s) non retiré(s) de Vizyo Auth` : ''}`,
      meta: { fleetId, clientId: fleet.clientId, deleted, authRemoved, authFailures },
    });
    return { status: 'deleted', deleted, authRemoved, authFailures };
  }

  private async fleetOr404(fleetId: string) {
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true, archivedAt: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    return fleet;
  }
}

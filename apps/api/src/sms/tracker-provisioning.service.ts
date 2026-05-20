import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TrackerProvisioningStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from './sms-gateway.service';

/**
 * Contexte tenant requis pour les operations sensibles sur un provisioning.
 *
 * La table TrackerProvisioning n'a pas de fleetId direct (un imei peut etre
 * provisione AVANT d'etre rattache a un vehicule). On derive donc via :
 *
 *   provisioning.imei -> tracker.imei -> tracker.vehicle.fleetId
 *
 * Regles :
 *   - SUPER_ADMIN : acces total.
 *   - Autre role + tracker rattache : doit matcher requestedBy.fleetId.
 *   - Autre role + tracker non rattache (imei orphelin) : refuse (404).
 */
interface RequestedBy {
  role: UserRole | string;
  fleetId: string | null;
}

/**
 * V1.5 (Sprint I) — Sequence d'init Coban GPS403D via SMS.
 *
 * Reference protocole : docs/03-protocol-coban-gps403d.md §5.7.
 *
 * Sequence de 9 SMS (entre chaque envoi, on attend l'ACK "ok 123456" du boitier
 * via le webhook inbound, max 60s avant timeout).
 *
 *   1. begin123456                   → reset config
 *   2. apn123456 <APN>               → APN GPRS
 *   3. apnuser123456 <USER>          → user APN (souvent vide)
 *   4. apnpasswd123456 <PASSWD>      → password APN (souvent vide)
 *   5. adminip123456 <IP> <PORT>     → IP serveur Tracky + port TCP
 *   6. gprs123456                    → activer GPRS
 *   7. fix030s***n123456             → reporting 30s en mouvement
 *   8. acc123456 on                  → activation alarme ACC
 *   9. lowbattery123456 <PHONE> on   → alarme batterie faible
 *
 * Pour rester pragmatique, on n'attend PAS l'ACK entre chaque SMS dans cette V1 :
 * on envoie tous les 9 a 30s d'intervalle (cron), et on regarde les replies dans
 * un second temps via le webhook inbound. C'est suffisant pour 99% des cas
 * (le boitier est verbeux).
 */

interface StepRecord {
  step: number;
  payload: string;
  sentAt: string;
  status: 'sent' | 'failed' | 'noop';
  twilioSid?: string;
  error?: string;
}

interface ProvisioningParams {
  imei: string;
  phoneNumber: string;
  apn: string;
  apnUser?: string;
  apnPasswd?: string;
  serverIp: string;
  serverPort: number;
  lowBatteryPhone?: string;
}

const COBAN_PASSWORD = '123456'; // password par defaut Coban (override via env si prod)
const STEP_DELAY_MS = 30 * 1000;
const MAX_STEPS = 9;

@Injectable()
export class TrackerProvisioningService {
  private readonly logger = new Logger(TrackerProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsGatewayService,
  ) {}

  /** Build the 9 Coban SMS payloads from the provisioning params. */
  buildPayloads(params: ProvisioningParams): string[] {
    const pwd = COBAN_PASSWORD;
    return [
      `begin${pwd}`,
      `apn${pwd} ${params.apn}`,
      `apnuser${pwd} ${params.apnUser ?? ''}`.trim(),
      `apnpasswd${pwd} ${params.apnPasswd ?? ''}`.trim(),
      `adminip${pwd} ${params.serverIp} ${params.serverPort}`,
      `gprs${pwd}`,
      `fix030s***n${pwd}`,
      `acc${pwd} on`,
      `lowbattery${pwd} ${params.lowBatteryPhone ?? ''} on`.replace(/\s+on$/, ' on'),
    ];
  }

  /**
   * Start a new provisioning sequence. Returns the created row immediately ;
   * the actual SMS dispatch runs asynchronously (chained 30s setTimeout).
   */
  async start(
    params: ProvisioningParams,
    requestedByUserId: string,
  ): Promise<{ id: string }> {
    if (!/^\d{14,16}$/.test(params.imei)) {
      throw new BadRequestException('IMEI invalide (14-16 chiffres attendus)');
    }
    if (!params.phoneNumber.startsWith('+')) {
      throw new BadRequestException('phoneNumber doit etre au format E.164 (ex: +33612345678)');
    }
    if (!params.apn || !params.serverIp || !params.serverPort) {
      throw new BadRequestException('apn, serverIp et serverPort sont requis');
    }

    // Reject if a provisioning is already in progress for this IMEI.
    const existing = await this.prisma.trackerProvisioning.findFirst({
      where: { imei: params.imei, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    });
    if (existing) {
      throw new BadRequestException(
        `Un provisionnement est deja en cours pour ${params.imei} (id ${existing.id}). Annuler avant d'en relancer un.`,
      );
    }

    const provisioning = await this.prisma.trackerProvisioning.create({
      data: {
        imei: params.imei,
        phoneNumber: params.phoneNumber,
        apn: params.apn,
        apnUser: params.apnUser,
        apnPasswd: params.apnPasswd,
        serverIp: params.serverIp,
        serverPort: params.serverPort,
        lowBatteryPhone: params.lowBatteryPhone,
        status: TrackerProvisioningStatus.IN_PROGRESS,
        startedAt: new Date(),
        startedBy: requestedByUserId,
        steps: [] as object,
      },
    });

    // Fire the dispatch loop in the background — it returns immediately.
    void this.dispatchAll(provisioning.id, params).catch((err) => {
      this.logger.error(
        `Provisioning ${provisioning.id} crashed during dispatch: ${err instanceof Error ? err.message : err}`,
      );
    });

    return { id: provisioning.id };
  }

  /**
   * Cancel an in-progress provisioning.
   *
   * `requestedBy` est optionnel pour ne pas casser les anciens appels internes,
   * mais le controller HTTP doit toujours le fournir pour appliquer le tenant
   * check (defense en profondeur — actuellement le controller est SUPER_ADMIN
   * only via @Roles, mais on ne veut pas dependre uniquement du guard).
   */
  async cancel(id: string, requestedBy?: RequestedBy): Promise<void> {
    const provisioning = await this.prisma.trackerProvisioning.findUnique({ where: { id } });
    if (!provisioning) throw new NotFoundException('Provisionnement introuvable');
    await this.assertTenantAccess(provisioning.imei, requestedBy);
    if (provisioning.status !== TrackerProvisioningStatus.IN_PROGRESS) return;
    await this.prisma.trackerProvisioning.update({
      where: { id },
      data: { status: TrackerProvisioningStatus.CANCELLED },
    });
  }

  async list(limit = 50, requestedBy?: RequestedBy) {
    const isSuper = !requestedBy || requestedBy.role === UserRole.SUPER_ADMIN;
    if (isSuper) {
      return this.prisma.trackerProvisioning.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
      });
    }
    if (!requestedBy.fleetId) return [];
    // Tenant-scoped : ne retourne que les provisionings dont l'imei est attache
    // a un tracker de la flotte courante.
    const trackers = await this.prisma.tracker.findMany({
      where: { vehicle: { fleetId: requestedBy.fleetId } },
      select: { imei: true },
    });
    if (trackers.length === 0) return [];
    return this.prisma.trackerProvisioning.findMany({
      where: { imei: { in: trackers.map((t) => t.imei) } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  async findOne(id: string, requestedBy?: RequestedBy) {
    const row = await this.prisma.trackerProvisioning.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Provisionnement introuvable');
    await this.assertTenantAccess(row.imei, requestedBy);
    return row;
  }

  /**
   * Resout la flotte via imei -> tracker.vehicle.fleetId et la compare au caller.
   * Echoue par 404 si le caller est non-SUPER et que le tracker n'appartient
   * pas a sa flotte (ou n'a pas de vehicule rattache).
   */
  private async assertTenantAccess(imei: string, requestedBy?: RequestedBy): Promise<void> {
    if (!requestedBy || requestedBy.role === UserRole.SUPER_ADMIN) return;
    if (!requestedBy.fleetId) throw new NotFoundException('Provisionnement introuvable');
    const tracker = await this.prisma.tracker.findFirst({
      where: { imei, vehicle: { fleetId: requestedBy.fleetId } },
      select: { id: true },
    });
    if (!tracker) throw new NotFoundException('Provisionnement introuvable');
  }

  /**
   * Dispatch loop — sends each of the 9 SMS with STEP_DELAY_MS between attempts.
   * Reads the live state from DB at every step so a CANCELLED row stops the loop.
   * Errors during a single SMS don't abort the run — they just mark the step as
   * 'failed' and continue.
   */
  private async dispatchAll(provisioningId: string, params: ProvisioningParams): Promise<void> {
    const payloads = this.buildPayloads(params);

    for (let i = 0; i < MAX_STEPS; i++) {
      // Re-read state — admin may have cancelled.
      const current = await this.prisma.trackerProvisioning.findUnique({
        where: { id: provisioningId },
      });
      if (!current || current.status !== TrackerProvisioningStatus.IN_PROGRESS) {
        this.logger.log(`Provisioning ${provisioningId} stopped (status=${current?.status ?? 'missing'})`);
        return;
      }

      const payload = payloads[i]!;
      const result = await this.sms.send(params.phoneNumber, payload, {
        imei: params.imei,
        provisioningId,
        provisioningStep: i + 1,
      });

      const stepRecord: StepRecord = {
        step: i + 1,
        payload,
        sentAt: new Date().toISOString(),
        status: result.ok ? (this.sms.isEnabled() ? 'sent' : 'noop') : 'failed',
        twilioSid: result.twilioSid,
        error: result.error,
      };

      const existingSteps = (current.steps as unknown as StepRecord[]) ?? [];
      await this.prisma.trackerProvisioning.update({
        where: { id: provisioningId },
        data: {
          currentStep: i + 1,
          steps: [...existingSteps, stepRecord] as object,
        },
      });

      if (i < MAX_STEPS - 1) {
        await this.sleep(STEP_DELAY_MS);
      }
    }

    // Mark complete (even if some steps failed — admin can retry individual SMS).
    const final = await this.prisma.trackerProvisioning.findUnique({
      where: { id: provisioningId },
    });
    if (final && final.status === TrackerProvisioningStatus.IN_PROGRESS) {
      const stepsArr = (final.steps as unknown as StepRecord[]) ?? [];
      const anyFailed = stepsArr.some((s) => s.status === 'failed');
      await this.prisma.trackerProvisioning.update({
        where: { id: provisioningId },
        data: {
          status: anyFailed ? TrackerProvisioningStatus.FAILED : TrackerProvisioningStatus.COMPLETED,
          completedAt: anyFailed ? null : new Date(),
          failedAt: anyFailed ? new Date() : null,
          failureReason: anyFailed
            ? `${stepsArr.filter((s) => s.status === 'failed').length} SMS echoues sur ${MAX_STEPS}`
            : null,
        },
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

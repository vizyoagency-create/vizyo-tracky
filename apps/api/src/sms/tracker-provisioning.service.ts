import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { TrackerProvisioningStatus, TrackerStatus, UserRole } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { AllowlistService } from './allowlist.service';
import { SMS_INBOUND_EVENT, SmsGatewayService, type SmsInboundEvent } from './sms-gateway.service';

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
 * V1.5 (Sprint I) → V1.17 — Configuration d'un boitier Coban GPS403D par SMS,
 * avec ATTENTE de la reponse (ACK) du boitier entre chaque commande.
 *
 * Reference protocole : docs/03-protocol-coban-gps403d.md §5.
 *
 * Sequence par defaut (6 commandes ; extras optionnels si les champs sont fournis) :
 *
 *   1. begin123456                   → reset config            (ACK "begin ok")
 *   2. apn123456 <APN>               → APN GPRS (defaut wsim)   (ACK "apn ...")
 *   3. admin123456 <NUM sans +>      → numero master/SOS        (ACK "admin OK")
 *   4. adminip123456 <IP> <PORT>     → IP serveur Tracky + port (ACK "adminip ...")
 *   5. gprs123456                    → activer GPRS             (souvent SANS ACK)
 *   6. fix0NNs***n123456             → reporting toutes NN s    (ACK "fix ok")
 *
 * Transport : vizyo-texto (SmsGatewayService). On ENVOIE la commande puis on
 * ATTEND la reponse du boitier captee par le webhook entrant (event sms.inbound),
 * jusqu'a `ackTimeoutS` (defaut 15s). Si aucune reponse n'arrive a temps, l'etape
 * est marquee `no-ack` et la sequence CONTINUE (timeout genereux, non bloquant) —
 * un `no-ack` n'est pas un echec (l'objectif est surtout de confirmer que la SIM
 * recoit/repond aux SMS). Seul un echec d'ENVOI marque l'etape `failed`.
 */

type StepStatus = 'pending' | 'sent' | 'acked' | 'no-ack' | 'failed' | 'noop';

interface StepRecord {
  step: number; // 1-based
  key: string; // 'begin' | 'apn' | 'admin' | 'adminip' | 'gprs' | 'fix' | ...
  label: string; // libelle FR pour l'UI
  payload: string;
  status: StepStatus;
  sentAt?: string;
  twilioSid?: string;
  error?: string;
  reply?: string; // texte de la reponse du boitier
  repliedAt?: string;
  ackMatched?: boolean; // true si la reponse contient le mot-cle attendu
}

interface StepDef {
  key: string;
  label: string;
  payload: string;
  expect: string; // mot-cle attendu dans l'ACK (insensible a la casse)
}

/**
 * V1.18 — Etat LIVE du tracker rattache a un provisioning (derive par imei).
 *
 * Le retour SMS (ACK) est fragile : il depend du telephone passerelle qui doit
 * forwarder au serveur les SMS RECUS du boitier — maillon souvent KO. Le signal
 * FIABLE qu'une sequence a reussi, c'est que le boitier se (re)connecte au serveur
 * TCP, observable via `tracker.lastSeenAt`. On expose donc cet etat pour que l'UI
 * affiche « Tracker connecte » INDEPENDAMMENT des ACK SMS.
 *
 * `seenSinceStart` = boitier vu en ligne APRES le lancement de la sequence (preuve
 * que CETTE config a pris effet ; insensible a un tracker deja online avant).
 */
export interface TrackerLiveStatus {
  status: TrackerStatus;
  lastSeenAt: Date | null;
  lastPositionAt: Date | null;
  seenSinceStart: boolean;
}

export interface ProvisioningParams {
  imei: string;
  phoneNumber: string;
  apn: string;
  apnUser?: string;
  apnPasswd?: string;
  serverIp: string;
  serverPort: number;
  adminNumber?: string; // n° master/SOS ; defaut = phoneNumber (le `+` est retire)
  lowBatteryPhone?: string;
  accOn?: boolean; // ajoute l'etape acc<pwd> on
  fixIntervalS?: number; // defaut 20 (plancher firmware Coban)
  ackTimeoutS?: number; // defaut 15
}

const COBAN_PASSWORD = '123456'; // password par defaut Coban (override via env si prod)
const DEFAULT_FIX_INTERVAL_S = 20;
const MIN_FIX_INTERVAL_S = 20; // plancher firmware Coban (cf docs/03 §5.4)
const MAX_FIX_INTERVAL_S = 999; // format fixNNN (3 chiffres)
// Defaut d'attente d'ACK par etape. Le round-trip SMS reel mesure en prod (boitier
// -> gateway -> relay -> webhook) est de ~15-60s : 12s etait BEAUCOUP trop court,
// chaque etape timeout-ait avant l'arrivee de la reponse (commandes envoyees en
// rafale toutes les 12s). 45s laisse la reponse arriver ET espace les envois (ce qui
// soulage le push FCM de capcom6, sujet aux 429). Ajustable par provisioning via le
// champ `ackTimeoutS` (admin SMS), borne [MIN, MAX].
const DEFAULT_ACK_TIMEOUT_S = 45;
const MIN_ACK_TIMEOUT_S = 3;
const MAX_ACK_TIMEOUT_S = 180;
const SETTLE_DELAY_MS = 1500; // petite pause apres un ACK avant la commande suivante
// #19 — fenetre de garde : une reponse arrivant moins de REPLY_GUARD_MS apres
// l'armement d'un waiter ne peut PAS etre la reponse a la commande qu'on vient
// d'envoyer (round-trip SMS reel > 3s) -> c'est une reponse TARDIVE de l'etape
// precedente (waiter partage par numero). On l'ignore et on reste arme.
const REPLY_GUARD_MS = 3000;
const INTER_STEP_DELAY_MS = 7000; // delai fixe entre commandes quand pas d'ACK
// V1.18 — Apres un provisioning ou le boitier n'a repondu a AUCUN SMS, on attend ce
// delai avant d'alerter le centre d'alerte : le boitier peut se connecter au serveur
// (TCP) sans repondre aux SMS. On n'alerte QUE s'il reste injoignable apres ce delai
// (ni ACK SMS, ni connexion) -> vraie panne, pas de faux positif. Cf. alertIfBoitierSilent.
const NO_RESPONSE_GRACE_MS = 5 * 60 * 1000;

@Injectable()
export class TrackerProvisioningService {
  private readonly logger = new Logger(TrackerProvisioningService.name);

  /**
   * Waiters d'ACK en attente, indexes par numero normalise (9 derniers chiffres).
   * Chaque entree est resolue par onSmsInbound() quand le boitier repond, ou par
   * le timeout de armReplyWaiter(). La valeur stockee EST la fonction de resolution
   * — l'identite sert a eviter qu'un timeout efface le waiter d'une autre etape.
   */
  private readonly waiters = new Map<string, (sms: SmsInboundEvent) => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsGatewayService,
    private readonly eventEmitter: EventEmitter2,
    private readonly errorLogger: ErrorLogger,
    private readonly allowlist: AllowlistService,
  ) {}

  // ─── Construction de la sequence ──────────────────────────────────────────

  /**
   * Construit la sequence de commandes SMS depuis les params. Les 6 commandes
   * de base sont toujours presentes ; apnuser/apnpasswd/acc/lowbattery ne sont
   * ajoutees que si le champ correspondant est fourni.
   */
  buildSteps(params: ProvisioningParams): StepDef[] {
    const pwd = COBAN_PASSWORD;
    const fixS = Math.min(
      MAX_FIX_INTERVAL_S,
      Math.max(MIN_FIX_INTERVAL_S, Math.floor(params.fixIntervalS ?? DEFAULT_FIX_INTERVAL_S)),
    );
    const fixToken = String(fixS).padStart(3, '0'); // 20 -> "020"
    const adminNum = this.stripNonDigits(params.adminNumber?.trim() || params.phoneNumber);

    const steps: StepDef[] = [
      { key: 'begin', label: 'Reset configuration', payload: `begin${pwd}`, expect: 'begin' },
      { key: 'apn', label: `APN « ${params.apn} »`, payload: `apn${pwd} ${params.apn}`, expect: 'apn' },
    ];
    if (params.apnUser) {
      steps.push({ key: 'apnuser', label: 'Utilisateur APN', payload: `apnuser${pwd} ${params.apnUser}`, expect: 'apn' });
    }
    if (params.apnPasswd) {
      steps.push({ key: 'apnpasswd', label: 'Mot de passe APN', payload: `apnpasswd${pwd} ${params.apnPasswd}`, expect: 'apn' });
    }
    if (adminNum) {
      steps.push({ key: 'admin', label: `Numéro admin ${adminNum}`, payload: `admin${pwd} ${adminNum}`, expect: 'admin' });
    }
    steps.push({
      key: 'adminip',
      label: `Serveur ${params.serverIp}:${params.serverPort}`,
      payload: `adminip${pwd} ${params.serverIp} ${params.serverPort}`,
      expect: 'adminip',
    });
    steps.push({ key: 'gprs', label: 'Activation GPRS', payload: `gprs${pwd}`, expect: 'gprs' });
    steps.push({ key: 'fix', label: `Reporting ${fixS}s`, payload: `fix${fixToken}s***n${pwd}`, expect: 'fix' });
    if (params.accOn) {
      steps.push({ key: 'acc', label: 'Alarme ACC', payload: `acc${pwd} on`, expect: 'acc' });
    }
    if (params.lowBatteryPhone) {
      steps.push({
        key: 'lowbattery',
        label: 'Alarme batterie faible',
        payload: `lowbattery${pwd} ${params.lowBatteryPhone} on`,
        expect: 'battery',
      });
    }
    return steps;
  }

  /** Compat : ancienne API renvoyant uniquement les payloads bruts. */
  buildPayloads(params: ProvisioningParams): string[] {
    return this.buildSteps(params).map((s) => s.payload);
  }

  /** Garde uniquement les chiffres (retire `+`, espaces) — format admin Coban. */
  private stripNonDigits(num: string): string {
    return (num ?? '').replace(/\D/g, '');
  }

  // ─── Lancement ────────────────────────────────────────────────────────────

  /**
   * Demarre une sequence de configuration. Renvoie la ligne creee immediatement ;
   * l'envoi reel + l'attente des ACK tournent en tache de fond (dispatchAll).
   */
  async start(params: ProvisioningParams, requestedByUserId: string): Promise<{ id: string }> {
    if (!/^\d{14,16}$/.test(params.imei)) {
      throw new BadRequestException('IMEI invalide (14-16 chiffres attendus)');
    }
    if (!params.phoneNumber.startsWith('+')) {
      throw new BadRequestException('phoneNumber doit être au format E.164 (ex: +33612345678)');
    }
    if (!params.apn || !params.serverIp || !params.serverPort) {
      throw new BadRequestException('apn, serverIp et serverPort sont requis');
    }

    // Refuse si une sequence est deja en cours pour cet IMEI.
    const existing = await this.prisma.trackerProvisioning.findFirst({
      where: { imei: params.imei, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    });
    if (existing) {
      throw new BadRequestException(
        `Un provisionnement est déjà en cours pour ${params.imei} (id ${existing.id}). Annuler avant d'en relancer un.`,
      );
    }

    const stepDefs = this.buildSteps(params);
    // Pre-remplit les etapes en 'pending' pour que le stepper s'affiche d'emblee.
    const initialSteps: StepRecord[] = stepDefs.map((d, i) => ({
      step: i + 1,
      key: d.key,
      label: d.label,
      payload: d.payload,
      status: 'pending',
    }));

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
        currentStep: 0,
        steps: initialSteps as object,
      },
    });

    // V1.14 — Renseigne le simPhoneNumber du tracker (par imei) des le lancement :
    // sert au fallback SMS + a l'allowlist vizyo-texto (auto-sync via l'event).
    // updateMany = no-op si le tracker n'existe pas encore.
    const simUpdate = await this.prisma.tracker.updateMany({
      where: { imei: params.imei },
      data: { simPhoneNumber: params.phoneNumber },
    });
    if (simUpdate.count > 0) {
      this.eventEmitter.emit('tracker.sim-changed', { imei: params.imei });
    } else {
      // Pas de tracker pour cet IMEI (cas test) : l'auto-sync allowlist ne se
      // declenchera pas. On ajoute donc le numero directement (best-effort) pour
      // que le relay accepte les SMS entrants (= les reponses du boitier).
      this.allowlist
        .add(params.phoneNumber, `provision ${params.imei}`)
        .catch((e) =>
          this.logger.warn(
            `Allowlist add (provision) ignoree pour ${params.phoneNumber}: ${e instanceof Error ? e.message : e}`,
          ),
        );
    }

    // Lance la boucle d'envoi en tache de fond — retourne immediatement.
    void this.dispatchAll(provisioning.id, params, stepDefs).catch((err) => {
      this.logger.error(
        `Provisioning ${provisioning.id} crashed during dispatch: ${err instanceof Error ? err.message : err}`,
      );
      this.errorLogger
        .record(
          err instanceof Error ? err : new Error(String(err)),
          'sms-provisioning',
          { provisioningId: provisioning.id, imei: params.imei },
          'CRITICAL',
        )
        .catch((e) => this.logger.error('ErrorLog persist failed', e));
    });

    return { id: provisioning.id };
  }

  // ─── Attente des reponses (ACK) ───────────────────────────────────────────

  /**
   * Recoit chaque SMS entrant (emis par SmsGatewayService.recordInbound depuis le
   * webhook vizyo-texto) et resout le waiter de l'etape en cours, si le numero
   * expediteur correspond a une sequence en attente.
   */
  @OnEvent(SMS_INBOUND_EVENT)
  onSmsInbound(evt: SmsInboundEvent): void {
    const key = this.normalizePhone(evt.fromNumber);
    const waiter = this.waiters.get(key);
    // #19 — on ne pre-supprime PLUS le waiter : l'entry decide s'il CONSOMME la
    // reponse (et se retire) ou s'il l'IGNORE (reponse tardive arrivee dans la
    // fenetre de garde) en restant arme pour la vraie reponse a venir.
    if (waiter) waiter(evt);
  }

  /** Normalise un numero pour le matching : 9 derniers chiffres (robuste +33/0033/0…). */
  private normalizePhone(phone: string): string {
    return (phone ?? '').replace(/\D/g, '').slice(-9);
  }

  /**
   * Arme un waiter pour la prochaine reponse du numero donne. Renvoie une promise
   * (resolue par l'event entrant, ou `null` au timeout) + une fonction `cancel`
   * pour liberer le waiter si l'envoi a echoue.
   */
  private armReplyWaiter(
    phone: string,
    timeoutMs: number,
    guardMs = 0,
  ): { promise: Promise<SmsInboundEvent | null>; cancel: () => void } {
    const key = this.normalizePhone(phone);
    const armedAt = Date.now();
    let settle!: (v: SmsInboundEvent | null) => void;
    let timer: ReturnType<typeof setTimeout>;
    const entry = (sms: SmsInboundEvent): void => {
      // #19 — reponse arrivant < guardMs apres l'armement : trop tot pour etre la
      // reponse a la commande qu'on vient d'envoyer -> reponse TARDIVE de l'etape
      // precedente. On l'ignore et on RESTE arme pour la vraie reponse.
      if (guardMs > 0 && Date.now() - armedAt < guardMs) return;
      cleanup();
      settle(sms);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      if (this.waiters.get(key) === entry) this.waiters.delete(key);
    };
    const promise = new Promise<SmsInboundEvent | null>((resolve) => {
      settle = resolve;
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
    });
    this.waiters.set(key, entry);
    return {
      promise,
      cancel: () => {
        cleanup();
        settle(null);
      },
    };
  }

  /** Reponse consideree comme l'ACK attendu si elle contient le mot-cle (ou "ok"). */
  private ackMatches(body: string, expect: string): boolean {
    const b = (body ?? '').toLowerCase();
    return b.includes(expect.toLowerCase()) || b.includes('ok');
  }

  // ─── Boucle d'envoi ───────────────────────────────────────────────────────

  /**
   * Envoie chaque commande puis attend la reponse du boitier avant de passer a la
   * suivante. Relit l'etat a chaque tour pour qu'une annulation arrete la boucle.
   * Met a jour chaque etape EN PLACE (par index) dans le JSON `steps`.
   */
  private async dispatchAll(
    provisioningId: string,
    params: ProvisioningParams,
    stepDefs: StepDef[],
  ): Promise<void> {
    const ackTimeoutMs =
      Math.min(MAX_ACK_TIMEOUT_S, Math.max(MIN_ACK_TIMEOUT_S, params.ackTimeoutS ?? DEFAULT_ACK_TIMEOUT_S)) * 1000;
    // En mode noop (dev, aucune gateway) on ne peut pas recevoir de reponse.
    const canReadReplies = this.sms.isEnabled();

    for (let i = 0; i < stepDefs.length; i++) {
      const current = await this.prisma.trackerProvisioning.findUnique({ where: { id: provisioningId } });
      if (!current || current.status !== TrackerProvisioningStatus.IN_PROGRESS) {
        this.logger.log(`Provisioning ${provisioningId} stopped (status=${current?.status ?? 'missing'})`);
        return;
      }

      const def = stepDefs[i]!;
      // Arme le waiter AVANT l'envoi pour ne pas rater une reponse rapide.
      const waiter = canReadReplies ? this.armReplyWaiter(params.phoneNumber, ackTimeoutMs, REPLY_GUARD_MS) : null;

      const result = await this.sms.send(params.phoneNumber, def.payload, {
        imei: params.imei,
        provisioningId,
        provisioningStep: i + 1,
        template: 'tracker_provisioning', source: 'provision',
      });

      if (!result.ok) {
        waiter?.cancel();
        await this.patchStep(provisioningId, i, {
          status: 'failed',
          sentAt: new Date().toISOString(),
          twilioSid: result.twilioSid,
          error: result.error,
        });
        continue;
      }

      // Envoi OK : marque 'sent' immediatement (feedback UI pendant l'attente d'ACK).
      const sentStatus: StepStatus = this.sms.isEnabled() ? 'sent' : 'noop';
      await this.patchStep(provisioningId, i, {
        status: sentStatus,
        sentAt: new Date().toISOString(),
        twilioSid: result.twilioSid,
      });

      const reply = waiter ? await waiter.promise : null;
      let acked = false;
      if (reply) {
        acked = true;
        const matched = this.ackMatches(reply.body, def.expect);
        await this.patchStep(provisioningId, i, {
          status: 'acked',
          reply: reply.body,
          repliedAt: reply.receivedAt,
          ackMatched: matched,
        });
        // Rattache la ligne SmsLog entrante a ce provisioning (audit Logs).
        this.prisma.smsLog
          .update({ where: { id: reply.smsLogId }, data: { imei: params.imei, provisioningId } })
          .catch((e) => this.logger.warn(`SmsLog enrich (inbound) échouée: ${e instanceof Error ? e.message : e}`));
      } else if (canReadReplies) {
        await this.patchStep(provisioningId, i, { status: 'no-ack' });
      }

      // Petite pause apres un ACK avant la commande suivante (le boitier traite
      // les SMS sequentiellement). Inutile apres un no-ack (timeout deja ecoule).
      if (acked && i < stepDefs.length - 1) {
        await this.sleep(SETTLE_DELAY_MS);
      }
    }

    // Finalisation : COMPLETED si aucun envoi n'a echoue (un `no-ack` n'est PAS un
    // echec — le SMS est parti, le boitier n'a juste pas (encore) repondu).
    const final = await this.prisma.trackerProvisioning.findUnique({ where: { id: provisioningId } });
    if (final && final.status === TrackerProvisioningStatus.IN_PROGRESS) {
      const stepsArr = (final.steps as unknown as StepRecord[]) ?? [];
      const failed = stepsArr.filter((s) => s.status === 'failed').length;
      const acked = stepsArr.filter((s) => s.status === 'acked').length;
      await this.prisma.trackerProvisioning.update({
        where: { id: provisioningId },
        data: {
          status: failed > 0 ? TrackerProvisioningStatus.FAILED : TrackerProvisioningStatus.COMPLETED,
          completedAt: failed > 0 ? null : new Date(),
          failedAt: failed > 0 ? new Date() : null,
          failureReason: failed > 0 ? `${failed} SMS echoues sur ${stepsArr.length}` : null,
        },
      });

      // V1.18 — Remontee au centre d'alerte (error_logs).
      if (failed > 0) {
        // Echec d'ENVOI reel (passerelle) -> erreur immediate et visible.
        void this.errorLogger
          .record(
            `Provisioning ${params.imei} : ${failed}/${stepsArr.length} SMS non envoyes (echec passerelle)`,
            'sms-provisioning',
            { imei: params.imei, provisioningId, failedSteps: failed },
            'ERROR',
          )
          .catch(() => undefined);
      } else if (canReadReplies && acked === 0 && stepsArr.length > 0) {
        // Tous les SMS sont partis mais le boitier n'a repondu a AUCUN. On laisse
        // NO_RESPONSE_GRACE_MS au boitier pour se connecter au serveur, puis on
        // alerte UNIQUEMENT s'il reste injoignable (evite les faux positifs).
        const timer = setTimeout(
          () => void this.alertIfBoitierSilent(provisioningId, params.imei),
          NO_RESPONSE_GRACE_MS,
        );
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
  }

  /**
   * V1.18 — Filet de securite pour le centre d'alerte. Appelee NO_RESPONSE_GRACE_MS
   * apres un provisioning ou le boitier n'a repondu a aucun SMS. On verifie s'il
   * s'est quand meme connecte au serveur (TCP) entre-temps :
   *   - tracker en ligne / vu depuis le lancement -> tout va bien, AUCUNE alerte
   *     (le provisioning a fonctionne, l'absence d'ACK SMS n'est pas un echec) ;
   *   - sinon (ni ACK, ni connexion) -> vraie panne, on remonte une ERROR.
   * Ce délai + ce double critere evitent les faux positifs dans le centre d'alerte.
   */
  private async alertIfBoitierSilent(provisioningId: string, imei: string): Promise<void> {
    try {
      const prov = await this.prisma.trackerProvisioning.findUnique({ where: { id: provisioningId } });
      if (!prov) return;
      const steps = (prov.steps as unknown as StepRecord[]) ?? [];
      if (steps.some((s) => s.status === 'acked')) return; // le boitier a fini par repondre

      const tracker = await this.prisma.tracker.findUnique({
        where: { imei },
        select: { status: true, lastSeenAt: true },
      });
      const online =
        tracker?.status === TrackerStatus.ONLINE ||
        (tracker?.lastSeenAt != null &&
          prov.startedAt != null &&
          tracker.lastSeenAt.getTime() >= prov.startedAt.getTime());
      if (online) return; // s'est connecte au serveur -> OK, pas de bruit

      await this.errorLogger.record(
        `Provisioning ${imei} : boitier injoignable — aucune reponse SMS et aucune connexion serveur apres ${Math.round(
          NO_RESPONSE_GRACE_MS / 60000,
        )} min (verifier SIM / couverture / IP+port serveur)`,
        'sms-provisioning',
        { imei, provisioningId },
        'ERROR',
      );
    } catch (e) {
      this.logger.warn(`alertIfBoitierSilent(${provisioningId}) échouée: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Met a jour une etape (par index) dans le JSON `steps` + bump currentStep. */
  private async patchStep(provisioningId: string, index: number, patch: Partial<StepRecord>): Promise<void> {
    const row = await this.prisma.trackerProvisioning.findUnique({ where: { id: provisioningId } });
    if (!row) return;
    const steps = (row.steps as unknown as StepRecord[]) ?? [];
    if (!steps[index]) return;
    steps[index] = { ...steps[index], ...patch };
    await this.prisma.trackerProvisioning.update({
      where: { id: provisioningId },
      data: { steps: steps as object, currentStep: Math.max(row.currentStep ?? 0, index + 1) },
    });
  }

  // ─── Annulation / lecture (inchange) ──────────────────────────────────────

  /**
   * Annule une sequence en cours.
   *
   * `requestedBy` est optionnel pour ne pas casser les anciens appels internes,
   * mais le controller HTTP doit toujours le fournir pour appliquer le tenant
   * check (defense en profondeur).
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
    const take = Math.min(limit, 200);
    const isSuper = !requestedBy || requestedBy.role === UserRole.SUPER_ADMIN;
    if (isSuper) {
      return this.withTrackerStatus(
        await this.prisma.trackerProvisioning.findMany({ orderBy: { createdAt: 'desc' }, take }),
      );
    }
    if (!requestedBy.fleetId) return [];
    // Tenant-scoped : ne retourne que les provisionings dont l'imei est attache
    // a un tracker de la flotte courante.
    const trackers = await this.prisma.tracker.findMany({
      where: { vehicle: { fleetId: requestedBy.fleetId } },
      select: { imei: true },
    });
    if (trackers.length === 0) return [];
    return this.withTrackerStatus(
      await this.prisma.trackerProvisioning.findMany({
        where: { imei: { in: trackers.map((t) => t.imei) } },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );
  }

  async findOne(id: string, requestedBy?: RequestedBy) {
    const row = await this.prisma.trackerProvisioning.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Provisionnement introuvable');
    await this.assertTenantAccess(row.imei, requestedBy);
    const [enriched] = await this.withTrackerStatus([row]);
    return enriched;
  }

  /**
   * V1.18 — Attache l'etat LIVE du tracker (par imei) a chaque provisioning, pour
   * que l'UI confirme « Tracker connecte » via la reconnexion TCP du boitier plutot
   * que via les ACK SMS (chaine entrante fragile). Une seule requete tracker quel
   * que soit le nombre de lignes (lookup par imei in [...]). Voir {@link TrackerLiveStatus}.
   */
  private async withTrackerStatus<T extends { imei: string; startedAt: Date | null }>(
    rows: T[],
  ): Promise<(T & { tracker: TrackerLiveStatus | null })[]> {
    if (rows.length === 0) return [];
    const imeis = [...new Set(rows.map((r) => r.imei))];
    const trackers = await this.prisma.tracker.findMany({
      where: { imei: { in: imeis } },
      select: { imei: true, status: true, lastSeenAt: true, lastPositionAt: true },
    });
    const byImei = new Map(trackers.map((t) => [t.imei, t]));
    return rows.map((r) => {
      const t = byImei.get(r.imei);
      const tracker: TrackerLiveStatus | null = t
        ? {
            status: t.status,
            lastSeenAt: t.lastSeenAt,
            lastPositionAt: t.lastPositionAt,
            seenSinceStart:
              t.lastSeenAt != null && r.startedAt != null && t.lastSeenAt.getTime() >= r.startedAt.getTime(),
          }
        : null;
      return { ...r, tracker };
    });
  }

  /**
   * Resout la flotte via imei -> tracker.vehicle.fleetId et la compare au caller.
   * Échoué par 404 si le caller est non-SUPER et que le tracker n'appartient
   * pas a sa flotte (ou n'a pas de véhicule rattache).
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import twilio from 'twilio';
import type { Twilio } from 'twilio';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { toE164 } from '../common/utils/phone';
import type { SmsTemplateId } from '../communications/communications.catalog';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AllowlistService } from './allowlist.service';

/**
 * V1.5 (Sprint I) — SMS Gateway via Twilio.
 *
 * Mode "no-op" : si TWILIO_ACCOUNT_SID est vide, le service log les envois mais
 * ne fait pas d'appel reseau. Permet de developper / tester en local sans
 * credentials Twilio.
 *
 * Toutes les routes consommatrices sont reservees SUPER_ADMIN (cf.
 * SmsAdminController, decision §0.3 de docs/13-roadmap-v1.5-finition.md).
 */

/**
 * Statut de SOUMISSION d'un SMS sortant, tel que la passerelle le rend dans la même
 * seconde. Ce sont les valeurs jamais réécrites par personne (cf. TRK-026).
 */
export const SMS_SUBMISSION_STATUSES = ['queued', 'accepted', 'sending', 'sent', 'noop'] as const;
/** Statuts terminaux d'ÉCHEC connus (fournisseur). */
export const SMS_FAILED_STATUSES = [
  'failed',
  'rejected',
  'undelivered',
  'error',
  'cancelled',
  'canceled',
] as const;
/** Statuts terminaux de SUCCÈS — les seuls qui prouvent une remise. */
export const SMS_DELIVERED_STATUSES = ['delivered', 'received'] as const;

/**
 * Issue d'un envoi, à trois états — TRK-026 (2026-08-17).
 *
 * ⚠️ **Un booléen ne peut pas porter « accepté mais non confirmé »**, et c'est le SEUL
 * état que ce canal produise aujourd'hui : la passerelle répond `queued` dans la même
 * seconde et **aucun accusé de remise n'a jamais été enregistré**. Tout code qui traitait
 * `ok === true` comme « le SMS est arrivé » se trompait ; il n'a jamais dit que ça.
 *
 * - `accepted`  : la passerelle a pris le message. **Ne prouve RIEN sur sa remise.**
 * - `delivered` : un statut terminal de succès a été observé. **Seul cas qui prouve.**
 * - `failed`    : refus explicite (HTTP non-2xx, statut d'échec, exception réseau).
 */
export type SmsOutcome = 'accepted' | 'delivered' | 'failed';

/** Traduit un statut fournisseur en issue à trois états. */
export function smsOutcomeFromStatus(status: string | null | undefined): SmsOutcome {
  const s = String(status ?? '').toLowerCase();
  if ((SMS_FAILED_STATUSES as readonly string[]).includes(s)) return 'failed';
  if ((SMS_DELIVERED_STATUSES as readonly string[]).includes(s)) return 'delivered';
  return 'accepted';
}

export interface SendSmsResult {
  /**
   * ⚠️ **`ok` signifie « non refusé », PAS « remis »** (TRK-026). Conservé tel quel : 11
   * appelants s'appuient dessus, dont le repli du coupe-circuit — en changer le sens
   * silencieusement serait pire que le défaut. Pour décider d'après une PREUVE de remise,
   * lire `outcome === 'delivered'`.
   */
  ok: boolean;
  /** Issue à trois états. `accepted` = pris en charge, remise NON prouvée. */
  outcome: SmsOutcome;
  /** Statut brut rendu par la passerelle à la soumission (`queued` en pratique). */
  submittedStatus?: string;
  /** Identifiant de la ligne `sms_logs` créée — point d'entrée de la réconciliation. */
  smsLogId?: string;
  twilioSid?: string;
  error?: string;
}

/**
 * Contexte d'un envoi SMS. `template` est OBLIGATOIRE (et typé) : c'est lui qui rend
 * le message identifiable dans le module admin « Communications ». Le compilateur
 * refuse donc un SMS anonyme — impossible d'en envoyer un qui n'apparaîtrait nulle part.
 *
 * Les autres clés restent libres et sont conservées telles quelles dans `sms_logs.context`
 * (dont l'ancien `source`, sur lequel s'appuient des requêtes JSON existantes).
 */
export interface SmsSendContext {
  template: SmsTemplateId;
  imei?: string;
  provisioningId?: string;
  requestedByUserId?: string;
  /**
   * T41 (contre-expertise du 13/09, P0-2) — validité transmise au relais, en secondes : passé
   * ce délai, le TÉLÉPHONE n'émet plus le message. À poser sur une COUPURE moteur, jamais sur
   * une remise en route. Conservé dans `sms_logs.context` pour relecture.
   */
  ttlSeconds?: number;
  /**
   * T41 — priorité capcom6 (−128 … 127) transmise au relais ; ≥ 100 contourne les limites et
   * délais du téléphone. Distinct de `priority` (chaîne), qui ordonne la file LOCALE de Tracky.
   */
  smsPriority?: number;
  [k: string]: unknown;
}

/**
 * Event emis a chaque SMS ENTRANT persiste (webhook vizyo-texto -> recordInbound).
 * La state machine de provisioning (TrackerProvisioningService) s'y abonne pour
 * faire avancer la sequence des qu'un boitier repond (ACK).
 */
export const SMS_INBOUND_EVENT = 'sms.inbound';
export interface SmsInboundEvent {
  smsLogId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  receivedAt: string;
}

export interface TextoGatewayHealth {
  observedAt: string;
  operational: boolean;
  provider: {
    status: string;
    version: string | null;
    releaseId: string | null;
  };
  device: {
    count: number;
    /** Dernier ping de l'appareil du verdict (nom historique conservé). */
    freshestLastSeenAt: string | null;
    ageSeconds: number | null;
    fresh: boolean;
    staleAfterSeconds: number;
    // T44 — facultatifs : un relais antérieur ne les envoie pas, et `fresh` suffit au verdict.
    /** ONLINE / STALE / OFFLINE / UNKNOWN — voir le relais (README, « santé »). */
    state?: 'ONLINE' | 'STALE' | 'OFFLINE' | 'UNKNOWN';
    selectedId?: string | null;
    selectedName?: string | null;
    selection?: 'configured' | 'single' | 'none' | 'ambiguous' | 'missing';
    offlineAfterSeconds?: number;
  };
  sim: {
    configuredNumber: number | null;
    cards?: Array<{ simNumber: number | null; phoneNumber: string | null; carrierName: string | null }>;
    configuredPresent?: boolean | null;
  };
  queue: {
    pending: number;
    oldestPendingAt: string | null;
    oldestAgeSeconds: number | null;
    failed24h: number;
  };
  telemetry: { batteryAvailable: boolean; chargingAvailable: boolean };
  error?: string;
}

export interface SmsGatewayHealth {
  enabled: boolean;
  reachable: boolean;
  error?: string;
  errorCode?: string;
  fromNumber?: string;
  recentFailures24h?: number;
  lastFailure?: {
    at: string;
    toNumber: string | null;
    errorCode?: string;
    errorMessage?: string;
  } | null;
  deliveryProofAvailable: boolean;
  pendingWithoutReceipt: number;
  oldestPendingAt: string | null;
  lastTerminalSuccessAt: string | null;
  gateway?: TextoGatewayHealth;
}

/**
 * ══ TRK-066 — QUAND LE DERNIER RECOURS SE TAIT, IL DOIT AU MOINS DIRE LEQUEL ═════════════
 *
 * Le 2026-09-04 à 03:00:10, la passerelle SMS a écrit sa **toute première ligne d'erreur** — le
 * référentiel notait, pour cette source, « **0 depuis toujours** ». Le message était :
 *
 *     The operation was aborted due to timeout
 *
 * Sept mots qui ne nomment ni la dépendance, ni la conséquence, ni ce qui survit. Or ce qui se
 * jouait derrière était le **coupe-circuit** : le boîtier `FG-669-DQ` était hors ligne, le repli
 * SMS était donc la DERNIÈRE voie, et le relais n'a pas répondu dans les 10 secondes accordées.
 * **Le véhicule n'a pas été immobilisé.**
 *
 * 🔑 C'est le défaut de TRK-060, sur une chaîne bien plus grave : *un message qui recopie l'erreur
 * de transport fait porter tout le travail de traduction à l'exploitant, et l'envoie au mauvais
 * endroit.* Celui-ci ne disait même pas quel relais avait expiré.
 *
 * ⚠️ **On change l'ORDRE, on n'efface rien** : le motif technique reste en fin de phrase ET dans
 * le contexte (`motifTechnique`), pour que la ligne reste diagnosticable.
 *
 * ⚠️ **Ce correctif ne touche PAS la garde elle-même.** Le délai de 10 s, l'absence de réessai sur
 * le dernier recours, et le niveau `ERROR` porté par une immobilisation qui n'a pas eu lieu sont
 * instruits dans la fiche TRK-066 : ils relèvent du coupe-circuit, que le §8 de la procédure
 * d'audit interdit de modifier sans décision humaine. *On corrige le cri, jamais le garde-fou.*
 */
export function decrireEchecRelaisSms(motif: string, destinataire: string): string {
  const expiration = /abort|timeout|timed out/i.test(motif);
  const masque = destinataire.length > 4 ? `…${destinataire.slice(-4)}` : destinataire;
  const cause = expiration
    ? "le relais SMS (vizyo-texto) n'a pas répondu dans le délai accordé"
    : 'le relais SMS (vizyo-texto) a refusé la demande';
  return (
    `SMS non remis au relais : ${cause}. Le message vers ${masque} n'est pas parti — ` +
    "si cet envoi était le repli d'une commande moteur, le véhicule n'a PAS été immobilisé. " +
    `Motif technique : ${motif.replace(/\s+/g, ' ').trim().slice(0, 200)}`
  );
}

@Injectable()
export class SmsGatewayService implements OnModuleInit {
  private readonly logger = new Logger(SmsGatewayService.name);

  /**
   * File FIFO locale devant la passerelle Android. Elle ne remplace pas la file
   * persistante du téléphone : elle empêche Tracky de lui injecter une rafale
   * (10 messages en 6 s lors de l'incident du 11/09).
   *
   * Les RESTORE restent, eux, rejouables depuis la base par EngineControlService :
   * un redémarrage API ne peut donc pas les perdre avec cette file mémoire.
   */
  private smsDispatchQueue: Array<{
    sequence: number;
    priority: number;
    to: string;
    body: string;
    context: SmsSendContext;
    resolve: (result: SendSmsResult) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private smsDispatchSequence = 0;
  private smsDispatchProcessing = false;
  private queuedForDispatch = 0;
  private nextDispatchAt = 0;
  private readonly minIntervalMs: number;

  // Provider actif : vizyo-texto (passerelle SMS maison) > twilio (legacy/fallback) > noop.
  private readonly provider: 'vizyo-texto' | 'twilio' | 'noop';

  // vizyo-texto (V1.14 — remplace Twilio). Cf. VIZYO_TEXTO_* dans env.validation.
  private readonly textoUrl: string;
  private readonly textoApiKey: string;

  // Twilio (legacy, conserve en fallback le temps de la transition).
  private readonly client: Twilio | null;
  private readonly fromNumber: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
    private readonly eventEmitter: EventEmitter2,
    private readonly systemActivity: SystemActivityService,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
    /**
     * T52 (contre-expertise du 13/09, P2-9) — l'allowlist du relais ne doit pas rester sur le
     * chemin d'une remise en route. Facultatif : les specs construisent le service sans lui.
     */
    @Optional() @Inject(AllowlistService) private readonly allowlist?: AllowlistService,
  ) {
    this.textoUrl = (this.config?.get('VIZYO_TEXTO_URL', { infer: true }) ?? '').replace(/\/+$/, '');
    this.textoApiKey = this.config?.get('VIZYO_TEXTO_API_KEY', { infer: true }) ?? '';

    const sid = this.config?.get('TWILIO_ACCOUNT_SID', { infer: true }) ?? '';
    const token = this.config?.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
    this.fromNumber = this.config?.get('TWILIO_PHONE_NUMBER', { infer: true }) ?? '';
    const configuredInterval = this.config?.get('SMS_MIN_INTERVAL_MS', { infer: true });
    this.minIntervalMs = Math.max(
      0,
      Number.isFinite(Number(configuredInterval))
        ? Number(configuredInterval)
        : process.env['NODE_ENV'] === 'production'
          ? 15_000
          : 0,
    );

    if (this.textoUrl && this.textoApiKey) {
      this.provider = 'vizyo-texto';
      this.client = null;
      this.logger.log(`SMS Gateway active via vizyo-texto (${this.textoUrl})`);
    } else if (sid && token && this.fromNumber) {
      this.provider = 'twilio';
      this.client = twilio(sid, token);
      this.logger.log(`SMS Gateway active via Twilio (from ${this.fromNumber})`);
    } else {
      this.provider = 'noop';
      this.client = null;
      this.logger.warn('SMS Gateway disabled (ni VIZYO_TEXTO_* ni TWILIO_* configures) — mode no-op');
    }
  }

  // A8 — Alerte persistante si SMS en mode noop en production.
  async onModuleInit(): Promise<void> {
    if (this.provider === 'noop' && process.env['NODE_ENV'] === 'production') {
      this.errorLogger.record(
        'SMS Gateway en mode noop — ni VIZYO_TEXTO ni TWILIO configures',
        'sms-gateway',
        { NODE_ENV: process.env['NODE_ENV'] },
        'CRITICAL',
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
    }
  }

  isEnabled(): boolean {
    return this.provider !== 'noop';
  }

  /** Provider SMS actif (pour l'affichage du statut admin). */
  currentProvider(): 'vizyo-texto' | 'twilio' | 'noop' {
    return this.provider;
  }

  /** Mesures sans effet de bord pour les sentinelles et l'interface admin. */
  dispatchQueueState(): { depth: number; minIntervalMs: number; nextDispatchAt: string | null } {
    return {
      depth: this.queuedForDispatch,
      minIntervalMs: this.minIntervalMs,
      nextDispatchAt: this.nextDispatchAt > Date.now() ? new Date(this.nextDispatchAt).toISOString() : null,
    };
  }

  /**
   * V1.13 — Health check Twilio reel (auth ping + audit recents echecs).
   *
   * Cas couverts :
   *   - enabled = false : env vars manquants → mode noop (dev)
   *   - enabled = true + reachable = true : auth OK, gateway fonctionnelle
   *   - enabled = true + reachable = false : env vars set mais credentials
   *     invalides/expires/revoques (cas typique apres rotation Twilio)
   *
   * Avant : status() retournait juste enabled=bool (presence env vars) → UI
   * affichait "Twilio actif" alors qu'en realite les envois faisaient HTTP 401
   * silencieusement. L'admin devait fouiller les SMS logs pour decouvrir
   * `errorCode: 20003 "Authenticate"`. Maintenant on ping reellement.
   *
   * Le ping est non-bloquant : si Twilio est down/timeout, on retourne
   * unreachable avec l'erreur — pas d'exception propagee.
   */
  async healthCheck(): Promise<SmsGatewayHealth> {
    /**
     * 🔴 TRK-026 — **`recentFailures24h` n'est PAS un indicateur de santé**, et l'écran ne
     * doit plus le présenter comme tel. Il compte les lignes `status='failed'`, or aucun
     * code ne réécrit jamais `sms_logs.status` : seul un refus SYNCHRONE (HTTP non-2xx,
     * timeout) peut produire un `failed`. Une SIM expirée, un téléphone déchargé ou un
     * opérateur qui bloque rendent tous HTTP 200 + `queued` → ce compteur vaut 0.
     * Mesuré en prod : dernier `failed` le 2026-07-25, soit 0 pendant 22 jours de cécité.
     *
     * `deliveryProofAvailable` dit la vérité : tant qu'il vaut `false`, AUCUN compteur de
     * cette réponse ne peut affirmer que la chaîne fonctionne.
     */
    // Compte les SMS OUT en echec dans les 24h (utile meme en mode noop).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const submission = [...SMS_SUBMISSION_STATUSES];
    const [recentFailures24h, lastFailureRow, pendingWithoutReceipt, oldestPending, everDelivered, lastDelivered] =
      await Promise.all([
        this.prisma.smsLog.count({
          where: { direction: 'OUT', status: { in: [...SMS_FAILED_STATUSES] }, createdAt: { gte: since } },
        }),
        this.prisma.smsLog.findFirst({
          where: { direction: 'OUT', status: { in: [...SMS_FAILED_STATUSES] } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, toNumber: true, errorCode: true, errorMessage: true },
        }),
        // Sortants figés sur un statut de soumission : la mesure honnête de la cécité.
        this.prisma.smsLog.count({
          where: { direction: 'OUT', status: { in: submission } },
        }),
        this.prisma.smsLog.findFirst({
          where: { direction: 'OUT', status: { in: submission } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        // Un SEUL sortant ayant atteint un statut terminal de succès suffit à prouver que la
        // chaîne d'accusés de remise existe. Zéro = elle n'a jamais fonctionné.
        this.prisma.smsLog.count({
          where: { direction: 'OUT', status: { in: [...SMS_DELIVERED_STATUSES] } },
        }),
        this.prisma.smsLog.findFirst({
          where: { direction: 'OUT', status: { in: [...SMS_DELIVERED_STATUSES] } },
          orderBy: [
            { statusUpdatedAt: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' },
          ],
          select: { createdAt: true, statusUpdatedAt: true },
        }),
      ]);

    const lastFailure = lastFailureRow
      ? {
          at: lastFailureRow.createdAt.toISOString(),
          toNumber: lastFailureRow.toNumber,
          errorCode: lastFailureRow.errorCode ?? undefined,
          errorMessage: lastFailureRow.errorMessage ?? undefined,
        }
      : null;
    const deliveryProofAvailable = everDelivered > 0;
    const oldestPendingAt = oldestPending ? oldestPending.createdAt.toISOString() : null;
    const lastTerminalSuccessAt = lastDelivered
      ? (lastDelivered.statusUpdatedAt ?? lastDelivered.createdAt).toISOString()
      : null;

    // vizyo-texto : santé authentifiée BOUT-EN-BOUT. `/health` ne prouvait que
    // le processus Node ; `/v1/texto/health` prouve aussi que le téléphone ping.
    if (this.provider === 'vizyo-texto') {
      try {
        const res = await fetch(`${this.textoUrl}/v1/texto/health`, {
          headers: { Authorization: `Bearer ${this.textoApiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          return {
            enabled: true,
            reachable: false,
            error: `Télémétrie Android indisponible (HTTP ${res.status})`,
            fromNumber: this.textoUrl,
            recentFailures24h,
            lastFailure,
            deliveryProofAvailable,
            pendingWithoutReceipt,
            oldestPendingAt,
            lastTerminalSuccessAt,
          };
        }
        const gateway = (await res.json()) as TextoGatewayHealth;
        const valid =
          typeof gateway?.operational === 'boolean' &&
          typeof gateway?.device?.fresh === 'boolean' &&
          typeof gateway?.provider?.status === 'string';
        if (!valid) throw new Error('réponse de télémétrie Android invalide');
        return {
          enabled: true,
          reachable: true,
          error: gateway.operational
            ? undefined
            : (gateway.error ?? 'téléphone Android absent ou périmé'),
          fromNumber: this.textoUrl,
          recentFailures24h,
          lastFailure,
          deliveryProofAvailable,
          pendingWithoutReceipt,
          oldestPendingAt,
          lastTerminalSuccessAt,
          gateway,
        };
      } catch (err) {
        return {
          enabled: true,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          fromNumber: this.textoUrl,
          recentFailures24h,
          lastFailure,
          deliveryProofAvailable,
          pendingWithoutReceipt,
          oldestPendingAt,
          lastTerminalSuccessAt,
        };
      }
    }

    if (this.provider === 'noop' || !this.client) {
      return {
        enabled: false,
        reachable: false,
        fromNumber: this.fromNumber || undefined,
        recentFailures24h,
        lastFailure,
        deliveryProofAvailable,
        pendingWithoutReceipt,
        oldestPendingAt,
        lastTerminalSuccessAt,
      };
    }

    const sid = this.config?.get('TWILIO_ACCOUNT_SID', { infer: true });
    try {
      // Ping Twilio en fetchant le compte. Cout = 1 req API simple, pas de SMS envoye.
      await this.client.api.accounts(sid as string).fetch();
      return {
        enabled: true,
        reachable: true,
        fromNumber: this.fromNumber,
        recentFailures24h,
        lastFailure,
        deliveryProofAvailable,
        pendingWithoutReceipt,
        oldestPendingAt,
        lastTerminalSuccessAt,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = (err as { code?: string | number }).code?.toString();
      return {
        enabled: true,
        reachable: false,
        error: errorMessage,
        errorCode,
        fromNumber: this.fromNumber,
        recentFailures24h,
        lastFailure,
        deliveryProofAvailable,
        pendingWithoutReceipt,
        oldestPendingAt,
        lastTerminalSuccessAt,
      };
    }
  }

  /**
   * Relit l'état d'un sortant et le RÉCONCILIE si un statut terminal est connu — TRK-026.
   *
   * 🔴 **Pourquoi cette méthode existe.** Avant le 2026-08-17, `grep -rn "smsLog.update"`
   * ne rendait **aucune occurrence** dans tout `apps/api/src` : `sms_logs.status` était écrit
   * une seule fois, à l'insertion, et plus jamais. Le webhook entrant (`recordInbound`) ne
   * crée que des lignes `received` pour les SMS **entrants** ; il ne réconcilie aucun sortant.
   * Conséquence : un sortant restait figé sur son statut de soumission à vie, et TOUT
   * instrument bâti dessus (preuve de vie, compteur d'échecs de l'écran admin) était inerte.
   *
   * ⚠️ **Cette méthode ne fabrique pas de preuve.** Elle offre le point d'entrée qui manquait.
   * Tant que la passerelle n'expose pas d'accusé de remise (correctif nº 1 de TRK-018, dépôt
   * `vizyo-texto`), `providerStatus` est indisponible et l'issue reste `accepted` — ce qui est
   * la réponse HONNÊTE, pas un échec de la réconciliation.
   *
   * @param providerStatus statut terminal observé côté fournisseur, si on en a un.
   * @returns l'issue à trois états après réconciliation, ou `null` si la ligne est introuvable.
   */
  /**
   * Lit l'état d'un sortant auprès de la passerelle vizyo-texto — TRK-026.
   *
   * `GET /v1/texto/:id`. L'identifiant passé est celui que `sendViaVizyoTexto` a persisté
   * dans `twilioSid`, c'est-à-dire `data.providerId ?? data.id` : le plus souvent celui de
   * **capcom6**, pas celui de la passerelle. La recherche côté passerelle accepte les deux
   * clefs (même correctif, dépôt `vizyo-texto`) — sans quoi cet appel rendrait 404 sur une
   * ligne qui existe.
   *
   * ⚠️ Ne lève JAMAIS. Un échec de lecture doit laisser l'appelant sur « pas de preuve »,
   * pas le faire tomber : la preuve de vie tourne dans un cron, et une passerelle
   * injoignable est précisément l'un des cas qu'elle est censée signaler.
   */
  private async lireStatutPasserelle(providerId: string): Promise<string | null> {
    if (!this.textoUrl || !this.textoApiKey) return null;
    try {
      const res = await fetch(`${this.textoUrl}/v1/texto/${encodeURIComponent(providerId)}`, {
        headers: { Authorization: `Bearer ${this.textoApiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { status?: string | null };
      return typeof data?.status === 'string' && data.status.length > 0 ? data.status : null;
    } catch (err) {
      // Volontairement silencieux au niveau `debug` : cette lecture est un CONFORT. La
      // journaliser en erreur ferait du bruit à chaque passage de cron quand la passerelle
      // est en panne — or cette panne-là a déjà son propre signal, la preuve de vie.
      this.logger.debug(
        `Lecture du statut passerelle impossible pour ${providerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async reconcileOutboundStatus(
    smsLogId: string,
    providerStatus?: string | null,
  ): Promise<{ outcome: SmsOutcome; status: string | null; changed: boolean } | null> {
    const log = await this.prisma.smsLog.findUnique({
      where: { id: smsLogId },
      select: { id: true, status: true, direction: true, twilioSid: true },
    });
    if (!log || log.direction !== 'OUT') return null;

    // Un statut déjà terminal n'est JAMAIS réécrit — une preuve de remise ne se dégrade pas.
    const current = smsOutcomeFromStatus(log.status);
    if (current !== 'accepted') {
      return { outcome: current, status: log.status, changed: false };
    }

    // ══ TRK-026 (2026-08-24) — ON VA CHERCHER L'ACCUSÉ AU LIEU DE L'ATTENDRE ═══════════
    //
    // Cette méthode existait depuis le 17/08 et n'avait jamais rien réconcilié : son seul
    // appelant (la preuve de vie) l'invoquait SANS `providerStatus`, et personne ne lui en
    // fournissait. Elle rendait donc invariablement l'état de soumission — d'où un verdict
    // `INDETERMINE` permanent et 365 sortants figés en `queued` depuis le 03/06.
    //
    // Mesuré le 24/08 : **l'information existait depuis le début.** Interrogé directement,
    // capcom6 répond `state: "Delivered"` — horodatage compris — pour le message de 07:00
    // que le propriétaire avait bien reçu sur son téléphone. Personne ne le lui demandait.
    // Deux maillons manquaient, tous deux posés ce jour :
    //   1. capcom6 n'avait qu'un webhook abonné (`sms:received`) ; `sms:sent`,
    //      `sms:delivered` et `sms:failed` ont été enregistrés côté passerelle ;
    //   2. Tracky ne relisait jamais l'état — c'est ce que fait le repli ci-dessous.
    //
    // ⚠️ BEST-EFFORT, ET C'EST VOULU. Toute panne de lecture (passerelle injoignable, 404,
    // JSON illisible, délai dépassé) laisse le statut indéfini, donc l'issue reste
    // `accepted` et le verdict `INDETERMINE`. *Ne jamais transformer une absence de réponse
    // en preuve de remise* — c'est exactement le défaut que TRK-026 décrit.
    let statutFournisseur = providerStatus ?? null;
    if (!statutFournisseur && log.twilioSid) {
      statutFournisseur = await this.lireStatutPasserelle(log.twilioSid);
    }
    if (!statutFournisseur) {
      return { outcome: current, status: log.status, changed: false };
    }

    const next = String(statutFournisseur).toLowerCase();
    if (smsOutcomeFromStatus(next) === 'accepted') {
      // Le fournisseur répond encore un statut de soumission → toujours aucune preuve.
      return { outcome: 'accepted', status: log.status, changed: false };
    }
    const updated = await this.prisma.smsLog.update({
      where: { id: log.id },
      data: { status: next, statusUpdatedAt: new Date() },
      select: { status: true },
    });
    return { outcome: smsOutcomeFromStatus(updated.status), status: updated.status, changed: true };
  }

  /**
   * Point d'entrée des webhooks de statut sortant. Le poller reste la seconde
   * voie indépendante ; le webhook accélère seulement la vérité terminale.
   */
  /**
   * T41 — annule un sortant encore en attente au relais (DELETE /v1/texto/:providerId).
   *
   * Le cas : une COUPURE partie par SMS vers un téléphone endormi, puis supplantée par une
   * remise en route. Best-effort par construction — ne lève JAMAIS, rend ce qui s'est passé :
   * le relais répond toujours 200 avec `cancelled` et sa raison (message déjà pris par le
   * téléphone, serveur capcom6 antérieur à v1.45.0). Le `ttlSeconds` posé à l'envoi couvre
   * ce que l'annulation ne peut pas rattraper.
   */
  async cancelOutbound(
    smsLogId: string,
  ): Promise<{ ok: boolean; status?: string; reason?: string }> {
    try {
      const log = await this.prisma.smsLog.findUnique({
        where: { id: smsLogId },
        select: { id: true, status: true, direction: true, twilioSid: true },
      });
      if (!log || log.direction !== 'OUT') return { ok: false, reason: 'sortant introuvable' };
      if (!log.twilioSid) return { ok: false, reason: 'aucun identifiant fournisseur' };
      if (smsOutcomeFromStatus(log.status) !== 'accepted') {
        return { ok: false, status: log.status ?? undefined, reason: `statut ${log.status} : plus annulable` };
      }
      if (this.provider !== 'vizyo-texto') {
        return { ok: false, reason: `annulation non supportée par le fournisseur ${this.provider}` };
      }
      const res = await fetch(`${this.textoUrl}/v1/texto/${encodeURIComponent(log.twilioSid)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.textoApiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { ok: false, reason: `relais HTTP ${res.status}` };
      const data = (await res.json().catch(() => ({}))) as {
        cancelled?: boolean;
        status?: string;
        reason?: string;
      };
      if (!data.cancelled) {
        return { ok: false, status: data.status, reason: data.reason ?? 'annulation refusée par le relais' };
      }
      const status = typeof data.status === 'string' && data.status ? data.status : 'cancelling';
      await this.prisma.smsLog.update({
        where: { id: log.id },
        data: { status, statusUpdatedAt: new Date() },
      });
      return { ok: true, status };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async recordOutboundStatus(input: {
    providerId: string;
    status: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<{ found: boolean; smsLogId?: string; outcome?: SmsOutcome }> {
    const log = await this.prisma.smsLog.findFirst({
      where: { direction: 'OUT', twilioSid: input.providerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, imei: true, status: true },
    });
    if (!log) return { found: false };

    // T45 — le relais pousse désormais `cancelled` (serveur capcom6 ≥ v1.45.0). Une annulation
    // que NOUS avons demandée (T41 : CUT supplantée, ligne déjà `cancelling`) n'est pas une panne
    // : le statut terminal est écrit, mais aucune alerte n'est levée.
    const annulationVoulue =
      String(log.status ?? '').toLowerCase() === 'cancelling' &&
      ['cancelled', 'canceled'].includes(String(input.status).toLowerCase());

    const rec = await this.reconcileOutboundStatus(log.id, input.status);
    if (!rec) return { found: false };
    if (rec.outcome === 'failed' && annulationVoulue) {
      this.logger.log({ smsLogId: log.id, providerId: input.providerId }, 'SMS annulé au relais comme demandé (T41)');
      return { found: true, smsLogId: log.id, outcome: rec.outcome };
    }
    if (rec.outcome === 'failed') {
      await this.prisma.smsLog.update({
        where: { id: log.id },
        data: {
          errorCode: input.errorCode ?? undefined,
          errorMessage: input.errorMessage ?? undefined,
        },
      });
      if (rec.changed) {
        this.errorLogger.record(
          `SMS en échec terminal (${rec.status ?? input.status})`,
          'sms-gateway-status',
          {
            smsLogId: log.id,
            providerId: input.providerId,
            imei: log.imei ?? undefined,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
          },
          'CRITICAL',
        ).catch(() => undefined);
      }
    }
    return { found: true, smsLogId: log.id, outcome: rec.outcome };
  }

  /**
   * Send an SMS and persist the audit row in `sms_logs`.
   * In no-op mode, the audit row is still written with `status = 'noop'`.
   *
   * Palier B — wrapper qui journalise l'action système (arrière-plan) une fois le résultat
   * connu, quel que soit le canal (vizyo-texto / Twilio / no-op). Le corps technique est dans
   * `performSend()`. Couvre commandes device, provisioning, audio arm/disarm, alertes SMS.
   */
  async send(
    to: string,
    body: string,
    context: SmsSendContext,
  ): Promise<SendSmsResult> {
    // ⚠️ Dernière ligne de défense (incident 2026-07-19) : un numéro international arrivé SANS `+`
    // (catalogue opérateur) faisait échouer 100 % des envois — donc le repli SMS du coupe-circuit.
    // On NORMALISE ici plutôt que de rejeter : si un autre chemin écrit un numéro brut un jour, le
    // SMS partira quand même. `toE164` reste prudent (un numéro national n'est jamais préfixé).
    const normalized = toE164(to) ?? to;
    const priority = context['priority'] === 'critical_restore'
      ? 100
      : context.template === 'engine_control_fallback'
        ? 50
        : 0;
    this.queuedForDispatch += 1;
    return new Promise<SendSmsResult>((resolve, reject) => {
      this.smsDispatchQueue.push({
        sequence: this.smsDispatchSequence++,
        priority,
        to: normalized,
        body,
        context,
        resolve,
        reject,
      });
      // Le drain est unique. Une RESTORE peut dépasser les SMS ordinaires encore en
      // attente, tout en conservant le FIFO entre commandes de même priorité.
      void this.drainDispatchQueue();
    });
  }

  private async drainDispatchQueue(): Promise<void> {
    if (this.smsDispatchProcessing) return;
    this.smsDispatchProcessing = true;
    try {
      while (this.smsDispatchQueue.length > 0) {
        this.smsDispatchQueue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        const job = this.smsDispatchQueue.shift();
        if (!job) continue;
        try {
      const waitMs = Math.max(0, this.nextDispatchAt - Date.now());
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          // Le timer doit garder le processus vivant tant qu'un appel HTTP attend sa
          // place : contrairement aux sentinelles de fond, cet envoi a un appelant.
          if (typeof timer.ref === 'function') timer.ref();
        });
      }

          const result = await this.performSend(job.to, job.body, job.context);
      this.nextDispatchAt = Date.now() + this.minIntervalMs;
          const safeTo = job.to.trim();
          if (safeTo) this.recordSystemActivity(safeTo, job.body, job.context, result);
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        } finally {
          this.queuedForDispatch = Math.max(0, this.queuedForDispatch - 1);
        }
      }
    } finally {
      this.smsDispatchProcessing = false;
      // Couvre une insertion arrivée exactement entre la fin de la boucle et le finally.
      if (this.smsDispatchQueue.length > 0) void this.drainDispatchQueue();
    }
  }

  private async performSend(
    to: string,
    body: string,
    context: SmsSendContext,
  ): Promise<SendSmsResult> {
    const safeTo = to.trim();
    if (!safeTo) return { ok: false, outcome: 'failed', error: 'Numero destinataire vide' };

    // vizyo-texto en priorite (V1.14 — remplace l'appel Twilio).
    if (this.provider === 'vizyo-texto') {
      return this.sendViaVizyoTexto(safeTo, body, context);
    }

    // No-op mode: write the audit row, return success without network call.
    if (this.provider === 'noop' || !this.client) {
      const log = await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: this.fromNumber || 'noop',
          toNumber: safeTo,
          body,
          status: 'noop',
          template: context.template,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      this.logger.debug(`[noop] SMS to ${safeTo}: ${body}`);
      // `noop` = pris en charge, rien d'envoyé : `accepted`, jamais `delivered`. Hors prod
      // la nuance est gratuite ; en prod elle empêche un no-op de passer pour une remise.
      return { ok: true, outcome: 'accepted', submittedStatus: 'noop', smsLogId: log.id };
    }

    try {
      const message = await this.client.messages.create({
        from: this.fromNumber,
        to: safeTo,
        body,
      });
      const log = await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: this.fromNumber,
          toNumber: safeTo,
          body,
          twilioSid: message.sid,
          status: message.status,
          template: context.template,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      return {
        ok: true,
        // Twilio rend `queued`/`accepted` à la soumission : `accepted`, pas `delivered`.
        outcome: smsOutcomeFromStatus(message.status),
        submittedStatus: message.status,
        smsLogId: log.id,
        twilioSid: message.sid,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = (err as { code?: string | number }).code?.toString();
      await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: this.fromNumber,
          toNumber: safeTo,
          body,
          status: 'failed',
          errorCode,
          errorMessage,
          template: context.template,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      this.logger.error(`SMS send failed to ${safeTo}: ${errorMessage}`);
      this.errorLogger.record(
        err instanceof Error ? err : new Error(errorMessage),
        'sms-gateway',
        { imei: context?.imei, toNumber: safeTo, errorCode, provider: 'twilio' },
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
      return { ok: false, outcome: 'failed', submittedStatus: 'failed', error: errorMessage };
    }
  }

  /**
   * Palier B — trace le SMS dans le journal des actions système. Le numéro est MASQUÉ et le
   * corps CAVIARDÉ (les commandes device contiennent le mot de passe boîtier — jamais en clair
   * ici ; l'audit brut reste dans sms_logs, réservé SUPER_ADMIN). `context.source` fournit un
   * libellé lisible ('alert-notification', 'audio-auto-disarm', 'engine-control-fallback'…).
   */
  private recordSystemActivity(
    to: string,
    body: string,
    context: SmsSendContext,
    result: SendSmsResult,
  ): void {
    // `source` historique conservé en priorité (continuité des libellés déjà journalisés) ;
    // à défaut on retombe sur le `template` typé — plus aucun envoi n'est anonyme.
    const source = typeof context?.source === 'string' ? context.source : context.template;
    const triggeredByUserId =
      typeof context?.requestedByUserId === 'string' ? context.requestedByUserId : null;
    this.systemActivity.record({
      category: 'SMS',
      action: source ? `sms_${source}`.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) : 'sms_sent',
      // « accepted » signifie seulement que la passerelle a pris la demande. Le journal
      // global ne doit plus transformer cette soumission en fausse preuve de remise.
      status: result.outcome === 'delivered' ? 'SUCCESS' : result.outcome === 'failed' ? 'FAILURE' : 'SKIPPED',
      actor: 'system',
      target: maskPhone(to),
      detail:
        result.outcome === 'accepted'
          ? `${source ? `SMS (${source})` : redactSmsBody(body)} — soumis, remise non prouvée`
          : source ? `SMS (${source})` : redactSmsBody(body),
      triggeredByUserId,
      meta: {
        imei: typeof context?.imei === 'string' ? context.imei : undefined,
        provider: this.provider,
        outcome: result.outcome,
        error: result.error,
      },
    });
  }

  /**
   * V1.14 — Envoi via la passerelle vizyo-texto (POST /v1/texto/send).
   *
   * Garde l'interface SendSmsResult identique (twilioSid = providerId capcom6)
   * et ecrit la MEME ligne d'audit smsLog que le chemin Twilio, pour que le reste
   * du code (UI admin, state machine provisioning) ne voie aucune difference.
   */
  private async sendViaVizyoTexto(
    to: string,
    body: string,
    context: SmsSendContext,
    retriedAfterAllowlist = false,
  ): Promise<SendSmsResult> {
    try {
      // B1 — timeout 10s pour ne pas rester pendu si le relay hang.
      const res = await fetch(`${this.textoUrl}/v1/texto/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.textoApiKey}`,
        },
        body: JSON.stringify({
          to,
          body,
          context,
          // T41 — les deux options remontent au premier niveau, là où le relais les valide ;
          // elles restent aussi dans `context` pour l'audit.
          ...(Number.isFinite(context.ttlSeconds) ? { ttlSeconds: Math.floor(context.ttlSeconds as number) } : {}),
          ...(Number.isFinite(context.smsPriority) ? { priority: Math.trunc(context.smsPriority as number) } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      // A3 — si le JSON est malformé, on log dans ErrorLog (le body vide est traité par B4).
      let jsonParseOk = true;
      const data = (await res.json().catch((jsonErr: unknown) => {
        jsonParseOk = false;
        this.errorLogger.record(
          `vizyo-texto response JSON malformé: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
          'sms-gateway',
          { url: `${this.textoUrl}/v1/texto/send`, httpStatus: res.status, toNumber: to, imei: context?.imei },
        ).catch((e) => this.logger.error('ErrorLog persist failed', e));
        return {};
      })) as {
        id?: string;
        status?: string;
        providerId?: string;
        error?: string;
        message?: string;
      };

      // A2 — HTTP non-2xx : log dans ErrorLog.
      if (!res.ok) {
        const errorMessage = data.message ?? data.error ?? `HTTP ${res.status}`;
        // ══ T52 — L'ALLOWLIST NE BLOQUE PAS UNE REMISE EN ROUTE ═══════════════════════════════
        // Un 403 « hors allowlist » comptait comme un refus de soumission, trois fois, puis plus
        // aucun SMS : la garde anti-spam du relais restait sur le chemin de la restauration. Le
        // relais garde sa garde ; c'est Tracky — seul détenteur de la clé d'allowlist — qui
        // répare la sienne : le numéro du boîtier est ajouté à la volée, l'envoi est retenté
        // UNE fois, et une ligne dit que l'allowlist avait dérivé (la synchro a manqué un SIM).
        if (
          !retriedAfterAllowlist &&
          res.status === 403 &&
          /allowlist/i.test(errorMessage) &&
          context['priority'] === 'critical_restore' &&
          this.allowlist
        ) {
          try {
            await this.allowlist.add(to, `RESTORE ${context.imei ?? ''} — ajout automatique (T52)`.trim());
            this.errorLogger.record(
              `Allowlist du relais incomplète : ${to} ajouté à la volée pour une remise en route (la synchronisation avait manqué ce boîtier)`,
              'sms-gateway',
              { imei: context?.imei, toNumber: to, provider: 'vizyo-texto', phase: 'allowlist-self-heal' },
            ).catch(() => undefined);
            this.logger.warn(`T52 : ${to} ajouté à l'allowlist du relais, nouvel essai d'envoi (RESTORE)`);
            return this.sendViaVizyoTexto(to, body, context, true);
          } catch (addErr) {
            this.logger.error(
              `T52 : ajout de ${to} à l'allowlist impossible — ${addErr instanceof Error ? addErr.message : String(addErr)}`,
            );
            // On retombe sur le traitement d'échec ordinaire ci-dessous.
          }
        }
        await this.prisma.smsLog.create({
          data: {
            direction: 'OUT',
            fromNumber: 'vizyo-texto',
            toNumber: to,
            body,
            status: 'failed',
            errorMessage,
            template: context.template,
            imei: context?.imei,
            provisioningId: context?.provisioningId,
            context: context as object,
          },
        });
        this.logger.error(`SMS (vizyo-texto) échec vers ${to}: ${errorMessage}`);
        this.errorLogger.record(
          errorMessage,
          'sms-gateway',
          { imei: context?.imei, toNumber: to, httpStatus: res.status, provider: 'vizyo-texto' },
        ).catch((e) => this.logger.error('ErrorLog persist failed', e));
        return { ok: false, outcome: 'failed', submittedStatus: 'failed', error: errorMessage };
      }

      // B4 — 200 mais body vide/malformé → traiter comme échec.
      if (!jsonParseOk || Object.keys(data).length === 0) {
        const errorMessage = 'Response body vide ou malformé';
        await this.prisma.smsLog.create({
          data: {
            direction: 'OUT',
            fromNumber: 'vizyo-texto',
            toNumber: to,
            body,
            status: 'failed',
            errorMessage,
            template: context.template,
            imei: context?.imei,
            provisioningId: context?.provisioningId,
            context: context as object,
          },
        });
        this.logger.error(`SMS (vizyo-texto) échec vers ${to}: ${errorMessage}`);
        this.errorLogger.record(
          errorMessage,
          'sms-gateway',
          { imei: context?.imei, toNumber: to, httpStatus: res.status, provider: 'vizyo-texto' },
        ).catch((e) => this.logger.error('ErrorLog persist failed', e));
        return { ok: false, outcome: 'failed', submittedStatus: 'failed', error: errorMessage };
      }

      const providerId = data.providerId ?? data.id;
      const status = data.status ?? 'queued';
      const log = await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: 'vizyo-texto',
          toNumber: to,
          body,
          twilioSid: providerId,
          status,
          template: context.template,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      // #34 — `ok` ne doit PAS rester true pour les statuts d'echec autres que
      // 'failed' (rejected/undelivered/error...).
      //
      // 🔴 TRK-026 (2026-08-17) — **ce durcissement ne pouvait rien attraper.** Il élargit la
      // liste des statuts d'ÉCHEC, alors que le seul statut que cette passerelle rende ici est
      // `queued` — qui n'en est pas un, et ne doit pas en devenir un : `queued` n'est pas un
      // échec, c'est une ABSENCE DE RÉPONSE. En production, 332 messages sortants sont figés
      // sur ce statut et aucun n'a jamais atteint d'état terminal depuis le 2026-07-25.
      // *On avait corrigé la forme du test, pas le fait qu'il n'y a rien à tester.*
      //
      // D'où `outcome` : le statut de soumission décide de `accepted` vs `failed`, et JAMAIS
      // de `delivered`. Seule une réconciliation ultérieure (`reconcileOutboundStatus`) peut
      // prononcer `delivered` — et elle a besoin d'un accusé de remise que la passerelle
      // n'expose pas encore (correctif nº 1 de TRK-018, dépôt vizyo-texto).
      const outcome = smsOutcomeFromStatus(status);
      return {
        ok: outcome !== 'failed',
        outcome,
        submittedStatus: status,
        smsLogId: log.id,
        twilioSid: providerId,
      };
    } catch (err) {
      // A1 — erreur réseau / timeout → log dans ErrorLog.
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: 'vizyo-texto',
          toNumber: to,
          body,
          status: 'failed',
          errorMessage,
          template: context.template,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      this.logger.error(`SMS (vizyo-texto) erreur vers ${to}: ${errorMessage}`);
      this.errorLogger.record(
        new Error(decrireEchecRelaisSms(errorMessage, to)),
        'sms-gateway',
        { imei: context?.imei, toNumber: to, provider: 'vizyo-texto', motifTechnique: errorMessage },
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
      return { ok: false, outcome: 'failed', submittedStatus: 'failed', error: errorMessage };
    }
  }

  /**
   * Persist an inbound SMS (from Twilio webhook). Provisioning state machine
   * subscribes via TrackerProvisioningService.handleInbound() to advance steps
   * when the device replies "ok 123456".
   */
  /**
   * TRK-036 — de quel BOITIER vient ce SMS entrant ?
   *
   * ── LE DEFAUT, MESURE ────────────────────────────────────────────────────────────────
   *
   * Le 2026-08-19 a 04:39:13, une commande RESTORE part vers GS-014-NY par le repli SMS.
   * A 08:28:58, le boitier repond « Resume engine Succeed » depuis SA carte SIM. Le message
   * est bien recu, bien persiste ici — avec `imei` NULL. Vingt et une heures plus tard, la
   * commande est toujours au statut « envoye ».
   *
   * 🔑 La preuve de remise n'etait pas absente : elle ARRIVAIT, elle etait RANGEE, et
   * personne n'allait la chercher. Le repli SMS n'etait pas aveugle, il etait sourd d'une
   * oreille — l'accuse etait classe a cote d'un message de particulier et d'un demarchage.
   *
   * ── LA REGLE DE RAPPROCHEMENT ────────────────────────────────────────────────────────
   *
   * Le numero emetteur EST le `simPhoneNumber` du boitier. On compare sur les 9 derniers
   * chiffres — meme convention que la machine a etats de provisionnement — parce que le
   * meme numero circule sous plusieurs formes (`+33…`, `0033…`, `0…`) selon l'operateur qui
   * le relaie. Une comparaison stricte echouerait sur une variation d'ecriture.
   *
   * ⚠️ AMBIGUITE = ABSTENTION. Si deux boitiers matchent, on ne rattache rien : un accuse
   * colle au mauvais vehicule serait pire que pas d'accuse du tout — il ferait croire qu'une
   * coupure moteur a ete confirmee sur un vehicule qui n'a rien recu.
   *
   * ⚠️ Un echec de resolution laisse simplement `imei` a NULL, comme avant. Ce chemin ne
   * doit JAMAIS faire echouer l'enregistrement du SMS : perdre le message pour cause de
   * rattachement rate serait remplacer un angle mort par une perte de donnee.
   */
  private async resoudreImeiParSim(fromNumber: string): Promise<string | undefined> {
    const cle = (fromNumber ?? '').replace(/\D/g, '').slice(-9);
    if (cle.length < 9) return undefined;
    try {
      const candidats = await this.prisma.tracker.findMany({
        where: { simPhoneNumber: { endsWith: cle } },
        select: { imei: true },
        take: 2,
      });
      if (candidats.length !== 1) return undefined;
      return candidats[0].imei;
    } catch {
      return undefined;
    }
  }

  async recordInbound(payload: {
    fromNumber: string;
    toNumber: string;
    body: string;
    twilioSid?: string;
    imei?: string;
  }): Promise<{ id: string }> {
    // TRK-036 — RATTACHER L'EXPEDITEUR. Voir `resoudreImeiParSim`.
    const imei = payload.imei ?? (await this.resoudreImeiParSim(payload.fromNumber));

    const log = await this.prisma.smsLog.create({
      data: {
        direction: 'IN',
        fromNumber: payload.fromNumber,
        toNumber: payload.toNumber,
        body: payload.body,
        twilioSid: payload.twilioSid,
        status: 'received',
        imei,
      },
    });
    // Notifie la state machine de provisioning (attente d'ACK) + tout autre listener.
    this.eventEmitter.emit(SMS_INBOUND_EVENT, {
      smsLogId: log.id,
      fromNumber: payload.fromNumber,
      toNumber: payload.toNumber,
      body: payload.body,
      receivedAt: new Date().toISOString(),
    } satisfies SmsInboundEvent);
    return { id: log.id };
  }

  /** Audit log query — returns last N SMS for the admin UI. */
  async listLogs(limit = 100, imei?: string) {
    return this.prisma.smsLog.findMany({
      where: imei ? { imei } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }

  /**
   * V1.13 — Test du flow fallback SMS depuis l'UI admin (SUPER_ADMIN).
   *
   * Bypass les 3 conditions de `TrackerFixModeService.tryFallbackSms`
   * (simPhoneNumber, offline > 5min, SMS enabled) pour permettre a un admin de
   * valider la gateway SMS sans avoir a simuler un tracker offline. Envoie un
   * payload `fix030s***n123456` de test (commande Coban benigne).
   *
   * Le SMS est envoye au `recipientPhone` fourni par l'admin, PAS au
   * `simPhoneNumber` du tracker — c'est un test, on ne veut pas polluer une
   * vraie SIM en prod.
   *
   * Le SmsLog est cree avec un context explicite `source: 'admin-test-fallback'`
   * pour distinguer des vrais fallbacks dans l'audit Logs.
   *
   * Retourne le resultat brut de send() + le payload pour traceabilite UI.
   */
  async testFallbackForTracker(input: {
    trackerId: string;
    recipientPhone: string;
    requestedByUserId: string;
  }): Promise<{
    ok: boolean;
    smsResult: SendSmsResult;
    payload: string;
    trackerImei: string;
  }> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { id: input.trackerId },
      select: { id: true, imei: true },
    });
    if (!tracker) {
      throw new Error(`Tracker ${input.trackerId} introuvable`);
    }
    const safePhone = input.recipientPhone.trim();
    if (!safePhone.startsWith('+') || safePhone.length < 8) {
      throw new Error(
        'Numéro destinataire invalide (format E.164 attendu, ex: +33612345678)',
      );
    }
    const payload = `fix030s***n123456`; // benigne 30s
    const smsResult = await this.send(safePhone, payload, {
      template: 'admin_test_fallback',
      imei: tracker.imei,
      source: 'admin-test-fallback',
      requestedByUserId: input.requestedByUserId,
    });
    return {
      ok: smsResult.ok,
      smsResult,
      payload,
      trackerImei: tracker.imei,
    };
  }
}

/** Masque un numéro pour l'affichage admin : garde l'indicatif + 2 derniers chiffres. */
function maskPhone(phone: string): string {
  const s = phone.replace(/\s+/g, '');
  return s.length <= 6 ? s : `${s.slice(0, 4)}••••${s.slice(-2)}`;
}

/** Caviarde les longues séquences de chiffres (mots de passe boîtier) et tronque. */
function redactSmsBody(body: string): string {
  return body.replace(/\d{5,}/g, '••••').slice(0, 80);
}

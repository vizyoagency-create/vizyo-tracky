import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService, smsOutcomeFromStatus, type SmsOutcome } from './sms-gateway.service';

export interface HeartbeatResult {
  provider: 'vizyo-texto' | 'twilio' | 'noop';
  recipients: number;
  /**
   * Nombre de messages ACCEPTÉS par la passerelle.
   *
   * ⚠️ **`sent` ne veut pas dire « arrivé »** (TRK-026). Le nom est conservé pour ne pas
   * casser l'écran d'administration, mais la seule chose qu'il mesure est une soumission
   * réussie. La question « la chaîne fonctionne-t-elle ? » se lit dans `verifyHeartbeat()`.
   */
  sent: number;
  /** Refus explicites à la soumission (HTTP non-2xx, statut d'échec, exception). */
  failed: number;
  /** true = aucun destinataire configure (SMS_HEARTBEAT_RECIPIENTS vide) => no-op safe. */
  skipped: boolean;
  /** Identifiants `sms_logs` des messages émis — ce que la vérification différée relira. */
  smsLogIds: string[];
  results: { to: string; ok: boolean; outcome: SmsOutcome; error?: string }[];
}

/** Verdict de la vérification différée. */
export interface HeartbeatVerdict {
  /**
   * - `OK`            : au moins un message a atteint un statut terminal de succès.
   * - `ECHEC`         : au moins un refus explicite.
   * - `INDETERMINE`   : messages acceptés, aucune preuve de remise. **Le cas réel aujourd'hui.**
   * - `NON_EMIS`      : aucun heartbeat trouvé dans la fenêtre — le cron n'a pas tourné.
   * - `SANS_OBJET`    : aucun destinataire configuré.
   */
  verdict: 'OK' | 'ECHEC' | 'INDETERMINE' | 'NON_EMIS' | 'SANS_OBJET';
  checked: number;
  delivered: number;
  failed: number;
  indeterminate: number;
  /** Âge du plus ancien message vérifié, en minutes (null si aucun). */
  oldestAgeMin: number | null;
}

/**
 * V1.15 — "Preuve de vie" SMS (heartbeat hebdomadaire).
 *
 * vizyo-texto repose sur une SIM Android physique (cf. SmsGatewayService). La
 * chaine peut casser silencieusement : tel decharge, app capcom6 crashee, SIM
 * expiree, operateur qui block... Aujourd'hui on ne le decouvre que le jour ou
 * un SMS CRITICAL part dans le vide (un ErrorLog est cree, mais encore faut-il
 * le regarder).
 *
 * Ce cron envoie chaque lundi 09h00 (Europe/Paris) un SMS de test aux numeros
 * admin (SMS_HEARTBEAT_RECIPIENTS).
 *
 * ---
 *
 * 🔴 **TRK-026 (2026-08-17) — cette sonde ne pouvait PAS échouer, et n'a jamais échoué.**
 *
 * La version d'origine concluait sur `res.ok`, c'est-à-dire sur le statut rendu par la
 * passerelle **dans la même seconde** : `queued`. Or les quatre pannes que le commentaire
 * ci-dessus nomme explicitement — téléphone déchargé, application plantée, SIM expirée,
 * opérateur qui bloque — produisent **toutes** le même observable : HTTP 200 + `queued`.
 * Aucune ne pouvait donc déclencher l'ErrorLog promis. Mesuré en production le 17/08 :
 * **zéro ligne `error_logs` de source `sms-heartbeat` depuis la mise en service**, 332
 * sortants figés en `queued`, dernier statut terminal le 25/07.
 *
 * Et le message lui-même annonçait « chaine SMS OK » — une affirmation de santé
 * transportée par la chaîne sous test, dont l'arrivée n'était jamais vérifiée.
 * *Une sonde qui ne peut pas rendre « en panne » ne mesure rien.*
 *
 * **Ce qui change.** L'envoi ne conclut plus. Un second passage, 20 min plus tard, RELIT
 * l'état des messages émis et prononce un verdict à trois branches — dont un
 * `INDETERMINE` explicite, qui est la réponse honnête tant que la passerelle n'expose
 * aucun accusé de remise (correctif nº 1 de TRK-018, dépôt `vizyo-texto`).
 *
 * ⚠️ **Deux crons plutôt qu'un `setTimeout`** : un timer en mémoire ne survit pas à un
 * redéploiement, et cette sonde tourne une fois par semaine — la fenêtre où un restart
 * l'avalerait est énorme. La vérification retrouve ses messages en base par
 * `template = 'gateway_heartbeat'`, donc elle est idempotente et rejouable à la main.
 */
@Injectable()
export class SmsHeartbeatService {
  private readonly logger = new Logger(SmsHeartbeatService.name);

  /** Fenêtre de recherche des heartbeats à vérifier (défaut 3 h). */
  private readonly verifyWindowMs: number;

  constructor(
    private readonly sms: SmsGatewayService,
    private readonly errorLogger: ErrorLogger,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    const h = Number(process.env['SMS_HEARTBEAT_VERIFY_WINDOW_H']);
    this.verifyWindowMs = (Number.isFinite(h) && h > 0 ? h : 3) * 3_600_000;
  }

  /**
   * Lundi 09h00 Europe/Paris.
   *
   * Le `timeZone` explicite rend le cron independant de la TZ du container API
   * (UTC en prod Docker) : pas besoin de recalculer l'heure en UTC ni de forcer
   * TZ au niveau container.
   */
  @Cron('0 0 9 * * 1', { name: 'sms-heartbeat', timeZone: 'Europe/Paris' })
  async runScheduled(): Promise<void> {
    const result = await this.runHeartbeat();
    if (result.skipped) {
      this.logger.warn('SMS heartbeat skip — SMS_HEARTBEAT_RECIPIENTS vide');
      return;
    }
    // ⚠️ On ne conclut RIEN ici, et surtout pas « OK » : à ce stade on sait seulement que la
    // passerelle a pris les messages. Le verdict appartient à `verifyScheduled()`.
    this.logger.log(
      `SMS heartbeat via ${result.provider} — ${result.sent}/${result.recipients} acceptes, ` +
        `${result.failed} refus. Verdict de remise differe (verification a 09h20).`,
    );
  }

  /**
   * Lundi 09h20 Europe/Paris — 20 min après l'envoi.
   *
   * Délai volontairement large : une remise SMS via SIM physique prend de quelques
   * secondes à plusieurs minutes selon l'opérateur (cf. le commentaire de
   * `tracker-provisioning.service.ts:112`, où 12 s s'étaient révélées très insuffisantes).
   */
  @Cron('0 20 9 * * 1', { name: 'sms-heartbeat-verify', timeZone: 'Europe/Paris' })
  async verifyScheduled(): Promise<void> {
    const v = await this.verifyHeartbeat();
    this.logger.log(
      `SMS heartbeat verification — verdict=${v.verdict} ` +
        `(${v.delivered} remis, ${v.failed} echecs, ${v.indeterminate} indetermines sur ${v.checked}).`,
    );
  }

  /** Numeros heartbeat depuis l'env (CSV E.164), trimmes et filtres. */
  recipients(): string[] {
    const raw = this.config.get('SMS_HEARTBEAT_RECIPIENTS', { infer: true }) ?? '';
    return raw
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  }

  /**
   * Coeur de l'ENVOI — partage par le cron ET l'endpoint run-now.
   *
   * Si aucun destinataire n'est configure, no-op safe (`skipped=true`) : pas
   * d'envoi, pas d'ErrorLog. Pratique en dev ou la var est vide.
   *
   * ⚠️ **Ne journalise plus de `CRITICAL` sur un simple `ok: false`.** Un refus à la
   * soumission est une information utile (elle est remontée), mais ce n'est pas la panne
   * que cette sonde existe pour attraper — celle-là ne se voit qu'à la vérification.
   */
  async runHeartbeat(): Promise<HeartbeatResult> {
    const provider = this.sms.currentProvider();
    const recipients = this.recipients();

    if (recipients.length === 0) {
      return {
        provider,
        recipients: 0,
        sent: 0,
        failed: 0,
        skipped: true,
        smsLogIds: [],
        results: [],
      };
    }

    const ts = new Date().toISOString();
    // ⚠️ Le corps ne doit plus AFFIRMER que la chaîne est saine : ce message est la question,
    // pas la réponse. L'ancien texte (« chaine SMS OK ») était lu par un humain comme un
    // constat, alors qu'il n'était qu'un envoi tenté.
    const body = `[Vizyo Tracky] Test de chaine SMS ${ts} via ${provider} — si vous lisez ceci, la remise fonctionne.`;

    const results: HeartbeatResult['results'] = [];
    const smsLogIds: string[] = [];
    let sent = 0;
    let failed = 0;

    for (const to of recipients) {
      const res = await this.sms.send(to, body, {
        template: 'gateway_heartbeat',
        source: 'sms-heartbeat',
      });
      results.push({ to, ok: res.ok, outcome: res.outcome, error: res.error });
      if (res.smsLogId) smsLogIds.push(res.smsLogId);
      if (res.outcome === 'failed') {
        failed++;
        await this.errorLogger.record(
          `SMS heartbeat REFUSE a la soumission vers ${to} — la passerelle a rejete le message.`,
          'sms-heartbeat',
          { provider, toNumber: to, error: res.error, ts, phase: 'submit' },
          'CRITICAL',
        );
      } else {
        sent++;
      }
    }

    return { provider, recipients: recipients.length, sent, failed, skipped: false, smsLogIds, results };
  }

  /**
   * Coeur de la VÉRIFICATION — relit les heartbeats récents et prononce le verdict.
   *
   * Partagé par le cron de 09h20 et l'endpoint admin, donc rejouable à la main sans
   * attendre lundi. Idempotent : il relit la base, il n'envoie rien.
   */
  async verifyHeartbeat(now: Date = new Date()): Promise<HeartbeatVerdict> {
    if (this.recipients().length === 0) {
      return {
        verdict: 'SANS_OBJET',
        checked: 0,
        delivered: 0,
        failed: 0,
        indeterminate: 0,
        oldestAgeMin: null,
      };
    }

    const since = new Date(now.getTime() - this.verifyWindowMs);
    const logs = await this.prisma.smsLog.findMany({
      where: { direction: 'OUT', template: 'gateway_heartbeat', createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, toNumber: true, createdAt: true },
    });

    // 🔑 Cas que RIEN ne couvrait avant : le cron d'envoi lui-même n'a pas tourné (conteneur
    // redémarré au mauvais moment, `@Cron` non enregistré, exception avalée). Un heartbeat
    // absent et un heartbeat non remis se ressemblent quand on ne regarde que les erreurs.
    if (logs.length === 0) {
      await this.errorLogger
        .record(
          'Preuve de vie SMS NON EMISE : aucun heartbeat en base sur la fenetre de verification — ' +
            'le cron d envoi n a pas tourne. La chaine SMS n est pas surveillee.',
          'sms-heartbeat',
          { phase: 'verify', windowHours: this.verifyWindowMs / 3_600_000 },
          'CRITICAL',
        )
        .catch(() => undefined);
      return {
        verdict: 'NON_EMIS',
        checked: 0,
        delivered: 0,
        failed: 0,
        indeterminate: 0,
        oldestAgeMin: null,
      };
    }

    let delivered = 0;
    let failed = 0;
    let indeterminate = 0;
    for (const log of logs) {
      // La réconciliation n'a aucun statut fournisseur à proposer tant que la passerelle
      // n'expose pas d'accusé de remise : elle rend donc l'état courant. On passe quand même
      // par elle pour que le jour où ce statut existe, ce chemin en profite sans modification.
      const rec = await this.sms
        .reconcileOutboundStatus(log.id)
        .catch(() => null);
      const outcome = rec?.outcome ?? smsOutcomeFromStatus(log.status);
      if (outcome === 'delivered') delivered++;
      else if (outcome === 'failed') failed++;
      else indeterminate++;
    }

    const oldestAgeMin = Math.round((now.getTime() - logs[0]!.createdAt.getTime()) / 60_000);
    const verdict: HeartbeatVerdict['verdict'] =
      failed > 0 ? 'ECHEC' : delivered > 0 ? 'OK' : 'INDETERMINE';

    if (verdict === 'ECHEC') {
      await this.errorLogger
        .record(
          `Preuve de vie SMS en ECHEC : ${failed} message(s) refuse(s) sur ${logs.length} — ` +
            'la chaine SMS est cassee (SIM, application ou operateur).',
          'sms-heartbeat',
          { phase: 'verify', checked: logs.length, failed, delivered, indeterminate },
          'CRITICAL',
        )
        .catch(() => undefined);
    } else if (verdict === 'INDETERMINE') {
      // ⚠️ Ni OK ni ÉCHEC, et c'est le POINT de la fiche : on cesse de présenter comme acquis
      // ce qu'on ne peut pas mesurer. Une ligne par semaine, pas du bruit — et elle disparaîtra
      // d'elle-même le jour où un accusé de remise existera.
      await this.errorLogger
        .record(
          `Preuve de vie SMS INDETERMINEE : ${indeterminate} message(s) sur ${logs.length} n ont ` +
            `jamais quitte leur statut de soumission apres ${oldestAgeMin} min. La chaine SMS n est ` +
            'ni prouvee ni infirmee — la passerelle n expose aucun accuse de remise (cf. TRK-018). ' +
            'Ne pas lire l ecran d administration comme une preuve : il est vert par construction.',
          'sms-heartbeat',
          { phase: 'verify', checked: logs.length, indeterminate, delivered, failed, oldestAgeMin },
          'ERROR',
        )
        .catch(() => undefined);
    }

    return { verdict, checked: logs.length, delivered, failed, indeterminate, oldestAgeMin };
  }
}

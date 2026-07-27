import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Alert, AlertRule, User, Vehicle } from '@prisma/client';
import { UserRole } from '@prisma/client';
import type { AlertSeverity as ClientAlertSeverity, AlertType as ClientAlertType } from '@vizyo/tracky-shared';
import { DEFAULT_MIN_SEVERITY, shouldPushAlert } from '@vizyo/tracky-shared';
import { formatFleetTime } from '../common/utils/datetime';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { WebPushService } from './web-push.service';

/**
 * V1.5 (Sprint M) — Dispatch d'une alerte sur les channels actifs.
 *
 * Pour une `Alert` donnee :
 *   1. Trouve les `AlertRule` matching (par fleet, par vehicle, par alertType,
 *      avec catch-all '*'). Voir `mergeChannels()` : le PUSH est un canal de
 *      base toujours actif, les regles ne pilotent que les canaux payants.
 *   2. Pour chaque channel actif (WEB_PUSH / EMAIL / WHATSAPP), envoie au
 *      destinataire (FLEET_ADMIN par defaut, ou User specifique via la regle).
 *   3. Pour les escalades (Sprint M-cron), `dispatchEscalation()` notifie
 *      l'`escalateToUserId` ou `User.escalationContactUserId` du destinataire
 *      original.
 *
 * ── Correctif « le push n'arrive jamais » (constate en prod) ────────────────
 * Trois causes CUMULEES faisaient que 582 alertes en 7 jours ont produit ZERO
 * push, alors que VAPID etait configure et que 14 appareils etaient abonnes.
 * Ce n'etait pas l'infrastructure d'envoi, c'etait l'AIGUILLAGE :
 *
 *   1. La seule `AlertRule` existante listait channels = ["EMAIL","WHATSAPP"].
 *      'WEB_PUSH' en etant absent, aucun push n'etait meme TENTE.
 *      -> corrige dans `mergeChannels()` : WEB_PUSH devient un canal de base.
 *   2. 3 flottes sur 4 n'ont aucune `AlertRule` : le defaut ['IN_APP'] seul ne
 *      declenchait donc aucun envoi externe.
 *      -> corrige dans `mergeChannels()` : le defaut inclut WEB_PUSH.
 *   3. Les SUPER_ADMIN ont `fleetId = NULL`, or `resolveRecipients()` filtrait
 *      les destinataires par « fleetId = alerte.fleetId ». Un SUPER_ADMIN ne
 *      pouvait donc STRUCTURELLEMENT jamais etre destinataire.
 *      -> corrige dans `resolveRecipients()` : les SUPER_ADMIN sont des
 *         destinataires CROSS-FLOTTE, explicitement, et en PUSH uniquement.
 *
 * Le volume est la raison d'etre des `NotificationPreference` : ~580 alertes
 * par semaine (surtout des exces de vitesse) = ~80 notifications par jour pour
 * un SUPER_ADMIN cross-flotte. Sans filtre par preference, l'utilisateur coupe
 * tout au bout de deux heures et ne revient jamais. Defaut = 'critical' seul.
 */

export type AlertChannel = 'IN_APP' | 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP' | 'SMS';

/**
 * Perimetre d'un destinataire, qui decide des canaux autorises :
 *   - 'FLEET'  : destinataire de la flotte de l'alerte (comportement historique).
 *                Tous les canaux, y compris les payants (EMAIL/WHATSAPP/SMS).
 *   - 'GLOBAL' : SUPER_ADMIN cross-flotte, ajoute par le correctif (cause #3).
 *                PUSH UNIQUEMENT — voir `dispatchAlert()` pour le pourquoi.
 */
type RecipientScope = 'FLEET' | 'GLOBAL';

interface DispatchRecipient {
  user: User;
  scope: RecipientScope;
}

/**
 * Preference push effective d'un utilisateur, dans la forme du contrat PARTAGE
 * (severite en MINUSCULES). La conversion depuis l'enum Prisma (MAJUSCULES) se
 * fait dans `toPushPreference()`, a la frontiere — jamais ailleurs.
 */
interface EffectivePushPreference {
  pushEnabled: boolean;
  minSeverity: ClientAlertSeverity;
  mutedTypes: ClientAlertType[];
}

/**
 * Defaut applique quand l'utilisateur n'a JAMAIS ouvert ses reglages (aucune
 * ligne en base). Regle non negociable : l'absence de preference donne un
 * defaut UTILE, jamais le silence — sinon on remplace un bug invisible
 * (« le push ne marche pas ») par un autre bug invisible.
 */
const DEFAULT_PUSH_PREFERENCE: EffectivePushPreference = {
  pushEnabled: true,
  minSeverity: DEFAULT_MIN_SEVERITY,
  mutedTypes: [],
};

/**
 * V1.15 — Anti-flood SMS : au plus 1 SMS d'alerte par (destinataire, type
 * d'alerte) sur cette fenetre. Evite qu'une rafale d'alertes du meme type
 * (ex: 20 OVERSPEED en 2min) ne declenche 20 SMS (spam + cout SIM). Les autres
 * canaux (push/email/whatsapp) ne sont pas throttles.
 */
const SMS_THROTTLE_MS = 5 * 60_000;

interface AlertWithVehicle extends Alert {
  vehicle?: Vehicle | null;
}

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushService,
    private readonly email: EmailService,
    private readonly sms: SmsGatewayService,
    private readonly errorLogger: ErrorLogger,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Dispatch an alert to all matching channels. Called by AlertsService.create
   * via EventEmitter or direct invocation. Errors are swallowed per-channel —
   * one channel failure doesn't abort the others.
   */
  async dispatchAlert(alert: AlertWithVehicle): Promise<{ channels: AlertChannel[] }> {
    const rules = await this.findMatchingRules(alert);
    const channels = this.mergeChannels(rules);

    // Recipients = tous les FLEET_ADMIN actifs de la fleet (par defaut).
    // Si une regle specifie escalateToUserId, on l'inclut aussi. Depuis le
    // correctif, s'y ajoutent les SUPER_ADMIN en perimetre 'GLOBAL' (push seul).
    const pushChannelActive = channels.includes('WEB_PUSH');
    const recipients = await this.resolveRecipients(alert, rules, pushChannelActive);
    if (recipients.length === 0) {
      this.logger.debug(`Alert ${alert.id}: no recipients found`);
      return { channels };
    }

    // UNE seule requete pour TOUTES les preferences des destinataires. Le dispatch
    // tourne sur chaque alerte (~580/semaine) : une requete par destinataire
    // multiplierait les aller-retours DB pour une donnee minuscule et stable.
    const preferences = pushChannelActive
      ? await this.loadPushPreferences(recipients.map((r) => r.user.id))
      : new Map<string, EffectivePushPreference>();

    for (const { user: recipient, scope } of recipients) {
      for (const channel of channels) {
        if (channel === 'IN_APP') continue; // legacy WS deja envoye par AlertsService

        // Un SUPER_ADMIN cross-flotte est destinataire du PUSH et de RIEN d'autre.
        // Les canaux payants (EMAIL/WHATSAPP/SMS) gardent exactement le
        // comportement d'aujourd'hui : ils fonctionnent, ils coutent de l'argent,
        // et un super-admin qui recevrait soudain l'e-mail des 4 flottes serait
        // une regression subie, pas une fonctionnalite demandee.
        if (scope === 'GLOBAL' && channel !== 'WEB_PUSH') continue;

        // Le filtre par preference s'applique au PUSH SEUL. Un utilisateur qui
        // coupe ses notifications ne doit pas cesser de recevoir ses e-mails.
        if (channel === 'WEB_PUSH' && !this.isPushAllowed(recipient, alert, preferences)) continue;

        try {
          await this.sendOnChannel(channel, recipient, alert, /* isEscalation */ false, scope);
        } catch (err) {
          this.logger.warn(
            `Dispatch ${channel} alert ${alert.id} -> ${recipient.email} failed: ${err instanceof Error ? err.message : err}`,
          );
          this.errorLogger.recordBackground(
            err instanceof Error ? err : new Error(String(err)),
            'notifications',
            { channel, alertId: alert.id, fleetId: alert.fleetId, userId: recipient.id },
          );
        }
      }
    }
    return { channels };
  }

  /**
   * Escalation : notifies the original recipient's escalation contact about
   * an unacknowledged CRITICAL alert. Called by ReportsCronService at fixed
   * intervals (Sprint M cron escalade).
   */
  async dispatchEscalation(alert: AlertWithVehicle): Promise<void> {
    // Escalade par defaut : tous les FLEET_ADMIN escalent vers leur escalationContactUserId.
    const fleetAdmins = await this.prisma.user.findMany({
      where: { fleetId: alert.fleetId, role: UserRole.FLEET_ADMIN, isActive: true },
    });
    const escalationTargets = new Map<string, User>();
    for (const admin of fleetAdmins) {
      if (!admin.escalationContactUserId) continue;
      // #14/#17 — la cible d'escalade DOIT appartenir a la flotte de l'alerte.
      // Sans ce filtre fleetId, un escalationContactUserId devenu obsolete (contact
      // reassigne a une AUTRE flotte) recevait le contenu de l'alerte (plaque,
      // position...) par email/SMS/WhatsApp -> fuite cross-tenant.
      const target = await this.prisma.user.findFirst({
        where: { id: admin.escalationContactUserId, fleetId: alert.fleetId, isActive: true },
      });
      if (target) {
        escalationTargets.set(target.id, target);
      }
    }

    // Dispatch sur les channels actifs pour cette alert (memes regles que la
    // notification initiale, en supposant que l'escalade utilise les memes
    // canaux). Si pas de cible, on ne fait rien.
    if (escalationTargets.size === 0) return;

    const rules = await this.findMatchingRules(alert);
    const channels = this.mergeChannels(rules);
    // Meme porte que le dispatch initial : sans ca, l'escalade serait un trou
    // dans le rollout et dans les preferences (on pousserait a des roles non
    // eligibles, ou a un utilisateur qui a coupe ses notifications).
    const preferences = channels.includes('WEB_PUSH')
      ? await this.loadPushPreferences([...escalationTargets.keys()])
      : new Map<string, EffectivePushPreference>();

    for (const target of escalationTargets.values()) {
      for (const channel of channels) {
        if (channel === 'IN_APP') continue;
        if (channel === 'WEB_PUSH' && !this.isPushAllowed(target, alert, preferences)) continue;
        try {
          await this.sendOnChannel(channel, target, alert, /* isEscalation */ true);
        } catch (err) {
          this.logger.warn(
            `Escalation ${channel} alert ${alert.id} -> ${target.email} failed: ${err instanceof Error ? err.message : err}`,
          );
          this.errorLogger.recordBackground(
            err instanceof Error ? err : new Error(String(err)),
            'notifications',
            { channel, alertId: alert.id, fleetId: alert.fleetId, userId: target.id, escalation: true },
          );
        }
      }
    }
  }

  private async findMatchingRules(alert: AlertWithVehicle): Promise<AlertRule[]> {
    return this.prisma.alertRule.findMany({
      where: {
        fleetId: alert.fleetId,
        enabled: true,
        OR: [
          { vehicleId: alert.vehicleId ?? null },
          { vehicleId: null },
        ],
        AND: [
          { OR: [{ alertType: alert.type as string }, { alertType: '*' }] },
        ],
      },
    });
  }

  /**
   * Causes #1 et #2 du correctif — le PUSH est un canal de BASE, pas un canal
   * pilote par les regles.
   *
   * Avant : sans regle, on renvoyait ['IN_APP'] seul (3 flottes sur 4 sont dans
   * ce cas = aucun envoi externe) ; et avec la seule regle existante, qui liste
   * ["EMAIL","WHATSAPP"], 'WEB_PUSH' etait absent = aucun push meme tente.
   *
   * DECISION ASSUMEE : WEB_PUSH est toujours actif, les `AlertRule` ne pilotent
   * plus que les canaux payants. Justification :
   *   - le push est gratuit (pas de cout SIM ni de credit e-mail) ;
   *   - il est deja opt-in DEUX fois cote utilisateur : il faut avoir autorise
   *     les notifications navigateur ET avoir un appareil abonne ;
   *   - il est filtre par les `NotificationPreference` (defaut = 'critical').
   * L'alternative — exiger que chaque flotte edite une regle pour recevoir un
   * push — est exactement le piege dans lequel on est tombe : l'utilisateur
   * croit la fonctionnalite active, elle n'est cablee nulle part, et le silence
   * ne se voit pas. Le reglage qui coupe le push est desormais la preference
   * utilisateur, un endroit ou l'on pense a aller chercher.
   *
   * NE PAS ajouter EMAIL/WHATSAPP/SMS au defaut : ils coutent de l'argent et 3
   * flottes n'ont aucune regle — on declencherait des envois non voulus a des
   * clients.
   */
  private mergeChannels(rules: AlertRule[]): AlertChannel[] {
    const set = new Set<AlertChannel>(['IN_APP', 'WEB_PUSH']);
    for (const rule of rules) {
      const list = (rule.channels as unknown as AlertChannel[]) ?? [];
      for (const c of list) set.add(c);
    }
    return Array.from(set);
  }

  /**
   * Cause #3 du correctif — le SUPER_ADMIN etait structurellement exclu.
   *
   * Le filtre tenant final « fleetId = alert.fleetId » est correct pour tous
   * les roles de flotte, mais les SUPER_ADMIN ont `fleetId = NULL` : aucun
   * d'eux ne pouvait donc JAMAIS matcher, quelle que soit la configuration.
   *
   * On ne desserre PAS ce filtre : on ajoute une seconde liste, explicite et
   * separee, des SUPER_ADMIN — les seuls destinataires cross-flotte, et
   * uniquement pour le PUSH (cf. `dispatchAlert`). Le filtre tenant strict
   * reste inchange pour tous les autres roles : un FLEET_ADMIN ne recoit que
   * sa flotte, aucune fuite inter-flotte n'est ouverte ici.
   *
   * `includeGlobalAdmins` evite la requete quand le push n'est pas actif — un
   * SUPER_ADMIN n'etant destinataire d'aucun autre canal, la chercher serait
   * inutile.
   */
  private async resolveRecipients(
    alert: AlertWithVehicle,
    rules: AlertRule[],
    includeGlobalAdmins: boolean,
  ): Promise<DispatchRecipient[]> {
    const userIds = new Set<string>();

    // Si une regle a escalateToUserId defini, on l'inclut deja dans les destinataires
    // initiaux (pas reellement utilise pour escalation ici — utile pour cibler
    // un user precis).
    for (const rule of rules) {
      if (rule.escalateToUserId) userIds.add(rule.escalateToUserId);
    }

    // Par defaut : tous les FLEET_ADMIN de la fleet.
    const fleetAdmins = await this.prisma.user.findMany({
      where: { fleetId: alert.fleetId, role: UserRole.FLEET_ADMIN, isActive: true },
    });
    for (const admin of fleetAdmins) userIds.add(admin.id);

    // V1.6 — Surveillance Max : pour les alertes SURVEILLANCE_TRIGGERED, on
    // ajoute les destinataires supplementaires definis sur le profil
    // (typiquement des FLEET_MANAGER opt-in autorises a recevoir les alertes
    // de vol pour ce vehicule precis).
    if (alert.type === 'SURVEILLANCE_TRIGGERED' && alert.vehicleId) {
      const profile = await this.prisma.surveillanceProfile.findUnique({
        where: { vehicleId: alert.vehicleId },
        select: { additionalNotifyUserIds: true },
      });
      if (profile) {
        for (const id of profile.additionalNotifyUserIds) userIds.add(id);
      }
    }

    // Filtre tenant strict : on ne retient que les users de la flotte de l'alerte.
    // Empeche un escalateToUserId ou additionalNotifyUserIds mal configure de
    // router une notif vers un user d'une autre flotte (cross-tenant leak).
    const fleetUsers = userIds.size === 0
      ? []
      : await this.prisma.user.findMany({
        where: {
          id: { in: Array.from(userIds) },
          isActive: true,
          fleetId: alert.fleetId,
        },
      });

    const byId = new Map<string, DispatchRecipient>();
    for (const user of fleetUsers) byId.set(user.id, { user, scope: 'FLEET' });

    if (includeGlobalAdmins) {
      const superAdmins = await this.prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN, isActive: true },
      });
      for (const user of superAdmins) {
        // Un SUPER_ADMIN deja present comme membre de la flotte garde son
        // perimetre 'FLEET' (tous canaux) : on ne lui RETIRE pas des envois
        // qu'il recoit deja aujourd'hui.
        if (byId.has(user.id)) continue;
        byId.set(user.id, { user, scope: 'GLOBAL' });
      }
    }

    return Array.from(byId.values());
  }

  /**
   * Charge les preferences push de tous les destinataires en UNE requete.
   *
   * En cas d'echec (table absente sur un environnement ou la migration n'est
   * pas passee, par exemple), on retombe sur les defauts plutot que d'abandonner
   * le dispatch : une panne de lecture des preferences ne doit pas emporter avec
   * elle les e-mails et les SMS, qui eux fonctionnent.
   */
  private async loadPushPreferences(userIds: string[]): Promise<Map<string, EffectivePushPreference>> {
    const map = new Map<string, EffectivePushPreference>();
    if (userIds.length === 0) return map;
    try {
      const rows = await this.prisma.notificationPreference.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, pushEnabled: true, minSeverity: true, mutedTypes: true },
      });
      for (const row of rows) {
        map.set(row.userId, {
          pushEnabled: row.pushEnabled,
          // Frontiere Prisma -> contrat partage : MAJUSCULES vers minuscules.
          minSeverity: this.toClientSeverity(row.minSeverity),
          mutedTypes: (row.mutedTypes ?? []) as ClientAlertType[],
        });
      }
    } catch (err) {
      this.logger.warn(
        `[push] preferences illisibles, application des defauts (${DEFAULT_PUSH_PREFERENCE.minSeverity}) : ${err instanceof Error ? err.message : err}`,
      );
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'notifications',
        { stage: 'load-push-preferences' },
      );
    }
    return map;
  }

  /**
   * Rollout du push, lu a chaque envoi pour qu'un changement de variable prenne
   * effet au redemarrage sans dependre d'un cache d'instance.
   *
   * Defaut SUR : toute valeur autre que 'ALL' (variable absente, mal
   * orthographiee, perdue lors d'une migration de `.env`) est traitee comme
   * SUPER_ADMIN_ONLY. Une erreur de configuration ne doit JAMAIS ajouter des
   * destinataires : le pire cas acceptable est le silence, visible et
   * corrigible, pas l'envoi massif a des clients qui ne s'y attendent pas.
   */
  private pushRollout(): 'SUPER_ADMIN_ONLY' | 'ALL' {
    const raw = this.config.get('PUSH_ROLLOUT', { infer: true }) as string | undefined;
    return raw === 'ALL' ? 'ALL' : 'SUPER_ADMIN_ONLY';
  }

  /**
   * Porte unique du PUSH : rollout, puis preference utilisateur.
   *
   * Chaque refus est JOURNALISE avec sa raison. L'utilisateur va tester en
   * conditions reelles : un silence doit s'expliquer depuis `docker logs`, pas
   * se deviner. Le prefixe '[push]' est commun avec WebPushService pour qu'un
   * seul grep raconte toute la chaine.
   */
  private isPushAllowed(
    user: User,
    alert: AlertWithVehicle,
    preferences: Map<string, EffectivePushPreference>,
  ): boolean {
    const who = `user=${user.id.slice(0, 8)} (${user.email})`;

    if (this.pushRollout() !== 'ALL' && user.role !== UserRole.SUPER_ADMIN) {
      this.logger.log(
        `[push] skip alert=${alert.id} ${who} — raison=rollout (PUSH_ROLLOUT=SUPER_ADMIN_ONLY, role=${user.role})`,
      );
      return false;
    }

    // Pas de ligne en base = defaut UTILE, jamais le silence.
    const pref = preferences.get(user.id) ?? DEFAULT_PUSH_PREFERENCE;
    const severity = this.toClientSeverity(alert.severity as string);
    const type = alert.type as unknown as ClientAlertType;

    if (shouldPushAlert(pref, { type, severity })) return true;

    // On distingue les trois refus possibles : « rien recu » n'a pas la meme
    // correction selon qu'on ait tout coupe, coupe ce type, ou fixe un seuil.
    const reason = !pref.pushEnabled
      ? 'preference (push desactive)'
      : pref.mutedTypes.includes(type)
        ? `preference (type ${type} coupe)`
        : `severite (${severity} < seuil ${pref.minSeverity})`;
    this.logger.log(`[push] skip alert=${alert.id} ${who} — raison=${reason}`);
    return false;
  }

  /**
   * Enum Prisma (INFO|WARNING|CRITICAL) -> contrat partage (minuscules).
   *
   * ⚠️ Les deux formes coexistent volontairement dans le produit ; la
   * conversion se fait ICI, a la frontiere, et nulle part ailleurs.
   * Une valeur inconnue (severite ajoutee a l'enum sans repasser par ce
   * dispatch) est traitee comme 'critical' : mieux vaut une notification de
   * trop, visible et corrigible, qu'une alerte grave avalee en silence.
   */
  private toClientSeverity(severity: string): ClientAlertSeverity {
    const lowered = String(severity).toLowerCase();
    return lowered === 'info' || lowered === 'warning' || lowered === 'critical'
      ? lowered
      : 'critical';
  }

  private async sendOnChannel(
    channel: AlertChannel,
    user: User,
    alert: AlertWithVehicle,
    isEscalation = false,
    scope: RecipientScope = 'FLEET',
  ): Promise<void> {
    const prefix = isEscalation ? '[ESCALADE] ' : '';
    const plate = alert.vehicle?.plate ?? alert.vehicleId ?? '';
    const subject = `${prefix}[Tracky] ${alert.title}${plate ? ` — ${plate}` : ''}`;
    const bodyText = `${prefix}${alert.title}\n${alert.message ?? ''}\n\nVehicule : ${plate || 'N/A'}\nSeverite : ${alert.severity}\n\nVoir l'alerte : (acceder a Tracky pour acquitter)`;

    if (channel === 'WEB_PUSH') {
      // expectedFleetId = alert.fleetId : defense en profondeur, refuse l'envoi
      // si l'user n'appartient pas a la flotte de l'alerte.
      //
      // EXCEPTION assumee pour le perimetre 'GLOBAL' : un SUPER_ADMIN a
      // `fleetId = NULL`, ce garde-fou le rejetterait donc systematiquement
      // (« [push] cross-tenant block ») et la cause #3 resterait entiere. On
      // passe `null` = pas de verification de flotte. Ce n'est pas un
      // relachement du controle : le perimetre 'GLOBAL' n'est attribue qu'aux
      // SUPER_ADMIN, dans `resolveRecipients()`, et eux SEULS sont
      // cross-flotte par definition de leur role.
      const expectedFleetId = scope === 'GLOBAL' ? null : alert.fleetId;
      await this.webPush.sendToUser(user.id, {
        title: subject,
        body: alert.message ?? alert.title,
        url: '/alerts',
        data: {
          alertId: alert.id,
          escalation: isEscalation,
          severity: alert.severity,
          vehiclePlate: plate,
        },
        // Severite -> SW : pattern vibration + requireInteraction si CRITICAL.
        severity: alert.severity as 'INFO' | 'WARNING' | 'CRITICAL',
        // Tag = alertId : si l'alerte est re-pushee (escalade), la nouvelle notif
        // remplace l'ancienne dans le centre de notifications du browser/OS.
        tag: alert.id,
      }, expectedFleetId);
      return;
    }
    if (channel === 'EMAIL') {
      // Charte 2026 : HTML délégué à EmailService.buildAlertEmail (shell commun).
      // subject/bodyText inchangés (tests + escalade en dépendent).
      const html = this.email.buildAlertEmail(
        {
          title: alert.title,
          message: alert.message ?? null,
          plate,
          severity: alert.severity as string,
          createdAt: alert.createdAt,
        },
        { isEscalation },
      );
      await this.email.send({ to: user.email, subject, html, text: bodyText, template: 'alert', fleetId: alert.fleetId });
      return;
    }
    if (channel === 'WHATSAPP' && user.phone) {
      // Envoi WhatsApp via Twilio (numero whatsapp:+... requis cote Twilio).
      // Pour V1, on passe par le canal SMS Twilio classique — Twilio supporte
      // WhatsApp via prefix 'whatsapp:'. Si le user n'a pas de phone, skip.
      const target = user.phone.startsWith('whatsapp:') ? user.phone : `whatsapp:${user.phone}`;
      await this.sms.send(target, bodyText, { alertId: alert.id, channel: 'whatsapp', escalation: isEscalation });
      return;
    }
    if (channel === 'SMS' && user.phone) {
      // V1.15 — SMS via vizyo-texto. Contrairement a WhatsApp, pas de prefixe :
      // on envoie au numero E.164 brut. Throttle anti-flood par (user, type).
      // SmsGatewayService gere deja l'audit sms_logs + l'ErrorLog CRITICAL si KO.
      if (await this.isSmsThrottled(user.id, alert.type as string)) {
        this.logger.debug(`SMS throttled for ${user.id} / ${alert.type} (alert ${alert.id})`);
        return;
      }
      await this.sms.send(user.phone, this.formatAlertSms(alert, isEscalation), {
        source: 'alert-notification',
        alertId: alert.id,
        vehicleId: alert.vehicleId ?? undefined,
        userId: user.id,
        alertType: alert.type as string,
        escalation: isEscalation,
      });
      return;
    }
  }

  /**
   * Format court pour SMS (1 segment ~160 char max — au-dela ca fragmente cote
   * gateway = surcout). Ex: "[Vizyo Tracky] CRITICAL — Exces de vitesse · TE002ST · 14h23".
   */
  private formatAlertSms(alert: AlertWithVehicle, isEscalation: boolean): string {
    const plate = alert.vehicle?.plate ?? alert.vehicleId ?? '?';
    // Ce canal était DÉJÀ correct (fuseau explicite) ; on passe par le helper
    // pour que l'e-mail et le SMS d'une même alerte partagent une seule source
    // de vérité — c'est leur divergence qui a révélé le bug.
    const time = formatFleetTime(alert.createdAt);
    const esc = isEscalation ? 'ESCALADE ' : '';
    const body = `[Vizyo Tracky] ${esc}${alert.severity} — ${alert.title} · ${plate} · ${time}`;
    return body.length > 160 ? `${body.slice(0, 157)}...` : body;
  }

  /**
   * True si un SMS d'alerte a deja ete tente pour ce (user, alertType) dans la
   * fenetre SMS_THROTTLE_MS. On compte toute tentative (meme failed/noop) :
   * l'objectif est de plafonner le volume SMS, pas de garantir la livraison
   * (les autres canaux restent envoyes a chaque alerte).
   */
  private async isSmsThrottled(userId: string, alertType: string): Promise<boolean> {
    const since = new Date(Date.now() - SMS_THROTTLE_MS);
    const recent = await this.prisma.smsLog.findFirst({
      where: {
        direction: 'OUT',
        createdAt: { gte: since },
        AND: [
          { context: { path: ['source'], equals: 'alert-notification' } },
          { context: { path: ['userId'], equals: userId } },
          { context: { path: ['alertType'], equals: alertType } },
        ],
      },
      select: { id: true },
    });
    return recent !== null;
  }
}

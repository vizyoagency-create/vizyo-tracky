import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Alert, AlertRule, User, Vehicle } from '@prisma/client';
import { UserRole } from '@prisma/client';
import type {
  AlertSeverity as ClientAlertSeverity,
  AlertType as ClientAlertType,
  NotificationCategory,
  SuppressionReason,
} from '@vizyo/tracky-shared';
import {
  resolveReceivesFleetAlerts,
  shouldPushAlert,
  shouldPushNotification,
} from '@vizyo/tracky-shared';
import { formatFleetTime } from '../common/utils/datetime';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { NotificationEligibilityService } from './notification-eligibility.service';
import { defaultPushPreference } from './notification-preferences.service';
import type { DeliveryStatus } from './notification-throttle.service';
import { DELIVERY_STATUS, NotificationThrottleService, PUSH_CHANNEL } from './notification-throttle.service';
import type { SendResult } from './web-push.service';
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
 * tout au bout de deux heures et ne revient jamais.
 *
 * Le defaut applique aux utilisateurs sans ligne n'est PAS decide ici : il vient de
 * `defaultPushPreference()` (cf. `DEFAULT_PUSH_PREFERENCE` plus bas), la meme source que
 * l'ecran de reglages. Ce fichier ne doit jamais en contenir une copie.
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
  /** Categories coupees — necessaire depuis l'ouverture du socle generique. */
  mutedCategories: NotificationCategory[];
}

/**
 * Defaut applique quand l'utilisateur n'a JAMAIS ouvert ses reglages (aucune
 * ligne en base). Regle non negociable : l'absence de preference donne un
 * defaut UTILE, jamais le silence — sinon on remplace un bug invisible
 * (« le push ne marche pas ») par un autre bug invisible.
 *
 * ⚠️⚠️ AUCUNE VALEUR EN DUR ICI — le defaut est LU depuis `defaultPushPreference()`,
 * exactement la fonction qui alimente l'ecran de reglages (`GET /notifications/preferences`,
 * `isDefault=true`) et l'apercu « voici ce que vous recevrez ». Les deux doivent coincider,
 * et une constante recopiee ici a DEJA diverge une fois : l'ecran annoncait un seuil
 * `warning` pendant que le dispatch appliquait `critical`. Consequence concrete, et
 * invisible de tous les tests : le super-admin sans ligne de preference (les 4 comptes de
 * production sont dans ce cas) lisait « à partir de : avertissement », testait une batterie
 * faible — WARNING, 4 par AN, precisement l'alerte qu'on veut voir arriver — et ne recevait
 * rien. C'est le bug d'origine remis a l'endroit inverse : un ecran qui promet une
 * livraison que le serveur refuse.
 *
 * Le POURQUOI des valeurs (330 POWER_CUT/jour, 164 OVERSPEED/jour, le calcul des ~2,3
 * notifications quotidiennes restantes) est documente a la source, dans
 * `notification-preferences.service.ts`. Il ne doit exister qu'a un seul endroit.
 *
 * ⚠️ Ce defaut ne s'applique QU'EN L'ABSENCE de ligne. Un utilisateur qui a une ligne
 * avec `mutedTypes: []` a EXPLICITEMENT tout rallume : lui re-appliquer le defaut
 * par-dessus transformerait son choix en reglage fantome, impossible a comprendre
 * depuis l'ecran (il coche « recevoir POWER_CUT », enregistre, et ne recoit rien).
 *
 * Gele pour que ce singleton de module ne puisse pas etre mute par un appelant : un seul
 * `.push()` egare sur `mutedTypes` couperait un type de plus pour TOUS les utilisateurs
 * sans reglage, jusqu'au prochain redemarrage.
 */
const DEFAULT_PUSH_PREFERENCE: EffectivePushPreference = (() => {
  const base = defaultPushPreference();
  return Object.freeze({ ...base, mutedTypes: Object.freeze([...base.mutedTypes]) as ClientAlertType[] });
})();

/**
 * Issue de la porte push pour UN destinataire, calculee AVANT la boucle d'envoi.
 *
 * Toutes les retenues (rollout, preference, cooldown, plafond) sont decidees et
 * journalisees dans `planPush()`. La boucle d'envoi n'a plus qu'a lire `allowed`.
 */
interface PushDecision {
  allowed: boolean;
  /** Evenements deja replies que cet envoi va solder (0 = envoi simple). */
  groupedCount: number;
}

/** Elements d'une ligne de `notification_deliveries`, tels que le dispatch les connait. */
interface DeliveryRecord {
  alert: AlertWithVehicle;
  userId: string;
  scope: RecipientScope;
  status: DeliveryStatus;
  reason?: string;
  title: string;
  body: string;
  deviceCount?: number;
  sentCount?: number;
  failedCount?: number;
  groupedCount?: number;
}

/**
 * V1.15 — Anti-flood SMS : au plus 1 SMS d'alerte par (destinataire, type
 * d'alerte) sur cette fenetre. Evite qu'une rafale d'alertes du meme type
 * (ex: 20 OVERSPEED en 2min) ne declenche 20 SMS (spam + cout SIM). Les autres
 * canaux (push/email/whatsapp) ne sont pas throttles.
 */
const SMS_THROTTLE_MS = 5 * 60_000;

/** Alerte enrichie de son vehicule — exportee pour que le rejeu puisse la reconstituer. */
export interface AlertWithVehicle extends Alert {
  vehicle?: Vehicle | null;
}

/**
 * Options de `dispatchAlert`. Vide par defaut : le flux normal ne passe rien, et son
 * comportement est donc rigoureusement inchange.
 */
export interface DispatchOptions {
  /**
   * Rejeu manuel d'une alerte deja creee (super-admin), pour renvoyer une notification
   * qu'un destinataire aurait du recevoir. Restreint au push et contourne le cooldown.
   */
  replay?: boolean;
}

// ⚠️ RIEN ENTRE CE DECORATEUR ET SA CLASSE. Le lien decorateur -> cible est perdu a la
// compilation : une declaration glissee entre les deux ne provoque aucune erreur, elle
// deplace silencieusement le decorateur. Un @Interval a deja ete detache de cette facon
// dans ce depot, et la tache planifiee a cesse de tourner en production sans un bruit.
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
    private readonly throttle: NotificationThrottleService,
    private readonly eligibility: NotificationEligibilityService,
  ) {}

  /**
   * Dispatch an alert to all matching channels. Called by AlertsService.create
   * via EventEmitter or direct invocation. Errors are swallowed per-channel —
   * one channel failure doesn't abort the others.
   */
  async dispatchAlert(
    alert: AlertWithVehicle,
    opts: DispatchOptions = {},
  ): Promise<{ channels: AlertChannel[] }> {
    const rules = await this.findMatchingRules(alert);
    // ⚠️ REJEU — deux restrictions volontaires, chacune pour une raison differente.
    //
    // 1. WEB_PUSH SEUL. Un rejeu ne doit jamais rejouer un SMS ni un WhatsApp : ces
    //    canaux COUTENT de l'argent et partent chez un client. Renvoyer une notification
    //    manquee ne justifie pas de refacturer un SMS deja envoye (ou jamais envoye).
    // 2. COOLDOWN CONTOURNE. Sans cela un rejeu demande dans le quart d'heure suivant un
    //    envoi serait replie en silence : l'operateur verrait « c'est parti », le client
    //    ne recevrait rien, et on aurait fabrique le bug qu'on repare.
    //
    // Tout le reste — permissions, perimetre vehicule, preferences, plafond horaire,
    // journalisation — est INCHANGE : le rejeu emprunte la meme porte que le flux normal.
    // Un chemin d'envoi parallele serait exactement ce que le garde-fou « une seule
    // porte » interdit, et le premier endroit ou les regles divergeraient en silence.
    const channels = opts.replay ? (['WEB_PUSH'] as AlertChannel[]) : this.mergeChannels(rules);

    // Recipients = tous les FLEET_ADMIN actifs de la fleet (par defaut).
    // Si une regle specifie escalateToUserId, on l'inclut aussi. Depuis le
    // correctif, s'y ajoutent les SUPER_ADMIN en perimetre 'GLOBAL' (push seul).
    const pushChannelActive = channels.includes('WEB_PUSH');
    const resolved = await this.resolveRecipients(alert, rules, pushChannelActive);

    // ══ A-T-IL LE DROIT DE SAVOIR ? ═══════════════════════════════════════════════
    //
    // Place ICI, avant toute boucle de canal, et non dans la porte push : le droit ne
    // depend pas du canal. Un compte sans `alerts_view` ne doit recevoir ni push, ni
    // e-mail, ni SMS, ni WhatsApp — l'audit du 2026-08-02 a montre que la MEME alerte
    // etait filtree en HTTP (403) et servie sans controle par tous les autres chemins.
    //
    // Ce filtre s'applique donc aussi aux destinataires designes par un TIERS
    // (`escalateToUserId` d'une regle, destinataires additionnels de surveillance) :
    // c'etait la seule facon de contourner meme le refus explicite de l'interesse.
    const recipients = await this.filterByPermission(alert, resolved);
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

    // Porte push calculee EN AMONT de la boucle d'envoi : le controle anti-spam a besoin
    // de connaitre TOUS les destinataires retenus d'un coup pour ne payer qu'une seule
    // lecture groupee. Une evaluation a l'interieur de la boucle serait une requete par
    // destinataire, sur chacune des ~500 alertes quotidiennes.
    const pushPlan = pushChannelActive
      ? await this.planPush(alert, recipients, preferences, {
          isEscalation: false,
          bypassCooldown: opts.replay === true,
        })
      : new Map<string, PushDecision>();

    for (const { user: recipient, scope } of recipients) {
      for (const channel of channels) {
        if (channel === 'IN_APP') continue; // legacy WS deja envoye par AlertsService

        // Un SUPER_ADMIN cross-flotte est destinataire du PUSH et de RIEN d'autre.
        // Les canaux payants (EMAIL/WHATSAPP/SMS) gardent exactement le
        // comportement d'aujourd'hui : ils fonctionnent, ils coutent de l'argent,
        // et un super-admin qui recevrait soudain l'e-mail des 4 flottes serait
        // une regression subie, pas une fonctionnalite demandee.
        if (scope === 'GLOBAL' && channel !== 'WEB_PUSH') continue;

        if (channel === 'WEB_PUSH') {
          // Le filtre par preference et les garde-fous anti-spam s'appliquent au PUSH
          // SEUL. Un utilisateur qui coupe ses notifications ne doit pas cesser de
          // recevoir ses e-mails, et un plafond horaire ne doit jamais retenir un SMS.
          const decision = pushPlan.get(recipient.id);
          if (!decision?.allowed) continue; // retenue deja tracee par planPush()
          try {
            await this.sendPush(recipient, alert, scope, decision.groupedCount, false);
          } catch (err) {
            this.logger.warn(
              `Dispatch WEB_PUSH alert ${alert.id} -> ${recipient.email} failed: ${err instanceof Error ? err.message : err}`,
            );
            this.errorLogger.recordBackground(
              err instanceof Error ? err : new Error(String(err)),
              'notifications',
              { channel, alertId: alert.id, fleetId: alert.fleetId, userId: recipient.id },
            );
          }
          continue;
        }

        try {
          await this.sendOnChannel(channel, recipient, alert, /* isEscalation */ false);
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
    // ⚠️ LE ROLE N'EST PLUS LE CRITERE — il ne l'est plus depuis que « qui est prevenu »
    // est un REGLAGE (`receivesFleetAlerts`).
    //
    // Cette requete filtrait `role: FLEET_ADMIN` en dur : un FLEET_MANAGER qui choisissait
    // un contact d'escalade obtenait le toast « Contact d'escalade enregistre », la valeur
    // partait bien en base... et AUCUNE escalade ne serait jamais partie pour lui. Le champ
    // etait ecrit, stocke, affiche — et relu par personne d'autre que les FLEET_ADMIN.
    //
    // On part donc des memes personnes que le dispatch ordinaire : celles qui recoivent les
    // alertes de la flotte. Escalader depuis quelqu'un qui ne recoit pas l'alerte n'aurait
    // aucun sens — il n'a rien a ne pas acquitter.
    const fleetMembers = await this.prisma.user.findMany({
      where: { fleetId: alert.fleetId, isActive: true },
      include: { notificationPreference: { select: { receivesFleetAlerts: true } } },
    });
    const escalating = fleetMembers.filter(
      (m) =>
        m.escalationContactUserId &&
        resolveReceivesFleetAlerts(m.notificationPreference?.receivesFleetAlerts, m.role),
    );

    const escalationTargets = new Map<string, User>();
    if (escalating.length > 0) {
      // #14/#17 — la cible d'escalade DOIT appartenir a la flotte de l'alerte.
      // Sans ce filtre fleetId, un escalationContactUserId devenu obsolete (contact
      // reassigne a une AUTRE flotte) recevait le contenu de l'alerte (plaque,
      // position...) par email/SMS/WhatsApp -> fuite cross-tenant.
      //
      // UNE seule requete pour toutes les cibles : la version precedente en faisait une
      // PAR administrateur, sur un chemin appele chaque minute par le cron d'escalade.
      const contactIds = [...new Set(escalating.map((m) => m.escalationContactUserId!))];
      const targets = await this.prisma.user.findMany({
        where: { id: { in: contactIds }, fleetId: alert.fleetId, isActive: true },
      });
      for (const target of targets) escalationTargets.set(target.id, target);
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
    const pushChannelActive = channels.includes('WEB_PUSH');
    const preferences = pushChannelActive
      ? await this.loadPushPreferences([...escalationTargets.keys()])
      : new Map<string, EffectivePushPreference>();
    // Meme porte anti-spam que le dispatch initial, a une exception pres : l'escalade
    // ignore le COOLDOWN (cf. `ThrottleTarget.bypassCooldown`). Elle ne se declenche
    // qu'une fois par alerte et seulement si personne n'a acquitte une CRITICAL — la
    // replier dans un « ×N » silencieux supprimerait le seul signal qui existe parce que
    // le premier a ete ignore. Le plafond horaire, lui, reste arme.
    const pushPlan = pushChannelActive
      ? await this.planPush(
        alert,
        [...escalationTargets.values()].map((user) => ({ user, scope: 'FLEET' as RecipientScope })),
        preferences,
        { isEscalation: true },
      )
      : new Map<string, PushDecision>();

    for (const target of escalationTargets.values()) {
      for (const channel of channels) {
        if (channel === 'IN_APP') continue;
        if (channel === 'WEB_PUSH') {
          const decision = pushPlan.get(target.id);
          if (!decision?.allowed) continue; // retenue deja tracee par planPush()
          try {
            await this.sendPush(target, alert, 'FLEET', decision.groupedCount, true);
          } catch (err) {
            this.logger.warn(
              `Escalation WEB_PUSH alert ${alert.id} -> ${target.email} failed: ${err instanceof Error ? err.message : err}`,
            );
            this.errorLogger.recordBackground(
              err instanceof Error ? err : new Error(String(err)),
              'notifications',
              { channel, alertId: alert.id, fleetId: alert.fleetId, userId: target.id, escalation: true },
            );
          }
          continue;
        }
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

    // ── Destinataires de la flotte — desormais REGLABLES ────────────────────────────
    // Avant : la liste etait CODEE EN DUR a « tous les FLEET_ADMIN ». Constat prod
    // 2026-07-28 : la flotte cdef31 comptait 6 utilisateurs actifs et 1 seul
    // destinataire — un responsable d'astreinte ou un veilleur de nuit ne pouvait pas
    // etre prevenu, et personne (pas meme son administrateur) ne pouvait y remedier.
    //
    // On lit maintenant `NotificationPreference.receivesFleetAlerts`. Il est NULLABLE :
    // `null` = « selon mon role », et le defaut par role reproduit EXACTEMENT l'ancien
    // comportement (FLEET_ADMIN oui, les autres non). Tant que personne ne touche a son
    // reglage, les memes personnes recoivent les memes alertes — on rend configurable
    // sans rien deplacer sous les pieds.
    //
    // UNE seule requete : on charge les actifs de la flotte avec leur preference, puis
    // on filtre en memoire. Le dispatch tourne sur chaque alerte, on ne multiplie pas
    // les allers-retours.
    const fleetMembers = await this.prisma.user.findMany({
      where: { fleetId: alert.fleetId, isActive: true },
      include: { notificationPreference: { select: { receivesFleetAlerts: true } } },
    });
    for (const member of fleetMembers) {
      if (resolveReceivesFleetAlerts(member.notificationPreference?.receivesFleetAlerts, member.role)) {
        userIds.add(member.id);
      }
    }

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
        include: { notificationPreference: { select: { receivesFleetAlerts: true } } },
      });
      for (const user of superAdmins) {
        // Un SUPER_ADMIN deja present comme membre de la flotte garde son
        // perimetre 'FLEET' (tous canaux) : on ne lui RETIRE pas des envois
        // qu'il recoit deja aujourd'hui.
        if (byId.has(user.id)) continue;
        // ⚠️ ASYMETRIE VOULUE avec le defaut par ROLE ci-dessus.
        // Cote FLOTTE, `defaultReceivesFleetAlerts('SUPER_ADMIN')` vaut FAUX : un
        // super-admin n'est pas un destinataire ordinaire de flotte. Mais en portee
        // GLOBALE il est, par construction, l'observateur transverse — et c'est le
        // comportement deja en production depuis l'ouverture du push.
        // Appliquer le defaut par role ICI le priverait de tout push du jour au
        // lendemain, cassant precisement ce qu'on vient de livrer.
        //
        // On respecte donc uniquement un choix EXPLICITE de se retirer. Sans ce test,
        // l'interrupteur « Recevoir les alertes de la flotte » n'aurait AUCUN effet
        // pour un super-admin : un reglage visible qui ne fait rien est pire que pas
        // de reglage du tout.
        if (user.notificationPreference?.receivesFleetAlerts === false) continue;
        byId.set(user.id, { user, scope: 'GLOBAL' });
      }
    }

    return Array.from(byId.values());
  }

  /**
   * Ecarte les destinataires qui n'ont pas le droit d'etre notifies de cette alerte.
   *
   * ⚠️ CHAQUE refus est JOURNALISE. C'est le point qui distingue ce filtre d'un simple
   * `if` : sans ligne, on remplacerait une fuite (recevoir sans droit) par un silence
   * inexplicable (ne plus rien recevoir sans savoir pourquoi) — et le centre de
   * notifications existe precisement pour qu'aucun non-envoi ne soit muet.
   *
   * Le motif distingue `no_permission` (il manque `alerts_view`) de `out_of_scope`
   * (le droit est la, mais pas sur ce vehicule) : les deux se corrigent a des endroits
   * differents, les confondre rendrait le diagnostic impossible.
   */
  private async filterByPermission(
    alert: AlertWithVehicle,
    recipients: DispatchRecipient[],
  ): Promise<DispatchRecipient[]> {
    if (recipients.length === 0) return recipients;
    const verdicts = await this.eligibility.check(
      recipients.map((r) => r.user.id),
      alert.vehicleId ?? null,
    );
    const kept: DispatchRecipient[] = [];
    for (const r of recipients) {
      const verdict = verdicts.get(r.user.id) ?? 'no_permission';
      if (verdict === 'ok') {
        kept.push(r);
        continue;
      }
      this.logger.log(
        `[push] skip alert=${alert.id} user=${r.user.id.slice(0, 8)} (${r.user.email}) — raison=${verdict}`,
      );
      await this.logDelivery({
        alert,
        userId: r.user.id,
        scope: r.scope,
        status: DELIVERY_STATUS.SUPPRESSED,
        reason: verdict,
        // Meme mise en forme que l'envoi reel : la ligne de journal doit montrer ce que
        // la personne AURAIT recu, pas un resume approximatif.
        title: this.buildPushContent(alert, false, 0).title,
        body: alert.message ?? '',
      });
    }
    return kept;
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
        select: { userId: true, pushEnabled: true, minSeverity: true, mutedTypes: true, mutedCategories: true },
      });
      for (const row of rows) {
        map.set(row.userId, {
          pushEnabled: row.pushEnabled,
          // Frontiere Prisma -> contrat partage : MAJUSCULES vers minuscules.
          minSeverity: this.toClientSeverity(row.minSeverity),
          mutedTypes: (row.mutedTypes ?? []) as ClientAlertType[],
          mutedCategories: (row.mutedCategories ?? []) as NotificationCategory[],
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
   * Renvoie le MOTIF exact du refus (contrat partage `SuppressionReason`), et pas un
   * simple booleen : ce motif part en base dans `notification_deliveries` et devient la
   * reponse a « pourquoi je n'ai rien recu ». Trois refus differents appellent trois
   * corrections differentes (tout coupe / ce type coupe / seuil trop haut) ; les
   * confondre, c'est rendre le diagnostic impossible.
   *
   * Chaque refus est aussi JOURNALISE en clair. Le prefixe '[push]' est commun avec
   * WebPushService pour qu'un seul grep raconte toute la chaine.
   */
  private checkPushPreference(
    user: User,
    alert: AlertWithVehicle,
    preferences: Map<string, EffectivePushPreference>,
  ): { allowed: boolean; reason: SuppressionReason | null } {
    const who = `user=${user.id.slice(0, 8)} (${user.email})`;

    if (this.pushRollout() !== 'ALL' && user.role !== UserRole.SUPER_ADMIN) {
      this.logger.log(
        `[push] skip alert=${alert.id} ${who} — raison=rollout (PUSH_ROLLOUT=SUPER_ADMIN_ONLY, role=${user.role})`,
      );
      return { allowed: false, reason: 'rollout' };
    }

    // Pas de ligne en base = defaut UTILE (POWER_CUT coupe), jamais le silence total.
    // Une ligne existante est prise TELLE QUELLE : ses `mutedTypes` sont un choix
    // explicite, on ne re-empile pas le defaut par-dessus.
    //
    // ⚠️ `reglePersonnelle` DOIT voyager jusqu'au motif enregistre. Ce booleen existait
    // deja ici, mais il ne servait qu'a nuancer une ligne de LOG : le motif ecrit en base
    // disait « coupe dans ses reglages » pour un utilisateur qui n'avait aucun reglage.
    // Le centre de notifications accusait donc le client d'un choix qu'il n'avait pas
    // fait — 28 fois de suite, pour le gerant de MH Cars le 2026-08-03.
    const reglePersonnelle = preferences.has(user.id);
    const pref = preferences.get(user.id) ?? DEFAULT_PUSH_PREFERENCE;
    const severity = this.toClientSeverity(alert.severity as string);
    const type = alert.type as unknown as ClientAlertType;

    if (shouldPushAlert(pref, { type, severity })) return { allowed: true, reason: null };

    // ⚠️ L'ORDRE DOIT SUIVRE CELUI DE `shouldPushAlert`, SINON LE MOTIF MENT.
    //
    // `shouldPushAlert` refuse dans cet ordre : interrupteur maitre, puis FAMILLE, puis
    // type, puis severite. Ce ternaire ignorait la famille : couper « Alertes vehicule »
    // produisait le motif « sous le seuil de severite ». L'utilisateur lisait donc, au
    // centre de notifications ET sur son ecran de reglages, qu'il fallait baisser son
    // seuil — remede sans aucun effet, puisque la famille bloque en amont.
    //
    // Un motif faux est pire qu'un motif absent : il envoie corriger le mauvais reglage.
    //
    // ⚠️ ET LE MOTIF DOIT NOMMER LE BON RESPONSABLE. Les deux seuls refus que le DEFAUT
    // peut produire sont le type coupe et le seuil : `pushEnabled` vaut true par defaut et
    // `mutedCategories` y est vide, donc ces deux-la sont forcement un choix personnel.
    // Un motif qui designe le mauvais responsable envoie corriger la ou il n'y a rien.
    const reason: SuppressionReason = !pref.pushEnabled
      ? 'preference_disabled'
      : (pref.mutedCategories ?? []).includes('ALERT')
        ? 'preference_category_muted'
        : pref.mutedTypes.includes(type)
          ? reglePersonnelle
            ? 'preference_type_muted'
            : 'default_type_muted'
          : reglePersonnelle
            ? 'preference_severity'
            : 'default_severity';
    const origine = reglePersonnelle ? 'preference' : 'defaut systeme';
    const detail =
      reason === 'preference_severity' || reason === 'default_severity'
        ? `severite (${severity} < seuil ${pref.minSeverity}, ${origine})`
        : reason === 'preference_type_muted' || reason === 'default_type_muted'
          ? `type ${type} coupe (${origine})`
          : reason === 'preference_category_muted'
            ? 'preference (famille « Alertes vehicule » coupee)'
            : 'preference (push desactive)';
    this.logger.log(`[push] skip alert=${alert.id} ${who} — raison=${detail}`);
    return { allowed: false, reason };
  }

  /**
   * Decide, POUR TOUS LES DESTINATAIRES A LA FOIS, qui recoit le push — et trace chaque
   * retenue dans `notification_deliveries`.
   *
   * Deux etapes, dans cet ordre :
   *   1. rollout + preferences (deja en memoire, aucun cout) : ecarte le gros du volume,
   *      notamment les 494 alertes quotidiennes POWER_CUT/OVERSPEED coupees par defaut ;
   *   2. garde-fous de debit, en UNE lecture groupee pour les survivants seulement.
   *
   * L'ordre n'est pas cosmetique : evaluer le debit avant les preferences ferait payer la
   * requete de throttle sur chaque alerte, y compris les 94 % qui ne devaient jamais
   * partir.
   */
  private async planPush(
    alert: AlertWithVehicle,
    recipients: DispatchRecipient[],
    preferences: Map<string, EffectivePushPreference>,
    opts: { isEscalation: boolean; bypassCooldown?: boolean },
  ): Promise<Map<string, PushDecision>> {
    const plan = new Map<string, PushDecision>();
    const eligible: DispatchRecipient[] = [];
    const content = this.buildPushContent(alert, opts.isEscalation, 0);

    for (const { user, scope } of recipients) {
      const gate = this.checkPushPreference(user, alert, preferences);
      if (gate.allowed) {
        eligible.push({ user, scope });
        continue;
      }
      plan.set(user.id, { allowed: false, groupedCount: 0 });

      // ⚠️ VOLUME — le refus 'rollout' n'est volontairement PAS journalise en base.
      // C'est un etat de configuration GLOBAL et statique (« le push n'est pas encore
      // ouvert a ce role »), identique pour tout le monde et derivable de PUSH_ROLLOUT :
      // l'ecrire produirait ~500 alertes/jour x tous les utilisateurs de flotte, soit des
      // dizaines de milliers de lignes strictement identiques par mois, qui noieraient
      // les retenues reellement informatives. Le centre de notifications doit afficher
      // cet etat comme un bandeau, pas comme 10 000 lignes.
      if (gate.reason && gate.reason !== 'rollout') {
        await this.logDelivery({
          alert,
          userId: user.id,
          scope,
          status: DELIVERY_STATUS.SUPPRESSED,
          reason: gate.reason,
          title: content.title,
          body: content.body,
        });
      }
    }

    if (eligible.length === 0) return plan;

    const decisions = await this.throttle.evaluate(eligible.map((r) => r.user.id), {
      // Catégorie ALERT : les alertes véhicule sont une nature de notification parmi
      // d'autres depuis l'ouverture du socle générique. Le sous-type reste le type
      // d'alerte, et le sujet le véhicule — le comportement est donc INCHANGÉ.
      category: 'ALERT',
      kind: alert.type as string,
      subjectKey: alert.vehicleId ?? null,
      // Une escalade contourne le cooldown par nature (c'est son role) ; un rejeu le
      // contourne sur demande explicite. Le PLAFOND horaire, lui, n'est jamais contourne :
      // c'est le dernier rempart, et un rejeu manuel n'est pas une urgence.
      bypassCooldown: opts.isEscalation || opts.bypassCooldown === true,
    });

    for (const { user, scope } of eligible) {
      // Destinataire absent de la reponse (cas theorique) : on notifie. En cas de doute,
      // une notification de trop se voit et se corrige ; une alerte perdue, non.
      const decision = decisions.get(user.id);
      if (!decision || decision.allowed) {
        plan.set(user.id, { allowed: true, groupedCount: decision?.groupedCount ?? 0 });
        continue;
      }
      plan.set(user.id, { allowed: false, groupedCount: decision.groupedCount });

      // Un evenement retenu par le COOLDOWN n'est pas jete : il est compte. `groupedCount`
      // porte ici son RANG dans le repli en cours (1 = premier retenu depuis le dernier
      // envoi) ; le prochain push parti soldera le tout avec « ×N ».
      const grouped = decision.reason === 'cooldown';
      await this.logDelivery({
        alert,
        userId: user.id,
        scope,
        status: grouped ? DELIVERY_STATUS.GROUPED : DELIVERY_STATUS.SUPPRESSED,
        reason: decision.reason ?? undefined,
        title: content.title,
        body: content.body,
        groupedCount: grouped ? decision.groupedCount + 1 : 0,
      });
    }

    return plan;
  }

  /**
   * Envoi PUSH + journalisation de son issue reelle.
   *
   * Le comptage n'est pas re-invente : `WebPushService.sendToUser` renvoie deja
   * `{ sent, failed, results[] }` apres avoir purge les abonnements morts (410 Gone).
   * On se sert de CE resultat — un second comptage local aurait diverge au premier
   * changement de la boucle d'envoi.
   */

  // ══════════════════════════════════════════════════════════════════════════════════
  // SOCLE GENERIQUE — notifier autre chose qu'une alerte
  //
  // Constat qui a motive ce point d'entree (2026-07-28) : le rappel d'entretien
  // envoyait deja du push EN DEHORS de tout ce systeme, via `webPush.sendToUser()` en
  // direct. Consequences : destinataires recodes en dur, preferences ignorees (donc
  // impossible a couper), anti-spam contourne, et absent du centre de notifications.
  //
  // Un second chemin existait donc deja. En ajouter d'autres (validation d'un lieu,
  // rapport hebdomadaire...) de la meme facon aurait produit autant de comportements
  // divergents que de fonctionnalites. `notifyUsers` est LE passage oblige : memes
  // preferences, meme anti-spam, meme journal, meme centre.
  //
  // Le chemin ALERTE garde son code specialise (contenu, escalade, portee GLOBAL) et
  // n'est pas touche : il partage les garde-fous, pas la mise en forme.
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Envoie une notification NON-ALERTE a une liste d'utilisateurs, en passant par les
   * memes garde-fous que les alertes.
   *
   * @returns le nombre de push reellement partis (0 n'est pas une erreur : ce peut etre
   *          une retenue volontaire, tracee dans le journal avec sa raison).
   */
  async notifyUsers(input: {
    userIds: string[];
    category: Exclude<NotificationCategory, 'ALERT'>;
    /** Sous-type fin dans la categorie (cloisonne le cooldown). */
    kind?: string | null;
    /** Sujet concerne : plan d'entretien, rapport... Cloisonne le cooldown. */
    subjectKey?: string | null;
    title: string;
    body: string;
    /** Ou emmener l'utilisateur au clic. */
    url?: string;
    /** Flotte concernee, pour le journal et le controle anti cross-tenant. */
    fleetId?: string | null;
  }): Promise<number> {
    const requested = [...new Set(input.userIds)];
    if (requested.length === 0) return 0;

    // 0. PERIMETRE DE DEPLOIEMENT (`PUSH_ROLLOUT`), avant tout le reste.
    //
    //    Le chemin ALERTE applique cette porte depuis l'origine ; l'ancien envoi direct
    //    du rappel d'entretien, lui, ne l'appliquait PAS. Un rappel serait donc parti
    //    vers des roles auxquels le push n'est pas encore ouvert — exactement ce que ce
    //    reglage existe pour empecher pendant une mise en service progressive.
    //
    //    Le refus n'est volontairement PAS journalise, comme pour les alertes : il est
    //    identique pour tout le monde, derivable de la configuration, et l'ecrire
    //    remplirait le journal d'un motif qui n'apprend rien.
    const roles = await this.prisma.user.findMany({
      where: { id: { in: requested } },
      select: { id: true, role: true },
    });
    const rollout = this.pushRollout();
    const userIds = roles
      .filter((u) => rollout === 'ALL' || u.role === UserRole.SUPER_ADMIN)
      .map((u) => u.id);
    if (userIds.length === 0) {
      this.logger.log(
        `[push] skip ${input.category} — raison=rollout (PUSH_ROLLOUT=${rollout}, ${requested.length} destinataire(s))`,
      );
      return 0;
    }

    const preferences = await this.loadPushPreferences(userIds);
    const category = input.category;

    // 1. Preferences. Une categorie coupee l'emporte : couper « Entretien » doit tout
    //    taire sans avoir a enumerer quoi que ce soit.
    const allowed: string[] = [];
    for (const userId of userIds) {
      const pref = preferences.get(userId) ?? DEFAULT_PUSH_PREFERENCE;
      if (shouldPushNotification(pref, { category })) {
        allowed.push(userId);
        continue;
      }
      await this.logGenericDelivery(input, userId, DELIVERY_STATUS.SUPPRESSED, {
        reason: pref.pushEnabled ? 'preference_category_muted' : 'preference_disabled',
      });
    }
    if (allowed.length === 0) return 0;

    // 2. Anti-spam, en UNE lecture groupee — comme pour les alertes.
    const decisions = await this.throttle.evaluate(allowed, {
      category,
      kind: input.kind ?? null,
      subjectKey: input.subjectKey ?? null,
    });

    let sent = 0;
    for (const userId of allowed) {
      const decision = decisions.get(userId);
      if (decision && !decision.allowed) {
        await this.logGenericDelivery(input, userId, DELIVERY_STATUS.GROUPED, {
          reason: decision.reason ?? undefined,
          groupedCount: decision.groupedCount,
        });
        continue;
      }

      try {
        const result = await this.webPush.sendToUser(
          userId,
          { title: input.title, body: input.body, url: input.url, data: { category, subjectKey: input.subjectKey ?? null } },
          input.fleetId ?? null,
        );
        if (result.sent > 0) sent++;
        await this.logGenericDelivery(
          input,
          userId,
          result.sent > 0 ? DELIVERY_STATUS.SENT : DELIVERY_STATUS.FAILED,
          {
            reason: result.sent === 0 && result.failed === 0 ? 'no_device' : undefined,
            deviceCount: result.sent + result.failed,
            sentCount: result.sent,
            failedCount: result.failed,
            groupedCount: decision?.groupedCount ?? 0,
          },
        );
      } catch (err) {
        // Trace AVANT de continuer : sans ligne, l'utilisateur ne verrait qu'une absence
        // de notification, indiscernable d'une retenue volontaire.
        await this.logGenericDelivery(input, userId, DELIVERY_STATUS.FAILED, {
          errorDetail: `erreur d'envoi : ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`,
        });
      }
    }
    return sent;
  }

  /** Ecrit une ligne de journal pour une notification non-alerte. Best-effort. */
  private async logGenericDelivery(
    input: { category: string; kind?: string | null; subjectKey?: string | null; title: string; body: string; fleetId?: string | null },
    userId: string,
    status: DeliveryStatus,
    // DEUX champs distincts pour UNE colonne, à dessein.
    //
    // `reason` est typé sur le CATALOGUE partagé, jamais sur `string` : un slug inventé
    // s'écrirait sans erreur puis s'afficherait « Motif non renseigné » au centre — un
    // non-envoi inexplicable, exactement ce que cet écran existe pour supprimer. C'est
    // arrivé : `preference_category_muted` était écrit sans exister dans le catalogue.
    //
    // `errorDetail` porte le cas qui n'est PAS un motif de retenue : l'échec technique
    // d'envoi. Le centre le rend tel quel (`labelForReason` renvoie l'inconnu verbatim),
    // ce qui est voulu — le message du serveur de push en dit plus long qu'un libellé
    // générique. Les séparer garde la garantie sur l'un sans interdire l'autre.
    extra: {
      reason?: SuppressionReason;
      errorDetail?: string;
      deviceCount?: number;
      sentCount?: number;
      failedCount?: number;
      groupedCount?: number;
    } = {},
  ): Promise<void> {
    try {
      await this.prisma.notificationDelivery.create({
        data: {
          alertId: null,
          category: input.category,
          // Denormalise dans la meme colonne que le type d'alerte : c'est le meme role
          // (sous-type fin), et le centre n'a ainsi qu'une colonne a lire.
          alertType: input.kind ?? null,
          severity: null,
          subjectKey: input.subjectKey ?? null,
          userId,
          fleetId: input.fleetId ?? null,
          channel: PUSH_CHANNEL,
          status,
          reason: extra.reason ?? extra.errorDetail ?? null,
          title: input.title,
          body: input.body,
          deviceCount: extra.deviceCount ?? 0,
          sentCount: extra.sentCount ?? 0,
          failedCount: extra.failedCount ?? 0,
          groupedCount: extra.groupedCount ?? 0,
        },
      });
    } catch (err) {
      // Le journal ne doit JAMAIS empecher une notification de partir.
      this.logger.warn(`[push] journal indisponible : ${err instanceof Error ? err.message : err}`);
    }
  }

  private async sendPush(
    user: User,
    alert: AlertWithVehicle,
    scope: RecipientScope,
    groupedCount: number,
    isEscalation: boolean,
  ): Promise<void> {
    const { title, body } = this.buildPushContent(alert, isEscalation, groupedCount);
    const plate = alert.vehicle?.plate ?? alert.vehicleId ?? '';
    // expectedFleetId = alert.fleetId : defense en profondeur, refuse l'envoi si l'user
    // n'appartient pas a la flotte de l'alerte.
    //
    // EXCEPTION assumee pour le perimetre 'GLOBAL' : un SUPER_ADMIN a `fleetId = NULL`,
    // ce garde-fou le rejetterait donc systematiquement (« [push] cross-tenant block ») et
    // la cause #3 resterait entiere. On passe `null` = pas de verification de flotte. Ce
    // n'est pas un relachement du controle : le perimetre 'GLOBAL' n'est attribue qu'aux
    // SUPER_ADMIN, dans `resolveRecipients()`, et eux SEULS sont cross-flotte par
    // definition de leur role.
    const expectedFleetId = scope === 'GLOBAL' ? null : alert.fleetId;

    let result: SendResult;
    try {
      result = await this.webPush.sendToUser(user.id, {
        title,
        body,
        url: '/alerts',
        data: {
          alertId: alert.id,
          escalation: isEscalation,
          severity: alert.severity,
          vehiclePlate: plate,
          // Le client doit pouvoir dire « cette notification en resume N » sans
          // re-interroger l'API.
          groupedCount,
        },
        // Severite -> SW : pattern vibration + requireInteraction si CRITICAL.
        severity: alert.severity as 'INFO' | 'WARNING' | 'CRITICAL',
        // Tag = alertId : si l'alerte est re-pushee (escalade), la nouvelle notif
        // remplace l'ancienne dans le centre de notifications du browser/OS.
        tag: alert.id,
      }, expectedFleetId);
    } catch (err) {
      // L'echec est trace en base AVANT d'etre relance : l'appelant se contente de le
      // remonter au centre d'erreur, et sans cette ligne l'utilisateur ne verrait
      // qu'une absence de notification, indiscernable d'une retenue volontaire.
      await this.logDelivery({
        alert,
        userId: user.id,
        scope,
        status: DELIVERY_STATUS.FAILED,
        reason: `erreur d'envoi : ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`,
        title,
        body,
        groupedCount,
      });
      throw err;
    }

    // `results` est vide quand aucun abonnement n'a ete cible (aucun appareil, VAPID non
    // configure, ou blocage cross-tenant). On prend `sent + failed` en repli pour ne pas
    // dependre d'un tableau qu'un futur appelant pourrait ne pas remplir.
    const deviceCount = result.results.length || result.sent + result.failed;

    if (result.sent > 0) {
      await this.logDelivery({
        alert,
        userId: user.id,
        scope,
        status: DELIVERY_STATUS.SENT,
        title,
        body,
        deviceCount,
        sentCount: result.sent,
        failedCount: result.failed,
        groupedCount,
      });
      return;
    }

    if (deviceCount > 0) {
      const firstError = result.results.find((r) => r.error);
      await this.logDelivery({
        alert,
        userId: user.id,
        scope,
        status: DELIVERY_STATUS.FAILED,
        reason: firstError
          ? `${firstError.statusCode ?? '?'} ${firstError.endpointHost} — ${firstError.error?.slice(0, 120)}`
          : 'aucun appareil n’a accepte l’envoi',
        title,
        body,
        deviceCount,
        sentCount: 0,
        failedCount: result.failed,
        groupedCount,
      });
      return;
    }

    // Aucun appareil cible : ce n'est PAS un echec, c'est une absence d'abonnement — et
    // c'est la premiere chose a verifier quand quelqu'un dit « je ne recois rien ». La
    // ranger dans FAILED noierait les vraies pannes d'envoi dans du bruit previsible.
    await this.logDelivery({
      alert,
      userId: user.id,
      scope,
      status: DELIVERY_STATUS.SUPPRESSED,
      reason: 'no_device' satisfies SuppressionReason,
      title,
      body,
      groupedCount,
    });
  }

  /**
   * Contenu reellement pousse — et donc contenu journalise : l'ecran d'administration doit
   * montrer ce que l'utilisateur a vu, pas une reconstitution approximative.
   *
   * `groupedCount` > 0 = cet envoi solde des evenements retenus pendant le cooldown. Le
   * total affiche vaut donc `groupedCount + 1` (les replies + celui-ci) : le libelle « ×N »
   * doit dire combien d'evenements la notification represente, sinon le regroupement
   * devient une perte d'information silencieuse — ce qu'on cherche justement a eviter.
   */
  private buildPushContent(
    alert: AlertWithVehicle,
    isEscalation: boolean,
    groupedCount: number,
  ): { title: string; body: string } {
    const prefix = isEscalation ? '[ESCALADE] ' : '';
    const plate = alert.vehicle?.plate ?? alert.vehicleId ?? '';
    const total = groupedCount + 1;
    const title = `${prefix}[Tracky] ${alert.title}${plate ? ` — ${plate}` : ''}${groupedCount > 0 ? ` ×${total}` : ''}`;
    const base = alert.message ?? alert.title;
    const body = groupedCount > 0
      ? `${base}\n${total} evenements depuis la derniere notification.`
      : base;
    return { title, body };
  }

  /**
   * Ecrit UNE ligne de `notification_deliveries` — envoyee comme non envoyee.
   *
   * ⚠️ Regle non negociable de ce lot : une notification retenue doit etre aussi visible
   * qu'une notification partie. Le bug d'origine (582 alertes, zero push) a survecu trois
   * mois parce que le silence ne laissait aucune trace ; remplacer ce silence par un
   * silence anti-spam serait pire, puisqu'il serait volontaire.
   *
   * L'ecriture est best-effort : une erreur de journalisation ne doit jamais empecher un
   * envoi ni faire echouer un dispatch. Consequence assumee cote garde-fous : si la
   * journalisation tombe, le cooldown et le plafond ne voient plus rien et laissent tout
   * passer — on retombe sur le comportement d'avant ce lot, pas sur un blocage.
   */
  private async logDelivery(record: DeliveryRecord): Promise<void> {
    try {
      await this.prisma.notificationDelivery.create({
        data: {
          alertId: record.alert.id,
          category: 'ALERT',
          // Sujet = véhicule : c'est ce qui donne au cooldown sa 3ᵉ dimension sans
          // devoir relire la table des alertes.
          subjectKey: record.alert.vehicleId ?? null,
          // Denormalises : le centre reste lisible meme apres purge de l'alerte (les
          // alertes ont une retention plus courte que leur journal d'envoi).
          alertType: record.alert.type as string,
          severity: record.alert.severity as string,
          userId: record.userId,
          // `null` pour un envoi cross-flotte a un SUPER_ADMIN, conformement au schema :
          // la ligne n'appartient a aucune flotte en particulier.
          fleetId: record.scope === 'GLOBAL' ? null : record.alert.fleetId,
          channel: PUSH_CHANNEL,
          status: record.status,
          reason: record.reason ?? null,
          title: record.title,
          body: record.body,
          deviceCount: record.deviceCount ?? 0,
          sentCount: record.sentCount ?? 0,
          failedCount: record.failedCount ?? 0,
          groupedCount: record.groupedCount ?? 0,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[push] journalisation impossible (alert=${record.alert.id} user=${record.userId.slice(0, 8)} status=${record.status}) : ${err instanceof Error ? err.message : err}`,
      );
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'notifications',
        { stage: 'notification-delivery-log', alertId: record.alert.id, userId: record.userId },
      );
    }
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

  /**
   * Canaux PAYANTS uniquement (EMAIL / WHATSAPP / SMS).
   *
   * ⚠️ Le PUSH ne passe plus par ici : il a sa propre voie (`sendPush`), parce qu'il est
   * le seul canal a porter le regroupement « ×N » et la journalisation par destinataire.
   * Deux chemins d'envoi push auraient diverge au premier changement — et c'est exactement
   * ce genre d'ecart qui a produit 582 alertes sans le moindre push. Le comportement des
   * canaux payants, lui, est INCHANGE : ils coutent de l'argent, ils marchent, on n'y
   * touche pas (aucun garde-fou anti-spam ne leur est applique ici).
   */
  private async sendOnChannel(
    channel: AlertChannel,
    user: User,
    alert: AlertWithVehicle,
    isEscalation = false,
  ): Promise<void> {
    const prefix = isEscalation ? '[ESCALADE] ' : '';
    const plate = alert.vehicle?.plate ?? alert.vehicleId ?? '';
    // Refonte e-mails (2026-08) : plus de crochets de MARQUE en tete de sujet —
    // motif spam classique, et 16 caracteres manges sur l'apercu mobile. Le nom
    // d'expediteur (RESEND_FROM = « Vizyo Tracky ») porte deja la marque.
    // `[ESCALADE]` reste : ce n'est pas de la marque, c'est une information.
    const subject = `${prefix}${alert.title}${plate ? ` — ${plate}` : ''}`;
    const bodyText = `${prefix}${alert.title}\n${alert.message ?? ''}\n\nVehicule : ${plate || 'N/A'}\nSeverite : ${alert.severity}\n\nVoir l'alerte : (acceder a Tracky pour acquitter)`;

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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailStatus } from '@prisma/client';
import { Resend } from 'resend';
import { partLibelle } from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { formatFleetDateTime, formatFleetDateTimeLong } from '../common/utils/datetime';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Identifiant de modèle e-mail (journalisé dans EmailLog.template). */
export type EmailTemplateId =
  /**
   * A6 — un tour de negociation d'une demande de mission. Un seul identifiant pour
   * les deux sens (depot vers transporteur et l'inverse) : c'est le meme objet, et
   * le journal des envois doit pouvoir les compter ensemble.
   */
  | 'mission_request'
  | 'invitation'
  | 'password_reset'
  | 'device_verification'
  | 'two_factor_disable'
  | 'weekly_report'
  | 'alert'
  | 'error_rate_alert'
  | 'lead'
  | 'lead_welcome'
  | 'quote_signed'
  | 'quote_client'
  | 'audio_activation'
  | 'audio_info'
  | 'installation_slot_requested'
  | 'installation_slot_confirmed'
  | 'reservation_requested'
  | 'reservation_confirmed'
  | 'ai_invoice_request'
  | 'partner_consent_invitation'
  // Espace dépôt (2026-08) — une mission vient d'être assignée à un compte dépôt.
  | 'mission_assigned'
  /**
   * A6 — la TOURNÉE d'une mission a changé après affectation. Identifiant distinct
   * de `mission_assigned` : ce n'est pas la même nouvelle, et le journal des envois
   * doit pouvoir répondre à « combien de tournées ont bougé ce mois-ci ? ».
   */
  | 'mission_tournee_modifiee'
  // Lot A3 — un dépôt signale un incident : le seul e-mail de l'espace dépôt qui
  // remonte vers le transporteur, et non l'inverse.
  | 'depot_incident';

/**
 * V1.5 (Sprint J) — Service d'envoi d'emails via Resend.
 *
 * Mode "no-op" : si RESEND_API_KEY est vide, le service log les envois mais
 * ne fait pas d'appel reseau. Permet de developper / tester en local sans
 * compte Resend (ex: copier-coller le lien d'invitation depuis les logs).
 *
 * Templates HTML inlines : pas de dependance externe (react-email, mjml, etc.)
 * — design coherent avec le visuel Tracky (mint/green sur fond fonce). A
 * extraire dans des fichiers separes si on multiplie les templates.
 */

/**
 * ─── La charte des e-mails (refonte 2026-08, planche « Emails Refonte ») ────────
 *
 * PILES SYSTEME, JAMAIS UNE POLICE DISTANTE. Le gabarit chargeait Manrope par
 * `<link href="fonts.googleapis.com">`. Gmail, Outlook et Yahoo SUPPRIMENT les
 * feuilles externes : Manrope n'arrivait jamais, la police retombait sur un
 * systeme non controle et la mise en page bougeait. Ces piles sont celles de la
 * planche, et elles rendent la meme chose partout parce qu'elles sont deja la.
 */
const EMAIL_FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const EMAIL_FONT_MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;

/**
 * Le vert de marque — RESERVE au filet, au bouton et au logo.
 *
 * « Le vert saturé en grande surface est un marqueur d'e-mail promotionnel »
 * (planche § 1.2) : c'est un signal qui pousse vers l'onglet Promotions. Le reste
 * du gabarit est noir sur blanc.
 */
const EMAIL_ACCENT = '#10E0A0';

/**
 * Le vert quand il porte du TEXTE. Meme regle que dans l'application : #10E0A0
 * rend 1,57:1 sur blanc — illisible. C'est le pendant e-mail de `--texte-succes`,
 * en dur parce qu'un e-mail n'a pas de jetons CSS.
 */
const EMAIL_ACCENT_TEXTE = '#0A7A55';

/**
 * Les couleurs SEMANTIQUES quand elles portent du texte — pendants e-mail de la
 * famille `--texte-*` de l'application, memes ratios, memes raisons.
 *
 * Les valeurs vives conviennent a un liseré ou a une pastille, jamais a du texte
 * sur fond clair. Mesure sur blanc : #F5B33D rend 1,74:1, #F5A623 1,91:1 et
 * #F2706B 2,71:1 — les trois etaient employes en couleur de texte.
 */
const EMAIL_TEXTE_ALERTE = '#A9413D';   // 5,98:1 sur blanc
const EMAIL_TEXTE_ATTENTE = '#885B05';  // 5,92:1 sur blanc
/** Texte secondaire. #6B7570 tombait a 4,4977 — SOUS le seuil, et invisible a l'arrondi. */
const EMAIL_TEXTE_SECOND = '#656F68';   // 5,21:1 sur blanc

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Modèle e-mail — journalisé dans EmailLog (centre e-mails admin). */
  template?: EmailTemplateId;
  /** Flotte concernée si connue (sinon lue depuis context.fleetId). */
  fleetId?: string | null;
  context?: Record<string, unknown>;
  /**
   * Pièces jointes (rapport hebdomadaire PDF). Le courrier hebdo annonçait « en pièce
   * jointe » depuis 2026-01 sans que rien ne soit joint : le paramètre n'existait pas.
   */
  attachments?: { filename: string; content: Buffer }[];
}

/**
 * ══ LES TRAJETS QUE RIEN NE RATTACHE À PERSONNE, DANS LE COURRIER DU LUNDI (F13) ═══════
 *
 * Le PDF joint le dit depuis ce lot ; le CORPS du message, lui, résumait trajets, kilomètres,
 * alertes et consommation sans jamais dire que ces nombres pouvaient n'appartenir à personne.
 * Or c'est le corps qui se lit sur un téléphone, à 8 h, sans ouvrir la pièce jointe — et chez
 * mh cars (mesuré le 2026-09-05) 1 866 trajets sur 1 886 sont dans ce cas : 99 % du courrier
 * portait sur des kilomètres qu'aucun conducteur ne revendique.
 *
 * ⚠️ UNE SEULE ÉCRITURE POUR LES DEUX PARTIES MIME DU MÊME MESSAGE. Le corps HTML est
 * fabriqué ici, le corps texte dans `ReportScheduleService` : deux phrases rédigées chacune
 * de son côté auraient fini par dire deux choses du même chiffre, et le client sous Outlook
 * n'aurait pas lu la même semaine que le client en texte brut. La phrase se calcule donc une
 * fois, ici, et les deux corps la reçoivent telle quelle.
 *
 * ⚠️ MUETTE QUAND IL N'Y A RIEN À SIGNALER, et c'est la moitié du travail : ce courrier part
 * AUTOMATIQUEMENT chaque lundi à TOUTES les sociétés, sociétés d'essai comprises. Une société
 * qui a renseigné ses conducteurs, une société sans un seul trajet, une société dont le
 * producteur de statistiques ne fabrique pas le champ (il est optionnel au contrat) ne
 * reçoivent AUCUNE ligne — pas une ligne à zéro, qui se lirait comme un reproche sans objet.
 *
 * Les mots sont ceux de l'écran, du PDF et du classeur — « … sur … (99 %, 11 460 km) … ni
 * conducteur, ni groupe » —, la part venant de la règle d'arrondi du contrat partagé.
 *
 * @param unattributed le bloc `unattributedTrips` du rapport, absent chez certains producteurs.
 * @param totalTrips le total RÉEL de la semaine (`trips.count`), jamais la somme des lignes
 *   classées : « 1 866 sur 22 » serait un mensonge parfaitement crédible.
 */
export function buildUnattributedNote(
  unattributed: { tripCount: number; distanceKm: number } | null | undefined,
  totalTrips: number,
): string | null {
  const n = unattributed?.tripCount ?? 0;
  if (n <= 0 || totalTrips <= 0) return null;
  return `${n} trajet${n > 1 ? 's' : ''} sur ${totalTrips} de la semaine `
    + `(${partLibelle(n, totalTrips)}, ${unattributed!.distanceKm.toFixed(1)} km) `
    + `n’${n > 1 ? 'ont' : 'a'} ni conducteur, ni groupe : `
    + `${n > 1 ? 'ils ne peuvent être attribués' : 'il ne peut être attribué'} à personne. `
    + 'Renseignez un conducteur ou un groupe sur ces véhicules, depuis la page Véhicules, '
    + 'pour que leurs kilomètres comptent pour quelqu’un.';
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: Resend | null;
  private readonly fromAddress: string;
  private readonly enabled: boolean;
  /** URL absolue du logo PNG (charte 2026) — cf. EMAIL_LOGO_URL. */
  private readonly logoUrl: string;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    this.fromAddress = this.config.get('RESEND_FROM', { infer: true });
    this.logoUrl = this.config.get('EMAIL_LOGO_URL', { infer: true });
    this.enabled = !!apiKey;
    this.client = this.enabled ? new Resend(apiKey) : null;
    if (this.enabled) {
      this.logger.log(`Email service active (from ${this.fromAddress})`);
    } else {
      this.logger.warn('Email service disabled (RESEND_API_KEY missing) — running in no-op mode');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async send(params: SendEmailParams): Promise<{ ok: boolean; id?: string; error?: string }> {
    if (!this.enabled || !this.client) {
      this.logger.debug(
        { to: params.to, subject: params.subject, ctx: params.context },
        `[noop] Email to ${params.to}: ${params.subject}`,
      );
      // Journal EmailLog même en no-op (dev/test) : l'admin voit les envois simulés.
      await this.persistLog(params, { status: EmailStatus.SENT });
      return { ok: true };
    }
    try {
      const result = await this.client.emails.send({
        from: this.fromAddress,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        attachments: params.attachments?.length
          ? params.attachments.map((a) => ({ filename: a.filename, content: a.content }))
          : undefined,
      });
      if (result.error) {
        this.logger.warn(`Email send failed to ${params.to}: ${result.error.message}`);
        this.errorLogger.recordBackground(result.error.message, 'email', { template: params.template, to: params.to });
        this.recordActivity(params, false, result.error.message);
        await this.persistLog(params, { status: EmailStatus.FAILED, errorMessage: result.error.message });
        return { ok: false, error: result.error.message };
      }
      this.recordActivity(params, true);
      await this.persistLog(params, { status: EmailStatus.QUEUED, providerId: result.data?.id ?? null });
      return { ok: true, id: result.data?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Email send threw to ${params.to}: ${message}`);
      this.errorLogger.recordBackground(err instanceof Error ? err : new Error(message), 'email', { template: params.template, to: params.to });
      this.recordActivity(params, false, message);
      await this.persistLog(params, { status: EmailStatus.FAILED, errorMessage: message });
      return { ok: false, error: message };
    }
  }

  /**
   * Centre e-mails (admin) — journalise l'envoi dans EmailLog. BEST-EFFORT : un
   * échec d'écriture ne DOIT JAMAIS faire échouer un envoi (try/catch + warn).
   * QUEUED = accepté par Resend (providerId présent, statut affiné ensuite par le
   * webhook) ; SENT = mode no-op ; FAILED = erreur d'envoi immédiate.
   */
  private async persistLog(
    params: SendEmailParams,
    opts: { status: EmailStatus; providerId?: string | null; errorMessage?: string },
  ): Promise<void> {
    try {
      const ctxFleet =
        typeof params.context?.['fleetId'] === 'string' ? (params.context['fleetId'] as string) : null;
      await this.prisma.emailLog.create({
        data: {
          providerId: opts.providerId ?? null,
          template: params.template ?? 'unknown',
          toAddress: params.to,
          subject: params.subject,
          status: opts.status,
          fleetId: params.fleetId ?? ctxFleet,
          errorMessage: opts.errorMessage ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`EmailLog persist failed: ${String(e)}`);
    }
  }

  /**
   * Palier B — trace l'e-mail envoyé dans le journal des actions système (arrière-plan).
   * Le mode no-op (dev, sans RESEND_API_KEY) n'est PAS journalisé (aucun envoi réel). Couvre
   * invitations, reset MDP, rapports hebdo, alertes/escalades — toutes passent par `send()`.
   */
  private recordActivity(params: SendEmailParams, ok: boolean, error?: string): void {
    const fleetId = typeof params.context?.['fleetId'] === 'string' ? (params.context['fleetId'] as string) : null;
    // Attribution : même clé de contexte que le SMS (`requestedByUserId`). Un reset MDP
    // déclenché par un admin ou une invitation apparaît alors « déclenché par X » au
    // lieu d'un « system » anonyme ; les envois cron restent 'system'.
    const requestedBy =
      typeof params.context?.['requestedByUserId'] === 'string'
        ? (params.context['requestedByUserId'] as string)
        : null;
    this.systemActivity.record({
      category: 'EMAIL',
      action: 'email_sent',
      status: ok ? 'SUCCESS' : 'FAILURE',
      actor: 'system',
      target: params.to,
      detail: params.subject,
      fleetId,
      triggeredByUserId: requestedBy,
      meta: error ? { error } : undefined,
    });
  }

  /**
   * Gabarit e-mail commun (charte 2026). Header logo + eyebrow, carte sombre,
   * footer mono. `body` = HTML interne DÉJÀ échappé (rangées `<tr><td>…`). `accent`
   * colore le filet haut + l'eyebrow (emerald par défaut, ambre conformité, rouge
   * alerte). Un seul endroit à maintenir → header/footer/logo cohérents partout.
   *
   * Public : réutilisé par LeadsService (même en-tête/pied que les e-mails du service).
   */
  shell(opts: {
    eyebrow: string;
    body: string;
    footer: string;
    /** Texte d'apercu (90 car.) — COMPLETE le sujet, ne le repete pas. */
    preheader?: string;
    accent?: string;
    borderColor?: string;
  }): string {
    const accent = opts.accent ?? EMAIL_ACCENT;
    const border = opts.borderColor ?? '#E3E8E6';
    // Le preheader ne doit rien laisser passer derriere lui : sans ce bourrage,
    // Gmail complete l'apercu avec le premier texte du corps.
    const apercu = opts.preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;">${opts.preheader}${'&#8199;&#65279;&#847; '.repeat(30)}</div>`
      : '';
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  /* Le sombre n'est plus impose : il n'arrive que si le CLIENT le demande.
     Apple Mail et quelques autres respectent cette requete ; Gmail l'ignore et
     garde le clair — c'est exactement le comportement voulu. */
  @media (prefers-color-scheme: dark) {
    .m-bg { background:#060807 !important; }
    .m-card { background:#101514 !important; border-color:rgba(255,255,255,.08) !important; }
    .m-brand, .m-title, .m-strong { color:#EAEFED !important; }
    .m-text { color:#56635E !important; }
    .m-foot { color:#69736E !important; }
    .m-rule { background:rgba(255,255,255,.07) !important; }
    .m-panel { background:#161D1B !important; border-color:rgba(255,255,255,.07) !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F2F5F3;">
  ${apercu}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="m-bg" style="background:#F2F5F3;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="m-card" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid ${border};border-radius:18px;overflow:hidden;">
        <tr><td style="height:3px;background:${accent};line-height:3px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:30px 36px 0;">
          <table role="presentation" width="100%"><tr>
            <td style="vertical-align:middle;">
              <img src="${this.logoUrl}" width="27" height="27" alt="Vizyo Tracky" style="display:inline-block;vertical-align:middle;border:0;" />
              <span class="m-brand" style="font-family:${EMAIL_FONT};font-size:16px;font-weight:700;letter-spacing:-0.01em;color:#0A1311;vertical-align:middle;margin-left:8px;">Vizyo <span style="color:${EMAIL_ACCENT_TEXTE};">Tracky</span></span>
            </td>
            <td align="right" class="m-text" style="font-family:${EMAIL_FONT_MONO};font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#56635E;">${opts.eyebrow}</td>
          </tr></table>
        </td></tr>
        ${opts.body}
        <tr><td style="padding:24px 36px 30px;">
          <div class="m-rule" style="height:1px;background:#E3E8E6;margin-bottom:16px;"></div>
          <p class="m-foot" style="margin:0;font-family:${EMAIL_FONT_MONO};font-size:10.5px;line-height:1.7;letter-spacing:0.03em;color:${EMAIL_TEXTE_SECOND};">${opts.footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  /**
   * Échappe le texte destiné à un corps HTML.
   *
   * Introduit avec `mission_assigned` (2026-08) parce que ses champs viennent d'une
   * SAISIE LIBRE : `originLabel` et `destLabel` sont tapés par un gestionnaire dans la
   * modale de création. Un libellé contenant `<` ou `&` casserait le rendu de l'e-mail
   * chez le destinataire — et l'e-mail est la seule chose que le dépôt reçoit avant
   * d'ouvrir l'application.
   */
  private escapeHtml(valeur: string): string {
    return valeur
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Espace dépôt (2026-08) — l'invitation, version DÉPÔT. Cf. design/A5-COMPTES.md § 6.
   *
   * Un dépôt n'est pas un collègue. Il ne connaît ni Tracky, ni le mot « flotte », ni
   * la personne qui l'invite. Trois différences en découlent :
   *
   *  1. **Le sujet nomme le TRANSPORTEUR**, pas Tracky : « MH CARS vous ouvre le suivi
   *     de ses livraisons ». C'est de son transporteur qu'il attend un e-mail ; un
   *     objet au nom d'un outil inconnu se lit comme du démarchage.
   *  2. **Le corps dit ce que le compte permet ET ce qu'il ne permet pas.** Un accès
   *     qu'on ouvre sans en donner les bornes inquiète autant qu'il rassure.
   *  3. **La signature est celle du transporteur**, Tracky en pied.
   *
   * Règles héritées de la refonte des e-mails : pas de crochets dans le sujet,
   * preheader renseigné, accents corrects, aucune information portée par une image.
   */
  private buildDepotInvitationEmail(opts: {
    recipientName?: string | null;
    inviterName: string;
    fleetName: string;
    acceptUrl: string;
    expiresAt: Date;
  }): { subject: string; html: string; text: string } {
    const transporteur = this.escapeHtml(opts.fleetName);
    const subject = `${opts.fleetName} vous ouvre le suivi de ses livraisons`;
    const expire = formatFleetDateTime(opts.expiresAt);

    const puce = (texte: string, oui: boolean) => `
      <tr>
        <td class="m-text" style="padding:5px 0;vertical-align:top;width:22px;font-family:${EMAIL_FONT};font-size:14px;color:${oui ? '#10E0A0' : '#6B7570'};">${oui ? '✓' : '·'}</td>
        <td class="m-title m-text" style="padding:5px 0;font-family:${EMAIL_FONT};font-size:13.5px;line-height:1.55;color:${oui ? '#0A1311' : '#56635E'};">${texte}</td>
      </tr>`;

    const html = this.shell({
      eyebrow: 'Accès',
      preheader: 'Ce que ce compte vous permet de voir, et ce qu\'il ne permet pas.',
      footer: `${transporteur} · SUIVI DE LIVRAISON<br>Propulsé par Vizyo Tracky. Ce lien expire le ${expire}.`,
      body: `
        <tr><td style="padding:28px 36px 0;">
          <!-- Preheader : première ligne lue dans la liste des messages. -->
          <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Suivez vos livraisons en direct, sans compte à créer côté logistique.</div>
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">Suivez vos livraisons en direct</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">${transporteur} vous ouvre un accès pour suivre les camions engagés sur vos livraisons. Rien à installer, rien à payer.</p>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${puce('Voir où en est chaque livraison qui vous est destinée', true)}
            ${puce('Suivre le camion en direct, pendant le créneau de la mission', true)}
            ${puce('Partager un lien de suivi temporaire à votre propre client', true)}
            ${puce('Vous ne voyez pas les autres véhicules de ' + transporteur, false)}
            ${puce('Vous ne voyez rien en dehors du créneau de vos missions', false)}
          </table>
        </td></tr>
        <tr><td style="padding:24px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.acceptUrl}" style="display:inline-block;padding:13px 26px;font-family:${EMAIL_FONT};font-size:15px;font-weight:700;color:#04130D;text-decoration:none;">Activer mon accès</a>
          </td></tr></table>
          <p class="m-text" style="margin:14px 0 0;font-family:${EMAIL_FONT};font-size:12.5px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Ou copiez ce lien : <span class="m-text" style="color:#56635E;">${opts.acceptUrl}</span></p>
        </td></tr>`,
    });

    const text = [
      `${opts.fleetName} vous ouvre le suivi de ses livraisons.`,
      '',
      'Ce que ce compte permet :',
      '  - voir où en est chaque livraison qui vous est destinée',
      '  - suivre le camion en direct, pendant le créneau de la mission',
      '  - partager un lien de suivi temporaire à votre propre client',
      '',
      'Ce qu\'il ne permet pas :',
      `  - voir les autres véhicules de ${opts.fleetName}`,
      '  - voir quoi que ce soit en dehors du créneau de vos missions',
      '',
      `Activer mon accès : ${opts.acceptUrl}`,
      `Ce lien expire le ${expire}.`,
    ].join('\n');

    return { subject, html, text };
  }

  /**
   * Espace dépôt (2026-08) — une mission vient d'être assignée à un compte dépôt.
   * Cf. design/A2-MISSIONS.md § 3.3.
   *
   * ⚠️ **LE SUJET PORTE L'INFORMATION.** « Livraison prévue jeudi 08:15 → 11:40 », et
   * non « Nouvelle mission ». Un dépôt reçoit ces e-mails toute la journée : un sujet
   * générique l'oblige à ouvrir pour savoir de quoi il s'agit, et il finit par ne plus
   * les ouvrir du tout.
   *
   * Le nom du TRANSPORTEUR est mis en avant, pas Tracky : c'est de lui que le dépôt
   * attend un e-mail, il ne connaît pas notre marque (A5 § 6, même principe).
   */
  /**
   * A6 — un tour de negociation vient d'arriver chez l'autre partie.
   *
   * ┌─ UN SEUL GABARIT POUR LES DEUX SENS, ET C'EST DELIBERE ───────────────────┐
   * │ Depot vers transporteur, transporteur vers depot : c'est le meme objet —  │
   * │ « quelqu'un vous a repondu, voici son offre ». Deux gabarits auraient      │
   * │ diverge des la premiere retouche, et l'un des deux serait devenu le        │
   * │ parent pauvre de l'autre.                                                 │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * `amountCents` nul = « sur devis » : on ne remplace JAMAIS par zero. Un e-mail
   * annoncant « 0,00 EUR » a un client final est pire qu'un e-mail sans montant.
   */
  buildMissionQuoteEmail(opts: {
    ref: string;
    /** Ce que le destinataire doit comprendre en une ligne. */
    titre: string;
    intro: string;
    origin: string;
    destination: string;
    nbArrets: number;
    startAt: Date;
    endAt: Date;
    amountCents: number | null;
    message: string | null;
    carrierName: string;
    url: string;
    libelleAction: string;
  }): { subject: string; html: string; text: string } {
    const jour = new Date(opts.startAt).toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    const h = (d: Date) =>
      new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const creneau = `${h(opts.startAt)} → ${h(opts.endAt)}`;
    const montant =
      opts.amountCents === null
        ? 'Sur devis'
        : `${(opts.amountCents / 100).toFixed(2).replace('.', ',')} € HT`;

    // Pas de crochets dans le sujet (B1 § I). La reference y figure : c'est elle
    // qu'on cherche dans une boite pleine.
    const subject = `${opts.titre} — ${opts.ref}`;

    const ligne = (libelle: string, valeur: string) => `
      <tr>
        <td style="padding:7px 0;font-family:'Manrope',system-ui,sans-serif;font-size:13px;color:#69736E;width:120px;">${libelle}</td>
        <td style="padding:7px 0;font-family:'Manrope',system-ui,sans-serif;font-size:14px;font-weight:600;color:#EAEFED;">${valeur}</td>
      </tr>`;

    const trajet =
      opts.nbArrets > 2
        ? `${this.escapeHtml(opts.origin)} → ${this.escapeHtml(opts.destination)} (${opts.nbArrets - 1} livraisons)`
        : `${this.escapeHtml(opts.origin)} → ${this.escapeHtml(opts.destination)}`;

    const html = this.shell({
      eyebrow: 'Demande de mission',
      footer: `${this.escapeHtml(opts.carrierName)}<br>Propulsé par Vizyo Tracky. E-mail automatique, ne pas répondre.`,
      body: `
        <tr><td style="padding:28px 36px 0;">
          <h1 style="margin:0 0 10px;font-family:'Manrope',system-ui,sans-serif;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#EAEFED;">${this.escapeHtml(opts.titre)}</h1>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">${this.escapeHtml(opts.intro)}</p>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${ligne('Référence', this.escapeHtml(opts.ref))}
            ${ligne('Trajet', trajet)}
            ${ligne('Créneau', `${jour}, ${creneau}`)}
            ${ligne('Montant', this.escapeHtml(montant))}
          </table>
        </td></tr>
        ${
          opts.message
            ? `<tr><td style="padding:18px 36px 0;">
                 <p style="margin:0;padding:13px 15px;border-radius:11px;background:#12201B;font-family:'Manrope',system-ui,sans-serif;font-size:14px;line-height:1.6;color:#EAEFED;">« ${this.escapeHtml(opts.message)} »</p>
               </td></tr>`
            : ''
        }
        <tr><td style="padding:22px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.url}" style="display:inline-block;padding:13px 26px;font-family:'Manrope',system-ui,sans-serif;font-size:15px;font-weight:700;color:#04130D;text-decoration:none;">${this.escapeHtml(opts.libelleAction)}</a>
          </td></tr></table>
        </td></tr>`,
    });

    const text = [
      opts.titre,
      '',
      opts.intro,
      '',
      `Référence : ${opts.ref}`,
      `Trajet    : ${opts.origin} → ${opts.destination}`,
      `Créneau   : ${jour}, ${creneau}`,
      `Montant   : ${montant}`,
      ...(opts.message ? ['', `« ${opts.message} »`] : []),
      '',
      opts.url,
    ].join('\n');

    return { subject, html, text };
  }

  buildMissionAssignedEmail(opts: {
    ref: string;
    origin: string;
    destination: string;
    startAt: Date;
    endAt: Date;
    plate: string;
    carrierName: string;
    depotUrl: string;
  }): { subject: string; html: string; text: string } {
    const jour = new Date(opts.startAt).toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    const h = (d: Date) =>
      new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const creneau = `${h(opts.startAt)} → ${h(opts.endAt)}`;

    // Pas de crochets dans le sujet (règle héritée de la refonte des e-mails, B1 § I).
    const subject = `Livraison prévue ${jour} ${creneau}`;

    const ligne = (libelle: string, valeur: string) => `
      <tr>
        <td class="m-text" style="padding:7px 0;font-family:${EMAIL_FONT};font-size:13px;color:${EMAIL_TEXTE_SECOND};width:120px;">${libelle}</td>
        <td class="m-title" style="padding:7px 0;font-family:${EMAIL_FONT};font-size:14px;font-weight:600;color:#0A1311;">${valeur}</td>
      </tr>`;

    const html = this.shell({
      eyebrow: 'Livraison',
      preheader: 'Le créneau, le point de retrait et la marche à suivre en cas d\'imprévu.',
      footer: `${this.escapeHtml(opts.carrierName)} · SUIVI DE LIVRAISON<br>Propulsé par Vizyo Tracky. E-mail automatique, ne pas répondre.`,
      body: `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 10px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">Une livraison vous est assignée</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">${this.escapeHtml(opts.carrierName)} vous a assigné la mission <strong class="m-title" style="color:#0A1311;">${this.escapeHtml(opts.ref)}</strong>. Vous pourrez suivre le camion en direct pendant son créneau.</p>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${ligne('Trajet', `${this.escapeHtml(opts.origin)} → ${this.escapeHtml(opts.destination)}`)}
            ${ligne('Créneau', `${jour}, ${creneau}`)}
            ${ligne('Camion', this.escapeHtml(opts.plate))}
          </table>
        </td></tr>
        <tr><td style="padding:22px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.depotUrl}" style="display:inline-block;padding:13px 26px;font-family:${EMAIL_FONT};font-size:15px;font-weight:700;color:#04130D;text-decoration:none;">Suivre la livraison</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:20px 36px 0;">
          <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:12.5px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Le suivi est actif de ${h(opts.startAt)} à ${h(opts.endAt)}. En dehors de ce créneau, la position du camion ne vous est pas communiquée — puis le trajet passe dans votre historique.</p>
        </td></tr>`,
    });

    const text = [
      `Une livraison vous est assignée par ${opts.carrierName}.`,
      '',
      `Mission : ${opts.ref}`,
      `Trajet  : ${opts.origin} → ${opts.destination}`,
      `Créneau : ${jour}, ${creneau}`,
      `Camion  : ${opts.plate}`,
      '',
      `Suivre la livraison : ${opts.depotUrl}`,
      '',
      `Le suivi est actif de ${h(opts.startAt)} à ${h(opts.endAt)} uniquement.`,
    ].join('\n');

    return { subject, html, text };
  }

  /**
   * Espace dépôt (2026-08) — un dépôt signale un incident sur l'une de ses missions.
   * Cf. design/A3-ESPACE-DEPOT.md § 5.
   *
   * ⚠️ **LE SENS DE LECTURE EST INVERSÉ** par rapport aux autres e-mails de l'espace
   * dépôt : ici le destinataire est le GESTIONNAIRE, pas le dépôt. C'est donc la
   * marque Tracky qui parle — le gestionnaire la connaît, il travaille dedans — et
   * c'est le nom du DÉPÔT qui est mis en avant, puisque c'est l'information neuve.
   *
   * Le sujet porte le motif et la référence : un gestionnaire qui reçoit trois
   * signalements dans la journée doit pouvoir les trier sans en ouvrir un seul.
   */
  buildDepotIncidentEmail(opts: {
    missionRef: string;
    trajet: string;
    plate: string;
    motif: string;
    message: string;
    nomDepot: string;
  }): { subject: string; html: string; text: string } {
    const subject = `Signalement ${opts.nomDepot} · ${opts.motif} · mission ${opts.missionRef}`;

    const ligne = (libelle: string, valeur: string) => `
      <tr>
        <td class="m-text" style="padding:7px 0;font-family:${EMAIL_FONT};font-size:13px;color:${EMAIL_TEXTE_SECOND};width:120px;">${libelle}</td>
        <td class="m-title" style="padding:7px 0;font-family:${EMAIL_FONT};font-size:14px;font-weight:600;color:#0A1311;">${valeur}</td>
      </tr>`;

    const html = this.shell({
      eyebrow: 'Signalement dépôt',
      preheader: 'Ce qu\'un dépôt signale sur une mission en cours, et ce qu\'il attend de vous.',
      footer: 'Vizyo Tracky · E-mail automatique, ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 10px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">${this.escapeHtml(opts.nomDepot)} a signalé un incident</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Le signalement a été ajouté à votre agenda comme événement ouvert. Il n'immobilise pas le camion.</p>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${ligne('Motif', this.escapeHtml(opts.motif))}
            ${ligne('Mission', this.escapeHtml(opts.missionRef))}
            ${ligne('Trajet', this.escapeHtml(opts.trajet))}
            ${ligne('Camion', this.escapeHtml(opts.plate))}
          </table>
        </td></tr>
        ${
          opts.message
            ? `<tr><td style="padding:20px 36px 0;">
          <p class="m-title m-card" style="margin:0;padding:14px 16px;border-radius:12px;background:#FFFFFF;border:1px solid rgba(255,255,255,0.08);font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:#0A1311;">${this.escapeHtml(opts.message)}</p>
        </td></tr>`
            : ''
        }`,
    });

    const text = [
      `${opts.nomDepot} a signalé un incident.`,
      '',
      `Motif   : ${opts.motif}`,
      `Mission : ${opts.missionRef}`,
      `Trajet  : ${opts.trajet}`,
      `Camion  : ${opts.plate}`,
      ...(opts.message ? ['', opts.message] : []),
      '',
      "Le signalement a été ajouté à votre agenda comme événement ouvert. Il n'immobilise pas le camion.",
    ].join('\n');

    return { subject, html, text };
  }

  /**
   * Template invitation utilisateur — utilise par InvitationsService.
   * Charte 2026 (charte e-mails Tracky) via shell().
   */
  buildInvitationEmail(opts: {
    recipientName?: string | null;
    inviterName: string;
    fleetName: string;
    role: string;
    acceptUrl: string;
    expiresAt: Date;
  }): { subject: string; html: string; text: string } {
    // ══ ESPACE DÉPÔT (2026-08) — VERSION DÉPÔT DU MÊME GABARIT ════════════════
    //
    // A5 § 6 : « Un dépôt n'est pas un collègue : il ne connaît ni Tracky ni le
    // vocabulaire de la flotte. » On ADAPTE le gabarit existant, on n'en crée pas
    // un second — c'est la même consigne que pour le mécanisme d'invitation.
    if (opts.role === 'DEPOT') return this.buildDepotInvitationEmail(opts);

    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const expiresLabel = formatFleetDateTime(opts.expiresAt);
    const subject = `Vous êtes invité à rejoindre ${opts.fleetName}`;

    const html = this.shell({
      eyebrow: 'Accès · Invitation',
      preheader: 'Créez votre mot de passe pour ouvrir votre espace.',
      footer: 'VIZYO TRACKY · GPS FLOTTE · OCCITANIE<br>Vous recevez cet e-mail suite à une invitation. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 8px;">
          <h1 class="m-title" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Rejoignez la flotte<br><span style="color:${EMAIL_ACCENT_TEXTE};">${escapeHtml(opts.fleetName)}</span></h1>
        </td></tr>
        <tr><td style="padding:8px 36px 0;">
          <p class="m-text" style="margin:0 0 16px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">${escapeHtml(greeting)}</p>
          <p class="m-text" style="margin:0 0 22px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;"><span class="m-title" style="color:#0A1311;font-weight:600;">${escapeHtml(opts.inviterName)}</span> vous invite à rejoindre sa flotte sur Vizyo Tracky en tant que <span style="color:${EMAIL_ACCENT_TEXTE};font-weight:600;">${escapeHtml(opts.role)}</span>. Créez votre mot de passe pour accéder à votre espace.</p>
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.acceptUrl}" style="display:inline-block;padding:14px 30px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Accepter l'invitation →</a>
          </td></tr></table>
          <p class="m-text" style="margin:22px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Ce lien expire le <span class="m-text" style="font-family:${EMAIL_FONT_MONO};color:#56635E;">${expiresLabel}</span>. Si vous ne reconnaissez pas cette invitation, ignorez cet e-mail.</p>
        </td></tr>`,
    });

    const text = `${greeting}

${opts.inviterName} vous a invité à rejoindre la flotte ${opts.fleetName} sur Vizyo Tracky en tant que ${opts.role}.

Acceptez l'invitation en visitant ce lien :
${opts.acceptUrl}

Ce lien est valide jusqu'au ${expiresLabel}.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Template reset mot de passe — meme style que l'invitation.
   */
  buildPasswordResetEmail(opts: {
    recipientName?: string | null;
    resetUrl: string;
    expiresInMinutes: number;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `Réinitialisation de votre mot de passe`;

    const html = this.shell({
      eyebrow: 'Sécurité · Mot de passe',
      preheader: 'Vous n\'êtes pas à l\'origine de la demande ? Ignorez ce message, rien ne change.',
      footer: 'VIZYO TRACKY · SÉCURITÉ DU COMPTE<br>E-mail automatique de sécurité. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Réinitialisez votre mot de passe</h1>
          <p class="m-text" style="margin:0 0 22px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Vous avez demandé à réinitialiser votre mot de passe. Choisissez-en un nouveau en cliquant ci-dessous.</p>
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.resetUrl}" style="display:inline-block;padding:14px 30px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Choisir un nouveau mot de passe →</a>
          </td></tr></table>
          <div class="m-panel" style="margin:22px 0 0;padding:14px 16px;background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:11px;">
            <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:#56635E;">Ce lien est valide <span style="font-family:${EMAIL_FONT_MONO};color:${EMAIL_ACCENT_TEXTE};">${opts.expiresInMinutes} min</span>. Vous n'êtes pas à l'origine de cette demande ? <span class="m-title" style="color:#0A1311;">Ignorez cet e-mail</span>, votre mot de passe reste inchangé.</p>
          </div>
        </td></tr>`,
    });

    const text = `${greeting}

Vous avez demandé la réinitialisation de votre mot de passe sur Vizyo Tracky.

Cliquez ce lien pour choisir un nouveau mot de passe :
${opts.resetUrl}

Ce lien est valide pendant ${opts.expiresInMinutes} minutes.

Si vous n'avez pas demandé cette réinitialisation, ignorez cet e-mail.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Sécurité (2026-07) — code de vérification d'un NOUVEL appareil (2FA app).
   * Envoyé quand une flotte exige la vérification e-mail et qu'un appareil non
   * reconnu se connecte. Le code (6 chiffres) est généré par Vizyo Auth ; Tracky
   * se charge de l'envoi (même partage que le reset mot de passe). Accent emerald,
   * code affiché en gros mono. `expiresInMinutes` = validité du code.
   */
  buildDeviceVerificationEmail(opts: {
    recipientName?: string | null;
    code: string;
    expiresInMinutes: number;
    deviceLabel?: string | null;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `Votre code de connexion : ${opts.code}`;
    const spaced = opts.code.split('').join('&nbsp;');
    const deviceLine = opts.deviceLabel
      ? `<p class="m-text" style="margin:0 0 18px;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Appareil : <span class="m-text" style="color:#56635E;">${escapeHtml(opts.deviceLabel)}</span></p>`
      : '';

    const html = this.shell({
      eyebrow: 'Sécurité · Nouvel appareil',
      preheader: 'Saisissez ce code pour terminer la connexion. Il expire dans quelques minutes.',
      footer: 'VIZYO TRACKY · SÉCURITÉ DU COMPTE<br>E-mail automatique de sécurité. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Votre code de connexion</h1>
          <p class="m-text" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">${escapeHtml(greeting)}</p>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Une connexion à votre compte a été demandée depuis un <span class="m-title" style="color:#0A1311;font-weight:600;">nouvel appareil</span>. Saisissez ce code pour la confirmer :</p>
          ${deviceLine}
          <table role="presentation" width="100%"><tr><td class="m-panel" align="center" style="background:#F6F9F7;border:1px solid rgba(16,224,160,.25);border-radius:13px;padding:22px 18px;">
            <div style="font-family:${EMAIL_FONT_MONO};font-size:38px;font-weight:600;letter-spacing:0.12em;color:${EMAIL_ACCENT_TEXTE};">${spaced}</div>
          </td></tr></table>
          <div class="m-panel" style="margin:22px 0 0;padding:14px 16px;background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:11px;">
            <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:#56635E;">Ce code est valide <span style="font-family:${EMAIL_FONT_MONO};color:${EMAIL_ACCENT_TEXTE};">${opts.expiresInMinutes} min</span>. Vous n'êtes pas à l'origine de cette connexion ? <span class="m-title" style="color:#0A1311;">Ignorez cet e-mail</span> et changez votre mot de passe par précaution.</p>
          </div>
        </td></tr>`,
    });

    const text = `${greeting}

Une connexion à votre compte Vizyo Tracky a été demandée depuis un nouvel appareil.

Votre code de vérification : ${opts.code}

Ce code est valide pendant ${opts.expiresInMinutes} minutes.

Si vous n'êtes pas à l'origine de cette connexion, ignorez cet e-mail et changez votre mot de passe par précaution.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Code de confirmation pour DÉSACTIVER la double authentification. C'est un
   * abaissement de sécurité : on insiste pour que l'utilisateur qui n'en est pas
   * l'origine réagisse (compte potentiellement compromis).
   */
  buildTwoFactorDisableEmail(opts: {
    recipientName?: string | null;
    code: string;
    expiresInMinutes: number;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `Code pour désactiver la double authentification : ${opts.code}`;
    const spaced = opts.code.split('').join('&nbsp;');

    const html = this.shell({
      eyebrow: 'Sécurité · Double authentification',
      preheader: 'Ce code retire une protection de votre compte. Ne le transmettez à personne.',
      footer: 'VIZYO TRACKY · SÉCURITÉ DU COMPTE<br>E-mail automatique de sécurité. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Désactiver la double authentification</h1>
          <p class="m-text" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">${escapeHtml(greeting)}</p>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Vous avez demandé à <span class="m-title" style="color:#0A1311;font-weight:600;">désactiver</span> la double authentification de votre compte. Saisissez ce code pour le confirmer :</p>
          <table role="presentation" width="100%"><tr><td class="m-panel" align="center" style="background:#F6F9F7;border:1px solid rgba(245,158,11,.3);border-radius:13px;padding:22px 18px;">
            <div style="font-family:${EMAIL_FONT_MONO};font-size:38px;font-weight:600;letter-spacing:0.12em;color:${EMAIL_TEXTE_ATTENTE};">${spaced}</div>
          </td></tr></table>
          <div class="m-panel" style="margin:22px 0 0;padding:14px 16px;background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:11px;">
            <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:#56635E;">Ce code est valide <span style="font-family:${EMAIL_FONT_MONO};color:${EMAIL_TEXTE_ATTENTE};">${opts.expiresInMinutes} min</span>. <span class="m-title" style="color:#0A1311;">Vous n'êtes pas à l'origine de cette demande&nbsp;?</span> N'entrez pas ce code, et changez votre mot de passe immédiatement — votre compte est peut-être compromis.</p>
          </div>
        </td></tr>`,
    });

    const text = `${greeting}

Vous avez demandé à DÉSACTIVER la double authentification de votre compte Vizyo Tracky.

Votre code de confirmation : ${opts.code}

Ce code est valide pendant ${opts.expiresInMinutes} minutes.

Vous n'êtes pas à l'origine de cette demande ? N'entrez pas ce code et changez votre mot de passe immédiatement — votre compte est peut-être compromis.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Sprint 4 (garde-fou #6) — mail OBLIGATIONS envoyé à TOUS les utilisateurs actifs
   * d'une flotte à l'activation de l'écoute audio (micro embarqué). Rappel des
   * obligations de l'exploitant : informer conducteurs/occupants, poser la
   * signalétique, finalité strictement limitée. La conformité (mandat, information,
   * AIPD/CNIL) reste la RESPONSABILITÉ de l'exploitant — le mail trace l'information.
   */
  buildAudioActivationEmail(opts: {
    fleetName: string;
    activatedBy: string;
  }): { subject: string; html: string; text: string } {
    const subject = `Écoute audio activée pour ${opts.fleetName} — obligations`;

    const html = this.shell({
      eyebrow: 'Conformité · Écoute audio',
      preheader: 'Ce que la loi vous impose d\'afficher et de déclarer, et sous quel délai.',
      accent: '#F5B33D',
      borderColor: 'rgba(245,179,61,.25)',
      footer: "VIZYO TRACKY · GARDE-FOU CONFORMITÉ<br>La conformité réglementaire reste la responsabilité de l'exploitant.",
      body: `
        <tr><td style="padding:26px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">Écoute audio activée</h1>
          <p class="m-text" style="margin:0 0 18px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">L'écoute audio à distance (micro embarqué) a été activée pour <span class="m-title" style="color:#0A1311;font-weight:600;">${escapeHtml(opts.fleetName)}</span> par <span class="m-title" style="color:#0A1311;font-weight:600;">${escapeHtml(opts.activatedBy)}</span>. Cette capacité est <span style="color:${EMAIL_TEXTE_ATTENTE};font-weight:600;">légalement sensible</span> : avant tout usage, vous devez —</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;">
            <tr><td class="m-text" style="padding:14px 18px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.5;color:#56635E;"><span style="color:${EMAIL_TEXTE_ATTENTE};font-weight:700;">01</span>&nbsp;&nbsp;<span class="m-title" style="color:#0A1311;font-weight:600;">Informer</span> les conducteurs et occupants concernés.</td></tr>
            <tr><td class="m-text" style="border-top:1px solid rgba(255,255,255,.06);padding:14px 18px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.5;color:#56635E;"><span style="color:${EMAIL_TEXTE_ATTENTE};font-weight:700;">02</span>&nbsp;&nbsp;<span class="m-title" style="color:#0A1311;font-weight:600;">Poser la signalétique</span> indiquant le dispositif.</td></tr>
            <tr><td class="m-text" style="border-top:1px solid rgba(255,255,255,.06);padding:14px 18px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.5;color:#56635E;"><span style="color:${EMAIL_TEXTE_ATTENTE};font-weight:700;">03</span>&nbsp;&nbsp;Limiter la <span class="m-title" style="color:#0A1311;font-weight:600;">finalité</span> à la sécurité / sûreté.</td></tr>
            <tr><td class="m-text" style="border-top:1px solid rgba(255,255,255,.06);padding:14px 18px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.5;color:#56635E;"><span style="color:${EMAIL_TEXTE_ATTENTE};font-weight:700;">04</span>&nbsp;&nbsp;Respecter le cadre applicable <span class="m-foot" style="color:${EMAIL_TEXTE_SECOND};">(information, AIPD/CNIL, DPO)</span>.</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:18px 36px 0;">
          <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Chaque déclenchement est tracé (qui, quand, quel véhicule, motif). La fonction est désactivable à tout moment dans les réglages de la flotte.</p>
        </td></tr>`,
    });

    const text = `Écoute audio activée — ${opts.fleetName}

La fonction d'écoute audio à distance (micro embarqué) a été activée pour la flotte ${opts.fleetName} par ${opts.activatedBy}.

Cette capacité est légalement sensible. En tant qu'exploitant, vous êtes responsable de sa conformité. Avant tout usage, vous devez :
- Informer les conducteurs et occupants des véhicules concernés.
- Poser la signalétique indiquant la présence d'un dispositif d'écoute.
- Limiter strictement la finalité (sécurité / sûreté) — jamais de surveillance permanente ou détournée.
- Respecter le cadre applicable (information, AIPD/CNIL, DPO le cas échéant).

Chaque déclenchement est tracé (qui, quand, quel véhicule, motif obligatoire). La fonction peut être désactivée à tout moment depuis les paramètres de la flotte.

La conformité réglementaire reste la responsabilité de l'exploitant. Vizyo fournit l'outil et les garde-fous techniques.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Sprint 4 — mail d'INFORMATION « Mode assistance » envoyé À LA DEMANDE du prestataire
   * (super-admin) à un utilisateur (typiquement un fleet-admin) pour lui présenter la
   * fonction AVANT activation. Pédagogique : explique le principe (écoute LIVE en cas
   * d'accident, sur autorisation EXPLICITE du client, AUCUN enregistrement conservé,
   * seules les métadonnées sont tracées) + la marche à suivre pour activer + les
   * obligations. Même structure/style que buildAudioActivationEmail (mint/green, fond
   * sombre). « le prestataire » reste générique (pas de marque tierce).
   */
  buildAudioInfoEmail(opts: {
    recipientName?: string | null;
    fleetName: string;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `Nouvelle fonction « Mode assistance » — ${opts.fleetName}`;

    const appBase = this.config.get('APP_BASE_URL', { infer: true });

    const html = this.shell({
      eyebrow: 'Nouveauté · Assistance',
      preheader: 'Une capacité désactivée par défaut : rien ne change tant que vous n\'agissez pas.',
      footer: 'VIZYO TRACKY · NOUVELLE FONCTION<br>Informez conducteurs et occupants, posez la signalétique. Conformité à votre charge.',
      body: `
        <tr><td style="padding:26px 36px 0;">
          <p style="margin:0 0 6px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${EMAIL_ACCENT_TEXTE};">Disponible pour ${escapeHtml(opts.fleetName)}</p>
          <h1 class="m-title" style="margin:0 0 14px;font-family:${EMAIL_FONT};font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Le Mode assistance<br>arrive sur votre flotte</h1>
          <p class="m-text" style="margin:0 0 18px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">En cas d'accident, et <span class="m-title" style="color:#0A1311;font-weight:600;">uniquement avec votre autorisation explicite</span>, le prestataire peut ouvrir brièvement le micro de la cabine pour porter assistance.</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:10px;margin:0 -10px;">
            <tr>
              <td class="m-panel" width="50%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;vertical-align:top;">
                <div class="m-title" style="font-family:${EMAIL_FONT};font-size:14px;font-weight:700;color:#0A1311;margin-bottom:4px;">Écoute en direct</div>
                <div class="m-text" style="font-family:${EMAIL_FONT};font-size:12.5px;line-height:1.5;color:${EMAIL_TEXTE_SECOND};">Aucun fichier audio n'est stocké.</div>
              </td>
              <td class="m-panel" width="50%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;vertical-align:top;">
                <div class="m-title" style="font-family:${EMAIL_FONT};font-size:14px;font-weight:700;color:#0A1311;margin-bottom:4px;">Métadonnées tracées</div>
                <div class="m-text" style="font-family:${EMAIL_FONT};font-size:12.5px;line-height:1.5;color:${EMAIL_TEXTE_SECOND};">Qui, quand, quel véhicule, motif.</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 36px 0;">
          <p class="m-text" style="margin:0 0 12px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};">Pour l'activer</p>
          <p class="m-text" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:#56635E;"><span style="color:${EMAIL_ACCENT_TEXTE};font-family:${EMAIL_FONT_MONO};">1 →</span> Réglages → Mode assistance</p>
          <p class="m-text" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:#56635E;"><span style="color:${EMAIL_ACCENT_TEXTE};font-family:${EMAIL_FONT_MONO};">2 →</span> Cochez l'attestation</p>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:#56635E;"><span style="color:${EMAIL_ACCENT_TEXTE};font-family:${EMAIL_FONT_MONO};">3 →</span> Activez la fonction</p>
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${appBase}/settings/audio-monitoring" style="display:inline-block;padding:14px 30px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Découvrir dans les réglages →</a>
          </td></tr></table>
        </td></tr>`,
    });

    const text = `${greeting}

Une nouvelle fonction est disponible pour la flotte ${opts.fleetName} : le Mode assistance.

Le principe. En cas d'accident, et uniquement avec votre autorisation explicite, le prestataire peut ouvrir brièvement le micro de la cabine du véhicule afin de porter assistance (évaluer la situation, rassurer / guider l'occupant, déclencher les secours).

Aucun enregistrement n'est conservé. Il s'agit d'une écoute en direct uniquement — aucun fichier audio n'est stocké. Seules des métadonnées sont tracées : qui a écouté, quand, quel véhicule, et le motif.

Comment l'activer.
- Rendez-vous dans Réglages → Mode assistance.
- Cochez l'attestation.
- Activez la fonction (possible une fois que le prestataire a rendu votre flotte éligible).

Vos obligations. Le Mode assistance est légalement sensible. Avant tout usage, vous devez :
- Informer les conducteurs et occupants des véhicules concernés.
- Poser la signalétique indiquant la présence d'un dispositif d'écoute.
- Respecter la réglementation applicable (information, AIPD/CNIL, DPO le cas échéant).

La conformité réglementaire reste la responsabilité de l'exploitant. Vizyo fournit l'outil et les garde-fous techniques.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Charte 2026 — rapport hebdomadaire. Déplacé de ReportsCronService pour passer
   * par le shell(). Renvoie UNIQUEMENT le HTML ; le cron conserve subject / text /
   * pièce jointe PDF (logique métier inchangée). Grille de 4 stats mono.
   *
   * @param opts.unattributedNote la phrase des trajets que rien ne rattache à personne,
   *   fabriquée par `buildUnattributedNote` (ci-dessus) et `null` quand il n'y a rien à
   *   signaler. Le PARAMÈTRE existe pour qu'elle ne soit PAS rédigée ici : ce courrier a deux
   *   parties MIME — ce HTML et le corps texte que `ReportScheduleService` compose du même
   *   appel —, un client sous Outlook lit l'une pendant qu'un client en texte brut lit
   *   l'autre. Une phrase calculée une fois et rendue deux fois ne peut pas diverger ; deux
   *   rédactions, même bien intentionnées, l'auraient fait.
   */
  buildWeeklyReportEmail(opts: {
    fromStr: string;
    toStr: string;
    tripsCount: number;
    totalKm: number;
    alertsTotal: number;
    /** Excès ÉTABLIS de la période — omis du courrier quand il n'y en a aucun. */
    speedingCount?: number;
    liters: number;
    costEur: number;
    pdfName?: string;
    unattributedNote?: string | null;
    /**
     * Chemin INTERNE vers lequel mène le bouton, période comprise. Par défaut le tableau de
     * bord, pour les appelants qui n'en fournissent pas.
     */
    lienRapport?: string;
  }): string {
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    /**
     * ⚠️ CHEMIN INTERNE UNIQUEMENT. `lienRapport` est composé par l'appelant, mais un gabarit
     * d'e-mail n'a aucune raison de faire confiance à ce qu'on lui passe : un chemin qui ne
     * commence pas par une seule barre est refusé, ce qui interdit `//evil.example` — une
     * redirection ouverte dans un courrier qui part à tous les clients.
     */
    const chemin = opts.lienRapport && /^\/(?!\/)/.test(opts.lienRapport) ? opts.lienRapport : '/dashboard';
    /**
     * ── UNE LIGNE, ET SEULEMENT SI ELLE A UN OBJET ────────────────────────────────────
     *
     * Le chiffre que le gestionnaire cherche le lundi matin n'existait que dans la pièce
     * jointe. Une ligne — pas une cinquième tuile : la grille en compte quatre, et un
     * courrier de rapport se lit en trois secondes sur un téléphone.
     *
     * Muette à zéro : ce courrier part automatiquement à toutes les sociétés, et « 0 excès »
     * chaque lundi serait un reproche sans objet.
     */
    const exces = opts.speedingCount && opts.speedingCount > 0
      ? `<tr><td style="padding:14px 36px 0;">
          <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:#56635E;">
            <strong style="color:${EMAIL_TEXTE_ATTENTE};">${opts.speedingCount}</strong> excès de vitesse sur la période — le détail par véhicule et par conducteur est dans la pièce jointe.
          </p>
        </td></tr>`
      : '';
    const km = opts.totalKm.toFixed(1);
    const liters = opts.liters.toFixed(0);
    const cost = opts.costEur.toFixed(2);
    const chip = opts.pdfName
      ? `<table role="presentation"><tr><td style="background:rgba(16,224,160,.1);border:1px solid rgba(16,224,160,.25);border-radius:9px;padding:9px 14px;font-family:${EMAIL_FONT_MONO};font-size:11px;color:${EMAIL_ACCENT_TEXTE};">${escapeHtml(opts.pdfName)} en pièce jointe</td></tr></table>`
      : '';
    /**
     * Le panneau des non attribués : sous la grille des quatre chiffres, AVANT le bouton —
     * c'est ce qui manque pour que ces quatre chiffres comptent pour quelqu'un.
     *
     * ⚠️ FILET AMBRE SUR LE PANNEAU NEUTRE DE LA MAISON (`m-panel` + `#F6F9F7`), et non un
     * fond ambre à moi : `m-panel` est ce que la règle sombre du gabarit sait repeindre.
     * Un fond clair codé en dur serait resté un pavé blanc au milieu d'un courrier sombre.
     * Ce n'est pas une alerte — rien n'est cassé —, c'est un trou de données à combler.
     *
     * ⚠️ LE TEXTE EST ÉCHAPPÉ. Il ne porte que des nombres et un nom de page, mais il arrive
     * d'ailleurs et traverse une couche de mise en forme : un gabarit d'e-mail n'a aucune
     * raison de faire confiance à ce qu'on lui passe.
     */
    const nonAttribues = opts.unattributedNote
      ? `<tr><td style="padding:16px 36px 0;">
          <table class="m-panel" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F9F7;border:1px solid rgba(245,179,61,.35);border-radius:13px;">
            <tr><td style="padding:14px 18px;">
              <div class="m-text" style="font-family:${EMAIL_FONT_MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_TEXTE_ATTENTE};margin-bottom:6px;">Trajets non attribués</div>
              <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:#56635E;">${escapeHtml(opts.unattributedNote)}</p>
            </td></tr>
          </table>
        </td></tr>`
      : '';
    return this.shell({
      eyebrow: 'Rapport · Hebdo',
      preheader: 'Distance, trajets et alertes de la semaine, avec le détail par véhicule.',
      footer: 'VIZYO TRACKY · RAPPORT AUTOMATIQUE HEBDOMADAIRE<br>Gérez la fréquence depuis Réglages → Rapports.',
      body: `
        <tr><td style="padding:26px 36px 0;">
          <p class="m-text" style="margin:0 0 6px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.06em;color:${EMAIL_TEXTE_SECOND};">SEMAINE DU ${escapeHtml(opts.fromStr)} → ${escapeHtml(opts.toStr)}</p>
          <h1 class="m-title" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Votre semaine en bref</h1>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:10px;margin:0 -10px;">
            <tr>
              <td class="m-panel" width="50%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div class="m-text" style="font-family:${EMAIL_FONT_MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};margin-bottom:8px;">Trajets</div>
                <div class="m-title" style="font-family:${EMAIL_FONT_MONO};font-size:30px;font-weight:600;color:#0A1311;">${opts.tripsCount}</div>
              </td>
              <td class="m-panel" width="50%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div class="m-text" style="font-family:${EMAIL_FONT_MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};margin-bottom:8px;">Distance</div>
                <div style="font-family:${EMAIL_FONT_MONO};font-size:30px;font-weight:600;color:${EMAIL_ACCENT_TEXTE};">${km}<span class="m-text" style="font-size:14px;color:${EMAIL_TEXTE_SECOND};"> km</span></div>
              </td>
            </tr>
            <tr>
              <td class="m-panel" width="50%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div class="m-text" style="font-family:${EMAIL_FONT_MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};margin-bottom:8px;">Alertes</div>
                <div style="font-family:${EMAIL_FONT_MONO};font-size:30px;font-weight:600;color:${EMAIL_TEXTE_ATTENTE};">${opts.alertsTotal}</div>
              </td>
              <td class="m-panel" width="50%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div class="m-text" style="font-family:${EMAIL_FONT_MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};margin-bottom:8px;">Conso estimée</div>
                <div class="m-title" style="font-family:${EMAIL_FONT_MONO};font-size:30px;font-weight:600;color:#0A1311;">${liters}<span class="m-text" style="font-size:14px;color:${EMAIL_TEXTE_SECOND};"> L</span></div>
                <div class="m-text" style="font-family:${EMAIL_FONT_MONO};font-size:12px;color:${EMAIL_TEXTE_SECOND};margin-top:3px;">≈ ${cost} €</div>
              </td>
            </tr>
          </table>
        </td></tr>
        ${exces}${nonAttribues}
        <tr><td style="padding:20px 36px 0;">
          ${chip}
          <table role="presentation" style="margin-top:${opts.pdfName ? '20px' : '0'};"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${appBase}${chemin}" style="display:inline-block;padding:14px 30px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Ouvrir le rapport →</a>
          </td></tr></table>
        </td></tr>`,
    });
  }

  /**
   * Charte 2026 — e-mail d'alerte. Déplacé de NotificationDispatchService pour
   * passer par le shell(). Renvoie le HTML ; le dispatch conserve subject / bodyText.
   * Accent conditionnel : escalade OU CRITICAL → rouge, WARNING → ambre, INFO →
   * emerald. Le bouton d'action reste emerald (charte). `plate` déjà résolu par l'appelant.
   */
  /**
   * Saturation du centre d'alerte : « ça se remplit vite ». On donne le CHIFFRE, le seuil qui a
   * été franchi, et surtout les sources responsables — pour savoir où regarder sans ouvrir l'app.
   */
  buildErrorRateAlertEmail(data: {
    total: number;
    critical: number;
    threshold: number;
    top: { source: string; count: number }[];
    since: Date;
  }): string {
    const accent = data.critical > 0 ? '#F2706B' : '#F5B33D';
    // Deux jetons pour une meme couleur : le VIF pour le filet, le FONCE des
    // qu'elle porte du texte. Confondre les deux donnait « CRITICAL » a 2,71:1.
    const accentTexte = data.critical > 0 ? EMAIL_TEXTE_ALERTE : EMAIL_TEXTE_ATTENTE;
    const border = data.critical > 0 ? 'rgba(242,112,107,.28)' : 'rgba(245,179,61,.25)';
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    const depuis = formatFleetDateTime(data.since);
    const lignes = data.top
      .map(
        (t, i) => `
            ${i > 0 ? '<tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>' : ''}
            <tr>
              <td class="m-text" style="padding:13px 18px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};">${escapeHtml(t.source)}</td>
              <td align="right" style="padding:13px 18px;"><span class="m-title" style="font-family:${EMAIL_FONT_MONO};font-size:13px;font-weight:600;color:#0A1311;background:rgba(255,255,255,.05);border-radius:6px;padding:3px 9px;">${t.count}</span></td>
            </tr>`,
      )
      .join('');
    return this.shell({
      eyebrow: `● Centre d'alerte · Seuil dépassé`,
      accent,
      borderColor: border,
      footer: "VIZYO TRACKY · VIGIE DU CENTRE D'ALERTE<br>Une seule alerte par heure, même si les erreurs continuent.",
      body: `
        <tr><td style="padding:26px 36px 0;">
          <h1 class="m-title" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">${data.total} erreurs en une heure</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.6;color:#56635E;">
            Le seuil de ${data.threshold} erreurs par heure a été franchi${data.critical > 0 ? `, dont <strong style="color:${accentTexte};">${data.critical} critiques</strong>` : ''}.
            Relevé depuis le ${escapeHtml(depuis)}.
          </p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;">${lignes}
          </table>
        </td></tr>
        <tr><td style="padding:22px 36px 0;">
          <a href="${appBase}/admin/observability" style="display:inline-block;background:#10E0A0;color:#04130D;font-family:${EMAIL_FONT};font-size:14px;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:10px;">Ouvrir le centre d'alerte</a>
        </td></tr>`,
    });
  }

  buildAlertEmail(
    alert: { title: string; message: string | null; plate: string; severity: string; createdAt: Date },
    opts: { isEscalation?: boolean } = {},
  ): string {
    const isEsc = opts.isEscalation ?? false;
    const sev = alert.severity;
    const accent = isEsc || sev === 'CRITICAL' ? '#F2706B' : sev === 'WARNING' ? '#F5B33D' : '#10E0A0';
    // Le filet garde le vif ; le libelle de severite prend le pendant lisible.
    const accentTexte = isEsc || sev === 'CRITICAL' ? EMAIL_TEXTE_ALERTE : sev === 'WARNING' ? EMAIL_TEXTE_ATTENTE : EMAIL_ACCENT_TEXTE;
    const border = isEsc || sev === 'CRITICAL' ? 'rgba(242,112,107,.28)' : sev === 'WARNING' ? 'rgba(245,179,61,.25)' : 'rgba(255,255,255,.08)';
    const sevLabel = sev === 'CRITICAL' ? 'Critique' : sev === 'WARNING' ? 'Avertissement' : 'Information';
    const eyebrow = `● ${isEsc ? 'Escalade' : 'Alerte'} · ${sevLabel}`;
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    // ⚠️ Le serveur tourne en UTC : sans fuseau explicite, une alerte de 07:38
    // était annoncée « 05:38 » dans l'e-mail — alors que le SMS de la MÊME
    // alerte disait 07:38. Cf. common/utils/datetime.ts.
    const heure = formatFleetDateTime(alert.createdAt);
    const messageP = alert.message
      ? `<p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.6;color:#56635E;">${escapeHtml(alert.message)}</p>`
      : '';
    return this.shell({
      eyebrow,
      accent,
      borderColor: border,
      footer: "VIZYO TRACKY · NOTIFICATION D'ALERTE<br>Réglez vos canaux dans Réglages → Alertes.",
      body: `
        <tr><td style="padding:26px 36px 0;">
          <h1 class="m-title" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">${escapeHtml(alert.title)}</h1>
          ${messageP}
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;">
            <tr>
              <td class="m-text" style="padding:13px 18px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};">Véhicule</td>
              <td align="right" style="padding:13px 18px;"><span class="m-title" style="font-family:${EMAIL_FONT_MONO};font-size:13px;font-weight:600;color:#0A1311;background:rgba(255,255,255,.05);border-radius:6px;padding:3px 9px;">${escapeHtml(alert.plate || 'N/A')}</span></td>
            </tr>
            <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>
            <tr>
              <td class="m-text" style="padding:13px 18px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};">Sévérité</td>
              <td align="right" style="padding:13px 18px;font-family:${EMAIL_FONT_MONO};font-size:13px;font-weight:600;color:${accentTexte};">${escapeHtml(sev)}</td>
            </tr>
            <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>
            <tr>
              <td class="m-text" style="padding:13px 18px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};">Heure</td>
              <td class="m-text" align="right" style="padding:13px 18px;font-family:${EMAIL_FONT_MONO};font-size:13px;color:#56635E;">${escapeHtml(heure)}</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:22px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${appBase}/alerts" style="display:inline-block;padding:14px 30px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Acquitter l'alerte →</a>
          </td></tr></table>
        </td></tr>`,
    });
  }

  /** Ligne « clé / valeur » réutilisable dans une carte détail (charte). */
  private kvRow(key: string, value: string, last = false): string {
    const border = last ? '' : 'border-bottom:1px solid rgba(255,255,255,.06);';
    return `<tr>
      <td class="m-text" style="padding:12px 18px;${border}font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};white-space:nowrap;">${escapeHtml(key)}</td>
      <td class="m-title" align="right" style="padding:12px 18px;${border}font-family:${EMAIL_FONT};font-size:13px;color:#0A1311;">${escapeHtml(value)}</td>
    </tr>`;
  }

  /**
   * Invitation à consentir au partage vers une application partenaire.
   *
   * ⚠️ CET E-MAIL DEMANDE UNE AUTORISATION — il ne l'annonce pas. Le ton est donc
   * volontairement sobre : ce qui sera partagé n'est PAS listé ici, parce que le
   * client choisira catégorie par catégorie sur l'écran, et qu'annoncer une liste
   * dans l'e-mail donnerait l'impression que c'est déjà décidé. On dit ce qu'on
   * demande, on dit qu'il choisit, et on l'emmène là où il choisit vraiment.
   *
   * ⚠️ Aucune donnée de flotte dans l'e-mail (ni plaques, ni conducteurs) : une
   * boîte mail n'est pas un canal maîtrisé.
   */
  buildPartnerConsentInvitationEmail(opts: {
    fleetName: string;
    partnerName: string;
    consentUrl: string;
    expiresAt: Date;
  }): { subject: string; html: string; text: string } {
    const subject = `Autoriser le partage avec ${opts.partnerName}`;
    const deadline = formatFleetDateTimeLong(opts.expiresAt);
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Autoriser le partage avec ${escapeHtml(opts.partnerName)} ?</h1>
          <p class="m-text" style="margin:0 0 14px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Bonjour,</p>
          <p class="m-text" style="margin:0 0 14px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">${escapeHtml(opts.partnerName)} souhaite recevoir certaines données de votre flotte <span class="m-title" style="color:#0A1311;font-weight:600;">${escapeHtml(opts.fleetName)}</span> pour enrichir votre suivi d'exploitation.</p>
          <p class="m-text" style="margin:0 0 22px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;"><span class="m-title" style="color:#0A1311;font-weight:600;">Rien n'est partagé tant que vous n'avez pas donné votre accord.</span> Le bouton ci-dessous ouvre l'écran où vous choisissez, catégorie par catégorie, ce que vous acceptez de partager — et où vous pourrez tout couper à tout moment.</p>
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.consentUrl}" style="display:inline-block;padding:14px 30px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Voir la demande →</a>
          </td></tr></table>
          <p class="m-text" style="margin:20px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Ce lien est valable jusqu'au ${escapeHtml(deadline)}. Il vous demandera de vous connecter à votre espace Tracky : il ne donne aucun accès par lui-même.</p>
          <p class="m-text" style="margin:10px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Vous n'attendiez pas cette demande ? Ne cliquez pas, et répondez à cet e-mail.</p>
        </td></tr>`;
    const html = this.shell({
      eyebrow: 'Intégration · Autorisation',
      preheader: 'Aucune donnée ne part tant que vous n\'avez pas autorisé ce partage.',
      footer: 'VIZYO TRACKY · GPS FLOTTE · OCCITANIE<br>Vous restez propriétaire de vos données : le partage se coupe depuis votre espace, sans nous demander.',
      body,
    });
    const text = `Autoriser le partage avec ${opts.partnerName} ?

Bonjour,

${opts.partnerName} souhaite recevoir certaines données de votre flotte ${opts.fleetName} pour enrichir votre suivi d'exploitation.

Rien n'est partagé tant que vous n'avez pas donné votre accord. Le lien ci-dessous ouvre l'écran où vous choisissez, catégorie par catégorie, ce que vous acceptez de partager — et où vous pourrez tout couper à tout moment.

${opts.consentUrl}

Ce lien est valable jusqu'au ${deadline}. Il vous demandera de vous connecter à votre espace Tracky : il ne donne aucun accès par lui-même.

Vous n'attendiez pas cette demande ? Ne cliquez pas, et répondez à cet e-mail.`;
    return { subject, html, text };
  }

  /**
   * Prise de RDV en ligne — NOTIFICATION OPÉRATEUR (→ contact@vizyoagency.com) quand un
   * client dépose une demande de créneau via un lien public.
   */
  buildInstallationSlotRequestedEmail(opts: {
    companyName: string;
    slotLabel: string;
    clientName: string;
    clientEmail: string;
    clientPhone?: string | null;
    clientAddress?: string | null;
    vehicle?: string | null;
    notes?: string | null;
    manageUrl: string;
  }): { subject: string; html: string; text: string } {
    const subject = `Demande de créneau d'installation — ${opts.companyName}`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      this.kvRow('Client', opts.clientName),
      this.kvRow('E-mail', opts.clientEmail),
      opts.clientPhone ? this.kvRow('Téléphone', opts.clientPhone) : '',
      opts.clientAddress ? this.kvRow('Adresse', opts.clientAddress) : '',
      opts.vehicle ? this.kvRow('Véhicule', opts.vehicle) : '',
    ].filter(Boolean);
    // Dernière ligne sans bordure basse.
    const body = `
        <tr><td style="padding:28px 36px 8px;">
          <h1 class="m-title" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Nouvelle demande de créneau</h1>
          <p class="m-text" style="margin:0;font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:#56635E;">Pour <span style="color:${EMAIL_ACCENT_TEXTE};font-weight:600;">${escapeHtml(opts.companyName)}</span>, à valider.</p>
        </td></tr>
        <tr><td style="padding:18px 36px 0;">
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
          ${opts.notes ? `<p class="m-text" style="margin:16px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:#56635E;"><span class="m-text" style="color:${EMAIL_TEXTE_SECOND};">Note du client :</span> ${escapeHtml(opts.notes)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:22px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.manageUrl}" style="display:inline-block;padding:14px 30px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Gérer la demande →</a>
          </td></tr></table>
        </td></tr>`;
    const html = this.shell({
      eyebrow: 'Installation · Demande',
      preheader: 'Un créneau vous est proposé : confirmez-le ou demandez-en un autre.',
      footer: 'VIZYO TRACKY · PLANIFICATION DES INSTALLATIONS<br>Notification automatique. Répondez au client via son e-mail.',
      body,
    });
    const text = `Nouvelle demande de créneau d'installation — ${opts.companyName}
Créneau : ${opts.slotLabel}
Client : ${opts.clientName} (${opts.clientEmail})${opts.clientPhone ? `\nTéléphone : ${opts.clientPhone}` : ''}${opts.clientAddress ? `\nAdresse : ${opts.clientAddress}` : ''}${opts.vehicle ? `\nVéhicule : ${opts.vehicle}` : ''}${opts.notes ? `\nNote : ${opts.notes}` : ''}

Gérer : ${opts.manageUrl}`;
    return { subject, html, text };
  }

  /**
   * Prise de RDV en ligne — CONFIRMATION CLIENT (→ e-mail du client) quand l'opérateur
   * valide le créneau. Envoyée depuis contact@vizyoagency.com (RESEND_FROM).
   */
  buildInstallationSlotConfirmedEmail(opts: {
    companyName: string;
    slotLabel: string;
    clientName?: string | null;
    address?: string | null;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.clientName ? `Bonjour ${opts.clientName},` : 'Bonjour,';
    const subject = `Votre créneau d'installation est confirmé`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      opts.address ? this.kvRow('Lieu', opts.address) : '',
    ].filter(Boolean);
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Votre créneau est confirmé</h1>
          <p class="m-text" style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">${escapeHtml(greeting)}</p>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Votre rendez-vous d'installation est bien confirmé. Voici le récapitulatif :</p>
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
          <p class="m-text" style="margin:20px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Un imprévu ? Répondez à cet e-mail pour convenir d'un autre créneau. À très bientôt.</p>
        </td></tr>`;
    const html = this.shell({
      eyebrow: 'Installation · Confirmation',
      preheader: 'Date, lieu et véhicules concernés — ce qu\'il faut préparer avant la pose.',
      footer: 'VIZYO TRACKY · GPS FLOTTE · OCCITANIE',
      body,
    });
    const text = `${greeting}

Votre créneau d'installation est confirmé.
Créneau : ${opts.slotLabel}${opts.address ? `\nLieu : ${opts.address}` : ''}

Un imprévu ? Répondez à cet e-mail. À bientôt.
— L'équipe Vizyo`;
    return { subject, html, text };
  }

  /**
   * Lien public de réservation — ACCUSÉ DE RÉCEPTION (→ demandeur) quand une demande est déposée.
   * Charte 2026 via shell(). Aucun véhicule exposé (la demande est en attente de validation).
   */
  buildReservationRequestedEmail(opts: {
    fleetName: string;
    slotLabel: string;
    destination?: string | null;
    seats?: number | null;
  }): { subject: string; html: string; text: string } {
    const subject = `Votre demande de réservation a bien été reçue`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      opts.destination ? this.kvRow('Destination', opts.destination) : '',
      opts.seats ? this.kvRow('Places', String(opts.seats)) : '',
    ].filter(Boolean);
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Demande bien reçue</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Bonjour, nous avons bien reçu votre demande de véhicule auprès de <span style="color:${EMAIL_ACCENT_TEXTE};font-weight:600;">${escapeHtml(opts.fleetName)}</span>. Elle est en cours de validation — vous recevrez une confirmation dès qu'un gestionnaire l'aura validée.</p>
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
        </td></tr>`;
    const html = this.shell({ eyebrow: 'Réservation · Demande reçue',
      preheader: 'Nous revenons vers vous dès qu\'un véhicule est confirmé sur ce créneau.', footer: 'VIZYO TRACKY · RÉSERVATION DE VÉHICULES', body });
    const text = `Bonjour,

Nous avons bien reçu votre demande de réservation auprès de ${opts.fleetName}.
Créneau : ${opts.slotLabel}${opts.destination ? `\nDestination : ${opts.destination}` : ''}${opts.seats ? `\nPlaces : ${opts.seats}` : ''}

Vous recevrez une confirmation dès qu'elle sera validée.`;
    return { subject, html, text };
  }

  /**
   * Lien public de réservation — CONFIRMATION (→ demandeur) quand un gestionnaire valide. Le véhicule
   * attribué est indiqué (post-validation : le demandeur doit savoir quel véhicule il utilisera).
   */
  buildReservationConfirmedEmail(opts: {
    fleetName: string;
    slotLabel: string;
    destination?: string | null;
    vehicle?: string | null;
  }): { subject: string; html: string; text: string } {
    const subject = `Votre réservation est confirmée`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      opts.destination ? this.kvRow('Destination', opts.destination) : '',
      this.kvRow('Véhicule', opts.vehicle || 'attribué par la société'),
    ].filter(Boolean);
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Votre réservation est confirmée</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">Bonjour, votre demande auprès de <span style="color:${EMAIL_ACCENT_TEXTE};font-weight:600;">${escapeHtml(opts.fleetName)}</span> a été <span class="m-title" style="color:#0A1311;font-weight:600;">validée</span>. Voici le récapitulatif :</p>
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
          <p class="m-text" style="margin:20px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:1.6;color:${EMAIL_TEXTE_SECOND};">Un imprévu ? Répondez à cet e-mail pour prévenir la société. À très bientôt.</p>
        </td></tr>`;
    const html = this.shell({ eyebrow: 'Réservation · Confirmée',
      preheader: 'Le véhicule, le créneau et le point de retrait sont fixés.', footer: 'VIZYO TRACKY · RÉSERVATION DE VÉHICULES', body });
    const text = `Bonjour,

Votre réservation auprès de ${opts.fleetName} est confirmée.
Créneau : ${opts.slotLabel}${opts.destination ? `\nDestination : ${opts.destination}` : ''}
Véhicule : ${opts.vehicle || 'attribué par la société'}

Un imprévu ? Répondez à cet e-mail. À bientôt.
— L'équipe Vizyo`;
    return { subject, html, text };
  }

  /** Facturation — un fleet-admin demande une FACTURE PHYSIQUE pour l'option IA (→ contact@vizyoagency.com). */
  buildAiInvoiceRequestEmail(opts: {
    fleetName: string;
    requester: string;
    vehicleCount: number;
    monthlyLabel: string;
  }): { subject: string; html: string; text: string } {
    const subject = `Facture physique — Option IA · ${opts.fleetName}`;
    const rows = [
      this.kvRow('Société', opts.fleetName),
      this.kvRow('Demandeur', opts.requester),
      this.kvRow('Véhicules facturables', String(opts.vehicleCount)),
      this.kvRow('Montant estimé', `~${opts.monthlyLabel}/mois`),
    ];
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <h1 class="m-title" style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#0A1311;">Demande de facture physique — Option IA</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#56635E;">La société <span style="color:${EMAIL_ACCENT_TEXTE};font-weight:600;">${escapeHtml(opts.fleetName)}</span> souhaite activer l'<span class="m-title" style="color:#0A1311;font-weight:600;">option IA</span> par <span class="m-title" style="color:#0A1311;font-weight:600;">facture physique</span>. Émettez la facture puis activez l'IA de la société depuis l'espace admin (page Coûts IA).</p>
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
        </td></tr>`;
    const html = this.shell({ eyebrow: 'Facturation · Option IA',
      preheader: 'Le détail de la consommation du mois et le montant correspondant.', footer: 'VIZYO TRACKY · FACTURATION', body });
    const text = `Demande de facture physique — Option IA
Société : ${opts.fleetName}
Demandeur : ${opts.requester}
Véhicules facturables : ${opts.vehicleCount}
Montant estimé : ~${opts.monthlyLabel}/mois

Émettez la facture puis activez l'IA de la société depuis l'espace admin (page Coûts IA).`;
    return { subject, html, text };
  }

  /**
   * Signature commerciale PERSONNELLE (charte) — bloc `<tr><td>` réutilisé dans
   * les e-mails prospects pour un ton humain (« un vrai commercial », pas un
   * robot ni « l'équipe »). Une identité + un contact direct : les gens
   * répondent mieux à une personne. `contactEmail`/`whatsappUrl`/`phone` sont
   * les coordonnées Vizyo (RESEND_FROM = contact@vizyoagency.com).
   */
  private commercialSignature(): string {
    const sans = "${EMAIL_FONT}";
    // Signature sobre, comme au bas d'un vrai e-mail personnel : pas d'avatar ni
    // de boutons — juste un nom et un contact direct.
    return `
      <tr><td style="padding:22px 36px 0;">
        <p style="margin:0;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">Bien à vous,</p>
        <p class="m-title" style="margin:0;font-family:${sans};font-size:15px;line-height:1.75;color:#0A1311;font-weight:700;">Y. Haddou</p>
        <p class="m-text" style="margin:0;font-family:${sans};font-size:14.5px;line-height:1.75;color:#56635E;">Vizyo Tracky</p>
        <p class="m-text" style="margin:0;font-family:${sans};font-size:14.5px;line-height:1.75;color:#56635E;">06&nbsp;52&nbsp;07&nbsp;70&nbsp;38 &nbsp;—&nbsp; tél &amp; WhatsApp &nbsp;·&nbsp; <a href="mailto:contact@vizyoagency.com" style="color:${EMAIL_ACCENT_TEXTE};text-decoration:none;">contact@vizyoagency.com</a></p>
      </td></tr>`;
  }

  private commercialSignatureText(): string {
    return `Bien à vous,

Y. Haddou
Vizyo Tracky · votre interlocuteur dédié
WhatsApp / Tél : 06 52 07 70 38
E-mail : contact@vizyoagency.com`;
  }

  /** Carte « récap devis » (le texte du simulateur, sauts de ligne préservés). */
  private quoteRecapCard(quoteText: string): string {
    const inner = escapeHtml(quoteText).replace(/\n/g, '<br>');
    return `<div class="m-text" style="padding:16px 18px;background:#F6F9F7;border:1px solid rgba(16,224,160,.28);border-radius:12px;font-family:${EMAIL_FONT_MONO};font-size:12.5px;line-height:1.75;color:#56635E;">${inner}</div>`;
  }

  /**
   * Suivi commercial — e-mail de BIENVENUE au PROSPECT (→ son e-mail) dès qu'il
   * remplit un formulaire de demande sur la LP. Ton PERSONNEL (signé Y. Haddou),
   * comme un commercial qui prend en main le dossier. Présentation vidéo (hub
   * privé) + 3 univers + configuration devis en soft (sans brusquer) + signature.
   */
  buildLeadWelcomeEmail(opts: {
    recipientName?: string | null;
    hubUrl: string;
    tarifsUrl: string;
    ficheUrl: string;
  }): { subject: string; html: string; text: string } {
    const firstName = (opts.recipientName || '').trim().split(/\s+/)[0] || '';
    const greeting = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
    const subject = 'Votre présentation Vizyo Tracky — et mes coordonnées';
    const sans = "${EMAIL_FONT}";

    const html = this.shell({
      eyebrow: 'Vizyo Tracky',
      footer: 'VIZYO TRACKY · GPS &amp; GESTION DE FLOTTE · OCCITANIE<br>Vous recevez cet e-mail suite à votre demande sur tracky.vizyoagency.com.',
      body: `
        <tr><td style="padding:30px 36px 0;">
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">Merci de m'avoir contacté via le site. Je suis Y. Haddou, et c'est moi qui vais suivre votre demande — personnellement, pas un service automatique.</p>
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">Pour que vous vous fassiez une idée concrète de ce que nous faisons, j'ai réuni une courte présentation de nos services en vidéo. Vous la regardez tranquillement, quand vous avez un moment&nbsp;: <a href="${opts.hubUrl}" style="color:${EMAIL_ACCENT_TEXTE};text-decoration:none;font-weight:600;">c'est par ici</a>. Vous y verrez l'essentiel — la supervision de votre flotte en temps réel (carte live, alertes, coupe-circuit antivol), l'analyse des trajets et des coûts (rapports, économies de carburant), et toute la gestion au quotidien&nbsp;: comptes, permissions, installation partout en France.</p>
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">Dès que vous aurez une idée du nombre de véhicules à équiper, vous pouvez <a href="${opts.tarifsUrl}" style="color:${EMAIL_ACCENT_TEXTE};text-decoration:none;font-weight:600;">estimer votre tarif et configurer un devis en ligne</a>, sans le moindre engagement. Cela dit, le plus simple reste souvent d'en discuter de vive voix — dites-moi ce qui vous arrange, je m'adapte à votre rythme.</p>
          <p style="margin:0;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">Une question, un doute, une contrainte particulière&nbsp;? Répondez simplement à cet e-mail, ou appelez-moi. Je m'en occupe.</p>
        </td></tr>
        ${this.commercialSignature()}`,
    });

    const text = `${greeting}

Merci de m'avoir contacté via le site. Je suis Y. Haddou, et c'est moi qui vais suivre votre demande — personnellement, pas un service automatique.

Pour que vous vous fassiez une idée concrète de ce que nous faisons, j'ai réuni une courte présentation de nos services en vidéo, à regarder tranquillement quand vous avez un moment :
${opts.hubUrl}

Vous y verrez l'essentiel : la supervision de votre flotte en temps réel (carte live, alertes, coupe-circuit antivol), l'analyse des trajets et des coûts (rapports, économies de carburant), et toute la gestion au quotidien (comptes, permissions, installation partout en France).

Dès que vous aurez une idée du nombre de véhicules à équiper, vous pouvez estimer votre tarif et configurer un devis en ligne, sans le moindre engagement :
${opts.tarifsUrl}

Cela dit, le plus simple reste souvent d'en discuter de vive voix — dites-moi ce qui vous arrange. Si vous préférez un document, la fiche produit est là : ${opts.ficheUrl}

Une question, un doute ? Répondez simplement à cet e-mail, ou appelez-moi. Je m'en occupe.

${this.commercialSignatureText()}`;

    return { subject, html, text };
  }

  /**
   * Devis signé en ligne — NOTIFICATION ADMIN (→ contact@vizyoagency.com) quand un
   * prospect valide « bon pour accord » un devis auto-configuré sur la page Tarifs.
   * Reprend le récap exact du simulateur pour retraiter/finaliser rapidement.
   */
  buildQuoteSignedAdminEmail(opts: {
    name: string;
    email: string;
    phone?: string | null;
    company?: string | null;
    fleetSize?: string | null;
    quoteText: string;
    managerUrl: string;
  }): { subject: string; html: string; text: string } {
    const sans = "${EMAIL_FONT}";
    const subject = `Devis signé en ligne — ${opts.company || opts.name}${opts.fleetSize ? ` (${opts.fleetSize})` : ''}`;
    const rows = [
      this.kvRow('Nom', opts.name),
      this.kvRow('E-mail', opts.email),
      opts.phone ? this.kvRow('Téléphone', opts.phone) : '',
      opts.company ? this.kvRow('Société', opts.company) : '',
      opts.fleetSize ? this.kvRow('Flotte', opts.fleetSize, true) : '',
    ].filter(Boolean);
    const html = this.shell({
      eyebrow: 'Devis signé · Prospect',
      preheader: 'Le devis est signé en ligne : voici le détail et la suite à donner.',
      footer: 'VIZYO TRACKY · NOTIFICATION INTERNE · DEVIS',
      body: `
        <tr><td style="padding:26px 36px 0;">
          <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:rgba(16,224,160,.12);font-family:${EMAIL_FONT_MONO};font-size:10.5px;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_ACCENT_TEXTE};margin-bottom:12px;">Bon pour accord</div>
          <h1 class="m-title" style="margin:0 0 4px;font-family:${sans};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">Devis signé en ligne</h1>
          <p class="m-text" style="margin:0 0 20px;font-family:${sans};font-size:14px;color:${EMAIL_TEXTE_SECOND};">Configuré et validé à l'instant via la page Tarifs.</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;border-collapse:separate;">${rows.join('')}</table>
        </td></tr>
        <tr><td style="padding:16px 36px 0;">
          ${this.quoteRecapCard(opts.quoteText)}
        </td></tr>
        <tr><td style="padding:20px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.managerUrl}" style="display:inline-block;padding:14px 30px;font-family:${sans};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Ouvrir Vizyo Manager →</a>
          </td></tr></table>
        </td></tr>`,
    });
    const text = `Devis signé en ligne — ${opts.company || opts.name}

Nom : ${opts.name}
E-mail : ${opts.email}${opts.phone ? `\nTéléphone : ${opts.phone}` : ''}${opts.company ? `\nSociété : ${opts.company}` : ''}${opts.fleetSize ? `\nFlotte : ${opts.fleetSize}` : ''}

${opts.quoteText}

Gérer : ${opts.managerUrl}`;
    return { subject, html, text };
  }

  /**
   * Devis signé en ligne — COPIE CLIENT (→ e-mail du prospect). Ton personnel
   * (signé Y. Haddou) : récap de son devis + « je vous recontacte pour
   * finaliser ». Rassure (indicatif, sans engagement, tarif bloqué).
   */
  buildQuoteClientEmail(opts: {
    recipientName?: string | null;
    quoteText: string;
    tarifsUrl: string;
    /** Hub de présentation (démos vidéo) — envoyé après CHAQUE devis pour nourrir la décision. */
    hubUrl: string;
  }): { subject: string; html: string; text: string } {
    const firstName = (opts.recipientName || '').trim().split(/\s+/)[0] || '';
    const greeting = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
    const subject = 'Votre devis Vizyo Tracky — récapitulatif';
    const sans = "${EMAIL_FONT}";
    const html = this.shell({
      eyebrow: 'Vizyo Tracky · Votre devis',
      footer: 'VIZYO TRACKY · GPS &amp; GESTION DE FLOTTE · OCCITANIE<br>Devis indicatif sans engagement — tarif bloqué à la souscription.',
      body: `
        <tr><td style="padding:30px 36px 0;">
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 18px;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">Merci d'avoir pris le temps de configurer votre devis. Vous en trouverez le récapitulatif juste en dessous. Je le regarde de mon côté et je reviens vers vous très vite pour le finaliser ensemble et répondre à vos questions.</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          ${this.quoteRecapCard(opts.quoteText)}
          <p style="margin:18px 0 0;font-family:${sans};font-size:15px;line-height:1.75;color:#56635E;">En attendant mon retour, je vous ai préparé une <a href="${opts.hubUrl}" style="color:${EMAIL_ACCENT_TEXTE};text-decoration:none;font-weight:600;">courte présentation de nos services en vidéo</a> — vous y verrez concrètement ce que votre flotte y gagne&nbsp;: la supervision en temps réel (carte live, alertes, coupe-circuit antivol), l'analyse des trajets et des coûts, et toute la gestion au quotidien (comptes conducteurs, permissions, installation par nos équipes).</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 0;"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.hubUrl}" style="display:inline-block;padding:13px 24px;font-family:${sans};font-size:14px;font-weight:700;color:#04130D;text-decoration:none;">&#9654;&nbsp; Voir la présentation (2 min)</a>
          </td></tr></table>
          <p class="m-text" style="margin:16px 0 0;font-family:${sans};font-size:14px;line-height:1.7;color:#56635E;">C'est un devis indicatif et sans engagement — le tarif est bloqué à la souscription. Si vous souhaitez ajuster quoi que ce soit, vous pouvez le <a href="${opts.tarifsUrl}" style="color:${EMAIL_ACCENT_TEXTE};text-decoration:none;">reconfigurer en ligne</a> ou simplement me le dire.</p>
        </td></tr>
        ${this.commercialSignature()}`,
    });
    const text = `${greeting}

Merci d'avoir pris le temps de configurer votre devis. Vous en trouverez le récapitulatif ci-dessous. Je le regarde de mon côté et je reviens vers vous très vite pour le finaliser ensemble et répondre à vos questions.

${opts.quoteText}

En attendant mon retour, une courte présentation de nos services en vidéo (supervision temps réel, analyse des coûts, gestion au quotidien) :
${opts.hubUrl}

Ce devis est indicatif et sans engagement — le tarif est bloqué à la souscription.
Reconfigurer en ligne : ${opts.tarifsUrl}

${this.commercialSignatureText()}`;
    return { subject, html, text };
  }

  /**
   * Centre e-mails (admin) — rend un modèle avec des DONNÉES D'EXEMPLE, pour l'aperçu
   * (drawer, via iframe srcdoc) et le bouton « Envoyer un test ». Réutilise les builders
   * existants → aucune duplication du markup des modèles côté front.
   */
  previewTemplate(id: EmailTemplateId): { subject: string; html: string; text: string } {
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    const fleetName = 'Transports Legrand';
    switch (id) {
      case 'invitation':
        return this.buildInvitationEmail({
          recipientName: 'Camille',
          inviterName: 'Julien Marchetti',
          fleetName,
          role: 'Gestionnaire',
          acceptUrl: `${appBase}/accept-invite?token=apercu`,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        });
      case 'mission_assigned':
        return this.buildMissionAssignedEmail({
          ref: 'M-2481',
          origin: 'Fenouillet',
          destination: 'Muret',
          startAt: new Date(Date.now() + 20 * 3_600_000),
          endAt: new Date(Date.now() + 23 * 3_600_000),
          plate: 'FR-482-BX',
          carrierName: fleetName,
          depotUrl: `${appBase}/depot`,
        });
      case 'mission_request':
        return this.buildMissionQuoteEmail({
          ref: 'D-0142',
          titre: 'Nouvelle demande de mission',
          intro:
            'Un de vos dépôts vous adresse une demande. Le devis ci-dessous a été calculé sur votre grille tarifaire.',
          origin: 'Entrepôt Toulouse',
          destination: 'Client Blagnac',
          nbArrets: 3,
          startAt: new Date('2026-09-02T08:00:00Z'),
          endAt: new Date('2026-09-02T12:00:00Z'),
          amountCents: 16900,
          message: 'Livraison fragile, merci de prévoir des sangles.',
          carrierName: 'MH Cars',
          url: `${appBase}/missions`,
          libelleAction: 'Ouvrir la demande',
        });
      case 'mission_tournee_modifiee':
        return this.buildMissionQuoteEmail({
          ref: 'M-2481',
          titre: 'Votre tournée a changé',
          intro:
            'Le trajet de cette mission a été modifié. Le détail ci-dessous est celui qui s\'applique désormais.',
          origin: 'Entrepôt Toulouse',
          destination: 'Client Muret',
          nbArrets: 4,
          startAt: new Date('2026-09-02T08:00:00Z'),
          endAt: new Date('2026-09-02T12:00:00Z'),
          amountCents: 16900,
          message: 'Deux livraisons ajoutées à la demande du client.',
          carrierName: 'MH Cars',
          url: `${appBase}/depot/missions`,
          libelleAction: 'Voir la mission',
        });
      case 'depot_incident':
        return this.buildDepotIncidentEmail({
          missionRef: 'M-2481',
          trajet: 'Fenouillet → Muret',
          plate: 'FR-482-BX',
          motif: 'Retard',
          message: "Le camion n'est pas arrivé sur le créneau annoncé. Le quai est bloqué à partir de 12 h.",
          nomDepot: 'Dépôt Fenouillet',
        });
      case 'password_reset':
        return this.buildPasswordResetEmail({
          recipientName: 'Camille',
          resetUrl: `${appBase}/reset?token=apercu`,
          expiresInMinutes: 30,
        });
      case 'device_verification':
        return this.buildDeviceVerificationEmail({
          recipientName: 'Camille',
          code: '482913',
          expiresInMinutes: 10,
          deviceLabel: 'Chrome · Windows',
        });
      case 'two_factor_disable':
        return this.buildTwoFactorDisableEmail({
          recipientName: 'Camille',
          code: '482913',
          expiresInMinutes: 10,
        });
      case 'audio_activation':
        return this.buildAudioActivationEmail({ fleetName, activatedBy: 'Julien Marchetti' });
      case 'audio_info':
        return this.buildAudioInfoEmail({ recipientName: 'Camille', fleetName });
      case 'installation_slot_requested':
        return this.buildInstallationSlotRequestedEmail({
          companyName: fleetName,
          slotLabel: 'lun. 7 juil., 08:00 – 10:00',
          clientName: 'Camille Bernard',
          clientEmail: 'camille.bernard@example.com',
          clientPhone: '+33 6 12 34 56 78',
          clientAddress: '12 rue des Fleurs, 31000 Toulouse',
          vehicle: 'AB-123-CD · Renault Kangoo · Diesel',
          notes: 'Disponible plutôt le matin.',
          manageUrl: `${appBase}/admin/installation-bookings`,
        });
      case 'installation_slot_confirmed':
        return this.buildInstallationSlotConfirmedEmail({
          companyName: fleetName,
          slotLabel: 'lun. 7 juil., 08:00 – 10:00',
          clientName: 'Camille',
          address: '12 rue des Fleurs, 31000 Toulouse',
        });
      case 'reservation_requested':
        return this.buildReservationRequestedEmail({
          fleetName,
          slotLabel: 'mar. 8 juil., 09:00 → 17:00',
          destination: 'Carcassonne',
          seats: 11,
        });
      case 'reservation_confirmed':
        return this.buildReservationConfirmedEmail({
          fleetName,
          slotLabel: 'mar. 8 juil., 09:00 → 17:00',
          destination: 'Carcassonne',
          vehicle: 'TE-001-ST',
        });
      case 'ai_invoice_request':
        return this.buildAiInvoiceRequestEmail({
          fleetName,
          requester: 'admin@societe.fr',
          vehicleCount: 12,
          monthlyLabel: '60,00 €',
        });
      case 'partner_consent_invitation':
        return this.buildPartnerConsentInvitationEmail({
          fleetName,
          partnerName: 'Maestroo',
          consentUrl: `${appBase}/api/integrations/partner/invite/apercu`,
          // Date FIXE : un aperçu qui change à chaque ouverture donne l'impression
          // d'un e-mail vivant alors qu'on regarde un gabarit.
          expiresAt: new Date('2026-01-15T18:00:00Z'),
        });
      case 'weekly_report':
        return {
          subject: `Rapport hebdomadaire — ${fleetName}`,
          html: this.buildWeeklyReportEmail({
            fromStr: '23/06/2026',
            toStr: '29/06/2026',
            tripsCount: 128,
            totalKm: 2340,
            alertsTotal: 14,
            liters: 287,
            costEur: 458,
            pdfName: 'rapport-semaine.pdf',
            // L'aperçu montre le bloc AVEC sa phrase — c'est le cas le plus fréquent en
            // production, et un aperçu qui l'omettrait laisserait croire qu'il n'existe pas.
            // La phrase passe par le MÊME constructeur que l'envoi réel : un exemple recopié
            // à la main aurait dérivé du jour où la vraie phrase change.
            unattributedNote: buildUnattributedNote({ tripCount: 112, distanceKm: 2016.4 }, 128),
          }),
          text: 'Aperçu du rapport hebdomadaire (données d’exemple).',
        };
      case 'error_rate_alert':
        return {
          subject: '47 erreurs en 1 h (dont 12 critiques)',
          html: this.buildErrorRateAlertEmail({
            total: 47,
            critical: 12,
            threshold: 5,
            top: [
              { source: 'engine-control', count: 21 },
              { source: 'sms-gateway', count: 18 },
              { source: 'gps-integrity', count: 8 },
            ],
            since: new Date(Date.now() - 60 * 60 * 1000),
          }),
          text: "Aperçu de l'alerte de saturation (données d'exemple).",
        };
      case 'alert':
        return {
          subject: 'Excès de vitesse détecté — TE-002-ST',
          html: this.buildAlertEmail({
            title: 'Excès de vitesse détecté',
            message: '142 km/h relevés sur une portion limitée à 110 km/h.',
            plate: 'TE-002-ST',
            severity: 'CRITICAL',
            createdAt: new Date(),
          }),
          text: 'Aperçu de l’alerte (données d’exemple).',
        };
      case 'lead':
        return {
          subject: 'Nouveau lead Tracky — SARL Delmas (25 véhicules)',
          html: this.shell({
            eyebrow: 'Lead · Prospect',
            footer: 'VIZYO TRACKY · NOTIFICATION INTERNE · LEADS',
            body: `
              <tr><td style="padding:26px 36px 0;">
                <h1 class="m-title" style="margin:0 0 4px;font-family:${EMAIL_FONT};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0A1311;">Nouveau prospect</h1>
                <p class="m-text" style="margin:0 0 20px;font-family:${EMAIL_FONT};font-size:14px;color:${EMAIL_TEXTE_SECOND};">Reçu à l'instant via la landing page</p>
              </td></tr>
              <tr><td style="padding:0 36px;">
                <table class="m-panel" role="presentation" width="100%" style="background:#F6F9F7;border:1px solid rgba(255,255,255,.07);border-radius:13px;">
                  <tr><td class="m-text" style="padding:12px 18px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};width:110px;">Nom</td><td class="m-title" style="padding:12px 18px;font-family:${EMAIL_FONT};font-size:14px;color:#0A1311;">Antoine Delmas</td></tr>
                  <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>
                  <tr><td class="m-text" style="padding:12px 18px;font-family:${EMAIL_FONT_MONO};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_TEXTE_SECOND};">Société</td><td class="m-title" style="padding:12px 18px;font-family:${EMAIL_FONT};font-size:14px;color:#0A1311;">SARL Delmas · <span style="color:${EMAIL_ACCENT_TEXTE};font-family:${EMAIL_FONT_MONO};font-size:13px;">25 véhicules</span></td></tr>
                </table>
              </td></tr>`,
          }),
          text: 'Aperçu du lead (données d’exemple).',
        };
      case 'lead_welcome':
        return this.buildLeadWelcomeEmail({
          recipientName: 'Camille Bernard',
          hubUrl: 'https://tracky.vizyoagency.com/decouvrir.html',
          tarifsUrl: 'https://tracky.vizyoagency.com/tarifs.html#simulateur',
          ficheUrl: 'https://tracky.vizyoagency.com/vizyo-tracky.pdf',
        });
      case 'quote_signed':
        return this.buildQuoteSignedAdminEmail({
          name: 'Antoine Delmas',
          email: 'antoine.delmas@example.com',
          phone: '+33 6 12 34 56 78',
          company: 'SARL Delmas',
          fleetSize: '25 véhicules',
          quoteText:
            'DEVIS AUTO-CONFIGURÉ — Tracky Pro (annuel renouvelable (tarif bloqué))\n25 véhicule(s) · Options : Live temps réel (15 s), Agent IA · Rétention : 1 an\nPar véhicule : 44,80 €/mois HT · Mensuel total : 1 120,00 € HT\n1re année (boîtier + install + abo) : 18 165 € · Années suivantes : 13 440 €\nÉconomies estimées : 5 000 – 10 000 €/an\nBon pour accord (devis indicatif, à confirmer par Vizyo).',
          managerUrl: 'https://manager.vizyoagency.com/services/leads',
        });
      case 'quote_client':
        return this.buildQuoteClientEmail({
          recipientName: 'Antoine Delmas',
          tarifsUrl: 'https://tracky.vizyoagency.com/tarifs.html#simulateur',
          hubUrl: 'https://tracky.vizyoagency.com/decouvrir.html',
          quoteText:
            'DEVIS AUTO-CONFIGURÉ — Tracky Pro (Sérénité — tout inclus, engagement 36 mois)\n25 véhicule(s) · Options : Live temps réel (20 s) · Rétention : 1 an\nPar véhicule : 365 €/an HT (soit 30,42 €/mois)\nTotal flotte : 9 125 €/an HT (soit 760,42 €/mois) — tout inclus : boîtier, SIM, pose, garantie\nÉconomies estimées : 5 000 – 10 000 €/an\nBon pour accord (devis indicatif, à confirmer par Vizyo).',
        });
      default:
        return {
          subject: 'Aperçu',
          html: this.shell({
            eyebrow: 'Aperçu',
            footer: 'VIZYO TRACKY',
            body: `<tr><td class="m-text" style="padding:26px 36px;font-family:${EMAIL_FONT};color:#56635E;">Modèle inconnu.</td></tr>`,
          }),
          text: '',
        };
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

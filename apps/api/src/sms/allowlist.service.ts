import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from '../observability/refroidissement-alerte.service';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

export interface AllowlistEntryDto {
  id: string;
  phone: string;
  label: string | null;
  source: string;
  createdAt: string;
}

export interface AllowlistSyncResult {
  added: number;
  removed: number;
  unchanged: number;
  skipped: number;
  /**
   * Suppressions RETENUES par la garde anti-suppression de masse de la passerelle
   * (V1.20). Optionnel : une passerelle anterieure au 2026-08-10 ne renvoie pas ce champ.
   *
   * ⚠️ TRK-025 — NE PAS S'EN SERVIR POUR ALERTER. Ce compteur ne concerne QUE la requête
   * qui vient d'être émise, et notre synchronisation ne demande jamais de suppression : il
   * vaut structurellement zéro. Les tentatives qui comptent viennent d'un tiers et ne se
   * lisent que dans le journal de la passerelle — cf. `remonterBlocagesPasserelle`.
   */
  removalsBlocked?: number;
}

/**
 * Une ligne du journal d'appels de la passerelle (`GET /v1/allowlist/audit`) — TRK-025.
 *
 * On n'y déclare que ce qu'on lit. Le journal en dit plus (numéros supprimés, compteurs
 * détaillés) ; y toucher depuis ici ferait dépendre l'API d'un schéma qu'elle ne possède pas.
 */
interface AllowlistAuditEntry {
  /** `'ok'` | `'removals_blocked'`. */
  outcome: string;
  createdAt: string;
  /** IP résolue après `trust proxy` — peut être celle du reverse proxy. */
  ip?: string | null;
  /** En-tête brut : la seule donnée fiable quand le proxy est mal réglé. */
  forwardedFor?: string | null;
  /** 8 premiers caractères de la clé utilisée — jamais la clé. */
  apiKeyPrefix?: string | null;
  route?: string | null;
  /** Numéros que l'appel voulait retirer et que la garde a retenus. */
  blockedPhones?: unknown[] | null;
}

export interface AllowlistStatus {
  entries: AllowlistEntryDto[];
  total: number;
  trackersWithSim: number;
  /** Trackers dont le simPhoneNumber n'est PAS dans l'allowlist (a synchroniser). */
  missing: { imei: string; phone: string }[];
  /** Entrees 'synced' sans tracker correspondant (SIM changee / tracker supprime). */
  orphans: { phone: string; label: string | null }[];
}

/**
 * V1.14 — Gere l'allowlist du tenant Tracky cote vizyo-texto, via son API
 * /v1/allowlist (auth api-key VIZYO_TEXTO_API_KEY), + la reconciliation avec
 * les SIM des trackers Tracky (source de verite).
 */
@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly errorLogger: ErrorLogger,
    private readonly systemActivity: SystemActivityService,
    // Refroidissements d'alerte — ObservabilityModule est @Global, aucun import a ajouter.
    private readonly refroidissement: RefroidissementAlerteService,
  ) {
    this.baseUrl = (this.config.get('VIZYO_TEXTO_URL', { infer: true }) ?? '').replace(/\/+$/, '');
    this.apiKey = this.config.get('VIZYO_TEXTO_API_KEY', { infer: true }) ?? '';
  }

  // ─── Auto-sync sur changement de SIM tracker ──────────────────────────────
  private syncing = false;
  private syncPending = false;

  /**
   * Reconcilie l'allowlist quand un tracker.simPhoneNumber change (event).
   * Coalesce les rafales (si un sync tourne deja, re-run a la fin) ; best-effort
   * (si vizyo-texto est down, on log et on abandonne — un sync manuel ou un
   * prochain event reconciliera).
   */
  @OnEvent('tracker.sim-changed')
  async onTrackerSimChanged(): Promise<void> {
    if (!this.baseUrl || !this.apiKey || this.syncing) {
      if (this.syncing) this.syncPending = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncPending = false;
        await this.syncFromTrackers();
      } while (this.syncPending);
    } catch (err) {
      this.logger.warn(`auto-sync allowlist échoué: ${err instanceof Error ? err.message : err}`);
      // A6 — persiste l'echec dans ErrorLog pour visibilite.
      this.errorLogger.record(
        err instanceof Error ? err : new Error(String(err)),
        'sms-allowlist',
        { trigger: 'auto-sync' },
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Réconciliation PÉRIODIQUE de l'allowlist (toutes les heures).
   *
   * Jusqu'ici la synchro ne partait QUE sur `tracker.sim-changed`. Un seul événement manqué —
   * vizyo-texto injoignable à cet instant, SIM saisie avant l'existence de l'auto-synchro, échec
   * réseau silencieux — et le numéro n'entrait jamais dans l'allowlist. Rien ne le rattrapait, et
   * rien ne le signalait : le symptôme n'apparaissait qu'au pire moment, un 403 « hors allowlist »
   * au moment d'un repli SMS de coupe-circuit.
   *
   * Constat prod 2026-07-27 : 9 SIM de boîtiers sur 39 étaient absentes de l'allowlist — le repli
   * SMS était donc MORT pour ces véhicules, en silence.
   *
   * Idempotent (le PUT /sync reconcilie la liste entière) et non bloquant. Une dérive RÉELLEMENT
   * corrigée est remontée au centre d'alerte : elle signale que des SMS n'auraient pas pu partir.
   */
  @Cron('0 25 * * * *')
  async reconcilePeriodically(): Promise<void> {
    if (!this.baseUrl || !this.apiKey || this.syncing) return;
    this.syncing = true;
    try {
      const result = await this.syncFromTrackers();

      // ── Preuve d'exécution — inconditionnelle ────────────────────────────────
      // Jusqu'au 2026-08-10, un passage qui ne changeait rien n'écrivait RIEN. Impossible
      // donc de distinguer « a tourné, tout allait bien » de « n'a pas tourné » : l'audit
      // TRK-017 a mis deux passages à trancher cette seule question. Une trace par
      // exécution, même à zéro, la rend lisible en une requête.
      // Volontairement au journal système (consultable) et PAS au centre d'alerte : une
      // exécution normale n'est pas une faute.
      this.systemActivity.record({
        category: 'SMS',
        action: 'allowlist_reconciled',
        status: 'SUCCESS',
        actor: 'system',
        detail: `+${result.added} / -${result.removed} (${result.unchanged} inchangés)`,
        meta: { ...result, episodeRepairs: this.episodeRepairs },
      });

      await this.reportCoverage(result);
    } catch (err) {
      this.logger.warn(`reconciliation allowlist échouée: ${err instanceof Error ? err.message : err}`);
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'sms-allowlist',
        { trigger: 'reconcile-cron' },
      );
    } finally {
      this.syncing = false;
    }
  }

  // ─── État de l'épisode de couverture en cours ──────────────────────────────
  /** Instant d'ouverture de l'épisode courant (trou de couverture non refermé durablement). */
  private episodeOpenedAt: number | null = null;
  /** Nombre de réparations depuis l'ouverture de l'épisode. */
  private episodeRepairs = 0;
  /** Dernière remontée au centre d'alerte pour cet épisode. */
  // TRK-038 — refroidissement EN BASE. L'episode, lui, reste en memoire : il decrit un
  // etat courant, pas une derniere emission.
  /** Un état qui dure se CONSULTE ; on ne le re-notifie qu'une fois par jour. */
  private static readonly EPISODE_REMINDER_MS = 24 * 60 * 60 * 1000;

  /**
   * Décide de ce qui mérite le centre d'alerte, et de ce qui n'y a pas sa place.
   *
   * Le défaut d'origine : une ligne d'erreur à CHAQUE réparation. En régime normal ça ne
   * se voyait pas ; le 2026-08-10, un tiers effaçant l'allowlist plusieurs fois par jour a
   * produit six lignes identiques en dix-neuf heures — six fois le même fait, aucune
   * information nouvelle après la première. *Un état qui dure se consulte, il ne se notifie
   * pas en boucle.*
   *
   * ⚠️ Ce qui n'est PAS fait ici, exprès : rien n'est rendu muet. Le premier trou d'un
   * épisode alerte toujours, immédiatement ; un épisode qui persiste réalerte chaque jour ;
   * et la fermeture est tracée. On corrige le cri, pas le garde-fou.
   */
  // TRK-038 — devenue `async` : le refroidissement de l'episode vit maintenant en base et
  // non dans un champ d'instance, donc sa lecture est une requete. L'appelant l'attend.
  private async reportCoverage(result: AllowlistSyncResult, now = Date.now()): Promise<void> {
    // ══ TRK-025 — LA REMONTÉE LISAIT LE MAUVAIS COMPTEUR ═══════════════════════════════
    //
    // Cette branche existait depuis le 10/08 et n'a jamais rien écrit. Elle lisait
    // `result.removalsBlocked`, c'est-à-dire la réponse à la synchronisation que CETTE API
    // vient d'émettre — or cette synchronisation ne demande JAMAIS de suppression (le
    // journal système le montre à chaque heure : `-0`). La passerelle n'a donc rien à
    // retenir pour cette requête-là, et le champ vaut structurellement **zéro**.
    //
    // Les suppressions qui comptent sont celles d'un TIERS porteur de la clé de production
    // (49 tentatives entre le 10 et le 17/08, toutes depuis 82.67.153.51). Elles n'existent
    // que dans `allowlist_audit_logs` **côté passerelle** — table qu'aucun code de l'API ne
    // lisait. On va donc la chercher.
    //
    // 🔑 *Un canal qui n'écrit jamais ressemble exactement à un canal sur lequel rien
    // n'arrive.* C'est ce qui a rendu ce défaut invisible pendant sept jours : le garde-fou
    // fonctionnait parfaitement (42 numéros intacts), et son silence passait pour du calme.
    await this.remonterBlocagesPasserelle(now);

    if (result.added === 0) {
      // Couverture complète. Si un épisode était ouvert, il se referme : on le trace au
      // journal système (pas au centre d'alerte — une bonne nouvelle n'est pas une faute).
      if (this.episodeOpenedAt !== null) {
        const hours = Math.round((now - this.episodeOpenedAt) / 36e5);
        this.systemActivity.record({
          category: 'SMS',
          action: 'allowlist_episode_closed',
          status: 'SUCCESS',
          actor: 'system',
          detail: `Couverture SMS rétablie durablement après ${this.episodeRepairs} réparation(s) sur ~${hours} h`,
          meta: { repairs: this.episodeRepairs, hours },
        });
        this.episodeOpenedAt = null;
        this.episodeRepairs = 0;
        // L'episode se referme : on OUBLIE le refroidissement. Ce qui rouvrira ensuite est un
        // fait NOUVEAU, et le taire au motif qu'on a crie pendant l'episode precedent serait faux.
        await this.refroidissement.oublier(CLES_REFROIDISSEMENT.ALLOWLIST_EPISODE);
      }
      return;
    }

    // Des numéros manquaient : ils ne pouvaient PAS recevoir de SMS (403 côté passerelle,
    // levé avant toute écriture — donc sans laisser la moindre trace ailleurs).
    this.episodeRepairs += 1;
    const isNewEpisode = this.episodeOpenedAt === null;
    if (isNewEpisode) this.episodeOpenedAt = now;
    const openedAt = this.episodeOpenedAt ?? now;

    const derniereAlerteAt = await this.refroidissement.derniereEmission(CLES_REFROIDISSEMENT.ALLOWLIST_EPISODE);
    const dueForReminder =
      !derniereAlerteAt || now - derniereAlerteAt.getTime() >= AllowlistService.EPISODE_REMINDER_MS;
    if (!isNewEpisode && !dueForReminder) {
      this.logger.warn(
        `Allowlist SMS : ${result.added} numéro(s) rétablis (réparation n°${this.episodeRepairs} ` +
          `de l'épisode en cours) — déjà signalé, pas de nouvelle ligne au centre d'alerte.`,
      );
      return;
    }
    await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.ALLOWLIST_EPISODE);

    const recurrence =
      this.episodeRepairs > 1
        ? ` Le trou se ROUVRE : ${this.episodeRepairs} réparations depuis ${new Date(openedAt).toISOString()} — ` +
          `quelque chose retire ces numéros entre deux réconciliations (journal des appels de la passerelle).`
        : '';

    this.errorLogger.recordBackground(
      `Allowlist SMS incomplète : ${result.added} numéro(s) manquant(s) rétabli(s) — le repli SMS ` +
        `(coupe-circuit, notifications) était inopérant pour ces destinataires.${recurrence}`,
      'sms-allowlist',
      {
        trigger: 'reconcile-cron',
        added: result.added,
        removed: result.removed,
        episodeRepairs: this.episodeRepairs,
        episodeOpenedAt: new Date(openedAt).toISOString(),
      },
    );
  }

  /**
   * TRK-025 — va LIRE, chez la passerelle, les suppressions de masse qu'elle a retenues.
   *
   * ── Pourquoi une lecture, et pas un compteur rendu par la synchronisation ───────────
   * Le correctif du 10/08 remontait `removalsBlocked`, le compteur de la réponse à NOTRE
   * synchronisation. Mais notre synchronisation ne demande jamais de suppression : ce
   * compteur ne pouvait pas être autre chose que zéro. Les tentatives qui comptent viennent
   * d'un tiers, et ne laissent de trace que dans le journal de la passerelle.
   *
   * ── Fenêtre et cadence ──────────────────────────────────────────────────────────────
   * On regarde les 24 dernières heures et on remonte UNE fois, puis une fois par jour tant
   * que ça dure. Un épisode se compte en dizaines de tentatives horaires (49 entre le 10 et
   * le 17/08) : une ligne par tentative répéterait quarante-neuf fois le même fait, ce qui
   * est précisément le défaut d'origine de [TRK-017]. *Un état qui dure se consulte ; il ne
   * se notifie pas en boucle.*
   *
   * ⚠️ NE LÈVE JAMAIS, et ne doit pas. Cette lecture s'exécute au milieu du cron de
   * réconciliation : une passerelle injoignable ne doit pas empêcher la réconciliation
   * elle-même de se terminer — c'est elle qui répare la couverture SMS. Un échec de lecture
   * laisse donc l'alerte muette, ce qui est un moindre mal, ET il est journalisé.
   *
   * ⚠️ On alerte sur la TENTATIVE, pas sur un dégât : la garde a tenu, aucun numéro n'a été
   * perdu. C'est bien le sujet — quelqu'un a demandé le retrait du repli SMS pour une large
   * part du parc, et personne ne le savait.
   */
  private async remonterBlocagesPasserelle(now: number): Promise<void> {
    if (!this.baseUrl || !this.apiKey) return;
    try {
      const journal = await this.call<AllowlistAuditEntry[]>('/v1/allowlist/audit?limit=200');
      if (!Array.isArray(journal)) return;

      const depuis = now - 24 * 60 * 60 * 1000;
      const blocages = journal.filter(
        (l) => l?.outcome === 'removals_blocked' && new Date(l.createdAt).getTime() >= depuis,
      );
      if (blocages.length === 0) return;

      // Une seule alerte par épisode, puis un rappel quotidien tant qu'il dure.
      const doitCrier = await this.refroidissement.tenterEmission(
        CLES_REFROIDISSEMENT.ALLOWLIST_SUPPRESSIONS_BLOQUEES,
        AllowlistService.EPISODE_REMINDER_MS,
      );
      if (!doitCrier) return;

      // Le plus récent porte l'appelant ; c'est lui qu'on nomme.
      const dernier = blocages[0]!;
      const nbNumeros = Array.isArray(dernier.blockedPhones) ? dernier.blockedPhones.length : null;
      const appelant = dernier.forwardedFor ?? dernier.ip ?? 'origine inconnue';

      this.errorLogger.recordBackground(
        `Allowlist SMS : ${blocages.length} tentative(s) de suppression de masse retenues par la ` +
          `passerelle sur 24 h — appelant ${appelant}` +
          (dernier.apiKeyPrefix ? ` (clé ${dernier.apiKeyPrefix})` : '') +
          `. ` +
          (nbNumeros != null
            ? `La dernière aurait retiré le repli SMS à ${nbNumeros} destinataire(s). `
            : '') +
          `Aucun numéro n'a été perdu — la garde a tenu. Vérifier le journal des appels de la ` +
          `passerelle avant de débloquer quoi que ce soit.`,
        'sms-allowlist',
        {
          trigger: 'reconcile-cron',
          tentatives24h: blocages.length,
          appelant,
          ip: dernier.ip ?? undefined,
          apiKeyPrefix: dernier.apiKeyPrefix ?? undefined,
          route: dernier.route ?? undefined,
          numerosVises: nbNumeros ?? undefined,
          premiere: blocages[blocages.length - 1]?.createdAt ?? undefined,
          derniere: dernier.createdAt,
        },
      );
    } catch (err) {
      // Journalisé, jamais propagé : la réconciliation doit aller au bout.
      this.logger.warn(
        `TRK-025 : lecture du journal d'allowlist impossible — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.baseUrl || !this.apiKey) {
      throw new ServiceUnavailableException(
        'vizyo-texto non configure (VIZYO_TEXTO_URL / VIZYO_TEXTO_API_KEY)',
      );
    }
    let res: Response;
    try {
      // B3 — timeout 10s pour ne pas rester pendu si le relay hang.
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`vizyo-texto injoignable (${path}): ${msg}`);
      throw new ServiceUnavailableException(`vizyo-texto injoignable : ${msg}`);
    }
    // B5 — si le JSON est malformé, throw au lieu de retourner un objet vide corrompu.
    let jsonParseOk = true;
    const data = (await res.json().catch(() => { jsonParseOk = false; return {}; })) as T & { message?: string };
    if (!res.ok) {
      throw new ServiceUnavailableException(data.message ?? `vizyo-texto HTTP ${res.status}`);
    }
    if (!jsonParseOk) {
      throw new ServiceUnavailableException('vizyo-texto: response body malformé (JSON invalide)');
    }
    return data;
  }

  list(): Promise<AllowlistEntryDto[]> {
    return this.call<AllowlistEntryDto[]>('/v1/allowlist');
  }

  add(phone: string, label?: string): Promise<AllowlistEntryDto> {
    return this.call<AllowlistEntryDto>('/v1/allowlist', {
      method: 'POST',
      body: JSON.stringify({ phone, label }),
    });
  }

  remove(phone: string): Promise<{ removed: boolean }> {
    return this.call<{ removed: boolean }>(`/v1/allowlist/${encodeURIComponent(phone)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Pousse vers l'allowlist vizyo-texto (source='synced') :
   *   - les `simPhoneNumber` des trackers (label `Tracker <imei>`)
   *   - les `User.phone` des utilisateurs actifs (label `User <email>`) — requis
   *     pour que les notifications SMS d'alerte (V1.15) soient livrees : sans ca
   *     vizyo-texto renvoie 403 sur un numero non-allowliste.
   * Dedup par numero ; un tracker prime sur un user en cas de meme numero.
   */
  /**
   * E.164 : l'inventaire WhereverSIM stocke le MSISDN SANS le signe plus, alors
   * que simPhoneNumber et l'allowlist le portent. Sans cette normalisation on
   * pousserait 345901035259762, que vizyo-texto ne reconnaîtrait pas comme le
   * même numéro que +345901035259762 — deux entrées pour une seule puce, et un
   * 403 malgré une allowlist « à jour ».
   */
  private e164(numero: string): string {
    const net = numero.trim().replace(/[\s.-]/g, '');
    return net.startsWith('+') ? net : `+${net}`;
  }

  /**
   * Les numéros à autoriser, UN PAR BOÎTIER CONNU.
   *
   * ── POURQUOI L'INVENTAIRE SIM FAIT AUTORITÉ SUR LA FICHE BOÎTIER ─────────────
   *
   * Le champ simPhoneNumber est une SAISIE : quelqu'un tape le numéro en créant
   * la fiche. Quand on change la puce d'un boîtier sans retoucher la fiche, ce
   * champ garde l'ancien numéro — ou reste vide — et le nouveau n'entre JAMAIS
   * dans l'allowlist. Tout SMS vers ce boîtier part alors en 403.
   *
   * C'est exactement ce qui s'est produit : du 19 au 25 juillet 2026, 1476 SMS
   * rejetés « hors allowlist du tenant », sur des puces pourtant actives chez
   * l'opérateur. Et le 18 août, trois puces activées les 14-15 août étaient
   * encore absentes de l'allowlist — dont celles de deux véhicules en service.
   *
   * L'inventaire des puces, lui, est synchronisé depuis l'API WhereverSIM toutes
   * les heures et porte le couple msisdn vers imei : il sait quelle puce est
   * PHYSIQUEMENT dans quel boîtier. On le prend donc comme source, et la saisie
   * manuelle ne sert plus que de repli.
   *
   * ⚠️ ON NE PREND QUE LES BOÎTIERS DÉJÀ EN BASE. Une puce activée dont le boîtier
   * n'est pas déclaré n'entre pas : ouvrir l'allowlist à tout le parc SIM
   * élargirait la surface d'envoi à des équipements dont on ignore où ils sont.
   * Le trou se referme en déclarant le boîtier, pas en baissant la garde.
   */
  private async numerosDesBoitiers(options: { recaler: boolean }): Promise<Map<string, string>> {
    const trackers = await this.prisma.tracker.findMany({
      select: { id: true, imei: true, simPhoneNumber: true },
    });
    const puces = await this.prisma.sim.findMany({
      where: { imei: { in: trackers.map((t) => t.imei) }, msisdn: { not: null } },
      select: { imei: true, msisdn: true },
    });
    const puceParImei = new Map(puces.map((s) => [s.imei as string, s.msisdn as string]));

    const parNumero = new Map<string, string>();
    const aRecaler: { id: string; imei: string; avant: string | null; apres: string }[] = [];

    for (const t of trackers) {
      const depuisInventaire = puceParImei.get(t.imei);
      const numero = depuisInventaire ? this.e164(depuisInventaire) : t.simPhoneNumber;
      if (!numero) continue;
      parNumero.set(numero, `Tracker ${t.imei}`);
      if (depuisInventaire && t.simPhoneNumber !== numero) {
        aRecaler.push({ id: t.id, imei: t.imei, avant: t.simPhoneNumber, apres: numero });
      }
    }

    /**
     * On RECOPIE le numéro trouvé sur la fiche boîtier — sinon l'écran admin
     * continuerait d'afficher l'ancien pendant que les SMS partent vers le bon.
     *
     * ⚠️ MAIS SEULEMENT DEPUIS LA SYNCHRO, JAMAIS DEPUIS status(). Ce dernier sert
     * un GET que l'écran admin appelle à chaque affichage : y écrire ferait muter
     * la base et remplir le journal au simple fait de REGARDER un tableau de bord,
     * y compris pour un lecteur sans droit d'écriture. Un GET ne modifie rien.
     */
    if (!options.recaler) return parNumero;
    for (const r of aRecaler) {
      await this.prisma.tracker.update({ where: { id: r.id }, data: { simPhoneNumber: r.apres } });
      this.systemActivity.record({
        category: 'SMS',
        action: 'tracker_sim_recalee',
        status: 'SUCCESS',
        actor: 'system',
        detail: `Boîtier ${r.imei} : numéro SIM ${r.avant ?? '(vide)'} → ${r.apres}, d'après l'inventaire WhereverSIM.`,
        meta: { imei: r.imei, avant: r.avant, apres: r.apres, source: 'wherever-sim' },
      });
      this.logger.log(`Tracker ${r.imei} : simPhoneNumber recale ${r.avant ?? '(vide)'} -> ${r.apres}`);
    }
    return parNumero;
  }

  async syncFromTrackers(): Promise<AllowlistSyncResult> {
    const [numerosBoitiers, users] = await Promise.all([
      this.numerosDesBoitiers({ recaler: true }),
      this.prisma.user.findMany({
        where: { phone: { not: null }, isActive: true },
        select: { email: true, phone: true },
      }),
    ]);
    const byPhone = new Map<string, string>(numerosBoitiers);
    for (const u of users) {
      const phone = u.phone as string;
      if (!byPhone.has(phone)) byPhone.set(phone, `User ${u.email}`);
    }
    const entries = Array.from(byPhone, ([phone, label]) => ({ phone, label }));
    const result = await this.call<AllowlistSyncResult>('/v1/allowlist/sync', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    });
    // Journal Système — des numéros GAGNENT/PERDENT le droit de recevoir des SMS
    // (effet réel côté vizyo-texto). Silencieux quand rien ne change (sync no-op).
    if (result.added > 0 || result.removed > 0) {
      this.systemActivity.record({
        category: 'SMS',
        action: 'allowlist_synced',
        status: 'SUCCESS',
        actor: 'system',
        detail: `+${result.added} / -${result.removed} numéro(s) (${result.unchanged} inchangés)`,
        meta: { added: result.added, removed: result.removed, unchanged: result.unchanged, skipped: result.skipped },
      });
    }
    return result;
  }

  /**
   * Reconciliation : boitiers non synces + entrees orphelines.
   *
   * ⚠️ CET ETAT DOIT SE CALCULER SUR LA MEME SOURCE QUE `syncFromTrackers()`.
   * S'il regardait encore `simPhoneNumber` seul, l'ecran admin annoncerait
   * « rien a synchroniser » pendant que le sync, lui, ajouterait des numeros —
   * et l'exploitant conclurait que l'ecran est casse. Un tableau de bord qui
   * mesure autre chose que ce que fait le systeme est pire qu'un tableau absent.
   */
  async status(): Promise<AllowlistStatus> {
    const [entries, numerosBoitiers, users] = await Promise.all([
      this.list(),
      this.numerosDesBoitiers({ recaler: false }),
      this.prisma.user.findMany({
        where: { phone: { not: null }, isActive: true },
        select: { phone: true },
      }),
    ]);
    const trackers = Array.from(numerosBoitiers, ([phone, label]) => ({
      imei: label.replace(/^Tracker /, ''),
      simPhoneNumber: phone,
    }));
    const allowed = new Set(entries.map((e) => e.phone));
    const trackerPhones = new Set(trackers.map((t) => t.simPhoneNumber));
    // V1.15 — les User.phone actifs sont aussi des numéros legitimes (notifs SMS
    // d'alerte) synces par syncFromTrackers() : on les considere "connus" pour ne
    // pas les remonter comme orphelins (sinon un admin les supprimerait a tort).
    const knownPhones = new Set<string>([
      ...trackerPhones,
      ...users.map((u) => u.phone as string),
    ]);

    const missing = trackers
      .filter((t) => !allowed.has(t.simPhoneNumber))
      .map((t) => ({ imei: t.imei, phone: t.simPhoneNumber }));

    const orphans = entries
      .filter((e) => e.source === 'synced' && !knownPhones.has(e.phone))
      .map((e) => ({ phone: e.phone, label: e.label }));

    return { entries, total: entries.length, trackersWithSim: trackers.length, missing, orphans };
  }
}

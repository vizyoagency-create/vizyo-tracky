import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import type { EnvoisSocieteDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/**
 * ══ LE GARDE-FOU D'ENVOI (30/09) ═══════════════════════════════════════════════════════════
 *
 * Le 24/09, une demande de RECETTE déposée par le lien public du VRAI client a envoyé l'avis
 * « demande à valider » à cinq personnes de cdef31 : rien, dans le code, ne distinguait un essai
 * d'une vraie demande.
 *
 * Deux protections, une seule question — « ce message peut-il partir ? » — posée avant chaque
 * envoi par `EmailService.send` (courriel) et par le notifier des réservations publiques (SMS au
 * demandeur, push « demande à valider » à l'équipe) :
 *
 *  1. LISTE BLANCHE (`EMAIL_LISTE_BLANCHE`, vide en prod ET sur la démo, qui invite des prospects) :
 *     sur un poste de dev muni d'une vraie clé, seuls ces destinataires reçoivent un courriel ; les
 *     autres sont RETENUS.
 *  2. MODE RECETTE D'UNE SOCIÉTÉ (`Fleet.envoisSuspendusJusqua`) : un super-admin qui va tester
 *     chez un vrai client retient, pour quelques heures, les avis que ses essais déclenchent —
 *     réservations, demandes du lien public, missions, dépôt — en courriel, en SMS et en push. Il expire
 *     SEUL : un oubli ne coupe jamais les avis pour de bon. Les courriels de compte (mot de passe,
 *     appareil, invitation), les alertes et le rapport hebdomadaire ne sont JAMAIS retenus.
 *
 * Un message retenu n'est pas une erreur : rien à rejouer. Il est journalisé (`EmailStatus.BLOCKED`,
 * journal système) pour prouver ce qui serait parti — et que rien n'est parti.
 */
export const MODELES_RETENUS_EN_RECETTE: ReadonlySet<string> = new Set([
  'reservation_requested',
  'reservation_request_pending',
  'reservation_confirmed',
  'reservation_refused',
  'mission_request',
  'mission_assigned',
  'mission_tournee_modifiee',
  'depot_incident',
]);

/** Durée maximale d'un mode recette : une séance de tests, jamais une coupure durable. */
export const RECETTE_HEURES_MAX = 24;
/** La société est relue au plus toutes les 15 s : un envoi par lot n'interroge pas la base à chaque ligne. */
const CACHE_MS = 15_000;

export interface ListeBlanche {
  adresses: Set<string>;
  domaines: string[];
}

/** « @demo.vizyoagency.com, admin@x.fr » → domaines et adresses ; vide → `null` (aucune restriction). */
export function lireListeBlanche(brut: string | undefined | null): ListeBlanche | null {
  const morceaux = (brut ?? '')
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (morceaux.length === 0) return null;
  const adresses = new Set<string>();
  const domaines: string[] = [];
  for (const e of morceaux) {
    if (e.startsWith('@')) {
      if (e.length > 1) domaines.push(e.slice(1));
    } else {
      adresses.add(e);
    }
  }
  return { adresses, domaines };
}

/**
 * Le destinataire est-il dans la liste ? Adresse exacte, ou domaine EXACT (« @vizyoagency.com »
 * n'ouvre pas « demo.vizyoagency.com » : chaque domaine se nomme). « Nom <adresse> » : on juge
 * l'adresse.
 */
export function dansLaListeBlanche(liste: ListeBlanche, destinataire: string): boolean {
  const brut = destinataire.trim().toLowerCase();
  const chevrons = /<([^>]+)>/.exec(brut);
  const adresse = (chevrons ? chevrons[1] : brut).trim();
  if (!adresse) return false;
  if (liste.adresses.has(adresse)) return true;
  const at = adresse.lastIndexOf('@');
  if (at < 0) return false;
  return liste.domaines.includes(adresse.slice(at + 1));
}

const HEURE_PARIS = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
/** « 30/09 12:40 » (heure de Paris). */
export const heureParis = (ms: number): string => HEURE_PARIS.format(ms).replace(',', '');

@Injectable()
export class GardeFouEnvoisService {
  private readonly logger = new Logger(GardeFouEnvoisService.name);
  private readonly liste: ListeBlanche | null;
  private readonly cache = new Map<string, { jusqua: number | null; lu: number }>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    @Optional() private readonly systemActivity?: SystemActivityService,
  ) {
    this.liste = lireListeBlanche(config.get('EMAIL_LISTE_BLANCHE', { infer: true }));
    if (this.liste) {
      const vue = [...this.liste.adresses, ...this.liste.domaines.map((d) => `@${d}`)].join(', ');
      this.logger.warn(`Garde-fou d'envoi : liste blanche ACTIVE (${vue}) — tout autre destinataire est RETENU.`);
    }
  }

  /** Vrai sur un poste de dev configuré : tout destinataire hors liste est retenu. */
  listeBlancheActive(): boolean {
    return this.liste !== null;
  }

  /**
   * Ce message peut-il partir ? `null` = oui ; sinon le MOTIF, en toutes lettres, pour le journal.
   *
   * Ne lève jamais : une panne de lecture de la société laisse partir — le garde-fou ne doit pas
   * devenir, lui, une coupure des avis. La liste blanche ne juge que les COURRIELS (les postes de dev
   * n'ont pas de passerelle SMS réelle) ; le mode recette juge les deux canaux.
   */
  async motifDeRetenue(p: {
    canal: 'email' | 'sms' | 'push';
    destinataire: string;
    fleetId?: string | null;
    modele?: string | null;
  }): Promise<string | null> {
    if (this.liste && p.canal === 'email') {
      // Plusieurs destinataires séparés par des virgules : TOUS doivent être dans la liste.
      const liste = this.liste;
      const destinataires = p.destinataire.split(',').map((d) => d.trim()).filter(Boolean);
      if (destinataires.length === 0 || destinataires.some((d) => !dansLaListeBlanche(liste, d))) {
        return 'destinataire hors liste blanche (EMAIL_LISTE_BLANCHE)';
      }
    }
    if (p.fleetId && p.modele && MODELES_RETENUS_EN_RECETTE.has(p.modele)) {
      const jusqua = await this.recetteJusqua(p.fleetId);
      if (jusqua !== null && jusqua > Date.now()) return `société en mode recette jusqu'au ${heureParis(jusqua)}`;
    }
    return null;
  }

  private async recetteJusqua(fleetId: string): Promise<number | null> {
    const c = this.cache.get(fleetId);
    if (c && Date.now() - c.lu < CACHE_MS) return c.jusqua;
    try {
      const f = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { envoisSuspendusJusqua: true } });
      const jusqua = f?.envoisSuspendusJusqua ? f.envoisSuspendusJusqua.getTime() : null;
      this.cache.set(fleetId, { jusqua, lu: Date.now() });
      return jusqua;
    } catch (e) {
      this.logger.warn(`mode recette de ${fleetId} illisible (${(e as Error)?.message ?? e}) — l'envoi part`);
      return null;
    }
  }

  /** Un SMS au demandeur RETENU (mode recette) : une ligne au journal système, numéro masqué. */
  noterSmsRetenu(p: { numero: string; fleetId: string | null; modele: string | null; motif: string }): void {
    const chiffres = p.numero.replace(/\D/g, '');
    this.systemActivity?.record({
      category: 'SMS',
      action: 'sms_retenu',
      status: 'SKIPPED',
      actor: 'system',
      target: chiffres.length > 4 ? `•••${chiffres.slice(-4)}` : '•••',
      fleetId: p.fleetId,
      detail: `SMS au demandeur retenu : ${p.motif}`,
      meta: { template: p.modele, motif: p.motif },
    });
  }

  /** Le push « demande à valider » RETENU (mode recette) : une ligne au journal système. */
  noterPushRetenu(p: { destinataires: number; fleetId: string | null; modele: string; motif: string }): void {
    this.systemActivity?.record({
      category: 'PUSH',
      action: 'push_retenu',
      status: 'SKIPPED',
      actor: 'system',
      target: `${p.destinataires} destinataire(s)`,
      fleetId: p.fleetId,
      detail: `Notification push retenue : ${p.motif}`,
      meta: { template: p.modele, motif: p.motif, destinataires: p.destinataires },
    });
  }

  /** L'état du mode recette d'une société — le bandeau de l'agenda. Sa société, ou toutes pour un super-admin. */
  async etat(user: AuthUser, fleetId: string): Promise<EnvoisSocieteDto> {
    if (user.role !== UserRole.SUPER_ADMIN && user.fleetId !== fleetId) throw new NotFoundException('Société introuvable');
    const f = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { envoisSuspendusJusqua: true } });
    if (!f) throw new NotFoundException('Société introuvable');
    const j = f.envoisSuspendusJusqua;
    return { suspendusJusqua: j && j.getTime() > Date.now() ? j.toISOString() : null };
  }

  /**
   * Super-admin : retenir les avis de la société pendant `heures` (1 à 24), ou les rétablir (`null`).
   * UNE ligne au journal de la société : elle voit, dans son Activité, qui a retenu ses avis et jusqu'à
   * quand — et quand ils repartent.
   */
  async regler(user: AuthUser, fleetId: string, heures: number | null): Promise<EnvoisSocieteDto> {
    if (user.role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('Réservé aux super-administrateurs.');
    if (heures !== null && (!Number.isInteger(heures) || heures < 1 || heures > RECETTE_HEURES_MAX)) {
      throw new BadRequestException(`Durée invalide : de 1 à ${RECETTE_HEURES_MAX} heures.`);
    }
    const f = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: { name: true, envoisSuspendusJusqua: true },
    });
    if (!f) throw new NotFoundException('Société introuvable');
    const maintenant = Date.now();
    const etaitActif = !!f.envoisSuspendusJusqua && f.envoisSuspendusJusqua.getTime() > maintenant;
    const jusqua = heures === null ? null : new Date(maintenant + heures * 3_600_000);
    await this.prisma.fleet.update({ where: { id: fleetId }, data: { envoisSuspendusJusqua: jusqua } });
    this.cache.delete(fleetId);
    if (jusqua || etaitActif) {
      try {
        this.systemActivity?.record({
          category: 'AGENDA',
          action: jusqua ? 'envois_suspendus' : 'envois_retablis',
          status: 'SUCCESS',
          actor: 'utilisateur',
          target: f.name,
          fleetId,
          triggeredByUserId: user.id,
          detail: jusqua
            ? `Mode recette : les avis de réservation et de mission (courriel, SMS et notification) sont retenus jusqu'au ${heureParis(jusqua.getTime())}.`
            : 'Mode recette levé : les avis de réservation et de mission partent de nouveau.',
          meta: { jusqua: jusqua?.toISOString() ?? null, heures },
        });
      } catch (e) {
        this.logger.warn(`journal du mode recette non écrit : ${(e as Error)?.message ?? e}`);
      }
    }
    return { suspendusJusqua: jusqua ? jusqua.toISOString() : null };
  }
}

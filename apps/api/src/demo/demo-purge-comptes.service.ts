import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuthAccountSyncService } from '../users/auth-account-sync.service';
import { DemoModeService } from './demo-mode.service';

/**
 * ═══ PURGE DES COMPTES DE DÉMONSTRATION DORMANTS ════════════════════════════════════════════
 *
 * On annonce au prospect que son accès ne dure pas. Une annonce qui n'est pas tenue vaut moins
 * que pas d'annonce du tout : ce service est ce qui la rend vraie.
 *
 * ── CE QUE « PURGER » VEUT DIRE ICI, ET POURQUOI PAS UN `DELETE` ────────────────────────────
 *
 * Supprimer la LIGNE serait un contresens sur deux plans. D'abord elle est retenue par deux
 * clés étrangères `Restrict` (`Invitation.createdBy`, `MissionShare.requestedBy`), qu'il
 * faudrait défaire une à une. Ensuite et surtout, la suppression emporterait en cascade
 * l'activité du prospect — or c'est précisément ce que l'exploitant garde pour savoir qui est
 * venu voir la démonstration et ce qu'il y a regardé. On détruirait la trace commerciale au
 * nom de la protection de la personne, alors que les deux se concilient.
 *
 * On fait donc les trois gestes qui comptent vraiment :
 *
 *   1. **Suspension dans Vizyo Auth** — c'est le seul geste qui empêche RÉELLEMENT de se
 *      reconnecter. Passer `isActive` à faux sans lui laisserait le mot de passe valide chez
 *      le fournisseur d'identité ; c'est l'écart qui avait fait croire pendant des mois qu'un
 *      compte « archivé » l'était (voir le commentaire de `UsersController.archive`).
 *   2. **Effacement des données personnelles** — l'adresse, le nom et le prénom sont
 *      remplacés. Il ne reste plus rien qui désigne quelqu'un, ni dans l'écran des
 *      utilisateurs, ni dans un export, ni en base.
 *   3. **Suppression de ses invitations** — une invitation porte une adresse EN CLAIR, qu'elle
 *      soit en attente ou acceptée. La laisser survivre au compte annulerait le geste nº 2.
 *
 * L'activité, elle, survit — désormais anonyme. C'est aussi ce que la protection des données
 * demande : conserver la mesure, pas la personne.
 *
 * ── LES CINQ COMPTES QU'ON NE TOUCHE JAMAIS ─────────────────────────────────────────────────
 *
 * Hors `DEMO_MODE`, ce service ne fait RIEN — la même image sert la production, et une purge
 * de comptes qui s'y déclencherait serait irréparable. La garde est la première ligne de la
 * méthode, avant toute lecture.
 *
 * Sont ensuite épargnés : les comptes de service du seed (`@demo.vizyoagency.com`, ce sont les
 * identifiants remis aux prospects), les super-administrateurs, le compte propriétaire, et
 * toute adresse inscrite dans `DEMO_COMPTES_PERMANENTS`. Cette dernière liste existe pour les
 * commerciaux : rien ne les distingue structurellement d'un prospect, et une purge à l'aveugle
 * effacerait le compte de la personne qui fait visiter la démonstration.
 *
 * ── POURQUOI L'INACTIVITÉ, ET PAS UNE DATE FIXE ─────────────────────────────────────────────
 *
 * Une purge « tous les dimanches » emporterait le commercial avec les prospects. L'inactivité
 * se règle d'elle-même : qui se sert de la démonstration la garde, qui l'a laissée dormir la
 * perd. Et elle s'annonce aussi simplement — « votre accès est supprimé après N jours sans
 * connexion ».
 */
@Injectable()
export class DemoPurgeComptesService {
  private readonly logger = new Logger(DemoPurgeComptesService.name);

  /** Domaine des comptes de rôle posés par le seed — jamais purgés. */
  private static readonly DOMAINE_SERVICE = '@demo.vizyoagency.com';

  /** Ce qui remplace l'adresse. `.invalid` est réservé par la RFC 2606 : il ne route nulle part. */
  private static readonly DOMAINE_EFFACE = '@compte-efface.invalid';

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountSync: AuthAccountSyncService,
    private readonly config: ConfigService<Env, true>,
    @Optional() private readonly demoMode?: DemoModeService,
  ) {}

  /** Délai d'inactivité, en jours. 0 ou absent ⇒ 30. */
  private get delaiJours(): number {
    const brut = Number(this.config.get('DEMO_PURGE_JOURS', { infer: true }) ?? 0);
    return Number.isFinite(brut) && brut > 0 ? brut : 30;
  }

  /** Adresses que la purge ne touche jamais — les commerciaux, typiquement. */
  private get permanents(): Set<string> {
    const brut = String(this.config.get('DEMO_COMPTES_PERMANENTS', { infer: true }) ?? '');
    return new Set(
      brut.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0),
    );
  }

  /**
   * Une fois par jour. Le créneau évite ceux du catalogue et passe APRÈS le rafraîchissement
   * hebdomadaire de 04:00, pour qu'un dimanche ne fasse pas les deux en même temps.
   */
  @Cron('35 5 * * *')
  async purger(maintenant = new Date()): Promise<void> {
    if (!this.demoMode?.enabled) return;

    const seuil = new Date(maintenant.getTime() - this.delaiJours * 24 * 60 * 60 * 1000);
    const permanents = this.permanents;

    const candidats = await this.prisma.user.findMany({
      where: {
        isActive: true,
        isOwner: false,
        role: { not: UserRole.SUPER_ADMIN },
        NOT: { email: { endsWith: DemoPurgeComptesService.DOMAINE_SERVICE } },
        createdAt: { lt: seuil },
      },
      select: { id: true, email: true, authUserId: true },
    });

    if (candidats.length === 0) {
      // Une trace même quand il n'y a rien à faire : sans elle, le silence de ce traitement
      // serait indistinguable de son arrêt.
      this.logger.log(`Passage effectué : aucun compte dormant depuis ${this.delaiJours} jours.`);
      return;
    }

    // La dernière connexion vient de `LoginEvent` : c'est la seule source qui distingue
    // « jamais venu » de « venu il y a longtemps ». Un compte créé avant le seuil mais revenu
    // depuis n'est PAS dormant.
    const connexions = await this.prisma.loginEvent.findMany({
      where: { userId: { in: candidats.map((c) => c.id) }, createdAt: { gte: seuil } },
      select: { userId: true },
    });
    const revenus = new Set(connexions.map((c) => c.userId));

    const aPurger = candidats.filter(
      (c) => !revenus.has(c.id) && !permanents.has(c.email.toLowerCase()),
    );

    if (aPurger.length === 0) {
      this.logger.log(`Passage effectué : aucun compte dormant depuis ${this.delaiJours} jours.`);
      return;
    }

    let faits = 0;
    for (const compte of aPurger) {
      try {
        // 1. Couper l'accès chez le fournisseur d'identité — le seul geste qui empêche
        //    réellement une reconnexion. Non bloquant : une panne de Vizyo Auth ne doit pas
        //    laisser les données personnelles en place.
        await this.accountSync.applyStatus(compte.authUserId, false, `purge-demo:${compte.email}`);

        // 2. Les invitations portent l'adresse en clair — celles qu'il a reçues comme celles
        //    qu'il a émises. Elles partent avec lui, sinon l'effacement ne vaut rien.
        await this.prisma.invitation.deleteMany({
          where: { OR: [{ email: compte.email }, { createdById: compte.id }] },
        });

        // 3. Effacer ce qui désigne la personne. La ligne reste, l'activité aussi — anonyme.
        await this.prisma.user.update({
          where: { id: compte.id },
          data: {
            email: `${compte.id}${DemoPurgeComptesService.DOMAINE_EFFACE}`,
            firstName: 'Compte',
            lastName: 'effacé',
            phone: null,
            isActive: false,
          },
        });
        faits += 1;
      } catch (e) {
        // Un compte qui résiste ne doit pas arrêter les suivants : on le dit et on continue.
        this.logger.error(`Purge impossible pour ${compte.email} : ${String(e)}`);
      }
    }

    this.logger.log(
      `Purge de démonstration : ${faits} compte(s) effacé(s) sur ${aPurger.length} dormant(s) ` +
        `depuis plus de ${this.delaiJours} jours.`,
    );
  }
}

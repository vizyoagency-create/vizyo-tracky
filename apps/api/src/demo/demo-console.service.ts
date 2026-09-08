import { ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { InvitationsService } from '../invitations/invitations.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserActivityService } from '../user-activity/user-activity.service';
import { DemoModeService } from './demo-mode.service';

/** Un compte de la démo, tel que la console de production l'affiche. */
export interface CompteDemo {
  id: string;
  email: string;
  nom: string;
  role: UserRole;
  actif: boolean;
  /** `true` pour les comptes posés par le seed : ce sont les identifiants remis aux prospects. */
  compteDeService: boolean;
  derniereConnexionAt: string | null;
  derniereConnexionVille: string | null;
  creeAt: string;
}

export interface InvitationDemo {
  id: string;
  email: string;
  role: UserRole;
  statut: string;
  expireAt: string;
  creeAt: string;
}

/**
 * ═══ CONSOLE DE DÉMONSTRATION — CÔTÉ DÉMO ════════════════════════════════════════════════════
 *
 * Ce service vit dans l'API de DÉMO et n'est appelé que par l'API de PRODUCTION, à travers les
 * routes internes de `DemoConsoleController`. Il ne fait rien que la démo ne sache déjà faire :
 * il expose ses comptes, ses invitations et son activité à l'exploitant, qui n'a aucune raison
 * d'avoir à se connecter à la démo pour l'administrer.
 *
 * ⚠️ TOUT EST INERTE HORS `DEMO_MODE`. La même image sert les deux environnements ; sans cette
 * garde, la production exposerait SES comptes et SON activité sur des routes authentifiées par
 * un simple secret partagé. La garde est ici, dans le service, et pas seulement dans le
 * contrôleur : c'est la couche que personne ne contourne en ajoutant une route.
 */
@Injectable()
export class DemoConsoleService {
  private readonly logger = new Logger(DemoConsoleService.name);

  /** Domaine des comptes posés par le seed — ceux qu'on remet aux prospects. */
  private static readonly DOMAINE_SERVICE = '@demo.vizyoagency.com';

  constructor(
    private readonly prisma: PrismaService,
    private readonly invitations: InvitationsService,
    private readonly fluxActivite: UserActivityService,
    @Optional() private readonly demoMode?: DemoModeService,
  ) {}

  private exigerDemo(): void {
    if (!this.demoMode?.enabled) {
      throw new ForbiddenException(
        "Cette API n'est servie que par l'environnement de démonstration (DEMO_MODE absent).",
      );
    }
  }

  /** La société de démo : la seule flotte de cette base, posée par le seed. */
  private async idFlotte(): Promise<string> {
    const flotte = await this.prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!flotte) throw new NotFoundException("Aucune société dans la base de démonstration (seed non passé ?).");
    return flotte.id;
  }

  /**
   * Tous les comptes, avec leur dernière connexion.
   *
   * La dernière connexion vient de `LoginEvent` et non d'une colonne sur `User` : c'est la seule
   * source qui distingue « jamais venu » de « venu il y a longtemps », et elle porte la ville,
   * qui dit d'un coup d'œil si un prospect a réellement ouvert la démo.
   */
  async comptes(): Promise<CompteDemo[]> {
    this.exigerDemo();
    const users = await this.prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
      select: {
        id: true, email: true, firstName: true, lastName: true,
        role: true, isActive: true, createdAt: true,
      },
    });
    if (users.length === 0) return [];

    // Une seule requête pour toutes les dernières connexions, plutôt qu'une par compte.
    const dernieres = await this.prisma.loginEvent.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      orderBy: { createdAt: 'desc' },
      select: { userId: true, createdAt: true, city: true },
    });
    const parUtilisateur = new Map<string, { createdAt: Date; city: string | null }>();
    for (const e of dernieres) if (!parUtilisateur.has(e.userId)) parUtilisateur.set(e.userId, e);

    return users.map((u) => {
      const dernier = parUtilisateur.get(u.id);
      return {
        id: u.id,
        email: u.email,
        nom: [u.firstName, u.lastName].filter(Boolean).join(' ') || '—',
        role: u.role,
        actif: u.isActive,
        compteDeService: u.email.endsWith(DemoConsoleService.DOMAINE_SERVICE),
        derniereConnexionAt: dernier?.createdAt.toISOString() ?? null,
        derniereConnexionVille: dernier?.city ?? null,
        creeAt: u.createdAt.toISOString(),
      };
    });
  }

  async listerInvitations(): Promise<InvitationDemo[]> {
    this.exigerDemo();
    const lignes = await this.prisma.invitation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, email: true, role: true, status: true, expiresAt: true, createdAt: true },
    });
    return lignes.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      statut: i.status,
      expireAt: i.expiresAt.toISOString(),
      creeAt: i.createdAt.toISOString(),
    }));
  }

  /**
   * Invite un prospect. On passe par `InvitationsService`, donc par la logique métier complète —
   * jeton haché, courriel, refus si le compte existe déjà — plutôt que d'écrire une ligne à la
   * main, ce qui produirait une invitation qu'aucun lien ne pourrait accepter.
   */
  async inviter(email: string, role: UserRole, demandeurEmail: string) {
    this.exigerDemo();
    const auteur = await this.prisma.user.findFirst({
      where: { role: UserRole.SUPER_ADMIN },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!auteur) throw new NotFoundException("Aucun compte super-administrateur dans la démonstration.");
    this.logger.log(`Invitation de démonstration pour ${email} (${role}), demandée par ${demandeurEmail}`);
    return this.invitations.create({
      email,
      role,
      fleetId: await this.idFlotte(),
      requestedByUserId: auteur.id,
      permissions: null,
      accessScopes: null,
    });
  }

  async revoquerInvitation(id: string) {
    this.exigerDemo();
    const auteur = await this.prisma.user.findFirst({
      where: { role: UserRole.SUPER_ADMIN },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, fleetId: true },
    });
    if (!auteur) throw new NotFoundException("Aucun compte super-administrateur dans la démonstration.");
    return this.invitations.revoke(id, auteur);
  }

  /**
   * Bloque ou débloque un compte. `isActive` existe déjà et gouverne l'accès : rien à migrer.
   *
   * ⚠️ Les comptes de service du seed ne se bloquent pas depuis ici. Ce sont les identifiants
   * remis aux prospects ; les bloquer par inadvertance couperait toutes les démonstrations à
   * venir, et rien à l'écran ne dirait pourquoi. Ils se gèrent par le seed, qui les recrée.
   */
  async definirBlocage(id: string, bloque: boolean): Promise<CompteDemo> {
    this.exigerDemo();
    const compte = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true },
    });
    if (!compte) throw new NotFoundException('Compte introuvable dans la démonstration.');
    if (compte.email.endsWith(DemoConsoleService.DOMAINE_SERVICE)) {
      throw new ForbiddenException(
        "Ce compte de service est remis aux prospects : le bloquer couperait toutes les démonstrations. Il se gère par le seed.",
      );
    }
    if (compte.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException("Un compte super-administrateur ne se bloque pas depuis la console.");
    }
    await this.prisma.user.update({ where: { id }, data: { isActive: !bloque } });
    this.logger.log(`Compte de démonstration ${compte.email} ${bloque ? 'bloqué' : 'débloqué'}`);
    return (await this.comptes()).find((c) => c.id === id)!;
  }

  /**
   * L'activité de la démo, telle que la production l'affichera dans « Activité utilisateurs ».
   * On réutilise `getFeed` sans le modifier : ce sont les mêmes événements, la même forme, et
   * c'est ce qui garantit que les deux sources se lisent de la même façon à l'écran.
   */
  async activite(filtres: { limit?: number; before?: string; beforeId?: string; type?: string; userId?: string }) {
    this.exigerDemo();
    // `isOwner: true` : la console est déjà réservée au super-admin de production, et masquer
    // l'activité de l'owner DANS la démo n'aurait aucun sens — il n'y a pas d'owner à protéger.
    return this.fluxActivite.getFeed(filtres, { isOwner: true });
  }
}

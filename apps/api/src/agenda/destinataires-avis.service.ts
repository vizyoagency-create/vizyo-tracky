import { Injectable } from '@nestjs/common';
import {
  getDefaultPermissions,
  type UserPermissions,
  type UserRoleSlug,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';

/** Un compte qui PEUT valider une demande, et s'il en est prévenu. */
export interface DestinatairePossible {
  id: string;
  email: string | null;
  role: string;
  notifie: boolean;
}

/**
 * ── QUI PEUT VALIDER UNE DEMANDE DE CONDUCTEUR, ET QUI EN EST PRÉVENU ───────────────────────
 *
 * ⚠️ DEUX CHOSES DISTINCTES, ET ELLES ÉTAIENT CONFONDUES jusqu'au 2026-09-24. Le notifieur
 * écrivait à tous les comptes portant `reservations_manage` : ouvrir la validation à quatre
 * gestionnaires chez cdef31 — ce que la mise en service exigeait — leur envoyait donc
 * mécaniquement quatre courriels par demande, aux boîtes du client.
 *
 * Le DROIT reste `reservations_manage`. L'AVIS est `users.reservationNoticeEnabled`, réglé
 * depuis « Paramètres de l'agenda ». Un compte à `false` voit et valide exactement comme avant.
 *
 * ── POURQUOI CE SERVICE VIT DANS `AgendaModule` ─────────────────────────────────────────────
 *
 * Deux appelants en ont besoin : l'écran des réglages (`AgendaAgentSettingsService`, ici) et le
 * notifieur (`ReservationBookingNotifier`, ailleurs). Or `ReservationBookingModule` importe déjà
 * `AgendaModule` : mettre la règle chez le notifieur et la lire depuis l'agenda fermerait un
 * CYCLE. Elle vit donc du côté importé, et le sens reste unique — reservation-booking → agenda.
 *
 * La dupliquer était l'autre option. C'est celle qui garantit qu'un jour les deux divergeront :
 * l'écran montrerait des destinataires à qui plus rien ne part.
 */
@Injectable()
export class DestinatairesAvisService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tous ceux qui peuvent valider dans cette société, chacun avec son réglage d'avis.
   *
   * ⚠️ Effectif = défauts du rôle RECOUVERTS par le JSON du compte. Une clé ABSENTE du JSON ne
   * vaut pas `false` : elle vaut le défaut du rôle. Lire le JSON seul ferait disparaître le
   * fleet-admin, dont le JSON est souvent vide.
   */
  async possibles(fleetId: string): Promise<DestinatairePossible[]> {
    const membres = await this.prisma.user.findMany({
      where: { fleetId, isActive: true },
      select: {
        id: true,
        email: true,
        role: true,
        permissions: true,
        reservationNoticeEnabled: true,
      },
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
    });
    return membres
      .filter((m) => {
        const defauts = getDefaultPermissions(m.role as UserRoleSlug);
        const explicites = (m.permissions ?? {}) as Partial<UserPermissions>;
        return { ...defauts, ...explicites }.reservations_manage === true;
      })
      .map((m) => ({
        id: m.id,
        email: m.email,
        role: m.role,
        notifie: m.reservationNoticeEnabled,
      }));
  }

  /** Ceux à qui l'avis part réellement. */
  async notifies(fleetId: string): Promise<DestinatairePossible[]> {
    return (await this.possibles(fleetId)).filter((c) => c.notifie);
  }
}

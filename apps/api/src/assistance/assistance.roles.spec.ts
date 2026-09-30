import 'reflect-metadata';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AssistanceController } from './assistance.controller';

/**
 * ══ QUI RÉPOND AUX DEMANDES D'ASSISTANCE — UNE FRONTIÈRE, PAS UN AFFICHAGE ═══════════════════
 *
 * Le 30/09/2026 l'écran « Demandes d'assistance » a quitté la navbar de l'application pour le
 * panneau `/admin`, et l'accès a été resserré au SUPER-ADMIN : c'est Vizyo qui traite les
 * demandes, pas les admins de flotte.
 *
 * Ce test porte sur le CONTRÔLEUR, pas sur la route Angular, et c'est tout le sujet. Une garde
 * d'écran ne ferme rien : elle retire un lien. L'appel HTTP, lui, reste possible pour qui
 * connaît l'URL. Ce dépôt s'est déjà fait prendre plusieurs fois par des garde-fous qui ne
 * gardaient rien — un périmètre qui n'existe que dans le navigateur n'existe pas.
 *
 * Le contrepoint compte autant : les routes de l'UTILISATEUR ne portent AUCUN rôle et ne doivent
 * jamais en porter. L'assistance est une aide ; la restreindre par mégarde en resserrant la
 * partie admin fermerait la porte à ceux qu'elle sert.
 */
describe('Assistance — la frontière entre poser une question et y répondre', () => {
  const rolesDe = (methode: string): UserRole[] => {
    const proto = AssistanceController.prototype as unknown as Record<string, object>;
    return (Reflect.getMetadata(ROLES_KEY, proto[methode]) ?? []) as UserRole[];
  };

  const ROUTES_ADMIN = ['adminListe', 'adminDetail', 'relire', 'repondre'] as const;
  const ROUTES_UTILISATEUR = ['disponible', 'ask', 'mesConversations', 'maConversation', 'rappel'] as const;

  it('🔴 les quatre routes d’administration sont réservées au SUPER-ADMIN', () => {
    for (const m of ROUTES_ADMIN) {
      expect({ methode: m, roles: rolesDe(m) }).toEqual({ methode: m, roles: [UserRole.SUPER_ADMIN] });
    }
  });

  it('🔴 aucune route d’administration ne laisse passer un admin de flotte', () => {
    for (const m of ROUTES_ADMIN) {
      expect(rolesDe(m)).not.toContain(UserRole.FLEET_ADMIN);
    }
  });

  it('les routes de l’utilisateur restent ouvertes à tous — c’est une aide, pas une administration', () => {
    for (const m of ROUTES_UTILISATEUR) {
      expect({ methode: m, roles: rolesDe(m) }).toEqual({ methode: m, roles: [] });
    }
  });

  it('le contrôleur n’expose pas d’autre route admin que ces quatre-là', () => {
    // Si une cinquième apparaît un jour, elle doit passer par ce test — et donc par une
    // décision explicite sur son périmètre, au lieu d'hériter du silence.
    const methodes = Object.getOwnPropertyNames(AssistanceController.prototype)
      .filter((m) => m !== 'constructor' && m.toLowerCase().startsWith('admin'));
    expect(methodes.sort()).toEqual(['adminDetail', 'adminListe']);
  });
});

import { Injectable, Logger } from '@nestjs/common';
import { AuthClientService } from '../auth-client/auth-client.service';
import { ErrorLogger } from '../observability/error-logger.service';

/**
 * SYNCHRONISATION DU STATUT DE COMPTE — Tracky ↔ Vizyo Auth.
 *
 * ── Le défaut réparé (2026-08-02) ────────────────────────────────────────────────────
 * Tracky porte `User.isActive`, Vizyo Auth porte `UserApp.status`. Les deux décident du
 * même fait — « cette personne peut-elle entrer ? » — et **rien ne les tenait ensemble** :
 *
 *   - archiver appelait `suspendUser()` dans un `catch {}` VIDE ;
 *   - désarchiver n'appelait RIEN du tout (`activateUser` n'était invoqué nulle part
 *     dans le dépôt : la méthode existait, personne ne s'en servait) ;
 *   - suspendre/réactiver une flotte entière ne touchait que la base Tracky.
 *
 * Tant que `suspendUser` échouait en 403 (correctif PR #51), l'asymétrie était sans
 * conséquence : archiver ne suspendait rien, donc désarchiver n'avait rien à défaire.
 * **Réparer l'appel a transformé un no-op en action irréversible depuis l'interface** —
 * un compte archivé puis désarchivé serait resté bloqué au login, en s'affichant actif.
 *
 * ── La règle ────────────────────────────────────────────────────────────────────────
 * Tracky est la source de vérité du statut. Tout écrit de `isActive` passe par ici, et
 * ce service pousse l'état correspondant vers Vizyo Auth.
 *
 * ⚠️ NON BLOQUANT, mais JAMAIS MUET. Une panne de Vizyo Auth ne doit pas empêcher un
 * administrateur d'archiver quelqu'un — mais l'échec doit laisser une trace, sinon on
 * recrée exactement le silence qui a masqué le bug d'origine pendant des mois. Chaque
 * échec est journalisé ET remonté au centre d'alerte, et l'écart reste visible dans
 * `/admin/auth-sync`, qui compare les deux côtés.
 */
@Injectable()
export class AuthAccountSyncService {
  private readonly logger = new Logger(AuthAccountSyncService.name);

  constructor(
    private readonly authClient: AuthClientService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * Aligne Vizyo Auth sur l'état Tracky.
   *
   * @returns `true` si Vizyo Auth a confirmé, `false` si l'appel a échoué (l'appelant
   *          poursuit : le statut Tracky, lui, est déjà écrit).
   */
  async applyStatus(authUserId: string | null | undefined, isActive: boolean, context: string): Promise<boolean> {
    // Un compte sans identifiant Vizyo Auth n'a rien à synchroniser. Ce n'est pas une
    // erreur : certains comptes de service n'existent que côté Tracky.
    if (!authUserId) return true;
    try {
      if (isActive) {
        await this.authClient.activateUser(authUserId);
      } else {
        await this.authClient.suspendUser(authUserId);
      }
      this.logger.log(`[auth-sync] ${isActive ? 'reactivation' : 'suspension'} OK (${context}) auth=${authUserId.slice(0, 8)}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Bruyant À DESSEIN. C'est un `catch {}` vide qui a laissé quatre appels échouer
      // en 403 pendant des mois sans que personne ne le voie.
      this.logger.error(
        `[auth-sync] Échec ${isActive ? 'reactivation' : 'suspension'} (${context}) auth=${authUserId.slice(0, 8)}: ${message}`,
      );
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(message),
        'auth-sync',
        { context, authUserId, intended: isActive ? 'active' : 'suspended' },
      );
      return false;
    }
  }
}

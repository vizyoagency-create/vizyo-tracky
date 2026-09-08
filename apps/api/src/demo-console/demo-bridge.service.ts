import { HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

/** Réponse d'une console non configurée : l'écran le dit, au lieu d'afficher une liste vide. */
export interface EtatPont {
  configure: boolean;
  url: string | null;
  /** Renseigné quand le dernier appel a échoué — l'écran montre POURQUOI, pas juste « vide ». */
  erreur?: string;
}

/**
 * ═══ PONT VERS LA DÉMONSTRATION — CÔTÉ PRODUCTION ════════════════════════════════════════════
 *
 * La production et la démo sont deux piles séparées, deux bases distinctes. Pour que la console
 * d'administration montre les comptes de démonstration et leur activité, il fallait choisir un
 * chemin. Deux étaient possibles :
 *
 *   · lire la base de la démo, en miroir de ce que la démo fait déjà de la production ;
 *   · appeler l'API de la démo avec son secret interne.
 *
 * C'est le second, pour une raison qui tient à l'écriture : inviter, révoquer, bloquer sont des
 * gestes MÉTIER — jeton haché, courriel, refus si le compte existe. Les rejouer depuis la
 * production en écrivant dans la base de la démo, ce serait les réimplémenter, et donc les voir
 * diverger au premier changement. En passant par l'API, il n'existe qu'une implémentation.
 *
 * ⚠️ TOLÉRANT À LA PANNE, PAR CONCEPTION. La démo est un environnement de démonstration : elle
 * est arrêtée pendant son rafraîchissement hebdomadaire, et redéployée sans préavis. Une console
 * qui jetterait une 500 à ce moment-là ferait croire à une panne de la PRODUCTION. On rend donc
 * une erreur nommée, que l'écran affiche telle quelle.
 */
@Injectable()
export class DemoBridgeService {
  private readonly logger = new Logger(DemoBridgeService.name);
  /** La démo peut être en train de redémarrer : on n'attend pas indéfiniment. */
  private static readonly DELAI_MS = 8_000;

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get url(): string {
    return (this.config.get('DEMO_API_URL', { infer: true }) || '').trim().replace(/\/+$/, '');
  }

  private get secret(): string {
    return (this.config.get('DEMO_INTERNAL_SECRET', { infer: true }) || '').trim();
  }

  estConfigure(): boolean {
    return this.url.length > 0 && this.secret.length > 0;
  }

  etat(): EtatPont {
    return { configure: this.estConfigure(), url: this.estConfigure() ? this.url : null };
  }

  async lire<T>(chemin: string, parametres: Record<string, string | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(parametres).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
    ).toString();
    return this.appeler<T>('GET', `${chemin}${qs ? `?${qs}` : ''}`);
  }

  async ecrire<T>(methode: 'POST' | 'DELETE', chemin: string, corps?: unknown): Promise<T> {
    return this.appeler<T>(methode, chemin, corps);
  }

  private async appeler<T>(methode: string, chemin: string, corps?: unknown): Promise<T> {
    if (!this.estConfigure()) {
      throw new ServiceUnavailableException(
        "Console de démonstration non configurée : DEMO_API_URL et DEMO_INTERNAL_SECRET manquent dans l'environnement de production.",
      );
    }
    let reponse: Response;
    try {
      reponse = await fetch(`${this.url}/api/internal/demo${chemin}`, {
        method: methode,
        headers: {
          'x-internal-secret': this.secret,
          ...(corps === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: corps === undefined ? undefined : JSON.stringify(corps),
        signal: AbortSignal.timeout(DemoBridgeService.DELAI_MS),
      });
    } catch (e) {
      // Démo arrêtée, en cours de rafraîchissement, ou réseau coupé. Ce n'est PAS une panne de
      // la production, et l'écran doit pouvoir le dire.
      this.logger.warn(`Démonstration injoignable (${methode} ${chemin}) : ${String(e)}`);
      throw new ServiceUnavailableException(
        "L'environnement de démonstration est injoignable. Il est peut-être en cours de rafraîchissement — réessayez dans quelques minutes.",
      );
    }
    if (!reponse.ok) {
      const detail = await reponse.text().catch(() => '');
      const message = this.messageDe(detail) ?? `La démonstration a répondu ${reponse.status}.`;
      this.logger.warn(`Démonstration : ${methode} ${chemin} → ${reponse.status} ${detail.slice(0, 160)}`);
      // On REPORTE le code de la démo : un 403 « compte de service » doit rester un 403 à
      // l'écran, pas devenir une 500 anonyme qui n'apprend rien à personne.
      throw new HttpException(message, reponse.status);
    }
    if (reponse.status === 204) return undefined as T;
    return (await reponse.json()) as T;
  }

  /** Extrait le message d'une erreur Nest (`{ error: { message } }` ou `{ message }`). */
  private messageDe(corps: string): string | null {
    try {
      const j = JSON.parse(corps) as { message?: unknown; error?: { message?: unknown } };
      const m = j?.error?.message ?? j?.message;
      return typeof m === 'string' && m.length > 0 ? m : null;
    } catch {
      return null;
    }
  }
}

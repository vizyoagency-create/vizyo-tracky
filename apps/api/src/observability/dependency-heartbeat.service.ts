import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from './error-logger.service';

/** Nombre d'échecs CONSÉCUTIFS avant de crier : un hoquet réseau isolé ne réveille personne. */
const FAILURES_BEFORE_ALERT = 2;
/** Au-delà, la dépendance est considérée injoignable (et non « lente »). */
const PROBE_TIMEOUT_MS = 8_000;

interface Target {
  /** Nom court — sert de suffixe de `source` dans le centre d'alerte. */
  name: string;
  url: string;
}

/**
 * Sonde ACTIVE des dépendances critiques (2026-07-21) — complète la vigie de saturation.
 *
 * Motivation (panne Vizyo Auth du 2026-07-18 → 21) : `vizyo-auth-api` a été recréé depuis le
 * mauvais compose et a perdu ses labels Traefik. Résultat : conteneur sain mais AUCUNE route →
 * toute connexion échouait. La panne a duré 3 jours sans que rien ne la signale, parce que
 * `ErrorRateWatchdogService` compte les erreurs ENREGISTRÉES : or personne n'exerçait le login
 * (les JWT déjà émis restaient valides) → 0 erreur écrite → 0 alerte.
 *
 * Leçon : une vigie de VOLUME détecte les pannes bruyantes, jamais les pannes SILENCIEUSES.
 * Pour « une dépendance est injoignable », il faut aller la toucher soi-même.
 *
 * On sonde l'URL PUBLIQUE (pas le conteneur en direct) : le test traverse ainsi Traefik/TLS,
 * c'est-à-dire précisément la couche qui avait lâché.
 *
 * L'échec est écrit au centre d'alerte en CRITICAL ; la vigie de saturation existante se charge
 * ensuite de l'e-mail (on ne duplique pas la plomberie de notification).
 */
@Injectable()
export class DependencyHeartbeatService {
  private readonly logger = new Logger(DependencyHeartbeatService.name);
  /** Échecs consécutifs par dépendance — remis à zéro dès qu'elle répond. */
  private readonly consecutiveFailures = new Map<string, number>();
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * Toutes les 5 min (à la seconde 30, pour ne pas tomber pile sur les autres crons).
   * Avec 2 échecs requis, une panne est signalée en ~10 min — à comparer aux 3 jours de l'incident.
   */
  @Cron('30 */5 * * * *')
  async check(): Promise<void> {
    if (this.running) return; // pas de recouvrement : @Cron ne le garantit pas
    this.running = true;
    try {
      await this.probeAll();
    } catch (e) {
      // Une sonde qui casse le scheduler serait pire que pas de sonde.
      this.logger.warn(`Sonde des dépendances indisponible : ${(e as Error)?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  /** Dépendances à surveiller — uniquement celles réellement configurées. */
  private targets(): Target[] {
    const out: Target[] = [];
    const auth = (this.config.get<string>('VIZYO_AUTH_API_URL') ?? '').trim();
    if (auth) out.push({ name: 'vizyo-auth', url: `${auth.replace(/\/+$/, '')}/health` });
    const texto = (this.config.get<string>('VIZYO_TEXTO_URL') ?? '').trim();
    if (texto) out.push({ name: 'vizyo-texto', url: `${texto.replace(/\/+$/, '')}/health` });
    return out;
  }

  private async probeAll(): Promise<void> {
    for (const target of this.targets()) {
      const ok = await this.probe(target.url);
      const previous = this.consecutiveFailures.get(target.name) ?? 0;

      if (ok) {
        // Rétabli après une alerte : on le dit, sinon l'exploitant ne sait pas que c'est fini.
        if (previous >= FAILURES_BEFORE_ALERT) {
          this.logger.warn(`Dépendance ${target.name} de nouveau joignable (après ${previous} échecs).`);
        }
        this.consecutiveFailures.set(target.name, 0);
        continue;
      }

      const failures = previous + 1;
      this.consecutiveFailures.set(target.name, failures);

      if (failures < FAILURES_BEFORE_ALERT) {
        this.logger.warn(`Dépendance ${target.name} muette (${failures}) — on attend confirmation.`);
        continue;
      }

      // Le compteur figure dans le message : l'exploitant voit depuis combien de cycles ça dure.
      this.errorLogger.recordBackground(
        new Error(
          `Dépendance critique injoignable : ${target.name} (${target.url}) — ${failures} échecs consécutifs`,
        ),
        `dependency:${target.name}`,
        { url: target.url, consecutiveFailures: failures },
        'CRITICAL',
      );
    }
  }

  /** true si la dépendance répond 2xx dans le délai imparti. Ne jette jamais. */
  private async probe(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      return res.ok;
    } catch {
      return false; // DNS, TLS, timeout, 404 Traefik… : dans tous les cas, injoignable.
    } finally {
      clearTimeout(timer);
    }
  }
}

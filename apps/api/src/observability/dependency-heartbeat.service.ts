import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
  /**
   * `false` quand l'URL sondée est une adresse INTERNE : le test ne traverse alors ni
   * le DNS public, ni Traefik, ni TLS — donc il ne verrait PAS une panne de routage.
   */
  reachesPublicRoute: boolean;
  /** Variable à définir pour corriger le cas ci-dessus (citée dans l'avertissement). */
  probeKey: string;
}

/**
 * Heuristique volontairement simple : un nom de service Docker (`vizyo-auth-api`) n'a pas
 * de point, contrairement à un vrai nom de domaine. Loopback exclu pour la même raison.
 * Approximatif sur les IP privées, mais le cas réel à attraper est le nom de service.
 */
function reachesPublicRoute(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    if (hostname === 'localhost' || hostname.startsWith('127.')) return false;
    return hostname.includes('.');
  } catch {
    return false;
  }
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
 * ⚠️ C'est tout l'enjeu du réglage : en prod, `VIZYO_AUTH_API_URL` vaut
 * `http://vizyo-auth-api:3200` — une adresse INTERNE. Sonder celle-là aurait affiché VERT
 * pendant les 3 jours de panne, puisque le conteneur, lui, répondait très bien. D'où
 * `DEPENDENCY_PROBE_*_URL`, qui prime, et l'avertissement au démarrage si l'URL retenue
 * ne sort pas du réseau Docker.
 *
 * L'échec est écrit au centre d'alerte en CRITICAL ; la vigie de saturation existante se charge
 * ensuite de l'e-mail (on ne duplique pas la plomberie de notification).
 */
@Injectable()
export class DependencyHeartbeatService implements OnModuleInit {
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

  /**
   * Dit au démarrage ce que la sonde surveille VRAIMENT. Une sonde qui se croit active alors
   * qu'elle ne teste rien d'utile est pire que pas de sonde : elle rassure à tort.
   */
  onModuleInit(): void {
    const targets = this.targets();
    if (targets.length === 0) {
      this.logger.warn(
        'Sonde des dépendances INACTIVE : aucune URL configurée (ni DEPENDENCY_PROBE_*_URL, ni VIZYO_*_URL).',
      );
      return;
    }
    for (const t of targets) {
      if (t.reachesPublicRoute) {
        this.logger.log(`Sonde ${t.name} : ${t.url}`);
        continue;
      }
      this.logger.warn(
        `Sonde ${t.name} : ${t.url} est une adresse INTERNE — le test ne traverse ni Traefik ni TLS. ` +
          `Une panne de ROUTAGE (conteneur sain, route publique morte) resterait INVISIBLE. ` +
          `Définir ${t.probeKey} sur l'URL publique.`,
      );
    }
  }

  /**
   * Dépendances à surveiller — uniquement celles réellement configurées.
   * `DEPENDENCY_PROBE_*_URL` prime : l'URL applicative peut être interne (cf. en-tête).
   */
  private targets(): Target[] {
    const out: Target[] = [];
    const auth = this.resolve('DEPENDENCY_PROBE_AUTH_URL', 'VIZYO_AUTH_API_URL');
    if (auth) {
      out.push({
        name: 'vizyo-auth',
        url: `${auth}/health`,
        reachesPublicRoute: reachesPublicRoute(auth),
        probeKey: 'DEPENDENCY_PROBE_AUTH_URL',
      });
    }
    const texto = this.resolve('DEPENDENCY_PROBE_TEXTO_URL', 'VIZYO_TEXTO_URL');
    if (texto) {
      out.push({
        name: 'vizyo-texto',
        url: `${texto}/health`,
        reachesPublicRoute: reachesPublicRoute(texto),
        probeKey: 'DEPENDENCY_PROBE_TEXTO_URL',
      });
    }
    return out;
  }

  /** URL de sonde dédiée si elle existe, sinon l'URL applicative. Sans barre finale. */
  private resolve(probeKey: string, fallbackKey: string): string {
    const probe = (this.config.get<string>(probeKey) ?? '').trim();
    const value = probe || (this.config.get<string>(fallbackKey) ?? '').trim();
    return value.replace(/\/+$/, '');
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

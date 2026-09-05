import { Injectable } from '@nestjs/common';
import type { AiFeatureKey } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { AiRouter } from './ai-router.service';
import { AiFeatureFlagsService } from './ai-feature-flags.service';

/**
 * Disponibilité de l'IA (2026-07). Combine (a) la CONFIG serveur (au moins une clé provider présente)
 * et (b) l'INTERRUPTEUR MAÎTRE par flotte (`Fleet.aiEnabled`, togglable par le fleet-admin depuis ses
 * réglages). Toute op IA CLIENTE (récit de trajet, agent d'agenda, optimiseur, parsing vocal des
 * réservations) DOIT passer par `isEnabledForFleet(fleetId)` AVANT d'appeler un moteur — l'app doit
 * rester pleinement fonctionnelle sans IA. Ne lève jamais : sur erreur DB on ne coupe pas l'IA déjà
 * configurée (repli non disruptif). L'analyse DÉTERMINISTE (arrêts/excès/éco/stations/scores) n'est
 * PAS de l'IA et n'est jamais concernée par ce flag.
 */
@Injectable()
export class AiAvailabilityService {
  private readonly cache = new Map<string, { v: boolean; at: number }>();
  private static readonly TTL_MS = 15_000;

  constructor(
    private readonly router: AiRouter,
    private readonly prisma: PrismaService,
    private readonly featureFlags: AiFeatureFlagsService,
  ) {}

  /** Au moins une clé provider présente côté serveur (Claude et/ou GPT). */
  isConfigured(): boolean {
    return this.router.isConfigured();
  }

  /**
   * L'IA est-elle UTILISABLE pour cette flotte ? true seulement si une clé est présente ET que la
   * flotte n'a pas désactivé l'IA. `fleetId` absent (contexte super-admin global) → suit la config.
   */
  async isEnabledForFleet(fleetId: string | null | undefined, feature?: AiFeatureKey, now = Date.now()): Promise<boolean> {
    if (!this.router.isConfigured()) return false;
    return this.isFeatureOnForFleet(fleetId, feature, now);
  }

  /**
   * La même porte SANS l'exigence d'une clé API côté serveur : drapeau global de la fonction ET
   * option IA de la société. C'est la porte des traitements qui passent par la FILE DU POSTE
   * (chantier C3, 2026-09-05 : jugement de l'agent d'agenda) — l'abonnement du poste n'a que
   * faire des clés du serveur, et un serveur sans clé ne doit pas éteindre le poste.
   */
  async isFeatureOnForFleet(fleetId: string | null | undefined, feature?: AiFeatureKey, now = Date.now()): Promise<boolean> {
    // Kill-switch GLOBAL par fonctionnalité (owner) — se cumule PAR-DESSUS l'interrupteur société.
    // Fail-open (défaut ON) : couper est une action explicite ; un glitch ne coupe pas l'IA payée.
    if (feature && !(await this.featureFlags.isEnabled(feature, now))) return false;
    // OPT-IN (2026-07) : l'IA est OFF par défaut. Tous les replis sont fail-CLOSED — aucune
    // flotte n'a l'IA tant qu'elle n'est pas explicitement activée. (Avant : fail-open `?? true`.)
    if (!fleetId) return false;
    const hit = this.cache.get(fleetId);
    if (hit && now - hit.at < AiAvailabilityService.TTL_MS) return hit.v;
    let enabled = false;
    try {
      const f = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { aiEnabled: true } });
      enabled = f?.aiEnabled ?? false;
    } catch {
      enabled = hit?.v ?? false; // erreur DB : dernière valeur connue, sinon OFF (on n'active jamais par erreur)
    }
    this.cache.set(fleetId, { v: enabled, at: now });
    return enabled;
  }

  /** Réglage brut d'une flotte (pour l'UI de réglages). Défaut OFF (opt-in). */
  async fleetSetting(fleetId: string): Promise<boolean> {
    try {
      const f = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { aiEnabled: true } });
      return f?.aiEnabled ?? false;
    } catch {
      return false;
    }
  }

  /** Change l'interrupteur IA d'une flotte + invalide le cache. */
  async setFleet(fleetId: string, enabled: boolean): Promise<boolean> {
    await this.prisma.fleet.update({ where: { id: fleetId }, data: { aiEnabled: enabled } });
    this.cache.delete(fleetId);
    return enabled;
  }
}

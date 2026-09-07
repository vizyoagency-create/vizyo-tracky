import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

/**
 * ═══ ENVIRONNEMENT DE DÉMONSTRATION — le seul interrupteur ════════════════════════════════
 *
 * `DEMO_MODE=true` fait de cette instance LA DÉMO (docs/environnement-demo/PLAN-2026-09-07.md) :
 * mêmes images Docker que la production, même code, même schéma de base — mais des boîtiers
 * simulés par rejeu de trames réelles, aucun serveur TCP boîtiers, et des sentinelles
 * d'exploitation qui n'ont pas d'objet ici mises en veille.
 *
 * ⚠️ VOLONTAIREMENT INDÉPENDANT DE `NODE_ENV`. La démo tourne en `production` : c'est ce qui
 * garantit qu'elle se comporte comme la prod (cookies `secure`, journaux, purges armées). Le
 * simulateur de développement (`MockPositionEmitterService`), lui, se coupe sur `NODE_ENV` —
 * c'est précisément pourquoi il ne peut pas servir ici.
 *
 * ⚠️ CE DRAPEAU NE PROTÈGE RIEN À LUI SEUL. Ce qui empêche la démo d'atteindre un véhicule,
 * c'est l'ABSENCE de port TCP publié et de clé SMS dans son environnement (compose + .env.demo).
 * Le drapeau ne fait qu'adapter l'application à cette absence — et le dire à l'écran.
 */
@Injectable()
export class DemoModeService {
  /** true = cette instance est l'environnement de démonstration. Figé au démarrage. */
  readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('DEMO_MODE', { infer: true }) === 'true';
  }
}

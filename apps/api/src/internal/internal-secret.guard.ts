import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../config/env.validation';

/**
 * Garde des routes machine `/api/internal/*` (appelées par Vizyo Manager).
 *
 * ┌─ LOT D (RDV v2, § 1.2 C7) : DU SECRET STATIQUE AU HMAC, SANS COUPURE ───────────────────┐
 * │ Jusqu'ici : un en-tête `X-Internal-Secret` comparé à `INTERNAL_API_SECRET`. Un secret qui  │
 * │ circule tel quel à chaque appel, sans horodatage : rejouable à l'infini par qui l'a vu.   │
 * │ Manager, lui, exige déjà `X-App-Id` + `X-App-Timestamp` (± 5 min) + `X-App-Signature`     │
 * │ (HMAC-SHA256 du `${timestamp}.${corps}`). Cette garde accepte désormais le même schéma,   │
 * │ appli `manager`, secret `VIZYO_MANAGER_APP_SECRET`.                                        │
 * │                                                                                            │
 * │ TRANSITION : tant que Manager n'est pas déployé en HMAC, l'ancien en-tête reste accepté — │
 * │ et chaque appel en secret statique laisse une ligne d'avertissement, pour qu'on voie le   │
 * │ jour où plus personne ne s'en sert et qu'on puisse le retirer.                             │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ Ordre Nest : les gardes lisent `req.body` AVANT la pipe de validation — c'est le corps tel
 * que reçu (mêmes clés, même ordre) qui est signé, comme côté Manager.
 */
@Injectable()
export class InternalSecretGuard implements CanActivate {
  private readonly logger = new Logger(InternalSecretGuard.name);
  private readonly secretStatique: string;
  private readonly secretHmac: string | null;
  /** Tolérance d'horodatage — la même que la garde de Manager (± 5 min). */
  static readonly TOLERANCE_S = 300;

  constructor(config: ConfigService<Env, true>) {
    this.secretStatique = config.get('INTERNAL_API_SECRET', { infer: true });
    const hmac = config.get('VIZYO_MANAGER_APP_SECRET', { infer: true }) as string | undefined;
    this.secretHmac = hmac && hmac.length > 0 ? hmac : null;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const route = `${req.method} ${req.originalUrl ?? req.url}`;

    const appId = premierEnTete(req.headers['x-app-id']);
    const timestamp = premierEnTete(req.headers['x-app-timestamp']);
    const signature = premierEnTete(req.headers['x-app-signature']);
    const statique = premierEnTete(req.headers['x-internal-secret']);
    const statiqueValide = !!statique && egalSansFuite(statique, this.secretStatique);

    if (appId || timestamp || signature) {
      if (!this.secretHmac) {
        // Manager envoie DÉJÀ les deux preuves (HMAC + secret statique) pendant la transition ; tant
        // que Tracky n'a pas son `VIZYO_MANAGER_APP_SECRET`, c'est le secret statique qui juge —
        // en le disant, pour qu'on pose la variable.
        if (statiqueValide) {
          this.logger.warn(`${route} : HMAC reçu mais VIZYO_MANAGER_APP_SECRET absent — accepté sur le secret statique ; poser la variable (lot D, C7)`);
          return true;
        }
        this.logger.error(`${route} : appel HMAC reçu, VIZYO_MANAGER_APP_SECRET absent et pas de secret statique valide`);
        throw new UnauthorizedException('App not configured');
      }
      // HMAC configuré : un appel qui se présente en HMAC est jugé en HMAC — jamais de repli
      // silencieux sur le secret statique quand la signature est fausse (ce serait cacher une
      // mauvaise configuration derrière un secret qu'on veut retirer).
      this.verifierHmac(appId, timestamp, signature, req.body, route);
      return true;
    }

    if (statiqueValide) {
      this.logger.warn(`${route} : appel en secret statique (X-Internal-Secret) — à passer en HMAC (lot D, C7)`);
      return true;
    }
    throw new UnauthorizedException('Invalid internal secret');
  }

  private verifierHmac(appId: string | undefined, timestamp: string | undefined, signature: string | undefined, body: unknown, route: string): void {
    if (!appId || !timestamp || !signature) throw new UnauthorizedException('Missing HMAC headers');
    if (appId.toLowerCase() !== 'manager') {
      this.logger.warn(`${route} : appli HMAC refusée « ${appId} »`);
      throw new UnauthorizedException('App not allowed');
    }
    if (!this.secretHmac) throw new UnauthorizedException('App not configured');
    const ts = Number.parseInt(timestamp, 10);
    const maintenant = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(ts) || Math.abs(maintenant - ts) > InternalSecretGuard.TOLERANCE_S) {
      throw new UnauthorizedException('Timestamp out of tolerance');
    }
    // Sans corps (GET, DELETE, POST vide), le client peut avoir signé `${ts}.` ou `${ts}.{}` selon
    // que son parseur lui donne `undefined` ou `{}` : les deux formes sont acceptées, sans ambiguïté
    // possible sur un corps réel (qui est signé tel quel, mêmes clés, même ordre).
    const vide = !body || typeof body !== 'object' || Object.keys(body as object).length === 0;
    const candidats = vide ? ['', '{}'] : [JSON.stringify(body)];
    const secret = this.secretHmac;
    const ok = candidats.some((corps) => egalSansFuite(signature, createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex')));
    if (!ok) {
      this.logger.warn(`${route} : signature HMAC invalide`);
      throw new UnauthorizedException('Invalid signature');
    }
  }
}

function premierEnTete(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Comparaison en temps constant — un secret ne se compare pas avec `===`. */
function egalSansFuite(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

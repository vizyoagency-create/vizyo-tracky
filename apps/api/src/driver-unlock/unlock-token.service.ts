import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env.validation';

/**
 * feat/comptes-conducteurs — jetons de déverrouillage véhicule.
 *
 * Un QR imprimé sur / à côté du véhicule encode un DEEP LINK signé :
 *   `${APP_BASE_URL}/driver/unlock?token=<vehicleId>.<hmac>`
 *
 * Le jeton est STATELESS (HMAC-SHA256 du vehicleId avec le secret serveur), sans
 * expiration : le QR est stable par véhicule. Le jeton n'est PAS un secret d'accès —
 * le vrai verrou reste l'autorisation (`engine_control` sur ce véhicule) + le contrôle
 * de proximité côté endpoint conducteur (incrément 4b). La signature empêche seulement
 * la forge / l'énumération d'un QR pour un vehicleId arbitraire.
 *
 * Émission (génération QR, 4a) ET vérification (déverrouillage, 4b) partagent ce service
 * pour ne PAS dupliquer le secret ni l'algorithme.
 */
@Injectable()
export class UnlockTokenService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get secret(): string {
    return (
      this.config.get('INVITATION_JWT_SECRET', { infer: true }) ||
      this.config.get('VIZYO_AUTH_JWT_ACCESS_SECRET', { infer: true })
    );
  }

  private sign(vehicleId: string): string {
    return createHmac('sha256', this.secret).update(vehicleId).digest('base64url');
  }

  /** Jeton opaque `<vehicleId>.<hmac>` à encoder dans le QR. */
  signVehicleToken(vehicleId: string): string {
    return `${vehicleId}.${this.sign(vehicleId)}`;
  }

  /** Vérifie le jeton et renvoie le vehicleId, ou `null` si invalide / forgé. */
  verifyVehicleToken(token: string | null | undefined): string | null {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const vehicleId = token.slice(0, dot);
    const providedSig = token.slice(dot + 1);
    const expectedSig = this.sign(vehicleId);
    const a = Buffer.from(providedSig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
    return vehicleId;
  }

  /** Deep link complet vers l'écran conducteur de déverrouillage. */
  buildDeepLink(vehicleId: string): { token: string; url: string } {
    const token = this.signVehicleToken(vehicleId);
    const baseUrl = this.config.get('APP_BASE_URL', { infer: true });
    const url = `${baseUrl.replace(/\/$/, '')}/driver/unlock?token=${encodeURIComponent(token)}`;
    return { token, url };
  }
}

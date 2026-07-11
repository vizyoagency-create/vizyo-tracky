import { Module } from '@nestjs/common';
import { UnlockTokenService } from './unlock-token.service';

/**
 * feat/comptes-conducteurs — module de déverrouillage conducteur.
 * 4a : fournit `UnlockTokenService` (émission des jetons QR, consommé par VehiclesModule).
 * 4b (à venir) : ajoutera le contrôleur `POST /driver/unlock` (vérif token + proximité + RESTORE).
 */
@Module({
  providers: [UnlockTokenService],
  exports: [UnlockTokenService],
})
export class DriverUnlockModule {}

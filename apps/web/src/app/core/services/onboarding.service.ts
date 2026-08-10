import { computed, inject, Injectable, signal } from '@angular/core';
import { MeProfile, UsersApiService } from './users.service';

/**
 * V1.5 (Sprint J) — Pilotage du wizard d'onboarding.
 *
 * Active automatiquement au premier login si `User.onboardingCompletedAt = null`.
 * Le DashboardLayoutComponent consomme `shouldShow` et rend le wizard en
 * overlay plein ecran. Skippable : le user peut fermer le wizard à tout moment,
 * mais la signal `shouldShow` repassera a true au prochain login tant que
 * `markComplete()` n'a pas ete appele.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private readonly usersApi = inject(UsersApiService);

  readonly profile = signal<MeProfile | null>(null);

  /** Wizard ouvert (peut etre re-ouvert depuis /account meme apres completion). */
  readonly shouldShow = signal(false);

  /** True si l'utilisateur n'a JAMAIS termine l'onboarding (premier login). */
  readonly isFirstTime = computed(() => {
    const p = this.profile();
    return p !== null && p.onboardingCompletedAt === null;
  });

  /** Charge le profil + ouvre le wizard si premier login. */
  async loadProfileAndDecide(): Promise<void> {
    try {
      const me = await this.usersApi.me();
      this.profile.set(me);
      if (me.onboardingCompletedAt === null) {
        this.shouldShow.set(true);
      }
    } catch {
      // Silent — l'onboarding peut etre relance manuellement plus tard.
    }
  }

  open(): void {
    this.shouldShow.set(true);
  }

  close(): void {
    this.shouldShow.set(false);
  }

  async markComplete(): Promise<void> {
    try {
      await this.usersApi.completeOnboarding();
      const p = this.profile();
      if (p) {
        this.profile.set({ ...p, onboardingCompletedAt: new Date().toISOString() });
      }
    } finally {
      this.shouldShow.set(false);
    }
  }

  reset(): void {
    this.profile.set(null);
    this.shouldShow.set(false);
  }
}

import { Injectable, signal } from '@angular/core';

const VISITS_KEY = 'tracky.pwa.visits';
const DISMISSED_KEY = 'tracky.pwa.dismissed';
const MIN_VISITS_BEFORE_PROMPT = 3;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => void;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Gere le prompt d'installation PWA :
 * - Android Chrome / Edge : capture `beforeinstallprompt` et expose `promptInstall()`.
 * - iOS Safari : pas d'API, on expose `isIosSafari()` pour afficher des instructions.
 * - Detecte le mode standalone (utilisateur deja installe) pour masquer la banniere.
 *
 * Strategie d'affichage :
 * - Compte les visites en localStorage (incremente une fois par session).
 * - Affiche la banniere apres MIN_VISITS_BEFORE_PROMPT, sauf si l'utilisateur l'a rejetee.
 */
@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private deferredPrompt: BeforeInstallPromptEvent | null = null;

  readonly canInstall = signal(false);
  readonly isStandalone = signal(this.detectStandalone());
  readonly shouldShowBanner = signal(false);

  init(): void {
    // Le browser nous notifie quand l'app est eligible a l'installation
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.canInstall.set(true);
      this.evaluateBanner();
    });

    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.canInstall.set(false);
      this.shouldShowBanner.set(false);
      this.isStandalone.set(true);
    });

    // Detection mode standalone reactive (rare mais possible apres install)
    window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
      this.isStandalone.set(e.matches);
    });

    this.incrementVisits();
    this.evaluateBanner();
  }

  /**
   * Declenche le prompt natif Android/Edge. Retourne true si l'utilisateur a accepte.
   * Ne fait rien sur iOS Safari (le browser n'expose pas l'API).
   */
  async promptInstall(): Promise<boolean> {
    if (!this.deferredPrompt) return false;
    this.deferredPrompt.prompt();
    const { outcome } = await this.deferredPrompt.userChoice;
    this.deferredPrompt = null;
    this.canInstall.set(false);
    this.shouldShowBanner.set(false);
    return outcome === 'accepted';
  }

  /** Masque la banniere et memorise le rejet pendant 30 jours. */
  dismissBanner(): void {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch { /* localStorage indisponible */ }
    this.shouldShowBanner.set(false);
  }

  isIosSafari(): boolean {
    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua);
    const isStandalone = (navigator as { standalone?: boolean }).standalone === true;
    // On ne traite que Safari iOS (CriOS = Chrome iOS, FxiOS = Firefox iOS)
    return isIos && !/CriOS|FxiOS/.test(ua) && !isStandalone;
  }

  private detectStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(display-mode: standalone)').matches
      || (navigator as { standalone?: boolean }).standalone === true;
  }

  private incrementVisits(): void {
    try {
      const current = Number(localStorage.getItem(VISITS_KEY) ?? '0') || 0;
      localStorage.setItem(VISITS_KEY, String(current + 1));
    } catch { /* localStorage indisponible */ }
  }

  private evaluateBanner(): void {
    if (this.isStandalone()) {
      this.shouldShowBanner.set(false);
      return;
    }

    try {
      const visits = Number(localStorage.getItem(VISITS_KEY) ?? '0') || 0;
      const dismissedAt = Number(localStorage.getItem(DISMISSED_KEY) ?? '0') || 0;
      const dismissedRecently = dismissedAt > 0 && (Date.now() - dismissedAt) < 30 * 24 * 60 * 60 * 1000;

      const eligible = visits >= MIN_VISITS_BEFORE_PROMPT && !dismissedRecently;
      // On affiche la banniere si :
      //  - Android : prompt deferred dispo + eligible
      //  - iOS Safari : detecte + eligible (instructions manuelles)
      this.shouldShowBanner.set(eligible && (this.canInstall() || this.isIosSafari()));
    } catch {
      this.shouldShowBanner.set(false);
    }
  }
}

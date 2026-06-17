import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  callback: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  duration: number;
  /**
   * Optional CTA shown as a button inside the toast. duration=0 recommended
   * (sinon le toast disparait avant que l'user clique).
   */
  action?: ToastAction;
  /**
   * Second optional CTA — utilise principalement par les toasts CRITICAL pour
   * exposer "Acquitter" + "Voir" en miroir des actions de la notif systeme.
   */
  extraAction?: ToastAction;
  /**
   * Severite logique (independante de `kind` qui ne pilote que la couleur).
   * 'critical' : declenche un son + vibration au push, affiche un style plus
   * saillant. Reserve aux alertes vitales (SOS, accident).
   */
  severity?: 'critical';
  /**
   * Clé de dédup anti-spam : si un toast ACTIF porte la même `dedupeKey`, un
   * nouveau `show()` avec cette clé ne l'empile pas (il renvoie le toast existant).
   * Utilisé pour les alertes récurrentes (ex. « Alimentation coupée » qui se répète
   * sur un même véhicule) afin de ne pas accumuler des toasts critiques persistants.
   */
  dedupeKey?: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  /** Audio cree paresseusement au premier critical pour respecter les autoplay policies. */
  private criticalAudio: HTMLAudioElement | null = null;
  /** Timestamp du dernier critical pour debouncer son+vibration <2s. */
  private lastCriticalSignalAt = 0;
  private static readonly CRITICAL_DEBOUNCE_MS = 2000;
  /** Max de toasts visibles simultanement (les plus anciens non-critical sont retires au-dela). */
  private static readonly MAX_VISIBLE = 3;

  show(toast: Omit<Toast, 'id' | 'duration'> & { id?: string; duration?: number }): string {
    // Coalescing anti-spam : un toast actif avec la même dedupeKey empêche
    // d'en empiler un nouveau (alerte critique récurrente → un seul toast).
    if (toast.dedupeKey) {
      const existing = this._toasts().find((t) => t.dedupeKey === toast.dedupeKey);
      if (existing) return existing.id;
    }
    const id = toast.id ?? crypto.randomUUID();
    const full: Toast = { duration: 4000, ...toast, id };
    this._toasts.update((list) => ToastService.capStack([...list, full]));
    if (full.duration > 0) {
      setTimeout(() => this.dismiss(id), full.duration);
    }
    if (full.severity === 'critical') {
      this.signalCritical();
    }
    return id;
  }

  success(title: string, message?: string) {
    return this.show({ kind: 'success', title, message });
  }
  error(title: string, message?: string) {
    return this.show({ kind: 'error', title, message, duration: 6000 });
  }
  warning(title: string, message?: string) {
    return this.show({ kind: 'warning', title, message });
  }
  info(title: string, message?: string) {
    return this.show({ kind: 'info', title, message });
  }

  /**
   * Toast pour alerte CRITICAL — duration=0 (manuel), severity=critical
   * (declenche son + vibration), kind=error pour la couleur. Les actions
   * "Acquitter" et "Voir" sont passees par l'appelant pour decoupler de la
   * dependance Router/HttpClient.
   */
  critical(input: {
    title: string;
    message?: string;
    onAcknowledge?: () => void;
    onView?: () => void;
    dedupeKey?: string;
  }): string {
    return this.show({
      kind: 'error',
      title: input.title,
      message: input.message,
      duration: 0,
      severity: 'critical',
      action: input.onAcknowledge ? { label: 'Acquitter', callback: input.onAcknowledge } : undefined,
      extraAction: input.onView ? { label: 'Voir', callback: input.onView } : undefined,
      dedupeKey: input.dedupeKey,
    });
  }

  dismiss(id: string) {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  /** Ferme tous les toasts d'un coup (bouton "Tout fermer" du container). */
  dismissAll(): void {
    this._toasts.set([]);
  }

  /**
   * Plafonne la pile a MAX_VISIBLE en retirant les plus anciens toasts
   * NON-critical. Un toast critical (duration=0, alerte vitale) n'est jamais
   * retire automatiquement — l'utilisateur doit l'acquitter/fermer.
   */
  private static capStack(list: Toast[]): Toast[] {
    let excess = list.length - ToastService.MAX_VISIBLE;
    if (excess <= 0) return list;
    return list.filter((t) => {
      if (excess > 0 && t.severity !== 'critical') {
        excess--;
        return false;
      }
      return true;
    });
  }

  /**
   * Pre-charge l'Audio sur une interaction utilisateur (par ex. clic "Activer
   * les notifications"). Sans pre-chargement, le premier appel a play() peut
   * etre bloque par l'autoplay policy du browser.
   */
  primeCriticalAudio(): void {
    if (typeof window === 'undefined') return;
    if (this.criticalAudio) return;
    try {
      const audio = new Audio('/assets/sounds/alert-critical.wav');
      audio.preload = 'auto';
      audio.volume = 0.6;
      audio.load();
      this.criticalAudio = audio;
    } catch {
      // Audio() peut throw dans des contextes restreints (SSR, certains iframes).
    }
  }

  /**
   * Joue son + vibration pour CRITICAL, debouncee a 2s pour eviter le spam si
   * 5 alertes arrivent dans la meme seconde.
   */
  private signalCritical(): void {
    const now = Date.now();
    if (now - this.lastCriticalSignalAt < ToastService.CRITICAL_DEBOUNCE_MS) return;
    this.lastCriticalSignalAt = now;

    // Vibration si supportee (mobile uniquement, ignore sur desktop).
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate([200, 100, 200, 100, 200]);
      }
    } catch { /* ignore */ }

    // Son : si l'audio est pre-charge (via primeCriticalAudio), play immediat.
    // Sinon creation paresseuse — l'autoplay policy peut bloquer le premier
    // coup, c'est OK : le user verra quand meme le toast.
    try {
      if (!this.criticalAudio && typeof window !== 'undefined') {
        this.criticalAudio = new Audio('/assets/sounds/alert-critical.wav');
        this.criticalAudio.volume = 0.6;
      }
      if (this.criticalAudio) {
        // currentTime = 0 garantit qu'un nouveau critical re-joue depuis le debut
        // meme si le precedent est encore en cours (rare, le son fait 320ms).
        this.criticalAudio.currentTime = 0;
        const playPromise = this.criticalAudio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => { /* autoplay bloque, silencieux */ });
        }
      }
    } catch { /* ignore */ }
  }
}

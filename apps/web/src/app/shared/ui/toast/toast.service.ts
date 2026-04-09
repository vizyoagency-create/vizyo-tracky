import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  duration: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  show(toast: Omit<Toast, 'id' | 'duration'> & { id?: string; duration?: number }): string {
    const id = toast.id ?? crypto.randomUUID();
    const full: Toast = { duration: 4000, ...toast, id };
    this._toasts.update((list) => [...list, full]);
    if (full.duration > 0) {
      setTimeout(() => this.dismiss(id), full.duration);
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

  dismiss(id: string) {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }
}

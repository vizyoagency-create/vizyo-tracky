import { Injectable, signal } from '@angular/core';

/** Verrou UI partagé entre carte, liste et fiche véhicule. */
@Injectable({ providedIn: 'root' })
export class EngineCommandLockService {
  private readonly lockedTrackerIds = signal<ReadonlySet<string>>(new Set());

  isLocked(trackerId: string | null | undefined): boolean {
    return !!trackerId && this.lockedTrackerIds().has(trackerId);
  }

  acquire(trackerId: string): boolean {
    if (this.lockedTrackerIds().has(trackerId)) return false;
    const next = new Set(this.lockedTrackerIds());
    next.add(trackerId);
    this.lockedTrackerIds.set(next);
    return true;
  }

  release(trackerId: string): void {
    if (!this.lockedTrackerIds().has(trackerId)) return;
    const next = new Set(this.lockedTrackerIds());
    next.delete(trackerId);
    this.lockedTrackerIds.set(next);
  }
}

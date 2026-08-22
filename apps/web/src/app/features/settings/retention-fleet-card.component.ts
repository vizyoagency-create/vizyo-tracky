import { swallow } from '../../core/error/swallow';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, type OnInit, inject, signal } from '@angular/core';
import type { RetentionFleetViewDto } from '@vizyo/tracky-shared';
import { Archive, Database, LucideAngularModule, ShieldCheck, Trash2 } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { RetentionService } from '../../core/services/retention.service';

/**
 * Sprint 6 — Encart « Rétention de vos données » (FLEET_ADMIN, dans les Paramètres).
 * Lecture seule : combien de positions de la flotte sont actives / en archive-préavis /
 * à supprimer, et l'échéance. Silencieux tant qu'aucun snapshot n'a été calculé.
 */
@Component({
  selector: 'app-retention-fleet-card',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, DecimalPipe],
  template: `
    @if (data(); as d) {
      <div class="r-card">
        <div class="r-head">
          <lucide-icon [img]="Database" [size]="16" />
          <span class="r-title">Rétention de vos données</span>
        </div>
        <p class="r-desc">
          Vos positions GPS sont conservées <b>{{ d.config.retentionDays }} jours</b>, puis archivées
          (récupérables) <b>{{ d.config.archiveDays }} jours</b> avant suppression. Vos trajets et
          rapports ne sont pas concernés.
        </p>
        <div class="r-stats">
          <div class="r-stat">
            <span class="rn">{{ d.snapshot.activeCount | number }}</span>
            <span class="rl">actives</span>
          </div>
          <div class="r-stat">
            <span class="rn amber">{{ d.snapshot.archiveCount | number }}</span>
            <span class="rl"><lucide-icon [img]="Archive" [size]="11" /> archive</span>
          </div>
          <div class="r-stat">
            <span class="rn red">{{ d.snapshot.toDeleteCount | number }}</span>
            <span class="rl"><lucide-icon [img]="Trash2" [size]="11" /> à supprimer</span>
          </div>
        </div>
        @if (d.snapshot.nextDeletionAt) {
          <p class="r-next">Prochaine suppression : <b>{{ d.snapshot.nextDeletionAt | date: 'dd/MM/yyyy' }}</b></p>
        }
        @if (!d.config.purgeEnabled) {
          <p class="r-note">
            <lucide-icon [img]="ShieldCheck" [size]="12" /> Mode observation : aucune donnée n'est
            actuellement supprimée.
          </p>
        }
      </div>
    }
  `,
  styles: [
    `
      .r-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 16px; }
      .r-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .r-head lucide-icon { color: var(--tracky-light); }
      .r-title { font-size: 14px; font-weight: 600; color: var(--fg-primary); }
      .r-desc { font-size: 12.5px; color: var(--fg-secondary); line-height: 1.5; margin: 0 0 12px; }
      .r-desc b { color: var(--fg-primary); }
      .r-stats { display: flex; gap: 22px; }
      .r-stat { display: flex; flex-direction: column; gap: 2px; }
      .rn { font-family: var(--font-display); font-size: 20px; font-weight: 700; color: var(--fg-primary); }
      .rn.amber { color: var(--texte-attente); }
      .rn.red { color: var(--texte-alerte); }
      .rl { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fg-tertiary); }
      .r-next { font-size: 12px; color: var(--fg-secondary); margin: 12px 0 0; }
      .r-next b { color: var(--fg-primary); }
      .r-note { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--tracky-light); margin: 8px 0 0; }
    `,
  ],
})
export class RetentionFleetCardComponent implements OnInit {
  private readonly retention = inject(RetentionService);
  protected readonly data = signal<RetentionFleetViewDto | null>(null);

  protected readonly Database = Database;
  protected readonly Archive = Archive;
  protected readonly Trash2 = Trash2;
  protected readonly ShieldCheck = ShieldCheck;

  async ngOnInit(): Promise<void> {
    try {
      this.data.set(await firstValueFrom(this.retention.getFleetView()));
    } catch (err) {
      swallow('retention-fleet-card:ngOnInit', err);
      // Encart secondaire : silencieux si pas de snapshot / pas de flotte.
    }
  }
}

import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, type OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { RetentionOverviewDto } from '@vizyo/tracky-shared';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Database,
  HardDrive,
  LucideAngularModule,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { RetentionService } from '../../core/services/retention.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Sprint 6 — Administration → Rétention des positions (SUPER_ADMIN).
 *
 * Lecture seule + recalcul à la demande. Affiche l'état global et par flotte : positions
 * ACTIVES / en ARCHIVE-préavis (récupérables) / À SUPPRIMER, l'ancienneté et l'échéance de
 * suppression. Le bandeau « mode observation (dry-run) » rappelle qu'aucune donnée n'est
 * effacée tant que le flag serveur n'est pas armé.
 */
@Component({
  selector: 'app-admin-retention',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DatePipe, DecimalPipe],
  template: `
    <div class="page">
      <div class="head">
        <a routerLink="/admin" class="back"><lucide-icon [img]="ArrowLeft" [size]="16" /> Administration</a>
        <h1><lucide-icon [img]="Database" [size]="24" /> Rétention des données</h1>
        <p class="sub">
          Conservation des positions GPS : fenêtre active, puis archive/préavis récupérable, puis
          suppression. Compteurs recalculés chaque nuit (et à la demande). Aucune autre donnée
          (véhicules, trajets, utilisateurs…) n'est concernée.
        </p>
      </div>

      @if (loading()) {
        <div class="s-card empty">Chargement…</div>
      } @else if (data(); as d) {
        <!-- Bandeau mode + config -->
        <div class="s-card banner" [class.danger]="d.config.purgeEnabled">
          @if (d.config.purgeEnabled) {
            <span class="mode real"><lucide-icon [img]="AlertTriangle" [size]="14" /> Suppression ACTIVE</span>
          } @else {
            <span class="mode dry"><lucide-icon [img]="ShieldCheck" [size]="14" /> Mode observation (dry-run)</span>
          }
          <div class="cfg">
            <span>Fenêtre active : <b>{{ d.config.retentionDays }} j</b></span>
            <span>Archive / préavis : <b>{{ d.config.archiveDays }} j</b></span>
            <span class="muted">Suppression au-delà de {{ d.config.retentionDays + d.config.archiveDays }} j</span>
          </div>
          <button class="refresh" (click)="refresh()" [disabled]="refreshing()">
            <lucide-icon [img]="RefreshCw" [size]="14" /> {{ refreshing() ? 'Recalcul…' : 'Recalculer' }}
          </button>
        </div>

        @if (!d.config.purgeEnabled) {
          <p class="hint">
            <lucide-icon [img]="ShieldCheck" [size]="14" /> Aucune donnée n'est supprimée : le système
            ne fait que <b>compter</b> ce qui serait concerné. La suppression réelle nécessite
            l'activation explicite du flag serveur.
          </p>
        }

        <!-- Global -->
        <div class="s-card">
          <div class="card-title">
            <lucide-icon [img]="HardDrive" [size]="16" /> Global
            <span class="when">{{ d.computedAt ? (d.computedAt | date: 'dd/MM/yyyy HH:mm') : '—' }}</span>
          </div>
          <div class="tiles">
            <div class="tile">
              <span class="num">{{ d.global.activeCount | number }}</span>
              <span class="lbl">Actives</span>
            </div>
            <div class="tile amber">
              <span class="num">{{ d.global.archiveCount | number }}</span>
              <span class="lbl"><lucide-icon [img]="Archive" [size]="12" /> Archive / préavis</span>
            </div>
            <div class="tile red">
              <span class="num">{{ d.global.toDeleteCount | number }}</span>
              <span class="lbl"><lucide-icon [img]="Trash2" [size]="12" /> À supprimer</span>
            </div>
          </div>
          <div class="meta">
            <span>Plus ancienne : <b>{{ d.global.oldestCreatedAt ? (d.global.oldestCreatedAt | date: 'dd/MM/yyyy') : '—' }}</b></span>
            <span>Prochaine suppression : <b>{{ d.global.nextDeletionAt ? (d.global.nextDeletionAt | date: 'dd/MM/yyyy') : '—' }}</b></span>
          </div>
        </div>

        <!-- Par flotte -->
        <div class="s-card">
          <div class="card-title">Par flotte</div>
          @if (d.fleets.length === 0) {
            <p class="muted small">Aucune position rattachée à une flotte.</p>
          } @else {
            <div class="tbl-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Flotte</th>
                    <th class="n">Actives</th>
                    <th class="n">Archive</th>
                    <th class="n">À supprimer</th>
                    <th>Plus ancienne</th>
                    <th>Prochaine suppr.</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of d.fleets; track f.scope) {
                    <tr>
                      <td class="fname">{{ f.fleetName || '—' }}</td>
                      <td class="n">{{ f.activeCount | number }}</td>
                      <td class="n" [class.amber]="f.archiveCount > 0">{{ f.archiveCount | number }}</td>
                      <td class="n" [class.red]="f.toDeleteCount > 0">{{ f.toDeleteCount | number }}</td>
                      <td class="muted">{{ f.oldestCreatedAt ? (f.oldestCreatedAt | date: 'dd/MM/yy') : '—' }}</td>
                      <td class="muted">{{ f.nextDeletionAt ? (f.nextDeletionAt | date: 'dd/MM/yy') : '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      } @else {
        <div class="s-card empty">État de rétention indisponible.</div>
      }
    </div>
  `,
  styles: [
    `
      .page { max-width: 980px; margin: 0 auto; padding: 8px 0 40px; }
      .head { margin-bottom: 20px; }
      .back {
        display: inline-flex; align-items: center; gap: 6px; color: var(--fg-tertiary);
        font-size: 13px; text-decoration: none; margin-bottom: 10px;
      }
      .back:hover { color: var(--fg-secondary); }
      h1 { display: flex; align-items: center; gap: 10px; font-family: var(--font-display); font-size: 26px; margin: 0 0 8px; color: var(--fg-primary); }
      .sub { color: var(--fg-secondary); font-size: 13px; max-width: 70ch; margin: 0; line-height: 1.5; }

      .s-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 16px); padding: 18px; margin-bottom: 16px; }
      .empty { text-align: center; color: var(--fg-tertiary); }

      .banner { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
      .banner.danger { border-color: rgba(239, 68, 68, .4); }
      .mode { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 5px 11px; border-radius: 999px; }
      .mode.dry { background: rgba(16, 224, 160, .15); color: var(--tracky-light); }
      .mode.real { background: rgba(239, 68, 68, .18); color: #fca5a5; }
      .cfg { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--fg-secondary); }
      .cfg b { color: var(--fg-primary); }
      .muted { color: var(--fg-tertiary); }
      .refresh {
        margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
        background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle);
        padding: 7px 13px; border-radius: 9px; cursor: pointer;
      }
      .refresh:hover:not(:disabled) { color: var(--fg-primary); }
      .refresh:disabled { opacity: .5; cursor: not-allowed; }

      .hint {
        display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.5;
        color: var(--fg-secondary); background: rgba(16, 224, 160, .08); border: 1px solid var(--border-subtle);
        padding: 11px 14px; border-radius: 12px; margin: -6px 0 16px;
      }
      .hint lucide-icon { color: var(--tracky-light); flex-shrink: 0; margin-top: 1px; }

      .card-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; color: var(--fg-primary); margin-bottom: 14px; }
      .card-title .when { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--fg-tertiary); }

      .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
      .tile { display: flex; flex-direction: column; gap: 4px; background: var(--bg-tertiary); border-radius: 12px; padding: 14px; }
      .tile .num { font-family: var(--font-display); font-size: 26px; font-weight: 700; color: var(--fg-primary); }
      .tile .lbl { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-tertiary); }
      .tile.amber .num { color: #fbbf24; }
      .tile.red .num { color: #f87171; }

      .meta { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 14px; font-size: 12.5px; color: var(--fg-secondary); }
      .meta b { color: var(--fg-primary); }

      .tbl-wrap { overflow-x: auto; }
      .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
      .tbl th { text-align: left; color: var(--fg-tertiary); font-weight: 500; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; padding: 6px 10px; border-bottom: 1px solid var(--border-subtle); }
      .tbl th.n, .tbl td.n { text-align: right; }
      .tbl td { padding: 9px 10px; border-bottom: 1px solid var(--border-subtle); color: var(--fg-secondary); }
      .tbl tr:last-child td { border-bottom: none; }
      .fname { color: var(--fg-primary); font-weight: 500; }
      .amber { color: #fbbf24; font-weight: 600; }
      .red { color: #f87171; font-weight: 600; }
      .small { font-size: 12.5px; }

      @media (max-width: 640px) {
        .tiles { grid-template-columns: 1fr; }
        .refresh { margin-left: 0; }
      }
    `,
  ],
})
export class AdminRetentionComponent implements OnInit {
  private readonly retention = inject(RetentionService);
  private readonly toast = inject(ToastService);

  protected readonly data = signal<RetentionOverviewDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Database = Database;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Trash2 = Trash2;
  protected readonly Archive = Archive;
  protected readonly HardDrive = HardDrive;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const d = await firstValueFrom(this.retention.getOverview());
      this.data.set(d);
    } catch {
      this.toast.error('Chargement impossible', "Impossible de charger l'état de rétention.");
    } finally {
      this.loading.set(false);
    }
  }

  protected async refresh(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    try {
      await firstValueFrom(this.retention.refresh());
      await this.load();
      this.toast.success('Snapshot recalculé', 'Les compteurs de rétention sont à jour.');
    } catch {
      this.toast.error('Recalcul impossible', 'Réessaie dans un instant.');
    } finally {
      this.refreshing.set(false);
    }
  }
}

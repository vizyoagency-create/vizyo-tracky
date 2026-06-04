import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule, AlertTriangle, Activity, Terminal, MessageSquare,
  Users, Radio, Shield, Zap,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AdminFixModeService, type AdminAlertSummary } from '../../core/services/admin-fix-mode.service';

@Component({
  selector: 'app-admin-hub',
  standalone: true,
  imports: [RouterLink, LucideAngularModule],
  template: `
    <div class="bento-hub">
      <!-- Header -->
      <div class="bento-header">
        <div class="bento-title-row">
          <div>
            <h1>Administration</h1>
            <p>Supervision, diagnostic et configuration.</p>
          </div>
          @if (stats(); as s) {
            <div class="live-pulse" [class.warn]="s.failing > 0 || s.criticalLastHour > 0">
              <span class="pulse-dot"></span>
              <span class="pulse-label">{{ s.failing > 0 || s.criticalLastHour > 0 ? 'Alertes actives' : 'Systeme nominal' }}</span>
            </div>
          }
        </div>
      </div>

      <!-- Bento Grid -->
      <div class="bento-grid">
        <!-- HERO : Centre d'alertes (2 cols) -->
        <a routerLink="/admin/alerts" class="bento-card hero red" style="--delay: 0">
          <div class="card-glow"></div>
          <div class="card-inner">
            <div class="card-top">
              <div class="card-icon red">
                <lucide-icon [img]="AlertTriangle" [size]="26"></lucide-icon>
              </div>
              <div class="card-badges">
                @if (stats(); as s) {
                  @if (s.failing > 0) {
                    <span class="badge badge-red">{{ s.failing }} failing</span>
                  }
                  @if (s.offline > 0) {
                    <span class="badge badge-amber">{{ s.offline }} offline</span>
                  }
                  @if (s.errorsLast24h > 0) {
                    <span class="badge badge-orange">{{ s.errorsLast24h }} err</span>
                  }
                  @if (s.criticalLastHour > 0) {
                    <span class="badge badge-red pulse-badge">{{ s.criticalLastHour }} crit</span>
                  }
                  @if (s.failing === 0 && s.offline === 0 && s.errorsLast24h === 0) {
                    <span class="badge badge-green">RAS</span>
                  }
                }
              </div>
            </div>
            <h3>Centre d'alertes</h3>
            <p>Trackers, commandes, erreurs applicatives — tout en un coup d'oeil.</p>
          </div>
        </a>

        <!-- Diagnostic -->
        <a routerLink="/admin/observability" class="bento-card green" style="--delay: 1">
          <div class="card-glow"></div>
          <div class="card-inner">
            <div class="card-icon green">
              <lucide-icon [img]="Activity" [size]="22"></lucide-icon>
            </div>
            <h3>Diagnostic & Tests</h3>
            <p>Wire logs, timeline, test push & SMS.</p>
          </div>
        </a>

        <!-- Trackers -->
        <a routerLink="/admin/trackers" class="bento-card blue" style="--delay: 2">
          <div class="card-glow"></div>
          <div class="card-inner">
            <div class="card-icon blue">
              <lucide-icon [img]="Radio" [size]="22"></lucide-icon>
            </div>
            <h3>Trackers</h3>
            <p>Inventaire, SIM, assignation vehicules.</p>
          </div>
        </a>

        <!-- Commandes -->
        <a routerLink="/admin/commands" class="bento-card blue-alt" style="--delay: 3">
          <div class="card-glow"></div>
          <div class="card-inner">
            <div class="card-icon blue-alt">
              <lucide-icon [img]="Terminal" [size]="22"></lucide-icon>
            </div>
            <h3>Commandes</h3>
            <p>Monitorer les commandes TCP/SMS envoyees.</p>
          </div>
        </a>

        <!-- SMS & Backup -->
        <a routerLink="/admin/sms" class="bento-card purple" style="--delay: 4">
          <div class="card-glow"></div>
          <div class="card-inner">
            <div class="card-icon purple">
              <lucide-icon [img]="MessageSquare" [size]="22"></lucide-icon>
            </div>
            <h3>SMS & Backup</h3>
            <p>Provisioning, logs SMS, allowlist, backups.</p>
          </div>
        </a>

        <!-- Sync Auth -->
        <a routerLink="/admin/auth-sync" class="bento-card cyan" style="--delay: 5">
          <div class="card-glow"></div>
          <div class="card-inner">
            <div class="card-icon cyan">
              <lucide-icon [img]="Users" [size]="22"></lucide-icon>
            </div>
            <h3>Sync Auth</h3>
            <p>Reconcilier comptes Vizyo Auth vs Tracky.</p>
          </div>
        </a>
      </div>
    </div>
  `,
  styles: [`
    .bento-hub { max-width: 960px; }

    /* Header */
    .bento-header { margin-bottom: 28px; }
    .bento-title-row {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; flex-wrap: wrap;
    }
    .bento-header h1 {
      font-family: var(--font-display, Poppins, sans-serif);
      font-size: 28px; font-weight: 800;
      color: var(--fg-primary); margin: 0;
      letter-spacing: -0.5px;
    }
    .bento-header p {
      color: var(--fg-tertiary); font-size: 13px; margin: 4px 0 0;
    }

    /* Live pulse indicator */
    .live-pulse {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 14px; border-radius: 20px;
      background: rgba(16, 224, 160, 0.08);
      border: 1px solid rgba(16, 224, 160, 0.15);
      font-size: 12px; font-weight: 600; color: var(--tracky-light);
    }
    .live-pulse.warn {
      background: rgba(239, 68, 68, 0.08);
      border-color: rgba(239, 68, 68, 0.2);
      color: #f87171;
    }
    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: currentColor;
      animation: pulse-glow 2s ease-in-out infinite;
    }
    .live-pulse.warn .pulse-dot { animation: pulse-glow-warn 1.5s ease-in-out infinite; }

    @keyframes pulse-glow {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16, 224, 160, 0.4); }
      50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(16, 224, 160, 0); }
    }
    @keyframes pulse-glow-warn {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
      50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
    }

    /* Bento Grid */
    .bento-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-auto-rows: minmax(140px, auto);
      gap: 12px;
    }
    @media (max-width: 768px) {
      .bento-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 480px) {
      .bento-grid { grid-template-columns: 1fr; }
      .bento-card.hero { grid-column: span 1; }
    }

    /* Card base */
    .bento-card {
      position: relative; overflow: hidden;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 18px;
      text-decoration: none;
      transition: transform 0.25s var(--ease-tracky, cubic-bezier(0.16, 1, 0.3, 1)),
                  border-color 0.25s ease, box-shadow 0.3s ease;
      animation: bento-enter 0.5s var(--ease-tracky, cubic-bezier(0.16, 1, 0.3, 1)) both;
      animation-delay: calc(var(--delay, 0) * 80ms);
    }
    .bento-card:hover {
      transform: translateY(-3px) scale(1.01);
    }
    .bento-card:active { transform: translateY(0) scale(0.99); }

    @keyframes bento-enter {
      from { opacity: 0; transform: translateY(16px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* Hero card (2 cols) */
    .bento-card.hero {
      grid-column: span 2;
      min-height: 170px;
    }

    /* Glow effect on hover */
    .card-glow {
      position: absolute; inset: 0;
      opacity: 0; transition: opacity 0.3s ease;
      pointer-events: none; border-radius: 18px;
    }
    .bento-card:hover .card-glow { opacity: 1; }

    .bento-card.red .card-glow { background: radial-gradient(ellipse at 30% 20%, rgba(239,68,68,0.08), transparent 70%); }
    .bento-card.red:hover { border-color: rgba(239,68,68,0.3); box-shadow: 0 4px 30px rgba(239,68,68,0.08); }

    .bento-card.green .card-glow { background: radial-gradient(ellipse at 30% 20%, rgba(16,224,160,0.08), transparent 70%); }
    .bento-card.green:hover { border-color: rgba(16,224,160,0.3); box-shadow: 0 4px 30px rgba(16,224,160,0.08); }

    .bento-card.blue .card-glow { background: radial-gradient(ellipse at 30% 20%, rgba(59,130,246,0.08), transparent 70%); }
    .bento-card.blue:hover { border-color: rgba(59,130,246,0.3); box-shadow: 0 4px 30px rgba(59,130,246,0.08); }

    .bento-card.blue-alt .card-glow { background: radial-gradient(ellipse at 30% 20%, rgba(99,102,241,0.08), transparent 70%); }
    .bento-card.blue-alt:hover { border-color: rgba(99,102,241,0.3); box-shadow: 0 4px 30px rgba(99,102,241,0.08); }

    .bento-card.purple .card-glow { background: radial-gradient(ellipse at 30% 20%, rgba(168,85,247,0.08), transparent 70%); }
    .bento-card.purple:hover { border-color: rgba(168,85,247,0.3); box-shadow: 0 4px 30px rgba(168,85,247,0.08); }

    .bento-card.cyan .card-glow { background: radial-gradient(ellipse at 30% 20%, rgba(6,182,212,0.08), transparent 70%); }
    .bento-card.cyan:hover { border-color: rgba(6,182,212,0.3); box-shadow: 0 4px 30px rgba(6,182,212,0.08); }

    /* Card inner */
    .card-inner {
      position: relative; z-index: 1;
      padding: 22px 24px;
      display: flex; flex-direction: column; gap: 10px;
      height: 100%;
    }
    .card-top {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 12px;
    }

    /* Icon */
    .card-icon {
      width: 48px; height: 48px; border-radius: 14px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: transform 0.3s var(--ease-tracky, cubic-bezier(0.16, 1, 0.3, 1));
    }
    .bento-card:hover .card-icon { transform: scale(1.1) rotate(-5deg); }

    .card-icon.red { background: rgba(239,68,68,0.12); color: #f87171; }
    .card-icon.green { background: rgba(16,224,160,0.12); color: var(--tracky-light); }
    .card-icon.blue { background: rgba(59,130,246,0.12); color: #60a5fa; }
    .card-icon.blue-alt { background: rgba(99,102,241,0.12); color: #818cf8; }
    .card-icon.purple { background: rgba(168,85,247,0.12); color: #c084fc; }
    .card-icon.cyan { background: rgba(6,182,212,0.12); color: #22d3ee; }

    /* Text */
    .card-inner h3 {
      font-family: var(--font-display, Poppins, sans-serif);
      font-size: 16px; font-weight: 700;
      color: var(--fg-primary); margin: 0;
    }
    .bento-card.hero .card-inner h3 { font-size: 20px; }

    .card-inner p {
      font-size: 12px; color: var(--fg-tertiary); margin: 0;
      line-height: 1.4;
    }

    /* Badges */
    .card-badges {
      display: flex; flex-wrap: wrap; gap: 6px;
      justify-content: flex-end;
    }
    .badge {
      display: inline-flex; align-items: center;
      padding: 3px 10px; border-radius: 12px;
      font-size: 11px; font-weight: 700;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      letter-spacing: 0.3px;
    }
    .badge-red { background: rgba(239,68,68,0.15); color: #f87171; }
    .badge-amber { background: rgba(245,158,11,0.15); color: #fbbf24; }
    .badge-orange { background: rgba(251,146,60,0.15); color: #fb923c; }
    .badge-green { background: rgba(16,224,160,0.12); color: var(--tracky-light); }
    .pulse-badge { animation: badge-pulse 1.5s ease-in-out infinite; }
    @keyframes badge-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `],
})
export class AdminHubComponent implements OnInit {
  private readonly api = inject(AdminFixModeService);

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Activity = Activity;
  protected readonly Terminal = Terminal;
  protected readonly MessageSquare = MessageSquare;
  protected readonly Users = Users;
  protected readonly Radio = Radio;
  protected readonly Shield = Shield;
  protected readonly Zap = Zap;

  readonly stats = signal<AdminAlertSummary | null>(null);

  ngOnInit(): void {
    firstValueFrom(this.api.alerts())
      .then((d) => this.stats.set(d.summary))
      .catch(() => { /* silencieux */ });
  }
}

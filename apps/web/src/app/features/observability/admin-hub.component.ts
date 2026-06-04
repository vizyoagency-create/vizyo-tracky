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
      <div class="bento-header">
        <div class="bento-title-row">
          <div>
            <h1>Administration</h1>
            <p>Supervision, diagnostic et configuration.</p>
          </div>
          @if (stats(); as s) {
            <div class="live-pulse" [class.warn]="s.failing > 0 || s.criticalLastHour > 0">
              <span class="pulse-dot"></span>
              {{ s.failing > 0 || s.criticalLastHour > 0 ? 'Alertes actives' : 'Systeme nominal' }}
            </div>
          }
        </div>
      </div>

      <div class="bento-grid">
        <!-- HERO : Centre d'alertes — 2 cols, 2 rows -->
        <a routerLink="/admin/alerts" class="bento-card hero" style="--i:0">
          <div class="glow glow-red"></div>
          <div class="hero-bg"></div>
          <div class="inner hero-inner">
            <div class="icon icon-red icon-lg">
              <lucide-icon [img]="AlertTriangle" [size]="28"></lucide-icon>
            </div>
            <h3>Centre d'alertes</h3>
            <p>Trackers, commandes, erreurs applicatives — vue unifiee.</p>
            <div class="hero-stats">
              @if (stats(); as s) {
                <div class="stat" [class.active]="s.failing > 0">
                  <span class="stat-val">{{ s.failing }}</span>
                  <span class="stat-lbl">Failing</span>
                </div>
                <div class="stat" [class.active]="s.offline > 0">
                  <span class="stat-val">{{ s.offline }}</span>
                  <span class="stat-lbl">Offline</span>
                </div>
                <div class="stat" [class.active]="s.pending > 0">
                  <span class="stat-val">{{ s.pending }}</span>
                  <span class="stat-lbl">Pending</span>
                </div>
                <div class="stat" [class.active]="s.errorsLast24h > 0">
                  <span class="stat-val">{{ s.errorsLast24h }}</span>
                  <span class="stat-lbl">Erreurs 24h</span>
                </div>
              }
            </div>
          </div>
        </a>

        <!-- Diagnostic — 1 col, 2 rows (tall) -->
        <a routerLink="/admin/observability" class="bento-card tall" style="--i:1">
          <div class="glow glow-green"></div>
          <div class="inner">
            <div class="icon icon-green">
              <lucide-icon [img]="Activity" [size]="22"></lucide-icon>
            </div>
            <h3>Diagnostic & Tests</h3>
            <p>Wire logs, timeline tracker, test push notification, test SMS fallback.</p>
          </div>
        </a>

        <!-- Trackers -->
        <a routerLink="/admin/trackers" class="bento-card" style="--i:2">
          <div class="glow glow-blue"></div>
          <div class="inner">
            <div class="icon icon-blue">
              <lucide-icon [img]="Radio" [size]="22"></lucide-icon>
            </div>
            <h3>Trackers</h3>
            <p>Inventaire, SIM, assignation.</p>
          </div>
        </a>

        <!-- Commandes -->
        <a routerLink="/admin/commands" class="bento-card" style="--i:3">
          <div class="glow glow-indigo"></div>
          <div class="inner">
            <div class="icon icon-indigo">
              <lucide-icon [img]="Terminal" [size]="22"></lucide-icon>
            </div>
            <h3>Commandes</h3>
            <p>Commandes TCP/SMS envoyees.</p>
          </div>
        </a>

        <!-- SMS & Backup -->
        <a routerLink="/admin/sms" class="bento-card" style="--i:4">
          <div class="glow glow-purple"></div>
          <div class="inner">
            <div class="icon icon-purple">
              <lucide-icon [img]="MessageSquare" [size]="22"></lucide-icon>
            </div>
            <h3>SMS & Backup</h3>
            <p>Provisioning, logs, allowlist, backups.</p>
          </div>
        </a>

        <!-- Sync Auth -->
        <a routerLink="/admin/auth-sync" class="bento-card" style="--i:5">
          <div class="glow glow-cyan"></div>
          <div class="inner">
            <div class="icon icon-cyan">
              <lucide-icon [img]="Users" [size]="22"></lucide-icon>
            </div>
            <h3>Sync Auth</h3>
            <p>Comptes Vizyo Auth vs Tracky.</p>
          </div>
        </a>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .bento-hub { max-width: 880px; }

    .bento-header { margin-bottom: 32px; }
    .bento-title-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; flex-wrap: wrap;
    }
    .bento-header h1 {
      font-family: var(--font-display, Poppins, sans-serif);
      font-size: 26px; font-weight: 800;
      color: var(--fg-primary); margin: 0; letter-spacing: -0.5px;
    }
    .bento-header p { color: var(--fg-tertiary); font-size: 13px; margin: 4px 0 0; }

    /* Pulse */
    .live-pulse {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 14px 5px 10px; border-radius: 20px;
      font-size: 11px; font-weight: 600;
      background: rgba(16,224,160,.06); border: 1px solid rgba(16,224,160,.12);
      color: var(--tracky-light);
    }
    .live-pulse.warn {
      background: rgba(239,68,68,.06); border-color: rgba(239,68,68,.15); color: #f87171;
    }
    .pulse-dot {
      width: 7px; height: 7px; border-radius: 50%; background: currentColor;
      animation: pdot 2s ease-in-out infinite;
    }
    .live-pulse.warn .pulse-dot { animation: pdot-w 1.4s ease-in-out infinite; }
    @keyframes pdot {
      0%,100% { box-shadow: 0 0 0 0 rgba(16,224,160,.4); }
      50% { box-shadow: 0 0 0 5px rgba(16,224,160,0); opacity: .5; }
    }
    @keyframes pdot-w {
      0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.4); }
      50% { box-shadow: 0 0 0 5px rgba(239,68,68,0); opacity: .5; }
    }

    /* ── GRID ── */
    .bento-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(2, 1fr) auto;
      gap: 10px;
    }
    /* Hero : col 1-2, row 1-2 */
    .bento-card.hero { grid-column: 1 / 3; grid-row: 1 / 3; }
    /* Diagnostic tall : col 3, row 1-2 */
    .bento-card.tall { grid-column: 3; grid-row: 1 / 3; }

    @media (max-width: 700px) {
      .bento-grid {
        grid-template-columns: 1fr 1fr;
        grid-template-rows: auto;
      }
      .bento-card.hero { grid-column: 1 / -1; grid-row: auto; }
      .bento-card.tall { grid-column: 1 / -1; grid-row: auto; }
    }
    @media (max-width: 440px) {
      .bento-grid { grid-template-columns: 1fr; }
    }

    /* ── CARD ── */
    .bento-card {
      position: relative; overflow: hidden;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 16px; text-decoration: none;
      transition: transform .3s cubic-bezier(.16,1,.3,1),
                  border-color .25s, box-shadow .35s;
      animation: enter .45s cubic-bezier(.16,1,.3,1) both;
      animation-delay: calc(var(--i,0) * 70ms);
    }
    .bento-card:hover { transform: translateY(-2px); }
    .bento-card:active { transform: translateY(0) scale(.99); }
    @keyframes enter {
      from { opacity: 0; transform: translateY(14px) scale(.98); }
    }

    /* Glow */
    .glow {
      position: absolute; inset: 0; opacity: 0; transition: opacity .35s;
      pointer-events: none; border-radius: 16px;
    }
    .bento-card:hover .glow { opacity: 1; }
    .glow-red    { background: radial-gradient(ellipse at 20% 30%, rgba(239,68,68,.1), transparent 65%); }
    .glow-green  { background: radial-gradient(ellipse at 30% 30%, rgba(16,224,160,.1), transparent 65%); }
    .glow-blue   { background: radial-gradient(ellipse at 30% 30%, rgba(59,130,246,.1), transparent 65%); }
    .glow-indigo { background: radial-gradient(ellipse at 30% 30%, rgba(99,102,241,.1), transparent 65%); }
    .glow-purple { background: radial-gradient(ellipse at 30% 30%, rgba(168,85,247,.1), transparent 65%); }
    .glow-cyan   { background: radial-gradient(ellipse at 30% 30%, rgba(6,182,212,.1), transparent 65%); }

    .bento-card:hover { box-shadow: 0 8px 32px rgba(0,0,0,.15); }
    .bento-card.hero:hover  { border-color: rgba(239,68,68,.25); }
    .bento-card.tall:hover  { border-color: rgba(16,224,160,.25); }
    .bento-card:nth-child(3):hover { border-color: rgba(59,130,246,.25); }
    .bento-card:nth-child(4):hover { border-color: rgba(99,102,241,.25); }
    .bento-card:nth-child(5):hover { border-color: rgba(168,85,247,.25); }
    .bento-card:nth-child(6):hover { border-color: rgba(6,182,212,.25); }

    /* Inner */
    .inner {
      position: relative; z-index: 1;
      padding: 20px; display: flex; flex-direction: column; gap: 8px;
      height: 100%;
    }
    .inner h3 {
      font-family: var(--font-display, Poppins, sans-serif);
      font-size: 15px; font-weight: 700;
      color: var(--fg-primary); margin: 0;
    }
    .inner p {
      font-size: 11.5px; line-height: 1.45;
      color: var(--fg-tertiary); margin: 0;
    }

    /* Icon */
    .icon {
      width: 42px; height: 42px; border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-bottom: 2px;
      transition: transform .3s cubic-bezier(.16,1,.3,1);
    }
    .icon-lg { width: 50px; height: 50px; border-radius: 14px; }
    .bento-card:hover .icon { transform: scale(1.08) rotate(-4deg); }

    .icon-red    { background: rgba(239,68,68,.1);  color: #f87171; }
    .icon-green  { background: rgba(16,224,160,.1); color: var(--tracky-light); }
    .icon-blue   { background: rgba(59,130,246,.1); color: #60a5fa; }
    .icon-indigo { background: rgba(99,102,241,.1); color: #818cf8; }
    .icon-purple { background: rgba(168,85,247,.1); color: #c084fc; }
    .icon-cyan   { background: rgba(6,182,212,.1);  color: #22d3ee; }

    /* ── HERO specifics ── */
    .hero-bg {
      position: absolute; inset: 0; pointer-events: none;
      background:
        radial-gradient(circle at 85% 80%, rgba(239,68,68,.06) 0%, transparent 50%),
        radial-gradient(circle at 10% 90%, rgba(251,146,60,.04) 0%, transparent 40%);
    }
    .hero-inner { justify-content: space-between; }
    .hero-inner h3 { font-size: 20px; letter-spacing: -0.3px; }
    .hero-inner p { max-width: 320px; }

    .hero-stats {
      display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto;
    }
    .stat {
      display: flex; flex-direction: column; align-items: center;
      padding: 8px 14px; border-radius: 10px;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.04);
      min-width: 64px;
      transition: border-color .2s, background .2s;
    }
    .stat.active { border-color: rgba(239,68,68,.2); background: rgba(239,68,68,.06); }
    .stat-val {
      font-family: var(--font-display, Poppins, sans-serif);
      font-size: 20px; font-weight: 800; color: var(--fg-primary);
      line-height: 1;
    }
    .stat.active .stat-val { color: #f87171; }
    .stat-lbl {
      font-size: 9px; text-transform: uppercase; letter-spacing: .5px;
      color: var(--fg-tertiary); margin-top: 3px; font-weight: 600;
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

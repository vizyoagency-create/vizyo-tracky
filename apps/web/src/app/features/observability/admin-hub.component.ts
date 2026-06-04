import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule, AlertTriangle, Activity, Terminal, MessageSquare,
  Users, Gauge, Shield, Radio,
} from 'lucide-angular';

@Component({
  selector: 'app-admin-hub',
  standalone: true,
  imports: [RouterLink, LucideAngularModule],
  template: `
    <div class="hub">
      <div class="hub-header">
        <h1>Administration</h1>
        <p class="muted">Outils de diagnostic, supervision et configuration avancee.</p>
      </div>

      <div class="hub-grid">
        @for (item of sections; track item.route) {
          <a [routerLink]="item.route" class="hub-card">
            <div class="hub-card-icon" [class]="item.color">
              <lucide-icon [img]="item.icon" [size]="22"></lucide-icon>
            </div>
            <div class="hub-card-content">
              <h3>{{ item.label }}</h3>
              <p>{{ item.desc }}</p>
            </div>
          </a>
        }
      </div>
    </div>
  `,
  styles: [`
    .hub { max-width: 900px }
    .hub-header { margin-bottom: 24px }
    .hub-header h1 { font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0 }
    .muted { color: var(--fg-tertiary); font-size: 13px; margin: 4px 0 0 }

    .hub-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px }

    .hub-card {
      display: flex; align-items: center; gap: 14px;
      padding: 18px 20px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 14px; text-decoration: none;
      transition: all .15s;
    }
    .hub-card:hover { border-color: var(--tracky); background: color-mix(in srgb, var(--tracky) 4%, var(--bg-secondary)) }

    .hub-card-icon {
      width: 44px; height: 44px; border-radius: 12px;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .hub-card-icon.green { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .hub-card-icon.amber { background: rgba(245,158,11,.1); color: #f59e0b }
    .hub-card-icon.blue { background: rgba(59,130,246,.1); color: #3b82f6 }
    .hub-card-icon.purple { background: rgba(168,85,247,.1); color: #a855f7 }
    .hub-card-icon.red { background: rgba(239,68,68,.1); color: #ef4444 }
    .hub-card-icon.cyan { background: rgba(6,182,212,.1); color: #06b6d4 }

    .hub-card-content h3 { font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0 }
    .hub-card-content p { font-size: 11px; color: var(--fg-tertiary); margin: 3px 0 0 }
  `],
})
export class AdminHubComponent {
  protected readonly sections = [
    { label: 'Centre d\'alertes', desc: 'Trackers failing, offline, commandes pending, erreurs applicatives', route: '/admin/alerts', icon: AlertTriangle, color: 'red' },
    { label: 'Diagnostic & Tests', desc: 'Wire logs, timeline, test push, test SMS fallback', route: '/admin/observability', icon: Activity, color: 'green' },
    { label: 'Commandes tracker', desc: 'Envoyer et monitorer les commandes TCP/SMS', route: '/admin/commands', icon: Terminal, color: 'blue' },
    { label: 'Trackers', desc: 'Inventaire global, assignation, SIM, statut', route: '/admin/trackers', icon: Radio, color: 'blue' },
    { label: 'SMS & Backup', desc: 'Historique SMS, provisioning, backup DB', route: '/admin/sms', icon: MessageSquare, color: 'purple' },
    { label: 'Sync Auth / Tracky', desc: 'Comparer les comptes Vizyo Auth vs Tracky', route: '/admin/auth-sync', icon: Users, color: 'cyan' },
  ];
}

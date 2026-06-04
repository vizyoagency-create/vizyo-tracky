import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, ArrowLeft, RefreshCw, Trash2, CheckCircle, AlertTriangle, XCircle } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { ToastService } from '../../shared/ui/toast/toast.service';

interface SyncedUser {
  authId: string;
  email: string;
  authStatus: string;
  trackyId: string;
  role: string;
  fleetId: string | null;
  isActive: boolean;
}

interface OnlyAuthUser {
  authId: string;
  email: string;
  status: string;
  createdAt: string;
}

interface OnlyTrackyUser {
  trackyId: string;
  email: string;
  role: string;
  fleetId: string | null;
  isActive: boolean;
}

interface SyncData {
  synced: SyncedUser[];
  onlyAuth: OnlyAuthUser[];
  onlyTracky: OnlyTrackyUser[];
  totalAuth: number;
  totalTracky: number;
}

@Component({
  selector: 'app-admin-auth-sync',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, RouterLink],
  template: `
    <div class="page">
      <header class="page-header">
        <a routerLink="/admin" class="back-link">
          <lucide-icon [img]="ArrowLeft" [size]="14"></lucide-icon>
          Administration
        </a>
        <div class="header-row">
          <div>
            <h1>Sync Auth / Tracky</h1>
            <p class="muted">Comparaison des comptes Vizyo Auth vs base Tracky locale.</p>
          </div>
          <button (click)="load()" class="btn-refresh" [disabled]="loading()">
            <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
            Actualiser
          </button>
        </div>
      </header>

      @if (loading()) {
        <div class="loading">
          <span class="spinner"></span>
        </div>
      } @else if (data()) {
        <!-- Stats -->
        <div class="stats-row">
          <div class="stat-card green">
            <lucide-icon [img]="CheckCircle" [size]="18"></lucide-icon>
            <div>
              <span class="stat-value">{{ data()!.synced.length }}</span>
              <span class="stat-label">Synchronises</span>
            </div>
          </div>
          <div class="stat-card amber">
            <lucide-icon [img]="AlertTriangle" [size]="18"></lucide-icon>
            <div>
              <span class="stat-value">{{ data()!.onlyAuth.length }}</span>
              <span class="stat-label">Auth seulement</span>
            </div>
          </div>
          <div class="stat-card red">
            <lucide-icon [img]="XCircle" [size]="18"></lucide-icon>
            <div>
              <span class="stat-value">{{ data()!.onlyTracky.length }}</span>
              <span class="stat-label">Tracky seulement</span>
            </div>
          </div>
        </div>

        <!-- Only in Auth (orphelins) -->
        @if (data()!.onlyAuth.length > 0) {
          <section class="card">
            <h2 class="card-title amber-text">
              <lucide-icon [img]="AlertTriangle" [size]="16"></lucide-icon>
              Comptes Auth sans equivalent Tracky ({{ data()!.onlyAuth.length }})
            </h2>
            <p class="card-desc">Ces users existent dans Vizyo Auth mais pas dans la base Tracky. Ils peuvent bloquer une re-invitation.</p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Email</th><th>Status</th><th>Cree le</th><th></th></tr></thead>
                <tbody>
                  @for (u of data()!.onlyAuth; track u.authId) {
                    <tr>
                      <td class="email-cell">{{ u.email }}</td>
                      <td><span class="pill" [class]="u.status === 'active' ? 'pill-on' : 'pill-off'">{{ u.status }}</span></td>
                      <td class="muted">{{ u.createdAt | date:'dd/MM/yyyy' }}</td>
                      <td>
                        <button (click)="removeFromAuth(u)" class="btn-icon danger" title="Supprimer de Auth">
                          <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <!-- Only in Tracky -->
        @if (data()!.onlyTracky.length > 0) {
          <section class="card">
            <h2 class="card-title red-text">
              <lucide-icon [img]="XCircle" [size]="16"></lucide-icon>
              Comptes Tracky sans equivalent Auth ({{ data()!.onlyTracky.length }})
            </h2>
            <p class="card-desc">Ces users sont dans Tracky mais pas dans Vizyo Auth. Ils ne peuvent pas se connecter.</p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Email</th><th>Role</th><th>Actif</th><th></th></tr></thead>
                <tbody>
                  @for (u of data()!.onlyTracky; track u.trackyId) {
                    <tr>
                      <td class="email-cell">{{ u.email }}</td>
                      <td><span class="pill">{{ u.role }}</span></td>
                      <td><span class="pill" [class]="u.isActive ? 'pill-on' : 'pill-off'">{{ u.isActive ? 'Oui' : 'Non' }}</span></td>
                      <td>
                        <button (click)="removeFromTracky(u)" class="btn-icon danger" title="Supprimer de Tracky">
                          <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <!-- Synced -->
        <section class="card">
          <h2 class="card-title green-text">
            <lucide-icon [img]="CheckCircle" [size]="16"></lucide-icon>
            Comptes synchronises ({{ data()!.synced.length }})
          </h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Email</th><th>Role</th><th>Auth status</th><th>Actif Tracky</th></tr></thead>
              <tbody>
                @for (u of data()!.synced; track u.trackyId) {
                  <tr>
                    <td class="email-cell">{{ u.email }}</td>
                    <td><span class="pill">{{ u.role }}</span></td>
                    <td><span class="pill" [class]="u.authStatus === 'active' ? 'pill-on' : 'pill-off'">{{ u.authStatus }}</span></td>
                    <td><span class="pill" [class]="u.isActive ? 'pill-on' : 'pill-off'">{{ u.isActive ? 'Oui' : 'Non' }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1000px }
    .page-header { display: flex; flex-direction: column; gap: 8px }
    .page-header h1 { font-size: 22px; font-weight: 700; color: var(--fg-primary); margin: 0 }
    .header-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px }
    .back-link { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-tertiary); font-size: 12px; text-decoration: none }
    .back-link:hover { color: var(--fg-secondary) }
    .muted { color: var(--fg-tertiary); font-size: 12px; margin: 0 }
    .btn-refresh {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .btn-refresh:hover { color: var(--fg-primary); border-color: var(--border-strong) }
    .btn-refresh:disabled { opacity: .5; cursor: not-allowed }
    .loading { display: flex; justify-content: center; padding: 40px }
    .spinner { width: 24px; height: 24px; border: 2px solid var(--fg-tertiary); border-top-color: var(--tracky-light); border-radius: 50%; animation: spin .6s linear infinite }
    @keyframes spin { to { transform: rotate(360deg) } }

    .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px }
    .stat-card {
      display: flex; align-items: center; gap: 12px; padding: 14px 18px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px;
    }
    .stat-card.green { color: var(--tracky-light) }
    .stat-card.amber { color: #f59e0b }
    .stat-card.red { color: #ef4444 }
    .stat-value { display: block; font-size: 20px; font-weight: 700; color: var(--fg-primary) }
    .stat-label { display: block; font-size: 11px; color: var(--fg-tertiary) }

    .card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 16px }
    .card-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0 0 4px }
    .card-title.green-text lucide-icon { color: var(--tracky-light) }
    .card-title.amber-text lucide-icon { color: #f59e0b }
    .card-title.red-text lucide-icon { color: #ef4444 }
    .card-desc { font-size: 11px; color: var(--fg-tertiary); margin: 0 0 12px }
    .table-wrap { overflow-x: auto }
    table { width: 100%; border-collapse: collapse; font-size: 12px }
    th { text-align: left; padding: 8px 10px; color: var(--fg-tertiary); font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--border-subtle) }
    td { padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); color: var(--fg-primary) }
    .email-cell { font-family: monospace; font-size: 11px }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 10px; font-weight: 600; background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .pill-on { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .pill-off { background: rgba(239,68,68,.1); color: #f87171 }
    .btn-icon { background: transparent; border: 0; padding: 6px; border-radius: 4px; cursor: pointer; color: var(--fg-tertiary) }
    .btn-icon:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .btn-icon.danger:hover { color: #ef4444 }

    @media (max-width: 640px) { .stats-row { grid-template-columns: 1fr } }
  `],
})
export class AdminAuthSyncComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Trash2 = Trash2;
  protected readonly CheckCircle = CheckCircle;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly XCircle = XCircle;

  protected readonly loading = signal(false);
  protected readonly data = signal<SyncData | null>(null);

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.http.get<SyncData>('/api/users/admin/auth-sync'));
      this.data.set(res);
    } catch {
      this.toast.error('Echec du chargement');
    } finally {
      this.loading.set(false);
    }
  }

  async removeFromTracky(user: OnlyTrackyUser): Promise<void> {
    if (!confirm(`Supprimer ${user.email} de Tracky ?`)) return;
    try {
      await firstValueFrom(this.http.delete(`/api/users/admin/auth-sync/tracky/${user.trackyId}`));
      this.toast.success(`${user.email} supprime de Tracky`);
      await this.load();
    } catch {
      this.toast.error('Echec de la suppression');
    }
  }

  async removeFromAuth(user: OnlyAuthUser): Promise<void> {
    if (!confirm(`Supprimer ${user.email} de Vizyo Auth ?`)) return;
    try {
      await firstValueFrom(this.http.delete(`/api/users/admin/auth-sync/${user.authId}`));
      this.toast.success(`${user.email} supprime de Auth`);
      await this.load();
    } catch {
      this.toast.error('Echec de la suppression');
    }
  }
}

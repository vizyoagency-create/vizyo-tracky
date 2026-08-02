import { computed, Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, ArrowLeft, RefreshCw, Trash2, CheckCircle, AlertTriangle, XCircle } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { SpinnerComponent } from '../../shared/ui/spinner/spinner.component';

interface SyncedUser {
  authId: string;
  email: string;
  authStatus: string;
  trackyId: string;
  role: string;
  fleetId: string | null;
  isActive: boolean;
  /** Statut cote Vizyo Auth, deja normalise en booleen par le serveur. */
  authActive: boolean;
  /**
   * Le desaccord, NOMME par le serveur :
   *   - `auth_ouvert` : bloque dans Tracky, mais peut TOUJOURS se connecter. Le plus grave.
   *   - `auth_bloque` : actif dans Tracky, mais rejete au login.
   *   - `null`        : les deux cotes sont d'accord.
   */
  mismatch: 'auth_ouvert' | 'auth_bloque' | null;
  /** Faux = rapproche par e-mail seulement, pas par identifiant. Lien fragile. */
  linkedById: boolean;
  createdAt: string;
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
  mismatchCount: number;
  authOuvertCount: number;
  authBloqueCount: number;
  /** Vrai quand la base Vizyo Auth n'a pas pu etre lue — a distinguer de « 0 compte ». */
  authUnavailable: boolean;
}

@Component({
  selector: 'app-admin-auth-sync',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, RouterLink, SpinnerComponent],
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
          <app-spinner [size]="24" />
        </div>
      } @else if (data()) {
        @if (data()!.authUnavailable) {
          <!-- Sans ce bandeau, une liaison morte s'affiche comme un parc vide : on
               conclurait que tout va bien alors qu'on ne voit RIEN. -->
          <div class="banner-warn">
            <lucide-icon [img]="AlertTriangle" [size]="16"></lucide-icon>
            <span>
              La base Vizyo Auth n'a pas pu etre lue. Les comptes affiches ci-dessous sont
              ceux de Tracky uniquement — la comparaison n'est PAS fiable en l'etat.
            </span>
          </div>
        }

        @if (data()!.mismatchCount > 0) {
          <div class="banner-danger">
            <lucide-icon [img]="XCircle" [size]="16"></lucide-icon>
            <span>
              <strong>{{ data()!.mismatchCount }} compte(s) en desaccord.</strong>
              @if (data()!.authOuvertCount > 0) {
                {{ data()!.authOuvertCount }} peuvent encore se connecter alors qu'ils sont
                archives dans Tracky.
              }
              @if (data()!.authBloqueCount > 0) {
                {{ data()!.authBloqueCount }} sont actifs dans Tracky mais rejetes au login.
              }
            </span>
          </div>
        }

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
              <thead><tr><th>Email</th><th>Role</th><th>Auth</th><th>Tracky</th><th>Lien</th><th>Etat</th><th></th></tr></thead>
              <tbody>
                <!-- Les comptes en desaccord d'abord : c'est ce qu'on vient chercher. -->
                @for (u of orderedSynced(); track u.trackyId) {
                  <tr [class.row-mismatch]="u.mismatch !== null">
                    <td class="email-cell">{{ u.email }}</td>
                    <td><span class="pill">{{ u.role }}</span></td>
                    <td><span class="pill" [class]="u.authActive ? 'pill-on' : 'pill-off'">{{ u.authStatus }}</span></td>
                    <td><span class="pill" [class]="u.isActive ? 'pill-on' : 'pill-off'">{{ u.isActive ? 'actif' : 'archive' }}</span></td>
                    <td>
                      <!-- Rapprochement par e-mail seulement : le lien casse si l'e-mail
                           change d'un cote. On le dit plutot que de le laisser croire solide. -->
                      <span class="pill" [class]="u.linkedById ? 'pill-on' : 'pill-warn'">
                        {{ u.linkedById ? 'identifiant' : 'e-mail seul' }}
                      </span>
                    </td>
                    <td>
                      @if (u.mismatch === 'auth_ouvert') {
                        <span class="pill pill-danger" title="Archive dans Tracky mais peut toujours se connecter">
                          peut encore se connecter
                        </span>
                      } @else if (u.mismatch === 'auth_bloque') {
                        <span class="pill pill-warn" title="Actif dans Tracky mais rejete au login">
                          bloque au login
                        </span>
                      } @else {
                        <span class="pill pill-on">coherent</span>
                      }
                    </td>
                    <td>
                      @if (u.mismatch !== null) {
                        <button (click)="realign(u)" class="btn-realign" [disabled]="busy() === u.trackyId">
                          {{ busy() === u.trackyId ? '...' : 'Realigner' }}
                        </button>
                      }
                    </td>
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

    .banner-warn, .banner-danger {
      display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px;
      border-radius: 10px; font-size: 12.5px; line-height: 1.5;
    }
    .banner-warn { background: rgba(217,119,6,.10); border: 1px solid rgba(217,119,6,.35); color: #b45309 }
    .banner-danger { background: rgba(220,38,38,.10); border: 1px solid rgba(220,38,38,.35); color: #b91c1c }
    .row-mismatch { background: rgba(220,38,38,.05) }
    .pill-danger { background: rgba(220,38,38,.15); color: #b91c1c }
    .pill-warn { background: rgba(217,119,6,.15); color: #b45309 }
    .btn-realign {
      padding: 5px 10px; border-radius: 7px; font-size: 11.5px; font-weight: 600;
      background: var(--bg-secondary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); cursor: pointer; white-space: nowrap;
    }
    .btn-realign:disabled { opacity: .5; cursor: not-allowed }
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
    .email-cell { font-family: var(--font-mono, monospace); font-size: 11px }
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
  /** Identifiant Tracky en cours de realignement (desactive son seul bouton). */
  protected readonly busy = signal<string | null>(null);

  /**
   * Les comptes en DESACCORD d'abord.
   *
   * Sur un parc de 15 comptes ca se voit ; sur 200, un desaccord perdu au milieu d'une
   * liste alphabetique ne se voit plus. Or c'est precisement ce qu'on vient chercher
   * sur cet ecran — le reste est de la confirmation.
   */
  protected readonly orderedSynced = computed(() => {
    const rows = this.data()?.synced ?? [];
    return [...rows].sort((a, b) => {
      if ((a.mismatch !== null) !== (b.mismatch !== null)) return a.mismatch !== null ? -1 : 1;
      return a.email.localeCompare(b.email);
    });
  });

  /**
   * Pousse le statut Tracky vers Vizyo Auth pour ce compte.
   *
   * Sens UNIQUE, a dessein : Tracky est la source de verite. Rapatrier le statut d'Auth
   * vers Tracky pourrait REOUVRIR un compte qu'un administrateur a volontairement archive.
   */
  protected async realign(u: SyncedUser): Promise<void> {
    this.busy.set(u.trackyId);
    try {
      await firstValueFrom(this.http.post(`/api/users/admin/auth-sync/${u.trackyId}/realign`, {}));
      this.toast.success(`${u.email} realigne sur Vizyo Auth.`);
      await this.load();
    } catch (err) {
      // Le message du serveur porte le motif reel : le jeter laisserait l'administrateur
      // devant un echec opaque, exactement ce que cet ecran existe pour supprimer.
      const msg = (err as { error?: { message?: string } })?.error?.message;
      this.toast.error(msg ?? 'Echec du realignement.');
    } finally {
      this.busy.set(null);
    }
  }

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

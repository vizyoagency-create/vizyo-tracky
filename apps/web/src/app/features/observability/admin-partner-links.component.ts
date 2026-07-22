import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

interface AdminPartnerLink {
  id: string;
  fleetName: string;
  organizationName: string;
  siret: string | null;
  status: string;
  suspendedByPlatform: boolean;
  suspendedReason: string | null;
  billingStatus: string;
  scopes: string[];
  approvedAt: string | null;
  lastSeenAt: string | null;
}

interface RevocationPreview {
  organizationName: string;
  scopes: string[];
  activeTokens: number;
  partnerReachable: boolean;
  remote: { byScope: Record<string, number>; total: number; alerts: number } | null;
}

/**
 * Pilotage plateforme des intégrations — SUPER_ADMIN.
 *
 * Porte le levier commercial : suspendre un client qui ne paye pas, sans qu'il puisse
 * le rétablir lui-même. L'aperçu de coupure est là pour qu'on puisse REGARDER avant
 * d'appuyer — couper un client a des conséquences financières pour lui.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §13.2
 */
@Component({
  selector: 'app-admin-partner-links',
  standalone: true,
  imports: [FormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pl-wrap">
      <header>
        <h1 class="pl-title">Intégrations partenaires</h1>
        <p class="pl-lead">
          Liens actifs entre les flottes et les applications partenaires. La suspension
          plateforme ne peut pas être levée par le client.
        </p>
      </header>

      @if (error(); as err) { <p class="pl-error" role="alert">{{ err }}</p> }

      @if (loading()) {
        <p class="pl-muted">Chargement…</p>
      } @else if (links().length === 0) {
        <p class="pl-muted">Aucun lien partenaire.</p>
      } @else {
        <table class="pl-table">
          <thead>
            <tr>
              <th>Flotte</th><th>Organisation</th><th>Statut</th>
              <th>Catégories</th><th>Facturation</th><th>Dernière activité</th><th></th>
            </tr>
          </thead>
          <tbody>
            @for (l of links(); track l.id) {
              <tr [class.pl-row-off]="l.suspendedByPlatform">
                <td>{{ l.fleetName }}</td>
                <td>
                  {{ l.organizationName }}
                  @if (l.siret) { <span class="pl-sub">{{ l.siret }}</span> }
                </td>
                <td>
                  <span class="pl-chip" [class.pl-chip-off]="l.status !== 'ACTIVE' || l.suspendedByPlatform">
                    {{ l.suspendedByPlatform ? 'suspendu' : l.status.toLowerCase() }}
                  </span>
                  @if (l.suspendedReason) { <span class="pl-sub">{{ l.suspendedReason }}</span> }
                </td>
                <td>{{ l.scopes.length }}</td>
                <td>
                  <select class="pl-select" [ngModel]="l.billingStatus" (ngModelChange)="setBilling(l, $event)">
                    <option value="COMP">Offert</option>
                    <option value="ACTIVE">Payant</option>
                    <option value="NONE">Aucun</option>
                  </select>
                </td>
                <td>{{ l.lastSeenAt ? (l.lastSeenAt | date: 'dd/MM HH:mm') : '—' }}</td>
                <td class="pl-actions">
                  <button type="button" class="pl-btn" (click)="preview(l)">Aperçu</button>
                  @if (l.suspendedByPlatform) {
                    <button type="button" class="pl-btn" [disabled]="busy()" (click)="resume(l)">Rétablir</button>
                  } @else {
                    <button type="button" class="pl-btn pl-btn-danger" [disabled]="busy()" (click)="askSuspend(l)">
                      Suspendre
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }

      @if (suspendTarget(); as t) {
        <section class="pl-card">
          <div class="pl-card-h">Suspendre {{ t.organizationName }}</div>
          <p class="pl-muted">
            L'accès sera coupé immédiatement et le client ne pourra pas le rétablir. La
            raison lui sera affichée.
          </p>
          <div class="pl-row">
            <input class="pl-input" [(ngModel)]="reason" placeholder="Ex. : facture 2026-07 impayée" />
            <button type="button" class="pl-btn" (click)="suspendTarget.set(null)">Annuler</button>
            <button type="button" class="pl-btn pl-btn-danger" [disabled]="busy() || !reason.trim()" (click)="suspend()">
              Confirmer
            </button>
          </div>
        </section>
      }

      @if (previewData(); as p) {
        <section class="pl-card">
          <div class="pl-card-h">
            <span>Aperçu de coupure — {{ p.organizationName }}</span>
            <button type="button" class="pl-btn" (click)="previewData.set(null)">Fermer</button>
          </div>
          <p class="pl-muted">Simulation. Rien n'a été modifié, ni ici ni chez le partenaire.</p>
          <ul class="pl-list">
            <li>{{ p.scopes.length }} catégorie(s) partagée(s)</li>
            <li>{{ p.activeTokens }} jeton(s) d'accès vivant(s) — coupés immédiatement</li>
            @if (p.partnerReachable && p.remote) {
              <li>{{ p.remote.total }} entrée(s) de données supprimée(s) chez le partenaire</li>
              <li>{{ p.remote.alerts }} alerte(s) supprimée(s)</li>
              @for (e of scopeRows(p); track e[0]) {
                <li class="pl-sub-item">{{ e[0] }} : {{ e[1] }}</li>
              }
            } @else {
              <li class="pl-warn">
                Partenaire injoignable — impossible de chiffrer ce qui disparaîtrait de son côté.
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .pl-wrap { display: flex; flex-direction: column; gap: 1rem; padding: 1.25rem; }
      .pl-title { margin: 0; font-size: 1.35rem; font-weight: 650; }
      .pl-lead, .pl-muted { margin: 0.35rem 0 0; color: var(--tk-text-muted, #7b8794); font-size: 0.9rem; }
      .pl-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
      .pl-table th { text-align: left; padding: 0.5rem; color: var(--tk-text-muted, #7b8794); font-weight: 500; border-bottom: 1px solid var(--tk-border, #232a32); }
      .pl-table td { padding: 0.5rem; border-bottom: 1px solid var(--tk-border, #232a32); vertical-align: top; }
      .pl-row-off { opacity: 0.6; }
      .pl-sub { display: block; font-size: 0.75rem; color: var(--tk-text-muted, #7b8794); }
      .pl-sub-item { color: var(--tk-text-muted, #7b8794); font-size: 0.82rem; margin-left: 1rem; }
      .pl-chip { font-size: 0.72rem; padding: 0.1rem 0.45rem; border-radius: 999px; background: var(--tk-accent-soft, #10e0a022); color: var(--tk-accent, #10e0a0); }
      .pl-chip-off { background: var(--tk-danger-soft, #e0484822); color: var(--tk-danger, #e04848); }
      .pl-actions { display: flex; gap: 0.35rem; }
      .pl-btn { padding: 0.35rem 0.7rem; border-radius: 7px; border: 1px solid var(--tk-border, #232a32); background: transparent; color: inherit; cursor: pointer; font-size: 0.8rem; }
      .pl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .pl-btn-danger { border-color: var(--tk-danger, #e04848); color: var(--tk-danger, #e04848); }
      .pl-select, .pl-input { padding: 0.3rem 0.45rem; border-radius: 7px; border: 1px solid var(--tk-border, #232a32); background: var(--tk-surface-2, #0f1317); color: inherit; font-size: 0.8rem; }
      .pl-input { flex: 1 1 16rem; }
      .pl-card { background: var(--tk-surface, #14181d); border: 1px solid var(--tk-border, #232a32); border-radius: 12px; padding: 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
      .pl-card-h { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
      .pl-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .pl-list { margin: 0; padding-left: 1.1rem; font-size: 0.875rem; display: flex; flex-direction: column; gap: 0.2rem; }
      .pl-warn { color: var(--tk-warn, #e0a848); }
      .pl-error { margin: 0; padding: 0.6rem 0.75rem; border-radius: 8px; background: var(--tk-danger-soft, #e0484822); color: var(--tk-danger, #e04848); font-size: 0.875rem; }
    `,
  ],
})
export class AdminPartnerLinksComponent {
  private readonly http = inject(HttpClient);

  protected readonly links = signal<AdminPartnerLink[]>([]);
  protected readonly previewData = signal<RevocationPreview | null>(null);
  protected readonly suspendTarget = signal<AdminPartnerLink | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected reason = '';

  constructor() {
    this.reload();
  }

  protected scopeRows(p: RevocationPreview): Array<[string, number]> {
    return Object.entries(p.remote?.byScope ?? {});
  }

  protected preview(l: AdminPartnerLink): void {
    this.run(
      this.http.get<RevocationPreview>(`/api/admin/partner-links/${l.id}/revocation-preview`),
      (p) => this.previewData.set(p),
    );
  }

  protected askSuspend(l: AdminPartnerLink): void {
    this.reason = '';
    this.suspendTarget.set(l);
  }

  protected suspend(): void {
    const t = this.suspendTarget();
    if (!t) return;
    this.run(
      this.http.post(`/api/admin/partner-links/${t.id}/platform-suspend`, { reason: this.reason.trim() }),
      () => {
        this.suspendTarget.set(null);
        this.reload();
      },
    );
  }

  protected resume(l: AdminPartnerLink): void {
    this.run(this.http.post(`/api/admin/partner-links/${l.id}/platform-resume`, {}), () => this.reload());
  }

  protected setBilling(l: AdminPartnerLink, status: string): void {
    this.run(this.http.patch(`/api/admin/partner-links/${l.id}/billing`, { status }), () => this.reload());
  }

  private reload(): void {
    this.loading.set(true);
    this.http.get<AdminPartnerLink[]>('/api/admin/partner-links').subscribe({
      next: (rows) => {
        this.links.set(rows);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Impossible de charger les liens partenaires.');
        this.loading.set(false);
      },
    });
  }

  private run<T>(obs: Observable<T>, onOk: (v: T) => void): void {
    this.busy.set(true);
    this.error.set(null);
    obs.subscribe({
      next: (v) => {
        this.busy.set(false);
        onOk(v);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set((err as { error?: { message?: string } })?.error?.message ?? 'Opération impossible.');
      },
    });
  }
}

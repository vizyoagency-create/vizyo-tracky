import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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

interface InvitableFleet {
  id: string;
  name: string;
  admins: { email: string; name: string }[];
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

      <!-- ── INVITER À CONSENTIR ──────────────────────────────────────────────
           On ne peut pas consentir à la place du client. Cet écran ne fait donc
           qu'une chose : lui envoyer le chemin le plus court vers sa décision. -->
      <section class="pl-card">
        <div class="pl-card-h">
          <span>Inviter un client à consentir</span>
          @if (inviteOk(); as ok) { <span class="pl-ok">Envoyé à {{ ok }}</span> }
        </div>
        <p class="pl-muted">
          Générez d'abord le code d'appairage dans Maestroo (écran « Intégration Tracky »),
          puis envoyez-le ici. Le client reçoit un e-mail qui l'emmène directement sur son
          écran de consentement — le code n'y figure pas, il est remis au moment du clic.
        </p>

        @if (fleets().length === 0) {
          <p class="pl-muted">
            Aucune flotte à inviter — toutes celles qui existent sont déjà connectées.
          </p>
        } @else {
          <div class="pl-form">
            <label class="pl-field">
              <span class="pl-label">Flotte</span>
              <select class="pl-select" [ngModel]="inviteFleetId()" (ngModelChange)="pickFleet($event)">
                <option value="">Choisir…</option>
                @for (f of fleets(); track f.id) {
                  <option [value]="f.id">{{ f.name }}</option>
                }
              </select>
            </label>

            <label class="pl-field">
              <span class="pl-label">Destinataire</span>
              @if (currentAdmins().length > 0) {
                <select class="pl-select" [(ngModel)]="inviteEmail">
                  @for (a of currentAdmins(); track a.email) {
                    <option [value]="a.email">{{ a.name }} — {{ a.email }}</option>
                  }
                </select>
              } @else {
                <!-- Aucun admin sur cette flotte : on le DIT, au lieu de proposer
                     une liste vide qui laisserait croire à un bug. -->
                <input class="pl-input" [(ngModel)]="inviteEmail" placeholder="adresse@societe.fr" />
              }
              @if (inviteFleetId() && currentAdmins().length === 0) {
                <span class="pl-hint">
                  Cette flotte n'a aucun administrateur actif : vérifiez à qui vous écrivez.
                </span>
              }
            </label>

            <label class="pl-field">
              <span class="pl-label">Code d'appairage (Maestroo)</span>
              <input
                class="pl-input"
                [(ngModel)]="inviteCode"
                placeholder="TRK-XXXX-XXXX-XXXX"
                autocomplete="off"
                spellcheck="false"
              />
            </label>

            <button
              type="button"
              class="pl-btn pl-btn-primary"
              [disabled]="busy() || !canInvite()"
              (click)="sendInvite()"
            >
              Envoyer l'invitation
            </button>
          </div>
        }
      </section>

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
      .pl-btn-primary { background: var(--tk-accent, #10e0a0); border-color: transparent; color: #06231a; font-weight: 600; align-self: flex-end; }
      .pl-ok { font-size: 0.78rem; font-weight: 500; color: var(--tk-accent, #10e0a0); }
      .pl-form { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: flex-end; }
      .pl-field { display: flex; flex-direction: column; gap: 0.25rem; flex: 1 1 13rem; }
      .pl-label { font-size: 0.75rem; color: var(--tk-text-muted, #7b8794); }
      .pl-hint { font-size: 0.72rem; color: var(--tk-warn, #e0a848); }
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

  protected readonly fleets = signal<InvitableFleet[]>([]);
  protected readonly inviteFleetId = signal('');
  protected readonly inviteOk = signal<string | null>(null);
  protected inviteEmail = '';
  protected inviteCode = '';

  /** Destinataires proposés pour la flotte choisie. */
  protected readonly currentAdmins = computed(
    () => this.fleets().find((f) => f.id === this.inviteFleetId())?.admins ?? [],
  );

  constructor() {
    this.reload();
    this.loadFleets();
  }

  protected canInvite(): boolean {
    return !!this.inviteFleetId() && this.inviteEmail.includes('@') && this.inviteCode.trim().length > 0;
  }

  /** Changer de flotte repropose SON administrateur : garder l'ancien enverrait l'invitation à côté. */
  protected pickFleet(id: string): void {
    this.inviteFleetId.set(id);
    this.inviteOk.set(null);
    this.inviteEmail = this.currentAdmins()[0]?.email ?? '';
  }

  protected sendInvite(): void {
    const email = this.inviteEmail.trim();
    this.run(
      this.http.post<{ email: string; emailSent: boolean }>('/api/admin/partner-links/invitations', {
        fleetId: this.inviteFleetId(),
        email,
        pairingCode: this.inviteCode.trim(),
      }),
      (res) => {
        // ⚠️ L'invitation est enregistrée même si l'e-mail n'est pas parti : on
        // distingue les deux, sinon on croit avoir sollicité un client qui n'a
        // jamais rien reçu.
        if (res.emailSent) {
          this.inviteOk.set(res.email);
          this.inviteCode = '';
        } else {
          this.error.set(
            `Invitation enregistrée mais l'e-mail n'est pas parti (${res.email}). Vérifiez le centre e-mails.`,
          );
        }
        this.loadFleets();
      },
    );
  }

  private loadFleets(): void {
    this.http.get<InvitableFleet[]>('/api/admin/partner-links/invitable-fleets').subscribe({
      next: (rows) => this.fleets.set(rows),
      error: () => this.error.set('Impossible de charger les flottes invitables.'),
    });
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

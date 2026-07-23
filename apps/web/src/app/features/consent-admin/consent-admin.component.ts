import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  AdminConsentUser,
  AdminLpConsent,
  AdminPartnerInvitation,
  ConsentAdminService,
} from '../../core/services/consent-admin.service';

/**
 * P4 — Vue admin « Qui a consenti » (SUPER_ADMIN). Deux tableaux : utilisateurs de
 * l'application (statut CGU/Confidentialité + date + IP) et visiteurs de la landing
 * page (choix accepter/refuser + IP). Route /admin/consent.
 */
@Component({
  selector: 'app-consent-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ca-wrap">
      <header class="ca-head">
        <h1 class="ca-title">Consentements RGPD</h1>
        <p class="ca-lead">Qui a consenti — application &amp; landing page, avec l'adresse IP.</p>
      </header>

      <section class="ca-card">
        <div class="ca-card-h">
          <span>Utilisateurs de l'application</span>
          <span class="ca-count">{{ users().length }}</span>
        </div>
        @if (loadingUsers()) {
          <p class="ca-muted">Chargement…</p>
        } @else if (users().length === 0) {
          <p class="ca-muted">Aucun utilisateur.</p>
        } @else {
          <div class="ca-scroll">
            <table class="ca-table">
              <thead>
                <tr>
                  <th>Utilisateur</th><th>Rôle</th><th>CGU</th>
                  <th>Confidentialité</th><th>IP</th><th>Notif</th><th>GPS</th><th>Conforme</th>
                </tr>
              </thead>
              <tbody>
                @for (u of users(); track u.userId) {
                  <tr>
                    <td><div class="ca-name">{{ u.name }}</div><div class="ca-sub">{{ u.email }}</div></td>
                    <td class="ca-sub">{{ u.role }}</td>
                    <td>{{ u.cgu.accepted ? fmt(u.cgu.at) : '—' }}</td>
                    <td>{{ u.privacy.accepted ? fmt(u.privacy.at) : '—' }}</td>
                    <td class="ca-mono">{{ u.cgu.ip || u.privacy.ip || '—' }}</td>
                    <td>{{ permTxt(u.notif) }}</td>
                    <td>{{ permTxt(u.geo) }}</td>
                    <td>
                      @if (u.compliant) {
                        <span class="ca-badge ca-ok">À jour</span>
                      } @else {
                        <span class="ca-badge ca-no">Non accepté</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <!-- ── CONSENTEMENTS D'INTÉGRATION ─────────────────────────────────────
           Le partage vers une application partenaire est un consentement comme
           un autre : il se demande, il se trace, et il doit pouvoir se prouver.
           On montre les trois moments — sollicité, ouvert, accepté — parce que
           s'arrêter au dernier ne dirait pas si le client a refusé ou n'a
           simplement jamais vu la demande. -->
      <section class="ca-card">
        <div class="ca-card-h">
          <span>Intégrations partenaires — demandes d'autorisation</span>
          <span class="ca-count">{{ invitations().length }}</span>
        </div>
        @if (loadingInvitations()) {
          <p class="ca-muted">Chargement…</p>
        } @else if (invitations().length === 0) {
          <p class="ca-muted">Aucune demande d'autorisation envoyée.</p>
        } @else {
          <div class="ca-scroll">
            <table class="ca-table">
              <thead>
                <tr>
                  <th>Flotte</th><th>Destinataire</th><th>Envoyée</th>
                  <th>Lien ouvert</th><th>IP</th><th>Autorisé</th><th>Catégories</th><th>État</th>
                </tr>
              </thead>
              <tbody>
                @for (i of invitations(); track i.id) {
                  <tr>
                    <td><div class="ca-name">{{ i.fleetName }}</div><div class="ca-sub">{{ i.partner }}</div></td>
                    <td class="ca-sub">{{ i.email }}</td>
                    <td>{{ fmt(i.sentAt) }}</td>
                    <td>
                      {{ fmt(i.openedAt) }}
                      @if (i.openCount > 1) { <span class="ca-sub">×{{ i.openCount }}</span> }
                    </td>
                    <td class="ca-mono">{{ i.openIp || '—' }}</td>
                    <td>{{ fmt(i.acceptedAt) }}</td>
                    <td class="ca-sub">{{ i.acceptedScopes.length || '—' }}</td>
                    <td><span class="ca-badge" [class]="stateClass(i.state)">{{ stateLabel(i.state) }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="ca-card">
        <div class="ca-card-h">
          <span>Visiteurs de la landing page</span>
          <span class="ca-count">{{ lp().length }}</span>
        </div>
        @if (loadingLp()) {
          <p class="ca-muted">Chargement…</p>
        } @else if (lp().length === 0) {
          <p class="ca-muted">Aucun consentement LP enregistré pour l'instant.</p>
        } @else {
          <div class="ca-scroll">
            <table class="ca-table">
              <thead>
                <tr><th>Date</th><th>Choix</th><th>IP</th><th>Page</th></tr>
              </thead>
              <tbody>
                @for (r of lp(); track r.id) {
                  <tr>
                    <td>{{ fmt(r.createdAt) }}</td>
                    <td>
                      @if (r.choice === 'granted') {
                        <span class="ca-badge ca-ok">Accepté</span>
                      } @else {
                        <span class="ca-badge ca-no">Refusé</span>
                      }
                    </td>
                    <td class="ca-mono">{{ r.ip || '—' }}</td>
                    <td class="ca-sub">{{ r.page || '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>
  `,
  styles: [
    `
    .ca-wrap { max-width: 1100px; margin: 0 auto; padding: 22px 18px 60px; }
    .ca-head { margin-bottom: 22px; }
    .ca-title { margin: 0 0 4px; font-size: 1.5rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .ca-lead { margin: 0; font-size: .92rem; color: var(--fg-tertiary); }
    .ca-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 16px); margin-bottom: 20px; overflow: hidden; }
    .ca-card-h { display: flex; align-items: center; gap: 10px; padding: 15px 18px; font-weight: 700; font-size: .98rem; color: var(--fg-primary); border-bottom: 1px solid var(--border-subtle); }
    .ca-count { margin-left: auto; font-size: .8rem; font-weight: 700; color: var(--tracky-light); background: color-mix(in srgb, var(--tracky-light) 14%, transparent); padding: 2px 10px; border-radius: 999px; }
    .ca-muted { padding: 18px; margin: 0; color: var(--fg-tertiary); font-size: .9rem; }
    .ca-scroll { overflow-x: auto; }
    .ca-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
    .ca-table th { text-align: left; padding: 11px 16px; font-size: .72rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--fg-tertiary); border-bottom: 1px solid var(--border-subtle); white-space: nowrap; }
    .ca-table td { padding: 12px 16px; color: var(--fg-secondary); border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
    .ca-table tr:last-child td { border-bottom: 0; }
    .ca-name { font-weight: 600; color: var(--fg-primary); }
    .ca-sub { font-size: .82rem; color: var(--fg-tertiary); }
    .ca-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .82rem; color: var(--fg-secondary); }
    .ca-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: .76rem; font-weight: 700; }
    .ca-ok { background: color-mix(in srgb, var(--tracky-light) 16%, transparent); color: var(--tracky-light); }
    .ca-no { background: rgba(242,112,107,.16); color: #f2706b; }
    .ca-wait { background: rgba(224,168,72,.16); color: #e0a848; }
    `,
  ],
})
export class ConsentAdminComponent {
  private readonly api = inject(ConsentAdminService);

  readonly users = signal<AdminConsentUser[]>([]);
  readonly lp = signal<AdminLpConsent[]>([]);
  readonly invitations = signal<AdminPartnerInvitation[]>([]);
  readonly loadingUsers = signal(true);
  readonly loadingLp = signal(true);
  readonly loadingInvitations = signal(true);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.users.set(await this.api.getUsers());
    } catch {
      /* silencieux */
    } finally {
      this.loadingUsers.set(false);
    }
    try {
      this.invitations.set(await this.api.getPartnerInvitations());
    } catch {
      // Le module partenaire peut être éteint (404) : la section reste vide,
      // le reste de la page continue de s'afficher.
    } finally {
      this.loadingInvitations.set(false);
    }
    try {
      this.lp.set(await this.api.getLp());
    } catch {
      /* silencieux */
    } finally {
      this.loadingLp.set(false);
    }
  }

  stateLabel(state: string): string {
    const map: Record<string, string> = {
      ACCEPTED: 'Autorisé',
      OPENED: 'Ouvert, sans réponse',
      EXPIRED: 'Expiré',
      SENT: 'En attente',
    };
    return map[state] ?? state;
  }

  stateClass(state: string): string {
    if (state === 'ACCEPTED') return 'ca-ok';
    if (state === 'EXPIRED') return 'ca-no';
    return 'ca-wait';
  }

  fmt(iso?: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  permTxt(v: boolean | null): string {
    return v === null ? '—' : v ? 'Oui' : 'Non';
  }
}

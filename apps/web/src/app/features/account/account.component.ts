import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { roleLabel as roleLabelFr } from '../../shared/utils/role-labels';
import {
  Bell,
  Compass,
  CheckCircle,
  ClipboardCopy,
  ExternalLink,
  KeyRound,
  Lock,
  LucideAngularModule,
  Mail,
  PartyPopper,
  Save,
  ShieldAlert,
  Trash2,
  UserCircle2,
  XCircle,
} from 'lucide-angular';
import { NotificationsApiService } from '../../core/services/notifications.service';
import { OnboardingService } from '../../core/services/onboarding.service';
import {
  InvitationDto,
  MeProfile,
  UsersApiService,
} from '../../core/services/users.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Tab = 'profile' | 'invitations' | 'notifications' | 'security';

/**
 * V1.5 (Sprint J) — Page "Mon compte".
 *
 * Sections livrees Sprint J :
 *   - Profil : firstName, lastName, phone (E.164)
 *   - Invitations : envoyer + lister + revoquer (FLEET_ADMIN+ seulement)
 *   - Securite : info Vizyo Auth (changement mot de passe via Vizyo Auth)
 *
 * Sections futures :
 *   - Notifications (push / email / WhatsApp opt-in) → Sprint M
 *   - Suppression / anonymisation RGPD → reporte (Vizyo Auth requis)
 */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule],
  template: `
    <div class="page">
      @if (isBaanoolMode()) {
        <!-- V1.12 — Mode Baanool : bouton retour vers /map en haut a gauche.
             Pas de top-bar standard sur cette page en baanool, donc on en
             cree un mini ici pour permettre la navigation retour. -->
        <button class="baanool-back" (click)="goBackToMap()" aria-label="Retour a la carte">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          <span>Carte</span>
        </button>
      }
      <header class="page-header">
        <h1>Mon compte</h1>
        <p class="muted">Gérez votre profil, vos invitations et vos préférences.</p>
      </header>

      <nav class="tabs" aria-label="Sections du compte">
        @for (t of visibleTabs(); track t.key) {
          <button (click)="activeTab.set(t.key)"
                  class="tab"
                  [class.active]="activeTab() === t.key">
            <lucide-icon [img]="t.icon" [size]="14"></lucide-icon>
            {{ t.label }}
          </button>
        }
      </nav>

      @if (activeTab() === 'profile') {
        <section class="card">
          <h2>Profil</h2>
          <div class="form-grid">
            <div class="field">
              <label>Email</label>
              <div class="field-locked">
                <input [value]="profile()?.email ?? ''" disabled />
                <span class="field-lock"
                      title="Géré par Vizyo Auth — modifiable depuis le portail Vizyo Auth uniquement"
                      aria-label="Champ verrouillé : géré par Vizyo Auth">
                  <lucide-icon [img]="LockIcon" [size]="13"></lucide-icon>
                </span>
              </div>
              <small>Géré par Vizyo Auth — non modifiable ici.</small>
            </div>
            <div class="field">
              <label>Rôle</label>
              <input [value]="roleLabel(profile()?.role)" disabled />
            </div>
            <div class="field">
              <label>Prénom</label>
              <input [(ngModel)]="firstName" name="firstName" placeholder="Jean" />
            </div>
            <div class="field">
              <label>Nom</label>
              <input [(ngModel)]="lastName" name="lastName" placeholder="Dupont" />
            </div>
            <div class="field field--full">
              <label>Téléphone</label>
              <input [(ngModel)]="phone" name="phone" placeholder="+33612345678" />
              <small>Format E.164. Utilisé pour les notifications WhatsApp (Sprint M).</small>
            </div>
          </div>
          <div class="row-actions">
            <button (click)="saveProfile()" class="btn-primary" [disabled]="saving()">
              <lucide-icon [img]="Save" [size]="14"></lucide-icon>
              {{ saving() ? 'Enregistrement...' : 'Enregistrer' }}
            </button>
            @if (profile() && !profile()!.onboardingCompletedAt) {
              <button (click)="restartOnboarding()" class="btn-ghost">
                <lucide-icon [img]="Compass" [size]="14"></lucide-icon>
                Reprendre l'onboarding
              </button>
            } @else {
              <button (click)="restartOnboarding()" class="btn-ghost">
                <lucide-icon [img]="Compass" [size]="14"></lucide-icon>
                Refaire l'onboarding
              </button>
            }
          </div>
        </section>
      }

      @if (activeTab() === 'invitations') {
        <section class="card">
          <h2>Inviter un utilisateur</h2>
          <div class="form-grid">
            <div class="field">
              <label>Email</label>
              <input [(ngModel)]="inviteEmail" type="email" placeholder="email@example.com" />
            </div>
            <div class="field">
              <label>Rôle</label>
              <select [(ngModel)]="inviteRole">
                @if (canInviteFleetAdmin()) {
                  <option value="FLEET_ADMIN">Administrateur de flotte</option>
                }
                <option value="FLEET_MANAGER">Gestionnaire de flotte</option>
                <option value="VIEWER">Lecteur</option>
              </select>
            </div>
          </div>
          <div class="row-actions">
            <button (click)="sendInvitation()" class="btn-primary" [disabled]="!inviteEmail.trim() || sendingInvite()">
              <lucide-icon [img]="Mail" [size]="14"></lucide-icon>
              {{ sendingInvite() ? 'Envoi...' : 'Envoyer l\\'invitation' }}
            </button>
          </div>
        </section>

        <section class="card">
          <h2>Invitations envoyées</h2>
          @if (invitations().length === 0) {
            <p class="muted">Aucune invitation pour le moment.</p>
          } @else {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Rôle</th>
                    <th>Statut</th>
                    <th>Créé le</th>
                    <th>Expire</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (inv of invitations(); track inv.id) {
                    <tr>
                      <td>{{ inv.email }}</td>
                      <td><span class="role-badge">{{ roleLabel(inv.role) }}</span></td>
                      <td>
                        @switch (inv.status) {
                          @case ('PENDING') {
                            <span class="status status--pending">
                              <lucide-icon [img]="Bell" [size]="12"></lucide-icon> En attente
                            </span>
                          }
                          @case ('ACCEPTED') {
                            <span class="status status--ok">
                              <lucide-icon [img]="CheckCircle" [size]="12"></lucide-icon> Acceptée
                            </span>
                          }
                          @case ('EXPIRED') {
                            <span class="status status--expired">
                              <lucide-icon [img]="XCircle" [size]="12"></lucide-icon> Expirée
                            </span>
                          }
                          @default {
                            <span class="status status--revoked">
                              <lucide-icon [img]="XCircle" [size]="12"></lucide-icon> Révoquée
                            </span>
                          }
                        }
                      </td>
                      <td class="muted">{{ inv.createdAt | date: 'dd/MM HH:mm' }}</td>
                      <td class="muted">{{ inv.expiresAt | date: 'dd/MM HH:mm' }}</td>
                      <td>
                        @if (inv.status === 'PENDING') {
                          <button (click)="revokeInvitation(inv.id)" class="btn-link">
                            Révoquer
                          </button>
                        }
                        @if (inv.acceptUrlForDevDebug) {
                          <button (click)="copyDevLink(inv.acceptUrlForDevDebug)" class="btn-link" title="Mode dev — copier le lien d'invitation">
                            <lucide-icon [img]="ClipboardCopy" [size]="12"></lucide-icon>
                            Copier le lien
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      @if (activeTab() === 'notifications') {
        <section class="card">
          <h2>Notifications push</h2>
          @if (notif.pushEnabled() === false) {
            <div class="info-box">
              <lucide-icon [img]="ShieldAlert" [size]="20"></lucide-icon>
              <div>
                <strong>Push désactivé côté serveur</strong>
                <p>Les VAPID keys ne sont pas configurées. Ajouter VAPID_PUBLIC_KEY et
                VAPID_PRIVATE_KEY a la config serveur pour activer.</p>
              </div>
            </div>
          } @else if (!notif.isPushSupported()) {
            <div class="info-box">
              <lucide-icon [img]="ShieldAlert" [size]="20"></lucide-icon>
              <div>
                <strong>Navigateur incompatible</strong>
                <p>Votre navigateur ne supporte pas les Web Push. Essayez Chrome, Firefox ou Edge.</p>
              </div>
            </div>
          } @else {
            <p class="muted" style="margin: 0 0 12px;">
              Recevez les alertes critiques (SOS, accidents, geofence) directement
              sur ce device, même app fermée.
            </p>
            <div class="row-actions">
              @if (!notif.isSubscribed()) {
                <button (click)="subscribePush()" class="btn-primary" [disabled]="subscribing()">
                  <lucide-icon [img]="Bell" [size]="14"></lucide-icon>
                  {{ subscribing() ? 'Activation...' : 'Activer les notifications push' }}
                </button>
              } @else {
                <button (click)="unsubscribePush()" class="btn-ghost">
                  <lucide-icon [img]="XCircle" [size]="14"></lucide-icon>
                  Désactiver sur ce device
                </button>
              }
            </div>
          }
        </section>

        @if (notif.devices().length > 0) {
          <section class="card">
            <h2>Devices abonnés</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Dernier vu</th>
                    <th>Créé</th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of notif.devices(); track d.id) {
                    <tr>
                      <td class="muted" style="font-size: 11px;">{{ d.userAgent ?? '—' }}</td>
                      <td class="muted">{{ d.lastSeenAt | date: 'dd/MM HH:mm' }}</td>
                      <td class="muted">{{ d.createdAt | date: 'dd/MM HH:mm' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <section class="card">
          <h2>Email & WhatsApp</h2>
          <div class="info-box">
            <lucide-icon [img]="Mail" [size]="20"></lucide-icon>
            <div>
              <strong>Configuration via les règles d'alerte</strong>
              <p>Les notifications email et WhatsApp sont configurées par flotte
              et par type d'alerte. Un FLEET_ADMIN peut les activer via
              l'API <code>/notifications/rules</code> (UI dédiée à venir).</p>
              <p style="margin-top: 8px; font-size: 12px;">
                WhatsApp utilise votre numéro de téléphone (configuré dans l'onglet Profil).
              </p>
            </div>
          </div>
        </section>
      }

      @if (activeTab() === 'security') {
        <section class="card">
          <h2>Sécurité</h2>
          <div class="info-box">
            <lucide-icon [img]="ShieldAlert" [size]="20"></lucide-icon>
            <div>
              <strong>Mot de passe et sessions</strong>
              <p>L'authentification est gérée par <strong>Vizyo Auth</strong>. Pour changer votre
              mot de passe ou révoquer toutes vos sessions actives, ouvrez le portail dédié.</p>
              <div class="row-actions" style="margin-top: 12px;">
                <a [href]="vizyoAuthPortalUrl"
                   target="_blank"
                   rel="noopener noreferrer"
                   class="btn-primary btn-link-external">
                  <lucide-icon [img]="ExternalLink" [size]="14"></lucide-icon>
                  Ouvrir le portail Vizyo Auth
                </a>
                <a [href]="vizyoAuthPortalUrl + '/reset-password?email=' + (profile()?.email ?? '')"
                   target="_blank"
                   rel="noopener noreferrer"
                   class="btn-ghost">
                  <lucide-icon [img]="KeyRound" [size]="14"></lucide-icon>
                  Changer le mot de passe
                </a>
              </div>
            </div>
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    .page {
      max-width: 980px;
      margin: 0 auto;
      padding: 24px 20px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .page-header h1 { margin: 0 0 4px; font-size: 24px; color: var(--fg-primary); }
    .muted { color: var(--fg-tertiary); }
    .tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border-subtle);
      overflow-x: auto;
      scrollbar-width: thin;
      /* Indicateur visuel de scroll horizontal sur mobile (gradient en bordure droite). */
      -webkit-mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
      mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
    }
    .tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 10px 14px;
      border: none;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--fg-tertiary);
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .tab.active {
      color: var(--tracky-light, #10E0A0);
      border-bottom-color: var(--tracky-light, #10E0A0);
    }
    .tab:hover:not(.active) { color: var(--fg-secondary); }
    /* Mobile : tabs plus compactes pour limiter le risque de troncature. */
    @media (max-width: 480px) {
      .tabs { gap: 2px; }
      .tab { padding: 10px 10px; font-size: 13px; gap: 4px; }
      /* Pas de masque si le scroll n'est pas necessaire (conserver une bordure nette). */
      .tabs:not(:hover) { -webkit-mask-image: none; mask-image: none; }
    }
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card, 16px);
      padding: 20px;
    }
    .card h2 { margin: 0 0 16px; font-size: 16px; color: var(--fg-primary); }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 640px) { .form-grid { grid-template-columns: 1fr } }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field--full { grid-column: 1 / -1; }
    .field label {
      font-size: 11px;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .field input, .field select {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
      color: var(--fg-primary);
    }
    .field input:focus, .field select:focus {
      outline: 2px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 60%, transparent);
      outline-offset: 1px;
      border-color: var(--tracky-light, #10E0A0);
    }
    .field input[disabled] { opacity: 0.7; cursor: not-allowed; }
    .field small { font-size: 11px; color: var(--fg-tertiary); }
    /* Champ verrouille (ex : Email gere par Vizyo Auth) — l'icone cadenas
     * a droite signale visuellement le statut sans alourdir le label. */
    .field-locked { position: relative; display: flex; }
    .field-locked input { padding-right: 36px; flex: 1 }
    .field-lock {
      position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border-radius: 6px;
      color: var(--fg-tertiary); pointer-events: auto; cursor: help;
    }
    .row-actions {
      display: flex; gap: 8px; flex-wrap: wrap;
      margin-top: 16px;
    }
    .btn-primary, .btn-ghost {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 9px 14px;
      border-radius: 9px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .btn-primary {
      background: var(--tracky-light, #10E0A0);
      color: var(--bg-primary);
      font-weight: 600;
    }
    .btn-primary[disabled] { opacity: 0.55; cursor: not-allowed; }
    .btn-primary:hover:not([disabled]) { filter: brightness(1.05); }
    .btn-ghost {
      background: transparent;
      border-color: var(--border-subtle);
      color: var(--fg-secondary);
    }
    .btn-ghost:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    /* Liens (a) qui doivent ressembler aux boutons primary/ghost. */
    a.btn-primary, a.btn-ghost { text-decoration: none; }
    .btn-link-external { /* hint visuel : action externe (nouvel onglet) */ }
    .btn-link {
      background: transparent;
      border: none;
      color: var(--tracky-light, #10E0A0);
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn-link:hover { text-decoration: underline; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 600px; }
    th, td {
      padding: 10px 8px;
      text-align: left;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
    }
    th { color: var(--fg-tertiary); font-weight: 500; text-transform: uppercase; font-size: 11px; }
    .role-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      background: var(--bg-tertiary);
      font-size: 11px;
      font-family: var(--font-mono, monospace);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 6px;
    }
    .status--pending { background: color-mix(in srgb, #f59e0b 18%, transparent); color: #f59e0b; }
    .status--ok { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 16%, transparent); color: var(--tracky-light, #10E0A0); }
    .status--expired { background: color-mix(in srgb, #ef4444 14%, transparent); color: #ef4444; }
    .status--revoked { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .info-box {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px;
      background: var(--bg-tertiary);
      border-radius: 10px;
    }
    .info-box lucide-icon { color: var(--accent-warning, #f59e0b); flex-shrink: 0; }
    .info-box strong { color: var(--fg-primary); display: block; margin-bottom: 4px; }
    .info-box p { margin: 0; color: var(--fg-secondary); font-size: 13px; line-height: 1.5; }

    /* V1.12 — Bouton retour mode baanool (pas de top-bar standard sur cette page). */
    .baanool-back {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px 8px 8px;
      background: var(--bg-tertiary, #f5f5f5);
      border: 1px solid var(--border-subtle, #eee);
      border-radius: 9999px;
      color: var(--fg-primary, #333);
      font-size: 14px; font-weight: 500;
      cursor: pointer;
      margin-bottom: 16px;
      transition: background 120ms;
    }
    .baanool-back:hover { background: var(--bg-secondary, #eee); }
    .baanool-back:active { transform: scale(0.97); }
  `],
})
export class AccountComponent implements OnInit {
  private readonly usersApi = inject(UsersApiService);
  private readonly toast = inject(ToastService);
  private readonly onboardingSvc = inject(OnboardingService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  // V1.12 — Mode Baanool : bouton retour vers la carte.
  protected readonly isBaanoolMode = computed(() => this.authService.user()?.preferences?.uiMode === 'baanool');
  goBackToMap(): void { void this.router.navigate(['/map']); }
  protected readonly notif = inject(NotificationsApiService);
  protected readonly subscribing = signal(false);

  protected readonly Bell = Bell;
  protected readonly LockIcon = Lock;
  protected readonly ExternalLink = ExternalLink;
  /** URL publique du portail Vizyo Auth (gestion mot de passe, sessions, MFA). */
  protected readonly vizyoAuthPortalUrl = 'https://auth.vizyoagency.com/account';
  protected readonly CheckCircle = CheckCircle;
  protected readonly ClipboardCopy = ClipboardCopy;
  protected readonly Compass = Compass;
  protected readonly KeyRound = KeyRound;
  protected readonly Mail = Mail;
  protected readonly PartyPopper = PartyPopper;
  protected readonly Save = Save;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly Trash2 = Trash2;
  protected readonly UserCircle2 = UserCircle2;
  protected readonly XCircle = XCircle;

  readonly profile = signal<MeProfile | null>(null);
  readonly invitations = signal<InvitationDto[]>([]);
  readonly activeTab = signal<Tab>('profile');
  readonly saving = signal(false);
  readonly sendingInvite = signal(false);

  firstName = '';
  lastName = '';
  phone = '';
  inviteEmail = '';
  protected readonly roleLabel = roleLabelFr;
  inviteRole: 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER' = 'FLEET_MANAGER';

  readonly canInvite = computed(() => {
    const role = this.profile()?.role;
    return role === 'SUPER_ADMIN' || role === 'FLEET_ADMIN';
  });

  readonly canInviteFleetAdmin = computed(() => this.profile()?.role === 'SUPER_ADMIN');

  readonly visibleTabs = computed(() => {
    const tabs: { key: Tab; label: string; icon: typeof Bell }[] = [
      { key: 'profile', label: 'Profil', icon: UserCircle2 },
    ];
    if (this.canInvite()) {
      tabs.push({ key: 'invitations', label: 'Invitations', icon: Mail });
    }
    tabs.push({ key: 'notifications', label: 'Notifications', icon: Bell });
    tabs.push({ key: 'security', label: 'Sécurité', icon: KeyRound });
    return tabs;
  });

  async ngOnInit(): Promise<void> {
    await this.loadProfile();
    if (this.canInvite()) await this.loadInvitations();
    await this.notif.loadStatus();
    this.notif.listDevices().catch(() => {/* non-bloquant */});
  }

  async subscribePush(): Promise<void> {
    this.subscribing.set(true);
    try {
      const result = await this.notif.subscribePush();
      if (result.ok) {
        this.toast.success('Notifications push activées sur ce device');
        await this.notif.listDevices();
      } else {
        this.toast.error(result.reason ?? 'Échec de l\'activation');
      }
    } finally {
      this.subscribing.set(false);
    }
  }

  async unsubscribePush(): Promise<void> {
    await this.notif.unsubscribePush();
    this.toast.success('Notifications désactivées sur ce device');
    await this.notif.listDevices();
  }

  async loadProfile(): Promise<void> {
    try {
      const me = await this.usersApi.me();
      this.profile.set(me);
      this.firstName = me.firstName ?? '';
      this.lastName = me.lastName ?? '';
      this.phone = me.phone ?? '';
    } catch {
      this.toast.error('Échec du chargement du profil');
    }
  }

  async loadInvitations(): Promise<void> {
    try {
      const items = await this.usersApi.listInvitations();
      this.invitations.set(items);
    } catch {
      // Silent — peut etre 403 si pas la perm.
    }
  }

  async saveProfile(): Promise<void> {
    if (this.phone && !/^\+\d{6,15}$/.test(this.phone)) {
      this.toast.error('Le téléphone doit être au format international (ex: +33612345678)');
      return;
    }
    this.saving.set(true);
    try {
      await this.usersApi.updateMe({
        firstName: this.firstName.trim() || '',
        lastName: this.lastName.trim() || '',
        phone: this.phone.trim() || null,
      });
      this.toast.success('Profil mis à jour');
      await this.loadProfile();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Échec';
      this.toast.error(message);
    } finally {
      this.saving.set(false);
    }
  }

  async sendInvitation(): Promise<void> {
    if (!this.inviteEmail.trim()) return;
    this.sendingInvite.set(true);
    try {
      await this.usersApi.invite({
        email: this.inviteEmail.trim().toLowerCase(),
        role: this.inviteRole,
      });
      this.toast.success(`Invitation envoyée à ${this.inviteEmail}`);
      this.inviteEmail = '';
      await this.loadInvitations();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Échec';
      this.toast.error(message);
    } finally {
      this.sendingInvite.set(false);
    }
  }

  async revokeInvitation(id: string): Promise<void> {
    try {
      await this.usersApi.revokeInvitation(id);
      this.toast.success('Invitation révoquée');
      await this.loadInvitations();
    } catch {
      this.toast.error('Échec de la révocation');
    }
  }

  async copyDevLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('Lien copié (mode dev)');
    } catch {
      this.toast.error('Échec de la copie');
    }
  }

  restartOnboarding(): void {
    this.onboardingSvc.open();
  }
}

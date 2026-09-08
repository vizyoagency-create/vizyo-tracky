import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ArrowLeft, Ban, CheckCircle2, LucideAngularModule, Mail, RefreshCw, Trash2, Users } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { swallow } from '../../core/error/swallow';
import { ToastService } from '../../shared/ui/toast/toast.service';

/** Miroir de `CompteDemo` (apps/api/src/demo/demo-console.service.ts). */
interface CompteDemo {
  id: string;
  email: string;
  nom: string;
  role: string;
  actif: boolean;
  compteDeService: boolean;
  derniereConnexionAt: string | null;
  derniereConnexionVille: string | null;
  creeAt: string;
}

interface InvitationDemo {
  id: string;
  email: string;
  role: string;
  statut: string;
  expireAt: string;
  creeAt: string;
}

/**
 * Administration → Comptes de démonstration (SUPER_ADMIN).
 *
 * Cet écran vit en PRODUCTION mais ne lit rien de la production : chaque appel est relayé vers
 * l'API de la démo, qui détient les comptes. On administre donc la démonstration sans avoir à
 * s'y connecter — et sans qu'aucun compte de démo n'existe côté production.
 *
 * ⚠️ Les comptes en `@demo.vizyoagency.com` sont ceux qu'on REMET AUX PROSPECTS. L'écran les
 * marque « compte de service » et l'API refuse de les bloquer : les couper par inadvertance
 * arrêterait toutes les démonstrations à venir, et rien ici ne dirait pourquoi.
 */
@Component({
  selector: 'app-admin-demo-comptes',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DatePipe, FormsModule],
  template: `
    <div class="page">
      <div class="head">
        <a routerLink="/admin" class="back"><lucide-icon [img]="ArrowLeft" [size]="16" /> Administration</a>
        <h1><lucide-icon [img]="Users" [size]="24" /> Comptes de démonstration</h1>
        <p class="sub">
          Les accès de <strong>demo-tracky.vizyoagency.com</strong> : qui peut s'y connecter, qui l'a
          fait et quand. Tout est relayé vers la démonstration — rien de tout ceci n'existe dans la
          base de production.
        </p>
      </div>

      @if (etat() === 'non-configure') {
        <div class="carte avert">
          <strong>Console non configurée.</strong>
          <p>
            Posez <code>DEMO_API_URL</code> et <code>DEMO_INTERNAL_SECRET</code> dans l'environnement de
            production. Le second est le secret interne <em>de la démonstration</em>, différent de celui
            de la production. Sans eux, aucun appel n'est émis.
          </p>
        </div>
      } @else if (etat() === 'injoignable') {
        <div class="carte avert">
          <strong>Démonstration injoignable.</strong>
          <p>{{ erreur() }}</p>
          <button class="btn" (click)="charger()">
            <lucide-icon [img]="RefreshCw" [size]="15" /> Réessayer
          </button>
        </div>
      } @else {
        <div class="carte">
          <div class="carte-tete">
            <h2><lucide-icon [img]="Mail" [size]="17" /> Inviter un prospect</h2>
            <button class="btn" (click)="charger()" [disabled]="chargement()">
              <lucide-icon [img]="RefreshCw" [size]="15" /> Rafraîchir
            </button>
          </div>
          <div class="form">
            <input class="in" type="email" placeholder="prenom.nom@societe.fr"
                   [(ngModel)]="nouvelEmail" name="email" autocomplete="off" />
            <select class="in" [(ngModel)]="nouveauRole" name="role">
              <option value="FLEET_ADMIN">Administrateur de flotte</option>
              <option value="FLEET_MANAGER">Gestionnaire</option>
              <option value="VIEWER">Lecteur</option>
            </select>
            <button class="btn btn-primaire" (click)="inviter()" [disabled]="!emailValide() || envoi()">
              {{ envoi() ? 'Envoi…' : 'Envoyer l’invitation' }}
            </button>
          </div>
          <p class="note">
            Le prospect reçoit un lien, choisit son mot de passe et arrive dans la société fictive.
            Une adresse déjà titulaire d'un compte Vizyo devra utiliser son mot de passe habituel.
          </p>
        </div>

        <div class="carte">
          <h2><lucide-icon [img]="Users" [size]="17" /> Comptes ({{ comptes().length }})</h2>
          @if (comptes().length === 0) {
            <p class="vide">Aucun compte.</p>
          } @else {
            <table class="tbl">
              <thead>
                <tr><th>Compte</th><th>Rôle</th><th>Dernière connexion</th><th>État</th><th></th></tr>
              </thead>
              <tbody>
                @for (c of comptes(); track c.id) {
                  <tr>
                    <td>
                      <div class="mono">{{ c.email }}</div>
                      <div class="petit">{{ c.nom }}@if (c.compteDeService) { · <span class="jeton">compte de service</span> }</div>
                    </td>
                    <td class="petit">{{ libelleRole(c.role) }}</td>
                    <td class="petit">
                      @if (c.derniereConnexionAt) {
                        {{ c.derniereConnexionAt | date: 'dd/MM/yy HH:mm' }}
                        @if (c.derniereConnexionVille) { · {{ c.derniereConnexionVille }} }
                      } @else {
                        <span class="jamais">jamais venu</span>
                      }
                    </td>
                    <td>
                      @if (c.actif) {
                        <span class="etat ok"><lucide-icon [img]="CheckCircle2" [size]="13" /> actif</span>
                      } @else {
                        <span class="etat ko"><lucide-icon [img]="Ban" [size]="13" /> bloqué</span>
                      }
                    </td>
                    <td class="droite">
                      @if (!c.compteDeService && c.role !== 'SUPER_ADMIN') {
                        <button class="btn btn-petit" (click)="basculerBlocage(c)">
                          {{ c.actif ? 'Bloquer' : 'Débloquer' }}
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>

        <div class="carte">
          <h2><lucide-icon [img]="Mail" [size]="17" /> Invitations ({{ invitationsEnCours().length }} en attente)</h2>
          @if (invitations().length === 0) {
            <p class="vide">Aucune invitation.</p>
          } @else {
            <table class="tbl">
              <thead><tr><th>Adresse</th><th>Rôle</th><th>Statut</th><th>Expire</th><th></th></tr></thead>
              <tbody>
                @for (i of invitations(); track i.id) {
                  <tr>
                    <td class="mono">{{ i.email }}</td>
                    <td class="petit">{{ libelleRole(i.role) }}</td>
                    <td class="petit">{{ i.statut }}</td>
                    <td class="petit">{{ i.expireAt | date: 'dd/MM/yy HH:mm' }}</td>
                    <td class="droite">
                      @if (i.statut === 'PENDING') {
                        <button class="btn btn-petit" (click)="revoquer(i)">
                          <lucide-icon [img]="Trash2" [size]="13" /> Révoquer
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
    .page { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; display: flex; flex-direction: column; gap: 18px; }
    .head h1 { display: flex; align-items: center; gap: 10px; font-size: 1.6rem; font-weight: 800; margin: 6px 0 4px; color: var(--fg-primary); }
    .back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg-tertiary); text-decoration: none; }
    .back:hover { color: var(--fg-secondary); }
    .sub { color: var(--fg-secondary); font-size: 14px; line-height: 1.5; max-width: 76ch; }
    .carte { background: var(--surface-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
    .carte h2 { display: flex; align-items: center; gap: 8px; font-size: 1rem; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .carte-tete { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .avert { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 10%, transparent); border-color: color-mix(in srgb, var(--warning) 26%, transparent); }
    .avert p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--fg-secondary); }
    .avert code { font-family: ui-monospace, monospace; font-size: 12px; }
    .form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .in { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 9px 12px; font-size: 14px; color: var(--fg-primary); font-family: inherit; }
    .in[type='email'] { flex: 1 1 260px; }
    .btn { display: inline-flex; align-items: center; gap: 6px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 9px 13px; font-size: 13px; font-weight: 600; color: var(--fg-primary); cursor: pointer; font-family: inherit; }
    .btn:hover:not(:disabled) { background: var(--bg-tertiary); }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn-primaire { background: var(--tracky-light); color: var(--accent-ink); border-color: transparent; }
    .btn-petit { padding: 5px 10px; font-size: 12px; }
    .note { font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0; }
    .vide { font-size: 13px; color: var(--fg-tertiary); margin: 0; }
    .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
    .tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); }
    .tbl td { padding: 9px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 55%, transparent); vertical-align: top; color: var(--fg-primary); }
    .droite { text-align: right; }
    .mono { font-family: ui-monospace, monospace; font-size: 12.5px; }
    .petit { font-size: 12.5px; color: var(--fg-secondary); }
    .jamais { color: var(--fg-tertiary); font-style: italic; }
    .jeton { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .etat { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; }
    .etat.ok { color: var(--texte-succes); }
    .etat.ko { color: var(--texte-alerte); }
    `,
  ],
})
export class AdminDemoComptesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Ban = Ban;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly Mail = Mail;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Trash2 = Trash2;
  protected readonly Users = Users;

  readonly comptes = signal<CompteDemo[]>([]);
  readonly invitations = signal<InvitationDemo[]>([]);
  readonly etat = signal<'chargement' | 'ok' | 'non-configure' | 'injoignable'>('chargement');
  readonly erreur = signal('');
  readonly chargement = signal(false);
  readonly envoi = signal(false);

  nouvelEmail = '';
  nouveauRole = 'FLEET_ADMIN';

  readonly invitationsEnCours = computed(() => this.invitations().filter((i) => i.statut === 'PENDING'));
  readonly emailValide = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.nouvelEmail.trim()));

  async ngOnInit(): Promise<void> {
    await this.charger();
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      const etat = await firstValueFrom(
        this.http.get<{ configure: boolean }>('/api/admin/demo-console/etat'),
      );
      if (!etat.configure) {
        this.etat.set('non-configure');
        return;
      }
      const [comptes, invitations] = await Promise.all([
        firstValueFrom(this.http.get<CompteDemo[]>('/api/admin/demo-console/comptes')),
        firstValueFrom(this.http.get<InvitationDemo[]>('/api/admin/demo-console/invitations')),
      ]);
      this.comptes.set(comptes);
      this.invitations.set(invitations);
      this.etat.set('ok');
    } catch (e) {
      // La démo est arrêtée pendant son rafraîchissement hebdomadaire : ce n'est pas une panne
      // de la production, et l'écran doit le dire plutôt que de rester vide.
      this.erreur.set(this.message(e, "L'environnement de démonstration n'a pas répondu."));
      this.etat.set('injoignable');
      swallow('admin-demo-comptes:charger', e);
    } finally {
      this.chargement.set(false);
    }
  }

  async inviter(): Promise<void> {
    if (!this.emailValide()) return;
    this.envoi.set(true);
    try {
      await firstValueFrom(
        this.http.post('/api/admin/demo-console/invitations', {
          email: this.nouvelEmail.trim(),
          role: this.nouveauRole,
        }),
      );
      this.toast.success(`Invitation envoyée à ${this.nouvelEmail.trim()}`);
      this.nouvelEmail = '';
      await this.charger();
    } catch (e) {
      this.toast.error(this.message(e, "L'invitation n'est pas partie."));
      swallow('admin-demo-comptes:inviter', e);
    } finally {
      this.envoi.set(false);
    }
  }

  async revoquer(i: InvitationDemo): Promise<void> {
    try {
      await firstValueFrom(this.http.delete(`/api/admin/demo-console/invitations/${i.id}`));
      this.toast.success(`Invitation de ${i.email} révoquée`);
      await this.charger();
    } catch (e) {
      this.toast.error(this.message(e, 'La révocation a échoué.'));
      swallow('admin-demo-comptes:revoquer', e);
    }
  }

  async basculerBlocage(c: CompteDemo): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(`/api/admin/demo-console/comptes/${c.id}/blocage`, { bloque: c.actif }),
      );
      this.toast.success(`${c.email} ${c.actif ? 'bloqué' : 'débloqué'}`);
      await this.charger();
    } catch (e) {
      // L'API refuse les comptes de service et les super-admins : son message est plus utile
      // qu'un « échec » générique, on le montre tel quel.
      this.toast.error(this.message(e, "Le changement d'état a échoué."));
      swallow('admin-demo-comptes:blocage', e);
    }
  }

  protected libelleRole(role: string): string {
    const libelles: Record<string, string> = {
      SUPER_ADMIN: 'Super-administrateur',
      FLEET_ADMIN: 'Administrateur de flotte',
      FLEET_MANAGER: 'Gestionnaire',
      VIEWER: 'Lecteur',
      NIGHT_WATCHMAN: 'Veilleur',
      DRIVER: 'Conducteur',
      DEPOT: 'Dépôt',
    };
    return libelles[role] ?? role;
  }

  private message(e: unknown, defaut: string): string {
    const m = (e as { error?: { error?: { message?: string }; message?: string } })?.error;
    return m?.error?.message ?? m?.message ?? defaut;
  }
}

import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Plus, Trash2, Users } from 'lucide-angular';
import { UsersApiService, type TrackyUser } from '../../core/services/users.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';

@Component({
  selector: 'app-users-list',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, ConfirmModalComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Utilisateurs</h1>
        <button
          (click)="showCreateModal.set(true)"
          class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl
                 bg-tracky hover:bg-tracky-dark text-white transition-colors cursor-pointer">
          <lucide-icon [img]="Plus" [size]="16"></lucide-icon>
          Ajouter un utilisateur
        </button>
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center h-40">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (users().length === 0) {
        <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-3">
          <lucide-icon [img]="UsersIcon" [size]="48" class="opacity-30"></lucide-icon>
          <p>Aucun utilisateur dans votre flotte</p>
          <button
            (click)="showCreateModal.set(true)"
            class="text-sm text-tracky-light hover:underline cursor-pointer">
            Ajouter votre premier utilisateur
          </button>
        </div>
      } @else {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
          <table class="w-full text-sm">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Email</th>
                <th class="p-3 text-left">Nom</th>
                <th class="p-3 text-center">Role</th>
                <th class="p-3 text-center">Statut</th>
                <th class="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors">
                  <td class="p-3">
                    <span class="font-semibold text-fg-primary">{{ u.email }}</span>
                  </td>
                  <td class="p-3 text-fg-secondary">
                    {{ u.firstName ?? '' }} {{ u.lastName ?? '' }}
                    @if (!u.firstName && !u.lastName) { <span class="text-fg-tertiary">—</span> }
                  </td>
                  <td class="p-3 text-center">
                    <span class="px-2 py-0.5 rounded-full text-xs font-medium"
                          [class]="u.role === 'FLEET_ADMIN' ? 'bg-tracky/20 text-tracky-light' : 'bg-bg-tertiary text-fg-secondary'">
                      {{ roleLabel(u.role) }}
                    </span>
                  </td>
                  <td class="p-3 text-center">
                    <span class="w-2 h-2 rounded-full inline-block"
                          [class]="u.isActive ? 'bg-tracky-light' : 'bg-red-400'"></span>
                  </td>
                  <td class="p-3 text-right">
                    @if (u.role !== 'FLEET_ADMIN') {
                      <button
                        (click)="confirmDelete(u)"
                        class="p-1.5 rounded-lg text-fg-tertiary hover:text-red-400 hover:bg-red-400/10
                               transition-colors cursor-pointer">
                        <lucide-icon [img]="Trash2" [size]="16"></lucide-icon>
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <!-- Create Modal -->
    <app-confirm-modal
      [open]="showCreateModal()"
      title="Ajouter un utilisateur"
      confirmLabel="Creer"
      [loading]="creating()"
      (confirmed)="onCreate()"
      (cancelled)="showCreateModal.set(false)"
    >
      <div class="flex flex-col gap-3 mt-4">
        @if (createError()) {
          <p class="text-sm text-red-400">{{ createError() }}</p>
        }
        <input type="email" [(ngModel)]="newEmail" placeholder="Email"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        <input type="password" [(ngModel)]="newPassword" placeholder="Mot de passe (min 12 car.)"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        <div class="grid grid-cols-2 gap-3">
          <input type="text" [(ngModel)]="newFirstName" placeholder="Prenom (optionnel)"
            class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                   placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
          <input type="text" [(ngModel)]="newLastName" placeholder="Nom (optionnel)"
            class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                   placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        </div>
      </div>
    </app-confirm-modal>

    <!-- Delete Modal -->
    <app-confirm-modal
      [open]="showDeleteModal()"
      title="Supprimer l'utilisateur"
      [description]="'Voulez-vous supprimer <strong>' + (userToDelete()?.email ?? '') + '</strong> ? Cette action est irreversible.'"
      confirmLabel="Supprimer"
      [danger]="true"
      [loading]="deleting()"
      (confirmed)="onDelete()"
      (cancelled)="showDeleteModal.set(false)"
    />
  `,
})
export class UsersListComponent implements OnInit {
  private readonly usersService = inject(UsersApiService);

  readonly loading = signal(true);
  readonly users = signal<TrackyUser[]>([]);

  readonly showCreateModal = signal(false);
  readonly creating = signal(false);
  readonly createError = signal('');
  newEmail = '';
  newPassword = '';
  newFirstName = '';
  newLastName = '';

  readonly showDeleteModal = signal(false);
  readonly deleting = signal(false);
  readonly userToDelete = signal<TrackyUser | null>(null);

  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly UsersIcon = Users;

  async ngOnInit(): Promise<void> {
    await this.loadUsers();
  }

  private async loadUsers(): Promise<void> {
    this.loading.set(true);
    try {
      this.users.set(await this.usersService.findAll());
    } catch { /* error */ }
    finally { this.loading.set(false); }
  }

  roleLabel(role: string): string {
    const map: Record<string, string> = {
      SUPER_ADMIN: 'Super Admin',
      FLEET_ADMIN: 'Administrateur',
      FLEET_MANAGER: 'Manager',
      VIEWER: 'Lecteur',
    };
    return map[role] ?? role;
  }

  async onCreate(): Promise<void> {
    if (!this.newEmail || !this.newPassword) return;
    this.creating.set(true);
    this.createError.set('');
    try {
      await this.usersService.create({
        email: this.newEmail,
        password: this.newPassword,
        firstName: this.newFirstName || undefined,
        lastName: this.newLastName || undefined,
        role: 'VIEWER',
      });
      this.showCreateModal.set(false);
      this.newEmail = '';
      this.newPassword = '';
      this.newFirstName = '';
      this.newLastName = '';
      await this.loadUsers();
    } catch (e) {
      this.createError.set((e as Error).message);
    } finally {
      this.creating.set(false);
    }
  }

  confirmDelete(user: TrackyUser): void {
    this.userToDelete.set(user);
    this.showDeleteModal.set(true);
  }

  async onDelete(): Promise<void> {
    const user = this.userToDelete();
    if (!user) return;
    this.deleting.set(true);
    try {
      await this.usersService.remove(user.id);
      this.showDeleteModal.set(false);
      this.userToDelete.set(null);
      await this.loadUsers();
    } catch { /* error */ }
    finally { this.deleting.set(false); }
  }
}

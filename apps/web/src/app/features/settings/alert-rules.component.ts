import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  ArrowLeft,
  Bell,
  Edit2,
  LucideAngularModule,
  Mail,
  MessageCircle,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import {
  AlertRuleDto,
  NotificationsApiService,
} from '../../core/services/notifications.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

const ALERT_TYPES: { value: string; label: string; severity: string }[] = [
  { value: '*', label: 'Tous les types', severity: '' },
  // CRITICAL
  { value: 'SOS', label: 'SOS', severity: 'critical' },
  { value: 'POWER_CUT', label: 'Coupure alimentation', severity: 'critical' },
  { value: 'ACCIDENT', label: 'Accident', severity: 'critical' },
  { value: 'COLLISION', label: 'Collision', severity: 'critical' },
  { value: 'TOW', label: 'Remorquage', severity: 'critical' },
  { value: 'TAMPER', label: 'Retrait tracker', severity: 'critical' },
  { value: 'ILLEGAL_IGNITION', label: 'Demarrage non autorise', severity: 'critical' },
  // WARNING
  { value: 'LOW_BATTERY', label: 'Batterie faible', severity: 'warning' },
  { value: 'OVERSPEED', label: 'Exces de vitesse', severity: 'warning' },
  { value: 'GEOFENCE_ENTER', label: 'Entree geofence', severity: 'warning' },
  { value: 'GEOFENCE_EXIT', label: 'Sortie geofence', severity: 'warning' },
  { value: 'MOVEMENT_IDLE', label: 'Mouvement a l\'arret', severity: 'warning' },
  { value: 'BONNET', label: 'Capot ouvert', severity: 'warning' },
  { value: 'DOOR', label: 'Porte ouverte', severity: 'warning' },
  { value: 'FATIGUE', label: 'Fatigue conducteur', severity: 'warning' },
  // INFO
  { value: 'HARSH_BRAKING', label: 'Freinage brutal', severity: 'info' },
  { value: 'HARSH_ACCELERATION', label: 'Acceleration brutale', severity: 'info' },
  { value: 'HARSH_TURN', label: 'Virage brutal', severity: 'info' },
  { value: 'VIBRATION', label: 'Vibration', severity: 'info' },
  { value: 'GPS_LOST', label: 'Perte signal GPS', severity: 'info' },
  { value: 'IDLE_TIME', label: 'Arret prolonge', severity: 'info' },
];

const ALL_CHANNELS: { value: 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP'; label: string; icon: typeof Bell }[] = [
  { value: 'WEB_PUSH', label: 'Notifications push (navigateur)', icon: Bell },
  { value: 'EMAIL', label: 'Email', icon: Mail },
  { value: 'WHATSAPP', label: 'WhatsApp', icon: MessageCircle },
];

interface RuleForm {
  id: string | null;
  vehicleId: string | null;
  alertType: string;
  enabled: boolean;
  channels: ('WEB_PUSH' | 'EMAIL' | 'WHATSAPP')[];
  escalateAfterMin: number | null;
  escalateToUserId: string | null;
}

const EMPTY_FORM: RuleForm = {
  id: null,
  vehicleId: null,
  alertType: '*',
  enabled: true,
  channels: ['EMAIL'],
  escalateAfterMin: null,
  escalateToUserId: null,
};

@Component({
  selector: 'app-alert-rules',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule, RouterLink],
  template: `
    <div class="page">
      <a routerLink="/settings" class="back-link">
        <lucide-icon [img]="ArrowLeft" [size]="13"></lucide-icon>
        Réglages
      </a>
      <div class="page-head-row">
        <div class="page-head-txt">
          <h1>Règles de notification.</h1>
          <p class="page-desc">
            Pour chaque type d'alerte, choisissez les canaux sur lesquels la flotte
            est notifiée. Les règles s'appliquent par flotte ; affinez au besoin par véhicule.
          </p>
        </div>
        @if (canEdit()) {
          <button class="btn-primary" (click)="openCreate()">
            <lucide-icon [img]="Plus" [size]="15"></lucide-icon>
            Ajouter une règle
          </button>
        }
      </div>

      @if (!canEdit()) {
        <div class="info-box">
          <lucide-icon [img]="Bell" [size]="20"></lucide-icon>
          <div>
            <strong>Lecture seule</strong>
            <p>Seul un FLEET_ADMIN ou SUPER_ADMIN peut créer ou modifier les règles.</p>
          </div>
        </div>
      }

      <section class="card">
        @if (rules().length === 0) {
          <div class="empty">
            <p class="muted">Aucune règle configurée. Par défaut, les alertes sont
            notifiées in-app uniquement.</p>
          </div>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Statut</th>
                  <th>Type d'alerte</th>
                  <th>Canaux</th>
                  <th>Escalade</th>
                  <th>Créé</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (rule of rules(); track rule.id) {
                  <tr>
                    <td>
                      @if (rule.enabled) {
                        <span class="pill pill-on">● Actif</span>
                      } @else {
                        <span class="pill pill-off">○ Désactivé</span>
                      }
                    </td>
                    <td><code>{{ alertTypeLabel(rule.alertType) }}</code></td>
                    <td>
                      <div class="channels">
                        @for (c of rule.channels; track c) {
                          <span class="ch-pill" [title]="channelLabel(c)"><lucide-icon [img]="channelIcon(c)" [size]="12"></lucide-icon></span>
                        }
                        @if (rule.channels.length === 0) {
                          <span class="muted">—</span>
                        }
                      </div>
                    </td>
                    <td>
                      @if (rule.escalateAfterMin) {
                        <span class="muted">{{ rule.escalateAfterMin }} min</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="muted">{{ rule.createdAt | date: 'dd/MM/yyyy' }}</td>
                    <td>
                      @if (canEdit()) {
                        <button class="btn-icon" (click)="openEdit(rule)" aria-label="Editer">
                          <lucide-icon [img]="Edit2" [size]="14"></lucide-icon>
                        </button>
                        <button class="btn-icon btn-icon-danger" (click)="deleteRule(rule)" aria-label="Supprimer">
                          <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
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

      <!-- Modal create/edit -->
      @if (formOpen()) {
        <div class="modal-overlay" (click)="closeForm()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <h2>{{ form().id ? 'Modifier' : 'Nouvelle' }} règle</h2>
              <button class="btn-icon" (click)="closeForm()">
                <lucide-icon [img]="XCircle" [size]="18"></lucide-icon>
              </button>
            </div>
            <div class="modal-body">
              <div class="field">
                <label>Type d'alerte</label>
                <select [(ngModel)]="formAlertType">
                  @for (t of alertTypes; track t.value) {
                    <option [value]="t.value">{{ t.label }}</option>
                  }
                </select>
              </div>

              <div class="field">
                <label>Canaux de notification</label>
                <div class="channel-toggles">
                  @for (c of allChannels; track c.value) {
                    <label class="channel-toggle">
                      <input type="checkbox"
                             [checked]="form().channels.includes(c.value)"
                             (change)="toggleChannel(c.value, $any($event.target).checked)" />
                      <span><lucide-icon [img]="c.icon" [size]="13"></lucide-icon> {{ c.label }}</span>
                    </label>
                  }
                </div>
              </div>

              <div class="field-row">
                <label class="field">
                  <span>Escalader apres (min)</span>
                  <input type="number" min="1" max="120" placeholder="ex: 10"
                         [ngModel]="form().escalateAfterMin"
                         (ngModelChange)="updateForm({ escalateAfterMin: $event ? Number($event) : null })" />
                </label>
              </div>

              <label class="checkbox-row">
                <input type="checkbox" [ngModel]="form().enabled"
                       (ngModelChange)="updateForm({ enabled: $event })" />
                Règle active
              </label>
            </div>
            <div class="modal-footer">
              <button class="btn-ghost" (click)="closeForm()">Annuler</button>
              <button class="btn-primary" (click)="save()" [disabled]="saving()">
                {{ saving() ? 'Enregistrement...' : 'Enregistrer' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px }
    .page-head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap }
    .page-head-txt { max-width: 560px }
    .page-head-txt h1 { font-family: var(--font-display, inherit); font-size: 1.72rem; font-weight: 800; letter-spacing: -.03em; line-height: 1.1; color: var(--fg-primary); margin: 0 }
    .page-desc { font-size: 14px; color: var(--fg-secondary); line-height: 1.5; margin: 8px 0 0 }
    .back-link {
      display: inline-flex; align-items: center; gap: 4px;
      color: var(--fg-tertiary); font-size: 12px; text-decoration: none; align-self: flex-start;
    }
    .back-link:hover { color: var(--fg-secondary) }
    .muted { color: var(--fg-tertiary); font-size: 12px; margin: 0 }
    .card {
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 18px;
    }
    .info-box {
      display: flex; gap: 12px; padding: 14px;
      background: rgba(56,189,248,.08);
      border: 1px solid rgba(56,189,248,.25);
      border-radius: var(--radius-card);
      color: var(--fg-secondary);
    }
    .info-box strong { display: block; margin-bottom: 2px }
    .info-box p { margin: 0; font-size: 12px }
    .empty { padding: 32px; text-align: center }
    .table-wrap { overflow-x: auto }
    table { width: 100%; min-width: 700px; border-collapse: collapse; font-size: 13px }
    th { text-align: left; padding: 10px 12px; color: var(--fg-tertiary); font-size: 11px; text-transform: uppercase; border-bottom: 1px solid var(--border-subtle) }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); color: var(--fg-primary) }
    code { font-family: var(--font-mono, monospace); font-size: 11px; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px }
    .pill { display: inline-flex; padding: 2px 8px; border-radius: 9999px; font-size: 10px; font-weight: 600 }
    .pill-on { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .pill-off { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .channels { display: flex; gap: 4px; flex-wrap: wrap }
    .ch-pill { display: inline-flex; align-items: center; padding: 3px 6px; background: var(--bg-tertiary); border-radius: 4px; color: var(--fg-secondary) }
    /* .btn-primary : styles globaux (styles.css) */
    .btn-ghost {
      background: transparent; color: var(--fg-secondary);
      border: 1px solid var(--border-subtle); padding: 8px 14px; border-radius: 8px;
      font-size: 12px; cursor: pointer;
    }
    .btn-icon {
      background: transparent; border: 0; color: var(--fg-tertiary);
      padding: 6px; border-radius: 4px; cursor: pointer;
    }
    .btn-icon:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .btn-icon-danger:hover { color: rgb(244, 63, 94) }

    /* Modal */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.5);
      display: flex; align-items: center; justify-content: center;
      z-index: 100; padding: 16px;
    }
    .modal {
      background: var(--bg-secondary); border-radius: 20px;
      width: 100%; max-width: 480px; max-height: 90vh; max-height: 90dvh; overflow-y: auto;
      border: 1px solid var(--border-strong);
    }
    .modal-header, .modal-footer {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 18px; border-bottom: 1px solid var(--border-subtle);
    }
    .modal-footer { border-top: 1px solid var(--border-subtle); border-bottom: 0; gap: 8px }
    .modal-header h2 { margin: 0; font-size: 16px; font-weight: 700 }
    .modal-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 16px }
    .field { display: flex; flex-direction: column; gap: 6px }
    .field label, .field > span { font-size: 11px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase }
    .field select, .field input[type="number"] {
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); padding: 8px 10px; border-radius: 6px;
      font-size: 13px;
    }
    .field-row { display: flex; gap: 12px }
    .channel-toggles { display: flex; flex-direction: column; gap: 6px }
    .channel-toggle {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; background: var(--bg-tertiary); border-radius: 6px;
      cursor: pointer; font-size: 13px;
    }
    .channel-toggle:hover { background: var(--bg-primary) }
    .channel-toggle span { display: inline-flex; align-items: center; gap: 6px }
    .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer }
  `],
})
export class AlertRulesComponent implements OnInit {
  private readonly api = inject(NotificationsApiService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Bell = Bell;
  protected readonly Edit2 = Edit2;
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly XCircle = XCircle;
  protected readonly alertTypes = ALERT_TYPES;
  protected readonly allChannels = ALL_CHANNELS;
  protected readonly Number = Number;

  protected readonly rules = signal<AlertRuleDto[]>([]);
  protected readonly form = signal<RuleForm>({ ...EMPTY_FORM });
  protected readonly formOpen = signal(false);
  protected readonly saving = signal(false);

  protected readonly canEdit = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN';
  });

  /** ngModel binding helper for alertType. */
  protected get formAlertType(): string {
    return this.form().alertType;
  }
  protected set formAlertType(value: string) {
    this.updateForm({ alertType: value });
  }

  async ngOnInit(): Promise<void> {
    await this.api.listRules();
    this.rules.set(this.api.rules());
  }

  alertTypeLabel(value: string): string {
    return ALERT_TYPES.find((t) => t.value === value)?.label ?? value;
  }

  channelLabel(c: string): string {
    return ALL_CHANNELS.find((x) => x.value === c)?.label ?? c;
  }

  channelIcon(c: string): typeof Bell {
    return ALL_CHANNELS.find((x) => x.value === c)?.icon ?? Bell;
  }

  openCreate(): void {
    this.form.set({ ...EMPTY_FORM });
    this.formOpen.set(true);
  }

  openEdit(rule: AlertRuleDto): void {
    this.form.set({
      id: rule.id,
      vehicleId: rule.vehicleId,
      alertType: rule.alertType,
      enabled: rule.enabled,
      channels: rule.channels.filter((c) => c !== 'IN_APP') as RuleForm['channels'],
      escalateAfterMin: rule.escalateAfterMin,
      escalateToUserId: rule.escalateToUserId,
    });
    this.formOpen.set(true);
  }

  closeForm(): void {
    this.formOpen.set(false);
  }

  toggleChannel(channel: 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP', checked: boolean): void {
    const current = this.form().channels;
    const next = checked ? [...current, channel] : current.filter((c) => c !== channel);
    this.updateForm({ channels: next as RuleForm['channels'] });
  }

  updateForm(patch: Partial<RuleForm>): void {
    this.form.update((f) => ({ ...f, ...patch }));
  }

  async save(): Promise<void> {
    const f = this.form();
    if (f.channels.length === 0) {
      this.toast.error('Choisis au moins un canal');
      return;
    }
    this.saving.set(true);
    try {
      const payload = {
        vehicleId: f.vehicleId,
        alertType: f.alertType,
        enabled: f.enabled,
        channels: f.channels,
        escalateAfterMin: f.escalateAfterMin,
        escalateToUserId: f.escalateToUserId,
      };
      if (f.id) {
        await this.api.updateRule(f.id, payload);
        this.toast.success('Règle mise à jour');
      } else {
        await this.api.createRule(payload);
        this.toast.success('Règle créée');
      }
      await this.api.listRules();
      this.rules.set(this.api.rules());
      this.formOpen.set(false);
    } catch {
      this.toast.error('Échec de l\'enregistrement');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRule(rule: AlertRuleDto): Promise<void> {
    if (!confirm(`Supprimer la règle "${this.alertTypeLabel(rule.alertType)}" ?`)) return;
    try {
      await this.api.deleteRule(rule.id);
      this.toast.success('Règle supprimée');
      await this.api.listRules();
      this.rules.set(this.api.rules());
    } catch {
      this.toast.error('Échec de la suppression');
    }
  }
}

import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CalendarClock, EyeOff, Eye, LucideAngularModule, Search, ShieldOff } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { VehicleDetailDto } from '../../core/services/vehicles.service';
import { PrivacyModeApiService } from '../../core/services/privacy-mode.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { WorkScheduleEditorComponent } from './work-schedule-editor.component';

/**
 * Onglet « Mode privé » de la page Véhicules. Liste les véhicules (déjà filtrés par
 * société côté parent) avec un interrupteur par voiture. Activer/désactiver ouvre une
 * modal de confirmation avec note facultative (comme « couper le moteur »). Quand le
 * mode privé est ON, aucune position n'est collectée pour ce véhicule.
 */
@Component({
  selector: 'app-privacy-mode-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, RouterLink, LucideAngularModule, ConfirmModalComponent, WorkScheduleEditorComponent],
  template: `
    <div class="pm">
      <div class="pm-intro">
        <lucide-icon [img]="ShieldOff" [size]="18"></lucide-icon>
        <div>
          <p class="pm-intro-t">Mode vie privée</p>
          <p class="pm-intro-s">Quand il est activé sur une voiture, <strong>aucune position n'est enregistrée</strong> tant qu'il reste actif : la dernière position connue est figée. L'historique des activations est tracé dans <a routerLink="/admin/activity">Activité → Système</a>.</p>
        </div>
      </div>

      <div class="pm-search">
        <lucide-icon [img]="Search" [size]="15"></lucide-icon>
        <input [ngModel]="search()" (ngModelChange)="search.set($event)" placeholder="Rechercher une plaque, marque…">
      </div>

      @if (rows().length === 0) {
        <div class="pm-empty">Aucun véhicule.</div>
      }
      @for (v of rows(); track v.id) {
        <div class="pm-row" [class.pm-row--on]="isPrivate(v)">
          <div class="pm-veh">
            <span class="pm-plate">{{ v.plate }}</span>
            @if (v.brand) { <span class="pm-bm">{{ v.brand }} {{ v.model }}</span> }
            @if (v.group) { <span class="pm-grp">{{ v.group.name }}</span> }
          </div>
          <div class="pm-state">
            @if (isPrivate(v)) {
              <span class="pm-badge"><lucide-icon [img]="EyeOff" [size]="13"></lucide-icon> Mode privé actif@if (sinceOf(v); as s) { · depuis {{ s | date:'dd/MM HH:mm' }} }</span>
            } @else {
              <span class="pm-badge pm-badge--off"><lucide-icon [img]="Eye" [size]="13"></lucide-icon> Collecte active</span>
            }
          </div>
          <button type="button" class="pm-cadre" (click)="editing.set(v)" title="Cadre de temps de travail (usage mixte)">
            <lucide-icon [img]="CalendarClock" [size]="14"></lucide-icon> Cadre
          </button>
          @if (canManage) {
            <button type="button" class="pm-toggle" [class.pm-toggle--on]="isPrivate(v)" [disabled]="busyId() === v.id" (click)="open(v)">
              {{ isPrivate(v) ? 'Désactiver' : 'Activer' }}
            </button>
          }
        </div>
      }
    </div>

    @if (editing(); as ev) {
      <app-work-schedule-editor [vehicleId]="ev.id" [plate]="ev.plate" (close)="editing.set(null)" (changed)="changed.emit()"></app-work-schedule-editor>
    }

    <app-confirm-modal
      [open]="!!pending()"
      [title]="pendingEnable() ? 'Activer le mode vie privée ?' : 'Désactiver le mode vie privée ?'"
      [description]="modalDesc()"
      [confirmLabel]="pendingEnable() ? 'Oui, activer' : 'Oui, désactiver'"
      cancelLabel="Annuler"
      [loading]="!!busyId()"
      (confirmed)="confirm()"
      (cancelled)="close()"
    >
      <textarea
        [ngModel]="note()" (ngModelChange)="note.set($event)"
        placeholder="Note (facultative — ex. demande du conducteur, week-end…)"
        maxlength="500" rows="2" class="pm-note"
      ></textarea>
    </app-confirm-modal>
  `,
  styles: [`
    .pm { display:flex; flex-direction:column; gap:10px; }
    .pm-intro { display:flex; gap:12px; padding:14px 16px; border-radius:12px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.08)); color:var(--tracky,#10E0A0); }
    .pm-intro-t { margin:0; font-weight:700; color:var(--fg-primary,#EAEFED); font-size:14px; }
    .pm-intro-s { margin:3px 0 0; font-size:12.5px; line-height:1.55; color:var(--fg-tertiary,#9BA5A1); }
    .pm-intro-s a { color:var(--tracky,#10E0A0); }
    .pm-search { display:flex; align-items:center; gap:8px; padding:9px 12px; border-radius:10px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.1)); color:var(--fg-tertiary,#69736E); }
    .pm-search input { flex:1; background:none; border:none; outline:none; color:var(--fg-primary,#EAEFED); font-size:14px; }
    .pm-row { display:flex; align-items:center; gap:12px; padding:12px 14px; border-radius:12px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.08)); }
    .pm-row--on { border-color:rgba(16,224,160,.35); background:rgba(16,224,160,.05); }
    .pm-veh { flex:1; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .pm-plate { font-family:var(--font-mono,monospace); font-weight:700; color:var(--fg-primary,#EAEFED); }
    .pm-bm { font-size:13px; color:var(--fg-secondary,#9BA5A1); }
    .pm-grp { font-size:11px; padding:2px 8px; border-radius:999px; background:var(--bg-tertiary,#161D1B); color:var(--fg-tertiary,#69736E); }
    .pm-state { flex:0 0 auto; }
    .pm-badge { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:600; color:var(--tracky,#10E0A0); }
    .pm-badge--off { color:var(--fg-tertiary,#69736E); }
    .pm-toggle { flex:0 0 auto; padding:8px 14px; border-radius:10px; border:1px solid var(--border-subtle,rgba(255,255,255,.14)); background:transparent; color:var(--fg-secondary,#9BA5A1); font-size:13px; font-weight:600; cursor:pointer; }
    .pm-toggle--on { background:var(--tracky,#10E0A0); color:#04130D; border-color:var(--tracky,#10E0A0); }
    .pm-toggle:disabled { opacity:.5; cursor:default; }
    .pm-cadre { flex:0 0 auto; display:inline-flex; align-items:center; gap:5px; padding:8px 12px; border-radius:10px; border:1px solid var(--border-subtle,rgba(255,255,255,.14)); background:transparent; color:var(--fg-tertiary,#9BA5A1); font-size:12.5px; font-weight:600; cursor:pointer; }
    .pm-cadre:hover { color:var(--fg-primary,#EAEFED); border-color:var(--tracky,#10E0A0); }
    .pm-empty { padding:24px; text-align:center; color:var(--fg-tertiary,#69736E); }
    .pm-note { width:100%; margin-top:12px; padding:9px 12px; border-radius:10px; background:var(--bg-tertiary,#161D1B); border:1px solid var(--border-subtle,rgba(255,255,255,.12)); color:var(--fg-primary,#EAEFED); font-size:14px; resize:none; box-sizing:border-box; }
    .pm-note:focus { outline:none; border-color:var(--tracky,#10E0A0); }
  `],
})
export class PrivacyModeTabComponent {
  private readonly api = inject(PrivacyModeApiService);
  private readonly toast = inject(ToastService);
  private readonly perms = inject(PermissionsService);

  readonly vehicles = input<VehicleDetailDto[]>([]);
  readonly changed = output<void>();

  protected readonly ShieldOff = ShieldOff; protected readonly Eye = Eye; protected readonly EyeOff = EyeOff; protected readonly Search = Search; protected readonly CalendarClock = CalendarClock;
  protected readonly canManage = this.perms.can('privacy_manage');

  /** Véhicule dont on édite le cadre de temps de travail (overlay). */
  protected readonly editing = signal<VehicleDetailDto | null>(null);
  protected readonly search = signal('');
  /** Overrides optimistes { vehicleId: { enabled, since } } après une bascule. */
  private readonly override = signal<Record<string, { enabled: boolean; since: string | null }>>({});
  protected readonly busyId = signal<string | null>(null);
  protected readonly pending = signal<VehicleDetailDto | null>(null);
  protected readonly pendingEnable = signal(false);
  protected readonly note = signal('');

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.vehicles();
    if (!q) return list;
    return list.filter((v) => `${v.plate} ${v.brand ?? ''} ${v.model ?? ''}`.toLowerCase().includes(q));
  });

  protected isPrivate(v: VehicleDetailDto): boolean {
    const o = this.override()[v.id];
    return o ? o.enabled : !!v.privacyModeEnabled;
  }
  protected sinceOf(v: VehicleDetailDto): string | null {
    const o = this.override()[v.id];
    return o ? o.since : (v.privacyModeSince ?? null);
  }
  protected modalDesc(): string {
    const v = this.pending();
    if (!v) return '';
    return this.pendingEnable()
      ? `<strong>${v.plate}</strong> — plus aucune position ne sera enregistrée tant que le mode privé reste actif. La dernière position connue reste figée.`
      : `<strong>${v.plate}</strong> — la collecte des positions reprend immédiatement.`;
  }

  protected open(v: VehicleDetailDto): void {
    this.pending.set(v);
    this.pendingEnable.set(!this.isPrivate(v));
    this.note.set('');
  }
  protected close(): void {
    this.pending.set(null);
  }

  protected async confirm(): Promise<void> {
    const v = this.pending();
    if (!v) return;
    const enable = this.pendingEnable();
    this.busyId.set(v.id);
    try {
      const state = await firstValueFrom(this.api.set(v.id, enable, this.note().trim() || undefined));
      this.override.update((o) => ({ ...o, [v.id]: { enabled: state.enabled, since: state.since } }));
      this.toast.success(enable ? 'Mode privé activé' : 'Mode privé désactivé', v.plate);
      this.changed.emit();
      this.close();
    } catch (e: unknown) {
      swallow('privacy-mode-tab:confirm', e);
      const msg = (e as { error?: { message?: string } })?.error?.message;
      this.toast.error('Action impossible', typeof msg === 'string' ? msg : 'Réessayez.');
    } finally {
      this.busyId.set(null);
    }
  }
}

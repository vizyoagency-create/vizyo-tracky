import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { LucideAngularModule, Plus, Shield, Trash2, Pencil, MapPin, Circle, ArrowDownLeft, ArrowUpRight, ArrowLeftRight } from 'lucide-angular';
import type { GeofenceDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { PermissionsService } from '../../core/services/permissions.service';
import { GeofencesApiService } from '../../core/services/geofences.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { GeofenceDrawDialogComponent } from './geofence-draw-dialog/geofence-draw-dialog.component';

@Component({
  selector: 'app-geofences-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, ConfirmModalComponent, GeofenceDrawDialogComponent],
  template: `
    <div class="gf-page">
      <div class="gf-blobs"></div>
      <div class="gf-blob-c"></div>

      <!-- Header -->
      <div class="gf-header">
        <div>
          <h1 class="gf-title">Géofences</h1>
          <p class="gf-sub">{{ geofences().length }} zone(s) configurée(s)</p>
        </div>
        @if (perms.can('geofences_manage')) {
          <button (click)="openCreate()" class="gf-add-btn">
            <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Nouvelle zone
          </button>
        }
      </div>

      @if (loading()) {
        <div class="gf-loading"><span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span></div>
      } @else if (geofences().length === 0) {
        <div class="gf-empty">
          <div class="gf-empty-icon"><lucide-icon [img]="Shield" [size]="32"></lucide-icon></div>
          <p>Aucune géofence configurée</p>
          @if (perms.can('geofences_manage')) {
            <button (click)="openCreate()" class="gf-empty-cta">Créer votre première zone</button>
          }
        </div>
      } @else {
        <div class="gf-grid">
          @for (g of geofences(); track g.id) {
            <div class="gf-card">
              <!-- Visual circle representation -->
              <div class="gf-visual">
                <div class="gf-circle-outer" [style.border-color]="g.color + '30'">
                  <div class="gf-circle-inner" [style.background]="g.color + '15'" [style.border-color]="g.color + '40'">
                    <div class="gf-circle-dot" [style.background]="g.color"></div>
                  </div>
                </div>
                <div class="gf-radius-label">{{ formatRadius(g.radiusMeters) }}</div>
              </div>

              <!-- Info -->
              <div class="gf-info">
                <div class="gf-name-row">
                  <span class="gf-color-dot" [style.background]="g.color"></span>
                  <span class="gf-name">{{ g.name }}</span>
                </div>
                <div class="gf-meta">
                  <span class="gf-rule-badge" [class]="ruleClass(g.rule)">
                    <lucide-icon [img]="ruleIcon(g.rule)" [size]="10"></lucide-icon>
                    {{ ruleLabel(g.rule) }}
                  </span>
                  <span class="gf-status" [class]="g.active ? 'active' : 'inactive'">
                    {{ g.active ? 'Activée' : 'Inactive' }}
                  </span>
                </div>
                <div class="gf-coords">
                  {{ g.centerLat.toFixed(4) }}, {{ g.centerLng.toFixed(4) }}
                </div>
              </div>

              <!-- Actions -->
              @if (perms.can('geofences_manage')) {
                <div class="gf-actions">
                  <button (click)="openEdit(g)" class="gf-action-btn edit" title="Modifier">
                    <lucide-icon [img]="Pencil" [size]="13"></lucide-icon>
                  </button>
                  <button (click)="confirmDel(g)" class="gf-action-btn delete" title="Supprimer">
                    <lucide-icon [img]="Trash2" [size]="13"></lucide-icon>
                  </button>
                </div>
              }
            </div>
          }
        </div>
      }
    </div>

    <app-geofence-draw-dialog [open]="showDrawDialog()" [editData]="editGeofence()" (created)="onDialogClosed()" />

    <app-confirm-modal
      [open]="showDeleteConfirm()"
      title="Supprimer la géofence"
      [description]="'Supprimer <strong>' + (deleteTarget()?.name ?? '') + '</strong> ? Cette action est irréversible.'"
      confirmLabel="Supprimer"
      [danger]="true"
      (confirmed)="onDeleteConfirmed()"
      (cancelled)="showDeleteConfirm.set(false)"
    />
  `,
  styles: [`
    .gf-page { position: relative; min-height: 100% }
    .gf-blobs { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden }
    .gf-blobs::before {
      content: ''; position: absolute; top: -8%; left: -10%; width: 45%; height: 50%;
      background: radial-gradient(ellipse, rgba(16,224,160,.06) 0%, transparent 70%);
      border-radius: 50% 40% 60% 30%; animation: gb1 12s ease-in-out infinite alternate;
    }
    .gf-blobs::after {
      content: ''; position: absolute; bottom: -12%; right: -8%; width: 40%; height: 45%;
      background: radial-gradient(ellipse, rgba(59,130,246,.05) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%; animation: gb2 10s ease-in-out infinite alternate;
    }
    .gf-blob-c {
      position: fixed; top: 45%; left: 55%; transform: translate(-50%,-50%); width: 28%; height: 32%;
      background: radial-gradient(ellipse, rgba(168,85,247,.04) 0%, transparent 70%);
      border-radius: 60% 40% 50% 30%; pointer-events: none; z-index: 0; animation: gb3 14s ease-in-out infinite alternate;
    }
    @keyframes gb1 { 0%{border-radius:50% 40% 60% 30%;transform:translate(0,0)} 100%{border-radius:30% 60% 40% 50%;transform:translate(4%,6%)} }
    @keyframes gb2 { 0%{border-radius:40% 60% 30% 50%;transform:translate(0,0)} 100%{border-radius:60% 30% 50% 40%;transform:translate(-3%,-4%)} }
    @keyframes gb3 { 0%{border-radius:60% 40% 50% 30%;transform:translate(-50%,-50%) scale(1)} 100%{border-radius:40% 50% 30% 60%;transform:translate(-50%,-50%) scale(1.1)} }

    .gf-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px }
    .gf-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .gf-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .gf-add-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 10px;
      font-size: 12px; font-weight: 700; background: #059669; color: white; border: none; cursor: pointer;
      box-shadow: 0 2px 8px rgba(5,150,105,.3);
    }
    .gf-add-btn:hover { background: #047857 }
    :host-context([data-theme="light"]) .gf-blobs::before { background: radial-gradient(ellipse, rgba(16,224,160,.1) 0%, transparent 70%) }
    :host-context([data-theme="light"]) .gf-blobs::after { background: radial-gradient(ellipse, rgba(59,130,246,.08) 0%, transparent 70%) }
    :host-context([data-theme="light"]) .gf-blob-c { background: radial-gradient(ellipse, rgba(168,85,247,.06) 0%, transparent 70%) }

    .gf-loading { position: relative; z-index: 1; display: flex; justify-content: center; padding: 60px 0 }
    .gf-empty {
      position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 50px 20px; border-radius: 16px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.08); color: var(--fg-tertiary); font-size: 14px;
    }
    .gf-empty-icon { width: 56px; height: 56px; border-radius: 14px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary) }
    .gf-empty-cta { font-size: 13px; color: var(--tracky-light); background: none; border: none; cursor: pointer; text-decoration: underline }

    .gf-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px }

    .gf-card {
      position: relative; display: flex; align-items: center; gap: 16px; padding: 16px 18px; border-radius: 14px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.55);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.08); transition: all .3s;
    }
    .gf-card:hover { border-color: rgba(16,224,160,.2); box-shadow: 0 0 24px rgba(16,224,160,.06), 0 6px 20px rgba(0,0,0,.12) }
    :host-context([data-theme="light"]) .gf-card { background: rgba(255,255,255,.7); border-color: rgba(5,150,105,.15); box-shadow: 0 2px 12px rgba(0,0,0,.04) }
    :host-context([data-theme="light"]) .gf-card:hover { border-color: rgba(5,150,105,.3); box-shadow: 0 4px 20px rgba(5,150,105,.08) }
    :host-context([data-theme="light"]) .gf-empty { background: rgba(255,255,255,.7); border-color: rgba(5,150,105,.12) }

    /* Visual circle */
    .gf-visual { position: relative; width: 64px; height: 64px; flex-shrink: 0; display: flex; align-items: center; justify-content: center }
    .gf-circle-outer {
      width: 60px; height: 60px; border-radius: 50%; border: 2px dashed; display: flex; align-items: center; justify-content: center;
      animation: gfpulse 3s ease-in-out infinite;
    }
    .gf-circle-inner { width: 40px; height: 40px; border-radius: 50%; border: 1.5px solid; display: flex; align-items: center; justify-content: center }
    .gf-circle-dot { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 6px currentColor }
    .gf-radius-label {
      position: absolute; bottom: -2px; right: -4px; font-size: 9px; font-weight: 700; color: var(--fg-tertiary);
      padding: 1px 5px; border-radius: 4px; background: var(--bg-tertiary);
    }
    @keyframes gfpulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.05);opacity:.7} }

    /* Info */
    .gf-info { flex: 1; min-width: 0 }
    .gf-name-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px }
    .gf-color-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 6px rgba(0,0,0,.2) }
    .gf-name { font-size: 14px; font-weight: 700; color: var(--fg-primary) }
    .gf-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px }
    .gf-rule-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 6px }
    .gf-rule-badge.enter { background: rgba(59,130,246,.1); color: #60a5fa }
    .gf-rule-badge.exit { background: rgba(245,158,11,.1); color: #f59e0b }
    .gf-rule-badge.both { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .gf-status { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 6px }
    .gf-status.active { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .gf-status.inactive { background: rgba(239,68,68,.1); color: #f87171 }
    .gf-coords { font-size: 10px; font-family: var(--font-mono, monospace); color: var(--fg-tertiary) }

    .gf-actions { position: absolute; top: 10px; right: 10px; display: flex; gap: 4px }
    .gf-action-btn {
      padding: 5px; border-radius: 6px; background: transparent; border: none;
      color: var(--fg-tertiary); cursor: pointer; transition: all .2s;
    }
    .gf-action-btn.edit:hover { color: var(--tracky-light); background: rgba(16,224,160,.1) }
    .gf-action-btn.delete:hover { color: #f87171; background: rgba(239,68,68,.1) }
  `],
})
export class GeofencesListComponent implements OnInit {
  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly toast = inject(ToastService);
  protected readonly perms = inject(PermissionsService);

  protected readonly geofences = signal<GeofenceDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly showDrawDialog = signal(false);
  protected readonly showDeleteConfirm = signal(false);
  protected readonly deleteTarget = signal<GeofenceDto | null>(null);

  protected readonly editGeofence = signal<{ id: string; name: string; rule: 'ENTER' | 'EXIT' | 'BOTH'; color: string; centerLat: number; centerLng: number; radiusMeters: number } | null>(null);

  protected readonly Plus = Plus;
  protected readonly Shield = Shield;
  protected readonly Trash2 = Trash2;
  protected readonly Pencil = Pencil;
  protected readonly MapPin = MapPin;
  protected readonly ArrowDownLeft = ArrowDownLeft;
  protected readonly ArrowUpRight = ArrowUpRight;
  protected readonly ArrowLeftRight = ArrowLeftRight;

  ngOnInit(): void { this.loadGeofences(); }

  protected ruleLabel(rule: string): string {
    if (rule === 'ENTER') return 'Entrée';
    if (rule === 'EXIT') return 'Sortie';
    return 'Entrée + Sortie';
  }

  protected ruleClass(rule: string): string {
    if (rule === 'ENTER') return 'enter';
    if (rule === 'EXIT') return 'exit';
    return 'both';
  }

  protected ruleIcon(rule: string) {
    if (rule === 'ENTER') return this.ArrowDownLeft;
    if (rule === 'EXIT') return this.ArrowUpRight;
    return this.ArrowLeftRight;
  }

  protected formatRadius(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
  }

  protected openCreate(): void {
    this.editGeofence.set(null);
    this.showDrawDialog.set(true);
  }

  protected openEdit(g: GeofenceDto): void {
    this.editGeofence.set({
      id: g.id, name: g.name, rule: g.rule as 'ENTER' | 'EXIT' | 'BOTH',
      color: g.color ?? '#10e0a0', centerLat: g.centerLat, centerLng: g.centerLng, radiusMeters: g.radiusMeters,
    });
    this.showDrawDialog.set(true);
  }

  protected confirmDel(g: GeofenceDto): void {
    this.deleteTarget.set(g);
    this.showDeleteConfirm.set(true);
  }

  protected async onDeleteConfirmed(): Promise<void> {
    const g = this.deleteTarget();
    if (!g) return;
    try {
      await firstValueFrom(this.geofencesApi.delete(g.id));
      this.geofences.update((list) => list.filter((x) => x.id !== g.id));
      this.toast.success('Géofence supprimée');
    } catch { this.toast.error('Échec de la suppression'); }
    this.showDeleteConfirm.set(false);
  }

  protected onDialogClosed(): void {
    this.showDrawDialog.set(false);
    this.editGeofence.set(null);
    this.loadGeofences();
  }

  private async loadGeofences(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.geofencesApi.list());
      this.geofences.set(list);
    } catch { this.geofences.set([]); }
    finally { this.loading.set(false); }
  }
}

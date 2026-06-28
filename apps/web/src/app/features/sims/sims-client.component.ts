import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Link, LucideAngularModule, RefreshCw, Search, Unlink, X } from 'lucide-angular';
import { simStatusLabel, type SimDto } from '@vizyo/tracky-shared';
import { PermissionsService } from '../../core/services/permissions.service';
import { SimsApiService } from '../../core/services/sims.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { formatBytes, formatDataLimit, simBadgeClass } from './sim-ui';

/**
 * V1.16 — Vue client (FLEET_ADMIN + delegues sims_view) du parc SIM de la flotte.
 * Lecture + assignation/detachement a un tracker (si sims_assign / admin).
 */
@Component({
  selector: 'app-sims-client',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="sp">
      <div class="sp-head">
        <div>
          <h1>Cartes SIM</h1>
          <p class="sp-sub">{{ sims().length }} SIM allouée(s) à votre flotte</p>
        </div>
        <button class="btn-ghost" (click)="reload()"><lucide-icon [img]="RefreshIcon" [size]="15"></lucide-icon> Rafraîchir</button>
      </div>

      <div class="sp-search">
        <lucide-icon [img]="SearchIcon" [size]="14"></lucide-icon>
        <input type="text" placeholder="Rechercher ICCID, numéro, tracker…" [(ngModel)]="search" />
      </div>

      @if (loading()) {
        <div class="sp-loading"><span class="spinner"></span></div>
      } @else if (filtered().length > 0) {
        <div class="sp-table-wrap">
          <table class="sp-table">
            <thead><tr><th>ICCID</th><th>Numéro</th><th>Statut</th><th>Conso (mois)</th><th>Tracker</th>@if (canAssign) { <th class="ta-r">Actions</th> }</tr></thead>
            <tbody>
              @for (s of filtered(); track s.id) {
                <tr>
                  <td class="mono">{{ s.iccid }}</td>
                  <td class="mono dim">{{ s.msisdn || '—' }}</td>
                  <td><span class="badge" [class]="badgeClass(s.statusId)">{{ statusLabel(s.statusId) }}</span></td>
                  <td class="dim">{{ fmtBytes(s.monthlyDataVolumeBytes) }} / {{ fmtLimit(s.monthlyDataLimitBytes) }}</td>
                  <td class="dim">
                    @if (s.tracker) { <span class="mono">{{ s.tracker.imei }}</span>@if (s.tracker.vehiclePlate) { · {{ s.tracker.vehiclePlate }} } }
                    @else { <span class="dim">non posée</span> }
                  </td>
                  @if (canAssign) {
                    <td class="ta-r">
                      @if (s.tracker) { <button class="lnk amber" (click)="unassign(s)"><lucide-icon [img]="UnlinkIcon" [size]="13"></lucide-icon> Détacher</button> }
                      @else { <button class="lnk green" (click)="startAssign(s)"><lucide-icon [img]="LinkIcon" [size]="13"></lucide-icon> Assigner</button> }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="sp-empty"><p>{{ sims().length === 0 ? 'Aucune carte SIM allouée à votre flotte pour le moment.' : 'Aucune SIM ne correspond à la recherche.' }}</p></div>
      }
    </div>

    @if (assigning(); as sim) {
      <div class="ov" (click)="cancelAssign()">
        <div class="ov-panel" (click)="$event.stopPropagation()">
          <div class="ov-head"><h2>Assigner SIM {{ sim.iccid }}</h2><button class="ov-x" (click)="cancelAssign()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button></div>
          <div class="ov-body">
            <div class="sp-search mb"><lucide-icon [img]="SearchIcon" [size]="14"></lucide-icon>
              <input type="text" placeholder="Rechercher IMEI / plaque…" [(ngModel)]="trackerSearch" /></div>
            <div class="picker">
              @for (t of filteredTrackers(); track t.id) {
                <button class="pick" (click)="confirmAssign(t.id)">
                  <span class="mono">{{ t.imei }}</span><span class="pick-meta">{{ t.vehiclePlate || 'libre' }}</span>
                </button>
              } @empty { <p class="hint">Aucun tracker sans SIM dans votre flotte.</p> }
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block }
    .sp { max-width: 920px }
    .sp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px }
    .sp-head h1 { font-family: var(--font-display, Poppins, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0 }
    .sp-sub { font-size: 13px; color: var(--fg-tertiary); margin: 4px 0 0 }
    .btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 12px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer }
    .sp-search { position: relative; display: flex; align-items: center; max-width: 360px; margin-bottom: 14px }
    .sp-search.mb { max-width: none; margin-bottom: 12px }
    .sp-search lucide-icon { position: absolute; left: 11px; color: var(--fg-tertiary) }
    .sp-search input { width: 100%; padding: 9px 12px 9px 32px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; color: var(--fg-primary); font-size: 13px; outline: none }
    .sp-search input:focus { border-color: var(--tracky) }
    .sp-table-wrap { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 14px; overflow-x: auto }
    .sp-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px }
    .sp-table thead th { text-align: left; padding: 11px 14px; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--fg-tertiary); border-bottom: 1px solid var(--border-subtle) }
    .sp-table tbody td { padding: 11px 14px; border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 50%, transparent); color: var(--fg-primary) }
    .ta-r { text-align: right } .mono { font-family: var(--font-mono, monospace); font-size: 12px } .dim { color: var(--fg-tertiary) }
    .badge { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 6px; white-space: nowrap }
    .st-active { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .st-suspended { background: rgba(245,158,11,.14); color: #fbbf24 }
    .st-pending { background: rgba(59,130,246,.12); color: #60a5fa }
    .st-inactive { background: rgba(239,68,68,.12); color: #f87171 }
    .st-unknown { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .lnk { background: none; border: none; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--fg-tertiary); padding: 3px 6px; display: inline-flex; align-items: center; gap: 4px }
    .lnk.green { color: var(--tracky-light) } .lnk.amber { color: #fbbf24 }
    .sp-loading { display: flex; justify-content: center; padding: 60px 0 }
    .spinner { width: 22px; height: 22px; border: 2px solid var(--border-subtle); border-top-color: var(--tracky-light); border-radius: 50%; animation: sp .7s linear infinite; display: inline-block }
    @keyframes sp { to { transform: rotate(360deg) } }
    .sp-empty { padding: 44px 20px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); text-align: center; font-size: 13px }
    .ov { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); backdrop-filter: blur(4px); padding: 16px }
    .ov-panel { width: 100%; max-width: 440px; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; max-height: 90vh; max-height: 90dvh }
    .ov-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-subtle) }
    .ov-head h2 { font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    .ov-x { padding: 6px; border-radius: 8px; background: none; border: none; color: var(--fg-tertiary); cursor: pointer }
    .ov-body { padding: 18px 20px; overflow-y: auto }
    .picker { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px }
    .pick { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 9px 12px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); cursor: pointer; text-align: left }
    .pick:hover { border-color: var(--tracky) } .pick-meta { font-size: 11px; color: var(--fg-tertiary) }
    .hint { font-size: 11px; color: var(--fg-tertiary) }
  `],
})
export class SimsClientComponent implements OnInit {
  private readonly api = inject(SimsApiService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  protected readonly RefreshIcon = RefreshCw;
  protected readonly SearchIcon = Search;
  protected readonly LinkIcon = Link;
  protected readonly UnlinkIcon = Unlink;
  protected readonly XIcon = X;
  protected readonly fmtBytes = formatBytes;
  protected readonly fmtLimit = formatDataLimit;
  protected readonly statusLabel = (id: number | null) => simStatusLabel(id);
  protected readonly badgeClass = (id: number | null) => simBadgeClass(id);

  protected readonly canAssign = this.perms.can('sims_assign');

  readonly loading = signal(true);
  readonly sims = signal<SimDto[]>([]);
  search = '';

  readonly assigning = signal<SimDto | null>(null);
  private allTrackers = signal<{ id: string; imei: string; vehiclePlate: string | null }[]>([]);
  trackerSearch = '';

  readonly filtered = computed(() => {
    const q = this.search.toLowerCase().trim();
    if (!q) return this.sims();
    return this.sims().filter((s) =>
      s.iccid.toLowerCase().includes(q) ||
      (s.msisdn ?? '').toLowerCase().includes(q) ||
      (s.tracker?.imei ?? '').toLowerCase().includes(q) ||
      (s.tracker?.vehiclePlate ?? '').toLowerCase().includes(q));
  });

  readonly filteredTrackers = computed(() => {
    const q = this.trackerSearch.toLowerCase().trim();
    let list = this.allTrackers();
    if (q) list = list.filter((t) => t.imei.toLowerCase().includes(q) || (t.vehiclePlate ?? '').toLowerCase().includes(q));
    return list.slice(0, 60);
  });

  ngOnInit(): void { void this.reload(); }

  async reload(): Promise<void> {
    this.loading.set(true);
    try { this.sims.set(await this.api.list()); }
    catch (e) { this.toast.error('Échec du chargement', this.errMsg(e)); }
    finally { this.loading.set(false); }
  }

  async startAssign(sim: SimDto): Promise<void> {
    this.assigning.set(sim); this.trackerSearch = '';
    try { this.allTrackers.set(await this.api.assignableTrackers()); }
    catch (e) { this.toast.error('Chargement trackers', this.errMsg(e)); }
  }
  cancelAssign(): void { this.assigning.set(null); }
  async confirmAssign(trackerId: string): Promise<void> {
    const sim = this.assigning(); if (!sim) return;
    try { await this.api.assign(sim.id, trackerId); this.toast.success('SIM assignée'); this.assigning.set(null); await this.reload(); }
    catch (e) { this.toast.error('Assignation échouée', this.errMsg(e)); }
  }
  async unassign(sim: SimDto): Promise<void> {
    if (!confirm(`Détacher la SIM ${sim.iccid} ?`)) return;
    try { await this.api.unassign(sim.id); this.toast.success('SIM détachée'); await this.reload(); }
    catch (e) { this.toast.error('Détachement échoué', this.errMsg(e)); }
  }

  private errMsg(err: unknown): string {
    const e = err as { error?: { message?: string | string[] }; message?: string };
    const m = e?.error?.message;
    if (Array.isArray(m)) return m.join(', ');
    return m ?? e?.message ?? 'Erreur inconnue';
  }
}

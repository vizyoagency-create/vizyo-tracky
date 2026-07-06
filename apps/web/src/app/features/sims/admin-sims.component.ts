import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  Activity,
  ArrowLeft,
  Building2,
  CreditCard,
  Database,
  Gauge,
  Link,
  Plus,
  Power,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Unlink,
  Upload,
  X,
  LucideAngularModule,
} from 'lucide-angular';
import {
  simStatusCategory,
  simStatusLabel,
  type SimConsumptionPointDto,
  type SimDto,
  type SimEventDto,
  type SimStatsDto,
} from '@vizyo/tracky-shared';
import { FleetsApiService, type FleetSummary } from '../../core/services/fleets.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { SimsApiService } from '../../core/services/sims.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { SpinnerComponent } from '../../shared/ui/spinner/spinner.component';
import {
  dataPercent,
  formatBytes,
  formatDataLimit,
  formatDateFr,
  formatDateTimeFr,
  simBadgeClass,
  SIM_STATUS_ACTIONS,
} from './sim-ui';

@Component({
  selector: 'app-admin-sims',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideAngularModule, GroupBadgeComponent, SpinnerComponent],
  template: `
    <div class="sp">
      <!-- Header -->
      <div class="sp-head">
        <div>
          <a routerLink="/admin" class="sp-back">
            <lucide-icon [img]="ArrowLeftIcon" [size]="14"></lucide-icon> Administration
          </a>
          <h1>Cartes SIM</h1>
          <p class="sp-sub">Parc M2M WhereverSIM — {{ sims().length }} carte(s) en cache</p>
        </div>
        <div class="sp-actions">
          <button class="btn-ghost" (click)="doSync()" [disabled]="syncing()">
            <lucide-icon [img]="RefreshIcon" [size]="15" [class.spin]="syncing()"></lucide-icon>
            {{ syncing() ? 'Sync…' : 'Synchroniser' }}
          </button>
          <button class="btn-ghost" (click)="openBulk()">
            <lucide-icon [img]="UploadIcon" [size]="15"></lucide-icon> Importer un lot
          </button>
          <button class="btn-primary" (click)="openCreate()">
            <lucide-icon [img]="PlusIcon" [size]="15"></lucide-icon> Nouvelle SIM
          </button>
        </div>
      </div>

      <!-- Stats -->
      @if (stats(); as s) {
        <div class="sp-kpis">
          <div class="kpi"><lucide-icon [img]="CreditCardIcon" [size]="22" class="i-sky"></lucide-icon>
            <div><span class="kpi-n">{{ s.totalSimCards }}</span><span class="kpi-l">Total parc</span></div></div>
          <div class="kpi"><lucide-icon [img]="ActivityIcon" [size]="22" class="i-emerald"></lucide-icon>
            <div><span class="kpi-n">{{ s.activeSimCards }}</span><span class="kpi-l">Actives</span></div></div>
          <div class="kpi"><lucide-icon [img]="GaugeIcon" [size]="22" class="i-amber"></lucide-icon>
            <div><span class="kpi-n">{{ fmtBytes(s.currentMonthlyDataUsage) }}</span><span class="kpi-l">Conso ce mois</span></div></div>
          <div class="kpi"><lucide-icon [img]="DatabaseIcon" [size]="22" class="i-purple"></lucide-icon>
            <div><span class="kpi-n">{{ fmtBytes(s.previousMonthDataUsage) }}</span><span class="kpi-l">Mois précédent</span></div></div>
        </div>
      }

      <!-- Filters -->
      <div class="sp-filters">
        <div class="sp-search">
          <lucide-icon [img]="SearchIcon" [size]="14"></lucide-icon>
          <input type="text" placeholder="Rechercher ICCID, numéro, IMEI, label…" [(ngModel)]="search" />
        </div>
        <select [(ngModel)]="filterStatus">
          <option value="">Tous les statuts</option>
          <option value="active">Actives</option>
          <option value="suspended">Suspendues</option>
          <option value="pending">En attente / stock</option>
          <option value="inactive">Inactives / résiliées</option>
        </select>
        <select [(ngModel)]="filterAssigned">
          <option value="">Toutes</option>
          <option value="assigned">Posées</option>
          <option value="unassigned">Non posées</option>
        </select>
      </div>

      <!-- Table -->
      @if (loading()) {
        <div class="sp-loading"><app-spinner [size]="22" /></div>
      } @else if (filtered().length > 0) {
        <div class="sp-table-wrap">
          <table class="sp-table">
            <thead>
              <tr>
                <th>ICCID</th><th>Numéro</th><th>Statut</th><th>Conso (mois)</th>
                <th>Flotte</th><th>Tracker</th><th class="ta-r">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (s of filtered(); track s.id) {
                <tr (click)="openDetail(s)" class="row">
                  <td class="mono">{{ s.iccid }}</td>
                  <td class="mono dim">{{ s.msisdn || '—' }}</td>
                  <td><span class="badge" [class]="badgeClass(s.statusId)">{{ statusLabel(s.statusId) }}</span></td>
                  <td>
                    <div class="conso">
                      <span class="conso-txt">{{ fmtBytes(s.monthlyDataVolumeBytes) }} / {{ fmtLimit(s.monthlyDataLimitBytes) }}</span>
                      @if (pct(s) > 0) { <div class="conso-bar"><span [style.width.%]="pct(s)" [class.hot]="pct(s) >= 90"></span></div> }
                    </div>
                  </td>
                  <td class="dim">{{ s.tracker?.vehicleFleet?.name || s.fleet?.name || '—' }}</td>
                  <td class="dim">
                    @if (s.tracker) { <span class="mono">{{ s.tracker.imei }}</span>@if (s.tracker.vehiclePlate) { <span class="plate"> · {{ s.tracker.vehiclePlate }}</span> } @if (s.tracker.vehicleGroup) { <app-group-badge [group]="s.tracker.vehicleGroup" /> } }
                    @else { — }
                  </td>
                  <td class="ta-r" (click)="$event.stopPropagation()">
                    @if (s.tracker) {
                      <button class="lnk amber" (click)="unassign(s)"><lucide-icon [img]="UnlinkIcon" [size]="13"></lucide-icon> Détacher</button>
                    } @else {
                      <button class="lnk green" (click)="startAssign(s)"><lucide-icon [img]="LinkIcon" [size]="13"></lucide-icon> Assigner</button>
                    }
                    <button class="lnk" (click)="openDetail(s)">Détail</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="sp-empty">
          <div class="sp-empty-ico"><lucide-icon [img]="CreditCardIcon" [size]="30"></lucide-icon></div>
          <p>{{ sims().length === 0 ? 'Aucune SIM en cache. Lance une synchronisation pour importer le parc WhereverSIM.' : 'Aucune SIM ne correspond aux filtres.' }}</p>
          @if (sims().length === 0) { <button class="sp-empty-cta" (click)="doSync()">Synchroniser le parc</button> }
        </div>
      }
    </div>

    <!-- ===== Create modal ===== -->
    @if (showCreate()) {
      <div class="ov" (click)="closeCreate()">
        <div class="ov-panel" (click)="$event.stopPropagation()">
          <div class="ov-head"><h2>Nouvelle carte SIM</h2><button class="ov-x" (click)="closeCreate()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button></div>
          <div class="ov-body">
            @if (createError()) { <div class="ov-err">{{ createError() }}</div> }
            <label class="fl">ICCID *</label>
            <input class="fi mono" [(ngModel)]="cIccid" placeholder="8934071000000000000" maxlength="22" />
            <label class="fl">Numéro (MSISDN)</label>
            <input class="fi mono" [(ngModel)]="cMsisdn" placeholder="+33612345678" />
            <label class="fl">Label</label>
            <input class="fi" [(ngModel)]="cLabel" placeholder="M2M lot juin" maxlength="120" />
            <label class="fl">Flotte (optionnel)</label>
            <select class="fi" [(ngModel)]="cFleetId">
              <option value="">— Stock central —</option>
              @for (f of fleets(); track f.id) { <option [value]="f.id">{{ f.name }}</option> }
            </select>
          </div>
          <div class="ov-foot">
            <button class="btn-ghost" (click)="closeCreate()">Annuler</button>
            <button class="btn-primary" [disabled]="creating() || !cIccid.trim()" (click)="create()">
              @if (creating()) { <app-spinner [size]="14" /> } Créer
            </button>
          </div>
        </div>
      </div>
    }

    <!-- ===== Bulk modal ===== -->
    @if (showBulk()) {
      <div class="ov" (click)="closeBulk()">
        <div class="ov-panel" (click)="$event.stopPropagation()">
          <div class="ov-head"><h2>Importer un lot de SIM</h2><button class="ov-x" (click)="closeBulk()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button></div>
          <div class="ov-body">
            <p class="hint">Une SIM par ligne : <code>ICCID [numéro] [label]</code> (séparés par espace, virgule ou tab). Colle depuis un tableur.</p>
            <textarea class="fi mono ta" [(ngModel)]="bulkRaw" rows="8" placeholder="8934071000000000001 +33600000001 Lot A&#10;8934071000000000002"></textarea>
            @if (bulkResult(); as r) {
              <div class="bulk-res">
                <span class="ok">{{ r.created.length }} créée(s)</span>
                @if (r.skipped.length) { <span class="ko">{{ r.skipped.length }} ignorée(s)</span> }
                @for (sk of r.skipped.slice(0, 8); track $index) { <div class="sk">· {{ sk.iccid }} — {{ sk.reason }}</div> }
              </div>
            }
          </div>
          <div class="ov-foot">
            <button class="btn-ghost" (click)="closeBulk()">Fermer</button>
            <button class="btn-primary" [disabled]="bulking() || !bulkRaw.trim()" (click)="runBulk()">
              @if (bulking()) { <app-spinner [size]="14" /> } Importer
            </button>
          </div>
        </div>
      </div>
    }

    <!-- ===== Assign modal ===== -->
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
                  <span class="mono">{{ t.imei }}</span>
                  <span class="pick-meta">{{ t.vehiclePlate || 'libre' }}@if (t.fleetName) { · {{ t.fleetName }} }</span>
                </button>
              } @empty { <p class="hint">Aucun tracker sans SIM dans le périmètre.</p> }
            </div>
          </div>
        </div>
      </div>
    }

    <!-- ===== Detail drawer ===== -->
    @if (detail(); as sim) {
      <div class="dw" (click)="closeDetail()">
        <div class="dw-panel" (click)="$event.stopPropagation()">
          <div class="dw-head">
            <div><h2 class="mono">{{ sim.iccid }}</h2><span class="badge" [class]="badgeClass(sim.statusId)">{{ statusLabel(sim.statusId) }}</span></div>
            <button class="ov-x" (click)="closeDetail()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </div>
          <div class="dw-body">
            <!-- Infos -->
            <div class="grid2">
              <div><span class="k">Numéro</span><span class="v mono">{{ sim.msisdn || '—' }}</span></div>
              <div><span class="k">IMSI</span><span class="v mono">{{ sim.imsi || '—' }}</span></div>
              <div><span class="k">IMEI</span><span class="v mono">{{ sim.imei || '—' }}</span></div>
              <div><span class="k">APN</span><span class="v mono">{{ sim.apn || '—' }}</span></div>
              <div><span class="k">IP</span><span class="v mono">{{ sim.ipAddress || '—' }}</span></div>
              <div><span class="k">Activée le</span><span class="v">{{ fmtDate(sim.activationAt) }}</span></div>
              <div><span class="k">Tracker</span><span class="v">{{ sim.tracker ? sim.tracker.imei : '—' }}</span></div>
              <div><span class="k">Sync</span><span class="v">{{ fmtDateTime(sim.externalSyncedAt) }}</span></div>
            </div>

            <!-- Allocation -->
            <div class="sec">
              <h3><lucide-icon [img]="Building2Icon" [size]="14"></lucide-icon> Flotte</h3>
              @if (sim.tracker) {
                <p class="hint">SIM posée sur un tracker — détache-la pour changer de flotte.</p>
              } @else {
                <div class="row-inline">
                  <select class="fi" [(ngModel)]="dFleetId">
                    <option value="">— Stock central —</option>
                    @for (f of fleets(); track f.id) { <option [value]="f.id">{{ f.name }}</option> }
                  </select>
                  <button class="btn-primary sm" (click)="saveAllocation()">Allouer</button>
                </div>
              }
            </div>

            <!-- Data limit -->
            <div class="sec">
              <h3><lucide-icon [img]="GaugeIcon" [size]="14"></lucide-icon> Plafond data (Mo)</h3>
              <div class="row-inline">
                <input class="fi" type="number" min="0" [(ngModel)]="dLimitMo" placeholder="0 = illimité" />
                <button class="btn-primary sm" (click)="saveDataLimit()">Appliquer</button>
              </div>
              <p class="hint">Conso : {{ fmtBytes(sim.monthlyDataVolumeBytes) }} / {{ fmtLimit(sim.monthlyDataLimitBytes) }}</p>
            </div>

            <!-- Lifecycle -->
            <div class="sec">
              <h3><lucide-icon [img]="PowerIcon" [size]="14"></lucide-icon> Cycle de vie</h3>
              <div class="btn-row">
                @for (a of statusActions; track a.statusId) {
                  <button class="chip" [class.danger]="a.danger" [disabled]="acting()" (click)="setStatus(a.statusId)">{{ a.label }}</button>
                }
              </div>
            </div>

            <!-- Consumption -->
            <div class="sec">
              <h3><lucide-icon [img]="ActivityIcon" [size]="14"></lucide-icon> Conso 30 jours</h3>
              @if (consoLoading()) { <app-spinner [size]="14" /> }
              @else if (conso().length) {
                <div class="spark">
                  @for (p of conso(); track p.day) {
                    <span class="bar" [style.height.%]="barH(p.bytes)" [title]="p.day + ' · ' + fmtBytes(p.bytes)"></span>
                  }
                </div>
                <p class="hint">Total : {{ fmtBytes(consoTotal()) }}</p>
              } @else { <p class="hint">Aucune donnée de conso.</p> }
            </div>

            <!-- Events -->
            <div class="sec">
              <h3>Événements récents</h3>
              @if (eventsLoading()) { <app-spinner [size]="14" /> }
              @else if (events().length) {
                <ul class="evts">
                  @for (e of events(); track $index) {
                    <li><span class="evt-t">{{ fmtDateTime(e.timestamp) }}</span><span class="evt-y">{{ e.type }}</span></li>
                  }
                </ul>
              } @else { <p class="hint">Aucun événement.</p> }
            </div>

            <!-- SMS -->
            <div class="sec">
              <h3><lucide-icon [img]="SendIcon" [size]="14"></lucide-icon> Envoyer un SMS</h3>
              <div class="row-inline">
                <input class="fi" [(ngModel)]="smsText" placeholder="Texte (max 160)" maxlength="160" />
                <button class="btn-primary sm" [disabled]="sending() || !smsText.trim()" (click)="sendSms()">Envoyer</button>
              </div>
              <p class="hint">Note : l'originator doit être enregistré côté WhereverSIM.</p>
            </div>

            <!-- Danger -->
            <div class="sec">
              <button class="btn-danger" (click)="removeSim()"><lucide-icon [img]="TrashIcon" [size]="14"></lucide-icon> Supprimer du cache</button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block }
    .sp { max-width: 1100px }
    .sp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px }
    .sp-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-tertiary); text-decoration: none; margin-bottom: 6px }
    .sp-back:hover { color: var(--tracky-light) }
    .sp-head h1 { font-family: var(--font-display, Poppins, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0 }
    .sp-sub { font-size: 13px; color: var(--fg-tertiary); margin: 4px 0 0 }
    .sp-actions { display: flex; gap: 8px; flex-wrap: wrap }

    /* .btn-primary : styles globaux (styles.css) */
    .btn-primary.sm { padding: 7px 12px }
    .btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 12px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer }
    .btn-ghost:hover { color: var(--fg-primary) } .btn-ghost:disabled { opacity: .5 }
    .btn-danger { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 12px; font-weight: 600; background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.25); color: #f87171; cursor: pointer }

    .sp-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px }
    @media (max-width: 720px) { .sp-kpis { grid-template-columns: 1fr 1fr } }
    .kpi { display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px }
    .kpi-n { display: block; font-family: var(--font-display, Poppins, sans-serif); font-size: 20px; font-weight: 800; color: var(--fg-primary) }
    .kpi-l { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--fg-tertiary) }
    .i-sky { color: #38bdf8 } .i-emerald { color: var(--tracky-light) } .i-amber { color: #fbbf24 } .i-purple { color: #c084fc }

    .sp-filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px }
    .sp-search { position: relative; flex: 1; min-width: 220px; max-width: 380px; display: flex; align-items: center }
    .sp-search.mb { max-width: none; margin-bottom: 12px }
    .sp-search lucide-icon { position: absolute; left: 11px; color: var(--fg-tertiary) }
    .sp-search input { width: 100%; padding: 9px 12px 9px 32px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; color: var(--fg-primary); font-size: 13px; outline: none }
    .sp-search input:focus { border-color: var(--tracky) }
    .sp-filters select { padding: 9px 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; color: var(--fg-primary); font-size: 13px; outline: none }

    .sp-table-wrap { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 14px; overflow-x: auto }
    .sp-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 880px }
    .sp-table thead th { text-align: left; padding: 11px 14px; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--fg-tertiary); border-bottom: 1px solid var(--border-subtle) }
    .sp-table tbody td { padding: 11px 14px; border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 50%, transparent); color: var(--fg-primary) }
    .row { cursor: pointer } .row:hover td { background: color-mix(in srgb, var(--bg-tertiary) 50%, transparent) }
    .ta-r { text-align: right } .mono { font-family: var(--font-mono, monospace); font-size: 12px } .dim { color: var(--fg-tertiary) }
    .plate { color: var(--fg-secondary) }

    .badge { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 6px; white-space: nowrap }
    .st-active { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .st-suspended { background: rgba(245,158,11,.14); color: #fbbf24 }
    .st-pending { background: rgba(59,130,246,.12); color: #60a5fa }
    .st-inactive { background: rgba(239,68,68,.12); color: #f87171 }
    .st-unknown { background: var(--bg-tertiary); color: var(--fg-tertiary) }

    .conso { min-width: 130px } .conso-txt { font-size: 11px; color: var(--fg-secondary) }
    .conso-bar { height: 4px; border-radius: 2px; background: var(--bg-tertiary); margin-top: 4px; overflow: hidden }
    .conso-bar span { display: block; height: 100%; background: var(--tracky-light) } .conso-bar span.hot { background: #f87171 }

    .lnk { background: none; border: none; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--fg-tertiary); padding: 3px 6px; display: inline-flex; align-items: center; gap: 4px }
    .lnk:hover { color: var(--fg-primary) } .lnk.green { color: var(--tracky-light) } .lnk.amber { color: #fbbf24 }

    .sp-loading { display: flex; justify-content: center; padding: 60px 0 }
    .spin { animation: vt-spin 1s linear infinite }

    .sp-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 50px 20px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); text-align: center }
    .sp-empty-ico { width: 58px; height: 58px; border-radius: 16px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center }
    .sp-empty-cta { font-size: 13px; color: var(--tracky-light); background: none; border: none; cursor: pointer; text-decoration: underline }

    /* overlay modals */
    .ov { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); backdrop-filter: blur(4px); padding: 16px }
    .ov-panel { width: 100%; max-width: 460px; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; max-height: 90vh; max-height: 90dvh }
    .ov-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-subtle) }
    .ov-head h2 { font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    .ov-x { padding: 6px; border-radius: 8px; background: none; border: none; color: var(--fg-tertiary); cursor: pointer } .ov-x:hover { color: var(--fg-primary); background: var(--bg-tertiary) }
    .ov-body { padding: 18px 20px; overflow-y: auto }
    .ov-err { padding: 10px 12px; border-radius: 10px; background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.2); color: #f87171; font-size: 12px; margin-bottom: 12px }
    .ov-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border-subtle) }
    .fl { display: block; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); margin: 12px 0 4px } .fl:first-child { margin-top: 0 }
    .fi { width: 100%; padding: 9px 12px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); border-radius: 10px; color: var(--fg-primary); font-size: 13px; outline: none }
    .fi:focus { border-color: var(--tracky) } .ta { resize: vertical; line-height: 1.5 }
    .hint { font-size: 11px; color: var(--fg-tertiary); margin: 6px 0 0; line-height: 1.45 } .hint code { background: var(--bg-tertiary); padding: 1px 5px; border-radius: 4px }
    .bulk-res { margin-top: 12px; font-size: 12px } .bulk-res .ok { color: var(--tracky-light); font-weight: 700; margin-right: 10px } .bulk-res .ko { color: #fbbf24; font-weight: 700 }
    .bulk-res .sk { color: var(--fg-tertiary); margin-top: 3px }

    .picker { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px }
    .pick { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 9px 12px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); cursor: pointer; text-align: left }
    .pick:hover { border-color: var(--tracky) } .pick-meta { font-size: 11px; color: var(--fg-tertiary) }

    /* drawer */
    .dw { position: fixed; inset: 0; z-index: 9000; display: flex; justify-content: flex-end; background: rgba(0,0,0,.5); backdrop-filter: blur(4px) }
    .dw-panel { width: 100%; max-width: 460px; height: 100%; background: var(--bg-primary); border-left: 1px solid var(--border-subtle); display: flex; flex-direction: column; animation: slide .25s ease }
    @keyframes slide { from { transform: translateX(30px); opacity: .6 } }
    .dw-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid var(--border-subtle) }
    .dw-head h2 { font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0 0 6px }
    .dw-body { padding: 18px 20px; overflow-y: auto; flex: 1 }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; margin-bottom: 6px }
    .grid2 .k { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: var(--fg-tertiary) }
    .grid2 .v { display: block; font-size: 13px; color: var(--fg-primary); margin-top: 2px; word-break: break-all }
    .sec { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-subtle) }
    .sec h3 { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--fg-secondary); margin: 0 0 10px; text-transform: uppercase; letter-spacing: .4px }
    .row-inline { display: flex; gap: 8px; align-items: center } .row-inline .fi { flex: 1 }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap }
    .chip { padding: 7px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer }
    .chip:hover { border-color: var(--tracky); color: var(--fg-primary) } .chip:disabled { opacity: .5 }
    .chip.danger { color: #f87171; border-color: rgba(239,68,68,.25) }
    .spark { display: flex; align-items: flex-end; gap: 2px; height: 56px; padding: 4px 0 }
    .spark .bar { flex: 1; min-width: 2px; background: var(--tracky-light); border-radius: 2px 2px 0 0; min-height: 2px; opacity: .85 }
    .evts { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px }
    .evts li { display: flex; justify-content: space-between; gap: 10px; font-size: 12px }
    .evt-t { color: var(--fg-tertiary) } .evt-y { color: var(--fg-secondary); font-weight: 600 }
  `],
})
export class AdminSimsComponent implements OnInit {
  private readonly api = inject(SimsApiService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeftIcon = ArrowLeft;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly PlusIcon = Plus;
  protected readonly UploadIcon = Upload;
  protected readonly SearchIcon = Search;
  protected readonly XIcon = X;
  protected readonly LinkIcon = Link;
  protected readonly UnlinkIcon = Unlink;
  protected readonly CreditCardIcon = CreditCard;
  protected readonly ActivityIcon = Activity;
  protected readonly GaugeIcon = Gauge;
  protected readonly DatabaseIcon = Database;
  protected readonly Building2Icon = Building2;
  protected readonly PowerIcon = Power;
  protected readonly SendIcon = Send;
  protected readonly TrashIcon = Trash2;

  protected readonly statusActions = SIM_STATUS_ACTIONS;
  protected readonly fmtBytes = formatBytes;
  protected readonly fmtLimit = formatDataLimit;
  protected readonly fmtDate = formatDateFr;
  protected readonly fmtDateTime = formatDateTimeFr;
  protected readonly statusLabel = (id: number | null) => simStatusLabel(id);
  protected readonly badgeClass = (id: number | null) => simBadgeClass(id);

  readonly loading = signal(true);
  readonly sims = signal<SimDto[]>([]);
  readonly stats = signal<SimStatsDto | null>(null);
  readonly fleets = signal<FleetSummary[]>([]);
  readonly syncing = signal(false);

  search = '';
  filterStatus = '';
  filterAssigned = '';

  // create
  readonly showCreate = signal(false);
  readonly creating = signal(false);
  readonly createError = signal('');
  cIccid = ''; cMsisdn = ''; cLabel = ''; cFleetId = '';

  // bulk
  readonly showBulk = signal(false);
  readonly bulking = signal(false);
  readonly bulkResult = signal<{ created: SimDto[]; skipped: { iccid: string; reason: string }[] } | null>(null);
  bulkRaw = '';

  // assign
  readonly assigning = signal<SimDto | null>(null);
  private allTrackers = signal<{ id: string; imei: string; vehiclePlate: string | null; fleetName: string | null }[]>([]);
  trackerSearch = '';

  // detail drawer
  readonly detail = signal<SimDto | null>(null);
  readonly conso = signal<SimConsumptionPointDto[]>([]);
  readonly consoLoading = signal(false);
  readonly events = signal<SimEventDto[]>([]);
  readonly eventsLoading = signal(false);
  readonly acting = signal(false);
  readonly sending = signal(false);
  dFleetId = ''; dLimitMo: number | null = null; smsText = '';

  readonly filtered = computed(() => {
    // Filtre société global (sélecteur super-admin) : n'affiche que les SIM de la société
    // choisie. On prend la flotte du VÉHICULE porteur (fiable quand la SIM est posée) et on
    // retombe sur l'allocation. matches() = no-op pour un non-super ou sans société choisie.
    let list = this.sims().filter((s) => this.fleetFilter.matches(s.tracker?.vehicleFleet?.id ?? s.fleet?.id ?? null));
    const q = this.search.toLowerCase().trim();
    if (q) {
      list = list.filter((s) =>
        s.iccid.toLowerCase().includes(q) ||
        (s.msisdn ?? '').toLowerCase().includes(q) ||
        (s.imei ?? '').toLowerCase().includes(q) ||
        (s.label ?? '').toLowerCase().includes(q));
    }
    if (this.filterStatus) list = list.filter((s) => simStatusCategory(s.statusId) === this.filterStatus);
    if (this.filterAssigned === 'assigned') list = list.filter((s) => !!s.tracker);
    else if (this.filterAssigned === 'unassigned') list = list.filter((s) => !s.tracker);
    return list;
  });

  readonly filteredTrackers = computed(() => {
    const q = this.trackerSearch.toLowerCase().trim();
    let list = this.allTrackers();
    if (q) list = list.filter((t) => t.imei.toLowerCase().includes(q) || (t.vehiclePlate ?? '').toLowerCase().includes(q));
    return list.slice(0, 60);
  });

  readonly consoTotal = computed(() => this.conso().reduce((a, p) => a + (p.bytes || 0), 0));
  private readonly consoMax = computed(() => Math.max(1, ...this.conso().map((p) => p.bytes || 0)));

  ngOnInit(): void {
    void this.reload();
    this.loadFleets();
  }

  pct(s: SimDto): number { return dataPercent(s.monthlyDataVolumeBytes, s.monthlyDataLimitBytes); }
  barH(bytes: number): number { return Math.max(3, Math.round(((bytes || 0) / this.consoMax()) * 100)); }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.sims.set(await this.api.list());
    } catch (e) { this.toast.error('Échec du chargement', this.errMsg(e)); }
    finally { this.loading.set(false); }
    // Stats (best-effort — WhereverSIM peut etre non configure).
    this.api.stats().then((s) => this.stats.set(s)).catch(() => this.stats.set(null));
  }

  private loadFleets(): void {
    this.fleetsApi.list().subscribe({ next: (f) => this.fleets.set(f), error: () => undefined });
  }

  async doSync(): Promise<void> {
    this.syncing.set(true);
    try {
      const r = await this.api.sync();
      this.toast.success('Synchronisation terminée', `${r.synced} SIM sur ${r.total}`);
      await this.reload();
    } catch (e) { this.toast.error('Sync échouée', this.errMsg(e)); }
    finally { this.syncing.set(false); }
  }

  // create
  openCreate(): void { this.showCreate.set(true); this.createError.set(''); }
  closeCreate(): void { if (!this.creating()) this.showCreate.set(false); }
  async create(): Promise<void> {
    this.creating.set(true); this.createError.set('');
    try {
      await this.api.create({ iccid: this.cIccid.trim(), msisdn: this.cMsisdn.trim() || null, label: this.cLabel.trim() || null, fleetId: this.cFleetId || null });
      this.toast.success('SIM créée');
      this.cIccid = ''; this.cMsisdn = ''; this.cLabel = ''; this.cFleetId = '';
      this.showCreate.set(false);
      await this.reload();
    } catch (e) { this.createError.set(this.errMsg(e)); }
    finally { this.creating.set(false); }
  }

  // bulk
  openBulk(): void { this.showBulk.set(true); this.bulkResult.set(null); }
  closeBulk(): void { if (!this.bulking()) this.showBulk.set(false); }
  async runBulk(): Promise<void> {
    this.bulking.set(true);
    try {
      const r = await this.api.bulkCreate(this.bulkRaw);
      this.bulkResult.set(r);
      this.toast.success('Import terminé', `${r.created.length} créée(s), ${r.skipped.length} ignorée(s)`);
      await this.reload();
    } catch (e) { this.toast.error('Import échoué', this.errMsg(e)); }
    finally { this.bulking.set(false); }
  }

  // assign
  async startAssign(sim: SimDto): Promise<void> {
    this.assigning.set(sim); this.trackerSearch = '';
    try { this.allTrackers.set(await this.api.assignableTrackers()); }
    catch (e) { this.toast.error('Chargement trackers', this.errMsg(e)); }
  }
  cancelAssign(): void { this.assigning.set(null); }
  async confirmAssign(trackerId: string): Promise<void> {
    const sim = this.assigning(); if (!sim) return;
    try {
      await this.api.assign(sim.id, trackerId);
      this.toast.success('SIM assignée');
      this.assigning.set(null);
      await this.reload();
    } catch (e) { this.toast.error('Assignation échouée', this.errMsg(e)); }
  }
  async unassign(sim: SimDto): Promise<void> {
    if (!confirm(`Détacher la SIM ${sim.iccid} de son tracker ?`)) return;
    try { await this.api.unassign(sim.id); this.toast.success('SIM détachée'); await this.reload(); }
    catch (e) { this.toast.error('Détachement échoué', this.errMsg(e)); }
  }

  // detail
  openDetail(sim: SimDto): void {
    this.detail.set(sim);
    this.dFleetId = sim.fleet?.id ?? '';
    this.dLimitMo = sim.monthlyDataLimitBytes ? Math.round(sim.monthlyDataLimitBytes / 1_000_000) : null;
    this.smsText = '';
    this.loadConso(sim.id);
    this.loadEvents(sim.id);
  }
  closeDetail(): void { this.detail.set(null); }
  private async loadConso(id: string): Promise<void> {
    this.consoLoading.set(true); this.conso.set([]);
    try { this.conso.set(await this.api.consumption(id)); } catch { /* provider off */ }
    finally { this.consoLoading.set(false); }
  }
  private async loadEvents(id: string): Promise<void> {
    this.eventsLoading.set(true); this.events.set([]);
    try { const r = await this.api.events(id); this.events.set(r.items); } catch { /* provider off */ }
    finally { this.eventsLoading.set(false); }
  }

  private async refreshDetail(updated: SimDto): Promise<void> {
    this.detail.set(updated);
    this.sims.update((list) => list.map((s) => (s.id === updated.id ? updated : s)));
  }

  async saveAllocation(): Promise<void> {
    const sim = this.detail(); if (!sim) return;
    try { await this.refreshDetail(await this.api.update(sim.id, { fleetId: this.dFleetId || null })); this.toast.success('Flotte mise à jour'); }
    catch (e) { this.toast.error('Allocation échouée', this.errMsg(e)); }
  }
  async saveDataLimit(): Promise<void> {
    const sim = this.detail(); if (!sim) return;
    const bytes = this.dLimitMo && this.dLimitMo > 0 ? Math.round(this.dLimitMo * 1_000_000) : null;
    try { await this.refreshDetail(await this.api.setDataLimit(sim.id, bytes)); this.toast.success('Plafond appliqué'); }
    catch (e) { this.toast.error('Plafond échoué', this.errMsg(e)); }
  }
  async setStatus(statusId: number): Promise<void> {
    const sim = this.detail(); if (!sim) return;
    this.acting.set(true);
    try { await this.refreshDetail(await this.api.setStatus(sim.id, statusId)); this.toast.success('Statut mis à jour'); }
    catch (e) { this.toast.error('Action échouée', this.errMsg(e)); }
    finally { this.acting.set(false); }
  }
  async sendSms(): Promise<void> {
    const sim = this.detail(); if (!sim) return;
    this.sending.set(true);
    try { await this.api.sendSms(sim.id, this.smsText.trim()); this.toast.success('SMS envoyé'); this.smsText = ''; }
    catch (e) { this.toast.error('Envoi SMS échoué', this.errMsg(e)); }
    finally { this.sending.set(false); }
  }
  async removeSim(): Promise<void> {
    const sim = this.detail(); if (!sim) return;
    if (!confirm(`Supprimer la SIM ${sim.iccid} du cache local ? (n'affecte pas l'opérateur)`)) return;
    try { await this.api.remove(sim.id); this.toast.success('SIM supprimée'); this.detail.set(null); await this.reload(); }
    catch (e) { this.toast.error('Suppression échouée', this.errMsg(e)); }
  }

  private errMsg(err: unknown): string {
    const e = err as { error?: { message?: string | string[] }; message?: string };
    const m = e?.error?.message;
    if (Array.isArray(m)) return m.join(', ');
    return m ?? e?.message ?? 'Erreur inconnue';
  }
}

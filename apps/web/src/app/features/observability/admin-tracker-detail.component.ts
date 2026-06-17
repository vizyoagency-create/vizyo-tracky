import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LucideAngularModule, ArrowLeft, Cpu, Wifi, WifiOff, Gauge, Sliders } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { isTrackerOnline } from '@vizyo/tracky-shared';
import { TrackersApiService, type TrackerDetail } from '../../core/services/trackers.service';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { CommandsPanelComponent } from '../tracker-commands/commands-panel.component';
import { relativeTime } from '../../shared/utils/relative-time';

/**
 * Page détail d'un boîtier (`/admin/trackers/:id`). Regroupe au même endroit :
 * identité + connectivité, véhicule porteur (lien + groupe), dernière position,
 * SIM, raccourcis config (fix-mode / sampling) et l'historique des commandes.
 */
@Component({
  selector: 'app-admin-tracker-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, LucideAngularModule, GroupBadgeComponent, CommandsPanelComponent],
  template: `
    <div class="p-4 sm:p-6 max-w-4xl mx-auto">
      <a routerLink="/admin/trackers" class="inline-flex items-center gap-2 text-fg-tertiary hover:text-fg-primary text-sm mb-4">
        <lucide-icon [img]="ArrowLeft" [size]="16"></lucide-icon> Trackers
      </a>

      @if (loading()) {
        <p class="text-fg-tertiary text-sm">Chargement…</p>
      } @else if (tracker(); as t) {
        <div class="flex items-center gap-3 mb-6 flex-wrap">
          <div class="w-11 h-11 rounded-xl bg-bg-secondary border border-border-subtle flex items-center justify-center text-tracky-light shrink-0">
            <lucide-icon [img]="Cpu" [size]="22"></lucide-icon>
          </div>
          <div class="min-w-0">
            <h1 class="text-xl sm:text-2xl font-display font-bold text-fg-primary font-mono truncate">{{ t.imei }}</h1>
            <p class="text-xs text-fg-tertiary">{{ t.model }}</p>
          </div>
          <span class="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold shrink-0"
                [class]="online() ? 'bg-emerald-500/15 text-emerald-400' : 'bg-gray-500/15 text-gray-400'">
            <lucide-icon [img]="online() ? Wifi : WifiOff" [size]="13"></lucide-icon>
            {{ online() ? 'En ligne' : 'Hors ligne' }}
          </span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div class="rounded-[--radius-card] bg-bg-secondary border border-border-subtle p-4">
            <h3 class="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-3">Identité</h3>
            <dl class="text-sm space-y-2">
              <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Statut (DB)</dt><dd class="text-fg-primary">{{ t.status }}</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Fil ACC</dt><dd [class]="t.accConnected ? 'text-emerald-400' : 'text-amber-400'">{{ t.accConnected ? 'Branché' : 'Non branché' }}</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Dernier signal</dt><dd class="text-fg-primary">{{ t.lastSeenAt ? relativeTime(t.lastSeenAt) : 'Jamais' }}</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Installé le</dt><dd class="text-fg-primary">{{ t.createdAt ? (t.createdAt | date:'dd/MM/yyyy') : '—' }}</dd></div>
            </dl>
          </div>

          <div class="rounded-[--radius-card] bg-bg-secondary border border-border-subtle p-4">
            <h3 class="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-3">Véhicule</h3>
            @if (t.vehicle; as v) {
              <a [routerLink]="['/vehicles', v.id]" class="text-base font-bold text-tracky-light hover:underline">{{ v.plate }}</a>
              <div class="mt-2"><app-group-badge [group]="v.group" [showEmpty]="true" /></div>
            } @else {
              <p class="text-sm text-fg-tertiary">Aucun véhicule assigné</p>
            }
          </div>

          <div class="rounded-[--radius-card] bg-bg-secondary border border-border-subtle p-4">
            <h3 class="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-3">Dernière position</h3>
            @if (t.lastPositionAt) {
              <dl class="text-sm space-y-2">
                <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Vitesse</dt><dd class="text-fg-primary">{{ (t.lastSpeedKmh ?? 0) | number:'1.0-0' }} km/h</dd></div>
                <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Contact</dt><dd [class]="t.lastIgnition ? 'text-emerald-400' : 'text-fg-tertiary'">{{ t.lastIgnition ? 'ON' : 'OFF' }}</dd></div>
                <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Coordonnées</dt><dd class="text-fg-primary font-mono text-xs">{{ (t.lastLat ?? 0) | number:'1.4-4' }}, {{ (t.lastLng ?? 0) | number:'1.4-4' }}</dd></div>
                <div class="flex justify-between gap-3"><dt class="text-fg-tertiary">Datée</dt><dd class="text-fg-primary">{{ relativeTime(t.lastPositionAt) }}</dd></div>
              </dl>
            } @else {
              <p class="text-sm text-fg-tertiary">Aucune position connue</p>
            }
          </div>

          <div class="rounded-[--radius-card] bg-bg-secondary border border-border-subtle p-4">
            <h3 class="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-3">SIM</h3>
            @if (t.simPhoneNumber) {
              <p class="text-sm font-mono text-fg-primary">{{ t.simPhoneNumber }}</p>
            } @else {
              <p class="text-sm text-fg-tertiary">Pas de numéro SIM</p>
            }
            <a routerLink="/admin/sims" class="inline-block mt-2 text-xs text-tracky-light hover:underline">Parc SIM →</a>
          </div>
        </div>

        <div class="flex gap-2 flex-wrap mb-4">
          <a [routerLink]="['/admin/trackers', t.id, 'fix-mode']" class="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-fg-secondary hover:text-fg-primary">
            <lucide-icon [img]="Gauge" [size]="14"></lucide-icon> Mode fix
          </a>
          <a [routerLink]="['/admin/trackers', t.id, 'sampling']" class="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-fg-secondary hover:text-fg-primary">
            <lucide-icon [img]="Sliders" [size]="14"></lucide-icon> Échantillonnage
          </a>
        </div>

        <div class="rounded-[--radius-card] bg-bg-secondary border border-border-subtle p-4">
          <h3 class="text-xs font-semibold text-fg-tertiary uppercase tracking-wide mb-3">Commandes</h3>
          <app-commands-panel [trackerId]="t.id" />
        </div>
      } @else {
        <p class="text-fg-tertiary text-sm">Tracker introuvable.</p>
      }
    </div>
  `,
})
export class AdminTrackerDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(TrackersApiService);

  protected readonly tracker = signal<TrackerDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly relativeTime = relativeTime;

  /** Connectivité fiable basée sur la fraîcheur du dernier signal (pas le status DB). */
  protected readonly online = computed(() => isTrackerOnline(this.tracker()?.lastSeenAt ?? null));

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Cpu = Cpu;
  protected readonly Wifi = Wifi;
  protected readonly WifiOff = WifiOff;
  protected readonly Gauge = Gauge;
  protected readonly Sliders = Sliders;

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.params['id'];
    if (!id) { this.loading.set(false); return; }
    try {
      this.tracker.set(await firstValueFrom(this.api.findOne(id)));
    } catch {
      /* 404 / accès refusé → tracker reste null */
    } finally {
      this.loading.set(false);
    }
  }
}

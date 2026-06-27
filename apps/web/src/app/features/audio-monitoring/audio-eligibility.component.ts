import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { FleetAudioEligibilityDto } from '@vizyo/tracky-shared';
import {
  AlertTriangle,
  ArrowLeft,
  Ear,
  LucideAngularModule,
  Search,
  ShieldCheck,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Sprint 4 — Écran « Audio — flottes éligibles » (super-admin / prestataire). N1 du
 * gating à deux étages. LÉGALEMENT CRITIQUE.
 *
 * Liste TOUTES les flottes. Pour chaque flotte : un toggle d'ÉLIGIBILITÉ
 * (`superAdminEnabled` → setFleetEligibility) qui autorise le client à voir/activer le
 * Mode assistance, et un badge LECTURE SEULE de l'état du consentement client
 * (`assistanceEnabled` = « Mode assistance ON/OFF par le client »). Retirer l'éligibilité
 * d'une flotte cascade « tout OFF » côté serveur (coupe toute écoute pour cette flotte).
 */
@Component({
  selector: 'app-audio-eligibility',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="ae-page">
      <a routerLink="/settings"
         class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
        <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon> Paramètres
      </a>
      <h1 class="text-2xl font-display font-bold text-fg-primary">Audio — flottes éligibles</h1>
      <p class="text-sm text-fg-tertiary mb-5">
        Autorisez les flottes au Mode assistance (écoute de cabine en cas d'accident). La flotte
        ne pourra activer le Mode assistance que si vous l'avez rendue éligible.
      </p>

      @if (loading()) {
        <div class="flex items-center justify-center h-40">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (fleets().length === 0) {
        <div class="s-card p-5 text-sm text-fg-tertiary">Aucune flotte.</div>
      } @else {
        <!-- Recherche -->
        <div class="search-box">
          <lucide-icon [img]="Search" [size]="15" class="text-fg-tertiary shrink-0"></lucide-icon>
          <input
            type="text"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
            placeholder="Rechercher une flotte…"
            class="search-input"
          />
        </div>

        <div class="s-card">
          <ul class="fleet-list">
            @for (f of filtered(); track f.fleetId) {
              <li class="fleet-row">
                <div class="fleet-main">
                  <div class="fleet-name">{{ f.fleetName }}</div>
                  <!-- Badge LECTURE SEULE : état du consentement client (N2). -->
                  <span class="client-badge" [class.on]="f.assistanceEnabled">
                    <span class="dot"></span>
                    @if (f.assistanceEnabled) {
                      Mode assistance ON par le client
                    } @else {
                      Mode assistance OFF par le client
                    }
                  </span>
                </div>

                <div class="fleet-action">
                  <span class="elig-label">{{ f.superAdminEnabled ? 'Éligible' : 'Non éligible' }}</span>
                  <button
                    type="button"
                    role="switch"
                    [attr.aria-checked]="f.superAdminEnabled"
                    [attr.aria-label]="'Éligibilité audio de ' + f.fleetName"
                    (click)="toggleEligibility(f)"
                    [disabled]="savingId() === f.fleetId"
                    class="switch"
                    [class.on]="f.superAdminEnabled"
                  >
                    <span class="knob"></span>
                  </button>
                </div>
              </li>
            }
          </ul>
        </div>

        <!-- Rappel : retirer l'éligibilité coupe tout pour la flotte. -->
        <div class="hint">
          <lucide-icon [img]="AlertTriangle" [size]="14" class="text-amber-400 shrink-0 mt-0.5"></lucide-icon>
          <span>
            Désactiver l'éligibilité d'une flotte coupe immédiatement toute écoute possible :
            le Mode assistance du client repasse à OFF et aucune cabine ne peut être écoutée.
          </span>
        </div>
      }
    </div>
  `,
  styles: [`
    .ae-page { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px }
    .s-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden }

    .search-box {
      display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 12px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    }
    .search-input {
      flex: 1; min-width: 0; background: transparent; border: none; outline: none;
      color: var(--fg-primary); font-size: 13px;
    }
    .search-input::placeholder { color: var(--fg-tertiary) }

    .fleet-list { list-style: none; margin: 0; padding: 0 }
    .fleet-row {
      display: flex; align-items: center; justify-content: space-between; gap: 14px;
      padding: 14px 18px; border-bottom: 1px solid var(--border-subtle);
    }
    .fleet-row:last-child { border-bottom: none }
    .fleet-main { min-width: 0; display: flex; flex-direction: column; gap: 6px }
    .fleet-name { font-size: 14px; font-weight: 600; color: var(--fg-primary); line-height: 1.2 }

    .client-badge {
      display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
      padding: 3px 9px; border-radius: 20px; background: var(--bg-tertiary); color: var(--fg-tertiary);
    }
    .client-badge.on { background: rgba(16,224,160,.15); color: var(--tracky-light) }
    .client-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .8 }

    .fleet-action { display: flex; align-items: center; gap: 10px; flex-shrink: 0 }
    .elig-label { font-size: 11px; font-weight: 600; color: var(--fg-tertiary); white-space: nowrap }

    .switch {
      position: relative; flex-shrink: 0; width: 46px; height: 26px; border-radius: 9999px; border: none; cursor: pointer;
      background: var(--bg-tertiary); transition: background .2s;
    }
    .switch.on { background: var(--tracky) }
    .switch:disabled { opacity: .45; cursor: not-allowed }
    .knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: white; transition: left .2s }
    .switch.on .knob { left: 23px }

    .hint {
      display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--fg-secondary);
      line-height: 1.5; padding: 12px 14px; border-radius: 12px;
      background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.16);
    }
  `],
})
export class AudioEligibilityComponent implements OnInit {
  private readonly audio = inject(AudioMonitoringService);
  private readonly toast = inject(ToastService);

  protected readonly fleets = signal<FleetAudioEligibilityDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly savingId = signal<string | null>(null);
  protected readonly query = signal('');

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Ear = Ear;
  protected readonly Search = Search;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly AlertTriangle = AlertTriangle;

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.fleets();
    return this.fleets().filter((f) => f.fleetName.toLowerCase().includes(q));
  });

  async ngOnInit(): Promise<void> {
    try {
      const list = await firstValueFrom(this.audio.getFleetsWithAudio());
      this.fleets.set(list);
    } catch {
      this.toast.error('Chargement impossible', 'Impossible de lire les flottes éligibles.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async toggleEligibility(fleet: FleetAudioEligibilityDto): Promise<void> {
    if (this.savingId()) return;
    const next = !fleet.superAdminEnabled;
    this.savingId.set(fleet.fleetId);
    try {
      const cfg = await firstValueFrom(this.audio.setFleetEligibility(fleet.fleetId, next));
      // Le serveur cascade « tout OFF » quand on retire l'éligibilité : on reflète les
      // DEUX étages renvoyés (superAdminEnabled + assistanceEnabled remis à false).
      this.fleets.update((list) =>
        list.map((f) =>
          f.fleetId === fleet.fleetId
            ? {
                ...f,
                superAdminEnabled: cfg.superAdminEnabled,
                assistanceEnabled: cfg.assistanceEnabled,
              }
            : f,
        ),
      );
      if (next) {
        this.toast.success('Flotte éligible', `« ${fleet.fleetName} » peut désormais activer le Mode assistance.`);
      } else {
        this.toast.success('Éligibilité retirée', `Toute écoute est coupée pour « ${fleet.fleetName} ».`);
      }
    } catch {
      this.toast.error('Opération refusée', "L'éligibilité n'a pas pu être modifiée.");
    } finally {
      this.savingId.set(null);
    }
  }
}

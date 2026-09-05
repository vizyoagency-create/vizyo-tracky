import { swallow } from '../../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { apiErrorMessage } from '../../../core/error/api-error';
import { LucideAngularModule, Sparkles, X, Check, MapPin, Inbox, Loader } from 'lucide-angular';
import type { AgendaAgentProposalDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaAgentApiService } from '../../../core/services/agenda-agent.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';

/**
 * Refonte agenda/IA (2026-07, P3.4) — Revue des propositions de l'agent nocturne.
 * Liste les suggestions récurrentes en attente (« le 731, lundi 8h → Carcassonne ») avec le POURQUOI
 * vulgarisé, et permet de valider (→ réservation) ou refuser. Société = sélecteur global.
 *
 * Avis de l'IA (design/C3 point 7, 2026-09-05) : une proposition naît avec une phrase mécanique et
 * l'IA la relit APRÈS coup, depuis le poste. Une carte AFFICHE l'avis quand il est rendu, et ne dit
 * RIEN sinon. ⚠️ Elle n'annonce pas « en attente » : les propositions créées avant la bascule — 339
 * encore vivantes le 05/09 — n'ont jamais été soumises et n'auront jamais d'avis ; promettre à leur
 * sujet un avis qui ne viendra pas ferait passer un stock ancien pour une chaîne en panne.
 * Les propositions que l'IA a écartées sont passées en `dismissed` : elles ne sont pas listées ici.
 */
@Component({
  selector: 'app-agenda-agent-proposals-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, LucideAngularModule, BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Propositions de l'agenda" (closed)="closed.emit()">
      <div class="ap">
        <div class="ap-head">
          <h3 class="ap-title"><lucide-icon [img]="SparklesIcon" [size]="15"></lucide-icon> Propositions de l'agent</h3>
          <button type="button" class="ap-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        @if (needsFleet()) {
          <div class="ap-note">Choisis une société dans le sélecteur en haut de page.</div>
        } @else if (loading()) {
          <div class="ap-skel"></div><div class="ap-skel"></div>
        } @else if (items().length === 0) {
          <div class="ap-empty"><lucide-icon [img]="InboxIcon" [size]="36" class="ap-empty-ic"></lucide-icon><p>Aucune proposition en attente. L'agent analyse les trajets récurrents chaque nuit.</p></div>
        } @else {
          <div class="ap-body">
            @for (p of items(); track p.id) {
              <article class="ap-card">
                <div class="ap-card-top">
                  <span class="ap-plate">{{ p.vehiclePlate || '—' }}</span>
                  <span class="ap-conf" [class.ap-conf--hi]="p.confidence >= 0.7">{{ p.confidence * 100 | number:'1.0-0' }}%</span>
                </div>
                <p class="ap-when">
                  {{ p.startAt | date:'EEEE d MMM · HH:mm' }} → {{ p.endAt | date:'HH:mm' }}
                  @if (p.destinationLabel) { <span class="ap-dest"><lucide-icon [img]="MapPinIcon" [size]="12"></lucide-icon> {{ p.destinationLabel }}</span> }
                </p>
                <p class="ap-why">{{ p.reasoning }}</p>
                <!-- Une proposition écartée par l'IA n'est plus listée (dismissed) : un avis
                     rendu ici est donc « conservée » ; le repli « écartée » ne sert qu'à ne
                     jamais afficher un faux « conservée » si un statut inattendu arrivait. -->
                @if (p.aiVerdictAt) {
                  <p class="ap-ia ap-ia--rendu">Avis IA du {{ p.aiVerdictAt | date:'dd/MM HH:mm' }} : {{ p.aiKeep === false ? 'écartée' : 'conservée' }}</p>
                }
                @if (canManage()) {
                  <div class="ap-actions">
                    <button type="button" class="ap-btn ap-btn--ok" [disabled]="busyId() === p.id" (click)="apply(p)"><lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> Réserver</button>
                    <button type="button" class="ap-btn ap-btn--no" [disabled]="busyId() === p.id" (click)="dismiss(p)">Refuser</button>
                  </div>
                }
              </article>
            }
          </div>
        }
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .ap { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .ap-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .ap-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .ap-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .ap-x:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .ap-note { margin: 12px 2px; padding: 12px; border-radius: 12px; background: rgba(56,189,248,.10); color: #38BDF8; font-size: 12.5px; }
    .ap-skel { height: 84px; border-radius: 12px; margin: 10px 2px; background: linear-gradient(90deg, var(--bg-tertiary), var(--bg-secondary), var(--bg-tertiary)); }
    .ap-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 30px 12px; color: var(--fg-tertiary); text-align: center; }
    .ap-empty-ic { opacity: .5; }
    .ap-body { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; max-height: 64dvh; padding: 10px 2px 2px; }
    .ap-card { border: 1px solid var(--border-subtle); border-radius: 12px; padding: 12px; background: var(--bg-tertiary); }
    .ap-card-top { display: flex; align-items: center; justify-content: space-between; }
    .ap-plate { font-size: 13px; font-weight: 800; color: var(--fg-primary); }
    .ap-conf { font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--bg-secondary); color: var(--fg-tertiary); }
    .ap-conf--hi { background: rgba(16,224,160,.16); color: var(--tracky-light); }
    .ap-when { font-size: 12.5px; color: var(--fg-secondary); margin-top: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; text-transform: capitalize; }
    .ap-dest { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; color: var(--tracky-light); text-transform: none; }
    .ap-why { font-size: 11.5px; color: var(--fg-tertiary); margin-top: 6px; line-height: 1.45; }
    .ap-ia { font-size: 10.5px; color: var(--fg-tertiary); margin-top: 6px; font-style: italic; }
    .ap-ia--rendu { color: var(--texte-succes); font-style: normal; font-weight: 600; }
    .ap-actions { display: flex; gap: 8px; margin-top: 10px; }
    .ap-btn { display: inline-flex; align-items: center; gap: 5px; padding: 8px 12px; border-radius: 9px; font-size: 12.5px; font-weight: 700; }
    .ap-btn--ok { background: rgba(16,224,160,.12); color: var(--tracky-light); border: 1px solid rgba(16,224,160,.25); }
    .ap-btn--no { background: var(--bg-secondary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .ap-btn:disabled { opacity: .5; }
  `],
})
export class AgendaAgentProposalsSheetComponent {
  private readonly agentApi = inject(AgendaAgentApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  readonly open = input(false);
  readonly closed = output<void>();
  /** Émis quand une proposition est validée/refusée (le parent rafraîchit agenda + compteur). */
  readonly changed = output<void>();

  protected readonly SparklesIcon = Sparkles;
  protected readonly XIcon = X;
  protected readonly CheckIcon = Check;
  protected readonly MapPinIcon = MapPin;
  protected readonly InboxIcon = Inbox;
  protected readonly LoaderIcon = Loader;

  protected readonly loading = signal(false);
  protected readonly items = signal<AgendaAgentProposalDto[]>([]);
  protected readonly busyId = signal<string | null>(null);

  protected readonly canManage = computed(() => this.perms.can('reservations_manage'));
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.fleetFilter.selectedFleetId());

  constructor() {
    effect(() => {
      if (!this.open() || this.needsFleet()) return;
      void this.load();
    });
  }

  private currentFleetId(): string | undefined {
    return this.fleetFilter.selectedFleetId() ?? undefined;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.items.set(await firstValueFrom(this.agentApi.listProposals(this.currentFleetId())));
    } catch (err) {
      swallow('agenda-agent-proposals-sheet:load', err);
      this.items.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  protected async apply(p: AgendaAgentProposalDto): Promise<void> {
    this.busyId.set(p.id);
    try {
      await firstValueFrom(this.agentApi.applyProposal(p.id));
      this.items.update((list) => list.filter((x) => x.id !== p.id));
      this.toast.success('Réservé', 'La réservation est placée dans l\'agenda.');
      this.changed.emit();
    } catch (e) {
      swallow('agenda-agent-proposals-sheet:apply', e);
      this.toast.error('Échec', apiErrorMessage(e, 'Action impossible.'));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async dismiss(p: AgendaAgentProposalDto): Promise<void> {
    this.busyId.set(p.id);
    try {
      await firstValueFrom(this.agentApi.dismissProposal(p.id));
      this.items.update((list) => list.filter((x) => x.id !== p.id));
      this.toast.success('Proposition refusée');
      this.changed.emit();
    } catch (e) {
      swallow('agenda-agent-proposals-sheet:dismiss', e);
      this.toast.error('Échec', apiErrorMessage(e, 'Action impossible.'));
    } finally {
      this.busyId.set(null);
    }
  }
}

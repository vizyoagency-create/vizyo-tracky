import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule, MapPin, ChevronLeft, Loader, Play, Save, Info, Gauge, History, FlaskConical, ShieldCheck,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  FleetPlacesApiService,
  type PlaceAutomationRunDto,
  type PlaceAutomationSettingsDto,
  type PlaceAutomationStatsDto,
} from '../../core/services/fleet-places.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorMessage } from '../../core/error/api-error';

/** Motifs d'arrêt d'un run, en clair. */
const STOP_LABELS: Record<string, string> = {
  completed: 'Terminé',
  max_analyses: 'Plafond de nombre atteint',
  max_cost: 'Plafond de dépense atteint',
  month_budget: 'Budget mensuel atteint',
  too_many_failures: 'Interrompu — échecs en série',
  already_running: 'Un passage était déjà en cours',
  error: 'Erreur',
};

/**
 * Espace SUPER-ADMIN — automatisation des analyses de lieux.
 *
 * Cette page pilote une dépense récurrente : elle est donc construite pour répondre d'abord à
 * « combien ça va me coûter » (bouton SIMULER, qui chiffre sans rien dépenser) et ensuite à
 * « combien ça m'a coûté et pourquoi » (historique détaillant les sauts par motif).
 */
@Component({
  selector: 'app-place-automation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, LucideAngularModule],
  template: `
    <div class="pa">
      <a routerLink="/admin/background-tasks" class="pa-back">
        <lucide-icon [img]="BackIcon" [size]="16"></lucide-icon> Automatisations
      </a>

      <div class="pa-head">
        <div class="pa-ico"><lucide-icon [img]="PinIcon" [size]="24"></lucide-icon></div>
        <div>
          <h1>Analyses de lieux automatiques</h1>
          <p>Les fiches de vos lieux clés se mettent à jour toutes seules — sous plafonds.</p>
        </div>
        @if (settings(); as s) {
          <span class="pa-state" [class.on]="s.enabled">
            <span class="pa-dot"></span>{{ s.enabled ? 'Active' : 'En pause' }}
          </span>
        }
      </div>

      <!-- Ce qui protège la facture : le point le plus important de la page. -->
      <section class="pa-card pa-explain">
        <div class="pa-card-h"><lucide-icon [img]="ShieldIcon" [size]="15"></lucide-icon> Ce qui protège la facture</div>
        <ol class="pa-steps">
          <li><span class="pa-step-n">1</span><div><strong>Sociétés sans IA écartées</strong> — une société qui n'a pas l'option n'est jamais analysée.</div></li>
          <li><span class="pa-step-n">2</span><div><strong>Budget mensuel</strong> — s'il est défini et déjà consommé, le passage est annulé avant le moindre appel.</div></li>
          <li><span class="pa-step-n">3</span><div><strong>Un lieu au plus tous les {{ draft()?.minIntervalDays ?? 30 }} jours</strong> — c'est la borne principale : un lieu ne peut pas coûter plus souvent que ça.</div></li>
          <li><span class="pa-step-n">4</span><div><strong>Faits inchangés = pas d'analyse</strong> — vérifier est gratuit (OpenStreetMap + vos données) ; on ne repaie pas pour un texte identique.</div></li>
          <li><span class="pa-step-n">5</span><div><strong>Deux plafonds par passage</strong> — un nombre maximum d'analyses ET un montant maximum en euros.</div></li>
        </ol>
      </section>

      @if (loading()) {
        <div class="pa-loading"><lucide-icon [img]="LoaderIcon" [size]="22" class="spin"></lucide-icon></div>
      } @else if (draft(); as d) {
        <section class="pa-card">
          <div class="pa-card-h"><lucide-icon [img]="GaugeIcon" [size]="15"></lucide-icon> Réglages</div>

          <label class="pa-row pa-toggle">
            <div>
              <span class="pa-row-t">Activer l'automatisation</span>
              <span class="pa-row-d">En pause, <strong>aucun passage automatique</strong> n'a lieu. Le bouton « Lancer maintenant » ci-dessous reste utilisable — c'est un déclenchement volontaire, et il dépense.</span>
            </div>
            <input type="checkbox" [checked]="d.enabled" (change)="patch('enabled', $any($event.target).checked)">
          </label>

          <div class="pa-row">
            <div>
              <span class="pa-row-t">Heure du passage quotidien</span>
              <span class="pa-row-d">Heure de Paris. Une fois par jour au maximum — les lieux ne changent pas d'une heure à l'autre.</span>
            </div>
            <input class="pa-num" type="number" min="0" max="23" [value]="d.hour"
                   (change)="patch('hour', +$any($event.target).value)">
          </div>

          <div class="pa-row">
            <div>
              <span class="pa-row-t">Délai minimum entre deux analyses d'un même lieu</span>
              <span class="pa-row-d">En jours. C'est le garde-fou le plus efficace : il borne la dépense quoi qu'il arrive.</span>
            </div>
            <input class="pa-num" type="number" min="1" max="365" [value]="d.minIntervalDays"
                   (change)="patch('minIntervalDays', +$any($event.target).value)">
          </div>

          <label class="pa-row pa-toggle">
            <div>
              <span class="pa-row-t">Ignorer les lieux dont rien n'a changé</span>
              <span class="pa-row-d">Recommandé. Sans ça, on repaie une analyse pour obtenir exactement le même texte.</span>
            </div>
            <input type="checkbox" [checked]="d.skipUnchanged" (change)="patch('skipUnchanged', $any($event.target).checked)">
          </label>

          <div class="pa-row">
            <div>
              <span class="pa-row-t">Maximum d'analyses par passage</span>
              <span class="pa-row-d">Plafond dur. Le reste attendra le passage suivant.</span>
            </div>
            <input class="pa-num" type="number" min="1" max="200" [value]="d.maxAnalysesPerRun"
                   (change)="patch('maxAnalysesPerRun', +$any($event.target).value)">
          </div>

          <div class="pa-row">
            <div>
              <span class="pa-row-t">Dépense maximale par passage (€)</span>
              <span class="pa-row-d">Second plafond, en argent. Le passage s'arrête dès qu'il est atteint.</span>
            </div>
            <input class="pa-num" type="number" min="0.01" max="5" step="0.05" [value]="d.maxCostEurPerRun"
                   (change)="patch('maxCostEurPerRun', +$any($event.target).value)">
          </div>

          <!-- Le chiffre qui compte vraiment : ce réglage s'applique CHAQUE JOUR. -->
          <div class="pa-worst">
            <lucide-icon [img]="ShieldIcon" [size]="14"></lucide-icon>
            <div>
              Au pire, cette configuration coûte <b>{{ worstCaseMonthly() | number: '1.2-2' }} € par mois</b>
              ({{ d.maxCostEurPerRun | number: '1.2-2' }} € × 30 passages quotidiens) — et seulement si
              chaque passage sature son plafond, ce qui n'arrive pas en régime normal.
              @if (budgetHint()) { <span class="pa-worst-b">{{ budgetHint() }}</span> }
            </div>
          </div>

          <div class="pa-actions">
            <button class="pa-btn pa-btn--primary" [disabled]="saving()" (click)="save()">
              <lucide-icon [img]="SaveIcon" [size]="15"></lucide-icon>
              {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
            <button class="pa-btn pa-btn--sim" [disabled]="busy()" (click)="simulate()">
              <lucide-icon [img]="FlaskIcon" [size]="15"></lucide-icon>
              {{ simulating() ? 'Simulation…' : 'Simuler (gratuit)' }}
            </button>
            <button class="pa-btn pa-btn--run" [disabled]="busy()" (click)="runNow()">
              <lucide-icon [img]="PlayIcon" [size]="15"></lucide-icon>
              {{ running() ? 'En cours…' : 'Lancer maintenant' }}
            </button>
          </div>
          <p class="pa-hint">
            <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
            « Simuler » évalue exactement le même parcours mais n'envoie aucune requête à l'IA :
            aucun euro n'est dépensé. « Lancer maintenant » dépense réellement.
          </p>
        </section>

        <!-- Résultat du dernier lancement déclenché depuis cette page -->
        @if (lastStats(); as st) {
          <section class="pa-card" [class.pa-sim]="st.dryRun">
            <div class="pa-card-h">
              <lucide-icon [img]="st.dryRun ? FlaskIcon : PlayIcon" [size]="15"></lucide-icon>
              {{ st.dryRun ? 'Simulation — rien n\\'a été dépensé' : 'Dernier lancement' }}
            </div>
            <div class="pa-stats">
              <div class="pa-stat"><b>{{ st.analyzed }}</b><span>{{ st.dryRun ? 'seraient analysés' : 'analysés' }}</span></div>
              <div class="pa-stat pa-stat--cost"><b>{{ st.costEur | number: '1.2-4' }} €</b><span>{{ st.dryRun ? 'coût estimé' : 'coût réel' }}</span></div>
              <div class="pa-stat"><b>{{ st.skippedUnchanged }}</b><span>inchangés</span></div>
              <div class="pa-stat"><b>{{ st.skippedCooldown }}</b><span>trop récents</span></div>
              <div class="pa-stat"><b>{{ st.skippedAiOff }}</b><span>société sans IA</span></div>
              @if (st.failed > 0) { <div class="pa-stat pa-stat--bad"><b>{{ st.failed }}</b><span>en échec</span></div> }
            </div>
            <p class="pa-stop">Arrêt : <b>{{ stopLabel(st.stopReason) }}</b></p>
          </section>
        }

        <!-- Historique -->
        <section class="pa-card">
          <div class="pa-card-h"><lucide-icon [img]="HistoryIcon" [size]="15"></lucide-icon> Historique des passages</div>
          @if (runs().length === 0) {
            <p class="pa-empty">Aucun passage pour l'instant.</p>
          } @else {
            <div class="pa-table-wrap">
              <table class="pa-table">
                <thead>
                  <tr><th>Quand</th><th>Type</th><th>Analysés</th><th>Sautés</th><th>Échecs</th><th>Coût</th><th>Arrêt</th></tr>
                </thead>
                <tbody>
                  @for (r of runs(); track r.id) {
                    <tr [class.pa-row-sim]="r.origin === 'dry-run'">
                      <td>{{ r.startedAt | date: 'dd/MM HH:mm' }}</td>
                      <td>{{ originLabel(r.origin) }}</td>
                      <td>{{ r.analyzed }}</td>
                      <td [title]="'inchangés ' + r.skippedUnchanged + ' · trop récents ' + r.skippedCooldown + ' · sans IA ' + r.skippedAiOff">
                        {{ r.skippedUnchanged + r.skippedCooldown + r.skippedAiOff }}
                      </td>
                      <td [class.pa-bad]="r.failed > 0">{{ r.failed }}</td>
                      <td>{{ r.costEur | number: '1.2-4' }} €</td>
                      <td>{{ stopLabel(r.stopReason) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pa { max-width: 820px; }
    .pa-back { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); text-decoration: none; margin-bottom: 18px; }
    .pa-back:hover { color: var(--fg-secondary); }
    .pa-head { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
    .pa-ico { width: 48px; height: 48px; border-radius: 13px; display: flex; align-items: center; justify-content: center; background: rgba(139,92,246,.12); color: #a78bfa; flex-shrink: 0; }
    .pa-head h1 { font-family: var(--font-display, Poppins, sans-serif); font-size: 24px; font-weight: 800; letter-spacing: -.4px; color: var(--fg-primary); margin: 0; }
    .pa-head p { color: var(--fg-tertiary); font-size: 13px; margin: 3px 0 0; }
    .pa-state { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; background: var(--bg-tertiary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
    .pa-state.on { background: rgba(16,224,160,.08); color: var(--tracky-light); border-color: rgba(16,224,160,.18); }
    .pa-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }

    .pa-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 20px 22px; margin-bottom: 16px; }
    .pa-card-h { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; color: var(--fg-tertiary); margin-bottom: 14px; }
    .pa-explain { background: color-mix(in srgb, var(--tracky-light) 6%, var(--bg-secondary)); border-color: color-mix(in srgb, var(--tracky-light) 20%, transparent); }
    .pa-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 11px; }
    .pa-steps li { display: flex; align-items: flex-start; gap: 12px; font-size: 13px; line-height: 1.5; color: var(--fg-secondary); }
    .pa-step-n { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: color-mix(in srgb, var(--tracky-light) 16%, transparent); color: var(--tracky-light); font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
    .pa-steps strong { color: var(--fg-primary); }

    .pa-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-top: 1px solid var(--border-subtle); }
    .pa-row:first-of-type { border-top: none; }
    .pa-toggle { cursor: pointer; }
    .pa-row-t { display: block; font-size: 13.5px; font-weight: 700; color: var(--fg-primary); }
    .pa-row-d { display: block; font-size: 11.5px; color: var(--fg-tertiary); margin-top: 2px; max-width: 470px; line-height: 1.45; }
    .pa-row input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--tracky, #10E0A0); cursor: pointer; flex-shrink: 0; }
    .pa-num { width: 92px; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--border-strong, var(--border-subtle)); background: var(--bg-tertiary); color: var(--fg-primary); font-size: 13px; font-weight: 700; text-align: center; }

    .pa-actions { display: flex; align-items: center; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    .pa-btn { display: inline-flex; align-items: center; gap: 7px; padding: 10px 16px; border-radius: 10px; font-size: 13px; font-weight: 800; cursor: pointer; border: none; }
    .pa-btn:disabled { opacity: .55; cursor: default; }
    .pa-btn--primary { background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); }
    .pa-btn--sim { background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-strong); }
    .pa-btn--run { background: transparent; color: #a78bfa; border: 1px solid color-mix(in srgb, #a78bfa 40%, transparent); }
    .pa-hint { display: flex; align-items: flex-start; gap: 6px; margin: 12px 0 0; font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; }
    .pa-worst { display: flex; align-items: flex-start; gap: 9px; margin-top: 14px; padding: 11px 13px; border-radius: 11px; background: color-mix(in srgb, var(--tracky-light) 8%, transparent); border: 1px solid color-mix(in srgb, var(--tracky-light) 20%, transparent); font-size: 12px; line-height: 1.5; color: var(--fg-secondary); }
    .pa-worst b { color: var(--fg-primary); }
    .pa-worst-b { display: block; margin-top: 4px; color: var(--fg-tertiary); font-size: 11.5px; }

    .pa-sim { border-style: dashed; }
    .pa-stats { display: flex; flex-wrap: wrap; gap: 10px; }
    .pa-stat { flex: 1 1 110px; background: var(--bg-tertiary); border-radius: 11px; padding: 11px 13px; }
    .pa-stat b { display: block; font-size: 19px; font-weight: 800; color: var(--fg-primary); }
    .pa-stat span { font-size: 11px; color: var(--fg-tertiary); }
    .pa-stat--cost b { color: var(--tracky-light); }
    .pa-stat--bad b { color: var(--danger); }
    .pa-stop { margin: 12px 0 0; font-size: 12px; color: var(--fg-tertiary); }
    .pa-stop b { color: var(--fg-secondary); }

    .pa-table-wrap { overflow-x: auto; }
    .pa-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .pa-table th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; color: var(--fg-tertiary); padding: 6px 10px 6px 0; font-weight: 700; white-space: nowrap; }
    .pa-table td { padding: 9px 10px 9px 0; border-top: 1px solid var(--border-subtle); color: var(--fg-secondary); white-space: nowrap; }
    .pa-row-sim td { opacity: .65; font-style: italic; }
    .pa-bad { color: var(--danger); font-weight: 700; }
    .pa-empty { margin: 0; font-size: 12.5px; color: var(--fg-tertiary); }
    .pa-loading { display: flex; justify-content: center; padding: 40px; color: var(--fg-tertiary); }
    .spin { animation: pa-spin 1s linear infinite; }
    @keyframes pa-spin { to { transform: rotate(360deg); } }
  `],
})
export class PlaceAutomationComponent implements OnInit {
  private readonly api = inject(FleetPlacesApiService);
  private readonly toast = inject(ToastService);

  protected readonly PinIcon = MapPin;
  protected readonly BackIcon = ChevronLeft;
  protected readonly LoaderIcon = Loader;
  protected readonly PlayIcon = Play;
  protected readonly SaveIcon = Save;
  protected readonly InfoIcon = Info;
  protected readonly GaugeIcon = Gauge;
  protected readonly HistoryIcon = History;
  protected readonly FlaskIcon = FlaskConical;
  protected readonly ShieldIcon = ShieldCheck;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly running = signal(false);
  protected readonly simulating = signal(false);
  protected readonly settings = signal<PlaceAutomationSettingsDto | null>(null);
  protected readonly draft = signal<PlaceAutomationSettingsDto | null>(null);
  protected readonly runs = signal<PlaceAutomationRunDto[]>([]);
  protected readonly lastStats = signal<PlaceAutomationStatsDto | null>(null);
  /** Budget IA mensuel global — lu au chargement (non modifié par l'enregistrement des réglages). */
  protected readonly monthlyBudgetEur = signal<number | null>(null);

  /** Un seul lancement à la fois côté UI (le serveur a de toute façon son propre verrou). */
  protected busy(): boolean {
    return this.running() || this.simulating();
  }

  /**
   * Pire cas mensuel = plafond par passage × 30. C'est LE chiffre à montrer : un plafond « par
   * passage » se lit comme petit, alors qu'il s'applique tous les jours.
   */
  protected worstCaseMonthly(): number {
    return (this.draft()?.maxCostEurPerRun ?? 0) * 30;
  }

  /** Rappelle le budget mensuel global s'il est défini — c'est lui qui prime en dernier ressort. */
  protected budgetHint(): string | null {
    const b = this.monthlyBudgetEur();
    if (b == null || b <= 0) return null;
    return `Un budget IA mensuel de ${b.toFixed(2)} € est configuré : il arrête les passages une fois atteint.`;
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [settings, runs] = await Promise.all([
        firstValueFrom(this.api.automationSettings()),
        firstValueFrom(this.api.automationRuns(30)),
      ]);
      this.settings.set(settings);
      this.draft.set({ ...settings });
      this.monthlyBudgetEur.set(settings.monthlyBudgetEur ?? null);
      this.runs.set(runs);
    } catch (e) {
      swallow('place-automation:load', e);
      this.toast.error('Chargement impossible', apiErrorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected patch<K extends keyof PlaceAutomationSettingsDto>(key: K, value: PlaceAutomationSettingsDto[K]): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, [key]: value });
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d || this.saving()) return;
    this.saving.set(true);
    try {
      const saved = await firstValueFrom(
        this.api.setAutomationSettings({
          enabled: d.enabled,
          hour: d.hour,
          minIntervalDays: d.minIntervalDays,
          skipUnchanged: d.skipUnchanged,
          maxAnalysesPerRun: d.maxAnalysesPerRun,
          maxCostEurPerRun: d.maxCostEurPerRun,
        }),
      );
      // On réaffiche la valeur RENVOYÉE par le serveur : elle peut différer de la saisie
      // (les plafonds sont bornés côté serveur) et l'UI ne doit pas mentir.
      this.settings.set(saved);
      this.draft.set({ ...saved });
      this.toast.success('Réglages enregistrés');
    } catch (e) {
      swallow('place-automation:save', e);
      this.toast.error('Enregistrement impossible', apiErrorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected async simulate(): Promise<void> {
    if (this.busy()) return;
    this.simulating.set(true);
    try {
      const stats = await firstValueFrom(this.api.simulateAutomation());
      this.lastStats.set(stats);
      this.runs.set(await firstValueFrom(this.api.automationRuns(30)));
      this.toast.success('Simulation terminée', `${stats.analyzed} lieu(x) seraient analysés`);
    } catch (e) {
      swallow('place-automation:simulate', e);
      this.toast.error('Simulation impossible', apiErrorMessage(e));
    } finally {
      this.simulating.set(false);
    }
  }

  protected async runNow(): Promise<void> {
    if (this.busy()) return;
    this.running.set(true);
    try {
      const stats = await firstValueFrom(this.api.runAutomationNow());
      this.lastStats.set(stats);
      const [settings, runs] = await Promise.all([
        firstValueFrom(this.api.automationSettings()),
        firstValueFrom(this.api.automationRuns(30)),
      ]);
      this.settings.set(settings);
      this.runs.set(runs);
      if (stats.stopReason === 'already_running') {
        this.toast.info('Un passage était déjà en cours', 'Rien de nouveau n\'a été lancé.');
      } else {
        this.toast.success('Passage terminé', `${stats.analyzed} analysé(s) · ${stats.costEur.toFixed(4)} €`);
      }
    } catch (e) {
      swallow('place-automation:runNow', e);
      // Un passage peut durer plusieurs minutes : si la requête HTTP a expiré, le run CONTINUE
      // côté serveur. Ne pas laisser croire qu'il ne s'est rien passé — sinon on reclique.
      this.toast.error(
        'Réponse non reçue',
        `${apiErrorMessage(e)} — le passage peut être encore en cours côté serveur. Consultez l'historique ci-dessous avant de relancer.`,
      );
      this.runs.set(await firstValueFrom(this.api.automationRuns(30)).catch(() => this.runs()));
    } finally {
      this.running.set(false);
    }
  }

  protected stopLabel(reason: string): string {
    return STOP_LABELS[reason] ?? reason;
  }

  protected originLabel(origin: string): string {
    return origin === 'dry-run' ? 'Simulation' : origin === 'manual' ? 'Manuel' : 'Automatique';
  }
}

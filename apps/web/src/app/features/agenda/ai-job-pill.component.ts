import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { LucideAngularModule, Sparkles, Check, AlertTriangle, ArrowRight, X, Loader } from 'lucide-angular';
import { AiJobService, type AiJob } from '../../core/services/ai-job.service';

/**
 * Refonte agenda/IA — Pastille de suivi des opérations IA lancées « en arrière-plan ».
 *
 * Affichée en haut de l'agenda. Trois états, tous EXPLICITES pour un non-expert :
 *  - EN COURS  : animation « scan IA » + « L'IA travaille… » + ce qu'elle fait précisément.
 *  - PRÊT      : ✓ + résumé du résultat + bouton « Voir » (le parent ouvre les résultats).
 *  - ERREUR    : ⚠ + message lisible + fermer.
 *
 * Ne fait AUCUN appel : elle lit le `AiJobService` (signals) et émet `view`/`dismiss` au parent.
 */
@Component({
  selector: 'app-ai-job-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    @if (jobs().length > 0) {
      <div class="ajp" role="status" aria-live="polite">
        @for (j of jobs(); track j.id) {
          <div class="ajp-card"
               [class.ajp-card--run]="j.status === 'running'"
               [class.ajp-card--done]="j.status === 'done'"
               [class.ajp-card--err]="j.status === 'error'">

            <!-- Icône d'état (animée en cours) -->
            <span class="ajp-ico">
              @if (j.status === 'running') {
                <span class="ajp-scan"><lucide-icon [img]="SparklesIcon" [size]="16"></lucide-icon></span>
              } @else if (j.status === 'done') {
                <lucide-icon [img]="CheckIcon" [size]="16"></lucide-icon>
              } @else {
                <lucide-icon [img]="AlertIcon" [size]="16"></lucide-icon>
              }
            </span>

            <div class="ajp-txt">
              <div class="ajp-top">
                <span class="ajp-title">{{ j.title }}</span>
                @if (j.status === 'running') { <span class="ajp-badge">IA en cours…</span> }
                @else if (j.status === 'done') { <span class="ajp-badge ajp-badge--ok">Résultats prêts</span> }
                @else { <span class="ajp-badge ajp-badge--err">Échec</span> }
              </div>
              <p class="ajp-sub">
                @if (j.status === 'running') { {{ j.hint }} }
                @else if (j.status === 'done') { {{ j.resultText }} }
                @else { {{ j.error }} }
              </p>
              @if (j.status === 'running') {
                <div class="ajp-bar"><span class="ajp-bar-fill"></span></div>
              }
            </div>

            <div class="ajp-actions">
              @if (j.status === 'done') {
                <button type="button" class="ajp-view" (click)="view.emit(j)">
                  Voir <lucide-icon [img]="ArrowRightIcon" [size]="14"></lucide-icon>
                </button>
              }
              @if (j.status === 'running') {
                <lucide-icon [img]="LoaderIcon" [size]="15" class="ajp-spin"></lucide-icon>
              }
              <!-- Toujours effaçable, MÊME en cours : sinon une requête qui ne répond jamais (socket
                   pendu) laisse une pastille « IA en cours… » bloquée à vie. Masquer n'annule pas la
                   tâche (elle finit en arrière-plan, son résultat est simplement ignoré). -->
              <button type="button" class="ajp-x" (click)="jobSvc.dismiss(j.id)"
                      [attr.aria-label]="j.status === 'running' ? 'Masquer (l’analyse continue en arrière-plan)' : 'Fermer'">
                <lucide-icon [img]="XIcon" [size]="15"></lucide-icon>
              </button>
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .ajp { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }

    .ajp-card {
      display: flex; align-items: center; gap: 11px;
      padding: 11px 13px; border-radius: 13px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
      animation: ajp-in .22s ease;
    }
    @keyframes ajp-in { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: none; } }

    /* En cours : liseré accent + fond très légèrement teinté + « respiration ». */
    .ajp-card--run {
      border-color: color-mix(in srgb, var(--tracky-light) 45%, transparent);
      background: color-mix(in srgb, var(--tracky-light) 7%, var(--bg-secondary));
    }
    .ajp-card--done { border-color: color-mix(in srgb, var(--tracky-light) 55%, transparent); }
    .ajp-card--err { border-color: color-mix(in srgb, var(--danger, #EF4444) 45%, transparent); }

    .ajp-ico {
      flex-shrink: 0; width: 32px; height: 32px; border-radius: 9px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--bg-tertiary); color: var(--tracky-light);
    }
    .ajp-card--done .ajp-ico { background: color-mix(in srgb, var(--tracky-light) 16%, transparent); }
    .ajp-card--err .ajp-ico { color: var(--danger, #EF4444); background: color-mix(in srgb, var(--danger, #EF4444) 12%, transparent); }

    /* Animation « scan IA » : l'étincelle pulse + tourne légèrement (IA qui cherche). */
    .ajp-scan { display: inline-flex; animation: ajp-pulse 1.5s ease-in-out infinite; }
    @keyframes ajp-pulse {
      0%, 100% { transform: scale(1) rotate(0deg); opacity: .85; }
      50% { transform: scale(1.18) rotate(8deg); opacity: 1; }
    }

    .ajp-txt { flex: 1; min-width: 0; }
    .ajp-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ajp-title { font-size: 13.5px; font-weight: 700; color: var(--fg-primary); }
    .ajp-badge {
      font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
      padding: 2px 7px; border-radius: 999px;
      background: color-mix(in srgb, var(--tracky-light) 16%, transparent); color: var(--tracky-light);
    }
    .ajp-badge--ok { background: color-mix(in srgb, var(--tracky-light) 20%, transparent); }
    .ajp-badge--err { background: color-mix(in srgb, var(--danger, #EF4444) 14%, transparent); color: var(--danger, #EF4444); }
    .ajp-sub { margin: 3px 0 0; font-size: 12px; color: var(--fg-secondary); line-height: 1.4; }

    /* Barre de progression indéterminée (va-et-vient) → « quelque chose se passe ». */
    .ajp-bar { margin-top: 8px; height: 3px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; }
    .ajp-bar-fill {
      display: block; height: 100%; width: 40%; border-radius: 3px; background: var(--tracky-light);
      animation: ajp-slide 1.3s ease-in-out infinite;
    }
    @keyframes ajp-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }

    .ajp-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .ajp-view {
      display: inline-flex; align-items: center; gap: 4px; padding: 7px 12px; border-radius: 9px;
      background: var(--tracky-light); color: var(--accent-ink, #04130D); font-size: 12.5px; font-weight: 800;
    }
    .ajp-x { width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg-tertiary); }
    .ajp-x:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .ajp-spin { color: var(--tracky-light); animation: ajp-rot .9s linear infinite; }
    @keyframes ajp-rot { to { transform: rotate(360deg); } }

    :host-context([data-theme='dark']) .ajp-card { border-color: rgba(255,255,255,.12); }
  `],
})
export class AiJobPillComponent {
  protected readonly jobSvc = inject(AiJobService);
  protected readonly jobs = this.jobSvc.jobs;

  /** Émis au clic « Voir » d'un job PRÊT — le parent (agenda) ouvre les résultats selon `kind`. */
  readonly view = output<AiJob>();

  protected readonly SparklesIcon = Sparkles;
  protected readonly CheckIcon = Check;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly ArrowRightIcon = ArrowRight;
  protected readonly XIcon = X;
  protected readonly LoaderIcon = Loader;
}

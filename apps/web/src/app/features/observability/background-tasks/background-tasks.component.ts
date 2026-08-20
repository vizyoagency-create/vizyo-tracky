import { swallow } from '../../../core/error/swallow';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, computed, inject,
  type OnDestroy, type OnInit, signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AlarmClock, AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, LucideAngularModule,
  RefreshCw, ShieldAlert, Timer,
} from 'lucide-angular';
import type { BackgroundTaskDto, BgTaskCategory } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { BackgroundTasksApiService } from './background-tasks.service';

const CATEGORY_ORDER: BgTaskCategory[] = [
  'IA & rapports', 'Sécurité & moteur', 'Notifications', 'Intégration partenaire',
  'Maintenance données', 'Temps réel', 'Système & observabilité',
];

@Component({
  selector: 'app-background-tasks',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, LucideAngularModule],
  templateUrl: './background-tasks.component.html',
  styleUrl: './background-tasks.component.css',
})
export class BackgroundTasksComponent implements OnInit, OnDestroy {
  private readonly api = inject(BackgroundTasksApiService);

  protected readonly AlarmClockIcon = AlarmClock;
  protected readonly AlertTriangleIcon = AlertTriangle;
  protected readonly ArrowLeftIcon = ArrowLeft;
  protected readonly CheckIcon = CheckCircle2;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly RefreshCwIcon = RefreshCw;
  protected readonly ShieldAlertIcon = ShieldAlert;
  protected readonly TimerIcon = Timer;

  protected readonly tasks = signal<BackgroundTaskDto[]>([]);
  protected readonly health = signal<import('@vizyo/tracky-shared').BackgroundTasksHealth | null>(null);
  protected readonly serverTz = signal<string>('');
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly nowMs = signal(Date.now());
  /** Décalage horloge serveur − client, pour aligner les compte-à-rebours sur l'heure serveur. */
  protected readonly skew = signal(0);

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) { this.nowMs.set(Date.now()); void this.load(true); }
  };

  /** Tâches groupées par catégorie, dans l'ordre voulu. */
  protected readonly groups = computed(() => {
    const byCat = new Map<BgTaskCategory, BackgroundTaskDto[]>();
    for (const t of this.tasks()) {
      const arr = byCat.get(t.category) ?? [];
      arr.push(t);
      byCat.set(t.category, arr);
    }
    return CATEGORY_ORDER
      .filter((c) => byCat.has(c))
      .map((c) => ({ category: c, items: byCat.get(c)! }));
  });

  /**
   * LA CHRONOLOGIE : ce qui va tourner, du plus imminent au plus lointain.
   *
   * Le regroupement par catégorie répond à « qu'est-ce qui existe ? ». Il ne répond pas à la
   * question qu'on se pose devant un incident : « qu'est-ce qui vient de passer, et qu'est-ce
   * qui arrive dans la minute ? ». Avec quarante et un traitements répartis en sept familles,
   * reconstituer cet ordre à l'œil demandait de comparer quarante compte-à-rebours dispersés.
   *
   * Les flux continus n'y figurent pas : ils n'ont pas d'échéance, les mêler à une file
   * chronologique reviendrait à leur inventer une heure de passage.
   */
  protected readonly chronologie = computed(() => {
    return this.tasks()
      .filter((t) => !t.continuous && t.nextRunAt && !(t.configurable && t.enabled === false))
      .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime());
  });

  /** Traitements à échéance mais actuellement EN PAUSE — ils ne passeront pas, il faut le dire. */
  protected readonly enPause = computed(() =>
    this.tasks().filter((t) => t.configurable && t.enabled === false),
  );

  /** Noms des traitements en pause, pour la mention sous la chronologie. */
  protected pauseNoms(): string {
    return this.enPause().map((t) => t.label).join(', ');
  }

  /** Heure d'horloge du prochain passage, en heure de Paris (le serveur, lui, tourne en UTC). */
  protected heureParis(iso: string | null): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  }

  /** Vrai si le passage est dans moins de deux minutes — la ligne est alors mise en avant. */
  protected imminent(iso: string | null): boolean {
    if (!iso) return false;
    return new Date(iso).getTime() - (this.nowMs() + this.skew()) < 120_000;
  }
  /** Compteurs de synthèse. */
  protected readonly summary = computed(() => {
    const t = this.tasks();
    return {
      total: t.length,
      timed: t.filter((x) => !x.continuous).length,
      continuous: t.filter((x) => x.continuous).length,
      configurable: t.filter((x) => x.configurable).length,
      paused: t.filter((x) => x.configurable && x.enabled === false).length,
      // Les trois environnements d'execution, comptes separement : c'est LA question qu'on se
      // pose devant cet ecran — ou tourne ce traitement, et qui paie ?
      posteLocal: t.filter((x) => x.executor === 'poste-local').length,
      iaFacturee: t.filter((x) => x.coutIa === 'facture').length,
    };
  });

  /** La PROCHAINE automatisation IA/rapport à se lancer (pour le focus « prochain rapport »). */
  protected readonly nextAi = computed(() => {
    const cands = this.tasks().filter((t) => t.category === 'IA & rapports' && t.nextRunAt);
    if (cands.length === 0) return null;
    return cands.reduce((a, b) => (new Date(a.nextRunAt!) < new Date(b.nextRunAt!) ? a : b));
  });

  /**
   * Drift OK = rien ne tourne « en cachette ». Revue : on compare les compteurs dans les DEUX
   * sens (une tâche cataloguée mais SUPPRIMÉE du code → registered < catalog → aussi un drift) et
   * on inclut les intervalles, pas seulement les jobs enregistrés en trop.
   */
  protected readonly driftOk = computed(() => {
    const h = this.health();
    if (!h) return true;
    return (
      h.uncataloguedJobs.length === 0 &&
      h.registeredCronCount === h.catalogCronCount &&
      h.registeredIntervalCount === h.catalogIntervalCount
    );
  });

  ngOnInit(): void {
    void this.load();
    this.pollHandle = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void this.load(true);
    }, 30_000);
    this.tickHandle = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) this.nowMs.set(Date.now());
    }, 1_000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
  }

  protected async load(isRefresh = false): Promise<void> {
    if (isRefresh) this.refreshing.set(true); else this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.list());
      this.tasks.set(res.tasks);
      this.health.set(res.health);
      this.serverTz.set(res.serverTimezone);
      this.skew.set(new Date(res.serverNow).getTime() - Date.now());
      this.nowMs.set(Date.now());
      this.error.set(null);
    } catch (e) {
      swallow('background-tasks:load', e);
      this.error.set((e as { error?: { message?: string } })?.error?.message ?? 'Chargement impossible');
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  /** Compte-à-rebours vers un instant ISO, ou null. */
  protected countdown(iso: string | null): string | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - (this.nowMs() + this.skew());
    if (ms <= 0) return 'imminent';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h >= 24) { const d = Math.floor(h / 24); return `${d} j ${h % 24} h`; }
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m > 0) return `${m} min ${String(sec).padStart(2, '0')} s`;
    return `${sec} s`;
  }

  protected critClass(c: BackgroundTaskDto['criticality']): string {
    return c === 'haute' ? 'crit-high' : c === 'moyenne' ? 'crit-mid' : 'crit-low';
  }

  protected trackByTask = (_: number, t: BackgroundTaskDto): string => t.id;
  protected trackByGroup = (_: number, g: { category: string }): string => g.category;
}

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  viewChild,
} from '@angular/core';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  LinearScale,
  Tooltip,
  type ChartConfiguration,
  type TooltipItem,
} from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

export interface ErrorBucket {
  hour: string;
  error: number;
  critical: number;
}

/**
 * Bar chart empile (stacked) : erreurs par heure sur 24h.
 * 2 series : ERROR (orange) + CRITICAL (rose).
 * Mobile-first : hauteur 180px par defaut.
 */
@Component({
  selector: 'app-error-timeline-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- ⚠️ role="figure" et NON role="img" : « img » porte
         « children presentational: true » et referme le conteneur sur un seul nom. Le
         défaut était pire ici que sur les deux autres graphiques — il n'y avait AUCUNE
         alternative textuelle derrière : un lecteur d'écran n'apprenait rien de plus
         que « erreurs par heure ». Le tableau ci-dessous répare cela. -->
    <div class="etc-wrapper" role="figure" [attr.aria-label]="ariaLabel()">
      <canvas #canvas aria-hidden="true"></canvas>
      <table class="sr-only">
        <caption>{{ ariaLabel() }}</caption>
        <thead><tr><th>Heure</th><th>Erreurs</th><th>Critiques</th></tr></thead>
        <tbody>
          @for (b of buckets(); track b.hour) {
            <tr><td>{{ libelleHeure(b.hour) }}</td><td>{{ b.error }}</td><td>{{ b.critical }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }
    .etc-wrapper {
      position: relative;
      width: 100%;
      height: var(--chart-height, 180px);
    }
    .sr-only {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `],
})
export class ErrorTimelineChartComponent implements AfterViewInit, OnDestroy {
  readonly buckets = input.required<ErrorBucket[]>();
  readonly height = input(180);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart: Chart | null = null;

  /** Heure lisible d'un créneau — le gabarit du tableau accessible s'en sert aussi. */
  protected libelleHeure(iso: string): string {
    return formatHour(iso);
  }

  /**
   * Nom accessible du graphique. Il annonce les TOTAUX : sans eux, « erreurs par heure »
   * ne dit pas s'il s'en est produit une ou trois cents.
   */
  protected readonly ariaLabel = computed(() => {
    const b = this.buckets();
    const erreurs = b.reduce((a, x) => a + x.error, 0);
    const critiques = b.reduce((a, x) => a + x.critical, 0);
    return `Erreurs par heure sur les dernières 24 h : ${erreurs} erreur${erreurs > 1 ? 's' : ''}, ${critiques} critique${critiques > 1 ? 's' : ''}.`;
  });

  private readonly updateOnDataChange = effect(() => {
    const data = this.buckets();
    if (!this.chart) return;
    this.chart.data.labels = data.map((b) => formatHour(b.hour));
    const ds0 = this.chart.data.datasets[0];
    const ds1 = this.chart.data.datasets[1];
    if (ds0) ds0.data = data.map((b) => b.error);
    if (ds1) ds1.data = data.map((b) => b.critical);
    this.chart.update('none');
  });

  ngAfterViewInit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    canvas.parentElement?.style.setProperty('--chart-height', `${this.height()}px`);

    const colors = readColors();
    const data = this.buckets();

    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: data.map((b) => formatHour(b.hour)),
        datasets: [
          {
            label: 'ERROR',
            data: data.map((b) => b.error),
            backgroundColor: 'rgba(251, 146, 60, 0.7)',
            borderRadius: 3,
            borderSkipped: false,
          },
          {
            label: 'CRITICAL',
            data: data.map((b) => b.critical),
            backgroundColor: 'rgba(244, 63, 94, 0.8)',
            borderRadius: 3,
            borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: colors.bgSecondary,
            titleColor: colors.fgPrimary,
            bodyColor: colors.fgSecondary,
            borderColor: colors.borderSubtle,
            borderWidth: 1,
            padding: 10,
            titleFont: { family: 'Inter, sans-serif', weight: 600, size: 12 },
            bodyFont: { family: 'Inter, sans-serif', size: 12 },
            callbacks: {
              title: (items: TooltipItem<'bar'>[]) => items[0]?.label ?? '',
              label: (ctx: TooltipItem<'bar'>) => {
                const n = (ctx.raw as number) ?? 0;
                return `${ctx.dataset.label}: ${n}`;
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            border: { color: colors.borderSubtle },
            ticks: {
              color: colors.fgTertiary,
              font: { size: 10 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 12,
            },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: colors.borderSubtle },
            border: { display: false },
            ticks: { color: colors.fgTertiary, font: { size: 10 }, precision: 0 },
          },
        },
        animation: { duration: 220 },
      },
    };

    this.chart = new Chart(canvas, config);
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.chart = null;
  }
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}h`;
}

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bgSecondary: get('--bg-secondary', '#0F1714'),
    fgPrimary: get('--fg-primary', '#F0FDF9'),
    fgSecondary: get('--fg-secondary', '#A7C7BC'),
    fgTertiary: get('--fg-tertiary', '#5C746C'),
    // ⚠️ Repli SANS `var(--…)` : ces couleurs finissent dans `ctx.fillStyle` d'un
    // canvas, qui ne resout aucune variable CSS et garde silencieusement sa valeur
    // precedente — du noir. Le meme piege peignait l'aire de /reports en noir opaque
    // (releve en production le 2026-08-17). Un repli doit etre une couleur, pas une
    // reference a resoudre.
    borderSubtle: get('--border-subtle', 'color-mix(in srgb, #10E0A0 8%, transparent)'),
  };
}

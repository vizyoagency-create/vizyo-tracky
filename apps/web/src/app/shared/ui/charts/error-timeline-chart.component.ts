import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
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
    <div class="etc-wrapper" role="img" [attr.aria-label]="'Erreurs par heure sur les dernieres 24h'">
      <canvas #canvas></canvas>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }
    .etc-wrapper {
      position: relative;
      width: 100%;
      height: var(--chart-height, 180px);
    }
  `],
})
export class ErrorTimelineChartComponent implements AfterViewInit, OnDestroy {
  readonly buckets = input.required<ErrorBucket[]>();
  readonly height = input(180);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart: Chart | null = null;

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
    borderSubtle: get('--border-subtle', 'color-mix(in srgb, var(--color-tracky-light) 8%, transparent)'),
  };
}

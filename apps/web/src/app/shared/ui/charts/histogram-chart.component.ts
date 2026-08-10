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

/** Bins par defaut pour la vitesse, en km/h. */
export const DEFAULT_SPEED_BINS: SpeedBin[] = [
  { label: '0–30', min: 0, max: 30, color: '#10E0A0' },
  { label: '30–50', min: 30, max: 50, color: '#7CC270' },
  { label: '50–70', min: 50, max: 70, color: '#EAB308' },
  { label: '70–90', min: 70, max: 90, color: '#F59E0B' },
  { label: '90–110', min: 90, max: 110, color: '#EF4444' },
  { label: '110+', min: 110, max: Infinity, color: '#B91C1C' },
];

export interface SpeedBin {
  label: string;
  min: number;
  /** Borne haute exclusive (sauf pour le dernier bin). */
  max: number;
  color: string;
}

/**
 * Histogramme : distribution d'une serie de valeurs scalaires en bins fixes
 * (par defaut : vitesses km/h). Standalone, OnPush.
 */
@Component({
  selector: 'app-histogram-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hc-wrapper" role="img" [attr.aria-label]="ariaLabel()">
      <canvas #canvas></canvas>
      <table class="sr-only">
        <caption>{{ ariaLabel() }}</caption>
        <thead><tr><th>Tranche</th><th>Trajets</th></tr></thead>
        <tbody>
          @for (b of bins(); track b.label; let i = $index) {
            <tr><td>{{ b.label }}</td><td>{{ counts()[i] }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }
    .hc-wrapper {
      position: relative;
      width: 100%;
      height: var(--chart-height, 220px);
    }
    .sr-only {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `],
})
export class HistogramChartComponent implements AfterViewInit, OnDestroy {
  /** Valeurs brutes a binner (ex: maxSpeed de chaque trip). */
  readonly values = input.required<number[]>();
  readonly bins = input<SpeedBin[]>(DEFAULT_SPEED_BINS);
  readonly height = input(220);
  readonly unit = input<string>('km/h');

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart: Chart | null = null;

  protected readonly counts = computed(() => {
    const bins = this.bins();
    const arr = new Array<number>(bins.length).fill(0);
    for (const v of this.values()) {
      for (let i = 0; i < bins.length; i++) {
        const b = bins[i]!;
        const inBin = i === bins.length - 1
          ? v >= b.min
          : v >= b.min && v < b.max;
        if (inBin) {
          arr[i] = (arr[i] ?? 0) + 1;
          break;
        }
      }
    }
    return arr;
  });

  protected readonly ariaLabel = computed(() => {
    const total = this.values().length;
    return `Distribution des vitesses sur ${total} trajet${total > 1 ? 's' : ''}.`;
  });

  private readonly updateOnDataChange = effect(() => {
    const c = this.counts();
    const bins = this.bins();
    if (!this.chart) return;
    this.chart.data.labels = bins.map((b) => `${b.label} ${this.unit()}`);
    const ds = this.chart.data.datasets[0];
    if (ds) {
      ds.data = c;
      ds.backgroundColor = bins.map((b) => b.color);
    }
    this.chart.update('none');
  });

  ngAfterViewInit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    canvas.parentElement?.style.setProperty('--chart-height', `${this.height()}px`);

    const colors = readColors();
    const bins = this.bins();
    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: bins.map((b) => `${b.label} ${this.unit()}`),
        datasets: [
          {
            label: 'Trajets',
            data: this.counts(),
            backgroundColor: bins.map((b) => b.color),
            borderRadius: 6,
            borderSkipped: false,
            maxBarThickness: 56,
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
            displayColors: true,
            boxWidth: 8,
            boxHeight: 8,
            boxPadding: 4,
            titleFont: { family: 'Inter, sans-serif', weight: 600, size: 12 },
            bodyFont: { family: 'Inter, sans-serif', size: 12 },
            callbacks: {
              title: (items: TooltipItem<'bar'>[]) => items[0]?.label ?? '',
              label: (ctx: TooltipItem<'bar'>) => {
                const n = (ctx.raw as number) ?? 0;
                return `${n} trajet${n > 1 ? 's' : ''}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: colors.borderSubtle },
            ticks: { color: colors.fgTertiary, font: { size: 11 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: colors.borderSubtle },
            border: { display: false },
            ticks: { color: colors.fgTertiary, font: { size: 11 }, precision: 0 },
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

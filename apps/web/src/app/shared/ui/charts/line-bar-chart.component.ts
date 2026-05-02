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
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type ChartDataset,
  type TooltipItem,
} from 'chart.js';

Chart.register(
  BarController,
  LineController,
  BarElement,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
);

export interface LineBarChartData {
  /** Labels d'axe X (ex: ["12 mai", "13 mai", …]). */
  labels: string[];
  /** Nombre de trajets par jour (bar). */
  tripCounts: number[];
  /** Distance en km par jour (line). */
  distancesKm: number[];
  /** Durée en heures par jour (utilisé pour le tooltip seulement). */
  durationsHours: number[];
}

/**
 * Combo bar (trajets/jour) + line (distance/jour) sur le même axe X.
 * Tooltip riche au hover. OnPush + import tree-shaké des modules Chart.js.
 */
@Component({
  selector: 'app-line-bar-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="lbc-wrapper"
      role="img"
      [attr.aria-label]="ariaLabel()"
    >
      <canvas #canvas></canvas>
      <table class="sr-only">
        <caption>{{ ariaLabel() }}</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Trajets</th>
            <th>Distance (km)</th>
            <th>Durée (h)</th>
          </tr>
        </thead>
        <tbody>
          @for (lbl of data().labels; track lbl; let i = $index) {
            <tr>
              <td>{{ lbl }}</td>
              <td>{{ data().tripCounts[i] }}</td>
              <td>{{ data().distancesKm[i] }}</td>
              <td>{{ data().durationsHours[i] }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }
    .lbc-wrapper {
      position: relative;
      width: 100%;
      height: var(--chart-height, 280px);
    }
    .sr-only {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `],
})
export class LineBarChartComponent implements AfterViewInit, OnDestroy {
  readonly data = input.required<LineBarChartData>();
  readonly height = input(280);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart: Chart | null = null;

  protected readonly ariaLabel = () => {
    const d = this.data();
    const total = d.tripCounts.reduce((a, b) => a + b, 0);
    const km = d.distancesKm.reduce((a, b) => a + b, 0);
    return `Évolution sur ${d.labels.length} jours : ${total} trajets, ${km.toFixed(0)} km au total.`;
  };

  private readonly updateOnDataChange = effect(() => {
    const d = this.data();
    if (!this.chart) return;
    this.applyData(d);
    this.chart.update('none');
  });

  ngAfterViewInit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    canvas.parentElement?.style.setProperty('--chart-height', `${this.height()}px`);

    const colors = readColors();
    const config: ChartConfiguration = {
      type: 'bar',
      data: { labels: [], datasets: this.buildDatasets([], [], colors) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: colors.bgSecondary,
            titleColor: colors.fgPrimary,
            bodyColor: colors.fgSecondary,
            borderColor: colors.borderSubtle,
            borderWidth: 1,
            padding: 10,
            displayColors: false,
            titleFont: { family: 'Inter, sans-serif', weight: 600, size: 12 },
            bodyFont: { family: 'Inter, sans-serif', size: 12 },
            callbacks: {
              title: (items: TooltipItem<'bar' | 'line'>[]) => items[0]?.label ?? '',
              label: (ctx: TooltipItem<'bar' | 'line'>) => {
                const i = ctx.dataIndex;
                const d2 = this.data();
                const trips = d2.tripCounts[i] ?? 0;
                const km = d2.distancesKm[i] ?? 0;
                const hours = d2.durationsHours[i] ?? 0;
                return [
                  `${trips} trajet${trips > 1 ? 's' : ''}`,
                  `${km.toFixed(1)} km`,
                  `${formatHours(hours)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: colors.borderSubtle },
            ticks: { color: colors.fgTertiary, font: { size: 11 }, maxRotation: 0, autoSkip: true },
          },
          y: {
            position: 'left',
            beginAtZero: true,
            grid: { color: colors.borderSubtle },
            border: { display: false },
            ticks: { color: colors.fgTertiary, font: { size: 11 }, callback: (v) => `${v} km` },
          },
          y1: {
            position: 'right',
            beginAtZero: true,
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: colors.fgTertiary,
              font: { size: 11 },
              precision: 0,
              callback: (v) => `${v}`,
            },
          },
        },
        animation: { duration: 220 },
      },
    };

    this.chart = new Chart(canvas, config);
    this.applyData(this.data());
    this.chart.update('none');
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.chart = null;
  }

  private applyData(d: LineBarChartData): void {
    if (!this.chart) return;
    this.chart.data.labels = d.labels;
    this.chart.data.datasets = this.buildDatasets(d.distancesKm, d.tripCounts, readColors());
  }

  private buildDatasets(
    distancesKm: number[],
    tripCounts: number[],
    colors: ReturnType<typeof readColors>,
  ): ChartDataset<'bar' | 'line'>[] {
    return [
      {
        type: 'bar',
        label: 'Trajets',
        data: tripCounts,
        backgroundColor: colors.trackyAlpha20,
        borderColor: colors.trackyLight,
        borderWidth: 1,
        borderRadius: 6,
        yAxisID: 'y1',
        order: 2,
      },
      {
        type: 'line',
        label: 'Distance',
        data: distancesKm,
        borderColor: colors.trackyLight,
        backgroundColor: colors.trackyAlpha15,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: colors.trackyLight,
        pointHoverBorderColor: colors.bgSecondary,
        pointHoverBorderWidth: 2,
        borderWidth: 2,
        yAxisID: 'y',
        order: 1,
      },
    ];
  }
}

function formatHours(h: number): string {
  if (h <= 0) return '0min';
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh === 0) return `${mm}min`;
  if (mm === 0) return `${hh}h`;
  return `${hh}h${String(mm).padStart(2, '0')}`;
}

/**
 * Lit les CSS vars du :root pour respecter le theme dark/light. Lu a chaque
 * (re)build du chart — coût négligeable et ça suit les changements de thème
 * runtime.
 */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    trackyLight: get('--tracky-light', '#10E0A0'),
    tracky: get('--tracky', '#059669'),
    bgSecondary: get('--bg-secondary', '#0F1714'),
    fgPrimary: get('--fg-primary', '#F0FDF9'),
    fgSecondary: get('--fg-secondary', '#A7C7BC'),
    fgTertiary: get('--fg-tertiary', '#5C746C'),
    borderSubtle: get('--border-subtle', 'rgba(16,224,160,0.08)'),
    trackyAlpha15: 'rgba(16, 224, 160, 0.15)',
    trackyAlpha20: 'rgba(16, 224, 160, 0.20)',
  };
}

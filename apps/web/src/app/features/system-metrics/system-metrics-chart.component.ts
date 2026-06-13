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
import type { SystemHistoryPointDto } from '@vizyo/tracky-shared';
import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type ChartDataset,
} from 'chart.js';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
);

/**
 * Multi-line CPU% / RAM% (axe gauche 0-100) + Load 1min (axe droit).
 * OnPush + effect sur les inputs. Couleurs lues sur les CSS vars (thème).
 */
@Component({
  selector: 'app-system-metrics-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="smc-wrapper"><canvas #canvas></canvas></div>`,
  styles: [
    `:host { display: block; width: 100%; }
     .smc-wrapper { position: relative; width: 100%; height: var(--chart-height, 300px); }`,
  ],
})
export class SystemMetricsChartComponent implements AfterViewInit, OnDestroy {
  readonly points = input.required<SystemHistoryPointDto[]>();
  readonly memTotalMb = input(0);
  readonly height = input(300);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart: Chart | null = null;

  private readonly updateOnDataChange = effect(() => {
    this.points();
    this.memTotalMb();
    if (!this.chart) return;
    this.applyData();
    this.chart.update('none');
  });

  ngAfterViewInit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    canvas.parentElement?.style.setProperty('--chart-height', `${this.height()}px`);

    const c = readColors();
    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: { color: c.fgSecondary, font: { size: 11 }, boxWidth: 12, usePointStyle: true },
          },
          tooltip: {
            backgroundColor: c.bgSecondary,
            titleColor: c.fgPrimary,
            bodyColor: c.fgSecondary,
            borderColor: c.borderSubtle,
            borderWidth: 1,
            padding: 10,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: c.borderSubtle },
            ticks: { color: c.fgTertiary, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          },
          y: {
            position: 'left',
            beginAtZero: true,
            max: 100,
            grid: { color: c.borderSubtle },
            border: { display: false },
            ticks: { color: c.fgTertiary, font: { size: 10 }, callback: (v) => `${v}%` },
          },
          y1: {
            position: 'right',
            beginAtZero: true,
            grid: { display: false },
            border: { display: false },
            ticks: { color: c.fgTertiary, font: { size: 10 } },
          },
        },
        animation: { duration: 180 },
      },
    };

    this.chart = new Chart(canvas, config);
    this.applyData();
    this.chart.update('none');
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.chart = null;
  }

  private applyData(): void {
    if (!this.chart) return;
    const pts = this.points();
    const memTotal = this.memTotalMb() || 1;
    const c = readColors();
    this.chart.data.labels = pts.map((p) => fmtLabel(p.t));
    const datasets: ChartDataset<'line', number[]>[] = [
      {
        label: 'CPU %',
        data: pts.map((p) => p.cpuPercent),
        borderColor: c.trackyLight,
        backgroundColor: c.trackyAlpha15,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        yAxisID: 'y',
      },
      {
        label: 'RAM %',
        data: pts.map((p) => Math.round((p.memUsedMb / memTotal) * 100)),
        borderColor: c.sky,
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        yAxisID: 'y',
      },
      {
        label: 'Load (1m)',
        data: pts.map((p) => p.loadAvg1),
        borderColor: c.amber,
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        borderDash: [4, 3],
        yAxisID: 'y1',
      },
    ];
    this.chart.data.datasets = datasets;
  }
}

function fmtLabel(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
}

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    trackyLight: get('--tracky-light', '#10E0A0'),
    bgSecondary: get('--bg-secondary', '#0F1714'),
    fgPrimary: get('--fg-primary', '#F0FDF9'),
    fgSecondary: get('--fg-secondary', '#A7C7BC'),
    fgTertiary: get('--fg-tertiary', '#5C746C'),
    borderSubtle: get('--border-subtle', 'rgba(16,224,160,0.08)'),
    trackyAlpha15: 'rgba(16, 224, 160, 0.15)',
    sky: '#38BDF8',
    amber: '#F59E0B',
  };
}

import { Component } from '@angular/core';
import { Truck, Navigation, Activity, AlertTriangle } from 'lucide-angular';
import { MetricCardComponent } from '../../shared/components/metric-card.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [MetricCardComponent],
  template: `
    <div class="flex flex-col gap-6">
      <h1 class="text-2xl font-display font-bold text-fg-primary">Vue d'ensemble</h1>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <app-metric-card
          label="Vehicules"
          [value]="24"
          trend="+2 ce mois"
          [icon]="Truck"
        />
        <app-metric-card
          label="En mouvement"
          [value]="8"
          trend="33% de la flotte"
          [icon]="Navigation"
        />
        <app-metric-card
          label="A l'arret"
          [value]="14"
          [icon]="Activity"
        />
        <app-metric-card
          label="Alertes"
          [value]="3"
          trend="2 critiques"
          [icon]="AlertTriangle"
        />
      </div>
    </div>
  `,
})
export class DashboardComponent {
  protected readonly Truck = Truck;
  protected readonly Navigation = Navigation;
  protected readonly Activity = Activity;
  protected readonly AlertTriangle = AlertTriangle;
}

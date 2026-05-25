import { Component } from '@angular/core';
import { VehicleGroupsTabComponent } from '../vehicles/vehicle-groups-tab.component';

/**
 * V1.11 Phase 1 — Page dediee /groups (extraction de l'onglet groupes
 * de la page Vehicules, qui restait cache derriere une perm groups_view).
 *
 * Pour l'instant on encapsule le composant existant. Si plus tard on veut
 * une UI specifique (vue arbre, drag-drop entre groupes), c'est ici.
 */
@Component({
  selector: 'app-vehicle-groups-page',
  standalone: true,
  imports: [VehicleGroupsTabComponent],
  template: `
    <div class="px-6 py-6">
      <h1 class="text-2xl font-bold text-fg-primary mb-1">Groupes de vehicules</h1>
      <p class="text-sm text-fg-secondary mb-6">
        Organisez vos vehicules en groupes pour gerer les acces par equipe ou par usage.
      </p>
      <app-vehicle-groups-tab />
    </div>
  `,
})
export class VehicleGroupsPageComponent {}

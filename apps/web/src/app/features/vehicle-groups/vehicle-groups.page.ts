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
    <!-- V1.12 — Le titre est deja affiche dans le top-bar (data.title de la
         route) et la description provient du composant tab. Pas de duplication. -->
    <div class="px-6 py-6">
      <h1 class="text-2xl font-bold text-fg-primary mb-4">Groupes de véhicules</h1>
      <app-vehicle-groups-tab />
    </div>
  `,
})
export class VehicleGroupsPageComponent {}

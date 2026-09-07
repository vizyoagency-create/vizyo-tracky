import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { MapService } from '../../core/services/map.service';
import { FleetPlacesApiService, type FleetPlaceDto } from '../../core/services/fleet-places.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PlaceMoveComponent } from './place-move.component';

/**
 * Le déplacement d'un lieu depuis la page Lieux : rien n'est enregistré avant le bouton, et le
 * bouton n'est actif qu'après un vrai déplacement. La carte elle-même n'est pas montée ici
 * (MapLibre n'a rien à faire dans un test de contrat) : le service de carte rend `null`, et le
 * geste de glisser est joué par `deplacerVers`, exactement ce que `dragend` appelle.
 */
const LIEU: FleetPlaceDto = {
  id: 'p1', fleetId: 'f1', name: 'Dépôt nord', kind: 'PARKING', lat: 43.6, lng: 1.43,
  radiusM: 60, note: null, stationId: null,
} as FleetPlaceDto;

describe('PlaceMoveComponent', () => {
  let update: jasmine.Spy;
  let toast: { success: jasmine.Spy; error: jasmine.Spy };

  beforeEach(() => {
    update = jasmine.createSpy('update').and.returnValue(of({ ...LIEU, lat: 43.61, lng: 1.44 }));
    toast = { success: jasmine.createSpy('success'), error: jasmine.createSpy('error') };
    TestBed.configureTestingModule({
      imports: [PlaceMoveComponent],
      providers: [
        { provide: MapService, useValue: { createMap: () => null } },
        { provide: FleetPlacesApiService, useValue: { update } },
        { provide: ToastService, useValue: toast },
      ],
    });
  });

  function monter() {
    const fixture = TestBed.createComponent(PlaceMoveComponent);
    fixture.componentRef.setInput('place', LIEU);
    fixture.detectChanges();
    return fixture;
  }

  const bouton = (fixture: ReturnType<typeof monter>): HTMLButtonElement =>
    fixture.nativeElement.querySelector('.pm-b--principal');

  it('sans déplacement, le bouton Enregistrer est inactif et rien ne part au serveur', async () => {
    const fixture = monter();
    await new Promise((r) => setTimeout(r, 0)); // la carte se monte au tour suivant
    fixture.detectChanges();

    expect(bouton(fixture).disabled).toBeTrue();
    // Reposer le repère exactement où il était n'est pas un déplacement.
    (fixture.componentInstance as unknown as { deplacerVers(a: number, b: number): void }).deplacerVers(LIEU.lat, LIEU.lng);
    fixture.detectChanges();
    expect(bouton(fixture).disabled).toBeTrue();
    expect(update).not.toHaveBeenCalled();
  });

  it('après un déplacement, Enregistrer envoie la nouvelle position et émet le lieu enregistré', async () => {
    const fixture = monter();
    const cmp = fixture.componentInstance as unknown as {
      deplacerVers(a: number, b: number): void;
      enregistrer(): Promise<void>;
    };
    let emis: FleetPlaceDto | null = null;
    fixture.componentInstance.deplace.subscribe((p) => (emis = p));

    cmp.deplacerVers(43.61, 1.44);
    fixture.detectChanges();
    expect(bouton(fixture).disabled).toBeFalse();

    await cmp.enregistrer();

    expect(update).toHaveBeenCalledWith('p1', { lat: 43.61, lng: 1.44 });
    expect(emis!.lat).toBe(43.61);
    expect(toast.success).toHaveBeenCalled();
  });

  it('un échec du serveur est dit, et rien n’est émis', async () => {
    update.and.returnValue(throwError(() => new Error('500')));
    const fixture = monter();
    const cmp = fixture.componentInstance as unknown as {
      deplacerVers(a: number, b: number): void;
      enregistrer(): Promise<void>;
    };
    let emis = 0;
    fixture.componentInstance.deplace.subscribe(() => emis++);

    cmp.deplacerVers(43.7, 1.5);
    await cmp.enregistrer();

    expect(toast.error).toHaveBeenCalled();
    expect(emis).toBe(0);
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { VehicleEventDto } from '@vizyo/tracky-shared';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { VehicleMaintenanceTabComponent } from './vehicle-maintenance-tab.component';

/**
 * ══ UN TOAST D'ÉCHEC DIT POURQUOI (relevé le 07/10/2026) ═══════════════════════════════════════
 *
 * L'onglet affichait `err.error?.message` : à plat, donc `undefined` sur toute erreur de l'API —
 * qui enveloppe son corps dans `{ error: { code, message, requestId } }`. Le toast disait « Échec »,
 * et rien d'autre. Même défaut dans 32 écrans ; celui-ci sert de banc, le motif étant lu partout
 * par la même fonction (`motifErreurApi`, `api-error.spec.ts`). Les deux tests tombent sur le code
 * d'avant.
 */
describe('Onglet Maintenance — le toast d’échec porte le motif du serveur (07/10/2026)', () => {
  let http: HttpTestingController;
  let toast: jasmine.SpyObj<Pick<ToastService, 'success' | 'error' | 'warning' | 'info'>>;

  // Les gestes testés sont protégés : appelés par une vue typée, sans rendre l'onglet (qui
  // lirait ses trois listes — hors sujet ici).
  type Vue = {
    markEventDone(ev: VehicleEventDto): Promise<void>;
    savePlan(): Promise<void>;
    planForm: Record<string, unknown>;
  };
  let onglet: Vue;

  /** Le corps d'erreur tel que l'API le sert (`all-exceptions.filter.ts`). */
  const enveloppe = (code: string, message: string) => ({ error: { code, message, requestId: 'r1' } });

  beforeEach(() => {
    toast = jasmine.createSpyObj('ToastService', ['success', 'error', 'warning', 'info']);
    TestBed.configureTestingModule({
      imports: [VehicleMaintenanceTabComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PermissionsService, useValue: { can: () => true } },
        { provide: ToastService, useValue: toast },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(VehicleMaintenanceTabComponent);
    fixture.componentRef.setInput('vehicleId', 'a0000000-0000-4000-8000-00000000000a');
    onglet = fixture.componentInstance as unknown as Vue;
  });

  afterEach(() => http.verify());

  it('⚠️ un refus de l’API : le toast dit le motif, pas seulement « Échec »', async () => {
    const fini = onglet.markEventDone({ id: 'ev1', status: 'PLANNED' } as VehicleEventDto);
    http
      .expectOne({ method: 'PATCH', url: '/api/agenda/events/ev1' })
      .flush(enveloppe('BAD_REQUEST', 'Une mission se pilote depuis l’onglet Missions.'), { status: 400, statusText: 'Bad Request' });
    await fini;

    expect(toast.error).toHaveBeenCalledOnceWith('Échec', 'Une mission se pilote depuis l’onglet Missions.');
  });

  it('⚠️ une panne non maîtrisée : le texte de l’écran, pas « Internal server error »', async () => {
    onglet.planForm = { label: 'Vidange', category: 'Révision', intervalMonths: 12, intervalKm: null, reminderDaysBefore: 14, reminderKmBefore: null, enabled: true };
    const fini = onglet.savePlan();
    http
      .expectOne({ method: 'POST', url: '/api/agenda/plans' })
      .flush(enveloppe('INTERNAL_SERVER_ERROR', 'Internal server error'), { status: 500, statusText: 'Internal Server Error' });
    await fini;

    expect(toast.error).toHaveBeenCalledOnceWith('Échec', 'Enregistrement impossible.');
  });
});

import { registerLocaleData } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import localeFr from '@angular/common/locales/fr';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { VehicleEventDto } from '@vizyo/tracky-shared';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { ReservationSheetComponent } from './reservation-sheet.component';

/**
 * ══ « À VALIDER » — REFUSER SE CONFIRME (30/09) ══════════════════════════════════════════════
 *
 * Trouvé en recette du garde-fou d'envoi : dans la file « À valider », « Refuser » écrivait d'un
 * clic — et un refus de demande publique PRÉVIENT le demandeur (courriel ou SMS, toujours). Le
 * panneau du jour demandait déjà « Refuser cette demande ? ». Ce spec verrouille : rien ne part
 * avant la confirmation, « Garder » n'écrit rien, la modale dit qui est prévenu.
 */
describe('Feuille Réservations — « Refuser » passe par la confirmation (30/09)', () => {
  let http: HttpTestingController;
  let toast: jasmine.SpyObj<Pick<ToastService, 'success' | 'warning' | 'error' | 'info'>>;
  let sheet: ReservationSheetComponent;

  // Les méthodes testées sont protégées : on les appelle par une vue typée, sans rendre la feuille
  // (ouverte, elle chargerait parc, statut IA et file — hors sujet ici).
  type Vue = {
    demanderRefus(g: { cle: string; items: VehicleEventDto[] }): void;
    confirmerRefus(): Promise<void>;
    refusEnAttente: { (): { cle: string; items: VehicleEventDto[] } | null; set(v: null): void };
    refusTitre(): string;
    refusEtat(): string;
    refusConsequences(): string;
    refusLibelle(): string;
    pending: { set(v: VehicleEventDto[]): void; (): VehicleEventDto[] };
  };
  const vue = (): Vue => sheet as unknown as Vue;

  const demande = (over: Partial<VehicleEventDto> & { metadata?: Record<string, unknown> } = {}): VehicleEventDto =>
    ({
      id: 'r1',
      fleetId: 'f1',
      vehicleId: 'v1',
      vehiclePlate: 'TEST-006-XX',
      type: 'RESERVATION',
      status: 'REQUESTED',
      title: 'Demande publique → Albi',
      startAt: '2026-10-01T07:00:00.000Z',
      endAt: '2026-10-01T15:00:00.000Z',
      metadata: { public: true, requester: 'École Jean-Jaurès', requesterContact: 'ecole@test.fr' },
      ...over,
    }) as unknown as VehicleEventDto;

  beforeAll(() => registerLocaleData(localeFr));

  beforeEach(() => {
    toast = jasmine.createSpyObj('ToastService', ['success', 'warning', 'error', 'info']);
    TestBed.configureTestingModule({
      imports: [ReservationSheetComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { user: () => ({ sub: 'u-valideur', role: 'FLEET_ADMIN', fleetId: 'f1' }) } },
        { provide: ToastService, useValue: toast },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    sheet = TestBed.createComponent(ReservationSheetComponent).componentInstance;
  });

  afterEach(() => {
    // Les deux lectures de fond des services réels (statut IA, droits par véhicule) : hors sujet ici.
    // Tout AUTRE appel resté ouvert — un refus parti trop tôt — fait échouer `verify()`.
    http.match((req) => req.method === 'GET' && (req.url === '/api/ai/status' || req.url === '/api/users/me/access'));
    http.verify();
  });

  it('« Refuser » n’écrit RIEN : il ouvre la confirmation, qui dit ce qu’on refuse et que le demandeur est prévenu', () => {
    const r = demande();
    vue().demanderRefus({ cle: 'r1', items: [r] });
    http.expectNone((req) => req.url.includes('/cancel'));
    expect(vue().refusEnAttente()).not.toBeNull();
    expect(vue().refusTitre()).toBe('Refuser cette demande ?');
    expect(vue().refusLibelle()).toBe('Refuser la demande');
    expect(vue().refusEtat()).toContain('« École Jean-Jaurès »');
    expect(vue().refusEtat()).toContain('TEST-006-XX');
    expect(vue().refusConsequences()).toContain('Le demandeur (lien public) est prévenu (courriel ou SMS).');
  });

  it('« Garder » : la confirmation se ferme, rien n’est parti', () => {
    vue().demanderRefus({ cle: 'r1', items: [demande()] });
    vue().refusEnAttente.set(null);
    http.expectNone((req) => req.url.includes('/cancel'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('confirmer : UN refus par véhicule de la demande, puis la confirmation se ferme', async () => {
    const a = demande({ id: 'r1', vehiclePlate: 'AA-1' });
    const b = demande({ id: 'r2', vehiclePlate: 'BB-2' });
    vue().pending.set([a, b]);
    vue().demanderRefus({ cle: 'grp', items: [a, b] });
    expect(vue().refusTitre()).toBe('Refuser les 2 véhicules de cette demande ?');
    expect(vue().refusEtat()).toContain('AA-1, BB-2');
    const fini = vue().confirmerRefus();
    http.expectOne({ method: 'POST', url: '/api/reservations/r1/cancel' }).flush({});
    // Les refus partent l'un après l'autre : laisser la boucle reprendre avant d'attendre le second.
    await new Promise((fin) => setTimeout(fin));
    http.expectOne({ method: 'POST', url: '/api/reservations/r2/cancel' }).flush({});
    await fini;
    expect(vue().refusEnAttente()).toBeNull();
    expect(vue().pending()).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith('2 véhicules refusés', 'AA-1, BB-2');
  });

  it('une demande INTERNE (pas du lien public) : « Personne n’est prévenu »', () => {
    vue().demanderRefus({ cle: 'r1', items: [demande({ metadata: { requesterId: 'u-conducteur' } })] });
    expect(vue().refusConsequences()).toContain('Personne n’est prévenu : ni courriel, ni SMS.');
  });

  it('sa PROPRE demande : on la retire (même mot que le panneau du jour)', () => {
    vue().demanderRefus({ cle: 'r1', items: [demande({ metadata: { requesterId: 'u-valideur' } })] });
    expect(vue().refusTitre()).toBe('Retirer votre demande ?');
    expect(vue().refusLibelle()).toBe('Retirer la demande');
  });
});

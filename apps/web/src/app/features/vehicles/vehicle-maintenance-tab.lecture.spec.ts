import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { VehicleEventDto } from '@vizyo/tracky-shared';
import { AgendaApiService } from '../../core/services/agenda.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { VehicleMaintenanceTabComponent } from './vehicle-maintenance-tab.component';

/**
 * ══ L'ONGLET MAINTENANCE MONTRE LES ENTRETIENS DU VÉHICULE — OU DIT QU'IL N'A PAS PU LES LIRE ══
 * (constaté en production le 07/10/2026, après le déploiement n° 18)
 *
 * L'onglet demandait `GET /api/agenda/events?vehicleId=…&type=MAINTENANCE`, sans `from` ni `to`, que
 * l'API exige depuis la création de la route (28/06) : 400 « from (ISO) requis ». Et un
 * `.catch(() => [])` l'avalait — « Aucun entretien ou incident à venir », « Aucun entretien passé
 * enregistré », sur tous les véhicules, sans un mot.
 *
 * Le faux serveur ci-dessous répond comme la VRAIE API : une lecture de `/api/agenda/events` sans
 * fenêtre reçoit son 400 ; avec une fenêtre, seuls les évènements qui y tombent. Les trois premiers
 * tests tombent sur le code d'avant — et le premier tomberait aussi sur une fenêtre « raisonnable »
 * choisie par l'écran : l'échéance de 2029 et la révision de 2023 en sortiraient, en silence.
 */

const VEHICULE = 'a0000000-0000-4000-8000-00000000000a';

const entretien = (id: string, title: string, status: string, startAt: string): VehicleEventDto =>
  ({
    id, fleetId: 'f1', vehicleId: VEHICULE, vehiclePlate: 'AB-123-CD', type: 'MAINTENANCE', category: null,
    status, severity: null, title, description: null, startAt, endAt: null, allDay: true, blocksVehicle: true,
    odometerKm: null, planId: null, linkedEventId: null, resolvedAt: null, metadata: null, source: 'MANUAL',
    createdAt: '2026-06-28T10:00:00.000Z', updatedAt: '2026-06-28T10:00:00.000Z',
  }) as unknown as VehicleEventDto;

/** L'échéance d'un plan des années devant, une échéance oubliée depuis 2025, un entretien de 2023. */
const ENTRETIENS = [
  entretien('ct', 'Contrôle technique 2029', 'PLANNED', '2029-03-01T00:00:00.000Z'),
  entretien('vidange', 'Vidange en retard', 'PLANNED', '2025-03-01T00:00:00.000Z'),
  entretien('revision', 'Révision 2023', 'DONE', '2023-05-10T00:00:00.000Z'),
];

describe('Onglet Maintenance — tous les entretiens du véhicule, ou l’échec dit (07/10/2026)', () => {
  let fixture: ComponentFixture<VehicleMaintenanceTabComponent>;
  let http: HttpTestingController;
  /** Les lectures d'évènements parties SANS fenêtre : celles que l'API de production refuse. */
  let refuseesParLApi: string[];

  /** Répond comme l'API de production, y compris son 400 à une lecture d'évènements sans fenêtre. */
  const commeLApi = (req: TestRequest): void => {
    const { url, params } = req.request;
    if (url === '/api/agenda/events') {
      const from = params.get('from');
      const to = params.get('to');
      if (!from || !to) {
        refuseesParLApi.push(req.request.urlWithParams);
        req.flush({ error: { code: 'BAD_REQUEST', message: 'from (ISO) requis' } }, { status: 400, statusText: 'Bad Request' });
        return;
      }
      // Avec une fenêtre : ce qui commence dedans (assez pour juger une fenêtre choisie par l'écran).
      const dans = (e: VehicleEventDto) => Date.parse(e.startAt) >= Date.parse(from) && Date.parse(e.startAt) <= Date.parse(to);
      req.flush(ENTRETIENS.filter(dans));
      return;
    }
    if (url === `/api/agenda/vehicles/${VEHICULE}/events`) {
      req.flush(ENTRETIENS.filter((e) => !params.get('type') || e.type === params.get('type')));
      return;
    }
    if (url === `/api/agenda/vehicles/${VEHICULE}/odometer`) {
      req.flush({ vehicleId: VEHICULE, lastOdometerKm: 12000, lastOdometerAt: '2026-09-01T00:00:00.000Z', gpsDistanceSinceKm: 450, estimatedKm: 12450 });
      return;
    }
    if (url === '/api/agenda/plans') {
      req.flush([]);
      return;
    }
    req.flush({ error: { message: `route inconnue du faux serveur : ${url}` } }, { status: 404, statusText: 'Not Found' });
  };

  /** Une panne sur les routes visées ; les autres répondent comme l'API. */
  const enPanne = (motif: RegExp, status = 503) => (req: TestRequest): void => {
    if (motif.test(req.request.url)) {
      req.flush({ error: { code: 'INDISPONIBLE', message: 'Service momentanément indisponible' } }, { status, statusText: 'Erreur' });
      return;
    }
    commeLApi(req);
  };

  beforeEach(() => {
    refuseesParLApi = [];
    TestBed.configureTestingModule({
      imports: [VehicleMaintenanceTabComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // Lecture seule : sans `agenda_manage`, ni « + Plan » ni « Marquer terminé » — hors sujet ici.
        { provide: PermissionsService, useValue: { can: () => false } },
        { provide: ToastService, useValue: jasmine.createSpyObj('ToastService', ['success', 'error', 'warning', 'info']) },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(VehicleMaintenanceTabComponent);
    fixture.componentRef.setInput('vehicleId', VEHICULE);
  });

  afterEach(() => http.verify());

  /** Répond à toutes les lectures en attente (et à celles qu'elles déclenchent), puis rend l'écran. */
  async function servir(repondre: (req: TestRequest) => void = commeLApi): Promise<void> {
    for (let vague = 0; vague < 3; vague++) {
      const enAttente = http.match(() => true);
      if (enAttente.length === 0) break;
      enAttente.forEach(repondre);
      await fixture.whenStable();
    }
    fixture.detectChanges();
  }

  const texte = (): string => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const alertes = (): string[] =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? '');

  it('⚠️ montre TOUT : l’échéance oubliée, le contrôle technique de 2029 et la révision de 2023', async () => {
    fixture.detectChanges(); // ngOnInit : les trois lectures partent
    await servir();

    expect(refuseesParLApi).withContext('lecture d’évènements sans fenêtre, refusée par l’API').toEqual([]);
    expect(texte()).toContain('Vidange en retard');
    expect(texte()).toContain('Contrôle technique 2029');
    expect(texte()).toContain('Révision 2023');
    expect(texte()).not.toContain('Aucun entretien ou incident à venir.');
    expect(texte()).not.toContain('Aucun entretien passé enregistré.');
    expect(alertes()).toEqual([]);
  });

  it('⚠️ une lecture des entretiens en échec le DIT — elle ne se fait plus passer pour une liste vide', async () => {
    fixture.detectChanges();
    await servir(enPanne(/\/events$/));

    expect(alertes().length).toBe(1);
    expect(alertes()[0]).toContain("Les entretiens de ce véhicule n'ont pas pu être lus");
    expect(alertes()[0]).toContain('Service momentanément indisponible');
    expect(texte()).not.toContain('Aucun entretien ou incident à venir.');
    expect(texte()).not.toContain('Aucun entretien passé enregistré.');
    // Le reste de l'onglet, lu, reste montré.
    expect((fixture.nativeElement as HTMLElement).querySelector('.vmt-odo')).withContext('carte du kilométrage').not.toBeNull();
    expect(texte()).toContain('Aucun plan d\'entretien pour ce véhicule.');
  });

  it('⚠️ « Réessayer » relit, et les entretiens reviennent', async () => {
    fixture.detectChanges();
    await servir(enPanne(/\/events$/));
    const reessayer = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Réessayer',
    );
    expect(reessayer).withContext('le recours de la zone en erreur').toBeDefined();

    reessayer!.click();
    // Ce que fait l'application après un clic : l'onglet repasse en chargement et la zone en erreur
    // s'en va, avec le minuteur « trop long » qu'elle vient d'armer (sinon `whenStable` l'attendrait).
    fixture.detectChanges();
    await servir();

    expect(alertes()).toEqual([]);
    expect(texte()).toContain('Contrôle technique 2029');
    expect(texte()).toContain('Révision 2023');
  });

  it('le kilométrage et les plans, illisibles, le disent aussi — chacun dans sa zone', async () => {
    fixture.detectChanges();
    await servir(enPanne(/\/odometer$|\/plans$/, 500));

    expect(alertes().length).toBe(2);
    expect(alertes().some((a) => a.includes("Le kilométrage estimé n'a pas pu être lu"))).toBeTrue();
    expect(alertes().some((a) => a.includes("Les plans d'entretien n'ont pas pu être lus"))).toBeTrue();
    // « Aucun plan » ou « Aucun relevé » serait faux : on ne sait pas.
    expect(texte()).not.toContain('Aucun plan d\'entretien pour ce véhicule.');
    expect(texte()).not.toContain('Aucun relevé ni distance GPS disponible.');
    // Les entretiens, eux, sont lus et montrés.
    expect(texte()).toContain('Contrôle technique 2029');
  });

  it('le client HTTP refuse, à la compilation, une lecture d’évènements sans fenêtre', () => {
    const api = TestBed.inject(AgendaApiService);
    // @ts-expect-error — `from` et `to` sont obligatoires : sans eux, l'API répond 400.
    const sansFenetre = () => api.listEvents({ vehicleId: VEHICULE, type: 'MAINTENANCE' });
    // Ce test vit à la compilation : si `from`/`to` redevenaient facultatifs, la directive
    // ci-dessus deviendrait inutile et le fichier cesserait de compiler (TS2578).
    expect(sansFenetre).toEqual(jasmine.any(Function));
  });
});

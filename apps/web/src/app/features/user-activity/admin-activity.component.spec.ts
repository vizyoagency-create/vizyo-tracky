import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { fakeAsync, TestBed, tick, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { SystemActivityDto } from '@vizyo/tracky-shared';
import { NEVER, of, Subject } from 'rxjs';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { FleetCacheService } from '../../core/services/fleet-cache.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { UsersApiService } from '../../core/services/users.service';
import { AdminActivityComponent } from './admin-activity.component';
import { UserActivityApiService } from './user-activity-api.service';

/**
 * ══ C12 — /admin/activity, onglet Système : « aucune action » n'est dit qu'une fois la réponse là ══
 *
 * Le journal est vidé AVANT chaque appel (onglet ouvert, puce, société, Réessayer) : les lignes à
 * l'écran appartiennent aux filtres précédents. Sans état « chargement », cette liste vide tombait
 * aussitôt dans la branche vide — « Aucune action pour ces filtres » affiché le temps de la réponse,
 * un faux constat sur le client que l'on vient de choisir dans le bandeau. Et la réponse la plus
 * LENTE, arrivée en dernier, ne doit pas remplir la liste de la société d'avant.
 */
describe('C12 — admin-activity, Système : « Chargement du journal… » avant tout constat vide', () => {
  let fixture: ComponentFixture<AdminActivityComponent>;
  /** Une réponse par appel du journal, résolue par le test dans l'ordre qu'il choisit. */
  let appels: { fleetId: string | null | undefined; reponse: Subject<SystemActivityDto[]> }[];
  const societe = signal<string | null>(null);

  const ligne = (id: string): SystemActivityDto => ({
    id, createdAt: new Date().toISOString(), category: 'EMAIL', action: 'email_sent', status: 'SUCCESS',
    actor: 'système', target: 'nord@example.test', detail: 'Rapport hebdomadaire', fleetId: 'f-nord', fleetName: 'Nord',
    triggeredByUserId: null, triggeredByName: null, durationMs: 12, error: null,
  });

  beforeEach(() => {
    appels = [];
    societe.set(null);
    TestBed.configureTestingModule({
      imports: [AdminActivityComponent],
      providers: [
        provideRouter([]),
        {
          provide: UserActivityApiService,
          useValue: {
            online: () => of([]),
            feed: () => of([]),
            comptesDemo: () => of([]),
            etatConsoleDemo: () => of({ configure: false, url: null }),
            stats: () => NEVER,
            engineCommands: () => of([]),
            systemFeed: (opts: { fleetId?: string | null }) => {
              const reponse = new Subject<SystemActivityDto[]>();
              appels.push({ fleetId: opts.fleetId, reponse });
              return reponse;
            },
          },
        },
        { provide: AudioMonitoringService, useValue: { getAudit: () => of([]) } },
        { provide: UsersApiService, useValue: { findAll: () => Promise.resolve({ users: [] }) } },
        { provide: FleetFilterService, useValue: { selectedFleetId: societe.asReadonly(), set: (v: string | null) => societe.set(v) } },
        {
          provide: FleetCacheService,
          useValue: { fleets: signal(new Map([['f-nord', 'Nord'], ['f-sud', 'Sud']])), loadIfNeeded: () => Promise.resolve() },
        },
      ],
    });
    // L'onglet se reflète dans l'URL : sans objet ici.
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
  });
  afterEach(() => TestBed.resetTestingModule());

  /** Ouvre la page, puis l'onglet Système — l'appel du journal part, sans réponse encore. */
  const ouvrirSysteme = (): void => {
    fixture = TestBed.createComponent(AdminActivityComponent);
    fixture.detectChanges();
    tick();
    fixture.componentInstance.setTab('system');
    fixture.detectChanges();
  };
  const rafraichir = (): void => { tick(); fixture.detectChanges(); };
  const page = (): string => (fixture.nativeElement.textContent ?? '').replace(/\s+/g, ' ');

  it('onglet ouvert, réponse pas encore là : « Chargement du journal… », aucun constat vide', fakeAsync(() => {
    ouvrirSysteme();

    expect(appels.length).toBe(1);
    expect(page()).toContain('Chargement du journal…');
    expect(page()).not.toContain('Aucune action');

    appels[0].reponse.next([]);
    rafraichir();
    expect(page()).not.toContain('Chargement du journal…');
    expect(page()).toContain('Aucune action système enregistrée.');
  }));

  it('🔴 société changée dans le bandeau : pas de « Aucune action pour ces filtres » AVANT la réponse', fakeAsync(() => {
    ouvrirSysteme();
    appels[0].reponse.next([ligne('a1')]);
    rafraichir();
    expect(page()).withContext('la ligne servie doit être affichée').toContain('nord@example.test');

    societe.set('f-sud');
    fixture.detectChanges();

    expect(appels.length).withContext('le changement de société doit relire le journal').toBe(2);
    expect(appels[1].fleetId).toBe('f-sud');
    expect(page()).toContain('Chargement du journal…');
    expect(page()).not.toContain('Aucune action pour ces filtres.');
    // Et les lignes de Nord ne restent pas sous le nom de Sud le temps de l'appel.
    expect(page()).not.toContain('nord@example.test');

    appels[1].reponse.next([]);
    rafraichir();
    expect(page()).toContain('Aucune action pour ces filtres.');
  }));

  it('la réponse LENTE de la société d’avant n’écrase pas celle de la société choisie', fakeAsync(() => {
    ouvrirSysteme();
    societe.set('f-sud');
    fixture.detectChanges();
    expect(appels.length).toBe(2);

    // L'appel de « toutes les sociétés » répond en dernier… après le choix de Sud.
    appels[0].reponse.next([ligne('a-ancienne')]);
    rafraichir();
    expect(page()).not.toContain('nord@example.test');
    expect(page()).toContain('Chargement du journal…');

    appels[1].reponse.next([]);
    rafraichir();
    expect(page()).not.toContain('nord@example.test');
    expect(page()).toContain('Aucune action pour ces filtres.');
  }));

  it('une panne n’est pas un journal vide : le motif et « Réessayer », jamais « Aucune action »', fakeAsync(() => {
    ouvrirSysteme();
    appels[0].reponse.error(new HttpErrorResponse({ status: 503, statusText: 'Service Unavailable' }));
    rafraichir();

    expect(page()).not.toContain('Chargement du journal…');
    expect(page()).not.toContain('Aucune action');
    expect(page()).toContain('Réessayer');
  }));
});

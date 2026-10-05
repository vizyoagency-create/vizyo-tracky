import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom, of } from 'rxjs';
import { AuthService, type AuthUser } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { GeofencesApiService } from '../../core/services/geofences.service';
import { MapService } from '../../core/services/map.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { GeofenceDrawDialogComponent } from './geofence-draw-dialog/geofence-draw-dialog.component';

/**
 * ══ UNE ZONE VA DANS LA SOCIÉTÉ CHOISIE (05/10/2026) ══════════════════════════════════════════════
 *
 * Le propriétaire a demandé une zone « Garage » pour cdef31. Dessinée par un super-admin, elle
 * serait partie dans la plus ancienne société de la base (mh cars) : l'écran n'envoyait aucune
 * société et le serveur en devinait une. Le serveur refuse désormais de deviner ; ces tests tiennent
 * le côté écran — la société du sélecteur part avec la zone, et sans elle on ne dessine pas.
 */

const CLE = 'vizyo-fleet-filter';
const CDEF31 = '2ad69ac1-3ffb-4fb6-aa4e-cfbba800b75f';
const compte = (role: AuthUser['role'], fleetId: string | null = null): AuthUser =>
  ({ sub: `u-${role}`, email: 'compte@exemple.fr', role, fleetId, permissions: null });

describe('FleetFilterService.societePourCreer — la société d’un objet à créer', () => {
  function filtre(utilisateur: AuthUser, choisie: string | null) {
    if (choisie) localStorage.setItem(CLE, choisie); else localStorage.removeItem(CLE);
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: { user: signal(utilisateur) } }] });
    return TestBed.inject(FleetFilterService);
  }
  afterEach(() => localStorage.removeItem(CLE));

  it('⚠️ super-admin : la société du sélecteur', () => {
    expect(filtre(compte('SUPER_ADMIN'), CDEF31).societePourCreer()).toEqual({ fleetId: CDEF31 });
  });

  it('⚠️ super-admin sans société choisie : null — à lui de la choisir avant de créer', () => {
    expect(filtre(compte('SUPER_ADMIN'), null).societePourCreer()).toBeNull();
  });

  it('tout autre compte : rien à envoyer, le serveur prend la sienne', () => {
    expect(filtre(compte('FLEET_ADMIN', CDEF31), null).societePourCreer()).toEqual({});
  });
});

describe('GeofencesApiService.importGeoJson — la société part avec l’import', () => {
  it('⚠️ transmet la société en paramètre, et rien quand il n’y en a pas', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const api = TestBed.inject(GeofencesApiService);
    const http = TestBed.inject(HttpTestingController);

    const avec = firstValueFrom(api.importGeoJson({ type: 'FeatureCollection', features: [] }, CDEF31));
    http.expectOne((r) => r.url === '/api/geofences/import-geojson' && r.params.get('fleetId') === CDEF31)
      .flush({ created: 1, skipped: 0 });
    expect(await avec).toEqual({ created: 1, skipped: 0 });

    const sans = firstValueFrom(api.importGeoJson({ type: 'FeatureCollection', features: [] }));
    http.expectOne((r) => r.url === '/api/geofences/import-geojson' && !r.params.has('fleetId'))
      .flush({ created: 0, skipped: 0 });
    await sans;
    http.verify();
  });
});

describe('Dessin d’une zone — la société choisie part avec la zone', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type Interne = Record<string, any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  function dialogue(societe: { fleetId?: string } | null) {
    const create = jasmine.createSpy('create').and.returnValue(of({}));
    TestBed.configureTestingModule({
      imports: [GeofenceDrawDialogComponent],
      providers: [
        { provide: GeofencesApiService, useValue: { create, update: () => of({}) } },
        { provide: FleetFilterService, useValue: { societePourCreer: () => societe } },
        { provide: PreferencesService, useValue: { prefs: signal({}) } },
        { provide: MapService, useValue: {} },
      ],
    });
    // Aucun detectChanges : la carte (MapLibre) n'a rien à faire ici — seul l'envoi est éprouvé.
    const d = TestBed.createComponent(GeofenceDrawDialogComponent).componentInstance as unknown as Interne;
    d['name'] = 'Garage — Aucamville';
    d['shape'] = 'CIRCLE';
    d['center'] = { lat: 43.66089, lng: 1.41866 };
    d['radiusMeters'] = 120;
    return { d, create };
  }

  it('⚠️ super-admin : la zone est envoyée AVEC la société du sélecteur', async () => {
    const { d, create } = dialogue({ fleetId: CDEF31 });
    await d['onSubmit']();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      name: 'Garage — Aucamville', type: 'CIRCLE', centerLat: 43.66089, centerLng: 1.41866, radiusMeters: 120, fleetId: CDEF31,
    }));
  });

  it('⚠️ super-admin sans société : rien n’est envoyé, et l’écran dit pourquoi', async () => {
    const { d, create } = dialogue(null);
    await d['onSubmit']();
    expect(create).not.toHaveBeenCalled();
    expect(d['errorMessage']()).toContain('société');
    expect(d['isLoading']()).toBeFalse();
  });

  it('⚠️ super-admin sans société : on ne passe même pas à la carte', () => {
    const { d } = dialogue(null);
    d['goToStep2']();
    expect(d['currentStep']()).toBe(1);
    expect(d['errorMessage']()).toContain('société');
  });

  it('compte de flotte : la zone part sans société, le serveur prend la sienne', async () => {
    const { d, create } = dialogue({});
    await d['onSubmit']();
    expect(create.calls.mostRecent().args[0].fleetId).toBeUndefined();
  });
});

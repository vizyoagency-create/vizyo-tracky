/**
 * Page « Horaires de la flotte » — les cartes REPLIABLES du 06/10/2026.
 *
 * Demande du propriétaire, en trois temps : « des accordéons pour les premiers cards en haut (les
 * fériés, appliquer des horaires) », puis « les KPI restent en haut, avant le truc des jours ; le
 * vert est trop agressif, fais une card normale », puis « pour les icônes, des SVG » (le 🏢 devant
 * le nom de la société).
 *
 * Ce que ces tests verrouillent :
 *   1. l'ORDRE : les compteurs, PUIS les jours fériés — jamais l'inverse ;
 *   2. les fériés sont une carte NORMALE (plus de bandeau coloré), repliée, dont l'en-tête résume
 *      quand même l'essentiel : la date, l'échéance, l'effet ;
 *   3. ouvrir / fermer est retenu sur le poste, et un stockage illisible ne casse rien ;
 *   4. l'action de masse est repliée, et dit dès l'en-tête qu'un super-admin doit choisir une société ;
 *   5. aucun emoji ne sert d'icône : des SVG.
 */
import { signal } from '@angular/core';
import { ComponentFixture, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { FleetScheduleListResponse, FleetScheduleRowDto } from '@vizyo/tracky-shared';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehicleSchedulesApiService } from '../../core/services/vehicle-schedules.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import {
  CLE_VOLETS_HORAIRES,
  FleetSchedulesComponent,
  lireVoletsHoraires,
  VOLETS_PAR_DEFAUT,
} from './fleet-schedules.component';

const ligne = (over: Partial<FleetScheduleRowDto> = {}): FleetScheduleRowDto => ({
  vehicleId: 'v1', fleetId: 'f1', plate: 'AA-111-BB', brand: 'Renault', model: 'Clio V', group: null,
  trackerId: 't1', hasTracker: true, scheduleExists: true, scheduleEnabled: true, timezone: 'Europe/Paris',
  windowDesc: '07:00–22:00', windowState: 'IN_WINDOW', overrideActive: false, overrideUntil: null,
  lastSpeedKmh: 0, lastIgnition: false, moving: false, lastPositionAt: null, lastSeenAt: null, lastNoFixAt: null,
  connectivity: 'ONLINE', engineCutState: 'normal', nextTransitionAt: null, nextTransitionAction: null,
  cutPending: false, pendingReason: null, awaitingStopUntil: null,
  ...over,
} as unknown as FleetScheduleRowDto);

/** Le 06/10/2026 à midi, heure de Paris : la Toussaint est « dans 26 jours ». */
const reponse = (over: Partial<FleetScheduleListResponse> = {}): FleetScheduleListResponse => ({
  items: [ligne(), ligne({ vehicleId: 'v2', fleetId: 'f2', plate: 'CC-222-DD', trackerId: 't2' })],
  fleets: [{ id: 'f1', name: 'Client test' }, { id: 'f2', name: 'A2R' }],
  holidayForecast: {
    upcoming: [{ date: '2026-11-01', name: 'Toussaint' }, { date: '2026-11-11', name: 'Armistice 1918' }],
    scheduledCount: 2, cutOnHolidayCount: 0, representativeWindow: '07:00-22:00',
  },
  scheduleCutMinStoppedSec: 600,
  serverNow: '2026-10-06T10:00:00.000Z',
  awaitingStopScanTruncated: false,
  ...over,
});

describe('Horaires de la flotte — les cartes repliables (06/10/2026)', () => {
  let role = 'FLEET_ADMIN';
  let reponseServie: FleetScheduleListResponse;

  beforeEach(() => {
    role = 'FLEET_ADMIN';
    reponseServie = reponse();
    try { localStorage.removeItem(CLE_VOLETS_HORAIRES); } catch { /* sans stockage */ }
  });
  afterEach(() => {
    try { localStorage.removeItem(CLE_VOLETS_HORAIRES); } catch { /* sans stockage */ }
  });

  /** Monte la page, laisse `load()` répondre, et rend la fixture prête à lire. */
  function monter(): ComponentFixture<FleetSchedulesComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FleetSchedulesComponent],
      providers: [
        provideRouter([]),
        { provide: VehicleSchedulesApiService, useValue: { listFleet: () => of(reponseServie) } },
        {
          provide: RealtimeService,
          useValue: {
            cutActiveTrackerIds: signal(new Set<string>()),
            cutPendingTrackerIds: signal(new Set<string>()),
            movingTrackerIds: signal(new Set<string>()),
            cutStateSnapshot: () => new Map(),
            seedMovingState: () => undefined,
            seedCutState: () => undefined,
          },
        },
        { provide: FleetFilterService, useValue: { selectedFleetId: signal<string | null>(null) } },
        { provide: AuthService, useValue: { user: signal({ role }), isWatchman: () => false } },
        { provide: PermissionsService, useValue: { can: () => true } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, warning: () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(FleetSchedulesComponent);
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
    return fixture;
  }

  const el = (f: ComponentFixture<FleetSchedulesComponent>, sel: string): HTMLElement | null =>
    f.nativeElement.querySelector(sel);
  const texte = (e: Element | null): string => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('les compteurs d’abord, PUIS les jours fériés — une carte normale, repliée, qui résume', fakeAsync(() => {
    const f = monter();
    const tuiles = el(f, '.tiles')!;
    const feries = el(f, '.volet-feries')!;
    expect(tuiles).not.toBeNull();
    expect(feries).not.toBeNull();
    // 🔴 L'ordre demandé : les KPI restent en haut.
    expect(tuiles.compareDocumentPosition(feries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Une carte NORMALE : plus de bandeau coloré.
    expect(feries.matches('section.volet')).toBe(true);
    expect(f.nativeElement.querySelector('.banner.holiday-ok, .banner.holiday-warn')).toBeNull();

    // Repliée par défaut — et l'en-tête dit quand même la date, l'échéance et l'effet.
    const bouton = el(f, '#volet-feries-tete')!;
    expect(bouton.getAttribute('aria-expanded')).toBe('false');
    expect(el(f, '#volet-feries')!.hidden).toBe(true);
    const tete = texte(bouton);
    expect(tete).toContain('Jours fériés');
    expect(tete).toContain('Prochain : dimanche 1 novembre — Toussaint');
    expect(tete).toContain('dans 26 jours');
    expect(tete).toContain('Roulent normalement');
    f.destroy();
  }));

  it('un clic ouvre la carte, et le choix est retenu sur ce poste', fakeAsync(() => {
    let f = monter();
    el(f, '#volet-feries-tete')!.click();
    f.detectChanges();
    expect(el(f, '#volet-feries-tete')!.getAttribute('aria-expanded')).toBe('true');
    const corps = el(f, '#volet-feries')!;
    expect(corps.hidden).toBe(false);
    expect(texte(corps)).toContain('Vos 2 véhicule(s) programmé(s) rouleront normalement ce jour-là');
    expect(texte(corps)).toContain('L\'automatisation horaire est active 07:00-22:00.');
    expect(texte(corps)).toContain('Fériés suivants :');
    expect(texte(el(f, '#volet-feries .plate-chip'))).toBe('mercredi 11 novembre — Armistice 1918');
    expect(JSON.parse(localStorage.getItem(CLE_VOLETS_HORAIRES)!).feries).toBe(true);
    f.destroy();

    // Une nouvelle visite retrouve la carte ouverte.
    f = monter();
    expect(el(f, '#volet-feries-tete')!.getAttribute('aria-expanded')).toBe('true');
    expect(el(f, '#volet-feries')!.hidden).toBe(false);
    f.destroy();
  }));

  it('férié avec coupe : la pastille passe au ton « attente » et compte les véhicules coupés', fakeAsync(() => {
    reponseServie = reponse({
      holidayForecast: { upcoming: [{ date: '2026-10-07', name: 'Férié test' }], scheduledCount: 2, cutOnHolidayCount: 1, representativeWindow: null },
    });
    const f = monter();
    const pastille = el(f, '.volet-feries .volet-pastille')!;
    expect(pastille.getAttribute('data-ton')).toBe('attente');
    expect(texte(pastille)).toBe('1 coupé(s) ce jour-là');
    expect(texte(el(f, '#volet-feries-tete'))).toContain('demain');
    f.destroy();
  }));

  it('l’action de masse est repliée ; un super-admin sans société le lit dès l’en-tête', fakeAsync(() => {
    role = 'SUPER_ADMIN';
    const f = monter();
    const bouton = el(f, '#volet-appliquer-tete')!;
    expect(bouton.getAttribute('aria-expanded')).toBe('false');
    expect(el(f, '#volet-appliquer')!.hidden).toBe(true);
    expect(texte(bouton)).toContain('Appliquer des horaires à toute la flotte');
    expect(texte(bouton.querySelector('.volet-pastille'))).toBe('Choisissez une société');
    f.destroy();
  }));

  it('l’aide est ouverte à la première visite, puis suit le choix', fakeAsync(() => {
    let f = monter();
    expect(el(f, '#volet-aide-tete')!.getAttribute('aria-expanded')).toBe('true');
    el(f, '#volet-aide-tete')!.click();
    f.detectChanges();
    expect(el(f, '#volet-aide')!.hidden).toBe(true);
    f.destroy();
    f = monter();
    expect(el(f, '#volet-aide-tete')!.getAttribute('aria-expanded')).toBe('false');
    f.destroy();
  }));

  it('aucun emoji ne sert d’icône : la société et l’astuce portent des SVG', fakeAsync(() => {
    const f = monter();
    const societe = el(f, '.fg-name')!;
    expect(societe).not.toBeNull();
    expect(societe.querySelector('svg')).not.toBeNull();
    expect(el(f, '.help-note svg')).not.toBeNull();
    // Ni 🏢 ni 💡 ni ✅ — aucun pictogramme du bloc emoji dans toute la page rendue.
    expect(/[\u{1F300}-\u{1FAFF}\u{2705}\u{26A0}]/u.test(f.nativeElement.textContent ?? '')).toBe(false);
    f.destroy();
  }));
});

describe('lireVoletsHoraires — un stockage illisible ne casse rien', () => {
  afterEach(() => {
    try { localStorage.removeItem(CLE_VOLETS_HORAIRES); } catch { /* sans stockage */ }
  });

  it('rien de stocké, JSON corrompu, valeur non-objet : les valeurs par défaut', () => {
    expect(lireVoletsHoraires()).toEqual({ ...VOLETS_PAR_DEFAUT });
    localStorage.setItem(CLE_VOLETS_HORAIRES, '{pas du json');
    expect(lireVoletsHoraires()).toEqual({ ...VOLETS_PAR_DEFAUT });
    localStorage.setItem(CLE_VOLETS_HORAIRES, '42');
    expect(lireVoletsHoraires()).toEqual({ ...VOLETS_PAR_DEFAUT });
  });

  it('ne retient que les booléens des clés connues', () => {
    localStorage.setItem(CLE_VOLETS_HORAIRES, JSON.stringify({ feries: true, aide: 'oui', autre: true }));
    expect(lireVoletsHoraires()).toEqual({ feries: true, appliquer: false, aide: true });
  });
});

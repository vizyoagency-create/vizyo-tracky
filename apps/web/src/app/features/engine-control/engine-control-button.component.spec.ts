import { fakeAsync, TestBed, tick, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DemoModeService } from '../../core/services/demo-mode.service';
import { EngineControlService } from '../../core/services/engine-control.service';
import { EngineCommandLockService } from '../../core/services/engine-command-lock.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehicleSchedulesApiService } from '../../core/services/vehicle-schedules.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { EngineControlButtonComponent } from './engine-control-button.component';

/**
 * ══ C4 — LA BASCULE QUI A COÛTÉ UNE NUIT (incident CDEF31 du 24 septembre 2026) ══════════════
 *
 * Ce composant immobilise des véhicules, et n'avait aucun test.
 *
 * Il exposait UN bouton qui changeait de sens au même pixel : « Rallumer » quand le véhicule
 * était coupé, « Couper » sinon. Rallumer un véhicule ne le fait pas démarrer — le conducteur
 * doit encore tourner la clé. Le geste naturel, quand rien ne bouge, est donc de réappuyer :
 * et l'on recoupait. Trace mesurée en production sur GS-187-NY, par le même compte veilleur :
 * RESTORE 01:45:20 · CUT 01:47:31 · RESTORE 01:47:41 · CUT 01:48:40 · RESTORE 01:49:32 ·
 * RESTORE 01:49:36 · CUT 01:50:48 · RESTORE 01:51:10.
 *
 * Deux propriétés à tenir, et elles se testent séparément :
 *   1. L'ÉTAT est dit — plus jamais déduit du libellé de l'action.
 *   2. Un clic de trop ne peut plus DÉFAIRE le geste précédent : chaque bouton n'est actif que
 *      pour l'action qui a un sens dans l'état courant.
 *
 * Le rôle joué est le VEILLEUR dans la situation de CETTE NUIT-LÀ : sa liste `recentCommands`
 * est vide, et son état vient uniquement de l'overlay temps réel. C'était alors structurel — un
 * `403` sur `GET /engine-control/commands` — ; C7 a depuis ouvert la route.
 *
 * On continue de tester cette configuration, et ce n'est pas de la nostalgie : la liste est
 * TOUJOURS vide quand un boîtier n'a jamais reçu de commande, quand la lecture échoue, et au
 * premier rendu. Le repli sur l'overlay reste donc le chemin le plus fragile du composant.
 * Le dernier cas, lui, vérifie le chemin post-C7 : la liste servie.
 */
describe('C4 — engine-control-button : l’état est dit, et un clic de trop ne défait plus rien', () => {
  let fixture: ComponentFixture<EngineControlButtonComponent>;
  // Les assertions se lisent sur le DOM : ce que l’opérateur VOIT, pas ce que le composant pense.

  const TRACKER = 'tracker-1';
  const VEHICULE = 'vehicule-1';

  /** L'overlay temps réel : c'est LUI, et lui seul, qui porte l'état pour un veilleur. */
  let cutActifs: ReturnType<typeof signal<Set<string>>>;
  let cutEnAttente: ReturnType<typeof signal<Set<string>>>;
  let enMouvement: ReturnType<typeof signal<Set<string>>>;
  let droitMoteur: boolean;
  /** null = la liste échoue (repli sur l'overlay) ; sinon, la liste servie depuis C7. */
  let commandesServies: unknown[] | null;

  // Les réglages du CAS (droits, liste servie) se posent AVANT `creer()` et ne sont remis à
  // zéro qu'ici : les remettre dans `creer()` écraserait ce que le test vient d'écrire — piège
  // dans lequel ce fichier est tombé à sa première rédaction.
  beforeEach(() => {
    droitMoteur = true;
    commandesServies = null;
  });

  const creer = (options?: { veilleur?: boolean }): void => {
    cutActifs = signal(new Set<string>());
    cutEnAttente = signal(new Set<string>());
    enMouvement = signal(new Set<string>());

    TestBed.configureTestingModule({
      imports: [EngineControlButtonComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: { isWatchman: () => options?.veilleur ?? true },
        },
        {
          provide: PermissionsService,
          useValue: { can: (perm: string) => (perm === 'engine_control' ? droitMoteur : false) },
        },
        {
          provide: RealtimeService,
          useValue: {
            snapshot: signal([{ trackerId: TRACKER, vehicleId: VEHICULE }]),
            cutActiveTrackerIds: cutActifs.asReadonly(),
            cutPendingTrackerIds: cutEnAttente.asReadonly(),
            movingTrackerIds: enMouvement.asReadonly(),
            engineCommandUpdates: signal(new Map()),
          },
        },
        {
          provide: EngineControlService,
          useValue: {
            // Liste indisponible : le composant retombe sur l'overlay temps réel.
            listCommands: () => (commandesServies ? of(commandesServies) : throwError(() => new Error('403'))),
            requestCommand: () => of({}),
          },
        },
        { provide: EngineCommandLockService, useValue: { isLocked: () => false, acquire: () => true, release: () => undefined } },
        { provide: VehicleSchedulesApiService, useValue: { get: () => of({ enabled: false }) } },
        { provide: DemoModeService, useValue: { enabled: () => false } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, info: () => undefined } },
      ],
    });

    fixture = TestBed.createComponent(EngineControlButtonComponent);
    fixture.componentRef.setInput('trackerId', TRACKER);
    fixture.componentRef.setInput('vehicleId', VEHICULE);
    fixture.componentRef.setInput('vehiclePlate', 'GS-187-NY');
    fixture.componentRef.setInput('trackLabel', 'Veilleur GS-187-NY');

    fixture.detectChanges();
  };

  /** Lecture du DOM : c'est ce que l'opérateur VOIT, pas ce que le composant pense. */
  const bouton = (sens: 'couper' | 'rallumer'): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector(`button[data-track="Veilleur GS-187-NY — ${sens}"]`);
  const texteEtat = (): string =>
    (fixture.nativeElement.querySelector('.ec-etat') as HTMLElement | null)?.textContent?.trim() ?? '';

  afterEach(() => TestBed.resetTestingModule());

  it('moteur actif : l’état est écrit, « Couper » est offert, « Rallumer » est refusé avec sa raison', () => {
    creer();
    expect(texteEtat()).toBe('Moteur actif');
    expect(bouton('couper')?.disabled).toBeFalse();
    expect(bouton('rallumer')?.disabled).toBeTrue();
    expect(bouton('rallumer')?.title).toContain('n’est pas coupé');
  });

  it('moteur coupé (confirmé) : l’état est écrit, « Rallumer » est offert, « Couper » est refusé', () => {
    creer();
    cutActifs.set(new Set([TRACKER]));
    fixture.detectChanges();

    expect(texteEtat()).toBe('Moteur coupé');
    expect(bouton('rallumer')?.disabled).toBeFalse();
    expect(bouton('couper')?.disabled).toBeTrue();
    expect(bouton('couper')?.title).toContain('déjà coupé');
  });

  it('coupure NON CONFIRMÉE : l’état le dit — « ne considérez pas ce véhicule comme immobilisé »', () => {
    creer();
    cutEnAttente.set(new Set([TRACKER]));
    fixture.detectChanges();

    expect(texteEtat()).toBe('Coupure non confirmée');
    // Le rallumage reste offert : c'est le seul levier si la coupe est partie pour de bon.
    expect(bouton('rallumer')?.disabled).toBeFalse();
  });

  it('🔴 LE TEST DE RÉGRESSION — les deux boutons existent TOUJOURS, à une place FIXE', () => {
    creer();
    // Moteur actif : les deux sont là.
    expect(bouton('couper')).withContext('« Couper » absent quand le moteur tourne').not.toBeNull();
    expect(bouton('rallumer')).withContext('« Rallumer » absent quand le moteur tourne').not.toBeNull();

    cutActifs.set(new Set([TRACKER]));
    fixture.detectChanges();

    // Moteur coupé : les deux sont TOUJOURS là, au même endroit.
    expect(bouton('couper')).withContext('« Couper » a disparu après la coupe').not.toBeNull();
    expect(bouton('rallumer')).withContext('« Rallumer » a disparu après la coupe').not.toBeNull();
  });

  it('🔴 LE TEST DE RÉGRESSION — un clic de trop ne peut PLUS défaire le geste précédent', () => {
    creer();
    // L'opérateur rallume : la commande part (état → moteur actif).
    cutActifs.set(new Set([TRACKER]));
    fixture.detectChanges();
    expect(bouton('rallumer')?.disabled).withContext('rallumage offert sur un véhicule coupé').toBeFalse();

    cutActifs.set(new Set());
    fixture.detectChanges();

    // Le véhicule ne démarre pas (il faut tourner la clé). Il réappuie AU MÊME ENDROIT.
    // Sous l'ancien code ce pixel portait désormais « Couper » : le véhicule était recoupé.
    expect(bouton('rallumer')?.disabled)
      .withContext('« Rallumer » doit être inerte, pas devenu « Couper »')
      .toBeTrue();
    // …et le bouton « Couper », lui, est ailleurs : le réappui ne peut pas l'atteindre.
    expect(bouton('couper')?.disabled).toBeFalse();
  });

  it('🔴 véhicule coupé mais SANS droit de rallumer : l’état reste visible, et la raison est ÉCRITE', () => {
    droitMoteur = false;
    creer();
    cutActifs.set(new Set([TRACKER]));
    fixture.detectChanges();

    // Le fait le plus important — « ce véhicule est immobilisé » — ne disparaît JAMAIS.
    // C'est ce qui manquait sur HD-443-QY : aucun bouton, aucune explication, et une page
    // parcourue de 0 à 100 % à la recherche d'une commande qui n'était nulle part.
    expect(texteEtat()).toBe('Moteur coupé');
    const refus = fixture.nativeElement.querySelector('.ec-refus') as HTMLElement | null;
    expect(refus?.textContent ?? '').toContain('droit de rallumer');
  });

  it('veilleur, véhicule en mouvement : « Couper » est refusé AVEC sa raison, en clair', () => {
    creer();
    enMouvement.set(new Set([TRACKER]));
    fixture.detectChanges();

    expect(bouton('couper')?.disabled).toBeTrue();
    const refus = fixture.nativeElement.querySelector('.ec-refus') as HTMLElement | null;
    expect(refus?.textContent ?? '').toContain('en mouvement');
  });

  it('🔴 C7 — quand la liste EST servie (veilleur admis), l’état vient d’elle et non de l’overlay', fakeAsync(() => {
    // Le chemin normal depuis C7 : plus besoin du WebSocket pour savoir qu'un véhicule est coupé.
    // C'est la réparation de fond — l'overlay n'est plus la seule source de vérité de ce rôle.
    //
    // `fakeAsync` et pas `async` : `loadRecentCommands` résout sa promesse dans une microtâche, et
    // hors `fakeAsync` cette continuation s'exécute HORS de la zone Angular — le signal est bien
    // mis à jour (on l'a vérifié) mais le gabarit ne se rafraîchit pas, et l'assertion lirait un
    // DOM périmé. Le test passerait ou échouerait pour une raison sans rapport avec le sujet.
    commandesServies = [
      { id: 'c1', trackerId: TRACKER, action: 'CUT', status: 'ACKNOWLEDGED', source: 'SCHEDULER',
        createdAt: new Date().toISOString(), sentAt: null, ackedAt: null, confirmationExpected: false,
        reason: null, lastError: null, requestedBy: '' },
    ];
    creer();
    tick();
    fixture.detectChanges();

    // L'overlay temps réel est resté VIDE — comme après une reconnexion qui a manqué des
    // événements. La liste servie suffit désormais.
    expect(texteEtat()).toBe('Moteur coupé');
    expect(bouton('rallumer')?.disabled).toBeFalse();
    expect(bouton('couper')?.disabled).toBeTrue();
  }));
});

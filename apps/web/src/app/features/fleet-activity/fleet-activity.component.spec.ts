import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { fakeAsync, TestBed, tick, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { AGENDA_ACTIVITY_ACTION_LABELS, type EngineCommandAuditDto } from '@vizyo/tracky-shared';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AdminActivityComponent } from '../user-activity/admin-activity.component';
import { FleetActivityApiService } from './fleet-activity-api.service';
import { FleetActivityComponent } from './fleet-activity.component';

/**
 * ══ D0 — L'AGENDA OUVRE LA PAGE ; UNE PANNE DES COMMANDES MOTEUR NE S'Y LIT PLUS « 0 ÉCHEC » ═══
 *
 * Depuis le 29/09, /fleet-admin/activity s'ouvre sur l'onglet Agenda. Les tuiles (Coupures,
 * Rallumages, Refusée en marche, Échec) restent AU-DESSUS des onglets et lisent les commandes
 * moteur — mais la zone d'erreur de ces commandes vit dans l'onglet Moteurs. Une API tombée
 * s'affichait donc, depuis l'Agenda, « 0 Échec » et rien d'autre : un « rien ne s'est passé »
 * sur l'écran même qui sert à vérifier que personne n'a touché aux véhicules.
 *
 * Ce qui est tenu ici, lu sur le DOM :
 *   1. l'onglet par défaut est l'Agenda, et `?tab=engine` (lien « Voir l'historique » du bouton
 *      moteur) ouvre bien Moteurs ;
 *   2. tant que les commandes ne sont pas lues, ou que leur lecture a échoué, les tuiles disent
 *      « — », jamais 0 ;
 *   3. une panne se signale AU-DESSUS des onglets, avec « Réessayer » ;
 *   4. une relecture ratée n'efface pas la dernière liste reçue (l'échec connu reste au bandeau).
 */
describe('D0 — fleet-activity : l’Agenda ouvre la page, et une panne des commandes moteur s’y lit', () => {
  let fixture: ComponentFixture<FleetActivityComponent>;
  /** Ce que sert la lecture des commandes moteur — réglé par le cas AVANT `creer()`. */
  let moteurs: () => Observable<EngineCommandAuditDto[]>;
  /** `?tab=` de l'URL ; null = aucun paramètre. */
  let ongletUrl: string | null;

  const panne = () => throwError(() => new HttpErrorResponse({ status: 503, statusText: 'Service Unavailable' }));
  const commande = (status: EngineCommandAuditDto['status']): EngineCommandAuditDto => ({
    id: 'cmd-' + status, action: 'CUT', status, vehiclePlate: 'GS-187-NY', trackerImei: '860000000000001',
    requestedByName: 'Veilleur', requestedByRole: 'NIGHT_WATCHMAN', source: 'MANUAL', reason: null,
    confirmationExpected: true, channel: 'TCP', lastError: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), sentAt: null, ackedAt: null,
  });

  beforeEach(() => {
    moteurs = () => of([]);
    ongletUrl = null;
  });
  afterEach(() => TestBed.resetTestingModule());

  const creer = (): void => {
    TestBed.configureTestingModule({
      imports: [FleetActivityComponent],
      providers: [
        {
          provide: FleetActivityApiService,
          useValue: {
            agenda: () => of([]),
            engineCommands: () => moteurs(),
            online: () => of([]),
            feed: () => of([]),
          },
        },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, info: () => undefined } },
        { provide: AuthService, useValue: { user: () => ({ role: 'FLEET_ADMIN' }) } },
        { provide: FleetFilterService, useValue: { selectedFleetId: signal<string | null>(null) } },
        // Lu par la zone d'état partagée, jamais consulté par ces cas.
        { provide: PermissionsService, useValue: {} },
        ...(ongletUrl
          ? [{ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ tab: ongletUrl }) } } }]
          : []),
      ],
    });
    fixture = TestBed.createComponent(FleetActivityComponent);
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
  };

  const texte = (sel: string): string =>
    (fixture.nativeElement.querySelector(sel) as HTMLElement | null)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const ongletActif = (): string => texte('.fa-tabs .tab-btn.on');
  const tuiles = (): string[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.fa-tuile b') as NodeListOf<HTMLElement>)
      .map((b) => b.textContent?.trim() ?? '');
  const noteIndisponible = (): HTMLElement | null =>
    Array.from(fixture.nativeElement.querySelectorAll('.fa-note') as NodeListOf<HTMLElement>)
      .find((n) => (n.textContent ?? '').includes('Commandes moteur indisponibles')) ?? null;

  it('l’onglet par défaut est l’Agenda', fakeAsync(() => {
    creer();
    expect(ongletActif()).toBe('Agenda');
  }));

  it('?tab=engine — le lien « Voir l’historique » du bouton moteur — ouvre Moteurs', fakeAsync(() => {
    ongletUrl = 'engine';
    creer();
    expect(ongletActif()).toBe('Moteurs');
  }));

  it('🔴 commandes moteur EN PANNE, vues depuis l’Agenda : « indisponibles » + Réessayer, et des « — » au lieu de 0', fakeAsync(() => {
    moteurs = panne;
    creer();

    expect(ongletActif()).toBe('Agenda');
    const note = noteIndisponible();
    expect(note).withContext('aucune trace de la panne au-dessus des onglets').not.toBeNull();
    expect(note?.querySelector('button')?.textContent?.trim()).toBe('Réessayer');
    expect(tuiles()).toEqual(['—', '—', '—', '—', '—']);
  }));

  it('commandes pas encore lues : « — » partout, et aucune panne annoncée', fakeAsync(() => {
    moteurs = () => NEVER;
    creer();

    expect(tuiles()).toEqual(['—', '—', '—', '—', '—']);
    expect(noteIndisponible()).toBeNull();
  }));

  it('commandes lues : les tuiles comptent, sans note de panne', fakeAsync(() => {
    moteurs = () => of([commande('FAILED'), commande('ACKNOWLEDGED')]);
    creer();

    // Vues sur 7 j · Coupures · Rallumages · Refusée en marche · Échec
    expect(tuiles()).toEqual(['2', '2', '0', '0', '1']);
    expect(noteIndisponible()).toBeNull();
  }));

  it('« Réessayer » relit les commandes : la note s’en va et les chiffres reviennent', fakeAsync(() => {
    moteurs = panne;
    creer();
    expect(noteIndisponible()).not.toBeNull();

    moteurs = () => of([commande('FAILED')]);
    noteIndisponible()!.querySelector('button')!.click();
    tick();
    fixture.detectChanges();

    expect(noteIndisponible()).toBeNull();
    expect(tuiles()[4]).toBe('1');
  }));

  it('une RELECTURE ratée garde la dernière liste : l’échec connu reste au bandeau, les tuiles disent « — »', fakeAsync(() => {
    moteurs = () => of([commande('FAILED')]);
    creer();
    expect(texte('.fa-alerte-titre')).toContain('1 commande moteur n');

    moteurs = panne;
    (fixture.nativeElement.querySelector('button.fa-refresh') as HTMLButtonElement).click();
    tick();
    fixture.detectChanges();

    expect(noteIndisponible()).not.toBeNull();
    expect(tuiles()).toEqual(['—', '—', '—', '—', '—']);
    // Avant, `engine.set([])` : la coupure en échec disparaissait du bandeau.
    expect(texte('.fa-alerte-chips')).toContain('GS-187-NY');
  }));
});

/**
 * ══ UNE COULEUR = UNE SIGNIFICATION, SUR LES DEUX ÉCRANS (revue du 29/09) ════════════════════
 *
 * Le même geste d'agenda s'affiche à deux endroits : le fil Agenda du client (ci-dessus,
 * `tonAction`) et /admin/activity (`agendaBadgeCls`). Chacun a son propre switch, et c'est
 * exactement ainsi que `reservation_retiree` (« Demande retirée par son auteur ») est tombé dans
 * les deux `default` : bleu « modification », à côté d'une « Réservation annulée » grise.
 *
 * Les deux méthodes n'utilisent pas `this` : on les appelle sur le prototype, sans monter les
 * composants.
 */
describe('Fil Agenda — le ton d’un geste est le même sur le fil client et sur /admin/activity', () => {
  type Ton = 'succes' | 'info' | 'attente' | 'alerte' | 'agent' | 'inactif';

  const tonClient = (action: string): Ton =>
    FleetActivityComponent.prototype['tonAction'].call(null, action) as Ton;
  const classeAdmin = (action: string): string =>
    AdminActivityComponent.prototype['agendaBadgeCls'].call(null, action);

  /** La traduction d'un ton du fil client en badge /admin — la légende commune des deux switchs. */
  const BADGE_DU_TON: Record<Ton, string> = {
    succes: 'bg-emerald-500/15 text-emerald-400',
    alerte: 'bg-rose-500/15 text-rose-400',
    attente: 'bg-amber-500/15 text-amber-400',
    agent: 'bg-fuchsia-500/15 text-fuchsia-400',
    inactif: 'bg-bg-tertiary text-fg-tertiary',
    info: 'bg-sky-500/15 text-sky-400',
  };

  it('🔴 « Demande retirée par son auteur » est un RETRAIT (gris), pas une modification (bleu)', () => {
    expect(tonClient('reservation_retiree')).toBe('inactif');
    expect(classeAdmin('reservation_retiree')).toBe(BADGE_DU_TON.inactif);
    // Même famille que sa voisine du fil : l'annulation.
    expect(tonClient('reservation_retiree')).toBe(tonClient('reservation_annulee'));
  });

  it('chaque code d’action d’agenda a la MÊME couleur sur les deux écrans', () => {
    const codes = Object.keys(AGENDA_ACTIVITY_ACTION_LABELS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(classeAdmin(code))
        .withContext(`« ${code} » : /admin/activity ne dit pas la même chose que le fil client`)
        .toBe(BADGE_DU_TON[tonClient(code)]);
    }
  });
});

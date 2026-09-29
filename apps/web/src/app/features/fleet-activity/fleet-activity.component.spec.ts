import { HttpErrorResponse } from '@angular/common/http';
import { signal, type WritableSignal } from '@angular/core';
import { fakeAsync, TestBed, tick, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import {
  AGENDA_ACTIVITY_ACTION_LABELS, type EngineCommandAuditDto, type FleetAgendaActivityDto,
} from '@vizyo/tracky-shared';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import { AiStatusService } from '../../core/services/ai-status.service';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AdminActivityComponent } from '../user-activity/admin-activity.component';
import { FleetActivityApiService } from './fleet-activity-api.service';
import { filAgendaVisible, FleetActivityComponent, PAGES_AGENDA_PAR_CLIC } from './fleet-activity.component';

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
        // 29/09 — statut IA simulé (le vrai lit HttpClient) : IA coupée, sans effet sur ces cas.
        { provide: AiStatusService, useValue: { enabled: signal(false), societeActive: signal(false), ensureLoaded: () => undefined } },
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

  it('« Propositions écartées en lot » (Réorganiser, 29/09) est un écart, gris comme l’écart à l’unité — pas une modification', () => {
    // La cohérence entre écrans ne le voyait pas : les deux tombaient dans le même `default` (bleu).
    expect(tonClient('propositions_ecartees')).toBe('inactif');
    expect(tonClient('propositions_ecartees')).toBe(tonClient('proposition_ecartee'));
    expect(classeAdmin('propositions_ecartees')).toBe(BADGE_DU_TON.inactif);
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

/**
 * ══ 29/09 — IA DÉSACTIVÉE PAR LA SOCIÉTÉ : PLUS AUCUN « PASSAGE DE L'AGENT » DANS LE FIL ═════════
 *
 * Demande du propriétaire : quand le client désactive l'IA, il ne doit plus en voir les options ni
 * les traces. L'agent d'agenda peut encore tourner côté serveur (ses passages déterministes) : c'est
 * le FIL qui ne les montre plus. Les gestes HUMAINS sur ses propositions (réservée, écartée) restent,
 * c'est l'historique. Le statut est un signal : l'IA réactivée, les passages reviennent sans relire.
 *
 * Tenu ici, lu sur le DOM :
 *   1. IA coupée : aucune ligne « Passage de l'agent », les gestes humains restent ;
 *   2. l'état vide ne promet plus « les propositions de l'agent » ;
 *   3. une page PLEINE de passages masqués n'est pas une impasse : l'état vide garde « Charger plus » ;
 *   4. (revue du 29/09) « Charger plus » ne rend jamais un clic sans effet visible : une page suivante
 *      faite uniquement de passages masqués enchaîne la suivante, dans une borne par clic.
 */
describe('29/09 — fil Agenda : IA de la société coupée, plus aucun passage de l’agent', () => {
  let fixture: ComponentFixture<FleetActivityComponent>;
  /** Interrupteur maître de la société (`AiStatusService.enabled`). */
  let iaActive: WritableSignal<boolean>;
  /** Pages servies par `GET /fleet-admin/activity/agenda`, dans l'ordre des appels. */
  let pages: FleetAgendaActivityDto[][];
  let appelsAgenda: { before?: string }[];

  /** Une ligne du fil comme la sert le serveur ; `minutes` = il y a combien de minutes. */
  const ligne = (
    id: string, action: string, minutes: number, actorKind: FleetAgendaActivityDto['actorKind'] = 'user',
  ): FleetAgendaActivityDto => ({
    id, at: new Date(Date.now() - minutes * 60_000).toISOString(),
    category: action === 'agenda_agent_run' ? 'AI' : action.startsWith('reservation') ? 'RESERVATION' : 'AGENDA',
    action, actionLabel: AGENDA_ACTIVITY_ACTION_LABELS[action] ?? action, status: 'SUCCESS',
    actorName: actorKind === 'agent' ? "Agent de l'agenda" : 'Joost Martin', actorKind,
    vehiclePlate: 'GS-187-NY', detail: null,
  });

  beforeEach(() => {
    iaActive = signal(false);
    pages = [[]];
    appelsAgenda = [];
  });
  afterEach(() => TestBed.resetTestingModule());

  const creer = (): void => {
    TestBed.configureTestingModule({
      imports: [FleetActivityComponent],
      providers: [
        {
          provide: FleetActivityApiService,
          useValue: {
            agenda: (opts: { before?: string }) => {
              appelsAgenda.push(opts);
              return of(pages[appelsAgenda.length - 1] ?? []);
            },
            engineCommands: () => of([]),
            online: () => of([]),
            feed: () => of([]),
          },
        },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, info: () => undefined } },
        { provide: AuthService, useValue: { user: () => ({ role: 'FLEET_ADMIN' }) } },
        { provide: FleetFilterService, useValue: { selectedFleetId: signal<string | null>(null) } },
        { provide: PermissionsService, useValue: {} },
        { provide: AiStatusService, useValue: { enabled: iaActive, societeActive: iaActive, ensureLoaded: () => undefined } },
      ],
    });
    fixture = TestBed.createComponent(FleetActivityComponent);
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
  };

  const texte = (sel: string): string =>
    (fixture.nativeElement.querySelector(sel) as HTMLElement | null)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  /** Les libellés d'action du fil, dans l'ordre affiché. */
  const actions = (): string[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.fa-ag-act') as NodeListOf<HTMLElement>)
      .map((e) => e.textContent?.trim() ?? '');

  it('filAgendaVisible : IA coupée → sans « agenda_agent_run » ; IA active → le fil entier, même ordre', () => {
    const fil = [
      ligne('a', 'agenda_agent_run', 1, 'agent'),
      ligne('b', 'proposition_reservee', 2),
      ligne('c', 'proposition_ecartee', 3),
      ligne('d', 'reservation_validee', 4),
      ligne('e', 'reglages_agent_modifies', 5),
    ];
    expect(filAgendaVisible(fil, false).map((l) => l.id)).toEqual(['b', 'c', 'd', 'e']);
    expect(filAgendaVisible(fil, true).map((l) => l.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(filAgendaVisible([], false)).toEqual([]);
  });

  it('🔴 IA coupée : aucun « Passage de l’agent » à l’écran ; les propositions réservée / écartée restent', fakeAsync(() => {
    pages = [[
      ligne('run', 'agenda_agent_run', 1, 'agent'),
      ligne('pr', 'proposition_reservee', 2),
      ligne('pe', 'proposition_ecartee', 3),
      ligne('rv', 'reservation_validee', 4),
    ]];
    creer();

    expect(actions()).toEqual([
      AGENDA_ACTIVITY_ACTION_LABELS['proposition_reservee'],
      AGENDA_ACTIVITY_ACTION_LABELS['proposition_ecartee'],
      AGENDA_ACTIVITY_ACTION_LABELS['reservation_validee'],
    ]);
    expect(fixture.nativeElement.textContent).not.toContain(AGENDA_ACTIVITY_ACTION_LABELS['agenda_agent_run']);

    // IA réactivée : le passage revient aussitôt, à sa place, sans relire le serveur.
    iaActive.set(true);
    fixture.detectChanges();
    expect(actions()[0]).toBe(AGENDA_ACTIVITY_ACTION_LABELS['agenda_agent_run']);
    expect(actions().length).toBe(4);
    expect(appelsAgenda.length).toBe(1);
  }));

  it('IA coupée, fil vide : l’état vide ne promet plus les propositions de l’agent', fakeAsync(() => {
    creer();
    expect(texte('.fa-colonne .zn-bloc')).toContain('Aucune action d');
    expect(texte('.fa-colonne .zn-bloc')).not.toContain('agent');

    iaActive.set(true);
    fixture.detectChanges();
    expect(texte('.fa-colonne .zn-bloc')).toContain("propositions de l'agent");
  }));

  it('🔴 IA coupée, une page PLEINE de passages de l’agent : pas d’impasse — « Charger plus » dans l’état vide', fakeAsync(() => {
    // 50 = la taille de page : le serveur a une suite, mais tout ce qu'il a servi est masqué.
    const passages = Array.from({ length: 50 }, (_, i) => ligne('run-' + i, 'agenda_agent_run', i + 1, 'agent'));
    pages = [passages, [ligne('ancien', 'reservation_validee', 90 * 24 * 60)]];
    creer();

    expect(texte('.fa-colonne .zn-titre')).toBe("Aucune action d'agenda récente");
    const plus = fixture.nativeElement.querySelector('.fa-colonne .zn-bloc button.fa-more') as HTMLButtonElement | null;
    expect(plus).withContext('état vide sans « Charger plus » : les gestes plus anciens sont inatteignables').not.toBeNull();

    plus!.click();
    tick();
    fixture.detectChanges();

    // Le curseur est la dernière ligne BRUTE lue (un passage masqué), pas la dernière affichée.
    expect(appelsAgenda[1]?.before).toBe(passages[49].at);
    expect(actions()).toEqual([AGENDA_ACTIVITY_ACTION_LABELS['reservation_validee']]);
    // Plus de suite : le bouton de l'état vide n'a plus lieu d'être, et le fil n'en montre pas.
    expect(fixture.nativeElement.querySelector('button.fa-more')).toBeNull();
  }));

  it('IA active : les passages de l’agent se lisent, et une page pleine n’est pas vide', fakeAsync(() => {
    iaActive = signal(true);
    pages = [Array.from({ length: 50 }, (_, i) => ligne('run-' + i, 'agenda_agent_run', i + 1, 'agent'))];
    creer();

    expect(actions().length).toBe(50);
    expect(fixture.nativeElement.querySelector('.fa-colonne .zn-bloc')).toBeNull();
  }));

  /** `n` passages de l'agent, du plus récent au plus ancien, à partir de `depuis` minutes. */
  const passages = (prefixe: string, n: number, depuis: number): FleetAgendaActivityDto[] =>
    Array.from({ length: n }, (_, i) => ligne(`${prefixe}-${i}`, 'agenda_agent_run', depuis + i, 'agent'));
  const boutonsPlus = (): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('button.fa-more') as NodeListOf<HTMLButtonElement>);

  it('🔴 IA coupée, fil rempli : la page suivante n’est faite que de passages masqués → le MÊME clic va jusqu’au geste suivant', fakeAsync(() => {
    // Revue du 29/09 : 1 geste + 49 passages, puis 50 passages — le clic lisait 50 lignes, n'en
    // affichait aucune, et l'écran restait identique, bouton compris.
    const p2 = passages('b', 50, 100);
    pages = [
      [ligne('h1', 'reservation_validee', 1), ...passages('a', 49, 2)],
      p2,
      [ligne('h2', 'reservation_annulee', 10_000)],
    ];
    creer();
    expect(actions()).toEqual([AGENDA_ACTIVITY_ACTION_LABELS['reservation_validee']]);
    expect(boutonsPlus().length).withContext('un seul « Charger plus » en état rempli').toBe(1);

    boutonsPlus()[0].click();
    tick();
    fixture.detectChanges();

    // Deux pages lues d'un seul clic, la seconde depuis la dernière ligne BRUTE de la première.
    expect(appelsAgenda.length).toBe(3);
    expect(appelsAgenda[2]?.before).toBe(p2[49].at);
    expect(actions()).toEqual([
      AGENDA_ACTIVITY_ACTION_LABELS['reservation_validee'],
      AGENDA_ACTIVITY_ACTION_LABELS['reservation_annulee'],
    ]);
    // La dernière page n'était pas pleine : plus de suite, plus de bouton.
    expect(boutonsPlus().length).toBe(0);
  }));

  it('IA coupée : la chaîne est BORNÉE par clic — le bouton reste, et le clic suivant reprend plus loin', fakeAsync(() => {
    // Des centaines de passages d'affilée : chaque clic lit au plus PAGES_AGENDA_PAR_CLIC pages.
    pages = [
      [ligne('h1', 'reservation_validee', 1), ...passages('a', 49, 2)],
      ...Array.from({ length: 2 * PAGES_AGENDA_PAR_CLIC }, (_, p) => passages('p' + p, 50, 100 + p * 50)),
      [ligne('h2', 'reservation_annulee', 100_000)],
    ];
    creer();

    boutonsPlus()[0].click();
    tick();
    fixture.detectChanges();
    expect(appelsAgenda.length).toBe(1 + PAGES_AGENDA_PAR_CLIC);
    expect(actions().length).toBe(1);
    expect(boutonsPlus().length).withContext('le serveur a encore une suite').toBe(1);

    boutonsPlus()[0].click();
    tick();
    fixture.detectChanges();
    expect(appelsAgenda.length).toBe(1 + 2 * PAGES_AGENDA_PAR_CLIC);

    boutonsPlus()[0].click();
    tick();
    fixture.detectChanges();
    expect(appelsAgenda.length).toBe(2 + 2 * PAGES_AGENDA_PAR_CLIC);
    expect(actions()).toEqual([
      AGENDA_ACTIVITY_ACTION_LABELS['reservation_validee'],
      AGENDA_ACTIVITY_ACTION_LABELS['reservation_annulee'],
    ]);
  }));

  it('IA active : une page de passages se VOIT — un clic, une page, comme avant', fakeAsync(() => {
    iaActive = signal(true);
    pages = [passages('a', 50, 1), passages('b', 50, 100), passages('c', 50, 200)];
    creer();

    boutonsPlus()[0].click();
    tick();
    fixture.detectChanges();
    expect(appelsAgenda.length).toBe(2);
    expect(actions().length).toBe(100);
  }));

  it('une page qui ne rapporte rien de NEUF (curseur qui se recouvre) arrête la chaîne : pas de relecture en boucle', fakeAsync(() => {
    const p1 = [ligne('h1', 'reservation_validee', 1), ...passages('a', 49, 2)];
    // Le serveur resservirait la même page : aucune ligne nouvelle, le curseur n'avance plus.
    pages = [p1, p1, p1, p1, p1, p1, p1];
    creer();

    boutonsPlus()[0].click();
    tick();
    fixture.detectChanges();
    expect(appelsAgenda.length).toBe(2);
    expect(actions().length).toBe(1);
  }));
});

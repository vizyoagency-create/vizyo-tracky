import { ComponentFixture, TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import {
  MiseEnServiceApi,
  type EtatAttenteDto,
  type ResolutionIdentifiantDto,
} from '../../../core/services/mise-en-service.service';
import { MiseEnServiceComponent } from './mise-en-service.component';

/**
 * Ce que ces tests couvrent : le PARCOURS a l'ecran, pas la logique serveur (deja testee).
 *
 * Ils existent parce que la session locale du navigateur retombe sur l'ecran de connexion
 * et que le panneau d'apercu ne composait pas d'image le jour ou ce composant a ete ecrit.
 * Cliquer a la main n'aurait rien laisse derriere ; ceci reste.
 */
const IMEI = '864035054799003';
const MSISDN = '+345901039990017';

function resolution(p: Partial<ResolutionIdentifiantDto> = {}): ResolutionIdentifiantDto {
  return {
    candidats: [{ type: 'imei', valeur: IMEI }],
    imei: IMEI,
    iccid: null,
    msisdn: MSISDN,
    simStatutId: 2,
    simStatutLibelle: 'Activée',
    trackerId: null,
    vehiculePlaque: null,
    flotteNom: null,
    frappeEnTcp: false,
    vuIlYaSecondes: null,
    voie: 'attente_tcp',
    message: 'Boîtier identifié.',
    ...p,
  };
}

const ATTENTE_VIDE: EtatAttenteDto = {
  connecte: false,
  encoreInconnu: false,
  derniereVueIso: null,
  positions: 0,
  statut: 'OFFLINE',
};

describe('MiseEnServiceComponent — le parcours a l’ecran', () => {
  let fixture: ComponentFixture<MiseEnServiceComponent>;
  let api: jasmine.SpyObj<MiseEnServiceApi>;

  const texte = () => (fixture.nativeElement as HTMLElement).innerText.replace(/\s+/g, ' ');

  beforeEach(async () => {
    api = jasmine.createSpyObj<MiseEnServiceApi>('MiseEnServiceApi', [
      'resoudre', 'rattacher', 'attente', 'prendreVerrou', 'rendreVerrou', 'forcerVerrou',
    ]);
    api.prendreVerrou.and.returnValue(of({
      libre: false, parMoi: true, detenteurNom: 'Moi', detenteurEmail: 'moi@x.fr',
      contexte: null, depuisSecondes: 0, expireDansSecondes: 90,
    }));
    api.rendreVerrou.and.returnValue(of({
      libre: true, parMoi: false, detenteurNom: null, detenteurEmail: null,
      contexte: null, depuisSecondes: null, expireDansSecondes: null,
    }));

    await TestBed.configureTestingModule({
      imports: [MiseEnServiceComponent],
      providers: [
        { provide: MiseEnServiceApi, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ role: 'FLEET_ADMIN' }) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MiseEnServiceComponent);
    fixture.componentRef.setInput('vehicleId', 'v-1');
    fixture.componentRef.setInput('plaque', 'AH-001-TS');
    fixture.detectChanges();
  });

  it('propose le scan et la saisie, sans jargon', () => {
    expect(texte()).toContain('Scannez');
    expect(texte()).toContain('Identifier le boîtier');
    // La sortie doit etre NOMMEE : « passer » seul ne dit pas ce qu'on passe.
    expect(texte()).toContain("Le boîtier n'est pas encore posé");
  });

  it('affiche l’identite trouvee — IMEI, SIM et statut', async () => {
    api.resoudre.and.returnValue(of(resolution()));
    (fixture.componentInstance as unknown as { code: string }).code = IMEI;
    await (fixture.componentInstance as unknown as { resoudre(): Promise<void> }).resoudre();
    fixture.detectChanges();

    expect(texte()).toContain(IMEI);
    expect(texte()).toContain(MSISDN);
    expect(texte()).toContain('Activée');
    expect(texte()).toContain('Rattacher à AH-001-TS');
  });

  it('⚠️ une puce en stock ne propose PAS de rattacher — elle explique quoi faire', async () => {
    api.resoudre.and.returnValue(of(resolution({ voie: 'sim_a_activer', imei: null, message: 'Puce non activée.' })));
    (fixture.componentInstance as unknown as { code: string }).code = MSISDN;
    await (fixture.componentInstance as unknown as { resoudre(): Promise<void> }).resoudre();
    fixture.detectChanges();

    expect(texte()).not.toContain('Rattacher à');
    expect(texte()).toContain('Activez la puce');
  });

  it('boitier deja rattache : refus explicite, pas de bouton', async () => {
    api.resoudre.and.returnValue(of(resolution({ voie: 'deja_rattache', message: 'Déjà utilisé.' })));
    (fixture.componentInstance as unknown as { code: string }).code = IMEI;
    await (fixture.componentInstance as unknown as { resoudre(): Promise<void> }).resoudre();
    fixture.detectChanges();

    expect(texte()).not.toContain('Rattacher à');
    expect(texte()).toContain('Détachez-le');
  });

  it('boitier deja en ligne : succes immediat, sans passer par l’attente', async () => {
    api.resoudre.and.returnValue(of(resolution({ voie: 'rattacher_maintenant' })));
    api.rattacher.and.returnValue(of({
      trackerId: 't-1', imei: IMEI, cree: true, vehiculePlaque: 'AH-001-TS', connecteDejaVu: true,
    }));
    api.attente.and.returnValue(of({ ...ATTENTE_VIDE, connecte: true, positions: 2, statut: 'ONLINE' }));

    const c = fixture.componentInstance as unknown as { code: string; resoudre(): Promise<void>; rattacher(): Promise<void> };
    c.code = IMEI;
    await c.resoudre();
    await c.rattacher();
    fixture.detectChanges();

    expect(texte()).toContain('Boîtier rattaché à AH-001-TS');
    expect(texte()).toContain('2 positions');
  });
});

/**
 * ── LE COMPTEUR N'EST PAS DECORATIF ──────────────────────────────────────────────────
 *
 * Soixante secondes d'ecran fige se lisent comme un plantage, et l'installateur recharge
 * la page au milieu de l'operation. Ces tests verrouillent que le compteur DESCEND, que
 * la phrase CHANGE, et que l'attente sait dire quand elle est vaine.
 */
describe('MiseEnServiceComponent — l’attente de 60 secondes', () => {
  let fixture: ComponentFixture<MiseEnServiceComponent>;
  let api: jasmine.SpyObj<MiseEnServiceApi>;
  const texte = () => (fixture.nativeElement as HTMLElement).innerText.replace(/\s+/g, ' ');

  async function entrerEnAttente(attente: EtatAttenteDto = ATTENTE_VIDE) {
    api.resoudre.and.returnValue(of(resolution()));
    api.rattacher.and.returnValue(of({
      trackerId: 't-1', imei: IMEI, cree: true, vehiculePlaque: 'AH-001-TS', connecteDejaVu: false,
    }));
    api.attente.and.returnValue(of(attente));
    const c = fixture.componentInstance as unknown as { code: string; resoudre(): Promise<void>; rattacher(): Promise<void> };
    c.code = IMEI;
    await c.resoudre();
    await c.rattacher();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    api = jasmine.createSpyObj<MiseEnServiceApi>('MiseEnServiceApi', [
      'resoudre', 'rattacher', 'attente', 'prendreVerrou', 'rendreVerrou', 'forcerVerrou',
    ]);
    api.prendreVerrou.and.returnValue(of({
      libre: false, parMoi: true, detenteurNom: 'Moi', detenteurEmail: 'moi@x.fr',
      contexte: null, depuisSecondes: 0, expireDansSecondes: 90,
    }));
    api.rendreVerrou.and.returnValue(of({
      libre: true, parMoi: false, detenteurNom: null, detenteurEmail: null,
      contexte: null, depuisSecondes: null, expireDansSecondes: null,
    }));
    await TestBed.configureTestingModule({
      imports: [MiseEnServiceComponent],
      providers: [
        { provide: MiseEnServiceApi, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ role: 'SUPER_ADMIN' }) } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MiseEnServiceComponent);
    fixture.componentRef.setInput('vehicleId', 'v-1');
    fixture.componentRef.setInput('plaque', 'AH-001-TS');
    fixture.detectChanges();
  });

  it('affiche 60 s, puis DESCEND', fakeAsync(async () => {
    await entrerEnAttente();
    expect(texte()).toContain('60');

    tick(5000);
    fixture.detectChanges();
    expect(texte()).toContain('55');

    discardPeriodicTasks();
  }));

  it('la phrase change au fil de l’attente — un texte fige cesse d’etre lu', fakeAsync(async () => {
    await entrerEnAttente();
    expect(texte()).toContain('On écoute le boîtier');

    tick(25_000);
    fixture.detectChanges();
    expect(texte()).toContain('réémet toutes les 30 secondes');

    tick(20_000);
    fixture.detectChanges();
    expect(texte()).toContain('Dernières secondes');

    discardPeriodicTasks();
  }));

  it('dit que la fenetre peut etre fermee — l’installateur n’est pas retenu', fakeAsync(async () => {
    await entrerEnAttente();
    expect(texte()).toContain('vous pouvez fermer cette fenêtre');
    discardPeriodicTasks();
  }));

  it('⚠️ boitier encore INCONNU apres rattachement : on arrete tout de suite', fakeAsync(async () => {
    // L'IMEI declare n'est pas celui du boitier. Continuer d'afficher « on ecoute »
    // ferait attendre soixante secondes pour rien, puis accuserait le materiel.
    await entrerEnAttente({ ...ATTENTE_VIDE, encoreInconnu: true });
    tick(3100);
    fixture.detectChanges();
    expect(texte()).toContain('AUTRE identifiant');
    discardPeriodicTasks();
  }));

  it('au bout des 60 s : echec NOMME, et le boitier reste declare', fakeAsync(async () => {
    await entrerEnAttente();
    tick(61_000);
    fixture.detectChanges();
    expect(texte()).toContain("ne s'est pas connecté en 60 secondes");
    // Le message doit rassurer : rien n'est perdu, le rattachement se fera tout seul.
    expect(texte()).toContain('il sera rattaché tout seul');
    discardPeriodicTasks();
  }));

  it('le verrou est pris pendant l’attente, et rendu a la sortie', fakeAsync(async () => {
    await entrerEnAttente();
    expect(api.prendreVerrou).toHaveBeenCalled();
    tick(61_000);
    fixture.detectChanges();
    // Garder le verrou apres coup bloquerait le poste suivant 90 s pour rien.
    expect(api.rendreVerrou).toHaveBeenCalled();
    discardPeriodicTasks();
  }));
});

describe('MiseEnServiceComponent — quand ca casse', () => {
  it('une resolution en erreur affiche le message du serveur, pas « erreur »', async () => {
    const api = jasmine.createSpyObj<MiseEnServiceApi>('MiseEnServiceApi', [
      'resoudre', 'rattacher', 'attente', 'prendreVerrou', 'rendreVerrou', 'forcerVerrou',
    ]);
    api.resoudre.and.returnValue(
      throwError(() => ({ error: { error: { message: 'Code trop long pour être un identifiant.' } } })),
    );
    await TestBed.configureTestingModule({
      imports: [MiseEnServiceComponent],
      providers: [
        { provide: MiseEnServiceApi, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ role: 'FLEET_ADMIN' }) } },
      ],
    }).compileComponents();
    const f = TestBed.createComponent(MiseEnServiceComponent);
    f.componentRef.setInput('vehicleId', 'v-1');
    f.detectChanges();

    const c = f.componentInstance as unknown as { code: string; resoudre(): Promise<void> };
    c.code = IMEI;
    await c.resoudre();
    f.detectChanges();

    expect((f.nativeElement as HTMLElement).innerText).toContain('Code trop long');
  });
});

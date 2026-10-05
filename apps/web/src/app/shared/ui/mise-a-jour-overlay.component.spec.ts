import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { AssistanceApiService } from '../../core/services/assistance.service';
import { AuthService } from '../../core/services/auth.service';
import { MiseAJourEnCoursService } from '../../core/services/mise-a-jour-en-cours.service';
import { MiseAJourOverlayComponent } from './mise-a-jour-overlay.component';

/**
 * ══ L'ÉCRAN « MISE À JOUR EN COURS » ET LA LIGNE D'URGENCE ═══════════════════════════════════
 *
 * Cet écran ne s'affiche que quand l'API ne répond plus — c'est-à-dire au moment exact où un
 * signalement envoyé au serveur échoue. Le lien WhatsApp qu'il porte est pourtant le seul geste
 * utile de l'écran, et celui qu'un super-admin voudra retrouver au lendemain d'un incident.
 *
 * D'où deux promesses : l'appui est signalé (et retenu par le service si l'API est à terre), et
 * il est retransmis dès qu'une session existe — y compris au rechargement que l'écran déclenche
 * lui-même au retour de l'API.
 */
describe('MiseAJourOverlayComponent — la ligne d’urgence pendant une panne', () => {
  let fixture: ComponentFixture<MiseAJourOverlayComponent>;
  let assistance: jasmine.SpyObj<Pick<AssistanceApiService, 'signalerUrgenceWhatsapp' | 'retransmettreAppuiRetenu'>>;
  const connecte = signal(true);

  const creer = (): void => {
    assistance = jasmine.createSpyObj('AssistanceApiService', ['signalerUrgenceWhatsapp', 'retransmettreAppuiRetenu']);
    TestBed.configureTestingModule({
      imports: [MiseAJourOverlayComponent],
      providers: [
        { provide: AssistanceApiService, useValue: assistance },
        { provide: AuthService, useValue: { isAuthenticated: connecte } },
        { provide: MiseAJourEnCoursService, useValue: { indisponible: signal(true), horsLigne: signal(false) } },
      ],
    });
    fixture = TestBed.createComponent(MiseAJourOverlayComponent);
    fixture.detectChanges();
  };

  afterEach(() => {
    connecte.set(true);
    TestBed.resetTestingModule();
  });

  it('🔴 l’appui sur WhatsApp est signalé depuis l’écran de mise à jour — sans retenir le clic', () => {
    creer();
    const a = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a.maj-secours');
    expect(a?.getAttribute('href')).toContain('wa.me');

    let retenuParLeComposant = true;
    const garde = (ev: Event): void => {
      retenuParLeComposant = ev.defaultPrevented;
      ev.preventDefault(); // le test ne quitte pas la page ; le composant, lui, ne doit rien empêcher
    };
    document.addEventListener('click', garde);
    try {
      a!.click();
    } finally {
      document.removeEventListener('click', garde);
    }

    expect(assistance.signalerUrgenceWhatsapp).toHaveBeenCalledOnceWith('mise-a-jour');
    expect(retenuParLeComposant).toBeFalse();
    expect(a!.hasAttribute('data-no-track')).toBeTrue();
  });

  // L'effet appartient à la VUE du composant : `fixture.detectChanges()` le rejoue. (`TestBed.tick()`
  // juste après un `signal.set()` hors zone déclenchait NG0101 dans ce banc — un artefact du test,
  // pas du composant : l'application, elle, ne pilote jamais un tick à la main.)
  it('🔴 un appui retenu repart dès le démarrage quand une session existe', () => {
    creer();
    expect(assistance.retransmettreAppuiRetenu).toHaveBeenCalledTimes(1);
  });

  it('sans session, rien ne repart… jusqu’à la connexion', () => {
    connecte.set(false);
    creer();
    expect(assistance.retransmettreAppuiRetenu).not.toHaveBeenCalled();

    connecte.set(true);
    fixture.detectChanges();
    expect(assistance.retransmettreAppuiRetenu).toHaveBeenCalledTimes(1);
  });
});

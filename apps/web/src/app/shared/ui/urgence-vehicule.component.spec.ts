import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { CONTACT_TEL_AFFICHE, CONTACT_TEL_E164 } from '@vizyo/tracky-shared';
import { AssistanceApiService } from '../../core/services/assistance.service';
import { UrgenceVehiculeComponent } from './urgence-vehicule.component';

/**
 * ══ LA LIGNE D'URGENCE — CE QUI DOIT RESTER VRAI ═════════════════════════════════════════════
 *
 * Trois propriétés, et chacune répare une erreur réelle :
 *
 *   1. LE NUMÉRO AFFICHÉ EST CELUI DE LA SOURCE UNIQUE. Le 27/09/2026 un numéro FAUX est parti
 *      en production sur l'écran de mise à jour ; il avait été recopié depuis un exemple en
 *      commentaire. Un test qui compare l'écran à la constante rend la recopie visible.
 *   2. LE BANDEAU EXISTE, et il porte le même numéro que la carte. C'est la seule forme que
 *      voit le VEILLEUR DE NUIT — enfermé sur /vehicles, il n'atteint pas l'écran Assistance.
 *   3. LA FRONTIÈRE EST ÉCRITE. Une ligne d'astreinte qui se remplit de questions cesse de
 *      répondre la nuit ; la carte doit dire à quoi elle sert ET à quoi elle ne sert pas.
 */
describe('UrgenceVehiculeComponent — la ligne d’astreinte véhicule', () => {
  let fixture: ComponentFixture<UrgenceVehiculeComponent>;
  let assistance: jasmine.SpyObj<Pick<AssistanceApiService, 'signalerUrgenceWhatsapp'>>;

  const creer = (variante: 'complet' | 'bandeau', plaque?: string): void => {
    assistance = jasmine.createSpyObj('AssistanceApiService', ['signalerUrgenceWhatsapp']);
    TestBed.configureTestingModule({
      imports: [UrgenceVehiculeComponent],
      providers: [{ provide: AssistanceApiService, useValue: assistance }],
    });
    fixture = TestBed.createComponent(UrgenceVehiculeComponent);
    fixture.componentRef.setInput('variante', variante);
    if (plaque) fixture.componentRef.setInput('plaque', plaque);
    fixture.detectChanges();
  };

  const texte = (): string => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const liens = (): HTMLAnchorElement[] =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a'));

  afterEach(() => TestBed.resetTestingModule());

  it('🔴 la carte affiche EXACTEMENT le numéro de la source unique', () => {
    creer('complet');
    expect(texte()).toContain(CONTACT_TEL_AFFICHE);
  });

  it('🔴 le bandeau du veilleur affiche le MÊME numéro — c’est sa seule page', () => {
    creer('bandeau');
    expect(texte()).toContain(CONTACT_TEL_AFFICHE);
    expect(liens().length).withContext('le bandeau doit être cliquable, pas décoratif').toBe(1);
  });

  it('le lien WhatsApp porte le numéro international', () => {
    creer('complet');
    const href = liens().map((a) => a.getAttribute('href') ?? '');
    const sansPlus = CONTACT_TEL_E164.replace('+', '');
    expect(href.some((h) => h.startsWith(`https://wa.me/${sansPlus}`)))
      .withContext(`wa.me manquant ou mal formé dans ${href.join(' | ')}`)
      .toBeTrue();
  });

  /**
   * 🔴 UN SEUL CANAL D'URGENCE, ET C'EST WHATSAPP.
   *
   * Un bouton « Appeler » a existé ici quelques heures. Il a été retiré le 30/09/2026 quand la
   * fiche remise au client a été arrêtée sur « WhatsApp uniquement ». Ce test existe pour que
   * personne ne le remette sans rouvrir la fiche : deux promesses différentes pour le même
   * numéro, c'est la garantie qu'une des deux sera fausse — et celle qu'on vérifie le moins est
   * toujours celle qui est à l'écran.
   */
  it('🔴 aucun lien tel: — la fiche remise au client dit « WhatsApp uniquement »', () => {
    creer('complet');
    const href = liens().map((a) => a.getAttribute('href') ?? '');
    expect(href.filter((h) => h.startsWith('tel:')))
      .withContext('si le téléphone revient, la fiche PDF doit être refaite en même temps')
      .toEqual([]);
  });

  it('la fiche imprimable est atteignable depuis le bloc', () => {
    creer('complet');
    const href = liens().map((a) => a.getAttribute('href') ?? '');
    expect(href).toContain('/fiche-urgence-nuit.html');
  });

  it('pour une question, l’écran donne une sortie écrite (courriel)', () => {
    creer('complet');
    const href = liens().map((a) => a.getAttribute('href') ?? '');
    expect(href.some((h) => h.startsWith('mailto:'))).toBeTrue();
  });

  it('le message WhatsApp demande la PLAQUE — sans elle, l’astreinte perd un aller-retour', () => {
    creer('complet');
    const wa = liens().map((a) => a.getAttribute('href') ?? '').find((h) => h.includes('wa.me')) ?? '';
    expect(decodeURIComponent(wa)).toContain('plaque');
  });

  it('quand l’écran connaît la plaque, elle est pré-remplie', () => {
    creer('complet', 'GS-187-NY');
    const wa = liens().map((a) => a.getAttribute('href') ?? '').find((h) => h.includes('wa.me')) ?? '';
    expect(decodeURIComponent(wa)).toContain('GS-187-NY');
  });

  it('🔴 la carte dit à quoi la ligne NE sert PAS — sinon elle cesse de répondre la nuit', () => {
    creer('complet');
    const t = texte();
    expect(t).toContain('véhicules immobilisés');
    expect(t)
      .withContext('la frontière doit être justifiée, pas seulement décrétée')
      .toContain('laissez la ligne libre');
  });

  it('les liens externes s’ouvrent sans exposer la page appelante', () => {
    creer('complet');
    const externes = liens().filter((a) => (a.getAttribute('href') ?? '').startsWith('http'));
    expect(externes.length).toBeGreaterThan(0);
    for (const a of externes) expect(a.getAttribute('rel')).toContain('noopener');
  });

  // ─── L'appui est signalé (01/10/2026) — sans jamais retenir le geste ────────────────────────

  const lienWhatsapp = (): HTMLAnchorElement => {
    const a = liens().find((l) => (l.getAttribute('href') ?? '').includes('wa.me'));
    if (!a) throw new Error('lien WhatsApp absent');
    return a;
  };

  /**
   * Clique comme un doigt, mais sans quitter la page du test : un écouteur posé sur `document`
   * passe APRÈS celui du composant, lit si le composant a empêché la navigation, puis l'empêche
   * lui-même. Renvoie `true` si le COMPOSANT a retenu le clic.
   */
  const cliquer = (a: HTMLAnchorElement): boolean => {
    let retenuParLeComposant = true;
    const garde = (ev: Event): void => {
      retenuParLeComposant = ev.defaultPrevented;
      ev.preventDefault();
    };
    document.addEventListener('click', garde);
    try {
      a.click();
    } finally {
      document.removeEventListener('click', garde);
    }
    return retenuParLeComposant;
  };

  it('🔴 l’appui sur le bandeau du veilleur est signalé, depuis la liste des véhicules', () => {
    creer('bandeau');
    cliquer(lienWhatsapp());
    expect(assistance.signalerUrgenceWhatsapp).toHaveBeenCalledOnceWith('vehicules', undefined);
  });

  it('l’appui sur la carte est signalé avec la plaque que l’écran connaît', () => {
    creer('complet', 'GS-187-NY');
    cliquer(lienWhatsapp());
    expect(assistance.signalerUrgenceWhatsapp).toHaveBeenCalledOnceWith('assistance', 'GS-187-NY');
  });

  it('🔴 le signalement ne RETIENT jamais le clic : WhatsApp s’ouvre dans le même geste', () => {
    for (const variante of ['bandeau', 'complet'] as const) {
      creer(variante);
      expect(cliquer(lienWhatsapp())).withContext(variante).toBeFalse();
      TestBed.resetTestingModule();
    }
  });

  it('les liens WhatsApp échappent à la capture automatique — la trace vient du serveur, pas en double', () => {
    for (const variante of ['bandeau', 'complet'] as const) {
      creer(variante);
      expect(lienWhatsapp().hasAttribute('data-no-track')).withContext(variante).toBeTrue();
      TestBed.resetTestingModule();
    }
  });

  it('les autres liens (fiche, courriel) ne déclenchent aucun signalement', () => {
    creer('complet');
    for (const a of liens().filter((l) => !(l.getAttribute('href') ?? '').includes('wa.me'))) cliquer(a);
    expect(assistance.signalerUrgenceWhatsapp).not.toHaveBeenCalled();
  });
});

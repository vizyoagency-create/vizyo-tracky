import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { CONTACT_TEL_AFFICHE, CONTACT_TEL_E164 } from '@vizyo/tracky-shared';
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

  const creer = (variante: 'complet' | 'bandeau', plaque?: string): void => {
    TestBed.configureTestingModule({ imports: [UrgenceVehiculeComponent] });
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

  it('WhatsApp et téléphone pointent tous deux sur le numéro international', () => {
    creer('complet');
    const href = liens().map((a) => a.getAttribute('href') ?? '');
    const sansPlus = CONTACT_TEL_E164.replace('+', '');
    expect(href.some((h) => h.startsWith(`https://wa.me/${sansPlus}`)))
      .withContext(`wa.me manquant ou mal formé dans ${href.join(' | ')}`)
      .toBeTrue();
    expect(href).toContain(`tel:${CONTACT_TEL_E164}`);
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
      .toContain('laisse la ligne libre');
  });

  it('les liens externes s’ouvrent sans exposer la page appelante', () => {
    creer('complet');
    const externes = liens().filter((a) => (a.getAttribute('href') ?? '').startsWith('http'));
    expect(externes.length).toBeGreaterThan(0);
    for (const a of externes) expect(a.getAttribute('rel')).toContain('noopener');
  });
});

import { TestBed } from '@angular/core/testing';
import { BANDES_VITESSE } from '../../utils/couleurs-carte';
import { LegendeVitesseComponent } from './legende-vitesse.component';

/**
 * La légende ne fait qu'une chose : afficher la table telle qu'elle est. Si la table
 * change, la légende change avec elle — c'est tout l'intérêt, et c'est ce qui est prouvé.
 */
describe('LegendeVitesseComponent', () => {
  /** `[style.background]` est relu normalisé par le navigateur : on compare en rgb. */
  const rgb = (hex: string): string => {
    const n = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    return `rgb(${r}, ${g}, ${b})`;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LegendeVitesseComponent] });
  });

  it('affiche une entrée par bande, dans l’ordre de la table, avec son libellé et sa couleur', () => {
    const fixture = TestBed.createComponent(LegendeVitesseComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    const items = Array.from(el.querySelectorAll('.lv-item'));
    expect(items.length).toBe(BANDES_VITESSE.length);
    items.forEach((item, i) => {
      expect(item.querySelector('.lv-libelle')?.textContent?.trim()).toBe(BANDES_VITESSE[i].libelle);
      const pastille = item.querySelector<HTMLElement>('.lv-pastille')!;
      expect(pastille.style.background).toBe(rgb(BANDES_VITESSE[i].couleur));
    });
  });

  it('la cinquième bande, « plus de 140 km/h », est bien là — celle que les légendes manuscrites oubliaient', () => {
    const fixture = TestBed.createComponent(LegendeVitesseComponent);
    fixture.detectChanges();

    const libelles = Array.from(fixture.nativeElement.querySelectorAll('.lv-libelle')).map((e) => (e as HTMLElement).textContent?.trim());
    expect(libelles).toContain('Plus de 140 km/h');
  });

  it('passe en grille sur demande, liste sinon', () => {
    const fixture = TestBed.createComponent(LegendeVitesseComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.lv--grille')).toBeNull();

    fixture.componentRef.setInput('disposition', 'grille');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.lv--grille')).not.toBeNull();

    fixture.componentRef.setInput('disposition', 'ligne');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.lv--grille')).toBeNull();
    expect(fixture.nativeElement.querySelector('.lv--ligne')).not.toBeNull();
  });
});

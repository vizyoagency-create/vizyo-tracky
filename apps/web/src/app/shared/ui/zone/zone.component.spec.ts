import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ZoneComponent, type EtatZone } from './zone.component';

/**
 * ── LA DÉMONSTRATION DES SIX ÉTATS ──────────────────────────────────────────────────
 *
 * Critère de recette du lot B-kit : « un composant démontre ses 6 états ». Ces tests
 * SONT cette démonstration — et ils tiennent lieu de garde-fou, ce qu'une page de
 * démonstration ne fait pas : une page se regarde une fois, un test se relance.
 *
 * Ce qu'ils empêchent, précisément :
 *   · qu'un état non nominal redevienne un écran muet — chaque cas vérifie qu'une
 *     PHRASE est rendue, pas seulement un pictogramme ;
 *   · qu'une erreur perde son recours ;
 *   · que « interdit » redevienne un masquage silencieux, alors que c'est le manque
 *     le plus coûteux : un bouton disparu produit un ticket de support ;
 *   · que le squelette pulse indéfiniment sans offrir de sortie.
 */
@Component({
  standalone: true,
  imports: [ZoneComponent],
  template: `
    <app-zone
      [etat]="etat()"
      quoi="l'historique"
      vide="Aucun trajet sur la période"
      videDetail="Élargissez la période ou changez de véhicule."
      partiel="Les scores de conduite manquent."
      permission="engine_control">
      <p class="contenu-reel">42 trajets</p>
    </app-zone>
  `,
})
class HoteTest {
  readonly etat = signal<EtatZone>('rempli');
}

describe('ZoneComponent — les 6 états obligatoires', () => {
  let fixture: ComponentFixture<HoteTest>;
  let hote: HoteTest;

  const texte = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const rendre = (etat: EtatZone) => {
    hote.etat.set(etat);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HoteTest],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(HoteTest);
    hote = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('rempli — le contenu projeté, et rien d\'autre', () => {
    rendre('rempli');
    expect(fixture.nativeElement.querySelector('.contenu-reel')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.zn-bloc')).toBeNull();
    expect(fixture.nativeElement.querySelector('.zn-partiel')).toBeNull();
  });

  it('chargement — un squelette, jamais un rond tournant', () => {
    rendre('chargement');
    // Règle du kit : « jamais un rond tournant seul au centre d'une page ».
    expect(fixture.nativeElement.querySelectorAll('app-skeleton').length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('app-spinner')).toBeNull();
    expect(fixture.nativeElement.querySelector('.contenu-reel')).toBeNull();
  });

  it('chargement — au-delà de 8 s, une sortie remplace le squelette', fakeAsync(() => {
    rendre('chargement');
    expect(fixture.nativeElement.querySelectorAll('app-skeleton').length).toBeGreaterThan(0);

    tick(8_000);
    fixture.detectChanges();

    // Le squelette a cédé la place : « l'utilisateur doit pouvoir abandonner ».
    expect(fixture.nativeElement.querySelectorAll('app-skeleton').length).toBe(0);
    expect(texte()).toContain('met plus de temps que prévu');
    const boutons = [...fixture.nativeElement.querySelectorAll('button')].map((b: HTMLElement) => b.textContent?.trim());
    expect(boutons).toContain('Réessayer');
    expect(boutons).toContain('Abandonner');
  }));

  it('vide — dit CE QUI est vide, et quoi faire', () => {
    rendre('vide');
    expect(texte()).toContain('Aucun trajet sur la période');
    expect(texte()).toContain('Élargissez la période');
    // Un état vide sans explication ressemble à un chargement qui n'a jamais fini.
    expect(fixture.nativeElement.querySelector('.zn-texte')).toBeTruthy();
  });

  it('erreur — porte toujours un recours', () => {
    rendre('erreur');
    expect(texte()).toContain('a échoué');
    const boutons = [...fixture.nativeElement.querySelectorAll('button')].map((b: HTMLElement) => b.textContent?.trim());
    expect(boutons).toContain('Réessayer');
    // Le bloc est annoncé aux lecteurs d'écran : une erreur qui n'interrompt pas
    // n'est pas lue du tout.
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('partiel — le contenu RESTE, un bandeau nomme ce qui manque', () => {
    rendre('partiel');
    // Masquer un contenu incomplet reviendrait à traiter une donnée manquante comme
    // une panne : « mieux vaut un tiret expliqué qu'un 0 faux ».
    expect(fixture.nativeElement.querySelector('.contenu-reel')).toBeTruthy();
    expect(texte()).toContain('Les scores de conduite manquent');
  });

  it('interdit — NOMME la permission, avec le libellé de la source partagée', () => {
    rendre('interdit');
    // `engine_control` → « Couper / redémarrer le moteur ». Le libellé vient de
    // PERMISSION_LABELS : une chaîne recopiée dériverait le jour où le libellé change.
    expect(texte()).toContain('Couper / redémarrer le moteur');
    expect(texte()).toContain('Un administrateur de la flotte peut vous l\'accorder');
    expect(fixture.nativeElement.querySelector('.contenu-reel')).toBeNull();
  });

  it('aucun des six états n\'est muet — chacun se lit ou s\'annonce', () => {
    const etats: EtatZone[] = ['rempli', 'vide', 'erreur', 'partiel', 'interdit'];
    for (const e of etats) {
      rendre(e);
      const t = texte().replace(/\s+/g, ' ').trim();
      expect(t.length).withContext(`l'état « ${e} » ne rend aucun texte`).toBeGreaterThan(0);
    }

    // Le chargement est la seule exception, et elle est VOULUE : un squelette n'a pas
    // de texte, c'est sa raison d'être — il dessine la forme du contenu à venir. Il
    // doit en revanche s'ANNONCER, sans quoi un lecteur d'écran ne dit rien pendant
    // toute l'attente.
    rendre('chargement');
    const zone = fixture.nativeElement.querySelector('[role="status"]') as HTMLElement | null;
    expect(zone).withContext('le squelette ne s\'annonce pas aux lecteurs d\'écran').toBeTruthy();
    expect(zone?.getAttribute('aria-label')).toContain('l\'historique');
  });
});

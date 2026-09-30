import { TestBed } from '@angular/core/testing';
import { ConfirmModalComponent } from './confirm-modal.component';

describe('ConfirmModalComponent — confirmation par glissement', () => {
  it('ne confirme pas un geste incomplet et remet le curseur au départ', () => {
    const fixture = TestBed.createComponent(ConfirmModalComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('title', 'Couper le moteur ?');
    fixture.componentRef.setInput('slideToConfirm', true);
    fixture.detectChanges();

    const confirmed = jasmine.createSpy('confirmed');
    fixture.componentInstance.confirmed.subscribe(confirmed);
    const slider = fixture.nativeElement.querySelector('input[type="range"]') as HTMLInputElement;
    slider.dispatchEvent(new Event('pointerdown'));
    slider.value = '75';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(confirmed).not.toHaveBeenCalled();
    expect(slider.value).toBe('0');
  });

  /** Un vrai geste au POINTEUR : appui, le pouce traverse la piste par paliers, relâché (`change`). */
  function glisser(slider: HTMLInputElement, valeurs: number[]) {
    slider.dispatchEvent(new Event('pointerdown'));
    for (const v of valeurs) {
      slider.value = String(v);
      slider.dispatchEvent(new Event('input'));
    }
    slider.dispatchEvent(new Event('change'));
  }

  function monter(title: string) {
    const fixture = TestBed.createComponent(ConfirmModalComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('title', title);
    fixture.componentRef.setInput('slideToConfirm', true);
    fixture.detectChanges();
    const confirmed = jasmine.createSpy('confirmed');
    fixture.componentInstance.confirmed.subscribe(confirmed);
    const slider = fixture.nativeElement.querySelector('input[type="range"]') as HTMLInputElement;
    return { fixture, confirmed, slider };
  }

  it('confirme une seule fois lorsque le doigt atteint la fin — par un GESTE continu', () => {
    const { fixture, confirmed, slider } = monter('Rallumer le moteur ?');
    glisser(slider, [2, 11, 23, 36, 48, 61, 74, 87, 95, 100]);
    fixture.detectChanges();

    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  /**
   * ── T50 (contre-expertise du 13/09, P2-3) — un clic ou une touche ne sont pas un geste ────────
   * Un range natif saute au point cliqué : `change` à 100 sans glissement confirmait une coupure
   * moteur. Le spec précédent fixait la valeur programmatiquement et ne le voyait pas.
   */
  it('T50 : un CLIC en bout de piste (une seule valeur, 100) ne confirme RIEN et remet le curseur au départ', () => {
    const { fixture, confirmed, slider } = monter('Couper le moteur ?');
    glisser(slider, [100]);
    fixture.detectChanges();

    expect(confirmed).not.toHaveBeenCalled();
    expect(slider.value).toBe('0');
  });

  it('T50 : un geste qui part du milieu (clic puis petit glissement) ne confirme pas non plus', () => {
    const { confirmed, slider } = monter('Couper le moteur ?');
    glisser(slider, [55, 62, 70, 78, 85, 90, 95, 98, 100]);
    expect(confirmed).not.toHaveBeenCalled();
  });

  it('T50 : les touches Fin / Début / Page sont sans effet sur le curseur', () => {
    const { confirmed, slider } = monter('Couper le moteur ?');
    for (const key of ['End', 'Home', 'PageUp', 'PageDown']) {
      const evt = new KeyboardEvent('keydown', { key, cancelable: true });
      slider.dispatchEvent(evt);
      expect(evt.defaultPrevented).withContext(key).toBeTrue();
    }
    glisser(slider, [100]);
    expect(confirmed).not.toHaveBeenCalled();
  });

  it('T50 : une flèche droite MAINTENUE reste un chemin clavier valide — le navigateur émet input ET change à chaque pas', () => {
    const { fixture, confirmed, slider } = monter('Rallumer le moteur ?');
    // Comme Chromium, Firefox et WebKit : chaque pas clavier émet `input` puis `change`. Relecture du
    // 30/09 : pris pour un relâché, ce `change` remettait le curseur à zéro après chaque flèche.
    for (let v = 1; v <= 100; v++) {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      slider.value = String(v);
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new Event('change'));
    }
    fixture.detectChanges();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('30/09 : un départ à 20 % (le doigt posé sur le bord de la pastille, téléphone étroit) est un geste valable', () => {
    const { confirmed, slider } = monter('Couper le moteur ?');
    glisser(slider, [20, 31, 42, 53, 64, 75, 86, 97, 100]);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('30/09 : allé au bout mais parti de la piste — refusé, et l’aide dit comment faire', () => {
    const { fixture, confirmed, slider } = monter('Couper le moteur ?');
    glisser(slider, [55, 62, 70, 78, 85, 90, 95, 98, 100]);
    fixture.detectChanges();
    expect(confirmed).not.toHaveBeenCalled();
    const aide = (fixture.nativeElement as HTMLElement).querySelector('.cm-glisse-aide');
    expect(aide?.textContent).toContain('Partez du bouton rond');
    expect(aide?.classList).toContain('cm-glisse-aide--indice');
  });

  it('T50 : un tremblement du pouce (retours en arrière) ne casse pas un geste par ailleurs complet', () => {
    const { confirmed, slider } = monter('Rallumer le moteur ?');
    glisser(slider, [3, 12, 10, 25, 24, 40, 55, 70, 68, 85, 99, 100]);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('30/09 — un VRAI bouton : le libellé sur la piste, la pastille, le doigt qui montre le geste ; « Envoi… » pendant l’envoi', () => {
    const { fixture } = monter('Couper le moteur ?');
    fixture.componentRef.setInput('slideLabel', 'Glissez pour couper le moteur');
    fixture.detectChanges();
    const n = fixture.nativeElement as HTMLElement;
    expect(n.querySelector('.cm-glisse-texte')?.textContent?.trim()).toBe('Glissez pour couper le moteur');
    expect(n.querySelector('.cm-glisse-bouton')).not.toBeNull();
    expect(n.querySelector('.cm-glisse-doigt')).not.toBeNull();
    expect(n.querySelector('.cm-glisse-aide')?.textContent).toContain('faites-le glisser jusqu’au bout');
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(n.querySelector('.cm-glisse-texte')?.textContent?.trim()).toBe('Envoi…');
    expect(n.querySelector('.cm-glisse')?.classList).toContain('cm-glisse--envoi');
  });

  it('conserve le bouton classique sur les autres modales de l’application', () => {
    const fixture = TestBed.createComponent(ConfirmModalComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('title', 'Confirmer ?');
    fixture.componentRef.setInput('confirmLabel', 'Valider');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('input[type="range"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Valider');
  });
});

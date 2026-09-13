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
    slider.value = '75';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(confirmed).not.toHaveBeenCalled();
    expect(slider.value).toBe('0');
  });

  it('confirme une seule fois lorsque le doigt atteint la fin', () => {
    const fixture = TestBed.createComponent(ConfirmModalComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('title', 'Rallumer le moteur ?');
    fixture.componentRef.setInput('slideToConfirm', true);
    fixture.detectChanges();

    const confirmed = jasmine.createSpy('confirmed');
    fixture.componentInstance.confirmed.subscribe(confirmed);
    const slider = fixture.nativeElement.querySelector('input[type="range"]') as HTMLInputElement;
    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    expect(confirmed).not.toHaveBeenCalled();
    slider.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(confirmed).toHaveBeenCalledTimes(1);
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

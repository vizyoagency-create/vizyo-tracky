/**
 * `cycleVisible` — le rythme du sondage du tableau de bord (06/10/2026).
 *
 * Ce que ces tests verrouillent : une page ouverte EN ARRIÈRE-PLAN lit ses chiffres dès qu'elle
 * redevient visible (et non 30 s plus tard), et un retour au premier plan ne provoque jamais deux
 * lectures rapprochées (le cycle repart, il ne s'ajoute pas).
 */
import { discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { cycleVisible, type DocumentVisible } from './cycle-visible';

class FauxDocument extends EventTarget implements DocumentVisible {
  hidden = false;
  basculer(cache: boolean): void {
    this.hidden = cache;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

describe('cycleVisible — un sondage qui repart tout de suite au retour visible', () => {
  it('page visible : une émission immédiate, puis une par période', fakeAsync(() => {
    const doc = new FauxDocument();
    let n = 0;
    const abo = cycleVisible(30_000, doc).subscribe(() => n++);
    expect(n).toBe(1);
    tick(30_000);
    expect(n).toBe(2);
    tick(30_000);
    expect(n).toBe(3);
    abo.unsubscribe();
    discardPeriodicTasks();
  }));

  it('🔴 ouverte cachée : rien, puis UNE lecture immédiate dès le retour visible', fakeAsync(() => {
    const doc = new FauxDocument();
    doc.hidden = true;
    let n = 0;
    const abo = cycleVisible(30_000, doc).subscribe(() => n++);
    tick(45_000);
    expect(n).withContext('aucune lecture tant que la page est cachée').toBe(0);

    doc.basculer(false);
    expect(n).withContext('lecture IMMÉDIATE au retour, pas 30 s plus tard').toBe(1);
    tick(30_000);
    expect(n).toBe(2);
    abo.unsubscribe();
    discardPeriodicTasks();
  }));

  it('un retour au premier plan RELANCE le cycle, il ne s’y ajoute pas', fakeAsync(() => {
    const doc = new FauxDocument();
    let n = 0;
    const abo = cycleVisible(30_000, doc).subscribe(() => n++);
    expect(n).toBe(1);

    tick(20_000);
    doc.basculer(true);
    tick(5_000);
    doc.basculer(false); // t = 25 s : lecture immédiate, le cycle repart de là
    expect(n).toBe(2);

    tick(10_000); // t = 35 s : l'ANCIEN minuteur aurait émis à 30 s — il n'existe plus
    expect(n).withContext('pas de seconde lecture rapprochée').toBe(2);
    tick(20_000); // t = 55 s = 25 + 30 : le nouveau cycle
    expect(n).toBe(3);
    abo.unsubscribe();
    discardPeriodicTasks();
  }));

  it('un passage en arrière-plan ne déclenche rien de lui-même', fakeAsync(() => {
    const doc = new FauxDocument();
    let n = 0;
    const abo = cycleVisible(30_000, doc).subscribe(() => n++);
    doc.basculer(true);
    expect(n).toBe(1);
    abo.unsubscribe();
    discardPeriodicTasks();
  }));

  it('hors navigateur : un simple minuteur qui part tout de suite', fakeAsync(() => {
    let n = 0;
    const abo = cycleVisible(1_000, null).subscribe(() => n++);
    expect(n).toBe(1);
    tick(1_000);
    expect(n).toBe(2);
    abo.unsubscribe();
    discardPeriodicTasks();
  }));
});

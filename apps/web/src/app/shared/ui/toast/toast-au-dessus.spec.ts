import { TestBed } from '@angular/core/testing';
import { ToastContainerComponent } from './toast-container.component';
import { ToastService } from './toast.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE TOAST DOIT PASSER AU-DESSUS DES MODALES ET DES TIROIRS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Il était à `z-[6000]`, donc SOUS chacune des douze modales et chacun des tiroirs du produit
 * — tous à `z-[9000]`. Un toast levé pendant qu'un panneau était ouvert n'apparaissait donc
 * nulle part.
 *
 * ⚠️ CE N'EST PAS UN DÉFAUT D'AFFICHAGE. Le toast est le SEUL canal qui dise « ça a marché »
 * ou « ça a échoué » : le masquer revient à exécuter l'action en silence. L'utilisateur
 * recommence — ou pire, croit que c'est passé. Signalé sur le replay (« je clique sur
 * Partager, le toast est derrière la modale »), le défaut valait pour tous ces composants.
 *
 * ── CE QUE CE FICHIER ATTRAPE, ET CE QU'IL N'ATTRAPE PAS ────────────────────────────────
 *
 * Il mesure la hauteur RÉELLE du conteneur, telle que le navigateur la calcule : il tombe si
 * quelqu'un rabaisse le toast, ou casse la classe qui le porte.
 *
 * ⚠️ IL NE VOIT PAS L'AUTRE MOITIÉ DU DÉFAUT — un futur panneau posé PLUS HAUT que 9500.
 * C'est pourtant ainsi que c'est arrivé : les modales sont montées à 9000 bien après que le
 * toast eut été fixé à 6000, et personne n'a fait le rapprochement. Le harnais de test monte
 * un composant à la fois ; deux composants qui ne se rencontrent jamais dans un même banc ne
 * peuvent pas y être comparés. La protection restante est le commentaire posé sur la classe.
 */

/** Le plafond réservé : au-dessus, seul le blocage applicatif (9999) a le droit de passer. */
const Z_TOAST = 9500;

/** Le plus haut niveau atteint par les modales et tiroirs du produit. */
const Z_MODALES = 9000;

describe('Toast — la hauteur du conteneur', () => {
  function monter(): HTMLElement {
    TestBed.configureTestingModule({ imports: [ToastContainerComponent], providers: [ToastService] });
    const fixture = TestBed.createComponent(ToastContainerComponent);
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('.toast-stack') as HTMLElement;
  }

  it('🔴 le conteneur passe au-dessus des modales, pas en dessous', () => {
    const pile = monter();

    const z = Number(getComputedStyle(pile).zIndex);
    expect(z).toBe(Z_TOAST);
    // La comparaison qui dit le défaut : 6000 < 9000, et c'est tout ce qu'il fallait pour
    // rendre chaque toast invisible dès qu'un panneau était ouvert.
    expect(z).toBeGreaterThan(Z_MODALES);
  });

  it('il reste FIXE : un toast qui défile avec la page sort de l’écran', () => {
    expect(getComputedStyle(monter()).position).toBe('fixed');
  });

  /**
   * ⚠️ `pointer-events: none` SUR LA PILE, `auto` sur chaque toast. Sans cela, la bande
   * invisible de la pile intercepterait les clics sur toute la hauteur droite de l'écran —
   * et monter le toast au-dessus des modales aurait rendu ce défaut-là bien plus visible.
   */
  it('la pile ne vole pas les clics de ce qu’elle survole', () => {
    expect(getComputedStyle(monter()).pointerEvents).toBe('none');
  });
});

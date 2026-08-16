import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DepotModalComponent } from './depot-modal.component';

/**
 * Espace dépôt (2026-08) — l'onboarding de première connexion (A3 § 5).
 *
 * ┌─ CE QU'IL DOIT FAIRE COMPRENDRE ──────────────────────────────────────────┐
 * │ Pas « comment cliquer », mais CE QUE LE DÉPÔT VERRA ET QUAND. Les trois     │
 * │ étapes — la mission est créée → le camion roule → la livraison est tracée — │
 * │ racontent le cycle complet, donc aussi ses silences : avant le départ il    │
 * │ n'y a rien à voir, et après la livraison le suivi s'arrête.                 │
 * │                                                                            │
 * │ Un dépôt qui a vu cette animation ne s'inquiète pas d'une carte vide à 7 h. │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Animation 100 % CSS, boucle de 12 s (3 × 4 s), COUPÉE sous `prefers-reduced-motion` :
 * les trois étapes s'affichent alors ensemble, statiques. Une animation qu'on ne peut
 * pas arrêter est un obstacle pour qui en souffre — et ici elle n'apporte rien
 * d'indispensable, tout est écrit.
 */
@Component({
  selector: 'app-depot-onboarding-modal',
  standalone: true,
  imports: [DepotModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      titre="Comment fonctionne votre suivi"
      [sousTitre]="'Ce que ' + carrierName() + ' partage avec vous'"
      (fermer)="fermer.emit()"
    >
      <div class="dob-scene" aria-hidden="true">
        <span class="dob-route"></span>
        <span class="dob-quai dob-quai--depart"></span>
        <span class="dob-quai dob-quai--arrivee"></span>
        <span class="dob-camion">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1"/>
            <circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>
          </svg>
        </span>
      </div>

      <ol class="dob-etapes">
        <li class="dob-etape dob-etape--1">
          <span class="dob-num">1</span>
          <div>
            <p class="dob-titre">La mission est créée</p>
            <p class="dob-txt">
              {{ carrierName() }} vous assigne une livraison, avec son créneau. Vous recevez un e-mail.
            </p>
          </div>
        </li>
        <li class="dob-etape dob-etape--2">
          <span class="dob-num">2</span>
          <div>
            <p class="dob-titre">Le camion roule</p>
            <p class="dob-txt">
              Dès le départ, sa position s'affiche sur votre carte — et seulement
              pendant le créneau de votre mission.
            </p>
          </div>
        </li>
        <li class="dob-etape dob-etape--3">
          <span class="dob-num">3</span>
          <div>
            <p class="dob-titre">La livraison est tracée</p>
            <p class="dob-txt">
              À l'arrivée, le trajet passe dans votre historique avec ses heures réelles.
              Le suivi du camion s'arrête là.
            </p>
          </div>
        </li>
      </ol>

      <p class="dob-note">
        Vous ne voyez que les camions engagés sur vos missions. Les autres véhicules de
        {{ carrierName() }} ne vous sont pas visibles.
      </p>

      <footer pied class="dob-pied">
        <button type="button" class="dob-btn" (click)="fermer.emit()">Revoir plus tard</button>
        <a class="dob-lien" href="/decouvrir-depot.html" target="_blank" rel="noopener">En savoir plus</a>
        <button type="button" class="dob-btn dob-btn--accent" (click)="fermer.emit()">Commencer</button>
      </footer>
    </app-depot-modal>
  `,
  styles: [`
    /* ─── La scène animée ────────────────────────────────────────────────────
       Un camion qui part d'un quai et rejoint l'autre, en 12 s. La boucle est
       volontairement lente : ce n'est pas une transition, c'est une explication. */
    .dob-scene {
      position: relative; height: 78px; margin-bottom: 18px; border-radius: 14px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color); overflow: hidden;
    }
    .dob-route {
      position: absolute; left: 40px; right: 40px; top: 50%; height: 2px;
      background: repeating-linear-gradient(to right, var(--border-strong-color) 0 8px, transparent 8px 16px);
    }
    .dob-quai {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 22px; height: 22px; border-radius: 7px;
      border: 2px dashed var(--violet); background: color-mix(in srgb, var(--violet) 16%, transparent);
    }
    .dob-quai--depart { left: 22px }
    .dob-quai--arrivee { right: 22px }
    .dob-camion {
      position: absolute; top: 50%; left: 34px; transform: translateY(-50%);
      display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%;
      background: var(--color-tracky-light); color: var(--accent-ink);
      animation: dob-roule 12s ease-in-out infinite;
    }
    @keyframes dob-roule {
      0%, 22%    { left: 34px; opacity: .35 }
      30%        { opacity: 1 }
      66%        { left: calc(100% - 68px); opacity: 1 }
      78%, 100%  { left: calc(100% - 68px); opacity: .35 }
    }

    /* Les trois étapes s'éclairent l'une après l'autre, en phase avec le camion. */
    .dob-etapes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 13px }
    .dob-etape { display: flex; align-items: flex-start; gap: 12px; opacity: .45; animation: dob-phase 12s ease-in-out infinite }
    .dob-etape--1 { animation-delay: 0s }
    .dob-etape--2 { animation-delay: 4s }
    .dob-etape--3 { animation-delay: 8s }
    @keyframes dob-phase {
      0%, 2%    { opacity: .45 }
      6%, 30%   { opacity: 1 }
      36%, 100% { opacity: .45 }
    }
    .dob-num {
      flex: 0 0 auto; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%;
      background: color-mix(in srgb, var(--violet) 16%, transparent); color: var(--texte-violet);
      font-family: var(--font-mono); font-size: 12.5px; font-weight: 800;
    }
    .dob-titre { margin: 0 0 3px; font-size: 14px; font-weight: 700; color: var(--text-primary) }
    .dob-txt { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }

    .dob-note {
      margin: 16px 0 0; padding: 11px 13px; border-radius: 13px;
      border: 1px dashed var(--border-strong-color);
      font-size: 12px; line-height: 1.55; color: var(--depot-attenue);
    }

    .dob-pied {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
      padding: 12px 20px 16px; border-top: 1px solid var(--border-color);
    }
    .dob-btn {
      min-height: 40px; padding: 9px 17px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dob-btn--accent { margin-left: auto; background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink) }
    .dob-lien { font-size: 12.5px; color: var(--violet); text-decoration: none; font-weight: 600 }
    .dob-lien:hover { text-decoration: underline }

    /* ─── Mouvement réduit : tout est visible, rien ne bouge ─────────────────── */
    @media (prefers-reduced-motion: reduce) {
      .dob-camion { animation: none; left: 50%; transform: translate(-50%, -50%) }
      .dob-etape { animation: none; opacity: 1 }
    }

    @media (max-width: 767px) {
      .dob-btn { min-height: 44px }
      .dob-pied { flex-wrap: wrap }
      .dob-btn--accent { margin-left: 0; flex: 1 }
    }
  `],
})
export class DepotOnboardingModalComponent {
  readonly carrierName = input<string>('Votre transporteur');
  readonly fermer = output<void>();
}

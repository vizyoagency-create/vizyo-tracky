import { Component, inject, input, OnInit } from '@angular/core';
import { Lock, LucideAngularModule } from 'lucide-angular';
import { PlanService } from '../../../core/services/plan.service';

/**
 * 5.2 — Bannière de gating DOUX : si la feature n'est pas incluse dans l'offre de la flotte,
 * affiche une invitation à monter de gamme — SANS bloquer la page (la feature reste utilisable).
 * Ne rend RIEN quand la feature est incluse, sans abonnement attribué, ou si l'API est muette.
 */
@Component({
  selector: 'app-plan-upsell',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (!plan.allows(feature())) {
      <div class="pu">
        <lucide-icon [img]="Lock" [size]="15" class="pu-ic" />
        <span class="pu-t">
          Cette fonction fait partie de <strong>{{ plan.requiredPlanLabel(feature()) }}</strong>
          — votre offre actuelle : {{ plan.label() }}.
        </span>
        <a class="pu-cta" href="mailto:contact@vizyoagency.com?subject=Changer%20d'offre%20Tracky">Parler à mon conseiller</a>
      </div>
    }
  `,
  styles: [`
    .pu { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 14px; padding:10px 14px; border-radius:11px; background:rgba(245,179,61,.08); border:1px solid rgba(245,179,61,.3); font-size:12.5px; color:var(--fg-secondary); }
    .pu-ic { color:var(--texte-attente); flex:none; }
    .pu-t { flex:1 1 260px; line-height:1.5; }
    .pu-t strong { color:var(--texte-attente); }
    .pu-cta { flex:none; font-weight:700; color:var(--tracky-light); text-decoration:none; border:1px solid var(--border-subtle); border-radius:8px; padding:6px 11px; }
  `],
})
export class PlanUpsellComponent implements OnInit {
  protected readonly plan = inject(PlanService);
  readonly feature = input.required<string>();
  protected readonly Lock = Lock;

  ngOnInit(): void {
    this.plan.ensureLoaded();
  }
}

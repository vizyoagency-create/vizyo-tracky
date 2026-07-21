import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';

export type TrackyPlanKey = 'LITE' | 'PRO' | 'SIGNATURE';

export interface MyPlanDto {
  hasSubscription: boolean;
  plan: TrackyPlanKey | null;
  formule: 'SERENITE' | 'LIBERTE' | null;
  isComp: boolean;
  options: { live: boolean; micro: boolean; agent: boolean; retentionKey: string } | null;
}

/** Features soumises au gating doux et leur plan minimal (mapping D1/5.2, acté le 21/07). */
const FEATURE_MIN_PLAN: Record<string, TrackyPlanKey> = {
  agenda: 'PRO', // agenda, maintenance, réservations
  scores: 'PRO', // scores de conduite & analyse carburant
  surveillance: 'SIGNATURE',
};
const PLAN_RANK: Record<TrackyPlanKey, number> = { LITE: 1, PRO: 2, SIGNATURE: 3 };

/**
 * 5.2 — Gating DOUX par offre. Règles de sécurité (21/07) :
 * - flotte SANS abonnement attribué → `allows()` = true partout (clients existants intacts) ;
 * - la coupure moteur n'est JAMAIS gâtée (sécurité terrain) — absente du mapping ;
 * - « doux » = bannière upsell informative, la feature reste utilisable.
 */
@Injectable({ providedIn: 'root' })
export class PlanService {
  private readonly http = inject(HttpClient);
  private loaded = false;

  readonly plan = signal<MyPlanDto | null>(null);

  /** Charge une fois (appelé par les composants gâtés) ; échec réseau = pas de gating. */
  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.http.get<MyPlanDto>('/api/billing/plan').subscribe({
      next: (p) => this.plan.set(p),
      error: () => this.plan.set(null),
    });
  }

  /** true = la feature est incluse dans l'offre (ou aucun abonnement attribué → tout passe). */
  allows(feature: keyof typeof FEATURE_MIN_PLAN | string): boolean {
    const p = this.plan();
    if (!p || !p.hasSubscription || !p.plan) return true;
    const min = FEATURE_MIN_PLAN[feature];
    if (!min) return true;
    return PLAN_RANK[p.plan] >= PLAN_RANK[min];
  }

  /** Libellé de l'offre courante (Réglages). */
  label(): string | null {
    const p = this.plan();
    if (!p?.hasSubscription || !p.plan) return null;
    const plan = { LITE: 'Tracky Lite', PRO: 'Tracky Pro', SIGNATURE: 'Tracky Signature' }[p.plan];
    const formule = p.formule === 'SERENITE' ? 'Sérénité (tout inclus, 36 mois)' : 'Liberté (sans engagement)';
    return `${plan} · ${formule}${p.isComp ? ' · offert' : ''}`;
  }

  requiredPlanLabel(feature: string): string {
    return FEATURE_MIN_PLAN[feature] === 'SIGNATURE' ? 'Tracky Signature' : 'Tracky Pro';
  }
}

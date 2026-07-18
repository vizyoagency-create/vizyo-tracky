/**
 * Facturation (2026-07) — l'assistance IA est une OPTION PAYANTE (abonnement mensuel Stripe).
 *
 * Règle : par défaut tout le monde paie ; un super-admin/owner peut OFFRIR l'IA à une société
 * (statut COMP, sans paiement) via son toggle. Un fleet-admin active en s'abonnant (carte) ou en
 * demandant une facture physique (→ contact@vizyoagency.com). L'abonnement pilote `Fleet.aiEnabled`.
 * Le PRIX est configurable par le super-admin (BillingSettings), pas figé dans le code.
 */

export type AiSubStatus = 'NONE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INVOICE_PENDING' | 'COMP';
export type BillingPricingUnit = 'per_vehicle' | 'flat';

/** Carte enregistrée (affichage seul — jamais le numéro complet). */
export interface BillingCardDto {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** État de facturation d'une société (pour l'onglet « Facturation & options »). */
export interface BillingStatusDto {
  /** Stripe configuré côté serveur (clé présente). Si false, seule l'activation COMP (owner) marche. */
  configured: boolean;
  /** Clé publiable pour Stripe.js côté front (null si non configuré). */
  publishableKey: string | null;
  status: AiSubStatus;
  card: BillingCardDto | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Véhicules facturables (actifs) de la société — base du calcul « par voiture ». */
  vehicleCount: number;
  pricingUnit: BillingPricingUnit;
  /** Prix unitaire configuré (centimes €) : par véhicule si per_vehicle, sinon forfait société. */
  unitAmountEurCents: number;
  /** Total mensuel (centimes €) : unit × véhicules si per_vehicle, sinon unit. */
  monthlyEurCents: number;
  /** Coût par véhicule (centimes €) = monthly / véhicules (≥1). */
  perVehicleEurCents: number;
  currency: string;
  /** État runtime effectif de l'IA pour la société. */
  aiEnabled: boolean;
  /** L'utilisateur courant peut-il gérer l'abonnement (fleet-admin de la société / super-admin) ? */
  canManage: boolean;
  /** true si le viewer est super-admin (peut OFFRIR sans paiement). */
  isSuperAdmin: boolean;
}

/** Réglage du prix de l'option IA (super-admin). */
export interface BillingSettingsDto {
  aiUnitAmountEurCents: number;
  aiPricingUnit: BillingPricingUnit;
  currency: string;
  updatedAt: string | null;
}

/** Corps : régler le prix de l'option IA (super-admin). */
export interface SetBillingPriceDto {
  aiUnitAmountEurCents: number;
  aiPricingUnit?: BillingPricingUnit;
}

/** SetupIntent pour ajouter une carte (client secret + clé publiable). */
export interface BillingSetupIntentDto {
  clientSecret: string;
  publishableKey: string;
}

/** Résultat d'une souscription : peut nécessiter une confirmation SCA/3DS côté front. */
export interface BillingSubscribeResultDto {
  status: AiSubStatus;
  /** true = une authentification (3DS) est requise → confirmer avec `clientSecret` côté front. */
  requiresAction: boolean;
  clientSecret: string | null;
}

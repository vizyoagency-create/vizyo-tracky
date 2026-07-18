import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  BillingPricingUnit, BillingSettingsDto, BillingSetupIntentDto, BillingStatusDto, BillingSubscribeResultDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Facturation de l'option IA — client HTTP de `/api/billing`. Consultation SUPER_ADMIN + FLEET_ADMIN
 * (scopé société) ; actions (carte/abonnement/facture/annulation) gardées `billing_manage` côté back.
 */
@Injectable({ providedIn: 'root' })
export class BillingApiService {
  private readonly http = inject(HttpClient);

  status(fleetId?: string): Observable<BillingStatusDto> {
    return this.http.get<BillingStatusDto>('/api/billing/status', { params: fleetId ? { fleetId } : {} });
  }

  setupIntent(fleetId?: string): Observable<BillingSetupIntentDto> {
    return this.http.post<BillingSetupIntentDto>('/api/billing/setup-intent', fleetId ? { fleetId } : {});
  }

  subscribe(fleetId?: string): Observable<BillingSubscribeResultDto> {
    return this.http.post<BillingSubscribeResultDto>('/api/billing/subscribe', fleetId ? { fleetId } : {});
  }

  requestInvoice(fleetId?: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>('/api/billing/request-invoice', fleetId ? { fleetId } : {});
  }

  cancel(fleetId?: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>('/api/billing/cancel', fleetId ? { fleetId } : {});
  }

  /** OFFERT (COMP) — super-admin active/coupe l'IA d'une société sans paiement. */
  comp(fleetId: string, enabled: boolean): Observable<{ status: string }> {
    return this.http.post<{ status: string }>('/api/billing/comp', { fleetId, enabled });
  }

  getPrice(): Observable<BillingSettingsDto> {
    return this.http.get<BillingSettingsDto>('/api/billing/settings/price');
  }

  setPrice(aiUnitAmountEurCents: number, aiPricingUnit?: BillingPricingUnit): Observable<BillingSettingsDto> {
    return this.http.put<BillingSettingsDto>('/api/billing/settings/price', { aiUnitAmountEurCents, aiPricingUnit });
  }
}

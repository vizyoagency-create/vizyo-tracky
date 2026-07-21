import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type TrackyPlan = 'LITE' | 'PRO' | 'SIGNATURE';
export type TrackyFormule = 'SERENITE' | 'LIBERTE';

export interface FleetSubscriptionDto {
  plan: TrackyPlan;
  formule: TrackyFormule;
  optLive: boolean;
  optMicro: boolean;
  optAgent: boolean;
  retentionKey: string;
  isComp: boolean;
  customPriceEurYear: number | null;
  notes: string | null;
  updatedAt: string;
  effective: { live: boolean; micro: boolean; agent: boolean; retentionKey: string };
  pricePerVehYear: number;
  revenueYear: number;
}

export interface SubscriptionRowDto {
  fleetId: string;
  fleetName: string;
  vehicles: number;
  subscription: FleetSubscriptionDto | null;
}

export interface UpsertSubscriptionBody {
  plan: TrackyPlan;
  formule: TrackyFormule;
  optLive?: boolean;
  optMicro?: boolean;
  optAgent?: boolean;
  retentionKey?: string;
  isComp?: boolean;
  customPriceEurYear?: number | null;
  notes?: string | null;
}

/** Grille tarifaire (même forme que lp/src/data/pricing.mjs) — champs édités par l'admin. */
export interface PricingGridDto {
  plans: Record<'lite' | 'pro' | 'signature', { name: string; tagline: string; serenite: number; liberte: number; popular?: boolean }>;
  addons: {
    live: { label: string; perVehYear: number };
    micro: { label: string; perVehYear: number };
    agent: { label: string; perVehYear: number };
    retention: { key: string; label: string; perVehYear: number; included?: boolean }[];
  };
  launch?: { active: boolean; label: string; until: string; slotsLeft: number; guarantee: string };
  [k: string]: unknown;
}

/** D4 + Phase 3 — espace admin « Abonnements & tarifs » (SUPER_ADMIN). */
@Injectable({ providedIn: 'root' })
export class SubscriptionsAdminApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<{ items: SubscriptionRowDto[]; totalRevenueYear: number }> {
    return this.http.get<{ items: SubscriptionRowDto[]; totalRevenueYear: number }>('/api/admin/subscriptions');
  }

  upsert(fleetId: string, body: UpsertSubscriptionBody): Observable<unknown> {
    return this.http.put(`/api/admin/subscriptions/${fleetId}`, body);
  }

  getGrid(): Observable<{ grid: PricingGridDto; updatedAt: string | null }> {
    return this.http.get<{ grid: PricingGridDto; updatedAt: string | null }>('/api/admin/subscriptions/pricing/grid');
  }

  updateGrid(grid: PricingGridDto): Observable<{ grid: PricingGridDto }> {
    return this.http.put<{ grid: PricingGridDto }>('/api/admin/subscriptions/pricing/grid', { grid });
  }
}

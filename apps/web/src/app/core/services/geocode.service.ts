import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal, type Signal } from '@angular/core';

/**
 * Géocodage inverse côté front pour la colonne « Dernière position » de la
 * liste véhicules. Appelle l'endpoint serveur (cache + throttle Nominatim) et
 * mémorise le résultat par coordonnées arrondies (~110 m) → un seul appel HTTP
 * par emplacement, quel que soit le nombre de véhicules qui s'y trouvent, et
 * pas de nouvel appel au fil des re-rendus.
 */
@Injectable({ providedIn: 'root' })
export class GeocodeService {
  private readonly http = inject(HttpClient);
  /** clé "lat,lng" -> signal d'adresse ('' tant que non résolu / échec). */
  private readonly cache = new Map<string, ReturnType<typeof signal<string>>>();

  private key(lat: number, lng: number): string {
    return `${lat.toFixed(3)},${lng.toFixed(3)}`;
  }

  /** Renvoie un signal (mémoïsé) qui se remplit avec l'adresse courte. */
  reverse(lat: number, lng: number): Signal<string> {
    const k = this.key(lat, lng);
    const existing = this.cache.get(k);
    if (existing) return existing.asReadonly();

    const sig = signal('');
    this.cache.set(k, sig);
    this.http
      .get<{ address: string }>('/api/geocode/reverse', { params: { lat: String(lat), lng: String(lng) } })
      .subscribe({
        next: (r) => sig.set(r.address ?? ''),
        error: () => sig.set(''),
      });
    return sig.asReadonly();
  }
}

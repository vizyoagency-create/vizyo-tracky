import { Injectable, Logger } from '@nestjs/common';
import { FleetPlaceKind } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';

/** Overpass (OSM) — même canal que l'enrichissement de marque des stations (fuel-station.service). */
const OVERPASS_URL = () => (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').replace(/\/$/, '');
const UA = 'Tracky/1.0 (contact@vizyoagency.com)';
const TIMEOUT_MS = 10_000;
/** Rayon de recherche du POI autour du lieu (m). Au-delà on risque d'attraper le voisin. */
const SEARCH_RADIUS_M = 120;

/**
 * Enrichissement FACTUEL d'un lieu depuis OpenStreetMap (Overpass).
 *
 * Pourquoi : l'app interrogeait déjà Overpass pour les stations mais n'en gardait QUE la marque —
 * tout le reste des tags était jeté. Or OSM porte exactement ce qu'on voit sur une fiche Google :
 * horaires (dont 24/7), téléphone, site web, enseigne, services (lavage, gonflage, boutique,
 * toilettes, automate), carburants disponibles, moyens de paiement, capacité d'un parking.
 *
 * GRATUIT et LÉGAL (ODbL), contrairement au scraping d'un moteur de recherche : pas de clé, pas de
 * quota facturé, pas de blocage d'IP. C'est la source de vérité FACTUELLE ; l'IA ne fait ensuite que
 * REFORMULER ces faits — elle n'en invente aucun.
 *
 * Best-effort strict : ne lève JAMAIS. Overpass est un service communautaire parfois lent ou
 * indisponible ; dans ce cas on renvoie `null` et l'appelant continue sans enrichissement.
 */
@Injectable()
export class PlaceEnrichmentService {
  private readonly logger = new Logger(PlaceEnrichmentService.name);
  /** Horodatage du dernier appel réseau — Overpass demande de rester raisonnable (≈1 req/s). */
  private lastCallAt = 0;

  constructor(private readonly errorLogger: ErrorLogger) {}

  /**
   * Récupère les faits OSM du POI le plus proche du lieu. `null` si rien trouvé ou Overpass KO.
   * @param kind oriente la recherche (station-service, parking…) pour ne pas capter un POI voisin.
   */
  async enrich(lat: number, lng: number, kind: FleetPlaceKind): Promise<PlaceFacts | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const filters = this.filtersFor(kind);
    // On interroge nodes ET ways : un parking ou une station est souvent un polygone, pas un point.
    const clauses = filters
      .map((f) => `node(around:${SEARCH_RADIUS_M},${lat},${lng})${f};way(around:${SEARCH_RADIUS_M},${lat},${lng})${f};`)
      .join('');
    const query = `[out:json][timeout:10];(${clauses});out tags center 5;`;

    let elements: OverpassElement[] = [];
    try {
      await this.throttle();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(OVERPASS_URL(), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        if (!res.ok) return null; // 429/504 Overpass : indisponibilité normale, pas une anomalie
        const json = (await res.json()) as { elements?: OverpassElement[] };
        elements = json.elements ?? [];
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Timeout / réseau = indisponibilité ATTENDUE d'un service communautaire → silencieux (sinon
      // une panne Overpass d'une heure inonderait le centre d'alerte). Toute AUTRE erreur (parse,
      // bug de code) est anormale et doit être visible.
      const name = (err as Error)?.name ?? '';
      if (name !== 'AbortError' && name !== 'TypeError') {
        this.errorLogger.recordBackground(
          err instanceof Error ? err : new Error(String(err)),
          'place-enrichment',
          { note: 'echec inattendu de l enrichissement OSM', lat, lng, kind },
        );
      }
      return null;
    }

    if (elements.length === 0) return null;
    // Le POI le plus « riche » (le plus de tags) est le meilleur candidat : un node nu à côté d'un
    // polygone complet ne doit pas gagner juste parce qu'il arrive en premier.
    const best = elements
      .filter((e) => e.tags && Object.keys(e.tags).length > 0)
      .sort((a, b) => Object.keys(b.tags ?? {}).length - Object.keys(a.tags ?? {}).length)[0];
    if (!best?.tags) return null;
    return this.toFacts(best);
  }

  /** Filtres Overpass selon la nature du lieu. */
  private filtersFor(kind: FleetPlaceKind): string[] {
    switch (kind) {
      case FleetPlaceKind.FUEL_STATION:
        return ['[amenity=fuel]'];
      case FleetPlaceKind.PARKING:
        return ['[amenity=parking]'];
      case FleetPlaceKind.DEPOT:
        // Dépôt : entrepôt / zone industrielle / cour de transport.
        return ['[landuse=industrial]', '[building=warehouse]', '[amenity=parking]'];
      default:
        return ['[amenity=fuel]', '[amenity=parking]'];
    }
  }

  /** Traduit les tags OSM bruts en faits exploitables (et affichables tels quels). */
  private toFacts(el: OverpassElement): PlaceFacts {
    const t = el.tags ?? {};
    const yes = (v: string | undefined) => v === 'yes' || v === 'true';

    const services: string[] = [];
    if (t['opening_hours'] === '24/7') services.push('Ouvert 24h/24');
    if (yes(t['car_wash']) || t['amenity'] === 'car_wash') services.push('Lavage');
    if (yes(t['compressed_air'])) services.push('Gonflage');
    if (t['shop'] && t['shop'] !== 'no') services.push('Boutique');
    if (yes(t['toilets'])) services.push('Toilettes');
    if (yes(t['atm'])) services.push('Distributeur');
    if (yes(t['self_service'])) services.push('Automate');
    if (yes(t['hgv'])) services.push('Poids lourds');
    if (yes(t['fuel:adblue'])) services.push('AdBlue');
    if (t['vacuum_cleaner'] && t['vacuum_cleaner'] !== 'no') services.push('Aspirateur');

    // Carburants : tags `fuel:*=yes`, libellés lisibles.
    const FUELS: Array<[string, string]> = [
      ['fuel:diesel', 'Gazole'],
      ['fuel:octane_95', 'SP95'],
      ['fuel:octane_98', 'SP98'],
      ['fuel:e10', 'E10'],
      ['fuel:e85', 'E85'],
      ['fuel:lpg', 'GPL'],
      ['fuel:cng', 'GNV'],
      ['fuel:electricity', 'Électrique'],
    ];
    const fuels = FUELS.filter(([tag]) => yes(t[tag])).map(([, label]) => label);

    const PAYMENTS: Array<[string, string]> = [
      ['payment:credit_cards', 'Carte bancaire'],
      ['payment:debit_cards', 'Carte de débit'],
      ['payment:contactless', 'Sans contact'],
      ['payment:cash', 'Espèces'],
      ['payment:fuel_cards', 'Carte carburant'],
    ];
    const payment = PAYMENTS.filter(([tag]) => yes(t[tag])).map(([, label]) => label);

    const parking =
      t['amenity'] === 'parking'
        ? {
            capacity: Number.isFinite(Number(t['capacity'])) ? Number(t['capacity']) : null,
            type: t['parking'] ?? null, // surface / underground / multi-storey
            access: t['access'] ?? null, // public / private / customers
            fee: t['fee'] ?? null,
          }
        : null;

    // Adresse OSM reconstituée quand elle existe.
    const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ').trim();
    const address = [addr || null, t['addr:postcode'] ?? null, t['addr:city'] ?? null]
      .filter(Boolean)
      .join(', ') || null;

    return {
      source: 'osm',
      osmId: el.type && el.id != null ? `${el.type}/${el.id}` : null,
      name: t['name'] ?? null,
      brand: t['brand'] ?? t['operator'] ?? null,
      operator: t['operator'] ?? null,
      openingHours: t['opening_hours'] ?? null,
      phone: t['phone'] ?? t['contact:phone'] ?? null,
      website: t['website'] ?? t['contact:website'] ?? null,
      services,
      fuels,
      payment,
      parking,
      imageUrl: this.imageFrom(t),
      wikidata: t['wikidata'] ?? null,
      address,
    };
  }

  /**
   * Image LIBRE du lieu si OSM en référence une.
   * - `image=<url>` : URL directe posée par un contributeur.
   * - `wikimedia_commons=File:X.jpg` : on passe par `Special:FilePath` (URL stable, redimensionnée).
   * Honnêteté : la plupart des stations françaises n'ont AUCUNE photo dans OSM — d'où le `null`
   * fréquent. On préfère pas d'image à une image inventée.
   */
  private imageFrom(t: Record<string, string>): string | null {
    const commons = t['wikimedia_commons'];
    if (commons?.startsWith('File:')) {
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(commons.slice(5))}?width=640`;
    }
    const img = t['image'];
    // On n'accepte que du https — pas de contenu mixte ni de schéma exotique dans l'UI.
    return img && /^https:\/\//i.test(img) ? img : null;
  }

  /** Sérialise les appels à ≈1/s : Overpass est communautaire, on reste un bon citoyen. */
  private async throttle(): Promise<void> {
    const MIN_INTERVAL_MS = 1100;
    const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
}

/** Faits OSM d'un lieu — SOURCE DE VÉRITÉ factuelle (l'IA ne fait que les reformuler). */
export interface PlaceFacts {
  source: 'osm';
  osmId: string | null;
  name: string | null;
  brand: string | null;
  operator: string | null;
  /** Horaires bruts OSM (`24/7`, `Mo-Fr 07:00-20:00`…). */
  openingHours: string | null;
  phone: string | null;
  website: string | null;
  services: string[];
  fuels: string[];
  payment: string[];
  parking: { capacity: number | null; type: string | null; access: string | null; fee: string | null } | null;
  /** Photo libre (OSM `image` ou Wikimedia Commons), souvent absente — jamais inventée. */
  imageUrl: string | null;
  wikidata: string | null;
  address: string | null;
}

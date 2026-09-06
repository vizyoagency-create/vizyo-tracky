import { swallow } from '../../core/error/swallow';
import { HttpClient, HttpErrorResponse, HttpParams, HttpResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { marqueFichierConducteurDeFiltre } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { ActivityTrackerService } from './activity-tracker.service';
import type {
  FleetReportDispatchDto,
  FleetReportScheduleDto,
  SendFleetReportNowResultDto,
  SetFleetReportScheduleDto,
} from '@vizyo/tracky-shared';

export interface FleetStatsReportDto {
  fleet: { id: string; name: string };
  period: { from: string; to: string; days: number };
  vehicles: {
    total: number;
    activeDuringPeriod: number;
    /**
     * Les véhicules du périmètre qui n'ont AUCUN trajet sur la période — nommés, pas
     * seulement comptés. `silencieux` distingue « il n'a pas servi » de « son boîtier
     * s'est tu » : le premier se mutualise, le second se répare.
     */
    idleVehicles: { vehicleId: string; plate: string; group: { id: string; name: string } | null; silencieux: boolean }[];
    /** Compte RÉEL des immobiles ; la liste ci-dessus est plafonnée. */
    idleTotal: number;
    /**
     * Véhicules que le client a mis en MODE VIE PRIVÉE : absents de TOUT ce rapport, `total`
     * compris. Servi pour que l'écran le DISE — un parc qui rétrécit sans explication se lit
     * comme une perte de véhicules, et « 5 sur 34 » chez un client qui en compte 39 est une
     * question sans réponse.
     */
    hiddenByPrivacy: number;
  };
  trips: {
    count: number;
    totalKm: number;
    totalDurationHours: number;
    avgKmPerVehicle: number;
    avgSpeedKmh: number;
    maxSpeedKmh: number;
  };
  alerts: {
    total: number;
    byType: { type: string; count: number }[];
    bySeverity: { severity: string; count: number }[];
  };
  consumption: {
    estimatedLiters: number;
    estimatedCostEur: number;
    fuelPriceEurL: number;
    /**
     * Prix RÉELLEMENT CONSTATÉ en station sur la période (€/L moyen), ou `null` si aucun
     * passage n'a été capté. Le serveur le calcule depuis toujours ; l'écran ne le demandait
     * pas, et le client comparait donc son coût estimé à un prix qu'il avait paramétré
     * lui-même, sans jamais voir celui qu'il paie vraiment.
     */
    observedPriceEurL: number | null;
    estimatedCostAtObservedEur: number | null;
    observedSampleCount: number;
    /** CO₂ estimé de la période (kg) — combustion seule, facteur propre à chaque énergie. */
    estimatedCo2Kg: number;
    /** Ralenti moteur cumulé de tout le périmètre, en SECONDES (F12). */
    idleSecondsTotal: number;
  };
  topVehicles: {
    vehicleId: string;
    plate: string;
    distanceKm: number;
    tripCount: number;
    estimatedConsumptionL: number;
    group?: { id: string; name: string } | null;
    /** Ajoutés le 4 septembre : sans eux, l'écran devait additionner lui-même la page chargée. */
    durationHours: number;
    avgSpeedKmh: number;
    /**
     * Excès ÉTABLIS de la période (règle partagée : au moins une seconde), le nombre de
     * trajets concernés, et le pire dépassement en km/h au-dessus de la limite.
     */
    speedingCount: number;
    speedingTripCount: number;
    worstOverKmh: number;
    /** Ralenti moteur cumulé du véhicule sur la période, en SECONDES. */
    idleSeconds: number;
  }[];
  /**
   * ── LE MÊME RÉCAPITULATIF, PAR CONDUCTEUR OU GROUPE (F13) ──────────────────────────
   *
   * `topVehicles` répond à « quel véhicule roule et dépasse ? ». Ce bloc répond à
   * « combien de kilomètres a fait tel conducteur ce mois-ci, avec combien d'excès ? » —
   * question à laquelle la page ne savait pas répondre, alors que l'écran des scores
   * impute déjà chaque trajet.
   *
   * Chaque trajet compte pour son CONDUCTEUR s'il est connu, sinon pour le GROUPE de son
   * véhicule. Mêmes champs et mêmes arrondis que `topVehicles` : l'écran réutilise ses
   * cellules telles quelles.
   *
   * ⚠️ OPTIONNELS À DESSEIN. Un serveur antérieur à ce lot ne les sert pas : l'écran doit
   * alors se TAIRE (bascule indisponible), jamais afficher une vue vide qui ferait croire
   * à zéro trajet attribué.
   */
  byAttribution?: {
    /** `driver:<id>` ou `group:<id>` — la clé d'imputation, identique à celle des scores. */
    key: string;
    /** Nom du conducteur, sinon nom du groupe. */
    label: string;
    kind: 'driver' | 'group';
    tripCount: number;
    distanceKm: number;
    durationHours: number;
    avgSpeedKmh: number;
    speedingCount: number;
    speedingTripCount: number;
    worstOverKmh: number;
    idleSeconds: number;
  }[];
  /** Compte RÉEL des lignes d'imputation ; `byAttribution` est plafonné comme `topVehicles`. */
  byAttributionTotal?: number;
  /**
   * Trajets sans conducteur NI groupe : comptés, jamais une ligne — on ne note pas
   * « personne ». Mesuré le 2026-09-05 : 1 866 trajets sur 1 886 chez mh cars.
   */
  unattributedTrips?: { tripCount: number; distanceKm: number; durationHours: number };
}

export type CsvType = 'positions' | 'trips' | 'alerts' | 'commands';

export type PdfReportSection = 'kpi' | 'alerts' | 'topVehicles' | 'trips';

/**
 * Options de personnalisation pour POST /api/reports/pdf — alignees sur le DTO
 * backend `GeneratePdfDto`. Tous les champs sont optionnels ; en l'absence de
 * filtre la modal genere un rapport flotte complet (comportement legacy).
 */
export interface PdfExportConfig {
  /** Restreint a ces vehicules. Vide / absent => toute la flotte. */
  vehicleIds?: string[];
  /** Sections a inclure. Vide / absent => toutes les sections. */
  sections?: PdfReportSection[];
  /** Cap trajets detailles (default 30, max 500). */
  maxTrips?: number;
  /** Cap top vehicules (default 10, max 50). */
  topN?: number;
  /**
   * Filtre CONDUCTEUR (F13) — un identifiant, ou `none` pour les trajets sans conducteur.
   *
   * ⚠️ Il borne le CALCUL du rapport, et le document le DIT (une ligne sous le nom de la
   * société). Sans lui, un gestionnaire filtré sur une personne recevait le PDF de toute la
   * société — un fichier qui contredit l'écran qui l'a produit, et qui survit à cet écran.
   */
  driverId?: string;
}

/**
 * V1.5 (Sprint L) — Rapports & export.
 *
 * Le PDF et le CSV sont des binaires/texte servis avec Content-Disposition:
 * attachment. Cote frontend, on declenche le download via un blob anchor.
 */
@Injectable({ providedIn: 'root' })
export class ReportsApiService {
  private readonly http = inject(HttpClient);
  private readonly tracker = inject(ActivityTrackerService);

  /**
   * Réglage hebdomadaire de TOUTES les sociétés — super-administrateur seulement.
   *
   * Sans lui, savoir si le rapport d'un client est coupé demandait de le sélectionner dans
   * le sélecteur du haut, une société après l'autre. Personne ne le fait pour vingt sociétés,
   * donc un rapport coupé se découvrait par hasard — souvent parce que le client le signalait.
   */
  scheduleOverview() {
    return this.http.get<FleetReportScheduleDto[]>('/api/reports/schedule/overview');
  }

  /**
   * Indicateurs et récapitulatif par véhicule, calculés sur TOUTE la période par le serveur.
   *
   * `vehicleIds` porte le périmètre de l'écran (filtre véhicule ou groupe) ; `topN` la
   * profondeur du récapitulatif. Sans eux, l'écran ne pouvait pas demander ce qu'il affiche,
   * et additionnait la seule page chargée.
   */
  /**
   * @param opts.driverId Filtre CONDUCTEUR (F13) — un identifiant, ou `none` pour les trajets
   *   sans conducteur. Il borne les totaux, le récapitulatif par véhicule, celui par
   *   imputation, les excès et le ralenti.
   *
   *   ⚠️ PAS les ALERTES : elles appartiennent à un véhicule et n'ont pas de conducteur (cf.
   *   `alertWhere` côté serveur). L'écran le dit quand un conducteur est sélectionné — sans
   *   quoi le lecteur croirait que cette personne a déclenché toutes ces alertes.
   */
  stats(fleetId: string | null, from: string, to: string, opts: { vehicleIds?: string[]; topN?: number; driverId?: string } = {}) {
    const params: Record<string, string> = { from, to };
    if (fleetId) params['fleetId'] = fleetId;
    if (opts.vehicleIds && opts.vehicleIds.length > 0) params['vehicleIds'] = opts.vehicleIds.join(',');
    if (opts.topN) params['topN'] = String(opts.topN);
    if (opts.driverId) params['driverId'] = opts.driverId;
    return this.http.get<FleetStatsReportDto>('/api/reports/stats', { params });
  }

  /**
   * Client du `GET /api/reports/pdf` historique, gardé pour compatibilité.
   *
   * ⚠️ AUCUN ÉCRAN NE L'APPELLE. Le bouton PDF de Rapports comme celui de l'onglet véhicule
   * ouvrent la modale et passent par `downloadConfiguredPdf` (POST). La phrase qui vivait ici
   * décrivait « l'export rapide, sans modale » et « deux chemins depuis un même écran » : ce
   * second chemin n'existe pas, et un lecteur envoyé le chercher ne le trouve pas. La route
   * serveur, elle, reste bien atteignable hors de l'app (URL recopiée, autre client).
   *
   * @param driverId Filtre CONDUCTEUR (F13), porté ici pour que ce client ne soit pas en retard
   *   sur sa route — le GET l'accepte désormais (cf. `reports.controller.ts`).
   *
   *   ⚠️ CE CHEMIN NE REND PAS le même périmètre que la variante configurable, et ne le peut
   *   pas : il ne transporte ni `vehicleIds`, ni `sections`, ni les plafonds. Le rebrancher
   *   depuis un écran filtré par véhicule ou par groupe produirait un PDF de TOUTE la société
   *   sous le nom d'une personne — exactement le défaut que ce lot referme.
   */
  async downloadPdf(fleetId: string | null, from: string, to: string, driverId?: string): Promise<void> {
    let params = new HttpParams().set('from', from).set('to', to);
    if (fleetId) params = params.set('fleetId', fleetId);
    if (driverId) params = params.set('driverId', driverId);
    try {
      const res = await firstValueFrom(
        this.http.get('/api/reports/pdf', { params, responseType: 'blob', observe: 'response' }),
      );
      this.triggerDownload(res.body ?? new Blob(), this.nomPdfDepuisReponse(res, from, to, driverId));
    } catch (err) {
      swallow('reports:downloadPdf', err);
      throw new Error(await this.formatHttpError(err, 'PDF'));
    }
  }

  /**
   * Variante configurable du PDF — POST avec body JSON (vehicleIds + sections
   * + caps). C'est le SEUL chemin d'export PDF de l'application : la modale y mène depuis la
   * page Rapports comme depuis l'onglet véhicule (cf. `downloadPdf`, sans appelant).
   */
  async downloadConfiguredPdf(
    fleetId: string | null,
    from: string,
    to: string,
    config: PdfExportConfig,
  ): Promise<void> {
    const body: Record<string, unknown> = { from, to };
    if (fleetId) body['fleetId'] = fleetId;
    if (config.vehicleIds && config.vehicleIds.length > 0) body['vehicleIds'] = config.vehicleIds;
    if (config.sections && config.sections.length > 0) body['sections'] = config.sections;
    if (config.maxTrips != null) body['maxTrips'] = config.maxTrips;
    if (config.topN != null) body['topN'] = config.topN;
    // Le filtre conducteur de l'écran voyage avec la configuration : le PDF est calculé
    // dessus, et le document porte le nom de la personne sous celui de la société.
    if (config.driverId) body['driverId'] = config.driverId;

    try {
      const res = await firstValueFrom(
        this.http.post('/api/reports/pdf', body, { responseType: 'blob', observe: 'response' }),
      );
      this.triggerDownload(res.body ?? new Blob(), this.nomPdfDepuisReponse(res, from, to, config.driverId));
    } catch (err) {
      swallow('reports:downloadConfiguredPdf', err);
      throw new Error(await this.formatHttpError(err, 'PDF'));
    }
  }

  /**
   * `vehicleIds` : périmètre véhicule / groupe de l'écran. Sans lui, un CSV « trajets »
   * demandé depuis un rapport filtré sur EP-047-TY exportait toute la flotte — le fichier
   * ne correspondait pas à l'écran qui l'avait produit.
   *
   * @param driverId Filtre CONDUCTEUR (F13), le même défaut une seconde fois : un CSV
   *   « trajets » demandé depuis un écran filtré sur une personne rendait tous les trajets
   *   de la société.
   *
   *   ⚠️ N'A DE SENS QUE POUR `type === 'trips'`. Une position, une alerte et une commande
   *   appartiennent à un véhicule ou à un boîtier, jamais à une personne : le serveur REFUSE
   *   ces trois types quand un conducteur est demandé (400, avec la raison en clair) plutôt
   *   que de rendre une autre population sous un nom de fichier qu'on croit filtré. L'écran
   *   désactive d'ailleurs le bouton concerné et le dit avant le clic.
   */
  async downloadCsv(type: CsvType, fleetId: string | null, from: string, to: string, vehicleIds: string[] = [], driverId?: string): Promise<void> {
    let params = new HttpParams().set('type', type).set('from', from).set('to', to);
    if (fleetId) params = params.set('fleetId', fleetId);
    if (vehicleIds.length > 0) params = params.set('vehicleIds', vehicleIds.join(','));
    if (driverId) params = params.set('driverId', driverId);
    try {
      /**
       * ── LE NOM DU FICHIER VIENT DU SERVEUR (F13) ──────────────────────────────────────
       *
       * Le serveur nomme déjà ce fichier et y met ce que le client ne peut pas deviner : le
       * FILTRE CONDUCTEUR (« -sans-conducteur », « -conducteur-<8 caractères> ») et le
       * marqueur « -PARTIEL » de la troncature. Tant que l'écran refabriquait le nom,
       * `a.download` écrasait le `Content-Disposition` et les deux marques n'atteignaient
       * personne : sous « Sans conducteur » — 1 905 trajets sur 1 956 chez « mh cars » —, le
       * gestionnaire recevait deux fichiers de MÊME nom pour deux populations différentes, et
       * un export tronqué portait le nom d'un export complet.
       *
       * ⚠️ LE REPLI RESTE LE NOM D'AVANT, jamais une chaîne vide : l'en-tête peut manquer
       * (proxy qui le filtre) ou être mal formé, et un `a.download` vide fait enregistrer le
       * fichier sous « download », sans extension. C'est exactement ce que
       * `filenameFromResponse` garantit, et c'est déjà le geste de `downloadExcel`.
       */
      const res = await firstValueFrom(
        this.http.get('/api/reports/csv', { params, responseType: 'blob', observe: 'response' }),
      );
      const filename = this.filenameFromResponse(
        res,
        `tracky-${type}-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`,
      );
      this.triggerDownload(res.body ?? new Blob(), filename);
    } catch (err) {
      swallow('reports:downloadCsv', err);
      throw new Error(await this.formatHttpError(err, 'CSV'));
    }
  }

  // ─── Rapport hebdomadaire : réglage par société + journal des envois ───────────────

  private scheduleParams(fleetId: string | null, extra: Record<string, string> = {}): HttpParams {
    let params = new HttpParams();
    if (fleetId) params = params.set('fleetId', fleetId);
    for (const [k, v] of Object.entries(extra)) params = params.set(k, v);
    return params;
  }

  getReportSchedule(fleetId: string | null): Promise<FleetReportScheduleDto> {
    return firstValueFrom(this.http.get<FleetReportScheduleDto>('/api/reports/schedule', { params: this.scheduleParams(fleetId) }));
  }

  setReportSchedule(fleetId: string | null, body: SetFleetReportScheduleDto): Promise<FleetReportScheduleDto> {
    return firstValueFrom(this.http.put<FleetReportScheduleDto>('/api/reports/schedule', body, { params: this.scheduleParams(fleetId) }));
  }

  sendReportNow(fleetId: string | null): Promise<SendFleetReportNowResultDto> {
    return firstValueFrom(this.http.post<SendFleetReportNowResultDto>('/api/reports/schedule/send-now', {}, { params: this.scheduleParams(fleetId) }));
  }

  listReportDispatches(fleetId: string | null, limit = 20): Promise<FleetReportDispatchDto[]> {
    return firstValueFrom(this.http.get<FleetReportDispatchDto[]>('/api/reports/schedule/dispatches', { params: this.scheduleParams(fleetId, { limit: String(limit) }) }));
  }

  async downloadSpeedAnalysis(tripId: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get(`/api/reports/speed-analysis/${tripId}`, { responseType: 'blob', observe: 'response' }),
      );
      // Le serveur nomme le fichier par plaque et date (« rapport-vitesse-EP-047-TY-2026-08-11 ») :
      // on le reprend, au lieu d'un identifiant tronqué qui ne disait rien.
      const filename = this.filenameFromResponse(res, `rapport-vitesse-${tripId.slice(0, 8)}.html`);
      this.triggerDownload(res.body ?? new Blob(), filename);
    } catch (err) {
      swallow('reports:downloadSpeedAnalysis', err);
      throw new Error(await this.formatHttpError(err, 'Rapport vitesse'));
    }
  }

  /**
   * Sprint 5 — Export Excel « soigné » PAR VÉHICULE.
   * POST /api/reports/excel { vehicleId? | fleetId? + groupId?, from, to } → .xlsx.
   *
   * Sans `vehicleId`, le classeur couvre TOUT le périmètre, avec une feuille de synthèse
   * par véhicule en tête — jusqu'au 4 septembre 2026, l'Excel n'existait que par véhicule,
   * et obtenir le mois d'un parc demandait quarante exports recollés à la main.
   * `from`/`to` sont les bornes de la période courante (le `to` est déjà
   * exclusif côté composant, ce que le backend attend : from < to strict).
   * Le nom de fichier est lu depuis le Content-Disposition (le backend nomme
   * `tracky-{plaque}-{from}_{to}.xlsx`), avec un fallback générique.
   */
  /**
   * @param cible.driverId Filtre CONDUCTEUR (F13) — un identifiant, ou `none`. Il borne les
   *   trajets du classeur, et la feuille de synthèse porte le nom de la personne.
   *
   *   ⚠️ Sous ce filtre, le classeur N'EMBARQUE PLUS les passages en station : ce sont des
   *   arrêts du VÉHICULE, que rien ne rattache à quelqu'un. Le classeur le dit — un fichier
   *   composite en silence est pire qu'un fichier incomplet annoncé.
   */
  async downloadExcel(
    cible: { vehicleId?: string; fleetId?: string | null; groupId?: string; driverId?: string },
    from: string,
    to: string,
  ): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.post('/api/reports/excel', {
          // ⚠️ Aucune clé vide n'est envoyée : le serveur distingue « pas de véhicule
          // demandé » (classeur de parc) de « véhicule vide », qui serait un 400.
          ...(cible.vehicleId ? { vehicleId: cible.vehicleId } : {}),
          ...(cible.fleetId ? { fleetId: cible.fleetId } : {}),
          ...(cible.groupId ? { groupId: cible.groupId } : {}),
          ...(cible.driverId ? { driverId: cible.driverId } : {}),
          from, to,
        }, {
          responseType: 'blob',
          observe: 'response',
        }),
      );
      const filename = this.filenameFromResponse(res, 'tracky-export.xlsx');
      this.triggerDownload(res.body ?? new Blob(), filename);
    } catch (err) {
      swallow('reports:downloadExcel', err);
      throw new Error(await this.formatHttpError(err, 'Excel'));
    }
  }

  /**
   * ── LE NOM DU PDF VIENT DU SERVEUR, COMME CELUI DU CSV ET DU CLASSEUR ─────────────────
   *
   * `a.download` ÉCRASE le `Content-Disposition` : tant que les deux chemins PDF refabriquaient
   * le nom ici, tout ce que le serveur y avait mis se perdait sur le disque du gestionnaire.
   * Mesuré en production le 2026-09-06, sur la même période et la même société :
   *
   *   serveur   tracky-rapport-2026-08-31_2026-09-06-conducteur-83c26191.pdf
   *   serveur   tracky-rapport-2026-08-31_2026-09-06-sans-conducteur.pdf
   *   serveur   tracky-rapport-2026-08-31_2026-09-06.pdf
   *   disque    tracky-rapport-2026-08-31_2026-09-07.pdf   ← les trois, à l'identique
   *
   * Trois marques disparaissaient d'un coup : le FILTRE CONDUCTEUR (trois populations sous un
   * seul nom, celle « sans conducteur » étant justement indiscernable de l'export complet), la
   * PLAQUE quand le rapport ne porte que sur un véhicule, et la BORNE DE FIN — `to` est
   * exclusive dans tout le produit, donc le repli datait le fichier d'un jour de trop et
   * contredisait l'aperçu « AU (INCLUS) » de la modale juste avant le clic.
   *
   * Le CSV, le classeur Excel et le rapport de vitesse lisaient déjà l'en-tête ; les deux PDF
   * étaient les seuls restés en arrière.
   *
   * ⚠️ LE REPLI RESTE UN NOM PLAUSIBLE, jamais une chaîne vide : l'en-tête peut manquer (proxy
   * qui le filtre), et un `a.download` vide fait enregistrer le fichier sous « download », sans
   * extension. Il porte donc au moins la marque du conducteur, la seule des trois qu'on puisse
   * recomposer ici sans redemander au serveur ce qu'il vient de dire.
   */
  private nomPdfDepuisReponse(
    res: HttpResponse<unknown>,
    from: string,
    to: string,
    driverId?: string,
  ): string {
    const marque = marqueFichierConducteurDeFiltre(driverId);
    return this.filenameFromResponse(
      res,
      `tracky-rapport-${from.slice(0, 10)}_${to.slice(0, 10)}${marque}.pdf`,
    );
  }

  /**
   * Extrait le filename du header Content-Disposition d'une réponse, sinon
   * `fallback`. Gère `filename="..."` et `filename*=UTF-8''...` (RFC 5987).
   */
  private filenameFromResponse(res: HttpResponse<unknown>, fallback: string): string {
    const cd = res.headers.get('Content-Disposition') ?? res.headers.get('content-disposition');
    if (!cd) return fallback;
    // filename*=UTF-8''nom%20encode.xlsx  (prioritaire si présent)
    const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
    if (star?.[1]) {
      try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fallthrough */ }
    }
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    if (plain?.[1]) return plain[1].trim();
    return fallback;
  }

  /** Extrait le message d'erreur reel renvoye par l'API.
   *  Avec responseType:'blob', l'error.error d'Angular est un Blob → on le parse.
   *  Robuste face aux 3 formes que NestJS peut renvoyer :
   *   - { message: "string" }                          (BadRequestException simple)
   *   - { message: ["err1", "err2"] }                  (class-validator)
   *   - { message: [{ constraints: {...}, property }] } (class-validator detaille) */
  private async formatHttpError(err: unknown, kind: 'PDF' | 'CSV' | 'Excel' | 'Rapport vitesse'): Promise<string> {
    if (err instanceof HttpErrorResponse) {
      const detail = await this.extractErrorDetail(err);
      return `Echec export ${kind} (${err.status})${detail ? ' : ' + detail : ''}`;
    }
    return `Echec export ${kind}`;
  }

  private async extractErrorDetail(err: HttpErrorResponse): Promise<string> {
    let raw: unknown = err.error;
    if (raw instanceof Blob) {
      try {
        const text = await raw.text();
        try { raw = JSON.parse(text); } catch { return text; }
      } catch { return ''; }
    }
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const msg = obj['message'];
      if (typeof msg === 'string') return msg;
      if (Array.isArray(msg)) {
        return msg
          .map((m) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const mObj = m as Record<string, unknown>;
              const constraints = mObj['constraints'];
              if (constraints && typeof constraints === 'object') {
                return Object.values(constraints).join(', ');
              }
              return JSON.stringify(m);
            }
            return String(m);
          })
          .filter(Boolean)
          .join(' ; ');
      }
      if (typeof obj['error'] === 'string') return obj['error'] as string;
      try { return JSON.stringify(obj); } catch { return ''; }
    }
    return String(raw);
  }

  private triggerDownload(blob: Blob, filename: string): void {
    // Trace explicite de l'export (le clic synthétique a.click() est ignoré par le
    // tracker — isTrusted=false) : le nom de fichier porte type + période.
    this.tracker.trackClick(`export:${filename}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

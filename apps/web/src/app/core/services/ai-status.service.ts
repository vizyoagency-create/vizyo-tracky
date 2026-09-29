import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import type { AiFeatureKey, AiStatusDto, FleetAiSettingDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import { FleetFilterService } from './fleet-filter.service';

/**
 * IA — état & interrupteur maître par flotte (2026-07). Le front masque les actions IA quand l'IA est
 * DÉSACTIVÉE pour la flotte de l'utilisateur (l'analyse déterministe des trajets/stations/scores reste
 * accessible). OPT-IN : par défaut tout est OFF tant que le statut n'est pas chargé — on ne montre PAS
 * d'actions IA avant confirmation (évite un flash de boutons IA puis un 403). Le vrai garde-fou reste
 * côté serveur (403), l'UI n'est qu'un confort.
 *
 * ══ Deux défauts corrigés le 2026-08-03 ══════════════════════════════════════════════════════
 *
 * **1. Le `fleetId` n'était jamais transmis.** L'endpoint l'accepte depuis toujours ; ce service ne
 * l'envoyait pas. Or les QUATRE super-admins de la plateforme n'ont pas de flotte, et la porte
 * serveur est fail-CLOSED sans flotte : `enabled` valait donc **toujours false pour un
 * super-admin**, sur n'importe quelle société, y compris une société ayant payé l'option. Toute la
 * couche IA de l'agenda et des récits leur était invisible. Le défaut est resté caché parce
 * qu'aucune société n'avait l'IA active — il se serait déclaré au premier client payant.
 *
 * **2. Le statut ne suivait pas le filtre société.** Chargé une fois pour toutes, il restait celui
 * de la société précédente après un changement de filtre : boutons proposés sur une société sans
 * option (→ 403), ou masqués sur une société qui l'a payée.
 *
 * ⚠️ Gater une affordance sur `enabled` ne suffit pas — utiliser `can(feature)`, qui reflète AUSSI
 * le kill-switch global par fonction. Voir `AiStatusDto.features`.
 */
@Injectable({ providedIn: 'root' })
export class AiStatusService {
  private readonly http = inject(HttpClient);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly auth = inject(AuthService);
  private readonly _status = signal<AiStatusDto | null>(null);
  /** Flotte du statut actuellement chargé — sert à détecter un changement de filtre société. */
  private loadedFor: string | null | undefined = undefined;
  private loading = false;
  /** Numéro de la dernière demande : seule sa réponse s'écrit (29/09). */
  private seq = 0;
  /** Compte pour lequel le statut vaut (`sub`) ; `undefined` = pas encore vu (29/09). */
  private compte: string | null | undefined = undefined;

  readonly status = this._status.asReadonly();
  /**
   * Interrupteur MAÎTRE de la société : « cette société a-t-elle l'option IA ? ». Utile pour les
   * textes d'explication. Pour AFFICHER UN BOUTON, préférer `can(feature)`.
   */
  readonly enabled = computed(() => this._status()?.enabled ?? false);
  /**
   * 29/09 — L'IA DE LA SOCIÉTÉ, telle que le CLIENT l'a choisie (`Fleet.aiEnabled`) : c'est elle qui
   * décide de MONTRER ou non l'IA (propositions de l'agent, Assistant IA, cartes « Agent IA », fil
   * Activité). `enabled` y mêle la présence d'une clé au serveur : sur la démo (aucune clé, option
   * imposée), chaque écran en tirait une conclusion différente. Un serveur d'avant le 29/09 n'envoie
   * pas `fleetEnabled` : on retombe alors sur `enabled`. Faux tant que le statut n'est pas chargé
   * (opt-in). Un bouton qui APPELLE l'IA se garde toujours sur `can(feature)`.
   */
  readonly societeActive = computed(() => {
    const s = this._status();
    if (!s) return false;
    return typeof s.fleetEnabled === 'boolean' ? s.fleetEnabled : s.enabled;
  });
  /** Au moins une clé provider présente côté serveur. */
  readonly configured = computed(() => this._status()?.configured ?? false);

  constructor() {
    // Le filtre société change → le statut de l'ancienne société ne vaut plus rien. On recharge
    // seulement si un statut avait déjà été demandé : sinon on déclencherait un appel sur des
    // écrans qui n'ont rien à voir avec l'IA.
    effect(() => {
      const fleetId = this.fleetFilter.selectedFleetId();
      const compte = this.auth.user()?.sub ?? null;
      // 29/09 (revue « IA désactivée ») — le COMPTE change dans le même onglet (déconnexion, autre
      // connexion) : le statut du compte précédent ne vaut rien pour le nouveau. Depuis que l'agenda,
      // la barre latérale et la page Activité masquent l'IA sur ce statut, le garder montrait ou
      // cachait l'IA d'une autre société. On l'oublie ; les écrans le redemandent (`ensureLoaded`).
      if (this.compte !== undefined && compte !== this.compte) {
        this.compte = compte;
        this.seq++; // une réponse en vol pour l'ancien compte ne s'écrit plus
        this._status.set(null);
        this.loadedFor = undefined;
        this.loading = false;
        return;
      }
      this.compte = compte;
      if (this.loadedFor === undefined) return; // jamais chargé : rien à rafraîchir
      if (fleetId === this.loadedFor) return;
      this.refresh();
    });
  }

  /**
   * Disponibilité RÉELLE d'une fonctionnalité, telle que le serveur l'appliquera : clé provider
   * + kill-switch global de la fonction + interrupteur société. Défaut OFF (opt-in) — une clé
   * absente de la réponse est traitée comme coupée, jamais comme disponible.
   */
  can(feature: AiFeatureKey): boolean {
    return this._status()?.features?.[feature] ?? false;
  }

  /** Charge le statut une seule fois (à appeler à l'init d'un composant IA). */
  ensureLoaded(): void {
    if (this._status() || this.loading) return;
    this.refresh();
  }

  /** (Re)charge le statut IA pour la société actuellement filtrée (best-effort, silencieux). */
  refresh(): void {
    this.loading = true;
    const fleetId = this.fleetFilter.selectedFleetId();
    this.loadedFor = fleetId;
    // 29/09 (revue) — deux changements de société rapprochés : la réponse de la PREMIÈRE, arrivée
    // après celle de la seconde, écrasait le bon statut, et rien ne le relisait avant le changement
    // suivant. Seule la dernière demande écrit.
    const n = ++this.seq;
    // ⚠️ `fleetId` OBLIGATOIRE pour un super-admin : sans lui, le serveur retombe sur la flotte de
    // l'utilisateur — qu'un super-admin n'a pas — et répond « IA coupée » quoi qu'il arrive.
    const params: Record<string, string> = fleetId ? { fleetId } : {};
    this.http.get<AiStatusDto>('/api/ai/status', { params }).subscribe({
      next: (s) => {
        if (n !== this.seq) return;
        this._status.set(s);
        this.loading = false;
      },
      error: () => {
        if (n !== this.seq) return;
        this.loading = false; /* garde l'état optimiste */
      },
    });
  }

  /** Réglage IA courant d'une flotte (pour l'UI de réglages). */
  getFleetEnabled(fleetId?: string): Observable<FleetAiSettingDto> {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<FleetAiSettingDto>('/api/ai/fleet-enabled', { params });
  }

  /** Active/désactive TOUTE l'IA d'une flotte (fleet-admin : sa flotte ; super-admin : `fleetId`). */
  setFleetEnabled(enabled: boolean, fleetId?: string): Observable<FleetAiSettingDto> {
    return this.http.put<FleetAiSettingDto>('/api/ai/fleet-enabled', fleetId ? { enabled, fleetId } : { enabled });
  }
}

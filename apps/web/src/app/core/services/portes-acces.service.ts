import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ConsentService } from './consent.service';
import { PermissionOnboardingService } from './permission-onboarding.service';
import { SecurityService } from './security.service';

/**
 * Les portes d'accès, dans l'ordre où elles se présentent au login.
 * L'ordre est celui du montage dans `DashboardLayoutComponent`.
 */
export type PorteAcces = 'consentement' | 'verification' | 'autorisations';

const ORDRE: readonly PorteAcces[] = ['consentement', 'verification', 'autorisations'];

/**
 * Compte les portes d'accès à franchir, et à quel rang se situe celle qu'on regarde.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CE SERVICE EXISTE (lot B0′)                                       │
 * │                                                                            │
 * │ Trois écrans bloquants peuvent s'enchaîner après la connexion, chacun       │
 * │ ignorant l'existence des autres. L'utilisateur en franchissait un, puis un  │
 * │ deuxième apparaissait, puis parfois un troisième : aucun ne disait combien  │
 * │ il en restait. Une porte sans compteur se lit comme la dernière.            │
 * │                                                                            │
 * │ Le total est CALCULÉ, jamais écrit : la vérification d'appareil n'apparaît  │
 * │ que si la 2FA est active ET la connexion inhabituelle. Un utilisateur       │
 * │ habituel voit « 1 sur 2 », pas « 1 sur 3 » — annoncer une étape qui         │
 * │ n'arrivera pas est le défaut symétrique de ne rien annoncer.                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ LE TOTAL NE REDESCEND JAMAIS — c'est toute la difficulté.
 *
 * Les conditions sont vivantes : accepter le consentement fait retomber
 * `mustAccept()` à faux. Un total lu directement sur les conditions passerait donc
 * de « 1 sur 2 » à « 1 sur 1 » au moment même où l'on franchit la première porte —
 * précisément le défaut de l'assistant de démarrage, dont la barre bondissait de
 * 40 % à 100 %. On mémorise donc les portes VUES exigées depuis le début de la
 * session : le total ne peut que croître, et il croît rarement (une porte qui
 * s'active en retard, le temps qu'un profil se charge).
 */
@Injectable({ providedIn: 'root' })
export class PortesAccesService {
  private readonly consent = inject(ConsentService);
  private readonly security = inject(SecurityService);
  private readonly perms = inject(PermissionOnboardingService);

  /** Les portes qu'on a vues exigées au moins une fois pendant cette session. */
  private readonly exigees = signal<ReadonlySet<PorteAcces>>(new Set());

  constructor() {
    effect(() => {
      const actives: PorteAcces[] = [];
      if (this.consent.mustAccept()) actives.push('consentement');
      if (this.security.mustVerify()) actives.push('verification');
      if (this.perms.shouldOnboard()) actives.push('autorisations');
      if (actives.length === 0) return;

      const connues = this.exigees();
      if (actives.every((p) => connues.has(p))) return;
      this.exigees.set(new Set([...connues, ...actives]));
    });
  }

  /** Nombre total de portes à franchir pour cette session. */
  readonly total = computed(() => this.exigees().size);

  /**
   * « Étape 2 sur 3 », ou `null` s'il n'y a qu'une seule porte — un compteur qui
   * annonce « 1 sur 1 » n'informe personne et ajoute du bruit à un écran bloquant.
   */
  libelle(porte: PorteAcces): string | null {
    const exigees = this.exigees();
    const total = exigees.size;
    if (total < 2) return null;
    const rang = ORDRE.filter((p) => exigees.has(p)).indexOf(porte) + 1;
    if (rang === 0) return null;
    return `Étape ${rang} sur ${total}`;
  }
}

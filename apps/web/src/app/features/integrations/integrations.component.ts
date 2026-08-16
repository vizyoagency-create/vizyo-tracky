import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Observable } from 'rxjs';
import {
  PARTNER_SCOPES,
  PARTNER_SCOPES_DEFAULT_ON,
  PARTNER_SCOPES_SENSITIVE,
  PARTNER_SCOPE_LABELS,
} from '@vizyo/tracky-shared';
import {
  PartnerClaimPreview,
  PartnerIntegrationService,
  PartnerLinkStatus,
  PartnerScopeOption,
} from '../../core/services/partner-integration.service';

/** Catégories dont l'activation expose des données particulièrement sensibles. */
const SENSITIVE = new Set<string>(PARTNER_SCOPES_SENSITIVE);

/**
 * ⚠️ Le catalogue vient du REGISTRE partagé, pas d'un état mémorisé au `claim` :
 * mémorisé, il était VIDE après un rechargement de page sur un lien déjà
 * connecté — les interrupteurs disparaissaient, le client ne pouvait plus rien
 * régler (ni couper une catégorie, ni activer « Corrections depuis Maestroo »).
 */
const SCOPE_CATALOGUE: PartnerScopeOption[] = PARTNER_SCOPES.map((key) => ({
  key,
  label: PARTNER_SCOPE_LABELS[key].label,
  description: PARTNER_SCOPE_LABELS[key].description,
  defaultOn: PARTNER_SCOPES_DEFAULT_ON.includes(key),
}));

/**
 * Écran « Intégrations » du client (fleet-admin). C'est ICI que vit l'interrupteur :
 * Tracky est le fournisseur, il décide de ce qui est partagé et peut tout couper.
 *
 * Trois états : non connecté (saisie du code) → écran de consentement (aperçu, rien
 * n'est encore activé) → connecté (interrupteurs vivants + journal + révocation).
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §13.1
 */
@Component({
  selector: 'app-integrations',
  standalone: true,
  imports: [FormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ig-wrap">
      <header class="ig-head">
        <h1 class="ig-title">Intégrations</h1>
        <p class="ig-lead">
          Connectez votre flotte à une application partenaire. Vous choisissez ce qui est
          partagé, et vous pouvez le couper à tout moment.
        </p>
      </header>

      @if (error(); as err) {
        <!--
          Une erreur porte TOUJOURS un recours (regle du kit). Sans lui, la seule issue est
          de recharger la page — et sur cet ecran, le client vient justement verifier ce
          qui part chez un tiers : le laisser devant un constat muet est le pire moment.
        -->
        <div class="ig-error" role="alert">
          <span>{{ err }}</span>
          <button type="button" class="ig-btn ig-btn-recours" (click)="reessayer()">Réessayer</button>
        </div>
      }

      @if (inviteExpired()) {
        <!-- Le client a cliqué, mais trop tard. On le dit franchement plutôt que
             de le laisser devant un « code invalide » incompréhensible. -->
        <p class="ig-warn" role="alert">
          Ce lien de consentement a expiré. Demandez-nous un nouveau lien — rien n'a
          été partagé entre-temps.
        </p>
      }

      @if (loading()) {
        <p class="ig-muted">Chargement…</p>
      } @else if (preview(); as pv) {
        <!-- ÉCRAN DE CONSENTEMENT — rien n'est encore activé à ce stade. -->
        <section class="ig-card">
          <div class="ig-card-h">Autoriser {{ pv.partner }} ?</div>
          <dl class="ig-meta">
            <dt>Organisation</dt><dd>{{ pv.organizationName }}</dd>
            @if (pv.siret) { <dt>SIRET</dt><dd>{{ pv.siret }}</dd> }
          </dl>
          <p class="ig-muted">
            Cochez les catégories que vous acceptez de partager. Vous pourrez les modifier
            ou tout couper après coup.
          </p>

          <!-- BLOC 1 — le partage courant, coché à la connexion. -->
          <div class="ig-bloc-t">Partage de données · activé à la connexion</div>
          @for (s of courantsDe(pv.scopes); track s.key) {
            <label class="ig-scope">
              <input
                type="checkbox"
                [checked]="chosen().has(s.key)"
                (change)="toggleChoice(s.key)"
              />
              <span class="ig-scope-body">
                <span class="ig-scope-label">{{ s.label }}</span>
                <span class="ig-scope-desc">{{ s.description }}</span>
              </span>
            </label>
          }

          <!--
            BLOC 2 — le sensible, SEPARE et decoche. Il etait melange au reste, distingue par
            une seule pastille : on cochait la position temps reel dans le meme geste que la
            plaque d'immatriculation. Le bandeau nomme l'obligation qui va avec.
          -->
          @if (sensiblesDe(pv.scopes).length) {
            <div class="ig-bloc-t ig-bloc-t--sensible">
              Sensible · décoché · à activer en connaissance de cause
            </div>
            @for (s of sensiblesDe(pv.scopes); track s.key) {
              <label class="ig-scope ig-scope-sensitive">
                <input
                  type="checkbox"
                  [checked]="chosen().has(s.key)"
                  (change)="toggleChoice(s.key)"
                />
                <span class="ig-scope-body">
                  <span class="ig-scope-label">
                    {{ s.label }} <em class="ig-badge">sensible</em>
                  </span>
                  <span class="ig-scope-desc">{{ s.description }}</span>
                </span>
              </label>
            }
          }

          <div class="ig-actions">
            <button type="button" class="ig-btn" (click)="cancelClaim()">Annuler</button>
            <button type="button" class="ig-btn ig-btn-primary" [disabled]="busy()" (click)="approve()">
              J'autorise
            </button>
          </div>
        </section>
      } @else if (state()?.status === 'NONE' || state()?.status === 'REVOKED') {
        <section class="ig-card">
          <div class="ig-card-h">Connecter une application</div>
          @if (state()?.suspendedByPlatform) {
            <!-- Le levier commercial : le client ne peut pas le lever lui-même. -->
            <p class="ig-error" role="alert">
              Votre accès à l'intégration a été suspendu. Contactez Tracky.
            </p>
          } @else {
            <p class="ig-muted">
              Générez un code depuis l'application partenaire, puis collez-le ici.
              Si vous avez reçu un lien par e-mail, le code est déjà rempli.
            </p>
            <div class="ig-row">
              <input
                class="ig-input"
                [(ngModel)]="code"
                placeholder="TRK-XXXX-XXXX-XXXX"
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="ig-btn ig-btn-primary" [disabled]="busy() || !code" (click)="claim()">
                Vérifier
              </button>
            </div>
          }
        </section>
      } @else if (state(); as st) {
        <section class="ig-card">
          <div class="ig-card-h">
            <span>{{ st.organizationName }}</span>
            <span class="ig-status" [class.ig-status-off]="st.status !== 'ACTIVE'">{{ statusLabel(st) }}</span>
          </div>
          @if (st.suspendedByPlatform) {
            <p class="ig-error" role="alert">
              Accès suspendu par Tracky@if (st.suspendedReason) { — {{ st.suspendedReason }} }.
              Contactez-nous pour le rétablir.
            </p>
          }
          <dl class="ig-meta">
            @if (st.approvedAt) { <dt>Connecté le</dt><dd>{{ st.approvedAt | date: 'dd/MM/yyyy HH:mm' }}</dd> }
            <dt>Dernière activité</dt>
            <dd>{{ st.lastSeenAt ? (st.lastSeenAt | date: 'dd/MM/yyyy HH:mm') : 'jamais' }}</dd>
          </dl>
        </section>

        <section class="ig-card">
          <div class="ig-card-h">Ce que vous partagez</div>
          <p class="ig-muted">
            Éteignez une catégorie : elle disparaît chez le partenaire, le reste continue.
          </p>

          <div class="ig-bloc-t">Partage de données · activé à la connexion</div>
          @for (s of scopesCourants(); track s.key) {
            <label class="ig-scope">
              <input
                type="checkbox"
                [checked]="isOn(s.key)"
                [disabled]="busy() || st.status !== 'ACTIVE'"
                (change)="setScope(s.key, !isOn(s.key))"
              />
              <span class="ig-scope-body">
                <span class="ig-scope-label">{{ s.label }}</span>
                <span class="ig-scope-desc">{{ s.description }}</span>
              </span>
              <span class="ig-vol" [class.ig-vol-off]="!isOn(s.key)">{{ volume(s.key) }}</span>
            </label>
          }

          <div class="ig-bloc-t ig-bloc-t--sensible">
            Sensible · éteint par défaut · information des salariés obligatoire
          </div>
          @for (s of scopesSensibles(); track s.key) {
            <label class="ig-scope ig-scope-sensitive">
              <input
                type="checkbox"
                [checked]="isOn(s.key)"
                [disabled]="busy() || st.status !== 'ACTIVE'"
                (change)="setScope(s.key, !isOn(s.key))"
              />
              <span class="ig-scope-body">
                <span class="ig-scope-label">
                  {{ s.label }} <em class="ig-badge">sensible</em>
                </span>
                <span class="ig-scope-desc">{{ s.description }}</span>
              </span>
              <span class="ig-vol" [class.ig-vol-off]="!isOn(s.key)">{{ volume(s.key) }}</span>
            </label>
          }

          <!-- Les deux garanties, ecrites plutot que sous-entendues. -->
          <ul class="ig-garanties">
            <li>
              <strong>Vous</strong> choisissez chaque catégorie, à tout moment.
              Vérifié à chaque requête du partenaire.
            </li>
            <li>
              Éteindre une catégorie <strong>purge</strong> les données correspondantes
              chez le partenaire.
            </li>
          </ul>
        </section>

        @if (st.events?.length) {
          <section class="ig-card">
            <div class="ig-card-h">Journal</div>
            <ul class="ig-log">
              @for (e of st.events; track e.createdAt) {
                <li>
                  <span class="ig-log-date">{{ e.createdAt | date: 'dd/MM HH:mm' }}</span>
                  <span>{{ actionLabel(e.action) }}</span>
                  @if (e.scope) { <span class="ig-log-scope">{{ e.scope }}</span> }
                </li>
              }
            </ul>
          </section>
        }

        <section class="ig-card ig-card-danger">
          <div class="ig-card-h">Révoquer l'accès</div>
          <p class="ig-muted">
            Toutes les données partagées disparaissent chez le partenaire. Cette action est
            définitive : pour vous reconnecter, il faudra refaire un appairage.
          </p>
          <div class="ig-row">
            <input
              class="ig-input"
              [(ngModel)]="confirmName"
              [placeholder]="'Tapez ' + (st.organizationName ?? '') + ' pour confirmer'"
              autocomplete="off"
            />
            <button
              type="button"
              class="ig-btn ig-btn-danger"
              [disabled]="busy() || confirmName !== st.organizationName"
              (click)="revoke()"
            >
              Révoquer
            </button>
          </div>
        </section>
      }
    </div>
  `,
  styles: [
    `
      /*
       * ⚠️ COULEUR DE TEXTE EXPLICITE SUR LA RACINE, jamais héritée.
       *
       * Ce composant utilisait des variables --tk-* QUI N'EXISTENT PAS dans le
       * design system (les vraies sont --fg-* / --bg-* / --border-*). Les
       * valeurs de repli sauvaient les fonds, mais les textes sans couleur
       * dépendaient de l'héritage — et rendaient sombre-sur-sombre dans certains
       * états (constaté le 2026-07-24). Sur un ÉCRAN DE CONSENTEMENT, un libellé
       * de catégorie illisible n'est pas un défaut cosmétique : le client coche
       * sans pouvoir lire ce qu'il autorise.
       *
       * Règle : tout texte porte sa couleur, issue des tokens RÉELS.
       */
      :host { color: var(--fg-primary); }
      .ig-wrap { display: flex; flex-direction: column; gap: 1rem; padding: 1.25rem; max-width: 52rem; color: var(--fg-primary); }
      .ig-title { margin: 0; font-size: 1.35rem; font-weight: 650; color: var(--fg-primary); }
      .ig-lead, .ig-muted { margin: 0.35rem 0 0; color: var(--fg-secondary); font-size: 0.9rem; }
      .ig-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; color: var(--fg-primary); }
      .ig-card-danger { border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
      .ig-card-h { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; font-weight: 600; color: var(--fg-primary); }
      .ig-status { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 999px; background: color-mix(in srgb, var(--color-tracky-light) 14%, transparent); color: var(--texte-succes); }
      .ig-status-off { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--texte-alerte); }
      .ig-meta { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.75rem; margin: 0; font-size: 0.875rem; }
      /* --fg-tertiary est un jeton a 3:1 : lisible a 16 px, pas a 14 (3,16 clair / 3,75
         sombre, mesure). Cf. point ouvert O5 de design/TOKENS.md. */
      .ig-meta dt { color: var(--fg-secondary); }
      .ig-meta dd { margin: 0; color: var(--fg-primary); }
      /*
       * L'ETIQUETTE porte la cible, pas la case : une case a cocher de 44 px est une tache.
       * Mesuree ici en pleine largeur, elle depasse largement le seuil — et cliquer la
       * description coche bien la categorie. Meme parti pris que « Rester connecte » sur
       * /login (cf. fiche de reprise).
       */
      .ig-scope { display: flex; gap: 0.6rem; align-items: flex-start; min-height: 44px; padding: 0.55rem; border-radius: 8px; cursor: pointer; color: var(--fg-primary); }
      .ig-scope:hover { background: var(--bg-tertiary); }
      .ig-scope-sensitive { border-left: 3px solid var(--warning); }
      .ig-scope-body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; }

      /*
       * Les deux BLOCS (B1 § E). Le sensible n'est plus une simple pastille dans une liste
       * plate : il a son bandeau, qui nomme l'obligation legale qui va avec.
       */
      .ig-bloc-t {
        display: flex; align-items: center; gap: 0.5rem; min-height: 26px; margin-top: 0.35rem;
        padding: 0.25rem 0.6rem; border-radius: 7px; background: var(--bg-tertiary);
        font-size: 0.66rem; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--fg-secondary); text-wrap: pretty;
      }
      .ig-bloc-t--sensible {
        background: color-mix(in srgb, var(--warning) 12%, transparent);
        color: var(--texte-attente);
      }

      /* Ce qui part reellement. « Rien n'est transmis » est la moitie qui compte. */
      .ig-vol { flex-shrink: 0; align-self: center; font-size: 0.72rem; font-weight: 700; text-align: right; color: var(--texte-succes); }
      .ig-vol-off { color: var(--fg-secondary); }

      .ig-garanties { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
      .ig-garanties li {
        position: relative; padding-left: 1.15rem; font-size: 0.8rem; line-height: 1.45;
        color: var(--fg-secondary); text-wrap: pretty;
      }
      .ig-garanties li::before {
        content: '✓'; position: absolute; left: 0; top: 0; color: var(--texte-succes); font-weight: 800;
      }
      .ig-garanties strong { color: var(--fg-primary); }
      /* Le libellé que le client LIT pour décider : couleur explicite, obligatoire. */
      .ig-scope-label { font-size: 0.9rem; font-weight: 550; color: var(--fg-primary); }
      .ig-scope-desc { font-size: 0.8rem; color: var(--fg-secondary); }
      .ig-badge { font-style: normal; font-size: 0.68rem; padding: 0.05rem 0.35rem; margin-left: 0.35rem; border-radius: 999px; background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--texte-attente); }
      .ig-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .ig-input { flex: 1 1 14rem; padding: 0.5rem 0.65rem; border-radius: 8px; border: 1px solid var(--border-subtle); background: var(--bg-tertiary); color: var(--fg-primary); }
      .ig-input::placeholder { color: var(--fg-tertiary); }
      .ig-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
      .ig-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-primary); cursor: pointer; font-size: 0.875rem; }
      .ig-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .ig-btn-primary { background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink); font-weight: 600; }
      .ig-btn-danger { background: var(--danger); border-color: transparent; color: var(--accent-ink); font-weight: 600; }
      .ig-error {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        flex-wrap: wrap; margin: 0; padding: 0.6rem 0.75rem; border-radius: 8px;
        background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--texte-alerte);
        font-size: 0.875rem;
      }
      .ig-btn-recours { border-color: color-mix(in srgb, var(--danger) 32%, transparent); color: var(--texte-alerte); flex-shrink: 0; }
      .ig-warn { margin: 0; padding: 0.6rem 0.75rem; border-radius: 8px; background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--texte-attente); font-size: 0.875rem; }
      .ig-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.82rem; color: var(--fg-primary); }
      .ig-log li { display: flex; gap: 0.5rem; align-items: baseline; }
      .ig-log-date { color: var(--fg-secondary); min-width: 6.5rem; }
      .ig-log-scope { color: var(--texte-succes); }
    `,
  ],
})
export class IntegrationsComponent {
  private readonly api = inject(PartnerIntegrationService);
  private readonly route = inject(ActivatedRoute);

  protected readonly state = signal<PartnerLinkStatus | null>(null);
  protected readonly preview = signal<PartnerClaimPreview | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly inviteExpired = signal(false);
  /** Cases cochées sur l'écran de consentement (avant activation). */
  protected readonly chosen = signal<Set<string>>(new Set());

  protected code = '';
  protected confirmName = '';

  /** Catalogue statique du registre partagé — survit au rechargement de page. */
  protected readonly allScopes = computed<PartnerScopeOption[]>(() => SCOPE_CATALOGUE);

  /**
   * Le catalogue en DEUX BLOCS (B1 § E « consentement en deux blocs, sensible décoché »).
   *
   * La séparation ne vient pas d'une liste recopiée ici : elle est dérivée de
   * `PARTNER_SCOPES_SENSITIVE`, le registre partagé, dont un test verrouille l'invariant
   * « SENSIBLE ⇒ jamais dans les défauts ». Une seconde liste tenue à la main divergerait
   * au premier scope ajouté — et divergerait EN SILENCE, sur l'écran où le client accorde
   * l'accès à des données nominatives.
   */
  protected readonly scopesCourants = computed<PartnerScopeOption[]>(
    () => SCOPE_CATALOGUE.filter((s) => !SENSITIVE.has(s.key)),
  );
  protected readonly scopesSensibles = computed<PartnerScopeOption[]>(
    () => SCOPE_CATALOGUE.filter((s) => SENSITIVE.has(s.key)),
  );

  /** Les memes deux blocs, mais sur le catalogue renvoye par l'apercu de consentement. */
  protected courantsDe(scopes: PartnerScopeOption[]): PartnerScopeOption[] {
    return scopes.filter((s) => !SENSITIVE.has(s.key));
  }
  protected sensiblesDe(scopes: PartnerScopeOption[]): PartnerScopeOption[] {
    return scopes.filter((s) => SENSITIVE.has(s.key));
  }

  /**
   * Ce qui part REELLEMENT, categorie par categorie.
   *
   * ⚠️ La planche affiche un VOLUME chiffre (« 3 412 trajets », « 186 pleins »). Ce chiffre
   * n'existe dans AUCUN DTO : ni `PartnerLinkStatus` ni `PartnerScopeOption` ne le portent,
   * et le reconstituer demanderait un appel par categorie. Il est donc laisse de cote —
   * cf. la fiche de reprise. Ce qui est dit ici est ce qu'on sait avec certitude, et c'est
   * la moitie qui compte : quand une categorie est eteinte, RIEN ne part.
   */
  protected volume(key: string): string {
    return this.isOn(key) ? 'Transmis' : "Rien n'est transmis";
  }

  constructor() {
    // Le lien reçu par e-mail arrive ici avec le code déjà résolu. Redemander au
    // client de « vérifier » un code qu'il n'a pas saisi n'a aucun sens : il a
    // cliqué sur « Voir la demande », on lui montre la demande.
    const params = this.route.snapshot.queryParamMap;
    this.code = (params.get('code') ?? '').trim();
    this.inviteExpired.set(params.get('invite') === 'expired');
    this.reload();
  }

  protected isSensitive(key: string): boolean {
    return SENSITIVE.has(key);
  }

  protected isOn(key: string): boolean {
    return (this.state()?.scopes ?? []).includes(key);
  }

  protected statusLabel(st: PartnerLinkStatus): string {
    if (st.suspendedByPlatform) return 'suspendu';
    return st.status === 'ACTIVE' ? 'connecté' : st.status.toLowerCase();
  }

  protected actionLabel(action: string): string {
    const map: Record<string, string> = {
      approved: 'Connexion autorisée',
      scope_enabled: 'Catégorie activée',
      scope_disabled: 'Catégorie coupée',
      revoked: 'Accès révoqué',
      platform_suspended: 'Suspendu par Tracky',
      platform_resumed: 'Rétabli par Tracky',
      billing_changed: 'Facturation modifiée',
    };
    return map[action] ?? action;
  }

  protected toggleChoice(key: string): void {
    const next = new Set(this.chosen());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.chosen.set(next);
  }

  protected claim(): void {
    this.run(this.api.claim(this.code.trim()), (pv) => {
      this.preview.set(pv);
      // Les catégories sensibles arrivent DÉCOCHÉES : c'est au client de les
      // allumer, en connaissance de cause.
      this.chosen.set(new Set(pv.scopes.filter((s) => s.defaultOn).map((s) => s.key)));
    });
  }

  protected cancelClaim(): void {
    this.preview.set(null);
    this.error.set(null);
  }

  protected approve(): void {
    const pv = this.preview();
    if (!pv) return;
    this.run(this.api.approve(this.code.trim(), [...this.chosen()]), () => {
      this.preview.set(null);
      this.code = '';
      this.reload();
    });
  }

  protected setScope(scope: string, enabled: boolean): void {
    this.run(this.api.setScope(scope, enabled), (res) => {
      const st = this.state();
      if (st) this.state.set({ ...st, scopes: res.scopes });
    });
  }

  protected revoke(): void {
    this.run(this.api.revoke('Révoqué depuis l\'espace client'), () => {
      this.confirmName = '';
      this.reload();
    });
  }

  /** Recours de l'etat d'erreur : une erreur sans geste qui suit oblige a recharger la page. */
  protected reessayer(): void {
    this.error.set(null);
    this.reload();
  }

  private reload(): void {
    this.loading.set(true);
    this.api.status().subscribe({
      next: (st) => {
        this.state.set(st);
        this.loading.set(false);
        // ⚠️ APRÈS le statut, jamais avant : une flotte déjà connectée ou suspendue
        // ne doit pas voir un écran de consentement s'ouvrir sous ses yeux.
        if (this.code && !st.suspendedByPlatform && (st.status === 'NONE' || st.status === 'REVOKED')) {
          this.claim();
        }
      },
      error: () => {
        this.error.set('Impossible de charger l\'état de l\'intégration.');
        this.loading.set(false);
      },
    });
  }

  private run<T>(obs: Observable<T>, onOk: (v: T) => void): void {
    this.busy.set(true);
    this.error.set(null);
    obs.subscribe({
      next: (v) => {
        this.busy.set(false);
        onOk(v);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        const message = (err as { error?: { message?: string } })?.error?.message;
        this.error.set(message ?? 'Opération impossible.');
      },
    });
  }
}

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Download, LucideAngularModule, ShieldCheck } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { ConsentService } from '../../core/services/consent.service';
import { PortesAccesService } from '../../core/services/portes-acces.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

const LEGAL_URL = 'https://tracky.vizyoagency.com/mentions-legales.html';

/**
 * Écran de consentement OBLIGATOIRE au login (P2) — overlay bloquant, non
 * dismissible. Rendu par DashboardLayoutComponent quand `consent.mustAccept()`.
 * Accepter → enregistre CGU + Confidentialité puis recharge (ré-init des données
 * qui avaient été bloquées par le gate 403). Refuser → déconnexion.
 */
@Component({
  selector: 'app-consent-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, LogoComponent],
  template: `
    @if (consent.mustAccept()) {
      <div class="cg-overlay" role="dialog" aria-modal="true" aria-labelledby="cg-title">
        <div class="cg-shell">
          <div class="cg-head">
            <span class="cg-badge"><lucide-icon [img]="ShieldCheck" [size]="22"></lucide-icon></span>
            <div>
              <h1 id="cg-title" class="cg-title">Bienvenue sur Vizyo Tracky</h1>
              <p class="cg-sub">
                @if (portes.libelle('consentement'); as rang) { {{ rang }} · }
                Un instant avant de démarrer
              </p>
            </div>
            <app-logo variant="icon" [size]="26" class="cg-logo" />
          </div>

          <p class="cg-lead">
            Merci de confirmer que vous acceptez nos conditions d'utilisation. Vos données
            sont hébergées en France, sécurisées, et vous en gardez le contrôle à tout
            moment (accès, rectification, suppression).
          </p>

          <label class="cg-check">
            <input type="checkbox" [checked]="accepted()" (change)="accepted.set(isChecked($event))" />
            <span>J'ai lu et j'accepte les
              <a [href]="legalUrl" target="_blank" rel="noopener">conditions d'utilisation et la politique de confidentialité</a>.</span>
          </label>

          <!--
            LA NOTE CONDUCTEURS DEVIENT ACTIONNABLE (B1 § F). C'etait « Pensez a informer vos
            conducteurs » : une ligne grise, au conditionnel, sans aucune suite — alors que
            c'est une OBLIGATION legale et que celui qui la lit vient d'accepter les
            conditions. On dit ce qui est du, et on fournit le modele.
          -->
          <div class="cg-note">
            <div class="cg-note-t">Vous devez informer vos conducteurs</div>
            <p class="cg-note-p">
              La géolocalisation d'un salarié doit être annoncée <strong>avant</strong> la mise
              en service. Nous vous fournissons le modèle de note.
            </p>
            <button type="button" class="cg-dl" (click)="telechargerModele()">
              <lucide-icon [img]="Download" [size]="14"></lucide-icon> Télécharger le modèle
            </button>
          </div>

          @if (error()) { <p class="cg-error">{{ error() }}</p> }

          <div class="cg-actions">
            <button type="button" class="cg-btn cg-btn--ghost" (click)="refuse()" [disabled]="busy()">
              Refuser et me déconnecter
            </button>
            <button type="button" class="cg-btn cg-btn--primary"
                    (click)="accept()" [disabled]="!accepted() || busy()">
              {{ busy() ? 'Un instant…' : 'Accepter et continuer' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
    .cg-overlay {
      position: fixed; inset: 0; z-index: 4000;
      background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
      backdrop-filter: blur(8px) saturate(1.2);
      display: flex; align-items: center; justify-content: center; padding: 16px;
      font-family: inherit;
    }
    .cg-shell {
      width: 100%; max-width: 540px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 18px);
      padding: 26px 26px 22px;
      max-height: calc(100dvh - 32px); overflow-y: auto;
    }
    .cg-head { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
    .cg-badge {
      width: 46px; height: 46px; border-radius: 13px; flex: none;
      background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent);
      color: var(--texte-succes); display: flex; align-items: center; justify-content: center;
    }
    .cg-title { margin: 0; font-size: 1.3rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .cg-sub { margin: 2px 0 0; font-size: .84rem; color: var(--fg-secondary); }
    .cg-logo { margin-left: auto; opacity: .9; }
    .cg-lead { margin: 0 0 18px; font-size: .93rem; line-height: 1.6; color: var(--fg-secondary); }
    .cg-check {
      display: flex; gap: 11px; align-items: flex-start; padding: 12px 0;
      font-size: .9rem; line-height: 1.5; color: var(--fg-secondary);
      border-top: 1px solid var(--border-subtle); cursor: pointer;
    }
    .cg-check input { width: 20px; height: 20px; margin-top: 1px; flex: none; accent-color: var(--color-tracky-light); cursor: pointer; }
    /* L ETIQUETTE porte la cible, pas la case : une case de 44 px est une tache. */
    .cg-check { min-height: 44px; }
    .cg-check a { color: var(--texte-succes); text-decoration: none; font-weight: 600; }
    .cg-check a:hover { text-decoration: underline; }
    /*
     * La note conducteurs est une OBLIGATION, pas une politesse : elle prend le ton
     * d'attente (ambre) et non le gris d'une mention de bas de page, ou elle se lisait
     * comme un rappel facultatif.
     */
    .cg-note {
      margin: 14px 0 0; padding: 12px 14px; border-radius: 12px;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    }
    .cg-note-t { font-size: .84rem; font-weight: 800; color: var(--texte-attente); }
    .cg-note-p { margin: 4px 0 0; font-size: .8rem; line-height: 1.5; color: var(--fg-secondary); text-wrap: pretty; }
    .cg-note-p strong { color: var(--fg-primary); }
    .cg-dl {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 44px; margin-top: 10px; padding: 0 13px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid color-mix(in srgb, var(--warning) 34%, transparent);
      color: var(--texte-attente); font: inherit; font-size: .8rem; font-weight: 800; cursor: pointer;
    }
    .cg-error { margin: 12px 0 0; font-size: .85rem; color: var(--texte-alerte); font-weight: 600; }
    .cg-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; margin-top: 20px; }
    .cg-btn {
      font: inherit; font-weight: 700; font-size: .9rem; padding: 11px 18px; border-radius: 11px;
      cursor: pointer; min-height: 44px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-primary);
    }
    .cg-btn:disabled { opacity: .5; cursor: not-allowed; }
    .cg-btn--ghost { color: var(--fg-secondary); }
    .cg-btn--primary { border: 0; background: var(--color-tracky-light); color: var(--accent-ink); }
    @media (max-width: 560px) { .cg-actions { flex-direction: column-reverse; } .cg-btn { width: 100%; } }
    `,
  ],
})
export class ConsentGateComponent {
  readonly consent = inject(ConsentService);
  /** Le rang de cette porte dans la file — calculé, jamais écrit (lot B0′). */
  readonly portes = inject(PortesAccesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);

  readonly ShieldCheck = ShieldCheck;
  readonly Download = Download;
  readonly legalUrl = LEGAL_URL;

  readonly accepted = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  isChecked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  /**
   * LE MODELE DE NOTE, genere ici — pas d'endpoint, pas de fichier a deployer.
   *
   * ⚠️ C'est un MODELE A ADAPTER, pas un document pret a afficher : il porte des champs
   * entre crochets que l'employeur doit remplir, et il le dit en tete. Le texte reprend les
   * mentions que la CNIL attend d'une information prealable (finalite, donnees, duree,
   * destinataires, droits) — la responsabilite de l'adapter reste a l'employeur, et c'est
   * ecrit noir sur blanc dans le fichier.
   */
  telechargerModele(): void {
    const modele = [
      'NOTE D’INFORMATION AUX CONDUCTEURS',
      'Géolocalisation des véhicules de la société',
      '',
      '⚠️ MODÈLE À ADAPTER. Les champs entre crochets doivent être complétés, et le contenu',
      'vérifié au regard de votre situation (accords collectifs, registre des traitements,',
      'consultation du CSE le cas échéant). Ce modèle ne constitue pas un conseil juridique.',
      '',
      '────────────────────────────────────────────────────────────',
      '',
      'À [NOM DE LA SOCIÉTÉ], le [DATE]',
      '',
      'Madame, Monsieur,',
      '',
      'Nous vous informons que les véhicules mis à votre disposition sont équipés d’un',
      'dispositif de géolocalisation, à compter du [DATE DE MISE EN SERVICE].',
      '',
      '1. POURQUOI',
      '   [Préciser la ou les finalités réellement poursuivies, par exemple : sécurité des',
      '   personnes et des biens, suivi des interventions, justification de prestations,',
      '   optimisation des tournées.] Le dispositif n’est pas utilisé pour un autre usage.',
      '',
      '2. CE QUI EST COLLECTÉ',
      '   Position du véhicule, horodatage, vitesse, kilométrage, et les événements liés au',
      '   véhicule (démarrage, arrêt, alertes techniques).',
      '',
      '3. QUAND',
      '   [Préciser les plages : par exemple, pendant le temps de travail uniquement.]',
      '   Hors de ces plages, aucune position n’est enregistrée dès lors que l’usage mixte du',
      '   véhicule est déclaré. Vous pouvez demander à en vérifier le réglage à tout moment.',
      '',
      '4. COMBIEN DE TEMPS',
      '   Les données sont conservées [DURÉE] puis supprimées.',
      '',
      '5. QUI Y ACCÈDE',
      '   [Fonctions habilitées : par exemple, le responsable de flotte et son suppléant.]',
      '   L’accès est nominatif et journalisé.',
      '',
      '6. VOS DROITS',
      '   Vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation et',
      '   d’opposition sur les données vous concernant. Pour l’exercer : [CONTACT].',
      '   Vous pouvez également saisir la CNIL.',
      '',
      'Le dispositif ne permet pas de vous suivre en dehors du cadre décrit ci-dessus.',
      '',
      '[NOM ET FONCTION DU SIGNATAIRE]',
      '',
    ].join('\n');

    const url = URL.createObjectURL(new Blob([modele], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'note-information-conducteurs-modele.txt';
    a.click();
    // Le navigateur garde le Blob en memoire tant que l'URL vit : on la libere.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.toast.success('Modèle téléchargé', 'À adapter à votre situation avant diffusion.');
  }

  async accept(): Promise<void> {
    if (!this.accepted() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const ok = await this.consent.accept();
    if (ok) {
      // Recharge propre : ré-initialise les données qui avaient été bloquées (403) avant l'accord.
      window.location.reload();
    } else {
      this.busy.set(false);
      this.error.set("L'enregistrement a échoué. Réessayez, ou contactez-nous si cela persiste.");
    }
  }

  refuse(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.toast.error('Déconnecté', 'Vous devez accepter les conditions pour utiliser Vizyo Tracky.');
    void this.router.navigate(['/login']);
  }
}

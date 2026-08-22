import { Component, computed, effect, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { PlanService } from '../../core/services/plan.service';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  LucideAngularModule, LogOut, User, Moon, Sun, Bell, Map, MapPin, RotateCcw, Palette,
  Navigation, Route, ArrowRight, Ear, Zap, Sparkles,
  Search, Check, ShieldCheck, CreditCard, SlidersHorizontal, Database,
} from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ThemeService } from '../../core/theme/theme.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { RetentionFleetCardComponent } from './retention-fleet-card.component';
import { Security2faCardComponent } from './security-2fa-card.component';
import { AiBillingCardComponent } from './ai-billing-card.component';
import { AlertRulesCardComponent } from './alert-rules-card.component';
import { NotificationsCardComponent } from './notifications-card.component';
import { roleLabel as roleLabelFr } from '../../shared/utils/role-labels';

/**
 * Les 9 sections de la page, reparties en deux groupes (B1 § E). Remplace les 4 onglets
 * plats — dont « Organisation », qui melangeait reglages personnels et reglages de societe.
 */
type Section =
  | 'apparence' | 'carte' | 'notifications' | 'compte' | 'securite'
  | 'abonnement' | 'regles' | 'donnees' | 'assistance';

interface SectionDef {
  cle: Section;
  titre: string;
  /** Icone lucide de la section. `lucide-angular` n'exporte pas de nom de type public :
   *  on prend celui d'une icone reelle, elles le partagent toutes. */
  icone: typeof Palette;
  /** Phrase d'en-tete : ce que la section fait, et sur QUI elle agit. */
  sousTitre: string;
  /** Termes cherches par l'utilisateur — on cherche un REGLAGE, pas un nom de section. */
  motsCles: string;
}

interface GroupeSection {
  cle: 'moi' | 'flotte';
  titre: string;
  sections: SectionDef[];
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, RouterLink, RetentionFleetCardComponent, Security2faCardComponent, AiBillingCardComponent, NotificationsCardComponent, AlertRulesCardComponent],
  template: `
    <div class="settings-page">
      <div class="s-top">
        <div class="settings-header">
          <span class="vt-eyebrow">Compte</span>
          <h1 class="settings-title">Paramètres</h1>
          <p class="settings-sub">Personnalisez votre expérience et gérez vos options.</p>
        </div>
        @if (enregistreLe()) {
          <span class="s-saved" role="status"><lucide-icon [img]="CheckIcon" [size]="13" /> Enregistré · {{ ilYA() }}</span>
        }
      </div>

      <!--
        Navigation a DEUX NIVEAUX (B1 § E). Une rangee plate d'onglets ne repond pas a la
        question la plus posee : « est-ce que ca ne change que pour moi, ou pour tout le
        monde ? ». Les groupes y repondent AVANT le clic, et la note du bas le dit en toutes
        lettres. « Organisation » melangeait justement les deux (Compte et Securite d'un cote,
        Retention et Mode assistance de l'autre).
      -->
      <div class="s-layout">
        <nav class="s-rail" aria-label="Sections des paramètres">
          <div class="s-search">
            <lucide-icon [img]="SearchIcon" [size]="14" />
            <input
              type="search"
              [value]="recherche()"
              (input)="recherche.set($any($event.target).value)"
              placeholder="Rechercher un réglage…"
              aria-label="Rechercher un réglage" />
          </div>

          @for (g of groupesFiltres(); track g.cle) {
            <span class="s-rail-grp">{{ g.titre }}</span>
            @for (s of g.sections; track s.cle) {
              <button
                type="button"
                class="s-nav"
                [class.on]="section() === s.cle"
                (click)="allerA(s.cle)"
                [attr.aria-current]="section() === s.cle ? 'true' : null">
                <lucide-icon [img]="s.icone" [size]="16" />
                <span class="s-nav-txt">{{ s.titre }}</span>
                @if (estModifiee(s.cle)) {
                  <span class="s-dot" [attr.aria-label]="'Modifié'" title="Modifié par rapport aux valeurs par défaut"></span>
                }
              </button>
            }
          } @empty {
            <p class="s-rail-vide">Aucun réglage ne correspond à « {{ recherche() }} ».</p>
          }

          <p class="s-rail-note">
            Les réglages <strong>Mon espace</strong> ne concernent que vous.
            Ceux de <strong>Ma flotte</strong> s'appliquent à toute la société.
          </p>
        </nav>

        <div class="s-contenu">
          <div class="s-sec-tete">
            <div>
              <h2>{{ titreSection() }}</h2>
              <p>{{ sousTitreSection() }}</p>
            </div>
          </div>

      <!-- ═══════════════ ABONNEMENT & OPTIONS (gated billing_manage) ═══════════════ -->
      @if (section() === 'abonnement' && canBilling()) {
        <!-- Plan — honnête : compteur réel + facturation gérée hors app (pas de faux moyen de paiement). -->
        <div class="s-plan">
          <div class="s-plan-glow"></div>
          <div class="s-plan-row">
            <div class="s-plan-info">
              <span class="vt-eyebrow">Votre abonnement</span>
              <div class="s-plan-count">{{ activeVehicleCount() }} véhicule{{ activeVehicleCount() > 1 ? 's' : '' }} suivi{{ activeVehicleCount() > 1 ? 's' : '' }}</div>
              @if (planLabel()) { <div class="s-plan-note s-plan-offre">Votre offre : {{ planLabel() }}</div> }
              <div class="s-plan-note">La facturation est gérée par votre conseiller Vizyo. Contactez-le pour changer d'offre, ajouter des véhicules ou activer une option.</div>
            </div>
            <a href="mailto:contact@vizyoagency.com" class="s-plan-btn">Contacter mon conseiller</a>
          </div>
        </div>

        <!-- Option IA payante : carte réelle (statut, coût /mois + /voiture, activer/annuler). -->
        @if (isSuperAdmin()) {
          <div class="s-plan-note s-plan-note--sa">L'option IA se gère <strong>par société</strong> depuis l'espace <a routerLink="/admin/ai-usage" class="s-lien-accent">Coûts IA</a> (activation offerte ou suivi des abonnements).</div>
        } @else {
          <app-ai-billing-card></app-ai-billing-card>
        }

        <div class="s-opt-head">
          <h3>Options premium</h3>
          <p>Des capacités avancées activables sur votre flotte.</p>
        </div>
        <div class="s-opt-grid">
          <!-- Suivi temps réel : capacité de base de l'app (honnête : « inclus »). -->
          <div class="s-opt">
            <div class="s-opt-top">
              <span class="s-opt-ico on"><lucide-icon [img]="ZapIcon" [size]="20"></lucide-icon></span>
              <span class="s-opt-status on">Inclus</span>
            </div>
            <h4>Suivi temps réel</h4>
            <p>Positions rafraîchies en direct, rejeu des trajets et carte live. Inclus dans votre abonnement.</p>
          </div>

          <!-- Micro d'assistance : état RÉEL d'éligibilité audio (N1 prestataire). -->
          <div class="s-opt">
            <div class="s-opt-top">
              <span class="s-opt-ico" [class.on]="audioEligible()"><lucide-icon [img]="EarIcon" [size]="20"></lucide-icon></span>
              @if (audioEligible()) {
                <span class="s-opt-status on">Éligible</span>
              } @else {
                <span class="s-opt-status">Sur demande</span>
              }
            </div>
            <h4>Micro d'assistance</h4>
            <p>Écoute d'habitacle sous cadre légal, en cas d'accident ou de litige (attestation requise).</p>
            @if (audioEligible() && perms.can('audio_monitoring')) {
              <a routerLink="/settings/audio-monitoring" class="s-opt-link">Gérer le Mode assistance <lucide-icon [img]="ArrowRightIcon" [size]="13"></lucide-icon></a>
            } @else {
              <span class="s-opt-hint">Activation par votre conseiller Vizyo.</span>
            }
          </div>

          <!-- Agent IA : état RÉEL de la permission ai_optimize. -->
          <div class="s-opt">
            <div class="s-opt-top">
              <span class="s-opt-ico" [class.on]="perms.can('ai_optimize')"><lucide-icon [img]="SparklesIcon" [size]="20"></lucide-icon></span>
              @if (perms.can('ai_optimize')) {
                <span class="s-opt-status on">Activé</span>
              } @else {
                <span class="s-opt-status">Sur demande</span>
              }
            </div>
            <h4>Agent IA</h4>
            <p>Optimisation des tournées et réaffectations véhicule / conducteur, avec propositions expliquées.</p>
            @if (perms.can('ai_optimize')) {
              <a routerLink="/agenda" class="s-opt-link">Ouvrir l'agenda IA <lucide-icon [img]="ArrowRightIcon" [size]="13"></lucide-icon></a>
            } @else {
              <span class="s-opt-hint">Disponible sur demande.</span>
            }
          </div>
        </div>
      }

      <!-- ═══════════════ APPARENCE ═══════════════ -->
      @if (section() === 'apparence') {
        <div class="settings-grid">
          <div class="settings-col">
            <!-- APPARENCE -->
            <div class="s-card">
              <div class="s-card-head">
                <div class="s-icon purple"><lucide-icon [img]="PaletteIcon" [size]="16"></lucide-icon></div>
                <div class="s-card-title">Thème &amp; interface</div>
              </div>
              <div class="s-card-body">
                <div class="theme-picker">
                  <button (click)="theme.setTheme('dark')" class="theme-option" [class.active]="theme.theme() === 'dark'">
                    <div class="theme-preview dark-preview">
                      <div class="tp-bar"></div><div class="tp-content"><div class="tp-line"></div><div class="tp-line short"></div></div>
                    </div>
                    <div class="theme-label">
                      <lucide-icon [img]="MoonIcon" [size]="12"></lucide-icon> Sombre
                    </div>
                  </button>
                  <button (click)="theme.setTheme('light')" class="theme-option" [class.active]="theme.theme() === 'light'">
                    <div class="theme-preview light-preview">
                      <div class="tp-bar"></div><div class="tp-content"><div class="tp-line"></div><div class="tp-line short"></div></div>
                    </div>
                    <div class="theme-label">
                      <lucide-icon [img]="SunIcon" [size]="12"></lucide-icon> Clair
                    </div>
                  </button>
                </div>

                <!-- V1.12 — Mode interface : Tracky (riche) vs Baanool (simplifie) -->
                <div class="ui-mode-section">
                  <div class="ui-mode-row">
                    <div class="ui-mode-txt">
                      <div class="ui-mode-title">Mode interface simplifiée</div>
                      <p class="ui-mode-desc">
                        Connexion directe à la carte, rails de navigation masqués, menu
                        au bouton. Toutes les pages restent accessibles — le menu les
                        garde toutes, et « Paramètres » y reste détaché pour revenir en
                        interface complète.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="ui-mode-sw"
                      (click)="toggleBaanoolMode()"
                      [class.on]="isBaanoolMode()"
                      [attr.aria-pressed]="isBaanoolMode()"
                      [disabled]="savingUiMode()"
                      aria-label="Mode interface simplifiée">
                      <span class="ui-mode-knob"></span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      }

      <!-- ═══════════════ CARTE ═══════════════ -->
      @if (section() === 'carte') {
        <div class="settings-grid">
          <div class="settings-col">
            <!-- CARTE -->
            @if (perms.can('vehicles_view')) {
            <div class="s-card">
              <div class="s-card-head">
                <div class="s-icon blue"><lucide-icon [img]="MapIcon" [size]="16"></lucide-icon></div>
                <div class="s-card-title">Carte</div>
              </div>
              <div class="s-card-body">
                <!-- Centre -->
                <div class="map-row">
                  <div class="map-row-left">
                    <lucide-icon [img]="NavigationIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                    <span class="map-label">Centre</span>
                  </div>
                  <div class="map-row-right">
                    <input type="number" step="0.001" [ngModel]="prefs().map.centerLat" (ngModelChange)="setMapPref('centerLat', $event)" class="coord-input" />
                    <input type="number" step="0.001" [ngModel]="prefs().map.centerLng" (ngModelChange)="setMapPref('centerLng', $event)" class="coord-input" />
                    <button type="button" (click)="useMyPosition()" class="geo-btn" title="Ma position" aria-label="Centrer sur ma position">
                      <lucide-icon [img]="MapPinIcon" [size]="13"></lucide-icon>
                    </button>
                  </div>
                </div>
                <!-- Zoom -->
                <div class="map-row">
                  <div class="map-row-left">
                    <lucide-icon [img]="MapIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                    <span class="map-label">Zoom</span>
                  </div>
                  <div class="map-row-right gap-2">
                    <span class="zoom-value">{{ prefs().map.zoom }}</span>
                    <input type="range" min="5" max="18" [ngModel]="prefs().map.zoom" (ngModelChange)="setMapPref('zoom', $event)" class="range-styled" />
                  </div>
                </div>
                <!-- Trails -->
                <div class="map-row">
                  <div class="map-row-left">
                    <lucide-icon [img]="RouteIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                    <span class="map-label">Traînées</span>
                  </div>
                  <div class="map-row-right">
                    @if (prefs().map.showTrails) {
                      <span class="zoom-value">{{ prefs().map.trailLength }}pts</span>
                      <input type="range" min="5" max="50" [ngModel]="prefs().map.trailLength" (ngModelChange)="setMapPref('trailLength', $event)" class="range-styled range-sm" />
                    }
                    <label class="toggle">
                      <input type="checkbox" [checked]="prefs().map.showTrails" (change)="setMapPref('showTrails', !prefs().map.showTrails)" />
                      <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
            }
          </div>
        </div>
      }

      <!-- ═══════════════ NOTIFICATIONS ═══════════════ -->
      @if (section() === 'notifications') {
        <div class="settings-grid">
          <div class="settings-col">
            <!-- PUSH NOTIFICATIONS — carte dédiée, adossée aux préférences SERVEUR.
                 L'ancienne liste d'interrupteurs vivait en localStorage : elle donnait
                 l'illusion de filtrer alors que la chaîne d'envoi ne l'a jamais lue.
                 Tout ce qui décide d'un envoi est désormais côté API.
                 Placée en PREMIER : sur téléphone la grille s'empile, et c'est la carte
                 qu'on vient chercher quand on ne reçoit rien. -->
            @if (perms.can('alerts_view')) {
              <app-notifications-card />
            }
          </div>

          <div class="settings-col">
            <!-- NOTIFICATIONS IN-APP -->
            @if (perms.can('alerts_view')) {
            <div class="s-card">
              <div class="s-card-head">
                <div class="s-icon amber"><lucide-icon [img]="BellIcon" [size]="16"></lucide-icon></div>
                <div class="s-card-title">Notifications in-app</div>
              </div>
              <div class="s-card-body">
                <p class="section-desc">Toasts affichés dans l'application selon la sévérité.</p>
                @for (n of notifItems; track n.key) {
                  <div class="notif-row">
                    <div class="notif-left">
                      <div class="notif-dot" [class]="n.color"></div>
                      <div>
                        <p class="notif-name">{{ n.label }}</p>
                        <p class="notif-desc">{{ n.desc }}</p>
                      </div>
                    </div>
                    <div class="notif-right">
                      @if (prefs().notifications[n.key].enabled && n.key !== 'critical') {
                        <select [ngModel]="prefs().notifications[n.key].duration" (ngModelChange)="setNotifDuration(n.key, $event)" class="duration-select">
                          <option [ngValue]="3000">3s</option>
                          <option [ngValue]="6000">6s</option>
                          <option [ngValue]="10000">10s</option>
                          <option [ngValue]="0">∞</option>
                        </select>
                      }
                      @if (n.key === 'critical' && prefs().notifications.critical.enabled) {
                        <span class="permanent-badge">∞</span>
                      }
                      <label class="toggle">
                        <input type="checkbox" [checked]="prefs().notifications[n.key].enabled" (change)="toggleNotif(n.key)" />
                        <span class="toggle-track"><span class="toggle-thumb"></span></span>
                      </label>
                    </div>
                  </div>
                }
              </div>
            </div>

            }
          </div>
        </div>
      }

      <!-- ═══════════════ RÈGLES D'ALERTE ═══════════════ -->
      <!--
        Ce que la FLOTTE envoie (e-mail / WhatsApp). Ces regles vivaient dans une page separee
        ET dans un onglet de la page Alertes — deux formulaires identiques, donc deux fois les
        memes bugs. Il n'en reste qu'un.

        Passe de « Notifications » a « Ma flotte » au lot B-pages : elles etaient cote a cote
        avec les reglages PERSONNELS de notification, ce qui laissait croire qu'on reglait ce
        qu'ON recoit. On regle ce que la SOCIETE envoie, a tout le monde.
      -->
      @if (section() === 'regles') {
        <div class="settings-grid">
          <div class="settings-col">
            @if (perms.can('alerts_view')) {
              <app-alert-rules-card />
            }
          </div>
        </div>
      }

      <!-- ═══════════════ MON COMPTE ═══════════════ -->
      @if (section() === 'compte') {
        <div class="settings-grid">
          <div class="settings-col">
            <!-- COMPTE -->
            <div class="s-card">
              <div class="s-card-head">
                <div class="s-icon green"><lucide-icon [img]="UserIcon" [size]="16"></lucide-icon></div>
                <div class="s-card-title">Compte</div>
              </div>
              <div class="s-card-body">
                <div class="account-block">
                  <div class="avatar">{{ initials() }}</div>
                  <div class="account-info">
                    <p class="account-email">{{ user()?.email || '—' }}</p>
                    <span class="role-badge" [class]="user()?.role === 'FLEET_ADMIN' || user()?.role === 'SUPER_ADMIN' ? 'admin' : 'viewer'">
                      {{ roleLabel() || 'Utilisateur' }}
                    </span>
                  </div>
                </div>
                <a routerLink="/account" class="account-link">
                  <lucide-icon [img]="UserIcon" [size]="14"></lucide-icon>
                  Voir mon profil
                </a>
                <button (click)="logout()" class="logout-btn">
                  <lucide-icon [img]="LogOutIcon" [size]="15"></lucide-icon>
                  Se déconnecter
                </button>
              </div>
            </div>

          </div>
        </div>
      }

      <!-- ═══════════════ SÉCURITÉ ═══════════════ -->
      @if (section() === 'securite') {
        <div class="settings-grid">
          <div class="settings-col">
            <!-- Sécurité du compte — vérification en 2 étapes (2FA), opt-in PAR
                 UTILISATEUR (tout le monde peut sécuriser son propre compte). -->
            <app-security-2fa-card />
          </div>
        </div>
      }

      <!-- ═══════════════ DONNÉES & RÉTENTION ═══════════════ -->
      @if (section() === 'donnees') {
        <div class="settings-grid">
          <div class="settings-col">
            <!-- Sprint 6 — Rétention des données de la flotte (lecture seule, FLEET_ADMIN). -->
            @if (user()?.role === 'FLEET_ADMIN') {
              <app-retention-fleet-card />
            }
          </div>
        </div>
      }

      <!-- ═══════════════ MODE ASSISTANCE ═══════════════ -->
      @if (section() === 'assistance') {
        <div class="settings-grid">
          <div class="settings-col">
            <!-- AUDIO N2 — Mode assistance (fleet-admin éligible). -->
            @if (user()?.role === 'FLEET_ADMIN' && perms.can('audio_monitoring') && audioEligible()) {
            <div class="s-card">
              <div class="s-card-head">
                <div class="s-icon violet"><lucide-icon [img]="EarIcon" [size]="16"></lucide-icon></div>
                <div class="s-card-title">Mode assistance</div>
              </div>
              <div class="s-card-body">
                <p class="section-desc">
                  En cas d'accident, autorisez le prestataire à activer l'écoute de la cabine pour
                  vous porter assistance (capacité légalement sensible, attestation requise).
                </p>
                <a routerLink="/settings/audio-monitoring" class="advanced-link">
                  Gérer le Mode assistance
                  <lucide-icon [img]="ArrowRightIcon" [size]="13"></lucide-icon>
                </a>
              </div>
            </div>
            }
          </div>
        </div>
      }

          <!--
            Reinitialisation — action GLOBALE et non « par section ». La planche montre un
            « Retablir les valeurs par defaut » dans l'en-tete de chaque section ; ici le
            geste remet TOUTES les preferences a zero. Le libelle dit donc ce qu'il fait, et
            le bouton n'apparait que sur les sections de preferences personnelles, la ou il a
            un sens — pas sous « Mode assistance », ou il s'etait retrouve par heritage de
            l'ancien onglet « Organisation ».
          -->
          @if (sectionPersonnelle()) {
            <button (click)="resetAll()" class="reset-btn">
              <lucide-icon [img]="ResetIcon" [size]="14"></lucide-icon>
              Réinitialiser tous les paramètres
            </button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    /* ── Navigation a deux niveaux (B1 § E) ───────────────────────────────── */
    .s-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .s-saved {
      display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: 0 12px;
      border-radius: 10px; white-space: nowrap; font-size: 12px; font-weight: 700;
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      color: var(--texte-succes);
    }
    .s-layout { display: grid; grid-template-columns: 248px minmax(0, 1fr); gap: 20px; align-items: start; margin-top: 18px; }
    .s-rail {
      display: flex; flex-direction: column; gap: 3px; padding: 12px 10px;
      border: 1px solid var(--border-subtle); border-radius: 14px; background: var(--bg-secondary);
      position: sticky; top: 12px;
    }
    .s-search {
      display: flex; align-items: center; gap: 9px; min-height: 44px; padding: 0 11px;
      border-radius: 10px; background: var(--bg-primary); border: 1px solid var(--border-strong);
      margin-bottom: 9px; color: var(--fg-secondary);
    }
    .s-search input {
      flex: 1; min-width: 0; border: 0; background: transparent; color: var(--fg-primary);
      font-size: 13px; font-family: inherit; outline: none;
    }
    .s-search input::placeholder { color: var(--fg-secondary); }
    .s-rail-grp {
      font-size: 10.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
      color: var(--fg-secondary); padding: 12px 11px 4px;
    }
    .s-rail-grp:first-of-type { padding-top: 4px; }
    .s-nav {
      display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 11px;
      border-radius: 10px; border: 1px solid transparent; background: transparent;
      color: var(--fg-secondary); font-size: 13.5px; font-weight: 600; font-family: inherit;
      cursor: pointer; text-align: left; width: 100%;
    }
    .s-nav:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .s-nav.on {
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 28%, transparent);
      color: var(--texte-succes);
    }
    .s-nav-txt { min-width: 0; flex: 1; }
    .s-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-tracky-light); flex-shrink: 0; }
    .s-rail-vide { margin: 8px 11px; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); text-wrap: pretty; }
    .s-rail-note {
      margin: 14px 0 0; padding: 12px 11px 2px; border-top: 1px solid var(--border-subtle);
      font-size: 11.5px; line-height: 1.5; color: var(--fg-secondary); text-wrap: pretty;
    }
    .s-rail-note strong { color: var(--fg-primary); }
    .s-contenu { min-width: 0; }

    /*
     * Mode interface simplifiee — etait ecrit en STYLES EN LIGNE, avec un blanc en dur sur le
     * curseur (critere de recette n° 1 « aucun style en ligne », et la regle « aucune couleur
     * en dur »). Ce blanc ne suivait aucun theme.
     *
     * L'interrupteur mesure 44 px de haut au TOUCHER (zone cliquable) tout en gardant sa
     * piste de 24 px a l'oeil : c'est la zone qui doit faire 44, pas le dessin.
     */
    .ui-mode-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-subtle); }
    .ui-mode-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .ui-mode-txt { flex: 1; min-width: 0; }
    .ui-mode-title { font-size: 13px; font-weight: 600; color: var(--fg-primary); margin-bottom: 4px; }
    .ui-mode-desc { font-size: 11.5px; color: var(--fg-secondary); margin: 0; line-height: 1.45; text-wrap: pretty; }
    .ui-mode-sw {
      flex-shrink: 0; width: 44px; min-height: 44px; border: none; background: transparent;
      cursor: pointer; position: relative; display: flex; align-items: center; padding: 0;
    }
    .ui-mode-sw::before {
      content: ''; position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
      height: 24px; border-radius: 9999px; background: var(--bg-tertiary); transition: background .2s;
    }
    .ui-mode-sw.on::before { background: var(--color-tracky-light); }
    .ui-mode-sw:disabled { opacity: .55; cursor: default; }
    .ui-mode-knob {
      position: absolute; top: 50%; left: 2px; transform: translateY(-50%);
      width: 20px; height: 20px; border-radius: 50%; background: var(--accent-ink);
      transition: left .2s; z-index: 1;
    }
    .ui-mode-sw:not(.on) .ui-mode-knob { background: var(--fg-secondary); }
    .ui-mode-sw.on .ui-mode-knob { left: 22px; }
    .s-sec-tete { margin-bottom: 16px; }
    .s-sec-tete h2 { margin: 0; font-size: 19px; font-weight: 800; letter-spacing: -.025em; color: var(--fg-primary); }
    .s-sec-tete p { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-secondary); text-wrap: pretty; }

    /*
     * Sous 900 px, le rail passe AU-DESSUS du contenu et defile horizontalement : une colonne
     * de 248 px sur un telephone ne laisse plus rien au reglage lui-meme. Les deux groupes
     * restent nommes — c'est la reponse a « ca change pour moi ou pour tout le monde ? », et
     * elle ne doit pas disparaitre avec la largeur.
     */
    @media (max-width: 900px) {
      .s-layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }
      .s-rail { position: static; }
    }

    /* Cibles tactiles au doigt — critère de recette « iPhone 390 px : cibles ≥ 44 px ».
       Mesuré à 375 px : les onglets de section, le bouton d'offre et les liens
       d'option étaient sous le seuil. Une page de réglages se parcourt au pouce. */
    @media (max-width: 768px) {
      .s-tab, .s-plan-btn, .s-opt-link { min-height: 44px }
    }
    .settings-page { max-width: 1080px; margin: 0 auto }
    .settings-header { margin-bottom: 18px }
    .settings-title { font-size: 26px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.03em; margin-top: 6px }
    .settings-sub { font-size: 13px; color: var(--fg-secondary); margin-top: 3px }
    .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start }
    .settings-col { display: flex; flex-direction: column; gap: 16px }

    /* Tabs */
    .s-tabs { display: flex; align-items: center; gap: 6px; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap }
    .s-tab { padding: 8px 15px; border-radius: 10px; font-size: 13px; font-weight: 700; color: var(--fg-secondary); cursor: pointer; border: 1px solid transparent; background: transparent; white-space: nowrap; transition: color .15s, background .15s, border-color .15s }
    .s-tab:hover { color: var(--fg-secondary) }
    .s-tab.active { background: var(--bg-secondary); color: var(--fg-primary); border-color: var(--border-strong, var(--border-subtle)) }

    /* Plan hero */
    .s-plan { position: relative; overflow: hidden; padding: 22px 24px; margin-bottom: 22px; border-radius: 18px; border: 1px solid var(--border-strong, var(--border-subtle)); background: color-mix(in srgb, var(--tracky) 5%, var(--bg-secondary)) }
    .s-plan-glow { position: absolute; top: -30%; right: -8%; width: 45%; height: 120%; pointer-events: none; background: radial-gradient(circle, color-mix(in srgb, var(--tracky) 12%, transparent), transparent 70%); filter: blur(8px) }
    .s-plan-row { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap }
    .s-plan-count { font-size: 1.9rem; font-weight: 800; letter-spacing: -.03em; margin-top: 8px }
    .s-plan-note { font-size: .84rem; color: var(--fg-secondary); margin-top: 8px; max-width: 56ch; line-height: 1.5 }
    .s-plan-btn { display: inline-flex; align-items: center; height: 40px; padding: 0 18px; border-radius: 11px; border: none; background: var(--tracky); color: var(--accent-ink); font-size: .84rem; font-weight: 700; cursor: pointer; white-space: nowrap; text-decoration: none }
    .s-plan-btn:hover { background: var(--tracky-light) }

    /* Options premium */
    .s-opt-head { margin-bottom: 12px }
    .s-opt-head h3 { font-size: 1.05rem; font-weight: 800; letter-spacing: -.01em; color: var(--fg-primary) }
    .s-opt-head p { margin-top: 5px; font-size: .86rem; color: var(--fg-secondary) }
    .s-opt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px }
    .s-opt { padding: 18px 19px; border-radius: 16px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); transition: transform .2s, border-color .2s }
    .s-opt:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--tracky) 40%, transparent) }
    .s-opt-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px }
    .s-opt-ico { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 12px; background: var(--bg-tertiary); color: var(--fg-tertiary) }
    /* Deux styles en ligne portaient un repli mort — var(--tracky-light, #3EEBB8) et
       var(--tracky-light, #10E0A0). La variable est TOUJOURS definie : la valeur de repli
       n'est jamais atteinte, elle ne fait que figer une couleur hors systeme. */
    .s-plan-offre { color: var(--texte-succes); font-weight: 600 }
    .s-plan-note--sa { margin: 14px 0 0 }
    .s-lien-accent { color: var(--texte-succes) }
    .s-opt-ico.on { background: color-mix(in srgb, var(--tracky) 12%, transparent); color: var(--texte-succes) }
    .s-opt-status { padding: 3px 10px; border-radius: 999px; font-size: .68rem; font-weight: 800; background: var(--bg-tertiary); color: var(--fg-secondary) }
    .s-opt-status.on { background: color-mix(in srgb, var(--tracky) 14%, transparent); color: var(--texte-succes) }
    .s-opt h4 { margin: 14px 0 0; font-size: 1rem; font-weight: 700; color: var(--fg-primary) }
    .s-opt p { margin: 6px 0 0; font-size: .82rem; color: var(--fg-secondary); line-height: 1.5 }
    .s-opt-link { display: inline-flex; align-items: center; gap: 5px; margin-top: 12px; font-size: .8rem; font-weight: 700; color: var(--texte-succes) }
    .s-opt-link:hover { text-decoration: underline }
    .s-opt-hint { display: block; margin-top: 12px; font-size: .76rem; color: var(--fg-secondary) }

    /* Card */
    .s-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden }
    .s-card-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle) }
    .s-card-title { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .s-card-body { padding: 18px }
    .s-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    /* DS : accent émeraude unique — les sections se distinguent par leur icône,
       pas par une couleur différente (fin de l'arc-en-ciel violet/bleu/cyan). */
    .s-icon.green, .s-icon.purple, .s-icon.amber, .s-icon.blue, .s-icon.cyan, .s-icon.violet {
      /* Pictogramme sur son propre lavis : le vert de marque tombe a ~3:1 en
         clair, sous le seuil graphique. --texte-succes tient dans les deux themes. */
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); color: var(--texte-succes);
    }

    /* Account */
    .account-block { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 12px; background: var(--bg-tertiary); margin-bottom: 14px }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--tracky); color: var(--accent-ink); font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    .account-email { font-size: 14px; font-weight: 600; color: var(--fg-primary) }
    .role-badge { display: inline-block; margin-top: 3px; padding: 2px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em }
    /* rgba(16,224,160,.15) etait le vert de marque ecrit autrement — il n'a pas de « # »
       pour se denoncer, mais c'est bien une couleur en dur. Meme chose pour le rouge du
       survol de deconnexion. */
    .role-badge.admin { background: color-mix(in srgb, var(--color-tracky-light) 15%, transparent); color: var(--texte-succes) }
    .role-badge.viewer { background: var(--bg-secondary); color: var(--fg-secondary) }
    .logout-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
      background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--texte-alerte); border: 1px solid color-mix(in srgb, var(--danger) 18%, transparent); cursor: pointer; transition: all .2s;
    }
    .logout-btn:hover { background: color-mix(in srgb, var(--danger) 15%, transparent) }
    .account-link {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
      background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle);
      text-decoration: none; transition: all .2s; margin-right: 8px;
    }
    .account-link:hover { background: var(--bg-secondary); color: var(--fg-primary); border-color: var(--border-strong) }
    .advanced-link {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; padding: 10px 14px;
      border-radius: 10px; font-size: 12px; font-weight: 600; color: var(--tracky-light);
      text-decoration: none; background: rgba(16,224,160,.06); border: 1px solid rgba(16,224,160,.18);
      transition: all .2s;
    }
    .advanced-link:hover { background: rgba(16,224,160,.12); border-color: rgba(16,224,160,.28) }

    /* Note : les styles du push (statut, bouton, liste des types) vivent desormais
       dans <app-notifications-card> — ils n'ont plus de porteur ici. */
    .section-desc { font-size: 11px; color: var(--fg-secondary); margin: 0 0 12px }

    /* Theme picker */
    .theme-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 12px }
    .theme-option { padding: 0; border: 2px solid var(--border-subtle); border-radius: 12px; overflow: hidden; cursor: pointer; transition: all .2s; background: transparent }
    .theme-option:hover { border-color: var(--border-strong) }
    .theme-option.active { border-color: var(--tracky); box-shadow: 0 0 0 2px rgba(16,224,160,.30); background: rgba(16,224,160,.10) }
    .theme-preview { height: 56px; position: relative; overflow: hidden }
    .dark-preview { background: #0b1120 }
    .light-preview { background: #f1f5f9 }
    .tp-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 24px }
    .dark-preview .tp-bar { background: #111827 }
    .light-preview .tp-bar { background: #e2e8f0 }
    .tp-content { position: absolute; left: 30px; top: 10px; display: flex; flex-direction: column; gap: 4px }
    .tp-line { width: 40px; height: 4px; border-radius: 2px }
    .tp-line.short { width: 24px }
    .dark-preview .tp-line { background: #1e293b }
    .light-preview .tp-line { background: #cbd5e1 }
    .theme-label { display: flex; align-items: center; justify-content: center; gap: 5px; padding: 8px; font-size: 12px; font-weight: 600; color: var(--fg-secondary) }
    .theme-option.active .theme-label { color: var(--texte-succes) }

    /* Notifications */
    .notif-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-subtle) }
    .notif-row:last-child { border-bottom: none }
    .notif-left { display: flex; align-items: center; gap: 10px }
    .notif-right { display: flex; align-items: center; gap: 8px }
    .notif-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0 }
    .notif-dot.red { background: var(--danger) }
    .notif-dot.amber { background: var(--warning) }
    .notif-dot.blue { background: var(--fg-tertiary) }
    .notif-name { font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .notif-desc { font-size: 10px; color: var(--fg-secondary); margin-top: 1px }
    .permanent-badge { font-size: 11px; color: var(--fg-secondary); padding: 2px 8px; border-radius: 6px; background: var(--bg-tertiary) }
    .duration-select {
      padding: 4px 24px 4px 10px; border-radius: 9999px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 11px; font-weight: 700; outline: none; cursor: pointer;
      appearance: none; -webkit-appearance: none; -moz-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2310E0A0' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      transition: all .15s;
    }
    .duration-select:hover { border-color: var(--tracky); color: var(--fg-primary); }
    .duration-select:focus { border-color: var(--tracky); }

    /* Map settings */
    .map-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-subtle) }
    .map-row:last-child { border-bottom: none }
    .map-row-left { display: flex; align-items: center; gap: 8px }
    .map-row-right { display: flex; align-items: center; gap: 6px }
    .map-label { font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .coord-input {
      width: 72px; padding: 5px 6px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 11px; font-family: var(--font-mono, monospace); text-align: center; outline: none;
    }
    .coord-input:focus { border-color: var(--tracky) }
    .geo-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; padding: 6px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; transition: all .2s }
    .geo-btn:hover { color: var(--tracky-light); border-color: var(--tracky) }
    .zoom-value { font-size: 12px; font-weight: 700; color: var(--fg-secondary); font-family: var(--font-mono, monospace); min-width: 30px; text-align: right }
    .range-styled { accent-color: var(--tracky); cursor: pointer }
    .range-sm { width: 80px }

    /* Toggle */
    .toggle { position: relative; display: inline-flex; cursor: pointer }
    .toggle input { position: absolute; opacity: 0; width: 0; height: 0 }
    .toggle-track { width: 40px; height: 22px; border-radius: 9999px; background: var(--bg-tertiary); transition: background .2s; position: relative; display: inline-block }
    .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left .2s }
    .toggle input:checked + .toggle-track { background: var(--tracky) }
    .toggle input:checked + .toggle-track .toggle-thumb { left: 20px }

    /* Reset */
    .reset-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px; margin-top: 20px; min-height: 44px; padding: 10px 18px; border-radius: 10px;
      font-size: 12px; font-weight: 600; background: var(--bg-secondary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle); cursor: pointer; transition: all .2s;
    }
    .reset-btn:hover { color: var(--fg-secondary); border-color: var(--border-strong) }

    @media (max-width: 900px) {
      .s-opt-grid { grid-template-columns: 1fr }
    }
    @media (max-width: 768px) {
      .settings-grid { grid-template-columns: 1fr }
    }
  `],
})
export class SettingsComponent implements OnInit, OnDestroy {
  private readonly planSvc = inject(PlanService);
  protected planLabel(): string | null { this.planSvc.ensureLoaded(); return this.planSvc.label(); }

  private readonly auth = inject(AuthService);
  private readonly audioApi = inject(AudioMonitoringService);
  private readonly preferencesService = inject(PreferencesService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly theme = inject(ThemeService);
  protected readonly perms = inject(PermissionsService);

  protected readonly user = this.auth.user;
  protected readonly prefs = this.preferencesService.prefs;

  /** Onglet actif (réf. maquette : Facturation / Apparence / Notifications / Organisation). */
  protected readonly section = signal<Section>('apparence');
  /** Facturation & options : réservé aux admins par défaut (perm billing_manage). */
  protected readonly canBilling = computed(() => this.perms.can('billing_manage'));

  /** Saisie de la recherche de réglage. */
  protected readonly recherche = signal('');
  /** Horodatage du dernier enregistrement local, pour l'indicateur « Enregistré ». */
  protected readonly enregistreLe = signal<number | null>(null);
  /** Re-evalue « il y a N s » sans dependre d'un rendu declenche par autre chose. */
  private readonly tic = signal(0);

  /**
   * Les 9 sections, rangees en DEUX groupes. C'est le coeur de B1 § E : « Mon espace » ne
   * concerne que moi, « Ma flotte » s'applique a toute la societe — la question la plus
   * posee, a laquelle une rangee plate d'onglets ne repondait pas. L'ancien onglet
   * « Organisation » melangeait precisement les deux (Compte et Securite d'un cote,
   * Retention et Mode assistance de l'autre).
   *
   * `motsCles` sert la recherche : on cherche un REGLAGE (« thème », « traînées », « 2FA »),
   * pas un nom de section — personne ne sait que la retention vit dans « Organisation ».
   */
  protected readonly groupes: GroupeSection[] = [
    {
      cle: 'moi', titre: 'Mon espace', sections: [
        { cle: 'apparence', titre: 'Apparence', icone: Palette, sousTitre: 'Appliqué immédiatement, sur cet appareil comme sur votre téléphone.', motsCles: 'thème sombre clair interface densité affichage couleur' },
        { cle: 'carte', titre: 'Carte', icone: Map, sousTitre: 'Le point de départ de votre carte, et ce qu\'elle affiche.', motsCles: 'centre zoom traînées trails position gps latitude longitude' },
        { cle: 'notifications', titre: 'Notifications', icone: Bell, sousTitre: 'Ce que VOUS recevez, sur cet appareil et par notification push.', motsCles: 'push alertes toast durée critique avertissement information son' },
        { cle: 'compte', titre: 'Mon compte', icone: User, sousTitre: 'Votre profil et votre session.', motsCles: 'profil email rôle déconnexion mot de passe identité' },
        { cle: 'securite', titre: 'Sécurité', icone: ShieldCheck, sousTitre: 'La protection de votre compte.', motsCles: '2fa double authentification vérification deux étapes code sécurité' },
      ],
    },
    {
      cle: 'flotte', titre: 'Ma flotte', sections: [
        { cle: 'abonnement', titre: 'Abonnement & options', icone: CreditCard, sousTitre: 'Votre offre, et les options activables sur la flotte.', motsCles: 'facturation offre plan prix option ia premium véhicules abonnement' },
        { cle: 'regles', titre: 'Règles d\'alerte', icone: SlidersHorizontal, sousTitre: 'Ce que la SOCIÉTÉ envoie — e-mail et WhatsApp, à tout le monde.', motsCles: 'alerte email whatsapp destinataire règle envoi seuil notification flotte' },
        { cle: 'donnees', titre: 'Données & rétention', icone: Database, sousTitre: 'Combien de temps vos données sont conservées.', motsCles: 'rétention conservation purge historique rgpd suppression données' },
        { cle: 'assistance', titre: 'Mode assistance', icone: Ear, sousTitre: 'Écoute d\'habitacle sous cadre légal, en cas d\'accident.', motsCles: 'audio micro écoute habitacle accident litige assistance' },
      ],
    },
  ];

  /** Sections réellement accessibles — une section vide ne doit pas figurer au menu. */
  private readonly groupesVisibles = computed<GroupeSection[]>(() =>
    this.groupes
      .map((g) => ({ ...g, sections: g.sections.filter((s) => this.sectionAccessible(s.cle)) }))
      .filter((g) => g.sections.length > 0),
  );

  /** Le rail filtré par la recherche : sur le titre ET sur les mots-clés de réglage. */
  protected readonly groupesFiltres = computed<GroupeSection[]>(() => {
    const q = this.normalise(this.recherche());
    if (!q) return this.groupesVisibles();
    return this.groupesVisibles()
      .map((g) => ({
        ...g,
        sections: g.sections.filter((s) =>
          this.normalise(`${s.titre} ${g.titre} ${s.motsCles}`).includes(q),
        ),
      }))
      .filter((g) => g.sections.length > 0);
  });

  private sectionCourante(): SectionDef | null {
    for (const g of this.groupes) {
      const s = g.sections.find((x) => x.cle === this.section());
      if (s) return s;
    }
    return null;
  }
  protected titreSection = computed(() => { this.section(); return this.sectionCourante()?.titre ?? ''; });
  protected sousTitreSection = computed(() => { this.section(); return this.sectionCourante()?.sousTitre ?? ''; });

  /** Le bouton de reinitialisation ne s'affiche que la ou il a un sens. */
  protected readonly sectionPersonnelle = computed(
    () => this.section() === 'apparence' || this.section() === 'carte' || this.section() === 'notifications',
  );

  protected allerA(cle: Section): void {
    this.section.set(cle);
  }

  /** Recherche insensible aux accents : « themes » doit trouver « Thème ». */
  private normalise(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  private sectionAccessible(cle: Section): boolean {
    switch (cle) {
      case 'abonnement': return this.canBilling();
      case 'carte': return this.perms.can('vehicles_view');
      case 'notifications':
      case 'regles': return this.perms.can('alerts_view');
      case 'donnees': return this.user()?.role === 'FLEET_ADMIN';
      case 'assistance':
        return this.user()?.role === 'FLEET_ADMIN' && this.perms.can('audio_monitoring') && this.audioEligible();
      default: return true;
    }
  }

  /**
   * La pastille « modifie » — calculee, jamais decorative.
   *
   * ⚠️ Elle n'est posee QUE sur les sections dont on peut REELLEMENT comparer l'etat aux
   * valeurs par defaut, c'est-a-dire les preferences locales (`getDefaults()`). Les sections
   * adossees au serveur (regles d'alerte, retention, abonnement) n'ont pas de reference a
   * comparer : y afficher une pastille serait une decoration qui ment. La planche montre la
   * pastille sur « Carte » — une preference locale, precisement.
   */
  protected estModifiee(cle: Section): boolean {
    const d = this.preferencesService.getDefaults();
    const p = this.prefs();
    if (cle === 'apparence') return p.theme !== d.theme;
    if (cle === 'carte') return JSON.stringify(p.map) !== JSON.stringify(d.map);
    if (cle === 'notifications') return JSON.stringify(p.notifications) !== JSON.stringify(d.notifications);
    return false;
  }

  /**
   * « Enregistré · il y a 2 s ». Les preferences sont ecrites a CHAQUE changement, sans
   * bouton : l'enregistrement automatique doit donc SE VOIR, sinon rien ne distingue
   * « c'est pris en compte » de « je viens de perdre ma saisie ».
   *
   * Declare en CHAMP et non dans `ngOnInit` : `effect()` exige un contexte d'injection, que
   * l'initialisation de champ fournit et que `ngOnInit` n'a plus.
   */
  private premierRendu = true;
  private readonly suiviEnregistrement = effect(() => {
    this.prefs();
    if (this.premierRendu) { this.premierRendu = false; return; }
    this.enregistreLe.set(Date.now());
  });

  /** « il y a 2 s » — relatif, recalcule a chaque tic. */
  protected ilYA(): string {
    this.tic();
    const t = this.enregistreLe();
    if (!t) return '';
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 5) return "à l'instant";
    if (sec < 60) return `il y a ${sec} s`;
    if (sec < 3600) return `il y a ${Math.round(sec / 60)} min`;
    return `il y a ${Math.round(sec / 3600)} h`;
  }
  /** Super-admin : pas de flotte propre → l'option IA se gère par société depuis Coûts IA, pas ici. */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');

  // La section de depart est desormais choisie dans `ngOnInit` a partir des sections
  // REELLEMENT accessibles (`groupesVisibles()`), ce qui couvre la facturation comme les
  // autres permissions — l'ancien constructeur ne traitait que le cas `billing_manage`.

  /** Nb de véhicules réellement suivis (snapshot flotte) — pour l'encart abonnement honnête. */
  protected readonly activeVehicleCount = computed(() => this.realtime.snapshot().length);

  protected readonly UserIcon = User;
  protected readonly LogOutIcon = LogOut;
  protected readonly MoonIcon = Moon;
  protected readonly SunIcon = Sun;
  protected readonly BellIcon = Bell;
  protected readonly MapIcon = Map;
  protected readonly MapPinIcon = MapPin;
  protected readonly ResetIcon = RotateCcw;
  protected readonly PaletteIcon = Palette;
  protected readonly NavigationIcon = Navigation;
  protected readonly RouteIcon = Route;
  protected readonly ArrowRightIcon = ArrowRight;
  protected readonly EarIcon = Ear;
  protected readonly ZapIcon = Zap;
  protected readonly SparklesIcon = Sparkles;
  protected readonly SearchIcon = Search;
  protected readonly CheckIcon = Check;

  // Sprint 4 — AUDIO N1 : la flotte est-elle ÉLIGIBLE au Mode assistance (le prestataire
  // l'a-t-il autorisée, `superAdminEnabled`) ? Gate l'affichage de la carte N2 du fleet-admin.
  // Fail-closed : false par défaut → carte masquée tant que l'éligibilité n'est pas confirmée.
  protected readonly audioEligible = signal(false);

  // V1.12 — Mode UI (Tracky riche vs Baanool simplifie)
  protected readonly isBaanoolMode = computed(() => this.user()?.preferences?.uiMode === 'baanool');
  protected readonly savingUiMode = signal(false);

  async toggleBaanoolMode(): Promise<void> {
    if (this.savingUiMode()) return;
    this.savingUiMode.set(true);
    const next: 'tracky' | 'baanool' = this.isBaanoolMode() ? 'tracky' : 'baanool';
    try {
      await this.auth.updatePreferences({ uiMode: next });
      this.toast.success(
        next === 'baanool'
          ? 'Mode interface simplifiee active.'
          : 'Interface complete restauree.',
      );
      // V1.12 — Auto-redirect : en activant baanool, on va direct sur /map
      // (UX coherente avec le redirect post-login). En desactivant, retour
      // au dashboard pour montrer le mode complet retrouve.
      void this.router.navigate([next === 'baanool' ? '/map' : '/dashboard']);
    } catch {
      this.toast.error('Échec mise à jour de la preference');
    } finally {
      this.savingUiMode.set(false);
    }
  }

  protected readonly notifItems = [
    { key: 'critical' as const, label: 'Critiques', desc: 'Accidents, coupures, SOS, remorquage', color: 'red' },
    { key: 'warning' as const, label: 'Avertissements', desc: 'Vitesse, inactivité, géofence, fatigue', color: 'amber' },
    { key: 'info' as const, label: 'Informations', desc: 'Freinage, vibrations, GPS, arrêt prolongé', color: 'blue' },
  ];

  async ngOnInit(): Promise<void> {
    // On atterrit sur la premiere section REELLEMENT accessible. Sans ca, un observateur
    // sans `billing_manage` arrivait sur une page vide : l'onglet par defaut etait
    // « Facturation », que sa permission lui interdit.
    const premiere = this.groupesVisibles()[0]?.sections[0]?.cle;
    if (premiere) this.section.set(premiere);

    // Le libelle est RELATIF : sans battement, « il y a 2 s » resterait affiche une heure.
    this.horloge = setInterval(() => this.tic.update((n) => n + 1), 10_000);

    // Sprint 4 — éligibilité audio (N1) : un FLEET_ADMIN ne voit la carte « Mode assistance »
    // que si le prestataire a rendu sa flotte éligible. Un seul fetch, mis en cache dans un
    // signal. Fail-closed : pas de fleetId ou fetch en échec → la carte reste masquée.
    const u = this.user();
    if (u?.role === 'FLEET_ADMIN' && u.fleetId) {
      firstValueFrom(this.audioApi.getFleetAudioConfig(u.fleetId))
        .then((cfg) => {
          this.audioEligible.set(cfg.superAdminEnabled === true);
          // L'eligibilite arrive APRES le premier rendu : si la section courante vient de
          // devenir invisible (ou l'inverse), on se recale sur une section qui existe.
          if (!this.sectionAccessible(this.section())) {
            const repli = this.groupesVisibles()[0]?.sections[0]?.cle;
            if (repli) this.section.set(repli);
          }
        })
        .catch(() => {
          // Échec silencieux → fail-closed : la carte reste cachée (default false).
        });
    }
  }

  ngOnDestroy(): void {
    if (this.horloge) clearInterval(this.horloge);
  }

  private horloge: ReturnType<typeof setInterval> | null = null;

  protected initials(): string {
    const email = this.user()?.email ?? '';
    return email.slice(0, 2).toUpperCase();
  }

  protected roleLabel(): string {
    return roleLabelFr(this.user()?.role);
  }

  protected toggleNotif(severity: 'critical' | 'warning' | 'info'): void {
    const c = this.prefs().notifications;
    this.preferencesService.update({ notifications: { ...c, [severity]: { ...c[severity], enabled: !c[severity].enabled } } });
  }

  protected setNotifDuration(severity: 'warning' | 'info', duration: number): void {
    const c = this.prefs().notifications;
    this.preferencesService.update({ notifications: { ...c, [severity]: { ...c[severity], duration: Number(duration) } } });
  }

  protected setMapPref(key: string, value: number | boolean): void {
    this.preferencesService.update({ map: { ...this.prefs().map, [key]: value } });
  }

  protected useMyPosition(): void {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      this.preferencesService.update({
        map: { ...this.prefs().map, centerLat: Math.round(pos.coords.latitude * 10000) / 10000, centerLng: Math.round(pos.coords.longitude * 10000) / 10000 },
      });
    });
  }

  protected resetAll(): void {
    this.preferencesService.reset();
    this.theme.setTheme('dark');
  }

  protected logout(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}

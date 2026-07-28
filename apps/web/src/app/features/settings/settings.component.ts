import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { PlanService } from '../../core/services/plan.service';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LucideAngularModule, LogOut, User, Moon, Sun, Bell, Map, MapPin, RotateCcw, Palette, Navigation, Route, ArrowRight, Ear, Zap, Sparkles } from 'lucide-angular';
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

type SettingsTab = 'billing' | 'appearance' | 'notifications' | 'organization';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, RouterLink, RetentionFleetCardComponent, Security2faCardComponent, AiBillingCardComponent, NotificationsCardComponent, AlertRulesCardComponent],
  template: `
    <div class="settings-page">
      <div class="settings-header">
        <span class="vt-eyebrow">Compte</span>
        <h1 class="settings-title">Paramètres &amp; facturation</h1>
        <p class="settings-sub">Personnalisez votre expérience et gérez vos options.</p>
      </div>

      <!-- Onglets (réf. maquette Parametres.dc.html) -->
      <div class="s-tabs">
        @if (canBilling()) {
          <button class="s-tab" [class.active]="tab() === 'billing'" (click)="tab.set('billing')" data-track="Onglet Facturation">Facturation &amp; options</button>
        }
        <button class="s-tab" [class.active]="tab() === 'appearance'" (click)="tab.set('appearance')" data-track="Onglet Apparence">Apparence</button>
        <button class="s-tab" [class.active]="tab() === 'notifications'" (click)="tab.set('notifications')" data-track="Onglet Notifications">Notifications</button>
        <button class="s-tab" [class.active]="tab() === 'organization'" (click)="tab.set('organization')" data-track="Onglet Organisation">Organisation</button>
      </div>

      <!-- ═══════════════ FACTURATION & OPTIONS (gated billing_manage) ═══════════════ -->
      @if (tab() === 'billing' && canBilling()) {
        <!-- Plan — honnête : compteur réel + facturation gérée hors app (pas de faux moyen de paiement). -->
        <div class="s-plan">
          <div class="s-plan-glow"></div>
          <div class="s-plan-row">
            <div class="s-plan-info">
              <span class="vt-eyebrow">Votre abonnement</span>
              <div class="s-plan-count">{{ activeVehicleCount() }} véhicule{{ activeVehicleCount() > 1 ? 's' : '' }} suivi{{ activeVehicleCount() > 1 ? 's' : '' }}</div>
              @if (planLabel()) { <div class="s-plan-note" style="color:var(--tracky-light,#3EEBB8);font-weight:600">Votre offre : {{ planLabel() }}</div> }
              <div class="s-plan-note">La facturation est gérée par votre conseiller Vizyo. Contactez-le pour changer d'offre, ajouter des véhicules ou activer une option.</div>
            </div>
            <a href="mailto:contact@vizyoagency.com" class="s-plan-btn">Contacter mon conseiller</a>
          </div>
        </div>

        <!-- Option IA payante : carte réelle (statut, coût /mois + /voiture, activer/annuler). -->
        @if (isSuperAdmin()) {
          <div class="s-plan-note" style="margin:14px 0 0;">L'option IA se gère <strong>par société</strong> depuis l'espace <a routerLink="/admin/ai-usage" style="color:var(--tracky-light,#10E0A0);">Coûts IA</a> (activation offerte ou suivi des abonnements).</div>
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
      @if (tab() === 'appearance') {
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
                <div class="ui-mode-section" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border-subtle)">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
                    <div style="flex:1;min-width:0">
                      <div style="font-size:13px;font-weight:600;color:var(--fg-primary);margin-bottom:4px">
                        Mode interface simplifiee
                      </div>
                      <p style="font-size:11px;color:var(--fg-tertiary);margin:0;line-height:1.4">
                        Connexion directe a la carte, sidebar et bottom-bar masquees,
                        navigation via le menu burger uniquement. Toutes les pages
                        restent accessibles.
                      </p>
                    </div>
                    <button
                      type="button"
                      (click)="toggleBaanoolMode()"
                      [attr.aria-pressed]="isBaanoolMode()"
                      [disabled]="savingUiMode()"
                      style="flex-shrink:0;width:44px;height:24px;border-radius:9999px;border:none;cursor:pointer;position:relative;transition:background 200ms"
                      [style.background]="isBaanoolMode() ? 'var(--tracky)' : 'var(--bg-tertiary)'">
                      <span style="position:absolute;top:2px;width:20px;height:20px;border-radius:50%;background:white;transition:left 200ms"
                            [style.left]="isBaanoolMode() ? '22px' : '2px'"></span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

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
                    <button (click)="useMyPosition()" class="geo-btn" title="Ma position">
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
      @if (tab() === 'notifications') {
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

            <!-- Ce que la FLOTTE envoie (e-mail / WhatsApp), juste sous les réglages
                 personnels : on lit d'abord « ce que je reçois », puis « ce que la
                 flotte envoie ». Ces règles vivaient auparavant dans une page séparée
                 ET dans un onglet de la page Alertes — deux formulaires identiques,
                 donc deux fois les mêmes bugs. Il n'en reste qu'un. -->
            <app-alert-rules-card />
            }
          </div>
        </div>
      }

      <!-- ═══════════════ ORGANISATION ═══════════════ -->
      @if (tab() === 'organization') {
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

          <div class="settings-col">
            <!-- Sécurité du compte — vérification en 2 étapes (2FA), opt-in PAR
                 UTILISATEUR (tout le monde peut sécuriser son propre compte). -->
            <app-security-2fa-card />
            <!-- Sprint 6 — Rétention des données de la flotte (lecture seule, FLEET_ADMIN). -->
            @if (user()?.role === 'FLEET_ADMIN') {
              <app-retention-fleet-card />
            }
          </div>
        </div>

        <!-- RESET -->
        <button (click)="resetAll()" class="reset-btn">
          <lucide-icon [img]="ResetIcon" [size]="14"></lucide-icon>
          Réinitialiser tous les paramètres
        </button>
      }
    </div>
  `,
  styles: [`
    .settings-page { max-width: 1080px; margin: 0 auto }
    .settings-header { margin-bottom: 18px }
    .settings-title { font-size: 26px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.03em; margin-top: 6px }
    .settings-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 3px }
    .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start }
    .settings-col { display: flex; flex-direction: column; gap: 16px }

    /* Tabs */
    .s-tabs { display: flex; align-items: center; gap: 6px; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap }
    .s-tab { padding: 8px 15px; border-radius: 10px; font-size: 13px; font-weight: 700; color: var(--fg-tertiary); cursor: pointer; border: 1px solid transparent; background: transparent; white-space: nowrap; transition: color .15s, background .15s, border-color .15s }
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
    .s-opt-head p { margin-top: 5px; font-size: .86rem; color: var(--fg-tertiary) }
    .s-opt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px }
    .s-opt { padding: 18px 19px; border-radius: 16px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); transition: transform .2s, border-color .2s }
    .s-opt:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--tracky) 40%, transparent) }
    .s-opt-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px }
    .s-opt-ico { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 12px; background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .s-opt-ico.on { background: color-mix(in srgb, var(--tracky) 12%, transparent); color: var(--tracky-light) }
    .s-opt-status { padding: 3px 10px; border-radius: 999px; font-size: .68rem; font-weight: 800; background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .s-opt-status.on { background: color-mix(in srgb, var(--tracky) 14%, transparent); color: var(--tracky-light) }
    .s-opt h4 { margin: 14px 0 0; font-size: 1rem; font-weight: 700; color: var(--fg-primary) }
    .s-opt p { margin: 6px 0 0; font-size: .82rem; color: var(--fg-secondary); line-height: 1.5 }
    .s-opt-link { display: inline-flex; align-items: center; gap: 5px; margin-top: 12px; font-size: .8rem; font-weight: 700; color: var(--tracky-light) }
    .s-opt-link:hover { text-decoration: underline }
    .s-opt-hint { display: block; margin-top: 12px; font-size: .76rem; color: var(--fg-tertiary) }

    /* Card */
    .s-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden }
    .s-card-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle) }
    .s-card-title { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .s-card-body { padding: 18px }
    .s-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    /* DS : accent émeraude unique — les sections se distinguent par leur icône,
       pas par une couleur différente (fin de l'arc-en-ciel violet/bleu/cyan). */
    .s-icon.green, .s-icon.purple, .s-icon.amber, .s-icon.blue, .s-icon.cyan, .s-icon.violet {
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); color: var(--color-tracky-light);
    }

    /* Account */
    .account-block { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 12px; background: var(--bg-tertiary); margin-bottom: 14px }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--tracky); color: var(--accent-ink); font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    .account-email { font-size: 14px; font-weight: 600; color: var(--fg-primary) }
    .role-badge { display: inline-block; margin-top: 3px; padding: 2px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em }
    .role-badge.admin { background: rgba(16,224,160,.15); color: var(--tracky-light) }
    .role-badge.viewer { background: var(--bg-secondary); color: var(--fg-tertiary) }
    .logout-btn {
      display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
      background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 18%, transparent); cursor: pointer; transition: all .2s;
    }
    .logout-btn:hover { background: rgba(239,68,68,.15) }
    .account-link {
      display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
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
    .section-desc { font-size: 11px; color: var(--fg-tertiary); margin: 0 0 12px }

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
    .theme-option.active .theme-label { color: var(--tracky-light) }

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
    .notif-desc { font-size: 10px; color: var(--fg-tertiary); margin-top: 1px }
    .permanent-badge { font-size: 11px; color: var(--fg-tertiary); padding: 2px 8px; border-radius: 6px; background: var(--bg-tertiary) }
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
    .geo-btn { padding: 6px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; transition: all .2s }
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
      display: inline-flex; align-items: center; gap: 7px; margin-top: 20px; padding: 10px 18px; border-radius: 10px;
      font-size: 12px; font-weight: 600; background: var(--bg-secondary); color: var(--fg-tertiary);
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
export class SettingsComponent implements OnInit {
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
  protected readonly tab = signal<SettingsTab>('billing');
  /** Facturation & options : réservé aux admins par défaut (perm billing_manage). */
  protected readonly canBilling = computed(() => this.perms.can('billing_manage'));
  /** Super-admin : pas de flotte propre → l'option IA se gère par société depuis Coûts IA, pas ici. */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');

  constructor() {
    // Non-admin sans droit de facturation : on démarre sur « Apparence » (pas de flash de l'onglet caché).
    if (!this.perms.can('billing_manage')) this.tab.set('appearance');
  }

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
      this.toast.error('Echec mise a jour de la preference');
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
    // Sprint 4 — éligibilité audio (N1) : un FLEET_ADMIN ne voit la carte « Mode assistance »
    // que si le prestataire a rendu sa flotte éligible. Un seul fetch, mis en cache dans un
    // signal. Fail-closed : pas de fleetId ou fetch en échec → la carte reste masquée.
    const u = this.user();
    if (u?.role === 'FLEET_ADMIN' && u.fleetId) {
      firstValueFrom(this.audioApi.getFleetAudioConfig(u.fleetId))
        .then((cfg) => this.audioEligible.set(cfg.superAdminEnabled === true))
        .catch(() => {
          // Échec silencieux → fail-closed : la carte reste cachée (default false).
        });
    }
  }

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

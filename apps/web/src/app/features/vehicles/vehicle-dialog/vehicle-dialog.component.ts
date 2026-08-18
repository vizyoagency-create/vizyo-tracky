import { swallow } from '../../../core/error/swallow';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, HostListener, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Truck, Radio, ChevronRight, X, Save, Check, Pencil } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { FleetsApiService, type FleetSummary } from '../../../core/services/fleets.service';
import { TrackersApiService } from '../../../core/services/trackers.service';
// Alias : la methode du composant s'appelle aussi `messagePlaque`. Sans alias, seule
// l'absence de `this.` distingue les deux — un piege pour la prochaine relecture.
import { formaterPlaqueFr, messagePlaque as diagnosticPlaque, normaliserPlaque } from '@vizyo/tracky-shared';
import { MiseEnServiceComponent } from '../mise-en-service/mise-en-service.component';
import { VehiclesApiService } from '../../../core/services/vehicles.service';
import type { InstallationEnergy } from '@vizyo/tracky-shared';
import { VEHICLE_TYPES } from '../../../shared/utils/vehicle-icons';
import { VEHICLE_BRANDS } from '../../../shared/utils/vehicle-brands';
import { BrandLogoComponent } from '../../../shared/ui/brand-logo/brand-logo.component';

@Component({
  selector: 'app-vehicle-dialog',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, BrandLogoComponent, MiseEnServiceComponent],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <!-- ⚠️ LE RÔLE DE MODALE MANQUAIT. Le panneau existait, se voyait, se remplissait —
             mais rien ne le DÉCLARAIT comme une modale : un lecteur d'écran l'annonçait
             comme une simple zone, sans dire qu'il faut en sortir pour revenir à la page.
             Relevé au balayage responsive du 2026-08-17, qui cherchait les modales par
             leur rôle et ne trouvait pas celle-ci. -->
        <div class="relative w-full max-w-md max-h-full bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden vd-overlay"
             role="dialog" aria-modal="true"
             [attr.aria-label]="isEditMode() ? 'Modifier le véhicule' : 'Ajouter un véhicule'">

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div class="flex items-center gap-3">
              @if (isEditMode()) {
                <div class="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
                  <lucide-icon [img]="PencilIcon" [size]="16" class="vd-info-txt"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Modifier le véhicule</h2>
                  <p class="text-[10px] text-fg-secondary">Modifier les informations du véhicule</p>
                </div>
              } @else if (currentStep() === 1) {
                <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                  <lucide-icon [img]="TruckIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Nouveau véhicule</h2>
                  <p class="text-[11px] text-fg-secondary">Étape 1 sur 2 · informations</p>
                </div>
              } @else {
                <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                  <lucide-icon [img]="RadioIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Associer un boîtier</h2>
                  <p class="text-[11px] text-fg-secondary">Étape 2 sur 2 · <strong class="vd-facultatif">facultative</strong></p>
                </div>
              }
            </div>
            <button (click)="onClose()"
              class="vd-croix text-fg-secondary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Stepper (create mode only) -->
          @if (!isEditMode()) {
            <div class="flex items-center px-6 py-3 border-b border-border-subtle bg-bg-secondary">
              <div class="flex items-center gap-2">
                <span class="vd-puce vd-puce--on">
                  @if (currentStep() > 1) {
                    <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon>
                  } @else { 1 }
                </span>
                <span class="text-xs font-medium" [class]="currentStep() >= 1 ? 'text-fg-primary' : 'text-fg-secondary'">Véhicule</span>
              </div>
              <div class="flex-1 h-px bg-border-subtle mx-3"></div>
              <div class="flex items-center gap-2">
                <span [class]="currentStep() >= 2 ? 'vd-puce vd-puce--on' : 'vd-puce'">2</span>
                <span class="text-xs font-medium" [class]="currentStep() >= 2 ? 'text-fg-primary' : 'text-fg-secondary'">Boîtier</span>
                <span class="vd-facultatif-puce">facultatif</span>
              </div>
            </div>
          }

          <!-- Content -->
          <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

            <!-- Loading vehicle data (edit mode) -->
            @if (isEditMode() && vehicleLoading()) {
              <div class="flex items-center justify-center gap-2 text-sm text-fg-secondary py-8">
                <span class="w-5 h-5 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin"></span>
                Chargement du véhicule...
              </div>
            }

            <!-- Error -->
            @if (errorMessage()) {
              <div class="p-3 rounded-xl bg-red-600/10 border border-red-600/20 vd-erreur-txt text-sm">
                {{ errorMessage() }}
              </div>
            }

            <!-- Step 1: Vehicle info (create) or Edit form -->
            @if ((currentStep() === 1 && !isEditMode()) || (isEditMode() && !vehicleLoading())) {
              @if (isSuperAdmin()) {
                <section>
                  <p class="section-title">Flotte</p>
                  @if (fleetsLoading()) {
                    <div class="flex items-center gap-2 text-sm text-fg-secondary py-2">
                      <span class="w-4 h-4 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin"></span>
                      Chargement des flottes...
                    </div>
                  } @else if (fleetsError()) {
                    <div class="p-3 rounded-xl bg-red-600/10 border border-red-600/20 vd-erreur-txt text-sm">
                      {{ fleetsError() }}
                    </div>
                  } @else if (fleets().length === 0) {
                    <div class="p-3 rounded-xl bg-amber-600/10 border border-amber-600/20 vd-avert-txt text-sm">
                      Aucune flotte disponible, créez une flotte d'abord
                    </div>
                  } @else {
                    <div>
                      <label class="field-label">Flotte *</label>
                      <select [(ngModel)]="selectedFleetId" class="field-input">
                        <option value="" disabled>Sélectionnez une flotte</option>
                        @for (f of fleets(); track f.id) {
                          <option [value]="f.id">{{ f.name }}</option>
                        }
                      </select>
                    </div>
                  }
                </section>
              }

              <!-- Ce que le formulaire exige VRAIMENT, dit d'emblee : le reste peut
                   attendre. Le compte est calcule depuis la liste des champs, pas
                   ecrit a la main — un champ ajoute le met a jour tout seul. -->
              @if (!isEditMode()) {
                <p class="vd-requis">
                  <strong>{{ champs().requis }} champ{{ champs().requis > 1 ? 's' : '' }} requis</strong>
                  sur {{ champs().total }} — les autres se complètent plus tard.
                </p>
              }

              <section>
                <p class="section-title">Identification</p>
                <div class="space-y-3">
                  <div>
                    <label class="field-label">Plaque d'immatriculation *</label>
                    <!-- ⚠️ LES TIRETS SE POSENT PENDANT LA FRAPPE. La validation seule
                         laisserait l'utilisateur deviner le gabarit ; en le voyant se
                         remplir, il sait ou il en est sans lire d'aide. -->
                    <input
                      type="text"
                      [ngModel]="plate"
                      (ngModelChange)="onPlaqueSaisie($event)"
                      [placeholder]="plaqueEtrangere ? 'KSR370' : 'AB-123-CD'"
                      [attr.inputmode]="plaqueEtrangere ? null : 'text'"
                      maxlength="20"
                      autocapitalize="characters"
                      spellcheck="false"
                      class="field-input font-mono"
                    />
                    @if (messagePlaque(); as m) {
                      <p class="vd-manque">{{ m }}</p>
                    } @else if (plate.trim()) {
                      <p class="vd-aide vd-plaque-ok">Plaque valide.</p>
                    }
                    <!-- Une case, pas une detection : deviner le pays refuserait une
                         plaque etrangere legitime — ce parc en compte une. -->
                    <label class="vd-plaque-etr">
                      <input type="checkbox" [(ngModel)]="plaqueEtrangere" (ngModelChange)="onBasculePlaque()" />
                      <span>Plaque étrangère (pas de mise en forme automatique)</span>
                    </label>
                  </div>
                </div>
              </section>

              <section>
                <p class="section-title">Type de véhicule</p>
                <div class="type-grid">
                  @for (t of vehicleTypes; track t.key) {
                    <button (click)="vehicleType = t.key" class="type-btn" [class.active]="vehicleType === t.key">
                      <span class="type-icon" [innerHTML]="getSvgHtml(t.svg)"></span>
                      <span>{{ t.label }}</span>
                    </button>
                  }
                </div>
              </section>

              <section>
                <p class="section-title">Détails (optionnel)</p>
                <div class="space-y-3">
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="field-label">Marque</label>
                      <div class="brand-field">
                        <app-brand-logo [brand]="brand" [size]="22" [chip]="true" />
                        <select [(ngModel)]="brand" class="field-input">
                          <option value="">— Sélectionner —</option>
                          @for (b of brandOptions(); track b) {
                            <option [value]="b">{{ b }}</option>
                          }
                        </select>
                      </div>
                    </div>
                    <div>
                      <label class="field-label">Modèle</label>
                      <input type="text" [(ngModel)]="model" placeholder="Master" class="field-input" />
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="field-label">Année</label>
                      <input type="number" [(ngModel)]="year" placeholder="2024" min="1950" class="field-input" />
                    </div>
                    <div>
                      <label class="field-label">Couleur</label>
                      <input type="text" [(ngModel)]="color" placeholder="Blanc" class="field-input" />
                    </div>
                  </div>

                  <!-- Sprint 8 — Caractéristiques (critères de réservation) -->
                  <div class="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label class="field-label">Places</label>
                      <input type="number" [(ngModel)]="seats" placeholder="5" min="1" max="99" class="field-input" />
                    </div>
                    <div>
                      <label class="field-label">Sièges enfants</label>
                      <input type="number" [(ngModel)]="childSeats" placeholder="0" min="0" max="20" class="field-input" />
                    </div>
                  </div>
                  <div class="mt-3">
                    <label class="field-label">Énergie</label>
                    <select [(ngModel)]="energy" class="field-input">
                      <option [ngValue]="undefined">—</option>
                      @for (e of energyOptions; track e.value) { <option [ngValue]="e.value">{{ e.label }}</option> }
                    </select>
                  </div>
                  <div class="mt-3">
                    <label class="field-label">Équipements</label>
                    <div class="vd-chips">
                      @for (f of features; track f) {
                        <span class="vd-chip">{{ f }}<button type="button" class="vd-chip-x" (click)="removeFeature(f)" aria-label="Retirer">×</button></span>
                      }
                      <input type="text" [(ngModel)]="featureInput" (keydown.enter)="addFeature($event)" placeholder="Ajouter (Entrée)…" class="vd-chip-input" />
                    </div>
                    <p class="vd-hint">Ex. climatisation, GPS, hayon, galerie, frigo — servent aux critères de réservation.</p>
                  </div>
                </div>
              </section>
            }

            <!-- Step 2: Tracker (create mode only) -->
            @if (!isEditMode() && currentStep() === 2) {
              <div class="vd-succes p-3 rounded-xl text-sm flex items-center gap-2">
                <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon>
                Véhicule <strong class="text-fg-primary mx-1">{{ plate }}</strong> créé avec succès
              </div>

              <!-- Un client qui saisit sa flotte n'a pas encore ses boitiers : ils
                   arrivent a l'installation. L'etape le dit, plutot que de bloquer. -->
              <div class="vd-sans">
                <p class="vd-sans-t">Le boîtier n'est pas encore posé ? Passez cette étape.</p>
                <p class="vd-sans-d">
                  <strong>{{ plate || 'Le véhicule' }}</strong> entre dans le <strong>suivi d'installation</strong>
                  et apparaîtra sur la carte dès la pose.
                </p>
              </div>

              <!-- ⚠️ L'ANCIENNE ETAPE 2 EST REMPLACEE, PAS COMPLETEE (lot 5, 2026-08-18).
                   Elle demandait de recopier a la main un IMEI de quinze chiffres lu sur
                   une etiquette, dans un hangar. Quatre boitiers du parc portaient un IMEI
                   faux a un ou trois chiffres pres — la saisie manuelle EST la panne.
                   On scanne, le serveur identifie, et le rattachement s'observe. -->
              <app-mise-en-service
                [vehicleId]="createdVehicleId()"
                [plaque]="plate"
                (termine)="onMiseEnServiceFinie()"
                (passer)="onSkipTracker()"
              />
            }
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
            <button (click)="onClose()"
              class="vd-annuler bg-bg-tertiary text-fg-secondary border border-border-subtle
                     hover:text-fg-primary transition-colors cursor-pointer">
              Annuler
            </button>

            @if (isEditMode()) {
              <!-- Edit mode: save button -->
              <button (click)="onSubmitEdit()" [disabled]="isLoading() || !plaqueValide() || (isSuperAdmin() && !selectedFleetId)"
                class="vd-bouton vd-enregistrer transition-all cursor-pointer disabled:opacity-50">
                @if (isLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                } @else {
                  <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
                }
                Enregistrer
              </button>
            } @else if (currentStep() === 1) {
              <button (click)="onSubmitStep1()" [disabled]="isLoading() || !plaqueValide() || (isSuperAdmin() && !selectedFleetId)"
                class="vd-bouton vd-primaire transition-all cursor-pointer disabled:opacity-50">
                @if (isLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                }
                Suivant
                <lucide-icon [img]="ChevronRightIcon" [size]="14"></lucide-icon>
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    /* iOS PWA standalone : le panneau (flex flex-col) s'etire sinon sur tout le
       fixed inset-0 = plein ecran, et son header passe SOUS le notch / la status
       bar (titre clippe), le footer SOUS le home indicator. On insette l'overlay
       par les safe-areas (top/bottom + lateral pour iPhone paysage) ; combine au
       max-h-full du panneau, header + footer restent visibles. env() = 0 hors iOS
       => additif, aucune regression Android/desktop. */
    .vd-overlay {
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }
    .animate-slide-in { animation: slideIn .25s ease-out }
    @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }
    .section-title { font-size: 10px; font-weight: 700; color: var(--fg-secondary); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px }
    .field-label { display: block; font-size: 11px; font-weight: 600; color: var(--fg-secondary); margin-bottom: 4px }
    .field-input {
      width: 100%; min-height: 44px; padding: 10px 14px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle);
      border-radius: 12px; color: var(--fg-primary); font-size: 13px; outline: none; transition: border-color .2s;
    }
    .field-input:focus { border-color: var(--tracky) }
    .field-input::placeholder { color: var(--fg-tertiary) }
    .vd-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px; border: 1.5px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary) }
    .vd-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 9px; border-radius: 8px; font-size: 12px; font-weight: 600; color: var(--tracky-light, #10E0A0); background: rgba(16,224,160,.12) }
    .vd-chip-x { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 5px; font-size: 14px; line-height: 1; color: var(--fg-tertiary); cursor: pointer }
    .vd-chip-x:hover { color: #EF4444; background: rgba(239,68,68,.12) }
    /* 44 px : ce champ mesurait 20 de haut, noye dans la boite a etiquettes. */
    .vd-chip-input { flex: 1; min-width: 90px; min-height: 44px; background: transparent; border: none; outline: none; color: var(--fg-primary); font-size: 13px }
    .vd-chip-input::placeholder { color: var(--fg-tertiary) }
    .vd-hint { font-size: 10.5px; color: var(--fg-secondary); margin-top: 5px }

    /* ─── Ce que le formulaire exige vraiment ─── */
    .vd-requis {
      margin: 0; padding: 9px 12px; border-radius: 10px;
      font-size: 12.5px; line-height: 1.45; color: var(--fg-secondary);
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
    }
    .vd-requis strong { color: var(--fg-primary); font-weight: 700; }

    /* ─── Le boitier est facultatif, et le dit ─── */
    .vd-facultatif { color: var(--texte-attente); font-weight: 700; }
    .vd-facultatif-puce {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
      padding: 2px 6px; border-radius: 999px;
      background: color-mix(in srgb, var(--warning) 16%, transparent);
      color: var(--texte-attente);
    }
    .vd-sans {
      padding: 11px 13px; border-radius: 12px;
      background: color-mix(in srgb, var(--color-tracky-light) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 26%, transparent);
    }
    .vd-sans-t { margin: 0; font-size: 13px; font-weight: 700; color: var(--fg-primary); }
    .vd-sans-d { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--fg-secondary); }
    .vd-sans-d strong { color: var(--fg-primary); font-weight: 700; }

    /* ─── Le compteur, a la place d'un bouton grise sans explication ─── */
    .vd-label-ligne { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .vd-compteur {
      font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums;
      color: var(--fg-secondary);
    }
    .vd-compteur--ok { color: var(--texte-succes); }
    .vd-manque { margin: 5px 0 0; font-size: 11px; color: var(--texte-attente); }
    .vd-aide { margin: 5px 0 0; font-size: 11px; line-height: 1.45; color: var(--fg-secondary); }
    .vd-opt { font-weight: 400; color: var(--fg-secondary); }

    /* La sortie NOMMEE : lisible, atteignable au doigt, sans concurrencer l'action
       principale — c'est un choix assume, pas un abandon. */
    .vd-sortie {
      min-height: 44px; padding: 0 14px; border-radius: 12px;
      font-size: 13.5px; font-weight: 600; cursor: pointer;
      background: transparent; color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    .vd-sortie:hover { color: var(--fg-primary); background: var(--bg-tertiary); }

    /* Encre FONCEE sur l'accent — regle non negociable de B0-SOCLE. Ces boutons et
       ces puces ecrivaient bg-tracky text-white : du blanc sur du vert menthe. */
    .vd-primaire { background: var(--tracky-light); color: var(--accent-ink); }
    .vd-primaire:hover:not([disabled]) { filter: brightness(1.06); }
    .vd-puce {
      width: 24px; height: 24px; border-radius: 999px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700;
      background: var(--bg-tertiary); color: var(--fg-secondary);
    }
    .vd-puce--on { background: var(--tracky-light); color: var(--accent-ink); }

    /* Classes de palette Tailwind remplacees : elles portaient une valeur figee,
       identique en clair et en sombre, et doublaient un jeton existant. */
    /* 44 px : la croix mesurait 30 x 36, les boutons du pied 42. */
    .vd-croix { width: 44px; height: 44px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; }
    .vd-bouton, .vd-annuler {
      min-height: 44px; padding: 0 16px; border-radius: 12px;
      font-size: 13.5px; font-weight: 600;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    }
    /* --blue est FONCE en theme clair (#0369A1) et CLAIR en sombre (#38BDF8).
       Une encre blanche fixe donne 5,93 d'un cote et 2,14 de l'autre : l'encre
       doit suivre le theme, comme --accent-ink le fait sur l'accent. */
    .vd-enregistrer { background: var(--blue); color: #FFFFFF; border: none; }
    :host-context([data-theme='dark']) .vd-enregistrer { color: var(--accent-ink); }
    .vd-enregistrer:hover:not([disabled]) { filter: brightness(1.08); }
    /* Le bandeau de succes ecrivait text-tracky-light sur son propre lavis : 3,34
       en clair. --texte-succes est la valeur assombrie prevue pour ca. */
    .vd-succes {
      background: color-mix(in srgb, var(--color-tracky-light) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 24%, transparent);
      color: var(--texte-succes);
    }
    .vd-erreur-txt { color: var(--texte-alerte); }
    .vd-avert-txt { color: var(--texte-attente); }
    .vd-info-txt { color: var(--texte-info); }
    select.field-input {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px;
    }
    select.field-input option { background: #1a1d21; color: #e5e7eb }
    select.field-input option:checked { background: #10b981; color: white }
    .brand-field { display: flex; align-items: center; gap: 8px }
    .brand-field select { flex: 1; min-width: 0 }
    .vd-plaque-ok { color: var(--texte-succes) }
    .vd-plaque-etr {
      display: flex; align-items: center; gap: 8px; margin-top: 8px; min-height: 44px;
      font-size: 12px; color: var(--fg-secondary); cursor: pointer;
    }
    .vd-plaque-etr input { width: 16px; height: 16px; flex: 0 0 16px; accent-color: var(--tracky) }
    .type-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px }
    .type-btn {
      display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border-radius: 10px;
      background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); color: var(--fg-secondary);
      cursor: pointer; transition: all .2s; font-size: 10px; font-weight: 600;
    }
    .type-btn:hover { border-color: var(--border-strong); color: var(--fg-primary) }
    /* Le libelle actif etait en --tracky-light : 3,2:1 sur son propre lavis, en clair. */
    .type-btn.active {
      border-color: var(--tracky); color: var(--texte-succes);
      background: color-mix(in srgb, var(--color-tracky-light) 8%, transparent);
    }
    .type-icon { display: flex; align-items: center; justify-content: center; height: 24px }
    @media (max-width: 480px) { .type-grid { grid-template-columns: repeat(3, 1fr) } }
  `],
})
export class VehicleDialogComponent {
  readonly open = input.required<boolean>();
  readonly mode = input<'create' | 'edit'>('create');
  readonly vehicleId = input<string>('');
  readonly done = output<void>();

  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly trackersApi = inject(TrackersApiService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly authService = inject(AuthService);
  private readonly sanitizer = inject(DomSanitizer);

  protected getSvgHtml(svgContent: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(
      `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${svgContent}</svg>`
    );
  }

  protected readonly isEditMode = computed(() => this.mode() === 'edit');
  protected readonly isSuperAdmin = computed(() => this.authService.user()?.role === 'SUPER_ADMIN');
  protected readonly fleets = signal<FleetSummary[]>([]);
  protected readonly fleetsLoading = signal(false);
  protected readonly fleetsError = signal('');
  protected readonly vehicleLoading = signal(false);
  protected selectedFleetId = '';

  /**
   * Les champs de l'étape 1, dans l'ordre du formulaire.
   *
   * Cette liste existe pour que « N champs requis sur M » se CALCULE. Un compteur
   * écrit à la main devient faux au premier champ ajouté, et personne ne s'en
   * aperçoit — c'est le défaut que l'assistant de démarrage portait avec son
   * « étape N sur 5 ». Ajouter un champ au gabarit sans l'ajouter ici est visible :
   * le total ne bouge pas.
   */
  private readonly CHAMPS_ETAPE_1: ReadonlyArray<{ cle: string; requis: boolean; superAdmin?: boolean }> = [
    { cle: 'flotte', requis: true, superAdmin: true },
    { cle: 'plaque', requis: true },
    { cle: 'type', requis: false },
    { cle: 'marque', requis: false },
    { cle: 'modele', requis: false },
    { cle: 'annee', requis: false },
    { cle: 'couleur', requis: false },
    { cle: 'places', requis: false },
    { cle: 'siegesEnfants', requis: false },
    { cle: 'energie', requis: false },
    { cle: 'equipements', requis: false },
  ];

  /** Ce que le formulaire exige vraiment — la flotte n'apparaît qu'au super-admin. */
  protected readonly champs = computed(() => {
    const visibles = this.CHAMPS_ETAPE_1.filter((c) => !c.superAdmin || this.isSuperAdmin());
    return { requis: visibles.filter((c) => c.requis).length, total: visibles.length };
  });

  protected readonly currentStep = signal(1);
  protected readonly isLoading = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly createdVehicleId = signal('');

  protected readonly vehicleTypes = VEHICLE_TYPES;
  private readonly brandLabels = VEHICLE_BRANDS.map((b) => b.label);

  /**
   * Options de la liste déroulante Marque. Inclut la valeur courante si elle
   * n'est pas dans la liste connue (ex. ancien véhicule saisi en texte libre)
   * pour ne pas la perdre à l'édition.
   */
  protected brandOptions(): string[] {
    const current = this.brand.trim();
    if (current && !this.brandLabels.includes(current)) {
      return [current, ...this.brandLabels];
    }
    return this.brandLabels;
  }

  protected plate = '';
  /** Coché : on n'impose ni le gabarit français ni les tirets. */
  protected plaqueEtrangere = false;
  protected vehicleType = 'CAR';
  protected brand = '';
  protected model = '';
  protected year: number | undefined;
  protected color = '';
  // Sprint 8 — caractéristiques (critères de réservation)
  protected seats: number | undefined;
  protected childSeats: number | undefined;
  // Sprint 10 — type de carburant (synchronisé depuis le planning d'installation).
  protected energy: InstallationEnergy | undefined;
  protected readonly energyOptions: { value: InstallationEnergy; label: string }[] = [
    { value: 'DIESEL', label: 'Diesel' },
    { value: 'ESSENCE', label: 'Essence' },
    { value: 'ELECTRIQUE', label: 'Électrique' },
    { value: 'HYBRIDE', label: 'Hybride' },
    { value: 'AUTRE', label: 'Autre' },
  ];
  protected features: string[] = [];
  protected featureInput = '';
  protected imei = '';
  protected trackerModel = '';
  protected simPhoneNumber = '';

  protected readonly TruckIcon = Truck;
  protected readonly RadioIcon = Radio;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly CheckIcon = Check;
  protected readonly PencilIcon = Pencil;

  constructor() {
    effect(() => {
      if (!this.open()) return;

      if (this.isSuperAdmin()) {
        this.loadFleets();
      }

      if (this.isEditMode() && this.vehicleId()) {
        this.loadVehicle(this.vehicleId());
      }
    });
  }

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open() && !this.isLoading()) this.onClose(); }

  onClose(): void {
    if (this.isLoading()) return;
    this.reset();
    this.done.emit();
  }

  onSkipTracker(): void {
    this.reset();
    this.done.emit();
  }

  private async loadFleets(): Promise<void> {
    this.fleetsLoading.set(true);
    this.fleetsError.set('');
    try {
      const list = await firstValueFrom(this.fleetsApi.list());
      this.fleets.set(list);
      if (!this.isEditMode() && list.length === 1) {
        this.selectedFleetId = list[0].id;
      }
    } catch (err) {
      swallow('vehicle-dialog:loadFleets', err);
      this.fleetsError.set('Impossible de charger les flottes');
    } finally {
      this.fleetsLoading.set(false);
    }
  }

  private async loadVehicle(id: string): Promise<void> {
    this.vehicleLoading.set(true);
    this.errorMessage.set('');
    try {
      const v = await firstValueFrom(this.vehiclesApi.findOne(id));
      this.plate = v.plate;
      this.vehicleType = v.type;
      this.brand = v.brand ?? '';
      this.model = v.model ?? '';
      this.year = v.year ?? undefined;
      this.color = v.color ?? '';
      this.seats = v.seats ?? undefined;
      this.childSeats = v.childSeats ?? undefined;
      this.energy = v.energy ?? undefined;
      this.features = Array.isArray(v.features) ? [...v.features] : [];
      this.selectedFleetId = v.fleetId;
    } catch (err) {
      swallow('vehicle-dialog:loadVehicle', err);
      this.errorMessage.set('Impossible de charger le véhicule');
    } finally {
      this.vehicleLoading.set(false);
    }
  }

  async onSubmitStep1(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const data: Record<string, unknown> = { plate: this.plate.trim(), type: this.vehicleType };
      if (this.brand.trim()) data['brand'] = this.brand.trim();
      if (this.model.trim()) data['model'] = this.model.trim();
      if (this.year) data['year'] = this.year;
      if (this.color.trim()) data['color'] = this.color.trim();
      this.applyCharacteristics(data);
      if (this.selectedFleetId) data['fleetId'] = this.selectedFleetId;
      const vehicle = await firstValueFrom(this.vehiclesApi.create(data as Parameters<VehiclesApiService['create']>[0]));
      this.createdVehicleId.set(vehicle.id);
      this.currentStep.set(2);
    } catch (err) {
      swallow('vehicle-dialog:onSubmitStep1', err);
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  async onSubmitEdit(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const data: Record<string, unknown> = {
        plate: this.plate.trim(),
        type: this.vehicleType,
      };
      if (this.brand.trim()) data['brand'] = this.brand.trim();
      if (this.model.trim()) data['model'] = this.model.trim();
      if (this.year) data['year'] = this.year;
      if (this.color.trim()) data['color'] = this.color.trim();
      this.applyCharacteristics(data);
      if (this.isSuperAdmin() && this.selectedFleetId) {
        data['fleetId'] = this.selectedFleetId;
      }
      await firstValueFrom(this.vehiclesApi.update(this.vehicleId(), data));
      this.reset();
      this.done.emit();
    } catch (err) {
      swallow('vehicle-dialog:onSubmitEdit', err);
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  /**
   * Le boîtier est rattaché et vu en ligne : le composant de mise en service a fait le
   * travail, il ne reste qu'à refermer. `onSubmitStep2` reste en place pour l'ancien
   * chemin (il n'est plus atteignable depuis ce gabarit).
   */
  /**
   * Mise en forme à la frappe, et seulement pour les plaques françaises.
   *
   * ⚠️ CE CHAMP EST L'IDENTIFIANT DU VÉHICULE — à l'écran, sur les rapports, sur les
   * cartes QR. Le formulaire n'exigeait qu'une chaîne non vide : un véhicule est parti
   * en production avec « FT- » pour toute plaque, validé sans un mot.
   */
  protected onPlaqueSaisie(valeur: string): void {
    this.plate = this.plaqueEtrangere ? valeur.toUpperCase() : formaterPlaqueFr(valeur);
  }

  /** En basculant, on remet la saisie au format du mode choisi. */
  protected onBasculePlaque(): void {
    this.plate = this.plaqueEtrangere
      ? normaliserPlaque(this.plate)
      : formaterPlaqueFr(this.plate);
  }

  protected messagePlaque(): string | null {
    // Silencieux tant que le champ est vide : on n'accuse pas quelqu'un qui n'a pas
    // encore tapé. Le bouton reste désactivé, ce qui suffit à dire que ce n'est pas fini.
    if (!this.plate.trim()) return null;
    return diagnosticPlaque(this.plate, this.plaqueEtrangere);
  }

  protected plaqueValide(): boolean {
    return diagnosticPlaque(this.plate, this.plaqueEtrangere) === null;
  }

  protected onMiseEnServiceFinie(): void {
    this.done.emit();
    this.reset();
  }

  async onSubmitStep2(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const tracker = await firstValueFrom(
        this.trackersApi.create({
          imei: this.imei.trim(),
          model: this.trackerModel.trim() || undefined,
          simPhoneNumber: this.simPhoneNumber.trim() || undefined,
        }),
      );
      await firstValueFrom(this.trackersApi.assign(tracker.id, this.createdVehicleId()));
      this.reset();
      this.done.emit();
    } catch (err) {
      swallow('vehicle-dialog:onSubmitStep2', err);
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  /** Sprint 8 — ajoute un équipement (tag) depuis l'input (Entrée). */
  protected addFeature(ev: Event): void {
    ev.preventDefault();
    const raw = this.featureInput.trim();
    if (!raw) return;
    const exists = this.features.some((f) => f.toLowerCase() === raw.toLowerCase());
    if (!exists && this.features.length < 30) this.features = [...this.features, raw];
    this.featureInput = '';
  }

  /** Sprint 8 — retire un équipement. */
  protected removeFeature(f: string): void {
    this.features = this.features.filter((x) => x !== f);
  }

  /** Sprint 8 — ajoute les caractéristiques (places / sièges enfants / équipements) au payload. */
  private applyCharacteristics(data: Record<string, unknown>): void {
    data['seats'] = this.seats ?? null;
    data['childSeats'] = this.childSeats ?? null;
    data['energy'] = this.energy ?? null;
    data['features'] = this.features;
  }

  private reset(): void {
    this.currentStep.set(1);
    this.errorMessage.set('');
    this.createdVehicleId.set('');
    this.selectedFleetId = '';
    this.plate = '';
    this.plaqueEtrangere = false;
    this.vehicleType = 'CAR';
    this.brand = '';
    this.model = '';
    this.year = undefined;
    this.color = '';
    this.seats = undefined;
    this.childSeats = undefined;
    this.energy = undefined;
    this.features = [];
    this.featureInput = '';
    this.imei = '';
    this.trackerModel = '';
    this.simPhoneNumber = '';
  }

  private extractError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const msg = err.error?.message;
      return Array.isArray(msg) ? msg.join(', ') : msg ?? err.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}

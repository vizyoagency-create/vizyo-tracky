import { HttpClient } from '@angular/common/http';
import { swallow } from '../../core/error/swallow';
import { httpFailureMessage } from '../../core/services/http-failure';
import { ChangeDetectionStrategy, Component, HostListener, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Archive, Users, Shield, Pencil, KeyRound, Send, XCircle, Mail, UserPlus, MoreVertical, Check, AlertTriangle } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { getDefaultPermissions, PERMISSION_GROUP_ORDER, PERMISSION_LABELS, type UserPermissions } from '@vizyo/tracky-shared';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { AuthService } from '../../core/services/auth.service';
import { FleetsApiService, type FleetSummary } from '../../core/services/fleets.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { VehiclesApiService } from '../../core/services/vehicles.service';
import { VehicleGroupsService } from '../../core/services/vehicle-groups.service';
import { UserAccessService } from '../../core/services/user-access.service';
import { UsersApiService, type TrackyUser, type PendingInvitation } from '../../core/services/users.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { roleLabel as roleLabelFr } from '../../shared/utils/role-labels';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { UserDrawerComponent, type UserDrawerData, type UserDrawerResult } from './user-drawer.component';
import { VehicleAccessDrawerComponent, type AccessDrawerData, type AccessDrawerResult } from './vehicle-access-drawer.component';
import { SaFleetBadgeComponent } from '../../shared/ui/super-admin-context/sa-fleet-badge.component';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { DriversListComponent } from '../drivers/drivers-list.component';

type AppRole = 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER' | 'NIGHT_WATCHMAN' | 'DRIVER' | 'DEPOT';

@Component({
  selector: 'app-users-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideAngularModule, ConfirmModalComponent, UserDrawerComponent, VehicleAccessDrawerComponent, SaFleetBadgeComponent, DriversListComponent],
  template: `
    <div class="upage">
      <!-- Header -->
      <div class="u-header">
        <div class="u-head-titles">
          <span class="vt-eyebrow">Pilotage</span>
          <h1 class="u-title">Utilisateurs &amp; rôles</h1>
          <p class="u-sub">
            @if (activeTab() === 'accounts') {
              {{ visibleTotalCount() }} membre(s){{ includeArchived() ? ' · archives inclus' : ' dans votre flotte' }}@if (visiblePendingCount() > 0) { · {{ visiblePendingCount() }} invitation(s) en attente }@if (visibleExpiredCount() > 0) { · <strong class="u-sub-expired">{{ visibleExpiredCount() }} invitation(s) expirée(s)</strong> }
            } @else if (activeTab() === 'roles') {
              Capacités par défaut de chaque rôle applicatif
            } @else {
              Personnes qui conduisent les véhicules
            }
          </p>
        </div>
        @if (activeTab() === 'accounts' && perms.can('users_manage')) {
          <div class="u-header-actions">
            <label class="u-toggle-archived">
              <input type="checkbox" [checked]="includeArchived()" (change)="toggleArchived()" />
              <span>Archives</span>
            </label>
            <button (click)="openCreateDrawer()" class="btn-primary u-invite-btn">
              <lucide-icon [img]="UserPlusIcon" [size]="16"></lucide-icon> Inviter un utilisateur
            </button>
          </div>
        }
      </div>

      <!-- Onglets : Utilisateurs / Rôles & permissions / Conducteurs -->
      <div class="u-tabs">
        <button class="u-tab" data-track="Onglet Utilisateurs" [class.active]="activeTab() === 'accounts'" (click)="selectTab('accounts')">Utilisateurs</button>
        <button class="u-tab" data-track="Onglet Rôles" [class.active]="activeTab() === 'roles'" (click)="selectTab('roles')">Rôles &amp; permissions</button>
        @if (perms.can('drivers_view')) {
          <button class="u-tab" data-track="Onglet Conducteurs" [class.active]="activeTab() === 'drivers'" (click)="selectTab('drivers')">Conducteurs</button>
        }
      </div>

      @if (activeTab() === 'drivers') {
        <app-drivers-list [embedded]="true" />
      } @else if (activeTab() === 'roles') {
        <!-- ══ Matrice de permissions (référence rôles, pilotée par les defaults réels) ══ -->
        <div class="vt-card m-card">
          <div class="m-head">
            <div>
              <h3 class="m-title">Matrice de permissions</h3>
              <p class="m-desc">Le rôle n'est qu'un <strong>point de départ</strong>. Chaque permission ci-dessous s'active ou se coupe <strong>par utilisateur</strong> (et par groupe / véhicule) via « Détail par utilisateur » — aucune n'est définitivement bloquée par le rôle.</p>
            </div>
            <a routerLink="/users/overview" class="m-detail-link">Détail par utilisateur →</a>
          </div>
          <div class="m-grid m-grid-head">
            <span></span>
            @for (r of roleCols; track r.role) {
              <span class="m-col-h">{{ r.short }}</span>
            }
          </div>
          @for (grp of permGroups; track grp.group) {
            <div class="m-group-h">{{ grp.group }}</div>
            @for (p of grp.perms; track p.key) {
              <div class="m-grid">
                <span class="m-cap" [title]="p.description">{{ p.label }}</span>
                @for (r of roleCols; track r.role) {
                  <span class="m-cell" [class.m-cell--fige]="r.role === 'DEPOT'">
                    @if (r.role === 'DEPOT' && isDefaultOn(p.key, r.role)) {
                      <!-- ◆ — accordé, MAIS limité à ses propres missions.
                           Une coche verte identique aux autres rôles produirait
                           l'inquiétude inverse : le Fleet Admin croirait ouvrir sa
                           flotte. C'est cette distinction visuelle qui lui permet de
                           comprendre en trois secondes (A5 § 4). -->
                      <span class="chk-depot" title="Accordé, mais limité à ses propres missions — non modifiable">◆</span>
                    } @else if (isDefaultOn(p.key, r.role)) {
                      <span class="chk" title="Activé par défaut"><lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon></span>
                    } @else if (r.role === 'DEPOT') {
                      <!-- Le rôle est FERMÉ : la case est grisée, pas « activable ». -->
                      <span class="chk-fige" title="Le périmètre d'un dépôt est fixé par ses missions">—</span>
                    } @else {
                      <span class="chk-part" title="Désactivé par défaut — activable par utilisateur">○</span>
                    }
                  </span>
                }
              </div>
            }
          }
          <div class="m-legend">
            <span><span class="chk chk-sm"><lucide-icon [img]="CheckIcon" [size]="11"></lucide-icon></span> Activé par défaut</span>
            <span><span class="chk-part chk-sm">○</span> Désactivé par défaut — activable par utilisateur</span>
            <span><span class="chk-depot chk-sm">◆</span> Limité à ses propres missions</span>
          </div>
          <!-- La légende du ◆, en toutes lettres. Sans elle, le marqueur intrigue
               sans rassurer — et c'est précisément la question que se pose un Fleet
               Admin avant d'ouvrir un accès à une société extérieure. -->
          <p class="m-legend-depot">
            <strong>◆ Limité à ses propres missions</strong> — le dépôt n'a aucun droit
            d'action : son accès est en lecture seule, borné à la fenêtre horaire de chaque
            mission. Ses cases ne sont pas modifiables : son périmètre est fixé par les
            missions que vous lui assignez, pas par cette matrice.
          </p>
        </div>
      } @else if (loading()) {
        <div class="u-loading"><span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span></div>
      } @else if (loadError()) {
        <!--
          ⚠️ CET ETAT DOIT PASSER AVANT « aucun utilisateur », sinon il reste invisible :
          en panne la liste est vide, donc la branche du dessous l'avalerait et l'ecran
          rejouerait le message d'une flotte vide — exactement le defaut corrige ici.
        -->
        <div class="u-empty">
          <div class="u-empty-icon"><lucide-icon [img]="AlertTriangleIcon" [size]="32"></lucide-icon></div>
          <p>{{ loadError() }}</p>
          <button (click)="reload()" class="u-empty-cta">Réessayer</button>
        </div>
      } @else if (visibleUsers().length === 0 && visiblePendingInvitations().length === 0) {
        <div class="u-empty">
          <div class="u-empty-icon"><lucide-icon [img]="UsersIcon" [size]="32"></lucide-icon></div>
          <p>Aucun utilisateur dans votre flotte</p>
          @if (perms.can('users_manage')) {
            <button (click)="openCreateDrawer()" class="u-empty-cta">Inviter votre premier utilisateur</button>
          }
        </div>
      } @else {
        <!-- ══ Table utilisateurs (réf. maquette Utilisateurs.dc.html) ══ -->
        <div class="vt-card u-table">
          <div class="u-thead">
            <span class="u-th">Utilisateur</span>
            <span class="u-th">Rôle</span>
            <span class="u-th u-col-scope">Périmètre</span>
            <span class="u-th u-col-last">Membre depuis</span>
            <span></span>
          </div>

          <!-- Comptes actifs / archivés -->
          @for (u of visibleUsers(); track u.id) {
            <div class="u-row" [class.u-row-archived]="!u.isActive">
              <div class="u-cell-user">
                <span class="u-avatar" [class]="avatarClass(u)">{{ userInitials(u) }}</span>
                <div class="u-user-txt">
                  <div class="u-name">{{ displayName(u) }}</div>
                  <div class="u-email mono">{{ u.email }}</div>
                </div>
              </div>
              <span class="u-cell-role">
                <span class="u-role-pill" [class]="rolePillClass(u.role)">{{ roleLabel(u.role) }}</span>
                <app-sa-fleet-badge [fleetId]="u.fleetId" />
              </span>
              <span class="u-col-scope u-scope" [class.u-scope-muted]="!u.isActive">{{ perimeterLabel(u) }}</span>
              <span class="u-col-last mono u-since">{{ u.isActive ? formatDate(u.createdAt) : 'Archivé' }}</span>
              <div class="u-row-menu">
                @if (perms.can('users_manage') && (isSuperAdmin() || u.role !== 'FLEET_ADMIN')) {
                  <button class="u-menu-btn" (click)="toggleMenu(u.id, $event)" [attr.aria-label]="'Actions ' + u.email">
                    <lucide-icon [img]="MoreVerticalIcon" [size]="16"></lucide-icon>
                  </button>
                  @if (openMenuId() === u.id) {
                    <div class="u-menu" role="menu">
                      @if (u.isActive) {
                        <button class="u-menu-item" title="Modifier — infos, rôle, accès &amp; permissions" (click)="closeMenu(); openEditDrawer(u)"><lucide-icon [img]="PencilIcon" [size]="14"></lucide-icon> Modifier</button>
                        <button class="u-menu-item" (click)="closeMenu(); onResetPassword(u)"><lucide-icon [img]="KeyIcon" [size]="14"></lucide-icon> Réinit. mot de passe</button>
                        @if (isSuperAdmin()) {
                          <button class="u-menu-item" [class.disabled]="audioInfoDisabled(u)" [disabled]="audioInfoDisabled(u)" [title]="audioInfoTooltip(u)" (click)="closeMenu(); confirmAudioInfoMail(u)"><lucide-icon [img]="MailIcon" [size]="14"></lucide-icon> Info Mode assistance</button>
                        }
                        <button class="u-menu-item danger" (click)="closeMenu(); confirmDelete(u)"><lucide-icon [img]="ArchiveIcon" [size]="14"></lucide-icon> Archiver</button>
                      } @else {
                        <button class="u-menu-item" (click)="closeMenu(); onUnarchive(u)"><lucide-icon [img]="ArchiveIcon" [size]="14"></lucide-icon> Désarchiver</button>
                      }
                    </div>
                  }
                }
              </div>
            </div>
          }

          <!-- Invitations en attente -->
          @for (inv of visiblePendingInvitations(); track inv.id) {
            <div class="u-row u-row-inv">
              <div class="u-cell-user">
                <span class="u-avatar pending">{{ invInitials(inv) }}</span>
                <div class="u-user-txt">
                  <div class="u-name">{{ invName(inv) }}</div>
                  <div class="u-email mono">{{ inv.email }}</div>
                </div>
              </div>
              <span class="u-cell-role">
                <span class="u-role-pill" [class]="inv.status === 'PENDING' ? 'invited' : 'expired'">
                  <span class="u-pill-dot"></span>{{ inv.status === 'PENDING' ? 'Invité' : 'Expiré' }}
                </span>
              </span>
              <!--
                ⚠️ « en attente » était affiché quel que soit le statut — y compris pour
                un lien mort depuis un mois. Une invitation expirée n'attend rien : elle
                demande une action (la renvoyer). Le dire change ce que le gestionnaire
                fait de l'information.
              -->
              <span class="u-col-scope u-scope u-scope-muted">
                {{ roleLabel(inv.role) }} ·
                {{ inv.status === 'PENDING' ? 'en attente' : 'lien expiré — à renvoyer' }}
              </span>
              <span class="u-col-last mono u-since">—</span>
              <div class="u-row-menu">
                @if (perms.can('users_manage')) {
                  <button class="u-menu-btn" (click)="toggleMenu(inv.id, $event)" [attr.aria-label]="'Actions ' + inv.email">
                    <lucide-icon [img]="MoreVerticalIcon" [size]="16"></lucide-icon>
                  </button>
                  @if (openMenuId() === inv.id) {
                    <div class="u-menu" role="menu">
                      @if (isSuperAdmin() && inv.status === 'PENDING') {
                        <button class="u-menu-item" (click)="closeMenu(); openEditInvitationDrawer(inv)"><lucide-icon [img]="PencilIcon" [size]="14"></lucide-icon> Modifier l'invitation</button>
                      }
                      <button class="u-menu-item" (click)="closeMenu(); onResendInvitation(inv)"><lucide-icon [img]="SendIcon" [size]="14"></lucide-icon> Renvoyer</button>
                      <button class="u-menu-item danger" (click)="closeMenu(); onRevokeInvitation(inv)"><lucide-icon [img]="XCircleIcon" [size]="14"></lucide-icon> Révoquer</button>
                    </div>
                  }
                }
              </div>
            </div>
          }
        </div>
      }

    </div>

    <!-- User Drawer (create + edit) -->
    <app-user-drawer
      [open]="showDrawer()"
      [data]="drawerData()"
      [loading]="drawerLoading()"
      (closed)="showDrawer.set(false)"
      (saved)="onDrawerSave($event)"
    />

    <!-- Archive Modal -->
    <app-confirm-modal
      [open]="showDeleteModal()"
      title="Archiver l'utilisateur"
      [description]="'Voulez-vous archiver <strong>' + (userToDelete()?.email ?? '') + '</strong> ? Cet utilisateur ne pourra plus se connecter. Ses actions passees seront conservees.'"
      confirmLabel="Archiver"
      [danger]="true"
      [loading]="deleting()"
      (confirmed)="onDelete()"
      (cancelled)="showDeleteModal.set(false)"
    />

    <!-- Info Mode assistance — confirmation (SUPER_ADMIN only) -->
    <app-confirm-modal
      [open]="showAudioInfoModal()"
      title="Envoyer l'info Mode assistance"
      [description]="audioInfoDescription()"
      confirmLabel="Envoyer"
      [loading]="sendingAudioInfo()"
      (confirmed)="onSendAudioInfoMail()"
      (cancelled)="showAudioInfoModal.set(false)"
    />

    <!-- Vehicle Access Drawer -->
    <app-vehicle-access-drawer
      [open]="showAccessDrawer()"
      [data]="accessDrawerData()"
      [loading]="savingAccess()"
      (closed)="showAccessDrawer.set(false)"
      (saved)="onAccessDrawerSave($event)"
    />

  `,
  styles: [`
    /* Cibles tactiles au doigt — critère de recette « iPhone 390 px : cibles ≥ 44 px ».
       Mesuré à 375 px : le menu d'actions de chaque ligne (15 lignes, 15 cibles) et les
       trois onglets étaient sous le seuil. Sur une liste, la cible par ligne est celle
       qu'on vise le plus souvent et la plus facile à rater — les lignes sont serrées. */
    @media (max-width: 768px) {
      .u-menu-btn, .u-tab, .btn-primary { min-width: 44px; min-height: 44px }
    }
    .upage { position: relative; min-height: 100%; max-width: 1240px; margin: 0 auto }

    /* ─── Header ─── */
    .u-header { position: relative; z-index: 1; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px }
    .u-title { font-size: 26px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.03em; margin-top: 6px }
    .u-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 3px }
    .u-header-actions { display: flex; align-items: center; gap: 12px }
    .u-invite-btn { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap }
    .u-toggle-archived { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-tertiary); cursor: pointer }
    .u-toggle-archived input { accent-color: var(--tracky); cursor: pointer }

    /* ─── Tabs ─── */
    .u-tabs { position: relative; z-index: 1; display: flex; align-items: center; gap: 6px; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap }
    .u-tab { padding: 8px 15px; border-radius: 10px; font-size: 13px; font-weight: 700; color: var(--fg-tertiary); cursor: pointer; border: 1px solid transparent; background: transparent; white-space: nowrap; transition: color .15s, background .15s, border-color .15s }
    .u-tab:hover { color: var(--fg-secondary) }
    .u-tab.active { background: var(--bg-secondary); color: var(--fg-primary); border-color: var(--border-strong, var(--border-subtle)) }

    .u-loading { position: relative; z-index: 1; display: flex; justify-content: center; padding: 60px 0 }
    .u-empty { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 50px 20px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary) }
    .u-empty-icon { width: 60px; height: 60px; border-radius: 16px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary) }
    .u-empty-cta { font-size: 13px; color: var(--tracky-light); background: none; border: none; cursor: pointer; text-decoration: underline }

    /* ─── Users table ─── */
    .u-table { position: relative; z-index: 1; overflow: hidden; padding: 0 }
    .u-thead, .u-row { display: grid; grid-template-columns: minmax(200px,2fr) 168px 1fr 128px 44px; align-items: center; gap: 14px; padding: 12px 18px }
    .u-thead { background: var(--surface-rail); border-bottom: 1px solid var(--border-subtle) }
    .u-th { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-tertiary) }
    .u-row { border-top: 1px solid var(--border-subtle); transition: background .15s }
    .u-row:hover { background: var(--bg-secondary) }
    .u-row-archived { opacity: .55 }

    .u-cell-user { display: flex; align-items: center; gap: 11px; min-width: 0 }
    .u-avatar { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 999px; font-size: 12.5px; font-weight: 700; flex-shrink: 0; background: var(--bg-tertiary); color: var(--fg-secondary) }
    .u-avatar.admin { background: var(--tracky); color: var(--accent-ink) }
    .u-avatar.manager { background: var(--bg-tertiary); color: var(--fg-secondary) }
    .u-avatar.viewer { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .u-avatar.pending { background: transparent; border: 1px dashed color-mix(in srgb, var(--warning) 45%, transparent); color: var(--warning) }
    .u-user-txt { min-width: 0 }
    .u-name { font-size: 13.5px; font-weight: 700; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .u-email { font-size: 11px; color: var(--fg-tertiary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }

    .u-cell-role { display: flex; align-items: center; gap: 7px; flex-wrap: wrap }
    .u-role-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700; background: var(--bg-tertiary); color: var(--fg-secondary) }
    .u-role-pill.admin { background: color-mix(in srgb, var(--tracky) 14%, transparent); color: var(--tracky-light) }
    /* Espace dépôt (2026-08) — violet : un dépôt n'est pas un membre de la flotte,
       et la pastille doit le dire d'un coup d'œil dans une liste mêlée. */
    .u-role-pill.depot { background: color-mix(in srgb, var(--violet) 14%, transparent); color: var(--violet) }
    .u-role-pill.invited { background: color-mix(in srgb, var(--warning) 14%, transparent); color: var(--warning) }
    .u-role-pill.expired { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger) }
    .u-pill-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor }

    .u-scope { font-size: 12.5px; color: var(--fg-secondary) }
    .u-scope-muted { color: var(--fg-tertiary) }
    .u-since { font-size: 12px; color: var(--fg-tertiary) }

    .u-row-menu { position: relative; display: flex; justify-content: flex-end }
    .u-menu-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--fg-tertiary); cursor: pointer; transition: all .15s }
    .u-menu-btn:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .u-menu { position: absolute; top: 34px; right: 0; z-index: 51; min-width: 208px; padding: 6px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-strong); box-shadow: 0 18px 44px -14px rgba(0,0,0,.5) }
    .u-menu-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; border-radius: 8px; border: none; background: transparent; color: var(--fg-secondary); font-size: 12.5px; font-weight: 600; text-align: left; cursor: pointer; transition: background .12s, color .12s; white-space: nowrap }
    .u-menu-item:hover:not(.disabled) { background: var(--bg-tertiary); color: var(--fg-primary) }
    .u-menu-item.danger:hover:not(.disabled) { color: var(--danger) }
    .u-menu-item.disabled { opacity: .4; cursor: not-allowed }

    /* ─── Permission matrix ─── */
    .m-card { position: relative; z-index: 1; overflow: hidden; padding: 0 }
    .m-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 16px 18px 14px; border-bottom: 1px solid var(--border-subtle) }
    .m-title { font-size: 15px; font-weight: 700; color: var(--fg-primary) }
    .m-desc { margin-top: 5px; font-size: 12.5px; color: var(--fg-tertiary); max-width: 62ch }
    .m-detail-link { font-size: 12px; font-weight: 600; color: var(--tracky-light); white-space: nowrap; flex-shrink: 0 }
    .m-detail-link:hover { text-decoration: underline }
    .m-grid { display: grid; grid-template-columns: minmax(180px,2fr) repeat(5,1fr); align-items: center; gap: 10px; padding: 11px 18px; border-top: 1px solid var(--border-subtle) }
    .m-group-h { padding: 13px 18px 5px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-tertiary); border-top: 1px solid var(--border-subtle) }
    .m-grid-head { border-top: none; background: var(--surface-rail) }
    .m-col-h { text-align: center; font-size: 12px; font-weight: 700; color: var(--fg-secondary) }
    .m-cap { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .m-cap-ico { color: var(--fg-tertiary) }
    .m-cap-danger { color: var(--danger) }
    .m-cell { display: flex; justify-content: center }
    .chk { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 7px; background: color-mix(in srgb, var(--tracky) 14%, transparent); color: var(--tracky-light) }
    .chk-part { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 7px; background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--warning); font-size: 13px }
    .chk-none { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; color: var(--fg-tertiary); font-weight: 700 }
    /* ═══ Espace dépôt (2026-08) — le marqueur ◆ et les cases figées ═══════════
       Violet, DISTINCT de la coche verte. C'est la distinction qui permet à un
       Fleet Admin de comprendre en trois secondes qu'ouvrir un accès dépôt
       n'ouvre pas sa flotte (A5 § 4). */
    .chk-depot { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
                 border-radius: 7px; background: color-mix(in srgb, var(--violet) 16%, transparent);
                 color: var(--violet); font-size: 12px; font-weight: 700 }
    .chk-fige { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
                color: var(--fg-tertiary); opacity: .5 }
    /* La colonne entière est visiblement figée : le rôle est fermé, ses cases ne se
       cochent pas. Le dire par le style évite qu'on essaie puis qu'on cherche pourquoi. */
    .m-cell--fige { opacity: .92; cursor: not-allowed }
    .m-legend-depot { margin: 0; padding: 11px 18px; border-top: 1px solid var(--border-subtle);
                      background: color-mix(in srgb, var(--violet) 7%, transparent);
                      font-size: 11.5px; line-height: 1.6; color: var(--fg-secondary) }
    .m-legend-depot strong { color: var(--violet) }
    .m-legend { display: flex; flex-wrap: wrap; gap: 16px; padding: 12px 18px; border-top: 1px solid var(--border-subtle); background: var(--bg-secondary); font-size: 11.5px; color: var(--fg-tertiary) }
    .m-legend > span { display: inline-flex; align-items: center; gap: 7px }
    .chk-sm { width: 18px; height: 18px }

    @media (max-width: 1000px) {
      .u-thead, .u-row { grid-template-columns: minmax(160px,2fr) 140px 44px }
      .u-col-scope, .u-col-last { display: none !important }
      .m-grid { grid-template-columns: minmax(140px,1.6fr) repeat(5,1fr) }
    }
  `],
})
export class UsersListComponent implements OnInit {
  private readonly usersService = inject(UsersApiService);
  private readonly http = inject(HttpClient);
  private readonly audioApi = inject(AudioMonitoringService);
  private readonly toast = inject(ToastService);

  private readonly fleetFilter = inject(FleetFilterService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** Onglet actif : comptes (accès app) / rôles (matrice) / conducteurs (personnes). */
  readonly activeTab = signal<'accounts' | 'roles' | 'drivers'>('accounts');

  /** Changement d'onglet AVEC synchro URL (?tab=) → PAGE_VIEW distinct côté tracker. */
  protected selectTab(tab: 'accounts' | 'roles' | 'drivers'): void {
    this.activeTab.set(tab);
    this.closeMenu();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'accounts' ? null : tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  readonly loading = signal(true);
  /**
   * Espace dépôt (2026-08) — missions en cours par compte dépôt, pour la colonne
   * « Périmètre » (A5 § 3). Chargé à part et sans bloquer : la liste des utilisateurs
   * ne doit pas dépendre d'une donnée de mission.
   */
  protected readonly missionsEnCours = signal<Record<string, number>>({});
  /**
   * Message de PANNE, distinct de l'etat « aucun utilisateur ».
   *
   * ⚠️ Les deux se ressemblaient a l'ecran : un `catch {}` vide laissait la liste vide,
   * et l'utilisateur lisait « Aucun utilisateur dans votre flotte » pour une panne
   * serveur ou une session expiree. Un ecran vide et un ecran en panne ne se corrigent
   * pas au meme endroit — ils ne doivent pas se ressembler.
   */
  readonly loadError = signal<string | null>(null);
  readonly users = signal<TrackyUser[]>([]);
  readonly pendingInvitations = signal<PendingInvitation[]>([]);
  readonly includeArchived = signal(false);
  readonly totalCount = computed(() => this.users().length + this.pendingInvitations().length);

  /** Menu d'actions par ligne (⋮) : id de la ligne ouverte, ou null. */
  readonly openMenuId = signal<string | null>(null);
  protected toggleMenu(id: string, ev: Event): void {
    ev.stopPropagation();
    this.openMenuId.update((cur) => (cur === id ? null : id));
  }
  protected closeMenu(): void { this.openMenuId.set(null); }

  /** Ferme le menu ⋮ sur tout clic hors du menu/bouton (y compris navbar, quel que soit le z-index). */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(ev: MouseEvent): void {
    if (!this.openMenuId()) return;
    const t = ev.target as HTMLElement;
    if (!t.closest('.u-menu') && !t.closest('.u-menu-btn')) this.closeMenu();
  }

  /** Vues filtrées par le sélecteur de société global (SUPER_ADMIN). No-op sinon. */
  readonly visibleUsers = computed(() => this.users().filter((u) => this.fleetFilter.matches(u.fleetId)));
  readonly visiblePendingInvitations = computed(() =>
    this.pendingInvitations().filter((i) => this.fleetFilter.matches(i.fleetId)),
  );
  /**
   * ⚠️ MEMBRES ≠ INVITATIONS. Ce compteur additionnait les deux.
   *
   * Constat du 2026-08-03 : cdef31 affichait « 10 membre(s) dans votre flotte » pour SIX
   * comptes réels et quatre invitations — dont les quatre avaient expiré un mois plus tôt.
   * Personne, sur cette flotte, n'a jamais eu dix accès.
   *
   * Un invité n'est pas un membre : il n'a pas de compte, il ne peut rien voir, et il peut
   * ne jamais accepter. Les compter ensemble gonfle un chiffre que le gestionnaire lit
   * comme « qui a accès à mes données ».
   */
  readonly visibleTotalCount = computed(() => this.visibleUsers().length);

  /** Invitations en attente RÉELLE (non expirées) — affichées à part du compte des membres. */
  readonly visiblePendingCount = computed(
    () => this.visiblePendingInvitations().filter((i) => i.status === 'PENDING').length,
  );

  /** Invitations dont le lien est MORT : elles demandent une action (renvoyer), pas une attente. */
  readonly visibleExpiredCount = computed(
    () => this.visiblePendingInvitations().filter((i) => i.status !== 'PENDING').length,
  );

  // ─── Matrice de permissions (référence rôles) ─────────────────
  protected readonly roleCols: { role: AppRole; short: string }[] = [
    { role: 'FLEET_ADMIN', short: 'Admin' },
    { role: 'FLEET_MANAGER', short: 'Gestionnaire' },
    { role: 'VIEWER', short: 'Lecteur' },
    { role: 'NIGHT_WATCHMAN', short: 'Veilleur' },
    { role: 'DRIVER', short: 'Conducteur' },
    // Espace dépôt (2026-08) — 6ᵉ colonne, après Conducteur (A5 § 4).
    { role: 'DEPOT', short: 'Dépôt' },
  ];
  /**
   * TOUTES les capacités, groupées, dérivées de la SOURCE UNIQUE (packages/shared) — plus de liste
   * codée en dur. Chaque permission du vrai modèle apparaît ; le rôle ne fait que fixer le défaut.
   */
  protected readonly permGroups = PERMISSION_GROUP_ORDER
    .map((group) => ({
      group,
      perms: (Object.keys(PERMISSION_LABELS) as (keyof UserPermissions)[])
        .filter((k) => PERMISSION_LABELS[k].group === group)
        .map((k) => ({ key: k, label: PERMISSION_LABELS[k].label, description: PERMISSION_LABELS[k].description ?? '' })),
    }))
    .filter((g) => g.perms.length > 0);

  /**
   * Une capacité est-elle ACTIVE par défaut pour ce rôle ? Sinon elle est simplement désactivée
   * par défaut — mais reste ACTIVABLE par utilisateur (il n'y a pas de « non disponible » réel).
   */
  protected isDefaultOn(key: keyof UserPermissions, role: AppRole): boolean {
    return !!getDefaultPermissions(role)[key];
  }

  // Drawer (create + edit)
  readonly showDrawer = signal(false);
  readonly drawerData = signal<UserDrawerData | null>(null);
  readonly drawerLoading = signal(false);

  readonly showDeleteModal = signal(false);
  readonly deleting = signal(false);
  readonly userToDelete = signal<TrackyUser | null>(null);

  // Info Mode assistance — confirmation modal (SUPER_ADMIN only)
  readonly showAudioInfoModal = signal(false);
  readonly sendingAudioInfo = signal(false);
  readonly audioInfoTarget = signal<TrackyUser | null>(null);
  /**
   * FAIL-CLOSED — fleetIds dont la flotte est ÉLIGIBLE (N1 `superAdminEnabled === true`).
   * Tant que `getFleetsWithAudio()` n'a pas résolu (ou s'il échoue), le set reste vide
   * → le bouton « Info Mode assistance » reste désactivé. Inutile d'inviter un fleet-admin
   * à activer le Mode assistance avant que le prestataire ait rendu sa flotte éligible.
   */
  readonly eligibleFleetIds = signal<Set<string>>(new Set());
  /** Le bouton mail est ACTIF uniquement si l'user a une flotte ET qu'elle est éligible. */
  protected audioInfoDisabled(user: TrackyUser): boolean {
    return !user.fleetId || !this.eligibleFleetIds().has(user.fleetId);
  }
  /** Tooltip du bouton mail : explique pourquoi il est grisé tant que la flotte n'est pas éligible. */
  protected audioInfoTooltip(user: TrackyUser): string {
    return this.audioInfoDisabled(user)
      ? "Rendez d'abord la flotte éligible (Réglages → Audio — flottes éligibles)"
      : "Envoyer l'info Mode assistance";
  }
  /** Corps de la modale : destinataire + résumé court de ce que contient le mail. */
  readonly audioInfoDescription = computed(() => {
    const email = this.audioInfoTarget()?.email ?? '';
    return (
      `Envoyer le mail d'information <strong>Mode assistance</strong> à <strong>${email}</strong> ?` +
      `<br/><br/>Le mail explique le principe (écoute en direct en cas d'accident, sur autorisation ` +
      `explicite du client, aucun enregistrement conservé — seules les métadonnées sont tracées), ` +
      `la marche à suivre pour l'activer et les obligations (information des conducteurs, signalétique, réglementation).`
    );
  });

  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly groupsService = inject(VehicleGroupsService);
  private readonly userAccess = inject(UserAccessService);

  // Access drawer
  readonly showAccessDrawer = signal(false);
  readonly accessDrawerData = signal<AccessDrawerData | null>(null);
  readonly savingAccess = signal(false);


  private readonly auth = inject(AuthService);
  private readonly fleetsApi = inject(FleetsApiService);
  protected readonly perms = inject(PermissionsService);
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  private fleets: FleetSummary[] = [];
  /** Vrai si `/api/fleets` a echoue : distingue « pas de flotte » de « on ne sait pas ». */
  private fleetsEnEchec = false;

  protected userInitials(u: TrackyUser): string {
    if (u.firstName && u.lastName) return (u.firstName[0] + u.lastName[0]).toUpperCase();
    if (u.firstName) return u.firstName.slice(0, 2).toUpperCase();
    return u.email.slice(0, 2).toUpperCase();
  }

  /** Nom affiché : « Prénom Nom », sinon la partie locale de l'email. */
  protected displayName(u: TrackyUser): string {
    const n = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
    return n || u.email.split('@')[0];
  }
  protected invName(inv: PendingInvitation): string { return inv.email.split('@')[0]; }
  protected invInitials(inv: PendingInvitation): string { return inv.email.slice(0, 2).toUpperCase(); }

  /** Classe d'avatar par rôle (accent pour admin, neutre sinon). */
  protected avatarClass(u: TrackyUser): string {
    return u.role === 'FLEET_ADMIN' || u.role === 'SUPER_ADMIN' ? 'admin' : u.role === 'FLEET_MANAGER' ? 'manager' : 'viewer';
  }
  protected rolePillClass(role: string): string {
    // Espace dépôt — violet, la couleur du dépôt dans tout le système (A5 § 3).
    if (role === 'DEPOT') return 'depot';
    return role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN' ? 'admin' : 'neutral';
  }
  /** Périmètre honnête dérivé du rôle (le détail par groupe/véhicule est dans le drawer Accès). */
  protected perimeterLabel(u: TrackyUser): string {
    if (!u.isActive) return 'Archivé';
    if (u.role === 'SUPER_ADMIN' || u.role === 'FLEET_ADMIN') return 'Toute la flotte';
    // ═══ ESPACE DÉPÔT — LA COLONNE PORTE L'ACTIVITÉ, PAS UN SCOPE ═══════════
    //
    // A5 § 3 : « La colonne Périmètre porte l'activité plutôt qu'un scope — c'est
    // l'information utile : un dépôt sans mission depuis trois mois est un compte
    // à fermer. »
    //
    // Écrire « Accès personnalisé » pour un dépôt serait faux deux fois : il n'a
    // aucun scope, et rien n'a été personnalisé.
    if (u.role === 'DEPOT') {
      const n = this.missionsEnCours()[u.id];
      if (n === undefined) return 'Missions…';
      return n === 0 ? 'Aucune mission' : n === 1 ? '1 mission en cours' : `${n} missions en cours`;
    }
    return 'Accès personnalisé';
  }

  protected formatDate(date: string): string {
    try {
      return new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric' }).format(new Date(date));
    } catch { return ''; }
  }

  protected readonly ArchiveIcon = Archive;
  protected readonly KeyIcon = KeyRound;
  protected readonly UsersIcon = Users;
  protected readonly AlertTriangleIcon = AlertTriangle;
  protected readonly ShieldIcon = Shield;
  protected readonly PencilIcon = Pencil;
  protected readonly SendIcon = Send;
  protected readonly XCircleIcon = XCircle;
  protected readonly MailIcon = Mail;
  protected readonly UserPlusIcon = UserPlus;
  protected readonly MoreVerticalIcon = MoreVertical;
  protected readonly CheckIcon = Check;

  async ngOnInit(): Promise<void> {
    // Deep-link d'onglet via ?tab=drivers|roles (redirection /drivers → /users?tab=drivers).
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if (tab === 'drivers' && this.perms.can('drivers_view')) {
      this.activeTab.set('drivers');
    } else if (tab === 'roles') {
      this.activeTab.set('roles');
    }
    await this.loadUsers();
    // Espace dépôt — l'activité des dépôts, détachée : un échec laisse « Missions… »
    // et n'empêche pas la liste de s'afficher.
    void firstValueFrom(this.http.get<Record<string, number>>('/api/missions/depot-activity'))
      .then((a) => this.missionsEnCours.set(a ?? {}))
      .catch((err) => swallow('users-list:depotActivity', err));
    if (this.isSuperAdmin()) {
      // ⚠️ C'ETAIT UN `.catch(() => [])` MUET. En cas de panne, le selecteur de flotte
      // du drawer DISPARAISSAIT — sa condition d'affichage est `fleets?.length` — et un
      // SUPER_ADMIN creait alors des comptes sans flotte sans qu'aucun ecran ne l'indique.
      // Pour un compte DEPOT, cela produit un compte inerte : `validerDepot` (API) exige
      // un depot de la flotte de la mission. On retient donc l'echec pour le dire.
      this.fleets = await firstValueFrom(this.fleetsApi.list()).catch((err) => {
        swallow('users-list:fleets', err);
        this.fleetsEnEchec = true;
        return [] as FleetSummary[];
      });
      // FAIL-CLOSED : on construit l'ensemble des flottes éligibles (N1). En cas d'erreur,
      // le set reste vide → tous les boutons « Info Mode assistance » restent désactivés.
      await firstValueFrom(this.audioApi.getFleetsWithAudio())
        .then((fleets) =>
          this.eligibleFleetIds.set(
            new Set(fleets.filter((f) => f.superAdminEnabled).map((f) => f.fleetId)),
          ),
        )
        .catch(() => { /* fail-closed : on laisse le set vide */ });
    }
  }

  /** Relance le chargement depuis l'écran de panne (une panne réseau est souvent passagère). */
  protected reload(): void {
    void this.loadUsers();
  }

  private async loadUsers(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const result = await this.usersService.findAll(this.includeArchived(), true);
      this.users.set(result.users);
      this.pendingInvitations.set(result.pendingInvitations);
    } catch (err) {
      // ⚠️ C'ETAIT UN `catch {}` VIDE. L'ecran affichait alors « Aucun utilisateur dans
      // votre flotte » — la reponse metier d'une flotte vide — pour une panne serveur,
      // une coupure reseau, un 403, ou une SESSION EXPIREE. L'utilisateur concluait que
      // son parc etait vide et ne rappelait personne.
      //
      // Un ecran vide et un ecran en panne ne se corrigent pas au meme endroit : ils ne
      // doivent pas se ressembler.
      this.users.set([]);
      this.pendingInvitations.set([]);
      // Message CENTRALISE : deux ecrans ne doivent pas raconter deux histoires
      // differentes de la meme panne.
      //
      // ⚠️ Cet appel passe par `fetch` natif, donc hors intercepteurs : un 401 ne
      // declenche NI deconnexion NI toast « Session expiree ». On le dit au moins.
      this.loadError.set(httpFailureMessage(err, 'les utilisateurs'));
    } finally {
      this.loading.set(false);
    }
  }

  roleLabel(role: string): string {
    return roleLabelFr(role);
  }

  async openCreateDrawer(): Promise<void> {
    // Charge véhicules + groupes pour la matrice d'accès intégrée (scopes GROUP/VEHICLE).
    // Best-effort : en cas d'échec on ouvre quand même (scope « Toute la flotte » suffit).
    const [groups, vehicles] = await Promise.all([
      this.groupsService.list().catch(() => []),
      firstValueFrom(this.vehiclesApi.list()).catch(() => []),
    ]);
    this.drawerData.set({
      mode: 'create',
      isSuperAdmin: this.isSuperAdmin(),
      fleets: this.fleets,
      fleetsEnEchec: this.fleetsEnEchec,
      groups,
      vehicles,
      // Audio hors invitation (accordable après acceptation via la matrice, garde d'éligibilité).
      audioEligible: false,
    });
    this.showDrawer.set(true);
  }

  async openEditDrawer(user: TrackyUser): Promise<void> {
    // Charge la matrice : véhicules/groupes + scopes d'accès existants de l'utilisateur.
    const [groups, vehicles, access] = await Promise.all([
      this.groupsService.list().catch(() => []),
      firstValueFrom(this.vehiclesApi.list()).catch(() => []),
      firstValueFrom(this.userAccess.getAccess(user.id)).catch(() => null),
    ]);
    const accessEntries = (access?.entries ?? []).map((e) => ({
      type: e.accessType,
      groupId: e.groupId ?? undefined,
      vehicleId: e.vehicleId ?? undefined,
      permissions: (e.permissions ?? undefined) as Record<string, boolean> | undefined,
    }));
    this.drawerData.set({
      mode: 'edit',
      user,
      isSuperAdmin: this.isSuperAdmin(),
      fleets: this.fleets,
      fleetsEnEchec: this.fleetsEnEchec,
      groups,
      vehicles,
      audioEligible: !!user.fleetId && this.eligibleFleetIds().has(user.fleetId),
      accessEntries,
    });
    this.showDrawer.set(true);
  }

  async openEditInvitationDrawer(inv: PendingInvitation): Promise<void> {
    const [groups, vehicles] = await Promise.all([
      this.groupsService.list().catch(() => []),
      firstValueFrom(this.vehiclesApi.list()).catch(() => []),
    ]);
    this.drawerData.set({
      mode: 'edit-invitation',
      invitation: {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        fleetId: inv.fleetId,
        permissions: inv.permissions,
        accessScopes: (inv.accessScopes ?? undefined) as { type: 'ALL' | 'GROUP' | 'VEHICLE'; groupId?: string; vehicleId?: string; permissions?: Record<string, boolean> }[] | undefined,
      },
      isSuperAdmin: this.isSuperAdmin(),
      fleets: this.fleets,
      fleetsEnEchec: this.fleetsEnEchec,
      groups,
      vehicles,
      audioEligible: !!inv.fleetId && this.eligibleFleetIds().has(inv.fleetId),
    });
    this.showDrawer.set(true);
  }

  async onDrawerSave(result: UserDrawerResult): Promise<void> {
    this.drawerLoading.set(true);
    try {
      const mode = this.drawerData()?.mode;
      if (mode === 'create') {
        await this.usersService.invite({
          email: result.email!,
          role: result.role,
          fleetId: result.fleetId,
          accessScopes: result.accessScopes,
        });
        this.toast.success(`Invitation envoyée a ${result.email}`);
      } else if (mode === 'edit-invitation') {
        const invId = this.drawerData()?.invitation?.id;
        if (invId) {
          await this.usersService.updateInvitation(invId, {
            fleetId: result.fleetId,
            role: result.role,
            accessScopes: result.accessScopes,
          });
          this.toast.success('Invitation mise à jour');
        }
      } else {
        const userId = this.drawerData()?.user?.id;
        if (userId) {
          const fleetChanged = this.isSuperAdmin() && result.fleetId !== undefined;
          // 1) Champs utilisateur (rôle/actif/flotte). Le changement de rôle réinitialise
          //    la base d'héritage `User.permissions` côté backend ; les scopes ci-dessous
          //    pilotent l'accès résolu (per-véhicule + union globale).
          await this.usersService.update(userId, {
            firstName: result.firstName,
            lastName: result.lastName,
            role: result.role,
            isActive: result.isActive,
            ...(fleetChanged ? { fleetId: result.fleetId } : {}),
          });
          // 2) Matrice d'accès : remplace les scopes (UserVehicleAccess) — même chemin que
          //    le bouton « Accès & Perms » (conservé), donc parfaitement cohérent.
          if (result.accessScopes && result.accessScopes.length > 0) {
            await firstValueFrom(this.userAccess.setAccess(userId, result.accessScopes));
          }
        }
      }
      this.showDrawer.set(false);
      await this.loadUsers();
    } catch (err) {
      swallow('users-list:onDrawerSave', err);
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
    finally { this.drawerLoading.set(false); }
  }

  confirmDelete(user: TrackyUser): void {
    this.userToDelete.set(user);
    this.showDeleteModal.set(true);
  }

  async onDelete(): Promise<void> {
    const user = this.userToDelete();
    if (!user) return;
    this.deleting.set(true);
    try {
      await this.usersService.remove(user.id);
      this.showDeleteModal.set(false);
      this.userToDelete.set(null);
      await this.loadUsers();
    } catch (err) {
      // ⚠️ C'ETAIT UN `catch { /* error */ }` MUET, sur un appel `fetch` NATIF — donc
      // hors intercepteur HTTP : rien, absolument rien, n'informait l'utilisateur. Il
      // cliquait « Archiver », la fenetre restait ouverte, et aucun message n'expliquait
      // pourquoi. Le syndrome « j'ai clique, il ne se passe rien ».
      this.toast.error('Archivage impossible', httpFailureMessage(err, 'cet utilisateur'));
    } finally { this.deleting.set(false); }
  }

  async toggleArchived(): Promise<void> {
    this.includeArchived.update((v) => !v);
    await this.loadUsers();
  }

  async onUnarchive(user: TrackyUser): Promise<void> {
    try {
      await this.usersService.update(user.id, { isActive: true });
      this.toast.success(`${user.email} a été désarchivé.`);
      await this.loadUsers();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
  }

  async onResetPassword(user: TrackyUser): Promise<void> {
    try {
      await this.usersService.resetPassword(user.id);
      this.toast.success(`Un email de reinitialisation a été envoyé a ${user.email}.`);
    } catch {
      this.toast.error('Erreur lors de l\'envoi du lien de reinitialisation.');
    }
  }

  // ─── Info Mode assistance (SUPER_ADMIN only) ───────────────

  /** Ouvre la modale de confirmation d'envoi du mail d'info Mode assistance. */
  confirmAudioInfoMail(user: TrackyUser): void {
    this.audioInfoTarget.set(user);
    this.showAudioInfoModal.set(true);
  }

  /** Confirme : envoie le mail d'info Mode assistance au destinataire, puis toast + ferme. */
  async onSendAudioInfoMail(): Promise<void> {
    const user = this.audioInfoTarget();
    if (!user) return;
    this.sendingAudioInfo.set(true);
    try {
      await firstValueFrom(this.audioApi.sendAudioInfoMail(user.id));
      this.toast.success(`Mail envoyé a ${user.email}`);
      this.showAudioInfoModal.set(false);
      this.audioInfoTarget.set(null);
    } catch (err) {
      swallow('users-list:onSendAudioInfoMail', err);
      this.toast.error(err instanceof Error ? err.message : 'Erreur lors de l\'envoi du mail.');
      this.showAudioInfoModal.set(false);
    } finally {
      this.sendingAudioInfo.set(false);
    }
  }

  // ─── Invitation actions ────────────────────────────────

  async onResendInvitation(inv: PendingInvitation): Promise<void> {
    try {
      await this.usersService.resendInvitation(inv.id);
      this.toast.success(`Invitation renvoyee a ${inv.email}`);
      await this.loadUsers();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
  }

  async onRevokeInvitation(inv: PendingInvitation): Promise<void> {
    try {
      await this.usersService.revokeInvitation(inv.id);
      this.toast.success(`Invitation revoquee pour ${inv.email}`);
      await this.loadUsers();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
  }

  // ─── Vehicle Access Drawer ───────────────────────────────

  private accessUserId = '';

  async openAccessModal(user: TrackyUser): Promise<void> {
    this.accessUserId = user.id;

    const [groups, vehicles, currentAccess] = await Promise.all([
      this.groupsService.list(),
      firstValueFrom(this.vehiclesApi.list()),
      this.groupsService.getUserAccess(user.id),
    ]);

    this.accessDrawerData.set({
      userEmail: user.email,
      currentType: currentAccess.type,
      currentGroupIds: currentAccess.groupIds,
      currentVehicleIds: currentAccess.vehicleIds,
      groups,
      vehicles,
    });
    this.showAccessDrawer.set(true);
  }

  async onAccessDrawerSave(result: AccessDrawerResult): Promise<void> {
    this.savingAccess.set(true);
    try {
      await this.groupsService.setUserAccess(this.accessUserId, {
        type: result.type,
        groupIds: result.type === 'ALL' ? [] : result.groupIds,
        vehicleIds: result.type === 'ALL' ? [] : result.vehicleIds,
      });
      this.showAccessDrawer.set(false);
      this.toast.success('Accès enregistré');
    } catch (err) {
      // ⚠️ LE PLUS GRAVE DES DEUX : c'est le PERIMETRE D'ACCES d'un utilisateur — quels
      // vehicules il a le droit de voir. Un echec silencieux ici laisse croire qu'on a
      // restreint quelqu'un alors que rien n'a ete enregistre. Un reglage de securite
      // qui echoue sans le dire est pire que pas de reglage du tout : on cesse de
      // verifier ce qu'on croit avoir fait.
      this.toast.error('Accès non enregistré', httpFailureMessage(err, 'les accès'));
    } finally { this.savingAccess.set(false); }
  }
}

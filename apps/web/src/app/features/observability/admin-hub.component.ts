import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule, AlertTriangle, Activity, Terminal, MessageSquare,
  Users, Radio, Shield, Zap, ChevronRight, Database, ClipboardList, CreditCard, Cpu, Footprints, Ear, Mail, CalendarClock, Bot, Globe, BellRing, Plug, Server,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AdminFixModeService, type AdminAlertSummary } from '../../core/services/admin-fix-mode.service';

@Component({
  selector: 'app-admin-hub',
  standalone: true,
  imports: [RouterLink, LucideAngularModule],
  template: `
    <div class="hub">
      <div class="hub-head">
        <div>
          <h1>Administration</h1>
          <p>Supervision, diagnostic et configuration avancee.</p>
        </div>
        @if (stats(); as s) {
          <div class="pulse" [class.pulse-warn]="s.failing > 0 || s.criticalLastHour > 0">
            <span class="pulse-dot"></span>
            {{ s.failing > 0 || s.criticalLastHour > 0 ? 'Alertes actives' : 'Nominal' }}
          </div>
        }
      </div>

      <div class="grid">
        <!-- ── HERO : Centre d'alertes ── -->
        <a routerLink="/admin/alerts" class="card card-hero" style="--i:0">
          <span class="accent accent-red"></span>
          <div class="card-bg-hero"></div>
          <div class="body body-hero">
            <div class="row-top">
              <div class="ico ico-red ico-lg"><lucide-icon [img]="AlertTriangle" [size]="26"></lucide-icon></div>
              <lucide-icon [img]="ChevronRight" [size]="18" class="chevron"></lucide-icon>
            </div>
            <h3>Centre d'alertes</h3>
            <p class="desc">Trackers en echec, hors ligne, commandes en attente, erreurs applicatives — tout centralise.</p>
            @if (stats(); as s) {
              <div class="stats-row">
                <div class="kpi" [class.kpi-hot]="s.failing > 0">
                  <span class="kpi-n">{{ s.failing }}</span><span class="kpi-l">Failing</span>
                </div>
                <div class="kpi" [class.kpi-hot]="s.offline > 0">
                  <span class="kpi-n">{{ s.offline }}</span><span class="kpi-l">Offline</span>
                </div>
                <div class="kpi" [class.kpi-hot]="s.pending > 0">
                  <span class="kpi-n">{{ s.pending }}</span><span class="kpi-l">Pending</span>
                </div>
                <div class="kpi" [class.kpi-hot]="s.errorsLast24h > 0">
                  <span class="kpi-n">{{ s.errorsLast24h }}</span><span class="kpi-l">Err. 24h</span>
                </div>
              </div>
            }
          </div>
        </a>

        <!-- ── DIAGNOSTIC (tall) ── -->
        <a routerLink="/admin/observability" class="card card-tall" style="--i:1">
          <span class="accent accent-green"></span>
          <div class="body">
            <div class="row-top">
              <div class="ico ico-green"><lucide-icon [img]="Activity" [size]="22"></lucide-icon></div>
              <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
            </div>
            <h3>Diagnostic & Tests</h3>
            <p class="desc">Wire logs, timeline par tracker, test push notification, test SMS fallback.</p>
            <div class="visual-wave">
              <svg viewBox="0 0 120 24" preserveAspectRatio="none"><path d="M0 18 Q15 4 30 14 T60 10 T90 16 T120 8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/><path d="M0 20 Q15 10 30 16 T60 14 T90 18 T120 12" fill="none" stroke="currentColor" stroke-width="1" opacity="0.12"/></svg>
            </div>
          </div>
        </a>

        <!-- ── TRACKERS ── -->
        <a routerLink="/admin/trackers" class="card" style="--i:2">
          <span class="accent accent-blue"></span>
          <div class="body">
            <div class="row-top">
              <div class="ico ico-blue"><lucide-icon [img]="Radio" [size]="20"></lucide-icon></div>
              <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
            </div>
            <h3>Trackers</h3>
            <p class="desc">Inventaire global, assignation vehicules, gestion SIM, statut en ligne.</p>
          </div>
        </a>

        <!-- ── COMMANDES ── -->
        <a routerLink="/admin/commands" class="card" style="--i:3">
          <span class="accent accent-indigo"></span>
          <div class="body">
            <div class="row-top">
              <div class="ico ico-indigo"><lucide-icon [img]="Terminal" [size]="20"></lucide-icon></div>
              <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
            </div>
            <h3>Commandes tracker</h3>
            <p class="desc">Historique et monitoring des commandes TCP/SMS envoyees aux boitiers.</p>
          </div>
        </a>

        <!-- ── SMS & BACKUP ── -->
        <a routerLink="/admin/sms" class="card" style="--i:4">
          <span class="accent accent-purple"></span>
          <div class="body">
            <div class="row-top">
              <div class="ico ico-purple"><lucide-icon [img]="MessageSquare" [size]="20"></lucide-icon></div>
              <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
            </div>
            <h3>SMS & Backup</h3>
            <p class="desc">Provisioning SMS, logs Twilio, allowlist vizyo-texto, backups Postgres.</p>
          </div>
        </a>

        <!-- ── CONSENTEMENTS RGPD ── -->
        <a routerLink="/admin/consent" class="card" style="--i:5">
          <span class="accent accent-green"></span>
          <div class="body">
            <div class="row-top">
              <div class="ico ico-green"><lucide-icon [img]="Shield" [size]="20"></lucide-icon></div>
              <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
            </div>
            <h3>Consentements RGPD</h3>
            <p class="desc">Qui a consenti — application & landing page, avec l'adresse IP.</p>
          </div>
        </a>

        <!-- ── SÉCURITÉ & CONNEXIONS ── -->
        <a routerLink="/admin/security" class="card" style="--i:5">
          <span class="accent accent-green"></span>
          <div class="body">
            <div class="row-top">
              <div class="ico ico-green"><lucide-icon [img]="Globe" [size]="20"></lucide-icon></div>
              <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
            </div>
            <h3>Sécurité &amp; connexions</h3>
            <p class="desc">Qui a activé le 2FA, et la carte des lieux de connexion par utilisateur.</p>
          </div>
        </a>

        <!-- ── SYNC AUTH (wide) ── -->
        <a routerLink="/admin/auth-sync" class="card card-wide" style="--i:5">
          <span class="accent accent-cyan"></span>
          <div class="body body-row">
            <div class="ico ico-cyan"><lucide-icon [img]="Users" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Sync Auth / Tracky</h3>
              <p class="desc">Comparer et reconcilier les comptes entre Vizyo Auth et la base Tracky.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── PLANNINGS D'INSTALLATION (wide) ── -->
        <a routerLink="/admin/installations" class="card card-wide" style="--i:6">
          <span class="accent accent-amber"></span>
          <div class="body body-row">
            <div class="ico ico-amber"><lucide-icon [img]="ClipboardList" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Plannings d'installation</h3>
              <p class="desc">Planifier les poses de boîtiers par client, saisir IMEI + SIM à la pose, suivre l'avancement. Le client consulte son planning.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── RÉSERVATIONS D'INSTALLATION (wide) ── -->
        <a routerLink="/admin/installation-bookings" class="card card-wide" style="--i:6">
          <span class="accent accent-green"></span>
          <div class="body body-row">
            <div class="ico ico-green"><lucide-icon [img]="CalendarClock" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Réservations d'installation</h3>
              <p class="desc">Générer un lien public de prise de RDV, valider les créneaux choisis par les clients (crée la pose + e-mails) et voir l'agenda des poses.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── PARC SIM (wide) ── -->
        <a routerLink="/admin/sims" class="card card-wide" style="--i:7">
          <span class="accent accent-teal"></span>
          <div class="body body-row">
            <div class="ico ico-teal"><lucide-icon [img]="CreditCard" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Cartes SIM</h3>
              <p class="desc">Parc SIM M2M WhereverSIM : synchro inventaire, conso data, allocation aux flottes, assignation aux trackers, cycle de vie (activer / suspendre / résilier).</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── E-MAILS (wide) ── -->
        <a routerLink="/admin/emails" class="card card-wide" style="--i:9">
          <span class="accent accent-green"></span>
          <div class="body body-row">
            <div class="ico ico-green"><lucide-icon [img]="Mail" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>E-mails</h3>
              <p class="desc">Suivi des envois transactionnels, aperçu des modèles et santé de la délivrabilité (SPF/DKIM/DMARC, bounces, suppression). Toute la vie e-mail de Tracky au même endroit.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── ABONNEMENTS & TARIFS (wide) — D4 + Phase 3 chantier commercial ── -->
        <a routerLink="/admin/subscriptions" class="card card-wide" style="--i:9">
          <span class="accent accent-green"></span>
          <div class="body body-row">
            <div class="ico ico-green"><lucide-icon [img]="CreditCard" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Abonnements &amp; tarifs</h3>
              <p class="desc">Plan (Lite/Pro/Signature), formule et options de chaque client — avec cas spéciaux (offert, prix négocié) et revenu estimé. Édition de la grille tarifaire publique, propagée à la LP sans redéploiement.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!--
          ── INTÉGRATIONS PARTENAIRES (wide) ──
          ⚠️ La page existait, gardée par « superAdminGuard », mais AUCUNE tuile n'y menait :
          elle n'était atteignable qu'en connaissant son URL. Or c'est le levier commercial
          (suspendre un client qui ne paye pas) — il ne peut pas vivre hors de l'interface.
        -->
        <a routerLink="/admin/partner-links" class="card card-wide" style="--i:9">
          <span class="accent accent-violet"></span>
          <div class="body body-row">
            <div class="ico ico-violet"><lucide-icon [img]="Plug" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Intégrations partenaires</h3>
              <p class="desc">Liens actifs entre une flotte Tracky et un partenaire (Maestroo…) : qui partage quoi, depuis quand, et l'interrupteur pour couper un partage côté plateforme — le client ne peut pas le rétablir seul.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── SYSTÈME VPS (wide) ── -->
        <a routerLink="/admin/system" class="card card-wide" style="--i:8">
          <span class="accent accent-rose"></span>
          <div class="body body-row">
            <div class="ico ico-rose"><lucide-icon [img]="Cpu" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Système VPS</h3>
              <p class="desc">CPU, RAM, charge serveur et taille de la base — en direct + historique (hier / aujourd'hui / 7j / 30j) pour surveiller la charge et anticiper les purges.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── AUDIT VPS (wide) ──
             Complementaire de « Systeme VPS » ci-dessus, et volontairement separe : celui-la
             montre l'instant (CPU, RAM, charge), celui-ci montre la DERIVE (disque qui se
             remplit, conteneurs morts, paquets en retard, SSH expose). Deux temporalites. -->
        <a routerLink="/admin/vps" class="card card-wide" style="--i:8">
          <span class="accent accent-cyan"></span>
          <div class="body body-row">
            <div class="ico ico-cyan"><lucide-icon [img]="Server" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Audit VPS</h3>
              <p class="desc">Rapports quotidiens de la machine : ce qui sature, ce qui traine et ce qui expose. Constats horodates, gain estime et securite — en lecture seule.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── BOÎTIERS NON RECONNUS (wide) ── -->
        <a routerLink="/admin/unknown-trackers" class="card card-wide" style="--i:9">
          <span class="accent accent-amber"></span>
          <div class="body body-row">
            <div class="ico ico-amber"><lucide-icon [img]="AlertTriangle" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Boîtiers non reconnus</h3>
              <p class="desc">IMEI qui tapent le serveur en GPRS sans être enregistrés (→ le boîtier retombe en SMS). Vois-les en direct et crée le tracker sur son véhicule en 1 clic.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── ACTIVITÉ UTILISATEURS (wide) ── -->
        <a routerLink="/admin/activity" class="card card-wide" style="--i:10">
          <span class="accent accent-violet"></span>
          <div class="body body-row">
            <div class="ico ico-violet"><lucide-icon [img]="Footprints" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Activité utilisateurs</h3>
              <p class="desc">Qui est en ligne et sur quelle page, en direct. Sessions, navigation, temps par écran et clics — pour comprendre l'usage et améliorer l'interface.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── AUDIO — FLOTTES ÉLIGIBLES (wide) — N1 super-admin/prestataire ── -->
        <a routerLink="/admin/audio-eligibility" class="card card-wide" style="--i:11">
          <span class="accent accent-purple"></span>
          <div class="body body-row">
            <div class="ico ico-purple"><lucide-icon [img]="Ear" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Audio — flottes éligibles</h3>
              <p class="desc">Autorisez les flottes au Mode assistance (écoute de cabine en cas d'accident). Capacité légalement sensible : seules les flottes rendues éligibles ici peuvent ensuite y consentir.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── RÉTENTION DES DONNÉES (wide) — Sprint 6 ── -->
        <a routerLink="/admin/retention" class="card card-wide" style="--i:12">
          <span class="accent accent-teal"></span>
          <div class="body body-row">
            <div class="ico ico-teal"><lucide-icon [img]="Database" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Rétention des données</h3>
              <p class="desc">État de conservation des positions GPS (global + par flotte) : actives, archive/préavis récupérable, et ce qui sera supprimé — recalcul à la demande. Mode observation par défaut (aucune suppression).</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── COÛTS IA (wide) — Palier Coûts IA ── -->
        <a routerLink="/admin/ai-usage" class="card card-wide" style="--i:13">
          <span class="accent accent-amber"></span>
          <div class="body body-row">
            <div class="ico ico-amber"><lucide-icon [img]="Zap" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Coûts IA</h3>
              <p class="desc">Dépenses du copilote IA (Claude) : coût par utilisateur, flotte, type et jour, tendance du mois et journal des appels — avec budget mensuel et alerte rouge à l'approche du plafond.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── AUTOMATISATION DES TRAJETS (wide) ── -->
        <a routerLink="/admin/trip-automation" class="card card-wide" style="--i:14">
          <span class="accent accent-violet"></span>
          <div class="body body-row">
            <div class="ico ico-violet"><lucide-icon [img]="Bot" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Automatisation des trajets</h3>
              <p class="desc">Lance tout seul, pour toutes les flottes, le pipeline « recalcul → analyse déterministe → récit IA ». Cadence réglable (horaire pour tester, puis quotidien), plafonds de coût, et bouton « Lancer maintenant ».</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <a routerLink="/admin/background-tasks" class="card card-wide" style="--i:15">
          <span class="accent accent-violet"></span>
          <div class="body body-row">
            <div class="ico ico-violet"><lucide-icon [img]="CalendarClock" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Automatisations &amp; tâches de fond</h3>
              <p class="desc">Tout ce qui tourne en arrière-plan (horaires véhicules, rapports IA, purges, sécurité, temps réel) réuni au même endroit : période, prochain lancement (compte-à-rebours), état et réglages. Plus rien d'invisible.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── CENTRE DE NOTIFICATIONS (wide) ── -->
        <a routerLink="/admin/notifications" class="card card-wide" style="--i:16">
          <span class="accent accent-green"></span>
          <div class="body body-row">
            <div class="ico ico-green"><lucide-icon [img]="BellRing" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Centre de notifications</h3>
              <p class="desc">Toutes les notifications, envoyées comme retenues : qui l'a reçue, quand, sur combien d'appareils — et pour celles qui ne sont pas parties, POURQUOI. Santé du push en un coup d'œil (clés, périmètre, comptes sans appareil).</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>

        <!-- ── TRAFIC API & SOURCES (wide) ── -->
        <a routerLink="/admin/api-traffic" class="card card-wide" style="--i:16">
          <span class="accent accent-cyan"></span>
          <div class="body body-row">
            <div class="ico ico-cyan"><lucide-icon [img]="Globe" [size]="20"></lucide-icon></div>
            <div class="body-text">
              <h3>Trafic API &amp; Sources</h3>
              <p class="desc">Observabilité du trafic entrant (Landing, Maestroo, API, Webhooks) et intelligence IP : qui appelle quoi, IP connues vs inconnues, et détection des IP inconnues à forte fréquence (bot / scan). KPIs, tableau IP et flux en direct.</p>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="16" class="chevron"></lucide-icon>
          </div>
        </a>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .hub { max-width: 1060px; }

    /* ── HEADER ── */
    .hub-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; flex-wrap: wrap; margin-bottom: 36px;
    }
    .hub-head h1 {
      font-family: var(--font-display);
      font-size: 28px; font-weight: 800; letter-spacing: -.5px;
      color: var(--fg-primary); margin: 0;
    }
    .hub-head p { color: var(--fg-tertiary); font-size: 13px; margin: 5px 0 0; }

    .pulse {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 14px 5px 10px; border-radius: 20px;
      font-size: 11px; font-weight: 600;
      background: rgba(16,224,160,.06); border: 1px solid rgba(16,224,160,.12);
      color: var(--tracky-light);
    }
    .pulse-warn { background: rgba(239,68,68,.06); border-color: rgba(239,68,68,.15); color: #f87171; }
    .pulse-dot {
      width: 7px; height: 7px; border-radius: 50%; background: currentColor;
      animation: pd 2s ease-in-out infinite;
    }
    .pulse-warn .pulse-dot { animation: pdw 1.4s ease-in-out infinite; }
    @keyframes pd  { 50% { box-shadow: 0 0 0 5px rgba(16,224,160,0); opacity:.5 } }
    @keyframes pdw { 50% { box-shadow: 0 0 0 5px rgba(239,68,68,0); opacity:.5 } }

    /* ── GRID ── */
    .grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: auto auto auto;
    }
    .card-hero { grid-column: 1 / 3; grid-row: 1 / 3; min-height: 280px; }
    .card-tall { grid-column: 3;     grid-row: 1 / 3; }
    .card-wide { grid-column: 1 / -1; }

    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr 1fr; }
      .card-hero { grid-column: 1 / -1; grid-row: auto; min-height: 220px; }
      .card-tall { grid-column: 1 / -1; grid-row: auto; }
      .card-wide { grid-column: 1 / -1; }
    }
    @media (max-width: 480px) {
      .grid { grid-template-columns: 1fr; }
    }

    /* ── CARD ── */
    .card {
      position: relative; overflow: hidden;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 16px; text-decoration: none;
      transition: transform .3s cubic-bezier(.16,1,.3,1),
                  border-color .3s, box-shadow .4s;
      animation: pop .5s cubic-bezier(.16,1,.3,1) both;
      animation-delay: calc(var(--i,0) * 75ms);
    }
    .card:hover {
      transform: translateY(-3px);
      box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
    }
    .card:active { transform: translateY(0) scale(.99); }
    @keyframes pop { from { opacity:0; transform: translateY(18px) scale(.97); } }

    /* Color accent bar (top 3px) */
    .accent {
      position: absolute; top: 0; left: 0; right: 0; height: 3px;
      border-radius: 16px 16px 0 0;
    }
    .accent-red    { background: linear-gradient(90deg, #ef4444, #f97316); }
    .accent-green  { background: linear-gradient(90deg, #10e0a0, #34d399); }
    .accent-blue   { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
    .accent-indigo { background: linear-gradient(90deg, #6366f1, #818cf8); }
    .accent-purple { background: linear-gradient(90deg, #a855f7, #c084fc); }
    .accent-cyan   { background: linear-gradient(90deg, #06b6d4, #22d3ee); }
    .accent-amber  { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .accent-teal   { background: linear-gradient(90deg, #14b8a6, #2dd4bf); }
    .accent-rose   { background: linear-gradient(90deg, #f43f5e, #fb7185); }
    .accent-violet { background: linear-gradient(90deg, #8b5cf6, #a78bfa); }

    /* Hover border color */
    .card-hero:hover  { border-color: rgba(239,68,68,.25); }
    .card-tall:hover  { border-color: rgba(16,224,160,.25); }
    .card:nth-child(3):hover { border-color: rgba(59,130,246,.25); }
    .card:nth-child(4):hover { border-color: rgba(99,102,241,.25); }
    .card:nth-child(5):hover { border-color: rgba(168,85,247,.25); }
    .card-wide:hover  { border-color: rgba(6,182,212,.25); }

    /* ── BODY ── */
    .body {
      position: relative; z-index: 1;
      padding: 24px 26px; height: 100%;
      display: flex; flex-direction: column; gap: 10px;
    }
    .body-hero { justify-content: space-between; padding: 28px 30px; }
    .body-row {
      flex-direction: row; align-items: center; gap: 18px;
      padding: 18px 26px;
    }
    .body-text { flex: 1; min-width: 0; }
    .body-text h3, .body-text .desc { margin: 0; }
    .body-text .desc { margin-top: 2px; }

    .row-top {
      display: flex; align-items: flex-start; justify-content: space-between;
    }

    .body h3 {
      font-family: var(--font-display);
      font-size: 16px; font-weight: 700;
      color: var(--fg-primary); margin: 0;
    }
    .body-hero h3 { font-size: 22px; letter-spacing: -.3px; }

    .desc {
      font-size: 12px; line-height: 1.5;
      color: var(--fg-tertiary); margin: 0;
    }
    .body-hero .desc { font-size: 13px; max-width: 380px; }

    /* Chevron → */
    .chevron {
      color: var(--fg-tertiary); opacity: 0;
      transition: opacity .2s, transform .2s;
    }
    .card:hover .chevron { opacity: .6; transform: translateX(2px); }

    /* ── ICONS ── */
    .ico {
      width: 44px; height: 44px; border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: transform .3s cubic-bezier(.16,1,.3,1);
    }
    .ico-lg { width: 52px; height: 52px; border-radius: 14px; }
    .card:hover .ico { transform: scale(1.08) rotate(-4deg); }

    .ico-red    { background: rgba(239,68,68,.1);  color: #f87171; }
    .ico-green  { background: rgba(16,224,160,.1); color: var(--tracky-light); }
    .ico-blue   { background: rgba(59,130,246,.1); color: #60a5fa; }
    .ico-indigo { background: rgba(99,102,241,.1); color: #818cf8; }
    .ico-purple { background: rgba(168,85,247,.1); color: #c084fc; }
    .ico-cyan   { background: rgba(6,182,212,.1);  color: #22d3ee; }
    .ico-amber  { background: rgba(245,158,11,.1); color: #fbbf24; }
    .ico-teal   { background: rgba(20,184,166,.1); color: #2dd4bf; }
    .ico-rose   { background: rgba(244,63,94,.1);  color: #fb7185; }
    .ico-violet { background: rgba(139,92,246,.1); color: #a78bfa; }

    /* ── HERO BG ── */
    .card-bg-hero {
      position: absolute; inset: 0; pointer-events: none;
      background:
        radial-gradient(circle at 90% 85%, rgba(239,68,68,.07) 0%, transparent 45%),
        radial-gradient(circle at 5% 95%, rgba(251,146,60,.04) 0%, transparent 35%);
    }

    /* ── HERO STATS ── */
    .stats-row {
      display: flex; gap: 10px; flex-wrap: wrap; margin-top: auto;
    }
    .kpi {
      display: flex; flex-direction: column; align-items: center;
      padding: 10px 18px; border-radius: 12px;
      background: rgba(255,255,255,.025);
      border: 1px solid rgba(255,255,255,.04);
      min-width: 72px;
      transition: all .25s;
    }
    .kpi-hot {
      border-color: rgba(239,68,68,.2);
      background: rgba(239,68,68,.06);
    }
    .kpi-n {
      font-family: var(--font-display);
      font-size: 24px; font-weight: 800; line-height: 1;
      color: var(--fg-primary);
    }
    .kpi-hot .kpi-n { color: #f87171; }
    .kpi-l {
      font-size: 9px; text-transform: uppercase; letter-spacing: .6px;
      color: var(--fg-tertiary); margin-top: 4px; font-weight: 600;
    }

    /* ── DIAGNOSTIC WAVE (decorative) ── */
    .visual-wave {
      margin-top: auto; color: var(--tracky-light);
    }
    .visual-wave svg { width: 100%; height: 28px; }
  `],
})
export class AdminHubComponent implements OnInit {
  private readonly api = inject(AdminFixModeService);

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Activity = Activity;
  protected readonly Terminal = Terminal;
  protected readonly MessageSquare = MessageSquare;
  protected readonly Users = Users;
  protected readonly Radio = Radio;
  protected readonly Shield = Shield;
  protected readonly Zap = Zap;
  protected readonly ChevronRight = ChevronRight;
  protected readonly CalendarClock = CalendarClock;
  protected readonly Database = Database;
  protected readonly ClipboardList = ClipboardList;
  protected readonly CreditCard = CreditCard;
  protected readonly Plug = Plug;
  protected readonly Cpu = Cpu;
  protected readonly Server = Server;
  protected readonly Footprints = Footprints;
  protected readonly Ear = Ear;
  protected readonly Mail = Mail;
  protected readonly Bot = Bot;
  protected readonly Globe = Globe;
  protected readonly BellRing = BellRing;

  readonly stats = signal<AdminAlertSummary | null>(null);

  ngOnInit(): void {
    firstValueFrom(this.api.alerts())
      .then((d) => this.stats.set(d.summary))
      .catch(() => { /* silencieux */ });
  }
}

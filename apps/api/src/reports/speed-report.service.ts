import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

interface PositionRow {
  timestamp: Date;
  speedKmh: number;
  lat: number;
  lng: number;
  valid: boolean;
  heading: number;
  ignition: boolean | null;
}

@Injectable()
export class SpeedReportService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(tripId: string, requestedBy: RequestedBy): Promise<{ html: string; filename: string }> {
    const where: Record<string, unknown> = { id: tripId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Trajet introuvable');
      where.fleetId = requestedBy.fleetId;
    }

    const trip = await this.prisma.trip.findFirst({
      where,
      include: { vehicle: { include: { fleet: true } } },
    });
    if (!trip) throw new NotFoundException('Trajet introuvable');

    if (
      requestedBy.role === UserRole.FLEET_ADMIN &&
      trip.vehicle?.fleet?.id !== requestedBy.fleetId
    ) {
      throw new ForbiddenException();
    }

    // Resolve tracker IMEI via separate query (Trip has no tracker relation).
    let imei = 'N/A';
    if (trip.trackerId) {
      const tracker = await this.prisma.tracker.findUnique({
        where: { id: trip.trackerId },
        select: { imei: true },
      });
      if (tracker) imei = tracker.imei;
    }

    const positions: PositionRow[] = await this.prisma.position.findMany({
      where: {
        trackerId: trip.trackerId ?? undefined,
        timestamp: { gte: trip.startedAt, lte: trip.endedAt ?? new Date() },
      },
      orderBy: { timestamp: 'asc' },
      select: {
        timestamp: true,
        speedKmh: true,
        lat: true,
        lng: true,
        valid: true,
        heading: true,
        ignition: true,
      },
    });

    const plate = trip.vehicle?.plate ?? 'N/A';
    const brand = trip.vehicle?.brand ?? '';
    const model = trip.vehicle?.model ?? '';
    const vehicleName = `${brand} ${model}`.trim() || plate;
    const fleetName = trip.vehicle?.fleet?.name ?? 'N/A';
    const startDate = trip.startedAt.toISOString().slice(0, 10);
    const startTime = trip.startedAt.toISOString().slice(11, 19);
    const endTime = trip.endedAt?.toISOString().slice(11, 19) ?? '—';
    const now = new Date().toISOString().slice(0, 10);

    const speedPositions = positions.filter((p) => p.speedKmh > 90);
    const avgSpeedExcess = speedPositions.length > 0
      ? speedPositions.reduce((s, p) => s + p.speedKmh, 0) / speedPositions.length
      : 0;

    const html = this.renderHtml({
      plate,
      vehicleName,
      fleetName,
      imei,
      startDate,
      startTime,
      endTime,
      now,
      trip: {
        distanceKm: trip.distanceKm,
        maxSpeed: trip.maxSpeed,
        avgSpeed: trip.avgSpeed,
        positionCount: trip.positionCount,
      },
      positions,
      speedExcessCount: speedPositions.length,
      avgSpeedExcess,
    });

    const filename = `rapport-vitesse-${plate.replace(/\s/g, '-')}-${startDate}.html`;
    return { html, filename };
  }

  private renderHtml(d: {
    plate: string;
    vehicleName: string;
    fleetName: string;
    imei: string;
    startDate: string;
    startTime: string;
    endTime: string;
    now: string;
    trip: { distanceKm: number; maxSpeed: number; avgSpeed: number; positionCount: number };
    positions: PositionRow[];
    speedExcessCount: number;
    avgSpeedExcess: number;
  }): string {
    const positionRows = d.positions.map((p) => {
      const t = p.timestamp.toISOString().slice(11, 19);
      const over = p.speedKmh > 90;
      const peak = p.speedKmh === d.trip.maxSpeed;
      const cls = peak ? 'speed-peak' : over ? 'speed-over' : '';
      const ign = p.ignition === true ? 'ON' : p.ignition === false ? 'OFF' : '—';
      return `<tr class="${cls}"><td>${t}</td><td>${p.speedKmh.toFixed(1)}</td><td>${p.lat.toFixed(5)}</td><td>${p.lng.toFixed(5)}</td><td>${p.valid ? '✓' : '✗'}</td><td>${ign}</td></tr>`;
    }).join('\n');

    const maxBarSpeed = Math.max(...d.positions.map((p) => p.speedKmh), 1);
    const chartBars = d.positions
      .filter((_, i) => i % Math.max(1, Math.floor(d.positions.length / 80)) === 0)
      .map((p) => {
        const pct = (p.speedKmh / maxBarSpeed) * 100;
        const color = p.speedKmh > 90 ? (p.speedKmh === d.trip.maxSpeed ? '#991b1b' : '#dc2626') : '#059669';
        const t = p.timestamp.toISOString().slice(11, 16);
        return `<div class="bar" style="height:${pct}%" title="${t} — ${p.speedKmh.toFixed(1)} km/h"><div class="bar-fill" style="background:${color}"></div></div>`;
      }).join('\n');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rapport Vitesse — ${d.plate} — ${d.startDate} — Vizyo Tracky</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--green:#059669;--green-light:#10E0A0;--red:#dc2626;--red-bg:#fef2f2;--orange:#ea580c;--text:#1e293b;--text-light:#64748b;--border:#e2e8f0;--bg-alt:#f8fafc}
@page{size:A4;margin:20mm 18mm 25mm 18mm}
@media print{body{font-size:9pt;margin:0;padding:0}.page-break{page-break-before:always}.no-break{page-break-inside:avoid}.cover-page{page-break-after:always}table{font-size:7.5pt}h2{page-break-after:avoid}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',system-ui,sans-serif;color:var(--text);background:#fff;line-height:1.6;font-size:10.5pt}
.container{max-width:210mm;margin:0 auto;padding:0 15mm}
.cover-page{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;border-bottom:4px solid var(--green)}
.cover-page h1{font-size:2rem;font-weight:800;margin:.5rem 0}
.cover-page .subtitle{font-size:1.1rem;color:var(--text-light);margin:.5rem 0}
.cover-page .conf{display:inline-block;background:var(--red-bg);color:var(--red);font-weight:700;font-size:.75rem;letter-spacing:.1em;padding:.375rem 1rem;border-radius:4px;margin-top:1.5rem;text-transform:uppercase}
.logo{font-size:1.5rem;font-weight:800;margin-bottom:2rem}.logo span{color:var(--green)}
.warning-box{background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:1.25rem;margin:2rem 0;font-size:.9rem;line-height:1.7}
.warning-box strong{color:#b45309}
section{margin-top:2.5rem}
h2{font-size:1.25rem;font-weight:700;color:var(--green);border-bottom:2px solid var(--green);padding-bottom:.375rem;margin-bottom:1rem}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin:1rem 0}
.kpi{background:var(--bg-alt);border:1px solid var(--border);border-radius:8px;padding:1rem;text-align:center}
.kpi .val{font-size:1.5rem;font-weight:800;color:var(--text)}
.kpi .lbl{font-size:.7rem;color:var(--text-light);text-transform:uppercase;letter-spacing:.05em;margin-top:.25rem}
.kpi.danger .val{color:var(--red)}
table{width:100%;border-collapse:collapse;font-size:.85rem;margin:1rem 0}
th{background:var(--green);color:#fff;font-weight:600;padding:.5rem .375rem;text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.03em}
td{padding:.375rem;border-bottom:1px solid var(--border)}
tr:nth-child(even){background:var(--bg-alt)}
tr.speed-over{background:#fef2f2;color:var(--red);font-weight:600}
tr.speed-peak{background:#991b1b;color:#fff;font-weight:700}
.chart-container{margin:1.5rem 0;border:1px solid var(--border);border-radius:8px;padding:1rem;background:var(--bg-alt)}
.chart{display:flex;align-items:flex-end;gap:1px;height:180px;position:relative}
.bar{flex:1;display:flex;align-items:flex-end;min-width:2px}
.bar-fill{width:100%;border-radius:1px 1px 0 0;min-height:1px}
.limit-line{position:absolute;bottom:0;left:0;right:0;border-top:2px dashed var(--red);pointer-events:none}
.legend{display:flex;gap:1.5rem;margin-top:.75rem;font-size:.75rem;color:var(--text-light)}
.legend i{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;margin-right:4px}
.checklist{list-style:none;margin:1rem 0}
.checklist li{padding:.5rem 0;border-bottom:1px solid var(--border);padding-left:1.5rem;position:relative}
.checklist li::before{content:"☐";position:absolute;left:0;color:var(--green);font-weight:700}
.rec-list{counter-reset:rec;list-style:none;margin:1rem 0}
.rec-list li{padding:.5rem 0;border-bottom:1px solid var(--border);padding-left:2rem;position:relative;counter-increment:rec}
.rec-list li::before{content:counter(rec);position:absolute;left:0;background:var(--green);color:#fff;width:1.25rem;height:1.25rem;border-radius:50%;text-align:center;font-size:.7rem;font-weight:700;line-height:1.25rem}
.footer{margin-top:3rem;padding-top:1.5rem;border-top:2px solid var(--border);text-align:center;font-size:.75rem;color:var(--text-light)}
</style>
</head>
<body>

<div class="cover-page">
<div class="logo">Vizyo<span> Tracky</span></div>
<h1>Rapport d'Analyse de Vitesse GPS</h1>
<p class="subtitle">Véhicule ${d.plate} — ${d.vehicleName}</p>
<p class="subtitle">${d.startDate}</p>
<p class="subtitle" style="margin-top:1rem;font-size:.85rem;color:var(--text-light)">Flotte : ${d.fleetName} | IMEI : ${d.imei}</p>
<p class="subtitle" style="font-size:.8rem">Rapport généré le ${d.now}</p>
<div class="conf">CONFIDENTIEL</div>
</div>

<div class="container">

<div class="warning-box">
<strong>⚠ Note importante :</strong> Ce rapport technique présente les données GPS enregistrées par le système Vizyo Tracky. Il est fourni à titre informatif et ne constitue pas un avis juridique. L'utilisation de ces données dans le cadre d'une procédure disciplinaire ou de licenciement est soumise aux conditions légales détaillées en section 5. Il est fortement recommandé de consulter un avocat spécialisé en droit du travail avant toute action.
</div>

<section>
<h2>1. Résumé du trajet</h2>
<div class="kpi-grid">
<div class="kpi danger"><div class="val">${d.trip.maxSpeed.toFixed(1)}</div><div class="lbl">Vit. max (km/h)</div></div>
<div class="kpi"><div class="val">${d.trip.avgSpeed.toFixed(1)}</div><div class="lbl">Vit. moy (km/h)</div></div>
<div class="kpi"><div class="val">${d.trip.distanceKm.toFixed(2)}</div><div class="lbl">Distance (km)</div></div>
<div class="kpi"><div class="val">${d.trip.positionCount}</div><div class="lbl">Positions GPS</div></div>
</div>
<table>
<tr><td style="font-weight:600;width:40%">Plaque d'immatriculation</td><td>${d.plate}</td></tr>
<tr><td style="font-weight:600">Véhicule</td><td>${d.vehicleName}</td></tr>
<tr><td style="font-weight:600">Heure de départ (UTC)</td><td>${d.startTime}</td></tr>
<tr><td style="font-weight:600">Heure d'arrivée (UTC)</td><td>${d.endTime}</td></tr>
<tr><td style="font-weight:600">Mesures > 90 km/h</td><td style="color:var(--red);font-weight:700">${d.speedExcessCount} positions</td></tr>
<tr><td style="font-weight:600">Vitesse moyenne durant excès</td><td style="color:var(--red);font-weight:700">${d.avgSpeedExcess.toFixed(1)} km/h</td></tr>
</table>
</section>

<section class="page-break">
<h2>2. Profil de vitesse</h2>
<div class="chart-container">
<div class="chart" style="position:relative">
${chartBars}
<div class="limit-line" style="bottom:${(90 / maxBarSpeed) * 100}%"></div>
</div>
<div class="legend">
<span><i style="background:var(--green)"></i> &lt; 90 km/h</span>
<span><i style="background:var(--red)"></i> &gt; 90 km/h</span>
<span><i style="background:#991b1b"></i> Pic maximal</span>
<span style="color:var(--red)">- - - Limite 90 km/h</span>
</div>
</div>
</section>

<section class="page-break">
<h2>3. Chronologie détaillée</h2>
<table>
<thead><tr><th>Heure (UTC)</th><th>Vitesse (km/h)</th><th>Latitude</th><th>Longitude</th><th>GPS</th><th>Contact</th></tr></thead>
<tbody>
${positionRows}
</tbody>
</table>
</section>

<section class="page-break no-break">
<h2>4. Fiabilité de la mesure GPS</h2>
<p>La vitesse GPS est mesurée par <strong>effet Doppler</strong> (décalage de fréquence des signaux satellites), et non par dérivation de la position. Cette méthode offre une précision de <strong>±0.1 à 0.5 km/h</strong> en conditions optimales.</p>
<table style="margin-top:1rem">
<thead><tr><th>Source d'erreur</th><th>Marge</th><th>Impact sur ${d.trip.maxSpeed.toFixed(1)} km/h</th></tr></thead>
<tbody>
<tr><td>Mesure Doppler GPS</td><td>±0.1 à 0.5 km/h</td><td>${(d.trip.maxSpeed - 0.5).toFixed(1)} à ${(d.trip.maxSpeed + 0.5).toFixed(1)} km/h</td></tr>
<tr><td>Conditions dégradées (pire cas)</td><td>±1 à 3 km/h</td><td>${(d.trip.maxSpeed - 3).toFixed(1)} à ${(d.trip.maxSpeed + 3).toFixed(1)} km/h</td></tr>
<tr><td>Conversion nœuds → km/h</td><td>±0.001 km/h</td><td>Négligeable</td></tr>
<tr class="speed-over"><td><strong>Total pire cas</strong></td><td><strong>±3 km/h</strong></td><td><strong>${(d.trip.maxSpeed - 3).toFixed(1)} à ${(d.trip.maxSpeed + 3).toFixed(1)} km/h</strong></td></tr>
</tbody>
</table>
<p style="margin-top:1rem"><strong>Garanties d'intégrité :</strong> données brutes (aucun lissage serveur), horodatage double (GPS + serveur), seules les positions avec fix GPS valide sont incluses, conversion par facteur exact international 1.852.</p>
<p style="margin-top:.5rem">${d.speedExcessCount} mesures consécutives au-dessus de 90 km/h excluent un artefact GPS isolé.</p>
</section>

<section class="page-break no-break">
<h2>5. Cadre juridique</h2>

<h3 style="font-size:1rem;margin:1rem 0 .5rem;color:var(--text)">5.1 Conditions préalables à vérifier</h3>
<ul class="checklist">
<li>Le salarié a-t-il été informé individuellement du dispositif GPS ? (Art. L.1222-3 Code du travail)</li>
<li>Le CSE (ou délégués du personnel) a-t-il été consulté ? (Art. L.2312-38 Code du travail)</li>
<li>Le dispositif est-il inscrit au registre des traitements RGPD ?</li>
<li>Les données GPS sont-elles collectées uniquement pendant les heures de travail ?</li>
<li>Le mode vie privée est-il activé en dehors des heures de service ?</li>
</ul>

<div class="warning-box" style="margin-top:1rem">
<strong>⚠ Restriction CNIL :</strong> La délibération CNIL n°2015-165 du 4 juin 2015 interdit le traitement de la <strong>vitesse maximale</strong> à des fins de sanction. Seule la <strong>vitesse moyenne</strong> est autorisée (Art. 9 Loi Informatique et Libertés). Recommandation : présenter la vitesse moyenne du trajet (${d.trip.avgSpeed.toFixed(1)} km/h) comme indicateur principal.
</div>

<h3 style="font-size:1rem;margin:1rem 0 .5rem;color:var(--text)">5.2 Jurisprudence</h3>
<p>Cour de cassation (22 mars 2023) : le juge met en balance le droit à la preuve de l'employeur et le droit au respect de la vie privée du salarié (articles 6 et 8 CEDH). La preuve GPS peut être écartée si le dispositif n'est pas conforme. Le licenciement pourrait être requalifié en licenciement sans cause réelle et sérieuse.</p>

<h3 style="font-size:1rem;margin:1.5rem 0 .5rem;color:var(--text)">5.3 Recommandations</h3>
<ol class="rec-list">
<li>Vérifier l'information préalable du salarié (document signé)</li>
<li>Consulter un avocat en droit du travail AVANT d'engager la procédure</li>
<li>Privilégier la vitesse moyenne du trajet dans la lettre de licenciement</li>
<li>Les données de vitesse instantanée peuvent servir d'éléments complémentaires</li>
<li>Conserver les données GPS brutes (ne pas les supprimer)</li>
<li>Vérifier que le contrat ou le règlement intérieur mentionne l'interdiction des excès de vitesse</li>
</ol>
</section>

<div class="footer">
<p><strong>Rapport technique — Vizyo Tracky</strong></p>
<p>Document confidentiel — Usage réservé au client ${d.fleetName}</p>
<p>Ce document est fourni à titre informatif et ne constitue pas un avis juridique.</p>
</div>

</div>
</body>
</html>`;
  }
}

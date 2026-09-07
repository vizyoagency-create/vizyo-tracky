import { Prisma } from '@prisma/client';
import { ALLOWLIST } from './allowlist';
import {
  Assainisseur,
  Correspondances,
  SYSTEM_USER_ID,
  abonnementDemo,
  planningRapportDemo,
  transformerAlerte,
  transformerAnalyse,
  transformerBoitier,
  transformerConducteur,
  transformerFlotte,
  transformerGeofence,
  transformerLieu,
  transformerPlanning,
  transformerPosition,
  transformerProfilSurveillance,
  transformerTrajet,
  transformerVehicule,
  type Contexte,
} from './transformations';

const SEL = 'un-sel-de-test-suffisamment-long';

/** Une ligne source « pleine » : chaque colonne du modèle reçoit une valeur non nulle plausible. */
function ligneSource(modele: string, surcharges: Record<string, unknown> = {}): Record<string, unknown> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === modele)!;
  const ligne: Record<string, unknown> = {};
  for (const f of m.fields) {
    if (f.kind === 'object') continue;
    if (f.isList) {
      ligne[f.name] = f.type === 'Int' ? [30, 30] : ['a'];
      continue;
    }
    switch (f.type) {
      case 'String':
        ligne[f.name] = `${f.name}-source`;
        break;
      case 'Int':
        ligne[f.name] = 7;
        break;
      case 'Float':
        ligne[f.name] = 1.5;
        break;
      case 'Boolean':
        ligne[f.name] = true;
        break;
      case 'DateTime':
        ligne[f.name] = new Date('2026-08-01T10:00:00Z');
        break;
      case 'Json':
        ligne[f.name] = { texte: 'FV-941-LZ', liste: ['x'] };
        break;
      default: {
        // Enum : la première valeur.
        const e = Prisma.dmmf.datamodel.enums.find((x) => x.name === f.type);
        ligne[f.name] = e?.values[0]?.name ?? 'X';
      }
    }
  }
  return { ...ligne, ...surcharges };
}

function contexte(): Contexte {
  const assainisseur = new Assainisseur();
  assainisseur.ajouter('FV-941-LZ', 'AB-123-CD');
  assainisseur.ajouter('Transports Réels SARL', 'Transports Démo');
  assainisseur.ajouter('Karim Benali', 'Camille Martin');
  return {
    sel: SEL,
    nomFlotte: 'Transports Démo',
    idFlotteDemo: 'f1e2d3c4-0000-5000-8000-000000000001',
    maintenant: new Date('2026-09-07T04:00:00Z'),
    ids: new Correspondances(SEL),
    assainisseur,
  };
}

/** Les clés produites doivent être EXACTEMENT celles que l'allowlist annonce — ni plus, ni moins. */
function attendreChampsDe(modele: string, sortie: object): void {
  const regle = ALLOWLIST[modele]!;
  const attendus = [...regle.copies, ...regle.transformes, ...regle.imposes].sort();
  expect(Object.keys(sortie).sort()).toEqual(attendus);
}

describe("transformations de l'import de démonstration", () => {
  it('Assainisseur : remplace plaques (avec ou sans tirets), noms et société, sans toucher au reste', () => {
    const a = contexte().assainisseur;
    expect(a.texte('SOS — véhicule FV-941-LZ (FV941LZ) conduit par Karim Benali, Transports Réels SARL')).toBe(
      'SOS — véhicule AB-123-CD (AB-123-CD) conduit par Camille Martin, Transports Démo',
    );
    expect(a.texte('Vitesse 41 km/h sur la D941')).toBe('Vitesse 41 km/h sur la D941');
    expect(a.json({ t: 'fv-941-lz', n: 3, l: ['Karim Benali'] })).toEqual({ t: 'AB-123-CD', n: 3, l: ['Camille Martin'] });
  });

  it('Correspondances : identifiants stables, `siImporte` rend null pour une ligne non importée', () => {
    const ids = new Correspondances(SEL);
    const v = ids.marquer('Vehicle', 'v-1');
    expect(ids.id('Vehicle', 'v-1')).toBe(v);
    expect(ids.siImporte('Vehicle', 'v-1')).toBe(v);
    expect(ids.siImporte('Vehicle', 'v-2')).toBeNull();
    expect(ids.siImporte('Vehicle', null)).toBeNull();
    expect(ids.marquer('FuelStation', 's-1', 's-1')).toBe('s-1'); // identifiant conservé
    expect(ids.idsImportes('Vehicle')).toEqual([v]);
  });

  it('Fleet : identité neuve, réglages copiés, facturation et auteur effacés, IA active', () => {
    const ctx = contexte();
    const sortie = transformerFlotte(ligneSource('Fleet') as never, ctx);
    attendreChampsDe('Fleet', sortie);
    expect(sortie).toMatchObject({
      id: ctx.idFlotteDemo,
      name: 'Transports Démo',
      clientId: null,
      stripeCustomerId: null,
      speedAlertUpdatedById: null,
      weeklyReportEmail: null,
      aiEnabled: true,
      fuelPriceEurL: 1.5,
    });
  });

  it('FleetSubscription / FleetReportSchedule : imposés — SIGNATURE offert, rapport hebdo coupé', () => {
    const ctx = contexte();
    const abo = abonnementDemo(ctx);
    attendreChampsDe('FleetSubscription', abo);
    expect(abo).toMatchObject({ plan: 'SIGNATURE', isComp: true, optLive: true, optMicro: true, optAgent: true });
    const rapport = planningRapportDemo(ctx);
    attendreChampsDe('FleetReportSchedule', rapport);
    expect(rapport.enabled).toBe(false);
  });

  it('Vehicle : plaque régénérée, conducteur remappé, auteurs et notes effacés', () => {
    const ctx = contexte();
    ctx.ids.marquer('Driver', 'd-1');
    const src = ligneSource('Vehicle', { id: 'v-1', currentDriverId: 'd-1' });
    const sortie = transformerVehicule(src as never, ctx, 'AB-123-CD');
    attendreChampsDe('Vehicle', sortie);
    expect(sortie).toMatchObject({
      id: ctx.ids.id('Vehicle', 'v-1'),
      fleetId: ctx.idFlotteDemo,
      plate: 'AB-123-CD',
      currentDriverId: ctx.ids.id('Driver', 'd-1'),
      outOfServiceById: null,
      outOfServiceNote: null,
      privacyModeById: null,
      privacyModeNote: null,
      brand: 'brand-source',
    });
  });

  it('Tracker : IMEI régénéré, SIM effacée, overrides admin effacés, liveness conservée', () => {
    const ctx = contexte();
    ctx.ids.marquer('Vehicle', 'v-1');
    const sortie = transformerBoitier(ligneSource('Tracker', { id: 't-1', vehicleId: 'v-1' }) as never, ctx, '353000000000015');
    attendreChampsDe('Tracker', sortie);
    expect(sortie).toMatchObject({
      imei: '353000000000015',
      simPhoneNumber: null,
      verboseUntil: null,
      fixModeOverrideUntil: null,
      vehicleId: ctx.ids.id('Vehicle', 'v-1'),
      lastLat: 1.5,
    });
  });

  it('Driver : identité de liste, coordonnées, permis, notes et compte effacés', () => {
    const ctx = contexte();
    const sortie = transformerConducteur(ligneSource('Driver', { id: 'd-1' }) as never, ctx, { firstName: 'Camille', lastName: 'Martin' });
    attendreChampsDe('Driver', sortie);
    expect(sortie).toMatchObject({ firstName: 'Camille', lastName: 'Martin', phone: null, email: null, licenseNumber: null, notes: null, userId: null });
  });

  it('Geofence / FleetPlace : géométrie copiée, nom remplacé, note et auteur effacés', () => {
    const ctx = contexte();
    const zone = transformerGeofence(ligneSource('Geofence', { id: 'g-1' }) as never, ctx, 3);
    attendreChampsDe('Geofence', zone);
    expect(zone.name).toBe('Zone 3');
    const lieu = transformerLieu(ligneSource('FleetPlace', { id: 'p-1', kind: 'DEPOT' }) as never, ctx, 2, null);
    attendreChampsDe('FleetPlace', lieu);
    expect(lieu).toMatchObject({ name: 'Dépôt 2', note: null, createdById: null, stationId: null });
  });

  it("VehicleSchedule / SurveillanceProfile : réglages copiés, état d'exécution remis à zéro", () => {
    const ctx = contexte();
    const planning = transformerPlanning(ligneSource('VehicleSchedule', { id: 's-1', vehicleId: 'v-1' }) as never, ctx);
    attendreChampsDe('VehicleSchedule', planning);
    expect(planning).toMatchObject({ lastEvaluatedAt: null, lastEvaluatedState: null, overrideUntil: null, enabled: true });
    const profil = transformerProfilSurveillance(ligneSource('SurveillanceProfile', { id: 'sp-1', vehicleId: 'v-1' }) as never, ctx);
    attendreChampsDe('SurveillanceProfile', profil);
    expect(profil).toMatchObject({ additionalNotifyUserIds: [], currentlyArmed: false, createdBy: SYSTEM_USER_ID });
  });

  it('Trip / TripAnalysis : mission et notes effacées, textes assainis, conducteur hors fenêtre → null', () => {
    const ctx = contexte();
    ctx.ids.marquer('Tracker', 't-1');
    const trajet = transformerTrajet(ligneSource('Trip', { id: 'tr-1', vehicleId: 'v-1', trackerId: 't-1', driverId: 'd-absent' }) as never, ctx);
    attendreChampsDe('Trip', trajet);
    expect(trajet).toMatchObject({ missionId: null, notes: null, notesUpdatedAt: null, notesUpdatedById: null, driverId: null, trackerId: ctx.ids.id('Tracker', 't-1') });

    const analyse = transformerAnalyse(
      ligneSource('TripAnalysis', { id: 'a-1', tripId: 'tr-1', vehicleId: 'v-1', narrative: 'Le véhicule FV-941-LZ a roulé 12 km.' }) as never,
      ctx,
    );
    attendreChampsDe('TripAnalysis', analyse);
    expect(analyse.narrative).toBe('Le véhicule AB-123-CD a roulé 12 km.');
    expect(analyse.detail).toEqual({ texte: 'AB-123-CD', liste: ['x'] });
  });

  it('Alert : titre, message et charge utile assainis, acquitteur effacé, trajet hors fenêtre → null', () => {
    const ctx = contexte();
    ctx.ids.marquer('Vehicle', 'v-1');
    const sortie = transformerAlerte(
      ligneSource('Alert', { id: 'al-1', vehicleId: 'v-1', trackerId: 't-absent', tripId: 'tr-absent', title: 'SOS — FV-941-LZ' }) as never,
      ctx,
    );
    attendreChampsDe('Alert', sortie);
    expect(sortie).toMatchObject({ title: 'SOS — AB-123-CD', acknowledgedBy: null, trackerId: null, tripId: null, vehicleId: ctx.ids.id('Vehicle', 'v-1') });
  });

  it('Position : identifiant neuf, boîtier remappé, mesures copiées', () => {
    const sortie = transformerPosition(ligneSource('Position', { id: 'p-1' }) as never, 'tracker-demo');
    attendreChampsDe('Position', sortie);
    expect(sortie.id).not.toBe('p-1');
    expect(sortie.trackerId).toBe('tracker-demo');
  });
});

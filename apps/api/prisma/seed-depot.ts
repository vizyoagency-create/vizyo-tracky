/**
 * Espace dépôt (2026-08) — jeu d'essai local pour le bloc A.
 *
 * Recrée le CAS DE RÉFÉRENCE du livrable (A0 § Le besoin) : un transporteur, sept
 * camions, et un dépôt qui ne doit en voir que quelques-uns — jamais les autres.
 *
 * C'est ce scénario précis qui permet de vérifier l'isolation autrement que par des
 * mocks : avec sept camions en base, un dépôt qui en verrait huit, ou zéro, se
 * remarque immédiatement.
 *
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed-depot.ts
 *
 * Idempotent : relançable sans dupliquer. Ne touche QUE la flotte de démonstration.
 */
import { MissionStatus, Prisma, PrismaClient, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import { getDefaultPermissions } from '@vizyo/tracky-shared';

const prisma = new PrismaClient();

const PLAQUES = ['FR-482-BX', 'FR-119-TD', 'FR-207-QM', 'FR-556-KZ', 'FR-731-VL', 'FR-864-RN', 'FR-903-HC'];

async function main(): Promise<void> {
  const fleet = await prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!fleet) throw new Error('Aucune flotte — lance d\'abord `prisma/seed.ts`.');
  console.log(`Flotte : ${fleet.name} (${fleet.id})`);

  // ── Les 7 camions du cas de référence ─────────────────────────────────────
  const vehicules = [];
  for (const [i, plate] of PLAQUES.entries()) {
    const v = await prisma.vehicle.upsert({
      where: { fleetId_plate: { fleetId: fleet.id, plate } },
      update: {},
      create: {
        fleetId: fleet.id,
        plate,
        brand: i % 2 === 0 ? 'Renault' : 'Iveco',
        model: i % 2 === 0 ? 'D 12 t' : 'Daily',
        type: 'TRUCK',
      },
    });
    // Un boîtier avec une position fraîche : sans lui, aucune mission ne démarre.
    await prisma.tracker.upsert({
      where: { imei: `86000000000${String(i).padStart(4, '0')}` },
      update: { lastPositionAt: new Date(), lastLat: 43.6 + i * 0.01, lastLng: 1.44 + i * 0.01 },
      create: {
        imei: `86000000000${String(i).padStart(4, '0')}`,
        vehicleId: v.id,
        lastPositionAt: new Date(),
        lastLat: 43.6 + i * 0.01,
        lastLng: 1.44 + i * 0.01,
        lastSpeedKmh: 0,
      },
    });
    vehicules.push(v);
  }
  console.log(`${vehicules.length} camions prêts (avec boîtier et position fraîche)`);

  // ── Deux comptes dépôt : le nôtre, et un CONCURRENT ───────────────────────
  // Le second est essentiel : sans lui, on ne peut pas vérifier qu'un dépôt ne voit
  // pas les missions d'un autre — le test le plus important d'A1 § 8 (critère 5).
  // ⚠️ Les permissions sont ECRITES, pas laissées à null.
  //
  // Le backend retombe sur les défauts du rôle quand `User.permissions` est null ; le
  // FRONT, lui, lit `user.permissions?.[perm] === true` et refuse tout. Un compte
  // dépôt à `permissions: null` voit donc une API qui répond 200 et une interface qui
  // n'affiche rien — la panne la plus coûteuse à diagnostiquer, parce que les deux
  // côtés « fonctionnent ».
  const permissionsDepot = getDefaultPermissions('DEPOT') as unknown as Prisma.InputJsonValue;

  const depotA = await prisma.user.upsert({
    where: { email: 'depot.fenouillet@exemple.fr' },
    update: { role: UserRole.DEPOT, fleetId: fleet.id, isActive: true, permissions: permissionsDepot },
    create: {
      authUserId: 'seed-depot-a',
      email: 'depot.fenouillet@exemple.fr',
      firstName: 'Dépôt',
      lastName: 'Fenouillet',
      role: UserRole.DEPOT,
      fleetId: fleet.id,
      permissions: permissionsDepot,
    },
  });
  const depotB = await prisma.user.upsert({
    where: { email: 'depot.muret@exemple.fr' },
    update: { role: UserRole.DEPOT, fleetId: fleet.id, isActive: true, permissions: permissionsDepot },
    create: {
      authUserId: 'seed-depot-b',
      email: 'depot.muret@exemple.fr',
      firstName: 'Dépôt',
      lastName: 'Muret',
      role: UserRole.DEPOT,
      fleetId: fleet.id,
      permissions: permissionsDepot,
    },
  });
  // Un TROISIÈME dépôt, sans aucune mission. C'est le cas de recette n° 1 : le tout
  // premier écran d'un dépôt qu'on vient d'inviter. Sans ce compte, on ne peut pas
  // vérifier l'état vide — « le plus important à soigner » (A3 § 2) — autrement qu'en
  // cassant temporairement les données des deux autres.
  const depotC = await prisma.user.upsert({
    where: { email: 'depot.launaguet@exemple.fr' },
    update: { role: UserRole.DEPOT, fleetId: fleet.id, isActive: true, permissions: permissionsDepot },
    create: {
      authUserId: 'seed-depot-c',
      email: 'depot.launaguet@exemple.fr',
      firstName: 'Dépôt',
      lastName: 'Launaguet',
      role: UserRole.DEPOT,
      fleetId: fleet.id,
      permissions: permissionsDepot,
    },
  });
  console.log(`3 dépôts : ${depotA.email}, ${depotB.email} et ${depotC.email} (aucune mission)`);

  // Invariant A1 § 7, vérifié plutôt que supposé : un DEPOT n'a JAMAIS de scope véhicule.
  const scopes = await prisma.userVehicleAccess.count({
    where: { userId: { in: [depotA.id, depotB.id, depotC.id] } },
  });
  if (scopes > 0) throw new Error(`INVARIANT VIOLÉ : ${scopes} ligne(s) UserVehicleAccess sur un dépôt`);

  // ── Les missions, calées pour couvrir les 4 cas de la fenêtre ─────────────
  const maintenant = Date.now();
  const h = (decalage: number) => new Date(maintenant + decalage * 3_600_000);

  const scenarios = [
    // Dépôt A : en cours → sa position DOIT être servie.
    { veh: 0, depot: depotA.id, debut: h(-1), fin: h(2), statut: MissionStatus.IN_PROGRESS, ref: 'M-0001', de: 'Fenouillet', vers: 'Muret' },
    // Dépôt A : planifiée → visible dans la liste, position REFUSÉE (A1 § 8, critère 2).
    { veh: 1, depot: depotA.id, debut: h(4), fin: h(7), statut: MissionStatus.PLANNED, ref: 'M-0002', de: 'Fenouillet', vers: 'Colomiers' },
    // Dépôt A : terminée → dans l'historique, position REFUSÉE (critère 4).
    { veh: 2, depot: depotA.id, debut: h(-8), fin: h(-5), statut: MissionStatus.DONE, ref: 'M-0003', de: 'Fenouillet', vers: 'Blagnac' },
    // Dépôt A : en retard → position TOUJOURS servie (l'invariant contre-intuitif).
    { veh: 3, depot: depotA.id, debut: h(-4), fin: h(-1), statut: MissionStatus.LATE, ref: 'M-0004', de: 'Fenouillet', vers: 'Tournefeuille' },
    // Dépôt B : en cours → INVISIBLE du dépôt A (critère 5).
    { veh: 4, depot: depotB.id, debut: h(-1), fin: h(2), statut: MissionStatus.IN_PROGRESS, ref: 'M-0005', de: 'Muret', vers: 'Portet' },
    // Mission interne, sans dépôt → invisible de TOUS les dépôts.
    { veh: 5, depot: null, debut: h(-1), fin: h(2), statut: MissionStatus.IN_PROGRESS, ref: 'M-0006', de: 'Dépôt central', vers: 'Atelier' },
    // Le 7e camion (index 6) n'a AUCUNE mission : c'est le témoin. Aucun dépôt ne
    // doit jamais le voir, sous aucun angle.
  ];

  for (const s of scenarios) {
    const v = vehicules[s.veh];
    const mission = await prisma.mission.upsert({
      where: { fleetId_ref: { fleetId: fleet.id, ref: s.ref } },
      update: {
        status: s.statut,
        startAt: s.debut,
        endAt: s.fin,
        depotUserId: s.depot,
        actualStartAt: s.statut === MissionStatus.PLANNED ? null : s.debut,
        actualEndAt: s.statut === MissionStatus.DONE ? s.fin : null,
      },
      create: {
        ref: s.ref,
        fleetId: fleet.id,
        originLabel: s.de,
        destLabel: s.vers,
        startAt: s.debut,
        endAt: s.fin,
        vehicleId: v.id,
        depotUserId: s.depot,
        status: s.statut,
        // Le départ RÉEL : c'est lui qui fait basculer la première étape du déroulé
        // horodaté de « prévu 06:23 » (tireté) à « 06:23 » (constaté). Sans lui, une
        // mission en cours affiche un déroulé entièrement au futur — ce qui se lit
        // comme un suivi qui n'a pas démarré.
        ...(s.statut !== MissionStatus.PLANNED ? { actualStartAt: s.debut } : {}),
        ...(s.statut === MissionStatus.DONE ? { actualEndAt: s.fin } : {}),
      },
    });

    // L'événement d'agenda — c'est LUI qui rend le véhicule indisponible.
    const dejaPose = await prisma.vehicleEvent.findFirst({
      where: { type: VehicleEventType.MISSION, metadata: { path: ['missionId'], equals: mission.id } },
      select: { id: true },
    });
    const statutEvenement =
      s.statut === MissionStatus.DONE
        ? VehicleEventStatus.DONE
        : s.statut === MissionStatus.PLANNED
          ? VehicleEventStatus.PLANNED
          : VehicleEventStatus.IN_PROGRESS;
    if (dejaPose) {
      // ⚠️ L'ÉVÉNEMENT SUIT LA MISSION, y compris quand on rejoue le seed.
      //
      // Les créneaux sont relatifs à l'heure du lancement : sans cette mise à jour,
      // relancer le seed décale les missions mais laisse les événements d'agenda sur
      // l'ancienne fenêtre. Le véhicule cesse alors d'apparaître immobilisé — et la
      // vérification d'indisponibilité échoue sur un jeu d'essai qu'on croit sain.
      await prisma.vehicleEvent.update({
        where: { id: dejaPose.id },
        data: {
          status: statutEvenement,
          startAt: s.debut,
          endAt: s.fin,
          title: `Mission ${s.ref} · ${s.de} → ${s.vers}`,
        },
      });
    } else {
      await prisma.vehicleEvent.create({
        data: {
          fleetId: fleet.id,
          vehicleId: v.id,
          type: VehicleEventType.MISSION,
          status: statutEvenement,
          title: `Mission ${s.ref} · ${s.de} → ${s.vers}`,
          startAt: s.debut,
          endAt: s.fin,
          allDay: false,
          blocksVehicle: true,
          createdBy: depotA.id,
          source: 'SYSTEM',
          metadata: { missionId: mission.id, missionRef: s.ref },
        },
      });
    }
    console.log(`  ${s.ref} · ${v.plate} · ${s.statut} · dépôt ${s.depot ? (s.depot === depotA.id ? 'A' : 'B') : 'aucun (interne)'}`);
  }

  // ── Lot A3 : de quoi rendre l'HISTORIQUE et le TRAJET observables ─────────
  //
  // Les 6 missions ci-dessus suffisaient à prouver l'isolation (A1) : elles
  // n'exercent ni les KPI, ni le déroulé horodaté, ni le bloc conducteur. Un
  // historique à une seule ligne affiche le cas dégradé de tous ses écrans — on ne
  // saurait pas si le cas nominal fonctionne.
  await semerHistorique(fleet.id, vehicules, depotA.id);

  console.log('\n── Ce qu\'on doit observer ──────────────────────────────────');
  console.log(`  Dépôt A (${depotA.email}) : 4 missions, 2 positions servies (M-0001 en cours, M-0004 en retard)`);
  console.log(`  Dépôt B (${depotB.email}) : 1 mission`);
  console.log(`  Dépôt C (${depotC.email}) : AUCUNE mission — l'état vide du critère 1`);
  console.log(`  ${PLAQUES[6]} : AUCUNE mission — invisible de tout dépôt, c'est le témoin`);
  console.log(`  Véhicules indisponibles attendus dans l'onglet Missions : 5 (M-0003 est terminée)`);
  console.log(`  Historique du dépôt A : 7 missions terminées, dont 2 en retard → taux affiché`);
  console.log(`  M-0011 : arrêts intermédiaires posés → « 14 min sur place » dans le déroulé`);
}

/**
 * Lot A3 — un conducteur, six missions terminées de plus, et leurs trajets.
 *
 * Pourquoi ces volumes précis :
 *   - **7 missions terminées** au total : au-dessus du seuil de 5 de
 *     `DEPOT_KPI_MIN_SAMPLE`, donc le « % à l'heure » S'AFFICHE. Avec une seule, on
 *     ne verrait jamais que le tiret expliqué — le cas dégradé, pas le nominal.
 *   - **2 en retard** : le KPI « retard moyen » a des cas à moyenner, et le taux ne
 *     vaut ni 0 % ni 100 % (deux valeurs qu'on lit comme un bug d'affichage).
 *   - **des positions stationnaires** sur une mission : le détecteur d'arrêts a de
 *     quoi trouver un arrêt intermédiaire, et le déroulé horodaté peut montrer le
 *     temps passé sur place — l'information qui justifie la modale (A3 § 5).
 */
async function semerHistorique(
  fleetId: string,
  vehicules: Array<{ id: string; plate: string }>,
  depotAId: string,
): Promise<void> {
  // Un conducteur, avec un téléphone : c'est lui qui exerce le masquage côté API
  // (« 06 12 •• •• 47 ») et l'endpoint d'appel journalisé.
  const conducteur = await prisma.driver.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000d1' },
    update: { phone: '+33612345647' },
    create: {
      id: '00000000-0000-0000-0000-0000000000d1',
      fleetId,
      firstName: 'Karim',
      lastName: 'Benali',
      phone: '+33612345647',
    },
  });

  // Le conducteur des missions en cours : sans lui, le bloc conducteur reste vide et
  // le bouton d'appel n'a rien à révéler.
  await prisma.mission.updateMany({
    where: { fleetId, ref: { in: ['M-0001', 'M-0004'] } },
    data: { driverId: conducteur.id },
  });

  const jour = 24 * 3_600_000;
  const passe = (jours: number, heure: number) => {
    const d = new Date(Date.now() - jours * jour);
    d.setHours(heure, 0, 0, 0);
    return d;
  };

  const terminees = [
    { ref: 'M-0007', veh: 0, de: 'Fenouillet', vers: 'Muret', jours: 2, retardMin: 0 },
    { ref: 'M-0008', veh: 1, de: 'Fenouillet', vers: 'Colomiers', jours: 3, retardMin: 0 },
    { ref: 'M-0009', veh: 2, de: 'Fenouillet', vers: 'Blagnac', jours: 5, retardMin: 38 },
    { ref: 'M-0010', veh: 3, de: 'Fenouillet', vers: 'Muret', jours: 8, retardMin: 0 },
    { ref: 'M-0011', veh: 0, de: 'Fenouillet', vers: 'Tournefeuille', jours: 11, retardMin: 12 },
    { ref: 'M-0012', veh: 1, de: 'Fenouillet', vers: 'Portet', jours: 14, retardMin: 0 },
  ];

  for (const t of terminees) {
    const v = vehicules[t.veh]!;
    const debut = passe(t.jours, 8);
    const fin = passe(t.jours, 12);
    const finReelle = new Date(fin.getTime() + t.retardMin * 60_000);

    const mission = await prisma.mission.upsert({
      where: { fleetId_ref: { fleetId, ref: t.ref } },
      update: { status: MissionStatus.DONE, actualStartAt: debut, actualEndAt: finReelle },
      create: {
        ref: t.ref,
        fleetId,
        originLabel: t.de,
        destLabel: t.vers,
        startAt: debut,
        endAt: fin,
        actualStartAt: debut,
        actualEndAt: finReelle,
        vehicleId: v.id,
        driverId: conducteur.id,
        depotUserId: depotAId,
        status: MissionStatus.DONE,
      },
    });

    const tracker = await prisma.tracker.findFirst({ where: { vehicleId: v.id }, select: { id: true } });
    const dejaLa = await prisma.trip.findFirst({ where: { missionId: mission.id }, select: { id: true } });
    if (!dejaLa) {
      await prisma.trip.create({
        data: {
          vehicleId: v.id,
          trackerId: tracker?.id ?? null,
          fleetId,
          missionId: mission.id,
          startedAt: debut,
          endedAt: finReelle,
          durationSeconds: Math.round((finReelle.getTime() - debut.getTime()) / 1000),
          distanceKm: 42 + t.jours,
          distanceMeters: (42 + t.jours) * 1000,
          driverId: conducteur.id,
          driverSource: 'AUTO',
          segmentationSource: 'seed',
          // Le TRACÉ. En production il vient de la segmentation ; sans lui la
          // mini-carte de la modale affiche « Aucune position connue » et on ne
          // vérifie jamais le rendu qu'on livre.
          polyline: encoderPolyligne(traceDe(t.veh)),
        },
      });
    }

    // Les positions de M-0011 seulement : un arrêt intermédiaire de 14 minutes, puis
    // le stationnement d'arrivée. C'est ce qui fait apparaître « 14 min sur place »
    // dans le déroulé — sans positions, le détecteur ne trouve rien et le déroulé se
    // réduit à deux lignes (départ, arrivée), ce qui ne prouve rien.
    if (t.ref === 'M-0011' && tracker) {
      const dejaPosees = await prisma.position.count({
        where: { trackerId: tracker.id, timestamp: { gte: debut, lte: finReelle } },
      });
      if (dejaPosees === 0) {
        const points: Array<{ min: number; lat: number; lng: number; v: number }> = [];
        // En route.
        for (let min = 0; min < 60; min += 5) {
          points.push({ min, lat: 43.6 + min * 0.002, lng: 1.44 + min * 0.001, v: 62 });
        }
        // Arrêt intermédiaire : 18 min au même point, moteur à l'arrêt.
        for (let min = 60; min <= 78; min += 3) {
          points.push({ min, lat: 43.72, lng: 1.5, v: 0 });
        }
        // Reprise, puis stationnement d'arrivée.
        for (let min = 84; min < 180; min += 6) {
          points.push({ min, lat: 43.72 + (min - 84) * 0.001, lng: 1.5 + (min - 84) * 0.0008, v: 58 });
        }
        for (let min = 180; min <= 235; min += 5) {
          points.push({ min, lat: 43.816, lng: 1.577, v: 0 });
        }
        await prisma.position.createMany({
          data: points.map((p) => ({
            trackerId: tracker.id,
            lat: p.lat,
            lng: p.lng,
            speedKmh: p.v,
            heading: 45,
            valid: true,
            ignition: p.v > 0,
            timestamp: new Date(debut.getTime() + p.min * 60_000),
          })),
        });
      }
    }

    console.log(`  ${t.ref} · ${v.plate} · DONE · ${t.retardMin > 0 ? `+${t.retardMin} min` : "à l'heure"}`);
  }
}

/** Une trace plausible autour de Toulouse, décalée par véhicule pour les distinguer. */
function traceDe(index: number): Array<{ lat: number; lng: number }> {
  const points: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i <= 24; i++) {
    points.push({
      lat: 43.6 + index * 0.012 + i * 0.0085 + Math.sin(i / 3) * 0.004,
      lng: 1.44 + index * 0.01 + i * 0.006 + Math.cos(i / 4) * 0.003,
    });
  }
  return points;
}

/** Encodeur polyline Google (précision 5) — le format que lit le frontend. */
function encoderPolyligne(points: Array<{ lat: number; lng: number }>): string {
  let sortie = '';
  let latPrec = 0;
  let lngPrec = 0;
  const morceau = (valeur: number): string => {
    let v = valeur < 0 ? ~(valeur << 1) : valeur << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    sortie += morceau(lat - latPrec) + morceau(lng - lngPrec);
    latPrec = lat;
    lngPrec = lng;
  }
  return sortie;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * TRK-031 — assainir les épisodes de perte GPS restés ouverts avant le correctif.
 *
 * ── POURQUOI CE SCRIPT EXISTE ────────────────────────────────────────────────────────
 *
 * `recordRecovery` fermait TOUS les épisodes ouverts d'un véhicule à la date du jour.
 * Mesuré le 2026-08-19 : FS-253-HR ressort de son parking à 13:48:56 et neuf épisodes se
 * referment à cette seconde, avec des durées de 6,94 à **35,18 jours**. Huit sont
 * fabriquées — pendant les prétendus 35 jours, le boîtier a émis **5 027 positions**.
 *
 * Le code est corrigé (il ne ferme plus que l'épisode courant et ses doublons). Mais le
 * STOCK reste : au 20/08, **20 épisodes ouverts sur 9 véhicules**, dont **9 sur KSR370**.
 * Sans ce script, ils ne se fermeront jamais — la borne du correctif les exclut par
 * construction, et c'est voulu : l'ingestion ne doit pas réparer le passé.
 *
 * ── DEUX POPULATIONS, ET LA SECONDE EST CELLE QUI FAIT LE DÉGÂT ──────────────────────
 *
 * ⚠️ La version initiale de ce script ne traitait que les épisodes OUVERTS. C'était
 * insuffisant, et la mesure le dit : au 2026-08-20, **13 des 20 épisodes CLOS portent une
 * durée fabriquée**, et ce sont eux — pas les ouverts — qui alimentent la médiane affichée à
 * l'exploitant. Assainir les seuls épisodes ouverts aurait laissé l'écran mentir.
 *
 *   1. **Épisodes ouverts** — jamais refermés, ils ne comptent pas encore dans la médiane
 *      mais s'y inviteront au prochain retour du véhicule ;
 *   2. **Épisodes clos à une date FAUSSE** — reconnaissables sans ambiguïté : le boîtier a
 *      émis des positions PENDANT l'absence qu'ils déclarent. Ils faussent la médiane
 *      aujourd'hui.
 *
 * Pour les deux, la vraie date de retour est la même : **la première position valide
 * postérieure à la perte**. C'est ce que le code aurait dû écrire.
 *
 * ⚠️ Il ne ferme JAMAIS un épisode à `now()`. C'est exactement le défaut qu'on répare, et
 * l'appliquer en masse serait le rejouer vingt fois d'un coup.
 *
 * ⚠️ Un épisode sans position postérieure reste OUVERT — et c'est le bon résultat : le
 * véhicule n'est jamais revenu. KSR370 est muet depuis le 14/08 ; son dernier épisode doit
 * rester ouvert, les précédents non.
 *
 * ⚠️ Un épisode antérieur à la rétention des positions (60 jours) n'est pas
 * reconstituable : sa date de retour n'existe plus nulle part. Le script les compte et les
 * NOMME plutôt que de deviner. Les laisser ouverts est honnête ; leur inventer une date ne
 * le serait pas.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 * Lecture seule par défaut — il faut demander explicitement l'écriture :
 *
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/assainir-episodes-gps.ts
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/assainir-episodes-gps.ts --apply
 *
 * Vérification d'après-coup, celle qui porte sur la CAUSE : aucun épisode clos ne doit
 * couvrir un intervalle pendant lequel le boîtier a émis des positions. Au 20/08 : 8 sur
 * 14. L'objectif est 0 — et pas « la médiane a l'air plus jolie ».
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes('--apply');

/** Rétention des positions, en jours — au-delà, la date de retour n'existe plus. */
const RETENTION_POSITIONS_JOURS = Number(process.env.POSITIONS_RETENTION_DAYS ?? 60);

type Ligne = {
  id: string;
  plaque: string;
  lostAt: Date;
  retour: Date | null;
  positionsPendant: number;
  verdict: 'A_FERMER' | 'DATE_A_CORRIGER' | 'TOUJOURS_PERDU' | 'HORS_RETENTION';
  /** Date de retour actuellement inscrite, pour les épisodes déjà clos (donc faux). */
  retourActuel: Date | null;
};

function jours(ms: number): string {
  return (ms / 86_400_000).toFixed(2);
}

async function main(): Promise<void> {
  const horizon = new Date(Date.now() - RETENTION_POSITIONS_JOURS * 86_400_000);

  // Les DEUX populations d'un coup : ouverts, et clos (dont on vérifiera la date plus bas).
  const ouverts = await prisma.gpsLossEvent.findMany({
    orderBy: [{ vehicleId: 'asc' }, { lostAt: 'asc' }],
    select: { id: true, vehicleId: true, lostAt: true, recoveredAt: true },
  });

  console.log(
    `\n${APPLIQUER ? '⚠️  MODE ÉCRITURE' : '🔍 LECTURE SEULE (DRY-RUN)'} — ${ouverts.length} épisode(s) examiné(s)\n`,
  );
  if (ouverts.length === 0) {
    console.log('Rien à assainir.');
    return;
  }

  // ⚠️ La relation Vehicle -> Tracker est 1-1 : un véhicule porte AU PLUS un boîtier, et
  // c'est le boîtier ACTUEL. Si un boîtier a été remplacé depuis la perte, les positions de
  // l'ancien ne sont plus atteignables par ce chemin — l'épisode sera classé « toujours
  // perdu » alors qu'il ne l'est pas. Le cas est rare et le script se contente de ne rien
  // écrire : mieux vaut laisser un épisode ouvert que lui inventer une date.
  const vehicleIds = [...new Set(ouverts.map((e) => e.vehicleId))];
  const vehicules = await prisma.vehicle.findMany({
    where: { id: { in: vehicleIds } },
    select: { id: true, plate: true, tracker: { select: { id: true } } },
  });
  const parVehicule = new Map(vehicules.map((v) => [v.id, v]));

  const lignes: Ligne[] = [];

  for (const ep of ouverts) {
    const v = parVehicule.get(ep.vehicleId);
    const trackerIds = v?.tracker ? [v.tracker.id] : [];
    const plaque = v?.plate ?? '(sans véhicule)';

    if (trackerIds.length === 0) {
      if (!ep.recoveredAt) {
        lignes.push({ id: ep.id, plaque, lostAt: ep.lostAt, retour: null, retourActuel: null, positionsPendant: 0, verdict: 'TOUJOURS_PERDU' });
      }
      continue;
    }

    // ⚠️ Pour un épisode DÉJÀ CLOS, la seule question qui compte est : le boîtier a-t-il émis
    // des positions PENDANT l'absence déclarée ? Si oui, la durée est fabriquée. Si non, la
    // date en place est plausible et on n'y touche pas — on ne réécrit pas ce qui va bien.
    if (ep.recoveredAt) {
      const pendant = await prisma.position.count({
        where: {
          trackerId: { in: trackerIds },
          valid: true,
          timestamp: { gt: ep.lostAt, lt: ep.recoveredAt },
        },
      });
      if (pendant === 0) continue;

      const vraie = await prisma.position.findFirst({
        where: { trackerId: { in: trackerIds }, valid: true, timestamp: { gt: ep.lostAt } },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      });
      if (!vraie) continue; // ne devrait pas arriver : `pendant > 0` implique qu'il y en a une
      lignes.push({
        id: ep.id,
        plaque,
        lostAt: ep.lostAt,
        retour: vraie.timestamp,
        retourActuel: ep.recoveredAt,
        positionsPendant: pendant,
        verdict: 'DATE_A_CORRIGER',
      });
      continue;
    }

    const premiere = await prisma.position.findFirst({
      where: { trackerId: { in: trackerIds }, valid: true, timestamp: { gt: ep.lostAt } },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
    });

    if (!premiere) {
      // Aucune position après la perte. Deux causes très différentes, et il faut les
      // distinguer : soit le véhicule n'est jamais revenu (épisode légitimement ouvert),
      // soit la perte est si ancienne que les positions ont été purgées.
      lignes.push({
        id: ep.id,
        plaque,
        lostAt: ep.lostAt,
        retour: null,
        retourActuel: null,
        positionsPendant: 0,
        verdict: ep.lostAt < horizon ? 'HORS_RETENTION' : 'TOUJOURS_PERDU',
      });
      continue;
    }

    const positionsPendant = await prisma.position.count({
      where: { trackerId: { in: trackerIds }, valid: true, timestamp: { gt: ep.lostAt } },
    });

    lignes.push({ id: ep.id, plaque, lostAt: ep.lostAt, retour: premiere.timestamp, retourActuel: null, positionsPendant, verdict: 'A_FERMER' });
  }

  if (lignes.length === 0) {
    console.log('Rien à assainir : aucun épisode ouvert réparable, aucune date fabriquée.');
    return;
  }

  const largeur = Math.max(...lignes.map((l) => l.plaque.length), 8);
  console.log(
    `${'Véhicule'.padEnd(largeur)}  ${'Perte'.padEnd(20)}  ${'Retour reconstitué'.padEnd(20)}  Durée(j)  Positions  Verdict`,
  );
  console.log('─'.repeat(largeur + 76));
  for (const l of lignes) {
    const duree = l.retour ? jours(l.retour.getTime() - l.lostAt.getTime()).padStart(8) : '       —';
    const fautive = l.retourActuel ? `  (au lieu de ${l.retourActuel.toISOString().slice(0, 10)})` : '';
    console.log(
      `${l.plaque.padEnd(largeur)}  ${l.lostAt.toISOString().slice(0, 19)}  ` +
        `${(l.retour ? l.retour.toISOString().slice(0, 19) : '—').padEnd(20)}  ${duree}  ` +
        `${String(l.positionsPendant).padStart(9)}  ${l.verdict}${fautive}`,
    );
  }

  const aFermer = lignes.filter((l) => l.verdict === 'A_FERMER');
  const aCorriger = lignes.filter((l) => l.verdict === 'DATE_A_CORRIGER');
  const perdus = lignes.filter((l) => l.verdict === 'TOUJOURS_PERDU');
  const horsRetention = lignes.filter((l) => l.verdict === 'HORS_RETENTION');

  console.log(
    `\n${aFermer.length} à fermer (ouverts) · ${aCorriger.length} date(s) FABRIQUÉE(S) à corriger · ` +
      `${perdus.length} toujours perdu(s), laissé(s) ouvert(s) · ` +
      `${horsRetention.length} hors rétention (${RETENTION_POSITIONS_JOURS} j), laissé(s) ouvert(s)`,
  );

  if (!APPLIQUER) {
    console.log('\n🔍 Rien n’a été écrit. Relancer avec --apply pour appliquer.');
    return;
  }

  let ecrits = 0;
  for (const l of aFermer) {
    // ⚠️ `recoveredAt: null` dans le `where` : si un vrai retour est survenu entre la
    // lecture et l'écriture, on ne l'écrase pas. Le script est rejouable sans risque.
    const { count } = await prisma.gpsLossEvent.updateMany({
      where: { id: l.id, recoveredAt: null },
      data: { recoveredAt: l.retour as Date },
    });
    ecrits += count;
  }
  for (const l of aCorriger) {
    // ⚠️ Ici on RÉÉCRIT une date existante — le seul endroit de tout ce dossier où on touche
    // à une valeur déjà posée. C'est justifié parce qu'elle est réfutée par la donnée
    // elle-même : le boîtier a émis des positions pendant l'absence déclarée. Le `where`
    // reprend la date fautive : si elle a changé depuis la lecture, on s'abstient.
    const { count } = await prisma.gpsLossEvent.updateMany({
      where: { id: l.id, recoveredAt: l.retourActuel as Date },
      data: { recoveredAt: l.retour as Date },
    });
    ecrits += count;
  }
  console.log(`\n✅ ${ecrits} épisode(s) refermé(s) à leur VRAIE date de retour.`);
  console.log(
    'Vérification à rejouer : aucun épisode clos ne doit couvrir un intervalle pendant\n' +
      'lequel le boîtier a émis des positions.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

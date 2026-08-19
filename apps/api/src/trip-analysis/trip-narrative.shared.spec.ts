import {
  assainirRecit,
  clampScore,
  construirePayloadRecit,
  recitConcluant,
  type LigneAnalyse,
} from './trip-narrative.shared';

/**
 * Récit de trajet — le module PUR partagé par l'application et par l'agent sur poste.
 *
 * C'est le contrat commun aux deux producteurs. Ce que ces tests verrouillent n'est pas la qualité
 * du texte (elle dépend du modèle) mais ce qui ferait DIVERGER les deux côtés, ou ferait écrire une
 * affirmation fausse en base.
 */
describe('trip-narrative.shared', () => {
  function ligne(over: Record<string, unknown> = {}): LigneAnalyse {
    return {
      tripId: 't1', fleetId: 'f1', vehicleId: 'v1',
      distanceKm: 12.4, durationSec: 1800, movingSec: 1500, avgSpeedKmh: 29, maxSpeedKmh: 78,
      stopCount: 2, idleSec: 300, gpsPoints: 420, gpsValidRatio: 0.98, gpsLostCount: 1,
      speedingCount: 1, speedingSec: 40, maxOverKmh: 8, limitsKnown: true,
      harshAccel: 1, harshBrake: 2, ecoScore: 84, fuelLiters: 1.2, co2Kg: 2.8,
      ...over,
    } as LigneAnalyse;
  }

  // ─── Ce qui part au modèle ─────────────────────────────────────────────────

  it('ne transmet JAMAIS de positions brutes', () => {
    const p = JSON.stringify(construirePayloadRecit(ligne({ positions: [{ lat: 43.6, lng: 1.44 }] })));
    // Le travail déterministe est déjà fait et fiable. Envoyer les points inviterait le modèle à
    // recompter — donc à se tromper — et gonflerait la facture pour rien.
    expect(p).not.toContain('43.6');
    expect(p).not.toContain('positions');
  });

  it('transmet `limitsKnown`, qui sépare « aucun excès » de « aucun excès SIGNALÉ »', () => {
    const connu = construirePayloadRecit(ligne({ limitsKnown: true })) as { speeding: { limitsKnown: boolean } };
    const inconnu = construirePayloadRecit(ligne({ limitsKnown: false })) as { speeding: { limitsKnown: boolean } };
    expect(connu.speeding.limitsKnown).toBe(true);
    // Sans ce drapeau, le modèle affirmerait une conformité qu'on n'a jamais mesurée.
    expect(inconnu.speeding.limitsKnown).toBe(false);
  });

  it('convertit les secondes en minutes, comme l’écran', () => {
    const p = construirePayloadRecit(ligne()) as { summary: { durationMin: number; movingMin: number; idleMin: number } };
    expect(p.summary.durationMin).toBe(30);
    expect(p.summary.movingMin).toBe(25);
    expect(p.summary.idleMin).toBe(5);
  });

  it('borne le détail des excès et des arrêts', () => {
    const p = construirePayloadRecit(ligne({
      detail: {
        speeding: Array.from({ length: 30 }, () => ({ maxSpeedKmh: 100, limitKmh: 80, overKmh: 20, durationSec: 10 })),
        stops: Array.from({ length: 40 }, () => ({ durationMin: 5 })),
      },
    })) as { speeding: { segments: unknown[] }; stops: unknown[] };
    expect(p.speeding.segments).toHaveLength(8);
    expect(p.stops).toHaveLength(12);
  });

  it('survit à une ligne incomplète sans inventer de chiffres', () => {
    const p = construirePayloadRecit({ tripId: 't', fleetId: 'f', vehicleId: 'v' }) as {
      summary: { distanceKm: number }; ecoDriving: { fuelLiters: number | null }; stops: unknown[];
    };
    expect(p.summary.distanceKm).toBe(0);
    // `null` et non 0 : « non mesuré » n'est pas « zéro litre ».
    expect(p.ecoDriving.fuelLiters).toBeNull();
    expect(p.stops).toEqual([]);
  });

  // ─── Ce qui revient du modèle ──────────────────────────────────────────────

  it('borne le récit et les conseils', () => {
    const r = assainirRecit({ narrative: 'a'.repeat(5000), advice: 'b'.repeat(5000), trustScore: 90 });
    expect(r.narrative).toHaveLength(1500);
    expect(r.advice).toHaveLength(800);
  });

  it('rend des chaînes vides plutôt que `undefined` sur une réponse incomplète', () => {
    const r = assainirRecit({});
    expect(r.narrative).toBe('');
    expect(r.advice).toBe('');
  });

  it('un indice de confiance illisible retombe à 50, jamais à 0', () => {
    // 0 afficherait un badge rouge alarmant sur un trajet peut-être irréprochable : « on ne sait
    // pas » n'est pas « donnée catastrophique ».
    expect(clampScore(undefined)).toBe(50);
    expect(clampScore('nawak')).toBe(50);
    expect(clampScore(140)).toBe(100);
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(72.4)).toBe(72);
  });

  // ─── Ce qui mérite d'être écrit ────────────────────────────────────────────

  it('un récit vide ou trop court n’est PAS concluant', () => {
    // L'écrire condamnerait le trajet à ne jamais être repris : le pipeline considère qu'un trajet
    // avec récit est traité.
    expect(recitConcluant(assainirRecit({ narrative: '' }))).toBe(false);
    expect(recitConcluant(assainirRecit({ narrative: 'Trajet court.' }))).toBe(false);
  });

  it('un vrai récit est concluant', () => {
    const texte = 'Trajet calme de 12 km en trente minutes, deux arrets brefs et une conduite reguliere.';
    expect(recitConcluant(assainirRecit({ narrative: texte }))).toBe(true);
  });
});

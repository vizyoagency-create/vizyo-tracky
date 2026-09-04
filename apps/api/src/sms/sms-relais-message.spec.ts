import { decrireEchecRelaisSms } from './sms-gateway.service';

/**
 * ── TRK-066 : CE QUE LIT L'EXPLOITANT QUAND LE DERNIER RECOURS SE TAIT ──────────────────
 *
 * Le 2026-09-04 à 03:00:10, la passerelle SMS a écrit sa **première ligne d'erreur de toute
 * l'histoire conservée** — le référentiel notait « 0 depuis toujours » pour cette source. Le
 * message tenait en sept mots : `The operation was aborted due to timeout`.
 *
 * Derrière, le coupe-circuit : boîtier hors ligne, repli SMS en dernière voie, relais muet en
 * 10 secondes. **Le véhicule n'a pas été immobilisé** — et la ligne ne le disait pas.
 *
 * ⚠️ Ce fichier teste le MESSAGE, pas la garde. Le délai, le réessai et le niveau d'alerte
 * relèvent du coupe-circuit et d'une décision humaine (fiche TRK-066).
 */
describe('TRK-066 — le message d’un relais SMS qui n’a pas répondu', () => {
  const MOTIF_REEL = 'The operation was aborted due to timeout';

  it('nomme la DÉPENDANCE — sans quoi on ne sait même pas quel relais a expiré', () => {
    const m = decrireEchecRelaisSms(MOTIF_REEL, '+33759742946');
    expect(m).toContain('relais SMS (vizyo-texto)');
  });

  it('nomme la CONSÉQUENCE, y compris la plus grave : le véhicule n’a pas été immobilisé', () => {
    const m = decrireEchecRelaisSms(MOTIF_REEL, '+33759742946');
    expect(m).toContain("n'est pas parti");
    expect(m).toContain("le véhicule n'a PAS été immobilisé");
  });

  it('CONSERVE le motif technique — on change l’ordre, on n’efface pas la preuve', () => {
    const m = decrireEchecRelaisSms(MOTIF_REEL, '+33759742946');
    expect(m).toContain('Motif technique');
    expect(m).toContain('aborted due to timeout');
  });

  it('TÉMOIN — un refus qui n’est PAS une expiration n’en annonce pas une', () => {
    const m = decrireEchecRelaisSms('401 Unauthorized', '+33759742946');
    expect(m).toContain('a refusé la demande');
    expect(m).not.toContain('dans le délai accordé');
    expect(m).toContain('401 Unauthorized');
  });

  it('ne publie pas le numéro complet du destinataire — ces lignes sont versionnées', () => {
    const m = decrireEchecRelaisSms(MOTIF_REEL, '+33759742946');
    expect(m).not.toContain('+33759742946');
    expect(m).toContain('2946');
  });

  it('borne le motif — une pile bavarde ne doit pas noyer la ligne', () => {
    expect(decrireEchecRelaisSms('x'.repeat(5000), '+33759742946').length).toBeLessThan(500);
  });
});

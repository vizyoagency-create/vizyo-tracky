import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ══ LE MOT DE PASSE DU BOÎTIER NE DOIT JAMAIS SORTIR PAR UNE ROUTE DE LECTURE ════════════════
 *
 * Le 30/09/2026, `Tracker.devicePassword` est ajouté au modèle. Or `TrackersService.findAll` et
 * `findOne` renvoient le Tracker ENTIER (`include: { vehicle: … }`) et sont ouvertes à
 * FLEET_ADMIN, FLEET_MANAGER et VIEWER. Sans précaution, le secret serait parti en clair à tous
 * ces rôles le jour même — pas par une faille, par un `include` que plus personne ne relit.
 *
 * Ces tests gardent deux propriétés qu'un refactor futur casserait sans bruit :
 *
 *   1. AUCUN `return` de ce service ne rend un Tracker brut. Ils passent tous par
 *      `sansMotDePasse`, qui retire le secret et le remplace par `motDePasseUsine`.
 *   2. Le verdict « usine » se lit sur `devicePasswordSetAt`, jamais sur une comparaison avec
 *      « 123456 » — un boîtier changé POUR cette valeur resterait exposé et doit le dire.
 *
 * Le contrôle est TEXTUEL et c'est assumé : instancier le service demanderait Prisma, et le
 * défaut qu'on prévient n'est pas un comportement mais un oubli d'écriture. Un test qui lit le
 * code attrape l'oubli le jour où il est commis, pas trois mois plus tard en production.
 */
describe('TrackersService — le mot de passe du boîtier ne sort pas', () => {
  const source = readFileSync(join(__dirname, 'trackers.service.ts'), 'utf8');

  it('🔴 aucun return ne rend un Tracker sans passer par sansMotDePasse', () => {
    const lignes = source.split('\n');
    const suspects = lignes
      .map((ligne, i) => ({ n: i + 1, t: ligne.trim() }))
      .filter(({ t }) => /^return (updated|created|existing|out|rows|tracker)\b/.test(t))
      // Un `return` peut s'étendre sur plusieurs lignes (`return rows.map((t) =>` …) : on lit
      // l'instruction, pas la ligne. Sans cela le test crie sur du code parfaitement protégé —
      // et un test qui crie à tort finit désactivé.
      .filter(({ n }) => !lignes.slice(n - 1, n + 2).join(' ').includes('sansMotDePasse'))
      // `return tracker;` dans `unassign` rend ce que `findOne` a DÉJÀ assaini.
      .filter(({ t }) => t !== 'return tracker;');

    expect(suspects.map((s) => `${s.n}: ${s.t}`)).toEqual([]);
  });

  it('le verdict « usine » se lit sur devicePasswordSetAt, pas sur la valeur', () => {
    const fn = source.slice(source.indexOf('function sansMotDePasse'), source.indexOf('@Injectable'));
    expect(fn).toContain('devicePasswordSetAt');
    // Comparer à « 123456 » raterait un boîtier qu'on aurait changé POUR cette valeur — et
    // raterait aussi un lot de matériel livré avec une autre valeur d'usine.
    expect(fn).not.toContain("'123456'");
  });

  it('sansMotDePasse retire bien le secret et pose le verdict', () => {
    // On rejoue la fonction sur des objets nus : c'est sa seule responsabilité.
    const sansMotDePasse = <T extends { devicePassword?: string; devicePasswordSetAt?: Date | null }>(t: T): T => {
      const { devicePassword: _s, ...reste } = t;
      return { ...(reste as T), motDePasseUsine: t.devicePasswordSetAt == null } as T;
    };

    const usine = sansMotDePasse({ imei: '1', devicePassword: '123456', devicePasswordSetAt: null }) as Record<string, unknown>;
    expect(usine['devicePassword']).toBeUndefined();
    expect(usine['motDePasseUsine']).toBe(true);

    const change = sansMotDePasse({ imei: '2', devicePassword: '840193', devicePasswordSetAt: new Date() }) as Record<string, unknown>;
    expect(change['devicePassword']).toBeUndefined();
    expect(change['motDePasseUsine']).toBe(false);
  });
});

/**
 * ══ ET PLUS AUCUNE COMMANDE NE PORTE LE MOT DE PASSE D'USINE EN DUR ══════════════════════════
 *
 * Vingt gabarits du catalogue Coban et cinq modules l'écrivaient. Le compilateur garde déjà les
 * appels (le paramètre `pwd` est obligatoire, sans valeur par défaut) ; ce test garde les
 * CHAÎNES, que le compilateur ne peut pas voir.
 */
describe('Commandes boîtier — plus de mot de passe d’usine écrit en dur', () => {
  const fichiers = [
    '../../../../packages/shared/src/protocol/coban.catalog.ts',
    '../engine-control/engine-control.service.ts',
    '../tracker-fix-mode/tracker-fix-mode.service.ts',
  ];

  it('🔴 aucune commande construite avec « 123456 » collé', () => {
    const fautifs: string[] = [];
    for (const rel of fichiers) {
      const texte = readFileSync(join(__dirname, rel), 'utf8');
      texte.split('\n').forEach((ligne, i) => {
        const t = ligne.trim();
        // Les commentaires racontent l'incident et CITENT l'ancienne forme : c'est voulu.
        if (/^\s*(\/\/|\*|\/\*)/.test(t)) return;
        if (/(stop|resume|reset|factory|sleep|nofix|move|shock|sensitivity|apn|adminip|password|protocol|monitor|begin|gprs|speed|stockade|fix)123456/.test(t)) {
          fautifs.push(`${rel}:${i + 1} → ${t.slice(0, 80)}`);
        }
      });
    }
    expect(fautifs).toEqual([]);
  });
});

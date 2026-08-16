import { readFileSync } from 'fs';
import { join } from 'path';
import { getDefaultPermissions } from '@vizyo/tracky-shared';

/**
 * Lot A6 — QUI PEUT LIRE UN FIL DE NEGOCIATION.
 *
 * ┌─ LA FUITE QUE CE FICHIER EMPECHE DE REVENIR ──────────────────────────────┐
 * │ `GET /mission-requests` etait garde par `missions_view`. Or le role        │
 * │ CONDUCTEUR le porte par defaut : une session de conducteur obtenait donc   │
 * │ la totalite des negociations de la societe — noms des depots, adresses,    │
 * │ montants, messages. Verifie sur une session reelle le 2026-08-14 : 21 Ko   │
 * │ de reponse, statut 200.                                                    │
 * │                                                                            │
 * │ Ce n'etait pas un simple exces de droits. Le produit protege deja le       │
 * │ conducteur de ces donnees ailleurs : `MissionConducteurDto` est vide de    │
 * │ toute information du depot, et son commentaire le dit mot pour mot. Une    │
 * │ permission trop large sur une seule route contredisait toute cette         │
 * │ precaution.                                                                │
 * │                                                                            │
 * │ Le test ne verifie PAS un comportement d'execution — un test d'integration │
 * │ HTTP le ferait mieux mais ne dirait rien du jour ou quelqu'un change la    │
 * │ permission dans le decorateur. Il lit LE DECORATEUR, et le confronte a la  │
 * │ matrice des roles. C'est le lien exact qui avait cede.                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
describe('MissionRequestsController — qui lit les negociations', () => {
  const source = readFileSync(
    join(__dirname, 'mission-requests.controller.ts'),
    'utf8',
  );

  /** La permission exigee par la route dont la signature suit le decorateur. */
  const permissionDe = (signature: string): string | null => {
    const i = source.indexOf(signature);
    if (i < 0) throw new Error(`route introuvable : ${signature}`);
    // On remonte au dernier @RequirePermissions avant la signature.
    const avant = source.slice(0, i);
    const m = [...avant.matchAll(/@RequirePermissions\('([^']+)'\)/g)].pop();
    return m ? m[1] : null;
  };

  it('la LISTE exige `missions_request`, pas `missions_view`', () => {
    expect(permissionDe('lister(')).toBe('missions_request');
  });

  it('le DETAIL exige la meme chose que la liste', () => {
    // Le detail porte PLUS que la liste : chaque tour, chaque montant, chaque
    // message. Le fermer d'un cote en le laissant ouvert de l'autre n'aurait rien
    // ferme du tout.
    expect(permissionDe('detail(')).toBe('missions_request');
  });

  it('l\'AFFECTATION reste sur `missions_manage` : engager son parc n\'est pas negocier', () => {
    expect(permissionDe('affecter(')).toBe('missions_manage');
  });

  describe('la matrice des roles, cote a cote avec la garde', () => {
    /**
     * Les deux BOUTS de la table : celui qui demande, celui qui arbitre. Le
     * gestionnaire n'y est pas — voir le test suivant, c'est une decision.
     */
    const AUTORISES = ['DEPOT', 'FLEET_ADMIN'] as const;
    /** Ceux qui n'ont rien a faire dans une negociation commerciale. */
    const EXCLUS = ['DRIVER', 'VIEWER', 'NIGHT_WATCHMAN'] as const;

    for (const role of AUTORISES) {
      it(`${role} porte missions_request : il negocie ou il arbitre`, () => {
        expect(getDefaultPermissions(role).missions_request).toBe(true);
      });
    }

    for (const role of EXCLUS) {
      it(`${role} ne porte PAS missions_request`, () => {
        expect(getDefaultPermissions(role).missions_request).toBe(false);
      });
    }

    it('le GESTIONNAIRE ne la porte PAS par defaut, alors qu\'il cree des missions', () => {
      // ⚠️ DECISION DU CLIENT, 2026-08-15, ET ELLE VA CONTRE L'INTUITION.
      //
      // Le gestionnaire porte `missions_manage` : il cree des missions toute la
      // journee. La symetrie voudrait qu'il puisse aussi en demander une. Le client
      // tranche l'inverse : creer une mission, c'est planifier son propre parc ;
      // demander et negocier, c'est engager un PRIX face a un tiers. Deux metiers.
      //
      // Ce test existe pour qu'un futur « tiens, c'est incoherent » ne la rouvre pas
      // en silence : elle est fermee EXPRES, et un admin l'accorde nommement.
      expect(getDefaultPermissions('FLEET_MANAGER').missions_manage).toBe(true);
      expect(getDefaultPermissions('FLEET_MANAGER').missions_request).toBe(false);
    });

    it('le CONDUCTEUR porte missions_view — c\'est pourquoi la garde ne peut pas s\'y fier', () => {
      // La ligne qui explique la fuite. Si un jour `missions_view` lui est retiree,
      // ce test le signalera : la garde pourra alors etre rediscutee, mais pas
      // relachee par inadvertance.
      expect(getDefaultPermissions('DRIVER').missions_view).toBe(true);
    });
  });
});

import { KNOWLEDGE, contenuSujets, estSujetConnu, sommaireConnaissances } from './tracky-knowledge';

/**
 * BASE DE CONNAISSANCES — ce qui doit rester vrai quoi qu'il arrive.
 *
 * Le contenu de ce fichier finit MOT POUR MOT dans des réponses lues par des utilisateurs. La
 * règle « vocabulaire client, jamais interne » n'est donc pas une convention de style : c'est la
 * barrière contre la divulgation. On ne compte pas sur le modèle pour taire ce qu'on lui a
 * donné — on ne le lui donne pas. Une règle vérifiable doit être vérifiée automatiquement,
 * sinon elle tient jusqu'au premier sujet ajouté un vendredi soir.
 */
describe('Base de connaissances de l\'assistance', () => {
  const tousLesContenus = KNOWLEDGE.map((t) => `${t.titre}\n${t.contenu}`);

  // ─── Aucun secret ne doit passer ───────────────────────────────────────────

  it('ne contient aucun chemin de fichier ni extension de source', () => {
    for (const [i, texte] of tousLesContenus.entries()) {
      expect({ sujet: KNOWLEDGE[i].key, trouve: texte.match(/[\w-]+\.(ts|js|html|scss|prisma)\b/g) }).toEqual({
        sujet: KNOWLEDGE[i].key, trouve: null,
      });
      expect({ sujet: KNOWLEDGE[i].key, trouve: texte.match(/\b(apps|packages)\/[\w-]+/g) }).toEqual({
        sujet: KNOWLEDGE[i].key, trouve: null,
      });
    }
  });

  it('ne nomme aucune classe ni service interne', () => {
    // Un nom de classe trahit l'architecture et donne prise à qui cherche une faille.
    const motifClasse = /\b[A-Z][a-zA-Z]*(Service|Component|Controller|Guard|Module|Repository|Dto)\b/g;
    for (const [i, texte] of tousLesContenus.entries()) {
      expect({ sujet: KNOWLEDGE[i].key, trouve: texte.match(motifClasse) }).toEqual({
        sujet: KNOWLEDGE[i].key, trouve: null,
      });
    }
  });

  it('ne cite aucune variable d\'environnement', () => {
    // Motif d'une variable d'environnement : MAJUSCULES_AVEC_UNDERSCORES. Connaître leur nom,
    // c'est connaître les leviers de l'installation.
    const motifEnv = /\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,}\b/g;
    for (const [i, texte] of tousLesContenus.entries()) {
      expect({ sujet: KNOWLEDGE[i].key, trouve: texte.match(motifEnv) }).toEqual({
        sujet: KNOWLEDGE[i].key, trouve: null,
      });
    }
  });

  it('ne nomme aucun champ technique de la base', () => {
    const champs = ['fleetId', 'userId', 'vehicleId', 'aiEnabled', 'trackerId', 'costUsd', 'isOwner', 'segmentationSource', 'lastSeenAt'];
    for (const [i, texte] of tousLesContenus.entries()) {
      for (const champ of champs) {
        expect({ sujet: KNOWLEDGE[i].key, champ, present: texte.includes(champ) }).toEqual({
          sujet: KNOWLEDGE[i].key, champ, present: false,
        });
      }
    }
  });

  it('ne cite aucun fournisseur technique ni prestataire', () => {
    // Le client achète Tracky, pas une pile technique. Nommer les briques expose des cibles et
    // engage sur des choix qui peuvent changer sans préavis.
    const fournisseurs = ['Anthropic', 'Claude', 'OpenAI', 'GPT', 'Postgres', 'PostgreSQL', 'Twilio', 'Resend', 'NestJS', 'Angular', 'Prisma', 'Docker', 'Coban'];
    for (const [i, texte] of tousLesContenus.entries()) {
      for (const f of fournisseurs) {
        expect({ sujet: KNOWLEDGE[i].key, fournisseur: f, present: new RegExp(`\\b${f}\\b`, 'i').test(texte) }).toEqual({
          sujet: KNOWLEDGE[i].key, fournisseur: f, present: false,
        });
      }
    }
  });

  // ─── Structure ─────────────────────────────────────────────────────────────

  it('a des clés uniques et stables', () => {
    const cles = KNOWLEDGE.map((t) => t.key);
    expect(new Set(cles).size).toBe(cles.length);
    for (const k of cles) expect(k).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('donne à chaque sujet des mots-clés et un contenu utile', () => {
    for (const t of KNOWLEDGE) {
      expect({ sujet: t.key, motsCles: t.motsCles.length > 2 }).toEqual({ sujet: t.key, motsCles: true });
      // Un sujet trop court ne répond à rien et coûte un aller-retour pour rien.
      expect({ sujet: t.key, assezLong: t.contenu.length > 300 }).toEqual({ sujet: t.key, assezLong: true });
    }
  });

  it('n\'emploie que des mots-clés en minuscules et sans accent (robustesse du classement)', () => {
    // Les questions arrivent écrites à la va-vite, sans accents et en minuscules. Des mots-clés
    // accentués ne matcheraient pas « exces de vitesse » tapé sans accent.
    for (const t of KNOWLEDGE) {
      for (const m of t.motsCles) {
        expect({ sujet: t.key, mot: m, conforme: m === m.toLowerCase() && !/[àâäéèêëîïôöùûüç]/.test(m) }).toEqual({
          sujet: t.key, mot: m, conforme: true,
        });
      }
    }
  });

  // ─── Sélection ─────────────────────────────────────────────────────────────

  it('le sommaire reste bien plus léger que la base entière', () => {
    const base = KNOWLEDGE.reduce((n, t) => n + t.contenu.length, 0);
    // Le sommaire part à CHAQUE question : s'il approchait le poids de la base, l'étape de
    // classement coûterait aussi cher que la réponse et n'aurait plus d'intérêt.
    expect(sommaireConnaissances().length).toBeLessThan(base / 8);
  });

  it('ignore les sujets inventés au lieu de rendre une section vide', () => {
    expect(contenuSujets(['tout', 'schema', 'admin', 'carte-live']).map((t) => t.key)).toEqual(['carte-live']);
    expect(contenuSujets(['nawak'])).toEqual([]);
    expect(estSujetConnu('carte-live')).toBe(true);
    expect(estSujetConnu('rien')).toBe(false);
  });

  it('rend un ordre stable quelle que soit celui de la demande (mise en cache possible)', () => {
    const a = contenuSujets(['trajets', 'carte-live']).map((t) => t.key);
    const b = contenuSujets(['carte-live', 'trajets']).map((t) => t.key);
    expect(a).toEqual(b);
  });

  it('ne rend pas deux fois le même sujet si la clé est répétée', () => {
    expect(contenuSujets(['trajets', 'trajets', 'trajets'])).toHaveLength(1);
  });

  // ─── Sujets attendus ───────────────────────────────────────────────────────

  it('couvre les domaines sur lesquels les questions tombent', () => {
    const attendus = [
      'carte-live', 'trajets', 'analyse-trajet', 'scores-conduite', 'carburant', 'zones',
      'alertes', 'notifications', 'surveillance', 'moteur', 'boitier', 'agenda',
      'vehicules', 'horaires', 'rapports', 'roles-permissions', 'vie-privee', 'compte',
      'ia', 'assistance-limites',
    ];
    const cles = KNOWLEDGE.map((t) => t.key);
    for (const a of attendus) expect(cles).toContain(a);
  });

  it('dit explicitement que l\'assistance ne peut PAS agir', () => {
    const limites = KNOWLEDGE.find((t) => t.key === 'assistance-limites');
    // Sans cette phrase dans la base, l'agent finit par promettre une action qu'il ne fera pas.
    expect(limites?.contenu).toMatch(/n.AGIT PAS|ne peut rien modifier/i);
  });
});

import { TestBed } from '@angular/core/testing';
import { PreferencesService } from './preferences.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES REPÈRES DE LIEUX SONT DISCRETS PAR DÉFAUT, ET LE CHOIX SE RETIENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La carte pose trois familles de repères : stations détectées, zones mortes, lieux de la
 * flotte. Toutes s'affichaient en taille pleine dès l'ouverture ; sur une flotte réelle elles
 * couvrent la ville, et la carte cesse de montrer ce qu'on vient y chercher — les véhicules.
 *
 * ⚠️ DEUX PROPRIÉTÉS, ET LA SECONDE EST LA PLUS FACILE À PERDRE. Le mode « discrets » existait
 * déjà, mais il vivait dans un signal de composant : le choix ne survivait pas au rechargement.
 * Changer le seul défaut aurait déplacé l'agacement sur ceux qui veulent la vue complète — ils
 * auraient dû la redemander à chaque visite.
 */
const UTILISATEUR = 'u-test-lieux';
const CLE = `vizyo-tracky-prefs-${UTILISATEUR}`;

describe('Préférences — affichage des lieux sur la carte', () => {
  let prefs: PreferencesService;

  beforeEach(() => {
    localStorage.removeItem(CLE);
    TestBed.resetTestingModule();
    prefs = TestBed.configureTestingModule({}).inject(PreferencesService);
  });

  afterEach(() => localStorage.removeItem(CLE));

  /** Une nouvelle visite : un service neuf qui relit ce qui a été stocké. */
  const nouvelleVisite = (): PreferencesService => {
    TestBed.resetTestingModule();
    const s = TestBed.configureTestingModule({}).inject(PreferencesService);
    s.load(UTILISATEUR);
    return s;
  };

  it('🔴 le défaut du produit est « discrets », pas « tous »', () => {
    prefs.load(UTILISATEUR);

    expect(prefs.prefs().map.lieuxAffichage).toBe('discrets');
  });

  it('🔴 le choix survit au rechargement', () => {
    prefs.load(UTILISATEUR);
    prefs.update({ map: { ...prefs.prefs().map, lieuxAffichage: 'tous' } });

    expect(nouvelleVisite().prefs().map.lieuxAffichage).toBe('tous');
  });

  it('« masqués » se retient aussi — ce n’est pas qu’un repli vers le défaut', () => {
    // Le témoin : si la relecture retombait bêtement sur le défaut, le test précédent
    // pourrait passer par coïncidence le jour où le défaut deviendrait « tous ».
    prefs.load(UTILISATEUR);
    prefs.update({ map: { ...prefs.prefs().map, lieuxAffichage: 'masques' } });

    expect(nouvelleVisite().prefs().map.lieuxAffichage).toBe('masques');
  });

  /**
   * ⚠️ LES UTILISATEURS EXISTANTS ONT DÉJÀ DES PRÉFÉRENCES STOCKÉES, sans cette clé. La fusion
   * doit leur donner le défaut plutôt qu'un `undefined` — sinon le tri-état de la carte
   * démarrerait sur rien, et aucun des trois boutons ne serait actif.
   */
  it('des préférences enregistrées AVANT ce réglage reçoivent le défaut', () => {
    localStorage.setItem(CLE, JSON.stringify({ map: { style: 'osm', zoom: 12, showTrails: true } }));

    const s = nouvelleVisite();

    expect(s.prefs().map.lieuxAffichage).toBe('discrets');
    // …et le reste de leurs réglages n'est pas écrasé au passage.
    expect(s.prefs().map.zoom).toBe(12);
  });
});

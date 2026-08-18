import { VerrouProvisioningRegistry } from './verrou-provisioning.registry';

const ANNA = { userId: 'u-anna', nom: 'Anna Diaz', email: 'anna@exemple.fr' };
const BRUNO = { userId: 'u-bruno', nom: 'Bruno Léon', email: 'bruno@exemple.fr' };

describe('VerrouProvisioning — un seul pari a la fois', () => {
  let v: VerrouProvisioningRegistry;
  beforeEach(() => {
    v = new VerrouProvisioningRegistry();
    jest.restoreAllMocks();
  });

  it('libre au depart', () => {
    const e = v.etat(ANNA.userId);
    expect(e.libre).toBe(true);
    expect(e.detenteurNom).toBeNull();
  });

  it('le premier arrive le prend', () => {
    const e = v.prendre({ ...ANNA, contexte: 'FL-787-KV' });
    expect(e.libre).toBe(false);
    expect(e.parMoi).toBe(true);
    expect(e.contexte).toBe('FL-787-KV');
  });

  it('⚠️ le second se voit refuser, et apprend A QUI demander', () => {
    // Un « occupé » anonyme laisse l'installateur attendre sans savoir qui relancer.
    v.prendre({ ...ANNA, contexte: 'FL-787-KV' });
    const e = v.prendre(BRUNO);
    expect(e.parMoi).toBe(false);
    expect(e.detenteurNom).toBe('Anna Diaz');
    expect(e.contexte).toBe('FL-787-KV');
    expect(e.depuisSecondes).not.toBeNull();
  });

  it('reprendre son propre verrou le rafraichit sans reinitialiser son anciennete', () => {
    const t0 = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    v.prendre(ANNA);
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 30_000);
    const e = v.prendre(ANNA);
    expect(e.parMoi).toBe(true);
    // L'anciennete compte depuis la PRISE, pas depuis le dernier battement : c'est elle
    // qui dit au super-admin si la session traine.
    expect(e.depuisSecondes).toBe(30);
    expect(e.expireDansSecondes).toBe(90);
  });

  it('rendre libere', () => {
    v.prendre(ANNA);
    expect(v.rendre(ANNA.userId).libre).toBe(true);
  });

  it('rendre le verrou de quelqu’un d’autre ne fait RIEN', () => {
    v.prendre(ANNA);
    const e = v.rendre(BRUNO.userId);
    expect(e.libre).toBe(false);
    expect(e.detenteurNom).toBe('Anna Diaz');
  });

  it('⚠️ un onglet ferme libere tout seul apres 90 s sans battement', () => {
    // Sans expiration, un portable qui s'endort bloquerait le parc jusqu'a ce que
    // quelqu'un appelle l'assistance.
    const t0 = 2_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    v.prendre(ANNA);
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 89_000);
    expect(v.etat(BRUNO.userId).libre).toBe(false);
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 91_000);
    expect(v.etat(BRUNO.userId).libre).toBe(true);
  });

  it('un battement dans la fenetre repousse l’expiration', () => {
    const t0 = 3_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    v.prendre(ANNA);
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 60_000);
    v.prendre(ANNA); // battement
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 120_000);
    // 120 s apres la prise, mais 60 s seulement apres le dernier battement.
    expect(v.etat(ANNA.userId).libre).toBe(false);
  });

  it('la liberation forcee rend la main, et le suivant peut prendre', () => {
    v.prendre(ANNA);
    expect(v.forcer('admin@vizyoagency.com').libre).toBe(true);
    expect(v.prendre(BRUNO).parMoi).toBe(true);
  });

  it('⚠️ l’evince l’apprend a son battement suivant : parMoi bascule a false', () => {
    // C'est le mecanisme de notification choisi — pas de push temps reel, mais le
    // battement existant. L'ecran de l'evince doit donc reagir a CE signal.
    v.prendre(ANNA);
    v.forcer('admin@vizyoagency.com');
    const apresEviction = v.prendre(BRUNO);
    expect(apresEviction.parMoi).toBe(true);
    expect(v.etat(ANNA.userId).parMoi).toBe(false);
  });
});

import { MapStyleService } from './map-style.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES FONDS DE CARTE NE DÉPENDENT PLUS DE CARTO
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mesuré en production le 2026-09-08 : les tuiles CARTO (« Plan clair », « Plan sombre » et
 * les libellés de l'hybride) portent le filigrane « API KEY REQUIRED » en travers de la carte.
 * Le service gratuit a fermé sans prévenir, et un fond qui s'affiche avec un avertissement
 * dessus n'est pas un fond. Les fonds gris d'Esri rendent le même service, sans clé.
 */
describe('MapStyleService — catalogue des fonds', () => {
  const svc = new MapStyleService();
  const urls = svc.catalog.flatMap((s) => [s.tilesUrl, s.overlayUrl ?? '']).filter(Boolean);

  it('🔴 aucun fond ne charge une tuile CARTO (filigrane « API KEY REQUIRED » depuis 2026-09)', () => {
    for (const url of urls) expect(url).not.toContain('cartocdn');
  });

  it('les six fonds gardent leur identifiant : la préférence est persistée par utilisateur', () => {
    expect(svc.catalog.map((s) => s.id)).toEqual(['osm', 'dark', 'light', 'satellite', 'hybrid', 'topo']);
  });

  it('les plans clair et sombre portent des libellés (calque de référence Esri)', () => {
    expect(svc.byId('light').overlayUrl).toContain('World_Light_Gray_Reference');
    expect(svc.byId('dark').overlayUrl).toContain('World_Dark_Gray_Reference');
  });

  it("un fond ne promet pas plus de zoom que son fournisseur n'en sert (Esri gris : 16)", () => {
    expect(svc.byId('light').maxZoom).toBeLessThanOrEqual(16);
    expect(svc.byId('dark').maxZoom).toBeLessThanOrEqual(16);
  });

  it('toutes les tuiles sont servies en https', () => {
    for (const url of urls) expect(url.startsWith('https://')).toBeTrue();
  });

  it('un identifiant inconnu retombe sur le plan OpenStreetMap', () => {
    expect(svc.byId('inconnu' as never).id).toBe('osm');
    expect(svc.byId(undefined).id).toBe('osm');
  });
});

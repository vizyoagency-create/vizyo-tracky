import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Filet anti « bug silencieux » sur les permissions.
 *
 * `PermissionsGuard` est OPT-IN par contrôleur : un `@RequirePermissions(...)` /
 * `@RequireVehiclePermission(...)` ne s'applique JAMAIS si le contrôleur (ou la
 * route) n'a pas aussi `PermissionsGuard` dans un `@UseGuards`. Sans filet, on
 * peut donc « oublier » le guard et croire une capacité protégée alors qu'elle
 * est ouverte.
 *
 * Ce test échoue BRUYAMMENT en CI si un contrôleur déclare une permission sans le
 * guard — ce qui garde la MATRICE comme source d'autorité, sans avoir à rendre
 * `PermissionsGuard` global (ce qui exigerait de globaliser l'auth = risque prod).
 */
function walkControllers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...walkControllers(p));
    } else if (p.endsWith('.controller.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('PermissionsGuard — couverture (anti silent-gap)', () => {
  const SRC = join(__dirname, '..');
  const controllers = walkControllers(SRC);

  it('trouve bien les contrôleurs de l\'API', () => {
    expect(controllers.length).toBeGreaterThan(20);
  });

  it('tout contrôleur avec @RequirePermissions liste PermissionsGuard dans un @UseGuards', () => {
    const offenders: string[] = [];
    for (const file of controllers) {
      const src = readFileSync(file, 'utf8');
      const declaresPerm = /@RequirePermissions|@RequireVehiclePermission/.test(src);
      if (!declaresPerm) continue;
      const guardsPerm = /@UseGuards\([^)]*PermissionsGuard/.test(src);
      if (!guardsPerm) offenders.push(file.slice(SRC.length));
    }
    // Si ce test casse : ajouter `PermissionsGuard` au @UseGuards du/des fichiers listés.
    expect(offenders).toEqual([]);
  });
});

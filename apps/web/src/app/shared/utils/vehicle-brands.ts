/**
 * Marques de véhicules connues + mapping vers leur logo.
 *
 * Le champ `Vehicle.brand` reste du TEXTE LIBRE en base (pas d'enum) : ce
 * fichier est l'unique source de vérité côté front pour (1) peupler la liste
 * déroulante de saisie et (2) retrouver le logo correspondant à un texte de
 * marque, en tolérant les variations de casse/accents/espaces
 * (« Citroën » / « citroen » / « CITROEN » → même logo).
 *
 * Les PNG sont servis depuis `public/logos/brands/<slug>.png`. Si le fichier
 * n'existe pas (marque inconnue ou logo pas encore exporté), `brandLogoUrl`
 * renvoie `null` et l'appelant retombe sur l'icône de type de véhicule.
 */

export interface VehicleBrand {
  /** Identifiant stable = nom du fichier logo (`<slug>.png`). */
  slug: string;
  /** Libellé affiché (liste déroulante, valeur stockée en base). */
  label: string;
  /**
   * Clés normalisées supplémentaires qui doivent pointer vers cette marque
   * (abréviations, ancien nom, variantes). Le `label` est toujours reconnu.
   */
  aliases?: string[];
  /**
   * Affiche le logo sur une pastille SOMBRE au lieu de blanche. Pour les logos
   * dont le tracé est clair/blanc (sinon invisibles sur fond blanc).
   */
  darkBg?: boolean;
}

/**
 * Normalise un texte de marque en clé de comparaison :
 * minuscules, sans accents, sans caractères non alphanumériques.
 *   « Mercedes-Benz » → « mercedesbenz », « Citroën » → « citroen »
 */
export function normalizeBrandKey(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritiques
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Liste des marques supportées. Trié alpha pour la liste déroulante.
 * Ajouter une marque = 1 ligne ici + le PNG dans `public/logos/brands/`.
 */
export const VEHICLE_BRANDS: VehicleBrand[] = [
  { slug: 'alfa-romeo', label: 'Alfa Romeo', aliases: ['alfa'] },
  { slug: 'audi', label: 'Audi' },
  // Badge modèle RS3 (tracé clair) → pastille sombre pour rester lisible.
  { slug: 'audi-rs3', label: 'Audi RS3', aliases: ['rs3', 'audirs3'], darkBg: true },
  { slug: 'bmw', label: 'BMW' },
  { slug: 'citroen', label: 'Citroën', aliases: ['citroen'] },
  { slug: 'dacia', label: 'Dacia' },
  { slug: 'ds', label: 'DS', darkBg: true },
  { slug: 'fiat', label: 'Fiat' },
  { slug: 'ford', label: 'Ford' },
  { slug: 'honda', label: 'Honda', darkBg: true },
  { slug: 'hyundai', label: 'Hyundai', darkBg: true },
  { slug: 'isuzu', label: 'Isuzu' },
  { slug: 'iveco', label: 'Iveco', darkBg: true },
  { slug: 'jeep', label: 'Jeep' },
  { slug: 'kia', label: 'Kia' },
  { slug: 'land-rover', label: 'Land Rover', aliases: ['landrover'] },
  { slug: 'man', label: 'MAN', darkBg: true },
  { slug: 'mazda', label: 'Mazda' },
  { slug: 'mercedes', label: 'Mercedes-Benz', aliases: ['mercedes', 'mercedesbenz', 'benz'], darkBg: true },
  { slug: 'mini', label: 'Mini' },
  { slug: 'mitsubishi', label: 'Mitsubishi' },
  { slug: 'nissan', label: 'Nissan' },
  { slug: 'opel', label: 'Opel' },
  { slug: 'peugeot', label: 'Peugeot' },
  { slug: 'porsche', label: 'Porsche' },
  { slug: 'renault', label: 'Renault' },
  { slug: 'renault-old', label: 'Renault (ancien)', aliases: ['renaultancien'] },
  { slug: 'renault-trucks', label: 'Renault Trucks', aliases: ['renaulttrucks'] },
  { slug: 'scania', label: 'Scania' },
  { slug: 'seat', label: 'SEAT' },
  { slug: 'skoda', label: 'Škoda', aliases: ['skoda'] },
  { slug: 'suzuki', label: 'Suzuki' },
  { slug: 'tesla', label: 'Tesla' },
  { slug: 'toyota', label: 'Toyota' },
  { slug: 'volkswagen', label: 'Volkswagen', aliases: ['vw'] },
  { slug: 'volvo', label: 'Volvo', darkBg: true },
];

/** Index normalisé (label + alias) → marque, construit une seule fois. */
const BRAND_INDEX: ReadonlyMap<string, VehicleBrand> = (() => {
  const map = new Map<string, VehicleBrand>();
  for (const b of VEHICLE_BRANDS) {
    map.set(normalizeBrandKey(b.label), b);
    map.set(normalizeBrandKey(b.slug), b);
    for (const a of b.aliases ?? []) map.set(normalizeBrandKey(a), b);
  }
  return map;
})();

/** Retrouve la marque connue correspondant à un texte libre, sinon `null`. */
export function findBrand(brand: string | null | undefined): VehicleBrand | null {
  if (!brand) return null;
  return BRAND_INDEX.get(normalizeBrandKey(brand)) ?? null;
}

/**
 * URL du logo pour un texte de marque libre, ou `null` si marque inconnue.
 * Chemin relatif (pas de `/` initial) pour rester compatible avec un
 * déploiement sous sous-chemin.
 */
export function brandLogoUrl(brand: string | null | undefined): string | null {
  const found = findBrand(brand);
  return found ? `logos/brands/${found.slug}.png` : null;
}

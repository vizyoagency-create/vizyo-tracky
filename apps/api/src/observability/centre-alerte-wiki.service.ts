import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';

/**
 * WIKI DU CENTRE D'ALERTE — sert `docs/centre-alerte/` à l'écran d'administration.
 *
 * ══ Pourquoi ce service existe ════════════════════════════════════════════════════════
 *
 * Le référentiel des erreurs, la procédure d'audit et les rapports quotidiens vivaient
 * uniquement dans le dépôt. Or ce sont exactement les documents qu'on veut sous les yeux
 * AU MOMENT où l'on regarde une alerte — pas dans un éditeur, sur une autre machine.
 * L'écran « Centre d'alertes » les expose donc en lecture.
 *
 * ══ Découverte AUTOMATIQUE, manifeste FACULTATIF ══════════════════════════════════════
 *
 * Les documents sont trouvés en parcourant le disque, pas en lisant une liste. Le
 * manifeste `app/wiki.json` n'ajoute que du confort (titre, ordre, description) et le
 * `passages` (journal de ce qui a été fait), qui lui ne se devine pas.
 *
 * C'est un choix délibéré : l'agent d'audit écrit un rapport chaque nuit. S'il fallait
 * qu'il déclare aussi le fichier pour qu'il s'affiche, un oubli rendrait le rapport
 * invisible — et personne ne s'en apercevrait. Ici, un fichier déposé apparaît ; un
 * manifeste périmé dégrade la présentation, jamais la disponibilité.
 *
 * ══ Traversée de chemin : impossible par construction ═════════════════════════════════
 *
 * Le `slug` reçu du client n'est JAMAIS concaténé à un chemin. Il sert uniquement de clé
 * de recherche dans la liste que ce service vient de construire lui-même ; le chemin
 * absolu ouvert provient de cette liste. Un `../../etc/passwd` ne correspond à aucune
 * entrée découverte : il tombe en 404 avant toute opération de fichier.
 */

/** Extensions servies. `.sql` est inclus : le collecteur fait partie de la documentation. */
const ALLOWED_EXTENSIONS = ['.md', '.sql'] as const;

/** Profondeur de parcours. `docs/centre-alerte/rapports/x.md` = 1 sous-dossier ; 3 est large. */
const MAX_DEPTH = 3;

/** Bornes de sûreté : un dossier de documentation ne doit jamais faire tomber l'API. */
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1_000_000;

export interface WikiDocumentMeta {
  slug: string;
  title: string;
  description: string | null;
  section: string;
  order: number;
  format: 'markdown' | 'sql';
  sizeBytes: number;
  updatedAt: string;
}

export interface WikiSection {
  key: string;
  label: string;
  description: string | null;
  documents: WikiDocumentMeta[];
}

interface ManifestDocument {
  slug?: string;
  title?: string;
  description?: string;
  section?: string;
  order?: number;
}

interface ManifestSection {
  key?: string;
  label?: string;
  description?: string;
  order?: number;
}

interface Manifest {
  title?: string;
  intro?: string;
  updatedAt?: string;
  sections?: ManifestSection[];
  documents?: ManifestDocument[];
  /** État de chaque famille d'erreur : quand, quoi, quoi faire. Traversé tel quel. */
  fiches?: unknown[];
  /** Barème des statuts (libellé, puce, ordre) — décrit dans le manifeste, pas dans le code. */
  statuts?: unknown[];
  passages?: unknown[];
}

@Injectable()
export class CentreAlerteWikiService {
  private readonly logger = new Logger('CentreAlerteWiki');

  /**
   * Emplacements essayés dans l'ordre, le premier qui existe gagne.
   *
   * En développement comme dans le conteneur, `process.cwd()` vaut `<racine>/apps/api`
   * (WORKDIR du Dockerfile), donc `../../docs/centre-alerte` couvre les deux. Les autres
   * candidats sont des filets : lancement depuis la racine du dépôt, ou surcharge
   * explicite par variable d'environnement.
   */
  private candidateRoots(): string[] {
    const fromEnv = process.env['CENTRE_ALERTE_DOCS_DIR'];
    // Surcharge EXCLUSIVE : si quelqu'un désigne explicitement un dossier, on n'ira pas en
    // chercher un autre derrière son dos. Un repli silencieux transformerait une erreur de
    // configuration en « ça marche, mais pas avec les fichiers que vous croyez » — le genre
    // de panne qu'on ne découvre qu'en lisant un document périmé.
    if (fromEnv) return [fromEnv];
    return [
      resolve(process.cwd(), '..', '..', 'docs', 'centre-alerte'),
      resolve(process.cwd(), 'docs', 'centre-alerte'),
      '/app/docs/centre-alerte',
    ];
  }

  private async resolveRoot(): Promise<string | null> {
    for (const candidate of this.candidateRoots()) {
      try {
        const info = await stat(candidate);
        if (info.isDirectory()) return candidate;
      } catch {
        /* candidat suivant */
      }
    }
    return null;
  }

  private async readManifest(root: string): Promise<Manifest> {
    try {
      const raw = await readFile(join(root, 'app', 'wiki.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : {};
    } catch {
      // Manifeste absent ou illisible : la découverte disque suffit à servir les documents.
      // On ne fait pas échouer l'écran pour un fichier de confort.
      return {};
    }
  }

  /** Parcours borné du dossier. Retourne des chemins RELATIFS en séparateurs POSIX. */
  private async walk(root: string, sub = '', depth = 0): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    let entries;
    try {
      entries = await readdir(join(root, sub), { withFileTypes: true });
    } catch {
      return [];
    }

    const found: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relative = sub ? posix.join(sub, entry.name) : entry.name;

      if (entry.isDirectory()) {
        found.push(...(await this.walk(root, relative, depth + 1)));
      } else if (ALLOWED_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        found.push(relative);
      }
      if (found.length >= MAX_FILES) break;
    }
    return found;
  }

  /** Titre de repli quand le manifeste ne dit rien — un rapport doit rester lisible. */
  private deriveTitle(slug: string): string {
    const name = slug.split('/').pop() ?? slug;
    const bare = name.replace(/\.(md|sql)$/i, '');
    const isoDate = /^(\d{4}-\d{2}-\d{2})$/.exec(bare);
    if (isoDate) return `Audit du ${isoDate[1]}`;
    const datePrefix = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(bare);
    if (datePrefix) return `${datePrefix[1]} — ${datePrefix[2].replace(/-/g, ' ')}`;
    return bare.replace(/[-_]/g, ' ');
  }

  /** Section de repli : tout ce qui est dans `rapports/` en est un ; le reste est un document. */
  private deriveSection(slug: string): string {
    const folder = slug.includes('/') ? slug.split('/')[0] : '';
    return folder === 'rapports' ? 'rapports' : 'guide';
  }

  /** Construit la liste complète, manifeste appliqué par-dessus la découverte disque. */
  private async collect(): Promise<{
    root: string | null;
    manifest: Manifest;
    documents: WikiDocumentMeta[];
    /** Chemins absolus, construits ICI et jamais depuis une entrée utilisateur. */
    pathsBySlug: Map<string, string>;
  }> {
    const root = await this.resolveRoot();
    if (!root) {
      this.logger.warn(
        `Dossier de documentation introuvable. Essayés : ${this.candidateRoots().join(' | ')}`,
      );
      return { root: null, manifest: {}, documents: [], pathsBySlug: new Map() };
    }

    const [manifest, slugs] = await Promise.all([this.readManifest(root), this.walk(root)]);
    const declared = new Map<string, ManifestDocument>(
      (manifest.documents ?? [])
        .filter((d): d is ManifestDocument & { slug: string } => typeof d.slug === 'string')
        .map((d) => [d.slug, d]),
    );

    const documents: WikiDocumentMeta[] = [];
    const pathsBySlug = new Map<string, string>();

    for (const slug of slugs) {
      const absolute = join(root, ...slug.split('/'));
      let sizeBytes = 0;
      let updatedAt = new Date(0).toISOString();
      try {
        const info = await stat(absolute);
        sizeBytes = info.size;
        updatedAt = info.mtime.toISOString();
      } catch {
        continue; // disparu entre le parcours et le stat : on l'ignore
      }

      const meta = declared.get(slug);
      documents.push({
        slug,
        title: meta?.title ?? this.deriveTitle(slug),
        description: meta?.description ?? null,
        section: meta?.section ?? this.deriveSection(slug),
        order: meta?.order ?? 999,
        format: slug.toLowerCase().endsWith('.sql') ? 'sql' : 'markdown',
        sizeBytes,
        updatedAt,
      });
      pathsBySlug.set(slug, absolute);
    }

    return { root, manifest, documents, pathsBySlug };
  }

  /** Index complet pour l'écran : sections ordonnées, documents triés, journal des passages. */
  async index(): Promise<{
    available: boolean;
    title: string;
    intro: string | null;
    updatedAt: string | null;
    sections: WikiSection[];
    fiches: unknown[];
    statuts: unknown[];
    passages: unknown[];
    documentCount: number;
  }> {
    const { root, manifest, documents } = await this.collect();

    const declaredSections = manifest.sections ?? [];
    const sectionOrder = new Map<string, number>(
      declaredSections
        .filter((s): s is ManifestSection & { key: string } => typeof s.key === 'string')
        .map((s, i) => [s.key, s.order ?? i]),
    );
    const sectionMeta = new Map<string, ManifestSection>(
      declaredSections
        .filter((s): s is ManifestSection & { key: string } => typeof s.key === 'string')
        .map((s) => [s.key, s]),
    );

    const grouped = new Map<string, WikiDocumentMeta[]>();
    for (const doc of documents) {
      const list = grouped.get(doc.section) ?? [];
      list.push(doc);
      grouped.set(doc.section, list);
    }

    const sections: WikiSection[] = [...grouped.entries()]
      .map(([key, docs]) => ({
        key,
        label: sectionMeta.get(key)?.label ?? key,
        description: sectionMeta.get(key)?.description ?? null,
        documents: docs.sort((a, b) =>
          // Les rapports se trient par DATE décroissante : le nom de fichier commence par
          // l'ISO, donc l'ordre alphabétique inverse donne le plus récent en premier — et
          // ça reste vrai pour un rapport qu'aucun manifeste ne déclare.
          key === 'rapports'
            ? b.slug.localeCompare(a.slug)
            : a.order - b.order || a.title.localeCompare(b.title),
        ),
      }))
      .sort(
        (a, b) =>
          (sectionOrder.get(a.key) ?? 999) - (sectionOrder.get(b.key) ?? 999) ||
          a.label.localeCompare(b.label),
      );

    return {
      available: root !== null,
      title: manifest.title ?? "Centre d'alerte — documentation",
      intro: manifest.intro ?? null,
      updatedAt: manifest.updatedAt ?? null,
      sections,
      // Traversés tels quels : leur forme est décrite par le manifeste, pas par le serveur.
      // Le jour où l'on ajoute un champ à une fiche, l'écran le reçoit sans redéploiement
      // de l'API — ce sont des données de documentation, pas un contrat métier.
      fiches: Array.isArray(manifest.fiches) ? manifest.fiches : [],
      statuts: Array.isArray(manifest.statuts) ? manifest.statuts : [],
      passages: Array.isArray(manifest.passages) ? manifest.passages : [],
      documentCount: documents.length,
    };
  }

  /**
   * Contenu d'un document.
   *
   * ⚠️ `slug` ne sert QU'À CHERCHER dans `pathsBySlug`, construite juste au-dessus par le
   * parcours disque. Aucun chemin n'est dérivé de l'entrée client : un slug inconnu — donc
   * toute tentative de traversée — sort en 404 avant le moindre accès fichier.
   */
  async document(slug: string): Promise<{
    slug: string;
    title: string;
    format: 'markdown' | 'sql';
    updatedAt: string;
    content: string;
    truncated: boolean;
  }> {
    const { documents, pathsBySlug } = await this.collect();
    const meta = documents.find((d) => d.slug === slug);
    const absolute = pathsBySlug.get(slug);
    if (!meta || !absolute) {
      throw new NotFoundException('Document introuvable dans la documentation du centre d\'alerte');
    }

    const raw = await readFile(absolute, 'utf8');
    const truncated = raw.length > MAX_FILE_BYTES;

    return {
      slug: meta.slug,
      title: meta.title,
      format: meta.format,
      updatedAt: meta.updatedAt,
      content: truncated ? `${raw.slice(0, MAX_FILE_BYTES)}\n\n…(document tronqué)` : raw,
      truncated,
    };
  }

  /** Exposé pour le diagnostic : où le service est allé chercher, et ce qu'il a retenu. */
  async debugRoots(): Promise<{ candidates: string[]; resolved: string | null; separator: string }> {
    return {
      candidates: this.candidateRoots(),
      resolved: await this.resolveRoot(),
      separator: sep,
    };
  }
}

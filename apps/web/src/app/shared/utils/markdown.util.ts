/**
 * RENDU MARKDOWN — minimal, sans dépendance, et sûr par construction.
 *
 * ══ Pourquoi maison ═══════════════════════════════════════════════════════════════════
 *
 * L'application n'embarque aucune bibliothèque markdown, et l'unique besoin est d'afficher
 * la documentation du centre d'alerte : titres, tableaux, listes, blocs de code, liens.
 * Ajouter `marked` + `dompurify` au bundle pour ça coûterait plus que ce fichier.
 *
 * ══ La règle de sûreté, en une phrase ═════════════════════════════════════════════════
 *
 *   **On échappe AVANT de transformer, jamais après.**
 *
 * Chaque fragment de texte qui finit dans la sortie passe par {@link escapeHtml}. Les
 * seules balises présentes dans le résultat sont donc celles que ce fichier a lui-même
 * écrites. Un document contenant `<script>` produit `&lt;script&gt;` — du texte affiché,
 * pas du code exécuté.
 *
 * L'ordre inverse (transformer puis échapper) casserait les balises générées ; l'ordre
 * « transformer sans échapper » laisserait passer le HTML du document. Les deux sont des
 * erreurs classiques ; c'est pour ça que la règle est écrite ici et pas seulement sous-entendue.
 *
 * Deux protections s'ajoutent :
 *   - les URL de liens sont filtrées par schéma — `javascript:` est refusé et rendu en
 *     texte brut (cf. `safeHref`) ;
 *   - le binding `[innerHTML]` d'Angular repasse de toute façon par son sanitizer. C'est
 *     une ceinture en plus des bretelles, pas la protection principale.
 */

/** Échappe tout ce qui pourrait être interprété comme du balisage. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Identifiant d'ancre à la façon de GitHub — `## TRK-001` devient `trk-001`, ce qui rend
 * les liens internes du référentiel (`[TRK-001](#trk-001)`) cliquables tels quels.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritiques décomposés par NFD
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export interface MarkdownOptions {
  /**
   * Dossier du document rendu (`''` à la racine, `'rapports'` pour un rapport). Sert à
   * résoudre les liens relatifs vers d'autres documents, pour que le wiki se parcoure
   * sans quitter la fenêtre.
   */
  baseDir?: string;
}

/** Résout `./x.md`, `../x.md` ou `x.md` depuis le dossier courant. */
function resolveDocHref(baseDir: string, href: string): string {
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const segment of href.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * Ne laisse passer qu'un schéma inoffensif. Tout le reste (`javascript:`, `data:`…)
 * renvoie `null`, et l'appelant rend alors le libellé en texte.
 */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  // Chemin nu vers un document du wiki (`REFERENCE-ERREURS.md`, `rapports/x.md`).
  if (/^[\w.-]+(\/[\w.-]+)*\.(md|sql)(#[\w-]*)?$/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Jeton de remplacement du code en ligne.
 *
 * ⚠️ Il commence par `<` **volontairement** : l'extraction a lieu APRÈS l'échappement,
 * donc le texte ne contient plus le moindre `<` à ce stade. Toute collision est
 * impossible par construction — là où un caractère de contrôle ou une suite de lettres
 * aurait pu apparaître dans un document réel. La restauration cible `<CODE:n>` très
 * précisément, sans risque de croiser un `<strong>` ou un `<a …>` produits entre-temps.
 */
const codeToken = (index: number): string => `<CODE:${index}>`;
const CODE_TOKEN_RE = /<CODE:(\d+)>/g;

/**
 * Formatage en ligne : code, gras, italique, barré, liens.
 * Le texte est échappé à la PREMIÈRE ligne — tout ce qui suit ne manipule que du sûr.
 */
function renderInline(raw: string, baseDir: string): string {
  // 1. Échappement — la frontière. Après cette ligne, plus aucun balisage du document.
  const escaped = escapeHtml(raw);

  // 2. Sortir le code en ligne : sans ça, un `**` à l'intérieur d'un `code` passerait en gras.
  //    Les accents graves ne sont pas touchés par l'échappement, la détection reste fiable.
  const codeSpans: string[] = [];
  let html = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return codeToken(codeSpans.length - 1);
  });

  // 3. Liens. Le libellé est déjà échappé ; l'URL est filtrée puis ré-échappée.
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match: string, label: string, href: string) => {
      // L'échappement a transformé `&` en `&amp;` dans l'URL : on rétablit pour l'analyse.
      const decoded = href
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
      const safe = safeHref(decoded);
      if (!safe) return label; // schéma refusé → on garde le texte, on jette le lien

      // Lien vers un autre document du wiki : navigation interne, sans quitter la fenêtre.
      if (/\.(md|sql)(#.*)?$/i.test(safe) && !/^https?:\/\//i.test(safe)) {
        const [path, anchor] = safe.split('#');
        const slug = resolveDocHref(baseDir, path);
        return `<a href="#" data-wiki-doc="${escapeHtml(slug)}"${
          anchor ? ` data-wiki-anchor="${escapeHtml(anchor)}"` : ''
        }>${label}</a>`;
      }
      // Ancre interne au document courant.
      if (safe.startsWith('#')) {
        return `<a href="#" data-wiki-anchor="${escapeHtml(safe.slice(1))}">${label}</a>`;
      }
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  );

  // 4. Emphase. `**` avant `*`, sinon le gras serait mangé par l'italique.
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 5. Réinjection du code en ligne (contenu déjà échappé à l'étape 1).
  return html.replace(
    CODE_TOKEN_RE,
    (_match, index: string) => `<code>${codeSpans[Number(index)] ?? ''}</code>`,
  );
}

/** Une ligne `| --- | :-: |` : le séparateur qui fait d'un bloc de `|` un tableau. */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Rend un document markdown en HTML.
 *
 * Couvre ce que la documentation du centre d'alerte utilise réellement : titres, listes,
 * tableaux, blocs de code, citations, filets, et le formatage en ligne. Volontairement pas
 * plus — une construction non gérée s'affiche en texte, jamais en balisage inattendu.
 */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const baseDir = options.baseDir ?? '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    out.push(`<p>${renderInline(paragraph.join(' '), baseDir)}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // ── Bloc de code délimité ────────────────────────────────────────────────────────
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const language = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consomme la clôture
      out.push(
        `<pre data-lang="${escapeHtml(language)}"><code>${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // ── Ligne vide ───────────────────────────────────────────────────────────────────
    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    // ── Filet ────────────────────────────────────────────────────────────────────────
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      out.push('<hr />');
      i++;
      continue;
    }

    // ── Titre ────────────────────────────────────────────────────────────────────────
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].trim();
      // L'ancre se calcule sur le texte BRUT (avant formatage) : c'est ce que fait GitHub,
      // donc `[TRK-001](#trk-001)` retombe bien sur `## TRK-001`.
      out.push(
        `<h${level} id="${escapeHtml(slugifyHeading(text))}">${renderInline(text, baseDir)}</h${level}>`,
      );
      i++;
      continue;
    }

    // ── Tableau ──────────────────────────────────────────────────────────────────────
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      i += 2; // en-tête + séparateur
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const head = header.map((c) => `<th>${renderInline(c, baseDir)}</th>`).join('');
      const body = rows
        .map(
          (cells) =>
            `<tr>${cells.map((c) => `<td>${renderInline(c, baseDir)}</td>`).join('')}</tr>`,
        )
        .join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // ── Citation ─────────────────────────────────────────────────────────────────────
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      // Rendu récursif : une citation peut contenir un titre, une liste ou un tableau.
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'), options)}</blockquote>`);
      continue;
    }

    // ── Listes ───────────────────────────────────────────────────────────────────────
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const b = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        const n = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]);
        const match = ordered ? n : b;
        if (!match) break;
        items.push(`<li>${renderInline(match[1], baseDir)}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // ── Texte courant ────────────────────────────────────────────────────────────────
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  return out.join('\n');
}

/** Un fichier non-markdown (le collecteur SQL) : bloc de code, échappé, rien d'autre. */
export function renderPlainCode(source: string, language: string): string {
  return `<pre data-lang="${escapeHtml(language)}"><code>${escapeHtml(source)}</code></pre>`;
}

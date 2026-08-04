import { escapeHtml, renderMarkdown, renderPlainCode, slugifyHeading } from './markdown.util';

/**
 * Ces tests VERROUILLENT le raisonnement qui autorise `bypassSecurityTrustHtml` dans
 * `centre-alerte-wiki.component.ts`. Le rendu contourne le sanitizer d'Angular ; il ne
 * peut le faire que parce que sa sortie ne contient jamais de balisage issu du document.
 *
 * ⚠️ Si l'un de ces tests casse, ce n'est pas le test qu'il faut ajuster : c'est que le
 * rendu est devenu injectable, et le contournement n'est plus légitime.
 */
/**
 * Analyse la sortie dans un document INERTE (`DOMParser`) : rien ne s'y charge et rien ne
 * s'y exécute. On interroge ensuite l'arbre réel plutôt que la chaîne.
 *
 * C'est la seule façon honnête de tester « est-ce injectable ? ». Chercher `onerror=` dans
 * le texte donne un faux échec — la sortie échappée contient légitimement ces caractères
 * en tant que TEXTE AFFICHÉ (`&lt;img src=x onerror=&quot;…`), ce qui est exactement le
 * comportement voulu. Ce qui compte n'est pas la présence de la sous-chaîne, c'est
 * l'absence d'ÉLÉMENT correspondant dans l'arbre.
 */
function parsed(html: string): Document {
  return new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
}

/** Un attribut de gestionnaire d'évènement a-t-il survécu quelque part dans l'arbre ? */
function hasEventHandlerAttribute(doc: Document): boolean {
  return [...doc.querySelectorAll('*')].some((el) =>
    [...el.attributes].some((a) => a.name.toLowerCase().startsWith('on')),
  );
}

describe('markdown.util — sûreté', () => {
  it('ne produit aucun élément script pour une balise script du document', () => {
    const html = renderMarkdown('Bonjour <script>alert(1)</script> fin');
    const doc = parsed(html);
    expect(doc.querySelectorAll('script').length).toBe(0);
    // Le texte, lui, doit rester lisible à l'écran.
    expect(doc.getElementById('root')?.textContent).toContain('<script>alert(1)</script>');
  });

  it('ne produit ni élément img ni gestionnaire d\'évènement', () => {
    const doc = parsed(renderMarkdown('<img src=x onerror="alert(1)">'));
    expect(doc.querySelectorAll('img').length).toBe(0);
    expect(hasEventHandlerAttribute(doc)).toBe(false);
  });

  it('ne produit aucun élément inattendu sur une charge composite', () => {
    const doc = parsed(
      renderMarkdown(
        ['<iframe src="//evil"></iframe>', '<svg onload=alert(1)>', '<a href="javascript:alert(1)">x</a>'].join('\n'),
      ),
    );
    expect(doc.querySelectorAll('iframe, svg, script, img, object, embed').length).toBe(0);
    expect(hasEventHandlerAttribute(doc)).toBe(false);
    expect([...doc.querySelectorAll('a')].some((a) => (a.getAttribute('href') ?? '').includes('javascript:')))
      .toBe(false);
  });

  it('refuse une URL `javascript:` et retombe sur le texte du lien', () => {
    const html = renderMarkdown('[clique ici](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('clique ici');
  });

  it('refuse une URL `data:`', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('<a ');
  });

  it('échappe le contenu d\'un bloc de code délimité', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('<pre');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('échappe le contenu d\'un fichier non-markdown', () => {
    const html = renderPlainCode('SELECT \'<b>\' FROM t;', 'sql');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('ne laisse pas un document fabriquer le jeton interne de code', () => {
    // Le jeton commence par `<`, or l'échappement a lieu AVANT son insertion : un
    // document qui écrit littéralement `<CODE:0>` doit ressortir en texte, jamais
    // devenir un élément `<code>` surgi de nulle part.
    const html = renderMarkdown('texte <CODE:0> texte');
    expect(html).toContain('&lt;CODE:0&gt;');
    expect(html).not.toContain('<code>');
  });

  it('échappe les guillemets et apostrophes', () => {
    expect(escapeHtml(`"a" 'b' & <c>`)).toBe('&quot;a&quot; &#39;b&#39; &amp; &lt;c&gt;');
  });
});

describe('markdown.util — rendu', () => {
  it('rend un titre avec une ancre à la GitHub', () => {
    expect(renderMarkdown('## TRK-001')).toContain('<h2 id="trk-001">');
    expect(slugifyHeading('Journal des passages')).toBe('journal-des-passages');
  });

  it('produit une ancre stable pour un titre accentué et ponctué', () => {
    // Deux écarts ASSUMÉS avec GitHub : les accents sont retirés et les espaces multiples
    // fusionnés (GitHub garderait « étape-1--garde »). Sans conséquence ici — toutes les
    // ancres de la documentation du centre d'alerte sont des identifiants ASCII simples
    // (`#trk-008`), et c'est la STABILITÉ qui compte, pas la parité exacte.
    expect(slugifyHeading('Étape 1 — Garde anti-doublon')).toBe('etape-1-garde-anti-doublon');
  });

  it('rend un tableau avec en-tête et corps', () => {
    const html = renderMarkdown(['| Source | n |', '|---|---|', '| gps | 5 |'].join('\n'));
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Source</th>');
    expect(html).toContain('<td>gps</td>');
    expect(html).toContain('<td>5</td>');
  });

  it('ne prend pas une ligne contenant un tube pour un tableau sans séparateur', () => {
    const html = renderMarkdown('a | b\nc | d');
    expect(html).not.toContain('<table>');
  });

  it('rend le gras, l\'italique et le code en ligne', () => {
    const html = renderMarkdown('**gras** et *italique* et `du code`');
    expect(html).toContain('<strong>gras</strong>');
    expect(html).toContain('<em>italique</em>');
    expect(html).toContain('<code>du code</code>');
  });

  it('ne met pas en gras ce qui est à l\'intérieur d\'un code en ligne', () => {
    const html = renderMarkdown('`**pas du gras**`');
    expect(html).toContain('<code>**pas du gras**</code>');
    expect(html).not.toContain('<strong>');
  });

  it('rend les listes à puces et numérotées', () => {
    expect(renderMarkdown('- un\n- deux')).toContain('<ul><li>un</li><li>deux</li></ul>');
    expect(renderMarkdown('1. un\n2. deux')).toContain('<ol><li>un</li><li>deux</li></ol>');
  });

  it('rend une citation et un filet', () => {
    expect(renderMarkdown('> note')).toContain('<blockquote>');
    expect(renderMarkdown('---')).toContain('<hr />');
  });

  it('marque un lien externe pour ouverture dans un nouvel onglet', () => {
    const html = renderMarkdown('[docs](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('transforme un lien vers un autre document en navigation interne', () => {
    const html = renderMarkdown('[Référentiel](./REFERENCE-ERREURS.md)');
    expect(html).toContain('data-wiki-doc="REFERENCE-ERREURS.md"');
    expect(html).not.toContain('target="_blank"');
  });

  it('résout un lien relatif depuis le dossier du document courant', () => {
    const html = renderMarkdown('[retour](../REFERENCE-ERREURS.md)', { baseDir: 'rapports' });
    expect(html).toContain('data-wiki-doc="REFERENCE-ERREURS.md"');
  });

  it('résout un lien frère depuis un sous-dossier', () => {
    const html = renderMarkdown('[autre](2026-08-04.md)', { baseDir: 'rapports' });
    expect(html).toContain('data-wiki-doc="rapports/2026-08-04.md"');
  });

  it('transforme une ancre interne en saut dans le document', () => {
    const html = renderMarkdown('[TRK-008](#trk-008)');
    expect(html).toContain('data-wiki-anchor="trk-008"');
  });

  it('porte l\'ancre quand le lien vise une section d\'un autre document', () => {
    const html = renderMarkdown('[voir](./REFERENCE-ERREURS.md#trk-008)');
    expect(html).toContain('data-wiki-doc="REFERENCE-ERREURS.md"');
    expect(html).toContain('data-wiki-anchor="trk-008"');
  });
});

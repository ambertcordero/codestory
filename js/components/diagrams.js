/* CodeStory - components/diagrams.js
   Reusable, dependency-free renderers for Story visuals: a small syntax
   highlighter, dark code panels with real line numbers, and a layered SVG
   graph used for architecture, module, call and data-flow diagrams.
   Every string is HTML-escaped before it reaches the page. */

(function () {
  'use strict';

  const e = (value) => CodeStoryUI.escapeHtml(value);

  /* ------------------------------------------------------------------ */
  /* Syntax highlighting                                                 */
  /* ------------------------------------------------------------------ */

  const KEYWORDS = {
    js: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
    py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
  };
  const KEYWORD_SETS = {};
  Object.keys(KEYWORDS).forEach((key) => { KEYWORD_SETS[key] = new Set(KEYWORDS[key].split(' ')); });

  function languageFor(path) {
    const ext = String(path || '').toLowerCase().split('.').pop();
    if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'java', 'cs', 'go', 'rs', 'php'].indexOf(ext) !== -1) return 'js';
    if (ext === 'py') return 'py';
    if (ext === 'html' || ext === 'htm' || ext === 'xml') return 'html';
    if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css';
    return 'plain';
  }

  function span(cls, text) {
    return '<span class="tok-' + cls + '">' + e(text) + '</span>';
  }

  function highlightLine(line, lang) {
    if (lang === 'plain') return e(line);
    if (lang === 'html') {
      return e(line).replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tok-tag">$2</span>')
        .replace(/([\w-]+)=(&quot;[^&]*&quot;)/g, '<span class="tok-attr">$1</span>=<span class="tok-string">$2</span>');
    }
    const keywords = KEYWORD_SETS[lang] || new Set();
    const pattern = lang === 'css'
      ? /(\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|vh|vw)?\b)|([.#]?[A-Za-z_-][\w-]*)/g
      : /(\/\/.*$|#.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
    let out = '';
    let last = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      out += e(line.slice(last, match.index));
      if (match[1] && (lang !== 'js' || match[1][0] !== '#')) out += span('comment', match[1]);
      else if (match[1]) out += e(match[1]);
      else if (match[2]) out += span('string', match[2]);
      else if (match[3]) out += span('number', match[3]);
      else if (match[4]) {
        const word = match[4];
        const next = line.slice(match.index + word.length).match(/^\s*\(/);
        if (keywords.has(word)) out += span('keyword', word);
        else if (next && lang !== 'css') out += span('fn', word);
        else out += e(word);
      }
      last = match.index + match[0].length;
    }
    return out + e(line.slice(last));
  }

  /* ------------------------------------------------------------------ */
  /* Code panel                                                          */
  /* ------------------------------------------------------------------ */

  /* options: { file, line, symbol, text, truncated, highlights: {lineNo: note}, caption } */
  function codePanel(options) {
    const text = String(options.text || '');
    const lines = text.split('\n');
    const start = Number.isInteger(options.line) && options.line > 0 ? options.line : null;
    const lang = languageFor(options.file);
    const highlights = options.highlights || {};
    const rows = lines.map((line, index) => {
      const number = start ? start + index : null;
      const note = number && highlights[number];
      return '<span class="code-row' + (note ? ' is-highlighted' : '') + '"' +
        (note ? ' title="' + e(note) + '"' : '') + '>' +
        '<span class="code-gutter" aria-hidden="true">' + (number || '') + '</span>' +
        '<span class="code-text">' + (highlightLine(line, lang) || ' ') + '</span>' +
        (note ? '<span class="code-note">' + e(note) + '</span>' : '') +
        '</span>';
    }).join('');
    const location = e(options.file || 'Source') + (start ? ':' + start : '');
    return (
      '<figure class="code-panel-visual">' +
        '<figcaption class="code-panel-head">' +
          '<span class="code-panel-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
          '<code class="code-panel-file">' + location + '</code>' +
          (options.symbol ? '<span class="code-panel-symbol">' + e(options.symbol) + '</span>' : '') +
        '</figcaption>' +
        '<pre class="code-panel-body"><code>' + rows + '</code></pre>' +
        (options.truncated ? '<p class="code-panel-foot">Excerpt continues in the source file.</p>' : '') +
        (options.caption ? '<p class="code-panel-foot">' + e(options.caption) + '</p>' : '') +
      '</figure>'
    );
  }

  /* ------------------------------------------------------------------ */
  /* Layered SVG graph                                                   */
  /* ------------------------------------------------------------------ */

  let graphCounter = 0;

  function truncate(text, max) {
    const value = String(text || '');
    return value.length <= max ? value : value.slice(0, max - 1) + '\u2026';
  }

  function midpoint(p0, p1, p2, p3) {
    return {
      x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
      y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
    };
  }

  /* spec: { nodes:[{id,label,sub,kind,layer,emphasis,ref,refKind}], edges:[{from,to,label,title,dashed,emphasis}],
             captions:[...], vertical:bool, ariaLabel } */
  function layeredGraph(spec) {
    const vertical = Boolean(spec.vertical);
    const W = vertical ? 168 : 184;
    const H = 58;
    const GAP_LAYER = vertical ? 74 : 96;
    const GAP_NODE = vertical ? 18 : 22;
    const PAD = 18;
    const CAPTION = spec.captions && spec.captions.length ? 28 : 0;
    const id = 'dg' + (++graphCounter);

    const layers = [];
    spec.nodes.forEach((node) => {
      const layer = Math.max(0, node.layer || 0);
      (layers[layer] = layers[layer] || []).push(node);
    });
    const counts = layers.map((layer) => (layer ? layer.length : 0));
    const maxCount = Math.max(1, ...counts);
    const span = maxCount * (vertical ? W : H) + (maxCount - 1) * GAP_NODE;
    const positions = {};
    layers.forEach((layer, li) => {
      if (!layer) return;
      const own = layer.length * (vertical ? W : H) + (layer.length - 1) * GAP_NODE;
      const offset = (span - own) / 2;
      layer.forEach((node, ni) => {
        const along = offset + ni * ((vertical ? W : H) + GAP_NODE);
        const across = li * ((vertical ? H : W) + GAP_LAYER);
        positions[node.id] = vertical
          ? { x: PAD + along, y: PAD + CAPTION + across }
          : { x: PAD + across, y: PAD + CAPTION + along };
      });
    });
    const layerCount = layers.length;
    const width = vertical ? span + PAD * 2 : PAD * 2 + layerCount * W + (layerCount - 1) * GAP_LAYER;
    const height = vertical
      ? PAD * 2 + CAPTION + layerCount * H + (layerCount - 1) * GAP_LAYER
      : PAD * 2 + CAPTION + span;

    const captions = (spec.captions || []).map((caption, li) => {
      if (!caption || !layers[li]) return '';
      return vertical
        ? '<text class="dg-caption" x="' + PAD + '" y="' + (PAD + CAPTION + li * (H + GAP_LAYER) - 8) + '">' + e(caption) + '</text>'
        : '<text class="dg-caption" x="' + (PAD + li * (W + GAP_LAYER)) + '" y="' + (PAD + 12) + '">' + e(caption) + '</text>';
    }).join('');

    const edgeMarkup = [];
    const labelMarkup = [];
    spec.edges.forEach((edge) => {
      const a = positions[edge.from];
      const b = positions[edge.to];
      if (!a || !b) return;
      let p0, p3, p1, p2;
      if (vertical) {
        const down = b.y > a.y;
        const same = Math.abs(b.y - a.y) < 1;
        p0 = { x: a.x + W / 2, y: same ? a.y + H : (down ? a.y + H : a.y) };
        p3 = { x: b.x + W / 2, y: same ? b.y + H : (down ? b.y : b.y + H) };
        const k = same ? 40 : Math.max(24, Math.abs(p3.y - p0.y) / 2);
        p1 = { x: p0.x, y: p0.y + (down || same ? k : -k) };
        p2 = { x: p3.x, y: p3.y + (down ? -k : k) };
      } else {
        const forward = b.x > a.x;
        const same = Math.abs(b.x - a.x) < 1;
        p0 = { x: same ? a.x + W : (forward ? a.x + W : a.x), y: a.y + H / 2 };
        p3 = { x: same ? b.x + W : (forward ? b.x : b.x + W), y: b.y + H / 2 };
        const k = same ? 44 : Math.max(30, Math.abs(p3.x - p0.x) / 2);
        p1 = { x: p0.x + (forward || same ? k : -k), y: p0.y };
        p2 = { x: p3.x + (forward ? -k : k), y: p3.y };
      }
      const cls = 'dg-edge' + (edge.dashed ? ' is-dashed' : '') + (edge.emphasis ? ' is-' + edge.emphasis : '');
      edgeMarkup.push('<path class="' + cls + '" d="M' + p0.x + ' ' + p0.y + ' C' + p1.x + ' ' + p1.y + ', ' +
        p2.x + ' ' + p2.y + ', ' + p3.x + ' ' + p3.y + '" marker-end="url(#' + id + '-arrow)">' +
        (edge.title ? '<title>' + e(edge.title) + '</title>' : '') + '</path>');
      if (edge.label) {
        const m = midpoint(p0, p1, p2, p3);
        const label = truncate(edge.label, 26);
        const lw = label.length * 6.1 + 12;
        labelMarkup.push('<g class="dg-edge-label' + (edge.emphasis ? ' is-' + edge.emphasis : '') + '">' +
          (edge.title ? '<title>' + e(edge.title) + '</title>' : '') +
          '<rect x="' + (m.x - lw / 2) + '" y="' + (m.y - 9) + '" width="' + lw + '" height="18" rx="9" />' +
          '<text x="' + m.x + '" y="' + (m.y + 3.5) + '" text-anchor="middle">' + e(label) + '</text></g>');
      }
    });

    const nodeMarkup = spec.nodes.map((node) => {
      const p = positions[node.id];
      const interactive = Boolean(node.ref);
      const maxChars = Math.floor((W - 26) / 7.2);
      return '<g class="dg-node kind-' + e(node.kind || 'file') + (node.emphasis ? ' is-' + node.emphasis : '') + '"' +
        (interactive ? ' role="button" tabindex="0" data-visual-ref="' + e(node.ref) + '" data-ref-kind="' + e(node.refKind || 'symbol') + '"' : '') +
        ' aria-label="' + e(node.label + (node.sub ? ', ' + node.sub : '')) + '">' +
        '<title>' + e(node.label + (node.sub ? ' \u2014 ' + node.sub : '')) + '</title>' +
        '<rect class="dg-node-card" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="10" />' +
        '<rect class="dg-node-stripe" x="' + p.x + '" y="' + (p.y + 10) + '" width="4" height="' + (H - 20) + '" rx="2" />' +
        '<text class="dg-node-title" x="' + (p.x + 16) + '" y="' + (p.y + 25) + '">' + e(truncate(node.label, maxChars)) + '</text>' +
        '<text class="dg-node-sub" x="' + (p.x + 16) + '" y="' + (p.y + 43) + '">' + e(truncate(node.sub || '', maxChars + 6)) + '</text>' +
        '</g>';
    }).join('');

    return (
      '<svg class="dg-svg' + (vertical ? ' is-vertical' : '') + '" viewBox="0 0 ' + Math.ceil(width) + ' ' + Math.ceil(height) +
        '" style="max-width:' + Math.ceil(width) + 'px" role="img" aria-label="' + e(spec.ariaLabel || 'Diagram') + '">' +
        '<defs><marker id="' + id + '-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
        '<path d="M0 0 L10 5 L0 10 z" class="dg-arrow" /></marker></defs>' +
        captions +
        '<g class="dg-edges">' + edgeMarkup.join('') + '</g>' +
        nodeMarkup +
        '<g class="dg-labels">' + labelMarkup.join('') + '</g>' +
      '</svg>'
    );
  }

  window.CodeStoryDiagrams = {
    languageFor: languageFor,
    highlightLine: highlightLine,
    codePanel: codePanel,
    layeredGraph: layeredGraph,
    truncate: truncate,
  };
})();

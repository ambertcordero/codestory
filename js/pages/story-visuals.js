/* CodeStory - pages/story-visuals.js
   Visual layer for the My Explorer Story: a Visual guide (architecture and
   workflow diagrams), one content-appropriate visual per chapter and code
   illustrations beside the chapter text. Everything is built from
   /api/projects/{id}/visuals (static analysis of the stored files) plus the
   grounded evidence already on each chapter. Nothing is drawn unless the
   analysis found it; links that are user-mediated or unverified are labelled. */

(function () {
  'use strict';

  const e = (value) => CodeStoryUI.escapeHtml(value);
  const D = () => window.CodeStoryDiagrams;
  const state = { guideTab: 'architecture', guideOpen: true };

  const CALLABLE = { function: true, method: true, handler: true };
  const KIND_LABEL = {
    function: 'function', method: 'method', handler: 'event handler', constant: 'constant',
    class: 'class', module: 'module scope',
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function usable(visuals) {
    return Boolean(visuals && visuals.generated === true && visuals.architecture &&
      Array.isArray(visuals.architecture.nodes) && visuals.architecture.nodes.length);
  }

  function isNarrow() {
    return Boolean(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
  }

  function baseName(path) {
    return String(path || '').split('/').pop();
  }

  function location(file, line) {
    return (file || '') + (Number.isInteger(line) && line > 0 ? ':' + line : '');
  }

  function symbol(visuals, id) {
    return visuals && visuals.symbols ? visuals.symbols[id] || null : null;
  }

  function entryFor(visuals, handlerId) {
    return (visuals.entries || []).find((entry) => entry.handler === handlerId) || null;
  }

  function symbolLabel(visuals, sym) {
    if (!sym) return '';
    if (sym.kind === 'handler') {
      const entry = entryFor(visuals, sym.id);
      return entry ? entry.event + ' handler' : 'event handler';
    }
    if (sym.kind === 'module') return baseName(sym.file) + ' (top level)';
    return sym.qualified + (CALLABLE[sym.kind] ? '()' : '');
  }

  function symbolSub(visuals, sym) {
    if (!sym) return '';
    if (sym.kind === 'handler') {
      const entry = entryFor(visuals, sym.id);
      return (entry ? entry.element + ' \u00b7 ' : '') + location(baseName(sym.file), sym.line);
    }
    return location(baseName(sym.file), sym.line);
  }

  function chip(visuals, id, extraClass) {
    const sym = symbol(visuals, id);
    if (!sym) return '';
    return '<button class="visual-chip kind-' + e(sym.kind) + (extraClass ? ' ' + extraClass : '') +
      '" type="button" data-visual-ref="' + e(id) + '" data-ref-kind="symbol">' +
      '<span>' + e(symbolLabel(visuals, sym)) + '</span><code>' + e(location(baseName(sym.file), sym.line)) + '</code></button>';
  }

  function badge(verified, text) {
    return '<span class="visual-badge ' + (verified ? 'is-verified' : 'is-inferred') + '">' +
      e(text || (verified ? 'Verified in source' : 'Inferred')) + '</span>';
  }

  /* Calls (and constant reads) that start inside a symbol, as line notes. */
  function lineNotes(visuals, sym) {
    const notes = {};
    if (!sym) return notes;
    if (Number.isInteger(sym.line)) notes[sym.line] = KIND_LABEL[sym.kind] ? 'defines ' + (sym.kind === 'module' ? 'top-level code' : sym.qualified) : '';
    (visuals.calls || []).forEach((call) => {
      if (call.from !== sym.id || !Number.isInteger(call.line)) return;
      const target = symbol(visuals, call.to);
      if (!target) return;
      const verb = call.kind === 'reads' ? 'reads ' : call.kind === 'instantiates' ? 'creates ' : call.kind === 'callback' ? 'passes ' : 'calls ';
      const text = verb + target.qualified;
      notes[call.line] = notes[call.line] && notes[call.line].indexOf(text) === -1 ? notes[call.line] + ', ' + target.qualified : (notes[call.line] || text);
    });
    return notes;
  }

  function symbolPanel(visuals, id, caption) {
    const sym = symbol(visuals, id);
    if (!sym || !sym.snippet || !sym.snippet.text) return '';
    return D().codePanel({
      file: sym.file,
      line: sym.snippet.start,
      symbol: symbolLabel(visuals, sym) + ' \u00b7 ' + (KIND_LABEL[sym.kind] || sym.kind),
      text: sym.snippet.text,
      truncated: sym.snippet.truncated,
      highlights: lineNotes(visuals, sym),
      caption: caption,
    });
  }

  function filePanel(visuals, path) {
    const node = (visuals.architecture.nodes || []).find((item) => item.id === path);
    if (!node) return '';
    const outgoing = visuals.architecture.edges.filter((edge) => edge.from === path);
    const incoming = visuals.architecture.edges.filter((edge) => edge.to === path);
    const symbols = Object.values(visuals.symbols || {}).filter((sym) => sym.file === path && sym.kind !== 'module' && sym.kind !== 'handler');
    const edgeRow = (edge, other) =>
      '<li><code>' + e(location(edge.from, edge.line)) + '</code> ' +
      (edge.statement ? '<code class="visual-statement">' + e(D().truncate(edge.statement, 90)) + '</code>' : '') +
      (edge.names && edge.names.length ? ' <span>brings in ' + e(edge.names.join(', ')) + '</span>' : '') +
      ' <span class="visual-muted">(' + e(other) + ')</span></li>';
    return (
      '<div class="visual-file-detail">' +
        '<h4><code>' + e(node.path) + '</code></h4>' +
        '<p class="visual-muted">' + e(node.language || node.type) + ' \u00b7 ' + e(node.lines) + ' lines</p>' +
        (outgoing.length ? '<p class="visual-detail-label">References</p><ul>' + outgoing.map((edge) => edgeRow(edge, edge.to)).join('') + '</ul>' : '') +
        (incoming.length ? '<p class="visual-detail-label">Referenced by</p><ul>' + incoming.map((edge) => edgeRow(edge, edge.from)).join('') + '</ul>' : '') +
        (!outgoing.length && !incoming.length ? '<p class="visual-muted">No import, script or stylesheet link was detected for this file.</p>' : '') +
        (symbols.length ? '<p class="visual-detail-label">Symbols found</p><div class="visual-chip-row">' +
          symbols.map((sym) => chip(visuals, sym.id)).join('') + '</div>' : '') +
      '</div>'
    );
  }

  function detailPlaceholder(text) {
    return '<p class="visual-detail-empty">' + e(text) + '</p>';
  }

  /* ------------------------------------------------------------------ */
  /* Architecture                                                        */
  /* ------------------------------------------------------------------ */

  function architectureLayers(nodes, edges) {
    const ids = nodes.map((node) => node.id);
    const linked = new Set();
    edges.forEach((edge) => { linked.add(edge.from); linked.add(edge.to); });
    const incoming = new Set(edges.map((edge) => edge.to));
    const layer = {};
    ids.filter((id) => linked.has(id) && !incoming.has(id)).forEach((id) => { layer[id] = 0; });
    if (!Object.keys(layer).length && linked.size) layer[ids.find((id) => linked.has(id))] = 0;
    for (let round = 0; round < ids.length; round += 1) {
      let changed = false;
      edges.forEach((edge) => {
        if (layer[edge.from] === undefined) return;
        const next = layer[edge.from] + 1;
        if (next < ids.length && (layer[edge.to] === undefined || layer[edge.to] < next)) {
          layer[edge.to] = next;
          changed = true;
        }
      });
      if (!changed) break;
    }
    ids.forEach((id) => { if (linked.has(id) && layer[id] === undefined) layer[id] = 0; });
    const max = Math.max(-1, ...Object.values(layer));
    const unlinked = ids.filter((id) => layer[id] === undefined);
    unlinked.forEach((id) => { layer[id] = max + 1; });
    return { layer: layer, max: max, hasUnlinked: unlinked.length > 0 };
  }

  function edgeLabel(edge) {
    if (edge.names && edge.names.length) return edge.names.join(', ');
    const tag = String(edge.statement || '').match(/^<\s*(\w+)/);
    if (tag) return '<' + tag[1].toLowerCase() + '>';
    return '';
  }

  function edgeTitle(edge) {
    return edge.from + ' \u2192 ' + edge.to + (edge.line ? ' (line ' + edge.line + ')' : '') +
      (edge.statement ? ': ' + edge.statement : '');
  }

  function architectureGraph(visuals, focusFiles) {
    const arch = visuals.architecture;
    const focus = focusFiles && focusFiles.size ? focusFiles : null;
    let nodes = arch.nodes;
    let edges = arch.edges;
    if (focus) {
      const keep = new Set(focus);
      edges.forEach((edge) => { if (focus.has(edge.from) || focus.has(edge.to)) { keep.add(edge.from); keep.add(edge.to); } });
      nodes = nodes.filter((node) => keep.has(node.id));
      edges = edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
    }
    const layers = architectureLayers(nodes, edges);
    const captions = [];
    for (let i = 0; i <= layers.max; i += 1) captions.push(i === 0 ? 'Entry point' : 'Level ' + (i + 1));
    if (layers.hasUnlinked) captions.push('No detected links');
    const symbolCount = {};
    Object.values(visuals.symbols || {}).forEach((sym) => {
      if (sym.kind !== 'module' && sym.kind !== 'handler') symbolCount[sym.file] = (symbolCount[sym.file] || 0) + 1;
    });
    return D().layeredGraph({
      vertical: isNarrow(),
      ariaLabel: 'Architecture diagram: ' + nodes.length + ' files and ' + edges.length + ' detected references',
      captions: captions,
      nodes: nodes.map((node) => ({
        id: node.id,
        label: node.label || baseName(node.path),
        sub: (node.language || node.type) + ' \u00b7 ' + node.lines + ' lines' +
          (symbolCount[node.id] ? ' \u00b7 ' + symbolCount[node.id] + ' symbols' : ''),
        kind: node.type,
        layer: layers.layer[node.id],
        emphasis: focus ? (focus.has(node.id) ? 'focus' : 'muted') : '',
        ref: node.id,
        refKind: 'file',
      })),
      edges: edges.map((edge) => ({
        from: edge.from, to: edge.to, label: edgeLabel(edge), title: edgeTitle(edge),
        emphasis: focus && (focus.has(edge.from) || focus.has(edge.to)) ? 'focus' : '',
      })),
    });
  }

  function architectureLegend(visuals) {
    const used = new Set(visuals.architecture.nodes.map((node) => node.type));
    return '<ul class="visual-legend">' + (visuals.architecture.legend || [])
      .filter((item) => used.has(item.type))
      .map((item) => '<li><i class="kind-' + e(item.type) + '"></i>' + e(item.label) + '</li>').join('') +
      '<li><i class="is-edge"></i>Reference found in source (labels = names imported)</li></ul>';
  }

  /* ------------------------------------------------------------------ */
  /* Workflow                                                            */
  /* ------------------------------------------------------------------ */

  function linkHtml(visuals, link) {
    if (!link) return '';
    let text;
    if (link.kind === 'call') {
      const from = symbol(visuals, link.from);
      const to = symbol(visuals, link.to);
      text = e((from ? symbolLabel(visuals, from) : '?') + ' calls ' + (to ? symbolLabel(visuals, to) : '?')) +
        ' <code>' + e(location(link.file, link.line)) + '</code>';
    } else if (link.kind === 'user' && link.verified) {
      const source = symbol(visuals, link.source);
      text = 'User ' + e(link.event || 'action') + 's ' + e(link.element || '') + ' \u2014 ' +
        e((source ? symbolLabel(visuals, source) : 'code') + ' ' + (link.detail || '')) +
        ' <code>' + e(location(link.file, link.line)) + '</code>';
    } else {
      text = 'Next step happens after a user action' + (link.element ? ' on ' + e(link.element) : '') +
        '; no code path between these stages was found';
    }
    const verified = link.verified === true;
    return '<li class="journey-link ' + (verified ? 'is-verified' : 'is-inferred') + '">' +
      '<span class="journey-link-line" aria-hidden="true"></span>' +
      '<p>' + badge(verified, verified ? (link.kind === 'call' ? 'Direct call' : 'Wired in source') : 'Inferred') + ' ' + text + '</p></li>';
  }

  function stageHtml(visuals, stage, index, focusSymbols) {
    const touched = focusSymbols && stage.symbols.concat(stage.supporting || []).some((id) => focusSymbols.has(id));
    const trigger = stage.trigger
      ? '<p class="journey-trigger">Triggered by <strong>' + e(stage.trigger.event) + '</strong> on <code>' + e(stage.trigger.element) +
        '</code>' + (stage.trigger.selectors && stage.trigger.selectors.length ? ' (' + e(stage.trigger.selectors.join(', ')) + ')' : '') +
        ' \u00b7 listener at <code>' + e(location(stage.trigger.file, stage.trigger.line)) + '</code></p>'
      : '';
    const evidence = (stage.evidence || []).map((edge) => {
      const from = symbol(visuals, edge.from);
      const to = symbol(visuals, edge.to);
      return '<li>' + e((from ? symbolLabel(visuals, from) : '?') + ' \u2192 ' + (to ? symbolLabel(visuals, to) : '?')) +
        ' <code>' + e(location(edge.file, edge.line)) + '</code></li>';
    }).join('');
    return '<li class="journey-stage' + (touched ? ' is-focus' : '') + (focusSymbols && !touched ? ' is-muted' : '') + '">' +
      '<span class="journey-index" aria-hidden="true">' + (index + 1) + '</span>' +
      '<div class="journey-card">' +
        '<h4>' + e(stage.title) + '</h4>' + trigger +
        '<div class="visual-chip-row">' + stage.symbols.map((id) => chip(visuals, id, 'is-primary')).join('') +
          (stage.supporting || []).map((id) => chip(visuals, id, 'is-supporting')).join('') + '</div>' +
        (evidence ? '<ul class="journey-evidence">' + evidence + '</ul>' : '') +
      '</div></li>';
  }

  function journeyHtml(visuals, focusSymbols, onlyRange) {
    const journey = visuals.journey;
    if (!journey || !Array.isArray(journey.stages) || !journey.stages.length) return '';
    const links = journey.links || [];
    let from = 0;
    let to = journey.stages.length - 1;
    if (onlyRange) { from = onlyRange[0]; to = onlyRange[1]; }
    let html = '';
    for (let i = from; i <= to; i += 1) {
      html += stageHtml(visuals, journey.stages[i], i, focusSymbols);
      if (i < to) html += linkHtml(visuals, links[i]);
    }
    return '<ol class="journey">' + html + '</ol>';
  }

  function flowLanes(visuals) {
    const flows = (visuals.flows || []).filter((flow) => flow.steps && flow.steps.length > 1);
    if (!flows.length) return '';
    return '<details class="visual-lanes"><summary>All traced entry points (' + flows.length + ')</summary>' +
      flows.map((flow) => {
        const entry = (visuals.entries || []).find((item) => item.id === flow.entry);
        const title = entry ? entry.label : 'Entry';
        return '<section class="visual-lane"><h5>' + e(title) +
          (entry ? ' <code>' + e(location(entry.file, entry.line)) + '</code>' : '') +
          (entry && entry.element_location ? ' <span class="visual-muted">element in <code>' +
            e(location(entry.element_location.file, entry.element_location.line)) + '</code></span>' : '') + '</h5>' +
          '<ol class="visual-tree">' + flow.steps.slice(1).map((step) =>
            '<li style="--depth:' + Math.min(step.depth - 1, 6) + '">' + chip(visuals, step.symbol) +
            (step.via ? '<span class="visual-muted">' + e(step.via.kind) + ' at ' + e(location(baseName(step.via.file), step.via.line)) + '</span>' : '') +
            '</li>').join('') + '</ol></section>';
      }).join('') + '</details>';
  }

  /* ------------------------------------------------------------------ */
  /* Call / data-flow neighbourhoods                                     */
  /* ------------------------------------------------------------------ */

  function neighbourhood(visuals, centerIds, kinds, ariaLabel) {
    const centers = new Set(centerIds);
    const calls = (visuals.calls || []).filter((call) =>
      kinds.indexOf(call.kind) !== -1 && (centers.has(call.from) || centers.has(call.to)) &&
      symbol(visuals, call.from) && symbol(visuals, call.to) && call.from !== call.to);
    if (!calls.length) return '';
    const seen = new Set();
    const unique = calls.filter((call) => {
      const key = call.from + '>' + call.to;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 14);
    const layerOf = {};
    unique.forEach((call) => {
      if (centers.has(call.from) && !centers.has(call.to)) layerOf[call.to] = 2;
      if (centers.has(call.to) && !centers.has(call.from)) layerOf[call.from] = 0;
    });
    centers.forEach((id) => { layerOf[id] = 1; });
    const ids = Object.keys(layerOf).filter((id) => symbol(visuals, id));
    return D().layeredGraph({
      vertical: isNarrow(),
      ariaLabel: ariaLabel,
      captions: ['Used by', 'In this chapter', kinds.indexOf('reads') !== -1 && kinds.length === 1 ? 'Reads' : 'Calls'],
      nodes: ids.map((id) => {
        const sym = symbol(visuals, id);
        return {
          id: id, label: symbolLabel(visuals, sym), sub: symbolSub(visuals, sym), kind: sym.kind,
          layer: layerOf[id], emphasis: centers.has(id) ? 'focus' : '', ref: id, refKind: 'symbol',
        };
      }),
      edges: unique.map((call) => ({
        from: call.from, to: call.to, label: call.kind === 'call' ? 'line ' + call.line : call.kind + ' \u00b7 ' + call.line,
        title: call.kind + ' at ' + location(call.file, call.line),
      })),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Guide                                                               */
  /* ------------------------------------------------------------------ */

  function figure(kind, title, intro, body, extra, detailText) {
    return '<div class="visual-figure" data-visual-figure="' + e(kind) + '">' +
      (title ? '<div class="visual-figure-head"><h4>' + e(title) + '</h4>' + (intro || '') + '</div>' : '') +
      '<div class="visual-figure-body"><div class="visual-canvas">' + body + '</div>' +
        '<aside class="visual-detail" aria-live="polite">' + detailPlaceholder(detailText || 'Select a node to see its source.') + '</aside>' +
      '</div>' + (extra || '') + '</div>';
  }

  function renderGuide(visuals) {
    if (visuals && visuals.error) {
      return '<p class="workspace-note visual-unavailable">Diagrams are unavailable: ' + e(visuals.error) + '</p>';
    }
    if (!usable(visuals)) return '';
    const arch = visuals.architecture;
    const hasJourney = Boolean(visuals.journey && visuals.journey.stages && visuals.journey.stages.length);
    const hasFlows = (visuals.flows || []).some((flow) => flow.steps && flow.steps.length > 1);
    const tabs = [{ key: 'architecture', label: 'Architecture' }];
    if (hasJourney || hasFlows) tabs.push({ key: 'workflow', label: hasJourney ? 'Workflow' : 'Entry points' });
    if (!tabs.some((tab) => tab.key === state.guideTab)) state.guideTab = 'architecture';

    const archPanel = figure('architecture',
      arch.nodes.length + ' files \u00b7 ' + arch.edges.length + ' references',
      '<p>File links reuse the System Map analysis. Each arrow is an import, script or stylesheet reference found in the source.</p>',
      architectureGraph(visuals, null), architectureLegend(visuals), 'Select a file to see what it references and which symbols it defines.');

    let workflowPanel = '';
    if (hasJourney) {
      const verifiedLinks = (visuals.journey.links || []).filter((link) => link.verified).length;
      workflowPanel = figure('workflow', 'From product selection to receipt',
        '<p>Each stage is anchored to functions found in the code. ' + verifiedLinks + ' of ' +
        (visuals.journey.links || []).length + ' transitions are confirmed by a call or a wired event listener; the rest are marked as inferred.</p>',
        journeyHtml(visuals, null, null), flowLanes(visuals), 'Select a function to see its code.');
    } else if (hasFlows) {
      workflowPanel = figure('workflow', 'Traced entry points',
        '<p>Event listeners and top-level code, with the calls each one makes.</p>', flowLanes(visuals).replace('<details class="visual-lanes">', '<details class="visual-lanes" open>'), '', 'Select a function to see its code.');
    }

    const panels = { architecture: archPanel, workflow: workflowPanel };
    return (
      '<details class="visual-guide"' + (state.guideOpen ? ' open' : '') + ' data-visual-guide>' +
        '<summary><span class="visual-guide-eyebrow">Visual guide</span><span class="visual-guide-title">How the code fits together</span></summary>' +
        '<div class="visual-tabs" role="tablist" aria-label="Visual guide">' + tabs.map((tab) =>
          '<button class="visual-tab' + (tab.key === state.guideTab ? ' active' : '') + '" type="button" role="tab" aria-selected="' +
          (tab.key === state.guideTab) + '" data-visual-tab="' + tab.key + '">' + e(tab.label) + '</button>').join('') + '</div>' +
        tabs.map((tab) => '<div class="visual-tab-panel" data-visual-panel="' + tab.key + '"' +
          (tab.key === state.guideTab ? '' : ' hidden') + '>' + panels[tab.key] + '</div>').join('') +
        '<p class="visual-footnote">' + e(visuals.notes || '') + '</p>' +
      '</details>'
    );
  }

  /* ------------------------------------------------------------------ */
  /* Chapter planning                                                    */
  /* ------------------------------------------------------------------ */

  function chapterSymbols(chapter, visuals) {
    const found = new Set();
    if (!usable(visuals)) return found;
    const symbols = Object.values(visuals.symbols || {});
    const files = new Set(Array.isArray(chapter.source_files) ? chapter.source_files : []);
    (chapter.evidence || []).forEach((item) => {
      const inFile = symbols.filter((sym) => sym.file === item.file && sym.kind !== 'module');
      let match = item.symbol ? inFile.filter((sym) => sym.qualified === item.symbol || sym.name === item.symbol) : [];
      if (!match.length && Number.isInteger(item.line)) {
        match = inFile.filter((sym) => sym.kind !== 'class' && sym.line <= item.line && (sym.end_line || sym.line) >= item.line);
      }
      match.forEach((sym) => found.add(sym.id));
    });
    const text = [chapter.title, chapter.narrative, chapter.how_it_works, chapter.why_it_matters].join(' ');
    const tokens = new Set(text.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g) || []);
    symbols.forEach((sym) => {
      if (sym.kind === 'module' || sym.kind === 'handler') return;
      const byName = sym.name.length >= 5 && tokens.has(sym.name) && (!files.size || files.has(sym.file));
      if (tokens.has(sym.qualified) || byName) found.add(sym.id);
    });
    return found;
  }

  function chapterFiles(chapter, visuals, symbols) {
    const files = new Set((chapter.source_files || []).filter((path) =>
      visuals.architecture.nodes.some((node) => node.id === path)));
    symbols.forEach((id) => { const sym = symbol(visuals, id); if (sym) files.add(sym.file); });
    return files;
  }

  const ISSUE_TITLE = /issue|insight|improv|finding|risk|quality|limitation/i;
  const FLOW_TITLE = /flow|checkout|journey|transaction|workflow|process|lifecycle/i;
  const DATA_TITLE = /data|price|total|tax|vat|calculat|model|state/i;

  function candidates(chapter, index, total, visuals, story) {
    const list = [];
    const title = String(chapter.title || '');
    if (ISSUE_TITLE.test(title)) list.push({ type: 'issues', score: 100 });
    if (!usable(visuals)) {
      if ((chapter.evidence || []).length) list.push({ type: 'code', score: 5 });
      return list;
    }
    const symbols = chapterSymbols(chapter, visuals);
    const files = chapterFiles(chapter, visuals, symbols);
    const journey = visuals.journey;
    if (journey && journey.stages) {
      const touched = [];
      journey.stages.forEach((stage, i) => {
        if (stage.symbols.concat(stage.supporting || []).some((id) => symbols.has(id))) touched.push(i);
      });
      const titled = FLOW_TITLE.test(title);
      if (touched.length >= 2 || (touched.length >= 1 && titled)) {
        list.push({ type: 'workflow', score: 10 * touched.length + (titled ? 15 : 0), range: [touched[0], touched[touched.length - 1]], symbols: symbols });
      }
    }
    const constants = Array.from(symbols).filter((id) => {
      const sym = symbol(visuals, id);
      return sym && sym.kind === 'constant' && (visuals.calls || []).some((call) => call.to === id && call.kind === 'reads');
    });
    if (constants.length) list.push({ type: 'dataflow', score: 20 + 3 * constants.length + (DATA_TITLE.test(title) ? 15 : 0), centers: constants });
    const edges = visuals.architecture.edges.filter((edge) => files.has(edge.from) || files.has(edge.to));
    if (edges.length) list.push({ type: 'module', score: 12 + 4 * edges.length + (index === 0 ? 30 : 0), files: files });
    const callable = Array.from(symbols).map((id) => symbol(visuals, id)).filter((sym) => sym && CALLABLE[sym.kind]);
    const ranked = callable.map((sym) => ({
      sym: sym, degree: (visuals.calls || []).filter((call) => call.kind !== 'reads' && (call.from === sym.id || call.to === sym.id)).length,
    })).filter((item) => item.degree >= 2).sort((a, b) => b.degree - a.degree);
    if (ranked.length) list.push({ type: 'calls', score: 18 + Math.min(ranked[0].degree, 10), centers: ranked.slice(0, 2).map((item) => item.sym.id) });
    if ((chapter.evidence || []).length || callable.length) list.push({ type: 'code', score: 5, symbols: symbols });
    return list;
  }

  function planChapters(story, visuals) {
    const chapters = Array.isArray(story.chapters) ? story.chapters : [];
    const used = new Set();
    return chapters.map((chapter, index) => {
      const options = candidates(chapter, index, chapters.length, visuals, story).sort((a, b) => b.score - a.score);
      if (!options.length) return null;
      const pick = options.find((option) => option.type === 'issues' || !used.has(option.type)) || options[0];
      used.add(pick.type);
      return pick;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Chapter visual rendering                                            */
  /* ------------------------------------------------------------------ */

  const PLAN_TITLES = {
    module: ['Module diagram', 'The files this chapter covers and the references between them.'],
    workflow: ['Workflow segment', 'Where this chapter sits in the traced point-of-sale flow.'],
    dataflow: ['Data flow', 'Which code reads the values this chapter describes.'],
    calls: ['Call diagram', 'Who calls the key functions in this chapter, and what they call.'],
    issues: ['Findings at a glance', 'Verified static checks from Issues & Insights.'],
  };

  function issuesVisual(story) {
    const issues = Array.isArray(story.verified_issues) ? story.verified_issues : [];
    if (!issues.length) {
      return '<p class="visual-muted">The static checks recorded no findings for this project.</p>';
    }
    const order = ['critical', 'high', 'warning', 'medium', 'low', 'info'];
    const counts = {};
    issues.forEach((issue) => { counts[issue.severity || 'info'] = (counts[issue.severity || 'info'] || 0) + 1; });
    const keys = Object.keys(counts).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return '<div class="visual-issues">' +
      '<div class="visual-issue-bar" role="img" aria-label="' + e(keys.map((key) => counts[key] + ' ' + key).join(', ')) + '">' +
      keys.map((key) => '<span class="sev-' + e(key) + '" style="flex:' + counts[key] + '"></span>').join('') + '</div>' +
      '<ul class="visual-legend">' + keys.map((key) => '<li><i class="sev-' + e(key) + '"></i>' + counts[key] + ' ' + e(key) + '</li>').join('') + '</ul>' +
      '<ul class="visual-issue-list">' + issues.slice(0, 6).map((issue) =>
        '<li><span class="visual-badge sev-' + e(issue.severity || 'info') + '">' + e(issue.severity || 'info') + '</span> ' +
        e(issue.title) + (issue.file ? ' <code>' + e(location(issue.file, issue.line)) + '</code>' : '') + '</li>').join('') + '</ul>' +
      '<button class="workspace-btn" type="button" data-explorer-tab="issues">Open Issues &amp; Insights</button></div>';
  }

  function renderChapterVisual(plan, story, visuals) {
    if (!plan || plan.type === 'code') return '';
    let body = '';
    if (plan.type === 'issues') {
      body = issuesVisual(story);
      return '<section class="chapter-visual is-issues"><p class="chapter-visual-eyebrow">' + PLAN_TITLES.issues[0] + '</p>' +
        '<p class="chapter-visual-intro">' + PLAN_TITLES.issues[1] + '</p>' + body + '</section>';
    }
    if (plan.type === 'module') body = architectureGraph(visuals, plan.files);
    if (plan.type === 'workflow') body = journeyHtml(visuals, plan.symbols, plan.range);
    if (plan.type === 'dataflow') body = neighbourhood(visuals, plan.centers, ['reads'], 'Data-flow diagram');
    if (plan.type === 'calls') body = neighbourhood(visuals, plan.centers, ['call', 'callback', 'instantiates'], 'Call diagram');
    if (!body) return '';
    return '<section class="chapter-visual is-' + e(plan.type) + '">' +
      '<p class="chapter-visual-eyebrow">' + e(PLAN_TITLES[plan.type][0]) + '</p>' +
      figure(plan.type, '', '', body, '', 'Select a node to see its source.')
        .replace('<div class="visual-figure-body">', '<p class="chapter-visual-intro">' + e(PLAN_TITLES[plan.type][1]) + '</p><div class="visual-figure-body">') +
      '</section>';
  }

  /* Evidence -> code panels with real line numbers and call highlights. */
  function evidencePanels(chapter, visuals) {
    const evidence = Array.isArray(chapter.evidence) ? chapter.evidence : [];
    const ok = usable(visuals);
    return evidence.map((item) => {
      const sym = ok ? Object.values(visuals.symbols || {}).find((candidate) =>
        candidate.file === item.file && candidate.kind !== 'module' &&
        (item.symbol ? (candidate.qualified === item.symbol || candidate.name === item.symbol)
          : Number.isInteger(item.line) && candidate.kind !== 'class' && candidate.line <= item.line && (candidate.end_line || candidate.line) >= item.line)) : null;
      return D().codePanel({
        file: item.file || 'Source file',
        line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
        symbol: item.symbol || (sym ? symbolLabel(visuals, sym) : ''),
        text: item.snippet || '',
        highlights: sym ? lineNotes(visuals, sym) : {},
      });
    }).join('');
  }

  /* ------------------------------------------------------------------ */
  /* Interaction                                                         */
  /* ------------------------------------------------------------------ */

  function showDetail(target, visuals) {
    const figureEl = target.closest('.visual-figure');
    const detail = figureEl ? figureEl.querySelector('.visual-detail') : null;
    if (!detail || !usable(visuals)) return;
    const ref = target.getAttribute('data-visual-ref');
    const kind = target.getAttribute('data-ref-kind');
    figureEl.querySelectorAll('[data-visual-ref].is-selected').forEach((node) => node.classList.remove('is-selected'));
    figureEl.querySelectorAll('[data-visual-ref="' + CSS.escape(ref) + '"]').forEach((node) => node.classList.add('is-selected'));
    const html = kind === 'file' ? filePanel(visuals, ref) : symbolPanel(visuals, ref);
    detail.innerHTML = html || detailPlaceholder('No source excerpt is available for this item.');
    if (isNarrow()) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function handleClick(event, visuals) {
    const tab = event.target.closest('[data-visual-tab]');
    if (tab) {
      const guide = tab.closest('[data-visual-guide]');
      state.guideTab = tab.getAttribute('data-visual-tab');
      guide.querySelectorAll('[data-visual-tab]').forEach((button) => {
        const active = button === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      });
      guide.querySelectorAll('[data-visual-panel]').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-visual-panel') !== state.guideTab;
      });
      return true;
    }
    const node = event.target.closest('[data-visual-ref]');
    if (node) {
      showDetail(node, visuals);
      return true;
    }
    return false;
  }

  function handleKeydown(event, visuals) {
    if (event.key !== 'Enter' && event.key !== ' ') return false;
    const node = event.target.closest('g[data-visual-ref]');
    if (!node) return false;
    event.preventDefault();
    showDetail(node, visuals);
    return true;
  }

  function handleToggle(event) {
    if (event.target && event.target.matches && event.target.matches('[data-visual-guide]')) {
      state.guideOpen = event.target.open;
    }
  }

  window.CodeStoryVisuals = {
    usable: usable,
    renderGuide: renderGuide,
    planChapters: planChapters,
    renderChapterVisual: renderChapterVisual,
    evidencePanels: evidencePanels,
    handleClick: handleClick,
    handleKeydown: handleKeydown,
    handleToggle: handleToggle,
  };
})();

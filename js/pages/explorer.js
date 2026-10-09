/* CodeStory - pages/explorer.js
   "My Explorer" view: browse a stored project's Story, System Map and Issues.
   Story generation uses a local Ollama model when available; otherwise the
   disconnect is reported honestly with setup guidance. */

(function () {
  'use strict';

  const page = document.querySelector('.explorer-page');
  if (!page) {
    return;
  }

  const titleEl = document.getElementById('explorerTitle');
  const subEl = document.getElementById('explorerSub');
  const selectEl = document.getElementById('explorerProjectSelect');
  const refreshButton = document.getElementById('explorerRefreshButton');
  const tabs = [...page.querySelectorAll('.explorer-tab')];

  function statusEl(name) { return page.querySelector('[data-status="' + name + '"]'); }
  function contentEl(name) { return page.querySelector('[data-content="' + name + '"]'); }

  let projects = [];
  let currentId = null;
  let activeTab = 'story';
  let activeStory = null;
  let activeVisuals = null;
  const Visuals = window.CodeStoryVisuals || null;
  let activeChapterIndex = 0;

  const OLLAMA_HELP =
    '<p>Story generation needs a local AI model. Install Ollama from ' +
    '<a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a>, ' +
    'then run <code>ollama serve</code> and <code>ollama pull qwen2.5-coder:3b</code>. ' +
    'Configure the host and model in Settings.</p>';

  function setStatus(name, state, html) {
    const target = statusEl(name);
    if (!target) return;
    if (!html) {
      target.hidden = true;
      target.className = 'explorer-status';
      target.innerHTML = '';
      return;
    }
    target.hidden = false;
    target.className = 'explorer-status is-' + state;
    target.innerHTML = html;
  }

  function setContent(name, html) {
    const target = contentEl(name);
    if (target) target.innerHTML = html || '';
  }

  /* ------------------------------------------------------------------ */
  /* Project selection                                                   */
  /* ------------------------------------------------------------------ */

  function populateSelect() {
    if (!projects.length) {
      selectEl.innerHTML = '<option value="">No projects</option>';
      selectEl.disabled = true;
      return;
    }
    selectEl.disabled = false;
    selectEl.innerHTML = projects
      .map((project) => (
        '<option value="' + CodeStoryUI.escapeHtml(project.id) + '">' +
        CodeStoryUI.escapeHtml(project.name) +
        (project.demo ? ' (demo)' : '') + '</option>'
      ))
      .join('');
    selectEl.value = currentId || '';
  }

  function chooseCurrent() {
    const selected = CodeStoryStore.getSelected();
    const ids = projects.map((project) => project.id);
    if (selected && ids.indexOf(selected.id) !== -1) {
      currentId = selected.id;
    } else if (ids.length) {
      currentId = ids[0];
    } else {
      currentId = null;
    }
  }

  function currentProject() {
    return projects.find((project) => project.id === currentId) || null;
  }

  /* ------------------------------------------------------------------ */
  /* Story                                                               */
  /* ------------------------------------------------------------------ */

  function renderStoryDocument(story) {
    const e = CodeStoryUI.escapeHtml;
    const chapters = Array.isArray(story.chapters) ? story.chapters : [];
    const structured = story.structured === true && chapters.length > 0;
    const meta =
      '<p class="story-doc-meta">Generated ' + e(CodeStoryUI.formatDate(story.generated_at)) +
      ' with <code>' + e(story.model || 'local model') + '</code></p>';
    const guide = Visuals ? Visuals.renderGuide(activeVisuals) : '';

    if (!structured) {
      setContent('story',
        '<article class="story-doc">' + meta +
          (story.note ? '<p class="workspace-note">' + e(story.note) + '</p>' : '') + guide +
          CodeStoryUI.renderMarkdown(story.text || '') +
          '<div class="story-doc-actions"><button class="workspace-btn" type="button" data-story="regenerate">Regenerate story</button></div>' +
        '</article>');
      return;
    }

    activeChapterIndex = Math.max(0, Math.min(activeChapterIndex, chapters.length - 1));
    const chapter = chapters[activeChapterIndex];
    const chapterFiles = Array.isArray(chapter.source_files) ? chapter.source_files : [];
    const evidence = Array.isArray(chapter.evidence) ? chapter.evidence : [];
    const relationships = Array.isArray(chapter.relationships) ? chapter.relationships : [];
    const verifiedFileEdges = relationships.filter((relationship) =>
      relationship.verified === true && relationship.from_file && relationship.to_file
    );
    const dots = chapters.map((item, index) =>
      '<button class="story-progress-step' + (index === activeChapterIndex ? ' is-current' : '') +
      (index < activeChapterIndex ? ' is-complete' : '') + '" type="button" data-story-chapter="' + index +
      '" aria-label="Go to chapter ' + (index + 1) + ': ' + e(item.title) +
      '" aria-current="' + (index === activeChapterIndex ? 'step' : 'false') + '"></button>'
    ).join('');
    const evidenceHtml = evidence.length
      ? (Visuals
        ? '<section class="story-evidence story-code-illustration"><h3>Source evidence</h3>' +
          Visuals.evidencePanels(chapter, activeVisuals) + '</section>'
        : '<section class="story-evidence"><h3>Source evidence</h3><div class="story-evidence-list">' +
          evidence.map((item) => {
            const location = e(item.file || 'Source file') + (Number.isInteger(item.line) && item.line > 0 ? ':' + item.line : '');
            return '<article class="story-evidence-card"><p class="story-evidence-location"><code>' + location +
              (item.symbol ? ' · ' + e(item.symbol) : '') + '</code></p>' +
              '<pre class="story-code"><code>' + e(item.snippet || '') + '</code></pre></article>';
          }).join('') + '</div></section>')
      : '';
    const chapterPlan = Visuals ? Visuals.planChapters(story, activeVisuals)[activeChapterIndex] : null;
    const chapterVisual = Visuals ? Visuals.renderChapterVisual(chapterPlan, story, activeVisuals) : '';
    const fileEdgesHtml = verifiedFileEdges.length
      ? '<section class="story-flow" aria-label="Verified source file relationships"><h3>Verified source references</h3>' +
        '<p>These file links were found in the project’s import and include statements.</p>' +
        '<div class="story-flow-list">' + verifiedFileEdges.map((relationship) =>
          '<div class="story-flow-edge"><code>' + e(relationship.from_file) +
          '</code><span aria-label="references">&rarr;</span><code>' + e(relationship.to_file) + '</code></div>'
        ).join('') + '</div></section>'
      : '';
    const relationshipsHtml = relationships.length
      ? '<section class="story-relationships"><h3>Other chapter relationships</h3><ul>' +
        relationships.map((relationship) =>
          '<li><span class="story-relationship-status ' + (relationship.verified === true ? 'is-verified' : 'is-potential') +
          '">' + (relationship.verified === true ? 'Verified file link' : 'Potential') + '</span> ' +
          '<strong>' + e(relationship.from || '') + ' &rarr; ' + e(relationship.to || '') + '</strong>' +
          (relationship.description ? '<span> ' + e(relationship.description) + '</span>' : '') + '</li>'
        ).join('') + '</ul></section>'
      : '';
    const sourceFilesHtml = chapterFiles.length
      ? '<p class="story-chapter-files"><strong>Source files:</strong> ' +
        chapterFiles.map((path) => '<code>' + e(path) + '</code>').join(' ') + '</p>'
      : '';
    const howItWorks = chapter.how_it_works
      ? '<section class="story-chapter-detail"><h3>How it works</h3>' + CodeStoryUI.renderMarkdown(chapter.how_it_works) + '</section>'
      : '';
    const whyItMatters = chapter.why_it_matters
      ? '<section class="story-chapter-detail"><h3>Why it matters</h3>' + CodeStoryUI.renderMarkdown(chapter.why_it_matters) + '</section>'
      : '';
    const overview = activeChapterIndex === 0 && story.overview
      ? '<section class="story-overview"><h2>' + e(story.title || 'Project story') + '</h2>' +
        CodeStoryUI.renderMarkdown(story.overview) + '</section>'
      : '';
    const issueCount = Array.isArray(story.verified_issues) ? story.verified_issues.length : 0;
    const illustrationHtml = chapter.image
      ? '<figure class="story-illustration"><img src="' + e(CodeStoryAPI.base + chapter.image) +
        '" alt="Editorial illustration for this chapter" loading="lazy" />' +
        '<figcaption>AI-generated editorial illustration</figcaption></figure>'
      : '<div class="story-illustration is-pending" data-image-chapter="' + e(chapter.id || '') + '">' +
        '<p>Preparing an editorial illustration…</p></div>';

    setContent('story',
      '<article class="story-doc is-structured">' + meta + overview + guide +
        '<div class="story-progress" aria-label="Story chapter progress">' +
          '<div class="story-progress-copy"><strong>Chapter ' + (activeChapterIndex + 1) + ' of ' + chapters.length +
          '</strong><span>' + Math.round(((activeChapterIndex + 1) / chapters.length) * 100) + '% complete</span></div>' +
          '<div class="story-progress-track" role="progressbar" aria-valuemin="1" aria-valuemax="' + chapters.length +
          '" aria-valuenow="' + (activeChapterIndex + 1) + '" aria-valuetext="Chapter ' + (activeChapterIndex + 1) +
          ' of ' + chapters.length + '"><div class="story-progress-fill" style="width:' +
          (((activeChapterIndex + 1) / chapters.length) * 100) + '%"></div></div>' +
          '<div class="story-progress-steps">' + dots + '</div>' +
        '</div>' +
        '<section class="story-chapter">' +
          '<p class="story-chapter-eyebrow">Chapter ' + (activeChapterIndex + 1) + '</p>' +
          '<h2>' + e(chapter.title || 'Untitled chapter') + '</h2>' +
          '<div class="story-chapter-layout' + (evidenceHtml ? ' has-code' : '') + '">' +
            '<div class="story-chapter-text">' + CodeStoryUI.renderMarkdown(chapter.narrative || '') + howItWorks + whyItMatters + '</div>' +
            evidenceHtml +
          '</div>' +
          illustrationHtml + chapterVisual + sourceFilesHtml + fileEdgesHtml + relationshipsHtml +
        '</section>' +
        '<div class="story-chapter-navigation">' +
          '<button class="workspace-btn" type="button" data-story-nav="previous"' +
            (activeChapterIndex === 0 ? ' disabled' : '') + '>Previous chapter</button>' +
          '<span>Chapter ' + (activeChapterIndex + 1) + ' / ' + chapters.length + '</span>' +
          '<button class="workspace-btn primary" type="button" data-story-nav="next"' +
            (activeChapterIndex === chapters.length - 1 ? ' disabled' : '') + '>Next chapter</button>' +
        '</div>' +
        '<div class="story-related-tools"><span>Continue exploring</span>' +
          '<button class="workspace-btn" type="button" data-explorer-tab="map">Open System Map</button>' +
          '<button class="workspace-btn" type="button" data-explorer-tab="issues">View Issues &amp; Insights (' + issueCount + ')</button>' +
        '</div>' +
        '<div class="story-doc-actions"><button class="workspace-btn" type="button" data-story="regenerate">Regenerate story</button></div>' +
      '</article>');

    if (!chapter.image) requestChapterImage(chapter);
  }

  /* Requests the editorial illustration for the rendered chapter. The backend
     caches generated images, so repeat views cost nothing; failures degrade
     to a short note and never affect the story itself. */
  function requestChapterImage(chapter) {
    const project = currentProject();
    const target = page.querySelector('[data-image-chapter]');
    if (!project || !chapter || !chapter.id || !CodeStoryAPI.createChapterImage || !target) return;
    CodeStoryAPI.createChapterImage(project.id, chapter.id).then((data) => {
      if (!target.isConnected) return;
      if (data && data.available && data.image_url) {
        chapter.image = data.image_url;
        target.outerHTML =
          '<figure class="story-illustration"><img src="' + CodeStoryUI.escapeHtml(CodeStoryAPI.base + data.image_url) +
          '" alt="Editorial illustration for this chapter" loading="lazy" />' +
          '<figcaption>AI-generated editorial illustration</figcaption></figure>';
      } else {
        target.outerHTML = '<div class="story-illustration is-unavailable"><p>Illustration unavailable.</p></div>';
      }
    }).catch((error) => {
      if (!target.isConnected) return;
      target.outerHTML =
        '<div class="story-illustration is-unavailable"><p>' + CodeStoryUI.escapeHtml(error.message || 'Illustration unavailable.') + '</p>' +
        '<button class="workspace-btn" type="button" data-story-image="' + CodeStoryUI.escapeHtml(chapter.id) + '">Retry illustration</button></div>';
    });
  }

  function loadVisuals(project) {
    if (!CodeStoryAPI.visuals) return Promise.resolve(null);
    return CodeStoryAPI.visuals(project.id).catch((error) => ({ error: error.message }));
  }

  async function loadStory(project) {
    setStatus('story', 'loading', '<h3>Loading story...</h3>');
    setContent('story', '');
    activeStory = null;
    activeVisuals = null;
    activeChapterIndex = 0;
    try {
      const results = await Promise.all([CodeStoryAPI.getStory(project.id), loadVisuals(project)]);
      const data = results[0];
      activeVisuals = results[1];
      if (data.available && data.story && data.story.text) {
        activeStory = data.story;
        setStatus('story', null);
        renderStoryDocument(activeStory);
      } else {
        setStatus('story', null);
        renderEmptyStory();
      }
    } catch (error) {
      setStatus('story', 'error', '<h3>Could not load the story</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  /* Renders the "no story yet" state and checks the real AI connection so a
     missing Ollama is explained before the user even clicks Generate. */
  function renderEmptyStory() {
    setContent('story',
      '<div class="workspace-empty">' +
        '<h3>No story yet</h3>' +
        '<p>Generate a narrative walkthrough of this project using your local AI model.</p>' +
        '<div data-ai-status></div>' +
        '<button class="workspace-btn primary" type="button" data-story="generate">Generate story</button>' +
      '</div>');
    if (!CodeStoryAPI.aiStatus) return;
    const note = page.querySelector('[data-ai-status]');
    CodeStoryAPI.aiStatus().then((status) => {
      // A newer render may have replaced this element; ignore stale results.
      if (!note || !note.isConnected) return;
      if (!status || !status.connected) {
        note.innerHTML = '<div class="workspace-note"><strong>Local AI is not connected.</strong>' + OLLAMA_HELP + '</div>';
      } else if (status.model_available === false) {
        note.innerHTML = '<div class="workspace-note"><strong>The configured model <code>' +
          CodeStoryUI.escapeHtml(status.model || '') + '</code> is not installed.</strong>' +
          '<p>Run <code>ollama pull ' + CodeStoryUI.escapeHtml(status.model || '') + '</code>, or pick an installed model in Settings.</p></div>';
      }
    }).catch(() => {
      /* The status check is best-effort; the Generate click reports the real error. */
    });
  }

  async function generateStory() {
    const project = currentProject();
    if (!project) return;
    setStatus('story', 'loading',
      '<h3>Generating story...</h3><p>The local model is reading ' + project.file_count + ' files. This can take a while.</p>');
    setContent('story', '');
    activeStory = null;
    activeChapterIndex = 0;
    try {
      const results = await Promise.all([CodeStoryAPI.createStory(project.id), loadVisuals(project)]);
      const data = results[0];
      activeVisuals = results[1];
      const story = data.story || {};
      activeStory = story;
      setStatus('story', null);
      if (story.text) {
        renderStoryDocument(story);
      } else {
        setStatus('story', 'error', '<h3>The model returned an empty story</h3><p>Please try generating it again.</p>');
      }
    } catch (error) {
      setStatus('story', 'error',
        '<h3>Story generation unavailable</h3>' +
        '<p>' + CodeStoryUI.escapeHtml(error.message) + '</p>' + OLLAMA_HELP);
    }
  }

  /* ------------------------------------------------------------------ */
  /* System map                                                          */
  /* ------------------------------------------------------------------ */

  const MAP_LAYERS = [
    { name: 'Presentation', title: 'PRESENTATION', types: ['markup', 'style'] },
    { name: 'Application', title: 'APPLICATION', types: ['script', 'code'] },
    { name: 'Data & Docs', title: 'DATA & DOCS', types: ['data', 'docs'] },
  ];

  const MAP_TYPE_LABELS = {
    markup: 'Markup', style: 'Style', script: 'Script',
    code: 'Code', data: 'Data / Config', docs: 'Docs',
  };

  const MAP_TYPE_SHORT = {
    markup: 'MARKUP', style: 'STYLE', script: 'SCRIPT',
    code: 'CODE', data: 'DATA', docs: 'DOCS',
  };

  const MAP_TYPE_GLYPHS = {
    markup: 'M-4 -4 L-7 0 L-4 4 M4 -4 L7 0 L4 4 M-2 -7 L2 7',
    style: 'M0 -7 C4 -2 6 1 6 3 A6 6 0 1 1 -6 3 C-6 1 -4 -2 0 -7 Z',
    script: 'M1 -7 L-5 1 L-1 1 L-2 7 L5 -1 L1 -1 Z',
    code: 'M-6 -5 L-9 0 L-6 5 M6 -5 L9 0 L6 5 M4 -7 L-4 7',
    data: 'M-7 -4 H7 M-7 0 H7 M-7 4 H7 M-9 -4 A2 1.4 0 1 0 -9 -4.01 M-9 0 A2 1.4 0 1 0 -9 -0.01',
    docs: 'M-6 -8 H2 L6 -4 V8 H-6 Z M2 -8 V-4 H6 M-4 -1 H4 M-4 2 H4 M-4 5 H1',
  };

  const CARD_W = 224;
  const CARD_H = 96;
  const MAP_COLUMN_X = [64, 412, 766];
  const MAP_TOP_Y = 92;
  const MAP_V_GAP = 24;
  const MAP_MAX_NODES = 60;

  function mapTypeLabel(type) {
    return MAP_TYPE_LABELS[type] || 'File';
  }

  function mapTypeShort(type) {
    return MAP_TYPE_SHORT[type] || 'FILE';
  }

  function mapLayerForType(type) {
    return MAP_LAYERS.find((layer) => layer.types.indexOf(type) !== -1) || MAP_LAYERS[1];
  }

  function truncateEnd(text, max) {
    const value = String(text || '');
    return value.length <= max ? value : value.slice(0, max - 1) + '\u2026';
  }

  function truncateMiddle(text, max) {
    const value = String(text || '');
    return value.length <= max ? value : '\u2026' + value.slice(value.length - (max - 1));
  }

  function buildMapLayout(map) {
    const nodes = (map.nodes || []).slice(0, MAP_MAX_NODES);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = (map.edges || []).filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const columns = MAP_LAYERS.map(() => []);
    nodes.forEach((node) => {
      columns[MAP_LAYERS.indexOf(mapLayerForType(node.type))].push(node);
    });
    const positions = {};
    let maxColumnHeight = 0;
    columns.forEach((column, index) => {
      column.forEach((node, row) => {
        positions[node.id] = {
          x: MAP_COLUMN_X[index],
          y: MAP_TOP_Y + row * (CARD_H + MAP_V_GAP),
        };
      });
      maxColumnHeight = Math.max(
        maxColumnHeight,
        column.length * CARD_H + Math.max(0, column.length - 1) * MAP_V_GAP
      );
    });
    return {
      nodes: nodes,
      edges: edges,
      positions: positions,
      width: MAP_COLUMN_X[MAP_COLUMN_X.length - 1] + CARD_W + 70,
      height: Math.max(540, MAP_TOP_Y + maxColumnHeight + 48),
    };
  }

  function mapEdgePath(from, to) {
    const fromCenter = from.x + CARD_W / 2;
    const toCenter = to.x + CARD_W / 2;
    if (Math.abs(toCenter - fromCenter) < 20) {
      const x = from.x + CARD_W / 2;
      const y1 = from.y + CARD_H;
      const y2 = to.y;
      const k = Math.max(18, Math.min(60, Math.abs(y2 - y1) / 2));
      return 'M' + x + ' ' + y1 + ' C' + x + ' ' + (y1 + k) + ', ' + x + ' ' + (y2 - k) + ', ' + x + ' ' + y2;
    }
    const forward = toCenter > fromCenter;
    const x1 = forward ? from.x + CARD_W : from.x;
    const y1 = from.y + CARD_H / 2;
    const x2 = forward ? to.x : to.x + CARD_W;
    const y2 = to.y + CARD_H / 2;
    const k = Math.max(28, Math.min(120, Math.abs(x2 - x1) * 0.55));
    const c1 = forward ? x1 + k : x1 - k;
    const c2 = forward ? x2 - k : x2 + k;
    return 'M' + x1 + ' ' + y1 + ' C' + c1 + ' ' + y1 + ', ' + c2 + ' ' + y2 + ', ' + x2 + ' ' + y2;
  }

  function renderMapGraph(map) {
    const layout = buildMapLayout(map);
    if (!layout.nodes.length) {
      return '<div class="workspace-empty"><h3>No files to map</h3></div>';
    }
    const e = CodeStoryUI.escapeHtml;
    const positions = layout.positions;
    const legendItems = map.legend || [];

    const captions = MAP_LAYERS.map((layer, index) => (
      '<text x="' + MAP_COLUMN_X[index] + '" y="58">' + e(layer.title) + '</text>'
    )).join('');
    const dividerOne = MAP_COLUMN_X[0] + CARD_W + (MAP_COLUMN_X[1] - MAP_COLUMN_X[0] - CARD_W) / 2;
    const dividerTwo = MAP_COLUMN_X[1] + CARD_W + (MAP_COLUMN_X[2] - MAP_COLUMN_X[1] - CARD_W) / 2;
    const divider = '<path d="M' + dividerOne + ' 76v' + (layout.height - 92) +
      'M' + dividerTwo + ' 76v' + (layout.height - 92) + '" />';

    const edgeMarkup = layout.edges.map((edge) => {
      const from = positions[edge.from];
      const to = positions[edge.to];
      return '<path class="map-edge" data-from="' + e(edge.from) + '" data-to="' + e(edge.to) +
        '" d="' + mapEdgePath(from, to) + '" marker-end="url(#arch-map-arrow)" />';
    }).join('');

    const nodeMarkup = layout.nodes.map((node) => {
      const position = positions[node.id];
      const glyph = MAP_TYPE_GLYPHS[node.type] || MAP_TYPE_GLYPHS.code;
      return (
        '<g class="map-node type-' + e(node.type) + '" data-node="' + e(node.id) +
          '" data-type="' + e(node.type) + '" data-name="' + e(node.label) +
          '" data-file="' + e(node.path) + '" data-language="' + e(node.language || '') +
          '" role="button" tabindex="0" aria-pressed="false" aria-label="' +
          e(node.label) + ', ' + e(mapTypeLabel(node.type)) + '">' +
          '<rect class="map-node-card" x="' + position.x + '" y="' + position.y +
            '" width="' + CARD_W + '" height="' + CARD_H + '" rx="12" />' +
          '<circle class="map-node-icon" cx="' + (position.x + 27) + '" cy="' + (position.y + 29) + '" r="13" />' +
          '<path class="map-icon-glyph" transform="translate(' + (position.x + 27) + ' ' +
            (position.y + 29) + ')" d="' + glyph + '" />' +
          '<text class="map-node-type" x="' + (position.x + 52) + '" y="' + (position.y + 25) + '">' +
            e(mapTypeShort(node.type)) + '</text>' +
          '<text class="map-node-title" x="' + (position.x + 24) + '" y="' + (position.y + 62) + '">' +
            e(truncateEnd(node.label, 24)) + '</text>' +
          '<text class="map-node-file" x="' + (position.x + 24) + '" y="' + (position.y + 81) + '">' +
            e(truncateMiddle(node.path, 30)) + '</text>' +
          '<circle class="map-node-status" cx="' + (position.x + CARD_W - 16) + '" cy="' +
            (position.y + 20) + '" r="4" />' +
        '</g>'
      );
    }).join('');

    const toolbarFilters = ['<button class="map-filter active" type="button" data-filter="all" aria-pressed="true">All</button>']
      .concat(legendItems.map((item) => (
        '<button class="map-filter" type="button" data-filter="' + e(item.type) +
          '" aria-pressed="false">' + e(item.label) + '</button>'
      )))
      .join('');

    const legendMarkup = legendItems.map((item) => (
      '<span><i class="legend-dot type-' + e(item.type) + '"></i>' + e(item.label) + '</span>'
    )).join('');

    const svg =
      '<svg class="architecture-map" viewBox="0 0 ' + layout.width + ' ' + layout.height +
        '" role="group" aria-label="Project architecture map. Select a component to see details.">' +
        '<defs><marker id="arch-map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
          '<path d="M 0 0 L 10 5 L 0 10 z" fill="#8a9a9f" /></marker></defs>' +
        '<g class="map-layers" aria-hidden="true">' + captions + divider + '</g>' +
        '<g class="map-viewport">' +
          '<g class="map-edges" aria-hidden="true">' + edgeMarkup + '</g>' +
          nodeMarkup +
        '</g>' +
      '</svg>';

    return (
      '<header class="system-map-header">' +
        '<p class="system-map-kicker">SYSTEM ARCHITECTURE</p>' +
        '<div class="system-map-stats" aria-label="Map summary">' +
          '<span><strong>' + layout.nodes.length + '</strong> components</span>' +
          '<span><strong>' + layout.edges.length + '</strong> connections</span>' +
        '</div>' +
      '</header>' +
      '<section class="system-map-toolbar" aria-label="Map controls">' +
        '<label class="system-map-search">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8" />' +
            '<path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />' +
          '</svg>' +
          '<input class="system-map-search-input" type="search" placeholder="Find a component or file..." aria-label="Find a component or file" />' +
        '</label>' +
        '<div class="system-map-filters" role="group" aria-label="Filter components by type">' +
          toolbarFilters +
        '</div>' +
        '<div class="system-map-zoom" role="group" aria-label="Zoom controls">' +
          '<button class="map-zoom-button" type="button" data-zoom="out" aria-label="Zoom out">\u2212</button>' +
          '<span class="map-zoom-level" aria-live="polite">100%</span>' +
          '<button class="map-zoom-button" type="button" data-zoom="in" aria-label="Zoom in">+</button>' +
          '<button class="map-zoom-reset" type="button">Reset</button>' +
        '</div>' +
      '</section>' +
      '<div class="system-map-layout">' +
        '<section class="system-map-canvas" aria-label="Interactive architecture diagram">' +
          '<div class="system-map-stage">' + svg +
            '<p class="system-map-empty" hidden>No components match your search. Try another name or filter.</p>' +
          '</div>' +
          '<footer class="system-map-legend">' + legendMarkup +
            '<span class="map-hint">Select a component to explore it</span>' +
          '</footer>' +
        '</section>' +
        '<aside class="map-details" aria-live="polite" aria-label="Component details">' +
          '<div class="map-details-placeholder">' +
            '<span class="map-details-symbol" aria-hidden="true">\u2197</span>' +
            '<p class="map-details-eyebrow">EXPLORE THE SYSTEM</p>' +
            '<h2>Choose a component</h2>' +
            '<p>Select any node in the map to see where it lives and how it connects to the rest of the system.</p>' +
          '</div>' +
          '<div class="map-details-content" hidden>' +
            '<span class="map-details-type"></span>' +
            '<h2 class="map-details-title"></h2>' +
            '<code class="map-details-file"></code>' +
            '<p class="map-details-description"></p>' +
            '<div class="map-details-connection"><strong>Connections</strong>' +
              '<p class="map-details-connection-copy"></p></div>' +
            '<button class="map-clear-selection" type="button">Clear selection</button>' +
          '</div>' +
        '</aside>' +
      '</div>' +
      (map.notes ? '<p class="workspace-note">' + e(map.notes) + '</p>' : '')
    );
  }

  function wireMapInteractions() {
    const root = contentEl('map');
    if (!root) return;
    const svg = root.querySelector('.architecture-map');
    if (!svg) return;

    const nodes = [...svg.querySelectorAll('.map-node')];
    const edges = [...svg.querySelectorAll('.map-edge')];
    const viewport = svg.querySelector('.map-viewport');
    const searchInput = root.querySelector('.system-map-search-input');
    const emptyState = root.querySelector('.system-map-empty');
    const placeholder = root.querySelector('.map-details-placeholder');
    const details = root.querySelector('.map-details-content');
    const clearButton = root.querySelector('.map-clear-selection');
    const zoomLevel = root.querySelector('.map-zoom-level');
    const filterButtons = [...root.querySelectorAll('.map-filter')];
    const zoomButtons = [...root.querySelectorAll('.map-zoom-button')];
    const zoomReset = root.querySelector('.map-zoom-reset');

    const size = (svg.getAttribute('viewBox') || '0 0 0 0').split(/\s+/);
    const centerX = Number(size[2]) / 2 || 0;
    const centerY = Number(size[3]) / 2 || 0;

    const info = {};
    const outgoing = {};
    const incoming = {};
    nodes.forEach((node) => {
      const id = node.dataset.node;
      info[id] = {
        name: node.dataset.name,
        file: node.dataset.file,
        type: node.dataset.type,
        language: node.dataset.language,
      };
    });
    edges.forEach((edge) => {
      const from = edge.dataset.from;
      const to = edge.dataset.to;
      (outgoing[from] = outgoing[from] || []).push(to);
      (incoming[to] = incoming[to] || []).push(from);
    });

    let selectedNode = null;
    let zoom = 1;
    let activeFilter = 'all';

    const labelFor = (id) => (info[id] ? info[id].name : id);
    const neighborsOf = (id) => new Set([...(outgoing[id] || []), ...(incoming[id] || [])]);

    function refreshEmphasis() {
      const selectedId = selectedNode && selectedNode.dataset.node;
      const neighbors = selectedId ? neighborsOf(selectedId) : new Set();
      edges.forEach((edge) => {
        const hit = Boolean(selectedId) && (edge.dataset.from === selectedId || edge.dataset.to === selectedId);
        edge.classList.toggle('is-muted', Boolean(selectedId) && !hit);
      });
      nodes.forEach((node) => {
        const id = node.dataset.node;
        const isSelected = node === selectedNode;
        const isNeighbor = Boolean(selectedId) && id !== selectedId && neighbors.has(id);
        node.classList.toggle('is-selected', isSelected);
        node.classList.toggle('is-connected', isNeighbor);
        node.classList.toggle('is-muted', Boolean(selectedId) && !isSelected && !isNeighbor);
        node.setAttribute('aria-pressed', String(isSelected));
      });
    }

    function clearSelection() {
      selectedNode = null;
      if (placeholder) placeholder.hidden = false;
      if (details) details.hidden = true;
      refreshEmphasis();
    }

    function selectNode(node) {
      if (!node || !details) return;
      selectedNode = node;
      const id = node.dataset.node;
      const meta = info[id] || {};
      const layer = mapLayerForType(meta.type);
      if (placeholder) placeholder.hidden = true;
      details.hidden = false;
      const typeEl = details.querySelector('.map-details-type');
      const titleEl = details.querySelector('.map-details-title');
      const fileEl = details.querySelector('.map-details-file');
      const descEl = details.querySelector('.map-details-description');
      const connectionsEl = details.querySelector('.map-details-connection-copy');
      if (typeEl) typeEl.textContent = mapTypeLabel(meta.type);
      if (titleEl) titleEl.textContent = meta.name || id;
      if (fileEl) fileEl.textContent = meta.file || id;
      if (descEl) {
        descEl.textContent = 'This file sits in the ' + layer.name + ' layer' +
          (meta.language ? ' and is written in ' + meta.language : '') + '.';
      }
      const out = (outgoing[id] || []).map(labelFor);
      const inc = (incoming[id] || []).map(labelFor);
      let text = '';
      if (out.length) text += 'References: ' + out.join(', ') + '. ';
      if (inc.length) text += 'Referenced by: ' + inc.join(', ') + '.';
      if (connectionsEl) {
        connectionsEl.textContent = text.trim() || 'No detected relationships to other files.';
      }
      refreshEmphasis();
    }

    function refreshFilters() {
      const query = (searchInput && searchInput.value ? searchInput.value : '').trim().toLowerCase();
      nodes.forEach((node) => {
        const matchesType = activeFilter === 'all' || node.dataset.type === activeFilter;
        const haystack = (node.dataset.name + ' ' + node.dataset.file).toLowerCase();
        const matchesSearch = !query || haystack.indexOf(query) !== -1;
        node.classList.toggle('is-filtered', !(matchesType && matchesSearch));
      });
      edges.forEach((edge) => {
        const fromNode = nodes.find((node) => node.dataset.node === edge.dataset.from);
        const toNode = nodes.find((node) => node.dataset.node === edge.dataset.to);
        const hidden = Boolean((fromNode && fromNode.classList.contains('is-filtered')) ||
          (toNode && toNode.classList.contains('is-filtered')));
        edge.classList.toggle('is-filtered', hidden);
      });
      const visible = nodes.filter((node) => !node.classList.contains('is-filtered')).length;
      if (emptyState) emptyState.hidden = visible > 0;
      if (selectedNode && selectedNode.classList.contains('is-filtered')) clearSelection();
      refreshEmphasis();
    }

    function applyZoom() {
      if (zoom === 1) {
        viewport.removeAttribute('transform');
      } else {
        viewport.setAttribute('transform', 'translate(' + centerX + ' ' + centerY + ') scale(' + zoom +
          ') translate(' + (-centerX) + ' ' + (-centerY) + ')');
      }
      if (zoomLevel) zoomLevel.textContent = Math.round(zoom * 100) + '%';
    }

    nodes.forEach((node) => {
      node.addEventListener('click', () => selectNode(node));
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectNode(node);
        }
      });
    });

    if (searchInput) searchInput.addEventListener('input', refreshFilters);
    filterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        activeFilter = button.dataset.filter;
        filterButtons.forEach((filter) => {
          const isActive = filter === button;
          filter.classList.toggle('active', isActive);
          filter.setAttribute('aria-pressed', String(isActive));
        });
        refreshFilters();
      });
    });
    zoomButtons.forEach((button) => {
      button.addEventListener('click', () => {
        zoom = Math.max(0.7, Math.min(1.6, zoom + (button.dataset.zoom === 'in' ? 0.1 : -0.1)));
        applyZoom();
      });
    });
    if (zoomReset) {
      zoomReset.addEventListener('click', () => {
        zoom = 1;
        applyZoom();
      });
    }
    if (clearButton) clearButton.addEventListener('click', clearSelection);
  }

  async function loadMap(project) {
    setStatus('map', 'loading', '<h3>Building system map...</h3>');
    setContent('map', '');
    try {
      const map = await CodeStoryAPI.map(project.id);
      setStatus('map', null);
      setContent('map', renderMapGraph(map));
      wireMapInteractions();
    } catch (error) {
      setStatus('map', 'error', '<h3>Could not build the map</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Issues                                                              */
  /* ------------------------------------------------------------------ */

  function renderIssues(issues) {
    const findings = issues.findings || [];
    if (!findings.length) {
      return '<div class="workspace-empty"><h3>No issues detected</h3><p>Static checks found nothing to report for this project.</p></div>';
    }
    const rows = findings.map((finding) => (
      '<article class="issue-row is-' + CodeStoryUI.escapeHtml(finding.severity) + '">' +
        '<div class="issue-row-head">' +
          '<span class="issue-severity">' + CodeStoryUI.escapeHtml(finding.severity) + '</span>' +
          '<h3>' + CodeStoryUI.escapeHtml(finding.title) + '</h3>' +
          '<span class="issue-source">' +
            (finding.source === 'ai' ? 'AI suggestion' : 'Static analysis') + '</span>' +
        '</div>' +
        (finding.file ? '<p class="issue-file">' + CodeStoryUI.escapeHtml(finding.file) +
          (finding.line ? ':' + finding.line : '') + '</p>' : '') +
        (finding.detail ? '<p class="issue-detail">' + CodeStoryUI.escapeHtml(finding.detail) + '</p>' : '') +
      '</article>'
    )).join('');

    return (
      '<div class="issue-summary">' +
        '<span class="issue-pill warning">' + (issues.summary.warning || 0) + ' warnings</span>' +
        '<span class="issue-pill info">' + (issues.summary.info || 0) + ' notes</span>' +
      '</div>' +
      '<div class="issue-list">' + rows + '</div>' +
      '<p class="workspace-note">' + CodeStoryUI.escapeHtml(issues.disclaimer || '') + '</p>'
    );
  }

  async function loadIssues(project) {
    setStatus('issues', 'loading', '<h3>Scanning for issues...</h3>');
    setContent('issues', '');
    try {
      const issues = await CodeStoryAPI.issues(project.id);
      setStatus('issues', null);
      setContent('issues', renderIssues(issues));
    } catch (error) {
      setStatus('issues', 'error', '<h3>Could not scan for issues</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tab and view orchestration                                          */
  /* ------------------------------------------------------------------ */

  function loadActive() {
    const project = currentProject();
    if (!project) {
      setStatus(activeTab, null);
      setContent(activeTab,
        '<div class="workspace-empty"><h3>No project selected</h3><p>Import a project to explore its story, map and issues.</p></div>');
      return;
    }
    if (activeTab === 'story') loadStory(project);
    else if (activeTab === 'map') loadMap(project);
    else loadIssues(project);
  }

  function setTab(tab) {
    activeTab = tab;
    tabs.forEach((button) => {
      const isActive = button.getAttribute('data-tab') === tab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    page.querySelectorAll('.explorer-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.getAttribute('data-panel') === tab);
    });
    loadActive();
  }

  tabs.forEach((button) => {
    button.addEventListener('click', () => setTab(button.getAttribute('data-tab')));
  });

  selectEl.addEventListener('change', () => {
    const project = projects.find((item) => item.id === selectEl.value);
    if (!project) return;
    currentId = project.id;
    CodeStoryStore.setSelected(project.id, project.name);
    CodeStoryApp.setCurrentProject(project.name);
    updateHeader();
    loadActive();
  });

  refreshButton.addEventListener('click', () => {
    loadActive();
  });

  page.addEventListener('click', (event) => {
    if (Visuals && Visuals.handleClick(event, activeVisuals)) return;
    const imageButton = event.target.closest('[data-story-image]');
    if (imageButton && activeStory && Array.isArray(activeStory.chapters)) {
      const chapter = activeStory.chapters.find(
        (item) => item.id === imageButton.getAttribute('data-story-image'));
      const container = imageButton.closest('.story-illustration');
      if (chapter && container) {
        container.outerHTML = '<div class="story-illustration is-pending" data-image-chapter="' +
          CodeStoryUI.escapeHtml(chapter.id) + '"><p>Preparing an editorial illustration…</p></div>';
        requestChapterImage(chapter);
      }
      return;
    }
    const storyButton = event.target.closest('[data-story]');
    if (storyButton) generateStory();
    const chapterButton = event.target.closest('[data-story-nav]');
    if (chapterButton && activeStory && Array.isArray(activeStory.chapters)) {
      activeChapterIndex += chapterButton.getAttribute('data-story-nav') === 'next' ? 1 : -1;
      renderStoryDocument(activeStory);
      return;
    }
    const stepButton = event.target.closest('[data-story-chapter]');
    if (stepButton && activeStory && Array.isArray(activeStory.chapters)) {
      activeChapterIndex = Number(stepButton.getAttribute('data-story-chapter'));
      renderStoryDocument(activeStory);
      return;
    }
    const explorerTabButton = event.target.closest('[data-explorer-tab]');
    if (explorerTabButton) setTab(explorerTabButton.getAttribute('data-explorer-tab'));
  });

  if (Visuals) {
    page.addEventListener('keydown', (event) => { Visuals.handleKeydown(event, activeVisuals); });
    page.addEventListener('toggle', Visuals.handleToggle, true);
  }

  if (window.matchMedia) {
    const narrowQuery = window.matchMedia('(max-width: 720px)');
    const rerender = () => { if (activeStory && activeStory.text) renderStoryDocument(activeStory); };
    if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', rerender);
    else if (narrowQuery.addListener) narrowQuery.addListener(rerender);
  }

  function updateHeader() {
    const project = currentProject();
    if (project) {
      titleEl.textContent = project.name;
      subEl.textContent = CodeStoryUI.plural(project.file_count || 0, 'file') + ' \u00b7 ' +
        (project.total_lines || 0) + ' lines \u00b7 ' + CodeStoryUI.formatBytes(project.total_size || 0) +
        (project.demo ? ' \u00b7 Built-in Demo Project' : '');
    } else {
      titleEl.textContent = 'No project selected';
      subEl.textContent = 'Import a project to explore its story, map and issues.';
    }
  }

  async function render() {
    setStatus('story', 'loading', '<h3>Loading projects...</h3>');
    try {
      const data = await CodeStoryAPI.listProjects();
      projects = Array.isArray(data.projects) ? data.projects : [];
    } catch (error) {
      projects = [];
      ['story', 'map', 'issues'].forEach((name) => setStatus(name, 'error',
        '<h3>Cannot reach the backend</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>'));
      titleEl.textContent = 'My Explorer';
      subEl.textContent = 'Start the local backend to load your projects.';
      selectEl.innerHTML = '<option value="">Unavailable</option>';
      selectEl.disabled = true;
      return;
    }
    chooseCurrent();
    populateSelect();
    updateHeader();
    loadActive();
  }

  window.ExplorerView = {
    render: render,
    select(projectId) {
      currentId = projectId;
    },
    invalidate() {
      currentId = null;
    },
  };
})();

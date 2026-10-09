/* CodeStory - pages/projects.js
   "My Projects" view: list, filter, open, re-analyze and delete imported
   projects. Data comes from the local backend; nothing here is fabricated. */

(function () {
  'use strict';

  const grid = document.getElementById('projectsGrid');
  if (!grid) {
    return;
  }

  const statusEl = document.getElementById('projectsStatus');
  const countEl = document.getElementById('projectsCount');
  const searchInput = document.getElementById('projectsSearch');
  const importButton = document.getElementById('projectsImportButton');

  let cache = [];

  function setStatus(state, html) {
    if (!html) {
      statusEl.hidden = true;
      statusEl.className = 'workspace-status';
      statusEl.innerHTML = '';
      return;
    }
    statusEl.hidden = false;
    statusEl.className = 'workspace-status is-' + state;
    statusEl.innerHTML = html;
  }

  function languageChips(types) {
    return (types || [])
      .slice(0, 6)
      .map((type) => (
        '<span class="project-chip">' + CodeStoryUI.escapeHtml(type.language) +
        '<b>' + type.count + '</b></span>'
      ))
      .join('');
  }

  function cardHtml(project) {
    const demoBadge = project.demo ? '<span class="project-badge demo">Demo</span>' : '';
    const sourceBadge = '<span class="project-badge">' + CodeStoryUI.escapeHtml(project.source || 'import') + '</span>';
    const selected = CodeStoryStore.getSelected();
    const isCurrent = selected && selected.id === project.id;
    return (
      '<article class="project-card' + (isCurrent ? ' is-current' : '') + '" data-id="' + CodeStoryUI.escapeHtml(project.id) + '">' +
        '<div class="project-card-head">' +
          '<h3>' + CodeStoryUI.escapeHtml(project.name) + '</h3>' +
          '<div class="project-badges">' + demoBadge + sourceBadge + '</div>' +
        '</div>' +
        '<p class="project-meta">' +
          CodeStoryUI.plural(project.file_count || 0, 'file') + ' &middot; ' +
          (project.total_lines || 0) + ' lines &middot; ' +
          CodeStoryUI.formatBytes(project.total_size || 0) +
        '</p>' +
        '<div class="project-chips">' + languageChips(project.detected_types) + '</div>' +
        '<p class="project-date">Added ' + CodeStoryUI.escapeHtml(CodeStoryUI.formatDate(project.created_at)) + '</p>' +
        '<div class="project-actions">' +
          '<button class="workspace-btn primary" type="button" data-action="open">Open</button>' +
          '<button class="workspace-btn" type="button" data-action="select">Set current</button>' +
          '<button class="workspace-btn" type="button" data-action="reanalyze">Re-analyze</button>' +
          '<button class="workspace-btn danger" type="button" data-action="delete">Delete</button>' +
        '</div>' +
      '</article>'
    );
  }

  function renderList() {
    const query = (searchInput.value || '').trim().toLowerCase();
    const filtered = query
      ? cache.filter((project) => {
          const haystack = (project.name + ' ' + (project.detected_types || []).map((t) => t.language).join(' ')).toLowerCase();
          return haystack.indexOf(query) !== -1;
        })
      : cache;

    countEl.textContent = query
      ? filtered.length + ' of ' + cache.length + ' shown'
      : CodeStoryUI.plural(cache.length, 'project');

    if (!filtered.length) {
      grid.innerHTML =
        '<div class="workspace-empty">' +
          '<h3>' + (cache.length ? 'No projects match that filter' : 'No projects yet') + '</h3>' +
          '<p>' + (cache.length
            ? 'Try a different search term.'
            : 'Import a ZIP, folder, files or snippet to get started.') + '</p>' +
          (cache.length ? '' : '<button class="workspace-btn primary" type="button" data-action="import">Import your first project</button>') +
        '</div>';
      return;
    }
    grid.innerHTML = filtered.map(cardHtml).join('');
  }

  async function load() {
    setStatus('loading', '<h3>Loading projects...</h3>');
    grid.innerHTML = '';
    try {
      const data = await CodeStoryAPI.listProjects();
      cache = Array.isArray(data.projects) ? data.projects : [];
      setStatus(null);
      renderList();
    } catch (error) {
      countEl.textContent = '';
      grid.innerHTML = '';
      setStatus('error',
        '<h3>Could not load projects</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>' +
        '<button class="workspace-btn" type="button" data-action="retry">Retry</button>');
    }
  }

  async function reanalyze(project) {
    const card = grid.querySelector('.project-card[data-id="' + project.id + '"]');
    if (card) card.classList.add('is-busy');
    try {
      await CodeStoryAPI.reanalyze(project.id);
      await load();
    } catch (error) {
      if (card) card.classList.remove('is-busy');
      setStatus('error', '<h3>Re-analysis failed</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  async function remove(project) {
    if (!window.confirm('Delete "' + project.name + '"? This removes its stored files from this machine.')) {
      return;
    }
    try {
      await CodeStoryAPI.deleteProject(project.id);
      const selected = CodeStoryStore.getSelected();
      if (selected && selected.id === project.id) {
        CodeStoryStore.setSelected(null);
        CodeStoryApp.setCurrentProject(null);
      }
      await load();
    } catch (error) {
      setStatus('error', '<h3>Delete failed</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  function open(project) {
    CodeStoryStore.setSelected(project.id, project.name);
    CodeStoryApp.setCurrentProject(project.name);
    if (window.ExplorerView) window.ExplorerView.invalidate();
    CodeStoryApp.showView('explorer');
  }

  grid.addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const action = actionButton.getAttribute('data-action');
    if (action === 'import') {
      if (window.CodeStoryImport) CodeStoryImport.open('zip');
      return;
    }
    if (action === 'retry') {
      load();
      return;
    }
    const card = actionButton.closest('.project-card');
    if (!card) return;
    const project = cache.find((item) => item.id === card.getAttribute('data-id'));
    if (!project) return;

    if (action === 'open') open(project);
    else if (action === 'select') {
      CodeStoryStore.setSelected(project.id, project.name);
      CodeStoryApp.setCurrentProject(project.name);
      renderList();
    } else if (action === 'reanalyze') reanalyze(project);
    else if (action === 'delete') remove(project);
  });

  if (importButton) {
    importButton.addEventListener('click', () => {
      if (window.CodeStoryImport) CodeStoryImport.open('zip');
    });
  }
  if (searchInput) {
    searchInput.addEventListener('input', renderList);
  }

  window.ProjectsView = {
    render: load,
    refresh: load,
  };
})();

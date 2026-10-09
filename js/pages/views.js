/* CodeStory - pages/views.js
   Top-level view switching between Home (Overview/Story/Issues/Map) and the
   workspace pages: My Projects, My Explorer and Settings. */

(function () {
  'use strict';

  const VIEW_BY_LABEL = {
    Home: 'home',
    'My Projects': 'projects',
    'My Explorer': 'explorer',
    Settings: 'settings',
  };

  const homeSelectors = [
    '.section-tabs',
    '.overview-topbar',
    '.overview-page',
    '.issues-page',
    '.system-map-page',
    '.content-grid',
    '.bottom-nav',
  ];

  const pageSelectors = {
    projects: '.projects-page',
    explorer: '.explorer-page',
    settings: '.settings-page',
  };

  let currentView = 'home';

  function syncNav(view) {
    document.querySelectorAll('.nav-item').forEach((item) => {
      const itemView = VIEW_BY_LABEL[item.textContent.trim()] || 'home';
      item.classList.toggle('active', itemView === view);
    });
    document.querySelectorAll('.mobile-nav-item').forEach((item) => {
      const itemView = VIEW_BY_LABEL[item.textContent.trim()] || 'home';
      const isActive = itemView === view;
      item.classList.toggle('active', isActive);
      if (isActive) {
        item.setAttribute('aria-current', 'page');
      } else {
        item.removeAttribute('aria-current');
      }
    });
  }

  function showView(view) {
    const target = VIEW_BY_LABEL[view] || view;
    currentView = Object.prototype.hasOwnProperty.call(pageSelectors, target) || target === 'home'
      ? target
      : 'home';

    const isHome = currentView === 'home';
    document.body.dataset.view = currentView;

    Object.keys(pageSelectors).forEach((key) => {
      const element = document.querySelector(pageSelectors[key]);
      if (element) element.hidden = currentView !== key;
    });

    if (isHome) {
      if (typeof showSection === 'function') {
        showSection('Overview');
      }
    } else {
      document.body.classList.remove('showing-overview');
      homeSelectors.forEach((selector) => {
        const element = document.querySelector(selector);
        if (element) element.hidden = true;
      });
    }

    syncNav(currentView);

    if (currentView === 'projects' && window.ProjectsView) window.ProjectsView.render();
    if (currentView === 'explorer' && window.ExplorerView) window.ExplorerView.render();
    if (currentView === 'settings' && window.SettingsView) window.SettingsView.render();
  }

  function setCurrentProject(name) {
    const label = name || 'No project selected';
    const sidebarName = document.getElementById('sidebarCurrentProjectName');
    const topbarName = document.getElementById('topbarProjectName');
    if (sidebarName) sidebarName.textContent = label;
    if (topbarName) topbarName.textContent = label;
  }

  function refreshCurrentProject() {
    const selected = window.CodeStoryStore.getSelected();
    setCurrentProject(selected && selected.name ? selected.name : null);
    return selected;
  }

  function viewForLabel(label) {
    return VIEW_BY_LABEL[label] || 'home';
  }

  window.CodeStoryApp = {
    showView: showView,
    setCurrentProject: setCurrentProject,
    refreshCurrentProject: refreshCurrentProject,
    viewForLabel: viewForLabel,
    getView: () => currentView,
  };

  // A completed import becomes the current project and refreshes open views.
  window.addEventListener('codestory:imported', (event) => {
    const detail = event.detail || {};
    if (detail.project_id) {
      window.CodeStoryStore.setSelected(detail.project_id, detail.project_name || '');
      setCurrentProject(detail.project_name || null);
    }
    if (currentView === 'projects' && window.ProjectsView) window.ProjectsView.render();
    if (window.ExplorerView) window.ExplorerView.invalidate();
  });

  document.addEventListener('DOMContentLoaded', () => {
    refreshCurrentProject();
  });
})();

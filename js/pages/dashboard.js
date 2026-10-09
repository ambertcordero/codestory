/* CodeStory - pages/dashboard.js
   Dashboard page behaviour: section tab switching and the System Map view. */

const sectionTabs = document.querySelectorAll('.section-tab');
const mainPanel = document.querySelector('.main-panel');
const projectTabs = document.querySelector('.section-tabs');
const overviewTopbar = document.querySelector('.overview-topbar');
const overviewPage = document.querySelector('.overview-page');
const issuesPage = document.querySelector('.issues-page');
const systemMapPage = document.querySelector('.system-map-page');
const storyContent = document.querySelector('.content-grid');
const chapterNavigation = document.querySelector('.bottom-nav');
const mobileBottomNavigation = document.querySelector('.mobile-bottom-nav');

function showSection(label) {
  const showingOverview = label === 'Overview';
  const showingIssues = label === 'Issues';
  const showingSystemMap = label === 'System';
  sectionTabs.forEach((button) => {
    const isActive = button.textContent.trim().split(/\s/)[0] === label;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  mainPanel.classList.toggle('is-overview', showingOverview);
  document.body.classList.toggle('showing-overview', showingOverview);
  overviewTopbar.hidden = !showingOverview;
  overviewPage.hidden = !showingOverview;
  issuesPage.hidden = !showingIssues;
  systemMapPage.hidden = !showingSystemMap;
  storyContent.hidden = showingOverview || showingIssues || showingSystemMap;
  chapterNavigation.hidden = showingOverview || showingIssues || showingSystemMap;
  projectTabs.hidden = false;
  mobileBottomNavigation.hidden = false;
}

sectionTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    showSection(tab.textContent.trim().split(/\s/)[0]);
  });
});

const mapNodes = [...document.querySelectorAll('.system-map-page .map-node')];
const mapEdges = [...document.querySelectorAll('.system-map-page .map-edge')];
const mapViewport = document.querySelector('.system-map-page .map-viewport');
const mapSearchInput = document.querySelector('.system-map-page .system-map-search-input');
const mapEmptyState = document.querySelector('.system-map-page .system-map-empty');
const mapDetailsPlaceholder = document.querySelector('.system-map-page .map-details-placeholder');
const mapDetailsContent = document.querySelector('.system-map-page .map-details-content');
const mapZoomLevel = document.querySelector('.system-map-page .map-zoom-level');
let selectedMapNode = null;
let mapZoom = 1;
let activeMapFilter = 'all';

function refreshMapFilters() {
  const query = mapSearchInput.value.trim().toLowerCase();
  mapNodes.forEach((node) => {
    const matchesType = activeMapFilter === 'all' || node.dataset.type === activeMapFilter;
    const matchesSearch = `${node.dataset.name} ${node.dataset.file}`.toLowerCase().includes(query);
    node.classList.toggle('is-filtered', !matchesType || !matchesSearch);
  });

  mapEdges.forEach((edge) => {
    const fromNode = mapNodes.find((node) => node.dataset.node === edge.dataset.from);
    const toNode = mapNodes.find((node) => node.dataset.node === edge.dataset.to);
    edge.classList.toggle('is-filtered', fromNode.classList.contains('is-filtered') || toNode.classList.contains('is-filtered'));
  });

  const visibleCount = mapNodes.filter((node) => !node.classList.contains('is-filtered')).length;
  mapEmptyState.hidden = visibleCount > 0;
  if (selectedMapNode?.classList.contains('is-filtered')) {
    clearMapSelection();
  }
  refreshMapEmphasis();
}

function refreshMapEmphasis() {
  const selectedId = selectedMapNode?.dataset.node;
  const connectedIds = new Set();
  if (selectedId) {
    mapEdges.forEach((edge) => {
      const isConnected = edge.dataset.from === selectedId || edge.dataset.to === selectedId;
      edge.classList.toggle('is-muted', !isConnected);
      if (isConnected) {
        connectedIds.add(edge.dataset.from);
        connectedIds.add(edge.dataset.to);
      }
    });
  } else {
    mapEdges.forEach((edge) => edge.classList.remove('is-muted'));
  }
  mapNodes.forEach((node) => {
    const isSelected = node === selectedMapNode;
    node.classList.toggle('is-selected', isSelected);
    node.classList.toggle('is-connected', Boolean(selectedId && connectedIds.has(node.dataset.node)));
    node.classList.toggle('is-muted', Boolean(selectedId && !connectedIds.has(node.dataset.node)));
    node.setAttribute('aria-pressed', String(isSelected));
  });
}

function selectMapNode(node) {
  selectedMapNode = node;
  mapDetailsPlaceholder.hidden = true;
  mapDetailsContent.hidden = false;
  mapDetailsContent.querySelector('.map-details-type').textContent = node.dataset.type === 'frontend'
    ? 'Frontend'
    : node.dataset.type === 'data' ? 'Data store' : node.dataset.node === 'payments' ? 'External API' : 'Core service';
  mapDetailsContent.querySelector('.map-details-title').textContent = node.dataset.name;
  mapDetailsContent.querySelector('.map-details-file').textContent = node.dataset.file;
  mapDetailsContent.querySelector('.map-details-description').textContent = node.dataset.description;
  mapDetailsContent.querySelector('.map-details-connection-copy').textContent = node.dataset.connection;
  refreshMapEmphasis();
}

function clearMapSelection() {
  if (!mapNodes.length) return;
  selectedMapNode = null;
  mapDetailsPlaceholder.hidden = false;
  mapDetailsContent.hidden = true;
  refreshMapEmphasis();
}

mapNodes.forEach((node) => {
  node.addEventListener('click', () => selectMapNode(node));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectMapNode(node);
    }
  });
});

mapSearchInput.addEventListener('input', refreshMapFilters);
document.querySelectorAll('.system-map-page .map-filter').forEach((button) => {
  button.addEventListener('click', () => {
    activeMapFilter = button.dataset.filter;
    document.querySelectorAll('.system-map-page .map-filter').forEach((filter) => {
      const isActive = filter === button;
      filter.classList.toggle('active', isActive);
      filter.setAttribute('aria-pressed', String(isActive));
    });
    refreshMapFilters();
  });
});

document.querySelectorAll('.system-map-page .map-zoom-button').forEach((button) => {
  button.addEventListener('click', () => {
    mapZoom = Math.max(0.7, Math.min(1.5, mapZoom + (button.dataset.zoom === 'in' ? 0.1 : -0.1)));
    mapViewport.setAttribute('transform', `translate(530 310) scale(${mapZoom}) translate(-530 -310)`);
    mapZoomLevel.textContent = `${Math.round(mapZoom * 100)}%`;
  });
});

document.querySelector('.system-map-page .map-zoom-reset').addEventListener('click', () => {
  mapZoom = 1;
  mapViewport.removeAttribute('transform');
  mapZoomLevel.textContent = '100%';
});
document.querySelector('.system-map-page .map-clear-selection').addEventListener('click', clearMapSelection);

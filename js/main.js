/* CodeStory - main.js
   App level wiring loaded last: global keyboard shortcuts, the project
   selector toggle and the topbar search field. */

const projectSelector = document.querySelector('.project-selector');
projectSelector.addEventListener('click', () => {
  projectSelector.classList.toggle('is-open');
});

const searchInput = document.querySelector('.search-wrap input');
searchInput.addEventListener('input', (event) => {
  const value = event.target.value.trim();
  if (value) {
    searchInput.setAttribute('aria-label', `Searching for ${value}`);
  } else {
    searchInput.setAttribute('aria-label', 'Search this project');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setMobileSidebarOpen(false);
    clearMapSelection();
  }
});

/* CodeStory - components/sidebar.js
   Sidebar toggle and mobile navigation behaviour. */

const navItems = document.querySelectorAll('.nav-item');
const mobileNavItems = document.querySelectorAll('.mobile-nav-item');
const sidebar = document.querySelector('.sidebar');
const sidebarMenuToggle = document.querySelector('.sidebar-menu-toggle');
const overviewSidebarToggle = document.querySelector('.overview-sidebar-toggle');
const sidebarCloseToggle = document.querySelector('.sidebar-close-toggle');
const sidebarBackdrop = document.querySelector('.sidebar-backdrop');

function activateView(label) {
  if (window.CodeStoryApp && typeof window.CodeStoryApp.viewForLabel === 'function') {
    window.CodeStoryApp.showView(window.CodeStoryApp.viewForLabel(label));
  } else if (label === 'Home' && typeof showSection === 'function') {
    showSection('Overview');
  }
}

navItems.forEach((item) => {
  item.addEventListener('click', () => {
    const label = item.textContent.trim();
    navItems.forEach((button) => button.classList.remove('active'));
    item.classList.add('active');
    setMobileNavigation(label);
    activateView(label);
    closeMobileSidebar();
  });
});

sidebarMenuToggle.addEventListener('click', () => {
  setMobileSidebarOpen(!sidebar.classList.contains('is-open'));
});

overviewSidebarToggle.addEventListener('click', () => {
  setMobileSidebarOpen(!sidebar.classList.contains('is-open'));
});

sidebarCloseToggle.addEventListener('click', () => setMobileSidebarOpen(false));
sidebarBackdrop.addEventListener('click', () => setMobileSidebarOpen(false));

function setMobileSidebarOpen(isOpen) {
  sidebar.classList.toggle('is-open', isOpen);
  document.body.classList.toggle('sidebar-open', isOpen);
  sidebarMenuToggle.setAttribute('aria-expanded', String(isOpen));
  sidebarMenuToggle.setAttribute('aria-label', isOpen ? 'Close sidebar menu' : 'Open sidebar menu');
  overviewSidebarToggle.setAttribute('aria-expanded', String(isOpen));
  overviewSidebarToggle.setAttribute('aria-label', isOpen ? 'Close sidebar menu' : 'Open sidebar menu');
  sidebarBackdrop.tabIndex = isOpen ? 0 : -1;
}

function closeMobileSidebar() {
  if (window.matchMedia('(max-width: 640px)').matches) {
    setMobileSidebarOpen(false);
  }
}

mobileNavItems.forEach((item) => {
  item.addEventListener('click', () => {
    const label = item.textContent.trim();
    mobileNavItems.forEach((button) => {
      button.classList.remove('active');
      button.removeAttribute('aria-current');
    });
    item.classList.add('active');
    item.setAttribute('aria-current', 'page');

    navItems.forEach((button) => {
      button.classList.toggle('active', button.textContent.trim() === label);
    });

    activateView(label);
  });
});

function setMobileNavigation(label) {
  mobileNavItems.forEach((button) => {
    const isActive = button.textContent.trim() === label;
    button.classList.toggle('active', isActive);
    if (isActive) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
}

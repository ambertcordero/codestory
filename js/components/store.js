/* CodeStory - components/store.js
   Tiny localStorage wrapper for the currently selected project and cached
   preferences. The backend remains the source of truth for project data. */

(function () {
  'use strict';

  const SELECTED_KEY = 'codestory.selectedProject';
  const PREFS_KEY = 'codestory.uiPrefs';

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch (error) {
      /* Storage may be unavailable; features still work without it. */
    }
  }

  window.CodeStoryStore = {
    getSelected() {
      const raw = read(SELECTED_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && parsed.id ? parsed : null;
      } catch (error) {
        return null;
      }
    },
    setSelected(projectId, name) {
      write(SELECTED_KEY, projectId ? JSON.stringify({ id: projectId, name: name || '' }) : null);
    },
    getPrefs() {
      const raw = read(PREFS_KEY);
      if (!raw) return {};
      try {
        return JSON.parse(raw) || {};
      } catch (error) {
        return {};
      }
    },
    setPrefs(updates) {
      const merged = Object.assign({}, this.getPrefs(), updates || {});
      write(PREFS_KEY, JSON.stringify(merged));
      return merged;
    },
  };
})();

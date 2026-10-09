/* CodeStory - components/api.js
   Thin client for the local CodeStory FastAPI backend. */

(function () {
  'use strict';

  const BASE = (window.CODESTORY_API_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const OFFLINE_MESSAGE =
    'Cannot reach the local CodeStory backend at ' + BASE +
    '. Start it with "python -m uvicorn main:app --port 8000".';

  async function request(path, options) {
    let response;
    try {
      response = await fetch(BASE + path, options);
    } catch (error) {
      const offline = new Error(OFFLINE_MESSAGE);
      offline.offline = true;
      throw offline;
    }

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const message = data && data.detail ? data.detail : 'Request failed (HTTP ' + response.status + ').';
      const failure = new Error(message);
      failure.status = response.status;
      failure.data = data;
      throw failure;
    }
    return data;
  }

  function jsonBody(method, payload) {
    return {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    };
  }

  function id(projectId) {
    return encodeURIComponent(projectId);
  }

  window.CodeStoryAPI = {
    base: BASE,
    health: () => request('/api/health'),
    getDemo: () => request('/api/demo'),
    listProjects: () => request('/api/projects'),
    getProject: (projectId) => request('/api/projects/' + id(projectId)),
    deleteProject: (projectId) => request('/api/projects/' + id(projectId), { method: 'DELETE' }),
    getFile: (projectId, path) =>
      request('/api/projects/' + id(projectId) + '/file?path=' + encodeURIComponent(path)),
    reanalyze: (projectId) => request('/api/projects/' + id(projectId) + '/reanalyze', { method: 'POST' }),
    map: (projectId) => request('/api/projects/' + id(projectId) + '/map'),
    issues: (projectId) => request('/api/projects/' + id(projectId) + '/issues'),
    visuals: (projectId) => request('/api/projects/' + id(projectId) + '/visuals'),
    getStory: (projectId) => request('/api/projects/' + id(projectId) + '/story'),
    createStory: (projectId) => request('/api/projects/' + id(projectId) + '/story', { method: 'POST' }),
    aiStatus: () => request('/api/ai/status'),
    getSettings: () => request('/api/settings'),
    updateSettings: (payload) => request('/api/settings', jsonBody('PUT', payload)),
    clearData: () => request('/api/data', { method: 'DELETE' }),
  };
})();

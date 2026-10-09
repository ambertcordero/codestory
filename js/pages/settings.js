/* CodeStory - pages/settings.js
   "Settings" view: local AI (Ollama) connection, analysis preferences and
   stored-data management. Connection status always reflects the real backend. */

(function () {
  'use strict';

  const page = document.querySelector('.settings-page');
  if (!page) {
    return;
  }

  const badge = document.getElementById('settingsAiStatus');
  const hostInput = document.getElementById('settingsOllamaHost');
  const modelInput = document.getElementById('settingsOllamaModel');
  const imageModelInput = document.getElementById('settingsImageModel');
  const checkButton = document.getElementById('settingsCheckButton');
  const modelList = document.getElementById('settingsModelList');
  const aiHelp = document.getElementById('settingsAiHelp');
  const saveAnalysis = document.getElementById('settingsSaveAnalysis');
  const clearData = document.getElementById('settingsClearData');
  const feedback = document.getElementById('settingsFeedback');

  const excludeGenerated = document.getElementById('settingsExcludeGenerated');
  const excludeDependencies = document.getElementById('settingsExcludeDependencies');
  const flagUnsupported = document.getElementById('settingsFlagUnsupported');
  const maxFileCount = document.getElementById('settingsMaxFileCount');
  const maxFileSize = document.getElementById('settingsMaxFileSize');
  const maxTotalSize = document.getElementById('settingsMaxTotalSize');

  function mbToBytes(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number * 1000 * 1000) : null;
  }

  function bytesToMb(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number / 1000 / 1000) : '';
  }

  let loaded = false;

  function setFeedback(state, html) {
    if (!html) {
      feedback.hidden = true;
      feedback.className = 'settings-feedback';
      feedback.innerHTML = '';
      return;
    }
    feedback.hidden = false;
    feedback.className = 'settings-feedback is-' + state;
    feedback.innerHTML = html;
  }

  function setBadge(state, text) {
    badge.className = 'ai-status-badge is-' + state;
    badge.textContent = text;
  }

  function renderAi(status) {
    if (status.connected) {
      setBadge('online', 'Connected');
      aiHelp.hidden = true;
      const models = status.models || [];
      modelList.innerHTML = models.length
        ? 'Installed models: ' + models.map((name) =>
            '<span class="ai-model-chip' + (name === status.model ? ' is-active' : '') + '">' +
            CodeStoryUI.escapeHtml(name) + '</span>').join('')
        : 'No models installed yet. Run <code>ollama pull qwen2.5-coder:3b</code>.';
      if (!status.model_available) {
        aiHelp.hidden = false;
        aiHelp.innerHTML = '<p>The configured model <code>' + CodeStoryUI.escapeHtml(status.model) +
          '</code> is not installed. Pull it with <code>ollama pull ' + CodeStoryUI.escapeHtml(status.model) +
          '</code> or choose an installed model above.</p>';
      }
    } else {
      setBadge('offline', 'Not connected');
      modelList.textContent = '';
      aiHelp.hidden = false;
      aiHelp.innerHTML = '<p>' + CodeStoryUI.escapeHtml(status.error || 'Ollama is not reachable.') + '</p>' +
        '<p>CodeStory uses a local Ollama model to write project stories. Everything runs offline on this machine. ' +
        'Install Ollama, then run <code>ollama serve</code> and <code>ollama pull qwen2.5-coder:3b</code>.</p>';
    }
  }

  function applySettings(settings) {
    hostInput.value = settings.ollama_host || '';
    modelInput.value = settings.ollama_model || '';
    if (imageModelInput) {
      imageModelInput.value = settings.image_model || '';
    }
    excludeGenerated.checked = settings.exclude_generated !== false;
    excludeDependencies.checked = settings.exclude_dependencies !== false;
    flagUnsupported.checked = settings.flag_unsupported !== false;
    if (maxFileCount) {
      maxFileCount.value = settings.max_file_count || 10000;
    }
    if (maxFileSize) {
      maxFileSize.value = bytesToMb(settings.max_file_size) || 1;
    }
    if (maxTotalSize) {
      maxTotalSize.value = bytesToMb(settings.max_total_size) || 200;
    }
  }

  async function loadSettings() {
    setFeedback(null);
    try {
      const data = await CodeStoryAPI.getSettings();
      applySettings(data.settings || {});
    } catch (error) {
      setFeedback('error', '<h3>Could not load settings</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  async function checkConnection() {
    setBadge('checking', 'Checking...');
    aiHelp.hidden = true;
    modelList.textContent = '';
    try {
      const status = await CodeStoryAPI.aiStatus();
      renderAi(status);
      return status;
    } catch (error) {
      setBadge('offline', 'Not connected');
      aiHelp.hidden = false;
      aiHelp.innerHTML = '<p>' + CodeStoryUI.escapeHtml(error.message) + '</p>';
      return null;
    }
  }

  async function saveAll() {
    setFeedback(null);
    const payload = {
      ollama_host: hostInput.value.trim(),
      ollama_model: modelInput.value.trim(),
      image_model: imageModelInput ? imageModelInput.value.trim() : null,
      exclude_generated: excludeGenerated.checked,
      exclude_dependencies: excludeDependencies.checked,
      flag_unsupported: flagUnsupported.checked,
      max_file_count: maxFileCount && Number(maxFileCount.value) > 0 ?
        Math.round(Number(maxFileCount.value)) : null,
      max_file_size: maxFileSize ? mbToBytes(maxFileSize.value) : null,
      max_total_size: maxTotalSize ? mbToBytes(maxTotalSize.value) : null,
    };
    try {
      const data = await CodeStoryAPI.updateSettings(payload);
      applySettings(data.settings || {});
      setFeedback('success', '<h3>Settings saved</h3><p>Your preferences are stored on this machine.</p>');
      checkConnection();
    } catch (error) {
      setFeedback('error', '<h3>Could not save settings</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  async function clearAll() {
    if (!window.confirm('Delete all imported projects and settings stored by CodeStory on this machine?')) {
      return;
    }
    try {
      await CodeStoryAPI.clearData();
      CodeStoryStore.setSelected(null);
      CodeStoryApp.setCurrentProject(null);
      if (window.ExplorerView) window.ExplorerView.invalidate();
      setFeedback('success', '<h3>Data cleared</h3><p>All stored projects and settings were removed.</p>');
      await loadSettings();
      checkConnection();
    } catch (error) {
      setFeedback('error', '<h3>Could not clear data</h3><p>' + CodeStoryUI.escapeHtml(error.message) + '</p>');
    }
  }

  if (checkButton) checkButton.addEventListener('click', checkConnection);
  if (saveAnalysis) saveAnalysis.addEventListener('click', saveAll);
  if (clearData) clearData.addEventListener('click', clearAll);

  async function render() {
    setBadge('checking', 'Checking...');
    await loadSettings();
    if (!loaded) {
      loaded = true;
    }
    checkConnection();
  }

  window.SettingsView = {
    render: render,
  };
})();

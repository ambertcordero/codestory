/* CodeStory - pages/import.js
   Import dialog behaviour: open/close, import-method switching, local file
   collection, and validation via the local FastAPI backend.

   Imported source code is never executed in the browser. */

(function () {
  'use strict';

  const API_BASE = window.CODESTORY_API_BASE || 'http://127.0.0.1:8000';
  /* Keep these in sync with backend/analyzer.py. */
  const MAX_UPLOAD_BYTES = 200 * 1000 * 1000;
  const MAX_FILES = 10000;
  /* Selections larger than this are packed into a ZIP in the browser and sent
     as a single file - thousands of multipart parts are slow to parse. */
  const ZIP_PACK_THRESHOLD = 250;

  const SUPPORTED_EXTENSIONS = new Set([
    '.html', '.css', '.js', '.ts', '.jsx', '.tsx',
    '.py', '.java', '.php', '.go', '.rs', '.cs',
    '.sql', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini',
    '.md', '.txt',
  ]);

  const EXCLUDED_DIRECTORIES = new Set([
    'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'packages',
    'site-packages', '.venv', 'venv', 'virtualenv', 'env',
    '.git', '.svn', '.hg', '.idea', '.vscode', '.vs',
    'dist', 'build', 'out', 'target', 'bin', 'obj', 'coverage', 'debug',
    'release', '__pycache__', '.next', '.nuxt', '.cache', '.parcel-cache',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', 'logs', 'tmp', 'temp',
    '.terraform', '.gradle', '.mvn', 'cmakefiles', 'pods', 'deriveddata',
    '.ssh', '.aws', '.gnupg',
  ]);

  const EXCLUDED_FILENAMES = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'composer.lock', 'gemfile.lock', 'cargo.lock', 'poetry.lock', 'go.sum',
    '.ds_store', 'thumbs.db', 'desktop.ini', '.npmrc', '.netrc',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts',
  ]);

  const EXCLUDED_SUFFIXES = [
    '.pem', '.key', '.ppk', '.p12', '.pfx', '.keystore', '.jks', '.asc',
    '.gpg', '.min.js', '.min.css', '.map', '.lock', '.pyc', '.pyo', '.class',
    '.o', '.so', '.dll', '.exe', '.bin', '.bak',
  ];

  /* The built-in demo project is served by the local backend, which reads the
     real Simple POS sources from the repository's simple-pos-demo/ folder. */
  const DEMO_SCHEME = 'demo';

  const overlay = document.getElementById('importOverlay');
  if (!overlay) {
    return;
  }

  const closeButton = overlay.querySelector('.import-dialog-close');
  const methodButtons = [...overlay.querySelectorAll('.import-method')];
  const panels = [...overlay.querySelectorAll('.import-panel')];
  const feedback = overlay.querySelector('[data-feedback]');
  const analyzeButtons = [...overlay.querySelectorAll('[data-analyze]')];
  const uploadProjectButton = document.getElementById('uploadProjectButton');
  const tryDemoButton = document.getElementById('tryDemoButton');
  const pasteNameInput = overlay.querySelector('[data-input="paste-name"]');
  const pasteCodeInput = overlay.querySelector('[data-input="paste-code"]');
  const demoStatus = overlay.querySelector('[data-demo-status]');
  const demoContent = overlay.querySelector('[data-demo-content]');
  const demoAnalyzeButton = overlay.querySelector('[data-analyze="demo"]');

  let demoState = { loaded: false, data: null };

  const fileInputs = {};
  overlay.querySelectorAll('input[type="file"]').forEach((input) => {
    fileInputs[input.getAttribute('data-input')] = input;
  });

  let lastFocused = null;

  /* ------------------------------------------------------------------ */
  /* Open / close                                                        */
  /* ------------------------------------------------------------------ */

  function openImport(method) {
    const chosen = method || 'zip';
    lastFocused = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add('import-open');
    setMethod(chosen);
    clearFeedback();
    if (chosen === DEMO_SCHEME) {
      prepareDemo();
    }
    const focusTarget = overlay.querySelector('.import-method.active');
    if (focusTarget) {
      focusTarget.focus();
    }
  }

  function closeImport() {
    overlay.hidden = true;
    document.body.classList.remove('import-open');
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
  }

  if (uploadProjectButton) {
    uploadProjectButton.addEventListener('click', () => openImport('zip'));
  }
  if (tryDemoButton) {
    tryDemoButton.addEventListener('click', () => openImport(DEMO_SCHEME));
  }
  closeButton.addEventListener('click', closeImport);
  feedback.addEventListener('click', (event) => {
    const action = event.target.closest('[data-feedback-action]');
    if (action && action.getAttribute('data-feedback-action') === 'explore') {
      closeImport();
      if (window.CodeStoryApp) {
        CodeStoryApp.showView('explorer');
      }
    }
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      closeImport();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) {
      closeImport();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Method switching                                                    */
  /* ------------------------------------------------------------------ */

  function setMethod(method) {
    methodButtons.forEach((button) => {
      const isActive = button.getAttribute('data-method') === method;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    panels.forEach((panel) => {
      panel.classList.toggle('active', panel.getAttribute('data-panel') === method);
    });
    clearFeedback();
  }

  methodButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const method = button.getAttribute('data-method');
      setMethod(method);
      if (method === DEMO_SCHEME) {
        prepareDemo();
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* File selection                                                      */
  /* ------------------------------------------------------------------ */

  function showFilename(method, files) {
    const label = overlay.querySelector('[data-filename="' + method + '"]');
    if (!label) {
      return;
    }
    let text = '';
    if (files && files.length === 1) {
      text = files[0].name;
    } else if (files && files.length > 1) {
      if (method === 'folder' || method === 'files') {
        const counts = countSelection(files);
        text = files.length.toLocaleString() + ' files selected (' +
          counts.included.toLocaleString() + ' supported, ' +
          counts.skipped.toLocaleString() + ' skipped)';
      } else {
        text = files.length + ' files selected';
      }
    }
    label.textContent = text;
    label.hidden = !text;
  }

  /* Counts supported vs skipped files by name only - cheap enough to run on
     every selection change. Mirrors the backend exclusion lists. */
  function countSelection(files) {
    let included = 0;
    let skipped = 0;
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      if (isExcludedPath(path) || !hasSupportedExtension(path)) {
        skipped += 1;
      } else {
        included += 1;
      }
    }
    return { included: included, skipped: skipped };
  }

  Object.keys(fileInputs).forEach((method) => {
    const input = fileInputs[method];
    input.addEventListener('change', () => {
      clearFeedback();
      showFilename(method, input.files);
      updateAnalyzeState(method);
    });
  });

  function updateAnalyzeState(method) {
    const button = overlay.querySelector('[data-analyze="' + method + '"]');
    if (!button || method === 'paste' || method === 'demo') {
      return;
    }
    const input = fileInputs[method];
    button.disabled = !(input && input.files && input.files.length > 0);
  }

  overlay.querySelectorAll('.import-dropzone').forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    if (!input) {
      return;
    }
    const method = input.getAttribute('data-input');
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-dragover');
      if (!event.dataTransfer || !event.dataTransfer.files.length) {
        return;
      }
      try {
        input.files = event.dataTransfer.files;
      } catch (error) {
        return;
      }
      clearFeedback();
      showFilename(method, input.files);
      updateAnalyzeState(method);
    });
  });

  if (pasteNameInput && pasteCodeInput) {
    const updatePasteState = debounce(() => {
      const button = overlay.querySelector('[data-analyze="paste"]');
      button.disabled = !(pasteNameInput.value.trim() && pasteCodeInput.value.trim());
    }, 120);
    pasteNameInput.addEventListener('input', updatePasteState);
    pasteCodeInput.addEventListener('input', updatePasteState);
  }

  analyzeButtons.forEach((button) => {
    button.addEventListener('click', () => runImport(button.getAttribute('data-analyze')));
  });

  /* ------------------------------------------------------------------ */
  /* Browser support                                                     */
  /* ------------------------------------------------------------------ */

  const folderInput = fileInputs.folder;
  const folderSupported = Boolean(folderInput && 'webkitdirectory' in folderInput);
  if (!folderSupported) {
    const note = overlay.querySelector('[data-unsupported="folder"]');
    if (note) {
      note.hidden = false;
    }
    const folderButton = overlay.querySelector('[data-analyze="folder"]');
    if (folderButton) {
      folderButton.disabled = true;
    }
    const zone = overlay.querySelector('[data-panel="folder"] .import-dropzone');
    if (zone) {
      zone.setAttribute('aria-disabled', 'true');
      zone.style.pointerEvents = 'none';
      zone.style.opacity = '0.5';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Import dispatch                                                     */
  /* ------------------------------------------------------------------ */

  function runImport(method) {
    clearFeedback();
    switch (method) {
      case 'zip':
        return importZip();
      case 'folder':
        return importFolder();
      case 'files':
        return importMultiple();
      case 'single':
        return importSingle();
      case 'paste':
        return importPaste();
      case 'demo':
        return analyzeSelectedDemo();
      default:
        return showError('Unknown import method.');
    }
  }

  async function importZip() {
    const input = fileInputs.zip;
    const file = input && input.files && input.files[0];
    if (!file) {
      return showError('Choose a ZIP file first.');
    }
    if (!/\.zip$/i.test(file.name)) {
      return showError('Please select a .zip archive.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return showError('That ZIP is larger than the ' +
        Math.round(MAX_UPLOAD_BYTES / 1e6) + ' MB limit.');
    }

    showLoading('Uploading and validating ' + file.name + '...');
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('source', 'zip');
    return postImportXHR('/api/import/zip', form, file.name);
  }

  function importFolder() {
    if (!folderSupported) {
      return showError('Folder selection is not supported by this browser. Use Upload ZIP or Multiple Files.');
    }
    const files = Array.from(fileInputs.folder.files || []);
    if (!files.length) {
      return showError('Choose a project folder first.');
    }

    let excluded = 0;
    let unsupported = 0;
    const entries = [];
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      if (isExcludedPath(path)) {
        excluded += 1;
        continue;
      }
      if (!hasSupportedExtension(path)) {
        unsupported += 1;
        continue;
      }
      entries.push({ file: file, path: path });
    }
    if (!entries.length) {
      return showError('No supported source files were found in that folder.');
    }
    const projectName = entries[0].path.split('/')[0] || 'Imported folder';
    const note = 'Found ' + files.length.toLocaleString() + ' files: ' +
      entries.length.toLocaleString() + ' supported, ' +
      (excluded + unsupported).toLocaleString() + ' skipped. ';
    return submitFileList(entries, projectName,
      note + 'Reading and validating ' + entries.length.toLocaleString() + ' files...', 'folder');
  }

  function importMultiple() {
    const files = Array.from(fileInputs.files.files || []);
    if (!files.length) {
      return showError('Choose one or more files first.');
    }
    const entries = files
      .filter((file) => hasSupportedExtension(file.name))
      .map((file) => ({ file: file, path: file.name }));
    if (!entries.length) {
      return showError('None of the selected files use a supported type.');
    }
    const projectName = entries.length === 1 ? basename(entries[0].path) : 'Imported files';
    const skippedNote = files.length !== entries.length
      ? files.length.toLocaleString() + ' files found, ' +
        entries.length.toLocaleString() + ' supported, ' +
        (files.length - entries.length).toLocaleString() + ' skipped. '
      : '';
    return submitFileList(entries, projectName,
      skippedNote + 'Reading and validating ' + entries.length.toLocaleString() + ' files...', 'files');
  }

  function importSingle() {
    const file = fileInputs.single.files && fileInputs.single.files[0];
    if (!file) {
      return showError('Choose a source file first.');
    }
    if (!hasSupportedExtension(file.name)) {
      return showError("Unsupported file type '" + extensionOf(file.name) + "'. " + supportedText());
    }
    return submitFileList([{ file: file, path: file.name }], basename(file.name), 'Validating ' + file.name + '...', 'file');
  }

  function importPaste() {
    const filename = pasteNameInput.value.trim();
    const content = pasteCodeInput.value;
    if (!filename) {
      return showError('Enter a file name (for example snippet.js).');
    }
    if (!content.trim()) {
      return showError('Paste some code before analyzing.');
    }
    if (!hasSupportedExtension(filename)) {
      return showError("Unsupported file type '" + extensionOf(filename) + "'. " + supportedText());
    }

    showLoading('Analyzing ' + filename + '...');
    return postImport('/api/import/snippet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: filename, content: content }),
    });
  }

  function setDemoStatus(state, html) {
    if (!demoStatus) {
      return;
    }
    if (!html) {
      demoStatus.hidden = true;
      demoStatus.className = 'demo-status';
      demoStatus.innerHTML = '';
      return;
    }
    demoStatus.hidden = false;
    demoStatus.className = 'demo-status is-' + state;
    demoStatus.innerHTML = html;
  }

  async function prepareDemo() {
    if (!demoContent || demoState.loaded) {
      return;
    }
    setDemoStatus('loading', '<h3>Loading the built-in demo...</h3>');
    demoContent.hidden = true;
    demoContent.innerHTML = '';
    if (demoAnalyzeButton) {
      demoAnalyzeButton.disabled = true;
    }
    try {
      const data = await CodeStoryAPI.getDemo();
      demoState = { loaded: true, data: data };
      setDemoStatus(null);
      renderDemo(data);
    } catch (error) {
      demoState = { loaded: false, data: null };
      setDemoStatus('error',
        '<h3>Could not load the demo project</h3><p>' + escapeHtml(error.message) + '</p>');
    }
  }

  function renderDemo(data) {
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.length) {
      setDemoStatus('error', '<h3>The demo project is empty</h3>');
      return;
    }

    const header =
      '<div class="demo-header">' +
        '<span class="demo-badge">' + escapeHtml(data.label || 'Built-in Demo Project') + '</span>' +
        '<h3>' + escapeHtml(data.name) + '</h3>' +
        (data.description
          ? '<p class="demo-description">' + escapeHtml(data.description) + '</p>' : '') +
        '<ul class="demo-meta">' +
          '<li>' + files.length + ' supported files</li>' +
          '<li>' + (data.total_lines || 0) + ' lines</li>' +
          '<li>' + formatBytes(data.total_size || 0) + '</li>' +
          '<li>Runs offline</li>' +
        '</ul>' +
      '</div>';

    const rows = files.map((item) => (
      '<li class="demo-file">' +
        '<div class="demo-file-head">' +
          '<label class="demo-file-pick">' +
            '<input type="checkbox" data-demo-check="' + escapeHtml(item.path) + '" checked />' +
            '<span class="demo-file-info">' +
              '<span class="demo-file-path">' + escapeHtml(item.path) + '</span>' +
              '<span class="demo-file-meta">' + escapeHtml(item.language) + ' &middot; ' +
                (item.lines || 0) + ' lines &middot; ' + formatBytes(item.size || 0) + '</span>' +
            '</span>' +
          '</label>' +
          '<button class="demo-file-toggle" type="button" data-demo-preview="' +
            escapeHtml(item.path) + '">View</button>' +
        '</div>' +
        '<pre class="demo-file-preview" data-demo-preview-body hidden></pre>' +
      '</li>'
    )).join('');

    demoContent.innerHTML =
      header +
      '<p class="import-hint">Review the files below, then choose which ones to analyze.</p>' +
      '<ul class="demo-files">' + rows + '</ul>';
    demoContent.hidden = false;
    updateDemoAnalyzeState();
  }

  function selectedDemoPaths() {
    if (!demoContent) {
      return [];
    }
    return [...demoContent.querySelectorAll('[data-demo-check]')]
      .filter((box) => box.checked)
      .map((box) => box.getAttribute('data-demo-check'));
  }

  function updateDemoAnalyzeState() {
    if (!demoAnalyzeButton) {
      return;
    }
    const count = selectedDemoPaths().length;
    demoAnalyzeButton.disabled = count === 0;
    demoAnalyzeButton.textContent = count === 0
      ? 'Select files to analyze'
      : 'Analyze ' + count + ' Selected File' + (count === 1 ? '' : 's');
  }

  function analyzeSelectedDemo() {
    const data = demoState.data;
    if (!data || !Array.isArray(data.files) || !data.files.length) {
      return showError('The demo project is not loaded yet.');
    }
    const selected = selectedDemoPaths();
    if (!selected.length) {
      return showError('Select at least one file to analyze.');
    }
    const byPath = {};
    data.files.forEach((item) => {
      byPath[item.path] = item;
    });
    const entries = selected
      .filter((path) => byPath[path])
      .map((path) => ({
        file: new File([byPath[path].content], basename(path), { type: 'text/plain' }),
        path: path,
      }));
    return submitFileList(entries, data.name, 'Analyzing the built-in demo project...', DEMO_SCHEME);
  }

  if (demoContent) {
    demoContent.addEventListener('change', (event) => {
      if (event.target.matches('[data-demo-check]')) {
        updateDemoAnalyzeState();
      }
    });
    demoContent.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-demo-preview]');
      if (!toggle) {
        return;
      }
      const file = toggle.closest('.demo-file');
      const preview = file && file.querySelector('[data-demo-preview-body]');
      if (!preview) {
        return;
      }
      if (preview.hidden) {
        if (!preview.textContent) {
          const path = toggle.getAttribute('data-demo-preview');
          const match = (demoState.data && demoState.data.files || [])
            .find((item) => item.path === path);
          preview.textContent = match ? match.content : 'Preview unavailable.';
        }
        preview.hidden = false;
        toggle.textContent = 'Hide';
      } else {
        preview.hidden = true;
        toggle.textContent = 'View';
      }
    });
  }

  async function submitFileList(entries, projectName, loadingMessage, source) {
    if (!entries.length) {
      return showError('No supported source files were found.');
    }
    if (entries.length > MAX_FILES) {
      return showError('Too many files: the limit is ' + MAX_FILES.toLocaleString() +
        ' supported files.');
    }
    if (entries.length > ZIP_PACK_THRESHOLD) {
      return submitAsZip(entries, projectName, source);
    }

    showLoading(loadingMessage);
    const form = new FormData();
    entries.forEach((entry) => form.append('files', entry.file, entry.file.name));
    form.append('paths', JSON.stringify(entries.map((entry) => entry.path)));
    form.append('project_name', projectName || '');
    form.append('source', source || 'files');
    return postImport('/api/import/files', { method: 'POST', body: form });
  }

  /* Large selections go up as one browser-built ZIP: a single upload body is
     far faster for the backend to parse than thousands of multipart parts. */
  async function submitAsZip(entries, projectName, source) {
    showLoading('Preparing ' + entries.length.toLocaleString() + ' files for upload...');
    let blob;
    try {
      blob = await buildZip(entries, (done, total) => {
        showLoading('Preparing upload: ' + done.toLocaleString() + ' of ' +
          total.toLocaleString() + ' files...');
      });
    } catch (error) {
      return showError('Could not read the selected files: ' + error.message);
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      return showError('The selected files are too large to upload: the limit is ' +
        Math.round(MAX_UPLOAD_BYTES / 1e6) + ' MB.');
    }
    const form = new FormData();
    form.append('file', blob, (projectName || 'project') + '.zip');
    form.append('source', source || 'files');
    return postImportXHR('/api/import/zip', form, 'the packed project');
  }

  function handleImportResponse(status, data) {
    if (status < 200 || status >= 300) {
      const message = data && data.detail ? data.detail :
        'The import failed (HTTP ' + status + ').';
      return showError(message);
    }
    if (!data || typeof data.file_count !== 'number' || data.file_count < 1) {
      return showError('The import response was invalid. Please try again.');
    }
    return showResult(data);
  }

  async function postImport(path, options) {
    let response;
    try {
      response = await fetch(API_BASE + path, options);
    } catch (error) {
      return showError(cannotReachMessage());
    }

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    return handleImportResponse(response.status, data);
  }

  /* XMLHttpRequest variant so large uploads can report progress. */
  function postImportXHR(path, form, what) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API_BASE + path);
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) {
          const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
          showLoading('Uploading ' + what + '... ' + percent + '%');
        }
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (error) {
          data = null;
        }
        resolve(handleImportResponse(xhr.status, data));
      });
      xhr.addEventListener('error', () => resolve(showError(cannotReachMessage())));
      xhr.addEventListener('abort', () => resolve(showError('The upload was cancelled.')));
      xhr.send(form);
    });
  }

  function cannotReachMessage() {
    return 'Cannot reach the local CodeStory backend at ' + API_BASE +
      '. Start it with "python -m uvicorn main:app --port 8000".';
  }

  /* ------------------------------------------------------------------ */
  /* Client-side ZIP builder (STORE only, no dependencies)               */
  /* ------------------------------------------------------------------ */

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(timestamp) {
    const date = new Date(timestamp || Date.now());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time, date: day };
  }

  function pushUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function pushUint32(view, offset, value) {
    view.setUint32(offset, value, true);
  }

  /* Builds a standard ZIP container (uncompressed) so the backend can stream
     entries out of a single request body. `prepared` items are
     { nameBytes, data, stamp } - byte layout lives here so it stays testable. */
  function buildZipChunks(prepared) {
    const parts = [];
    const central = [];
    let offset = 0;

    prepared.forEach((entry) => {
      const nameBytes = entry.nameBytes;
      const data = entry.data;
      const stamp = entry.stamp;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      pushUint32(local, 0, 0x04034b50);
      pushUint16(local, 4, 20);          // version needed
      pushUint16(local, 6, 0x0800);      // UTF-8 names
      pushUint16(local, 8, 0);           // method: STORE
      pushUint16(local, 10, stamp.time);
      pushUint16(local, 12, stamp.date);
      pushUint32(local, 14, crc);
      pushUint32(local, 18, data.length);
      pushUint32(local, 22, data.length);
      pushUint16(local, 26, nameBytes.length);
      pushUint16(local, 28, 0);

      const directory = new DataView(new ArrayBuffer(46));
      pushUint32(directory, 0, 0x02014b50);
      pushUint16(directory, 4, 20);      // version made by
      pushUint16(directory, 6, 20);      // version needed
      pushUint16(directory, 8, 0x0800);
      pushUint16(directory, 10, 0);
      pushUint16(directory, 12, stamp.time);
      pushUint16(directory, 14, stamp.date);
      pushUint32(directory, 16, crc);
      pushUint32(directory, 20, data.length);
      pushUint32(directory, 24, data.length);
      pushUint16(directory, 28, nameBytes.length);
      pushUint32(directory, 42, offset); // local header offset

      parts.push(local.buffer, nameBytes, data);
      central.push(directory.buffer, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    });

    const centralOffset = offset;
    let centralSize = 0;
    central.forEach((chunk) => { centralSize += chunk.byteLength; });

    const end = new DataView(new ArrayBuffer(22));
    pushUint32(end, 0, 0x06054b50);
    pushUint16(end, 8, prepared.length);
    pushUint16(end, 10, prepared.length);
    pushUint32(end, 12, centralSize);
    pushUint32(end, 16, centralOffset);

    return parts.concat(central).concat([end.buffer]);
  }

  async function buildZip(entries, onProgress) {
    const encoder = new TextEncoder();
    const prepared = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      prepared.push({
        nameBytes: encoder.encode(entry.path),
        data: new Uint8Array(await entry.file.arrayBuffer()),
        stamp: dosDateTime(entry.file.lastModified),
      });
      if (onProgress && (i % 100 === 0 || i === entries.length - 1)) {
        onProgress(i + 1, entries.length);
      }
      if (i % 100 === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
    return new Blob(buildZipChunks(prepared));
  }

  /* ------------------------------------------------------------------ */
  /* Feedback rendering                                                  */
  /* ------------------------------------------------------------------ */

  function clearFeedback() {
    feedback.hidden = true;
    feedback.className = 'import-feedback';
    feedback.innerHTML = '';
  }

  function setFeedback(state, html) {
    feedback.hidden = false;
    feedback.className = 'import-feedback is-' + state;
    feedback.innerHTML = html;
  }

  function showLoading(message) {
    setFeedback('loading', '<h3>Importing...</h3><p>' + escapeHtml(message) + '</p>');
  }

  function showError(message) {
    setFeedback('error', '<h3>Import failed</h3><p>' + escapeHtml(message) + '</p>');
  }

  function showResult(result) {
    const types = result.detected_types || [];
    const chips = types
      .map((type) => (
        '<li class="import-type-chip">' + escapeHtml(type.language) +
        ' <span>' + type.count + '</span></li>'
      ))
      .join('');

    const skipped = result.skipped || {};
    const skippedParts = Object.keys(skipped).map(
      (category) => category + ': ' + skipped[category].length
    );
    const skippedLine = skippedParts.length
      ? '<p class="import-skipped">Excluded ' + escapeHtml(skippedParts.join(', ')) + '</p>'
      : '';

    setFeedback('success',
      '<h3>Imported "' + escapeHtml(result.project_name) + '"</h3>' +
      '<p>Validated locally. No source code was executed.</p>' +
      '<ul class="import-result-meta">' +
      '<li>' + result.file_count + ' files</li>' +
      '<li>' + (result.total_lines || 0) + ' lines</li>' +
      '<li>' + formatBytes(result.total_size || 0) + '</li>' +
      (result.skipped_count ? '<li>' + result.skipped_count + ' skipped</li>' : '') +
      '</ul>' +
      (chips ? '<ul class="import-type-list">' + chips + '</ul>' : '') +
      skippedLine +
      '<div class="import-result-actions">' +
      '<button class="import-analyze" type="button" data-feedback-action="explore">' +
      'Open in My Explorer</button></div>'
    );

    if (result.project_id) {
      window.dispatchEvent(new CustomEvent('codestory:imported', { detail: result }));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Utilities                                                           */
  /* ------------------------------------------------------------------ */

  function extensionOf(name) {
    const lower = String(name).toLowerCase();
    const index = lower.lastIndexOf('.');
    return index >= 0 ? lower.slice(index) : '(none)';
  }

  function hasSupportedExtension(name) {
    return SUPPORTED_EXTENSIONS.has(extensionOf(name));
  }

  function isExcludedPath(path) {
    const lower = String(path).toLowerCase();
    const parts = lower.split('/');
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (EXCLUDED_DIRECTORIES.has(parts[i])) {
        return true;
      }
    }
    const filename = parts[parts.length - 1];
    if (filename.startsWith('.env')) {
      return true;
    }
    if (EXCLUDED_FILENAMES.has(filename)) {
      return true;
    }
    return EXCLUDED_SUFFIXES.some((suffix) => filename.endsWith(suffix));
  }

  function basename(path) {
    const parts = String(path).split('/');
    return parts[parts.length - 1];
  }

  function supportedText() {
    return 'Supported types: ' + [...SUPPORTED_EXTENSIONS].join(', ') + '.';
  }

  function formatBytes(bytes) {
    if (bytes < 1000) {
      return bytes + ' B';
    }
    if (bytes < 1_000_000) {
      return (bytes / 1000).toFixed(1) + ' KB';
    }
    return (bytes / 1_000_000).toFixed(2) + ' MB';
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(fn, wait);
    };
  }

  window.CodeStoryImport = {
    open: openImport,
    close: closeImport,
    setMethod: setMethod,
    run: runImport,
    submitZip: importZip,
    submitFolder: importFolder,
    submitMultiple: importMultiple,
    submitSingle: importSingle,
    submitPaste: importPaste,
    loadDemo: analyzeSelectedDemo,
    prepareDemo: prepareDemo,
  };
})();

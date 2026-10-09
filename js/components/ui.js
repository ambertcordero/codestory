/* CodeStory - components/ui.js
   Small shared helpers for the workspace pages: escaping, formatting and a
   minimal, safe markdown renderer. */

(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1000) return value + ' B';
    if (value < 1_000_000) return (value / 1000).toFixed(1) + ' KB';
    return (value / 1_000_000).toFixed(2) + ' MB';
  }

  function formatDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function plural(count, singular, pluralWord) {
    return count + ' ' + (count === 1 ? singular : (pluralWord || singular + 's'));
  }

  /* Minimal markdown: headings, bullet lists, fenced code and paragraphs.
     Everything is HTML-escaped first, so this is safe for untrusted text. */
  function renderMarkdown(text) {
    const lines = escapeHtml(text || '').split(/\r?\n/);
    const html = [];
    let inCode = false;
    let inList = false;

    function closeList() {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
    }

    lines.forEach((line) => {
      if (/^```/.test(line.trim())) {
        if (inCode) {
          html.push('</code></pre>');
          inCode = false;
        } else {
          closeList();
          html.push('<pre class="story-code"><code>');
          inCode = true;
        }
        return;
      }
      if (inCode) {
        html.push(line);
        return;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length + 1;
        html.push('<h' + level + ' class="story-heading">' + heading[2] + '</h' + level + '>');
        return;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) {
          html.push('<ul class="story-list">');
          inList = true;
        }
        html.push('<li>' + bullet[1] + '</li>');
        return;
      }
      if (!line.trim()) {
        closeList();
        return;
      }
      closeList();
      html.push('<p>' + line + '</p>');
    });

    closeList();
    if (inCode) html.push('</code></pre>');
    return html.join('\n');
  }

  window.CodeStoryUI = {
    escapeHtml: escapeHtml,
    formatBytes: formatBytes,
    formatDate: formatDate,
    plural: plural,
    renderMarkdown: renderMarkdown,
  };
})();

// ── Shared viewer — called by both local exports and share viewer ────
// Usage: renderApp({ messages, title, source, project, timestamp }, rawDownloadData)

function renderApp(data, rawDownloadData, viewerConfig) {
  var allMessages = data.messages || [];
  var meta = {
    title: data.title || '',
    source: data.source || '',
    project: data.project || '',
    timestamp: data.timestamp || '',
    modelId: data.modelId || '',
    githubUsername: data.githubUsername || '',
    githubAvatarUrl: data.githubAvatarUrl || ''
  };
  var config = viewerConfig || {};
  var configuredUserLabel = (typeof config.userLabel === 'string' && config.userLabel.trim()) ? config.userLabel.trim() : 'user';
  var assistantFallbackLabel = (typeof config.assistantFallbackLabel === 'string' && config.assistantFallbackLabel.trim()) ? config.assistantFallbackLabel.trim() : 'assistant';
  var metadataUserLabel = meta.githubUsername ? ('@' + meta.githubUsername.replace(/^@/, '')) : '';
  var userLabel = metadataUserLabel || configuredUserLabel;
  var userAvatarUrl = meta.githubAvatarUrl || (typeof config.userAvatarUrl === 'string' ? config.userAvatarUrl.trim() : '');
  var modelLabel = meta.modelId || '';
  if (!modelLabel) {
    for (var mi = allMessages.length - 1; mi >= 0; mi--) {
      if (allMessages[mi] && allMessages[mi].modelId) { modelLabel = allMessages[mi].modelId; break; }
    }
  }

  var themeStorageKey = 'opentraces.theme';
  var systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function normalizeThemePreference(value) {
    return value === 'light' || value === 'dark' ? value : 'system';
  }

  function getStoredThemePreference() {
    try {
      return normalizeThemePreference(localStorage.getItem(themeStorageKey) || 'system');
    } catch (e) {
      return 'system';
    }
  }

  function getResolvedTheme(preference) {
    if (preference === 'system') {
      return systemThemeMedia.matches ? 'dark' : 'light';
    }
    return preference;
  }

  function applyTheme(preference) {
    var resolved = getResolvedTheme(preference);
    document.documentElement.setAttribute('data-theme', resolved);
  }

  function persistThemePreference(preference) {
    try {
      localStorage.setItem(themeStorageKey, preference);
    } catch (e) {}
  }

  var themePreference = getStoredThemePreference();
  applyTheme(themePreference);

  // ── Helpers ──────────────────────────────────────────────────────
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function md(t) {
    var h = esc(t);
    h = h.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    h = h.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    h = h.replace(/\n\n/g, '</p><p>');
    return '<p>' + h + '</p>';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function truncate(s, n) {
    n = n || 80;
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  function messageWho(m, isTool) {
    if (isTool) return m.toolName;
    if (m.role === 'user') return userLabel;
    if (m.role === 'assistant') return m.modelId || modelLabel || assistantFallbackLabel;
    return m.role;
  }

  // ── Filter state ───────────────────────────────────────────────
  var filterMode = 'default';
  var searchQuery = '';

  function passesFilter(m) {
    if (filterMode === 'user') return m.role === 'user';
    if (filterMode === 'no-tools') return !m.toolName;
    return true;
  }

  function passesSearch(m) {
    if (!searchQuery) return true;
    var tokens = searchQuery.toLowerCase().split(/\s+/);
    var text = (m.content + ' ' + m.role + ' ' + (m.toolName || '')).toLowerCase();
    for (var i = 0; i < tokens.length; i++) {
      if (text.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  }

  // ── Header ─────────────────────────────────────────────────────
  document.getElementById('page-header').innerHTML =
    '<h1>' + esc(meta.title || 'Conversation') + '</h1>' +
    '<div class="meta">' +
    '<span class="source">' + esc(meta.source) + '</span>' +
    (modelLabel ? '<span class="session-model">' + esc(modelLabel) + '</span>' : '') +
    (metadataUserLabel ? '<span class="session-user">' + esc(metadataUserLabel) + '</span>' : '') +
    '<span>' + esc(meta.project) + '</span>' +
    '<span>' + esc(meta.timestamp) + '</span>' +
    '<span>' + allMessages.length + ' messages</span>' +
    '<button class="dl-btn" id="dl-btn">&#8595; JSONL</button>' +
    '</div>' +
    '<div class="help-bar">Ctrl+O toggle tools · Esc clear search</div>';

  if (systemThemeMedia && typeof systemThemeMedia.addEventListener === 'function') {
    systemThemeMedia.addEventListener('change', function () {
      if (themePreference === 'system') applyTheme(themePreference);
    });
  }

  // ── Download ───────────────────────────────────────────────────
  document.getElementById('dl-btn').addEventListener('click', function () {
    var content = rawDownloadData || allMessages.map(function (m) { return JSON.stringify(m); }).join('\n');
    var blob = new Blob([content], { type: 'application/x-ndjson' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (meta.title || 'session').replace(/[^a-z0-9]/gi, '_').slice(0, 50) + '.jsonl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ── Rendering ──────────────────────────────────────────────────
  var thread = document.getElementById('thread');
  var treeContainer = document.getElementById('tree-container');
  var treeStatus = document.getElementById('tree-status');
  var treeStatusCount = document.createElement('span');
  treeStatusCount.className = 'tree-status-count';

  var treeThemeWrap = document.createElement('label');
  treeThemeWrap.className = 'tree-theme-wrap';
  treeThemeWrap.innerHTML = '<span>theme</span>';

  var themeSelect = document.createElement('select');
  themeSelect.className = 'tree-theme-select';
  themeSelect.innerHTML =
    '<option value="system">system</option>' +
    '<option value="dark">dark</option>' +
    '<option value="light">light</option>';
  themeSelect.value = themePreference;
  themeSelect.addEventListener('change', function (e) {
    themePreference = normalizeThemePreference(e.target.value);
    persistThemePreference(themePreference);
    applyTheme(themePreference);
  });

  treeThemeWrap.appendChild(themeSelect);
  treeStatus.innerHTML = '';
  treeStatus.appendChild(treeStatusCount);
  treeStatus.appendChild(treeThemeWrap);

  function refresh() {
    thread.innerHTML = '';
    treeContainer.innerHTML = '';
    var total = 0;
    var visible = 0;

    allMessages.forEach(function (m, idx) {
      total++;
      if (!passesFilter(m) || !passesSearch(m)) return;
      visible++;

      // Message
      var d = document.createElement('div');
      var isTool = !!m.toolName;
      d.className = 'msg ' + (isTool ? 'tool' : m.role);
      d.id = 'msg-' + idx;
      if (isTool) d.dataset.tool = '1';
      var who = messageWho(m, isTool);
      var whoPrefix = (!isTool && m.role === 'user' && userAvatarUrl)
        ? '<img class="who-avatar" src="' + esc(userAvatarUrl) + '" alt="avatar">'
        : '';
      var time = fmtTime(m.timestamp);
      d.innerHTML =
        (time ? '<span class="time">' + time + '</span>' : '') +
        '<div class="who">' + whoPrefix + '<span>' + esc(who) + '</span></div>' +
        '<div class="body">' + (isTool ? '<pre>' + esc(m.content) + '</pre>' : md(m.content)) + '</div>';
      thread.appendChild(d);

      // Tree node
      var tn = document.createElement('div');
      tn.className = 'tree-node';
      var roleClass = isTool ? 'tree-role-tool' : m.role === 'user' ? 'tree-role-user' : 'tree-role-assistant';
      var preview = m.content.replace(/[\n\t]/g, ' ').trim();
      var treeWho = messageWho(m, isTool);
      tn.innerHTML =
        '<span class="tree-marker">&bull;</span>' +
        '<span class="tree-content"><span class="' + roleClass + '">' + esc(treeWho) + ':</span> ' +
        esc(truncate(preview, 60)) + '</span>';
      (function (i) {
        tn.addEventListener('click', function () {
          var target = document.getElementById('msg-' + i);
          if (target) {
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target.classList.add('highlight');
            setTimeout(function () { target.classList.remove('highlight'); }, 2000);
          }
          treeContainer.querySelectorAll('.tree-node').forEach(function (n) { n.classList.remove('active'); });
          tn.classList.add('active');
        });
      })(idx);
      treeContainer.appendChild(tn);
    });

    treeStatusCount.textContent = visible + ' / ' + total + ' entries';
  }

  refresh();

  // ── Search ─────────────────────────────────────────────────────
  document.getElementById('tree-search').addEventListener('input', function (e) {
    searchQuery = e.target.value;
    refresh();
  });

  // ── Filter buttons ─────────────────────────────────────────────
  var filterBtns = document.querySelectorAll('.filter-btn');
  for (var _i = 0; _i < filterBtns.length; _i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var _j = 0; _j < filterBtns.length; _j++) filterBtns[_j].classList.remove('active');
        btn.classList.add('active');
        filterMode = btn.getAttribute('data-filter') || 'default';
        refresh();
      });
    })(filterBtns[_i]);
  }

  // ── Sidebar toggle (mobile) ────────────────────────────────────
  var sidebar = document.getElementById('sidebar');
  var sidebarOverlay = document.getElementById('sidebar-overlay');
  var hamburgerBtn = document.getElementById('hamburger');

  hamburgerBtn.addEventListener('click', function () {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('open');
    hamburgerBtn.style.display = 'none';
  });

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
    hamburgerBtn.style.display = '';
  }

  sidebarOverlay.addEventListener('click', closeSidebar);
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);

  // ── Keyboard shortcuts ─────────────────────────────────────────
  var toolsVisible = true;
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 'o') {
      e.preventDefault();
      toolsVisible = !toolsVisible;
      var tools = document.querySelectorAll('[data-tool]');
      for (var i = 0; i < tools.length; i++) tools[i].classList.toggle('hidden', !toolsVisible);
    }
    if (e.key === 'Escape') {
      var search = document.getElementById('tree-search');
      if (search.value) { search.value = ''; searchQuery = ''; refresh(); }
    }
  });
}

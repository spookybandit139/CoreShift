(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const stage = byId('intelStage');
  if (!stage) return;

  const api = window.coreShiftAPI;
  const GROUPS = ['Core', 'Intelligence', 'US Search', 'Infrastructure', 'Social', 'Tools'];
  const MODULES = [
    ['dashboard', 'Dashboard', 'Core', 'Local workspace overview', 'dashboard'],
    ['activity', 'Activity', 'Core', 'Session actions without raw queries', 'activity'],
    ['cases', 'Cases', 'Core', 'Authorized research cases and evidence', 'cases'],
    ['web-databases', 'Web Databases', 'Intelligence', 'Plan authorized checks across named providers', 'databases'],
    ['reverse-face', 'Reverse Face Search', 'Intelligence', 'Local image fingerprint; no identity inference', 'file'],
    ['image-geolocation', 'Image Geolocation', 'Intelligence', 'Inspect local image metadata without location claims', 'file'],
    ['gmail-lookup', 'Gmail Lookup', 'Intelligence', 'Local email validation and source plan', 'search'],
    ['hudson-rock', 'Hudson Rock', 'Intelligence', 'External provider launch plan', 'provider'],
    ['seon', 'SEON', 'Intelligence', 'External provider launch plan', 'provider'],
    ['phone-search', 'Phone Search', 'US Search', 'Normalize a phone number and plan public-source review', 'search'],
    ['address-search', 'Address Search', 'US Search', 'Normalize an address and plan map review', 'search'],
    ['email-search', 'Email Search', 'US Search', 'Validate an email and plan public-source review', 'search'],
    ['person-search', 'Person Search', 'US Search', 'Build a consent-aware public search plan', 'search'],
    ['ip-info', 'IP Info', 'Infrastructure', 'Local address classification with optional live context', 'ip'],
    ['port-scan', 'Port Scan', 'Infrastructure', 'Authorization-first passive inspection plan; no active scan', 'provider'],
    ['whois', 'Whois', 'Infrastructure', 'Live registration data from RDAP', 'rdap'],
    ['dns-recon', 'DNS Recon', 'Infrastructure', 'Live DNS and MX records from Google DNS', 'dns'],
    ['shodan', 'Shodan', 'Infrastructure', 'Passive external provider launch plan', 'provider'],
    ['certificate-lookup', 'Certificate Lookup', 'Infrastructure', 'Certificate transparency source plan', 'provider'],
    ['usernames', 'Usernames', 'Social', 'Candidate profile URLs with no existence claims', 'username'],
    ['github', 'GitHub', 'Social', 'Public account metadata from GitHub API', 'github'],
    ['roblox', 'Roblox', 'Social', 'Official public profile pivot plan', 'roblox'],
    ['discord', 'Discord', 'Social', 'Decode a public snowflake locally', 'discord'],
    ['tiktok', 'TikTok', 'Social', 'Official profile link plan with no existence claim', 'provider'],
    ['evidence-hash', 'Evidence Hash', 'Tools', 'SHA-256 and basic metadata computed locally', 'file'],
    ['url-inspector', 'URL Inspector', 'Tools', 'Normalize a URL and inspect hostname signals locally', 'url'],
    ['discord-id-decoder', 'Discord ID Decoder', 'Tools', 'Decode Discord snowflake fields locally', 'discord'],
    ['roblox-profile-inspector', 'Roblox Profile Inspector', 'Tools', 'Official profile pivot with safe compromise guidance', 'roblox'],
    ['relationship-graph', 'Relationship Graph', 'Tools', 'Case-to-evidence links without inferred identity', 'graph'],
    ['timeline', 'Timeline', 'Tools', 'Chronological case evidence view', 'timeline'],
    ['report-builder', 'Report Builder', 'Tools', 'Review and export case JSON', 'report'],
    ['source-notes', 'Source Notes', 'Tools', 'Add attributed notes to the active case', 'notes'],
    ['double-counter-bypass', 'Double Counter Bypass', 'Tools', 'EXCLUDED — evasion or bypass behavior is not implemented', 'disabled', true],
    ['discord-alt-identifier', 'Discord Alt Identifier', 'Tools', 'EXCLUDED — automatic alt identification is not implemented', 'disabled', true]
  ].map(([id, label, group, description, mode, disabled = false]) => ({ id, label, group, description, mode, disabled }));

  const APPROVED_HOSTS = new Set([
    'api.github.com', 'github.com', 'ipwho.is', 'dns.google', 'rdap.org', 'www.google.com',
    'www.usa.gov', 'discord.com', 'www.roblox.com', 'www.tiktok.com', 'www.shodan.io',
    'crt.sh', 'www.hudsonrock.com', 'hudsonrock.com', 'seon.io', 'www.seon.io',
    'support.google.com', 'leakcheck.io', 'snusbase.com', 'cloudsint.com'
  ]);
  const state = {
    cases: [], activeCaseId: '', activeModule: 'dashboard', activity: [], account: null,
    liveRuns: 0, fileModule: null, pendingEvidence: null, startedAt: new Date().toISOString(),
    requestController: null, requestSerial: 0
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const add = (parent, ...children) => {
    children.flat().forEach(child => child !== null && child !== undefined && parent.append(child));
    return parent;
  };
  const btn = (label, className, handler) => {
    const node = el('button', className, label); node.type = 'button';
    if (handler) node.addEventListener('click', handler);
    return node;
  };
  const toast = message => typeof window.coreShiftToast === 'function' && window.coreShiftToast(message);
  const moduleById = id => MODULES.find(item => item.id === id);
  const activeCase = () => state.cases.find(item => item.id === state.activeCaseId) || null;
  const stamp = value => new Date(value).toLocaleString();
  const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const safeText = (value, limit = 1200) => String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, limit);
  const badgeClass = value => {
    const label = String(value || '').toLowerCase();
    if (label.includes('demo')) return ' demo';
    if (label.includes('live')) return ' live';
    if (label.includes('unverified')) return ' unverified';
    if (label.includes('excluded')) return ' excluded';
    if (label.includes('unavailable')) return ' unavailable';
    if (label.includes('manual')) return ' manual';
    return ' local';
  };
  const setBusy = busy => { stage.setAttribute('aria-busy', String(busy)); };
  const setEgress = message => { byId('intelEgressNotice').textContent = message; };
  const resetEgress = () => setEgress('No network request is running. Live providers require confirmation for every lookup.');

  function log(moduleId, action, status = 'complete') {
    state.activity.unshift({ id: uid('event'), moduleId, action, status, at: new Date().toISOString() });
    state.activity = state.activity.slice(0, 80);
  }

  function cleanCase(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: safeText(raw.id || uid('case'), 80), title: safeText(raw.title, 100),
      purpose: safeText(raw.purpose, 500), authorization: safeText(raw.authorization, 500),
      createdAt: raw.createdAt || new Date().toISOString(),
      evidence: Array.isArray(raw.evidence) ? raw.evidence.slice(0, 500).map(item => ({
        id: safeText(item.id || uid('evidence'), 80), title: safeText(item.title, 160),
        module: safeText(item.module, 80), classification: safeText(item.classification, 40),
        source: safeText(item.source, 200), capturedAt: item.capturedAt || new Date().toISOString(),
        fields: Array.isArray(item.fields) ? item.fields.slice(0, 80).map(pair => [safeText(pair[0], 100), safeText(pair[1], 1500)]) : []
      })) : [],
      notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 300).map(note => ({
        id: safeText(note.id || uid('note'), 80), title: safeText(note.title, 120), text: safeText(note.text, 2000),
        source: safeText(note.source, 400), createdAt: note.createdAt || new Date().toISOString()
      })) : []
    };
  }

  async function persistCases() {
    try {
      state.cases = state.cases.slice(0, 100).map(cleanCase).filter(Boolean);
      await api.saveSettings({ intelligenceWorkspace: { version: 1, cases: state.cases } });
      updateCaseSelect();
    } catch (error) { toast(`Could not save cases: ${error.message}`); }
  }

  function updateCaseSelect() {
    const select = byId('intelActiveCaseSelect');
    select.replaceChildren();
    add(select, new Option('No active case', ''));
    state.cases.forEach(item => add(select, new Option(item.title, item.id)));
    if (!state.cases.some(item => item.id === state.activeCaseId)) state.activeCaseId = '';
    select.value = state.activeCaseId;
  }

  function viewHeader(module, eyebrow) {
    const root = el('div');
    const header = el('header', 'intel-view-header');
    const copy = el('div');
    add(copy, el('small', 'intel-eyebrow', eyebrow || module.group.toUpperCase()), el('h2', 'intel-title', module.label), el('p', 'intel-subtitle', module.description));
    const badgeLabel = module.disabled ? 'EXCLUDED' : ['github', 'ip', 'dns', 'rdap'].includes(module.mode) ? 'CONSENT PER RUN' : 'LOCAL FIRST';
    const badge = el('span', `intel-status-badge${badgeClass(badgeLabel)}`, badgeLabel);
    add(header, copy, badge); add(root, header); return root;
  }

  function card(title, body, className = '') {
    const node = el('article', `intel-card ${className}`.trim());
    const head = el('header', 'intel-card-head'); add(head, el('h3', '', title));
    const content = el('div', 'intel-card-body');
    if (body instanceof Node) add(content, body); else content.textContent = String(body ?? '');
    add(node, head, content); return node;
  }

  function field(label, control) {
    const wrap = el('label', 'intel-field'); add(wrap, el('span', '', label), control); return wrap;
  }

  function makeInput(placeholder, type = 'text') {
    const input = el('input', 'intel-input'); input.type = type; input.placeholder = placeholder;
    input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 300; return input;
  }

  function evidenceFrom(module, title, classification, source, fields) {
    return { id: uid('evidence'), title, module: module.label, classification, source, capturedAt: new Date().toISOString(), fields };
  }

  async function addEvidence(evidence) {
    const current = activeCase();
    if (!current) { state.pendingEvidence = evidence; openCaseModal(); toast('Create or select a case before adding evidence.'); return; }
    if (current.evidence.length >= 500) return toast('This case has reached the 500-item evidence limit. Export or remove items before adding more.');
    current.evidence.unshift(evidence); await persistCases(); log(state.activeModule, 'Added a result to the active case');
    toast(`Evidence added to ${current.title}.`);
  }

  async function copyCitation(evidence) {
    const text = `CoreShift Intelligence — ${evidence.title}. Source: ${evidence.source}. Retrieved: ${evidence.capturedAt}. Classification: ${evidence.classification}.`;
    try { await navigator.clipboard.writeText(text); toast('Citation copied.'); }
    catch { const area = el('textarea'); area.value = text; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); toast('Citation copied.'); }
  }

  function openApproved(url, moduleId) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !APPROVED_HOSTS.has(parsed.hostname)) throw new Error('Source is not approved.');
      setEgress(`Opening ${parsed.hostname} shares the encoded identifier with that provider.`);
      log(moduleId, 'Opened an approved HTTPS source');
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
      setTimeout(resetEgress, 5000);
    } catch (error) { toast(error.message); }
  }

  function renderResult(module, { title, badge = 'LOCAL', fields = [], source = 'Local analysis', sourceUrl = '', note = '' }) {
    const root = viewHeader(module);
    const result = el('article', 'intel-result-card');
    const head = el('header', 'intel-result-head'); add(head, el('div', '', title), el('span', `intel-status-badge${badgeClass(badge)}`, badge));
    const grid = el('div', 'intel-result-fields');
    fields.forEach(([key, value]) => { const row = el('div', 'intel-kv'); add(row, el('small', '', key), el('b', '', value)); add(grid, row); });
    if (note) add(grid, el('p', 'intel-notice', note));
    const evidence = evidenceFrom(module, title, badge, source, fields);
    const actions = el('footer', 'intel-source-actions');
    add(actions, btn('Add to active case', 'intel-btn intel-btn-primary', () => addEvidence(evidence)), btn('Copy citation', 'intel-btn intel-btn-quiet', () => copyCitation(evidence)));
    if (sourceUrl) add(actions, btn('Open approved source', 'intel-btn', () => openApproved(sourceUrl, module.id)));
    add(result, head, grid, actions); add(root, result); stage.replaceChildren(root); setBusy(false);
  }

  function renderError(module, message, sourceUrl = '') {
    const root = viewHeader(module, 'LOOKUP STATE');
    const box = card('No result was inferred', message, 'intel-warning');
    if (sourceUrl) add(box, btn('Open approved source manually', 'intel-btn', () => openApproved(sourceUrl, module.id)));
    add(root, box); stage.replaceChildren(root); setBusy(false);
  }

  function loading(module, message) {
    const root = viewHeader(module); add(root, el('div', 'intel-loading', message)); stage.replaceChildren(root); setBusy(true);
  }

  async function fetchJson(url, controller) {
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > 2 * 1024 * 1024) throw new Error('Provider response exceeded the 2 MB safety limit.');
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error('Provider response exceeded the 2 MB safety limit.');
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: safeText(text, 500) }; }
      return { response, data };
    } finally { clearTimeout(timer); }
  }

  function confirmFetch(module, provider, description, url, onSuccess) {
    const root = viewHeader(module, 'LIVE PROVIDER');
    const box = card('Confirm one live request', `Provider: ${provider}. This run will send ${description}. CoreShift does not run background lookups or save the query.`, 'intel-warning');
    const confirm = btn('Confirm & run once', 'intel-btn intel-btn-primary', async () => {
      cancelActiveRequest();
      const controller = new AbortController(); const requestId = ++state.requestSerial;
      state.requestController = controller; confirm.disabled = true; state.liveRuns += 1; log(module.id, `Started a ${provider} request`, 'running');
      setEgress(`One request is running against ${new URL(url).hostname}.`); loading(module, `Contacting ${provider}…`);
      try {
        const packet = await fetchJson(url, controller);
        if (requestId !== state.requestSerial || controller.signal.aborted) return;
        log(module.id, `Completed a ${provider} request`); await onSuccess(packet);
      } catch (error) {
        if (requestId !== state.requestSerial || controller.signal.aborted) return;
        log(module.id, `A ${provider} request failed`, 'error'); renderError(module, `${provider} could not be reached: ${safeText(error.message, 240)}. No fallback result was invented.`);
      } finally {
        if (requestId === state.requestSerial) { state.requestController = null; resetEgress(); setBusy(false); }
      }
    });
    add(box, confirm, btn('Cancel', 'intel-btn intel-btn-quiet', () => renderModule(module.id))); add(root, box);
    stage.replaceChildren(root); setEgress(`Awaiting confirmation before any data is sent to ${new URL(url).hostname}.`);
  }

  function cancelActiveRequest() {
    if (state.requestController) state.requestController.abort();
    state.requestController = null; state.requestSerial += 1; resetEgress(); setBusy(false);
  }

  function queryView(module, label, placeholder, submitLabel, onSubmit, extraControl = null) {
    const root = viewHeader(module);
    const form = el('form', 'intel-query-form'); const input = makeInput(placeholder);
    add(form, field(label, input)); if (extraControl) add(form, extraControl);
    add(form, btn(submitLabel, 'intel-btn intel-btn-primary'));
    form.addEventListener('submit', event => { event.preventDefault(); const value = input.value.trim(); if (!value) return toast(`Enter ${label.toLowerCase()} first.`); onSubmit(value, extraControl); });
    add(root, form, el('p', 'intel-notice', 'Queries remain in memory unless you explicitly add a result to a case.'));
    stage.replaceChildren(root); input.focus();
  }

  function renderRail(filter = '') {
    const nav = byId('intelModuleNav'); nav.replaceChildren(); const needle = filter.trim().toLowerCase();
    GROUPS.forEach(group => {
      const matches = MODULES.filter(item => item.group === group && (!needle || `${item.label} ${item.description}`.toLowerCase().includes(needle)));
      if (!matches.length) return;
      const section = el('section', 'intel-nav-group'); add(section, el('p', 'intel-nav-label', group));
      matches.forEach(item => {
        const button = btn(item.label, `intel-module-btn${item.id === state.activeModule ? ' active' : ''}`, () => renderModule(item.id));
        button.disabled = item.disabled; button.setAttribute('aria-current', item.id === state.activeModule ? 'page' : 'false');
        if (item.disabled) { button.title = item.description; add(button, el('small', '', ' EXCLUDED')); }
        add(section, button);
      }); add(nav, section);
    });
    if (!nav.children.length) add(nav, el('p', 'intel-empty', 'No modules match this filter.'));
  }

  function renderDashboard() {
    const module = moduleById('dashboard'); const root = viewHeader(module, 'LOCAL-FIRST COMMAND CENTER');
    const evidenceCount = state.cases.reduce((sum, item) => sum + item.evidence.length, 0);
    const stats = el('div', 'intel-dashboard-grid');
    [['CASES', state.cases.length], ['SAVED EVIDENCE', evidenceCount], ['SESSION ACTIONS', state.activity.length], ['LIVE RUNS', state.liveRuns]].forEach(([label, value]) => {
      const node = el('article', 'intel-stat-card'); add(node, el('small', '', label), el('strong', '', value)); add(stats, node);
    }); add(root, stats);
    const quickGrid = el('div', 'intel-quick-grid');
    ['usernames', 'github', 'ip-info', 'dns-recon', 'evidence-hash', 'url-inspector'].forEach(id => {
      const item = moduleById(id); add(quickGrid, btn(item.label, 'intel-btn', () => renderModule(id)));
    }); add(root, card('Quick modules', quickGrid));
    const lower = el('div', 'intel-dashboard-grid');
    const recentBody = el('div', 'intel-activity-list');
    if (!state.activity.length) add(recentBody, el('p', 'intel-empty', 'No session actions yet. Raw query values are never written here.'));
    state.activity.slice(0, 5).forEach(item => add(recentBody, el('p', 'intel-activity-row', `${stamp(item.at)} · ${moduleById(item.moduleId)?.label || 'Workspace'} · ${item.action}`)));
    const sessionBody = el('div');
    add(sessionBody, el('p', '', `Account: ${state.account?.username || 'Local guest'}${state.account?.role ? ` · ${state.account.role}` : ''}`),
      el('p', '', `Started: ${stamp(state.startedAt)}`), el('p', 'intel-notice', 'No background lookup is enabled. Provider egress always requires a click.'),
      el('p', 'intel-warning', 'Double Counter Bypass and automatic Discord alt identification are explicitly excluded.'));
    add(lower, card('Recent activity', recentBody), card('Session & notifications', sessionBody)); add(root, lower); stage.replaceChildren(root);
  }

  function renderActivity() {
    const root = viewHeader(moduleById('activity')); const list = el('div', 'intel-activity-list');
    if (!state.activity.length) add(list, el('p', 'intel-empty', 'No actions in this session.'));
    state.activity.forEach(item => add(list, el('div', 'intel-activity-row', `${stamp(item.at)} · ${moduleById(item.moduleId)?.label || 'Workspace'} · ${item.action} · ${item.status}`)));
    add(root, list); stage.replaceChildren(root);
  }

  function renderCases() {
    const root = viewHeader(moduleById('cases')); const actions = el('div', 'intel-source-actions');
    add(actions, btn('New case', 'intel-btn intel-btn-primary', openCaseModal), btn('Export workspace JSON', 'intel-btn', () => exportJson('coreshift-intelligence-workspace.json', { exportedAt: new Date().toISOString(), cases: state.cases })));
    if (state.cases.length) add(actions, btn('Clear saved cases', 'intel-btn intel-btn-danger', async () => {
      if (!window.confirm('Delete every saved Intelligence case, evidence item, and source note from local settings? This cannot be undone.')) return;
      state.cases = []; state.activeCaseId = ''; await persistCases(); log('cases', 'Cleared all saved Intelligence cases'); renderCases(); toast('Saved Intelligence cases cleared.');
    }));
    add(root, actions); const grid = el('div', 'intel-case-grid');
    if (!state.cases.length) add(grid, el('p', 'intel-empty', 'No cases yet. Create one with a documented purpose and authorization.'));
    state.cases.forEach(item => {
      const node = el('article', 'intel-case-card');
      add(node, el('small', '', item.id), el('h3', '', item.title), el('p', '', item.purpose), el('p', '', `Authorization: ${item.authorization}`), el('b', '', `${item.evidence.length} evidence items · ${item.notes.length} notes`));
      const row = el('div', 'intel-source-actions');
      add(row, btn('Make active', 'intel-btn intel-btn-primary', () => { state.activeCaseId = item.id; updateCaseSelect(); renderCases(); }), btn('Export JSON', 'intel-btn', () => exportJson(`${fileName(item.title)}.json`, item)), btn('Delete case', 'intel-btn intel-btn-danger', async () => {
        if (!window.confirm(`Delete the saved case “${item.title}” and all of its evidence and notes?`)) return;
        state.cases = state.cases.filter(candidate => candidate.id !== item.id); if (state.activeCaseId === item.id) state.activeCaseId = '';
        await persistCases(); log('cases', 'Deleted a saved case'); renderCases(); toast('Case deleted from local settings.');
      }));
      add(node, row);
      if (item.evidence.length) {
        const list = el('div', 'intel-evidence-list');
        item.evidence.slice(0, 12).forEach(evidence => {
          const evidenceRow = el('div', 'intel-evidence-row'); const copy = el('div');
          add(copy, el('b', '', evidence.title), el('small', '', `${evidence.module} · ${evidence.classification}`));
          add(evidenceRow, copy, btn('Remove', 'intel-btn intel-btn-danger', async () => {
            if (!window.confirm(`Remove “${evidence.title}” from this case?`)) return;
            item.evidence = item.evidence.filter(candidate => candidate.id !== evidence.id); await persistCases(); log('cases', 'Removed an evidence item'); renderCases();
          })); add(list, evidenceRow);
        });
        if (item.evidence.length > 12) add(list, el('small', '', `${item.evidence.length - 12} more items are included in the export.`));
        add(node, list);
      }
      add(grid, node);
    }); add(root, grid); stage.replaceChildren(root);
  }

  async function renderDemo() {
    cancelActiveRequest(); state.activeModule = 'dashboard'; renderRail(byId('intelModuleFilter').value); byId('intelBreadcrumb').textContent = 'INTELLIGENCE / DASHBOARD / OFFLINE DEMO'; resetEgress();
    const module = moduleById('dashboard');
    const demos = [
      ['Discord → Roblox pivot', [['Discord handle', 'atlas_arcade_demo'], ['Connection plan', 'Roblox candidate — unverified'], ['Status', 'Fictional training entity']]],
      ['Roblox → database pivot', [['Username candidate', 'atlas_arcade_demo'], ['Web databases', 'LeakCheck · Snusbase · CloudSINT'], ['Status', 'Plan only — no provider queried']]],
      ['Infrastructure context', [['Domain', 'northstar.example'], ['IP', '192.0.2.44'], ['Status', 'Reserved documentation values — not public targets']]]
    ];
    const demoId = 'case-demo-atlas-arcade';
    let demoCase = state.cases.find(item => item.id === demoId);
    if (!demoCase) {
      demoCase = cleanCase({
        id: demoId,
        title: 'DEMO · Atlas Arcade correlation review',
        purpose: 'Fictional training walkthrough of the Discord → Roblox → provider-plan workflow.',
        authorization: 'Offline demo data only. No real person, account, provider, or public target is queried.',
        createdAt: new Date().toISOString(),
        evidence: demos.map(([title, fields]) => evidenceFrom(module, `DEMO · ${title}`, 'DEMO', 'CoreShift fictional offline demo', fields)),
        notes: [{ id: 'note-demo-scope', title: 'Demo scope', text: 'All identifiers use reserved or fictional values. No live lookup is required.', source: 'CoreShift offline fixture', createdAt: new Date().toISOString() }]
      });
      state.cases.unshift(demoCase); await persistCases();
    }
    state.activeCaseId = demoId; updateCaseSelect();
    const root = viewHeader(module, 'FICTIONAL OFFLINE DEMO');
    add(root, el('p', 'intel-warning', 'DEMO · Every item below is fictional or reserved for documentation. No network request was made. A removable demo case is now active for graph, timeline, notes, and report views.'));
    const grid = el('div', 'intel-result-grid');
    demos.forEach(([title, fields]) => {
      const node = el('article', 'intel-result-card'); const head = el('header', 'intel-result-head'); add(head, el('h3', '', title), el('span', 'intel-status-badge demo', 'DEMO')); add(node, head);
      fields.forEach(([key, value]) => { const row = el('div', 'intel-kv'); add(row, el('small', '', key), el('b', '', value)); add(node, row); });
      const evidence = evidenceFrom(module, `DEMO · ${title}`, 'DEMO', 'CoreShift fictional offline demo', fields);
      add(node, btn('Add DEMO evidence to case', 'intel-btn', () => addEvidence(evidence))); add(grid, node);
    });
    const actions = el('div', 'intel-source-actions');
    add(actions, btn('View relationship graph', 'intel-btn intel-btn-primary', () => renderModule('relationship-graph')), btn('View timeline', 'intel-btn', () => renderModule('timeline')), btn('Build report', 'intel-btn', () => renderModule('report-builder')));
    add(root, grid, actions); stage.replaceChildren(root); log('dashboard', 'Loaded the fictional offline demo'); toast('Offline demo case loaded.');
  }

  const validGithub = value => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value) && !value.includes('--');
  const ipv4Parts = value => { const p = value.split('.'); return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255) ? p.map(Number) : null; };
  const validIpv6 = value => { try { return value.includes(':') && new URL(`http://[${value}]/`).hostname.length > 2; } catch { return false; } };
  function ipClass(value) {
    const p = ipv4Parts(value);
    if (!p) {
      const lower = value.toLowerCase();
      if (lower === '::' || lower === '::1') return lower === '::1' ? 'Loopback IPv6' : 'Unspecified IPv6';
      if (/^f[cd]/.test(lower)) return 'Private IPv6';
      if (/^fe[89ab]/.test(lower)) return 'Link-local IPv6';
      if (/^ff/.test(lower)) return 'Multicast IPv6';
      if (lower.startsWith('2001:db8:')) return 'Documentation IPv6';
      if (lower.startsWith('::ffff:')) return 'IPv4-mapped IPv6';
      return validIpv6(lower) ? 'Public IPv6 candidate' : 'Invalid address';
    }
    if (p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return 'Private or local IPv4';
    if ((p[0] === 192 && p[1] === 0 && p[2] === 2) || (p[0] === 198 && p[1] === 51 && p[2] === 100) || (p[0] === 203 && p[1] === 0 && p[2] === 113)) return 'RFC 5737 documentation IPv4';
    if (p[0] === 0 || p[0] >= 224 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
        (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 192 && p[1] === 88 && p[2] === 99) ||
        (p[0] === 198 && (p[1] === 18 || p[1] === 19))) return 'Reserved or special-use IPv4';
    return 'Public IPv4 candidate';
  }
  function normalizeHost(value) {
    try { const host = value.includes('://') ? new URL(value).hostname : value.toLowerCase().replace(/\.$/, ''); return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host) ? host : ''; } catch { return ''; }
  }
  function classifyQuery(value) {
    const trimmed = value.trim(); const address = ipClass(trimmed);
    if (address !== 'Invalid address') return `IP address · ${address}`;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Email address candidate';
    if (normalizeHost(trimmed)) return 'Domain candidate';
    try { const url = new URL(trimmed); if (['http:', 'https:'].includes(url.protocol)) return 'Web URL'; } catch {}
    if (/^\+?[\d() .-]{7,24}$/.test(trimmed)) return 'Phone number candidate';
    if (/^\d{16,22}$/.test(trimmed)) return 'Numeric snowflake candidate';
    if (/^[A-Za-z0-9_.-]{2,40}$/.test(trimmed)) return 'Username candidate';
    return 'Free-text query';
  }

  function renderGithub(module) {
    queryView(module, 'GitHub username', 'octocat', 'Prepare lookup', username => {
      if (!validGithub(username)) return toast('Enter a valid GitHub username.');
      const encoded = encodeURIComponent(username); const url = `https://api.github.com/users/${encoded}`; const sourceUrl = `https://github.com/${encoded}`;
      confirmFetch(module, 'GitHub public API', 'the entered username', url, ({ response, data }) => {
        if (!response.ok) return renderError(module, response.status === 404 ? 'GitHub returned 404. No public account result was returned.' : `GitHub returned HTTP ${response.status}.`, sourceUrl);
        renderResult(module, { title: 'GitHub public account', badge: 'LIVE · GITHUB', source: 'GitHub public API', sourceUrl, fields: [
          ['Login', safeText(data.login)], ['Display name', safeText(data.name || 'Not published')], ['Bio', safeText(data.bio || 'Not published')],
          ['Public repositories', safeText(data.public_repos)], ['Followers', safeText(data.followers)], ['Created', safeText(data.created_at)]
        ] });
      });
    });
  }

  function renderIp(module) {
    queryView(module, 'IP address', '192.0.2.44', 'Classify address', value => {
      const classification = ipClass(value);
      if (classification === 'Invalid address') return toast('Enter a valid IPv4 or IPv6 address.');
      if (!classification.startsWith('Public')) return renderResult(module, { title: 'Local address classification', badge: 'LOCAL', source: 'CoreShift local classifier', fields: [['Address', value], ['Classification', classification]], note: 'No provider was contacted for private, reserved, or documentation space.' });
      const encoded = encodeURIComponent(value); const url = `https://ipwho.is/${encoded}`;
      confirmFetch(module, 'ipwho.is', 'the entered IP address', url, ({ response, data }) => {
        if (!response.ok || data.success === false) return renderError(module, safeText(data.message || `Provider returned HTTP ${response.status}.`));
        renderResult(module, { title: 'Public IP context', badge: 'LIVE · IPWHO.IS', source: 'ipwho.is public API', sourceUrl: url, fields: [
          ['IP', safeText(data.ip)], ['Type', safeText(data.type)], ['Country', safeText(data.country || 'Not returned')], ['Region', safeText(data.region || 'Not returned')],
          ['City', safeText(data.city || 'Not returned')], ['ISP', safeText(data.connection?.isp || 'Not returned')], ['Timezone', safeText(data.timezone?.id || 'Not returned')]
        ], note: 'Geolocation is approximate provider data, not proof of a person or precise device location.' });
      });
    });
  }

  function renderDns(module) {
    const select = el('select', 'intel-select'); ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME'].forEach(type => add(select, new Option(type, type)));
    const selectField = field('Record type', select);
    queryView(module, 'Domain', 'northstar.example', 'Prepare DNS lookup', value => {
      const host = normalizeHost(value); if (!host) return toast('Enter a valid domain name.'); const type = select.value;
      const url = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${encodeURIComponent(type)}`;
      confirmFetch(module, 'Google Public DNS', 'the domain and selected record type', url, ({ response, data }) => {
        if (!response.ok) return renderError(module, `Google DNS returned HTTP ${response.status}.`);
        const answers = Array.isArray(data.Answer) ? data.Answer.slice(0, 40).map(item => `${safeText(item.name, 260)} · ${safeText(item.data, 700)} · TTL ${safeText(item.TTL)}`).join('\n') : 'No answer records returned';
        renderResult(module, { title: `${type} records`, badge: 'LIVE · DNS.GOOGLE', source: 'Google Public DNS JSON API', sourceUrl: url, fields: [['Name', host], ['Status code', safeText(data.Status)], ['Answers', answers]] });
      });
    }, selectField);
  }

  function renderRdap(module) {
    queryView(module, 'Domain or IP', 'example.com', 'Prepare RDAP lookup', value => {
      const host = normalizeHost(value); const classification = ipClass(value); const isIp = classification !== 'Invalid address';
      if (!host && !isIp) return toast('Enter a valid domain or IP address.');
      const target = host || value; const url = `https://rdap.org/${isIp ? 'ip' : 'domain'}/${encodeURIComponent(target)}`;
      confirmFetch(module, 'RDAP.org', 'the entered domain or IP', url, ({ response, data }) => {
        if (!response.ok) return renderError(module, `RDAP returned HTTP ${response.status}.`);
        const events = Array.isArray(data.events) ? data.events.slice(0, 12).map(item => `${safeText(item.eventAction)}: ${safeText(item.eventDate)}`).join('\n') : 'Not returned';
        renderResult(module, { title: 'Registration record', badge: 'LIVE · RDAP', source: 'RDAP bootstrap service', sourceUrl: url, fields: [
          ['Handle', safeText(data.handle || 'Not returned')], ['Name', safeText(data.ldhName || data.name || target)], ['Status', Array.isArray(data.status) ? data.status.map(value => safeText(value)).join(', ') : 'Not returned'], ['Events', events]
        ] });
      });
    });
  }

  function renderUsername(module) {
    queryView(module, 'Username candidate', 'atlas_arcade_demo', 'Build URL matrix', value => {
      if (!/^[A-Za-z0-9_.-]{2,40}$/.test(value)) return toast('Use 2–40 letters, numbers, dots, underscores, or hyphens.');
      const encoded = encodeURIComponent(value); const links = [
        ['GitHub', `https://github.com/${encoded}`], ['TikTok', `https://www.tiktok.com/@${encoded}`],
        ['Roblox', `https://www.roblox.com/search/users?keyword=${encoded}`], ['Google exact search', `https://www.google.com/search?q=${encodeURIComponent(`\"${value}\"`)}`]
      ];
      const root = viewHeader(module, 'CANDIDATE MATRIX'); add(root, el('p', 'intel-warning', 'UNVERIFIED · These are candidate URLs only. CoreShift has not checked whether any account exists or belongs to the same person.'));
      const grid = el('div', 'intel-connection-grid'); links.forEach(([name, url]) => {
        const node = card(name, 'UNVERIFIED candidate · opening shares the encoded username.'); add(node, btn('Open candidate', 'intel-btn', () => openApproved(url, module.id))); add(grid, node);
      }); add(root, grid); stage.replaceChildren(root); log(module.id, 'Built a local unverified username matrix');
    });
  }

  function decodeSnowflake(value) {
    if (!/^\d{16,22}$/.test(value)) throw new Error('Enter a 16–22 digit Discord snowflake.');
    const snowflake = BigInt(value); const epoch = 1420070400000n; const millis = (snowflake >> 22n) + epoch;
    if (millis > BigInt(Date.now() + 31557600000)) throw new Error('Snowflake timestamp is outside the expected range.');
    return { created: new Date(Number(millis)).toISOString(), worker: Number((snowflake >> 17n) & 31n), process: Number((snowflake >> 12n) & 31n), increment: Number(snowflake & 4095n) };
  }

  function renderDiscord(module) {
    queryView(module, 'Discord snowflake', '175928847299117063', 'Decode locally', value => {
      let decoded; try { decoded = decodeSnowflake(value); } catch (error) { return toast(error.message); }
      log(module.id, 'Decoded a Discord snowflake locally'); renderDiscordTabs(module, value, decoded, 'Profile');
    });
  }

  function renderDiscordTabs(module, snowflake, decoded, tab) {
    const root = viewHeader(module, 'LOCAL SNOWFLAKE VIEW'); const tabs = el('div', 'intel-source-actions');
    ['Profile', 'Connections 15', 'Reviews', 'Mod Actions', 'Roblox', 'Raw'].forEach(name => add(tabs, btn(name, `intel-btn${name === tab ? ' intel-btn-primary' : ''}`, () => renderDiscordTabs(module, snowflake, decoded, name)))); add(root, tabs);
    if (tab === 'Profile') add(root, card('Decoded profile fields', `Created ${decoded.created} · worker ${decoded.worker} · process ${decoded.process} · increment ${decoded.increment}. This does not reveal a username or account owner.`));
    else if (tab === 'Connections 15') {
      const grid = el('div', 'intel-connection-grid'); ['Amazon Music', 'Crunchyroll', 'eBay', 'Epic', 'GitHub', 'PlayStation', 'Reddit', 'Riot', 'Roblox', 'Spotify', 'Steam', 'Twitch', 'Twitter', 'Xbox', 'YouTube'].forEach(name => add(grid, card(name, 'UNVERIFIED · no connection provider was queried.'))); add(root, grid);
    } else if (tab === 'Roblox') add(root, card('Roblox pivot', 'No identity link is inferred. Use the Roblox module to create an official, unverified username or numeric-ID plan.'));
    else if (tab === 'Raw') add(root, card('Local decoded JSON', JSON.stringify({ snowflake, ...decoded }, null, 2)));
    else add(root, card(tab, 'No provider is configured for this category. CoreShift will not invent review, moderation, or identity data.'));
    stage.replaceChildren(root);
  }

  function renderRoblox(module) {
    queryView(module, 'Username or numeric user ID', 'atlas_arcade_demo', 'Build official profile plan', value => {
      if (!/^[A-Za-z0-9_]{2,40}$/.test(value)) return toast('Enter a username or numeric user ID.');
      const numeric = /^\d+$/.test(value); const url = numeric ? `https://www.roblox.com/users/${encodeURIComponent(value)}/profile` : `https://www.roblox.com/search/users?keyword=${encodeURIComponent(value)}`;
      const root = viewHeader(module, 'UNVERIFIED PIVOT'); const tabs = el('div', 'intel-source-actions');
      ['Overview', 'History', 'Breach signals'].forEach((name, index) => add(tabs, btn(name, `intel-btn${index === 0 ? ' intel-btn-primary' : ''}`, () => toast(name === 'Breach signals' ? 'No leaked credentials are collected or displayed.' : 'No provider data has been loaded.'))));
      add(root, tabs, el('p', 'intel-warning', 'UNVERIFIED · No Roblox account existence or Discord relationship has been claimed.'));
      const node = card('Official Roblox plan', numeric ? 'Numeric public-profile URL prepared.' : 'Official Roblox user-search URL prepared.'); add(node, btn('Open Roblox', 'intel-btn', () => openApproved(url, module.id))); add(root, node, card('History', 'No username or profile history provider was queried.'), card('Safe compromise indicators', 'No credential leaks are ingested. Review official account-security notices and redact any sensitive material.'));
      stage.replaceChildren(root); log(module.id, 'Built an unverified Roblox profile plan');
    });
  }

  function searchConfig(id, value) {
    const encoded = encodeURIComponent(value); const google = `https://www.google.com/search?q=${encodeURIComponent(`\"${value}\"`)}`;
    if (id === 'gmail-lookup') return { ok: /^[^\s@]+@gmail\.com$/i.test(value), label: 'Gmail syntax', detail: 'Syntax only; account existence is not checked.', links: [['Google account help', 'https://support.google.com/mail/answer/56256']] };
    if (id === 'phone-search') return { ok: /^\+?[\d() .-]{7,24}$/.test(value), label: 'Phone search plan', detail: `${value.replace(/\D/g, '').length} digits normalized locally.`, links: [['Google exact search', google]] };
    if (id === 'address-search') return { ok: value.length >= 5, label: 'Address search plan', detail: 'No residency or ownership claim is made.', links: [['Google Maps', `https://www.google.com/maps/search/?api=1&query=${encoded}`], ['USA.gov', `https://www.usa.gov/search?query=${encoded}`]] };
    if (id === 'email-search') return { ok: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), label: 'Email search plan', detail: 'Syntax is valid; mailbox existence is not checked.', links: [['Google exact search', google]] };
    return { ok: value.length >= 2, label: 'Person search plan', detail: 'Public-source candidates only; identities must be verified manually.', links: [['Google exact search', google], ['USA.gov', `https://www.usa.gov/search?query=${encoded}`]] };
  }

  function renderSearch(module) {
    queryView(module, module.id.includes('email') || module.id === 'gmail-lookup' ? 'Email address' : module.id === 'phone-search' ? 'Phone number' : module.id === 'address-search' ? 'Address' : 'Name', 'Enter a value', 'Build local plan', value => {
      const plan = searchConfig(module.id, value); if (!plan.ok) return toast('The value does not match the expected format.');
      const root = viewHeader(module, 'LOCAL VALIDATION'); add(root, el('p', 'intel-warning', `UNVERIFIED · ${plan.detail}`));
      const grid = el('div', 'intel-connection-grid'); plan.links.forEach(([name, url]) => { const node = card(name, 'Opening this source shares the encoded identifier.'); add(node, btn('Open source', 'intel-btn', () => openApproved(url, module.id))); add(grid, node); });
      add(root, grid); stage.replaceChildren(root); log(module.id, 'Built a local public-source plan');
    });
  }

  function renderProvider(module) {
    if (module.id === 'tiktok') return queryView(module, 'TikTok username', 'atlas_arcade_demo', 'Build profile plan', value => {
      if (!/^[A-Za-z0-9_.]{2,30}$/.test(value)) return toast('Enter a valid TikTok username candidate.');
      const url = `https://www.tiktok.com/@${encodeURIComponent(value)}`;
      renderResult(module, { title: 'TikTok candidate profile', badge: 'UNVERIFIED', source: 'Official TikTok profile URL plan', sourceUrl: url, fields: [['Candidate', value], ['Existence', 'Not checked']], note: 'Opening the official URL is the only network action.' });
    });
    const configs = {
      'hudson-rock': ['Hudson Rock', 'https://www.hudsonrock.com/', 'CoreShift does not send a target automatically. Use the provider only with authorization.'],
      seon: ['SEON', 'https://seon.io/', 'CoreShift does not send a target automatically. Review provider terms and consent requirements.'],
      'port-scan': ['Shodan passive view', 'https://www.shodan.io/', 'No active port scan is implemented in this renderer. Scan only systems you own or are authorized to test.'],
      shodan: ['Shodan', 'https://www.shodan.io/', 'No target has been queried. Provider observations can be stale and are not proof of current exposure.'],
      'certificate-lookup': ['Certificate Transparency', 'https://crt.sh/', 'No domain has been submitted. Certificate logs do not prove current service ownership.']
    };
    const [name, url, warning] = configs[module.id]; const root = viewHeader(module, 'EXTERNAL PROVIDER PLAN');
    add(root, el('p', 'intel-warning', warning), btn(`Open ${name}`, 'intel-btn intel-btn-primary', () => openApproved(url, module.id))); stage.replaceChildren(root);
  }

  function renderDatabases(module) {
    queryView(module, 'Authorized query', 'atlas_arcade_demo', 'Build provider plan', value => {
      if (value.length < 2) return toast('Enter a longer query value.'); const root = viewHeader(module, 'PROVIDER PLAN');
      add(root, el('p', 'intel-warning', `UNVERIFIED · Local classification: ${classifyQuery(value)}. No breach database was queried. Never use exposed credentials or bypass access controls.`));
      const grid = el('div', 'intel-connection-grid'); [['LeakCheck', 'https://leakcheck.io/'], ['Snusbase', 'https://snusbase.com/'], ['CloudSINT', 'https://cloudsint.com/']].forEach(([name, url]) => {
        const node = card(name, 'Query types: email · username · domain · IP. Target is not sent until you explicitly use the provider.'); add(node, btn('Open provider home', 'intel-btn', () => openApproved(url, module.id))); add(grid, node);
      }); add(root, grid); stage.replaceChildren(root); log(module.id, 'Built a web-database provider plan');
    });
  }

  function renderFile(module) {
    const root = viewHeader(module, 'LOCAL FILE ANALYSIS'); const box = card('Choose a local file', module.id === 'reverse-face' ? 'CoreShift computes a fingerprint only. It does not identify a person.' : module.id === 'image-geolocation' ? 'CoreShift reports basic metadata only and does not infer coordinates.' : 'The complete file is read locally to calculate SHA-256.');
    add(box, btn('Choose file', 'intel-btn intel-btn-primary', () => { state.fileModule = module.id; const input = byId('intelFileInput'); input.accept = ['reverse-face', 'image-geolocation'].includes(module.id) ? 'image/*' : ''; input.value = ''; input.click(); })); add(root, box); stage.replaceChildren(root);
  }

  async function handleFile(file) {
    const module = moduleById(state.fileModule || 'evidence-hash'); if (!file) return;
    if (file.size > 64 * 1024 * 1024) return toast('Choose a file no larger than 64 MB.'); loading(module, 'Computing SHA-256 locally…');
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      renderResult(module, { title: 'Local file fingerprint', badge: 'LOCAL · SHA-256', source: 'Web Crypto on this device', fields: [['Name', file.name], ['Type', file.type || 'Unknown'], ['Size', `${file.size.toLocaleString()} bytes`], ['Last modified', new Date(file.lastModified).toISOString()], ['SHA-256', hash]], note: 'No file bytes or hash were sent to a provider.' }); log(module.id, 'Hashed a selected file locally');
    } catch (error) { renderError(module, `Hashing failed: ${safeText(error.message, 240)}`); }
  }

  function renderUrl(module) {
    queryView(module, 'URL', 'https://northstar.example/path?ref=demo', 'Inspect locally', value => {
      let parsed; try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`); } catch { return toast('Enter a valid URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return toast('Only HTTP and HTTPS URLs can be inspected.');
      const labels = parsed.hostname.split('.'); const fields = [['Normalized URL', parsed.href], ['Hostname', parsed.hostname], ['HTTPS', parsed.protocol === 'https:' ? 'Yes' : 'No'], ['Punycode', parsed.hostname.includes('xn--') ? 'Present — review carefully' : 'Not present'], ['Credentials', parsed.username || parsed.password ? 'Present — sensitive' : 'None'], ['Subdomain depth', Math.max(0, labels.length - 2)], ['Path segments', parsed.pathname.split('/').filter(Boolean).length], ['Query parameters', [...parsed.searchParams].length], ['Port', parsed.port || 'Default']];
      renderResult(module, { title: 'URL structure signals', badge: 'LOCAL', source: 'CoreShift URL parser', fields, note: 'These are structural signals, not a safety verdict. The inspected URL was not opened.' }); log(module.id, 'Inspected URL structure locally');
    });
  }

  function renderGraph(module) {
    const root = viewHeader(module); const current = activeCase();
    if (!current) add(root, el('p', 'intel-empty', 'Select an active case to view relationships.'));
    else { add(root, el('p', 'intel-notice', 'Only explicit case-to-evidence membership is shown. CoreShift does not infer that usernames or accounts belong to one person.')); const grid = el('div', 'intel-result-grid'); add(grid, card(current.title, 'CASE ROOT'));
      current.evidence.forEach(item => add(grid, card(item.title, `${item.module} · ${item.classification} · linked because it was explicitly added to this case`))); add(root, grid); }
    stage.replaceChildren(root);
  }

  function renderTimeline(module) {
    const root = viewHeader(module); const current = activeCase(); const timeline = el('div', 'intel-timeline');
    if (!current) add(timeline, el('p', 'intel-empty', 'Select an active case to view its timeline.'));
    else {
      const items = [{ at: current.createdAt, text: 'Case created' }, ...current.evidence.map(item => ({ at: item.capturedAt, text: `Evidence added · ${item.title}` })), ...current.notes.map(item => ({ at: item.createdAt, text: `Source note · ${item.title}` }))].sort((a, b) => new Date(a.at) - new Date(b.at));
      items.forEach(item => add(timeline, el('div', 'intel-activity-row', `${stamp(item.at)} · ${item.text}`)));
    } add(root, timeline); stage.replaceChildren(root);
  }

  function renderNotes(module) {
    const root = viewHeader(module); const current = activeCase(); if (!current) { add(root, el('p', 'intel-empty', 'Select an active case to add source notes.')); return stage.replaceChildren(root); }
    const form = el('form', 'intel-query-form'); const title = makeInput('Source note title'); const source = makeInput('HTTPS source URL or citation label'); const text = el('textarea', 'intel-textarea'); text.placeholder = 'Write an attributed observation. Separate facts from interpretation.'; text.maxLength = 2000;
    add(form, field('Title', title), field('Source', source), field('Note', text), btn('Save note', 'intel-btn intel-btn-primary'));
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!title.value.trim() || !text.value.trim()) return toast('Add a title and note.');
      if (current.notes.length >= 300) return toast('This case has reached the 300-note limit. Export or remove notes before adding more.');
      current.notes.unshift({ id: uid('note'), title: safeText(title.value, 120), source: safeText(source.value, 400), text: safeText(text.value, 2000), createdAt: new Date().toISOString() });
      await persistCases(); log(module.id, 'Saved a source note to the active case'); renderNotes(module);
    });
    add(root, form); current.notes.forEach(note => {
      const body = el('div'); add(body, el('p', '', note.text), el('small', '', `Source: ${note.source || 'Not specified'} · ${stamp(note.createdAt)}`), btn('Delete note', 'intel-btn intel-btn-danger', async () => {
        if (!window.confirm(`Delete the source note “${note.title}”?`)) return;
        current.notes = current.notes.filter(candidate => candidate.id !== note.id); await persistCases(); log(module.id, 'Deleted a source note'); renderNotes(module);
      })); add(root, card(note.title, body));
    }); stage.replaceChildren(root);
  }

  function renderReport(module) {
    const root = viewHeader(module); const current = activeCase();
    if (!current) add(root, el('p', 'intel-empty', 'Select an active case to build a report.'));
    else { const report = el('article', 'intel-report'); add(report, el('h3', '', current.title), el('p', '', `Purpose: ${current.purpose}`), el('p', '', `Authorization: ${current.authorization}`), el('p', '', `${current.evidence.length} evidence items · ${current.notes.length} source notes`), btn('Export active case JSON', 'intel-btn intel-btn-primary', () => exportJson(`${fileName(current.title)}.json`, current))); current.evidence.forEach(item => add(report, el('p', 'intel-evidence-row', `${stamp(item.capturedAt)} · ${item.module} · ${item.title} · ${item.source}`))); add(root, report); }
    stage.replaceChildren(root);
  }

  function exportJson(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = el('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('JSON export created.'); log(state.activeModule, 'Exported JSON');
  }
  const fileName = value => safeText(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'case';

  function renderModule(id) {
    const module = moduleById(id) || moduleById('dashboard'); if (module.disabled) return;
    cancelActiveRequest();
    state.activeModule = module.id; byId('intelBreadcrumb').textContent = `INTELLIGENCE / ${module.group.toUpperCase()} / ${module.label.toUpperCase()}`; renderRail(byId('intelModuleFilter').value); resetEgress(); setBusy(false);
    const handlers = { dashboard: renderDashboard, activity: renderActivity, cases: renderCases, databases: renderDatabases, github: renderGithub, ip: renderIp, dns: renderDns, rdap: renderRdap, username: renderUsername, discord: renderDiscord, roblox: renderRoblox, search: renderSearch, provider: renderProvider, file: renderFile, url: renderUrl, graph: renderGraph, timeline: renderTimeline, report: renderReport, notes: renderNotes };
    (handlers[module.mode] || renderDashboard)(module);
  }

  function openCaseModal() {
    const modal = byId('intelCaseModal'); byId('intelCaseForm').reset(); modal.hidden = false; requestAnimationFrame(() => byId('intelCaseTitle').focus());
  }
  function closeCaseModal() { byId('intelCaseModal').hidden = true; state.pendingEvidence = null; }

  async function initialize() {
    byId('intelModuleFilter').addEventListener('input', event => renderRail(event.target.value));
    byId('intelActiveCaseSelect').addEventListener('change', event => { state.activeCaseId = event.target.value; log('cases', 'Changed the active case'); if (['dashboard', 'cases', 'graph', 'timeline', 'report', 'notes'].includes(state.activeModule)) renderModule(state.activeModule); });
    byId('intelLoadDemoBtn').addEventListener('click', renderDemo); byId('intelNewCaseBtn').addEventListener('click', openCaseModal);
    byId('intelCaseCancel').addEventListener('click', closeCaseModal); byId('intelCaseCancelFooter').addEventListener('click', closeCaseModal);
    byId('intelCaseModal').addEventListener('click', event => { if (event.target === byId('intelCaseModal')) closeCaseModal(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !byId('intelCaseModal').hidden) closeCaseModal(); });
    byId('intelFileInput').addEventListener('change', event => handleFile(event.target.files?.[0]));
    byId('intelCaseForm').addEventListener('submit', async event => {
      event.preventDefault(); const title = byId('intelCaseTitle').value.trim(); const purpose = byId('intelCasePurpose').value.trim(); const authorization = byId('intelCaseAuthorization').value.trim(); if (!title || !purpose || !authorization) return;
      if (state.cases.length >= 100) return toast('The workspace has reached the 100-case limit. Export or delete cases before creating another.');
      const created = cleanCase({ id: uid('case'), title, purpose, authorization, createdAt: new Date().toISOString(), evidence: [], notes: [] }); state.cases.unshift(created); state.activeCaseId = created.id;
      const pending = state.pendingEvidence; byId('intelCaseModal').hidden = true; state.pendingEvidence = null; if (pending) created.evidence.unshift(pending); await persistCases(); log('cases', 'Created an authorized case'); toast('Case created locally.'); if (state.activeModule === 'cases') renderCases();
    });
    const panel = byId('panel-intelligence');
    new MutationObserver(() => { if (!panel.classList.contains('visible')) cancelActiveRequest(); })
      .observe(panel, { attributes: true, attributeFilter: ['class'] });
    renderRail(); updateCaseSelect(); renderDashboard();
    try {
      const [settings, session] = await Promise.all([api.getSettings(), api.getAccountSession().catch(() => ({ account: null }))]);
      const saved = settings?.intelligenceWorkspace?.cases; state.cases = Array.isArray(saved) ? saved.map(cleanCase).filter(Boolean) : []; state.account = session?.account || null; updateCaseSelect(); renderModule('dashboard');
    } catch (error) { add(stage, el('p', 'intel-warning', `Local settings could not be loaded: ${safeText(error.message, 240)}`)); }
  }

  initialize();
})();

(() => {
  'use strict';

  const runtime = { root: null, initPromise: null, links: [], formats: [], loading: false };
  const byId = id => document.getElementById(id);
  const toast = message => window.coreShiftToast?.(String(message || 'PIA operation completed.'));

  async function init() {
    if (runtime.root?.isConnected) return runtime.root;
    if (runtime.initPromise) return runtime.initPromise;
    runtime.initPromise = (async () => {
      const response = await window.coreShiftAPI.loadPiaPanel();
      if (!response?.success) throw new Error(response?.message || 'PIA channel could not be loaded.');
      const host = document.querySelector('.main-content');
      if (!host) throw new Error('CoreShift content area is unavailable.');
      const template = document.createElement('template');
      template.innerHTML = response.html.trim();
      host.append(template.content.cloneNode(true));
      runtime.root = byId('panel-pia');
      if (!runtime.root) throw new Error('PIA channel markup is invalid.');
      bindEvents();
      await loadAll();
      return runtime.root;
    })().catch(error => {
      runtime.initPromise = null;
      throw error;
    });
    return runtime.initPromise;
  }

  async function onShow() {
    await init();
    await loadAll();
  }

  function bindEvents() {
    runtime.root.querySelectorAll('[data-pia-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.piaView)));
    byId('piaLinkForm').addEventListener('submit', saveLink);
    byId('piaLinkCancel').addEventListener('click', resetLinkForm);
    byId('piaRefreshLinks').addEventListener('click', loadLinks);
    byId('piaLinksList').addEventListener('click', handleLinkAction);
    byId('piaFormatForm').addEventListener('submit', saveFormat);
    byId('piaFormatCancel').addEventListener('click', resetFormatForm);
    byId('piaRefreshFormats').addEventListener('click', loadFormats);
    byId('piaFormatsList').addEventListener('click', handleFormatAction);
    byId('piaFormatFilter').addEventListener('input', renderFormats);
  }

  function showView(name) {
    const selected = name === 'formats' ? 'formats' : 'links';
    runtime.root.querySelectorAll('[data-pia-view]').forEach(button => {
      const active = button.dataset.piaView === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    ['links', 'formats'].forEach(view => {
      const panel = byId(`pia-view-${view}`);
      const active = view === selected;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    });
  }

  async function loadAll() {
    if (runtime.loading) return;
    runtime.loading = true;
    setDatabaseStatus('Syncing MySQL');
    try {
      const [linksReady, formatsReady] = await Promise.all([loadLinks(), loadFormats()]);
      setDatabaseStatus(linksReady && formatsReady ? 'MySQL synchronized' : 'MySQL unavailable');
    } finally { runtime.loading = false; }
  }

  async function loadLinks() {
    const response = await window.coreShiftAPI.listPiaLinks();
    if (!response?.success) {
      renderFailure(byId('piaLinksList'), response?.message || 'Staff links could not be loaded.');
      setDatabaseStatus('MySQL unavailable');
      return false;
    }
    runtime.links = Array.isArray(response.rows) ? response.rows : [];
    byId('piaLinkCount').textContent = String(runtime.links.length);
    renderLinks();
    return true;
  }

  async function loadFormats() {
    const response = await window.coreShiftAPI.listPiaFormats();
    if (!response?.success) {
      renderFailure(byId('piaFormatsList'), response?.message || 'Formats could not be loaded.');
      setDatabaseStatus('MySQL unavailable');
      return false;
    }
    runtime.formats = Array.isArray(response.rows) ? response.rows : [];
    byId('piaFormatCount').textContent = String(runtime.formats.length);
    renderFormats();
    return true;
  }

  function renderLinks() {
    const list = byId('piaLinksList');
    if (!runtime.links.length) return renderFailure(list, 'No PIA staff links have been saved yet.');
    const groups = new Map();
    for (const link of runtime.links) {
      const team = String(link.team_name || 'General Staff');
      if (!groups.has(team)) groups.set(team, []);
      groups.get(team).push(link);
    }
    const fragment = document.createDocumentFragment();
    for (const [team, links] of groups) {
      for (const link of links) {
        const article = element('article', 'pia-record');
        const header = element('header');
        const copy = element('div');
        copy.append(element('span', 'pia-team', team), element('h3', '', link.title));
        header.append(copy, actionButtons(link.id, 'link'));
        const anchor = element('a', '', link.url);
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        article.append(header);
        if (link.description) article.append(element('p', '', link.description));
        article.append(anchor, element('small', 'pia-record-meta', recordMeta(link)));
        fragment.append(article);
      }
    }
    list.replaceChildren(fragment);
  }

  function renderFormats() {
    const list = byId('piaFormatsList');
    const filter = String(byId('piaFormatFilter')?.value || '').trim().toLowerCase();
    const formats = runtime.formats.filter(format => !filter || `${format.section_name} ${format.title} ${format.content}`.toLowerCase().includes(filter));
    if (!formats.length) return renderFailure(list, filter ? 'No formats match that filter.' : 'No PIA formats have been saved yet.');
    const fragment = document.createDocumentFragment();
    for (const format of formats) {
      const article = element('article', 'pia-record');
      const header = element('header');
      const copy = element('div');
      copy.append(element('span', 'pia-section', format.section_name), element('h3', '', format.title));
      header.append(copy, actionButtons(format.id, 'format', true));
      const preview = element('pre', '', format.content);
      article.append(header, preview, element('small', 'pia-record-meta', recordMeta(format)));
      fragment.append(article);
    }
    list.replaceChildren(fragment);
  }

  function actionButtons(id, type, copyEnabled = false) {
    const actions = element('div', 'pia-record-actions');
    if (copyEnabled) actions.append(actionButton('Copy', type, id, 'copy'));
    actions.append(actionButton('Edit', type, id, 'edit'), actionButton('Delete', type, id, 'delete', 'danger'));
    return actions;
  }

  function actionButton(label, type, id, action, className = '') {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.piaAction = action;
    button.dataset.piaType = type;
    button.dataset.piaId = String(id);
    return button;
  }

  async function saveLink(event) {
    event.preventDefault();
    const payload = {
      id: byId('piaLinkId').value || undefined,
      teamName: byId('piaLinkTeam').value,
      title: byId('piaLinkTitle').value,
      url: byId('piaLinkUrl').value,
      description: byId('piaLinkDescription').value
    };
    const button = byId('piaLinkSubmit');
    button.disabled = true;
    const response = await window.coreShiftAPI.savePiaLink(payload);
    button.disabled = false;
    toast(response?.message || 'PIA staff link save failed.');
    if (response?.success) { resetLinkForm(); await loadLinks(); }
  }

  async function saveFormat(event) {
    event.preventDefault();
    const payload = {
      id: byId('piaFormatId').value || undefined,
      sectionName: byId('piaFormatSection').value,
      title: byId('piaFormatTitle').value,
      content: byId('piaFormatContent').value
    };
    const button = byId('piaFormatSubmit');
    button.disabled = true;
    const response = await window.coreShiftAPI.savePiaFormat(payload);
    button.disabled = false;
    toast(response?.message || 'PIA format save failed.');
    if (response?.success) { resetFormatForm(); await loadFormats(); }
  }

  async function handleLinkAction(event) {
    const button = event.target.closest('[data-pia-type="link"]');
    if (!button) return;
    const link = runtime.links.find(item => Number(item.id) === Number(button.dataset.piaId));
    if (!link) return;
    if (button.dataset.piaAction === 'edit') {
      byId('piaLinkId').value = link.id;
      byId('piaLinkTeam').value = link.team_name;
      byId('piaLinkTitle').value = link.title;
      byId('piaLinkUrl').value = link.url;
      byId('piaLinkDescription').value = link.description || '';
      byId('piaLinkSubmit').textContent = 'Update staff link';
      byId('piaLinkCancel').hidden = false;
      byId('piaLinkTeam').focus();
    }
    if (button.dataset.piaAction === 'delete' && confirm(`Delete “${link.title}”?`)) {
      const response = await window.coreShiftAPI.deletePiaLink(link.id);
      toast(response?.message || 'PIA staff link delete failed.');
      if (response?.success) await loadLinks();
    }
  }

  async function handleFormatAction(event) {
    const button = event.target.closest('[data-pia-type="format"]');
    if (!button) return;
    const format = runtime.formats.find(item => Number(item.id) === Number(button.dataset.piaId));
    if (!format) return;
    if (button.dataset.piaAction === 'copy') {
      try { await navigator.clipboard.writeText(format.content); toast('PIA format copied to the clipboard.'); }
      catch { toast('Windows blocked clipboard access.'); }
    }
    if (button.dataset.piaAction === 'edit') {
      byId('piaFormatId').value = format.id;
      byId('piaFormatSection').value = format.section_name;
      byId('piaFormatTitle').value = format.title;
      byId('piaFormatContent').value = format.content;
      byId('piaFormatSubmit').textContent = 'Update format';
      byId('piaFormatCancel').hidden = false;
      byId('piaFormatSection').focus();
    }
    if (button.dataset.piaAction === 'delete' && confirm(`Delete “${format.title}”?`)) {
      const response = await window.coreShiftAPI.deletePiaFormat(format.id);
      toast(response?.message || 'PIA format delete failed.');
      if (response?.success) await loadFormats();
    }
  }

  function resetLinkForm() {
    byId('piaLinkForm').reset();
    byId('piaLinkId').value = '';
    byId('piaLinkSubmit').textContent = 'Save staff link';
    byId('piaLinkCancel').hidden = true;
  }

  function resetFormatForm() {
    byId('piaFormatForm').reset();
    byId('piaFormatId').value = '';
    byId('piaFormatSubmit').textContent = 'Save format';
    byId('piaFormatCancel').hidden = true;
  }

  function recordMeta(record) {
    const date = new Date(record.updated_at || record.created_at);
    return `Updated ${Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleString()} · ${record.created_by || 'PIA admin'}`;
  }

  function setDatabaseStatus(text) { if (byId('piaDatabaseStatus')) byId('piaDatabaseStatus').textContent = text; }
  function renderFailure(container, message) { container.replaceChildren(element('div', 'pia-empty', message)); }
  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  window.PIAChannel = Object.freeze({ init, onShow });
})();

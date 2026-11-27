import { $, imageSource, isSpeedDial2Backup, movedOrder, parseBackup, readState, siteUrl, updateCollection } from './data.js';

let state;
let activeView;
let activeFolder;
let editingId;
let editingFolderId;
let dragging;
let dropHint;
const editor = $('editor');
const folderEditor = $('folder-editor');
const preferences = $('preferences');
const addTile = $('add');
const tabs = [...$('home-tabs').querySelectorAll('button')];
const labels = { html: 'HTML アプリ', react: 'JSX アプリ' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, label, action) {
  const node = element('button', text);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.title = label;
  node.onclick = action;
  return node;
}

function marker(entry) {
  const mark = element('span', [...entry.name][0].toUpperCase(), 'mark');
  mark.setAttribute('aria-hidden', 'true');
  const swatches = ['violet', 'blue', 'pink', 'green', 'amber'];
  const code = entry.name.codePointAt(0) || 0;
  mark.dataset.color = swatches[code % swatches.length];
  const source = imageSource(entry.imageUrl);
  if (source) {
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = source;
    mark.append(image);
  }
  return mark;
}

function visibleTiles() {
  const entries = new Map(state.entries.map(entry => [entry.id, entry]));
  const folders = new Map(state.folders.map(folder => [folder.id, folder]));
  const members = new Map();
  const occupied = new Set(state.entries.map(entry => entry.folderId));
  const visible = [];
  for (const id of state.order) {
    const entry = entries.get(id);
    if (!entry || (activeView !== 'all' && (entry.kind === 'site') !== (activeView === 'sites'))) continue;
    if (entry.folderId) {
      if (!members.has(entry.folderId)) members.set(entry.folderId, []);
      members.get(entry.folderId).push(entry);
    }
    if (entry.folderId === activeFolder) visible.push(entry);
  }
  if (activeFolder) return visible;
  const candidates = new Map(visible.map(entry => [entry.id, entry]));
  return state.order.map(id => {
    if (candidates.has(id)) return candidates.get(id);
    const folder = folders.get(id);
    if (!folder) return null;
    const children = members.get(id) || [];
    return children.length || !occupied.has(id) ? { ...folder, children } : null;
  }).filter(Boolean);
}

function clearDropHint() {
  dropHint?.classList.remove('drop-before', 'drop-after', 'drop-folder');
  dropHint = null;
}

function bindDrag(tile, item) {
  tile.draggable = true;
  tile.ondragstart = event => {
    if (event.target.closest('.tile-actions')) {
      event.preventDefault();
      return;
    }
    dragging = item;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    tile.classList.add('dragging');
  };
  tile.ondragend = () => {
    dragging = null;
    clearDropHint();
    tile.classList.remove('dragging');
  };
  const position = event => {
    const rect = tile.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (item.children && !dragging.children && x > .25 && x < .75 && y > .2 && y < .8) return 'folder';
    return x < .5 ? 'before' : 'after';
  };
  tile.ondragover = event => {
    if (!dragging || dragging.id === item.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const hint = 'drop-' + position(event);
    if (tile === dropHint && tile.classList.contains(hint)) return;
    clearDropHint();
    dropHint = tile;
    tile.classList.add(hint);
  };
  tile.ondragleave = event => {
    if (dropHint === tile && !tile.contains(event.relatedTarget)) clearDropHint();
  };
  tile.ondrop = event => {
    if (!dragging || dragging.id === item.id) return;
    event.preventDefault();
    const source = dragging.id;
    const action = position(event);
    dragging = null;
    clearDropHint();
    if (action === 'folder') {
      updateCollection(current => ({
        ...current, entries: current.entries.map(entry => entry.id === source ? { ...entry, folderId: item.id } : entry),
        order: [...current.order.filter(id => id !== source), source]
      })).catch(showStateError);
    } else {
      reorder(source, item.id, action === 'after');
    }
  };
}

function reorder(source, target, after) {
  if (!target) return;
  updateCollection(current => ({
    ...current, order: movedOrder(current.order, source, target.id || target, after)
  })).catch(showStateError);
}

function renderTile(item, index, items) {
  const tile = element('article', '', 'tile');
  tile.dataset.id = item.id;
  const folder = Boolean(item.children);
  const launch = element(folder ? 'button' : 'a', '', 'launch');
  launch.draggable = false;
  if (folder) {
    launch.type = 'button';
    launch.onclick = () => { activeFolder = item.id; render(); };
    const preview = element('span', '', 'folder-mark');
    preview.setAttribute('aria-hidden', 'true');
    preview.append(...item.children.slice(0, 4).map(marker));
    if (!item.children.length) preview.textContent = '▤';
    launch.append(preview, element('strong', item.name), element('small', `${item.children.length} 件`));
  } else {
    launch.href = item.kind === 'site' ? siteUrl(item.url) : `app.html?id=${encodeURIComponent(item.id)}`;
    if (state.openMode === 'new') {
      launch.target = '_blank';
      launch.rel = 'noopener noreferrer';
    }
    const subtitle = item.kind === 'site' ? new URL(launch.href).hostname : labels[item.kind];
    launch.append(marker(item), element('strong', item.name), element('small', subtitle));
  }
  const actions = element('div', '', 'tile-actions');
  const previous = button('←', `${item.name} を前へ`, () => reorder(item.id, items[index - 1], false));
  const next = button('→', `${item.name} を後ろへ`, () => reorder(item.id, items[index + 1], true));
  previous.disabled = index === 0;
  next.disabled = index === items.length - 1;
  const edit = button('✎', `${item.name} を編集`, () => folder ? openFolderEditor(item) : openEditor(item));
  actions.append(previous, next, edit);
  tile.append(launch, actions);
  bindDrag(tile, item);
  return tile;
}

function render() {
  const folder = state.folders.find(item => item.id === activeFolder);
  if (!folder) activeFolder = undefined;
  $('back-home').hidden = !folder;
  $('add-folder').hidden = Boolean(folder);
  $('view-title').textContent = folder?.name || 'スピードダイヤル';
  const split = state.homeView !== 'all';
  $('home-tabs').hidden = !split;
  $('tab-order-field').hidden = !split;
  for (const tab of tabs) {
    tab.setAttribute('aria-pressed', String(tab.dataset.view === activeView));
  }
  // DOM 順も左側のタブからに揃える。
  $('home-tabs').prepend(tabs.find(tab => tab.dataset.view === state.tabOrder) || tabs[0]);
  const items = visibleTiles();
  $('entries').replaceChildren(addTile, ...items.map(renderTile));
}

async function refresh() {
  const next = await readState();
  if (next.homeView !== state?.homeView) {
    activeView = next.homeView;
    activeFolder = undefined;
  }
  state = next;
  $('status').textContent = '';
  $('open-mode').value = state.openMode;
  $('home-view').value = state.homeView;
  $('tab-order').value = state.tabOrder;
  render();
}

for (const tab of tabs) {
  tab.onclick = () => {
    activeView = tab.dataset.view;
    activeFolder = undefined;
    render();
  };
}
$('back-home').onclick = () => { activeFolder = undefined; render(); };

function syncFields() {
  const site = $('kind').value === 'site';
  $('url-field').hidden = !site;
  $('url').disabled = !site;
  $('code-fields').hidden = site;
}

function openEditor(entry) {
  editingId = entry?.id;
  $('editor-title').textContent = entry ? '項目を編集' : '項目を追加';
  $('entry-form').reset();
  $('kind').value = entry?.kind || (activeView === 'apps' ? 'html' : 'site');
  $('name').value = entry?.name || '';
  $('url').value = entry?.url || '';
  $('source').value = entry?.source || '';
  $('image-url').value = entry?.imageUrl || '';
  const folders = $('entry-folder');
  folders.replaceChildren(new Option('ホーム', ''), ...state.folders.map(folder => new Option(folder.name, folder.id)));
  folders.value = entry?.folderId || activeFolder || '';
  $('delete').hidden = !entry;
  $('editor-error').textContent = '';
  syncFields();
  editor.showModal();
}

function openFolderEditor(folder) {
  editingFolderId = folder?.id;
  $('folder-title').textContent = folder ? 'フォルダーを編集' : 'フォルダーを作成';
  $('folder-name').value = folder?.name || '';
  $('remove-folder').hidden = !folder;
  $('folder-error').textContent = '';
  folderEditor.showModal();
}

$('add').onclick = () => openEditor();
$('cancel-edit').onclick = () => editor.close();
$('kind').onchange = syncFields;
$('add-folder').onclick = () => openFolderEditor();
$('cancel-folder').onclick = () => folderEditor.close();
$('folder-form').onsubmit = async event => {
  event.preventDefault();
  const id = editingFolderId;
  const name = $('folder-name').value.trim();
  if (!name) { $('folder-error').textContent = 'フォルダー名を入力してください。'; return; }
  try {
    await updateCollection(current => ({
      ...current, folders: id ? current.folders.map(folder => folder.id === id ? { id, name } : folder)
        : [...current.folders, { id: crypto.randomUUID(), name }]
    }));
    folderEditor.close();
  } catch {
    $('folder-error').textContent = 'フォルダーを保存できませんでした。';
  }
};
$('remove-folder').onclick = async () => {
  const id = editingFolderId;
  if (!confirm('フォルダーを解除し、中のタイルをホームに戻しますか？')) return;
  try {
    await updateCollection(current => ({
      ...current, folders: current.folders.filter(folder => folder.id !== id)
    }));
    folderEditor.close();
  } catch {
    $('folder-error').textContent = 'フォルダーを解除できませんでした。';
  }
};

$('file').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const kind = /\.html?$/i.test(file.name) ? 'html' : /\.(jsx|js)$/i.test(file.name) ? 'react' : '';
    if (!kind) throw new Error('HTML または JSX ファイルを選択してください。');
    const source = await file.text();
    if (!editor.open || event.target.files[0] !== file) return;
    $('source').value = source;
    $('kind').value = kind;
    if (!$('name').value.trim()) $('name').value = file.name.replace(/\.[^.]+$/, '');
    $('editor-error').textContent = '';
    syncFields();
  } catch (error) {
    $('editor-error').textContent = error.message;
  } finally {
    if (event.target.files[0] === file) event.target.value = '';
  }
};

function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('画像ファイルを選択してください。')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    reader.readAsDataURL(file);
  });
}

$('entry-form').onsubmit = async event => {
  event.preventDefault();
  const editing = editingId;
  const kind = $('kind').value;
  const save = event.submitter;
  if (save) save.disabled = true;
  try {
    const url = kind === 'site' ? siteUrl($('url').value.trim()) : '';
    const source = kind === 'site' ? '' : $('source').value;
    if (kind !== 'site' && !source.trim()) throw new Error('ソースコードを入力するか、ファイルを選択してください。');
    const name = $('name').value.trim() || (url ? new URL(url).hostname : '');
    if (!name) throw new Error('アプリ名を入力してください。');
    const folderId = $('entry-folder').value || undefined;
    const typedImage = $('image-url').value.trim();
    const file = $('image-file').files[0];
    const imageUrl = file ? await readImage(file) : imageSource(typedImage);
    if (typedImage && !imageUrl) throw new Error('画像の URL を確認してください。');

    await updateCollection(current => {
      const entry = { id: editing || crypto.randomUUID(), name, kind, url, source, folderId, imageUrl };
      const entries = editing ? current.entries.map(previous => previous.id === editing ? {
        ...entry, fallback: previous.source === source && previous.kind === kind ? previous.fallback : undefined
      } : previous) : [...current.entries, entry];
      return { ...current, entries };
    });
    editor.close();
  } catch (error) {
    $('editor-error').textContent = error.message || '項目を保存できませんでした。';
  } finally {
    if (save) save.disabled = false;
  }
};

$('delete').onclick = async () => {
  const id = editingId;
  if (!confirm('この項目を削除しますか？')) return;
  try {
    await updateCollection(current => ({ ...current, entries: current.entries.filter(entry => entry.id !== id) }));
    editor.close();
  } catch {
    $('editor-error').textContent = '項目を削除できませんでした。';
  }
};
$('settings').onclick = () => {
  $('settings-status').textContent = '';
  preferences.showModal();
};
$('startup-url').value = chrome.runtime.getURL('index.html');
$('copy-startup').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('startup-url').value);
    $('settings-status').textContent = '起動ページのアドレスをコピーしました。';
  } catch {
    $('startup-url').select();
    $('settings-status').textContent = '選択したアドレスをコピーしてください。';
  }
};
for (const [id, key] of [['open-mode', 'openMode'], ['home-view', 'homeView'], ['tab-order', 'tabOrder']]) {
  $(id).onchange = async event => {
    try {
      await chrome.storage.local.set({ [key]: event.target.value });
    } catch {
      $('settings-status').textContent = '設定を保存できませんでした。';
      event.target.value = state[key];
    }
  };
}

$('export').onclick = async () => {
  const { entries, folders, order } = await readState();
  const backup = { format: 'webapp-hub-speed-dial', version: 2, entries, folders, order };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const download = element('a');
  download.href = url;
  download.download = 'webapp-hub-speed-dial.json';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('import').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const imported = parseBackup(data);
    const count = imported.entries.length;
    const skipped = isSpeedDial2Backup(data) ? data.dials.length - count : 0;
    if (!count && skipped && !imported.folders.length) throw new Error('読み込める HTTP・HTTPS のリンクがありません。');
    await updateCollection(current => ({
      entries: [...current.entries, ...imported.entries], folders: [...current.folders, ...imported.folders],
      order: [...current.order, ...imported.order]
    }));
    $('settings-status').textContent = `${count} 件を追加しました。${skipped ? ` 対応外のリンク ${skipped} 件をスキップしました。` : ''}`;
  } catch (error) {
    $('settings-status').textContent = error.message || 'バックアップを読み込めませんでした。';
  }
};

function showStateError() {
  $('status').textContent = 'スピードダイヤルを読み込めませんでした。';
}
chrome.storage.onChanged.addListener(() => refresh().catch(showStateError));
refresh().catch(showStateError);

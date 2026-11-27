import { $, imageSource, isSpeedDial2Backup, movedOrder, parseBackup, readState, siteUrl, updateCollection } from './data.js';
import { applyGesture } from './tab-actions.js';

let state;
let activeView;
let activeFolder;
let editingId;
let editingFolderId;
let dragging;
let dropHint;
let stagedImage;
let imagePreviewUrl;
const editor = $('editor');
const folderEditor = $('folder-editor');
const folderPopup = $('folder-popup');
const addToFolder = $('add-to-folder');
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
    image.addEventListener('load', () => {
      mark.replaceChildren(image);
      mark.classList.add('has-image');
    }, { once: true });
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
  const root = new Map();
  for (const id of state.order) {
    const entry = entries.get(id);
    if (!entry || (activeView !== 'all' && (entry.kind === 'site') !== (activeView === 'sites'))) continue;
    if (entry.folderId) {
      if (!members.has(entry.folderId)) members.set(entry.folderId, []);
      members.get(entry.folderId).push(entry);
    } else {
      root.set(id, entry);
    }
  }
  const home = state.order.map(id => {
    if (root.has(id)) return root.get(id);
    const folder = folders.get(id);
    if (!folder) return null;
    const children = members.get(id) || [];
    return children.length || !occupied.has(id) ? { ...folder, children } : null;
  }).filter(Boolean);
  return { home, members };
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
    if (!activeFolder && !dragging.children && x > .25 && x < .75 && y > .2 && y < .8) {
      return 'folder';
    }
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
    updateCollection(current => action === 'folder'
      ? groupTiles(current, source, item.id)
      : { ...current, order: movedOrder(current.order, source, item.id, action === 'after') }
    ).catch(showStateError);
  };
}

function groupTiles(current, source, target) {
  const from = current.entries.find(entry => entry.id === source);
  if (!from || from.folderId) return current;
  if (current.folders.some(folder => folder.id === target)) {
    return {
      ...current,
      entries: current.entries.map(entry => entry.id === source ? { ...entry, folderId: target } : entry),
      order: [...current.order.filter(id => id !== source), source]
    };
  }
  const to = current.entries.find(entry => entry.id === target);
  if (!to || to.folderId) return current;
  const folderId = crypto.randomUUID();
  return {
    ...current,
    folders: [...current.folders, { id: folderId, name: '新しいフォルダー' }],
    entries: current.entries.map(entry => entry.id === source || entry.id === target ? { ...entry, folderId } : entry),
    order: current.order.filter(id => id !== source).flatMap(id => id === target ? [folderId, target, source] : [id])
  };
}

function renderTile(item) {
  const tile = element('article', '', 'tile');
  tile.dataset.id = item.id;
  tile.classList.toggle('site-tile', item.kind === 'site');
  const folder = Boolean(item.children);
  const launch = element(folder ? 'button' : 'a', '', 'launch');
  launch.draggable = false;
  if (folder) {
    launch.type = 'button';
    launch.setAttribute('aria-haspopup', 'dialog');
    launch.onclick = () => {
      activeFolder = item.id;
      renderFolder(visibleTiles().members);
      folderPopup.showModal();
    };
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
    const caption = element('span', '', 'tile-caption');
    caption.append(element('strong', item.name), element('small', subtitle));
    launch.append(marker(item), caption);
  }
  const actions = element('div', '', 'tile-actions');
  actions.append(button('✎', `${item.name} を編集`, () => folder ? openFolderEditor(item) : openEditor(item)));
  tile.append(launch, actions);
  bindDrag(tile, item);
  return tile;
}

function renderFolder(members) {
  const folder = state.folders.find(item => item.id === activeFolder);
  if (!folder) {
    if (folderPopup.open) folderPopup.close();
    return;
  }
  const entries = members.get(folder.id) || [];
  $('folder-popup-title').textContent = folder.name;
  $('folder-count').textContent = `${entries.length} 件`;
  $('folder-entries').replaceChildren(...entries.map(renderTile), addToFolder);
}

function render() {
  const split = activeView !== 'all';
  $('home-tabs').hidden = !split;
  $('tab-order-field').hidden = state.homeView === 'all';
  for (const tab of tabs) {
    tab.setAttribute('aria-pressed', String(tab.dataset.view === activeView));
  }
  // DOM 順も上側のボタンからに揃える。
  $('home-tabs').prepend(tabs.find(tab => tab.dataset.view === state.tabOrder) || tabs[0]);
  const { home, members } = visibleTiles();
  $('entries').replaceChildren(...home.map(renderTile), addTile);
  if (folderPopup.open) renderFolder(members);
}

async function refresh() {
  const next = await readState();
  if (next.homeView !== state?.homeView) {
    const requested = !state && location.hash.slice(1);
    activeView = ['apps', 'sites'].includes(requested) ? requested : next.homeView;
    if (folderPopup.open) folderPopup.close();
  }
  state = next;
  $('status').textContent = '';
  $('open-mode').value = state.openMode;
  $('home-view').value = state.homeView;
  $('tab-order').value = state.tabOrder;
  syncGridSettings(state.gridSettings);
  render();
}

function showView(view) {
  if (!state) return;
  activeView = view;
  if (folderPopup.open) folderPopup.close();
  render();
}

for (const tab of tabs) tab.onclick = () => showView(tab.dataset.view);
installMouseGestures(direction => {
  applyGesture(direction, showView).catch(showStateError);
}, () => !document.querySelector('dialog[open]'));

$('close-folder-popup').onclick = () => folderPopup.close();
folderPopup.addEventListener('click', event => {
  if (event.target === folderPopup) folderPopup.close();
});
folderPopup.addEventListener('close', () => {
  if (folderPopup.open) return;
  const folderId = activeFolder;
  activeFolder = undefined;
  const tiles = [...$('entries').querySelectorAll('.tile')];
  tiles.find(tile => tile.dataset.id === folderId)?.querySelector('.launch').focus();
});

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
  stagedImage = undefined;
  $('image-url').value = entry?.imageUrl || '';
  updateImagePreview();
  const folders = $('entry-folder');
  folders.replaceChildren(new Option('ホーム', ''), ...state.folders.map(folder => new Option(folder.name, folder.id)));
  folders.value = entry?.folderId || (folderPopup.open ? activeFolder : '') || '';
  $('delete').hidden = !entry;
  $('editor-error').textContent = '';
  syncFields();
  editor.showModal();
}

function openFolderEditor(folder) {
  editingFolderId = folder.id;
  $('folder-name').value = folder.name;
  $('folder-error').textContent = '';
  folderEditor.showModal();
}

addTile.onclick = () => openEditor();
addToFolder.onclick = () => openEditor();
$('cancel-edit').onclick = () => editor.close();
$('kind').onchange = syncFields;
$('cancel-folder').onclick = () => folderEditor.close();
$('folder-form').onsubmit = async event => {
  event.preventDefault();
  const id = editingFolderId;
  const name = $('folder-name').value.trim();
  if (!name) { $('folder-error').textContent = 'フォルダー名を入力してください。'; return; }
  try {
    await updateCollection(current => ({
      ...current, folders: current.folders.map(folder => folder.id === id ? { id, name } : folder)
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

function releasePreviewUrl() {
  if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  imagePreviewUrl = undefined;
}

function updateImagePreview() {
  releasePreviewUrl();
  const preview = $('image-preview');
  if (stagedImage) imagePreviewUrl = URL.createObjectURL(stagedImage);
  const source = imagePreviewUrl || imageSource($('image-url').value);
  if (source) preview.src = source;
  else preview.removeAttribute('src');
  $('image-preview-row').hidden = !source;
}

function stageImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    $('editor-error').textContent = '画像ファイルを選択してください。';
    return;
  }
  stagedImage = file;
  $('image-url').value = '';
  $('editor-error').textContent = '';
  updateImagePreview();
}

$('image-file').onchange = event => stageImage(event.target.files[0]);
$('image-url').oninput = () => {
  stagedImage = undefined;
  $('image-file').value = '';
  updateImagePreview();
};
$('clear-image').onclick = () => {
  $('image-url').value = '';
  $('image-url').oninput();
};
editor.addEventListener('paste', event => {
  const clipboard = event.clipboardData;
  const file = [...(clipboard?.files || [])].find(item => item.type.startsWith('image/')) ||
    [...(clipboard?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
  if (!file) return;
  event.preventDefault();
  $('image-file').value = '';
  stageImage(file);
});
editor.addEventListener('close', () => {
  if (editor.open) return;
  releasePreviewUrl();
  stagedImage = undefined;
  $('image-preview').removeAttribute('src');
  if (folderPopup.open && !folderPopup.contains(document.activeElement)) $('close-folder-popup').focus();
});

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
    const file = stagedImage;
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

const gridControls = { columns: $('tile-columns'), gap: $('tile-gap') };

function paintGridSettings({ columns, gap }) {
  document.documentElement.style.setProperty('--tile-columns', columns);
  document.documentElement.style.setProperty('--tile-gap', `${gap}px`);
  $('tile-columns-value').value = `${columns} 列`;
  $('tile-gap-value').value = `${gap} px`;
}

function syncGridSettings(settings) {
  for (const [key, input] of Object.entries(gridControls)) input.value = settings[key];
  paintGridSettings(settings);
}

function gridFromControls() {
  return { columns: gridControls.columns.valueAsNumber, gap: gridControls.gap.valueAsNumber };
}

for (const input of Object.values(gridControls)) {
  input.oninput = () => paintGridSettings(gridFromControls());
  input.onchange = async () => {
    try {
      await chrome.storage.local.set({ gridSettings: gridFromControls() });
    } catch {
      $('settings-status').textContent = 'タイル表示設定を保存できませんでした。';
      syncGridSettings(state.gridSettings);
    }
  };
}

$('export').onclick = async () => {
  const { entries, folders, order, gridSettings } = await readState();
  const backup = { format: 'webapp-hub-speed-dial', version: 2, entries, folders, order, gridSettings };
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
    }), imported.gridSettings);
    $('settings-status').textContent = `${count} 件を追加しました。${skipped ? ` 対応外のリンク ${skipped} 件をスキップしました。` : ''}${imported.gridSettings ? ' タイル表示設定も復元しました。' : ''}`;
  } catch (error) {
    $('settings-status').textContent = error.message || 'バックアップを読み込めませんでした。';
  }
};

function showStateError() {
  $('status').textContent = 'スピードダイヤルを読み込めませんでした。';
}
chrome.storage.onChanged.addListener(() => refresh().catch(showStateError));
refresh().catch(showStateError);

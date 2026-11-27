import { $, isSpeedDial2Backup, parseBackup, readState, siteUrl, updateEntries } from './data.js';

let state;
let editingId;
const editor = $('editor');
const preferences = $('preferences');
const labels = { html: 'HTML アプリ', react: 'JSX アプリ' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderTile(entry) {
  const tile = element('article', '', 'tile');
  const launch = element('a', '', 'launch');
  launch.href = entry.kind === 'site' ? siteUrl(entry.url) : `app.html?id=${encodeURIComponent(entry.id)}`;
  if (state.openMode === 'new') {
    launch.target = '_blank';
    launch.rel = 'noopener noreferrer';
  }
  const mark = element('span', [...entry.name][0].toUpperCase(), 'mark');
  mark.setAttribute('aria-hidden', 'true');
  if (typeof entry.imageUrl === 'string' && /^(https?:\/\/|data:image\/)/i.test(entry.imageUrl)) {
    const image = new Image();
    image.src = entry.imageUrl;
    image.alt = '';
    image.addEventListener('load', () => mark.replaceChildren(image), { once: true });
  }
  const subtitle = entry.kind === 'site' ? new URL(launch.href).hostname : labels[entry.kind];
  launch.append(mark, element('strong', entry.name), element('small', subtitle));
  const edit = element('button', '編集', 'edit');
  edit.setAttribute('aria-label', `${entry.name} を編集`);
  edit.onclick = () => openEditor(entry);
  tile.append(launch, edit);
  return tile;
}

async function refresh() {
  state = await readState();
  const container = $('entries');
  container.replaceChildren();
  $('open-mode').value = state.openMode;
  if (!state.entries.length) {
    container.append(element('p', '「追加」から Web サイト、HTML、JSX を登録できます。', 'empty'));
    return;
  }
  let sectionName;
  let grid;
  for (const entry of state.entries) {
    const next = entry.section || '';
    if (next !== sectionName) {
      sectionName = next;
      const section = element('section', '', 'group');
      grid = element('div', '', 'grid');
      if (next) section.append(element('h2', next));
      section.append(grid);
      container.append(section);
    }
    grid.append(renderTile(entry));
  }
}

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
  $('kind').value = entry?.kind || 'site';
  $('name').value = entry?.name || '';
  $('url').value = entry?.url || '';
  $('source').value = entry?.source || '';
  $('delete').hidden = !entry;
  $('editor-error').textContent = '';
  syncFields();
  editor.showModal();
}

$('add').onclick = () => openEditor();
$('cancel-edit').onclick = () => editor.close();
$('kind').onchange = syncFields;
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

$('entry-form').onsubmit = async event => {
  event.preventDefault();
  const editing = editingId;
  const kind = $('kind').value;
  try {
    const url = kind === 'site' ? siteUrl($('url').value.trim()) : '';
    const source = kind === 'site' ? '' : $('source').value;
    if (kind !== 'site' && !source.trim()) throw new Error('ソースコードを入力するか、ファイルを選択してください。');
    const name = $('name').value.trim() || (url ? new URL(url).hostname : '');
    if (!name) throw new Error('アプリ名を入力してください。');

    await updateEntries(entries => {
      const entry = { id: editing || crypto.randomUUID(), name, kind, url, source };
      if (!editing) return [...entries, entry];
      return entries.map(previous => previous.id === editing ? {
        ...entry, imageUrl: previous.imageUrl, section: previous.section,
        fallback: previous.source === source && previous.kind === kind ? previous.fallback : undefined
      } : previous);
    });
    editor.close();
  } catch (error) {
    $('editor-error').textContent = error.message || '項目を保存できませんでした。';
  }
};

$('delete').onclick = async () => {
  const id = editingId;
  if (!confirm('この項目を削除しますか？')) return;
  try {
    await updateEntries(entries => entries.filter(entry => entry.id !== id));
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
$('open-mode').onchange = async event => {
  try {
    await chrome.storage.local.set({ openMode: event.target.value });
  } catch {
    $('settings-status').textContent = '起動方法を保存できませんでした。';
    event.target.value = state.openMode;
  }
};

$('export').onclick = async () => {
  const backup = { format: 'webapp-hub-speed-dial', version: 1, entries: (await readState()).entries };
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
    const skipped = isSpeedDial2Backup(data) ? data.dials.length - imported.length : 0;
    if (!imported.length && skipped) throw new Error('読み込める HTTP・HTTPS のリンクがありません。');
    await updateEntries(entries => [...entries, ...imported]);
    $('settings-status').textContent = `${imported.length} 件を追加しました。${skipped ? ` 対応外のリンク ${skipped} 件をスキップしました。` : ''}`;
  } catch (error) {
    $('settings-status').textContent = error.message || 'バックアップを読み込めませんでした。';
  }
};

function showStateError() {
  $('status').textContent = 'スピードダイヤルを読み込めませんでした。';
}
chrome.storage.onChanged.addListener(() => refresh().catch(showStateError));
refresh().catch(showStateError);

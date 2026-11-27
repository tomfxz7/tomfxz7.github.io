export const $ = id => document.getElementById(id);

export async function readState() {
  const stored = await chrome.storage.local.get({
    entries: [], folders: [], order: [], openMode: 'same', homeView: 'all', tabOrder: 'apps'
  });
  return { ...stored, ...normalizeCollection(stored) };
}

export function normalizeCollection({ entries, folders = [], order = [] }) {
  const normalizedFolders = [...folders];
  const folderIds = new Set(folders.map(folder => folder.id));
  const inferredOrder = [];
  const seenFolders = new Set();
  const normalizedEntries = entries.map(({ section, ...entry }) => {
    if (section && !entry.folderId) {
      entry.folderId = `legacy:${section}`;
      if (!folderIds.has(entry.folderId)) {
        normalizedFolders.push({ id: entry.folderId, name: section });
        folderIds.add(entry.folderId);
      }
    }
    if (!folderIds.has(entry.folderId)) delete entry.folderId;
    if (entry.folderId && !seenFolders.has(entry.folderId)) {
      inferredOrder.push(entry.folderId);
      seenFolders.add(entry.folderId);
    }
    inferredOrder.push(entry.id);
    return entry;
  });
  const allIds = new Set([...inferredOrder, ...folderIds]);
  return {
    entries: normalizedEntries, folders: normalizedFolders,
    order: [...new Set([...order.filter(id => allIds.has(id)), ...allIds])]
  };
}

export function updateCollection(update) {
  return navigator.locks.request('hub-entries', async () => {
    const state = await readState();
    await chrome.storage.local.set(normalizeCollection(update(state)));
  });
}

export function movedOrder(order, source, target, after = false) {
  if (source === target || !order.includes(source) || !order.includes(target)) return order;
  const result = order.filter(id => id !== source);
  result.splice(result.indexOf(target) + Number(after), 0, source);
  return result;
}

export function imageSource(value) {
  if (typeof value !== 'string') return '';
  const source = value.trim();
  return /^(https?:\/\/|data:image\/)/i.test(source) ? source : '';
}

export function siteUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('http:// または https:// の URL を入力してください。');
  }
  return url.href;
}

export function isSpeedDial2Backup(data) {
  return Array.isArray(data?.dials) && Array.isArray(data.groups);
}

function parseSpeedDial2Backup({ dials, groups }) {
  const byPosition = (a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0);
  const buckets = new Map();
  for (const group of [...groups].sort(byPosition)) {
    if (!group || group.id == null) continue;
    const label = typeof group.title === 'string' ? group.title.trim() : '';
    buckets.set(String(group.id), { folder: { id: crypto.randomUUID(), name: label || 'フォルダー' }, entries: [] });
  }
  const ungrouped = { entries: [] };
  for (const dial of [...dials].sort(byPosition)) {
    if (typeof dial?.url !== 'string') continue;
    let url;
    try {
      url = siteUrl(dial.url);
    } catch {
      continue;
    }
    const bucket = buckets.get(String(dial.idgroup)) || ungrouped;
    const name = (typeof dial.title === 'string' && dial.title.trim()) || new URL(url).hostname;
    const imageUrl = imageSource(dial.thumbnail);
    bucket.entries.push({ id: crypto.randomUUID(), kind: 'site', url, name, imageUrl, folderId: bucket.folder?.id });
  }
  const bucketsInOrder = [...buckets.values(), ungrouped];
  return normalizeCollection({
    entries: bucketsInOrder.flatMap(bucket => bucket.entries),
    folders: [...buckets.values()].map(bucket => bucket.folder),
    order: bucketsInOrder.flatMap(({ folder, entries }) => [...(folder ? [folder.id] : []), ...entries.map(entry => entry.id)])
  });
}

export function parseBackup(data) {
  if (isSpeedDial2Backup(data)) return parseSpeedDial2Backup(data);

  if (data?.format === 'webapp-hub-speed-dial' && [1, 2].includes(data.version) && Array.isArray(data.entries)) {
    const idMap = new Map();
    const folders = (data.version === 2 ? data.folders : []).map(folder => {
      if (typeof folder?.id !== 'string' || typeof folder.name !== 'string' || !folder.name.trim() || idMap.has(folder.id)) {
        throw new Error('バックアップのフォルダーが不正です。');
      }
      const id = crypto.randomUUID();
      idMap.set(folder.id, id);
      return { id, name: folder.name };
    });
    const entries = data.entries.map(entry => {
      if (typeof entry?.name !== 'string' || !entry.name.trim() || !['site', 'html', 'react'].includes(entry.kind) ||
          (entry.id != null && idMap.has(entry.id))) {
        throw new Error('バックアップの項目が不正です。');
      }
      const content = entry.kind === 'site'
        ? { url: siteUrl(entry.url) }
        : { source: entry.source, fallback: entry.kind === 'react' ? entry.fallback : undefined };
      if (entry.kind !== 'site' && typeof content.source !== 'string') throw new Error('ソースコードが不正です。');
      const { name, kind, imageUrl } = entry;
      const id = crypto.randomUUID();
      if (entry.id != null) idMap.set(entry.id, id);
      return { id, name, kind, section: data.version === 1 && typeof entry.section === 'string' ? entry.section : undefined,
        folderId: idMap.get(entry.folderId), imageUrl: imageSource(imageUrl), ...content };
    });
    const order = Array.isArray(data.order) ? data.order.map(id => idMap.get(id)).filter(Boolean) : [];
    const normalized = normalizeCollection({ entries, folders, order });
    if (data.version !== 1) return normalized;
    // 旧形式のフォルダー識別子も、既存のコレクションと衝突しないよう振り直す。
    const folderIds = new Map(normalized.folders.map(folder => [folder.id, crypto.randomUUID()]));
    return {
      entries: normalized.entries.map(entry => ({ ...entry, folderId: folderIds.get(entry.folderId) })),
      folders: normalized.folders.map(folder => ({ ...folder, id: folderIds.get(folder.id) })),
      order: normalized.order.map(id => folderIds.get(id) || id)
    };
  }

  const apps = Array.isArray(data) ? data : data?.version === 2 ? data.apps : null;
  if (!Array.isArray(apps)) throw new Error('対応するバックアップ形式ではありません。');

  const entries = apps.map(app => {
    if (typeof app?.name !== 'string' || !app.name.trim() || typeof app.html !== 'string') {
      throw new Error('バックアップのアプリが不正です。');
    }
    const react = app.codeType === 'react' && Boolean(app.sourceCode?.trim());
    return {
      originalId: app.id, id: crypto.randomUUID(), name: app.name,
      kind: react ? 'react' : 'html', source: react ? app.sourceCode : app.html,
      fallback: react ? app.html : undefined, imageUrl: app.imageUrl, createdAt: app.createdAt
    };
  });

  const byId = new Map(entries.map(entry => [entry.originalId, entry]));
  const groups = new Map((data.layout?.groups || []).map(group => [group.id, {
    ...group, name: group.name || 'フォルダー', folderId: crypto.randomUUID()
  }]));
  const sorted = items => {
    const option = data.sortOption;
    if (!['name-asc', 'name-desc', 'date-asc', 'date-desc'].includes(option)) return items;
    const direction = option.endsWith('desc') ? -1 : 1;
    return items.sort((a, b) => direction * (option.startsWith('name')
      ? a.name.localeCompare(b.name, 'ja') : (a.createdAt || 0) - (b.createdAt || 0)));
  };
  const order = [];
  const handledGroups = new Set();
  const addGroup = group => {
    handledGroups.add(group.id);
    order.push(group.folderId);
    for (const entry of sorted(group.appIds.map(id => byId.get(id)).filter(Boolean))) {
      entry.folderId = group.folderId;
      order.push(entry.id);
    }
  };
  const home = (data.layout?.home || []).map(entry => entry.type === 'group'
    ? groups.get(entry.id) : byId.get(entry.id)).filter(Boolean);
  for (const item of sorted(home)) {
    if (groups.get(item.id) === item) addGroup(item);
    else order.push(item.id);
  }
  for (const group of groups.values()) if (!handledGroups.has(group.id)) addGroup(group);

  return normalizeCollection({
    entries: entries.map(({ originalId, createdAt, ...entry }) => entry),
    folders: [...groups.values()].map(group => ({ id: group.folderId, name: group.name })), order
  });
}

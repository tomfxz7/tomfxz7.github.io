export const $ = id => document.getElementById(id);

export async function readState() {
  return chrome.storage.local.get({ entries: [], openMode: 'same' });
}

export function updateEntries(update) {
  return navigator.locks.request('hub-entries', async () => {
    const { entries } = await readState();
    await chrome.storage.local.set({ entries: update(entries) });
  });
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
    buckets.set(String(group.id), { section: label, entries: [] });
  }
  const ungrouped = { section: '', entries: [] };
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
    const imageUrl = typeof dial.thumbnail === 'string' && /^(https?:\/\/|data:image\/)/i.test(dial.thumbnail)
      ? dial.thumbnail : undefined;
    bucket.entries.push({ id: crypto.randomUUID(), kind: 'site', url, name, imageUrl, section: bucket.section });
  }
  return [...buckets.values(), ungrouped].flatMap(bucket => bucket.entries);
}

export function parseBackup(data) {
  if (isSpeedDial2Backup(data)) return parseSpeedDial2Backup(data);

  if (data?.format === 'webapp-hub-speed-dial' && data.version === 1 && Array.isArray(data.entries)) {
    return data.entries.map(entry => {
      if (!entry?.name?.trim() || !['site', 'html', 'react'].includes(entry.kind)) {
        throw new Error('バックアップの項目が不正です。');
      }
      const content = entry.kind === 'site'
        ? { url: siteUrl(entry.url) }
        : { source: entry.source, fallback: entry.kind === 'react' ? entry.fallback : undefined };
      if (entry.kind !== 'site' && typeof content.source !== 'string') throw new Error('ソースコードが不正です。');
      const { name, kind, section, imageUrl } = entry;
      return { id: crypto.randomUUID(), name, kind, section, imageUrl, ...content };
    });
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
  const groups = new Map((data.layout?.groups || []).map(group => [group.id, group]));
  const sorted = items => {
    const option = data.sortOption;
    if (!['name-asc', 'name-desc', 'date-asc', 'date-desc'].includes(option)) return items;
    const direction = option.endsWith('desc') ? -1 : 1;
    return items.sort((a, b) => direction * (option.startsWith('name')
      ? a.name.localeCompare(b.name, 'ja') : (a.createdAt || 0) - (b.createdAt || 0)));
  };
  const ordered = new Set();
  for (const item of sorted((data.layout?.home || [])
    .map(entry => entry.type === 'group' ? groups.get(entry.id) : byId.get(entry.id)).filter(Boolean))) {
    if (!groups.has(item.id)) {
      ordered.add(item);
      continue;
    }
    for (const entry of sorted(item.appIds.map(id => byId.get(id)).filter(Boolean))) {
      entry.section = item.name;
      ordered.add(entry);
    }
  }
  entries.forEach(entry => ordered.add(entry));
  return [...ordered].map(({ originalId, createdAt, ...entry }) => entry);
}

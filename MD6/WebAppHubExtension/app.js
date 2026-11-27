import { $, imageSource, readState } from './data.js';
import { applyGesture } from './tab-actions.js';

const id = new URLSearchParams(location.search).get('id');

async function start() {
  const { entries } = await readState();
  const entry = entries.find(item => item.id === id);
  if (!entry || entry.kind === 'site') {
    $('app-status').textContent = 'このアプリは見つかりませんでした。';
    return;
  }

  document.title = entry.name;
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = imageSource(entry.imageUrl) || 'favicon.ico';
  document.head.append(icon);
  const runGesture = direction => applyGesture(direction, view => {
    location.href = `index.html#${view}`;
  }).catch(() => {
    $('app-status').hidden = false;
    $('app-status').textContent = 'タブを操作できませんでした。';
  });
  installMouseGestures(runGesture);
  // アプリからのメッセージは、入力検出器にだけ渡した識別子で確認する。
  const gestureKey = crypto.randomUUID();
  const prefix = `speed-dial:${entry.id}:`;
  const saved = () => Object.keys(localStorage)
    .filter(key => key.startsWith(prefix)).map(key => [key.slice(prefix.length), localStorage.getItem(key)]);
  const frame = document.createElement('iframe');
  frame.title = entry.name;
  frame.src = 'sandbox.html';
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox');

  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    const message = event.data;
    if (message?.type === 'hub-ready') {
      $('app-status').hidden = true;
    } else if (message?.type === 'hub-error' && typeof message.text === 'string') {
      $('app-status').hidden = false;
      $('app-status').textContent = message.text;
    } else if (message?.type === 'hub-gesture' && message.key === gestureKey) {
      runGesture(message.direction);
    } else if (message?.type === 'hub-storage') {
      try {
        if (message.action === 'clear') saved().forEach(([key]) => localStorage.removeItem(prefix + key));
        if (typeof message.key !== 'string') return;
        if (message.action === 'remove') localStorage.removeItem(prefix + message.key);
        if (message.action === 'set' && typeof message.value === 'string') {
          localStorage.setItem(prefix + message.key, message.value);
        }
      } catch {
        $('app-status').hidden = false;
        $('app-status').textContent = 'アプリのデータを保存できませんでした。';
      }
    }
  });

  frame.addEventListener('load', () => frame.contentWindow.postMessage({
    type: 'hub-launch', kind: entry.kind, source: entry.source, fallback: entry.fallback, storage: saved(), gestureKey
  }, '*'), { once: true });
  document.body.append(frame);
}

start().catch(() => { $('app-status').textContent = 'アプリを読み込めませんでした。'; });

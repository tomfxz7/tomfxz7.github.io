const extensionBase = new URL('.', location.href);
const parentOrigin = `${extensionBase.protocol}//${extensionBase.host}`;

function scriptData(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function installStorage(saved, origin) {
  const values = new Map(saved);
  const notify = (action, key, value) => parent.postMessage({ type: 'hub-storage', action, key, value }, origin);
  const storage = {
    getItem: key => values.get(String(key)) ?? null,
    setItem(key, value) {
      values.set(String(key), String(value));
      notify('set', String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
      notify('remove', String(key));
    },
    clear() {
      values.clear();
      notify('clear');
    },
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

function runReact(compiled, origin) {
  try {
    const modules = {
      react: React,
      'react-dom': ReactDOM,
      'react-dom/client': ReactDOM,
      'lucide-react': new Proxy({}, {
        get(_target, name) {
          const icon = window.lucide?.icons?.[name];
          const nodes = icon?.[0] === "svg" ? icon[2] : icon;
          if (!Array.isArray(nodes)) return undefined;
          return ({ size = 24, color = 'currentColor', strokeWidth = 2, children, ...props }) =>
            React.createElement('svg', {
              width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth,
              strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props
            }, ...nodes.map(([tag, attributes], key) => React.createElement(tag, { ...attributes, key })), children);
        }
      })
    };
    const require = name => {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error(`未対応の JSX モジュール: ${name}`);
    };
    const exports = {};
    const module = { exports };
    for (const hook of ['useState', 'useRef', 'useEffect', 'useCallback', 'useMemo']) window[hook] = React[hook];
    const App = new Function('require', 'module', 'exports', 'React',
      `${compiled}\nreturn module.exports.default || module.exports.App || (typeof App === "undefined" ? null : App);`
    )(require, module, exports, React);
    if (!App) throw new Error('ルートコンポーネントを default export するか、App として定義してください。');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  } catch (error) {
    parent.postMessage({ type: 'hub-error', text: error.message }, origin);
  }
}

function loadCompiler() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('vendor/babel.js', extensionBase).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error('JSX コンパイラーを読み込めませんでした。'));
    document.head.append(script);
  });
}

async function buildReact(source) {
  await loadCompiler();
  const { code } = Babel.transform(source, {
    presets: ['react'], plugins: ['transform-modules-commonjs'], filename: 'App.jsx'
  });
  const scripts = ['react.js', 'react-dom.js', 'iframe-lucide.js'].map(file =>
    `<script src="${new URL(`vendor/${file}`, extensionBase).href}"></script>`).join('');
  const tailwind = source.includes('className') ? '<script src="https://cdn.tailwindcss.com"></script>' : '';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${tailwind}</head><body><div id="root"></div>${scripts}<script>(${runReact})(${scriptData(code)}, ${scriptData(parentOrigin)});</script></body></html>`;
}

window.addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'hub-launch') return;
  const { kind, source, fallback, storage } = event.data;
  try {
    let html = source;
    if (kind === 'react') {
      try {
        html = await buildReact(source);
      } catch (error) {
        if (typeof fallback !== 'string' || !fallback.trim()) throw error;
        html = fallback;
      }
    }
    const shim = `<script>(${installStorage})(${scriptData(storage)}, ${scriptData(parentOrigin)});</script>`;
    const head = /^\s*(?:<!doctype[^>]*>\s*)?(?:<html\b[^>]*>\s*)?<head\b[^>]*>/i;
    const doctype = /^\s*<!doctype\b[^>]*>/i;
    const documentHtml = head.test(html) ? html.replace(head, tag => tag + shim)
      : html.replace(new RegExp(`(?:${doctype.source})|^`, 'i'), tag => tag + shim);
    parent.postMessage({ type: 'hub-ready' }, parentOrigin);
    document.open();
    document.write(documentHtml);
    document.close();
  } catch (error) {
    parent.postMessage({ type: 'hub-error', text: error.message }, parentOrigin);
  }
});

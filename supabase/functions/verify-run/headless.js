// Runs the real game script from index.html without a browser, so the server can
// re-play a recorded run and compute the score itself. Shared by the Supabase Edge
// Function (Deno) and tools/replay-test.mjs (Node).

function makeStub() {
  let stub;
  stub = new Proxy(function () {}, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      return stub;
    },
    set() { return true; },
    apply() { return stub; },
    construct() { return stub; },
    has() { return true; },
    deleteProperty() { return true; }
  });
  return stub;
}

export function extractGameScript(html) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) if (m[1].includes('RULES_VERSION')) return m[1];
  throw new Error('game script not found in index.html');
}

// Returns window.NAH_ENGINE ({ replayRun(run), RULES_VERSION, ... }). Build a fresh one per run.
export function createEngine(src) {
  const stub = makeStub();
  const mem = new Map();
  const localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
    clear: () => mem.clear(),
    key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size; }
  };
  const location = { protocol: 'https:', origin: 'https://headless.local', pathname: '/', href: 'https://headless.local/', search: '', hash: '' };
  const navigator = { onLine: false, userAgent: 'headless', language: 'en' };
  const noop = () => 0;
  const matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
  const winProps = {
    NAH_HEADLESS: true, NAH_CONFIG: { supabaseUrl: '', supabaseAnonKey: '', siteUrl: '' },
    localStorage, location, navigator, crypto: globalThis.crypto, matchMedia,
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 1,
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    AudioContext: undefined, webkitAudioContext: undefined, NAH_ENGINE: undefined
  };
  const window = new Proxy(winProps, {
    get(t, k) { return k in t ? t[k] : stub; },
    set(t, k, v) { t[k] = v; return true; },
    has() { return true; }
  });
  const g = {
    window, self: window, globalThis: window, document: stub, localStorage, location, navigator, matchMedia,
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    fetch: () => Promise.reject(new Error('offline')), alert: noop, confirm: () => false, screen: stub,
    addEventListener: noop, removeEventListener: noop, getComputedStyle: () => stub, Image: function () { return stub; },
    history: stub, performance: { now: () => Date.now() }
  };
  const names = Object.keys(g);
  const engine = new Function(...names, `${src}\n;return window.NAH_ENGINE;`)(...names.map(n => g[n]));
  if (!engine || typeof engine.replayRun !== 'function') throw new Error('engine failed to start');
  return engine;
}

// Pruebas de background.js con un `chrome` simulado.
// Ejecutar: node --test browser-extension/vyntra-browser/tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "background.js"), "utf8");

function createStorageArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      // Simula la latencia del storage para detectar carreras.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

function loadBackground({ versionName = "", fetchImpl } = {}) {
  const listeners = [];
  const local = createStorageArea();
  const session = createStorageArea();
  const registered = [];
  const chrome = {
    runtime: {
      id: "vyntra-ext",
      getManifest: () => ({ version: "0.3.1", version_name: versionName }),
      getURL: (path) => `chrome-extension://vyntra-ext/${path}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
    },
    storage: { local, session },
    alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
    tabs: {
      query: async () => [],
      sendMessage: async () => undefined,
      captureVisibleTab: async () => "data:image/png;base64,AAAA",
    },
    idle: { queryState: (_seconds, cb) => cb("active") },
    scripting: {
      getRegisteredContentScripts: async () => registered.slice(),
      registerContentScripts: async (scripts) => registered.push(...scripts),
      updateContentScripts: async (scripts) => {
        registered.splice(0, registered.length, ...scripts);
      },
      unregisterContentScripts: async () => registered.splice(0, registered.length),
    },
  };
  const context = vm.createContext({
    chrome,
    crypto: globalThis.crypto,
    fetch: fetchImpl || (async () => { throw new Error("sin red"); }),
    console,
    setTimeout,
    URL,
    Blob,
    FormData,
    atob,
  });
  vm.runInContext(source, context, { filename: "background.js" });
  return { ctx: context, chrome, local, session, registered, listeners };
}

const RULES = [
  { executable_name: "browser-extension", title_contains: "salesforce.com", classification: "productive", priority: 5 },
  { executable_name: "", title_contains: ".zendesk.com", classification: "productive", priority: 1 },
  { executable_name: "", title_contains: "YouTube", classification: "non_productive", priority: 1 },
  { executable_name: "excel.exe", title_contains: "", classification: "productive", priority: 1 },
];

test("patrones de dominio: host exacto o subdominio", () => {
  const { ctx } = loadBackground();
  const tab = (url, title = "Pagina") => ({ url, title });
  assert.equal(ctx.normalizeTab(tab("https://salesforce.com/home"), RULES).identifier, "salesforce.com");
  const sub = ctx.normalizeTab(tab("https://acme.my.salesforce.com/lightning"), RULES);
  assert.equal(sub.identifier, "salesforce.com");
  assert.equal(sub.evidenceAllowed, true);
  assert.equal(ctx.normalizeTab(tab("https://acme.zendesk.com/agent"), RULES).evidenceAllowed, true);
  assert.equal(ctx.normalizeTab(tab("https://zendesk.com/"), RULES).listed, true);
});

test("patrones de dominio: no coinciden como subcadena ni por el titulo", () => {
  const { ctx } = loadBackground();
  for (const [url, title] of [
    ["https://evil-salesforce.com/", "Login"],
    ["https://salesforce.com.evil.net/", "Login"],
    ["https://notsalesforce.com/", "Login"],
    ["https://example.com/", "Como usar salesforce.com - blog"],
    ["https://fakezendesk.com/", "zendesk.com"],
  ]) {
    const result = ctx.normalizeTab({ url, title }, RULES);
    assert.equal(result.listed, false, url);
    assert.equal(result.evidenceAllowed, false, url);
    assert.equal(result.identifier, "(sitio fuera de lista)");
  }
});

test("patrones sin forma de dominio: subcadena sin mayusculas", () => {
  const { ctx } = loadBackground();
  const result = ctx.normalizeTab({ url: "https://www.youtube.com/watch?v=1", title: "Musica - YouTube" }, RULES);
  assert.equal(result.identifier, "YouTube");
  assert.equal(result.listed, true);
  assert.equal(result.evidenceAllowed, false);
});

test("reglas de otros ejecutables no aplican al navegador y sin pestana no hay evidencia", () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.normalizeTab({ url: "https://excel.office.com/", title: "Excel" }, RULES).listed, false);
  assert.equal(ctx.normalizeTab(null, RULES).evidenceAllowed, false);
});

test("patrones de registro dinamico solo para dominios productivos", () => {
  const { ctx } = loadBackground();
  assert.deepEqual(Array.from(ctx.productiveMatchPatterns(RULES)), [
    "*://*.salesforce.com/*",
    "*://*.zendesk.com/*",
    "*://salesforce.com/*",
    "*://zendesk.com/*",
  ]);
});

test("apiBase: solo origenes de la estacion; localhost solo en build dev", () => {
  const prod = loadBackground();
  assert.equal(prod.ctx.isAllowedApiBase("https://vyntralab.tech"), true);
  assert.equal(prod.ctx.isAllowedApiBase("https://www.vyntralab.tech/"), true);
  assert.equal(prod.ctx.isAllowedApiBase("https://evil.example.com"), false);
  assert.equal(prod.ctx.isAllowedApiBase("http://localhost:3000"), false);
  const dev = loadBackground({ versionName: "0.3.1-dev" });
  assert.equal(dev.ctx.isAllowedApiBase("http://localhost:3000"), true);
});

test("station_sync valida sender.url y apiBase", async () => {
  const { ctx, local, session } = loadBackground();
  const stationSender = { id: "vyntra-ext", tab: { id: 1 }, frameId: 0, url: "https://vyntralab.tech/estacion" };
  const evilSender = { id: "vyntra-ext", tab: { id: 2 }, frameId: 0, url: "https://evil.example.com/" };
  const payload = { apiBase: "https://vyntralab.tech", session: { token: "secreto", email: "a@b.c" } };

  const rejected = await ctx.handleMessage({ type: "station_sync", payload }, evilSender);
  assert.equal(rejected.ok, false);
  const badBase = await ctx.handleMessage(
    { type: "station_sync", payload: { ...payload, apiBase: "https://evil.example.com" } },
    stationSender,
  );
  assert.equal(badBase.ok, false);

  const accepted = await ctx.handleMessage({ type: "station_sync", payload }, stationSender);
  assert.equal(accepted.ok, true);
  // El token vive en storage.session, no en storage.local.
  assert.equal(session.data.vyntraStationToken, "secreto");
  assert.equal(local.data.vyntraStationBridge.session.token, undefined);
  assert.equal((await ctx.loadStation()).session.token, "secreto");

  const popupOnly = await ctx.handleMessage({ type: "sample_now" }, stationSender);
  assert.equal(popupOnly.ok, false);
});

test("la cola serializa enqueue concurrentes y conserva eventos de marcaje al recortar", async () => {
  const { ctx, local } = loadBackground();
  await Promise.all(Array.from({ length: 30 }, (_, i) => ctx.enqueue({ id: `e${i}`, tipo: "browser_activity_snapshot" })));
  assert.equal(local.data.vyntraBrowserQueue.length, 30);

  const queue = [
    { id: "s1", tipo: "shift_started" },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, tipo: "browser_activity_snapshot" })),
    { id: "s2", tipo: "break_started" },
  ];
  const trimmed = Array.from(ctx.trimQueue(queue, 3));
  assert.deepEqual(trimmed.map((event) => event.id), ["s1", "a4", "s2"]);
  const onlyCritical = Array.from(ctx.trimQueue([{ id: "x", tipo: "shift_finished" }, { id: "y", tipo: "shift_started" }], 1));
  assert.equal(onlyCritical.length, 2);
});

test("flush envia por lotes y quita aceptados y rechazados", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const { events } = JSON.parse(init.body);
    bodies.push(events.length);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        accepted: events.filter((event) => event.id !== "e3").map((event) => ({ id: event.id })),
        rejected: events.filter((event) => event.id === "e3").map((event) => ({ id: event.id, error: "x" })),
      }),
    };
  };
  const { ctx, local } = loadBackground({ fetchImpl });
  await ctx.enqueue(Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, tipo: "browser_activity_snapshot" })));
  const station = { apiBase: "https://vyntralab.tech", session: { token: "t" } };
  const result = await ctx.flushQueue(station);
  assert.equal(result.pending, 0);
  assert.deepEqual(bodies, [50, 50, 20]);
  assert.deepEqual(local.data.vyntraBrowserQueue, []);
});

test("captura: se descarta si la pestana activa cambia", async () => {
  const fetchCalls = [];
  const { ctx, chrome, local } = loadBackground({
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await local.set({ vyntraBrowserRules: { rules: RULES, fetchedAt: new Date().toISOString() } });
  const tabs = [
    { id: 7, windowId: 1, url: "https://acme.salesforce.com/", title: "Cuenta" },
    { id: 8, windowId: 1, url: "https://mail.example.com/", title: "Correo personal" },
  ];
  let calls = 0;
  chrome.tabs.query = async () => [tabs[Math.min(calls++, 1)]];
  const station = { apiBase: "https://vyntralab.tech", session: { token: "t" } };
  await assert.rejects(ctx.uploadVisibleTabCapture({ station, mode: "auto" }), (error) => error.code === "TAB_CHANGED");
  assert.equal(fetchCalls.filter((url) => url.includes("/api/evidence/upload")).length, 0);
});

import { useCallback, useEffect, useRef, useState } from "react";

/* Общее хранилище: Supabase (REST + Realtime). Каждая правка — отдельная запись; версия записи = updated_at. */
const cfg = window.TABLO_CONFIG || {};
const BASE = String(cfg.supabaseUrl || "").replace(/\/$/, "");
const KEY = cfg.supabasePublishableKey || "";
const POLL = cfg.pollMs || 15000;
const HDR = { apikey: KEY, "Content-Type": "application/json" }; // sb_publishable — не JWT, в Authorization не передаётся
const TABLES = ["bookings", "zoom_resources", "tablo_categories", "tablo_courses", "tablo_settings"];
export const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
export const LEGACY_KEY = "tablo:draft:v1";

class ApiError extends Error { constructor(m, code, offline, details) { super(m); this.code = code; this.offline = !!offline; this.details = details || null; } }

async function rest(method, path, body, prefer) {
  let res;
  try {
    res = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: prefer ? { ...HDR, Prefer: prefer } : HDR, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch (e) { throw new ApiError("Нет связи с сервером.", null, true); }
  const t = await res.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* не JSON */ }
  if (!res.ok) {
    const code = j && j.code;
    const msg = code === "PGRST205" || code === "42P01" ? "В базе нет нужных таблиц: выполните SQL из инструкции." : code === "PGRST202" ? "На сервере нет функции tablo_apply_changes: выполните sql/03_atomic_apply.sql." : code === "TB409" ? "CONFLICT" : (j && j.message) || `Ошибка сервера ${res.status}.`;
    throw new ApiError(msg, code, false, (j && j.details) || null);
  }
  return j;
}
const enc = encodeURIComponent;
const CONFLICT = "Данные на сервере изменились после того, как вы их открыли (кто-то из сотрудников что-то добавил, изменил или удалил). Ничего не применено. Актуальные данные загружены — повторите действие.";
async function apply(ops) {
  try { return await rest("POST", "rpc/tablo_apply_changes", { ops }); }
  catch (e) {
    if (e.code === "TB409" || e.code === "23505") throw new ApiError(CONFLICT + (e.details ? ` (${e.details})` : ""), "STALE");
    if (e.code === "23P01") throw new ApiError("Ничего не применено: в результате Zoom ID оказался бы занят двумя бронированиями на пересекающиеся даты.", "23P01");
    if (e.code === "23503") throw new ApiError("Ничего не применено: есть ссылка на несуществующий курс или Zoom ID, либо Zoom ID используется в бронированиях.", "23503");
    throw e;
  }
}
const STALE = "Запись уже изменил или удалил другой сотрудник. Актуальные данные загружены — закройте окно и откройте запись заново.";
async function guarded(method, table, id, ver, patch, col = "id") {
  const rows = await rest(method, `${table}?${col}=eq.${enc(id)}&updated_at=eq.${enc(ver)}`, patch, "return=representation");
  if (!rows || !rows.length) throw new ApiError(STALE, "STALE");
  return rows[0];
}

const bIn = (r) => ({ id: r.id, title: r.title, zoomResourceId: r.zoom_resource_id || null, startDate: String(r.start_date).slice(0, 10), endDate: String(r.end_date).slice(0, 10), responsible: r.responsible || null, curator: r.curator || null, comment: r.comment || null, color: r.color || "blue", ...(r.course_id ? { courseId: r.course_id } : {}), createdAt: r.created_at, updatedAt: r.updated_at });
const bOut = (v) => ({ title: v.title, zoom_resource_id: v.zoomResourceId || null, start_date: v.startDate, end_date: v.endDate, responsible: v.responsible || null, curator: v.curator || null, comment: v.comment || null, color: v.color, course_id: v.courseId || null });
const rIn = (r) => ({ id: r.id, name: r.name || "Дополнительный", zoomId: r.zoom_id, joinUrl: r.join_url || null, active: r.active !== false, permanent: !!r.permanent, updatedAt: r.updated_at });
const rOut = (r) => ({ id: r.id, zoom_id: r.zoomId, name: r.name, active: r.active !== false, permanent: !!r.permanent, join_url: r.joinUrl || null });

async function loadAll() {
  const [res, bk, cat, crs, st] = await Promise.all([
    rest("GET", "zoom_resources?select=*&order=created_at.asc"),
    rest("GET", "bookings?select=*&order=created_at.asc"),
    rest("GET", "tablo_categories?select=*&order=sort_order.asc,name.asc"),
    rest("GET", "tablo_courses?select=*&order=sort_order.asc,title.asc"),
    rest("GET", "tablo_settings?select=*&key=eq.survey"),
  ]);
  const s = st[0];
  if (!s || !s.value) throw new ApiError("Настройки анкеты не найдены: выполните 02_seed.sql.", "NOSEED");
  return {
    categories: cat.map((c) => ({ id: c.id, name: c.name, updatedAt: c.updated_at })),
    courses: crs.map((c) => ({ id: c.id, title: c.title, categoryId: c.category_id, url: c.url, updatedAt: c.updated_at })),
    survey: { title: s.value.title, url: s.value.url, updatedAt: s.updated_at },
    schedule: { resources: res.map(rIn), bookings: bk.map(bIn) },
  };
}

function connectRealtime(onEvent, onJoin, onState) {
  let ws, hb, timer, retry = 0, closed = false;
  const open = () => {
    try { ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${enc(KEY)}&vsn=1.0.0`); } catch (e) { onState(false); return; }
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ topic: "realtime:tablo", event: "phx_join", ref: "1", join_ref: "1", payload: { config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: TABLES.map((table) => ({ event: "*", schema: "public", table })) } } }));
      hb = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" })); }, 25000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.event === "phx_reply" && m.ref === "1") { const ok = m.payload && m.payload.status === "ok"; onState(ok); if (ok) onJoin(); }
      else if (m.event === "postgres_changes") onEvent();
    };
    ws.onclose = () => { clearInterval(hb); onState(false); if (!closed) timer = setTimeout(open, Math.min(30000, 1000 * 2 ** retry++)); };
  };
  open();
  return () => { closed = true; clearTimeout(timer); clearInterval(hb); if (ws) ws.close(); };
}

const overlap = (a, b) => a.startDate <= b.endDate && b.startDate <= a.endDate;

export function useStore() {
  const [data, setData] = useState(null);
  const [st, setSt] = useState(null); // {kind: saving|saved|error, text}
  const [pollErr, setPollErr] = useState(null);
  const [lastOk, setLastOk] = useState(null);
  const [live, setLive] = useState(false);
  const [legacy, setLegacy] = useState(() => { try { return localStorage.getItem(LEGACY_KEY); } catch (e) { return null; } });
  const seq = useRef(0), applied = useRef(0), dref = useRef(null);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await loadAll();
      if (my < applied.current) return dref.current; // запоздавший ответ не затирает более свежий
      applied.current = my; dref.current = d; setData(d); setLastOk(new Date()); setPollErr(null);
      return d;
    } catch (e) { setPollErr(e.offline ? "Нет связи с сервером" : e.message); return null; }
  }, []);

  useEffect(() => {
    reload();
    let deb;
    const soon = () => { clearTimeout(deb); deb = setTimeout(reload, 150); };
    const stop = connectRealtime(soon, reload, setLive); // при (пере)подключении — повторное чтение сервера
    const t = setInterval(reload, POLL);
    const vis = () => { if (!document.hidden) reload(); };
    document.addEventListener("visibilitychange", vis); window.addEventListener("focus", vis); window.addEventListener("online", vis);
    return () => { stop(); clearInterval(t); clearTimeout(deb); document.removeEventListener("visibilitychange", vis); window.removeEventListener("focus", vis); window.removeEventListener("online", vis); };
  }, [reload]);

  /** Успех показывается только после ответа сервера и повторного чтения данных. */
  const run = useCallback(async (fn) => {
    setSt({ kind: "saving" });
    try { const r = await fn(); await reload(); setSt({ kind: "saved" }); return r; }
    catch (e) { if (e.offline || e.code === "STALE" || e.code === "23P01" || e.code === "23503") await reload(); setSt({ kind: "error", text: e.offline ? "Сохранение не подтверждено сервером. Обновите данные перед повторным сохранением." : e.message }); throw e; }
  }, [reload]);
  const msg = (e) => (e.offline ? "Нет связи с сервером: сохранение не подтверждено. Обновите данные, прежде чем повторять сохранение." : e.code === "23P01" ? "Этот Zoom ID уже занят в выбранный период." : e.message);

  const sched = () => dref.current.schedule;
  const api = {
    async saveBooking(v, prev) {
      try {
        await run(() => (prev ? guarded("PATCH", "bookings", prev.id, prev.updatedAt, bOut(v)) : rest("POST", "bookings", { id: uid("b"), ...bOut(v) }, "return=minimal")));
        return { saved: v };
      } catch (e) {
        if (e.code === "23P01") { const c = sched().bookings.find((b) => (!prev || b.id !== prev.id) && b.zoomResourceId === v.zoomResourceId && overlap(b, v)); if (c) return { conflict: c }; }
        return { error: msg(e) };
      }
    },
    deleteBooking: (b) => run(() => guarded("DELETE", "bookings", b.id, b.updatedAt)),
    /** Только то, что пользователь изменил в диалоге (сравнение с исходным списком на момент открытия), одной транзакцией. */
    saveResources: (next, initial) => run(async () => {
      const was = Object.fromEntries(initial.map((r) => [r.id, r]));
      const ops = [];
      for (const r of next) {
        const w = was[r.id];
        if (!w) ops.push({ table: "zoom_resources", op: "upsert", id: r.id, expected: null, row: rOut(r) });
        else if (w.zoomId !== r.zoomId || w.active !== r.active || (w.joinUrl || null) !== (r.joinUrl || null)) {
          const { permanent, ...row } = rOut(r);
          ops.push({ table: "zoom_resources", op: "upsert", id: r.id, expected: w.updatedAt || null, row: w.updatedAt ? row : rOut(r) });
        }
      }
      const kept = new Set(next.map((r) => r.id));
      for (const w of initial) if (!w.permanent && !kept.has(w.id)) ops.push({ table: "zoom_resources", op: "delete", id: w.id, expected: w.updatedAt || null });
      if (ops.length) await apply(ops);
    }),
    async saveCourse(v, prev) {
      let id = prev ? prev.id : uid("c"), categoryId = v.categoryId, created = null;
      try {
        await run(async () => {
          if (!categoryId) {
            const ex = dref.current.categories.find((c) => norm(c.name) === norm(v.newCategory));
            if (ex) categoryId = ex.id; else { categoryId = uid("cat"); created = categoryId; await rest("POST", "tablo_categories", { id: categoryId, name: v.newCategory, sort_order: dref.current.categories.length }, "return=minimal"); }
          }
          try {
            if (prev) await guarded("PATCH", "tablo_courses", prev.id, prev.updatedAt, { title: v.title, url: v.url, category_id: categoryId });
            else await rest("POST", "tablo_courses", { id, title: v.title, url: v.url, category_id: categoryId, sort_order: dref.current.courses.length }, "return=minimal");
          } catch (e) { if (created) await rest("DELETE", `tablo_categories?id=eq.${enc(created)}`).catch(() => {}); throw e; }
        });
        return { id };
      } catch (e) { return { error: msg(e) }; }
    },
    async saveSurvey(v, prev) {
      try { await run(() => guarded("PATCH", "tablo_settings", "survey", prev.updatedAt, { value: { title: v.title, url: v.url } }, "key")); return {}; }
      catch (e) { return { error: msg(e) }; }
    },
    /** Свежий снимок сервера. Ошибка чтения — исключение, подмены данными из памяти нет. */
    snapshot: () => loadAll(),
    /** Атомарный импорт. snap — снимок сервера, показанный пользователю; строки, изменённые после него, импорт отклоняют. */
    importData: (x, scopeAll, snap) => run(async () => {
      const ver = (arr) => Object.fromEntries(arr.map((r) => [r.id, r.updatedAt || null]));
      const ops = [];
      const add = (table, id, expected, row) => ops.push({ table, op: "upsert", id, expected: expected || null, row });
      if (scopeAll) {
        const cv = ver(snap.categories), kv = ver(snap.courses);
        x.categories.forEach((c, i) => add("tablo_categories", c.id, cv[c.id], { id: c.id, name: c.name, sort_order: i }));
        x.courses.forEach((c, i) => add("tablo_courses", c.id, kv[c.id], { id: c.id, title: c.title, url: c.url, category_id: c.categoryId, sort_order: i }));
        add("tablo_settings", "survey", snap.survey.updatedAt, { key: "survey", value: { title: x.survey.title, url: x.survey.url } });
      }
      const rv = ver(snap.schedule.resources), bv = ver(snap.schedule.bookings);
      x.schedule.resources.forEach((r) => { const { permanent, ...o } = rOut(r); add("zoom_resources", r.id, rv[r.id], rv[r.id] ? o : rOut(r)); });
      x.schedule.bookings.forEach((b) => add("bookings", b.id, bv[b.id], { id: b.id, ...bOut(b) }));
      await apply(ops);
    }),
    /** Копия строго с сервера. При ошибке чтения бросает исключение — данные из памяти не подставляются. */
    async backup() { const d = await loadAll(); return { schemaVersion: 1, revision: `r${Date.now().toString(36)}`, exportedAt: new Date().toISOString(), categories: d.categories.map(({ id, name }) => ({ id, name })), courses: d.courses.map(({ id, title, categoryId, url }) => ({ id, title, categoryId, url })), survey: { title: d.survey.title, url: d.survey.url }, schedule: { resources: d.schedule.resources.map(({ updatedAt, ...r }) => r), bookings: d.schedule.bookings } }; },
  };
  const dropLegacy = () => { try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ничего */ } setLegacy(null); };
  const status = st && st.kind === "saving" ? { t: "Сохраняем…", k: "wait" } : pollErr ? { t: pollErr, k: "bad" } : st && st.kind === "error" ? { t: st.text, k: "bad" } : st && st.kind === "saved" ? { t: "Сохранено", k: "ok" } : null;
  return { current: data, api, reload, status, lastOk, live, loadError: data ? null : pollErr, legacy, dropLegacy, pollErr };
}

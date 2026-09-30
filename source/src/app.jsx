import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { checkBackup, ZoomSchedule } from "./schedule.jsx";
import { copyText, downloadJson, isHttpUrl } from "./util.js";
import { qrModel } from "./qr.js";
import { useStore, uid, norm } from "./store.js";

/* =====================================================================
   Формат catalog.json (schemaVersion 1)
   {
     schemaVersion: 1,           версия формата
     revision: "строка",         идентификатор редакции; меняется при каждой выгрузке
     exportedAt: "ISO-дата",
     categories: [{ id, name }],
     courses:    [{ id, title, categoryId, url }],   id стабилен, не зависит от названия и порядка
     survey:     { title, url },
     schedule:   { resources: [...], bookings: [{ ..., courseId? }] }   формат резервной копии старого расписания
   }
   Рабочее хранилище — Supabase (см. store.js); этот формат — файл резервной копии.
   ===================================================================== */

/** Проверка catalog.json. Бросает Error с понятным текстом; исходный объект не меняет. */
function validateCatalog(raw) {
  const bad = (m) => { throw new Error(m); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("это не файл каталога.");
  if (raw.schemaVersion !== 1) bad("неизвестная версия формата (нужна schemaVersion: 1).");
  if (typeof raw.revision !== "string" || !raw.revision) bad("нет идентификатора редакции (revision).");
  if (!Array.isArray(raw.categories) || !Array.isArray(raw.courses)) bad("нет списков categories и courses.");
  const catIds = new Set();
  const categories = raw.categories.map((c, i) => {
    if (!c || typeof c.id !== "string" || !c.id || typeof c.name !== "string" || !c.name.trim()) bad(`категория №${i + 1} записана неверно.`);
    if (catIds.has(c.id)) bad(`повторяется ID категории «${c.id}».`);
    catIds.add(c.id);
    return { id: c.id, name: c.name.trim() };
  });
  const ids = new Set();
  const courses = raw.courses.map((c, i) => {
    if (!c || typeof c.id !== "string" || !c.id) bad(`у курса №${i + 1} нет ID.`);
    if (ids.has(c.id)) bad(`повторяется ID курса «${c.id}».`);
    ids.add(c.id);
    if (typeof c.title !== "string" || !c.title.trim()) bad(`у курса «${c.id}» нет названия.`);
    if (!catIds.has(c.categoryId)) bad(`у курса «${c.title}» неизвестная категория.`);
    if (!isHttpUrl(c.url)) bad(`у курса «${c.title}» некорректная ссылка.`);
    return { id: c.id, title: c.title.trim(), categoryId: c.categoryId, url: c.url };
  });
  const s = raw.survey;
  if (!s || typeof s.title !== "string" || !s.title.trim() || !isHttpUrl(s.url)) bad("настройки анкеты записаны неверно.");
  const sch = raw.schedule;
  if (!sch || !Array.isArray(sch.resources) || !Array.isArray(sch.bookings)) bad("нет раздела schedule (resources и bookings).");
  const bids = new Set();
  for (const b of sch.bookings) { if (b && bids.has(b.id)) bad(`повторяется ID бронирования «${b.id}».`); bids.add(b && b.id); }
  const rids = new Set();
  for (const r of sch.resources) { if (r && rids.has(r.id)) bad(`повторяется ID Zoom «${r.id}».`); rids.add(r && r.id); }
  const schedule = checkBackup({ resources: sch.resources, bookings: sch.bookings });
  return { schemaVersion: 1, revision: raw.revision, exportedAt: raw.exportedAt || null, categories, courses, survey: { title: s.title.trim(), url: s.url }, schedule };
}

/* =====================================================================
   Маршрутизация по hash: #/, #/schedule, #/materials[/id][?q=], #/survey, #/manage
   ===================================================================== */
function parseHash() {
  const h = window.location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  return { section: parts[0] || "home", id: parts[1] ? decodeURIComponent(parts[1]) : null, q: new URLSearchParams(qs || "").get("q") || "" };
}
function useRoute() {
  const [r, setR] = useState(parseHash);
  useEffect(() => {
    const f = () => setR(parseHash());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return r;
}
const go = (h) => { window.location.hash = h; };

/* =====================================================================
   Общие компоненты
   ===================================================================== */
function Dialog({ title, onClose, children, wide }) {
  const ref = useRef(null);
  const tid = useId();
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const first = el.querySelector("[data-autofocus]") || el.querySelector("input,select,textarea,button");
    if (first) first.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const f = [...el.querySelectorAll("a[href],button:not([disabled]),input,select,textarea")];
        if (!f.length) return;
        const a = f[0], b = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (prev && prev.focus) prev.focus(); };
  }, []); // eslint-disable-line
  return (
    <div className="tb-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="tb-dialog" role="dialog" aria-modal="true" aria-labelledby={tid} style={wide ? { maxWidth: 620 } : null}>
        <h2 id={tid} className="tb-h2">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Confirm({ title, children, confirmText, danger, onCancel, onConfirm }) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <div className="tb-body">{children}</div>
      <div className="tb-actions">
        <button type="button" className="tb-btn" onClick={onCancel} data-autofocus>Отмена</button>
        <button type="button" className={`tb-btn ${danger ? "tb-danger" : "tb-primary"}`} onClick={onConfirm}>{confirmText}</button>
      </div>
    </Dialog>
  );
}

function useToast() {
  const [t, setT] = useState(null);
  useEffect(() => { if (!t) return; const id = setTimeout(() => setT(null), 2800); return () => clearTimeout(id); }, [t]);
  return [t, setT];
}

/* QR-код: SVG из одного пути, тёмный на белом, с полем вокруг. */
function QrSvg({ url, label, size }) {
  const m = useMemo(() => { try { return qrModel(url); } catch (e) { return null; } }, [url]);
  if (!m) return <p role="alert" className="tb-err">Не удалось построить QR-код для этой ссылки (слишком длинная).</p>;
  return (
    <svg viewBox={`0 0 ${m.size} ${m.size}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges" style={{ display: "block", maxWidth: "100%", height: "auto", background: "#fff" }}>
      <rect width={m.size} height={m.size} fill="#fff" />
      <path d={m.d} fill="#000" />
    </svg>
  );
}

function QrZoom({ title, url, onClose }) {
  const closeRef = useRef(null);
  const tid = useId();
  useEffect(() => {
    const prev = document.activeElement;
    const html = document.documentElement;
    const old = html.style.overflow;
    html.style.overflow = "hidden";
    closeRef.current && closeRef.current.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "Tab") { // фокус остаётся внутри режима показа
        const f = [...document.querySelectorAll(".tb-zoom a[href],.tb-zoom button")];
        const a = f[0], b = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); html.style.overflow = old; if (prev && prev.focus) prev.focus(); };
  }, []); // eslint-disable-line
  return (
    <div className="tb-zoom" role="dialog" aria-modal="true" aria-labelledby={tid}>
      <h2 id={tid} className="tb-zoom-title">{title}</h2>
      <div className="tb-zoom-qr"><QrSvg url={url} label={`QR-код: ${title}`} size={600} /></div>
      <p className="tb-zoom-cap">Наведите камеру телефона на QR-код</p>
      <a href={url} target="_blank" rel="noopener noreferrer" className="tb-zoom-url">{url}</a>
      <button ref={closeRef} type="button" className="tb-btn tb-primary tb-zoom-close" onClick={onClose}>Закрыть</button>
    </div>
  );
}

/** Блок QR + ссылка + кнопки. Один и тот же для материалов и анкеты. */
function LinkPanel({ title, url, chatText, openLabel, onEdit, heading }) {
  const [zoom, setZoom] = useState(false);
  const [toast, setToast] = useToast();
  async function copy(text, okMsg) {
    if (await copyText(text)) setToast(okMsg);
    else window.prompt("Автоматическое копирование недоступно. Скопируйте вручную (Ctrl+C):", text);
  }
  return (
    <div className="tb-card tb-panel">
      {heading}
      <button type="button" className="tb-qrbtn" onClick={() => setZoom(true)} aria-label={`Увеличить QR-код: ${title}`}>
        <QrSvg url={url} label={`QR-код: ${title}`} size={260} />
      </button>
      <p className="tb-hint">Нажмите на QR-код, чтобы увеличить</p>
      <a className="tb-url" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
      <div className="tb-btnrow">
        <a className="tb-btn tb-primary" href={url} target="_blank" rel="noopener noreferrer">{openLabel}</a>
        <button type="button" className="tb-btn" onClick={() => copy(url, "Ссылка скопирована")}>Скопировать ссылку</button>
        <button type="button" className="tb-btn" onClick={() => copy(chatText, "Текст для чата скопирован")}>Для чата</button>
        <button type="button" className="tb-btn" onClick={onEdit}>Изменить</button>
      </div>
      <p role="status" className="tb-status">{toast || ""}</p>
      {zoom && <QrZoom title={title} url={url} onClose={() => setZoom(false)} />}
    </div>
  );
}

function Field({ label, error, children, id }) {
  return (
    <div className="tb-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && <p role="alert" className="tb-err" id={`${id}-err`}>{error}</p>}
    </div>
  );
}

/* =====================================================================
   Страницы
   ===================================================================== */
function Home({ data }) {
  const cards = [
    ["#/schedule", "Расписание Zoom", "Календарь занятий, бронирование Zoom ID, ответственные и кураторы."],
    ["#/materials", "Материалы курсов", `Каталог курсов${data ? ` (${data.courses.length})` : ""}: ссылки на материалы и QR-коды для слушателей.`],
    ["#/survey", "Опросная анкета", "Ссылка и QR-код анкеты «Оценка удовлетворенности слушателей»."],
  ];
  return (
    <div>
      <h1 className="tb-h1">Учебная платформа</h1>
      <div className="tb-home">
        {cards.map(([href, t, d]) => (
          <a key={href} href={href} className="tb-bigcard">
            <span className="tb-bigtitle">{t}</span>
            <span className="tb-bigdesc">{d}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function CourseForm({ data, course, onClose, onSave }) {
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const cats = data.categories;
  const [title, setTitle] = useState(course ? course.title : "");
  const [cat, setCat] = useState(course ? course.categoryId : cats[0] ? cats[0].id : "__new");
  const [newCat, setNewCat] = useState("");
  const [url, setUrl] = useState(course ? course.url : "");
  const [err, setErr] = useState({});
  async function submit() {
    if (busy) return;
    const e = {};
    const t = title.trim();
    if (!t) e.title = "Укажите название курса."; else if (t.length > 300) e.title = "Не длиннее 300 символов.";
    if (cat === "__new" && !newCat.trim()) e.newCat = "Укажите название категории.";
    const u = url.trim();
    if (!isHttpUrl(u)) e.url = "Введите ссылку целиком, начиная с https:// или http://, без пробелов.";
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const r = await onSave({ title: t, url: u, categoryId: cat === "__new" ? null : cat, newCategory: cat === "__new" ? newCat.trim() : null });
    if (r && r.error) { setErr({ form: r.error }); setBusy(false); }
  }
  return (
    <Dialog title={course ? "Изменить курс" : "Добавить курс"} onClose={onClose} wide>
      <div className="tb-body">
        {err.form && <p role="alert" className="tb-warn">{err.form}</p>}
        <Field id={`${ids}-t`} label="Название" error={err.title}><textarea id={`${ids}-t`} rows={2} className="tb-input" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus /></Field>
        <Field id={`${ids}-c`} label="Категория">
          <select id={`${ids}-c`} className="tb-input" value={cat} onChange={(e) => setCat(e.target.value)}>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="__new">Новая категория…</option>
          </select>
        </Field>
        {cat === "__new" && <Field id={`${ids}-n`} label="Название новой категории" error={err.newCat}><input id={`${ids}-n`} className="tb-input" value={newCat} onChange={(e) => setNewCat(e.target.value)} /></Field>}
        <Field id={`${ids}-u`} label="Ссылка на материалы" error={err.url}><input id={`${ids}-u`} className="tb-input" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={err.url ? `${ids}-u-err` : undefined} /></Field>
      </div>
      <div className="tb-actions">
        <button type="button" className="tb-btn" onClick={onClose}>Отмена</button>
        <button type="button" className="tb-btn tb-primary" onClick={submit} disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </Dialog>
  );
}

function Materials({ store, route }) {
  const data = store.current;
  const [q, setQ] = useState(route.q || "");
  const [cat, setCat] = useState("all");
  const [form, setForm] = useState(null);
  useEffect(() => { setQ(route.q || ""); }, [route.q]);
  const catName = useMemo(() => Object.fromEntries(data.categories.map((c) => [c.id, c.name])), [data]);
  const list = useMemo(() => {
    const nq = norm(q.trim());
    return data.courses.filter((c) => (cat === "all" || c.categoryId === cat) && (!nq || norm(c.title).includes(nq)));
  }, [data, q, cat]);
  const selected = route.id ? data.courses.find((c) => c.id === route.id) : null;
  const counts = useMemo(() => { const m = {}; data.courses.forEach((c) => { m[c.categoryId] = (m[c.categoryId] || 0) + 1; }); return m; }, [data]);

  async function save(v) {
    const r = await store.api.saveCourse(v, form.course);
    if (r.error) return r;
    setForm(null);
    go(`#/materials/${encodeURIComponent(r.id)}`);
    return {};
  }
  function course_id(f) { return f && f.course ? f.course.id : null; }

  const detail = selected ? (
    <LinkPanel
      title={selected.title}
      url={selected.url}
      chatText={`Материалы курса «${selected.title}»:\n${selected.url}`}
      openLabel="Открыть материалы"
      onEdit={() => setForm({ course: selected })}
      heading={<div><h2 className="tb-h2" style={{ marginTop: 0 }}>{selected.title}</h2><p className="tb-muted">{catName[selected.categoryId] || "Без категории"}</p></div>}
    />
  ) : (
    <div className="tb-card tb-empty">Выберите курс в списке, чтобы увидеть QR-код и ссылку.</div>
  );

  return (
    <div>
      <div className="tb-titlebar">
        <h1 className="tb-h1">Материалы курсов</h1>
        <button type="button" className="tb-btn tb-primary" onClick={() => setForm({ course: null })}>Добавить курс</button>
      </div>
      <div className="tb-filters">
        <input type="search" className="tb-input" placeholder="Поиск по названию" aria-label="Поиск по названию курса" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="tb-input" aria-label="Категория" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">Все категории ({data.courses.length})</option>
          {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({counts[c.id] || 0})</option>)}
        </select>
      </div>
      <p className="tb-muted" role="status">Найдено курсов: {list.length} из {data.courses.length}</p>
      <div className="tb-two">
        <ul className="tb-list" aria-label="Список курсов">
          {list.map((c) => (
            <li key={c.id}>
              <a href={`#/materials/${encodeURIComponent(c.id)}`} className={`tb-item ${selected && selected.id === c.id ? "on" : ""}`} aria-current={selected && selected.id === c.id ? "true" : undefined}>
                <span className="tb-item-t">{c.title}</span>
                <span className="tb-item-c">{catName[c.categoryId]}</span>
              </a>
            </li>
          ))}
          {!list.length && <li className="tb-empty">Ничего не найдено. Измените запрос или категорию.</li>}
        </ul>
        <div className="tb-detail">{detail}</div>
      </div>
      {form && <CourseForm data={data} course={form.course} onClose={() => setForm(null)} onSave={save} />}
    </div>
  );
}

function SurveyForm({ survey, onClose, onSave }) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(survey.title);
  const [url, setUrl] = useState(survey.url);
  const [err, setErr] = useState({});
  async function submit() {
    if (busy) return;
    const e = {};
    if (!title.trim()) e.title = "Укажите заголовок.";
    if (!isHttpUrl(url.trim())) e.url = "Введите ссылку целиком, начиная с https:// или http://, без пробелов.";
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const r = await onSave({ title: title.trim(), url: url.trim() });
    if (r && r.error) { setErr({ form: r.error }); setBusy(false); }
  }
  return (
    <Dialog title="Изменить анкету" onClose={onClose} wide>
      <div className="tb-body">
        {err.form && <p role="alert" className="tb-warn">{err.form}</p>}
        <Field id={`${ids}-t`} label="Заголовок" error={err.title}><input id={`${ids}-t`} className="tb-input" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus /></Field>
        <Field id={`${ids}-u`} label="Ссылка для заполнения анкеты" error={err.url}><input id={`${ids}-u`} className="tb-input" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
        <p className="tb-muted">Нужна ссылка для заполнения (viewform), а не ссылка редактора формы.</p>
      </div>
      <div className="tb-actions">
        <button type="button" className="tb-btn" onClick={onClose}>Отмена</button>
        <button type="button" className="tb-btn tb-primary" onClick={submit} disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </Dialog>
  );
}

function Survey({ store }) {
  const s = store.current.survey;
  const [edit, setEdit] = useState(null); // снимок анкеты на момент открытия формы
  return (
    <div>
      <h1 className="tb-h1">{s.title}</h1>
      <div style={{ maxWidth: 520 }}>
        <LinkPanel title={s.title} url={s.url} chatText={`Опросная анкета «${s.title}»:\n${s.url}`} openLabel="Открыть анкету" onEdit={() => setEdit({ ...s })} />
      </div>
      {edit && <SurveyForm survey={edit} onClose={() => setEdit(null)} onSave={async (v) => { const r = await store.api.saveSurvey(v, edit); if (!r.error) setEdit(null); return r; }} />}
    </div>
  );
}

function Manage({ store }) {
  const [dlg, setDlg] = useState(null);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const d = store.current;
  const counts = (x) => `курсов: ${x.courses.length}, категорий: ${x.categories.length}, бронирований: ${x.schedule.bookings.length}, Zoom ID: ${x.schedule.resources.length}`;
  async function download() {
    setMsg(null);
    try { downloadJson(await store.api.backup(), "catalog.json"); setMsg({ ok: true, text: "Резервная копия скачана: данные только что прочитаны с сервера." }); }
    catch (e) { setMsg({ ok: false, text: `Копия не создана: ${e.offline ? "нет связи с сервером" : e.message}. Файл не скачан; данные из памяти страницы за серверную копию не выдаются.` }); }
  }
  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = validateCatalog(JSON.parse(await f.text()));
      const snapshot = await store.api.snapshot(); // свежий снимок сервера
      setDlg({ kind: "import", data, snapshot, name: f.name });
    } catch (err) { setDlg({ kind: "bad", reason: err instanceof SyntaxError ? "файл повреждён или это не JSON." : err.offline ? "нет связи с сервером, данные не изменены." : err.message }); }
  }
  async function doImport() {
    setDlg((x) => ({ ...x, busy: true, error: null }));
    try { await store.api.importData(dlg.data, true, dlg.snapshot); setDlg(null); setMsg({ ok: true, text: "Файл загружен: изменения применены целиком и видны всем сотрудникам." }); }
    catch (e) { setDlg((x) => ({ ...x, busy: false, error: e.offline ? "Нет связи с сервером: подтверждение импорта не получено. Импорт мог завершиться. Обновите данные перед повторной загрузкой файла." : e.message })); }
  }
  return (
    <div style={{ maxWidth: 780 }}>
      <h1 className="tb-h1">Управление</h1>
      <div className="tb-card tb-body">
        <p style={{ marginTop: 0 }}><strong>Общее хранилище.</strong> Расписание, курсы, категории и анкета хранятся в Supabase и сразу видны всем сотрудникам. Входа нет; публиковать файлы в GitHub после правок не нужно.</p>
        <dl className="tb-dl">
          <dt>Связь с сервером</dt><dd>{store.pollErr ? store.pollErr : "есть"}</dd>
          <dt>Автообновление</dt><dd>{store.live ? "Realtime подключён" : "Realtime недоступен — обновление раз в 15 секунд"}</dd>
          <dt>Последнее обновление</dt><dd>{store.lastOk ? store.lastOk.toLocaleTimeString("ru-RU") : "—"}</dd>
          <dt>Данные на сервере</dt><dd>{counts(d)}</dd>
        </dl>
        <div className="tb-btnrow">
          <button type="button" className="tb-btn tb-primary" onClick={download}>Скачать резервную копию</button>
          <button type="button" className="tb-btn" onClick={() => fileRef.current.click()}>Загрузить копию</button>
          <button type="button" className="tb-btn" onClick={store.reload}>Обновить с сервера</button>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: "none" }} aria-label="Файл catalog.json" />
        {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "tb-ok" : "tb-warn"}>{msg.text}</p>}
        <p className="tb-muted">В копию попадают все курсы, категории, анкета и всё расписание с сервера. Старую копию расписания загружают в разделе «Расписание Zoom» (внизу): она затрагивает только расписание.</p>
        {store.legacy && (
          <div className="tb-warn" role="alert">
            <p style={{ marginTop: 0 }}>На этом устройстве найден старый локальный черновик. Он не подставляется в общие данные автоматически.</p>
            <div className="tb-btnrow">
              <button type="button" className="tb-btn" onClick={() => { try { downloadJson(JSON.parse(store.legacy), "local-draft.json"); } catch (e) { downloadJson({ raw: store.legacy }, "local-draft.json"); } }}>Скачать черновик</button>
              <button type="button" className="tb-btn tb-danger" onClick={() => setDlg({ kind: "dropLegacy" })}>Удалить черновик</button>
            </div>
          </div>
        )}
      </div>
      {dlg && dlg.kind === "import" && (
        <Confirm title="Изменить общие данные?" confirmText={dlg.busy ? "Загружаем…" : "Загрузить для всех"} danger onCancel={() => setDlg(null)} onConfirm={() => !dlg.busy && doImport()}>
          <p>Файл «{dlg.name}» изменит данные <strong>у всех сотрудников</strong>: записи из файла будут добавлены или заменят записи с теми же ID (всё или ничего). Если после этого окна кто-то изменит те же записи, импорт будет отклонён. Записи, которых в файле нет, останутся.</p>
          <p className="tb-muted">На сервере сейчас: {counts(dlg.snapshot)}.<br />В файле: {counts(dlg.data)}.</p>
          {dlg.error && <p role="alert" className="tb-err">{dlg.error}</p>}
        </Confirm>
      )}
      {dlg && dlg.kind === "bad" && (
        <Dialog title="Файл не подошёл" onClose={() => setDlg(null)}>
          <p className="tb-body">Не удалось загрузить: {dlg.reason} Данные не изменены.</p>
          <div className="tb-actions"><button type="button" className="tb-btn tb-primary" data-autofocus onClick={() => setDlg(null)}>Понятно</button></div>
        </Dialog>
      )}
      {dlg && dlg.kind === "dropLegacy" && (
        <Confirm title="Удалить локальный черновик?" confirmText="Удалить" danger onCancel={() => setDlg(null)} onConfirm={() => { store.dropLegacy(); setDlg(null); }}>
          <p>Черновик будет удалён из этого браузера. Если он нужен, сначала скачайте его.</p>
        </Confirm>
      )}
    </div>
  );
}

function Schedule({ store }) {
  const d = store.current;
  return (
    <div className="tb-sched">
      <ZoomSchedule
        schedule={d.schedule}
        courses={d.courses}
        api={store.api}
        onOpenCourse={(id) => go(`#/materials/${encodeURIComponent(id)}`)}
        onFindCourse={(t) => go(`#/materials?q=${encodeURIComponent(t)}`)}
        storageNote="Расписание общее: изменения сохраняются на сервере и сразу видны всем сотрудникам."
      />
    </div>
  );
}

function StatusBar({ store }) {
  const s = store.status;
  return (
    <p className="tb-muted" role="status" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", margin: "0 0 8px", fontSize: 13 }}>
      <span className={s && s.k === "bad" ? "tb-err" : s && s.k === "ok" ? "tb-ok" : ""}>{s ? s.t : store.live ? "Общее хранилище подключено" : ""}</span>
      <span>{store.lastOk ? `Обновлено ${store.lastOk.toLocaleTimeString("ru-RU")}` : ""}</span>
      <button type="button" className="tb-link" onClick={store.reload}>Обновить</button>
    </p>
  );
}

function App() {
  const store = useStore();
  const route = useRoute();
  useEffect(() => {
    const t = { home: "Учебная платформа", schedule: "Расписание Zoom", materials: "Материалы курсов", survey: "Опросная анкета", manage: "Управление" };
    document.title = `${t[route.section] || t.home} — Учебная платформа`;
  }, [route.section]);
  const links = [["home", "#/", "Главная"], ["schedule", "#/schedule", "Расписание Zoom"], ["materials", "#/materials", "Материалы курсов"], ["survey", "#/survey", "Опросная анкета"], ["manage", "#/manage", "Управление"]];
  const cur = store.current;
  let page;
  if (!cur) page = store.loadError ? (
    <div className="tb-card tb-body" role="alert">
      <h2 className="tb-h2" style={{ marginTop: 0 }}>Данные не загружены</h2>
      <p>{store.loadError}. Это не значит, что курсов или занятий нет: проверьте связь и повторите.</p>
      <button type="button" className="tb-btn tb-primary" onClick={store.reload}>Повторить</button>
    </div>
  ) : <div className="tb-card tb-empty">Загружаем данные…</div>;
  else if (route.section === "schedule") page = <Schedule store={store} />;
  else if (route.section === "materials") page = <Materials store={store} route={route} />;
  else if (route.section === "survey") page = <Survey store={store} />;
  else if (route.section === "manage") page = <Manage store={store} />;
  else page = <Home data={cur} />;
  return (
    <>
      <header className="tb-nav">
        <nav aria-label="Разделы" className="tb-navin">
          {links.map(([k, h, t]) => <a key={k} href={h} className={(route.section === k || (k === "home" && !links.some((l) => l[0] === route.section))) ? "on" : ""} aria-current={route.section === k ? "page" : undefined}>{t}</a>)}
          {store.legacy && <a href="#/manage" className="tb-badge">Есть старый локальный черновик</a>}
        </nav>
      </header>
      <main className="tb-main">
        {cur && <StatusBar store={store} />}
        {page}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function fmtDate(date, opts = { weekday: "short", month: "short", day: "numeric" }) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

// "19:00" -> "7pm", "19:30" -> "7:30pm"
export function fmtTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 && h < 24 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${suffix}`;
}

export const fmtRange = (start, end) => `${fmtTime(start)} – ${fmtTime(end)}`;

export function fmtDuration(min) {
  return min % 60 ? `${(min / 60).toFixed(1)} hours` : `${min / 60} hour${min === 60 ? "" : "s"}`;
}

export const LEVEL_LABEL = { preferred: "Preferred", available: "Available", if_needed: "If needed" };

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  logo: svg('<path d="M8 3v3M16 3v3"/><rect x="3" y="5" width="18" height="16" rx="4"/><path d="M8 14.5l2.5 2.5L16 11.5"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  hourglass: svg('<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  send: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="3"/><path d="M5 15V6a3 3 0 0 1 3-3h7"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'),
  trophy: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  alert: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  message: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
};

const AVATAR_COLORS = ["#6b5bd6", "#2f8a68", "#d0573a", "#b07613", "#2f73b8", "#a2427a", "#4f7d2a", "#7a5a3a"];
export function avatar(name, cls = "") {
  const n = String(name || "?").trim();
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const initial = [...n][0]?.toUpperCase() || "?";
  return `<span class="avatar ${cls}" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}" title="${esc(n)}">${esc(initial)}</span>`;
}

export function topbar(extra = "") {
  return `<div class="topbar">
    <a class="brand" href="/"><span class="brand-mark">${icons.logo}</span>Gather</a>
    ${extra}
  </div>`;
}

export async function showDemoBanner(el) {
  const status = await api("/api/status").catch(() => null);
  if (status?.demoMode) {
    el.innerHTML = `<div class="banner">${icons.info}<div><b>Demo mode.</b> No <code>OPENAI_API_KEY</code> in <code>.env</code>, so replies are read by a simple rule-based parser instead of AI.</div></div>`;
  }
}

let toastEl;
export function toast(message) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

export function copyButton(button, getText, message = "Copied to clipboard") {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      toast(message);
    } catch {
      toast("Couldn't copy. Select the text and copy it manually.");
    }
  });
}


export const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

export function eventDates(event) {
  const out = []; const d = new Date(`${event.dateStart}T00:00:00Z`); const last = new Date(`${event.dateEnd}T00:00:00Z`);
  while (d <= last) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export function metaHtml(event) {
  return [
    [icons.calendar, `${fmtDate(event.dateStart)} – ${fmtDate(event.dateEnd)}`],
    [icons.clock, fmtRange(event.dayStart, event.dayEnd)],
    [icons.hourglass, fmtDuration(event.durationMinutes)],
    [icons.globe, event.timeZone.replace(/_/g, " ")],
  ].map(([ic, t]) => `<span class="meta">${ic}${esc(t)}</span>`).join("");
}

// Day-by-day bars of when someone can come, inside the event's daily window.
export function timelineHtml(event, availability) {
  const winStart = toMin(event.dayStart), span = toMin(event.dayEnd) - winStart;
  const byDate = {};
  for (const b of availability) (byDate[b.date] ||= []).push(b);
  return eventDates(event).map((d) => {
    const segs = (byDate[d] || []).map((b) => {
      const left = ((toMin(b.start) - winStart) / span) * 100;
      const width = ((toMin(b.end) - toMin(b.start)) / span) * 100;
      return `<div class="seg ${b.level}" style="left:${left}%;width:${width}%" title="${esc(LEVEL_LABEL[b.level])}: ${esc(fmtRange(b.start, b.end))}">${esc(fmtRange(b.start, b.end))}</div>`;
    }).join("");
    return `<div class="day">${esc(fmtDate(d, { weekday: "short" }))}<span>${esc(fmtDate(d, { month: "short", day: "numeric" }))}</span></div><div class="track">${segs}</div>`;
  }).join("") + `<div class="axis"><span>${fmtTime(event.dayStart)}</span><span>${fmtTime(event.dayEnd)}</span></div>`;
}

export const legendHtml = `<div class="legend"><span><i class="l-preferred"></i>Preferred</span><span><i class="l-available"></i>Available</span><span><i class="l-if_needed"></i>If needed</span></div>`;

// Must-respect items, preferences and notes from a parsed reply.
export function extrasHtml(parsed) {
  const parts = [];
  if (parsed.hard_constraints.length)
    parts.push(`<div class="confirm-section"><h3>Must respect</h3><div class="chips">${parsed.hard_constraints.map((h) => `<span class="chip static red">${icons.alert.replace("<svg", '<svg width="14" height="14"')}${esc(h)}</span>`).join("")}</div></div>`);
  if (parsed.preferences.length)
    parts.push(`<div class="confirm-section"><h3>Preferences</h3><div class="chips">${parsed.preferences.map((p) => `<span class="chip static violet">${esc(p.value)} <span class="strength">· ${esc(p.topic)}${p.strength === "strong" ? " · strong" : ""}</span></span>`).join("")}</div></div>`);
  if (parsed.notes)
    parts.push(`<div class="confirm-section"><h3>Notes</h3><p style="margin:0">${esc(parsed.notes)}</p></div>`);
  if (!parsed.availability.length)
    parts.unshift(`<div class="banner" style="margin-top:16px">${icons.info}<div>No times inside the event window yet. You can still submit, or tell me more.</div></div>`);
  return parts.join("");
}

// The organizer's final pick, shown to everyone once the event is decided.
export function decidedHtml(event) {
  const d = event.decided;
  return `<div class="card decided-card">
    <span class="eyebrow">${icons.check} Decided</span>
    <h2>${esc(d.title)}</h2>
    <div class="when">${icons.calendar}${esc(`${fmtDate(d.slot.date, { weekday: "long", month: "short", day: "numeric" })} · ${fmtRange(d.slot.start, d.slot.end)}`)}</div>
    ${d.details ? `<p>${esc(d.details)}</p>` : ""}
    <p class="small muted" style="margin:0">Replies are closed. See you there!</p>
  </div>`;
}

// ----- events this device has replied to -----
// Each reply stores its private token under gather-token-<eventId> in this browser, so
// one device can remember many events without an account. My Gather (/me) lists them.
const TOKEN_PREFIX = "gather-token-";

export function myEvents() {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(TOKEN_PREFIX) && localStorage.getItem(k))
      .map((k) => ({ eventId: k.slice(TOKEN_PREFIX.length), token: localStorage.getItem(k) }));
  } catch {
    return [];
  }
}

export function forgetEvent(eventId) {
  try { localStorage.removeItem(TOKEN_PREFIX + eventId); } catch {}
}

// Top-bar link to My Gather, shown once this device has replied to something.
export function myGatherLink() {
  const n = myEvents().length;
  return n ? `<a class="my-gather" href="/me">${icons.users.replace("<svg", '<svg width="16" height="16"')}My Gather <span>${n}</span></a>` : "";
}

// ----- editable timeline -----
// Lets people paint their availability on the day bars in 30-minute steps: pick a brush
// (Preferred / Available / If needed / Clear), then tap or drag across the bars.
// mountAvailabilityEditor(el, event, availability, onChange) draws it into el and calls
// onChange(newAvailability) after every stroke. Returns { get() }.
const STEP = 30;
const BRUSHES = [
  ["preferred", "Preferred"],
  ["available", "Available"],
  ["if_needed", "If needed"],
  [null, "Clear"],
];

function slotsOf(event) {
  const start = toMin(event.dayStart), end = toMin(event.dayEnd);
  const n = Math.ceil((end - start) / STEP);
  return { start, end, n };
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// blocks -> { date: [level | null per 30-minute cell] }
function toCells(event, availability) {
  const { start, end, n } = slotsOf(event);
  const cells = Object.fromEntries(eventDates(event).map((d) => [d, Array(n).fill(null)]));
  const rank = { if_needed: 1, available: 2, preferred: 3 };
  for (const b of availability) {
    if (!cells[b.date]) continue;
    for (let i = 0; i < n; i++) {
      const mid = start + i * STEP + Math.min(STEP, end - start - i * STEP) / 2;
      const cur = cells[b.date][i];
      if (toMin(b.start) <= mid && mid < toMin(b.end) && (!cur || rank[b.level] > rank[cur])) cells[b.date][i] = b.level;
    }
  }
  return cells;
}

// cells -> blocks, merging neighbouring cells with the same level
function toBlocks(event, cells) {
  const { start, end } = slotsOf(event);
  const out = [];
  for (const [date, row] of Object.entries(cells)) {
    let i = 0;
    while (i < row.length) {
      if (!row[i]) { i++; continue; }
      let j = i;
      while (j < row.length && row[j] === row[i]) j++;
      out.push({ date, start: hhmm(start + i * STEP), end: hhmm(Math.min(end, start + j * STEP)), level: row[i] });
      i = j;
    }
  }
  return out;
}

export function mountAvailabilityEditor(el, event, availability, onChange = () => {}) {
  const { n } = slotsOf(event);
  const cells = toCells(event, availability);
  let brush = "available";
  let painting = false;

  el.innerHTML = `
    <div class="brushes" role="radiogroup" aria-label="What to paint">
      ${BRUSHES.map(([level, label]) => `<button type="button" class="brush ${level || "clear"}" data-level="${level || ""}" role="radio" aria-checked="${level === brush}"><i></i>${label}</button>`).join("")}
    </div>
    <p class="small muted" style="margin:8px 0 12px">Pick one, then tap or drag across the bars. Each step is 30 minutes.</p>
    <div class="timeline editing">${eventDates(event).map((d) => `
      <div class="day">${esc(fmtDate(d, { weekday: "short" }))}<span>${esc(fmtDate(d, { month: "short", day: "numeric" }))}</span></div>
      <div class="track editable" data-date="${d}" style="--n:${n}">
        <div class="segs"></div>
        <div class="cells">${Array.from({ length: n }, (_, i) => `<span data-i="${i}"></span>`).join("")}</div>
      </div>`).join("")}
      <div class="axis"><span>${fmtTime(event.dayStart)}</span><span>${fmtTime(event.dayEnd)}</span></div>
    </div>`;

  const drawRow = (date) => {
    const track = el.querySelector(`.track[data-date="${date}"]`);
    const blocks = toBlocks(event, { [date]: cells[date] });
    const { start, end } = slotsOf(event);
    track.querySelector(".segs").innerHTML = blocks.map((b) => {
      const left = ((toMin(b.start) - start) / (end - start)) * 100;
      const width = ((toMin(b.end) - toMin(b.start)) / (end - start)) * 100;
      return `<div class="seg ${b.level}" style="left:${left}%;width:${width}%">${esc(fmtRange(b.start, b.end))}</div>`;
    }).join("");
  };
  Object.keys(cells).forEach(drawRow);

  el.querySelector(".brushes").addEventListener("click", (e) => {
    const b = e.target.closest(".brush");
    if (!b) return;
    brush = b.dataset.level || null;
    el.querySelectorAll(".brush").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  });

  // A fast drag skips cells between pointer events, so fill in everything between the
  // last cell painted and this one when they're on the same day.
  let last = null;
  const paintAt = (x, y) => {
    const cell = document.elementFromPoint(x, y)?.closest(".cells > span");
    const track = cell?.closest(".track.editable");
    if (!cell || !el.contains(track)) return;
    const date = track.dataset.date, i = Number(cell.dataset.i);
    const from = last?.date === date ? Math.min(last.i, i) : i;
    const to = last?.date === date ? Math.max(last.i, i) : i;
    for (let k = from; k <= to; k++) cells[date][k] = brush;
    last = { date, i };
    drawRow(date);
  };
  const grid = el.querySelector(".timeline");
  const move = (e) => paintAt(e.clientX, e.clientY);
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    if (!painting) return;
    painting = false;
    last = null;
    onChange(toBlocks(event, cells));
  };
  grid.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".cells > span")) return;
    e.preventDefault();
    stop(); // finish any stroke whose release we never saw
    painting = true;
    paintAt(e.clientX, e.clientY);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });

  return { get: () => toBlocks(event, cells) };
}

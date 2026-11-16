// Slack bot: /gather opens a form, the bot posts the event in the channel, people
// reply in the thread (or privately in a DM) in their own words, and the organizer gets
// a plan with one click. Gather can also DM people who can't make the top pick to see
// if they could adjust. The handlers here are runtime-agnostic: lib/slack-socket.js runs them
// with Bolt in Socket Mode (npm start), lib/slack-http.js runs them on Cloudflare over HTTP.
import * as store from "./store.js";
import { newId } from "./store.js";
import { parseReply, recommend, routeDm, negotiationQuestion, reviseDraft } from "./llm.js";
import { normalizeEventFields } from "./events.js";
import { simulateReplies } from "./simulate.js";
import { negotiationKey, negotiationCandidates, askTestParticipant } from "./negotiate.js";
import { missingScopes } from "./slack-http.js";
import { rankSlots } from "./schedule.js";

const ASK_OPTIONS = ["Food preferences", "Budget", "Dietary restrictions", "Drinks", "Location", "Activity ideas"];
const DURATIONS = [[30, "30 min"], [60, "1 hour"], [90, "1.5 hours"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"]];
const LEVEL = { preferred: "preferred", available: "available", if_needed: "if needed" };
const MEDALS = ["🥇", "🥈", "🥉"];

// ---------- formatting ----------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtDate = (d, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
function fmtTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h >= 12 && h < 24 ? "pm" : "am"}`;
}
const fmtRange = (a, b) => `${fmtTime(a)}–${fmtTime(b)}`;
const fmtDuration = (min) => (min % 60 ? `${min / 60} hours` : `${min / 60} hour${min === 60 ? "" : "s"}`);
// "🗓 Fri, Nov 20   🕔 Sometime between 8pm–11pm   ⏳ Lasts 2 hours": the window is when the
// event *could* happen; the length is how long it runs. Labels keep the two from being confused.
export function whenLine(f) {
  const dates = f.dateStart === f.dateEnd ? fmtDate(f.dateStart) : `${fmtDate(f.dateStart)} – ${fmtDate(f.dateEnd)}`;
  return `🗓 ${dates}   🕔 Sometime between ${fmtRange(f.dayStart, f.dayEnd)}   ⏳ Lasts ${fmtDuration(f.durationMinutes)}`;
}
const when = (slot) => `${fmtDate(slot.date)} · ${fmtRange(slot.start, slot.end)}`;
const isoDate = (offsetDays, from = new Date()) => new Date(from.getTime() + offsetDays * 86400000).toISOString().slice(0, 10);

const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: clip(text, 2900) } });
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text: clip(text, 2900) }] });
const option = (value, text) => ({ text: { type: "plain_text", text }, value: String(value) });
const button = (action_id, value, text, style) => ({ type: "button", action_id, value: String(value), text: { type: "plain_text", text }, ...(style ? { style } : {}) });

// ---------- views & messages ----------
export function createEventModal({ channel, title = "", prefill = {}, draftId = null }) {
  const p = { title, ...prefill };
  const input = (block_id, label, element, optional = false) => ({ type: "input", block_id, optional, label: { type: "plain_text", text: label }, element });
  const asks = (p.askAbout ? p.askAbout.split(/,\s*/) : ASK_OPTIONS.slice(0, 3)).filter((a) => ASK_OPTIONS.includes(a));
  const duration = DURATIONS.find(([v]) => v === p.durationMinutes) || DURATIONS[3];
  return {
    type: "modal",
    callback_id: "gather_create",
    private_metadata: JSON.stringify({ channel, ...(draftId ? { draftId } : {}) }),
    title: { type: "plain_text", text: "Plan a get-together" },
    submit: { type: "plain_text", text: "Post to channel" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      ...(channel ? [] : [input("channel", "Post in", { type: "conversations_select", action_id: "v", filter: { include: ["public", "private"], exclude_bot_users: true } })]),
      input("title", "What's the occasion?", { type: "plain_text_input", action_id: "v", max_length: 120, ...(p.title?.trim() ? { initial_value: p.title.trim().slice(0, 120) } : {}), placeholder: { type: "plain_text", text: "Lab happy hour" } }),
      input("description", "Details", { type: "plain_text_input", action_id: "v", multiline: true, max_length: 1000, ...(p.description?.trim() ? { initial_value: p.description.trim() } : {}), placeholder: { type: "plain_text", text: "End-of-semester drinks + food near campus" } }, true),
      input("askAbout", "Besides time, ask people about", {
        type: "multi_static_select", action_id: "v",
        options: ASK_OPTIONS.map((a) => option(a, a)),
        ...(asks.length ? { initial_options: asks.map((a) => option(a, a)) } : {}),
      }, true),
      input("dateStart", "Earliest date", { type: "datepicker", action_id: "v", initial_date: p.dateStart || isoDate(1) }),
      input("dateEnd", "Latest date", { type: "datepicker", action_id: "v", initial_date: p.dateEnd || isoDate(7) }),
      input("dayStart", "It could happen any time between…", { type: "timepicker", action_id: "v", initial_time: p.dayStart || "17:00" }),
      input("dayEnd", "…and", { type: "timepicker", action_id: "v", initial_time: p.dayEnd || "23:00" }),
      input("durationMinutes", "How long will it last?", {
        type: "static_select", action_id: "v",
        options: DURATIONS.map(([v, l]) => option(v, l)),
        initial_option: option(duration[0], duration[1]),
      }),
    ],
  };
}

// Pull plain values out of a submitted modal.
export function readModal(values) {
  const v = (id) => values[id]?.v ?? {};
  return {
    title: v("title").value || "",
    description: v("description").value || "",
    askAbout: (v("askAbout").selected_options || []).map((o) => o.value).join(", "),
    dateStart: v("dateStart").selected_date || "",
    dateEnd: v("dateEnd").selected_date || "",
    dayStart: v("dayStart").selected_time || "",
    dayEnd: v("dayEnd").selected_time || "",
    durationMinutes: Number(v("durationMinutes").selected_option?.value),
  };
}

// An event stops collecting replies once it's decided or cancelled.
export const isClosed = (event) => Boolean(event.slack?.decided || event.slack?.cancelled);

// Does a plain channel message look like someone answering "when are you free?" Used only to
// offer (privately, to its author) to count it; nothing is saved unless they confirm.
export function looksLikeReply(text) {
  // A weekday, a clock time, or Chinese time/availability words are enough on their own.
  const strong = /\b(mon|tues?|wed|thur?s?|fri|sat|sun)(day)?\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|周[一二三四五六日天末]|星期|礼拜|\d+\s*点|有空|没空|有时间|没时间|来不了|能来/i;
  // "today", "evening"… only count next to an availability word ("Nice slides today" doesn't).
  const soft = /\b(today|tomorrow|tonight|weekend|morning|afternoon|evening|night)\b|今天|明天|后天|上午|下午|中午|晚上/i;
  const availability = /\b(free|available|busy|works?|can|can't|cannot|could|ok|okay|fine|good|count me in|i'm in)\b|可以|不行|行|都行/i;
  return strong.test(text) || (soft.test(text) && availability.test(text));
}

// "Add to calendar" links for a decided slot, in the event's own time zone.
function tzOffset(date, time, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T${time}:00Z`)).find((p) => p.type === "timeZoneName")?.value || "GMT";
  return name === "GMT" ? "+00:00" : name.slice(3);
}
export function calendarLinks(event, slot, details = "") {
  const tz = event.timeZone || "America/New_York";
  const compact = (t) => `${slot.date.replace(/-/g, "")}T${t.replace(":", "")}00`;
  const google = new URL("https://calendar.google.com/calendar/render");
  google.search = new URLSearchParams({ action: "TEMPLATE", text: event.title, dates: `${compact(slot.start)}/${compact(slot.end)}`, ctz: tz, details }).toString();
  const outlook = new URL("https://outlook.office.com/calendar/0/deeplink/compose");
  outlook.search = new URLSearchParams({
    subject: event.title, body: details,
    startdt: `${slot.date}T${slot.start}:00${tzOffset(slot.date, slot.start, tz)}`,
    enddt: `${slot.date}T${slot.end}:00${tzOffset(slot.date, slot.end, tz)}`,
  }).toString();
  return { google: google.toString(), outlook: outlook.toString() };
}

export function eventMessage(event) {
  const s = event.slack;
  const replied = event.responses;
  const asks = event.askAbout ? ` and what you think about *${esc(event.askAbout.toLowerCase())}*` : "";
  const blocks = [
    section(`*📅 ${esc(event.title)}*${event.description ? `\n${esc(event.description)}` : ""}`),
    context(`${whenLine(event)}   👤 Organized by <@${s.organizer}>`),
  ];
  if (s.decided) {
    blocks.push(section(`✅ *Decided: ${when(s.decided)}*`));
  } else if (s.cancelled) {
    blocks.push(section("🚫 *Cancelled by the organizer.*"));
  } else {
    blocks.push(section(`*Reply in this thread* 👇 with when you're free${asks}. Write it like a normal message, e.g. _"Thu or Fri evening, Thu only after 7. Sushi please, allergic to peanuts."_ You can also mention @Gather in the channel, or DM me to keep it private.`));
  }
  blocks.push(context(replied.length ? `✅ ${replied.length} replied: ${replied.map((r) => (r.slackUserId ? `<@${r.slackUserId}>` : esc(r.name))).join(" ")}` : "No replies yet"));
  if (!isClosed(event)) {
    blocks.push({
      type: "actions",
      elements: [
        button("gather_plan", event.id, "✨ Generate plan", "primary"),
        // Organizer tools, tucked into a ⋯ menu.
        { type: "overflow", action_id: "gather_more", options: [
          option(`remind:${event.id}`, "🔔 Remind who hasn't replied"),
          option(`simulate:${event.id}`, "🧪 Add 5 test replies"),
          option(`cancel:${event.id}`, "🚫 Cancel this event"),
        ] },
      ],
    });
  }
  return { text: `📅 ${event.title}: reply in the thread with when you're free`, blocks };
}

export function confirmationMessage(parsed, { footer = "Not right? Just reply in the thread again and I'll update it. Only you can see this.", title } = {}) {
  const byDate = {};
  for (const b of parsed.availability) (byDate[b.date] ||= []).push(b);
  const lines = Object.keys(byDate).sort().map((d) =>
    `• *${fmtDate(d)}*: ${byDate[d].sort((a, b) => a.start.localeCompare(b.start)).map((b) => `${fmtRange(b.start, b.end)}${b.level === "available" ? "" : ` _(${LEVEL[b.level]})_`}`).join(", ")}`);
  const blocks = [
    section(`*Got it${title ? ` for ${esc(title)}` : ""}! Here's what I understood:*\n>${esc(parsed.summary)}`),
    section(`*🕐 When you can come*\n${lines.length ? lines.join("\n") : "_No times inside the event window._"}`),
  ];
  if (parsed.hard_constraints.length) blocks.push(section(`*⚠️ Must respect:* ${parsed.hard_constraints.map(esc).join("; ")}`));
  if (parsed.preferences.length) blocks.push(section(`*💬 Preferences:* ${parsed.preferences.map((p) => `${esc(p.value)} _(${esc(p.topic)})_`).join(", ")}`));
  if (parsed.notes) blocks.push(section(`*📝 Notes:* ${esc(parsed.notes)}`));
  blocks.push(context(footer));
  return { text: `Got it: ${parsed.summary}`, blocks };
}

export function planMessage(event, rec) {
  const total = event.responses.length;
  const blocks = [section(`*✨ Plan for ${esc(event.title)}* (from ${total} ${total === 1 ? "reply" : "replies"})\n${esc(rec.group_summary)}`)];
  if (rec.must_respect.length) blocks.push(section(`*⚠️ Must respect:* ${rec.must_respect.map(esc).join(" · ")}`));
  rec.proposals.forEach((p, i) => {
    const slot = p.slot;
    blocks.push({ type: "divider" });
    blocks.push(section([
      `${MEDALS[i] || "•"} *${esc(p.title)}*`,
      `*${when(slot)}*  ·  ${slot.attendees.length}/${total} can come${slot.missing.length ? ` (not: ${slot.missing.map(esc).join(", ")})` : " 🎉"}`,
      `_Why:_ ${esc(p.why)}`,
      `_Trade-offs:_ ${esc(p.tradeoffs)}`,
      `_Details:_ ${esc(p.details)}`,
    ].join("\n")));
  });
  const elements = rec.proposals.map((p, i) =>
    button(`gather_announce_${i}`, `${event.id}:${i}`, `📣 Announce ${i === 0 ? "top pick" : `option ${i + 1}`}`, i === 0 ? "primary" : undefined));
  const askable = rec.proposals[0] ? negotiationCandidates(event, rec.proposals[0].slot) : [];
  if (askable.length) elements.push(button("gather_negotiate", event.id, `🤝 Ask ${askable.length === 1 ? "the 1 person" : `the ${askable.length} people`} who can't make it`));
  blocks.push({ type: "actions", elements });
  blocks.push(context(`Only <@${event.slack.organizer}> can use these buttons. *Announce* posts the decision to the channel. *Ask* DMs people who can't make the top pick to see if they could adjust.`));
  return { text: `Plan for ${event.title}`, blocks };
}

function helpMessage() {
  return [
    "*Hi, I'm Gather* 👋 I help groups find a time that works. Here's what you can do with me here:",
    "• *Reply to an event privately*: just tell me when you're free, e.g. _\"Thursday after 7 works, I'm vegetarian\"_. Handy for things you'd rather not post in the channel.",
    "• *Set up a new event*: e.g. _\"Plan a happy hour next week in #social, evenings, about 2 hours\"_.",
    "• *Ask about your events*: e.g. _\"What did I say for the happy hour?\"_ or _\"Who has replied?\"_",
    "• *Tell me how you like things*: e.g. _\"reply to me in Chinese, but post events in English\"_. I'll remember it for you. Ask _\"what do you remember about me?\"_ or say _\"forget my preferences\"_ anytime.",
    "In a channel, type `/gather` to open the full form.",
  ].join("\n");
}

// A Map-like view over persisted bot state (store.getState / setState). Entries older than
// maxAgeDays are dropped when something new is written.
function persistedMap(name, maxAgeDays = 2) {
  const all = () => store.getState(name) || {};
  const fresh = (entries) => Object.fromEntries(Object.entries(entries).filter(([, v]) => Date.now() - (v?.savedAt || 0) < maxAgeDays * 86400000));
  return {
    get: (key) => all()[key]?.value,
    has: (key) => key in all(),
    set: (key, value) => store.setState(name, { ...fresh(all()), [key]: { value, savedAt: Date.now() } }),
    delete: (key) => {
      const { [key]: _gone, ...rest } = all();
      store.setState(name, rest);
    },
  };
}

// ---------- handlers ----------
export function registerSlackHandlers(app, { dashboardUrl = () => null } = {}) {
  // Process one person's messages in order so a quick follow-up doesn't race the first parse.
  const queues = new Map();
  const serialize = (key, fn) => {
    const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
    queues.set(key, next.catch(() => {}));
    return next;
  };
  // DM state: a reply waiting for "which event?", and unposted drafts. Kept in storage, not
  // memory: on Cloudflare the workspace's object can be unloaded between two messages.
  const pendingPick = persistedMap("pendingPick");
  const drafts = persistedMap("drafts");
  // user -> draft whose preview is waiting for a decision; their DMs count as feedback on it.
  const activeDraft = persistedMap("activeDraft");
  const DRAFT_FEEDBACK_MINUTES = 30;

  // Merge newly stated preferences into what we know about this person. Returns a short
  // description of what changed, or "" if nothing did.
  function rememberPrefs(user, remember) {
    if (!remember) return "";
    const prefs = { ...store.getUserPrefs(user) };
    const zh = (prefs.replyLanguage || remember.reply_language) === "Chinese";
    const changes = [];
    if (remember.reply_language && remember.reply_language !== prefs.replyLanguage) {
      prefs.replyLanguage = remember.reply_language;
      changes.push(zh ? `回复你用${langName(remember.reply_language, true)}` : `reply to you in ${remember.reply_language}`);
    }
    if (remember.post_language && remember.post_language !== prefs.postLanguage) {
      prefs.postLanguage = remember.post_language;
      changes.push(zh ? `发布的活动用${langName(remember.post_language, true)}` : `write events I post for you in ${remember.post_language}`);
    }
    if (remember.usual_channel_id && remember.usual_channel_id !== prefs.usualChannelId) {
      prefs.usualChannelId = remember.usual_channel_id;
      changes.push(zh ? `默认发到 <#${remember.usual_channel_id}>` : `post in <#${remember.usual_channel_id}> by default`);
    }
    const notes = new Set(prefs.notes || []);
    for (const n of remember.notes || []) if (n && !notes.has(n)) { notes.add(n); changes.push(n); }
    prefs.notes = [...notes].slice(-10);
    if (!changes.length) return "";
    store.setUserPrefs(user, prefs);
    return zh ? `📝 我记住了：${changes.join("；")}。（说"你记住了我什么"可以查看，说"忘掉我的偏好"可以清除）` : `📝 I'll remember that: ${changes.join("; ")}. (Ask "what do you remember about me?" to check, or say "forget my preferences".)`;
  }
  const langName = (l, zh) => (zh ? { English: "英文", Chinese: "中文", Japanese: "日文", Korean: "韩文" }[l] || l : l);

  // Slack doesn't push new permissions to workspaces that already installed Gather. When a
  // feature needs one this workspace hasn't approved (or newer ones exist), point the person
  // at a one-click update instead of failing. slackCtx.scopes is unknown (undefined) for the
  // local Socket Mode bot, which is treated as having everything.
  function updateNote(slackCtx, needed) {
    if (!slackCtx?.scopes || !slackCtx.updateUrl) return "";
    const missing = needed ? needed.filter((s) => !slackCtx.scopes.includes(s)) : missingScopes(slackCtx.scopes);
    if (!missing.length) return "";
    return needed
      ? `This needs a quick update to Gather for this workspace: <${slackCtx.updateUrl}|update Gather> (you'll approve the new permission in Slack; nothing else changes).`
      : `💡 There's an update to Gather for this workspace: <${slackCtx.updateUrl}|update it> to get the newest features (one click; your events stay as they are).`;
  }

  const refreshEventMessage = (client, event) =>
    client.chat.update({ channel: event.slack.channel, ts: event.slack.ts, ...eventMessage(event) }).catch((err) => console.error("chat.update failed:", err.data?.error || err.message));

  const tellUser = (client, event, user, text) =>
    client.chat.postEphemeral({ channel: event.slack.channel, thread_ts: event.slack.ts, user, text });

  async function dm(client, user, payload) {
    const opened = await client.conversations.open({ users: user });
    return client.chat.postMessage({ channel: opened.channel.id, ...payload });
  }

  async function displayName(client, user) {
    const info = await client.users.info({ user }).catch(() => null);
    return info?.user?.profile?.display_name || info?.user?.real_name || info?.user?.name || user;
  }

  const openEvents = () =>
    Object.values(store.allEvents()).filter((e) => e.slack?.ts && !isClosed(e)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);

  // The open event a channel message is most likely about: the newest one posted there.
  const OPEN_IN_CHANNEL_DAYS = 14;
  const openEventsIn = (channel) =>
    openEvents().filter((e) => e.slack.channel === channel && Date.now() - Date.parse(e.createdAt) < OPEN_IN_CHANNEL_DAYS * 86400000);

  // Privately ask a channel message's author whether (and for which event) to count it.
  // Each button carries the event and the text, so nothing has to be remembered meanwhile.
  function countPrompt(events, msg, text, { mentioned }) {
    const value = (e) => JSON.stringify({ e: e.id, ts: msg.ts, t: text.slice(0, 1500) });
    const one = events.length === 1;
    const question = one
      ? `Is this your reply to *${esc(events[0].title)}*?`
      : `There's more than one event collecting replies here. Which one is this for?`;
    const why = mentioned ? "" : " I only count messages in an event's thread, ones that mention @Gather, or ones you confirm here.";
    const choices = one
      ? [button("gather_count_yes_0", value(events[0]), "✅ Yes, count it", "primary")]
      : events.slice(0, 4).map((e, i) => button(`gather_count_yes_${i}`, value(e), clip(e.title, 70)));
    return {
      channel: msg.channel, user: msg.user,
      text: one ? `Is this your reply to ${events[0].title}?` : "Which event is this for?",
      blocks: [
        section(question + why),
        { type: "actions", elements: [...choices, button("gather_count_no", JSON.stringify({ ts: msg.ts }), one ? "No" : "None of these")] },
        context("Only you can see this."),
      ],
    };
  }

  // A thread that belongs to an event: the event's own, or one under a channel message we
  // counted for it (so follow-up questions there keep working).
  const eventForThread = (channel, threadTs) =>
    store.findEventBySlackThread(channel, threadTs) ||
    Object.values(store.allEvents()).find((e) => e.slack?.channel === channel && e.slack.linkedThreads?.includes(threadTs)) || null;

  const linkThread = (eventId, ts) =>
    store.updateEvent(eventId, (e) => (e.slack.linkedThreads = [...(e.slack.linkedThreads || []), ts].slice(-200)));

  async function postEvent(client, { fields, channel, organizer }, slackCtx) {
    // Public channels can be joined automatically; private ones need /invite.
    await client.conversations.join({ channel }).catch(() => {});
    const event = store.createEvent({ ...fields, slack: { channel, organizer, ts: null } });
    let posted;
    try {
      posted = await client.chat.postMessage({ channel, ...eventMessage(event) });
    } catch (err) {
      console.error("Posting the event failed:", err.data?.error || err.message);
      await dm(client, organizer, {
        text: `I couldn't post *${esc(event.title)}* in <#${channel}> (${err.data?.error || "error"}). If it's a private channel, add me first with \`/invite @Gather\`, then try again.`,
      }).catch(() => {});
      return null;
    }
    store.updateEvent(event.id, (e) => (e.slack.ts = posted.ts));
    const url = dashboardUrl(event);
    await tellUser(client, event, organizer,
      [
        `Posted! When people have replied, click *✨ Generate plan* on the message. To try it alone, use the *⋯* menu → *🧪 Add 5 test replies*.${url ? ` Your private dashboard (heatmap and every reply): ${url}` : ""}`,
        updateNote(slackCtx),
      ].filter(Boolean).join("\n")).catch(() => {});
    return event;
  }

  // Shared by thread replies and DMs: parse what someone said about an event, ask a
  // follow-up if needed, otherwise save it and confirm. `via` says where to answer.
  async function handleEventReply(client, eventId, user, text, via) {
    await serialize(`${eventId}:${user}`, async () => {
      const event = store.updateEvent(eventId, (e) => {
        e.slack.transcripts ||= {};
        const t = (e.slack.transcripts[user] ||= []);
        t.push({ role: "participant", text: text.slice(0, 2000) });
        e.slack.transcripts[user] = t.slice(-12);
      });
      const transcript = event.slack.transcripts[user];
      const say = (payload) =>
        via.kind === "thread"
          ? client.chat.postMessage({ channel: via.channel, thread_ts: via.thread_ts, ...payload })
          : client.chat.postMessage({ channel: via.channel, ...payload });

      let parsed;
      try {
        parsed = await parseReply(event, transcript, { language: store.getUserPrefs(user).replyLanguage });
      } catch (err) {
        console.error("Slack parse failed:", err);
        const sorry = `Sorry, I couldn't read that (${err.message}). Try again in a moment?`;
        await (via.kind === "thread" ? tellUser(client, event, user, sorry) : say({ text: sorry })).catch(() => {});
        return;
      }

      if (parsed.status === "need_clarification" && parsed.question) {
        store.updateEvent(event.id, (e) => e.slack.transcripts[user].push({ role: "assistant", text: parsed.question }));
        await say({ text: via.kind === "thread" ? `<@${user}> ${parsed.question}` : parsed.question });
        return;
      }

      const name = await displayName(client, user);
      store.upsertResponse(event.id, { name, slackUserId: user, parsed, transcript, ...(via.kind === "dm" ? { private: true } : {}) });
      if (via.kind === "thread") {
        await client.reactions.add({ channel: via.channel, timestamp: via.ts, name: "white_check_mark" }).catch(() => {});
        await client.chat.postEphemeral({ channel: via.channel, thread_ts: via.thread_ts, user, ...confirmationMessage(parsed) }).catch(() => {});
      } else {
        await say(confirmationMessage(parsed, { title: event.title, footer: "Not right? Just tell me here and I'll update it. Only the organizer sees the summary." }));
      }

      // If this was an answer to "could you make it after all?", let the organizer know.
      const nego = store.getEvent(event.id).slack.negotiations?.[user];
      if (nego?.status === "asked") {
        const fits = parsed.availability.some((b) => b.date === nego.slot.date && b.start <= nego.slot.start && b.end >= nego.slot.end);
        store.updateEvent(event.id, (e) => (e.slack.negotiations[user].status = fits ? "yes" : "replied"));
        await dm(client, event.slack.organizer, {
          text: fits
            ? `🤝 Good news for *${esc(event.title)}*: <@${user}> can make *${when(nego.slot)}* after all.`
            : `💬 <@${user}> replied about *${esc(event.title)}* and updated their availability, but still can't make *${when(nego.slot)}*.`,
        }).catch(() => {});
      }
      await refreshEventMessage(client, store.getEvent(event.id));
    });
  }

  // ----- slash command & form -----
  app.command("/gather", async ({ ack, command, client }) => {
    await ack();
    await client.views.open({ trigger_id: command.trigger_id, view: createEventModal({ channel: command.channel_id, title: command.text || "" }) });
  });

  app.view("gather_create", async ({ ack, body, view, client, context: slackCtx }) => {
    const meta = JSON.parse(view.private_metadata);
    const channel = meta.channel || view.state.values.channel?.v?.selected_conversation;
    const organizer = body.user.id;
    const info = await client.users.info({ user: organizer }).catch(() => null);
    const { fields, problems } = normalizeEventFields({ ...readModal(view.state.values), timeZone: info?.user?.tz });
    const blockErrors = Object.fromEntries(Object.entries(problems).filter(([k]) => k !== "timeZone"));
    if (Object.keys(blockErrors).length) {
      await ack({ response_action: "errors", errors: blockErrors });
      return;
    }
    await ack();
    const event = await postEvent(client, { fields, channel, organizer }, slackCtx);
    const draftId = meta.draftId;
    const draft = draftId && drafts.get(draftId);
    if (event && draft) {
      drafts.delete(draftId);
      activeDraft.delete(organizer);
      await closeDraftMessage(client, draft, `✅ Posted *${esc(event.title)}* in <#${channel}>. I'll collect replies there and in DMs.`);
    }
  });

  // ----- messages: thread replies and DMs -----
  app.event("message", async ({ event: msg, client, context: slackCtx }) => {
    if (msg.subtype || msg.bot_id) return;
    if (msg.channel_type === "im") return handleDm(client, msg);
    const raw = msg.text || "";
    const text = raw.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;

    // A reply in an event's thread (or in a thread we linked to one).
    if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      const found = eventForThread(msg.channel, msg.thread_ts);
      if (!found || isClosed(found)) return;
      return handleEventReply(client, found.id, msg.user, text, { kind: "thread", channel: msg.channel, thread_ts: msg.thread_ts, ts: msg.ts });
    }

    // A plain channel message while one or more events are open there.
    const events = openEventsIn(msg.channel);
    if (!events.length) return;
    const mentioned = Boolean(slackCtx?.botUserId && raw.includes(`<@${slackCtx.botUserId}>`));
    // "@Gather Wednesday after 7 works" with a single open event: counts right away.
    if (mentioned && events.length === 1) {
      linkThread(events[0].id, msg.ts);
      return handleEventReply(client, events[0].id, msg.user, text, { kind: "thread", channel: msg.channel, thread_ts: msg.ts, ts: msg.ts });
    }
    // Several open events (never guess which), or an untagged message that sounds like an
    // answer: privately ask its author.
    if (mentioned || looksLikeReply(text)) {
      await client.chat.postEphemeral(countPrompt(events, msg, text, { mentioned })).catch(() => {});
    }
  });

  app.action(/^gather_count_yes/, async ({ ack, body, action, client, respond }) => {
    await ack();
    const { e: eventId, ts, t: text } = JSON.parse(action.value);
    const event = store.getEvent(eventId);
    if (!event || isClosed(event)) return respond?.({ replace_original: true, text: "That event isn't collecting replies anymore." });
    await respond?.({ replace_original: true, text: `✅ Counting that for *${event.title}*.` });
    linkThread(eventId, ts);
    await handleEventReply(client, eventId, body.user.id, text, { kind: "thread", channel: event.slack.channel, thread_ts: ts, ts });
  });

  app.action("gather_count_no", async ({ ack, respond }) => {
    await ack();
    await respond?.({ delete_original: true });
  });

  // URL buttons (e.g. "Add to calendar") still send a click; just acknowledge it.
  app.action(/^gather_link_/, async ({ ack }) => ack());

  async function handleDm(client, msg) {
    const user = msg.user;
    const raw = msg.text || "";
    const text = raw.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;
    const say = (payload) => client.chat.postMessage({ channel: msg.channel, ...payload });
    const via = { kind: "dm", channel: msg.channel };
    const channelMention = raw.match(/<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/)?.[1];

    if (/^(help|帮助|\?)$/i.test(text)) return say({ text: helpMessage() });
    if (/forget (my|all)? ?(preferences|prefs|settings)|忘[掉记]?(我的)?(偏好|设置)|清除(我的)?(偏好|设置)/i.test(text)) {
      store.setUserPrefs(user, {});
      return say({ text: /[\u4e00-\u9fff]/.test(text) ? "好的，我已经忘掉了你的所有偏好。" : "Done, I've forgotten all your preferences." });
    }
    const prefs = store.getUserPrefs(user);

    // A draft is waiting for "Post it"? Treat the message as feedback on it ("make it 3 hours",
    // "write it all in English"), unless it's clearly about something else.
    const activeId = activeDraft.get(user);
    const active = activeId && drafts.get(activeId);
    if (active && Date.now() - active.shownAt < DRAFT_FEEDBACK_MINUTES * 60000) {
      // Just a channel ("#social")? Use it.
      if (channelMention && !text.replace(/<#[^>]+>/g, "").trim()) {
        active.channel = channelMention;
        drafts.set(activeId, active);
        await closeDraftMessage(client, active, "✏️ _Updated version below_ 👇");
        return showPreview(client, activeId, active, { channel: msg.channel });
      }
      let revised;
      try {
        revised = await reviseDraft({ fields: active.fields, instruction: text, timeZone: active.fields.timeZone, prefs });
      } catch (err) {
        console.error("Draft revision failed:", err);
        return say({ text: `Sorry, I couldn't update the draft (${err.message}). You can still use ✏️ Edit first.` });
      }
      if (revised.is_edit) {
        active.fields = cleanDraftFields(revised.draft, active.fields.timeZone);
        if (channelMention) active.channel = channelMention;
        drafts.set(activeId, active);
        await closeDraftMessage(client, active, "✏️ _Updated version below_ 👇");
        if (revised.reply) await say({ text: revised.reply });
        const noted = rememberPrefs(user, revised.remember);
        if (noted) await say({ text: noted });
        return showPreview(client, activeId, active, { channel: msg.channel });
      }
      // A short reply like "ok" while we still need a channel is about that, not a new topic.
      if (!active.channel && text.length <= 20) {
        return say({ text: "Pick the channel from the menu in the preview above 👆 (or type # and choose one). You can also tell me what to change." });
      }
    }

    // Mid-conversation about an event (we asked a follow-up, or asked them to adjust)? Keep going.
    const open = openEvents();
    const ongoing = open.filter((e) => {
      const t = e.slack.transcripts?.[user];
      return e.slack.negotiations?.[user]?.status === "asked" || (t?.length && t[t.length - 1].role === "assistant");
    });
    if (ongoing.length === 1) return handleEventReply(client, ongoing[0].id, user, text, via);
    // Waiting on answers for more than one event: don't guess which this is for.
    if (ongoing.length > 1) return askWhichEvent(say, user, text, ongoing);

    const info = await client.users.info({ user }).catch(() => null);
    const timeZone = info?.user?.tz || "America/New_York";
    const summaries = open.map((e) => {
      const mine = e.responses.find((r) => r.slackUserId === user);
      const top = e.recommendation?.proposals?.[0];
      return [
        `"${e.title}" in channel #${e.slack.channel}, ${e.dateStart} to ${e.dateEnd}, ${e.dayStart}–${e.dayEnd}, organized by ${e.slack.organizer === user ? "this person" : "someone else"}`,
        `${e.responses.length} replied (${e.responses.map((r) => r.name).join(", ") || "nobody yet"})`,
        mine ? `this person said: "${mine.parsed.summary}"` : "this person hasn't replied",
        top ? `current top pick: ${top.slot.date} ${top.slot.start}–${top.slot.end}` : "no plan yet",
      ].join("; ");
    });

    let route;
    try {
      route = await routeDm({ text, events: summaries, timeZone, userName: info?.user?.real_name, prefs });
    } catch (err) {
      console.error("DM routing failed:", err);
      return say({ text: `Sorry, something went wrong (${err.message}). Try again in a moment?` });
    }

    const noted = rememberPrefs(user, route.remember);
    // A message that only states a preference ("reply to me in Chinese from now on") just gets the note.
    if (noted && route.intent === "other") return say({ text: noted });
    if (noted) await say({ text: noted });

    if (route.intent === "reply") {
      const event = open[route.event_index] || (open.length === 1 ? open[0] : null);
      if (event) return handleEventReply(client, event.id, user, text, via);
      if (!open.length) return say({ text: "There are no open events right now. Want to start one? Try _\"Plan a happy hour next week in #social\"_." });
      return askWhichEvent(say, user, text, open);
    }

    if (route.intent === "create") {
      const draftId = newId();
      const draft = { organizer: user, channel: channelMention || store.getUserPrefs(user).usualChannelId || null, fields: cleanDraftFields(route.draft, timeZone) };
      drafts.set(draftId, draft);
      return showPreview(client, draftId, draft, { channel: msg.channel });
    }

    return say({ text: route.answer || helpMessage() });
  }

  // Event fields from what the model extracted, with sensible defaults for anything missing.
  function cleanDraftFields(d, timeZone) {
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
    const start = isDate(d.dateStart) ? d.dateStart : isoDate(1);
    return {
      title: d.title || "Get-together",
      description: (d.description || "").replace(/<#[^>]+>|#[\w-]+/g, "").trim(),
      askAbout: d.askAbout || ASK_OPTIONS.slice(0, 3).join(", "),
      dateStart: start,
      dateEnd: isDate(d.dateEnd) && d.dateEnd >= start ? d.dateEnd : isoDate(6, new Date(`${start}T12:00:00Z`)),
      dayStart: /^\d{2}:\d{2}$/.test(d.dayStart || "") ? d.dayStart : "17:00",
      // Midnight comes back as 00:00 or 24:00; the window has to end the same day.
      dayEnd: /^(00:00|24:00)$/.test(d.dayEnd || "") ? "23:59" : /^\d{2}:\d{2}$/.test(d.dayEnd || "") ? d.dayEnd : "23:00",
      durationMinutes: d.durationMinutes >= 30 ? Math.round(d.durationMinutes / 30) * 30 : 120,
      timeZone,
    };
  }

  // Post (or turn an existing message into) the draft preview, and remember where it is.
  async function showPreview(client, draftId, draft, { channel, ts }) {
    const payload = draftPreview(draftId, draft);
    const result = ts ? await client.chat.update({ channel, ts, ...payload }) : await client.chat.postMessage({ channel, ...payload });
    Object.assign(draft, { dmChannel: channel, previewTs: ts || result?.ts, shownAt: Date.now() });
    drafts.set(draftId, draft);
    activeDraft.set(draft.organizer, draftId);
  }

  const closeDraftMessage = (client, draft, text) =>
    draft.previewTs
      ? client.chat.update({ channel: draft.dmChannel, ts: draft.previewTs, text, blocks: [section(text)] }).catch(() => {})
      : Promise.resolve();

  const channelMenu = (placeholder = "Choose a channel") => ({
    type: "conversations_select",
    action_id: "gather_draft_channel",
    placeholder: { type: "plain_text", text: placeholder },
    filter: { include: ["public", "private"], exclude_bot_users: true },
  });

  function askWhichEvent(say, user, text, events) {
    pendingPick.set(user, text);
    return say({
      text: "Which event is this for?",
      blocks: [
        section("Which event is this for?"),
        // Every button in a block needs its own action_id, or Slack rejects the message.
        { type: "actions", elements: events.slice(0, 5).map((e, i) => button(`gather_dm_pick_${i}`, e.id, clip(e.title, 70))) },
      ],
    });
  }

  function draftPreview(draftId, draft) {
    const f = draft.fields;
    const details = section([
      `*📅 ${esc(f.title)}*${f.description ? `\n${esc(f.description)}` : ""}`,
      whenLine(f),
      f.askAbout ? `💬 Also asking about: ${esc(f.askAbout)}` : "",
    ].filter(Boolean).join("\n"));
    const elements = draft.channel
      ? [button("gather_draft_post", draftId, "✅ Post it", "primary"), button("gather_draft_edit", draftId, "✏️ Edit first"), button("gather_draft_cancel", draftId, "Cancel")]
      : [channelMenu(), button("gather_draft_edit", draftId, "✏️ Edit first"), button("gather_draft_cancel", draftId, "Cancel")];
    return {
      text: draft.channel ? `Ready to post ${f.title}?` : `Here's ${f.title}. Which channel should I post it in?`,
      blocks: [
        section(draft.channel ? `*Here's the event I'll post in <#${draft.channel}>:*` : "*Here's the event. Which channel should I post it in?*"),
        details,
        { type: "actions", block_id: `draft:${draftId}`, elements },
        context("Want changes? Just tell me here, e.g. _\"make it 3 hours\"_ or _\"write it all in English\"_."),
      ],
    };
  }

  app.action("gather_draft_channel", async ({ ack, body, action, client }) => {
    await ack();
    const draftId = action.block_id.replace(/^draft:/, "");
    const draft = drafts.get(draftId);
    if (!draft) return finishDraft(client, body, "This draft has expired. Tell me again what you'd like to plan.");
    draft.channel = action.selected_conversation;
    drafts.set(draftId, draft);
    await showPreview(client, draftId, draft, { channel: body.channel.id, ts: body.message.ts });
  });

  app.action(/^gather_dm_pick/, async ({ ack, body, action, client }) => {
    await ack();
    const user = body.user.id;
    const text = pendingPick.get(user);
    pendingPick.delete(user);
    const event = store.getEvent(action.value);
    if (!text || !event) return;
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: `For *${esc(event.title)}*:`, blocks: [] }).catch(() => {});
    await handleEventReply(client, event.id, user, text, { kind: "dm", channel: body.channel.id });
  });

  const finishDraft = (client, body, text) =>
    client.chat.update({ channel: body.channel.id, ts: body.message.ts, text, blocks: [section(text)] }).catch(() => {});

  app.action("gather_draft_post", async ({ ack, body, action, client, context: slackCtx }) => {
    await ack();
    const draft = drafts.get(action.value);
    if (!draft) return finishDraft(client, body, "This draft has expired. Tell me again what you'd like to plan.");
    const { fields, problems } = normalizeEventFields(draft.fields);
    if (Object.keys(problems).length) {
      await client.views.open({ trigger_id: body.trigger_id, view: createEventModal({ channel: draft.channel, prefill: draft.fields, draftId: action.value }) });
      return;
    }
    drafts.delete(action.value);
    activeDraft.delete(body.user.id);
    const event = await postEvent(client, { fields, channel: draft.channel, organizer: draft.organizer }, slackCtx);
    if (event) await finishDraft(client, body, `✅ Posted *${esc(event.title)}* in <#${draft.channel}>. I'll collect replies there and in DMs.`);
  });

  app.action("gather_draft_edit", async ({ ack, body, action, client }) => {
    await ack();
    const draft = drafts.get(action.value);
    if (!draft) return finishDraft(client, body, "This draft has expired. Tell me again what you'd like to plan.");
    // Keep the draft and its buttons: closing the form shouldn't lose anything.
    await client.views.open({ trigger_id: body.trigger_id, view: createEventModal({ channel: draft.channel, prefill: draft.fields, draftId: action.value }) });
  });

  app.action("gather_draft_cancel", async ({ ack, body, action, client }) => {
    await ack();
    drafts.delete(action.value);
    activeDraft.delete(body.user.id);
    await finishDraft(client, body, "Cancelled. Nothing was posted.");
  });

  // ----- organizer buttons -----
  app.action("gather_plan", async ({ ack, body, action, client }) => {
    await ack();
    const event = store.getEvent(action.value);
    if (!event) return;
    const user = body.user.id;
    if (user !== event.slack.organizer) {
      await tellUser(client, event, user, `Only <@${event.slack.organizer}> (the organizer) can generate the plan.`);
      return;
    }
    if (!event.responses.length) {
      await tellUser(client, event, user, "Nobody has replied yet. Give people a little time!");
      return;
    }
    const candidates = rankSlots(event, event.responses, 6);
    if (!candidates.length) {
      await tellUser(client, event, user, "No time works for anyone yet. Maybe widen the dates or daily window.");
      return;
    }
    const placeholder = await client.chat.postMessage({
      channel: event.slack.channel, thread_ts: event.slack.ts,
      text: `🤔 Putting together a plan from ${event.responses.length} ${event.responses.length === 1 ? "reply" : "replies"}…`,
    });
    try {
      const rec = await recommend(event, candidates);
      store.setRecommendation(event.id, { ...rec, responseCount: event.responses.length });
      await client.chat.update({ channel: event.slack.channel, ts: placeholder.ts, ...planMessage(store.getEvent(event.id), rec) });
    } catch (err) {
      console.error("Slack recommend failed:", err);
      await client.chat.update({ channel: event.slack.channel, ts: placeholder.ts, text: `Sorry, I couldn't build a plan (${err.message}).` });
    }
  });

  app.action("gather_more", async ({ ack, body, action, client, context: slackCtx }) => {
    await ack();
    const [command, eventId] = (action.selected_option?.value || "").split(":");
    const event = store.getEvent(eventId);
    if (!event) return;
    if (body.user.id !== event.slack.organizer) {
      await tellUser(client, event, body.user.id, `Only <@${event.slack.organizer}> (the organizer) can use this menu.`);
      return;
    }
    if (command === "remind") return remindNonResponders(client, event, slackCtx);
    if (command === "cancel") {
      return client.chat.postEphemeral({
        channel: event.slack.channel, thread_ts: event.slack.ts, user: body.user.id,
        text: `Cancel ${event.title}?`,
        blocks: [
          section(`Cancel *${esc(event.title)}*? Gather will stop collecting replies and mark it as cancelled.`),
          { type: "actions", elements: [{ ...button("gather_cancel_confirm", event.id, "Yes, cancel it"), style: "danger" }] },
        ],
      });
    }
    if (command !== "simulate") return;
    await tellUser(client, event, body.user.id, "🧪 Adding 5 replies from made-up participants. They go through the same AI parsing as real replies.").catch(() => {});
    const added = await simulateReplies(event.id, 5, {
      onReply: (name, transcript) =>
        client.chat.postMessage({
          channel: event.slack.channel,
          thread_ts: event.slack.ts,
          text: `🧪 *${esc(name)}*: ${transcript.filter((t) => t.role === "participant").map((t) => esc(t.text)).join(" / ")}`,
        }).catch(() => {}),
    });
    if (!added.length) await tellUser(client, event, body.user.id, "All test participants have already replied.").catch(() => {});
    await refreshEventMessage(client, store.getEvent(event.id));
  });

  app.action("gather_cancel_confirm", async ({ ack, body, action, client, respond }) => {
    await ack();
    const event = store.getEvent(action.value);
    if (!event || body.user.id !== event.slack.organizer || isClosed(event)) return;
    const updated = store.updateEvent(event.id, (e) => (e.slack.cancelled = { by: body.user.id, at: new Date().toISOString() }));
    await refreshEventMessage(client, updated);
    await client.chat.postMessage({ channel: event.slack.channel, thread_ts: event.slack.ts, text: `🚫 <@${body.user.id}> cancelled *${esc(event.title)}*.` }).catch(() => {});
    await respond?.({ replace_original: true, text: "Cancelled." });
  });

  // DM everyone in the event's channel who hasn't replied yet (skipping anyone reminded in
  // the last 12 hours). Their answer in the DM counts as their reply.
  const REMIND_AGAIN_HOURS = 12;
  const MAX_REMINDERS = 30;
  async function remindNonResponders(client, event, slackCtx = {}) {
    const note = updateNote(slackCtx, ["channels:read", "groups:read"]);
    if (note) return tellUser(client, event, event.slack.organizer, `🔔 To remind people, Gather needs to see who's in the channel. ${note}`).catch(() => {});
    let members;
    try {
      members = (await client.conversations.members({ channel: event.slack.channel, limit: 200 })).members || [];
    } catch (err) {
      const why = err.data?.error === "missing_scope" ? ` ${updateNote({ ...slackCtx, scopes: slackCtx.scopes || [] }, ["channels:read", "groups:read"]) || "Gather needs permission to see channel members: reinstall it from the Add to Slack page."}` : "";
      return tellUser(client, event, event.slack.organizer, `I couldn't get the channel's members (${err.data?.error || err.message}).${why}`).catch(() => {});
    }
    const replied = new Set(event.responses.map((r) => r.slackUserId).filter(Boolean));
    const recent = event.slack.reminded || {};
    const candidates = members
      .filter((u) => !replied.has(u) && u !== event.slack.organizer && u !== slackCtx.botUserId)
      .filter((u) => !recent[u] || Date.now() - recent[u] > REMIND_AGAIN_HOURS * 3600000)
      .slice(0, MAX_REMINDERS);
    const zh = /[\u4e00-\u9fff]/.test(event.title + (event.description || ""));
    const asks = event.askAbout ? (zh ? `，以及对${event.askAbout}的想法` : ` and what you think about ${event.askAbout.toLowerCase()}`) : "";
    const reminded = [];
    for (const user of candidates) {
      const info = await client.users.info({ user }).catch(() => null);
      if (!info?.user || info.user.is_bot || info.user.deleted || info.user.id === "USLACKBOT") continue;
      const question = zh
        ? `<@${event.slack.organizer}> 在组织 *${event.title}*，想知道你什么时候有空${asks}？直接在这里用自己的话回复就行，也可以回复 <#${event.slack.channel}> 里的活动帖子。`
        : `<@${event.slack.organizer}> is planning *${event.title}*. When are you free${asks}? Just reply here in your own words, e.g. "Thu after 7, vegetarian", or reply in the thread in <#${event.slack.channel}>.`;
      try {
        await dm(client, user, { text: question, blocks: [section(question), context(whenLine(event))] });
      } catch (err) {
        console.error("Reminder DM failed:", err.data?.error || err.message);
        continue;
      }
      store.updateEvent(event.id, (e) => {
        (e.slack.reminded ||= {})[user] = Date.now();
        e.slack.transcripts ||= {};
        // Their next DM is an answer to this.
        (e.slack.transcripts[user] ||= []).push({ role: "assistant", text: question });
      });
      reminded.push(user);
    }
    await tellUser(client, event, event.slack.organizer, reminded.length
      ? `🔔 Reminded ${reminded.map((u) => `<@${u}>`).join(", ")} privately. Their answers will show up here as they come in.`
      : "Everyone in the channel has already replied or was reminded in the last 12 hours.").catch(() => {});
  }

  // Ask people who can't make the top pick, one DM each, whether they could adjust.
  app.action("gather_negotiate", async ({ ack, body, action, client }) => {
    await ack();
    const event = store.getEvent(action.value);
    const slot = event?.recommendation?.proposals?.[0]?.slot;
    if (!slot) return;
    if (body.user.id !== event.slack.organizer) {
      await tellUser(client, event, body.user.id, `Only <@${event.slack.organizer}> (the organizer) can do this.`);
      return;
    }
    const people = negotiationCandidates(event, slot).filter((r) => !event.slack.negotiations?.[negotiationKey(r)]);
    if (!people.length) {
      await tellUser(client, event, body.user.id, "I've already asked everyone who can't make it.");
      return;
    }
    const record = (key, status, question) =>
      store.updateEvent(event.id, (e) => {
        e.slack.negotiations ||= {};
        e.slack.negotiations[key] = { slot: { date: slot.date, start: slot.start, end: slot.end }, status };
        if (!key.startsWith("sim:")) {
          e.slack.transcripts ||= {};
          (e.slack.transcripts[key] ||= []).push({ role: "assistant", text: question });
        }
      });
    const asked = [];
    const simResults = [];
    for (const person of people) {
      try {
        if (!person.slackUserId) {
          // Test participants can't get DMs, so show the exchange in the thread instead.
          const { question, answer, fits } = await askTestParticipant(event.id, person, slot);
          await client.chat.postMessage({ channel: event.slack.channel, thread_ts: event.slack.ts, text: `🧪 I asked *${esc(person.name)}* privately: _${esc(question)}_\n🧪 *${esc(person.name)}*: ${esc(answer)}` });
          record(negotiationKey(person), fits ? "yes" : "replied");
          simResults.push(`${fits ? "✅" : "❌"} ${esc(person.name)}`);
          continue;
        }
        const question = await negotiationQuestion(event, slot, person);
        await dm(client, person.slackUserId, {
          text: question,
          blocks: [
            section(`*About ${esc(event.title)}* (organized by <@${event.slack.organizer}>)\n${esc(question)}`),
            { type: "actions", elements: [
              button("gather_nego_yes", `${event.id}:${person.slackUserId}`, `✅ Yes, I can make ${when(slot)}`.slice(0, 75), "primary"),
              button("gather_nego_no", `${event.id}:${person.slackUserId}`, "No, sorry"),
            ] },
            context("You can also just reply here in your own words."),
          ],
        });
        record(person.slackUserId, "asked", question);
        asked.push(person.slackUserId);
      } catch (err) {
        console.error("Negotiation failed:", err.data?.error || err.message);
      }
    }
    const lines = [];
    if (asked.length) lines.push(`🤝 I've privately asked ${asked.map((u) => `<@${u}>`).join(", ")} whether they could make *${when(slot)}*. I'll DM you their answers.`);
    if (simResults.length) lines.push(`🧪 Test participants answered: ${simResults.join("  ")}. Click *✨ Generate plan* again to update the plan.`);
    await tellUser(client, event, body.user.id, lines.join("\n") || "I couldn't reach anyone, sorry.").catch(() => {});
    if (simResults.length) await refreshEventMessage(client, store.getEvent(event.id));
  });

  async function answerNegotiation({ body, action, client }, yes) {
    const [eventId, user] = action.value.split(":");
    if (body.user.id !== user) return;
    const event = store.getEvent(eventId);
    const nego = event?.slack.negotiations?.[user];
    if (!nego) return;
    const slot = nego.slot;
    store.updateEvent(eventId, (e) => {
      e.slack.negotiations[user].status = yes ? "yes" : "no";
      const t = (e.slack.transcripts[user] ||= []);
      t.push({ role: "participant", text: yes ? `Yes, I can make ${slot.date} ${slot.start}-${slot.end}.` : `No, I can't make ${slot.date} ${slot.start}-${slot.end}.` });
      if (yes) {
        const r = e.responses.find((x) => x.slackUserId === user);
        if (r) r.parsed.availability.push({ date: slot.date, start: slot.start, end: slot.end, level: "available" });
      }
    });
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: yes ? "Thanks!" : "No worries",
      blocks: [section(yes ? `✅ Thanks! I've marked you as coming to *${esc(event.title)}* on *${when(slot)}*.` : `👍 No worries, thanks for letting me know. *${esc(event.title)}* will go ahead without pressure.`)],
    }).catch(() => {});
    await dm(client, event.slack.organizer, {
      text: yes
        ? `🤝 Good news for *${esc(event.title)}*: <@${user}> can make *${when(slot)}* after all. Click *✨ Generate plan* again to refresh the plan.`
        : `🙅 <@${user}> can't make *${when(slot)}* for *${esc(event.title)}*.`,
    }).catch(() => {});
    await refreshEventMessage(client, store.getEvent(eventId));
  }
  app.action("gather_nego_yes", async (args) => { await args.ack(); await answerNegotiation(args, true); });
  app.action("gather_nego_no", async (args) => { await args.ack(); await answerNegotiation(args, false); });

  app.action(/^gather_announce_\d+$/, async ({ ack, body, action, client }) => {
    await ack();
    const [eventId, index] = action.value.split(":");
    const event = store.getEvent(eventId);
    const proposal = event?.recommendation?.proposals?.[Number(index)];
    if (!proposal) return;
    if (body.user.id !== event.slack.organizer) {
      await tellUser(client, event, body.user.id, `Only <@${event.slack.organizer}> (the organizer) can announce the decision.`);
      return;
    }
    const slot = proposal.slot;
    const message = Number(index) === 0 && event.recommendation.announcement
      ? event.recommendation.announcement
      : `${proposal.title}. ${proposal.details}`;
    await client.chat.postMessage({
      channel: event.slack.channel,
      text: `📣 ${event.title}: ${when(slot)}`,
      blocks: [
        section(`📣 *${esc(event.title)}* is on: *${when(slot)}*`),
        section(esc(message)),
        context(`Coming: ${slot.attendees.map((a) => esc(a.name)).join(", ")}${slot.missing.length ? `  ·  Can't make it: ${slot.missing.map(esc).join(", ")}` : ""}`),
        (() => {
          const links = calendarLinks(event, slot, message);
          return { type: "actions", elements: [
            { type: "button", action_id: "gather_link_google", url: links.google, text: { type: "plain_text", text: "📅 Add to Google Calendar" } },
            { type: "button", action_id: "gather_link_outlook", url: links.outlook, text: { type: "plain_text", text: "📅 Add to Outlook" } },
          ] };
        })(),
      ],
    });
    const updated = store.updateEvent(event.id, (e) => (e.slack.decided = { date: slot.date, start: slot.start, end: slot.end }));
    await refreshEventMessage(client, updated);
  });
}

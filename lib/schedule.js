// Deterministic scheduling: the LLM only extracts structured availability;
// all time math and ranking happens here so results are explainable and repeatable.

const SLOT_MINUTES = 30;

export const LEVEL_WEIGHT = { preferred: 1.0, available: 0.8, if_needed: 0.4 };

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Every date (YYYY-MM-DD) from start to end inclusive.
export function dateRange(start, end) {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// The best availability level a person has for [startMin, endMin) on a date, or null.
// A slot only counts if a single block covers it entirely.
function levelFor(availability, date, startMin, endMin) {
  let best = null;
  for (const block of availability) {
    if (block.date !== date) continue;
    if (toMinutes(block.start) <= startMin && toMinutes(block.end) >= endMin) {
      if (!best || LEVEL_WEIGHT[block.level] > LEVEL_WEIGHT[best]) best = block.level;
    }
  }
  return best;
}

// Per-date grid of 30-minute cells: who can make each cell.
export function buildHeatmap(event, responses) {
  const startMin = toMinutes(event.dayStart);
  const endMin = toMinutes(event.dayEnd);
  return dateRange(event.dateStart, event.dateEnd).map((date) => {
    const cells = [];
    for (let t = startMin; t + SLOT_MINUTES <= endMin; t += SLOT_MINUTES) {
      const people = responses
        .filter((r) => levelFor(r.parsed.availability, date, t, t + SLOT_MINUTES))
        .map((r) => r.name);
      cells.push({ time: fromMinutes(t), count: people.length, people });
    }
    return { date, cells };
  });
}

// Rank every possible start time for an event of event.durationMinutes.
// Primary key: how many people can attend; secondary: preference-weighted score.
export function rankSlots(event, responses, limit = 5) {
  const duration = event.durationMinutes;
  const startMin = toMinutes(event.dayStart);
  const endMin = toMinutes(event.dayEnd);
  const candidates = [];

  for (const date of dateRange(event.dateStart, event.dateEnd)) {
    for (let t = startMin; t + duration <= endMin; t += SLOT_MINUTES) {
      const attendees = [];
      const missing = [];
      let score = 0;
      for (const r of responses) {
        const level = levelFor(r.parsed.availability, date, t, t + duration);
        if (level) {
          attendees.push({ name: r.name, level });
          score += LEVEL_WEIGHT[level];
        } else {
          missing.push(r.name);
        }
      }
      if (attendees.length === 0) continue;
      candidates.push({
        date,
        start: fromMinutes(t),
        end: fromMinutes(t + duration),
        attendees,
        missing,
        score: Math.round(score * 100) / 100,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.attendees.length - a.attendees.length ||
      b.score - a.score ||
      a.date.localeCompare(b.date) ||
      a.start.localeCompare(b.start),
  );

  // Drop slots that overlap a better-ranked slot on the same day, so the
  // shortlist offers genuinely different options rather than 7:00 / 7:30 / 8:00.
  const picked = [];
  for (const c of candidates) {
    const overlaps = picked.some(
      (p) => p.date === c.date && toMinutes(p.start) < toMinutes(c.end) && toMinutes(c.start) < toMinutes(p.end),
    );
    if (!overlaps) picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}

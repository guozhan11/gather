// Shared event-creation rules for the web form and the Slack modal.
import { dateRange } from "./schedule.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
export const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Returns { fields, problems } where problems maps a field name to a message.
export function normalizeEventFields(b = {}) {
  const fields = {
    title: str(b.title, 120),
    description: str(b.description, 1000),
    askAbout: str(b.askAbout, 300),
    dateStart: str(b.dateStart, 10),
    dateEnd: str(b.dateEnd, 10),
    dayStart: str(b.dayStart, 5),
    dayEnd: str(b.dayEnd, 5),
    durationMinutes: Number(b.durationMinutes),
    timeZone: str(b.timeZone, 64) || "America/New_York",
  };
  const problems = {};
  if (!fields.title) problems.title = "Title is required.";
  if (!DATE.test(fields.dateStart) || !DATE.test(fields.dateEnd) || fields.dateEnd < fields.dateStart)
    problems.dateEnd = "Pick a valid date range.";
  else if (dateRange(fields.dateStart, fields.dateEnd).length > 14) problems.dateEnd = "Date range can be at most 14 days.";
  if (!TIME.test(fields.dayStart) || !TIME.test(fields.dayEnd) || fields.dayEnd <= fields.dayStart)
    problems.dayEnd = "Daily window must end after it starts.";
  else if (fields.durationMinutes > toMin(fields.dayEnd) - toMin(fields.dayStart))
    problems.durationMinutes = "The event is longer than the daily window.";
  if (!(fields.durationMinutes >= 30 && fields.durationMinutes <= 600 && fields.durationMinutes % 30 === 0))
    problems.durationMinutes = "Length must be a multiple of 30 minutes.";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: fields.timeZone });
  } catch {
    problems.timeZone = "Unknown time zone.";
  }
  return { fields, problems };
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

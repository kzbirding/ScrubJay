import { DateTime } from "luxon";

const TZ = "America/Los_Angeles";

/**
 * Accepts dates like:
 * - 2026-01-15
 * - 1/15/2026
 * - 1/15/26
 * - Jan 15 2026
 * - January 15, 2026
 */
function parseDateFlexible(dateRaw: string): DateTime {
  const d = (dateRaw ?? "").trim();

  const formats = [
    "yyyy-MM-dd",
    "M/d/yyyy",
    "M/d/yy",
    "MM/dd/yyyy",
    "MM/dd/yy",
    "MMM d yyyy",
    "MMM d, yyyy",
    "MMMM d yyyy",
    "MMMM d, yyyy",
  ];

  for (const f of formats) {
    const dt = DateTime.fromFormat(d, f, { zone: TZ });
    if (dt.isValid) return dt.startOf("day");
  }

  // Last-chance: Luxon ISO parse (covers some variants)
  const iso = DateTime.fromISO(d, { zone: TZ });
  if (iso.isValid) return iso.startOf("day");

  throw new Error(
    `Invalid date. Try formats like "2026-01-15", "1/15/2026", or "Jan 15 2026".`,
  );
}

/**
 * Accepts times like:
 * - "7"            -> 7:00 (needs AM/PM or we assume 7:00 AM)
 * - "7:30"         -> 7:30 (assume AM)
 * - "7am" / "7 AM"
 * - "7:30pm" / "7:30 PM"
 * - "19:30"        -> 24h
 *
 * Rule to avoid surprises:
 * - If user does NOT specify AM/PM and hour is 1–11, we assume AM.
 * - If user does NOT specify AM/PM and hour is 12, we assume 12:00 PM (noon).
 * - If user uses 24h (>= 13), we treat as 24h.
 */
function parseTimeFlexible(timeRaw: string): { hour: number; minute: number } {
  const t0 = (timeRaw ?? "").trim().toLowerCase();
  if (!t0) {
    throw new Error(
      `Invalid time. Try "7", "7:30pm", or "19:30".`,
    );
  }

  // Normalize spaces: "7 pm" -> "7pm"
  const t = t0.replace(/\s+/g, "");

  // Match: H, H:MM, HH:MM plus optional am/pm
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) {
    throw new Error(`Invalid time "${timeRaw}". Try "7", "7:30pm", or "19:30".`);
  }

  const hourRaw = parseInt(m[1], 10);
  const minuteRaw = m[2] ? parseInt(m[2], 10) : 0;
  const suffix = m[3]; // "am" | "pm" | undefined

  if (Number.isNaN(hourRaw) || hourRaw < 0 || hourRaw > 23) {
    throw new Error(`Invalid hour in "${timeRaw}".`);
  }
  if (Number.isNaN(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) {
    throw new Error(`Invalid minutes in "${timeRaw}". Use :00–:59.`);
  }

  // If 24h time provided (13–23), ignore suffix and treat as 24h
  if (hourRaw >= 13) {
    return { hour: hourRaw, minute: minuteRaw };
  }

  // If suffix given, treat as 12-hour time
  if (suffix) {
    if (hourRaw < 1 || hourRaw > 12) {
      throw new Error(`Invalid 12-hour time "${timeRaw}". Use 1–12 with AM/PM.`);
    }

    let hour = hourRaw % 12; // 12 -> 0
    if (suffix === "pm") hour += 12; // PM adds 12 except 12pm handled by %12 above
    return { hour, minute: minuteRaw };
  }

  // No suffix: make a reasonable default
  // - 1–11 => AM
  // - 12 => noon (12:xx PM)
  if (hourRaw === 12) {
    return { hour: 12, minute: minuteRaw };
  }
  return { hour: hourRaw, minute: minuteRaw };
}

export function parseMeetupTimes(date: string, start: string, end?: string) {
  const day = parseDateFlexible(date);

  const s = parseTimeFlexible(start);
  const startDt = day.set({ hour: s.hour, minute: s.minute }).setZone(TZ);

  if (!startDt.isValid) {
    throw new Error(
      `Invalid start time. Try "7", "7:30pm", or "19:30".`,
    );
  }

  let endDt: DateTime | undefined;
  if (end && end.trim()) {
    const e = parseTimeFlexible(end);
    endDt = day.set({ hour: e.hour, minute: e.minute }).setZone(TZ);

    if (!endDt.isValid) {
      throw new Error(
        `Invalid end time. Try "8:30am", "1:15pm", or "21:00".`,
      );
    }
    if (endDt <= startDt) {
      throw new Error("end_time must be after start_time.");
    }
  }

  return {
    start: startDt.toUTC(),
    end: endDt?.toUTC(),
    startUnix: Math.floor(startDt.toSeconds()),
    endUnix: endDt ? Math.floor(endDt.toSeconds()) : undefined,
  };
}

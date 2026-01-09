import { DateTime } from "luxon";

const TZ = "America/Los_Angeles";

export function parseMeetupTimes(date: string, start: string, end?: string) {
  // date: YYYY-MM-DD, time: HH:MM (24h)
  const startDt = DateTime.fromFormat(`${date} ${start}`, "yyyy-MM-dd HH:mm", {
    zone: TZ,
  });

  if (!startDt.isValid) {
    throw new Error("Invalid date/start_time. Use YYYY-MM-DD and HH:MM (24h).");
  }

  let endDt: DateTime | undefined;
  if (end) {
    endDt = DateTime.fromFormat(`${date} ${end}`, "yyyy-MM-dd HH:mm", {
      zone: TZ,
    });

    if (!endDt.isValid) {
      throw new Error("Invalid end_time. Use HH:MM (24h).");
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

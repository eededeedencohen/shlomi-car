/**
 * Date helpers (spec 2.1). All local time; server.js sets process.env.TZ = 'Asia/Jerusalem'
 * before anything else runs, so "start of day" means an Israeli day.
 */
import dayjs from 'dayjs';

export const startOfDay = (d = new Date()) => dayjs(d).startOf('day').toDate();

export const addDays = (d, n) => dayjs(d).add(n, 'day').toDate();

/** dayjs clamps month ends (29/02 + 12 months = 28/02). */
export const addMonths = (d, n) => dayjs(d).add(n, 'month').toDate();

/** Whole days from a to b (negative when b is before a), ignoring time of day. */
export const daysBetween = (a, b) => dayjs(b).startOf('day').diff(dayjs(a).startOf('day'), 'day');

export const startOfMonth = (d = new Date()) => dayjs(d).startOf('month').toDate();

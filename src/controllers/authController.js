import User from '../models/User.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { signToken } from '../utils/token.js';

/** Public user payload (never includes passwordHash). */
const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  username: user.username,
});

/**
 * Brute-force guard for login: after MAX_FAILURES failed attempts from the same IP + username within
 * WINDOW_MS the login is refused with 429 until the window passes. In-memory (single process), no deps.
 */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> [timestamps]

const failureKey = (req, ident) => `${req.ip || 'unknown'}|${ident}`;

const recentFailures = (key, now) => {
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
};

const recordFailure = (key, now) => {
  const list = recentFailures(key, now);
  list.push(now);
  failures.set(key, list);
  // keep the map bounded even under a wide scan
  if (failures.size > 5000) failures.delete(failures.keys().next().value);
};

/**
 * POST /api/auth/login  (PUBLIC)
 * body: { username, password } -> { token, user }
 */
export const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if ((username != null && typeof username !== 'string') || (password != null && typeof password !== 'string')) {
    throw ApiError.badRequest('יש להזין שם משתמש וסיסמה');
  }
  const ident = String(username || '').toLowerCase().trim();
  if (!ident || !password) throw ApiError.badRequest('יש להזין שם משתמש וסיסמה');

  const now = Date.now();
  const key = failureKey(req, ident);
  if (recentFailures(key, now).length >= MAX_FAILURES) {
    throw new ApiError(429, 'יותר מדי ניסיונות התחברות. נסו שוב בעוד כמה דקות');
  }

  const user = await User.findOne({ username: ident }).select('+passwordHash');
  const ok = user && user.active && user.passwordHash ? await user.verifyPassword(password) : false;
  if (!ok) {
    recordFailure(key, now);
    throw ApiError.unauthorized('שם משתמש או סיסמה שגויים');
  }
  failures.delete(key);

  const token = signToken({ id: user._id });
  res.json({ success: true, data: { token, user: publicUser(user) } });
});

/** GET /api/auth/me  (protect) */
export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: publicUser(req.user) });
});

/**
 * POST /api/auth/change-password  (protect)
 * body: { currentPassword, newPassword }
 */
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    throw ApiError.badRequest('יש להזין סיסמה נוכחית וסיסמה חדשה');
  }
  if (String(newPassword).length < 6) {
    throw ApiError.badRequest('הסיסמה החדשה חייבת להכיל לפחות 6 תווים');
  }
  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!user) throw ApiError.notFound('המשתמש לא נמצא');
  const ok = await user.verifyPassword(currentPassword);
  if (!ok) throw ApiError.unauthorized('הסיסמה הנוכחית שגויה');
  await user.setPassword(newPassword);
  await user.save();
  res.json({ success: true, data: { message: 'הסיסמה עודכנה בהצלחה' } });
});

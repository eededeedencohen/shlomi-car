import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { verifyToken } from '../utils/token.js';
import User from '../models/User.js';

/**
 * Authenticate the request via `Authorization: Bearer <jwt>`.
 * Sets req.user (Mongoose document without passwordHash). Throws 401 otherwise.
 */
export const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized();

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    throw ApiError.unauthorized('טוקן לא תקין או שפג תוקפו');
  }
  const user = await User.findById(decoded.id);
  if (!user || !user.active) throw ApiError.unauthorized('המשתמש לא קיים או לא פעיל');
  req.user = user;
  next();
});

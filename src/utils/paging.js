/** Paging helpers (spec 2.1). Lists respond with { success, data, total, page, pages }. */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
// Far beyond any real list; keeps $skip inside MongoDB's range when the query string is garbage.
const MAX_PAGE = 100000;

const toInt = (value, fallback) => {
  const n = parseInt(Array.isArray(value) ? value[0] : value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Reads `page` (1..100000, default 1) and `limit` (1..500, default 50) from req.query. */
export const parsePaging = (query = {}) => {
  const page = Math.min(Math.max(toInt(query.page, 1), 1), MAX_PAGE);
  const limit = Math.min(Math.max(toInt(query.limit, DEFAULT_LIMIT), 1), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
};

export const listResponse = (res, data, total, page, limit) =>
  res.json({
    success: true,
    data,
    total,
    page,
    pages: Math.max(Math.ceil(total / limit), 1),
  });

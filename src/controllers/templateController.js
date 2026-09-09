/**
 * Task catalog API (spec 4.5). A template is a ready-made task: work (labor) + parts + record price.
 * The catalog is small, so the list is not paged; it also returns the work / part suggestion indexes.
 */
import mongoose from 'mongoose';
import WorkItemTemplate, { TEMPLATE_CATEGORIES } from '../models/WorkItemTemplate.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { titleKeyOf, escapeRegex } from '../utils/normalize.js';
import { normalizeTask, applyTitleRename, deriveTitle, templateRow, catalogIndexes } from '../utils/tasks.js';

const RECENT_LIMIT = 8;

const MSG = {
  notFound: 'פריט הקטלוג לא נמצא',
  duplicate: 'פריט קטלוג בשם זה כבר קיים',
  title: 'שם הפריט הוא שדה חובה',
  category: 'קטגוריה לא חוקית',
  order: 'ערך מספרי לא תקין',
};

const isBlank = (v) => v === undefined || v === null || v === '';

const parseCategory = (v, fallback = 'general') => {
  if (isBlank(v)) return fallback;
  if (!TEMPLATE_CATEGORIES.includes(v)) throw ApiError.badRequest(MSG.category);
  return v;
};

const parseOrder = (v) => {
  if (isBlank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw ApiError.badRequest(MSG.order);
  return n;
};

const parseBool = (v, fallback) => {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return !['false', '0', ''].includes(v.toLowerCase());
  return Boolean(v);
};

const SORTS = {
  usage: { usageCount: -1, order: 1, title: 1 },
  recent: { lastUsedAt: -1, usageCount: -1, title: 1 },
  title: { title: 1 },
  order: { order: 1, usageCount: -1, title: 1 },
};

/** Pre-check for a duplicate (derived) title; the unique index on titleKey is the backstop. */
const assertUniqueTitle = async (title, excludeId = null) => {
  const query = { titleKey: titleKeyOf(title) };
  if (excludeId) query._id = { $ne: excludeId };
  const clash = await WorkItemTemplate.exists(query);
  if (clash) throw ApiError.badRequest(MSG.duplicate);
};

const loadTemplate = async (id) => {
  if (!mongoose.isValidObjectId(String(id))) throw ApiError.notFound(MSG.notFound);
  const template = await WorkItemTemplate.findById(id);
  if (!template) throw ApiError.notFound(MSG.notFound);
  return template;
};

/** Body -> task fields for the catalog (no done state). A bare title becomes a part or a work by `type` / guess. */
const taskFromBody = (body) => normalizeTask(body, { withStatus: false });

/** GET /api/templates -> { templates, recent, works, parts } */
export const listTemplates = asyncHandler(async (req, res) => {
  const q = req.query || {};
  const match = {};

  const search = String(q.q ?? '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    match.$or = [{ title: rx }, { 'work.title': rx }, { 'parts.title': rx }];
  }
  if (!isBlank(q.category)) match.category = parseCategory(q.category);
  if (String(q.active ?? '1') !== 'all') match.active = true;

  const sortKey = String(q.sortBy || '');
  const sort = Object.hasOwn(SORTS, sortKey) ? SORTS[sortKey] : SORTS.order;
  let listQuery = WorkItemTemplate.find(match).sort(sort);
  if (q.sortBy === 'title') listQuery = listQuery.collation({ locale: 'he' });

  const [templates, recent, activeAll] = await Promise.all([
    listQuery.lean(),
    WorkItemTemplate.find({ active: true, lastUsedAt: { $ne: null } })
      .sort({ lastUsedAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .lean(),
    WorkItemTemplate.find({ active: true }).select('work parts').lean(),
  ]);

  const { works, parts } = catalogIndexes(activeAll);
  res.json({ success: true, data: { templates: templates.map(templateRow), recent: recent.map(templateRow), works, parts } });
});

/** POST /api/templates  body: { title?, work?, parts?, price?, type?, category, order } */
export const createTemplate = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const task = taskFromBody(body);
  const title = deriveTitle(task);
  if (!title) throw ApiError.badRequest(MSG.title);
  await assertUniqueTitle(title);

  const template = await WorkItemTemplate.create({
    title,
    work: task.work,
    parts: task.parts,
    price: task.price,
    category: parseCategory(body.category),
    order: parseOrder(body.order) ?? 0,
  });

  res.status(201).json({ success: true, data: templateRow(template) });
});

/** PUT /api/templates/:id  whitelist: title, work, parts, price, category, active, order */
export const updateTemplate = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const template = await loadTemplate(req.params.id);

  const structural = body.work !== undefined || body.parts !== undefined || body.title !== undefined || body.price !== undefined;
  if (structural) {
    const merged = normalizeTask(
      {
        title: body.title !== undefined ? body.title : template.title,
        work: body.work !== undefined ? body.work : template.work ? template.work.toObject() : null,
        parts: body.parts !== undefined ? body.parts : template.parts.map((p) => p.toObject()),
        price: body.price !== undefined ? body.price : template.price,
        type: body.type,
      },
      { withStatus: false }
    );
    // a plain rename (no new structure) renames the single component so the derived title follows
    if (body.title !== undefined && body.work === undefined && body.parts === undefined) applyTitleRename(merged, body.title);
    const title = deriveTitle(merged);
    if (!title) throw ApiError.badRequest(MSG.title);
    if (titleKeyOf(title) !== template.titleKey) await assertUniqueTitle(title, template._id);
    template.title = title;
    template.work = merged.work;
    template.parts = merged.parts;
    template.price = merged.price;
  }
  if (body.category !== undefined) template.category = parseCategory(body.category, template.category);
  if (body.active !== undefined) template.active = parseBool(body.active, template.active);
  if (body.order !== undefined) template.order = parseOrder(body.order) ?? 0;

  await template.save();
  res.json({ success: true, data: templateRow(template) });
});

/** DELETE /api/templates/:id -> hard delete when never used, otherwise soft delete (spec 3.8) */
export const deleteTemplate = asyncHandler(async (req, res) => {
  const template = await loadTemplate(req.params.id);

  if ((template.usageCount || 0) === 0) {
    await template.deleteOne();
    return res.json({ success: true, data: { deleted: true, deactivated: false } });
  }

  template.active = false;
  await template.save();
  return res.json({ success: true, data: { deleted: false, deactivated: true } });
});

/**
 * Service bundles API (חבילות טיפול): named sets of tasks. Small catalog, not paged.
 *   GET    /api/bundles            ?q= &active=1|all            -> { bundles: [BundleRow] }
 *   POST   /api/bundles            { title, description, kind, items, order }
 *   PUT    /api/bundles/:id        whitelist: title, description, kind, items, active, order
 *   DELETE /api/bundles/:id        hard delete when never used, otherwise soft delete
 * A line names a catalog template (its task is copied, `qty` may override a single part) or carries
 * its own task fields (work / parts / price, or a bare title). BundleRow lines carry `total` / `priced`.
 */
import mongoose from 'mongoose';
import ServiceBundle from '../models/ServiceBundle.js';
import WorkItemTemplate from '../models/WorkItemTemplate.js';
import { SERVICE_KINDS } from '../models/Service.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { titleKeyOf, escapeRegex } from '../utils/normalize.js';
import { normalizeTask, copyTaskFields, deriveTitle, taskTotal, taskPriced, TASK_MSG } from '../utils/tasks.js';

const MAX_ITEMS = 100;

export const MSG = {
  notFound: 'החבילה לא נמצאה',
  duplicate: 'חבילה בשם זה כבר קיימת',
  title: 'שם החבילה הוא שדה חובה',
  noItems: 'חבילה חייבת להכיל לפחות פריט אחד',
  tooManyItems: `חבילה יכולה להכיל עד ${MAX_ITEMS} פריטים`,
  kind: 'סוג טיפול לא חוקי',
  number: 'ערך מספרי לא תקין',
};

const isBlank = (v) => v === undefined || v === null || v === '';
const cleanText = (v) => (isBlank(v) ? '' : String(v).trim());

const parseNumber = (v, { min, message } = {}) => {
  if (isBlank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || (min != null && n < min)) throw ApiError.badRequest(message || MSG.number);
  return n;
};

const parseBool = (v, fallback) => {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return !['false', '0', ''].includes(v.toLowerCase());
  return Boolean(v);
};

/** blank -> null (no suggested kind); otherwise one of SERVICE_KINDS. */
const parseKind = (v) => {
  if (isBlank(v) || v === 'none') return null;
  if (!SERVICE_KINDS.includes(v)) throw ApiError.badRequest(MSG.kind);
  return v;
};

/**
 * Body lines -> clean line sub-documents. A line that names an existing template copies its task
 * (own work / parts / price win when given; a legacy `qty` sets the quantity of a single part);
 * an unknown template ref is dropped and the line keeps whatever it carries.
 */
const sanitizeLines = async (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) throw ApiError.badRequest(MSG.noItems);
  if (raw.length > MAX_ITEMS) throw ApiError.badRequest(MSG.tooManyItems);

  const refIds = raw
    .map((line) => (line && typeof line === 'object' ? line.template : null))
    .filter((id) => !isBlank(id) && mongoose.isValidObjectId(String(id)))
    .map(String);
  const templates = refIds.length ? await WorkItemTemplate.find({ _id: { $in: refIds } }).lean() : [];
  const byId = new Map(templates.map((t) => [String(t._id), t]));

  return raw.map((line) => {
    const src = line && typeof line === 'object' ? line : { title: line };
    const tpl = !isBlank(src.template) && byId.has(String(src.template)) ? byId.get(String(src.template)) : null;
    const hasOwnStructure = src.work !== undefined || src.parts !== undefined;
    let task;
    if (tpl && !hasOwnStructure) {
      task = copyTaskFields(tpl);
      if (!isBlank(src.qty) && task.parts.length === 1) {
        task.parts[0].qty = parseNumber(src.qty, { min: 1, message: TASK_MSG.qty });
      }
      if (src.price !== undefined) task.price = parseNumber(src.price, { min: 0, message: TASK_MSG.price });
      if (!isBlank(src.title) && !tpl.work && task.parts.length === 1) {
        task.parts[0].title = cleanText(src.title).slice(0, 200);
        task.title = task.parts[0].title;
      }
    } else {
      const normalized = normalizeTask(src, { withStatus: false });
      task = { title: normalized.title, work: normalized.work, parts: normalized.parts, price: normalized.price };
    }
    return {
      template: tpl ? tpl._id : null,
      title: deriveTitle(task),
      work: task.work,
      parts: task.parts,
      price: task.price,
      notes: cleanText(src.notes).slice(0, 500),
    };
  });
};

/** Pre-check for a duplicate title (the unique index on titleKey is the backstop). */
const assertUniqueTitle = async (title, excludeId = null) => {
  const query = { titleKey: titleKeyOf(title) };
  if (excludeId) query._id = { $ne: excludeId };
  const clash = await ServiceBundle.exists(query);
  if (clash) throw ApiError.badRequest(MSG.duplicate);
};

const loadBundle = async (id) => {
  if (!mongoose.isValidObjectId(String(id))) throw ApiError.notFound(MSG.notFound);
  const bundle = await ServiceBundle.findById(id);
  if (!bundle) throw ApiError.notFound(MSG.notFound);
  return bundle;
};

/** Bundle document (items.template populated with `active`) -> API row with totals per line. */
export const toBundleRow = (doc) => {
  const b = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const items = (b.items || []).map((line) => {
    const tpl = line.template && typeof line.template === 'object' ? line.template : null;
    return {
      _id: line._id,
      template: tpl ? tpl._id : line.template || null,
      title: line.title,
      work: line.work ? { title: line.work.title, price: line.work.price ?? null } : null,
      parts: (line.parts || []).map((p) => ({ _id: p._id, title: p.title, qty: p.qty ?? 1, price: p.price ?? null })),
      price: line.price ?? null,
      total: taskTotal(line),
      priced: taskPriced(line),
      templateActive: tpl ? tpl.active !== false : null,
      notes: line.notes || '',
    };
  });
  return {
    _id: b._id,
    title: b.title,
    titleKey: b.titleKey,
    description: b.description || '',
    kind: b.kind || null,
    items,
    itemsCount: items.length,
    usageCount: b.usageCount || 0,
    lastUsedAt: b.lastUsedAt || null,
    active: b.active !== false,
    order: b.order || 0,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
};

const loadRow = async (id) => {
  const doc = await ServiceBundle.findById(id).populate('items.template', 'active').lean();
  return doc ? toBundleRow(doc) : null;
};

/** GET /api/bundles -> { bundles } */
export const listBundles = asyncHandler(async (req, res) => {
  const q = req.query || {};
  const match = {};
  const search = cleanText(q.q);
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    match.$or = [{ title: rx }, { description: rx }, { 'items.title': rx }, { 'items.parts.title': rx }];
  }
  if (String(q.active ?? '1') !== 'all') match.active = true;

  const docs = await ServiceBundle.find(match)
    .sort({ order: 1, usageCount: -1, title: 1 })
    .populate('items.template', 'active')
    .lean();

  res.json({ success: true, data: { bundles: docs.map(toBundleRow) } });
});

/** POST /api/bundles */
export const createBundle = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const title = cleanText(body.title);
  if (!title) throw ApiError.badRequest(MSG.title);
  await assertUniqueTitle(title);
  const items = await sanitizeLines(body.items);

  const bundle = await ServiceBundle.create({
    title,
    description: cleanText(body.description).slice(0, 500),
    kind: parseKind(body.kind),
    items,
    order: parseNumber(body.order) ?? 0,
  });

  res.status(201).json({ success: true, data: await loadRow(bundle._id) });
});

/** PUT /api/bundles/:id  whitelist: title, description, kind, items, active, order */
export const updateBundle = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const bundle = await loadBundle(req.params.id);

  if (body.title !== undefined) {
    const title = cleanText(body.title);
    if (!title) throw ApiError.badRequest(MSG.title);
    if (titleKeyOf(title) !== bundle.titleKey) await assertUniqueTitle(title, bundle._id);
    bundle.title = title;
  }
  if (body.description !== undefined) bundle.description = cleanText(body.description).slice(0, 500);
  if (body.kind !== undefined) bundle.kind = parseKind(body.kind);
  if (body.items !== undefined) bundle.items = await sanitizeLines(body.items);
  if (body.active !== undefined) bundle.active = parseBool(body.active, bundle.active);
  if (body.order !== undefined) bundle.order = parseNumber(body.order) ?? 0;

  await bundle.save();
  res.json({ success: true, data: await loadRow(bundle._id) });
});

/** DELETE /api/bundles/:id -> { deleted, deactivated } (hard when never used, otherwise soft) */
export const deleteBundle = asyncHandler(async (req, res) => {
  const bundle = await loadBundle(req.params.id);

  if ((bundle.usageCount || 0) === 0) {
    await bundle.deleteOne();
    return res.json({ success: true, data: { deleted: true, deactivated: false } });
  }

  bundle.active = false;
  await bundle.save();
  return res.json({ success: true, data: { deleted: false, deactivated: true } });
});

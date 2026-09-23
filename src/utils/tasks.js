/**
 * Task (רשומה) helpers shared by services, the catalog and bundles.
 * A task = optional work (העבודה, labor with a price) + parts (הפריטים, each with a quantity and a UNIT price)
 * + an optional record price that overrides the components. Its display title is derived:
 * the work title, else the first part title.
 */
import mongoose from 'mongoose';
import ApiError from './ApiError.js';
import { titleKeyOf, round2 } from './normalize.js';

export const TASK_MSG = {
  itemTitle: 'שם הפריט הוא שדה חובה',
  partTitle: 'שם החלק הוא שדה חובה',
  qty: 'כמות חייבת להיות לפחות 1',
  price: 'מחיר לא יכול להיות שלילי',
  tooManyParts: 'רשומה יכולה להכיל עד 50 חלקים',
};

const MAX_PARTS = 50;
const MAX_TITLE = 200;

const isBlank = (v) => v === undefined || v === null || v === '';
const cleanText = (v) => (isBlank(v) ? '' : String(v).trim());

const parsePrice = (v) => {
  if (isBlank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest(TASK_MSG.price);
  return round2(n);
};

const parseQty = (v) => {
  if (isBlank(v)) return 1;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw ApiError.badRequest(TASK_MSG.qty);
  return Math.round(n);
};

const parseBool = (v, fallback) => {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return !['false', '0', ''].includes(v.toLowerCase());
  return Boolean(v);
};

const plain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : v);

/** Titles that read like an action ('החלפת', 'בדיקת', 'כיוון'...) become labor when a bare title arrives. */
const WORK_PREFIX_RE =
  /^(החלפת|החלפה|בדיקת|בדיקה|בדיקות|ניקוי|כיוון|כוונון|איזון|תיקון|מילוי|טיפול|שטיפת|שטיפה|צביעת|צביעה|התקנת|התקנה|פירוק|הרכבת|הרכבה|ריתוך|שירות|ייעוץ|טסט|אבחון|הסרת|הסרה|חידוש|ליטוש|שאיבת|שאיבה|ניפוח|גירוז|ריפוד|הברגת)(?![א-ת])/;

export const guessTaskType = (title) => (WORK_PREFIX_RE.test(cleanText(title)) ? 'work' : 'part');

/** Body part -> { title, qty, price } (price = unit price). */
export function sanitizePart(raw) {
  const src = raw && typeof raw === 'object' ? raw : { title: raw };
  const title = cleanText(src.title).slice(0, MAX_TITLE);
  if (!title) throw ApiError.badRequest(TASK_MSG.partTitle);
  return { title, qty: parseQty(src.qty), price: parsePrice(src.price) };
}

/** Display title of a task: the work, else the first part, else whatever title it carries. */
export const deriveTitle = (task) => {
  const t = plain(task) || {};
  return cleanText(t.work?.title) || cleanText(t.parts?.[0]?.title) || cleanText(t.title);
};

/** Money the task adds up to: the record price when set, else labor + sum of qty x unit price. */
export function taskTotal(task) {
  const t = plain(task) || {};
  if (t.price != null) return round2(t.price);
  let sum = 0;
  if (t.work?.price != null) sum += Number(t.work.price) || 0;
  for (const p of t.parts || []) {
    if (p?.price != null) sum += (Number(p.qty) || 1) * (Number(p.price) || 0);
  }
  return round2(sum);
}

/** True when any price was entered on the task (record, labor or a part). */
export function taskPriced(task) {
  const t = plain(task) || {};
  return t.price != null || t.work?.price != null || (t.parts || []).some((p) => p?.price != null);
}

/**
 * Body task -> clean fields { title, work, parts, price, notes, template, done? }.
 * Also accepts the flat legacy shape { title, qty, price } (one part with the record price) and a bare title;
 * `type` ('work' | 'part') says what a bare title becomes, otherwise the title is guessed.
 * @param {object|string} raw
 * @param {{ defaultDone?: boolean, withStatus?: boolean }} options - withStatus false skips `done` (catalog, bundles)
 */
export function normalizeTask(raw, { defaultDone = true, withStatus = true } = {}) {
  const src = raw && typeof raw === 'object' ? plain(raw) : { title: raw };
  const title = cleanText(src.title).slice(0, MAX_TITLE);

  let work = null;
  if (src.work && typeof src.work === 'object') {
    const workTitle = cleanText(src.work.title).slice(0, MAX_TITLE) || title;
    if (workTitle) work = { title: workTitle, price: parsePrice(src.work.price) };
  }

  const rawParts = Array.isArray(src.parts) ? src.parts : [];
  if (rawParts.length > MAX_PARTS) throw ApiError.badRequest(TASK_MSG.tooManyParts);
  let parts = rawParts.map(sanitizePart);

  if (!work && parts.length === 0) {
    if (!title) throw ApiError.badRequest(TASK_MSG.itemTitle);
    const type = src.type === 'work' || src.type === 'part' ? src.type : guessTaskType(title);
    if (type === 'work') work = { title, price: null };
    else parts = [{ title, qty: parseQty(src.qty), price: null }];
  }

  const out = {
    title: title || deriveTitle({ work, parts }),
    work,
    parts,
    price: parsePrice(src.price),
    notes: cleanText(src.notes),
    template: !isBlank(src.template) && mongoose.isValidObjectId(String(src.template)) ? src.template : null,
  };
  if (withStatus) {
    out.done = parseBool(src.done, defaultDone);
    // the engine oil type chosen on the visit (service items only; templates and bundles drop it)
    out.oilType = cleanText(src.oilType).slice(0, 30);
  }
  return out;
}

/** Renames a task through its single component (the work, or the only part) so the derived title follows. */
export function applyTitleRename(task, title) {
  const clean = cleanText(title).slice(0, MAX_TITLE);
  if (!clean) return task;
  task.title = clean;
  if (task.work) task.work.title = clean;
  else if (task.parts?.length === 1) task.parts[0].title = clean;
  return task;
}

/** Deep plain copy of the task fields (for copying a template into a service, or a task into a bundle). */
export function copyTaskFields(task) {
  const t = plain(task) || {};
  return {
    title: deriveTitle(t) || cleanText(t.title),
    work: t.work ? { title: t.work.title, price: t.work.price ?? null } : null,
    parts: (t.parts || []).map((p) => ({ title: p.title, qty: p.qty ?? 1, price: p.price ?? null })),
    price: t.price ?? null,
  };
}

/**
 * Copies the prices of a used task back onto a catalog template (the last price becomes the next default).
 * Matches parts by title. Returns true when something changed.
 */
export function refreshTemplatePrices(template, task) {
  const t = plain(task) || {};
  let changed = false;
  if (t.work?.price != null && template.work) {
    template.work.price = t.work.price;
    changed = true;
  }
  const usedParts = new Map((t.parts || []).map((p) => [titleKeyOf(p.title), p]));
  for (const tp of template.parts || []) {
    const used = usedParts.get(titleKeyOf(tp.title));
    if (used && used.price != null) {
      tp.price = used.price;
      changed = true;
    }
  }
  if (t.price != null) {
    template.price = t.price;
    changed = true;
  }
  return changed;
}

/** API row of a catalog template: the document plus its computed total / priced flags. */
export function templateRow(doc) {
  if (!doc) return null;
  const t = plain(doc);
  return {
    _id: t._id,
    title: t.title,
    titleKey: t.titleKey,
    category: t.category,
    work: t.work ? { title: t.work.title, price: t.work.price ?? null } : null,
    parts: (t.parts || []).map((p) => ({ _id: p._id, title: p.title, qty: p.qty ?? 1, price: p.price ?? null })),
    price: t.price ?? null,
    total: taskTotal(t),
    priced: taskPriced(t),
    usageCount: t.usageCount || 0,
    lastUsedAt: t.lastUsedAt || null,
    active: t.active !== false,
    order: t.order || 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * Suggestion indexes for the task editor: distinct works and parts across active templates,
 * each with the last known price. Later templates never override an already indexed title.
 */
export function catalogIndexes(templates) {
  const works = new Map();
  const parts = new Map();
  for (const t of templates || []) {
    if (t.work?.title) {
      const key = titleKeyOf(t.work.title);
      if (!works.has(key)) works.set(key, { title: t.work.title, price: t.work.price ?? null });
      else if (works.get(key).price == null && t.work.price != null) works.get(key).price = t.work.price;
    }
    for (const p of t.parts || []) {
      const key = titleKeyOf(p.title);
      if (!parts.has(key)) parts.set(key, { title: p.title, price: p.price ?? null });
      else if (parts.get(key).price == null && p.price != null) parts.get(key).price = p.price;
    }
  }
  return { works: [...works.values()], parts: [...parts.values()] };
}

/**
 * Services API (spec 4.4). Every money / item / payment mutation goes through findById + mutate + save()
 * so the Service pre-validate hook (recalc, status dates, history) runs. Never updateOne money fields.
 */
import mongoose from 'mongoose';
import dayjs from 'dayjs';
import Service, { SERVICE_KINDS, SERVICE_STATUSES, PAYMENT_METHODS, TOTAL_MODES, OTHER_LABEL_MAX, normalizeKinds, kindsOf } from '../models/Service.js';
import Vehicle from '../models/Vehicle.js';
import Customer from '../models/Customer.js';
import WorkItemTemplate from '../models/WorkItemTemplate.js';
import ServiceBundle from '../models/ServiceBundle.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parsePaging, listResponse } from '../utils/paging.js';
import { normalizePlate, isValidPlate, titleKeyOf, escapeRegex } from '../utils/normalize.js';
import { startOfDay, addDays } from '../utils/dates.js';
import { recomputeVehicleStats } from '../utils/annual.js';
import { carryItems, commitCarry, uncarryFrom, recarryFrom, uncarryItem } from '../utils/carry.js';
import { deleteServicesCascade } from '../utils/cascade.js';
import { normalizeTask, applyTitleRename, deriveTitle, refreshTemplatePrices, templateRow } from '../utils/tasks.js';
import {
  selectServiceRows,
  toServiceRow,
  loadServiceFull,
  openItemsOfVehicle,
  vehicleRowOf,
} from '../utils/serviceRows.js';

const OPEN_STATUSES = ['pending', 'in_progress'];
const CREATE_STATUSES = ['pending', 'in_progress', 'done'];

/** Whitelisted status transitions (spec 3.3), validated against the CURRENT DB status. */
const TRANSITIONS = {
  pending: ['in_progress', 'done', 'cancelled'],
  in_progress: ['pending', 'done', 'cancelled'],
  done: ['in_progress', 'cancelled'],
  cancelled: ['pending'],
};

const MSG = {
  notFound: 'הטיפול לא נמצא',
  itemCarried: 'הפריט הועבר לטיפול מאוחר יותר, סמן אותו כבוצע שם',
  vehicleNotFound: 'הרכב לא נמצא',
  customerNotFound: 'הלקוח לא נמצא',
  itemNotFound: 'הפריט לא נמצא',
  paymentNotFound: 'התשלום לא נמצא',
  cancelled: 'הטיפול בוטל, שחזר אותו כדי לערוך',
  badTransition: 'מעבר סטטוס לא חוקי',
  noContent: 'הוסף לפחות פריט אחד או הערה',
  pickCustomer: 'יש לבחור לקוח או ליצור לקוח חדש',
  badPlate: 'מספר רכב חייב להכיל 7 או 8 ספרות',
  priceBeforePayment: 'יש לקבוע מחיר לטיפול לפני רישום תשלום',
  amountPositive: 'סכום חייב להיות גדול מאפס',
  carriedForward: 'הפריט הועבר לטיפול מאוחר יותר, מחק אותו שם',
  itemTitle: 'שם הפריט הוא שדה חובה',
  badDate: 'תאריך לא תקין',
  badNumber: 'ערך מספרי לא תקין',
  badKind: 'סוג טיפול לא חוקי',
  otherLabelLong: `שם הטיפול עד ${OTHER_LABEL_MAX} תווים`,
  badStatus: 'סטטוס לא חוקי',
  badMethod: 'אמצעי תשלום לא חוקי',
  badTotalMode: 'מצב חישוב מחיר לא חוקי',
  badId: 'מזהה לא תקין',
  noCarryItems: 'לא נבחרו פריטים להעברה',
  badOrder: 'סדר הפריטים לא תקין',
};

/* ------------------------------------------------------------------ parsing helpers */

const isBlank = (v) => v === undefined || v === null || v === '';

/** ISO / 'YYYY-MM-DD' (local midnight) -> Date; blank -> null; invalid -> 400. */
const parseDate = (v) => {
  if (isBlank(v)) return null;
  const d = dayjs(v);
  if (!d.isValid()) throw ApiError.badRequest(MSG.badDate);
  return d.toDate();
};

/** blank -> null; otherwise a finite number >= min, else 400. */
const parseNumber = (v, { min = 0, message = MSG.badNumber } = {}) => {
  if (isBlank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw ApiError.badRequest(message);
  return n;
};

const parseBool = (v, fallback) => {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return !['false', '0', ''].includes(v.toLowerCase());
  return Boolean(v);
};

const cleanText = (v) => (isBlank(v) ? '' : String(v).trim());

const assertObjectId = (id, message = MSG.badId) => {
  if (!mongoose.isValidObjectId(String(id))) throw ApiError.badRequest(message);
  return id;
};

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** Body task (work + parts + record price, or the flat legacy { title, qty, price }) -> clean sub-document data. */
const sanitizeItem = (raw, { defaultDone = true } = {}) => normalizeTask(raw, { defaultDone, withStatus: true });

/**
 * The tags of a visit from `body.kinds` (array or comma list) or the old single `body.kind`:
 * one to four known kinds in canonical order; blank -> fallback; an unknown value -> 400.
 */
const parseKinds = (body, fallback = ['repair']) => {
  const raw = body.kinds !== undefined ? body.kinds : body.kind;
  if (isBlank(raw) || (Array.isArray(raw) && raw.length === 0)) return fallback;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const values = list.map((k) => String(k).trim()).filter(Boolean);
  if (!values.length) return fallback;
  if (values.some((k) => !SERVICE_KINDS.includes(k))) throw ApiError.badRequest(MSG.badKind);
  return normalizeKinds(values);
};

/** The name of an 'אחר' visit: trimmed, up to OTHER_LABEL_MAX characters. */
const parseOtherLabel = (v) => {
  const text = cleanText(v);
  if (text.length > OTHER_LABEL_MAX) throw ApiError.badRequest(MSG.otherLabelLong);
  return text;
};

const sameKinds = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

const parseTotalMode = (v, fallback = 'items') => {
  if (isBlank(v)) return fallback;
  if (!TOTAL_MODES.includes(v)) throw ApiError.badRequest(MSG.badTotalMode);
  return v;
};

const parseMethod = (v, fallback = 'cash') => {
  if (isBlank(v)) return fallback;
  if (!PAYMENT_METHODS.includes(v)) throw ApiError.badRequest(MSG.badMethod);
  return v;
};

/* ------------------------------------------------------------------ loading helpers */

/** Loads a Service document for mutation (hooks run on save). 404 with the Hebrew message. */
const loadService = async (id) => {
  if (!mongoose.isValidObjectId(String(id))) throw ApiError.notFound(MSG.notFound);
  const service = await Service.findById(id);
  if (!service) throw ApiError.notFound(MSG.notFound);
  return service;
};

const assertEditable = (service) => {
  if (service.status === 'cancelled') throw ApiError.badRequest(MSG.cancelled);
};

/**
 * Payment rule (spec 3.2): a payment needs a price to be paid against - priced done items, or a manual
 * total the owner actually typed. Manual mode with an empty total is still "no price".
 */
const assertCanAcceptPayment = (service) => {
  service.recalc();
  if (service.totalPrice <= 0.005) throw ApiError.badRequest(MSG.priceBeforePayment);
};

const customerRefOf = (customer) =>
  customer ? { _id: customer._id, fullName: customer.fullName, phone: customer.phone || '' } : null;

/* ------------------------------------------------------------------ side effects */

/** Mileage max rule (spec 3.6): a higher service reading raises the vehicle reading, never lowers it. */
const applyMileageRule = async (vehicleId, mileage) => {
  if (mileage == null) return;
  await Vehicle.updateOne(
    { _id: vehicleId, $or: [{ mileage: null }, { mileage: { $lt: mileage } }] },
    { $set: { mileage, mileageUpdatedAt: new Date() } }
  );
};

/**
 * Template usage bump (spec 2.6). For every task linked to a catalog entry (by ref or by title):
 * usageCount + 1, lastUsedAt, and the prices used become the template's next prices. Parts of a task
 * also refresh the price of the part-only catalog entry with the same title.
 * Fire-and-forget: the caller does not await it.
 */
const bumpTemplateUsage = async (items) => {
  const now = new Date();
  const byTemplateId = new Map();
  const byTitleKey = new Map();
  const partByKey = new Map();
  for (const it of items || []) {
    if (it.template) byTemplateId.set(String(it.template), it);
    else {
      const key = titleKeyOf(deriveTitle(it) || it.title);
      if (key) byTitleKey.set(key, it);
    }
    for (const p of it.parts || []) {
      if (p.price != null) partByKey.set(titleKeyOf(p.title), p);
    }
  }
  if (byTitleKey.size) {
    const matches = await WorkItemTemplate.find({ active: true, titleKey: { $in: [...byTitleKey.keys()] } })
      .select('_id titleKey')
      .lean();
    for (const t of matches) {
      if (!byTemplateId.has(String(t._id))) byTemplateId.set(String(t._id), byTitleKey.get(t.titleKey));
    }
  }
  const templates = byTemplateId.size ? await WorkItemTemplate.find({ _id: { $in: [...byTemplateId.keys()] } }) : [];
  for (const template of templates) {
    template.usageCount = (template.usageCount || 0) + 1;
    template.lastUsedAt = now;
    refreshTemplatePrices(template, byTemplateId.get(String(template._id)));
    await template.save();
  }
  // part-only catalog entries named like a part that was priced inside another task
  if (partByKey.size) {
    const touched = new Set(templates.map((t) => String(t._id)));
    const partTemplates = await WorkItemTemplate.find({ active: true, work: null, titleKey: { $in: [...partByKey.keys()] } });
    for (const template of partTemplates) {
      if (touched.has(String(template._id)) || template.parts.length !== 1) continue;
      const used = partByKey.get(template.titleKey);
      if (!used) continue;
      template.parts[0].price = used.price;
      await template.save();
    }
  }
};

const bumpTemplateUsageInBackground = (items) => {
  if (!items?.length) return;
  bumpTemplateUsage(items).catch((err) => {
    console.error('template usage bump failed:', err?.message || err);
  });
};

const MAX_BUNDLES = 20;

/** body.bundles -> unique valid ids of the bundles applied to this request (usage stats only). */
const parseBundleIds = (raw) => {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id) => !isBlank(id) && mongoose.isValidObjectId(String(id))).map(String);
  return [...new Set(ids)].slice(0, MAX_BUNDLES);
};

const bumpBundleUsageInBackground = (bundleIds) => {
  if (!bundleIds?.length) return;
  ServiceBundle.bumpUsage(bundleIds).catch((err) => {
    console.error('bundle usage bump failed:', err?.message || err);
  });
};

/* ------------------------------------------------------------------ list filters */

const parseStatusFilter = (raw) => {
  const tokens = String(raw ?? 'open')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.includes('all')) return null;
  const set = new Set();
  for (const t of tokens) {
    if (t === 'open') OPEN_STATUSES.forEach((s) => set.add(s));
    else if (SERVICE_STATUSES.includes(t)) set.add(t);
  }
  if (!set.size) OPEN_STATUSES.forEach((s) => set.add(s));
  return [...set];
};

const parseKindFilter = (raw) => {
  const kinds = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((k) => SERVICE_KINDS.includes(k));
  return kinds.length ? kinds : null;
};

const SORT_FIELDS = ['openedAt', 'completedAt', 'balance', 'updatedAt'];

/** GET /api/services */
export const listServices = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePaging(req.query);
  const q = req.query;
  const match = {};

  const statuses = parseStatusFilter(q.status);
  if (statuses) match.status = statuses.length === 1 ? statuses[0] : { $in: statuses };

  const kinds = parseKindFilter(q.kind);
  if (kinds) match.kinds = kinds.length === 1 ? kinds[0] : { $in: kinds };

  const payment = cleanText(q.payment);
  if (payment === 'open') {
    match.balance = { $gt: 0.005 };
    if (!match.status) match.status = { $ne: 'cancelled' };
    else if (statuses.includes('cancelled')) {
      match.status = { $in: statuses.filter((s) => s !== 'cancelled') };
    }
  } else if (['unpaid', 'partial', 'paid'].includes(payment)) {
    match.paymentStatus = payment;
  }

  if (!isBlank(q.vehicle)) match.vehicle = assertObjectId(q.vehicle);
  if (!isBlank(q.customer)) match.customer = assertObjectId(q.customer);

  const search = cleanText(q.q);
  if (search) {
    const digits = normalizePlate(search);
    if (digits && digits.length === search.replace(/[\s-]/g, '').length) {
      match.plateNumber = new RegExp('^' + escapeRegex(digits));
    } else {
      const rx = new RegExp(escapeRegex(search), 'i');
      const customers = await Customer.find({ fullName: rx }).select('_id').lean();
      const or = [{ 'items.title': rx }];
      if (customers.length) or.push({ customer: { $in: customers.map((c) => c._id) } });
      match.$or = or;
    }
  }

  const from = parseDate(q.from);
  const to = parseDate(q.to);
  if (from || to) {
    match.openedAt = {};
    if (from) match.openedAt.$gte = startOfDay(from);
    if (to) match.openedAt.$lt = addDays(startOfDay(to), 1);
  }

  const sortBy = SORT_FIELDS.includes(q.sortBy) ? q.sortBy : 'openedAt';
  const dir = String(q.order || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const sort = { [sortBy]: dir, _id: dir };

  const [rows, total] = await Promise.all([
    selectServiceRows(Service.find(match).sort(sort).skip(skip).limit(limit)).lean(),
    Service.countDocuments(match),
  ]);

  return listResponse(res, rows.map(toServiceRow), total, page, limit);
});

/** GET /api/services/:id */
export const getService = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(String(req.params.id))) throw ApiError.notFound(MSG.notFound);
  const service = await loadServiceFull(req.params.id);
  if (!service) throw ApiError.notFound(MSG.notFound);

  const vehicleId = service.vehicle?._id ?? service.vehicle;
  const ownerId = service.vehicle?.customer ?? null;
  const billedId = service.customer?._id ?? service.customer;
  const differentOwner = Boolean(ownerId && billedId && !sameId(ownerId, billedId));

  const [openItemsElsewhere, quickTemplates] = await Promise.all([
    vehicleId ? openItemsOfVehicle(vehicleId, { excludeServiceId: service._id }) : [],
    WorkItemTemplate.find({ active: true }).sort({ order: 1, usageCount: -1, title: 1 }).limit(10).lean(),
  ]);

  res.json({ success: true, data: { service, differentOwner, openItemsElsewhere, quickTemplates: quickTemplates.map(templateRow) } });
});

/* ------------------------------------------------------------------ create */

const NEW_VEHICLE_FIELDS = ['make', 'model', 'year', 'color', 'fuelType', 'engineNotes', 'mileage', 'notes'];
const NEW_CUSTOMER_FIELDS = ['fullName', 'phone', 'phone2', 'email', 'notes'];

const pick = (src, fields) => {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
};

/**
 * Resolution order (spec 4.4): vehicle id -> plateNumber lookup -> create customer + vehicle.
 * Returns { vehicle, createdVehicle, createdCustomer }.
 */
const resolveVehicle = async (body) => {
  if (!isBlank(body.vehicle)) {
    if (!mongoose.isValidObjectId(String(body.vehicle))) throw ApiError.notFound(MSG.vehicleNotFound);
    const vehicle = await Vehicle.findById(body.vehicle);
    if (!vehicle) throw ApiError.notFound(MSG.vehicleNotFound);
    return { vehicle, createdVehicle: false, createdCustomer: false };
  }

  const plateNumber = normalizePlate(body.plateNumber);
  if (!isValidPlate(plateNumber)) throw ApiError.badRequest(MSG.badPlate);

  const existing = await Vehicle.findOne({ plateNumber });
  if (existing) return { vehicle: existing, createdVehicle: false, createdCustomer: false };

  // new vehicle: needs an owner (existing customer id or a new customer)
  let customer = null;
  let createdCustomer = false;
  if (!isBlank(body.customer)) {
    if (!mongoose.isValidObjectId(String(body.customer))) throw ApiError.notFound(MSG.customerNotFound);
    customer = await Customer.findById(body.customer);
    if (!customer) throw ApiError.notFound(MSG.customerNotFound);
  } else if (body.newCustomer && typeof body.newCustomer === 'object') {
    const data = pick(body.newCustomer, NEW_CUSTOMER_FIELDS);
    if (!cleanText(data.fullName)) throw ApiError.badRequest('שם מלא הוא שדה חובה');
    customer = await Customer.create(data);
    createdCustomer = true;
  } else {
    throw ApiError.badRequest(MSG.pickCustomer);
  }

  const data = pick(body.newVehicle, NEW_VEHICLE_FIELDS);
  // blank strings must not reach enum / number fields
  for (const key of Object.keys(data)) if (isBlank(data[key])) delete data[key];
  let vehicle;
  try {
    const mileage = parseNumber(data.mileage);
    const year = parseNumber(data.year, { min: 1950, message: 'שנת ייצור לא תקינה' });
    vehicle = await Vehicle.create({
      ...data,
      year,
      mileage,
      mileageUpdatedAt: mileage != null ? new Date() : null,
      plateNumber,
      customer: customer._id,
    });
  } catch (err) {
    // The vehicle was rejected: do not leave the customer we just created as an orphan.
    if (createdCustomer) await Customer.deleteOne({ _id: customer._id }).catch(() => {});
    throw err;
  }
  return { vehicle, createdVehicle: true, createdCustomer };
};

/** POST /api/services */
export const createService = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const status = isBlank(body.status) ? 'pending' : body.status;
  if (!CREATE_STATUSES.includes(status)) throw ApiError.badRequest(MSG.badStatus);
  const kinds = parseKinds(body);
  const otherLabel = kinds.includes('other') ? parseOtherLabel(body.otherLabel) : '';
  const totalMode = parseTotalMode(body.totalMode);
  const manualTotal = parseNumber(body.manualTotal, { min: 0, message: 'מחיר לא יכול להיות שלילי' });
  const mileage = parseNumber(body.mileage);
  const openedAt = parseDate(body.openedAt) || new Date();
  const completedAt = status === 'done' ? parseDate(body.completedAt) : null;
  const notes = cleanText(body.notes);
  const items = (Array.isArray(body.items) ? body.items : []).map((it) => sanitizeItem(it));
  const carryRefs = Array.isArray(body.carryItems) ? body.carryItems : [];
  const bundleIds = parseBundleIds(body.bundles);

  // a visit may start empty: the tasks are added on its page (2026-09-23)
  const { vehicle, createdVehicle, createdCustomer } = await resolveVehicle(body);

  const service = new Service({
    vehicle: vehicle._id,
    customer: vehicle.customer,
    plateNumber: vehicle.plateNumber,
    kinds,
    kind: kinds[0],
    otherLabel,
    status,
    openedAt,
    completedAt,
    mileage,
    notes,
    items,
    totalMode,
    manualTotal,
  });

  const { sources } = await carryItems(service, carryRefs);

  const payment = body.payment && typeof body.payment === 'object' ? body.payment : null;
  if (payment && !isBlank(payment.amount)) {
    const amount = parseNumber(payment.amount, { min: 0.01, message: MSG.amountPositive });
    assertCanAcceptPayment(service);
    service.payments.push({
      amount,
      method: parseMethod(payment.method),
      paidAt: parseDate(payment.paidAt) || new Date(),
      note: cleanText(payment.note),
    });
  }

  await service.save();
  await commitCarry(sources);
  bumpTemplateUsageInBackground(items);
  bumpBundleUsageInBackground(bundleIds);
  await applyMileageRule(vehicle._id, service.mileage);
  await recomputeVehicleStats(vehicle._id);

  const [full, vehicleRow, owner] = await Promise.all([
    loadServiceFull(service._id),
    vehicleRowOf(vehicle._id),
    Customer.findById(vehicle.customer).select('fullName phone').lean(),
  ]);

  res.status(201).json({
    success: true,
    data: {
      service: full,
      vehicle: vehicleRow,
      customer: customerRefOf(owner),
      createdVehicle,
      createdCustomer,
    },
  });
});

/* ------------------------------------------------------------------ update / status */

/** PUT /api/services/:id */
export const updateService = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  let recompute = false;
  let mileageChanged = false;

  if (body.kinds !== undefined || body.kind !== undefined) {
    const current = kindsOf(service);
    const kinds = parseKinds(body, current);
    if (!sameKinds(kinds, current)) {
      service.kinds = kinds;
      service.kind = kinds[0];
      recompute = true;
    }
  }
  if (body.otherLabel !== undefined) service.otherLabel = parseOtherLabel(body.otherLabel);
  if (body.openedAt !== undefined) {
    const openedAt = parseDate(body.openedAt);
    if (openedAt) {
      service.openedAt = openedAt;
      recompute = true;
    }
  }
  if (body.completedAt !== undefined && service.status === 'done') {
    const completedAt = parseDate(body.completedAt);
    if (completedAt) {
      service.completedAt = completedAt;
      recompute = true;
    }
  }
  if (body.mileage !== undefined) {
    const mileage = parseNumber(body.mileage);
    if (mileage !== (service.mileage ?? null)) {
      service.mileage = mileage;
      recompute = true;
      mileageChanged = true;
    }
  }
  if (body.notes !== undefined) service.notes = cleanText(body.notes);
  if (body.totalMode !== undefined) service.totalMode = parseTotalMode(body.totalMode, service.totalMode);
  if (body.manualTotal !== undefined) {
    service.manualTotal = parseNumber(body.manualTotal, { min: 0, message: 'מחיר לא יכול להיות שלילי' });
  }

  await service.save();
  // a cancelled visit never raises the vehicle odometer
  if (mileageChanged && service.status !== 'cancelled') await applyMileageRule(service.vehicle, service.mileage);
  if (recompute) await recomputeVehicleStats(service.vehicle);

  res.json({ success: true, data: await loadServiceFull(service._id) });
});

/** PATCH /api/services/:id/status */
export const setStatus = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  const target = body.status;
  const from = service.status;

  if (!SERVICE_STATUSES.includes(target) || !TRANSITIONS[from]?.includes(target)) {
    throw ApiError.badRequest(MSG.badTransition);
  }

  service.$locals.statusNote = cleanText(body.note);

  if (target === 'done') {
    if (parseBool(body.markAllDone, false)) {
      service.items.forEach((it) => {
        if (!it.done && !it.carriedTo?.service) it.done = true;
      });
    }
    const completedAt = parseDate(body.completedAt);
    service.completedAt = completedAt || new Date();
  }
  if (target === 'cancelled') {
    if (body.cancelReason !== undefined) service.cancelReason = cleanText(body.cancelReason);
  }
  if (target === 'pending' && from === 'cancelled') {
    service.cancelReason = '';
  }

  service.status = target;
  await service.save();

  if (target === 'cancelled') await uncarryFrom(service);
  if (target === 'pending' && from === 'cancelled') await recarryFrom(service);
  if (target === 'done') await applyMileageRule(service.vehicle, service.mileage);
  await recomputeVehicleStats(service.vehicle);

  const [full, vehicle] = await Promise.all([loadServiceFull(service._id), vehicleRowOf(service.vehicle)]);
  res.json({ success: true, data: { service: full, vehicle } });
});

/* ------------------------------------------------------------------ items */

/** POST /api/services/:id/items (single item or { items: [...], bundles?: [bundleId] }) */
export const addItems = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  assertEditable(service);

  const raw = Array.isArray(body.items) ? body.items : [body];
  const items = raw.map((it) => sanitizeItem(it));
  if (!items.length) throw ApiError.badRequest(MSG.itemTitle);
  const bundleIds = parseBundleIds(body.bundles);

  items.forEach((it) => service.items.push(it));
  await service.save();
  bumpTemplateUsageInBackground(items);
  bumpBundleUsageInBackground(bundleIds);
  await recomputeVehicleStats(service.vehicle);

  res.status(201).json({ success: true, data: await loadServiceFull(service._id) });
});

/** PUT /api/services/:id/items/:itemId */
export const updateItem = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  assertEditable(service);
  const item = service.items.id(req.params.itemId);
  if (!item) throw ApiError.notFound(MSG.itemNotFound);

  // structure: work / parts / record price, or a plain rename that follows the single component
  const structural = body.work !== undefined || body.parts !== undefined || body.title !== undefined || body.price !== undefined || body.qty !== undefined;
  if (structural) {
    if (body.title !== undefined && !cleanText(body.title)) throw ApiError.badRequest(MSG.itemTitle);
    const merged = normalizeTask(
      {
        title: body.title !== undefined ? body.title : item.title,
        work: body.work !== undefined ? body.work : item.work ? item.work.toObject() : null,
        parts: body.parts !== undefined ? body.parts : item.parts.map((p) => p.toObject()),
        price: body.price !== undefined ? body.price : item.price,
        type: body.type,
      },
      { withStatus: false }
    );
    if (body.title !== undefined && body.work === undefined && body.parts === undefined) applyTitleRename(merged, body.title);
    if (body.qty !== undefined && body.parts === undefined && merged.parts.length === 1) {
      const qty = parseNumber(body.qty, { min: 1, message: 'כמות חייבת להיות לפחות 1' });
      merged.parts[0].qty = qty == null ? 1 : Math.round(qty);
    }
    item.title = deriveTitle(merged) || merged.title;
    item.work = merged.work;
    item.parts = merged.parts;
    item.price = merged.price;
  }
  if (body.done !== undefined) {
    const done = parseBool(body.done, item.done);
    // an item that was carried forward lives on in the newer service; marking it done here would bill it twice
    if (done && !item.done && item.carriedTo?.service) throw ApiError.badRequest(MSG.itemCarried);
    item.done = done;
  }
  if (body.notes !== undefined) item.notes = cleanText(body.notes);

  await service.save();
  await recomputeVehicleStats(service.vehicle);

  res.json({ success: true, data: await loadServiceFull(service._id) });
});

/** PATCH /api/services/:id/items/:itemId/toggle */
export const toggleItem = asyncHandler(async (req, res) => {
  const service = await loadService(req.params.id);
  assertEditable(service);
  const item = service.items.id(req.params.itemId);
  if (!item) throw ApiError.notFound(MSG.itemNotFound);
  if (!item.done && item.carriedTo?.service) throw ApiError.badRequest(MSG.itemCarried);

  item.done = !item.done;
  await service.save();
  await recomputeVehicleStats(service.vehicle);

  res.json({ success: true, data: await loadServiceFull(service._id) });
});

/** PUT /api/services/:id/items/reorder  body { order: [itemId] } */
export const reorderItems = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  assertEditable(service);

  if (!Array.isArray(body.order)) throw ApiError.badRequest(MSG.badOrder);
  const ids = body.order.map((id) => String(id));
  const known = new Set(service.items.map((it) => String(it._id)));
  if (ids.some((id) => !known.has(id))) throw ApiError.badRequest(MSG.badOrder);

  // listed items take their position in `order`; unlisted ones follow, keeping their relative order
  const position = new Map(ids.map((id, i) => [id, i]));
  const rest = service.items
    .filter((it) => !position.has(String(it._id)))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  rest.forEach((it, i) => position.set(String(it._id), ids.length + i));
  service.items.forEach((it) => {
    it.order = position.get(String(it._id));
  });

  await service.save();
  res.json({ success: true, data: await loadServiceFull(service._id) });
});

/** DELETE /api/services/:id/items/:itemId */
export const removeItem = asyncHandler(async (req, res) => {
  const service = await loadService(req.params.id);
  assertEditable(service);
  const item = service.items.id(req.params.itemId);
  if (!item) throw ApiError.notFound(MSG.itemNotFound);
  if (item.carriedTo?.service) throw ApiError.badRequest(MSG.carriedForward);

  const removedItem = item.toObject();
  await uncarryItem(item, service._id);
  service.items.pull(item._id);
  await service.save();
  await recomputeVehicleStats(service.vehicle);

  res.json({ success: true, data: { service: await loadServiceFull(service._id), removedItem } });
});

/** POST /api/services/:id/carry  body { items: [{ serviceId, itemId }] } */
export const carryIntoService = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  assertEditable(service);

  const refs = Array.isArray(body.items) ? body.items : [];
  if (!refs.length) throw ApiError.badRequest(MSG.noCarryItems);

  const { sources } = await carryItems(service, refs);
  await service.save();
  await commitCarry(sources);
  await recomputeVehicleStats(service.vehicle);

  res.json({ success: true, data: await loadServiceFull(service._id) });
});

/* ------------------------------------------------------------------ payments */

/** POST /api/services/:id/payments */
export const addPayment = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  assertEditable(service);

  const amount = parseNumber(body.amount, { min: 0.01, message: MSG.amountPositive });
  if (amount == null) throw ApiError.badRequest(MSG.amountPositive);
  assertCanAcceptPayment(service);

  service.payments.push({
    amount,
    method: parseMethod(body.method),
    paidAt: parseDate(body.paidAt) || new Date(),
    note: cleanText(body.note),
  });
  await service.save();

  res.status(201).json({ success: true, data: await loadServiceFull(service._id) });
});

/** PUT /api/services/:id/payments/:paymentId */
export const updatePayment = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const service = await loadService(req.params.id);
  assertEditable(service);
  const payment = service.payments.id(req.params.paymentId);
  if (!payment) throw ApiError.notFound(MSG.paymentNotFound);

  if (body.amount !== undefined) {
    const amount = parseNumber(body.amount, { min: 0.01, message: MSG.amountPositive });
    if (amount == null) throw ApiError.badRequest(MSG.amountPositive);
    payment.amount = amount;
  }
  if (body.method !== undefined) payment.method = parseMethod(body.method, payment.method);
  if (body.paidAt !== undefined) {
    const paidAt = parseDate(body.paidAt);
    if (paidAt) payment.paidAt = paidAt;
  }
  if (body.note !== undefined) payment.note = cleanText(body.note);

  await service.save();
  res.json({ success: true, data: await loadServiceFull(service._id) });
});

/** DELETE /api/services/:id/payments/:paymentId (allowed on cancelled services too) */
export const removePayment = asyncHandler(async (req, res) => {
  const service = await loadService(req.params.id);
  const payment = service.payments.id(req.params.paymentId);
  if (!payment) throw ApiError.notFound(MSG.paymentNotFound);

  const removedPayment = payment.toObject();
  service.payments.pull(payment._id);
  await service.save();

  res.json({ success: true, data: { service: await loadServiceFull(service._id), removedPayment } });
});

/* ------------------------------------------------------------------ delete */

/** DELETE /api/services/:id: hard delete with its payments; carry links are repaired and the vehicle recomputed. */
export const deleteService = asyncHandler(async (req, res) => {
  const service = await loadService(req.params.id);
  const vehicleId = service.vehicle;
  const { payments } = await deleteServicesCascade([service]);

  res.json({ success: true, data: { deleted: true, payments, vehicle: await vehicleRowOf(vehicleId) } });
});

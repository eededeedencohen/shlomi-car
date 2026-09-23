import mongoose from 'mongoose';
import dayjs from 'dayjs';
import Vehicle from '../models/Vehicle.js';
import Customer from '../models/Customer.js';
import Service, { kindsOf } from '../models/Service.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parsePaging, listResponse } from '../utils/paging.js';
import {
  toAsciiDigits,
  normalizePlate,
  isValidPlate,
  escapeRegex,
  round2,
} from '../utils/normalize.js';
import { startOfDay, addDays } from '../utils/dates.js';
import { annualStateOf, recomputeVehicleStats, ANNUAL_LEAD_DAYS } from '../utils/annual.js';
import { openItemTaskFields } from '../utils/serviceRows.js';
import { previewVehicleDeletion, deleteVehiclesCascade } from '../utils/cascade.js';

const OPEN_STATUSES = ['pending', 'in_progress'];
const NOTES_PREVIEW_LENGTH = 120;
const PLATE_MESSAGE = 'מספר רכב חייב להכיל 7 או 8 ספרות';
const BACKFILL_DEFAULT_NOTE = 'רשומה היסטורית לצורך תזכורת טיפול שנתי';

/* ------------------------------------------------------------------ */
/* Row builders (spec section 4: ServiceRow / VehicleRow)              */
/* ------------------------------------------------------------------ */

/** ServiceRow field list (spec 4). `notes` is fetched only to derive `notesPreview`. */
export const SERVICE_ROW_SELECT =
  'plateNumber kinds kind otherLabel status openedAt completedAt mileage itemsCount itemsDoneCount remainingCount ' +
  'totalPrice paidAmount balance paymentStatus notes vehicle customer createdAt updatedAt';

const VEHICLE_REF_SELECT = 'plateNumber make model year';
const CUSTOMER_REF_SELECT = 'fullName phone';

/** Apply the ServiceRow select + populate to a Service query and return lean rows. */
export const serviceRowQuery = (query, extraSelect = '') =>
  query
    .select(`${SERVICE_ROW_SELECT} ${extraSelect}`.trim())
    .populate('vehicle', VEHICLE_REF_SELECT)
    .populate('customer', CUSTOMER_REF_SELECT)
    .lean();

/** Lean service document -> ServiceRow (full notes replaced by a 120 char preview; tags always present). */
export const toServiceRow = (doc) => {
  if (!doc) return null;
  const { notes, ...rest } = doc;
  const kinds = kindsOf(rest);
  return { ...rest, kinds, kind: kinds[0], otherLabel: rest.otherLabel || '', notesPreview: String(notes || '').slice(0, NOTES_PREVIEW_LENGTH) };
};

/** CustomerRef from a populated customer (or a bare id when not populated). */
const toCustomerRef = (c) => {
  if (!c) return null;
  if (typeof c === 'object' && c._id !== undefined) {
    return { _id: c._id, fullName: c.fullName ?? '', phone: c.phone ?? '' };
  }
  return { _id: c };
};

/**
 * VehicleRow builder (spec 4). Accepts a Mongoose document or a lean row; `customer` should be
 * populated with at least `fullName phone`. `openBalance` is the sum of positive balances of the
 * vehicle's non-cancelled services (computed by the caller, see openBalanceByVehicle).
 */
export function buildVehicleRow(vehicleDoc, { openBalance = 0 } = {}) {
  const v =
    typeof vehicleDoc?.toObject === 'function' ? vehicleDoc.toObject({ virtuals: false }) : vehicleDoc;
  const { annualState, daysToAnnual } = annualStateOf(v);
  return {
    _id: v._id,
    plateNumber: v.plateNumber,
    make: v.make ?? '',
    model: v.model ?? '',
    year: v.year ?? null,
    color: v.color ?? '',
    fuelType: v.fuelType ?? null,
    mileage: v.mileage ?? null,
    active: v.active !== false,
    customer: toCustomerRef(v.customer),
    lastAnnualAt: v.lastAnnualAt ?? null,
    annualDueAt: v.annualDueAt ?? null,
    annualDueOverride: v.annualDueOverride ?? null,
    annualReminderMuted: Boolean(v.annualReminderMuted),
    openAnnualServiceId: v.openAnnualServiceId ?? null,
    lastServiceAt: v.lastServiceAt ?? null,
    servicesCount: v.servicesCount ?? 0,
    openServicesCount: v.openServicesCount ?? 0,
    openItemsCount: v.openItemsCount ?? 0,
    annualState,
    daysToAnnual,
    openBalance: round2(openBalance),
  };
}

/** Map vehicleId -> open balance (positive balances of non-cancelled services). */
export async function openBalanceByVehicle(vehicleIds) {
  const ids = vehicleIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return new Map();
  const rows = await Service.aggregate([
    { $match: { vehicle: { $in: ids }, status: { $ne: 'cancelled' }, balance: { $gt: 0.005 } } },
    { $group: { _id: '$vehicle', openBalance: { $sum: '$balance' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), round2(r.openBalance)]));
}

/** Lean vehicles (customer populated) -> VehicleRow[] with open balances attached. */
export async function vehicleRowsFor(vehicles) {
  const balances = await openBalanceByVehicle(vehicles.map((v) => v._id));
  return vehicles.map((v) => buildVehicleRow(v, { openBalance: balances.get(String(v._id)) || 0 }));
}

/** Fresh VehicleRow by id (null when the vehicle does not exist). */
export async function vehicleRowById(vehicleId) {
  const v = await Vehicle.findById(vehicleId).populate('customer', CUSTOMER_REF_SELECT).lean();
  if (!v) return null;
  const [row] = await vehicleRowsFor([v]);
  return row;
}

/** Money totals over non-cancelled services matching `match` (ObjectId values, not strings). */
export async function serviceTotals(match) {
  const [row] = await Service.aggregate([
    { $match: { ...match, status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: null,
        servicesCount: { $sum: 1 },
        totalCharged: { $sum: '$totalPrice' },
        totalPaid: { $sum: '$paidAmount' },
        openBalance: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } },
      },
    },
  ]);
  return {
    servicesCount: row?.servicesCount || 0,
    totalCharged: round2(row?.totalCharged),
    totalPaid: round2(row?.totalPaid),
    openBalance: round2(row?.openBalance),
  };
}

/** Remaining items of a vehicle across its non-cancelled services, flattened to OpenItem rows (spec 3.5). */
export async function openItemsOfVehicle(vehicleId) {
  const services = await Service.find({
    vehicle: vehicleId,
    status: { $ne: 'cancelled' },
    items: { $elemMatch: { done: false, 'carriedTo.service': null } },
  })
    .sort({ openedAt: 1 })
    .select('_id openedAt kinds kind otherLabel status items')
    .lean();

  const rows = [];
  for (const s of services) {
    const remaining = s.items
      .filter((it) => !it.done && !it.carriedTo?.service)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const it of remaining) {
      rows.push({
        serviceId: s._id,
        serviceOpenedAt: s.openedAt,
        serviceStatus: s.status,
        serviceKind: kindsOf(s)[0],
        serviceKinds: kindsOf(s),
        serviceOtherLabel: s.otherLabel || '',
        itemId: it._id,
        ...openItemTaskFields(it),
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Input helpers                                                       */
/* ------------------------------------------------------------------ */

const VEHICLE_FIELDS = ['make', 'model', 'year', 'color', 'fuelType', 'engineNotes', 'mileage', 'notes'];
const NUMERIC_FIELDS = new Set(['year', 'mileage']);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** '' / null -> null, anything else -> Number (an invalid string becomes a Mongoose cast error). */
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

/** Whitelisted vehicle fields present in the body, coerced. Enum '' is treated as "not set". */
const pickVehicleFields = (body) => {
  const out = {};
  for (const key of VEHICLE_FIELDS) {
    if (!has(body, key)) continue;
    let value = body[key];
    if (NUMERIC_FIELDS.has(key)) value = numOrNull(value);
    else if (key === 'fuelType' && (value === '' || value == null)) value = null;
    out[key] = value;
  }
  return out;
};

/** Parse a date from JSON: 'YYYY-MM-DD' becomes local midnight; null for empty or invalid input. */
const parseDate = (value) => {
  if (value == null || value === '') return null;
  const d = dayjs(value);
  return d.isValid() ? d.toDate() : null;
};

/** A query is a plate query when it holds only digits, spaces and dashes. */
const digitsQueryOf = (q) => {
  const digits = normalizePlate(q);
  const stripped = toAsciiDigits(q).replace(/[\s-]/g, '');
  return digits && stripped === digits ? digits : '';
};

const idOrBadRequest = (value, message) => {
  if (!mongoose.isValidObjectId(value)) throw ApiError.badRequest(message);
  return new mongoose.Types.ObjectId(String(value));
};

/** Duplicate plate: 400 that carries the existing vehicle id (spec 4.3). Returns true when sent. */
const sendDuplicatePlate = (res, plateNumber, existingVehicleId) =>
  res.status(400).json({
    success: false,
    message: `מספר רכב ${plateNumber} כבר קיים במערכת`,
    data: { existingVehicleId },
  });

/**
 * Resolve exactly one of `customer` (existing id) / `newCustomer` (inline create).
 * Returns { customer, created }. The caller decides when to run it so an inline customer is only
 * created after the rest of the request has been validated.
 */
async function resolveCustomer(body) {
  const hasId = body.customer != null && body.customer !== '';
  const nc = body.newCustomer;
  const hasNew = Boolean(nc) && typeof nc === 'object';
  if (hasId === hasNew) throw ApiError.badRequest('יש לבחור לקוח או ליצור לקוח חדש');

  if (hasId) {
    if (!mongoose.isValidObjectId(body.customer)) throw ApiError.notFound('הלקוח לא נמצא');
    const customer = await Customer.findById(body.customer);
    if (!customer) throw ApiError.notFound('הלקוח לא נמצא');
    return { customer, created: false };
  }

  const fullName = String(nc.fullName || '').trim();
  if (!fullName) throw ApiError.badRequest('שם מלא הוא שדה חובה');
  const customer = await Customer.create({
    fullName,
    phone: nc.phone,
    phone2: nc.phone2,
    email: nc.email,
    notes: nc.notes,
  });
  return { customer, created: true };
}

/** Mileage max rule (spec 3.6): a higher service reading raises the vehicle reading. */
const applyMileageRule = (vehicle, serviceMileage) => {
  if (serviceMileage == null) return false;
  if (serviceMileage > (vehicle.mileage || 0)) {
    vehicle.mileage = serviceMileage;
    vehicle.mileageUpdatedAt = new Date();
    return true;
  }
  return false;
};

const loadVehicle = async (id) => {
  const vehicle = await Vehicle.findById(id);
  if (!vehicle) throw ApiError.notFound('הרכב לא נמצא');
  return vehicle;
};

/* ------------------------------------------------------------------ */
/* GET /api/vehicles                                                   */
/* ------------------------------------------------------------------ */

const SORT_FIELDS = {
  plate: 'plateNumber',
  lastService: 'lastServiceAt',
  annualDue: 'annualDueAt',
  make: 'make',
};

/**
 * רשימת רכבים: חיפוש (מספר רכב / יצרן / דגם / שם לקוח), סינון לפי לקוח, מצב טיפול שנתי ופעילות,
 * מיון ועימוד. כל שורה היא VehicleRow כולל יתרה פתוחה ומצב טיפול שנתי.
 */
export const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePaging(req.query);
  const today = startOfDay();
  const horizon = addDays(today, ANNUAL_LEAD_DAYS);

  const match = {};
  const activeParam = String(req.query.active ?? '1');
  if (activeParam === '1') match.active = true;
  else if (activeParam === '0') match.active = false;

  if (req.query.customer) {
    match.customer = idOrBadRequest(req.query.customer, 'מזהה לקוח לא תקין');
  }

  // annual filters always apply to active, unmuted vehicles (the reminder population, spec 3.4)
  const annual = String(req.query.annual || '');
  if (annual) {
    match.active = true;
    if (annual === 'muted') match.annualReminderMuted = true;
    else match.annualReminderMuted = false;
    if (annual === 'due') match.annualDueAt = { $ne: null, $lte: horizon };
    else if (annual === 'due_soon') match.annualDueAt = { $gte: today, $lte: horizon };
    else if (annual === 'overdue') match.annualDueAt = { $ne: null, $lt: today };
    else if (annual === 'none') match.annualDueAt = null;
    else if (annual !== 'muted') throw ApiError.badRequest('מסנן טיפול שנתי לא תקין');
  }

  const q = String(req.query.q || '').trim();
  const plateQuery = q ? digitsQueryOf(q) : '';
  let textRx = null;
  if (plateQuery) match.plateNumber = new RegExp(`^${escapeRegex(plateQuery)}`);
  else if (q) textRx = new RegExp(escapeRegex(q), 'i');

  const sortKey = String(req.query.sortBy || '');
  const sortField = Object.hasOwn(SORT_FIELDS, sortKey) ? SORT_FIELDS[sortKey] : SORT_FIELDS.lastService;
  const defaultOrder = sortField === 'lastServiceAt' ? -1 : 1;
  const dir = req.query.order === 'desc' ? -1 : req.query.order === 'asc' ? 1 : defaultOrder;
  let sortSpec;
  if (sortField === 'make') sortSpec = { make: dir, model: dir, plateNumber: 1 };
  else if (sortField === 'plateNumber') sortSpec = { plateNumber: dir };
  else sortSpec = { sortNull: 1, [sortField]: dir, plateNumber: 1 }; // dates: rows without a value last

  const pipeline = [
    { $match: match },
    { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'customer' } },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
    ...(textRx
      ? [{ $match: { $or: [{ make: textRx }, { model: textRx }, { 'customer.fullName': textRx }] } }]
      : []),
    {
      $lookup: {
        from: 'services',
        localField: '_id',
        foreignField: 'vehicle',
        pipeline: [
          { $match: { status: { $ne: 'cancelled' }, balance: { $gt: 0.005 } } },
          { $project: { balance: 1 } },
        ],
        as: 'svc',
      },
    },
    {
      $addFields: {
        openBalance: { $sum: '$svc.balance' },
        sortNull: { $cond: [{ $eq: [`$${sortField}`, null] }, 1, 0] },
      },
    },
    { $project: { svc: 0 } },
    { $sort: sortSpec },
    { $skip: skip },
    { $limit: limit },
  ];

  const countPipeline = pipeline.filter(
    (st) => !('$sort' in st) && !('$skip' in st) && !('$limit' in st) && !('$project' in st)
  );
  const [rows, countRows] = await Promise.all([
    Vehicle.aggregate(pipeline).collation({ locale: 'he' }),
    Vehicle.aggregate([...countPipeline, { $count: 'n' }]),
  ]);
  const total = countRows[0]?.n || 0;

  const data = rows.map((row) => buildVehicleRow(row, { openBalance: row.openBalance }));
  return listResponse(res, data, total, page, limit);
});

/* ------------------------------------------------------------------ */
/* GET /api/vehicles/lookup/:plate                                     */
/* ------------------------------------------------------------------ */

/**
 * חיפוש רכב לפי מספר (מנורמל). מחזיר 200 גם כשלא נמצא, עם כל מה שמסך "טיפול חדש" צריך:
 * טיפולים פתוחים, פריטים שנותרו, הטיפול האחרון וסוג טיפול מוצע.
 */
export const lookup = asyncHandler(async (req, res) => {
  const plateNumber = normalizePlate(req.params.plate);
  if (!isValidPlate(plateNumber)) throw ApiError.badRequest(PLATE_MESSAGE);

  const vehicle = await Vehicle.findOne({ plateNumber }).populate('customer', CUSTOMER_REF_SELECT).lean();
  if (!vehicle) return res.json({ success: true, data: { found: false, plateNumber } });

  const [rows, openServices, lastServiceDoc, openItems] = await Promise.all([
    vehicleRowsFor([vehicle]),
    serviceRowQuery(
      Service.find({ vehicle: vehicle._id, status: { $in: OPEN_STATUSES } }).sort({ openedAt: -1 })
    ),
    serviceRowQuery(
      Service.findOne({ vehicle: vehicle._id, status: { $ne: 'cancelled' } }).sort({ openedAt: -1, _id: -1 })
    ),
    openItemsOfVehicle(vehicle._id),
  ]);
  const row = rows[0];
  const annualDue = row.annualState === 'due_soon' || row.annualState === 'overdue';
  const suggestedKind = annualDue && !row.openAnnualServiceId ? 'annual' : 'repair';

  return res.json({
    success: true,
    data: {
      found: true,
      vehicle: row,
      customer: row.customer,
      openServices: openServices.map(toServiceRow),
      openItems,
      lastService: toServiceRow(lastServiceDoc),
      suggestedKind,
    },
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/vehicles/makes                                             */
/* ------------------------------------------------------------------ */

/** רשימת יצרנים ייחודית (ל-Autocomplete בטופס הרכב). */
export const makes = asyncHandler(async (req, res) => {
  const values = await Vehicle.distinct('make', { make: { $nin: [null, ''] } });
  const sorted = values
    .map((m) => String(m).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'he'));
  return res.json({ success: true, data: { makes: sorted } });
});

/* ------------------------------------------------------------------ */
/* GET /api/vehicles/:id                                               */
/* ------------------------------------------------------------------ */

/** כרטיס רכב: פרטים מלאים, כל הטיפולים (עם פריטים), פריטים שנותרו וסיכומי כסף. */
export const getOne = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.id).populate('customer', CUSTOMER_REF_SELECT).lean();
  if (!vehicle) throw ApiError.notFound('הרכב לא נמצא');

  const [rows, serviceDocs, openItems, totals] = await Promise.all([
    vehicleRowsFor([vehicle]),
    serviceRowQuery(Service.find({ vehicle: vehicle._id }).sort({ openedAt: -1, _id: -1 }), 'items'),
    openItemsOfVehicle(vehicle._id),
    serviceTotals({ vehicle: vehicle._id }),
  ]);

  const ownerId = String(vehicle.customer?._id ?? vehicle.customer ?? '');
  const services = serviceDocs.map((doc) => {
    const billedId = String(doc.customer?._id ?? doc.customer ?? '');
    return { ...toServiceRow(doc), differentOwner: billedId !== ownerId };
  });

  const data = {
    vehicle: {
      ...rows[0],
      engineNotes: vehicle.engineNotes ?? '',
      notes: vehicle.notes ?? '',
      mileageUpdatedAt: vehicle.mileageUpdatedAt ?? null,
      lastAnnualServiceId: vehicle.lastAnnualServiceId ?? null,
      annualDueOverrideSetAt: vehicle.annualDueOverrideSetAt ?? null,
    },
    services,
    openItems,
    totals,
  };
  return res.json({ success: true, data });
});

/* ------------------------------------------------------------------ */
/* POST /api/vehicles                                                  */
/* ------------------------------------------------------------------ */

/**
 * יצירת רכב עם לקוח קיים (customer) או לקוח חדש (newCustomer), בדיוק אחד מהם.
 * מספר רכב כפול מחזיר 400 עם existingVehicleId כדי שהלקוח יוכל לפתוח את הרכב הקיים.
 */
export const create = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const plateNumber = normalizePlate(body.plateNumber);
  if (!isValidPlate(plateNumber)) throw ApiError.badRequest(PLATE_MESSAGE);

  const existing = await Vehicle.findOne({ plateNumber }).select('_id').lean();
  if (existing) return sendDuplicatePlate(res, plateNumber, existing._id);

  // validate the vehicle fields before any customer is created, so a bad year never leaves an orphan customer
  const fields = pickVehicleFields(body);
  const vehicle = new Vehicle({ ...fields, plateNumber, customer: new mongoose.Types.ObjectId() });
  if (vehicle.mileage != null) vehicle.mileageUpdatedAt = new Date();
  await vehicle.validate();

  const { customer, created } = await resolveCustomer(body);
  vehicle.customer = customer._id;
  await vehicle.save();

  const row = await vehicleRowById(vehicle._id);
  return res.status(201).json({ success: true, data: { vehicle: row, customer, createdCustomer: created } });
});

/* ------------------------------------------------------------------ */
/* PUT /api/vehicles/:id                                               */
/* ------------------------------------------------------------------ */

/** עדכון פרטי רכב (שדות מותרים בלבד). שינוי מספר רכב מסונכרן לכל הטיפולים של הרכב. */
export const update = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const vehicle = await loadVehicle(req.params.id);

  let plateChanged = false;
  if (has(body, 'plateNumber')) {
    const plateNumber = normalizePlate(body.plateNumber);
    if (!isValidPlate(plateNumber)) throw ApiError.badRequest(PLATE_MESSAGE);
    if (plateNumber !== vehicle.plateNumber) {
      const clash = await Vehicle.findOne({ plateNumber, _id: { $ne: vehicle._id } }).select('_id').lean();
      if (clash) return sendDuplicatePlate(res, plateNumber, clash._id);
      vehicle.plateNumber = plateNumber;
      plateChanged = true;
    }
  }

  const fields = pickVehicleFields(body);
  const prevMileage = vehicle.mileage ?? null;
  Object.assign(vehicle, fields);
  if (has(fields, 'mileage') && (fields.mileage ?? null) !== prevMileage) {
    vehicle.mileageUpdatedAt = new Date();
  }
  if (has(body, 'active')) vehicle.active = body.active === true || body.active === 'true' || body.active === 1;

  await vehicle.save();
  if (plateChanged) {
    await Service.updateMany({ vehicle: vehicle._id }, { $set: { plateNumber: vehicle.plateNumber } });
  }

  const row = await vehicleRowById(vehicle._id);
  return res.json({ success: true, data: row });
});

/* ------------------------------------------------------------------ */
/* PUT /api/vehicles/:id/transfer                                      */
/* ------------------------------------------------------------------ */

/**
 * העברת בעלות (ספק 3.7): משנה רק את vehicle.customer. טיפולים קיימים שומרים את הלקוח שחויב;
 * טיפולים פתוחים ללא תשלומים עוברים ללקוח החדש רק כשמתבקש (moveOpenServices).
 */
export const transfer = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const vehicle = await loadVehicle(req.params.id);

  const { customer } = await resolveCustomer(body);
  if (String(customer._id) === String(vehicle.customer)) {
    throw ApiError.badRequest('הרכב כבר רשום על שם לקוח זה');
  }

  vehicle.customer = customer._id;
  await vehicle.save();

  let movedServices = 0;
  if (body.moveOpenServices === true || body.moveOpenServices === 'true') {
    const result = await Service.updateMany(
      { vehicle: vehicle._id, status: { $in: OPEN_STATUSES }, payments: { $size: 0 } },
      { $set: { customer: customer._id } }
    );
    movedServices = result.modifiedCount || 0;
  }

  await recomputeVehicleStats(vehicle._id);
  const row = await vehicleRowById(vehicle._id);
  return res.json({
    success: true,
    data: {
      vehicle: row,
      customer: { _id: customer._id, fullName: customer.fullName, phone: customer.phone ?? '' },
      movedServices,
    },
  });
});

/* ------------------------------------------------------------------ */
/* PUT /api/vehicles/:id/annual                                        */
/* ------------------------------------------------------------------ */

/** קביעת תאריך יעד ידני לטיפול שנתי (או ניקוי שלו) והשתקת התזכורת. */
export const updateAnnual = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const vehicle = await loadVehicle(req.params.id);

  if (has(body, 'annualDueOverride')) {
    if (body.annualDueOverride == null || body.annualDueOverride === '') {
      vehicle.annualDueOverride = null;
      vehicle.annualDueOverrideSetAt = null;
    } else {
      const date = parseDate(body.annualDueOverride);
      if (!date) throw ApiError.badRequest('תאריך לא תקין');
      vehicle.annualDueOverride = startOfDay(date);
      vehicle.annualDueOverrideSetAt = new Date();
    }
  }
  if (has(body, 'annualReminderMuted')) {
    vehicle.annualReminderMuted = body.annualReminderMuted === true || body.annualReminderMuted === 'true';
  }

  await vehicle.save();
  await recomputeVehicleStats(vehicle._id);
  const row = await vehicleRowById(vehicle._id);
  return res.json({ success: true, data: row });
});

/* ------------------------------------------------------------------ */
/* POST /api/vehicles/:id/annual/backfill                              */
/* ------------------------------------------------------------------ */

/** רישום טיפול שנתי היסטורי (הושלם בעבר, ללא פריטים) כדי שהתזכורת תתחיל לעבוד. */
export const backfillAnnual = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const vehicle = await loadVehicle(req.params.id);

  const completedAt = parseDate(body.completedAt);
  if (!completedAt) throw ApiError.badRequest('יש להזין תאריך טיפול');
  const tomorrow = addDays(startOfDay(), 1);
  if (completedAt >= tomorrow) throw ApiError.badRequest('תאריך הטיפול לא יכול להיות בעתיד');

  const dayStart = startOfDay(completedAt);
  const dayEnd = addDays(dayStart, 1);
  const sameDay = await Service.exists({
    vehicle: vehicle._id,
    kinds: 'annual',
    status: 'done',
    completedAt: { $gte: dayStart, $lt: dayEnd },
  });
  if (sameDay) throw ApiError.badRequest('כבר קיים טיפול שנתי בתאריך זה');

  const mileage = numOrNull(body.mileage);
  const note = String(body.note || '').trim();
  const service = await Service.create({
    vehicle: vehicle._id,
    customer: vehicle.customer,
    plateNumber: vehicle.plateNumber,
    kinds: ['annual'],
    kind: 'annual',
    status: 'done',
    openedAt: completedAt,
    completedAt,
    mileage,
    items: [],
    notes: note || BACKFILL_DEFAULT_NOTE,
  });

  if (applyMileageRule(vehicle, mileage)) await vehicle.save();
  await recomputeVehicleStats(vehicle._id);

  const [serviceDoc, row] = await Promise.all([
    serviceRowQuery(Service.findById(service._id)),
    vehicleRowById(vehicle._id),
  ]);
  return res.status(201).json({ success: true, data: { service: toServiceRow(serviceDoc), vehicle: row } });
});

/* ------------------------------------------------------------------ */
/* GET /api/vehicles/:id/deletion, DELETE /api/vehicles/:id            */
/* ------------------------------------------------------------------ */

/** מה יימחק יחד עם הרכב (לחלון האישור): טיפולים, תשלומים וסכומם. */
export const deletionPreview = asyncHandler(async (req, res) => {
  const vehicle = await loadVehicle(req.params.id);
  return res.json({ success: true, data: await previewVehicleDeletion(vehicle._id) });
});

/** מחיקה קשיחה מדורגת: הרכב וכל הטיפולים שלו (כולל מבוטלים ותשלומים). הלקוח נשאר. */
export const remove = asyncHandler(async (req, res) => {
  const vehicle = await loadVehicle(req.params.id);
  const result = await deleteVehiclesCascade([vehicle._id]);
  return res.json({ success: true, data: { deleted: true, ...result } });
});

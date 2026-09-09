import Customer from '../models/Customer.js';
import Vehicle from '../models/Vehicle.js';
import Service from '../models/Service.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parsePaging, listResponse } from '../utils/paging.js';
import { toAsciiDigits, normalizePhone, escapeRegex, round2 } from '../utils/normalize.js';
import { previewCustomerDeletion, deleteCustomerCascade } from '../utils/cascade.js';
import {
  serviceRowQuery,
  toServiceRow,
  vehicleRowsFor,
  serviceTotals,
} from './vehicleController.js';

const CUSTOMER_FIELDS = ['fullName', 'phone', 'phone2', 'email', 'notes'];
const CUSTOMER_DETAIL_SERVICES_LIMIT = 100;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const loadCustomer = async (id) => {
  const customer = await Customer.findById(id);
  if (!customer) throw ApiError.notFound('הלקוח לא נמצא');
  return customer;
};

/* ------------------------------------------------------------------ */
/* GET /api/customers                                                  */
/* ------------------------------------------------------------------ */

/** ?sortBy -> aggregated field. Dates / money default to descending, names to ascending. */
const SORT_FIELDS = {
  fullName: { field: 'fullName', defaultDir: 1 },
  lastService: { field: 'lastServiceAt', defaultDir: -1 },
  openBalance: { field: 'openBalance', defaultDir: -1 },
  vehicles: { field: 'vehiclesCount', defaultDir: -1 },
};

/**
 * רשימת לקוחות (CustomerRow, אגרגציה לפי ספק 6.6): חיפוש לפי שם, ואם יש ספרות גם לפי טלפון;
 * state=all|open|archived (ברירת מחדל: פעילים בלבד); מיון ועימוד; מיון עברי (collation he).
 */
export const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePaging(req.query);
  const state = String(req.query.state || '');

  const match = {};
  if (state === 'archived') match.active = false;
  else if (state !== 'all') match.active = true;

  const q = String(req.query.q || '').trim();
  if (q) {
    const nameRx = new RegExp(escapeRegex(q), 'i');
    const digits = toAsciiDigits(q).replace(/\D/g, '');
    if (digits) {
      const phoneRx = new RegExp(escapeRegex(normalizePhone(digits) || digits));
      match.$or = [{ fullName: nameRx }, { phone: phoneRx }, { phone2: phoneRx }];
    } else {
      match.fullName = nameRx;
    }
  }

  const sortKey = String(req.query.sortBy || '');
  const sort = Object.hasOwn(SORT_FIELDS, sortKey) ? SORT_FIELDS[sortKey] : SORT_FIELDS.fullName;
  const dir = req.query.order === 'desc' ? -1 : req.query.order === 'asc' ? 1 : sort.defaultDir;
  const sortSpec = sort.field === 'fullName' ? { fullName: dir, _id: 1 } : { [sort.field]: dir, fullName: 1 };

  const pipeline = [
    { $match: match },
    { $lookup: { from: 'vehicles', localField: '_id', foreignField: 'customer', as: 'vehicles' } },
    {
      $lookup: {
        from: 'services',
        localField: '_id',
        foreignField: 'customer',
        pipeline: [
          { $match: { status: { $ne: 'cancelled' } } },
          { $project: { balance: 1, openedAt: 1, status: 1 } },
        ],
        as: 'svc',
      },
    },
    {
      $addFields: {
        vehiclesCount: { $size: '$vehicles' },
        plates: { $slice: ['$vehicles.plateNumber', 3] },
        servicesCount: { $size: '$svc' },
        openServicesCount: {
          $size: {
            $filter: {
              input: '$svc',
              as: 's',
              cond: { $in: ['$$s.status', ['pending', 'in_progress']] },
            },
          },
        },
        openBalance: {
          $sum: {
            $map: {
              input: '$svc',
              as: 's',
              in: { $cond: [{ $gt: ['$$s.balance', 0] }, '$$s.balance', 0] },
            },
          },
        },
        lastServiceAt: { $max: '$svc.openedAt' },
      },
    },
    ...(state === 'open' ? [{ $match: { openBalance: { $gt: 0.005 } } }] : []),
    { $project: { vehicles: 0, svc: 0 } },
    { $sort: sortSpec },
    { $skip: skip },
    { $limit: limit },
  ];

  // the count must reflect the same filtering (state / search) without sort, paging or projection
  const countPipeline = pipeline.filter(
    (st) => !('$sort' in st) && !('$skip' in st) && !('$limit' in st) && !('$project' in st)
  );
  const [rows, countRows] = await Promise.all([
    Customer.aggregate(pipeline).collation({ locale: 'he' }),
    Customer.aggregate([...countPipeline, { $count: 'n' }]),
  ]);
  const total = countRows[0]?.n || 0;

  const data = rows.map((row) => ({
    ...row,
    phone: row.phone ?? '',
    phone2: row.phone2 ?? '',
    email: row.email ?? '',
    notes: row.notes ?? '',
    plates: row.plates || [],
    openBalance: round2(row.openBalance),
    lastServiceAt: row.lastServiceAt ?? null,
  }));
  return listResponse(res, data, total, page, limit);
});

/* ------------------------------------------------------------------ */
/* GET /api/customers/lookup?phone=                                    */
/* ------------------------------------------------------------------ */

/** התאמה מדויקת של טלפון (מנורמל) מול phone / phone2 של לקוחות פעילים, לזיהוי לקוח קיים בטופס. */
export const lookup = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) throw ApiError.badRequest('יש להזין מספר טלפון');

  const matches = await Customer.find({ active: true, $or: [{ phone }, { phone2: phone }] })
    .sort({ fullName: 1 })
    .select('fullName phone')
    .lean();
  return res.json({ success: true, data: { matches } });
});

/* ------------------------------------------------------------------ */
/* GET /api/customers/:id                                              */
/* ------------------------------------------------------------------ */

/** כרטיס לקוח: פרטים, הרכבים שלו (VehicleRow), היסטוריית חיוב (ServiceRow, 100 אחרונים) וסיכומים. */
export const getOne = asyncHandler(async (req, res) => {
  const customer = await loadCustomer(req.params.id);

  const [vehicleDocs, serviceDocs, totals] = await Promise.all([
    Vehicle.find({ customer: customer._id })
      .sort({ active: -1, lastServiceAt: -1, plateNumber: 1 })
      .populate('customer', 'fullName phone')
      .lean(),
    serviceRowQuery(
      Service.find({ customer: customer._id })
        .sort({ openedAt: -1, _id: -1 })
        .limit(CUSTOMER_DETAIL_SERVICES_LIMIT)
    ),
    serviceTotals({ customer: customer._id }),
  ]);
  const vehicles = await vehicleRowsFor(vehicleDocs);

  return res.json({
    success: true,
    data: { customer, vehicles, services: serviceDocs.map(toServiceRow), totals },
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/customers                                                 */
/* ------------------------------------------------------------------ */

/** יצירת לקוח. שם מלא חובה; טלפונים מנורמלים ומאומתים במודל. */
export const create = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const fullName = String(body.fullName || '').trim();
  if (!fullName) throw ApiError.badRequest('שם מלא הוא שדה חובה');

  const customer = await Customer.create({
    fullName,
    phone: body.phone,
    phone2: body.phone2,
    email: body.email,
    notes: body.notes,
  });
  return res.status(201).json({ success: true, data: customer });
});

/* ------------------------------------------------------------------ */
/* PUT /api/customers/:id                                              */
/* ------------------------------------------------------------------ */

/** עדכון פרטי לקוח (שדות מותרים בלבד). active=false = ארכיון: ההיסטוריה נשמרת. */
export const update = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const customer = await loadCustomer(req.params.id);

  for (const key of CUSTOMER_FIELDS) {
    if (has(body, key)) customer[key] = body[key] ?? '';
  }
  if (has(body, 'fullName') && !String(customer.fullName || '').trim()) {
    throw ApiError.badRequest('שם מלא הוא שדה חובה');
  }
  if (has(body, 'active')) customer.active = [true, 'true', 1, '1'].includes(body.active);

  await customer.save();
  return res.json({ success: true, data: customer });
});

/* ------------------------------------------------------------------ */
/* GET /api/customers/:id/deletion, DELETE /api/customers/:id          */
/* ------------------------------------------------------------------ */

/** מה יימחק יחד עם הלקוח (לחלון האישור): רכבים, טיפולים, תשלומים וסכומם. */
export const deletionPreview = asyncHandler(async (req, res) => {
  const customer = await loadCustomer(req.params.id);
  return res.json({ success: true, data: await previewCustomerDeletion(customer._id) });
});

/** מחיקה קשיחה מדורגת: הלקוח, הרכבים שלו, הטיפולים שנרשמו על שמו והטיפולים של הרכבים שלו (כולל תשלומים). */
export const remove = asyncHandler(async (req, res) => {
  const customer = await loadCustomer(req.params.id);
  const result = await deleteCustomerCascade(customer);
  return res.json({ success: true, data: { deleted: true, ...result } });
});

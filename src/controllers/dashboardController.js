/**
 * Dashboard API (spec 4.6 and section 6).
 *
 * GET /api/dashboard               - the morning glance: KPIs, open services, annual reminders, open balances, recent vehicles
 * GET /api/dashboard/annual        - paged AnnualRow list by state
 * GET /api/dashboard/open-balances - paged open balances by service or by customer
 *
 * Row builders (ServiceRow / VehicleRow / AnnualRow) are defined here and shared with searchController.
 * The ServiceRow select list is duplicated from the spec on purpose (S4 may not import utils/serviceRows.js).
 */
import Service, { kindsOf } from '../models/Service.js';
import Vehicle from '../models/Vehicle.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parsePaging, listResponse } from '../utils/paging.js';
import { startOfDay, addDays, startOfMonth } from '../utils/dates.js';
import { annualStateOf, ANNUAL_LEAD_DAYS } from '../utils/annual.js';
import { round2 } from '../utils/normalize.js';

const OPEN_STATUSES = ['pending', 'in_progress'];
const NOTES_PREVIEW_LENGTH = 120;
const ANNUAL_STATES_PARAM = ['due', 'overdue', 'due_soon', 'none', 'muted'];
const GROUP_BY_PARAM = ['service', 'customer'];

/** Positive balance on a non-cancelled service = money still owed (spec 6.1 / 6.4, shared $match). */
const OPEN_BALANCE_MATCH = { status: { $ne: 'cancelled' }, balance: { $gt: 0.005 } };

/* ------------------------------------------------------------------------------------------------
 * ServiceRow (spec section 4)
 * ---------------------------------------------------------------------------------------------- */

export const SERVICE_ROW_SELECT =
  'plateNumber kinds kind otherLabel status openedAt completedAt mileage itemsCount itemsDoneCount remainingCount ' +
  'totalPrice paidAmount balance paymentStatus notes vehicle customer createdAt updatedAt';

export const VEHICLE_REF_SELECT = 'plateNumber make model year';
export const CUSTOMER_REF_SELECT = 'fullName phone';

/** Lean service document (selected with SERVICE_ROW_SELECT and populated) -> ServiceRow. */
export const toServiceRow = (doc) => {
  if (!doc) return null;
  const { notes, ...rest } = doc;
  const text = notes ? String(notes) : '';
  const kinds = kindsOf(rest);
  return { ...rest, kinds, kind: kinds[0], otherLabel: rest.otherLabel || '', notesPreview: text.slice(0, NOTES_PREVIEW_LENGTH) };
};

/** Base query for ServiceRow lists; callers add sort / skip / limit and finish with .lean(). */
export const serviceRowQuery = (filter) =>
  Service.find(filter)
    .select(SERVICE_ROW_SELECT)
    .populate('vehicle', VEHICLE_REF_SELECT)
    .populate('customer', CUSTOMER_REF_SELECT);

/* ------------------------------------------------------------------------------------------------
 * VehicleRow / AnnualRow (spec section 4, 4.6)
 * ---------------------------------------------------------------------------------------------- */

/** Populated customer sub-document -> CustomerRef (null when the ref was not populated). */
export const toCustomerRef = (customer) => {
  if (!customer || typeof customer !== 'object' || !customer.fullName) return null;
  return { _id: customer._id, fullName: customer.fullName, phone: customer.phone || '' };
};

/** Sum of positive balances of non-cancelled services, keyed by vehicle id string. */
export async function openBalanceByVehicle(vehicleIds) {
  if (!vehicleIds.length) return new Map();
  const rows = await Service.aggregate([
    { $match: { vehicle: { $in: vehicleIds }, ...OPEN_BALANCE_MATCH } },
    { $group: { _id: '$vehicle', openBalance: { $sum: '$balance' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), round2(r.openBalance)]));
}

/** Lean vehicle (customer populated with fullName phone) -> VehicleRow. */
export const toVehicleRow = (v, { openBalance = 0, today } = {}) => {
  const { annualState, daysToAnnual } = annualStateOf(v, today);
  return {
    _id: v._id,
    plateNumber: v.plateNumber,
    make: v.make || '',
    model: v.model || '',
    year: v.year ?? null,
    color: v.color || '',
    fuelType: v.fuelType || null,
    mileage: v.mileage ?? null,
    active: v.active !== false,
    customer: toCustomerRef(v.customer),
    lastAnnualAt: v.lastAnnualAt || null,
    annualDueAt: v.annualDueAt || null,
    annualDueOverride: v.annualDueOverride || null,
    annualReminderMuted: Boolean(v.annualReminderMuted),
    openAnnualServiceId: v.openAnnualServiceId || null,
    lastServiceAt: v.lastServiceAt || null,
    servicesCount: v.servicesCount || 0,
    openServicesCount: v.openServicesCount || 0,
    openItemsCount: v.openItemsCount || 0,
    annualState,
    daysToAnnual,
    openBalance: round2(openBalance),
  };
};

/** Lean vehicles -> VehicleRow[] (one aggregation for the open balances of the whole batch). */
export async function buildVehicleRows(vehicles, today = startOfDay()) {
  if (!vehicles.length) return [];
  const balances = await openBalanceByVehicle(vehicles.map((v) => v._id));
  return vehicles.map((v) =>
    toVehicleRow(v, { openBalance: balances.get(String(v._id)) || 0, today })
  );
}

/** Lean vehicles -> AnnualRow[] = VehicleRow + openAnnualService: { _id, status } or null. */
export async function buildAnnualRows(vehicles, today = startOfDay()) {
  if (!vehicles.length) return [];
  const openIds = vehicles.map((v) => v.openAnnualServiceId).filter(Boolean);
  const [rows, openServices] = await Promise.all([
    buildVehicleRows(vehicles, today),
    openIds.length ? Service.find({ _id: { $in: openIds } }).select('status').lean() : [],
  ]);
  const openById = new Map(
    openServices.map((s) => [String(s._id), { _id: s._id, status: s.status }])
  );
  return rows.map((row) => ({
    ...row,
    openAnnualService: row.openAnnualServiceId
      ? openById.get(String(row.openAnnualServiceId)) || null
      : null,
  }));
}

/* ------------------------------------------------------------------------------------------------
 * Dashboard sections (spec 6.1 - 6.5)
 * ---------------------------------------------------------------------------------------------- */

const countsById = (agg) => Object.fromEntries(agg.map((r) => [r._id, r.n]));

/** 6.1 kpis */
async function loadKpis({ today, horizon, monthStart }) {
  const [statusAgg, moneyAgg, annualAgg, doneThisMonthCount, collectedAgg] = await Promise.all([
    Service.aggregate([
      { $match: { status: { $in: OPEN_STATUSES } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Service.aggregate([
      { $match: OPEN_BALANCE_MATCH },
      {
        $group: {
          _id: null,
          total: { $sum: '$balance' },
          n: { $sum: 1 },
          customers: { $addToSet: '$customer' },
        },
      },
    ]),
    Vehicle.aggregate([
      { $match: { active: true, annualReminderMuted: false } },
      {
        $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $eq: ['$annualDueAt', null] }, then: 'none' },
                { case: { $ne: ['$openAnnualServiceId', null] }, then: 'open' },
                { case: { $lt: ['$annualDueAt', today] }, then: 'overdue' },
                { case: { $lte: ['$annualDueAt', horizon] }, then: 'due_soon' },
              ],
              default: 'ok',
            },
          },
          n: { $sum: 1 },
        },
      },
    ]),
    Service.countDocuments({ status: 'done', completedAt: { $gte: monthStart } }),
    Service.aggregate([
      { $match: { 'payments.paidAt': { $gte: monthStart } } },
      { $unwind: '$payments' },
      { $match: { 'payments.paidAt': { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$payments.amount' } } },
    ]),
  ]);

  const status = countsById(statusAgg);
  const annual = countsById(annualAgg);
  const money = moneyAgg[0] || { total: 0, n: 0, customers: [] };
  const pendingCount = status.pending || 0;
  const inProgressCount = status.in_progress || 0;

  return {
    openServicesCount: pendingCount + inProgressCount,
    pendingCount,
    inProgressCount,
    openBalanceTotal: round2(money.total),
    openBalanceCount: money.n || 0,
    openBalanceCustomers: (money.customers || []).length,
    annualOverdueCount: annual.overdue || 0,
    annualDueSoonCount: annual.due_soon || 0,
    annualOpenCount: annual.open || 0,
    annualNoneCount: annual.none || 0,
    doneThisMonthCount,
    collectedThisMonth: round2(collectedAgg[0]?.total || 0),
  };
}

/** 6.2 openServices: { inProgress, pending }, oldest visit first */
async function loadOpenServices() {
  const [inProgress, pending] = await Promise.all([
    serviceRowQuery({ status: 'in_progress' }).sort({ openedAt: 1 }).limit(30).lean(),
    serviceRowQuery({ status: 'pending' }).sort({ openedAt: 1 }).limit(30).lean(),
  ]);
  return { inProgress: inProgress.map(toServiceRow), pending: pending.map(toServiceRow) };
}

/** Dashboard order: overdue (most overdue first), then due_soon ascending, open last. */
const ANNUAL_RANK = { overdue: 0, due_soon: 1, open: 2 };
const annualRank = (row) => ANNUAL_RANK[row.annualState] ?? 3;
const dueTime = (row) => (row.annualDueAt ? new Date(row.annualDueAt).getTime() : Infinity);
const compareAnnualRows = (a, b) =>
  annualRank(a) - annualRank(b) ||
  dueTime(a) - dueTime(b) ||
  String(a.plateNumber).localeCompare(String(b.plateNumber));

/** 6.3 annualDue */
async function loadAnnualDue({ today, horizon }) {
  const vehicles = await Vehicle.find({
    active: true,
    annualReminderMuted: false,
    annualDueAt: { $ne: null, $lte: horizon },
  })
    .sort({ annualDueAt: 1, plateNumber: 1 })
    .limit(20)
    .populate('customer', CUSTOMER_REF_SELECT)
    .lean();
  const rows = await buildAnnualRows(vehicles, today);
  return rows.sort(compareAnnualRows);
}

/** 6.4 openBalances: oldest debt first */
async function loadOpenBalances() {
  const rows = await serviceRowQuery(OPEN_BALANCE_MATCH).sort({ openedAt: 1 }).limit(20).lean();
  return rows.map(toServiceRow);
}

/** 6.4 openBalancesByCustomer pipeline (shared by the summary and the paged list). */
const openBalancesByCustomerPipeline = () => [
  { $match: OPEN_BALANCE_MATCH },
  {
    $group: {
      _id: '$customer',
      balance: { $sum: '$balance' },
      servicesCount: { $sum: 1 },
      oldestOpenedAt: { $min: '$openedAt' },
    },
  },
  { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'c' } },
  { $unwind: '$c' },
  {
    $project: {
      _id: 0,
      customer: { _id: '$c._id', fullName: '$c.fullName', phone: '$c.phone' },
      balance: 1,
      servicesCount: 1,
      oldestOpenedAt: 1,
    },
  },
  // secondary keys keep paging deterministic when two customers owe the same amount
  { $sort: { balance: -1, oldestOpenedAt: 1, 'customer._id': 1 } },
];

const toCustomerBalanceRow = (r) => ({
  customer: { _id: r.customer._id, fullName: r.customer.fullName, phone: r.customer.phone || '' },
  balance: round2(r.balance),
  servicesCount: r.servicesCount,
  oldestOpenedAt: r.oldestOpenedAt,
});

async function loadOpenBalancesByCustomer() {
  const rows = await Service.aggregate([...openBalancesByCustomerPipeline(), { $limit: 20 }]);
  return rows.map(toCustomerBalanceRow);
}

/** 6.5 recentVehicles: the last 6 vehicles touched (by service updatedAt) */
async function loadRecentVehicles() {
  return Service.aggregate([
    { $sort: { updatedAt: -1 } },
    {
      $group: {
        _id: '$vehicle',
        lastActivityAt: { $first: '$updatedAt' },
        plateNumber: { $first: '$plateNumber' },
      },
    },
    { $sort: { lastActivityAt: -1 } },
    { $limit: 6 },
    { $lookup: { from: 'vehicles', localField: '_id', foreignField: '_id', as: 'v' } },
    { $unwind: '$v' },
    {
      $project: {
        _id: 1,
        plateNumber: 1,
        lastActivityAt: 1,
        make: '$v.make',
        model: '$v.model',
      },
    },
  ]);
}

/* ------------------------------------------------------------------------------------------------
 * Handlers
 * ---------------------------------------------------------------------------------------------- */

const SECTION_ERROR = 'שגיאה בטעינת הנתונים';

/** A rejected section becomes { error } so the page still renders every other section. */
const settle = (key, result) => {
  if (result.status === 'fulfilled') return result.value;
  console.error(`[dashboard] section "${key}" failed:`, result.reason);
  return { error: SECTION_ERROR };
};

/**
 * GET /api/dashboard
 * data: { kpis, openServices: { inProgress, pending }, annualDue, annualNoneCount, openBalances,
 *         openBalancesByCustomer, recentVehicles, generatedAt }
 */
export const getSummary = asyncHandler(async (req, res) => {
  const today = startOfDay();
  const ctx = { today, horizon: addDays(today, ANNUAL_LEAD_DAYS), monthStart: startOfMonth() };

  const sections = [
    ['kpis', loadKpis(ctx)],
    ['openServices', loadOpenServices()],
    ['annualDue', loadAnnualDue(ctx)],
    ['openBalances', loadOpenBalances()],
    ['openBalancesByCustomer', loadOpenBalancesByCustomer()],
    ['recentVehicles', loadRecentVehicles()],
  ];
  const results = await Promise.allSettled(sections.map(([, promise]) => promise));
  const { kpis, openServices, annualDue, openBalances, openBalancesByCustomer, recentVehicles } =
    Object.fromEntries(sections.map(([key], i) => [key, settle(key, results[i])]));

  res.json({
    success: true,
    data: {
      kpis,
      openServices,
      annualDue,
      annualNoneCount: kpis.error ? 0 : kpis.annualNoneCount,
      openBalances,
      openBalancesByCustomer,
      recentVehicles,
      generatedAt: new Date(),
    },
  });
});

/** $match per `state` for the paged annual list (mirrors the vehicle list filters in spec 4.3). */
const annualMatchFor = (state, { today, horizon }) => {
  const alerted = { active: true, annualReminderMuted: false };
  switch (state) {
    case 'overdue':
      return { ...alerted, annualDueAt: { $ne: null, $lt: today } };
    case 'due_soon':
      return { ...alerted, annualDueAt: { $gte: today, $lte: horizon } };
    case 'none':
      return { ...alerted, annualDueAt: null };
    case 'muted':
      return { active: true, annualReminderMuted: true };
    case 'due':
    default:
      return { ...alerted, annualDueAt: { $ne: null, $lte: horizon } };
  }
};

/**
 * GET /api/dashboard/annual?state=due|overdue|due_soon|none|muted&page&limit
 * list of AnnualRow. For dated states the sort puts vehicles without an open annual first
 * (null sorts before ObjectIds), then by due date, which reproduces the dashboard order while staying pageable.
 */
export const listAnnual = asyncHandler(async (req, res) => {
  const state = String(req.query.state || 'due');
  if (!ANNUAL_STATES_PARAM.includes(state)) {
    throw ApiError.badRequest('ערך state לא תקין');
  }
  const { page, limit, skip } = parsePaging(req.query);
  const today = startOfDay();
  const ctx = { today, horizon: addDays(today, ANNUAL_LEAD_DAYS) };
  const match = annualMatchFor(state, ctx);
  const sort =
    state === 'none' || state === 'muted'
      ? { lastServiceAt: -1, plateNumber: 1 }
      : { openAnnualServiceId: 1, annualDueAt: 1, plateNumber: 1 };

  const [vehicles, total] = await Promise.all([
    Vehicle.find(match)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('customer', CUSTOMER_REF_SELECT)
      .lean(),
    Vehicle.countDocuments(match),
  ]);
  const rows = await buildAnnualRows(vehicles, today);
  return listResponse(res, rows, total, page, limit);
});

/**
 * GET /api/dashboard/open-balances?groupBy=service|customer&page&limit
 * list of ServiceRow (oldest debt first) or of { customer: CustomerRef, balance, servicesCount, oldestOpenedAt }.
 */
export const listOpenBalances = asyncHandler(async (req, res) => {
  const groupBy = String(req.query.groupBy || 'service');
  if (!GROUP_BY_PARAM.includes(groupBy)) {
    throw ApiError.badRequest('ערך groupBy לא תקין');
  }
  const { page, limit, skip } = parsePaging(req.query);

  if (groupBy === 'customer') {
    const [rows, countAgg] = await Promise.all([
      Service.aggregate([...openBalancesByCustomerPipeline(), { $skip: skip }, { $limit: limit }]),
      Service.aggregate([
        { $match: OPEN_BALANCE_MATCH },
        { $group: { _id: '$customer' } },
        { $count: 'n' },
      ]),
    ]);
    const total = countAgg[0]?.n || 0;
    return listResponse(res, rows.map(toCustomerBalanceRow), total, page, limit);
  }

  const [rows, total] = await Promise.all([
    serviceRowQuery(OPEN_BALANCE_MATCH).sort({ openedAt: 1 }).skip(skip).limit(limit).lean(),
    Service.countDocuments(OPEN_BALANCE_MATCH),
  ]);
  return listResponse(res, rows.map(toServiceRow), total, page, limit);
});

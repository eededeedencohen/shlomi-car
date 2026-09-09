/**
 * Global search API (spec 4.7).
 *
 * GET /api/search?q= -> { vehicles: [VehicleRow] (max 6), customers: [CustomerRow] (max 6), services: [ServiceRow] (max 6) }
 *
 * Digits query: vehicles by plate prefix (active first, exact full plate first), customers by phone / phone2
 * containing the digits, services by plate prefix.
 * Text query: customers by name, vehicles by make / model or by a matching owner, services by item title.
 */
import Customer from '../models/Customer.js';
import Vehicle from '../models/Vehicle.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { startOfDay } from '../utils/dates.js';
import {
  toAsciiDigits,
  normalizePlate,
  normalizePhone,
  isValidPlate,
  escapeRegex,
  round2,
} from '../utils/normalize.js';
import {
  CUSTOMER_REF_SELECT,
  serviceRowQuery,
  toServiceRow,
  buildVehicleRows,
} from './dashboardController.js';

const MIN_QUERY_LENGTH = 2;
const GROUP_LIMIT = 6;
/** How many matching owners feed the "vehicles whose customer matched" query. */
const OWNER_MATCH_LIMIT = 100;
const MIN_LENGTH_MESSAGE = 'יש להזין לפחות 2 תווים';

/** Digits with the separators people type into a plate or phone: spaces, dashes, dots, plus, parentheses. */
const DIGITS_QUERY = /^[\d\s\-.+()]+$/;

const activeFirstByName = { active: -1, fullName: 1 };
const activeFirstByActivity = { active: -1, lastServiceAt: -1, plateNumber: 1 };

/* ------------------------------------------------------------------------------------------------
 * CustomerRow (spec 6.6 aggregation restricted to the matched ids)
 * ---------------------------------------------------------------------------------------------- */

async function customerRowsByIds(ids) {
  if (!ids.length) return [];
  const rows = await Customer.aggregate([
    { $match: { _id: { $in: ids } } },
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
    { $project: { vehicles: 0, svc: 0 } },
  ]);

  // keep the order of the matched ids (active first, then by name)
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((r) => ({
      _id: r._id,
      fullName: r.fullName,
      phone: r.phone || '',
      phone2: r.phone2 || '',
      email: r.email || '',
      notes: r.notes || '',
      active: r.active !== false,
      vehiclesCount: r.vehiclesCount,
      plates: r.plates || [],
      servicesCount: r.servicesCount,
      openServicesCount: r.openServicesCount,
      openBalance: round2(r.openBalance),
      lastServiceAt: r.lastServiceAt || null,
    }));
}

/* ------------------------------------------------------------------------------------------------
 * Digits query
 * ---------------------------------------------------------------------------------------------- */

const vehicleQuery = (filter) =>
  Vehicle.find(filter).populate('customer', CUSTOMER_REF_SELECT).lean();

/** Plate prefix matches, active first; an exact full-plate match is always present and placed first. */
async function vehiclesByPlate(digits) {
  const prefix = new RegExp('^' + escapeRegex(digits));
  let vehicles = await vehicleQuery({ plateNumber: prefix })
    .sort({ active: -1, plateNumber: 1 })
    .limit(GROUP_LIMIT);

  const isExact = (v) => v.plateNumber === digits;
  if (isValidPlate(digits) && !vehicles.some(isExact)) {
    const exact = await vehicleQuery({ plateNumber: digits });
    if (exact.length) vehicles = [exact[0], ...vehicles].slice(0, GROUP_LIMIT);
  }
  // stable sort: the exact plate first, the rest keep the active-first order
  return vehicles.sort((a, b) => Number(isExact(b)) - Number(isExact(a)));
}

async function searchDigits(rawQuery, today) {
  const plateDigits = normalizePlate(rawQuery);
  const phoneDigits = normalizePhone(rawQuery) || plateDigits;
  const platePrefix = new RegExp('^' + escapeRegex(plateDigits));
  const phoneContains = new RegExp(escapeRegex(phoneDigits));

  const [vehicles, customerIds, services] = await Promise.all([
    vehiclesByPlate(plateDigits),
    Customer.find({ $or: [{ phone: phoneContains }, { phone2: phoneContains }] })
      .sort(activeFirstByName)
      .limit(GROUP_LIMIT)
      .select('_id')
      .lean(),
    serviceRowQuery({ plateNumber: platePrefix }).sort({ openedAt: -1 }).limit(GROUP_LIMIT).lean(),
  ]);

  const [vehicleRows, customers] = await Promise.all([
    buildVehicleRows(vehicles, today),
    customerRowsByIds(customerIds.map((c) => c._id)),
  ]);
  return { vehicles: vehicleRows, customers, services: services.map(toServiceRow) };
}

/* ------------------------------------------------------------------------------------------------
 * Text query
 * ---------------------------------------------------------------------------------------------- */

async function searchText(q, today) {
  const regex = new RegExp(escapeRegex(q), 'i');

  // one owner query feeds both the customer group (first 6) and the "vehicles of a matching owner" clause
  const owners = await Customer.find({ fullName: regex })
    .sort(activeFirstByName)
    .collation({ locale: 'he' })
    .limit(OWNER_MATCH_LIMIT)
    .select('_id')
    .lean();
  const ownerIds = owners.map((c) => c._id);

  const vehicleFilter = {
    $or: [
      { make: regex },
      { model: regex },
      ...(ownerIds.length ? [{ customer: { $in: ownerIds } }] : []),
    ],
  };

  const [vehicles, customers, services] = await Promise.all([
    vehicleQuery(vehicleFilter).sort(activeFirstByActivity).limit(GROUP_LIMIT),
    customerRowsByIds(ownerIds.slice(0, GROUP_LIMIT)),
    serviceRowQuery({ $or: [{ 'items.title': regex }, { 'items.parts.title': regex }, { 'items.work.title': regex }] })
      .sort({ openedAt: -1 })
      .limit(GROUP_LIMIT)
      .lean(),
  ]);

  const vehicleRows = await buildVehicleRows(vehicles, today);
  return { vehicles: vehicleRows, customers, services: services.map(toServiceRow) };
}

/* ------------------------------------------------------------------------------------------------
 * Handler
 * ---------------------------------------------------------------------------------------------- */

/**
 * GET /api/search?q=
 * 400 'יש להזין לפחות 2 תווים' when q (trimmed) is shorter than 2 characters, or a digits query has fewer than 2 digits.
 */
export const search = asyncHandler(async (req, res) => {
  const q = toAsciiDigits(req.query.q ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH) throw ApiError.badRequest(MIN_LENGTH_MESSAGE);

  const today = startOfDay();
  let data;
  if (DIGITS_QUERY.test(q)) {
    if (normalizePlate(q).length < MIN_QUERY_LENGTH) throw ApiError.badRequest(MIN_LENGTH_MESSAGE);
    data = await searchDigits(q, today);
  } else {
    data = await searchText(q, today);
  }
  res.json({ success: true, data });
});

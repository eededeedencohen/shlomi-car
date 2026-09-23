/**
 * Row builders for the services API (spec 4, S3).
 *
 * - SERVICE_ROW_SELECT / toServiceRow: the light `ServiceRow` used by lists (no items / payments / history).
 * - populateService: turns a Service query into a `ServiceFull` (vehicle + customer populated).
 * - openItemsOfVehicle: remaining items of a vehicle across its non-cancelled services (spec 3.5).
 * - vehicleRowOf / toVehicleRow: the `VehicleRow` shape returned next to a service (spec 4).
 */
import mongoose from 'mongoose';
import Service, { kindsOf } from '../models/Service.js';
import Vehicle from '../models/Vehicle.js';
import { annualStateOf } from './annual.js';
import { round2 } from './normalize.js';
import { taskTotal, taskPriced } from './tasks.js';

const NOTES_PREVIEW_LENGTH = 120;

/** Fields of a ServiceRow. `notes` is selected only to derive `notesPreview`. */
export const SERVICE_ROW_SELECT =
  '_id plateNumber kinds kind otherLabel status openedAt completedAt mileage itemsCount itemsDoneCount remainingCount ' +
  'totalPrice paidAmount balance paymentStatus notes vehicle customer createdAt updatedAt';

/** A lean service with its tags always present (rows from before the tags only carry `kind`). */
export const withKinds = (doc) => (doc ? { ...doc, kinds: kindsOf(doc), kind: kindsOf(doc)[0], otherLabel: doc.otherLabel || '' } : doc);

export const VEHICLE_REF_SELECT = 'plateNumber make model year';
export const CUSTOMER_REF_SELECT = 'fullName phone';

/** ServiceFull populate fields (spec 4: VehicleRef + mileage, color, engineNotes, customer, active). */
export const VEHICLE_FULL_SELECT = 'plateNumber make model year mileage color engineNotes customer active';
export const CUSTOMER_FULL_SELECT = 'fullName phone phone2';

const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

/** Lean document (or Mongoose document) -> ServiceRow: strips the heavy arrays, adds notesPreview. */
export function toServiceRow(doc) {
  if (!doc) return null;
  const { notes, items, payments, statusHistory, ...rest } = toPlain(doc);
  return {
    ...withKinds(rest),
    notesPreview: String(notes || '').slice(0, NOTES_PREVIEW_LENGTH),
  };
}

/** Applies the ServiceRow select + ref populates to a Service query (lists). */
export const selectServiceRows = (query) =>
  query
    .select(SERVICE_ROW_SELECT)
    .populate('vehicle', VEHICLE_REF_SELECT)
    .populate('customer', CUSTOMER_REF_SELECT);

/** Applies the ServiceFull populates to a Service query. */
export const populateService = (query) =>
  query.populate('vehicle', VEHICLE_FULL_SELECT).populate('customer', CUSTOMER_FULL_SELECT);

/** Loads a ServiceFull (plain object) by id, or null. */
export const loadServiceFull = (id) => populateService(Service.findById(id)).lean().then(withKinds);

/** Task fields of an OpenItem row (shared with the vehicle controller). */
export const openItemTaskFields = (it) => ({
  title: it.title,
  work: it.work ? { title: it.work.title, price: it.work.price ?? null } : null,
  parts: (it.parts || []).map((p) => ({ _id: p._id, title: p.title, qty: p.qty ?? 1, price: p.price ?? null })),
  price: it.price ?? null,
  total: taskTotal(it),
  priced: taskPriced(it),
  notes: it.notes || '',
});

/**
 * Remaining items of a vehicle across all its non-cancelled services (any status), oldest service first.
 * Each row: { serviceId, serviceOpenedAt, serviceStatus, serviceKind, itemId, title, work, parts, price, total, priced, notes }.
 */
export async function openItemsOfVehicle(vehicleId, { excludeServiceId } = {}) {
  const match = {
    vehicle: vehicleId,
    status: { $ne: 'cancelled' },
    items: { $elemMatch: { done: false, 'carriedTo.service': null } },
  };
  if (excludeServiceId) match._id = { $ne: excludeServiceId };

  const services = await Service.find(match)
    .sort({ openedAt: 1, _id: 1 })
    .select('_id openedAt kinds kind otherLabel status items')
    .lean();

  const rows = [];
  for (const s of services) {
    const remaining = (s.items || [])
      .filter((it) => it.done === false && !it.carriedTo?.service)
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

/** Sum of positive balances over non-cancelled services of a vehicle. */
export async function openBalanceOfVehicle(vehicleId) {
  const id = new mongoose.Types.ObjectId(String(vehicleId?._id ?? vehicleId));
  const agg = await Service.aggregate([
    { $match: { vehicle: id, status: { $ne: 'cancelled' }, balance: { $gt: 0.005 } } },
    { $group: { _id: null, openBalance: { $sum: '$balance' } } },
  ]);
  return round2(agg[0]?.openBalance || 0);
}

/** Vehicle (lean, customer populated) + openBalance -> VehicleRow (spec 4). */
export function toVehicleRow(vehicle, { openBalance = 0 } = {}) {
  if (!vehicle) return null;
  const v = toPlain(vehicle);
  const c = v.customer && typeof v.customer === 'object' ? v.customer : null;
  const { annualState, daysToAnnual } = annualStateOf(v);
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
    customer: c ? { _id: c._id, fullName: c.fullName, phone: c.phone || '' } : null,
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
}

/** Loads a fresh VehicleRow by id (after recomputeVehicleStats), or null when the vehicle is gone. */
export async function vehicleRowOf(vehicleId) {
  const id = vehicleId?._id ?? vehicleId;
  const [vehicle, openBalance] = await Promise.all([
    Vehicle.findById(id).populate('customer', CUSTOMER_REF_SELECT).lean(),
    openBalanceOfVehicle(id),
  ]);
  return toVehicleRow(vehicle, { openBalance });
}

/**
 * Cascading hard deletes (spec 3.8, since 2026-09-08): a customer takes their vehicles and services along,
 * a vehicle takes its services, a service takes its payments. Carry links that point at a deleted service
 * are repaired: an origin whose copy is deleted becomes remaining again (or is re-pointed at the copy's own
 * copy when the item was carried further), a copy whose origin is deleted loses its origin caption.
 * Surviving vehicles touched by the deletion are recomputed.
 */
import Service from '../models/Service.js';
import Vehicle from '../models/Vehicle.js';
import { round2 } from './normalize.js';
import { recomputeVehicleStats } from './annual.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** { vehicles, services, payments, paidAmount } for a set of lean services (payments + paidAmount selected). */
const summarize = (vehicles, services) => ({
  vehicles,
  services: services.length,
  payments: services.reduce((n, s) => n + (s.payments?.length || 0), 0),
  paidAmount: round2(services.reduce((n, s) => n + (Number(s.paidAmount) || 0), 0)),
});

const ownedVehicleIds = async (customerId) => (await Vehicle.find({ customer: customerId }).select('_id').lean()).map((v) => v._id);

/** Services a customer deletion removes: the ones billed to the customer plus every service of their vehicles. */
const customerServicesFilter = (customerId, vehicleIds) => ({ $or: [{ customer: customerId }, { vehicle: { $in: vehicleIds } }] });

/** What deleting the customer would remove (for the confirmation dialog). */
export async function previewCustomerDeletion(customerId) {
  const vehicleIds = await ownedVehicleIds(customerId);
  const services = await Service.find(customerServicesFilter(customerId, vehicleIds)).select('payments paidAmount').lean();
  return summarize(vehicleIds.length, services);
}

/** What deleting the vehicle would remove. */
export async function previewVehicleDeletion(vehicleId) {
  const services = await Service.find({ vehicle: vehicleId }).select('payments paidAmount').lean();
  return summarize(1, services);
}

/**
 * Deletes the given service documents (loaded, not lean), repairs carry links in the surviving services and
 * recomputes the surviving vehicles (those listed in `skipVehicles` are about to be deleted themselves).
 * @returns {Promise<{ services: number, payments: number }>}
 */
export async function deleteServicesCascade(services, { skipVehicles = [] } = {}) {
  const list = (services || []).filter(Boolean);
  if (list.length === 0) return { services: 0, payments: 0 };

  const ids = list.map((s) => s._id);
  const deleted = new Set(ids.map(String));
  const isDeleted = (ref) => Boolean(ref?.service) && deleted.has(String(ref.service));

  // surviving services that hold a link to a deleted one, loaded once and saved once
  const touched = new Map();
  const load = async (id) => {
    const key = String(id);
    if (touched.has(key)) return touched.get(key);
    const doc = await Service.findById(id);
    if (doc) touched.set(key, doc);
    return doc;
  };

  for (const s of list) {
    for (const it of s.items || []) {
      const from = it.carriedFrom?.service && !isDeleted(it.carriedFrom) ? it.carriedFrom : null; // surviving origin
      const to = it.carriedTo?.service && !isDeleted(it.carriedTo) ? it.carriedTo : null; // surviving newer copy
      if (from) {
        const origin = await load(from.service);
        const original = origin?.items.id(from.item);
        if (original && sameId(original.carriedTo?.service, s._id)) {
          // the copy was carried further: the origin now points at that live copy; otherwise it is remaining again
          original.carriedTo = to ? { service: to.service, item: to.item } : null;
        }
      }
      if (to) {
        const holder = await load(to.service);
        const copy = holder?.items.id(to.item);
        if (copy && sameId(copy.carriedFrom?.service, s._id)) {
          copy.carriedFrom = from ? { service: from.service, item: from.item } : null;
        }
      }
    }
  }
  for (const doc of touched.values()) await doc.save();

  const payments = list.reduce((n, s) => n + (s.payments?.length || 0), 0);
  await Service.deleteMany({ _id: { $in: ids } });

  const skip = new Set((skipVehicles || []).map(String));
  const vehicles = new Set();
  for (const s of list) if (s.vehicle && !skip.has(String(s.vehicle))) vehicles.add(String(s.vehicle));
  for (const doc of touched.values()) if (doc.vehicle && !skip.has(String(doc.vehicle))) vehicles.add(String(doc.vehicle));
  for (const vid of vehicles) await recomputeVehicleStats(vid);

  return { services: ids.length, payments };
}

/** Deletes the vehicles with every service they had. */
export async function deleteVehiclesCascade(vehicleIds) {
  const ids = (vehicleIds || []).filter(Boolean);
  if (ids.length === 0) return { vehicles: 0, services: 0, payments: 0 };
  const services = await Service.find({ vehicle: { $in: ids } });
  const result = await deleteServicesCascade(services, { skipVehicles: ids });
  await Vehicle.deleteMany({ _id: { $in: ids } });
  return { vehicles: ids.length, ...result };
}

/** Deletes the customer with their vehicles, the services billed to them and the services of their vehicles. */
export async function deleteCustomerCascade(customer) {
  const vehicleIds = await ownedVehicleIds(customer._id);
  const services = await Service.find(customerServicesFilter(customer._id, vehicleIds));
  const result = await deleteServicesCascade(services, { skipVehicles: vehicleIds });
  if (vehicleIds.length) await Vehicle.deleteMany({ _id: { $in: vehicleIds } });
  await customer.deleteOne();
  return { vehicles: vehicleIds.length, ...result };
}

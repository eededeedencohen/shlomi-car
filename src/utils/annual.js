/**
 * Annual service (טיפול שנתי) reminder logic (spec 3.4).
 *
 * - annualStateOf(vehicle, today) is pure: it reads the derived fields already stored on the vehicle.
 * - recomputeVehicleStats(vehicleId) rebuilds every DERIVED field of a vehicle from its services and saves it.
 *   It is the only code allowed to write those fields.
 */
import Service from '../models/Service.js';
import Vehicle from '../models/Vehicle.js';
import { startOfDay, addDays, addMonths, daysBetween } from './dates.js';

export const ANNUAL_INTERVAL_MONTHS = 12;
export const ANNUAL_LEAD_DAYS = 30;
export const ANNUAL_STATES = ['none', 'ok', 'due_soon', 'overdue', 'open', 'muted'];

const OPEN_STATUSES = ['pending', 'in_progress'];

/**
 * @param {object} vehicle - Vehicle document or lean row with annual fields
 * @param {Date} [today] - start of the current day
 * @returns {{ annualState: string, daysToAnnual: number|null }}
 */
export function annualStateOf(vehicle, today = startOfDay()) {
  const dueAt = vehicle?.annualDueAt ? new Date(vehicle.annualDueAt) : null;
  const daysToAnnual = dueAt ? daysBetween(today, dueAt) : null;

  if (vehicle?.annualReminderMuted || vehicle?.active === false) {
    return { annualState: 'muted', daysToAnnual };
  }
  if (vehicle?.openAnnualServiceId != null) {
    return { annualState: 'open', daysToAnnual };
  }
  if (!dueAt) return { annualState: 'none', daysToAnnual: null };

  const horizon = addDays(today, ANNUAL_LEAD_DAYS);
  if (dueAt < today) return { annualState: 'overdue', daysToAnnual };
  if (dueAt <= horizon) return { annualState: 'due_soon', daysToAnnual };
  return { annualState: 'ok', daysToAnnual };
}

/**
 * Rebuilds the derived fields of one vehicle from the services collection and saves the vehicle.
 * Returns the saved Vehicle document, or null when the vehicle no longer exists.
 */
export async function recomputeVehicleStats(vehicleId) {
  const id = vehicleId?._id ?? vehicleId;
  const v = await Vehicle.findById(id);
  if (!v) return null;

  const [lastAnnual, openAnnual, lastAny, servicesCount, openServicesCount, openItemsAgg] =
    await Promise.all([
      Service.findOne({ vehicle: id, kinds: 'annual', status: 'done', completedAt: { $ne: null } })
        .sort({ completedAt: -1, _id: -1 })
        .select('_id completedAt')
        .lean(),
      Service.findOne({ vehicle: id, kinds: 'annual', status: { $in: OPEN_STATUSES } })
        .sort({ openedAt: 1 })
        .select('_id')
        .lean(),
      Service.findOne({ vehicle: id, status: { $ne: 'cancelled' } })
        .sort({ openedAt: -1 })
        .select('openedAt')
        .lean(),
      Service.countDocuments({ vehicle: id, status: { $ne: 'cancelled' } }),
      Service.countDocuments({ vehicle: id, status: { $in: OPEN_STATUSES } }),
      Service.aggregate([
        { $match: { vehicle: v._id, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, openItems: { $sum: '$remainingCount' } } },
      ]),
    ]);

  v.lastAnnualAt = lastAnnual?.completedAt || null;
  v.lastAnnualServiceId = lastAnnual?._id || null;
  v.openAnnualServiceId = openAnnual?._id || null;

  // An annual completed on or after the DAY the override was set closes that cycle: the override was for the
  // previous cycle. Day granularity because the client sends date-only completedAt values (local midnight),
  // which would otherwise sort before a snooze set later the same day.
  if (lastAnnual && v.annualDueOverrideSetAt) {
    const overrideDay = new Date(v.annualDueOverrideSetAt);
    overrideDay.setHours(0, 0, 0, 0);
    if (lastAnnual.completedAt >= overrideDay) {
      v.annualDueOverride = null;
      v.annualDueOverrideSetAt = null;
    }
  }

  v.annualDueAt =
    v.annualDueOverride ||
    (lastAnnual ? addMonths(lastAnnual.completedAt, ANNUAL_INTERVAL_MONTHS) : null);

  v.lastServiceAt = lastAny?.openedAt || null;
  v.servicesCount = servicesCount;
  v.openServicesCount = openServicesCount;
  v.openItemsCount = openItemsAgg[0]?.openItems || 0;

  await v.save();
  return v;
}

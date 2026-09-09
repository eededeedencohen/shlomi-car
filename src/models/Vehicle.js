import mongoose from 'mongoose';
import { normalizePlate, isValidPlate, formatPlate } from '../utils/normalize.js';

const { Schema } = mongoose;

export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'other'];

/**
 * Vehicle (רכב). `customer` is the CURRENT owner only (ownership history is not tracked).
 * Fields marked DERIVED are written only by recomputeVehicleStats (utils/annual.js); never $inc them by hand.
 */
const vehicleSchema = new Schema(
  {
    plateNumber: {
      type: String,
      required: [true, 'מספר רכב חייב להכיל 7 או 8 ספרות'],
      set: normalizePlate,
      validate: {
        validator: isValidPlate,
        message: 'מספר רכב חייב להכיל 7 או 8 ספרות',
      },
    },
    customer: {
      type: Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'יש לבחור לקוח או ליצור לקוח חדש'],
    },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    year: {
      type: Number,
      validate: {
        validator: (v) => v == null || (v >= 1950 && v <= new Date().getFullYear() + 1),
        message: 'שנת ייצור לא תקינה',
      },
    },
    color: { type: String, trim: true },
    fuelType: { type: String, enum: FUEL_TYPES },
    engineNotes: { type: String, trim: true },
    mileage: { type: Number, min: [0, 'קילומטראז\' לא יכול להיות שלילי'], default: null },
    mileageUpdatedAt: { type: Date, default: null },
    notes: { type: String, trim: true },
    // false = sold / scrapped: excluded from reminders and default lists, history intact
    active: { type: Boolean, default: true, index: true },

    // Owner's explicit next-due date (also used for "snooze") and when it was set (auto-cleared, spec 3.4)
    annualDueOverride: { type: Date, default: null },
    annualDueOverrideSetAt: { type: Date, default: null },
    annualReminderMuted: { type: Boolean, default: false },

    // DERIVED
    lastAnnualAt: { type: Date, default: null },
    lastAnnualServiceId: { type: Schema.Types.ObjectId, ref: 'Service', default: null },
    openAnnualServiceId: { type: Schema.Types.ObjectId, ref: 'Service', default: null },
    annualDueAt: { type: Date, default: null, index: true },
    lastServiceAt: { type: Date, default: null },
    servicesCount: { type: Number, default: 0 },
    openServicesCount: { type: Number, default: 0 },
    openItemsCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

vehicleSchema.virtual('plateFormatted').get(function plateFormatted() {
  return formatPlate(this.plateNumber);
});

vehicleSchema.index({ plateNumber: 1 }, { unique: true });
vehicleSchema.index({ customer: 1 });
vehicleSchema.index({ active: 1, annualReminderMuted: 1, annualDueAt: 1 });
vehicleSchema.index({ lastServiceAt: -1 });
vehicleSchema.index({ make: 1, model: 1 });

export default mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);

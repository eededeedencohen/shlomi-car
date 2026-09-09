import mongoose from 'mongoose';
import { normalizePhone, isValidPhone } from '../utils/normalize.js';

const { Schema } = mongoose;

/** Phone field: normalized on set, may be empty, otherwise an Israeli number (0 + 8..9 digits). */
const phoneField = {
  type: String,
  trim: true,
  set: normalizePhone,
  validate: {
    validator: (v) => !v || isValidPhone(v),
    message: 'מספר טלפון לא תקין',
  },
};

/**
 * Customer (לקוח). No money counters live here; lists and detail views aggregate from services.
 * Phone is NOT unique (family members share phones); duplicates are surfaced, never blocked.
 */
const customerSchema = new Schema(
  {
    fullName: { type: String, required: [true, 'שם מלא הוא שדה חובה'], trim: true },
    phone: phoneField,
    phone2: phoneField,
    email: { type: String, trim: true, lowercase: true },
    notes: { type: String, trim: true },
    // false = archived: hidden from pickers and default lists, history kept
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

customerSchema.index({ fullName: 1 });
customerSchema.index({ phone: 1 });
customerSchema.index({ phone2: 1 });
customerSchema.index({ active: 1, fullName: 1 });

export default mongoose.models.Customer || mongoose.model('Customer', customerSchema);

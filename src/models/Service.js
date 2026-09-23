import mongoose from 'mongoose';
import { round2 } from '../utils/normalize.js';
import { deriveTitle, taskTotal, taskPriced } from '../utils/tasks.js';
import { taskFields } from './taskSchemas.js';

const { Schema } = mongoose;

// Canonical order of the service tags (a visit carries one to four of them: שנתי / לפני טסט / תיקון / אחר).
export const SERVICE_KINDS = ['annual', 'inspection', 'repair', 'other'];
export const OTHER_LABEL_MAX = 15;
export const SERVICE_STATUSES = ['pending', 'in_progress', 'done', 'cancelled'];

/** Any list (or a single value) -> the known kinds, unique, in canonical order. */
export const normalizeKinds = (list) => {
  const arr = Array.isArray(list) ? list : list == null ? [] : [list];
  return SERVICE_KINDS.filter((k) => arr.includes(k));
};

/** The kinds of a stored document; rows written before 2026-09-23 only carry the single `kind`. */
export const kindsOf = (doc) => {
  const kinds = normalizeKinds(doc?.kinds?.length ? doc.kinds : doc?.kind);
  return kinds.length ? kinds : ['repair'];
};
export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'];
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'credit', 'check', 'bit', 'other'];
export const TOTAL_MODES = ['items', 'manual'];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Reference to an item in another service (carry-forward links, spec 3.5). */
const carryRefSchema = new Schema(
  {
    service: { type: Schema.Types.ObjectId, ref: 'Service' },
    item: { type: Schema.Types.ObjectId },
  },
  { _id: false }
);

/**
 * WorkItem (רשומה / משימה): one checklist line = optional work (labor) + parts (qty x unit price)
 * + optional record price. `total` / `priced` are DERIVED in the parent pre-validate.
 */
const workItemSchema = new Schema({
  ...taskFields(),
  total: { type: Number, default: 0 },
  priced: { type: Boolean, default: false },
  done: { type: Boolean, default: false },
  // set when done flips true, cleared when false (parent pre-validate)
  doneAt: { type: Date, default: null },
  notes: { type: String, trim: true },
  template: { type: Schema.Types.ObjectId, ref: 'WorkItemTemplate', default: null },
  // this item was copied from a remaining item of an older service
  carriedFrom: { type: carryRefSchema, default: null },
  // set on the ORIGINAL item when it is carried forward; an item with carriedTo is no longer "remaining"
  carriedTo: { type: carryRefSchema, default: null },
  // display order, defaults to array index
  order: { type: Number, default: null },
});

/** Payment: money actually received against this service. */
const paymentSchema = new Schema({
  amount: {
    type: Number,
    required: [true, 'סכום חייב להיות גדול מאפס'],
    min: [0.01, 'סכום חייב להיות גדול מאפס'],
  },
  paidAt: {
    type: Date,
    required: [true, 'יש להזין תאריך תשלום'],
    default: Date.now,
    validate: {
      validator: (v) => v == null || v.getTime() <= Date.now() + ONE_DAY_MS,
      message: 'תאריך התשלום לא יכול להיות בעתיד',
    },
  },
  method: { type: String, enum: PAYMENT_METHODS, required: true, default: 'cash' },
  note: { type: String, trim: true },
});

/** Append-only status transition log. */
const statusHistorySchema = new Schema({
  from: { type: String, default: null },
  to: { type: String, required: true },
  at: { type: Date, required: true, default: Date.now },
  note: { type: String, trim: true, default: '' },
});

/**
 * Service (טיפול): one visit of one vehicle. `customer` is a SNAPSHOT of the vehicle owner at creation
 * (the person billed) and `plateNumber` is denormalized so lists and search need no populate.
 * DERIVED money / count fields are rebuilt by `recalc()` in pre-validate on every save.
 */
const serviceSchema = new Schema(
  {
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    plateNumber: { type: String, required: true },
    // the tags of the visit (1 to 4, canonical order); `kind` is DERIVED = the leading tag, kept for old
    // readers and for rows written before the tags existed
    kinds: { type: [{ type: String, enum: SERVICE_KINDS }], default: undefined, index: true },
    kind: { type: String, enum: SERVICE_KINDS, default: 'repair', index: true },
    // the name given to an 'אחר' visit (up to 15 characters); blank unless 'other' is among the kinds
    otherLabel: { type: String, trim: true, maxlength: [OTHER_LABEL_MAX, `שם הטיפול עד ${OTHER_LABEL_MAX} תווים`], default: '' },
    status: { type: String, enum: SERVICE_STATUSES, default: 'pending', index: true },

    // the visit date; editable
    openedAt: { type: Date, required: true, default: Date.now, index: true },
    // first transition into in_progress
    startedAt: { type: Date, default: null },
    // set on done, cleared on reopen / cancel
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true },

    mileage: { type: Number, min: [0, 'קילומטראז\' לא יכול להיות שלילי'], default: null },
    items: { type: [workItemSchema], default: [] },
    notes: { type: String, trim: true },
    payments: { type: [paymentSchema], default: [] },

    totalMode: { type: String, enum: TOTAL_MODES, default: 'items' },
    // used only when totalMode = 'manual'
    manualTotal: { type: Number, min: [0, 'מחיר לא יכול להיות שלילי'], default: null },

    // DERIVED (recalc)
    itemsCount: { type: Number, default: 0 },
    itemsDoneCount: { type: Number, default: 0 },
    remainingCount: { type: Number, default: 0 },
    itemsTotal: { type: Number, default: 0 },
    remainingQuote: { type: Number, default: 0 },
    totalPrice: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    balance: { type: Number, default: 0, index: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid', index: true },

    statusHistory: { type: [statusHistorySchema], default: [] },
  },
  // optimisticConcurrency: two saves of the same document from stale copies (double tap, second tab)
  // conflict instead of silently overwriting each other's derived money fields (VersionError -> 409).
  { timestamps: true, optimisticConcurrency: true }
);

// Remember the persisted status so the validate hook can log the transition it came from.
serviceSchema.post('init', function rememberStatus(doc) {
  doc.$locals.prevStatus = doc.status;
});

serviceSchema.pre('validate', function serviceSideEffects(next) {
  const now = new Date();

  // tags: always at least one, canonical order, the leading one mirrored into `kind`
  this.kinds = kindsOf(this);
  this.kind = this.kinds[0];
  if (!this.kinds.includes('other')) this.otherLabel = '';

  this.items.forEach((it, i) => {
    if (!it.title) it.title = deriveTitle(it);
    it.total = taskTotal(it);
    it.priced = taskPriced(it);
    if (it.done && !it.doneAt) it.doneAt = now;
    if (!it.done) it.doneAt = null;
    if (it.order == null) it.order = i;
  });

  // status side effects (controllers set this.status; the hook keeps the dates consistent)
  if (this.isNew || this.isModified('status')) {
    const prev = this.isNew ? null : (this.$locals.prevStatus ?? null);
    if (this.status === 'in_progress' && !this.startedAt) this.startedAt = now;
    if (this.status === 'done') {
      if (!this.completedAt) this.completedAt = now;
      this.cancelledAt = null;
    }
    if (this.status === 'cancelled') {
      if (!this.cancelledAt) this.cancelledAt = now;
      this.completedAt = null;
    }
    if (this.status === 'pending' || this.status === 'in_progress') {
      this.completedAt = null;
      this.cancelledAt = null;
    }
    if (!this.isNew || this.status !== 'pending') {
      this.statusHistory.push({
        from: prev,
        to: this.status,
        at: now,
        note: this.$locals.statusNote || '',
      });
    }
    this.$locals.prevStatus = this.status;
  }

  this.recalc();
  next();
});

/**
 * Payment math, single source of truth (spec 3.2). Pure and idempotent.
 * Task totals are recomputed here (not read from the stored `total`) so a task pushed moments
 * before a save is already counted.
 */
serviceSchema.methods.recalc = function recalc() {
  const remaining = this.items.filter((i) => !i.done && !i.carriedTo?.service);
  const doneItems = this.items.filter((i) => i.done);

  this.itemsCount = this.items.length;
  this.itemsDoneCount = doneItems.length;
  this.remainingCount = remaining.length;
  this.itemsTotal = round2(doneItems.reduce((s, i) => s + taskTotal(i), 0));
  this.remainingQuote = round2(remaining.reduce((s, i) => s + taskTotal(i), 0));

  const base = this.totalMode === 'manual' ? (this.manualTotal || 0) : this.itemsTotal;
  this.totalPrice = this.status === 'cancelled' ? 0 : round2(base);
  this.paidAmount = round2(this.payments.reduce((s, p) => s + (p.amount || 0), 0));
  this.balance = round2(this.totalPrice - this.paidAmount);

  if (this.paidAmount <= 0.005) this.paymentStatus = 'unpaid';
  else if (this.balance > 0.005) this.paymentStatus = 'partial';
  else this.paymentStatus = 'paid';
};

serviceSchema.index({ vehicle: 1, openedAt: -1 });
serviceSchema.index({ customer: 1, openedAt: -1 });
serviceSchema.index({ status: 1, openedAt: 1 });
serviceSchema.index({ status: 1, balance: 1 });
serviceSchema.index({ paymentStatus: 1, openedAt: -1 });
serviceSchema.index({ vehicle: 1, kinds: 1, status: 1, completedAt: -1 });
serviceSchema.index({ plateNumber: 1 });
serviceSchema.index({ openedAt: -1 });
serviceSchema.index({ updatedAt: -1 });
serviceSchema.index({ 'payments.paidAt': 1 });
serviceSchema.index({ 'items.title': 1 });
serviceSchema.index({ 'items.parts.title': 1 });

export default mongoose.models.Service || mongoose.model('Service', serviceSchema);

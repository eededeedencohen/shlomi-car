import mongoose from 'mongoose';
import { titleKeyOf } from '../utils/normalize.js';
import { deriveTitle } from '../utils/tasks.js';
import { taskFields } from './taskSchemas.js';
import { SERVICE_KINDS } from './Service.js';

const { Schema } = mongoose;

/**
 * One line of a bundle = a task snapshot (work + parts + record price). The task is always copied
 * (a deleted catalog entry does not break the bundle); `template` links it to the catalog for stats.
 * Whether the line enters a service as "בוצע" or "יש לבצע" is decided in the service, not here.
 */
const bundleLineSchema = new Schema({
  ...taskFields(),
  template: { type: Schema.Types.ObjectId, ref: 'WorkItemTemplate', default: null },
  notes: { type: String, trim: true, maxlength: [500, 'הערה ארוכה מדי'], default: '' },
});

/**
 * ServiceBundle (חבילת טיפול): a named, fixed set of tasks such as 'טיפול שנתי' or
 * 'טיפול 15,000 ק"מ'. Picking a bundle in a service adds all of its lines at once; the owner can
 * still add or remove lines in that specific service. `kind` is the suggested service kind.
 */
const serviceBundleSchema = new Schema(
  {
    title: {
      type: String,
      required: [true, 'שם החבילה הוא שדה חובה'],
      trim: true,
      maxlength: [200, 'שם החבילה ארוך מדי'],
    },
    // unique key derived from the title (pre-validate)
    titleKey: { type: String },
    description: { type: String, trim: true, maxlength: [500, 'התיאור ארוך מדי'], default: '' },
    // suggested service kind when the bundle is applied; null = leave the service kind as is
    kind: { type: String, enum: SERVICE_KINDS, default: null },
    items: {
      type: [bundleLineSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'חבילה חייבת להכיל לפחות פריט אחד',
      },
    },
    usageCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    // soft delete
    active: { type: Boolean, default: true },
    // manual pinning; lower first
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

serviceBundleSchema.pre('validate', function setKeys(next) {
  this.titleKey = titleKeyOf(this.title);
  (this.items || []).forEach((line) => {
    const derived = deriveTitle(line);
    if (derived) line.title = derived;
  });
  next();
});

/** Usage bump for bundles applied to a service (fire-and-forget by the caller). */
serviceBundleSchema.statics.bumpUsage = function bumpUsage(ids) {
  const valid = (ids || []).filter((id) => mongoose.isValidObjectId(String(id)));
  if (!valid.length) return Promise.resolve(null);
  return this.updateMany({ _id: { $in: valid } }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } });
};

serviceBundleSchema.index({ titleKey: 1 }, { unique: true });
serviceBundleSchema.index({ active: 1, order: 1, usageCount: -1 });

export default mongoose.models.ServiceBundle || mongoose.model('ServiceBundle', serviceBundleSchema);

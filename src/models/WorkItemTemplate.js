import mongoose from 'mongoose';
import { titleKeyOf } from '../utils/normalize.js';
import { deriveTitle } from '../utils/tasks.js';
import { taskFields } from './taskSchemas.js';

const { Schema } = mongoose;

export const TEMPLATE_CATEGORIES = [
  'oil',
  'filters',
  'brakes',
  'tires',
  'electrical',
  'engine',
  'ac',
  'body',
  'inspection',
  'cleaning',
  'general',
];

/**
 * WorkItemTemplate (משימה בקטלוג): a ready-made task = optional work (labor) + parts + optional record price.
 * Picking it copies the task onto a service; the template ref on the copy is for usage stats and price refresh.
 * Prices on the template are "the last price used" and are refreshed on every use.
 */
const workItemTemplateSchema = new Schema(
  {
    ...taskFields(),
    // unique key derived from the (derived) title (pre-validate)
    titleKey: { type: String },
    category: { type: String, enum: TEMPLATE_CATEGORIES, default: 'general' },
    usageCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    // soft delete
    active: { type: Boolean, default: true },
    // manual pinning; lower first
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

workItemTemplateSchema.pre('validate', function setTitleKey(next) {
  const derived = deriveTitle(this);
  if (derived) this.title = derived;
  this.titleKey = titleKeyOf(this.title);
  next();
});

workItemTemplateSchema.index({ titleKey: 1 }, { unique: true });
workItemTemplateSchema.index({ active: 1, order: 1, usageCount: -1 });
workItemTemplateSchema.index({ lastUsedAt: -1 });

export default mongoose.models.WorkItemTemplate ||
  mongoose.model('WorkItemTemplate', workItemTemplateSchema);

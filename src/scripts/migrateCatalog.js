/**
 * migrateCatalog.js - upgrades catalog entries, bundle lines and service items from the flat shape
 * ({ title, qty, price, defaultPrice, lastPrice, defaultDone }) to the task shape
 * (work + parts + record price). Idempotent: documents / lines that already carry a `parts` array are skipped.
 *   node src/scripts/migrateCatalog.js     (npm run migrate:catalog)
 * Safe to run in production (only adds the new fields and removes the retired ones).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: WorkItemTemplate } = await import('../models/WorkItemTemplate.js');
const { default: ServiceBundle } = await import('../models/ServiceBundle.js');
const { default: Service } = await import('../models/Service.js');
const { guessTaskType, deriveTitle, taskTotal, taskPriced } = await import('../utils/tasks.js');

const templates = WorkItemTemplate.collection;
const bundles = ServiceBundle.collection;
const services = Service.collection;

/** Legacy catalog entry: the old price becomes the labor price (work) or the unit price (part). */
const legacyTemplateTask = (doc) => {
  const title = String(doc.title || '').trim();
  const price = doc.lastPrice ?? doc.defaultPrice ?? null;
  if (guessTaskType(title) === 'work') return { work: { title, price }, parts: [], price: null };
  return { work: null, parts: [{ title, qty: 1, price }], price: null };
};

/** Legacy line / item: the old price was a line total, so it becomes the record price. */
const legacyLineTask = (line) => {
  const title = String(line.title || '').trim();
  const price = line.price ?? null;
  if (guessTaskType(title) === 'work') return { work: { title, price: null }, parts: [], price };
  return { work: null, parts: [{ title, qty: line.qty || 1, price: null }], price };
};

const copyTemplateTask = (tpl, line) => {
  const task = {
    work: tpl.work ? { title: tpl.work.title, price: tpl.work.price ?? null } : null,
    parts: (tpl.parts || []).map((p) => ({ title: p.title, qty: p.qty || 1, price: p.price ?? null })),
    price: tpl.price ?? null,
  };
  if (line.qty && task.parts.length === 1) task.parts[0].qty = line.qty;
  if (line.price != null) task.price = line.price;
  return task;
};

await connectDB();
try {
  // 1. catalog entries
  let migratedTemplates = 0;
  for (const doc of await templates.find({ parts: { $exists: false } }).toArray()) {
    const task = legacyTemplateTask(doc);
    await templates.updateOne(
      { _id: doc._id },
      {
        $set: { title: deriveTitle(task) || doc.title, work: task.work, parts: task.parts, price: task.price },
        $unset: { defaultPrice: '', lastPrice: '', defaultDone: '' },
      }
    );
    migratedTemplates += 1;
  }

  // 2. bundle lines (after the templates, so a line can copy its template's task)
  const templateById = new Map((await templates.find({}).toArray()).map((t) => [String(t._id), t]));
  let migratedBundles = 0;
  for (const bundle of await bundles.find({}).toArray()) {
    let changed = false;
    const items = (bundle.items || []).map((line) => {
      if (Array.isArray(line.parts)) return line;
      changed = true;
      const tpl = line.template ? templateById.get(String(line.template)) : null;
      const task = tpl && Array.isArray(tpl.parts) ? copyTemplateTask(tpl, line) : legacyLineTask(line);
      return {
        _id: line._id,
        template: line.template ?? null,
        title: deriveTitle(task) || line.title,
        work: task.work,
        parts: task.parts,
        price: task.price,
        notes: line.notes || '',
      };
    });
    if (changed) {
      await bundles.updateOne({ _id: bundle._id }, { $set: { items } });
      migratedBundles += 1;
    }
  }

  // 3. service items (a fresh database has none; kept for completeness)
  let migratedServices = 0;
  for (const svc of await services.find({ items: { $elemMatch: { parts: { $exists: false } } } }).toArray()) {
    let changed = false;
    const items = (svc.items || []).map((it) => {
      if (Array.isArray(it.parts)) return it;
      changed = true;
      const { qty, ...rest } = it;
      const task = legacyLineTask(it);
      const next = { ...rest, title: deriveTitle(task) || it.title, work: task.work, parts: task.parts, price: task.price };
      next.total = taskTotal(next);
      next.priced = taskPriced(next);
      return next;
    });
    if (changed) {
      await services.updateOne({ _id: svc._id }, { $set: { items } });
      migratedServices += 1;
    }
  }

  console.log(`Migrated: ${migratedTemplates} catalog entries, ${migratedBundles} bundles, ${migratedServices} services.`);
} finally {
  await disconnectDB();
}
process.exit(0);

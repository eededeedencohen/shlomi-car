/**
 * seedTemplates.js - idempotent insert of the task catalog (spec section 8).
 *   node src/scripts/seedTemplates.js     (npm run seed:templates)
 * Safe in production: existing entries are never modified, only missing ones (by title) are inserted.
 * Also exported as `seedTemplates()` so seedDemo.js can run the same upsert.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import WorkItemTemplate from '../models/WorkItemTemplate.js';
import { titleKeyOf } from '../utils/normalize.js';

/**
 * Catalog entries. `part` = a part-only task, `work` = labor (optionally with `parts`).
 * Prices are left empty: the first use of each task fills them in. Order = position in this list.
 */
export const TEMPLATE_CATALOG = [
  // combined tasks: labor + the parts it uses
  { work: 'החלפת שמן ומסנן', parts: ['שמן מנוע 5w30', 'מסנן שמן מקורי'], category: 'oil' },
  // parts
  { part: 'מסנן שמן מקורי', category: 'filters' },
  { part: 'מסנן שמן חליפי', category: 'filters' },
  { part: 'שמן מנוע 5w40', category: 'oil' },
  { part: 'שמן מנוע 5w30', category: 'oil' },
  { part: 'שמן מנוע 0w20', category: 'oil' },
  { part: 'מסנן אוויר מקורי', category: 'filters' },
  { part: 'מסנן אוויר חליפי', category: 'filters' },
  { part: 'מסנן מזגן', category: 'filters' },
  { part: 'מסנן דלק', category: 'filters' },
  { part: 'רפידות בלם קדמיות', category: 'brakes' },
  { part: 'רפידות בלם אחוריות', category: 'brakes' },
  { part: 'דיסקים קדמיים', category: 'brakes' },
  { part: 'נוזל בלמים', category: 'brakes' },
  { part: 'נוזל קירור', category: 'engine' },
  { part: 'מצבר', category: 'electrical' },
  { part: 'נורת איתות', category: 'electrical' },
  { part: 'נורת פנס ראשי', category: 'electrical' },
  { part: 'מגבים', category: 'general' },
  { part: 'פקק אטימה בראש מנוע', category: 'engine' },
  { part: 'מנוע מתזי שמשות', category: 'electrical' },
  { part: 'רצועת טיימינג', category: 'engine' },
  { part: 'פלאגים', category: 'engine' },
  // labor
  { work: 'ניקוי תחתית הרכב', category: 'cleaning' },
  { work: 'איזון גלגלים', category: 'tires' },
  { work: 'כיוון פרונט', category: 'tires' },
  { work: 'החלפת צמיגים', category: 'tires' },
  { work: 'בדיקת מזגן ומילוי גז', category: 'ac' },
  { work: 'בדיקה לפני טסט', category: 'inspection' },
  { work: 'טסט שנתי', category: 'inspection' },
  { work: 'החלפת רפידות בלם קדמיות', parts: ['רפידות בלם קדמיות'], category: 'brakes' },
  { work: 'החלפת מצבר', parts: ['מצבר'], category: 'electrical' },
];

/** Catalog entry -> task fields { title, work, parts, price }. */
export const catalogEntryTask = (entry) => {
  if (entry.work) {
    return {
      title: entry.work,
      work: { title: entry.work, price: entry.workPrice ?? null },
      parts: (entry.parts || []).map((p) => (typeof p === 'string' ? { title: p, qty: 1, price: null } : { title: p.title, qty: p.qty || 1, price: p.price ?? null })),
      price: null,
    };
  }
  return { title: entry.part, work: null, parts: [{ title: entry.part, qty: 1, price: entry.price ?? null }], price: null };
};

/**
 * Inserts every catalog entry that is missing (by titleKey). Existing documents are left untouched
 * (owner edits such as prices, category or active flag survive re-runs).
 * @returns {Promise<{ inserted: number, existing: number, total: number }>}
 */
export async function seedTemplates() {
  let inserted = 0;
  for (let i = 0; i < TEMPLATE_CATALOG.length; i += 1) {
    const entry = TEMPLATE_CATALOG[i];
    const task = catalogEntryTask(entry);
    const titleKey = titleKeyOf(task.title);
    const exists = await WorkItemTemplate.exists({ titleKey });
    if (exists) continue;
    await WorkItemTemplate.create({
      ...task,
      titleKey,
      category: entry.category || 'general',
      usageCount: 0,
      lastUsedAt: null,
      active: true,
      order: i,
    });
    inserted += 1;
  }
  const total = await WorkItemTemplate.countDocuments();
  return { inserted, existing: TEMPLATE_CATALOG.length - inserted, total };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  const { connectDB, disconnectDB } = await import('../config/db.js');

  await connectDB();
  try {
    const { inserted, existing, total } = await seedTemplates();
    console.log(`\nTemplates ready: ${inserted} inserted, ${existing} already existed, ${total} in catalog.\n`);
  } finally {
    await disconnectDB();
  }
  process.exit(0);
}

/**
 * seedBundles.js - idempotent insert of a few starter service bundles (חבילות טיפול).
 *   node src/scripts/seedBundles.js [--refresh]     (npm run seed:bundles [-- --refresh])
 * Existing bundles are never modified; only missing ones (by title) are inserted.
 * --refresh recreates the starter bundles that were never used from the current definitions.
 * Each line copies the task of the catalog entry with that title (run seed:templates first).
 * Also exported as `seedBundles()` for seedDemo.js.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import ServiceBundle from '../models/ServiceBundle.js';
import WorkItemTemplate from '../models/WorkItemTemplate.js';
import { titleKeyOf } from '../utils/normalize.js';
import { copyTaskFields, guessTaskType } from '../utils/tasks.js';

/** title / kind (null = keep the service kind) / description / line titles (catalog task titles). */
export const BUNDLE_CATALOG = [
  {
    title: 'טיפול שנתי',
    kind: 'annual',
    // Shlomi's standard (2026-09-23): the lines every annual visit opens with (seedAnnualBundle.js keeps them)
    description: 'נוסף אוטומטית לכל טיפול שנתי: שמן מנוע (סוג השמן נבחר בטיפול), מסנן שמן מנוע, מסנן אוויר ומסנן מזגן. אפשר להוסיף או להסיר בטיפול עצמו.',
    items: ['שמן מנוע', 'מסנן שמן מנוע', 'מסנן אוויר', 'מסנן מזגן'],
  },
  {
    title: 'טיפול שמן ומסנן',
    kind: null,
    description: 'טיפול קטן בין הטיפולים השנתיים.',
    items: ['החלפת שמן ומסנן'],
  },
  {
    title: 'בלמים קדמיים',
    kind: 'repair',
    description: 'החלפת רפידות ודיסקים קדמיים.',
    items: ['החלפת רפידות בלם קדמיות', 'דיסקים קדמיים'],
  },
];

/** A bundle line for a catalog title: the template's task when it exists, else a bare task from the title. */
const lineFor = (title, templateByKey) => {
  const tpl = templateByKey.get(titleKeyOf(title));
  if (tpl) return { template: tpl._id, ...copyTaskFields(tpl), notes: '' };
  const work = guessTaskType(title) === 'work';
  return {
    template: null,
    title,
    work: work ? { title, price: null } : null,
    parts: work ? [] : [{ title, qty: 1, price: null }],
    price: null,
    notes: '',
  };
};

/**
 * Inserts every starter bundle that does not exist yet (by titleKey).
 * `refresh: true` first removes starter bundles that were never used, so they are recreated from the
 * current definitions (bundles the owner already applied to a service are kept as they are).
 * @returns {Promise<{ inserted: number, existing: number, total: number, refreshed: number }>}
 */
export async function seedBundles({ refresh = false } = {}) {
  const templates = await WorkItemTemplate.find({}).lean();
  const templateByKey = new Map(templates.map((t) => [t.titleKey, t]));

  let refreshed = 0;
  if (refresh) {
    const keys = BUNDLE_CATALOG.map((entry) => titleKeyOf(entry.title));
    const removed = await ServiceBundle.deleteMany({ titleKey: { $in: keys }, usageCount: { $in: [0, null] } });
    refreshed = removed.deletedCount || 0;
  }

  let inserted = 0;
  for (let i = 0; i < BUNDLE_CATALOG.length; i += 1) {
    const entry = BUNDLE_CATALOG[i];
    const titleKey = titleKeyOf(entry.title);
    const exists = await ServiceBundle.exists({ titleKey });
    if (exists) continue;
    await ServiceBundle.create({
      title: entry.title,
      description: entry.description || '',
      kind: entry.kind || null,
      order: i,
      items: entry.items.map((title) => lineFor(title, templateByKey)),
    });
    inserted += 1;
  }
  const total = await ServiceBundle.countDocuments();
  return { inserted, existing: BUNDLE_CATALOG.length - inserted, total, refreshed };
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
    const refresh = process.argv.includes('--refresh');
    const { inserted, existing, total, refreshed } = await seedBundles({ refresh });
    console.log(`\nBundles ready: ${inserted} inserted, ${existing} already existed${refresh ? `, ${refreshed} unused starters recreated` : ''}, ${total} in catalog.\n`);
  } finally {
    await disconnectDB();
  }
  process.exit(0);
}

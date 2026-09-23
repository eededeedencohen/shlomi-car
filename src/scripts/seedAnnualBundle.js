/**
 * seedAnnualBundle.js - the lines of the 'טיפול שנתי' bundle (kind annual), which every visit tagged שנתי
 * opens with, set to Shlomi's standard list: שמן מנוע, מסנן שמן מנוע, מסנן אוויר, מסנן מזגן.
 *   node src/scripts/seedAnnualBundle.js [--dry]      (npm run seed:annual [-- --dry])
 * Idempotent: the bundle is created when there is none; lines already on the list keep their prices and
 * catalog links; lines that are not on the list are dropped (they can be added back in the catalog page).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import ServiceBundle from '../models/ServiceBundle.js';
import WorkItemTemplate from '../models/WorkItemTemplate.js';
import { titleKeyOf } from '../utils/normalize.js';
import { copyTaskFields, guessTaskType } from '../utils/tasks.js';

export const ANNUAL_STANDARD_TASKS = ['שמן מנוע', 'מסנן שמן מנוע', 'מסנן אוויר', 'מסנן מזגן'];
const DESCRIPTION = 'נוסף אוטומטית לכל טיפול שנתי: שמן מנוע (סוג השמן נבחר בטיפול), מסנן שמן מנוע, מסנן אוויר ומסנן מזגן. אפשר להוסיף או להסיר בטיפול עצמו.';

const lineFor = (title, templateByKey) => {
  const tpl = templateByKey.get(titleKeyOf(title));
  if (tpl) return { template: tpl._id, ...copyTaskFields(tpl), notes: '' };
  const work = guessTaskType(title) === 'work';
  return { template: null, title, work: work ? { title, price: null } : null, parts: work ? [] : [{ title, qty: 1, price: null }], price: null, notes: '' };
};

/** @returns {Promise<{ created: boolean, before: string[], after: string[] }>} */
export async function seedAnnualBundle({ dry = false } = {}) {
  const templates = await WorkItemTemplate.find({}).lean();
  const templateByKey = new Map(templates.map((t) => [t.titleKey || titleKeyOf(t.title), t]));
  let bundle = await ServiceBundle.findOne({ kind: 'annual', active: { $ne: false } }).sort({ order: 1, createdAt: 1 });
  if (!bundle) bundle = await ServiceBundle.findOne({ titleKey: titleKeyOf('טיפול שנתי') });
  const before = bundle ? bundle.items.map((l) => l.title) : [];
  const existingByKey = new Map((bundle?.items || []).map((l) => [titleKeyOf(l.title), l]));
  const items = ANNUAL_STANDARD_TASKS.map((title) => {
    const kept = existingByKey.get(titleKeyOf(title));
    return kept ? kept.toObject() : lineFor(title, templateByKey);
  });
  if (dry) return { created: !bundle, before, after: items.map((l) => l.title) };
  if (!bundle) {
    bundle = await ServiceBundle.create({ title: 'טיפול שנתי', description: DESCRIPTION, kind: 'annual', order: 0, items });
    return { created: true, before, after: bundle.items.map((l) => l.title) };
  }
  bundle.items = items;
  bundle.kind = 'annual';
  bundle.active = true;
  if (!bundle.description) bundle.description = DESCRIPTION;
  await bundle.save();
  return { created: false, before, after: bundle.items.map((l) => l.title) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  const { connectDB, disconnectDB } = await import('../config/db.js');
  await connectDB();
  try {
    const dry = process.argv.includes('--dry');
    const { created, before, after } = await seedAnnualBundle({ dry });
    console.log(`${dry ? '[dry run] ' : ''}annual bundle ${created ? 'created' : 'updated'}:`);
    console.log(`  before: ${before.length ? before.join(' | ') : '(none)'}`);
    console.log(`  after:  ${after.join(' | ')}`);
  } finally {
    await disconnectDB();
  }
  process.exit(0);
}

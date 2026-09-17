/**
 * seedCustomerHistory.js - test visits for ONE existing vehicle, so the history page has something to show.
 *   node src/scripts/seedCustomerHistory.js --plate 1546665 [--name "עדן כהן"] [--dry] [--remove]
 *   (npm run seed:history -- --plate 1546665)
 *
 * Touches nothing but that vehicle: it adds a few finished visits in the past (tasks with works and parts,
 * notes, mileage below the current odometer, every visit paid in full so no balance appears), all tagged
 * with TEST_MARK at the end of their notes. `--remove` deletes exactly those tagged visits again.
 * `--name` is a safety check: the vehicle's owner must carry that name. `--dry` only prints what was found.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import dayjs from 'dayjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TEST_MARK = '(נתוני בדיקה)';

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const PLATE = String(argOf('--plate') || '').replace(/\D/g, '');
const NAME = argOf('--name');
const DRY = process.argv.includes('--dry');
const REMOVE = process.argv.includes('--remove');

if (!PLATE) {
  console.error('Usage: node src/scripts/seedCustomerHistory.js --plate <digits> [--name "<owner>"] [--dry] [--remove]');
  process.exit(1);
}

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Customer } = await import('../models/Customer.js');
const { default: Vehicle } = await import('../models/Vehicle.js');
const { default: Service } = await import('../models/Service.js');
const { recomputeVehicleStats } = await import('../utils/annual.js');
const { normalizeTask, taskTotal } = await import('../utils/tasks.js');

const work = (title, price, parts = [], extra = {}) => ({ work: { title, price }, parts, done: true, ...extra });
const part = (title, qty = 1, price = null) => ({ title, qty, price });
const single = (title, qty, price, extra = {}) => ({ parts: [part(title, qty, price)], done: true, ...extra });

/** monthsAgo / day = when the visit happened; mileageBack = km below the odometer of today. */
const VISITS = [
  {
    monthsAgo: 30, day: 12, kind: 'annual', mileageBack: 40600,
    items: [
      work('החלפת שמן ומסנן', 100, [part('שמן מנוע 5w30', 4, 45), part('מסנן שמן מקורי', 1, 60)]),
      single('מסנן אוויר מקורי', 1, 95),
      single('מסנן מזגן', 1, 80),
      work('בדיקת בלמים', 0),
    ],
    notes: 'טיפול שנתי רגיל. רפידות קדמיות ב-40 אחוז, לעקוב בטיפול הבא.',
  },
  {
    monthsAgo: 24, day: 3, kind: 'repair', mileageBack: 33100,
    items: [
      work('החלפת רפידות ודיסקים קדמיים', 250, [part('רפידות בלם קדמיות', 1, 320), part('דיסק בלם קדמי', 2, 290)]),
      single('נוזל בלמים', 1, 90),
    ],
    notes: 'רעש בבלימה ורעידות בהגה. הוחלפו רפידות ודיסקים, בוצע ניקוז נוזל בלמים.',
  },
  {
    monthsAgo: 18, day: 20, kind: 'annual', mileageBack: 25700,
    items: [
      work('החלפת שמן ומסנן', 100, [part('שמן מנוע 5w30', 4, 48), part('מסנן שמן מקורי', 1, 60)]),
      single('מסנן אוויר חליפי', 1, 70),
      single('פלאגים', 4, 55),
      single('מגבים', 1, 130),
      work('כיוון פרונט', 180),
    ],
    notes: 'הלקוח ביקש גם כיוון פרונט, הרכב משך ימינה.',
  },
  {
    monthsAgo: 13, day: 8, kind: 'repair', mileageBack: 19200,
    items: [
      work('בדיקת מזגן ומילוי גז', 280),
      work('החלפת רצועת אביזרים', 150, [part('רצועת אביזרים', 1, 190), part('מותחן רצועה', 1, 260)]),
    ],
    notes: 'המזגן לא קירר. נמצאה רצועה סדוקה והוחלפה יחד עם המותחן.',
  },
  {
    monthsAgo: 9, day: 15, kind: 'inspection', mileageBack: 13900,
    items: [
      work('בדיקה לפני טסט', 150),
      single('נורת בלם אחורית', 2, 25),
      work('כיוון פנסים', 60),
      work('טסט שנתי', 0, [], { notes: 'עבר בפעם הראשונה' }),
    ],
    notes: '',
  },
  {
    monthsAgo: 6, day: 2, kind: 'annual', mileageBack: 8300,
    items: [
      work('החלפת שמן ומסנן', 110, [part('שמן מנוע 5w30', 4, 50), part('מסנן שמן מקורי', 1, 65)]),
      single('מסנן אוויר מקורי', 1, 100),
      single('מסנן מזגן', 1, 85),
      single('נוזל קירור', 1, 110),
      single('בולם זעזועים אחורי', 2, 380, { done: false, notes: 'נזילה קלה בצד ימין, להחליף בזוג' }),
    ],
    notes: 'בולמים אחוריים מתחילים לדלוף. הלקוח ביקש לדחות לטיפול הבא.',
  },
  {
    monthsAgo: 2, day: 24, kind: 'repair', mileageBack: 2500,
    items: [
      single('מצבר 60 אמפר', 1, 520),
      work('ניקוי קוטבי מצבר ובדיקת טעינה', 0),
      single('מגבים', 1, 140),
      single('נורת פנס ראשי', 1, 90, { done: false }),
    ],
    notes: 'הרכב לא הניע בבוקר. המצבר הוחלף, האלטרנטור תקין (14.2 וולט).',
  },
];

await connectDB();

try {
  const vehicle = await Vehicle.findOne({ plateNumber: PLATE });
  if (!vehicle) throw new Error(`No vehicle with plate ${PLATE}`);
  const owner = await Customer.findById(vehicle.customer);
  console.log(`Vehicle: ${vehicle.plateNumber} ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.year || ''}, odometer ${vehicle.mileage ?? 'unknown'}`);
  console.log(`Owner:   ${owner?.fullName || '(none)'} ${owner?.phone || ''}`);
  if (NAME && owner?.fullName !== NAME) throw new Error(`The owner is "${owner?.fullName}", not "${NAME}". Nothing was changed.`);

  const tagged = { vehicle: vehicle._id, notes: { $regex: `${TEST_MARK.replace(/[()]/g, '\\$&')}\\s*$` } };
  const existing = await Service.countDocuments(tagged);
  console.log(`Tagged test visits on this vehicle: ${existing} (all visits: ${await Service.countDocuments({ vehicle: vehicle._id })})`);

  if (DRY) {
    console.log('--dry: nothing was changed.');
  } else if (REMOVE) {
    const res = await Service.deleteMany(tagged);
    await recomputeVehicleStats(vehicle._id);
    console.log(`Removed ${res.deletedCount} test visits.`);
  } else if (existing > 0) {
    console.log('Test visits already exist here. Run with --remove first to replace them.');
  } else {
    const odometer = Number(vehicle.mileage) || 150000;
    let created = 0;
    for (const def of VISITS) {
      const openedAt = dayjs().subtract(def.monthsAgo, 'month').date(def.day).hour(9).minute(0).second(0).millisecond(0).toDate();
      const startedAt = dayjs(openedAt).add(30, 'minute').toDate();
      const completedAt = dayjs(openedAt).hour(14).toDate();
      const items = def.items.map((it) => {
        const task = normalizeTask(it, { defaultDone: it.done !== false });
        return { ...task, doneAt: task.done ? completedAt : null };
      });
      const svc = new Service({
        vehicle: vehicle._id,
        customer: vehicle.customer,
        plateNumber: vehicle.plateNumber,
        kind: def.kind,
        status: 'done',
        openedAt,
        startedAt,
        completedAt,
        mileage: Math.max(0, odometer - def.mileageBack),
        items,
        notes: `${def.notes ? `${def.notes}\n` : ''}${TEST_MARK}`,
        totalMode: 'items',
        createdAt: openedAt,
      });
      await svc.save();

      // the history the visit would have had, and one payment for the whole sum (no balance left behind)
      svc.statusHistory = [
        { from: null, to: 'pending', at: openedAt, note: '' },
        { from: 'pending', to: 'in_progress', at: startedAt, note: '' },
        { from: 'in_progress', to: 'done', at: completedAt, note: '' },
      ];
      const total = items.filter((i) => i.done).reduce((sum, i) => sum + taskTotal(i), 0);
      if (total > 0) svc.payments.push({ amount: total, method: 'cash', paidAt: completedAt });
      svc.updatedAt = completedAt;
      await svc.save({ timestamps: false });
      created += 1;
      console.log(`  + ${dayjs(openedAt).format('DD/MM/YYYY')} ${def.kind.padEnd(10)} ${items.length} tasks, total ${svc.totalPrice}, balance ${svc.balance}`);
    }
    await recomputeVehicleStats(vehicle._id);
    console.log(`Created ${created} test visits. Remove them later with: npm run seed:history -- --plate ${PLATE} --remove`);
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnectDB();
}

process.exit(process.exitCode || 0);

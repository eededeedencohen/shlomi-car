/**
 * seedDemo.js - demo data set for development and integration testing (spec section 8).
 *   node src/scripts/seedDemo.js [--keep]     (npm run seed:demo)
 *
 * 1. Upserts the work item catalog (seedTemplates).
 * 2. Deletes all customers / vehicles / services, unless --keep is passed
 *    (with --keep, vehicles whose plate already exists are skipped together with their services).
 * 3. Inserts the demo set THROUGH the Mongoose models so every hook runs, with historical dates.
 * 4. Recomputes every vehicle and prints a summary.
 * Refuses to run when NODE_ENV=production.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import dayjs from 'dayjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('seedDemo refuses to run with NODE_ENV=production (it deletes customers, vehicles and services).');
  process.exit(1);
}

const KEEP = process.argv.includes('--keep');

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Customer } = await import('../models/Customer.js');
const { default: Vehicle } = await import('../models/Vehicle.js');
const { default: Service } = await import('../models/Service.js');
const { default: WorkItemTemplate } = await import('../models/WorkItemTemplate.js');
const { recomputeVehicleStats, annualStateOf } = await import('../utils/annual.js');
const { startOfDay } = await import('../utils/dates.js');
const { titleKeyOf, formatPlate } = await import('../utils/normalize.js');
const { normalizeTask, refreshTemplatePrices } = await import('../utils/tasks.js');
const { seedTemplates } = await import('./seedTemplates.js');
const { seedBundles } = await import('./seedBundles.js');

// ---------------------------------------------------------------------------
// Demo data. Dates are relative to today (T) so the dashboard always has content.
// ---------------------------------------------------------------------------

const T = startOfDay();
const at = (dayOffset, hour = 9, minute = 0) =>
  dayjs(T).add(dayOffset, 'day').hour(hour).minute(minute).second(0).millisecond(0).toDate();

const CUSTOMERS = [
  { key: 'dani', fullName: 'דני כהן', phone: '0541234567', email: 'dani.cohen@example.com' },
  { key: 'yossi', fullName: 'יוסי לוי', phone: '0523456789', email: 'yossi.levi@example.com' },
  { key: 'michal', fullName: 'מיכל אברהם', phone: '0509876543', email: 'michal.avraham@example.com' },
  { key: 'avi', fullName: 'אבי מזרחי', phone: '0547654321', phone2: '0537654321', email: 'avi.mizrahi@example.com' },
  { key: 'ronit', fullName: 'רונית פרץ', phone: '0526543210', email: 'ronit.peretz@example.com' },
  { key: 'shimon', fullName: 'שמעון ביטון', phone: '0503210987', notes: 'משלם תמיד במזומן' },
];

const VEHICLES = [
  { plateNumber: '2722002', make: 'טויוטה', model: 'קורולה', year: 2018, color: 'לבן', fuelType: 'petrol', customer: 'dani', mileage: 118400, engineNotes: 'שמן 5w40' },
  { plateNumber: '8765432', make: 'יונדאי', model: 'i10', year: 2020, color: 'כסף', fuelType: 'petrol', customer: 'dani', mileage: 41200 },
  { plateNumber: '12345678', make: 'מאזדה', model: '3', year: 2021, color: 'אדום', fuelType: 'petrol', customer: 'yossi', mileage: 36500 },
  { plateNumber: '3456789', make: 'סקודה', model: 'אוקטביה', year: 2016, color: 'שחור', fuelType: 'diesel', customer: 'michal', mileage: 187300 },
  { plateNumber: '45678901', make: 'קיה', model: "ספורטאז'", year: 2019, color: 'אפור', fuelType: 'petrol', customer: 'avi', mileage: 92800 },
  { plateNumber: '5678901', make: 'סוזוקי', model: 'סוויפט', year: 2015, color: 'כחול', fuelType: 'petrol', customer: 'ronit', mileage: 143900 },
  { plateNumber: '6789012', make: 'פורד', model: 'פוקוס', year: 2014, color: 'לבן', fuelType: 'petrol', customer: 'shimon', mileage: 210500, active: false, notes: 'נמכר' },
  { plateNumber: '7890123', make: 'מיצובישי', model: 'אאוטלנדר', year: 2022, color: 'שחור', fuelType: 'hybrid', customer: 'shimon', mileage: 12400 },
];

/** The original WhatsApp message (docs/BRIEF.md) kept verbatim as the notes of service 1. */
const WHATSAPP_NOTE = [
  'טיפול קמ 2722002',
  'מסנן שמן מקורי',
  'שמן מנוע 5w40',
  'מסנן אוויר חליפי',
  'מסנן מזגן חליפי',
  'נורת איתות קדמי ימין .',
  'יש להחליף',
  'פקק אטימה בראש מנוע*2',
  'יש להחליף מנוע למתזי שמשות.',
  'יש לבצע ניקוי לתחתית הרכב.',
].join('\n');

const done = (title, price = null, extra = {}) => ({ title, done: true, price, ...extra });
const todo = (title, price = null, extra = {}) => ({ title, done: false, price, ...extra });
const pay = (amount, method, day) => ({ amount, method, day });

/**
 * day = offset from today for openedAt (done services complete the same day at 13:00).
 * payments[].day = offset for paidAt.
 */
const SERVICES = [
  {
    plate: '2722002', kind: 'annual', status: 'done', day: -2, mileage: 118400,
    items: [
      done('מסנן שמן מקורי', 60),
      done('שמן מנוע 5w40', 220),
      done('מסנן אוויר חליפי', 70),
      done('מסנן מזגן חליפי', 80),
      done('נורת איתות קדמי ימין', 30),
      todo('פקק אטימה בראש מנוע', 120, { qty: 2 }),
      todo('מנוע מתזי שמשות', 180),
      todo('ניקוי תחתית הרכב'),
    ],
    notes: WHATSAPP_NOTE,
    payments: [pay(300, 'cash', -2)],
  },
  {
    plate: '2722002', kind: 'annual', status: 'done', day: -370, mileage: 103900,
    items: [
      done('מסנן שמן מקורי', 60),
      done('שמן מנוע 5w40', 220),
      done('מסנן אוויר מקורי', 90),
      done('מסנן מזגן', 80),
      done('מסנן דלק', 120),
      done('נוזל בלמים', 80),
    ],
    payments: [pay(650, 'cash', -370)],
  },
  {
    plate: '8765432', kind: 'repair', status: 'in_progress', day: -1, mileage: 41200,
    items: [done('מצבר', 450), todo('בדיקת מזגן ומילוי גז', 250)],
    notes: 'המזגן לא מקרר, לבדוק לחץ גז',
    payments: [],
  },
  {
    plate: '12345678', kind: 'annual', status: 'done', day: -340, mileage: 21700,
    items: [
      done('מסנן שמן מקורי', 70),
      done('שמן מנוע 0w20', 300),
      done('מסנן אוויר מקורי', 110),
      done('מסנן מזגן', 90),
      done('פלאגים', 230),
    ],
    payments: [pay(800, 'bit', -340)],
  },
  {
    plate: '12345678', kind: 'inspection', status: 'pending', day: 0, mileage: 36500,
    items: [todo('בדיקה לפני טסט', 150), todo('טסט שנתי')],
    notes: 'הלקוח מביא את הרכב אחר הצהריים',
    payments: [],
  },
  {
    plate: '3456789', kind: 'annual', status: 'done', day: -400, mileage: 168200,
    items: [
      done('מסנן שמן מקורי', 80),
      done('שמן מנוע 5w30', 320),
      done('מסנן אוויר מקורי', 120),
      done('מסנן דלק', 180),
      done('מסנן מזגן', 90),
      done('נוזל קירור', 110),
    ],
    payments: [pay(900, 'credit', -400)],
  },
  {
    plate: '3456789', kind: 'repair', status: 'done', day: -90, mileage: 181500,
    items: [done('רפידות בלם קדמיות', 350), done('דיסקים קדמיים', 600)],
    notes: 'רעש בבלימה, הוחלפו רפידות ודיסקים',
    payments: [pay(500, 'cash', -90), pay(450, 'bank_transfer', -85)],
  },
  {
    plate: '45678901', kind: 'annual', status: 'done', day: -380, mileage: 71400,
    items: [
      done('מסנן שמן מקורי', 70),
      done('שמן מנוע 5w30', 280),
      done('מסנן אוויר חליפי', 90),
      done('מסנן מזגן', 80),
      done('מגבים', 130),
      done('נוזל בלמים', 100),
    ],
    payments: [pay(750, 'cash', -380)],
  },
  {
    plate: '45678901', kind: 'annual', status: 'pending', day: 0, mileage: 92800,
    items: [todo('שמן מנוע 5w30'), todo('מסנן שמן מקורי'), todo('מסנן אוויר מקורי')],
    notes: 'נפתח מתזכורת טיפול שנתי',
    payments: [],
  },
  {
    plate: '5678901', kind: 'repair', status: 'done', day: -20, mileage: 143900,
    items: [done('מגבים'), done('נוזל בלמים')],
    totalMode: 'manual', manualTotal: 400,
    notes: 'סוכם 400 שקל הכל',
    payments: [],
  },
  {
    plate: '5678901', kind: 'annual', status: 'done', day: -200, mileage: 138200,
    items: [
      done('מסנן שמן חליפי', 50),
      done('שמן מנוע 5w40', 220),
      done('מסנן אוויר חליפי', 70),
      done('מסנן מזגן', 80),
      done('נורת פנס ראשי', 90),
      done('נוזל קירור', 110),
      done('מגבים', 80),
    ],
    payments: [pay(700, 'cash', -200)],
  },
  {
    plate: '6789012', kind: 'repair', status: 'done', day: -500, mileage: 210500,
    items: [done('מצבר', 400)],
    payments: [pay(400, 'cash', -500)],
  },
  {
    plate: '8765432', kind: 'repair', status: 'cancelled', day: -10,
    cancelReason: 'הלקוח ביטל',
    items: [todo('רצועת טיימינג', 1200)],
    notes: 'הצעת מחיר לרצועת טיימינג',
    payments: [],
  },
  {
    plate: '2722002', kind: 'repair', status: 'done', day: -150, mileage: 112600,
    items: [done('כיוון פרונט', 150), done('איזון גלגלים', 120)],
    payments: [pay(270, 'cash', -150)],
  },
  {
    plate: '3456789', kind: 'other', status: 'done', day: -5, mileage: 187300,
    items: [done('ייעוץ טלפוני', 0)],
    notes: 'שאלה על נורית אזהרה בלוח המחוונים',
    payments: [],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds the historical status log the hook would have produced had the visit happened live. */
const historyFor = (def, dates) => {
  const log = [];
  if (def.status === 'pending') return log;
  log.push({ from: null, to: 'pending', at: dates.openedAt, note: '' });
  if (def.status === 'in_progress' || def.status === 'done') {
    log.push({ from: 'pending', to: 'in_progress', at: dates.startedAt, note: '' });
  }
  if (def.status === 'done') {
    log.push({ from: 'in_progress', to: 'done', at: dates.completedAt, note: '' });
  }
  if (def.status === 'cancelled') {
    log.push({ from: 'pending', to: 'cancelled', at: dates.cancelledAt, note: def.cancelReason || '' });
  }
  return log;
};

const datesFor = (def) => {
  const openedAt = at(def.day, 9);
  const dates = { openedAt, startedAt: null, completedAt: null, cancelledAt: null };
  if (def.status === 'in_progress' || def.status === 'done') dates.startedAt = at(def.day, 9, 30);
  if (def.status === 'done') dates.completedAt = at(def.day, 13);
  if (def.status === 'cancelled') dates.cancelledAt = at(def.day + 1, 10);
  return dates;
};

const money = (n) => `₪${Number(n || 0).toLocaleString('he-IL')}`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await connectDB();

try {
  const templates = await seedTemplates();
  console.log(`Templates: ${templates.inserted} inserted, ${templates.existing} existed (${templates.total} total)`);
  const bundles = await seedBundles();
  console.log(`Bundles: ${bundles.inserted} inserted, ${bundles.existing} existed (${bundles.total} total)`);

  if (!KEEP) {
    const [c, v, s] = await Promise.all([
      Customer.deleteMany({}),
      Vehicle.deleteMany({}),
      Service.deleteMany({}),
    ]);
    console.log(`Wiped: ${c.deletedCount} customers, ${v.deletedCount} vehicles, ${s.deletedCount} services`);
  } else {
    console.log('--keep: existing customers, vehicles and services are preserved');
  }

  // template lookup for item -> catalog links (usage stats)
  const templateDocs = await WorkItemTemplate.find({ active: true }).select('_id titleKey').lean();
  const templateByKey = new Map(templateDocs.map((t) => [t.titleKey, t._id]));

  // customers (with --keep an existing customer with the same phone is reused)
  const customerByKey = new Map();
  let customersCreated = 0;
  for (const def of CUSTOMERS) {
    const { key, ...fields } = def;
    let doc = KEEP ? await Customer.findOne({ phone: fields.phone }) : null;
    if (!doc) {
      doc = await Customer.create(fields);
      customersCreated += 1;
    }
    customerByKey.set(key, doc);
  }

  // vehicles (with --keep an existing plate is skipped together with its services)
  const vehicleByPlate = new Map();
  const skippedPlates = [];
  let vehiclesCreated = 0;
  for (const def of VEHICLES) {
    const { customer: customerKey, ...fields } = def;
    if (KEEP && (await Vehicle.exists({ plateNumber: fields.plateNumber }))) {
      skippedPlates.push(fields.plateNumber);
      continue;
    }
    const doc = new Vehicle({
      ...fields,
      customer: customerByKey.get(customerKey)._id,
      mileageUpdatedAt: at(-40, 10),
    });
    await doc.save();
    vehicleByPlate.set(doc.plateNumber, doc);
    vehiclesCreated += 1;
  }

  // services, through the model so hooks run; historical dates set explicitly
  const usage = new Map(); // templateId -> { count, lastUsedAt, task }
  const newestReading = new Map(); // plate -> { mileage, at }
  let servicesCreated = 0;
  for (const def of SERVICES) {
    const vehicle = vehicleByPlate.get(def.plate);
    if (!vehicle) continue;

    const dates = datesFor(def);
    // the flat demo lines become tasks (a work or a part by their title, the price as the record price)
    const items = def.items.map((it) => {
      const task = normalizeTask({ title: it.title, qty: it.qty, price: it.price, done: it.done, notes: it.notes }, { defaultDone: it.done });
      return {
        ...task,
        template: templateByKey.get(titleKeyOf(task.title)) || null,
        doneAt: it.done ? dates.completedAt || dates.startedAt || dates.openedAt : null,
      };
    });

    const svc = new Service({
      vehicle: vehicle._id,
      customer: vehicle.customer,
      plateNumber: vehicle.plateNumber,
      kind: def.kind,
      status: def.status,
      openedAt: dates.openedAt,
      startedAt: dates.startedAt,
      completedAt: dates.completedAt,
      cancelledAt: dates.cancelledAt,
      cancelReason: def.cancelReason,
      mileage: def.mileage ?? null,
      items,
      notes: def.notes,
      totalMode: def.totalMode || 'items',
      manualTotal: def.manualTotal ?? null,
      createdAt: dates.openedAt,
    });
    await svc.save();

    // replace the "now" history entry written by the hook with the historical log, then append payments
    svc.statusHistory = historyFor(def, dates);
    for (const p of def.payments) {
      svc.payments.push({ amount: p.amount, method: p.method, paidAt: at(p.day, 14) });
    }
    svc.updatedAt = dates.completedAt || dates.cancelledAt || dates.startedAt || dates.openedAt;
    await svc.save({ timestamps: false });
    servicesCreated += 1;

    for (const it of items) {
      if (!it.template) continue;
      const key = String(it.template);
      const cur = usage.get(key) || { count: 0, lastUsedAt: null, task: null };
      cur.count += 1;
      if (!cur.lastUsedAt || dates.openedAt > cur.lastUsedAt) {
        cur.lastUsedAt = dates.openedAt;
        cur.task = it;
      }
      usage.set(key, cur);
    }

    if (def.mileage != null) {
      const prev = newestReading.get(def.plate);
      if (!prev || dates.openedAt > prev.at) newestReading.set(def.plate, { mileage: def.mileage, at: dates.openedAt });
    }
  }

  // catalog usage stats, mirroring the API usage bump (the last price used becomes the template price)
  for (const [templateId, u] of usage) {
    const template = await WorkItemTemplate.findById(templateId);
    if (!template) continue;
    template.usageCount = (template.usageCount || 0) + u.count;
    template.lastUsedAt = u.lastUsedAt;
    if (u.task) refreshTemplatePrices(template, u.task);
    await template.save();
  }

  // mileage rule (spec 3.6): the newest service reading dates the vehicle's odometer
  for (const [plate, reading] of newestReading) {
    const vehicle = vehicleByPlate.get(plate);
    if (!vehicle) continue;
    if (reading.mileage >= (vehicle.mileage || 0)) {
      vehicle.mileage = reading.mileage;
      vehicle.mileageUpdatedAt = reading.at;
      await vehicle.save();
    }
  }

  // derived vehicle fields
  const allVehicles = await Vehicle.find().select('_id').lean();
  for (const v of allVehicles) await recomputeVehicleStats(v._id);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const [customersTotal, vehiclesTotal, servicesTotal, templatesTotal] = await Promise.all([
    Customer.countDocuments(),
    Vehicle.countDocuments(),
    Service.countDocuments(),
    WorkItemTemplate.countDocuments(),
  ]);

  const vehicles = await Vehicle.find().populate('customer', 'fullName').lean();
  const stateCounts = { overdue: 0, due_soon: 0, open: 0, ok: 0, none: 0, muted: 0 };
  const lines = [];
  for (const v of vehicles) {
    const { annualState, daysToAnnual } = annualStateOf(v, T);
    stateCounts[annualState] += 1;
    const days = daysToAnnual == null ? '' : ` (${daysToAnnual} days)`;
    lines.push(`  ${formatPlate(v.plateNumber).padEnd(11)} ${v.make} ${v.model}${' '.repeat(Math.max(1, 22 - (v.make + ' ' + v.model).length))}${v.customer?.fullName || ''}  annual: ${annualState}${days}, open items: ${v.openItemsCount}, services: ${v.servicesCount}`);
  }

  const [openStatus, openBalance] = await Promise.all([
    Service.aggregate([
      { $match: { status: { $in: ['pending', 'in_progress'] } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Service.aggregate([
      { $match: { status: { $ne: 'cancelled' }, balance: { $gt: 0.005 } } },
      { $group: { _id: null, total: { $sum: '$balance' }, n: { $sum: 1 } } },
    ]),
  ]);
  const pendingCount = openStatus.find((r) => r._id === 'pending')?.n || 0;
  const inProgressCount = openStatus.find((r) => r._id === 'in_progress')?.n || 0;
  const balanceTotal = openBalance[0]?.total || 0;
  const balanceCount = openBalance[0]?.n || 0;

  console.log('\nDemo data ready.');
  console.log(`Created: ${customersCreated} customers, ${vehiclesCreated} vehicles, ${servicesCreated} services`);
  if (skippedPlates.length) console.log(`Skipped existing plates (--keep): ${skippedPlates.join(', ')}`);
  console.log(`Collections: customers ${customersTotal}, vehicles ${vehiclesTotal}, services ${servicesTotal}, templates ${templatesTotal}`);
  console.log('\nVehicles:');
  console.log(lines.join('\n'));
  console.log('\nDashboard expectations:');
  console.log(`  open services: ${pendingCount + inProgressCount} (${inProgressCount} in progress, ${pendingCount} pending)`);
  console.log(`  annual: overdue ${stateCounts.overdue}, due_soon ${stateCounts.due_soon}, open ${stateCounts.open}, ok ${stateCounts.ok}, none ${stateCounts.none}, muted/inactive ${stateCounts.muted}`);
  console.log(`  open balances: ${money(balanceTotal)} across ${balanceCount} services`);
  console.log('');
} finally {
  await disconnectDB();
}

process.exit(0);

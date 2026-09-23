/**
 * smokeTest.js - end to end smoke test of the whole API (spec section 4), Node 22, no dependencies.
 *   npm run smoke
 * Env: API_URL (default http://localhost:5055/api), SMOKE_USER (shlomi), SMOKE_PASS (shlomi123).
 * Run `npm run seed:demo` first: the dashboard expectations assume a fresh demo set.
 * Prints PASS / FAIL per check with the endpoint, a count at the end, exit code 1 on any failure.
 */

const API_URL = (process.env.API_URL || 'http://localhost:5055/api').replace(/\/+$/, '');
const SMOKE_USER = process.env.SMOKE_USER || 'shlomi';
const SMOKE_PASS = process.env.SMOKE_PASS || 'shlomi123';

const MSG = {
  badTransition: 'מעבר סטטוס לא חוקי',
  plateFormat: 'מספר רכב חייב להכיל 7 או 8 ספרות',
  noContent: 'הוסף לפחות פריט אחד או הערה',
  cancelled: 'הטיפול בוטל, שחזר אותו כדי לערוך',
  amountPositive: 'סכום חייב להיות גדול מאפס',
  priceBeforePayment: 'יש לקבוע מחיר לטיפול לפני רישום תשלום',
  carriedForward: 'הפריט הועבר לטיפול מאוחר יותר, מחק אותו שם',
  carryOtherVehicle: 'ניתן להעביר פריטים רק מאותו רכב',
  carryUsed: 'הפריט כבר הועבר או בוצע',
  backfillDuplicate: 'כבר קיים טיפול שנתי בתאריך זה',
  backfillFuture: 'תאריך הטיפול לא יכול להיות בעתיד',
  sameCustomer: 'הרכב כבר רשום על שם לקוח זה',
  pickCustomer: 'יש לבחור לקוח או ליצור לקוח חדש',
  fullNameRequired: 'שם מלא הוא שדה חובה',
  templateDuplicate: 'פריט קטלוג בשם זה כבר קיים',
  bundleDuplicate: 'חבילה בשם זה כבר קיימת',
  bundleTitle: 'שם החבילה הוא שדה חובה',
  bundleNoItems: 'חבילה חייבת להכיל לפחות פריט אחד',
  bundleNotFound: 'החבילה לא נמצאה',
  searchShort: 'יש להזין לפחות 2 תווים',
  login: 'שם משתמש או סיסמה שגויים',
};

let token = null;
let passed = 0;
let failed = 0;
const failures = [];

/* ------------------------------------------------------------------ http */

async function call(method, path, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { parseError: true, text };
  }
  return { status: res.status, body: json, endpoint: `${method} ${path}` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b ?? {});
const put = (p, b) => call('PUT', p, b ?? {});
const patch = (p, b) => call('PATCH', p, b ?? {});
const del = (p) => call('DELETE', p);

/* ------------------------------------------------------------------ assertions */

function record(ok, label, endpoint, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${endpoint}  ${label}`);
  } else {
    failed += 1;
    const line = `FAIL  ${endpoint}  ${label}${detail ? `  -> ${detail}` : ''}`;
    failures.push(line);
    console.log(line);
  }
  return ok;
}

const short = (v) => {
  try {
    const s = JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}...` : s;
  } catch {
    return String(v);
  }
};

/** Expect a successful response with the given status; returns res.body.data (or null). */
function expectOk(res, label, status = 200) {
  const ok = res.status === status && res.body && res.body.success === true;
  record(ok, label, res.endpoint, ok ? '' : `status ${res.status} body ${short(res.body)}`);
  return ok ? res.body.data : null;
}

/** Expect an error response with status and (optionally) an exact Hebrew message. */
function expectError(res, label, status, message) {
  const okStatus = res.status === status && res.body && res.body.success === false;
  const okMessage = message === undefined || res.body?.message === message;
  const ok = okStatus && okMessage;
  record(
    ok,
    label,
    res.endpoint,
    ok ? '' : `status ${res.status} message ${short(res.body?.message)} (expected ${status}${message ? ` '${message}'` : ''})`
  );
  return ok;
}

function check(cond, label, endpoint, detail) {
  return record(Boolean(cond), label, endpoint, cond ? '' : detail);
}

function checkEq(actual, expected, label, endpoint) {
  return record(actual === expected, label, endpoint, actual === expected ? '' : `got ${short(actual)} expected ${short(expected)}`);
}

function hasKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return keys.slice();
  return keys.filter((k) => !(k in obj));
}

function checkShape(obj, keys, label, endpoint) {
  const missing = hasKeys(obj, keys);
  return record(missing.length === 0, label, endpoint, missing.length ? `missing ${missing.join(', ')}` : '');
}

function checkList(res, label) {
  const b = res.body;
  const ok =
    res.status === 200 &&
    b &&
    b.success === true &&
    Array.isArray(b.data) &&
    typeof b.total === 'number' &&
    typeof b.page === 'number' &&
    typeof b.pages === 'number';
  record(ok, label, res.endpoint, ok ? '' : `status ${res.status} body ${short(b)}`);
  return ok ? b : null;
}

const SERVICE_ROW_KEYS = [
  '_id', 'plateNumber', 'kind', 'status', 'openedAt', 'completedAt', 'mileage', 'itemsCount', 'itemsDoneCount',
  'remainingCount', 'totalPrice', 'paidAmount', 'balance', 'paymentStatus', 'notesPreview', 'vehicle', 'customer',
  'createdAt', 'updatedAt',
];
const SERVICE_FULL_KEYS = [
  '_id', 'vehicle', 'customer', 'plateNumber', 'kind', 'status', 'openedAt', 'items', 'payments', 'statusHistory',
  'totalMode', 'itemsCount', 'itemsDoneCount', 'remainingCount', 'itemsTotal', 'remainingQuote', 'totalPrice',
  'paidAmount', 'balance', 'paymentStatus',
];
const VEHICLE_ROW_KEYS = [
  '_id', 'plateNumber', 'make', 'model', 'year', 'color', 'fuelType', 'mileage', 'active', 'customer', 'lastAnnualAt',
  'annualDueAt', 'annualDueOverride', 'annualReminderMuted', 'openAnnualServiceId', 'lastServiceAt', 'servicesCount',
  'openServicesCount', 'openItemsCount', 'annualState', 'daysToAnnual', 'openBalance',
];
const CUSTOMER_ROW_KEYS = [
  '_id', 'fullName', 'phone', 'phone2', 'email', 'notes', 'active', 'vehiclesCount', 'plates', 'servicesCount',
  'openServicesCount', 'openBalance', 'lastServiceAt',
];
const OPEN_ITEM_KEYS = ['serviceId', 'serviceOpenedAt', 'serviceStatus', 'serviceKind', 'itemId', 'title', 'work', 'parts', 'price', 'total', 'priced', 'notes'];
const TEMPLATE_KEYS = ['_id', 'title', 'titleKey', 'category', 'work', 'parts', 'price', 'total', 'priced', 'usageCount', 'lastUsedAt', 'active', 'order'];
const BUNDLE_LINE_KEYS = ['_id', 'template', 'title', 'work', 'parts', 'price', 'total', 'priced', 'templateActive', 'notes'];
const KPI_KEYS = [
  'openServicesCount', 'pendingCount', 'inProgressCount', 'openBalanceTotal', 'openBalanceCount', 'openBalanceCustomers',
  'annualOverdueCount', 'annualDueSoonCount', 'annualOpenCount', 'annualNoneCount', 'doneThisMonthCount', 'collectedThisMonth',
];

const ymd = (d) => {
  const x = new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
};
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};
const idOf = (ref) => (ref && typeof ref === 'object' ? String(ref._id) : String(ref));
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

/* ------------------------------------------------------------------ sections */

async function testHealthAndAuth() {
  const h = await call('GET', '/health', undefined, { auth: false });
  check(h.status === 200 && h.body?.success === true && h.body?.service === 'shlomi-garage-api' && h.body?.time, 'health ok', h.endpoint, short(h.body));

  const bad = await call('POST', '/auth/login', { username: SMOKE_USER, password: 'definitely-wrong' }, { auth: false });
  expectError(bad, 'wrong password -> 401', 401, MSG.login);

  const noAuth = await call('GET', '/auth/me', undefined, { auth: false });
  expectError(noAuth, 'me without token -> 401', 401);

  const login = await call('POST', '/auth/login', { username: SMOKE_USER, password: SMOKE_PASS }, { auth: false });
  const data = expectOk(login, 'login');
  if (!data?.token) throw new Error('login failed, cannot continue');
  token = data.token;
  checkShape(data.user, ['_id', 'name', 'username'], 'login user shape', login.endpoint);

  const me = await get('/auth/me');
  const meData = expectOk(me, 'me');
  checkShape(meData, ['_id', 'name', 'username'], 'me shape', me.endpoint);
  checkEq(meData?.username, SMOKE_USER.toLowerCase(), 'me username', me.endpoint);

  // change-password round trip (restores the original password)
  const tmpPass = `${SMOKE_PASS}-tmp`;
  const shortPass = await post('/auth/change-password', { currentPassword: SMOKE_PASS, newPassword: '123' });
  expectError(shortPass, 'change-password too short -> 400', 400);
  const wrongCurrent = await post('/auth/change-password', { currentPassword: 'nope', newPassword: tmpPass });
  expectError(wrongCurrent, 'change-password wrong current -> 401', 401);
  const changed = await post('/auth/change-password', { currentPassword: SMOKE_PASS, newPassword: tmpPass });
  const ch = expectOk(changed, 'change-password');
  if (ch) checkEq(ch.message, 'הסיסמה עודכנה בהצלחה', 'change-password message', changed.endpoint);
  const oldLogin = await call('POST', '/auth/login', { username: SMOKE_USER, password: SMOKE_PASS }, { auth: false });
  expectError(oldLogin, 'old password rejected after change', 401, MSG.login);
  const restore = await post('/auth/change-password', { currentPassword: tmpPass, newPassword: SMOKE_PASS });
  expectOk(restore, 'change-password restore original');
}

async function testDashboardFresh() {
  const res = await get('/dashboard');
  const d = expectOk(res, 'summary');
  if (!d) return;
  checkShape(d, ['kpis', 'openServices', 'annualDue', 'annualNoneCount', 'openBalances', 'openBalancesByCustomer', 'recentVehicles', 'generatedAt'], 'summary shape', res.endpoint);
  checkShape(d.kpis, KPI_KEYS, 'kpis shape', res.endpoint);
  check(!d.kpis?.error && !d.openServices?.error && !Array.isArray(d.annualDue?.error), 'no section errors', res.endpoint, short(d));

  // fresh seed:demo expectations. Spec section 8 says "overdue 2", but 45678901 has a pending annual so
  // per section 3.4 / 6.1 it is 'open' (open ranks before overdue). Section 3 wins: overdue 1, open 1, due_soon 1.
  checkEq(d.kpis?.annualOverdueCount, 1, 'kpis annualOverdueCount 1 (3456789; 45678901 is open per 3.4)', res.endpoint);
  checkEq(d.kpis?.annualDueSoonCount, 1, 'kpis annualDueSoonCount 1', res.endpoint);
  checkEq(d.kpis?.annualOpenCount, 1, 'kpis annualOpenCount 1', res.endpoint);
  checkEq(d.kpis?.annualNoneCount, 2, 'kpis annualNoneCount 2', res.endpoint);
  checkEq(d.kpis?.openServicesCount, 3, 'kpis openServicesCount 3', res.endpoint);
  checkEq(d.kpis?.pendingCount, 2, 'kpis pendingCount 2', res.endpoint);
  checkEq(d.kpis?.inProgressCount, 1, 'kpis inProgressCount 1', res.endpoint);
  checkEq(d.kpis?.openBalanceCount, 3, 'kpis openBalanceCount 3', res.endpoint);
  check(near(d.kpis?.openBalanceTotal, 1010), 'kpis openBalanceTotal 1010', res.endpoint, short(d.kpis?.openBalanceTotal));
  checkEq(d.annualNoneCount, d.kpis?.annualNoneCount, 'annualNoneCount mirrors kpis', res.endpoint);

  check(Array.isArray(d.openServices?.inProgress) && d.openServices.inProgress.length === 1, 'openServices.inProgress 1 row', res.endpoint, short(d.openServices));
  check(Array.isArray(d.openServices?.pending) && d.openServices.pending.length === 2, 'openServices.pending 2 rows', res.endpoint, short(d.openServices));
  if (d.openServices?.inProgress?.[0]) checkShape(d.openServices.inProgress[0], SERVICE_ROW_KEYS, 'openServices ServiceRow shape', res.endpoint);

  check(Array.isArray(d.annualDue) && d.annualDue.length === 3, 'annualDue 3 rows (overdue, due_soon, open)', res.endpoint, short(d.annualDue?.map?.((r) => r.annualState)));
  if (Array.isArray(d.annualDue) && d.annualDue.length === 3) {
    checkEq(d.annualDue.map((r) => r.annualState).join(','), 'overdue,due_soon,open', 'annualDue order overdue -> due_soon -> open', res.endpoint);
    checkShape(d.annualDue[0], [...VEHICLE_ROW_KEYS, 'openAnnualService'], 'AnnualRow shape', res.endpoint);
    const openRow = d.annualDue[2];
    check(openRow.openAnnualService && openRow.openAnnualService.status === 'pending', 'open row carries openAnnualService', res.endpoint, short(openRow.openAnnualService));
  }

  check(Array.isArray(d.openBalances) && d.openBalances.length === 3, 'openBalances 3 rows', res.endpoint, short(d.openBalances?.length));
  const sumRows = (d.openBalances || []).reduce((s, r) => s + (r.balance || 0), 0);
  check(near(sumRows, d.kpis?.openBalanceTotal), 'openBalances rows sum equals kpi total', res.endpoint, `${sumRows} vs ${d.kpis?.openBalanceTotal}`);
  check(Array.isArray(d.openBalancesByCustomer) && d.openBalancesByCustomer.length === 2, 'openBalancesByCustomer 2 customers', res.endpoint, short(d.openBalancesByCustomer));
  if (d.openBalancesByCustomer?.[0]) {
    checkShape(d.openBalancesByCustomer[0], ['customer', 'balance', 'servicesCount', 'oldestOpenedAt'], 'byCustomer shape', res.endpoint);
    checkShape(d.openBalancesByCustomer[0].customer, ['_id', 'fullName', 'phone'], 'byCustomer CustomerRef', res.endpoint);
    check(d.openBalancesByCustomer[0].balance >= d.openBalancesByCustomer[1].balance, 'byCustomer sorted by balance desc', res.endpoint);
  }
  check(Array.isArray(d.recentVehicles) && d.recentVehicles.length === 6, 'recentVehicles 6 rows', res.endpoint, short(d.recentVehicles?.length));
  if (d.recentVehicles?.[0]) checkShape(d.recentVehicles[0], ['_id', 'plateNumber', 'make', 'model', 'lastActivityAt'], 'recentVehicles shape', res.endpoint);

  // paged annual list
  for (const state of ['due', 'overdue', 'due_soon', 'none', 'muted']) {
    const r = await get(`/dashboard/annual?state=${state}&page=1&limit=2`);
    const list = checkList(r, `annual state=${state} is a list`);
    if (!list) continue;
    // date based $match (spec 4.3): the vehicle with an open annual is still listed under overdue by its due date
    const expectedTotal = { due: 3, overdue: 2, due_soon: 1, none: 2, muted: 0 }[state];
    checkEq(list.total, expectedTotal, `annual state=${state} total ${expectedTotal}`, r.endpoint);
    check(list.data.length <= 2, `annual state=${state} respects limit`, r.endpoint);
    if (list.data[0]) checkShape(list.data[0], [...VEHICLE_ROW_KEYS, 'openAnnualService'], `annual state=${state} AnnualRow shape`, r.endpoint);
    if (state === 'due') checkEq(list.pages, 2, 'annual due pages 2', r.endpoint);
  }
  const badState = await get('/dashboard/annual?state=bogus');
  expectError(badState, 'annual bad state -> 400', 400);

  // open balances paging
  const ob1 = await get('/dashboard/open-balances?page=1&limit=2');
  const obList = checkList(ob1, 'open-balances by service page 1');
  if (obList) {
    checkEq(obList.total, 3, 'open-balances total 3', ob1.endpoint);
    checkEq(obList.pages, 2, 'open-balances pages 2', ob1.endpoint);
    checkEq(obList.data.length, 2, 'open-balances page 1 has 2 rows', ob1.endpoint);
    checkShape(obList.data[0], SERVICE_ROW_KEYS, 'open-balances ServiceRow shape', ob1.endpoint);
  }
  const ob2 = await get('/dashboard/open-balances?page=2&limit=2');
  const obList2 = checkList(ob2, 'open-balances by service page 2');
  if (obList2) checkEq(obList2.data.length, 1, 'open-balances page 2 has 1 row', ob2.endpoint);
  const obc = await get('/dashboard/open-balances?groupBy=customer&page=1&limit=1');
  const obcList = checkList(obc, 'open-balances by customer');
  if (obcList) {
    checkEq(obcList.total, 2, 'open-balances by customer total 2', obc.endpoint);
    checkEq(obcList.data.length, 1, 'open-balances by customer limit 1', obc.endpoint);
    checkShape(obcList.data[0], ['customer', 'balance', 'servicesCount', 'oldestOpenedAt'], 'by customer row shape', obc.endpoint);
  }
  const badGroup = await get('/dashboard/open-balances?groupBy=bogus');
  expectError(badGroup, 'open-balances bad groupBy -> 400', 400);
}

async function testSearch() {
  const shortQ = await get('/search?q=2');
  expectError(shortQ, 'short query -> 400', 400, MSG.searchShort);
  const emptyQ = await get('/search');
  expectError(emptyQ, 'missing query -> 400', 400, MSG.searchShort);

  const digits = await get('/search?q=2722002');
  const d = expectOk(digits, 'digits search');
  if (d) {
    checkShape(d, ['vehicles', 'customers', 'services'], 'search shape', digits.endpoint);
    check(d.vehicles.length >= 1 && d.vehicles[0].plateNumber === '2722002', 'exact plate first', digits.endpoint, short(d.vehicles.map((v) => v.plateNumber)));
    if (d.vehicles[0]) checkShape(d.vehicles[0], VEHICLE_ROW_KEYS, 'search VehicleRow shape', digits.endpoint);
    check(d.services.length === 3 && d.services.every((s) => s.plateNumber === '2722002'), 'services by plate prefix (3)', digits.endpoint, short(d.services.length));
    if (d.services[0]) checkShape(d.services[0], SERVICE_ROW_KEYS, 'search ServiceRow shape', digits.endpoint);
  }
  const prefix = await get('/search?q=27-22');
  const p = expectOk(prefix, 'digits with dashes search');
  if (p) check(p.vehicles.some((v) => v.plateNumber === '2722002'), 'plate prefix with separators matches', prefix.endpoint, short(p.vehicles));

  const phone = await get('/search?q=0541234567');
  const ph = expectOk(phone, 'phone digits search');
  if (ph) {
    check(ph.customers.length === 1 && ph.customers[0].fullName === 'דני כהן', 'customer by phone', phone.endpoint, short(ph.customers));
    if (ph.customers[0]) checkShape(ph.customers[0], CUSTOMER_ROW_KEYS, 'search CustomerRow shape', phone.endpoint);
  }

  const text = await get('/search?q=' + encodeURIComponent('דני'));
  const t = expectOk(text, 'text search by name');
  if (t) {
    check(t.customers.length === 1 && t.customers[0].fullName === 'דני כהן', 'customers by name', text.endpoint, short(t.customers));
    check(t.vehicles.length === 2, 'vehicles of the matching owner (2)', text.endpoint, short(t.vehicles.map((v) => v.plateNumber)));
  }
  const make = await get('/search?q=' + encodeURIComponent('טויוטה'));
  const m = expectOk(make, 'text search by make');
  if (m) check(m.vehicles.length === 1 && m.vehicles[0].plateNumber === '2722002', 'vehicle by make', make.endpoint, short(m.vehicles));
  const item = await get('/search?q=' + encodeURIComponent('מצבר'));
  const it = expectOk(item, 'text search by item title');
  if (it) check(it.services.length === 2, 'services by item title (2)', item.endpoint, short(it.services.length));
  const nothing = await get('/search?q=' + encodeURIComponent('zzzz-nothing'));
  const n = expectOk(nothing, 'text search no results');
  if (n) check(n.vehicles.length === 0 && n.customers.length === 0 && n.services.length === 0, 'no results are empty arrays', nothing.endpoint);
}

async function testCustomers(ctx) {
  const list = await get('/customers');
  const l = checkList(list, 'list (active only)');
  if (l) {
    checkEq(l.total, 6, 'list total 6', list.endpoint);
    checkShape(l.data[0], CUSTOMER_ROW_KEYS, 'CustomerRow shape', list.endpoint);
    const dani = l.data.find((c) => c.fullName === 'דני כהן');
    check(dani && dani.vehiclesCount === 2 && dani.plates.length === 2, 'דני כהן has 2 vehicles', list.endpoint, short(dani));
    check(dani && near(dani.openBalance, 610), 'דני כהן openBalance 610 (160 + 450)', list.endpoint, short(dani?.openBalance));
    check(dani && dani.openServicesCount === 1, 'דני כהן openServicesCount 1', list.endpoint, short(dani?.openServicesCount));
    ctx.customers = Object.fromEntries(l.data.map((c) => [c.fullName, c]));
  }
  const byName = await get('/customers?q=' + encodeURIComponent('כהן'));
  const bn = checkList(byName, 'list q by name');
  if (bn) checkEq(bn.total, 1, 'q=כהן total 1', byName.endpoint);
  const byPhone = await get('/customers?q=0523456');
  const bp = checkList(byPhone, 'list q by phone digits');
  if (bp) check(bp.total === 1 && bp.data[0].fullName === 'יוסי לוי', 'q phone digits finds יוסי לוי', byPhone.endpoint, short(bp.data));
  const open = await get('/customers?state=open&sortBy=openBalance&order=desc');
  const op = checkList(open, 'list state=open');
  if (op) {
    checkEq(op.total, 2, 'state=open total 2', open.endpoint);
    check(op.data.every((c) => c.openBalance > 0), 'state=open all have balance', open.endpoint);
    check(op.data.length < 2 || op.data[0].openBalance >= op.data[1].openBalance, 'sortBy openBalance desc', open.endpoint);
  }
  const archived = await get('/customers?state=archived');
  const ar = checkList(archived, 'list state=archived');
  if (ar) checkEq(ar.total, 0, 'state=archived total 0', archived.endpoint);
  const all = await get('/customers?state=all&sortBy=lastService&page=1&limit=4');
  const al = checkList(all, 'list state=all paged');
  if (al) {
    checkEq(al.total, 6, 'state=all total 6', all.endpoint);
    checkEq(al.pages, 2, 'limit 4 -> pages 2', all.endpoint);
    checkEq(al.data.length, 4, 'page 1 has 4', all.endpoint);
  }
  const sortVehicles = await get('/customers?sortBy=vehicles');
  const sv = checkList(sortVehicles, 'list sortBy=vehicles');
  if (sv) check(sv.data[0].vehiclesCount >= sv.data[1].vehiclesCount, 'sortBy vehicles desc', sortVehicles.endpoint);

  // lookup
  const lk = await get('/customers/lookup?phone=' + encodeURIComponent('+972-54-123-4567'));
  const lkd = expectOk(lk, 'lookup (972 prefix normalized)');
  if (lkd) {
    check(Array.isArray(lkd.matches) && lkd.matches.length === 1 && lkd.matches[0].fullName === 'דני כהן', 'lookup finds דני כהן', lk.endpoint, short(lkd));
    if (lkd.matches?.[0]) checkShape(lkd.matches[0], ['_id', 'fullName', 'phone'], 'lookup CustomerRef', lk.endpoint);
  }
  const lk2 = await get('/customers/lookup?phone=0537654321');
  const lkd2 = expectOk(lk2, 'lookup by phone2');
  if (lkd2) check(lkd2.matches.length === 1 && lkd2.matches[0].fullName === 'אבי מזרחי', 'lookup matches phone2', lk2.endpoint, short(lkd2));
  const lk3 = await get('/customers/lookup?phone=0500000000');
  const lkd3 = expectOk(lk3, 'lookup no match');
  if (lkd3) checkEq(lkd3.matches.length, 0, 'lookup empty matches', lk3.endpoint);
  const lk4 = await get('/customers/lookup');
  expectError(lk4, 'lookup without phone -> 400', 400);

  // get
  const daniId = ctx.customers?.['דני כהן']?._id;
  const one = await get(`/customers/${daniId}`);
  const od = expectOk(one, 'get');
  if (od) {
    checkShape(od, ['customer', 'vehicles', 'services', 'totals'], 'get shape', one.endpoint);
    checkEq(od.vehicles.length, 2, 'get vehicles 2', one.endpoint);
    if (od.vehicles[0]) checkShape(od.vehicles[0], VEHICLE_ROW_KEYS, 'get VehicleRow shape', one.endpoint);
    checkEq(od.services.length, 5, 'get services 5 (incl cancelled)', one.endpoint);
    if (od.services[0]) checkShape(od.services[0], SERVICE_ROW_KEYS, 'get ServiceRow shape', one.endpoint);
    checkShape(od.totals, ['servicesCount', 'totalCharged', 'totalPaid', 'openBalance'], 'get totals shape', one.endpoint);
    checkEq(od.totals.servicesCount, 4, 'totals exclude cancelled', one.endpoint);
    check(near(od.totals.openBalance, 610), 'totals openBalance 610', one.endpoint, short(od.totals));
  }
  const missing = await get('/customers/000000000000000000000000');
  expectError(missing, 'get unknown id -> 404', 404, 'הלקוח לא נמצא');
  const badId = await get('/customers/not-an-id');
  expectError(badId, 'get bad id -> 404', 404);

  // create
  const noName = await post('/customers', { phone: '0501111111' });
  expectError(noName, 'create without name -> 400', 400, MSG.fullNameRequired);
  const badPhone = await post('/customers', { fullName: 'בדיקה', phone: '12' });
  expectError(badPhone, 'create bad phone -> 400', 400, 'מספר טלפון לא תקין');
  const created = await post('/customers', { fullName: '  לקוח בדיקה  ', phone: '054-999-8877', email: 'Test@Example.com', notes: 'smoke' });
  const c = expectOk(created, 'create', 201);
  if (c) {
    checkEq(c.fullName, 'לקוח בדיקה', 'create trims name', created.endpoint);
    checkEq(c.phone, '0549998877', 'create normalizes phone', created.endpoint);
    checkEq(c.email, 'test@example.com', 'create lowercases email', created.endpoint);
    checkEq(c.active, true, 'create active default', created.endpoint);
    ctx.smokeCustomer = c;
  }

  // update
  const upd = await put(`/customers/${c?._id}`, { phone2: '0521112233', notes: 'updated', ignored: 'x' });
  const u = expectOk(upd, 'update');
  if (u) {
    checkEq(u.phone2, '0521112233', 'update phone2', upd.endpoint);
    checkEq(u.notes, 'updated', 'update notes', upd.endpoint);
    check(u.ignored === undefined, 'update ignores unknown fields', upd.endpoint);
  }
  const blank = await put(`/customers/${c?._id}`, { fullName: '   ' });
  expectError(blank, 'update blank name -> 400', 400, MSG.fullNameRequired);

  // deletion preview on a customer with vehicles and services (the delete itself cascades: see the cascade section)
  const preview = await get(`/customers/${daniId}/deletion`);
  const pv = expectOk(preview, 'deletion preview');
  if (pv) {
    checkShape(pv, ['vehicles', 'services', 'payments', 'paidAmount'], 'deletion preview shape', preview.endpoint);
    check(pv.vehicles >= 1 && pv.services >= 1, 'preview counts vehicles and services', preview.endpoint, short(pv));
  }
  expectError(await get('/customers/000000000000000000000000/deletion'), 'deletion preview unknown -> 404', 404, 'הלקוח לא נמצא');
}

async function testVehicles(ctx) {
  const list = await get('/vehicles');
  const l = checkList(list, 'list (active default)');
  if (l) {
    checkEq(l.total, 7, 'list total 7 active', list.endpoint);
    checkShape(l.data[0], VEHICLE_ROW_KEYS, 'VehicleRow shape', list.endpoint);
    check(l.data.every((v) => v.active === true), 'default list is active only', list.endpoint);
    ctx.vehicles = Object.fromEntries(l.data.map((v) => [v.plateNumber, v]));
    const corolla = ctx.vehicles['2722002'];
    check(corolla && corolla.customer?.fullName === 'דני כהן' && near(corolla.openBalance, 160) && corolla.openItemsCount === 3, '2722002 row: owner, balance 160, 3 open items', list.endpoint, short(corolla));
  }
  const inactive = await get('/vehicles?active=0');
  const ia = checkList(inactive, 'list active=0');
  if (ia) check(ia.total === 1 && ia.data[0].plateNumber === '6789012', 'active=0 -> 6789012', inactive.endpoint, short(ia.data));
  const allV = await get('/vehicles?active=all&sortBy=plate&order=asc');
  const av = checkList(allV, 'list active=all sortBy plate');
  if (av) {
    checkEq(av.total, 8, 'active=all total 8', allV.endpoint);
    const plates = av.data.map((v) => v.plateNumber);
    check(plates.join(',') === [...plates].sort().join(','), 'sorted by plate asc', allV.endpoint, short(plates));
  }
  const expectAnnual = { due: ['12345678', '3456789', '45678901'], due_soon: ['12345678'], overdue: ['3456789', '45678901'], none: ['7890123', '8765432'], muted: [] };
  for (const [filter, plates] of Object.entries(expectAnnual)) {
    const r = await get(`/vehicles?annual=${filter}&sortBy=plate&order=asc`);
    const rl = checkList(r, `list annual=${filter}`);
    if (rl) checkEq(rl.data.map((v) => v.plateNumber).sort().join(','), plates.join(','), `annual=${filter} -> ${plates.join(',') || 'empty'}`, r.endpoint);
  }
  const badAnnual = await get('/vehicles?annual=bogus');
  expectError(badAnnual, 'annual=bogus -> 400', 400);
  const byCustomer = await get(`/vehicles?customer=${ctx.customers['דני כהן']._id}`);
  const bc = checkList(byCustomer, 'list by customer');
  if (bc) checkEq(bc.total, 2, 'customer filter total 2', byCustomer.endpoint);
  const qPlate = await get('/vehicles?q=27');
  const qp = checkList(qPlate, 'list q plate prefix');
  if (qp) check(qp.total === 1 && qp.data[0].plateNumber === '2722002', 'q=27 -> 2722002', qPlate.endpoint, short(qp.data.map((v) => v.plateNumber)));
  const qText = await get('/vehicles?q=' + encodeURIComponent('ביטון') + '&active=all');
  const qt = checkList(qText, 'list q owner name');
  if (qt) checkEq(qt.total, 2, 'q=ביטון -> 2 vehicles', qText.endpoint);
  const qMake = await get('/vehicles?q=' + encodeURIComponent('סקודה'));
  const qm = checkList(qMake, 'list q make');
  if (qm) checkEq(qm.total, 1, 'q=סקודה -> 1', qMake.endpoint);
  const sortAnnual = await get('/vehicles?sortBy=annualDue&order=asc&limit=3');
  const sa = checkList(sortAnnual, 'list sortBy annualDue');
  if (sa) check(sa.data.length === 3 && sa.data.every((v) => v.annualDueAt), 'annualDue asc puts dated vehicles first', sortAnnual.endpoint, short(sa.data.map((v) => v.annualDueAt)));
  const sortMake = await get('/vehicles?sortBy=make&order=asc&page=2&limit=3');
  const sm = checkList(sortMake, 'list sortBy make page 2');
  if (sm) check(sm.page === 2 && sm.pages === 3 && sm.data.length === 3, 'paging page 2 of 3', sortMake.endpoint, short({ page: sm.page, pages: sm.pages, n: sm.data.length }));

  // lookup
  const found = await get('/vehicles/lookup/272-20-02');
  const f = expectOk(found, 'lookup found');
  if (f) {
    checkShape(f, ['found', 'vehicle', 'customer', 'openServices', 'openItems', 'lastService', 'suggestedKind'], 'lookup shape', found.endpoint);
    checkEq(f.found, true, 'lookup found true', found.endpoint);
    checkEq(f.customer?.fullName, 'דני כהן', 'lookup customer דני כהן', found.endpoint);
    checkShape(f.vehicle, VEHICLE_ROW_KEYS, 'lookup VehicleRow', found.endpoint);
    checkEq(f.openItems.length, 3, 'lookup 3 open items', found.endpoint);
    if (f.openItems[0]) checkShape(f.openItems[0], OPEN_ITEM_KEYS, 'lookup OpenItem shape', found.endpoint);
    checkEq(f.openServices.length, 0, 'lookup no open services', found.endpoint);
    check(f.lastService && f.lastService.kind === 'annual' && f.lastService.status === 'done', 'lookup lastService is the annual', found.endpoint, short(f.lastService));
    checkEq(f.suggestedKind, 'repair', 'lookup suggestedKind repair (annual ok)', found.endpoint);
    ctx.corollaOpenItems = f.openItems;
  }
  const arabic = await get('/vehicles/lookup/' + encodeURIComponent('٢٧٢٢٠٠٢'));
  const ar = expectOk(arabic, 'lookup Arabic-Indic digits');
  if (ar) checkEq(ar.found, true, 'Arabic-Indic plate normalized', arabic.endpoint);
  const dueLookup = await get('/vehicles/lookup/3456789');
  const dl = expectOk(dueLookup, 'lookup overdue vehicle');
  if (dl) checkEq(dl.suggestedKind, 'annual', 'suggestedKind annual when overdue', dueLookup.endpoint);
  const openAnnualLookup = await get('/vehicles/lookup/45678901');
  const oal = expectOk(openAnnualLookup, 'lookup vehicle with open annual');
  if (oal) {
    checkEq(oal.suggestedKind, 'repair', 'suggestedKind repair when annual already open', openAnnualLookup.endpoint);
    checkEq(oal.openServices.length, 1, 'open services listed', openAnnualLookup.endpoint);
    ctx.openAnnualServiceId = oal.openServices[0]?._id;
  }
  const notFound = await get('/vehicles/lookup/9999999');
  const nf = expectOk(notFound, 'lookup not found');
  if (nf) check(nf.found === false && nf.plateNumber === '9999999', 'not found shape', notFound.endpoint, short(nf));
  const badPlate = await get('/vehicles/lookup/12345');
  expectError(badPlate, 'lookup bad plate -> 400', 400, MSG.plateFormat);

  // makes
  const makes = await get('/vehicles/makes');
  const mk = expectOk(makes, 'makes');
  if (mk) check(Array.isArray(mk.makes) && mk.makes.length === 8 && mk.makes.includes('טויוטה'), 'makes 8 distinct', makes.endpoint, short(mk));

  // get
  const corollaId = ctx.vehicles['2722002']._id;
  const one = await get(`/vehicles/${corollaId}`);
  const od = expectOk(one, 'get');
  if (od) {
    checkShape(od, ['vehicle', 'services', 'openItems', 'totals'], 'get shape', one.endpoint);
    checkShape(od.vehicle, [...VEHICLE_ROW_KEYS, 'engineNotes', 'notes', 'mileageUpdatedAt', 'lastAnnualServiceId', 'annualDueOverrideSetAt'], 'get vehicle shape', one.endpoint);
    checkEq(od.services.length, 3, 'get 3 services', one.endpoint);
    if (od.services[0]) {
      checkShape(od.services[0], [...SERVICE_ROW_KEYS, 'items', 'differentOwner'], 'get service row + items', one.endpoint);
      check(od.services[0].kind === 'annual' && od.services[0].items.length === 8, 'newest first with 8 items', one.endpoint, short(od.services[0].items?.length));
    }
    checkEq(od.openItems.length, 3, 'get 3 open items', one.endpoint);
    check(near(od.totals.totalCharged, 460 + 650 + 270) && near(od.totals.openBalance, 160), 'get totals', one.endpoint, short(od.totals));
    checkEq(od.vehicle.lastAnnualServiceId && String(od.vehicle.lastAnnualServiceId), String(od.services[0]._id), 'lastAnnualServiceId is the newest annual', one.endpoint);
    ctx.corollaAnnualId = od.services[0]._id;
    ctx.corollaOldAnnualId = od.services.find((s) => s.kind === 'annual' && s._id !== od.services[0]._id)?._id;
  }
  const missing = await get('/vehicles/000000000000000000000000');
  expectError(missing, 'get unknown -> 404', 404, 'הרכב לא נמצא');

  // create
  const noCustomer = await post('/vehicles', { plateNumber: '1111111', make: 'טסט' });
  expectError(noCustomer, 'create without customer -> 400', 400, MSG.pickCustomer);
  const bothCustomer = await post('/vehicles', { plateNumber: '1111111', customer: ctx.smokeCustomer._id, newCustomer: { fullName: 'x' } });
  expectError(bothCustomer, 'create with customer and newCustomer -> 400', 400, MSG.pickCustomer);
  const badPlateCreate = await post('/vehicles', { plateNumber: '12-34', customer: ctx.smokeCustomer._id });
  expectError(badPlateCreate, 'create bad plate -> 400', 400, MSG.plateFormat);
  const dup = await post('/vehicles', { plateNumber: '272 20 02', customer: ctx.smokeCustomer._id });
  expectError(dup, 'create duplicate plate -> 400', 400, 'מספר רכב 2722002 כבר קיים במערכת');
  check(dup.body?.data?.existingVehicleId && String(dup.body.data.existingVehicleId) === String(corollaId), 'duplicate carries existingVehicleId', dup.endpoint, short(dup.body));
  const created = await post('/vehicles', {
    plateNumber: '11-222-33', make: 'טסט', model: 'סמוק', year: 2020, color: 'ירוק', fuelType: 'hybrid', mileage: 50000,
    newCustomer: { fullName: 'בעל רכב חדש', phone: '0507778899' },
  });
  const cv = expectOk(created, 'create with newCustomer', 201);
  if (cv) {
    checkShape(cv, ['vehicle', 'customer', 'createdCustomer'], 'create shape', created.endpoint);
    checkEq(cv.createdCustomer, true, 'createdCustomer true', created.endpoint);
    checkEq(cv.vehicle.plateNumber, '1122233', 'plate normalized', created.endpoint);
    checkShape(cv.vehicle, VEHICLE_ROW_KEYS, 'create VehicleRow', created.endpoint);
    checkEq(cv.vehicle.annualState, 'none', 'new vehicle annual none', created.endpoint);
    checkEq(cv.customer.fullName, 'בעל רכב חדש', 'new customer returned', created.endpoint);
    ctx.smokeVehicle = cv.vehicle;
    ctx.smokeVehicleOwner = cv.customer;
  }
  const created2 = await post('/vehicles', { plateNumber: '44455566', make: 'טסט', model: 'שני', customer: ctx.smokeCustomer._id });
  const cv2 = expectOk(created2, 'create with existing customer', 201);
  if (cv2) {
    checkEq(cv2.createdCustomer, false, 'createdCustomer false', created2.endpoint);
    ctx.smokeVehicle2 = cv2.vehicle;
  }
  const badYear = await post('/vehicles', { plateNumber: '5556667', year: 1800, customer: ctx.smokeCustomer._id });
  expectError(badYear, 'create bad year -> 400', 400);

  // update incl plate change
  const vid = ctx.smokeVehicle._id;
  const upd = await put(`/vehicles/${vid}`, { color: 'כחול', mileage: 51000, notes: 'הערה' });
  const u = expectOk(upd, 'update fields');
  if (u) {
    checkEq(u.color, 'כחול', 'update color', upd.endpoint);
    checkEq(u.mileage, 51000, 'update mileage', upd.endpoint);
  }
  const dupPlate = await put(`/vehicles/${vid}`, { plateNumber: '2722002' });
  expectError(dupPlate, 'update to existing plate -> 400', 400, 'מספר רכב 2722002 כבר קיים במערכת');
  check(dupPlate.body?.data?.existingVehicleId, 'update duplicate carries existingVehicleId', dupPlate.endpoint, short(dupPlate.body));
  // plate change syncing services: create a service on the vehicle first
  const svcForPlate = await post('/services', { vehicle: vid, kind: 'repair', status: 'done', items: [{ title: 'בדיקה כללית', price: 100 }] });
  const sp = expectOk(svcForPlate, 'create service on smoke vehicle (for plate sync)', 201);
  ctx.smokeVehicleService = sp?.service;
  if (sp) ctx.extraServices += 1;
  const plateChange = await put(`/vehicles/${vid}`, { plateNumber: '11-222-34' });
  const pc = expectOk(plateChange, 'update plate');
  if (pc) {
    checkEq(pc.plateNumber, '1122234', 'plate changed', plateChange.endpoint);
    const svc = await get(`/services/${sp?.service?._id}`);
    const sd = expectOk(svc, 'service after plate change');
    if (sd) checkEq(sd.service.plateNumber, '1122234', 'Service.plateNumber synced', svc.endpoint);
    const oldLookup = await get('/vehicles/lookup/1122233');
    const ol = expectOk(oldLookup, 'old plate lookup');
    if (ol) checkEq(ol.found, false, 'old plate no longer found', oldLookup.endpoint);
    ctx.smokeVehicle.plateNumber = '1122234';
  }
  const deactivate = await put(`/vehicles/${ctx.smokeVehicle2._id}`, { active: false });
  const da = expectOk(deactivate, 'update active false');
  if (da) check(da.active === false && da.annualState === 'muted', 'inactive vehicle is muted', deactivate.endpoint, short(da));
  const reactivate = await put(`/vehicles/${ctx.smokeVehicle2._id}`, { active: true });
  const ra = expectOk(reactivate, 'update active true');
  if (ra) checkEq(ra.active, true, 'reactivated', reactivate.endpoint);

  // transfer
  const sameOwner = await put(`/vehicles/${vid}/transfer`, { customer: ctx.smokeVehicleOwner._id });
  expectError(sameOwner, 'transfer to same customer -> 400', 400, MSG.sameCustomer);
  const noTarget = await put(`/vehicles/${vid}/transfer`, {});
  expectError(noTarget, 'transfer without customer -> 400', 400, MSG.pickCustomer);
  // open unpaid service to be moved
  const openSvc = await post('/services', { vehicle: vid, kind: 'repair', status: 'pending', items: [{ title: 'לבדוק', done: false }] });
  const os = expectOk(openSvc, 'create open service on smoke vehicle', 201);
  if (os) ctx.extraServices += 1;
  const t1 = await put(`/vehicles/${vid}/transfer`, { customer: ctx.smokeCustomer._id });
  const td = expectOk(t1, 'transfer without moveOpenServices');
  if (td) {
    checkShape(td, ['vehicle', 'customer', 'movedServices'], 'transfer shape', t1.endpoint);
    checkEq(td.movedServices, 0, 'movedServices 0', t1.endpoint);
    checkEq(String(td.vehicle.customer._id), String(ctx.smokeCustomer._id), 'vehicle owner changed', t1.endpoint);
    const s = await get(`/services/${os?.service?._id}`);
    const sd = expectOk(s, 'open service after transfer');
    if (sd) {
      checkEq(String(sd.service.customer._id), String(ctx.smokeVehicleOwner._id), 'service customer snapshot kept', s.endpoint);
      checkEq(sd.differentOwner, true, 'differentOwner true after transfer', s.endpoint);
    }
  }
  const t2 = await put(`/vehicles/${vid}/transfer`, { newCustomer: { fullName: 'בעלים שלישי', phone: '0509990001' }, moveOpenServices: true });
  const td2 = expectOk(t2, 'transfer with newCustomer + moveOpenServices');
  if (td2) {
    checkEq(td2.movedServices, 1, 'movedServices 1 (open, unpaid)', t2.endpoint);
    checkEq(td2.customer.fullName, 'בעלים שלישי', 'transfer created customer', t2.endpoint);
    ctx.thirdOwner = td2.customer;
    const s = await get(`/services/${os?.service?._id}`);
    const sd = expectOk(s, 'open service after move');
    if (sd) checkEq(String(sd.service.customer._id), String(td2.customer._id), 'open service re-pointed', s.endpoint);
    const done = await get(`/services/${sp?.service?._id}`);
    const dd = expectOk(done, 'done service after move');
    if (dd) checkEq(String(dd.service.customer._id), String(ctx.smokeVehicleOwner._id), 'done service not moved', done.endpoint);
  }
  ctx.smokeOpenService = os?.service;

  // annual override / mute / clear
  const overrideDate = ymd(new Date(Date.now() + 10 * 86400000));
  const ov = await put(`/vehicles/${vid}/annual`, { annualDueOverride: overrideDate });
  const ovd = expectOk(ov, 'annual override');
  if (ovd) {
    checkShape(ovd, VEHICLE_ROW_KEYS, 'annual returns VehicleRow', ov.endpoint);
    check(ovd.annualDueOverride && ymd(ovd.annualDueOverride) === overrideDate, 'override stored', ov.endpoint, short(ovd.annualDueOverride));
    check(ovd.annualDueAt && ymd(ovd.annualDueAt) === overrideDate, 'annualDueAt follows override', ov.endpoint, short(ovd.annualDueAt));
    checkEq(ovd.annualState, 'due_soon', 'override in 10 days -> due_soon', ov.endpoint);
    checkEq(ovd.daysToAnnual, 10, 'daysToAnnual 10', ov.endpoint);
  }
  const mute = await put(`/vehicles/${vid}/annual`, { annualReminderMuted: true });
  const md = expectOk(mute, 'annual mute');
  if (md) check(md.annualReminderMuted === true && md.annualState === 'muted', 'muted state', mute.endpoint, short(md));
  const mutedList = await get('/vehicles?annual=muted');
  const ml = checkList(mutedList, 'list annual=muted after mute');
  if (ml) check(ml.data.some((v) => v._id === vid), 'muted vehicle listed', mutedList.endpoint);
  const unmute = await put(`/vehicles/${vid}/annual`, { annualReminderMuted: false, annualDueOverride: null });
  const ud = expectOk(unmute, 'annual clear override + unmute');
  if (ud) check(ud.annualDueOverride === null && ud.annualDueAt === null && ud.annualState === 'none', 'cleared back to none', unmute.endpoint, short(ud));
  const badDate = await put(`/vehicles/${vid}/annual`, { annualDueOverride: 'not-a-date' });
  expectError(badDate, 'annual bad date -> 400', 400);

  // backfill
  const future = await post(`/vehicles/${vid}/annual/backfill`, { completedAt: ymd(new Date(Date.now() + 5 * 86400000)) });
  expectError(future, 'backfill future -> 400', 400, MSG.backfillFuture);
  const noDate = await post(`/vehicles/${vid}/annual/backfill`, {});
  expectError(noDate, 'backfill without date -> 400', 400);
  const bfDate = ymd(daysAgo(200));
  const bf = await post(`/vehicles/${vid}/annual/backfill`, { completedAt: bfDate, mileage: 52000, note: 'טיפול קודם' });
  const bfd = expectOk(bf, 'backfill', 201);
  if (bfd) {
    checkShape(bfd, ['service', 'vehicle'], 'backfill shape', bf.endpoint);
    checkShape(bfd.service, SERVICE_ROW_KEYS, 'backfill ServiceRow', bf.endpoint);
    check(bfd.service.kind === 'annual' && bfd.service.status === 'done' && ymd(bfd.service.completedAt) === bfDate, 'backfill service done annual on date', bf.endpoint, short(bfd.service));
    checkEq(bfd.vehicle.annualState, 'ok', 'backfill -> annual ok (165 days)', bf.endpoint);
    check(bfd.vehicle.lastAnnualAt && ymd(bfd.vehicle.lastAnnualAt) === bfDate, 'lastAnnualAt set', bf.endpoint, short(bfd.vehicle.lastAnnualAt));
    checkEq(bfd.vehicle.mileage, 52000, 'backfill mileage raised vehicle mileage', bf.endpoint);
    ctx.backfillServiceId = bfd.service._id;
    ctx.extraServices += 1;
  }
  const dupDay = await post(`/vehicles/${vid}/annual/backfill`, { completedAt: bfDate });
  expectError(dupDay, 'backfill same day -> 400', 400, MSG.backfillDuplicate);
  const defaultNote = await post(`/vehicles/${vid}/annual/backfill`, { completedAt: ymd(daysAgo(600)) });
  const dn = expectOk(defaultNote, 'backfill older with default note', 201);
  if (dn) {
    checkEq(dn.service.notesPreview, 'רשומה היסטורית לצורך תזכורת טיפול שנתי', 'backfill default note', defaultNote.endpoint);
    check(ymd(dn.vehicle.lastAnnualAt) === bfDate, 'older backfill does not move lastAnnualAt', defaultNote.endpoint, short(dn.vehicle.lastAnnualAt));
    ctx.oldBackfillServiceId = dn.service._id;
    ctx.extraServices += 1;
  }

  // deletion preview on a vehicle with services (the delete itself cascades: see the cascade section)
  const preview = await get(`/vehicles/${vid}/deletion`);
  const pv = expectOk(preview, 'deletion preview');
  if (pv) check(pv.vehicles === 1 && pv.services >= 3 && pv.payments === 0, 'preview counts the services of the vehicle', preview.endpoint, short(pv));
}

async function testServicesLists(ctx) {
  const def = await get('/services');
  const d = checkList(def, 'list default (open)');
  if (d) {
    check(d.data.every((s) => ['pending', 'in_progress'].includes(s.status)), 'default = pending + in_progress', def.endpoint, short(d.data.map((s) => s.status)));
    checkShape(d.data[0], SERVICE_ROW_KEYS, 'ServiceRow shape', def.endpoint);
    check(d.data[0].items === undefined && d.data[0].payments === undefined && d.data[0].notes === undefined, 'ServiceRow has no items/payments/notes', def.endpoint);
    checkShape(d.data[0].vehicle, ['_id', 'plateNumber', 'make', 'model', 'year'], 'VehicleRef', def.endpoint);
    checkShape(d.data[0].customer, ['_id', 'fullName', 'phone'], 'CustomerRef', def.endpoint);
  }
  const combos = [
    ['status=pending', (s) => s.status === 'pending'],
    ['status=in_progress', (s) => s.status === 'in_progress'],
    ['status=done', (s) => s.status === 'done'],
    ['status=cancelled', (s) => s.status === 'cancelled'],
    ['status=done,cancelled', (s) => ['done', 'cancelled'].includes(s.status)],
    ['status=all', () => true],
    ['status=all&kind=annual', (s) => s.kind === 'annual'],
    ['status=all&kind=repair,other', (s) => ['repair', 'other'].includes(s.kind)],
    ['status=all&payment=open', (s) => s.balance > 0.005 && s.status !== 'cancelled'],
    ['status=all&payment=unpaid', (s) => s.paymentStatus === 'unpaid'],
    ['status=all&payment=partial', (s) => s.paymentStatus === 'partial'],
    ['status=all&payment=paid', (s) => s.paymentStatus === 'paid'],
    ['status=all&q=2722002', (s) => s.plateNumber === '2722002'],
    ['status=all&q=' + encodeURIComponent('מיכל'), (s) => s.customer?.fullName === 'מיכל אברהם'],
    ['status=all&q=' + encodeURIComponent('מצבר'), () => true],
  ];
  for (const [qs, pred] of combos) {
    const r = await get(`/services?${qs}`);
    const l = checkList(r, `list ${decodeURIComponent(qs)}`);
    if (l) check(l.data.length > 0 && l.data.every(pred), `filter ${decodeURIComponent(qs)} rows match`, r.endpoint, short(l.data.map((s) => [s.status, s.kind, s.paymentStatus, s.balance])));
  }
  const cancelledCount = await get('/services?status=cancelled');
  const cc = checkList(cancelledCount, 'status=cancelled count');
  if (cc) checkEq(cc.total, 1, 'one cancelled demo service', cancelledCount.endpoint);
  const itemQ = await get('/services?status=all&q=' + encodeURIComponent('מצבר'));
  const iq = checkList(itemQ, 'q item title');
  if (iq) checkEq(iq.total, 2, 'q=מצבר -> 2 services', itemQ.endpoint);
  const corolla = (await get('/vehicles/lookup/2722002')).body?.data?.vehicle;
  const byVehicle = await get(`/services?status=all&vehicle=${corolla?._id}`);
  const bv = checkList(byVehicle, 'list by vehicle');
  if (bv) checkEq(bv.total, 3, 'vehicle filter total 3', byVehicle.endpoint);
  const byCustomer = await get(`/services?status=all&customer=${ctx.customers['דני כהן']._id}`);
  const bcu = checkList(byCustomer, 'list by customer');
  if (bcu) checkEq(bcu.total, 5, 'customer filter total 5', byCustomer.endpoint);
  const badVehicle = await get('/services?vehicle=nope');
  expectError(badVehicle, 'bad vehicle id -> 400', 400);
  const range = await get(`/services?status=all&from=${ymd(daysAgo(3))}&to=${ymd(new Date())}`);
  const rg = checkList(range, 'list from/to');
  if (rg) {
    checkEq(rg.total, 4, 'last 3 days -> 4 services (T-2, T-1, T, T)', range.endpoint);
    const fromTs = daysAgo(3).setHours(0, 0, 0, 0);
    check(rg.data.every((s) => new Date(s.openedAt).getTime() >= fromTs), 'from bound respected', range.endpoint);
  }
  const toOnly = await get(`/services?status=all&to=${ymd(daysAgo(100))}`);
  const to = checkList(toOnly, 'list to only');
  if (to) check(to.total === 7 && to.data.every((s) => new Date(s.openedAt) < daysAgo(99)), 'to bound (7 old services)', toOnly.endpoint, short(to.total));
  for (const [sortBy, order] of [['openedAt', 'desc'], ['openedAt', 'asc'], ['completedAt', 'desc'], ['balance', 'desc'], ['balance', 'asc'], ['updatedAt', 'desc']]) {
    const r = await get(`/services?status=all&sortBy=${sortBy}&order=${order}&limit=100`);
    const l = checkList(r, `sort ${sortBy} ${order}`);
    if (!l) continue;
    const vals = l.data.map((s) => (s[sortBy] == null ? null : sortBy === 'balance' ? s.balance : new Date(s[sortBy]).getTime())).filter((v) => v != null);
    const sorted = [...vals].sort((a, b) => (order === 'asc' ? a - b : b - a));
    checkEq(vals.join(','), sorted.join(','), `sorted by ${sortBy} ${order}`, r.endpoint);
  }
  const paged = await get('/services?status=all&limit=4&page=2');
  const pg = checkList(paged, 'list paged');
  if (pg) check(pg.total === 15 && pg.page === 2 && pg.pages === 4 && pg.data.length === 4, 'page 2 of 4, limit 4, total 15', paged.endpoint, short({ total: pg.total, page: pg.page, pages: pg.pages, n: pg.data.length }));
}

async function testServiceDetailAndCreate(ctx) {
  // get
  const annualId = ctx.corollaAnnualId;
  const one = await get(`/services/${annualId}`);
  const od = expectOk(one, 'get');
  if (od) {
    checkShape(od, ['service', 'differentOwner', 'openItemsElsewhere', 'quickTemplates'], 'get shape', one.endpoint);
    checkShape(od.service, SERVICE_FULL_KEYS, 'ServiceFull shape', one.endpoint);
    checkShape(od.service.vehicle, ['_id', 'plateNumber', 'make', 'model', 'year', 'mileage', 'color', 'engineNotes', 'customer', 'active'], 'ServiceFull vehicle populate', one.endpoint);
    checkShape(od.service.customer, ['_id', 'fullName', 'phone'], 'ServiceFull customer populate', one.endpoint);
    checkEq(od.differentOwner, false, 'differentOwner false', one.endpoint);
    checkEq(od.openItemsElsewhere.length, 0, 'openItemsElsewhere excludes own items', one.endpoint);
    check(Array.isArray(od.quickTemplates) && od.quickTemplates.length === 10, 'quickTemplates top 10', one.endpoint, short(od.quickTemplates?.length));
    check(od.service.items.length === 8 && od.service.remainingCount === 3 && od.service.itemsDoneCount === 5, 'annual items 8 / done 5 / remaining 3', one.endpoint, short([od.service.itemsCount, od.service.itemsDoneCount, od.service.remainingCount]));
    check(near(od.service.totalPrice, 460) && near(od.service.paidAmount, 300) && near(od.service.balance, 160) && od.service.paymentStatus === 'partial', 'annual money 460/300/160 partial', one.endpoint, short([od.service.totalPrice, od.service.paidAmount, od.service.balance, od.service.paymentStatus]));
    check(near(od.service.remainingQuote, 300), 'remainingQuote 300 (120 + 180)', one.endpoint, short(od.service.remainingQuote));
    check(od.service.statusHistory.length >= 1 && od.service.statusHistory.at(-1).to === 'done', 'statusHistory ends with done', one.endpoint, short(od.service.statusHistory));
  }
  const withPhone2 = await get(`/services/${ctx.openAnnualServiceId}`);
  const wp = expectOk(withPhone2, 'get service of a customer with phone2');
  if (wp) checkEq(wp.service.customer?.phone2, '0537654321', 'ServiceFull customer carries phone2', withPhone2.endpoint);
  const oldAnnual = await get(`/services/${ctx.corollaOldAnnualId}`);
  const oa = expectOk(oldAnnual, 'get older annual');
  if (oa) checkEq(oa.openItemsElsewhere.length, 3, 'openItemsElsewhere shows the 3 remaining items of the newer annual', oldAnnual.endpoint);
  const missing = await get('/services/000000000000000000000000');
  expectError(missing, 'get unknown -> 404', 404, 'הטיפול לא נמצא');
  const badId = await get('/services/bad');
  expectError(badId, 'get bad id -> 404', 404, 'הטיפול לא נמצא');

  // an empty visit is allowed since 2026-09-23 (the tasks are added on its page); tags: 1 to 4, canonical order
  const empty = await post('/services', { plateNumber: '2722002', kinds: ['repair', 'annual', 'other'], otherLabel: 'ניקוי' });
  const e = expectOk(empty, 'create with no items and no notes -> 201', 201);
  if (e) {
    check(e.service.items.length === 0 && JSON.stringify(e.service.kinds) === '["annual","repair","other"]' && e.service.kind === 'annual' && e.service.otherLabel === 'ניקוי', 'empty visit: kinds in canonical order, kind = leading tag, otherLabel kept', empty.endpoint, short([e.service.kinds, e.service.kind, e.service.otherLabel]));
    await del(`/services/${e.service._id}`);
  }
  const badKinds = await post('/services', { plateNumber: '2722002', kinds: ['annual', 'bogus'] });
  expectError(badKinds, 'create with an unknown tag -> 400', 400);
  const longLabel = await post('/services', { plateNumber: '2722002', kinds: ['other'], otherLabel: 'א'.repeat(16) });
  expectError(longLabel, 'create with a 16 character other label -> 400', 400);
  const emptyItems = await post('/services', { plateNumber: '2722002', items: [], notes: '   ' });
  const ei = expectOk(emptyItems, 'create with blank notes -> 201 (repair by default)', 201);
  if (ei) {
    check(JSON.stringify(ei.service.kinds) === '["repair"]' && ei.service.kind === 'repair', 'default tag is repair', emptyItems.endpoint, short(ei.service.kinds));
    await del(`/services/${ei.service._id}`);
  }
  // automatic status (2026-09-23): a waiting visit starts by itself with the first task marked done
  const waiting = await post('/services', { plateNumber: '2722002', status: 'pending', items: [{ title: 'בדיקת בלמים', done: false }, { title: 'מגבים', done: false }] });
  const w = expectOk(waiting, 'create a waiting visit with two undone tasks', 201);
  if (w) {
    checkEq(w.service.status, 'pending', 'undone tasks keep it waiting', waiting.endpoint);
    const added = await post(`/services/${w.service._id}/items`, { title: 'שמן', done: false });
    const a = expectOk(added, 'adding an undone task keeps it waiting', 201);
    if (a) checkEq(a.status, 'pending', 'still pending after an undone task', added.endpoint);
    const toggled = await patch(`/services/${w.service._id}/items/${w.service.items[0]._id}/toggle`);
    const t = expectOk(toggled, 'toggle the first task done');
    if (t) {
      checkEq(t.status, 'in_progress', 'the first done task moves it to in_progress', toggled.endpoint);
      check(t.startedAt != null && t.statusHistory.at(-1)?.from === 'pending' && t.statusHistory.at(-1)?.to === 'in_progress', 'startedAt set and a history line logged', toggled.endpoint, short(t.statusHistory.at(-1)));
    }
    const untoggled = await patch(`/services/${w.service._id}/items/${w.service.items[0]._id}/toggle`);
    const u2 = expectOk(untoggled, 'toggle it back');
    if (u2) checkEq(u2.status, 'in_progress', 'unticking does not send it back to waiting', untoggled.endpoint);
    await del(`/services/${w.service._id}`);
  }
  // engine oil type on an item (2026-09-23): stored on create, changed through PUT, at most 30 characters
  const oily = await post('/services', { plateNumber: '2722002', kinds: ['annual'], items: [{ title: 'שמן מנוע', done: false, oilType: ' 5W-30 ' }, { title: 'מסנן מזגן', done: false }] });
  const o = expectOk(oily, 'create an annual visit with an oil task', 201);
  if (o) {
    checkEq(o.service.items[0].oilType, '5W-30', 'oilType stored (trimmed)', oily.endpoint);
    checkEq(o.service.items[1].oilType, '', 'other items carry an empty oilType', oily.endpoint);
    const changed = await put(`/services/${o.service._id}/items/${o.service.items[0]._id}`, { oilType: 'Castrol Edge 0W-20 LL' });
    const c = expectOk(changed, 'change the oil type');
    if (c) checkEq(c.items[0].oilType, 'Castrol Edge 0W-20 LL', 'oilType updated', changed.endpoint);
    const long = await put(`/services/${o.service._id}/items/${o.service.items[0]._id}`, { oilType: 'x'.repeat(40) });
    const l = expectOk(long, 'a long oil type is cut, not rejected');
    if (l) checkEq(l.items[0].oilType.length, 30, 'oilType capped at 30 characters', long.endpoint);
    const cleared = await put(`/services/${o.service._id}/items/${o.service.items[0]._id}`, { oilType: '' });
    const cl = expectOk(cleared, 'clear the oil type');
    if (cl) checkEq(cl.items[0].oilType, '', 'oilType cleared', cleared.endpoint);
    await del(`/services/${o.service._id}`);
  }
  const badPlate = await post('/services', { plateNumber: '123', items: [{ title: 'x' }] });
  expectError(badPlate, 'create bad plate -> 400', 400, MSG.plateFormat);
  const newNoCustomer = await post('/services', { plateNumber: '9876543', newVehicle: { make: 'a' }, items: [{ title: 'x' }] });
  expectError(newNoCustomer, 'create new vehicle without customer -> 400', 400, MSG.pickCustomer);
  const unknownVehicle = await post('/services', { vehicle: '000000000000000000000000', items: [{ title: 'x' }] });
  expectError(unknownVehicle, 'create unknown vehicle id -> 404', 404, 'הרכב לא נמצא');
  const badStatus = await post('/services', { plateNumber: '2722002', status: 'cancelled', items: [{ title: 'x' }] });
  expectError(badStatus, 'create with status cancelled -> 400', 400);
  const noTitle = await post('/services', { plateNumber: '2722002', items: [{ title: '  ' }] });
  expectError(noTitle, 'create item without title -> 400', 400, 'שם הפריט הוא שדה חובה');
  const negPrice = await post('/services', { plateNumber: '2722002', items: [{ title: 'x', price: -5 }] });
  expectError(negPrice, 'create negative price -> 400', 400);

  // create via plate with carryItems + first payment (the corolla with 3 open items)
  const carry = ctx.corollaOpenItems.slice(0, 2).map((it) => ({ serviceId: it.serviceId, itemId: it.itemId }));
  const viaPlate = await post('/services', {
    plateNumber: '272-20-02',
    customer: ctx.smokeCustomer._id, // must be ignored: the vehicle's owner is used
    kind: 'repair',
    status: 'in_progress',
    mileage: 119000,
    items: [{ title: 'מסנן שמן מקורי', price: 60 }, { title: 'שמן מנוע 5w40', price: 220, done: true }, { title: 'בדיקת בלמים', done: false, price: 100 }],
    carryItems: carry,
    payment: { amount: 100, method: 'bit', note: 'מקדמה' },
    notes: 'טיפול בדיקה',
  });
  const vp = expectOk(viaPlate, 'create via plate + carry + payment', 201);
  if (vp) {
    checkShape(vp, ['service', 'vehicle', 'customer', 'createdVehicle', 'createdCustomer'], 'create shape', viaPlate.endpoint);
    checkShape(vp.service, SERVICE_FULL_KEYS, 'create ServiceFull', viaPlate.endpoint);
    checkShape(vp.vehicle, VEHICLE_ROW_KEYS, 'create VehicleRow', viaPlate.endpoint);
    check(vp.createdVehicle === false && vp.createdCustomer === false, 'nothing created', viaPlate.endpoint);
    checkEq(vp.customer.fullName, 'דני כהן', 'customer in body ignored (owner used)', viaPlate.endpoint);
    checkEq(String(vp.service.customer._id), String(ctx.customers['דני כהן']._id), 'service customer snapshot = owner', viaPlate.endpoint);
    checkEq(vp.service.status, 'in_progress', 'status in_progress', viaPlate.endpoint);
    check(vp.service.startedAt, 'startedAt set', viaPlate.endpoint);
    checkEq(vp.service.items.length, 5, '3 items + 2 carried', viaPlate.endpoint);
    const carried = vp.service.items.filter((i) => i.carriedFrom?.service);
    check(carried.length === 2 && carried.every((i) => !i.done && String(i.carriedFrom.service) === String(annualId)), 'carried copies link to the annual', viaPlate.endpoint, short(carried));
    check(carried.some((i) => i.title === 'פקק אטימה בראש מנוע' && i.parts?.[0]?.qty === 2 && i.total === 120), 'carried copy keeps part qty 2 and total 120', viaPlate.endpoint, short(carried));
    check(near(vp.service.itemsTotal, 280) && near(vp.service.totalPrice, 280), 'itemsTotal 280 (done only)', viaPlate.endpoint, short(vp.service.itemsTotal));
    check(near(vp.service.paidAmount, 100) && near(vp.service.balance, 180) && vp.service.paymentStatus === 'partial', 'first payment 100 -> balance 180 partial', viaPlate.endpoint, short([vp.service.paidAmount, vp.service.balance]));
    checkEq(vp.service.payments[0]?.method, 'bit', 'payment method bit', viaPlate.endpoint);
    checkEq(vp.vehicle.mileage, 119000, 'mileage rule raised vehicle mileage', viaPlate.endpoint);
    checkEq(vp.vehicle.openServicesCount, 1, 'vehicle openServicesCount 1', viaPlate.endpoint);
    checkEq(vp.vehicle.openItemsCount, 4, 'vehicle openItemsCount 4 (1 uncarried + 2 copies + 1 new todo)', viaPlate.endpoint);
    check(vp.service.statusHistory.length === 1 && vp.service.statusHistory[0].from === null && vp.service.statusHistory[0].to === 'in_progress', 'history: null -> in_progress', viaPlate.endpoint, short(vp.service.statusHistory));
    ctx.workService = vp.service;
    ctx.extraServices += 1;
  }
  // the source annual now has 1 remaining and 2 carried
  const annualAfter = await get(`/services/${annualId}`);
  const aa = expectOk(annualAfter, 'source annual after carry');
  if (aa) {
    checkEq(aa.service.remainingCount, 1, 'source remainingCount 1', annualAfter.endpoint);
    const withTo = aa.service.items.filter((i) => i.carriedTo?.service);
    check(withTo.length === 2 && withTo.every((i) => String(i.carriedTo.service) === String(ctx.workService._id)), 'source items carriedTo set', annualAfter.endpoint, short(withTo));
    ctx.carriedSourceItem = withTo[0];
    checkEq(aa.openItemsElsewhere.length, 3, 'annual sees 3 open items elsewhere (2 copies + 1 new)', annualAfter.endpoint);
  }
  const carryAgain = await post('/services', { plateNumber: '2722002', carryItems: carry, notes: 'x' });
  expectError(carryAgain, 'carry already carried item -> 400', 400, MSG.carryUsed);
  const templateBump = await get('/templates?sortBy=recent');
  const tb = expectOk(templateBump, 'templates after usage');
  if (tb) {
    const oil = tb.templates.find((t) => t.title === 'שמן מנוע 5w40');
    check(oil && oil.price === 220 && oil.total === 220 && oil.lastUsedAt, 'template usage bumped (price 220)', templateBump.endpoint, short(oil));
    check(tb.recent.length > 0 && tb.recent[0].lastUsedAt, 'recent templates populated', templateBump.endpoint);
  }

  // create via vehicle id
  const viaId = await post('/services', { vehicle: ctx.vehicles['5678901']._id, kind: 'inspection', items: [{ title: 'טסט שנתי', done: false }], openedAt: ymd(daysAgo(1)) });
  const vi = expectOk(viaId, 'create via vehicle id', 201);
  if (vi) {
    checkEq(vi.service.plateNumber, '5678901', 'plate denormalized', viaId.endpoint);
    checkEq(vi.service.status, 'pending', 'default status pending', viaId.endpoint);
    checkEq(vi.service.statusHistory.length, 0, 'new pending has no history entry', viaId.endpoint);
    checkEq(vi.service.remainingCount, 1, 'todo item remaining', viaId.endpoint);
    checkEq(ymd(vi.service.openedAt), ymd(daysAgo(1)), 'openedAt honoured', viaId.endpoint);
    ctx.pendingService = vi.service;
    ctx.extraServices += 1;
  }
  // create with newVehicle + newCustomer
  const brandNew = await post('/services', {
    plateNumber: '99-888-77',
    newVehicle: { make: 'סיאט', model: 'איביזה', year: 2017, mileage: 80000, fuelType: '' },
    newCustomer: { fullName: 'לקוח חדש לגמרי', phone: '052-000-1122' },
    status: 'done',
    kind: 'repair',
    items: [{ title: 'מגבים', price: 120 }],
    payment: { amount: 120, method: 'cash' },
  });
  const bn = expectOk(brandNew, 'create newVehicle + newCustomer', 201);
  if (bn) {
    check(bn.createdVehicle === true && bn.createdCustomer === true, 'created both', brandNew.endpoint);
    checkEq(bn.vehicle.plateNumber, '9988877', 'new vehicle plate', brandNew.endpoint);
    checkEq(bn.vehicle.make, 'סיאט', 'new vehicle make', brandNew.endpoint);
    checkEq(bn.customer.fullName, 'לקוח חדש לגמרי', 'new customer', brandNew.endpoint);
    checkEq(bn.customer.phone, '0520001122', 'new customer phone normalized', brandNew.endpoint);
    check(bn.service.status === 'done' && bn.service.completedAt && bn.service.paymentStatus === 'paid' && near(bn.service.balance, 0), 'done and paid', brandNew.endpoint, short(bn.service));
    checkEq(bn.vehicle.mileage, 80000, 'new vehicle mileage', brandNew.endpoint);
    checkEq(bn.vehicle.servicesCount, 1, 'servicesCount 1', brandNew.endpoint);
    ctx.brandNewService = bn.service;
    ctx.brandNewVehicle = bn.vehicle;
    ctx.brandNewCustomer = bn.customer;
    ctx.extraServices += 1;
  }
  const dupNew = await post('/services', { plateNumber: '9988877', newVehicle: { make: 'x' }, newCustomer: { fullName: 'y' }, items: [{ title: 'z' }] });
  const dn = expectOk(dupNew, 'create with existing plate ignores newVehicle/newCustomer', 201);
  if (dn) {
    check(dn.createdVehicle === false && dn.createdCustomer === false && dn.customer.fullName === 'לקוח חדש לגמרי', 'existing owner used', dupNew.endpoint, short(dn.customer));
    ctx.extraServices += 1;
    ctx.dupNewService = dn.service;
  }
}

async function testServiceUpdateAndStatus(ctx) {
  const id = ctx.workService._id;
  // update
  const upd = await put(`/services/${id}`, { kind: 'annual', mileage: 119500, notes: 'עודכן', completedAt: ymd(daysAgo(1)), openedAt: ymd(daysAgo(1)), status: 'done', totalPrice: 5 });
  const u = expectOk(upd, 'update');
  if (u) {
    checkShape(u, SERVICE_FULL_KEYS, 'update returns ServiceFull', upd.endpoint);
    check(u.kind === 'annual' && u.mileage === 119500 && u.notes === 'עודכן', 'update fields', upd.endpoint, short([u.kind, u.mileage, u.notes]));
    checkEq(u.status, 'in_progress', 'update cannot change status', upd.endpoint);
    check(u.completedAt == null, 'completedAt ignored while not done', upd.endpoint, short(u.completedAt));
    check(near(u.totalPrice, 280), 'totalPrice not writable', upd.endpoint, short(u.totalPrice));
    checkEq(ymd(u.openedAt), ymd(daysAgo(1)), 'openedAt updated', upd.endpoint);
  }
  const v1 = await get(`/vehicles/${ctx.vehicles['2722002']._id}`);
  const vd1 = expectOk(v1, 'vehicle after kind change to annual');
  if (vd1) {
    checkEq(vd1.vehicle.annualState, 'open', 'open annual -> state open', v1.endpoint);
    checkEq(String(vd1.vehicle.openAnnualServiceId), String(id), 'openAnnualServiceId points at it', v1.endpoint);
    checkEq(vd1.vehicle.mileage, 119500, 'mileage rule on update', v1.endpoint);
  }
  const manual = await put(`/services/${id}`, { totalMode: 'manual', manualTotal: 400 });
  const m = expectOk(manual, 'update manual total');
  if (m) check(m.totalMode === 'manual' && near(m.totalPrice, 400) && near(m.balance, 300) && near(m.itemsTotal, 280), 'manual 400 -> balance 300, itemsTotal 280 kept', manual.endpoint, short([m.totalPrice, m.balance, m.itemsTotal]));
  const backItems = await put(`/services/${id}`, { totalMode: 'items', kind: 'repair' });
  const bi = expectOk(backItems, 'update back to items mode + kind repair');
  if (bi) check(near(bi.totalPrice, 280), 'items mode restored', backItems.endpoint, short(bi.totalPrice));
  const badMode = await put(`/services/${id}`, { totalMode: 'bogus' });
  expectError(badMode, 'bad totalMode -> 400', 400);
  const badKind = await put(`/services/${id}`, { kind: 'bogus' });
  expectError(badKind, 'bad kind -> 400', 400);

  // status transitions on the work service: in_progress -> pending -> in_progress -> done -> in_progress -> done -> cancelled -> pending -> cancelled
  const status = async (target, body = {}, label) => {
    const r = await patch(`/services/${id}/status`, { status: target, ...body });
    const d = expectOk(r, label || `status -> ${target}`);
    if (d) {
      checkShape(d, ['service', 'vehicle'], `${target} returns service + vehicle`, r.endpoint);
      checkEq(d.service.status, target, `${target} applied`, r.endpoint);
    }
    return d;
  };
  const illegal = async (target, label) => {
    const r = await patch(`/services/${id}/status`, { status: target });
    expectError(r, label || `illegal -> ${target}`, 400, MSG.badTransition);
  };

  await illegal('bogus', 'illegal: unknown status');
  await illegal('in_progress', 'illegal: in_progress -> in_progress (same)');
  let s = await status('pending', { note: 'חזרה לממתין' }, 'in_progress -> pending');
  if (s) check(s.service.statusHistory.at(-1).from === 'in_progress' && s.service.statusHistory.at(-1).to === 'pending' && s.service.statusHistory.at(-1).note === 'חזרה לממתין', 'history entry with note', 'PATCH status', short(s.service.statusHistory.at(-1)));
  await illegal('cancelled_x', 'illegal: garbage');
  s = await status('in_progress', {}, 'pending -> in_progress');
  s = await status('done', { completedAt: ymd(new Date()) }, 'in_progress -> done (keep remaining)');
  if (s) {
    check(s.service.completedAt && s.service.remainingCount === 3, 'done keeps 3 remaining', 'PATCH status', short([s.service.completedAt, s.service.remainingCount]));
    checkEq(s.vehicle.openServicesCount, 0, 'vehicle openServicesCount 0 after done', 'PATCH status');
    checkEq(s.vehicle.openItemsCount, 4, 'vehicle openItemsCount still 4', 'PATCH status');
  }
  await illegal('pending', 'illegal: done -> pending');
  s = await status('in_progress', { note: 'ביטול פעולה' }, 'done -> in_progress (reopen)');
  if (s) check(s.service.completedAt == null && s.service.startedAt, 'reopen clears completedAt', 'PATCH status', short(s.service.completedAt));
  s = await status('done', { markAllDone: true }, 'in_progress -> done (markAllDone)');
  if (s) {
    check(s.service.remainingCount === 0 && s.service.itemsDoneCount === 5, 'markAllDone: all 5 done', 'PATCH status', short([s.service.remainingCount, s.service.itemsDoneCount]));
    check(near(s.service.totalPrice, 280 + 100 + 120 + 180), 'totals include newly done items (680)', 'PATCH status', short(s.service.totalPrice));
    checkEq(s.vehicle.openItemsCount, 1, 'vehicle openItemsCount 1 (only the uncarried annual item)', 'PATCH status');
  }
  s = await status('cancelled', { cancelReason: 'בדיקת ביטול' }, 'done -> cancelled (with payments)');
  if (s) {
    check(near(s.service.totalPrice, 0) && near(s.service.balance, -100) && s.service.cancelledAt && s.service.cancelReason === 'בדיקת ביטול', 'cancelled: totals 0, cancelledAt, reason', 'PATCH status', short([s.service.totalPrice, s.service.balance, s.service.cancelReason]));
    checkEq(s.vehicle.servicesCount, 3, 'cancelled excluded from servicesCount', 'PATCH status');
    checkEq(s.vehicle.openItemsCount, 3, 'un-carry: source items remaining again (3)', 'PATCH status');
  }
  const srcAfterCancel = await get(`/services/${ctx.corollaAnnualId}`);
  const sac = expectOk(srcAfterCancel, 'source after cancel');
  if (sac) check(sac.service.remainingCount === 3 && sac.service.items.every((i) => !i.carriedTo?.service), 'source un-carried', srcAfterCancel.endpoint, short(sac.service.remainingCount));
  await illegal('in_progress', 'illegal: cancelled -> in_progress');
  await illegal('done', 'illegal: cancelled -> done');
  const itemOnCancelled = await post(`/services/${id}/items`, { title: 'x' });
  expectError(itemOnCancelled, 'cancelled refuses item add', 400, MSG.cancelled);
  const payOnCancelled = await post(`/services/${id}/payments`, { amount: 10 });
  expectError(payOnCancelled, 'cancelled refuses payment add', 400, MSG.cancelled);
  const toggleOnCancelled = await patch(`/services/${id}/items/${ctx.workService.items[0]._id}/toggle`);
  expectError(toggleOnCancelled, 'cancelled refuses toggle', 400, MSG.cancelled);
  const carryOnCancelled = await post(`/services/${id}/carry`, { items: [{ serviceId: ctx.corollaAnnualId, itemId: ctx.corollaOpenItems[0].itemId }] });
  expectError(carryOnCancelled, 'cancelled refuses carry', 400, MSG.cancelled);
  s = await status('pending', {}, 'cancelled -> pending (restore)');
  if (s) {
    // the copies were marked done by markAllDone, so the sources are NOT re-carried (still undone but the copy is done)
    check(s.service.cancelledAt == null && near(s.service.totalPrice, 680), 'restore recomputes totals', 'PATCH status', short([s.service.cancelledAt, s.service.totalPrice]));
    checkEq(s.vehicle.servicesCount, 4, 'restored counted again', 'PATCH status');
  }
  const srcAfterRestore = await get(`/services/${ctx.corollaAnnualId}`);
  const sar = expectOk(srcAfterRestore, 'source after restore');
  if (sar) {
    const reCarried = sar.service.items.filter((i) => i.carriedTo?.service);
    checkEq(reCarried.length, 2, 're-carry links the 2 origins again', srcAfterRestore.endpoint);
  }
  s = await status('cancelled', {}, 'pending -> cancelled');
  s = await status('pending', {}, 'cancelled -> pending again');
  s = await status('done', {}, 'pending -> done');
  await illegal('pending', 'illegal: done -> pending (again)');
  ctx.workService = s?.service || ctx.workService;
}

async function testItems(ctx) {
  const id = ctx.pendingService._id; // pending inspection on 5678901 with 1 todo item
  const add = await post(`/services/${id}/items`, { title: 'בדיקה לפני טסט', price: 150 });
  const a = expectOk(add, 'add single item', 201);
  if (a) {
    check(a.items.length === 2 && a.items[1].done === true && a.items[1].doneAt, 'single add defaults done true with doneAt', add.endpoint, short(a.items[1]));
    check(near(a.totalPrice, 150), 'totals updated', add.endpoint, short(a.totalPrice));
  }
  const bulk = await post(`/services/${id}/items`, { items: [{ title: 'איזון גלגלים', price: 120, done: false }, { title: 'מגבים', qty: 2, price: 160, notes: 'זוג' }] });
  const b = expectOk(bulk, 'add bulk items', 201);
  if (b) {
    checkEq(b.items.length, 4, 'bulk added 2', bulk.endpoint);
    check(b.items[3].parts?.[0]?.qty === 2 && b.items[3].notes === 'זוג' && b.items[3].done === true, 'bulk item part qty/notes', bulk.endpoint, short(b.items[3]));
    check(b.items[2].work && b.items[2].work.title === 'איזון גלגלים' && b.items[2].parts.length === 0 && b.items[2].total === 120, 'bare action title becomes work-only', bulk.endpoint, short(b.items[2]));
    checkEq(b.remainingCount, 2, 'remaining 2', bulk.endpoint);
    check(b.items.every((it, i) => it.order === i), 'order defaults to index', bulk.endpoint, short(b.items.map((i) => i.order)));
  }
  const badItem = await post(`/services/${id}/items`, { items: [{ title: '' }] });
  expectError(badItem, 'add item without title -> 400', 400, 'שם הפריט הוא שדה חובה');
  const badQty = await post(`/services/${id}/items`, { title: 'x', qty: 0 });
  expectError(badQty, 'add item qty 0 -> 400', 400);
  const items = b?.items || a?.items;
  const todoItem = items.find((i) => i.title === 'איזון גלגלים');
  const upd = await put(`/services/${id}/items/${todoItem._id}`, { title: 'איזון גלגלים קדמיים', price: 130, notes: 'הערה', done: true, qty: 1, carriedTo: { service: id } });
  const u = expectOk(upd, 'update item');
  if (u) {
    const it = u.items.find((i) => String(i._id) === String(todoItem._id));
    check(it.title === 'איזון גלגלים קדמיים' && it.work?.title === 'איזון גלגלים קדמיים' && it.price === 130 && it.notes === 'הערה' && it.done === true && it.doneAt, 'item fields updated (rename follows the work)', upd.endpoint, short(it));
    const structured = await put(`/services/${id}/items/${todoItem._id}`, { work: { title: 'איזון גלגלים', price: 100 }, parts: [{ title: 'משקולות', qty: 4, price: 5 }], price: null });
    const st = expectOk(structured, 'update work + parts');
    if (st) {
      const it2 = st.items.find((i) => String(i._id) === String(todoItem._id));
      check(it2.title === 'איזון גלגלים' && it2.parts.length === 1 && it2.parts[0].qty === 4 && it2.total === 120 && it2.priced === true, 'task total = labor + qty x unit (120)', structured.endpoint, short(it2));
    }
    const back = await put(`/services/${id}/items/${todoItem._id}`, { parts: [], price: 130 });
    expectOk(back, 'restore record price 130');
    check(!it.carriedTo?.service, 'carriedTo not writable via update', upd.endpoint, short(it.carriedTo));
    check(near(u.totalPrice, 150 + 130 + 160), 'totals after item update (440)', upd.endpoint, short(u.totalPrice));
  }
  const tg = await patch(`/services/${id}/items/${todoItem._id}/toggle`);
  const t = expectOk(tg, 'toggle item');
  if (t) {
    const it = t.items.find((i) => String(i._id) === String(todoItem._id));
    check(it.done === false && it.doneAt == null, 'toggle -> undone clears doneAt', tg.endpoint, short(it));
    check(near(t.totalPrice, 310) && near(t.remainingQuote, 130), 'toggle updates totals and quote', tg.endpoint, short([t.totalPrice, t.remainingQuote]));
  }
  const tg2 = await patch(`/services/${id}/items/${todoItem._id}/toggle`);
  const t2 = expectOk(tg2, 'toggle item back');
  if (t2) check(t2.items.find((i) => String(i._id) === String(todoItem._id)).done === true, 'toggle -> done', tg2.endpoint);
  const missingItem = await patch(`/services/${id}/items/000000000000000000000000/toggle`);
  expectError(missingItem, 'toggle unknown item -> 404', 404);

  // reorder (route must beat /items/:itemId)
  const ids = t2.items.map((i) => String(i._id));
  const reversed = [...ids].reverse();
  const ro = await put(`/services/${id}/items/reorder`, { order: reversed });
  const r = expectOk(ro, 'reorder');
  if (r) {
    const byOrder = [...r.items].sort((x, y) => x.order - y.order).map((i) => String(i._id));
    checkEq(byOrder.join(','), reversed.join(','), 'order applied', ro.endpoint);
  }
  const partial = await put(`/services/${id}/items/reorder`, { order: [ids[0]] });
  const p = expectOk(partial, 'reorder partial list');
  if (p) check(p.items.find((i) => String(i._id) === ids[0]).order === 0, 'listed item first, rest follow', partial.endpoint, short(p.items.map((i) => [i.title, i.order])));
  const badOrder = await put(`/services/${id}/items/reorder`, { order: ['000000000000000000000000'] });
  expectError(badOrder, 'reorder unknown id -> 400', 400);
  const badOrder2 = await put(`/services/${id}/items/reorder`, { order: 'x' });
  expectError(badOrder2, 'reorder non-array -> 400', 400);

  // delete item (undo shape)
  const wipers = p.items.find((i) => i.title === 'מגבים');
  const dl = await del(`/services/${id}/items/${wipers._id}`);
  const d = expectOk(dl, 'delete item');
  if (d) {
    checkShape(d, ['service', 'removedItem'], 'delete item shape', dl.endpoint);
    check(d.removedItem.title === 'מגבים' && d.removedItem.parts?.[0]?.qty === 2, 'removedItem returned', dl.endpoint, short(d.removedItem));
    checkEq(d.service.items.length, 3, 'item removed', dl.endpoint);
  }
  const dlMissing = await del(`/services/${id}/items/${wipers._id}`);
  expectError(dlMissing, 'delete missing item -> 404', 404);

  // carriedTo guard: the corolla annual has 2 items carried into the work service
  const src = await get(`/services/${ctx.corollaAnnualId}`);
  const sd = expectOk(src, 'source annual for carriedTo guard');
  const carriedSrc = sd?.service.items.find((i) => i.carriedTo?.service);
  check(carriedSrc, 'a carried source item exists', src.endpoint);
  if (carriedSrc) {
    const guard = await del(`/services/${ctx.corollaAnnualId}/items/${carriedSrc._id}`);
    expectError(guard, 'delete carried source item -> 400', 400, MSG.carriedForward);
  }

  // carry endpoint: from another vehicle -> 400; same vehicle ok; delete carried copy un-carries
  const otherVehicleItem = ctx.corollaOpenItems.find((it) => !ctx.workService.items.some((w) => String(w.carriedFrom?.item) === String(it.itemId)));
  const wrong = await post(`/services/${id}/carry`, { items: [{ serviceId: otherVehicleItem.serviceId, itemId: otherVehicleItem.itemId }] });
  expectError(wrong, 'carry from another vehicle -> 400', 400, MSG.carryOtherVehicle);
  const noItems = await post(`/services/${id}/carry`, { items: [] });
  expectError(noItems, 'carry with no items -> 400', 400);
  const selfCarry = await post(`/services/${id}/carry`, { items: [{ serviceId: id, itemId: ids[0] }] });
  expectError(selfCarry, 'carry from itself -> 400', 400);
  // same vehicle: open a new service on 2722002 and carry the last remaining annual item
  const target = await post('/services', { plateNumber: '2722002', notes: 'יעד להעברה' });
  const tg3 = expectOk(target, 'create target service (notes only)', 201);
  ctx.extraServices += 1;
  if (tg3) {
    const carryRes = await post(`/services/${tg3.service._id}/carry`, { items: [{ serviceId: otherVehicleItem.serviceId, itemId: otherVehicleItem.itemId }] });
    const cr = expectOk(carryRes, 'carry same vehicle');
    if (cr) {
      check(cr.items.length === 1 && cr.items[0].title === otherVehicleItem.title && String(cr.items[0].carriedFrom.item) === String(otherVehicleItem.itemId), 'copy created with carriedFrom', carryRes.endpoint, short(cr.items));
      const again = await post(`/services/${tg3.service._id}/carry`, { items: [{ serviceId: otherVehicleItem.serviceId, itemId: otherVehicleItem.itemId }] });
      expectError(again, 'carry twice -> 400', 400, MSG.carryUsed);
      const copyDel = await del(`/services/${tg3.service._id}/items/${cr.items[0]._id}`);
      const cd = expectOk(copyDel, 'delete carried copy');
      if (cd) {
        const srcAgain = await get(`/services/${otherVehicleItem.serviceId}`);
        const sa = expectOk(srcAgain, 'source after copy delete');
        if (sa) {
          const orig = sa.service.items.find((i) => String(i._id) === String(otherVehicleItem.itemId));
          check(orig && !orig.carriedTo?.service, 'origin un-carried after copy delete', srcAgain.endpoint, short(orig?.carriedTo));
        }
      }
    }
    ctx.targetService = tg3.service;
  }
}

async function testPayments(ctx) {
  // items mode; after the item tests: done items 150 + 130 (the 160 wipers were deleted) = 280
  const id = ctx.pendingService._id;
  const before = await get(`/services/${id}`);
  const bd = expectOk(before, 'service before payments');
  if (bd) check(near(bd.service.totalPrice, 280) && bd.service.totalMode === 'items', 'total 280 in items mode', before.endpoint, short(bd.service.totalPrice));
  const zero = await post(`/services/${id}/payments`, { amount: 0 });
  expectError(zero, 'payment amount 0 -> 400', 400, MSG.amountPositive);
  const neg = await post(`/services/${id}/payments`, { amount: -5 });
  expectError(neg, 'payment negative -> 400', 400, MSG.amountPositive);
  const noAmount = await post(`/services/${id}/payments`, {});
  expectError(noAmount, 'payment missing amount -> 400', 400, MSG.amountPositive);
  const future = await post(`/services/${id}/payments`, { amount: 10, paidAt: ymd(new Date(Date.now() + 5 * 86400000)) });
  expectError(future, 'payment far future -> 400', 400, 'תאריך התשלום לא יכול להיות בעתיד');
  const badMethod = await post(`/services/${id}/payments`, { amount: 10, method: 'gold' });
  expectError(badMethod, 'payment bad method -> 400', 400);

  const p1 = await post(`/services/${id}/payments`, { amount: 100, method: 'cash', note: 'ראשון' });
  const d1 = expectOk(p1, 'add payment', 201);
  if (d1) check(near(d1.paidAmount, 100) && near(d1.balance, 180) && d1.paymentStatus === 'partial', 'partial after 100 (balance 180)', p1.endpoint, short([d1.paidAmount, d1.balance, d1.paymentStatus]));
  const p2 = await post(`/services/${id}/payments`, { amount: 300, method: 'credit', paidAt: ymd(new Date()) });
  const d2 = expectOk(p2, 'add overpayment (allowed)', 201);
  if (d2) check(near(d2.paidAmount, 400) && near(d2.balance, -120) && d2.paymentStatus === 'paid', 'overpaid -> balance -120 paid', p2.endpoint, short([d2.paidAmount, d2.balance, d2.paymentStatus]));
  const pay = d2?.payments?.find((p) => p.amount === 300);
  const up = await put(`/services/${id}/payments/${pay?._id}`, { amount: 180, method: 'bit', note: 'תוקן' });
  const ud = expectOk(up, 'update payment');
  if (ud) {
    const p = ud.payments.find((x) => String(x._id) === String(pay._id));
    check(p.amount === 180 && p.method === 'bit' && p.note === 'תוקן', 'payment fields updated', up.endpoint, short(p));
    check(near(ud.balance, 0) && ud.paymentStatus === 'paid', 'balance 0 paid', up.endpoint, short([ud.balance, ud.paymentStatus]));
  }
  const upZero = await put(`/services/${id}/payments/${pay?._id}`, { amount: 0 });
  expectError(upZero, 'update payment amount 0 -> 400', 400, MSG.amountPositive);
  const missingPay = await put(`/services/${id}/payments/000000000000000000000000`, { amount: 5 });
  expectError(missingPay, 'update unknown payment -> 404', 404);

  const dl = await del(`/services/${id}/payments/${pay?._id}`);
  const dd = expectOk(dl, 'delete payment');
  if (dd) {
    checkShape(dd, ['service', 'removedPayment'], 'delete payment shape', dl.endpoint);
    check(dd.removedPayment.amount === 180, 'removedPayment returned', dl.endpoint, short(dd.removedPayment));
    check(near(dd.service.balance, 180) && dd.service.paymentStatus === 'partial', 'back to partial', dl.endpoint, short([dd.service.balance, dd.service.paymentStatus]));
  }
  // re-POST the removed payment (client undo)
  const undo = await post(`/services/${id}/payments`, { amount: dd?.removedPayment.amount, method: dd?.removedPayment.method, paidAt: dd?.removedPayment.paidAt, note: dd?.removedPayment.note });
  const un = expectOk(undo, 're-add removed payment (undo)', 201);
  if (un) check(near(un.balance, 0), 'undo restores balance 0', undo.endpoint, short(un.balance));

  // total-0 guard: the notes-only target service (no priced done items) refuses payments in items mode
  const guard = await post(`/services/${ctx.targetService._id}/payments`, { amount: 50 });
  expectError(guard, 'payment when total 0 -> 400', 400, MSG.priceBeforePayment);
  const toManual = await put(`/services/${ctx.targetService._id}`, { totalMode: 'manual', manualTotal: 50 });
  expectOk(toManual, 'switch target to manual 50');
  const manualPay = await post(`/services/${ctx.targetService._id}/payments`, { amount: 50 });
  const mp = expectOk(manualPay, 'payment allowed in manual mode', 201);
  if (mp) check(near(mp.balance, 0) && mp.paymentStatus === 'paid', 'manual 50 paid', manualPay.endpoint, short([mp.balance, mp.paymentStatus]));

  // cancelled service: payment delete allowed
  const cancel = await patch(`/services/${ctx.targetService._id}/status`, { status: 'cancelled' });
  const cd = expectOk(cancel, 'cancel target (with payment)');
  if (cd) {
    check(near(cd.service.totalPrice, 0) && near(cd.service.balance, -50), 'cancelled with payment -> balance -50', cancel.endpoint, short([cd.service.totalPrice, cd.service.balance]));
    const upCancelled = await put(`/services/${ctx.targetService._id}/payments/${cd.service.payments[0]._id}`, { amount: 20 });
    expectError(upCancelled, 'cancelled refuses payment update', 400, MSG.cancelled);
    const delCancelled = await del(`/services/${ctx.targetService._id}/payments/${cd.service.payments[0]._id}`);
    const dc = expectOk(delCancelled, 'cancelled allows payment delete');
    if (dc) check(dc.service.payments.length === 0 && near(dc.service.balance, 0), 'payment removed from cancelled', delCancelled.endpoint, short(dc.service.balance));
  }

  // dashboard collectedThisMonth reflects payments made today
  const dash = await get('/dashboard');
  const dsh = expectOk(dash, 'dashboard after payments');
  if (dsh) check(dsh.kpis.collectedThisMonth >= 100 + 180, 'collectedThisMonth includes new payments', dash.endpoint, short(dsh.kpis.collectedThisMonth));
}

async function testServiceDelete(ctx) {
  // a service with payments is deleted together with them (cascade rule since 2026-09-08)
  const withPayments = await del(`/services/${ctx.pendingService._id}`);
  const wp = expectOk(withPayments, 'delete service with payments');
  if (wp) {
    check(wp.deleted === true && wp.payments >= 1, 'payments deleted along with the service', withPayments.endpoint, short(wp));
    ctx.extraServices -= 1;
    expectError(await get(`/services/${ctx.pendingService._id}`), 'deleted paid service -> 404', 404, 'הטיפול לא נמצא');
  }
  // delete without payments: the dup-new service on 9988877
  const ok = await del(`/services/${ctx.dupNewService._id}`);
  const d = expectOk(ok, 'delete service without payments');
  if (d) {
    checkShape(d, ['deleted', 'payments', 'vehicle'], 'delete shape', ok.endpoint);
    checkEq(d.payments, 0, 'no payments deleted', ok.endpoint);
    check(d.deleted === true && d.vehicle && d.vehicle.servicesCount === 1, 'vehicle recomputed after delete', ok.endpoint, short(d.vehicle?.servicesCount));
    ctx.extraServices -= 1;
  }
  const gone = await get(`/services/${ctx.dupNewService._id}`);
  expectError(gone, 'deleted service -> 404', 404, 'הטיפול לא נמצא');
  // deleting a service holding carried copies un-carries the sources
  const work = await get(`/services/${ctx.workService._id}`);
  const wd = expectOk(work, 'work service before delete');
  if (wd && wd.service.payments.length) {
    for (const p of wd.service.payments) {
      const r = await del(`/services/${ctx.workService._id}/payments/${p._id}`);
      expectOk(r, 'remove payment before delete');
    }
  }
  const delWork = await del(`/services/${ctx.workService._id}`);
  const dw = expectOk(delWork, 'delete service holding carried copies');
  if (dw) {
    ctx.extraServices -= 1;
    const src = await get(`/services/${ctx.corollaAnnualId}`);
    const sd = expectOk(src, 'source after holder delete');
    if (sd) check(sd.service.remainingCount === 3 && sd.service.items.every((i) => !i.carriedTo?.service), 'sources un-carried by delete', src.endpoint, short(sd.service.remainingCount));
    checkEq(dw.vehicle.openItemsCount, 3, 'vehicle openItemsCount back to 3', delWork.endpoint);
  }
  // full cleanup for the customer delete path: delete the target (cancelled, no payments), then the smoke vehicle's services, vehicle and customers
  const delTarget = await del(`/services/${ctx.targetService._id}`);
  if (expectOk(delTarget, 'delete cancelled target service')) ctx.extraServices -= 1;
}

async function testTemplates(ctx) {
  const list = await get('/templates');
  const l = expectOk(list, 'list');
  if (l) {
    checkShape(l, ['templates', 'recent', 'works', 'parts'], 'list shape', list.endpoint);
    check(l.templates.length >= 29 && l.templates.every((t) => t.active), 'active catalog (29+)', list.endpoint, short(l.templates.length));
    checkShape(l.templates[0], TEMPLATE_KEYS, 'Template shape', list.endpoint);
    check(l.recent.length <= 8, 'recent max 8', list.endpoint);
    const cleaning = l.templates.find((t) => t.title === 'ניקוי תחתית הרכב');
    check(cleaning && cleaning.work?.title === 'ניקוי תחתית הרכב' && cleaning.parts.length === 0 && cleaning.category === 'cleaning', 'work-only task (ניקוי תחתית)', list.endpoint, short(cleaning));
    const oilFilter = l.templates.find((t) => t.title === 'מסנן שמן מקורי');
    check(oilFilter && !oilFilter.work && oilFilter.parts.length === 1 && oilFilter.parts[0].title === 'מסנן שמן מקורי' && oilFilter.parts[0].qty === 1, 'part-only task (מסנן שמן)', list.endpoint, short(oilFilter));
    const combo = l.templates.find((t) => t.title === 'החלפת שמן ומסנן');
    check(combo && combo.work && combo.parts.length === 2 && combo.parts.some((p) => p.title === 'שמן מנוע 5w30'), 'combined task (work + 2 parts)', list.endpoint, short(combo));
    check(l.parts.some((p) => p.title === 'שמן מנוע 5w30') && l.works.some((w) => w.title === 'כיוון פרונט'), 'works / parts indexes', list.endpoint, short([l.works.length, l.parts.length]));
  }
  const byCat = await get('/templates?category=oil');
  const bc = expectOk(byCat, 'list category=oil');
  if (bc) check(bc.templates.length === 4 && bc.templates.every((t) => t.category === 'oil'), '4 oil templates', byCat.endpoint, short(bc.templates.map((t) => t.title)));
  const badCat = await get('/templates?category=bogus');
  expectError(badCat, 'bad category -> 400', 400);
  const byQ = await get('/templates?q=' + encodeURIComponent('מסנן'));
  const bq = expectOk(byQ, 'list q');
  if (bq) {
    check(
      bq.templates.length === 7 && bq.templates.every((t) => /מסנן/.test(t.title) || t.parts.some((p) => /מסנן/.test(p.title))),
      'q=מסנן -> 7 (title or part)',
      byQ.endpoint,
      short(bq.templates.map((t) => t.title))
    );
  }
  const byUsage = await get('/templates?sortBy=usage');
  const bu = expectOk(byUsage, 'list sortBy usage');
  if (bu) check(bu.templates[0].usageCount >= bu.templates[1].usageCount, 'usage desc', byUsage.endpoint);
  const byTitle = await get('/templates?sortBy=title');
  expectOk(byTitle, 'list sortBy title');

  const noTitle = await post('/templates', { category: 'oil' });
  expectError(noTitle, 'create without title -> 400', 400, 'שם הפריט הוא שדה חובה');
  const created = await post('/templates', { title: '  פריט סמוק  ', category: 'general', price: 99, order: 5 });
  const c = expectOk(created, 'create part-only from a bare title', 201);
  if (c) {
    check(
      c.title === 'פריט סמוק' && c.titleKey === 'פריט סמוק' && !c.work && c.parts.length === 1 && c.parts[0].title === 'פריט סמוק' && c.price === 99 && c.total === 99 && c.order === 5,
      'template fields',
      created.endpoint,
      short(c)
    );
    ctx.template = c;
  }
  const dup = await post('/templates', { title: 'פריט   סמוק' });
  expectError(dup, 'duplicate title (whitespace collapsed) -> 400', 400, MSG.templateDuplicate);
  const dup2 = await post('/templates', { title: 'מסנן שמן מקורי' });
  expectError(dup2, 'duplicate seeded title -> 400', 400, MSG.templateDuplicate);
  const combo = await post('/templates', { work: { title: 'החלפת סמוק', price: 100 }, parts: [{ title: 'חלק סמוק', qty: 2, price: 25 }, { title: 'חלק סמוק 2' }], category: 'engine' });
  const cb = expectOk(combo, 'create work + parts', 201);
  if (cb) check(cb.title === 'החלפת סמוק' && cb.work.price === 100 && cb.parts.length === 2 && cb.total === 150 && cb.priced === true, 'combined total = labor + qty x unit (150)', combo.endpoint, short(cb));
  const badPart = await post('/templates', { work: { title: 'x' }, parts: [{ qty: 2 }] });
  expectError(badPart, 'part without title -> 400', 400, 'שם החלק הוא שדה חובה');
  const workOnly = await post('/templates', { title: 'בדיקת סמוק', type: 'work', price: 80 });
  const wo = expectOk(workOnly, 'create work-only by type', 201);
  if (wo) check(wo.work?.title === 'בדיקת סמוק' && wo.parts.length === 0 && wo.total === 80, 'work-only fields', workOnly.endpoint, short(wo));

  const upd = await put(`/templates/${c?._id}`, { title: 'פריט סמוק 2', category: 'tires', price: 120, active: false, order: 1, usageCount: 99 });
  const u = expectOk(upd, 'update');
  if (u) {
    check(
      u.title === 'פריט סמוק 2' && u.parts[0].title === 'פריט סמוק 2' && u.category === 'tires' && u.price === 120 && u.active === false && u.order === 1 && u.usageCount === 0,
      'update whitelist (rename follows the part, usageCount ignored)',
      upd.endpoint,
      short(u)
    );
  }
  const updParts = await put(`/templates/${cb?._id}`, { parts: [{ title: 'חלק סמוק', qty: 3, price: 10 }], price: null });
  const up = expectOk(updParts, 'update parts');
  if (up) check(up.parts.length === 1 && up.parts[0].qty === 3 && up.total === 130, 'parts replaced, total = 100 + 3 x 10', updParts.endpoint, short(up));
  const updDup = await put(`/templates/${c?._id}`, { title: 'מגבים' });
  expectError(updDup, 'update to existing title -> 400', 400, MSG.templateDuplicate);
  const hidden = await get('/templates?q=' + encodeURIComponent('פריט סמוק'));
  const h = expectOk(hidden, 'inactive hidden by default');
  if (h) checkEq(h.templates.length, 0, 'inactive not listed', hidden.endpoint);
  const all = await get('/templates?active=all&q=' + encodeURIComponent('פריט סמוק'));
  const al = expectOk(all, 'active=all shows inactive');
  if (al) checkEq(al.templates.length, 1, 'inactive listed with active=all', all.endpoint);
  const hard = await del(`/templates/${c?._id}`);
  const hd = expectOk(hard, 'delete unused (hard)');
  if (hd) check(hd.deleted === true && hd.deactivated === false, 'hard deleted', hard.endpoint, short(hd));
  for (const tplId of [cb?._id, wo?._id]) expectOk(await del(`/templates/${tplId}`), 'delete smoke template');
  const gone = await get(`/templates?active=all&q=` + encodeURIComponent('סמוק'));
  const g = expectOk(gone, 'after hard delete');
  if (g) checkEq(g.templates.length, 0, 'templates gone', gone.endpoint);
  const used = (await get('/templates?sortBy=usage')).body?.data?.templates?.[0];
  const soft = await del(`/templates/${used?._id}`);
  const sd = expectOk(soft, 'delete used (soft)');
  if (sd) check(sd.deleted === false && sd.deactivated === true, 'soft deleted', soft.endpoint, short(sd));
  const restore = await put(`/templates/${used?._id}`, { active: true });
  const rs = expectOk(restore, 'restore soft deleted');
  if (rs) checkEq(rs.active, true, 'restored', restore.endpoint);
  const missing = await del('/templates/000000000000000000000000');
  expectError(missing, 'delete unknown -> 404', 404);
}

async function testBundles(ctx) {
  const list = await get('/bundles');
  const l = expectOk(list, 'list');
  if (l) {
    checkShape(l, ['bundles'], 'list shape', list.endpoint);
    check(l.bundles.length >= 3 && l.bundles.every((b) => b.active), 'seeded active bundles (3+)', list.endpoint, short(l.bundles.length));
    checkShape(l.bundles[0], ['_id', 'title', 'titleKey', 'description', 'kind', 'items', 'itemsCount', 'usageCount', 'lastUsedAt', 'active', 'order'], 'Bundle shape', list.endpoint);
    const annual = l.bundles.find((b) => b.title === 'טיפול שנתי');
    // Shlomi's standard annual list (2026-09-23): four lines, every visit tagged שנתי opens with them
    check(annual && annual.kind === 'annual' && annual.items.length === 4 && annual.itemsCount === 4, 'seeded annual bundle (4 lines, kind annual)', list.endpoint, short(annual));
    if (annual) {
      checkShape(annual.items[0], BUNDLE_LINE_KEYS, 'BundleLine shape', list.endpoint);
      check(JSON.stringify(annual.items.map((i) => i.title)) === JSON.stringify(['שמן מנוע', 'מסנן שמן מנוע', 'מסנן אוויר', 'מסנן מזגן']), 'the standard lines in order', list.endpoint, short(annual.items.map((i) => i.title)));
      const linked = annual.items.filter((i) => i.template);
      check(linked.every((i) => i.templateActive === true), 'lines that match a catalog item are linked to an active one', list.endpoint, short(annual.items.map((i) => i.template)));
      const oilLine = annual.items.find((i) => i.title === 'שמן מנוע');
      check(oilLine && !oilLine.work && oilLine.parts.length === 1 && oilLine.parts[0].title === 'שמן מנוע', 'the oil line is a bare part (the oil type is chosen on the visit)', list.endpoint, short(oilLine));
    }
  }
  const byQ = await get('/bundles?q=' + encodeURIComponent('בלמים'));
  const bq = expectOk(byQ, 'list q');
  if (bq) check(bq.bundles.length === 1 && bq.bundles[0].title === 'בלמים קדמיים', 'q=בלמים -> 1', byQ.endpoint, short(bq.bundles.map((b) => b.title)));

  const noTitle = await post('/bundles', { items: [{ title: 'x' }] });
  expectError(noTitle, 'create without title -> 400', 400, MSG.bundleTitle);
  const noItems = await post('/bundles', { title: 'חבילה ריקה' });
  expectError(noItems, 'create without items -> 400', 400, MSG.bundleNoItems);
  const badKind = await post('/bundles', { title: 'חבילה', kind: 'bogus', items: [{ title: 'x' }] });
  expectError(badKind, 'bad kind -> 400', 400, 'סוג טיפול לא חוקי');
  const badLine = await post('/bundles', { title: 'חבילה', items: [{ qty: 2 }] });
  expectError(badLine, 'line without title or template -> 400', 400, 'שם הפריט הוא שדה חובה');

  // a used bundle is only soft deleted, so titles carry a per-run suffix to keep re-runs independent
  const RUN = Date.now().toString(36).slice(-5);
  const bundleName = `חבילת סמוק ${RUN}`;
  const oil = (await get('/templates?q=' + encodeURIComponent('שמן מנוע 5w40'))).body?.data?.templates?.[0];
  const created = await post('/bundles', {
    title: `  ${bundleName}  `,
    kind: 'repair',
    description: 'תיאור',
    items: [
      { template: oil?._id, qty: 2 },
      { title: 'פריט חופשי', done: false, price: 50 },
      { template: '000000000000000000000000', title: 'תבנית שנמחקה' },
    ],
  });
  const c = expectOk(created, 'create', 201);
  if (c) {
    check(c.title === bundleName && c.titleKey === bundleName && c.kind === 'repair' && c.description === 'תיאור' && c.items.length === 3, 'bundle fields', created.endpoint, short(c));
    const first = c.items[0];
    check(first && first.title === 'שמן מנוע 5w40' && String(first.template) === String(oil?._id) && first.parts?.[0]?.qty === 2, 'line copies the catalog task, qty applied to its part', created.endpoint, short(first));
    check(first && first.total === oil?.total, 'line total follows the catalog price', created.endpoint, short([first?.total, oil?.total]));
    const second = c.items[1];
    check(second && second.template === null && second.parts?.[0]?.title === 'פריט חופשי' && second.price === 50 && second.total === 50, 'free line keeps its record price', created.endpoint, short(second));
    const third = c.items[2];
    check(third && third.template === null && third.title === 'תבנית שנמחקה', 'unknown template ref dropped, title kept', created.endpoint, short(third));
    const structured = await post('/bundles', { title: 'חבילה מובנית', items: [{ work: { title: 'החלפת בלמים', price: 200 }, parts: [{ title: 'רפידות', qty: 1, price: 150 }] }] });
    const sb = expectOk(structured, 'create with structured line', 201);
    if (sb) {
      check(sb.items[0].title === 'החלפת בלמים' && sb.items[0].total === 350, 'structured line total 350', structured.endpoint, short(sb.items[0]));
      expectOk(await del(`/bundles/${sb._id}`), 'delete structured bundle');
    }
    ctx.bundle = c;
  }
  const dup = await post('/bundles', { title: `חבילת   סמוק   ${RUN}`, items: [{ title: 'x' }] });
  expectError(dup, 'duplicate title (whitespace collapsed) -> 400', 400, MSG.bundleDuplicate);
  const dupSeed = await post('/bundles', { title: 'טיפול שנתי', items: [{ title: 'x' }] });
  expectError(dupSeed, 'duplicate seeded title -> 400', 400, MSG.bundleDuplicate);

  const renamed = `${bundleName} 2`;
  const upd = await put(`/bundles/${c?._id}`, { title: renamed, kind: null, active: false, order: 3, usageCount: 99, items: [{ title: 'רק אחד' }] });
  const u = expectOk(upd, 'update');
  if (u) {
    check(
      u.title === renamed && u.kind === null && u.active === false && u.order === 3 && u.usageCount === 0 && u.items.length === 1 && u.items[0].title === 'רק אחד',
      'update whitelist (usageCount ignored, items replaced)',
      upd.endpoint,
      short(u)
    );
  }
  const updEmpty = await put(`/bundles/${c?._id}`, { items: [] });
  expectError(updEmpty, 'update to no items -> 400', 400, MSG.bundleNoItems);
  const updDup = await put(`/bundles/${c?._id}`, { title: 'בלמים קדמיים' });
  expectError(updDup, 'update to existing title -> 400', 400, MSG.bundleDuplicate);
  const hidden = await get('/bundles?q=' + encodeURIComponent(bundleName));
  const h = expectOk(hidden, 'inactive hidden by default');
  if (h) checkEq(h.bundles.length, 0, 'inactive not listed', hidden.endpoint);
  const all = await get('/bundles?active=all&q=' + encodeURIComponent(bundleName));
  const al = expectOk(all, 'active=all shows inactive');
  if (al) checkEq(al.bundles.length, 1, 'inactive listed with active=all', all.endpoint);

  // usage bump: a service created with `bundles`, then items added with `bundles`
  const restore = await put(`/bundles/${c?._id}`, { active: true });
  expectOk(restore, 'restore active');
  const svc = await post('/services', { vehicle: ctx.smokeVehicle._id, items: [{ title: 'רק אחד', done: true, price: 10 }], bundles: [c?._id, 'not-an-id', c?._id] });
  const s = expectOk(svc, 'create service with bundles', 201);
  if (s) {
    ctx.extraServices += 1;
    const more = await post(`/services/${s.service._id}/items`, { items: [{ title: 'עוד אחד' }], bundles: [c?._id] });
    expectOk(more, 'add items with bundles', 201);
    await sleep(400);
    const after = await get('/bundles?q=' + encodeURIComponent(bundleName));
    const af = expectOk(after, 'bundle after use');
    if (af) check(af.bundles[0]?.usageCount === 2 && af.bundles[0]?.lastUsedAt, 'usageCount bumped once per request (2)', after.endpoint, short(af.bundles[0]));
    const delSvc = await del(`/services/${s.service._id}`);
    if (expectOk(delSvc, 'delete the bundle test service')) ctx.extraServices -= 1;
  }
  const soft = await del(`/bundles/${c?._id}`);
  const sd = expectOk(soft, 'delete used (soft)');
  if (sd) check(sd.deleted === false && sd.deactivated === true, 'soft deleted', soft.endpoint, short(sd));
  const unused = await post('/bundles', { title: 'חבילה זמנית', items: [{ title: 'x' }] });
  const un = expectOk(unused, 'create unused', 201);
  const hard = await del(`/bundles/${un?._id}`);
  const hd = expectOk(hard, 'delete unused (hard)');
  if (hd) check(hd.deleted === true && hd.deactivated === false, 'hard deleted', hard.endpoint, short(hd));
  const gone = await get('/bundles?active=all&q=' + encodeURIComponent('חבילה זמנית'));
  const g = expectOk(gone, 'after hard delete');
  if (g) checkEq(g.bundles.length, 0, 'bundle gone', gone.endpoint);
  const missing = await del('/bundles/000000000000000000000000');
  expectError(missing, 'delete unknown -> 404', 404, MSG.bundleNotFound);
  const badId = await put('/bundles/nope', { title: 'x' });
  expectError(badId, 'bad id -> 404', 404, MSG.bundleNotFound);
  const noAuth = await call('GET', '/bundles', undefined, { auth: false });
  expectError(noAuth, 'list without token -> 401', 401);
}

/** GET /bootstrap: the whole working set in one answer (the client works on its own copy from then on). */
async function testBootstrap() {
  const res = await get('/bootstrap');
  const d = expectOk(res, 'bootstrap');
  if (d) {
    checkShape(d, ['customers', 'vehicles', 'services', 'templates', 'bundles', 'generatedAt'], 'bootstrap shape', res.endpoint);
    checkEq(d.customers.length, 6, '6 customers', res.endpoint);
    checkEq(d.vehicles.length, 8, '8 vehicles', res.endpoint);
    check(d.services.length >= 15 && d.services[0].items && d.services[0].payments && d.services[0].statusHistory, 'services carry items, payments and history', res.endpoint, short(d.services.length));
    check(d.templates.length >= 29 && d.bundles.length >= 3, 'catalog included', res.endpoint, short([d.templates.length, d.bundles.length]));
    check(typeof d.services[0].vehicle === 'string' && typeof d.services[0].customer === 'string', 'refs are plain ids (lean docs)', res.endpoint);
  }
  const noAuth = await call('GET', '/bootstrap', undefined, { auth: false });
  expectError(noAuth, 'bootstrap without token -> 401', 401);
}

/** Cascading deletes (spec 3.8): carry-chain repair, customer -> vehicles + services + payments, vehicle -> services. */
async function testCascadeDeletes() {
  const custRes = await post('/customers', { fullName: 'לקוח למחיקה מדורגת', phone: '0501112222' });
  const cust = expectOk(custRes, 'create cascade customer', 201);
  if (!cust) return;
  const vehRes = await post('/vehicles', { plateNumber: '7070707', make: 'טסט', model: 'מחיקה', customer: cust._id });
  const veh = expectOk(vehRes, 'create cascade vehicle', 201);
  if (!veh) return;
  const vid = veh.vehicle._id;

  // S1 (paid, one open item) -> S2 carries the open item -> S3 carries the copy on
  const s1Res = await post('/services', {
    vehicle: vid, kind: 'repair', status: 'in_progress',
    items: [{ title: 'פנס אחורי', price: 100 }, { title: 'לתקן מראה', done: false }],
    payment: { amount: 50 },
  });
  const s1 = expectOk(s1Res, 'create S1 (paid, one open item)', 201);
  const openItem = s1?.service.items.find((i) => !i.done);
  if (!openItem) return;
  const s2Res = await post('/services', { vehicle: vid, kind: 'repair', status: 'in_progress', carryItems: [{ serviceId: s1.service._id, itemId: openItem._id }], notes: 'אמצע השרשרת' });
  const s2 = expectOk(s2Res, 'create S2 carrying from S1', 201);
  const copy1 = s2?.service.items.find((i) => i.carriedFrom?.service);
  if (!copy1) return;
  const s3Res = await post('/services', { vehicle: vid, kind: 'repair', status: 'in_progress', carryItems: [{ serviceId: s2.service._id, itemId: copy1._id }], notes: 'סוף השרשרת' });
  const s3 = expectOk(s3Res, 'create S3 carrying from S2', 201);
  const copy2 = s3?.service.items.find((i) => i.carriedFrom?.service);
  if (!copy2) return;

  // deleting the middle service compresses the chain: S1's item points at S3's copy and back
  const dmRes = await del(`/services/${s2.service._id}`);
  if (expectOk(dmRes, 'delete the middle service of a carry chain')) {
    const a1Res = await get(`/services/${s1.service._id}`);
    const a1 = expectOk(a1Res, 'S1 after the middle delete');
    const orig = a1?.service.items.find((i) => String(i._id) === String(openItem._id));
    check(orig && String(orig.carriedTo?.service) === String(s3.service._id) && String(orig.carriedTo?.item) === String(copy2._id), 'origin re-pointed at the surviving copy', a1Res.endpoint, short(orig?.carriedTo));
    check(a1 && a1.service.remainingCount === 0, 'origin still counts as carried', a1Res.endpoint, short(a1?.service.remainingCount));
    const a3Res = await get(`/services/${s3.service._id}`);
    const a3 = expectOk(a3Res, 'S3 after the middle delete');
    const c2 = a3?.service.items.find((i) => String(i._id) === String(copy2._id));
    check(c2 && String(c2.carriedFrom?.service) === String(s1.service._id) && String(c2.carriedFrom?.item) === String(openItem._id), 'copy re-pointed at the origin', a3Res.endpoint, short(c2?.carriedFrom));
  }

  // deleting the last holder releases the origin: remaining again
  const dlRes = await del(`/services/${s3.service._id}`);
  const dl = expectOk(dlRes, 'delete the last holder');
  if (dl) {
    const a1Res = await get(`/services/${s1.service._id}`);
    const a1 = expectOk(a1Res, 'S1 after the holder delete');
    const orig = a1?.service.items.find((i) => String(i._id) === String(openItem._id));
    check(orig && !orig.carriedTo?.service && a1.service.remainingCount === 1, 'origin remaining again', a1Res.endpoint, short([orig?.carriedTo, a1?.service.remainingCount]));
    checkEq(dl.vehicle?.openItemsCount, 1, 'vehicle openItemsCount recomputed', dlRes.endpoint);
  }

  // customer preview + cascade: the vehicle, the paid service and its payment go along
  const pvRes = await get(`/customers/${cust._id}/deletion`);
  const pv = expectOk(pvRes, 'customer deletion preview');
  if (pv) check(pv.vehicles === 1 && pv.services === 1 && pv.payments === 1 && near(pv.paidAmount, 50), 'preview: 1 vehicle, 1 service, 1 payment of 50', pvRes.endpoint, short(pv));
  const dcRes = await del(`/customers/${cust._id}`);
  const dc = expectOk(dcRes, 'delete customer (cascade)');
  if (dc) {
    check(dc.deleted === true && dc.vehicles === 1 && dc.services === 1 && dc.payments === 1, 'cascade counts', dcRes.endpoint, short(dc));
    expectError(await get(`/customers/${cust._id}`), 'deleted customer -> 404', 404, 'הלקוח לא נמצא');
    expectError(await get(`/vehicles/${vid}`), 'vehicle deleted with the customer -> 404', 404, 'הרכב לא נמצא');
    expectError(await get(`/services/${s1.service._id}`), 'service deleted with the customer -> 404', 404, 'הטיפול לא נמצא');
    const lookupRes = await get('/vehicles/lookup/7070707');
    const lk = expectOk(lookupRes, 'plate lookup after the cascade');
    if (lk) checkEq(lk.found, false, 'plate free again', lookupRes.endpoint);
  }

  // vehicle cascade keeps the customer
  const c2Res = await post('/customers', { fullName: 'לקוח שנשאר', phone: '0503334444' });
  const c2 = expectOk(c2Res, 'create second customer', 201);
  if (!c2) return;
  const v2Res = await post('/vehicles', { plateNumber: '7070708', make: 'טסט', customer: c2._id });
  const v2 = expectOk(v2Res, 'create second vehicle', 201);
  const svRes = v2 ? await post('/services', { vehicle: v2.vehicle._id, kind: 'repair', status: 'done', items: [{ title: 'מגבים', price: 80 }], payment: { amount: 80 } }) : null;
  const sv = svRes ? expectOk(svRes, 'create a paid service on it', 201) : null;
  if (sv) {
    const pvvRes = await get(`/vehicles/${v2.vehicle._id}/deletion`);
    const pvv = expectOk(pvvRes, 'vehicle deletion preview');
    if (pvv) check(pvv.vehicles === 1 && pvv.services === 1 && pvv.payments === 1 && near(pvv.paidAmount, 80), 'vehicle preview counts', pvvRes.endpoint, short(pvv));
    const dvRes = await del(`/vehicles/${v2.vehicle._id}`);
    const dv = expectOk(dvRes, 'delete vehicle (cascade)');
    if (dv) {
      check(dv.deleted === true && dv.services === 1 && dv.payments === 1, 'vehicle cascade counts', dvRes.endpoint, short(dv));
      expectError(await get(`/services/${sv.service._id}`), 'service deleted with the vehicle -> 404', 404, 'הטיפול לא נמצא');
      const stillRes = await get(`/customers/${c2._id}`);
      const still = expectOk(stillRes, 'customer survives a vehicle delete');
      if (still) check(still.vehicles.length === 0 && still.services.length === 0, 'customer left without vehicles or services', stillRes.endpoint, short([still.vehicles.length, still.services.length]));
    }
  }
  expectOk(await del(`/customers/${c2._id}`), 'delete second customer');
}

async function testCleanupAndDeletes(ctx) {
  // customer delete ok: a fresh customer with nothing attached
  const fresh = await post('/customers', { fullName: 'למחיקה' });
  const f = expectOk(fresh, 'create throwaway customer', 201);
  const delFresh = await del(`/customers/${f?._id}`);
  const df = expectOk(delFresh, 'delete customer without refs');
  if (df) checkEq(df.deleted, true, 'deleted true', delFresh.endpoint);
  const gone = await get(`/customers/${f?._id}`);
  expectError(gone, 'deleted customer -> 404', 404, 'הלקוח לא נמצא');

  // vehicle delete ok: smokeVehicle2 has no services
  const delV2 = await del(`/vehicles/${ctx.smokeVehicle2._id}`);
  const dv = expectOk(delV2, 'delete vehicle without services');
  if (dv) checkEq(dv.deleted, true, 'vehicle deleted', delV2.endpoint);
  const goneV = await get(`/vehicles/${ctx.smokeVehicle2._id}`);
  expectError(goneV, 'deleted vehicle -> 404', 404, 'הרכב לא נמצא');

  // smoke customer still owns the smoke vehicle? No: it was transferred to the third owner. Archive instead of delete.
  const archive = await put(`/customers/${ctx.smokeCustomer._id}`, { active: false });
  const ar = expectOk(archive, 'archive customer');
  if (ar) checkEq(ar.active, false, 'archived', archive.endpoint);
  const archivedList = await get('/customers?state=archived');
  const al = checkList(archivedList, 'archived list');
  if (al) check(al.data.some((c) => String(c._id) === String(ctx.smokeCustomer._id)), 'archived customer listed', archivedList.endpoint);
  const activeList = await get('/customers?q=' + encodeURIComponent('לקוח בדיקה'));
  const acl = checkList(activeList, 'active list hides archived');
  if (acl) checkEq(acl.total, 0, 'archived hidden by default', activeList.endpoint);
  const lookupArchived = await get('/customers/lookup?phone=0549998877');
  const la = expectOk(lookupArchived, 'lookup ignores archived');
  if (la) checkEq(la.matches.length, 0, 'archived not in lookup', lookupArchived.endpoint);
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log(`Smoke test against ${API_URL} as ${SMOKE_USER}\n`);
  const ctx = { extraServices: 0 };
  const sections = [
    ['health + auth', testHealthAndAuth],
    ['bootstrap (whole working set)', testBootstrap],
    ['dashboard (fresh seed)', testDashboardFresh],
    ['search', testSearch],
    ['customers', testCustomers],
    ['services: lists (fresh seed)', testServicesLists],
    ['vehicles', testVehicles],
    ['services: detail + create', testServiceDetailAndCreate],
    ['services: update + status', testServiceUpdateAndStatus],
    ['services: items + carry', testItems],
    ['services: payments', testPayments],
    ['services: delete', testServiceDelete],
    ['templates', testTemplates],
    ['bundles', testBundles],
    ['cascade deletes', testCascadeDeletes],
    ['cleanup + deletes', testCleanupAndDeletes],
  ];
  for (const [name, fn] of sections) {
    console.log(`\n== ${name} ==`);
    try {
      await fn(ctx);
    } catch (err) {
      record(false, `section crashed: ${err?.message || err}`, name, err?.stack?.split('\n').slice(1, 3).join(' | '));
      if (name === 'health + auth') break;
    }
  }
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(f));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});

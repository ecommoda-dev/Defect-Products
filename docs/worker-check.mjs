#!/usr/bin/env node
/**
 * docs/worker-check.mjs — اختبار سلوكي محلي لـ index.js (بدون شبكة ولا حساب كلاودفلير)
 *
 * بيشغّل الـ Worker الحقيقي (index.js بالنص) فوق:
 *   · D1 مزيّف على node:sqlite (نفس الجداول)   · R2 مزيّف في الذاكرة
 *   · شوبيفاي مزيّف (fetch) بيحاكي @idempotent والرفض والرد الضايع
 * مفيش dependency — node 22+ بس.
 *
 *   node docs/worker-check.mjs        # exit 0 = كل الاختبارات عدّت
 *
 * ⚠️ ده مش بديل عن اختبار حي (diag + خصم فعلي على SKU تجريبي) — ده بيمسك
 *    أخطاء المنطق والحالات الحدّية قبل ما نلمس المخزون الحقيقي.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp  = mkdtempSync(join(tmpdir(), 'defects-check-'));
writeFileSync(join(tmp, 'index.mjs'), readFileSync(join(HERE, '..', 'index.js'), 'utf8'));
const worker = (await import(join(tmp, 'index.mjs'))).default;

// ── D1 مزيّف ────────────────────────────────────────────────
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
CREATE TABLE employees (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, pin TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, tool TEXT NOT NULL, type TEXT NOT NULL, employee TEXT, order_id TEXT, order_name TEXT, sku TEXT, product_title TEXT, delta INTEGER, value_before INTEGER, value_after INTEGER, notes TEXT, extra TEXT, edit_count INTEGER, item_count INTEGER, items TEXT, edit_reason TEXT, stage TEXT);
CREATE TABLE log_value_alerts (source_tool TEXT NOT NULL, tool TEXT NOT NULL, type TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1, worker_version TEXT, sample_order_name TEXT, sample_employee TEXT, sample_notes TEXT, status TEXT NOT NULL DEFAULT 'open', PRIMARY KEY (source_tool, tool, type));
CREATE TABLE defect_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created_by TEXT, created_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE defects (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, variant_id TEXT NOT NULL, inventory_item_id TEXT NOT NULL, product_id TEXT, sku TEXT NOT NULL, barcode TEXT, product_title TEXT, variant_title TEXT, defect_type_id INTEGER NOT NULL, repairable INTEGER NOT NULL, side TEXT NOT NULL, origin TEXT NOT NULL, notes TEXT, status TEXT NOT NULL, deduct_state TEXT NOT NULL DEFAULT 'pending', restock_state TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL, created_by TEXT NOT NULL, status_changed_at TEXT, status_changed_by TEXT, deducted_at TEXT, restocked_at TEXT, cancelled_at TEXT, cancelled_by TEXT, available_before INTEGER, available_after INTEGER, pending_op TEXT);
CREATE TABLE defect_images (id INTEGER PRIMARY KEY AUTOINCREMENT, defect_id INTEGER NOT NULL, r2_key TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, content_type TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
`);
const norm = (a) => a.map(x => (x === undefined ? null : x));
const DB = {
  prepare(sql) {
    return {
      bind(...args) {
        const st = sqlite.prepare(sql), a = norm(args);
        return {
          async first() { return st.get(...a) ?? null; },
          async all()   { return { results: st.all(...a).map(r => ({ ...r })) }; },
          async run()   { const r = st.run(...a); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
        };
      },
      async first() { return sqlite.prepare(sql).get() ?? null; },
      async all()   { return { results: sqlite.prepare(sql).all().map(r => ({ ...r })) }; },
    };
  },
};

// ── R2 مزيّف ────────────────────────────────────────────────
const r2 = new Map();
const IMAGES = {
  async put(key, data) { const buf = new Uint8Array(data); r2.set(key, buf); return { size: buf.byteLength }; },
  async get(key) {
    const buf = r2.get(key); if (!buf) return null;
    return { body: new Blob([buf]).stream(), httpEtag: '"etag-' + key.length + '-' + buf.byteLength + '"' };
  },
  async delete(key) { if (IMAGES.failDelete) throw new Error('r2 delete down'); r2.delete(key); },
  async list() { return { objects: [...r2.keys()].map(key => ({ key })) }; },
};

// ── شوبيفاي مزيّف ──────────────────────────────────────────
const shop = { mode: 'ok', stock: 0, calls: [], idem: new Map(), suspended: false, tracked: true };
const VARIANT_ID = '49745809473858', ITEM_ID = '51000000001';
function variantNode() {
  return {
    id: `gid://shopify/ProductVariant/${VARIANT_ID}`, sku: 'GT1 / White / 41', barcode: '09473858', title: 'White / 41', displayName: 'GT1 - White / 41',
    suspended: shop.suspended ? { value: 'true' } : null, selectedOptions: [{ name: 'Color', value: 'White' }],
    product: { id: 'gid://shopify/Product/9714090869058', title: 'GT1', status: 'ACTIVE', vendor: 'x', suspended: null, featuredImage: null },
    inventoryItem: { id: `gid://shopify/InventoryItem/${ITEM_ID}`, tracked: shop.tracked,
      inventoryLevel: { quantities: [{ name: 'available', quantity: shop.stock }, { name: 'committed', quantity: 0 }, { name: 'on_hand', quantity: shop.stock }] } },
  };
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/admin/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
  const { query, variables } = JSON.parse(init.body);
  const ok = (data) => new Response(JSON.stringify({ data, extensions: { cost: { requestedQueryCost: 5, actualQueryCost: 4, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 990, restoreRate: 50 } } } }), { status: 200 });
  if (query.includes('accessScopes')) return ok({ currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'read_inventory' }, { handle: 'write_inventory' }] } });
  if (query.includes('location(id')) return ok({ location: { name: 'Main', isActive: true } });
  if (query.includes('nodes(ids')) return ok({ nodes: variables.ids[0].endsWith(VARIANT_ID) ? [variantNode()] : [null] });
  if (query.includes('productVariants')) return ok({ productVariants: { nodes: [variantNode()] } });
  if (query.includes('inventoryAdjustQuantities')) {
    const key = /@idempotent\(key: "([^"]+)"\)/.exec(query)?.[1] ?? null;
    const input = variables.input; const delta = input.changes[0].delta;
    shop.calls.push({ key, delta, reason: input.reason, ref: input.referenceDocumentUri, name: input.name });
    if (shop.mode === 'topError') return new Response(JSON.stringify({ errors: [{ message: 'Access denied for inventoryAdjustQuantities' }] }), { status: 200 });
    if (shop.mode === 'userError') return ok({ inventoryAdjustQuantities: { userErrors: [{ field: ['input'], message: 'Quantity invalid', code: 'INVALID' }], inventoryAdjustmentGroup: null } });
    if (shop.mode === 'emptyChanges') return ok({ inventoryAdjustQuantities: { userErrors: [], inventoryAdjustmentGroup: { createdAt: 'x', reason: input.reason, changes: [] } } });
    let res = shop.idem.get(key);
    if (!res) {
      shop.stock += delta;
      res = { createdAt: new Date().toISOString(), reason: input.reason, changes: [{ name: 'available', delta, quantityAfterChange: shop.stock }] };
      shop.idem.set(key, res);
    }
    if (shop.mode === 'lost') throw new TypeError('network down');   // اتنفّذ والرد ضاع
    return ok({ inventoryAdjustQuantities: { userErrors: [], inventoryAdjustmentGroup: res } });
  }
  throw new Error('fake shopify: unhandled query ' + query.slice(0, 60));
};

// ── أدوات الاختبار ──────────────────────────────────────────
const SECRET = 'test-secret-0123456789';
const env = { DB, IMAGES, WORKER_SECRET: SECRET, SHOP_DOMAIN: 'x.myshopify.com', CLIENT_ID: 'a', CLIENT_SECRET: 'b', LOCATION_ID: '98849620290' };
const ORIGIN = 'https://ecommoda-dev.github.io';
async function call(action, { method = 'GET', body, query = {}, form, headers = {}, e = env } = {}) {
  const qs = new URLSearchParams({ action, ...query });
  const init = { method, headers: { Authorization: `Bearer ${SECRET}`, Origin: ORIGIN, ...headers } };
  if (form) { init.method = 'POST'; init.body = form; }
  else if (body) { init.method = 'POST'; init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  return worker.fetch(new Request(`https://w.example/?${qs}`, init), e);
}
const J = async (r) => r.json();
const rid = () => crypto.randomUUID();
const EMP = 'Test_Emp';
const q1 = (sql, ...a) => sqlite.prepare(sql).get(...a);
const qa = (sql, ...a) => sqlite.prepare(sql).all(...a);

function reset() {
  for (const t of ['defect_images', 'defects', 'defect_types', 'logs', 'log_value_alerts']) sqlite.exec(`DELETE FROM ${t}`);
  sqlite.exec(`DELETE FROM employees`);
  sqlite.prepare(`INSERT INTO employees (username, display_name, pin) VALUES (?, ?, ?)`).run(EMP, 'Test Emp', '1234');
  Object.assign(shop, { mode: 'ok', stock: 5, calls: [], suspended: false, tracked: true }); shop.idem.clear();
  r2.clear(); IMAGES.failDelete = false;
}
async function newType(name = 'خياطة مفتوحة') {
  return (await J(await call('add_defect_type', { body: { employee: EMP, name } }))).type;
}
async function register(over = {}, typeId) {
  const type = typeId ?? (await newType()).id;
  const body = { employee: EMP, requestId: rid(), variantId: VARIANT_ID, defectTypeId: type, repairable: true, side: 'right', origin: 'new', notes: 'ملاحظة', ...over };
  return { body, res: await J(await call('register_defect', { body })) };
}
const JPEG = () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...new Array(64).fill(7)]);
function imgForm(defectId, bytes, name = 'a.jpg') {
  const f = new FormData(); f.set('employee', EMP); f.set('defectId', String(defectId)); f.set('file', new File([bytes], name)); return f;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── 1) الأمان والأساسيات ────────────────────────────────────
test('OPTIONS preflight = 204 وCORS صارم', async () => {
  const r = await worker.fetch(new Request('https://w/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});
test('بدون Authorization = 401', async () => {
  const r = await worker.fetch(new Request('https://w/?action=get_config', { headers: { Origin: ORIGIN } }), env);
  assert.equal(r.status, 401);
});
test('WORKER_SECRET غايب = 500 (مش "Bearer undefined" مقبول)', async () => {
  const r = await worker.fetch(new Request('https://w/?action=get_config', { headers: { Authorization: 'Bearer undefined', Origin: ORIGIN } }), { ...env, WORKER_SECRET: undefined });
  assert.equal(r.status, 500);
});
test('get_config بيرجّع النسخة', async () => {
  const d = await J(await call('get_config'));
  assert.equal(d.version, '1.0.0'); assert.equal(d.tool, 'defect_products');
});
test('diag: مصفوفة checks وكل بند ok + مفيش قيمة سر', async () => {
  const r = await call('diag'); const txt = await r.clone().text(); const d = await r.json();
  assert.ok(Array.isArray(d.checks) && d.checks.length >= 8);
  assert.ok(d.checks.every(c => c.ok), JSON.stringify(d.checks.filter(c => !c.ok)));
  assert.ok(!txt.includes(SECRET)); assert.ok(d.throttleStatus && d.lastQueryCost);
});

// ── 2) أنواع العيب ─────────────────────────────────────────
test('نوع عيب جديد، وبعده نفس الاسم بتهجئة/تشكيل/مسافات مختلفة = already', async () => {
  const a = await J(await call('add_defect_type', { body: { employee: EMP, name: 'أُلصق   غلط' } }));
  assert.equal(a.status, 'success');
  for (const variant of ['الصق غلط', '  أُلصق غلط ', 'ألصق  غلط']) {
    const b = await J(await call('add_defect_type', { body: { employee: EMP, name: variant } }));
    assert.equal(b.status, 'already', variant); assert.equal(b.type.id, a.type.id);
  }
  const other = await J(await call('add_defect_type', { body: { employee: EMP, name: 'لون مختلف' } }));
  assert.equal(other.status, 'success');
  assert.equal(q1(`SELECT COUNT(*) c FROM defect_types`).c, 2);
});
test('نوع عيب باسم قصير جدًا = 400', async () => {
  const r = await call('add_defect_type', { body: { employee: EMP, name: 'ا' } });
  assert.equal(r.status, 400);
});
test('موظف غير موجود = 400', async () => {
  const r = await call('add_defect_type', { body: { employee: 'Ghost', name: 'عيب' } });
  assert.equal(r.status, 400);
});

// ── 3) التسجيل والخصم ──────────────────────────────────────
test('تسجيل عادي: خصم 1 + صف done + لوج واحد + مفتاح idempotency', async () => {
  const { res } = await register();
  assert.equal(res.status, 'success'); assert.equal(shop.stock, 4);
  assert.equal(res.defect.deductState, 'done'); assert.equal(res.defect.status, 'awaiting_repair');
  assert.equal(res.defect.availableBefore, 5); assert.equal(res.defect.availableAfter, 4);
  assert.equal(shop.calls.length, 1);
  assert.equal(shop.calls[0].delta, -1); assert.equal(shop.calls[0].reason, 'damaged'); assert.equal(shop.calls[0].name, 'available');
  assert.match(shop.calls[0].key, /^[0-9a-f-]{36}:deduct$/);
  assert.match(shop.calls[0].ref, /^gid:\/\/Defect-Products\/Defect\/\d+$/);
  const logs = qa(`SELECT * FROM logs WHERE type='registered'`);
  assert.equal(logs.length, 1); assert.equal(JSON.parse(logs[0].extra).result, 'success'); assert.equal(logs[0].delta, -1);
  assert.ok(!JSON.parse(logs[0].extra)._unregistered);
});
test('repairable=false → الحالة unrepairable من البداية', async () => {
  const { res } = await register({ repairable: false });
  assert.equal(res.defect.status, 'unrepairable');
});
test('ضغطة مكررة بنفس requestId = already ومفيش خصم تاني', async () => {
  const { body, res } = await register();
  assert.equal(res.status, 'success');
  const again = await J(await call('register_defect', { body }));
  assert.equal(again.status, 'already'); assert.equal(shop.stock, 4); assert.equal(shop.calls.length, 1);
  assert.equal(q1(`SELECT COUNT(*) c FROM defects`).c, 1);
});
test('ضغطتين متزامنتين بنفس requestId = خصم واحد', async () => {
  const type = (await newType()).id;
  const body = { employee: EMP, requestId: rid(), variantId: VARIANT_ID, defectTypeId: type, repairable: true, side: 'left', origin: 'return' };
  const [a, b] = await Promise.all([call('register_defect', { body }), call('register_defect', { body })]);
  const sa = (await a.json()).status, sb = (await b.json()).status;
  assert.equal(shop.stock, 4, `stock=${shop.stock} (${sa},${sb})`);
  assert.equal(q1(`SELECT COUNT(*) c FROM defects`).c, 1);
});
test('الرصيد 0 → needs_decision بدون أي كتابة', async () => {
  shop.stock = 0;
  const { res } = await register();
  assert.equal(res.status, 'needs_decision'); assert.equal(res.reason, 'zero_stock');
  assert.equal(q1(`SELECT COUNT(*) c FROM defects`).c, 0); assert.equal(shop.calls.length, 0);
});
test('الرصيد 0 + stockMode=skip → اتسجّل بدون خصم', async () => {
  shop.stock = 0;
  const { res } = await register({ stockMode: 'skip' });
  assert.equal(res.status, 'success'); assert.equal(res.defect.deductState, 'skipped');
  assert.equal(shop.calls.length, 0); assert.equal(shop.stock, 0);
});
test('stockMode=skip والرصيد متاح → مرفوض (لازم يتخصم)', async () => {
  const { res } = await register({ stockMode: 'skip' });
  assert.equal(res.status, 'rejected'); assert.equal(q1(`SELECT COUNT(*) c FROM defects`).c, 0);
});
test('منتج موقوف / مخزون مش متتبَّع / variant مش موجود → rejected', async () => {
  shop.suspended = true; assert.equal((await register()).res.status, 'rejected'); shop.suspended = false;
  shop.tracked = false;  assert.equal((await register()).res.status, 'rejected'); shop.tracked = true;
  assert.equal((await register({ variantId: '1234567890' })).res.status, 'rejected');
  assert.equal(shop.calls.length, 0);
});
test('نوع عيب مش موجود → rejected', async () => {
  const { res } = await register({}, 9999); assert.equal(res.status, 'rejected');
});
test('مدخلات غلط = 400 (side/origin/requestId/notes طويلة)', async () => {
  const t = (await newType()).id;
  const base = { employee: EMP, requestId: rid(), variantId: VARIANT_ID, defectTypeId: t, repairable: true, side: 'right', origin: 'new' };
  for (const bad of [{ side: 'x' }, { origin: 'x' }, { requestId: 'a' }, { repairable: 'yes' }, { notes: 'x'.repeat(1001) }, { variantId: 'abc' }]) {
    assert.equal((await call('register_defect', { body: { ...base, ...bad } })).status, 400, JSON.stringify(bad));
  }
});
test('شوبيفاي ترفض (userErrors) → error + الصف اتمسح + المخزون زي ما هو', async () => {
  shop.mode = 'userError';
  const { res } = await register();
  assert.equal(res.status, 'error'); assert.equal(shop.stock, 5);
  assert.equal(q1(`SELECT COUNT(*) c FROM defects`).c, 0);
  const lg = qa(`SELECT * FROM logs WHERE type='registered'`); assert.equal(lg.length, 1); assert.equal(JSON.parse(lg[0].extra).result, 'error');
});
test('رفض على مستوى top-level errors → error (مش نجاح)', async () => {
  shop.mode = 'topError'; const { res } = await register();
  assert.equal(res.status, 'error'); assert.equal(q1(`SELECT COUNT(*) c FROM defects`).c, 0);
});
test('payload فاضي (changes=[]) → warning مش success', async () => {
  shop.mode = 'emptyChanges'; const { res } = await register();
  assert.equal(res.status, 'warning'); assert.equal(res.defect.deductState, 'unconfirmed');
});
test('الرد ضاع (اتنفّذ) → warning/unconfirmed، وإعادة نفس الطلب = success بدون خصم تاني', async () => {
  shop.mode = 'lost';
  const { body, res } = await register();
  assert.equal(res.status, 'warning'); assert.equal(res.retryable, true); assert.equal(res.defect.deductState, 'unconfirmed');
  assert.equal(shop.stock, 4);                      // اتنفّذ فعلًا
  shop.mode = 'ok';
  const retry = await J(await call('register_defect', { body }));
  assert.equal(retry.status, 'success'); assert.equal(retry.defect.deductState, 'done');
  assert.equal(shop.stock, 4, 'ممنوع خصم تاني');
});
test('صف معلّق أقدم من النافذة → مرفوض (مراجعة يدوية) ومفيش نداء', async () => {
  shop.mode = 'lost'; const { body } = await register(); shop.mode = 'ok';
  const n = shop.calls.length;
  sqlite.prepare(`UPDATE defects SET created_at = ?`).run(new Date(Date.now() - 3600_000).toISOString());
  const r = await J(await call('register_defect', { body }));
  assert.equal(r.status, 'rejected'); assert.equal(shop.calls.length, n);
});

// ── 4) تغيير الحالة / الإصلاح / الإلغاء ─────────────────────
test('قابل ↔ غير قابل للإصلاح بدون أثر على المخزون + already لو نفس الحالة', async () => {
  const { res } = await register(); const id = res.defect.id;
  const a = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'unrepairable' } }));
  assert.equal(a.status, 'success'); assert.equal(a.defect.status, 'unrepairable'); assert.equal(a.defect.repairable, false);
  const same = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'unrepairable' } }));
  assert.equal(same.status, 'already');
  const b = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'awaiting_repair' } }));
  assert.equal(b.status, 'success'); assert.equal(b.defect.repairable, true);
  assert.equal(shop.stock, 4); assert.equal(shop.calls.length, 1);
});
test('اتصلحت: +1 للستوك (reason=restock) وبعدين نهائية', async () => {
  const { res } = await register(); const id = res.defect.id;
  const r = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }));
  assert.equal(r.status, 'success'); assert.equal(r.defect.status, 'repaired'); assert.equal(r.defect.restockState, 'done');
  assert.equal(shop.stock, 5);
  assert.equal(shop.calls[1].delta, 1); assert.equal(shop.calls[1].reason, 'restock'); assert.match(shop.calls[1].key, /:restock$/);
  const again = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }));
  assert.equal(again.status, 'already'); assert.equal(shop.stock, 5);
  const back = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'unrepairable' } }));
  assert.equal(back.status, 'rejected');
});
test('اتصلحت من غير قابل للإصلاح مباشرة = مرفوض', async () => {
  const { res } = await register({ repairable: false });
  const r = await J(await call('set_status', { body: { employee: EMP, defectId: res.defect.id, status: 'repaired' } }));
  assert.equal(r.status, 'rejected'); assert.equal(shop.stock, 4);
});
test('اتصلحت لتسجيل بدون خصم → مفيش +1', async () => {
  shop.stock = 0; const { res } = await register({ stockMode: 'skip' });
  const r = await J(await call('set_status', { body: { employee: EMP, defectId: res.defect.id, status: 'repaired' } }));
  assert.equal(r.status, 'success'); assert.equal(shop.stock, 0); assert.equal(shop.calls.length, 0);
});
test('اتصلحت: شوبيفاي ترفض → error والحالة تفضل قابلة للإصلاح والعملية تتعاد', async () => {
  const { res } = await register(); const id = res.defect.id;
  shop.mode = 'userError';
  const r = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }));
  assert.equal(r.status, 'error'); assert.equal(r.defect.status, 'awaiting_repair'); assert.equal(r.defect.restockState, 'none');
  shop.mode = 'ok';
  const ok = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }));
  assert.equal(ok.status, 'success'); assert.equal(shop.stock, 5);
});
test('اتصلحت: الرد ضاع → warning وإعادة بنفس المفتاح = مرة واحدة بس', async () => {
  const { res } = await register(); const id = res.defect.id;
  shop.mode = 'lost';
  const r = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }));
  assert.equal(r.status, 'warning'); assert.equal(r.defect.restockState, 'unconfirmed'); assert.equal(shop.stock, 5);
  shop.mode = 'ok';
  const retry = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }));
  assert.equal(retry.status, 'success'); assert.equal(shop.stock, 5, 'ممنوع +1 تاني');
  assert.equal(retry.defect.status, 'repaired');
});
test('ضغطتين متزامنتين على اتصلحت = +1 واحد', async () => {
  const { res } = await register(); const id = res.defect.id;
  const body = { employee: EMP, defectId: id, status: 'repaired' };
  await Promise.all([call('set_status', { body }), call('set_status', { body })]);
  assert.equal(shop.stock, 5);
});
test('إلغاء: +1 (reason=correction) وبعدين already، ومينفعش بعد اتصلحت', async () => {
  const { res } = await register(); const id = res.defect.id;
  const c = await J(await call('cancel_defect', { body: { employee: EMP, defectId: id } }));
  assert.equal(c.status, 'success'); assert.equal(c.defect.status, 'cancelled'); assert.equal(shop.stock, 5);
  assert.equal(shop.calls[1].reason, 'correction'); assert.match(shop.calls[1].key, /:cancel$/);
  assert.equal((await J(await call('cancel_defect', { body: { employee: EMP, defectId: id } }))).status, 'already');
  assert.equal((await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }))).status, 'rejected');
  const r2 = (await register()).res.defect.id;
  await call('set_status', { body: { employee: EMP, defectId: r2, status: 'repaired' } });
  assert.equal((await J(await call('cancel_defect', { body: { employee: EMP, defectId: r2 } }))).status, 'rejected');
});
test('إلغاء تسجيل بدون خصم → مفيش رجوع للستوك', async () => {
  shop.stock = 0; const { res } = await register({ stockMode: 'skip' });
  const c = await J(await call('cancel_defect', { body: { employee: EMP, defectId: res.defect.id } }));
  assert.equal(c.status, 'success'); assert.equal(shop.stock, 0); assert.equal(shop.calls.length, 0);
});
test('إلغاء ثم اتصلحت أثناء عملية معلّقة من نوع تاني = مرفوض', async () => {
  const { res } = await register(); const id = res.defect.id;
  shop.mode = 'lost';
  await call('cancel_defect', { body: { employee: EMP, defectId: id } });      // unconfirmed cancel
  shop.mode = 'ok';
  const r = await J(await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } }));
  assert.equal(r.status, 'rejected'); assert.equal(shop.stock, 5);
});

// ── 5) الصور ────────────────────────────────────────────────
test('رفع صورة JPEG: R2 + D1 + اسم UUID من السيرفر، وعرضها stream بهيدرز الأمان وETag/304', async () => {
  const id = (await register()).res.defect.id;
  const r = await J(await call('add_defect_image', { form: imgForm(id, JPEG(), '../../evil name.jpg') }));
  assert.equal(r.status, 'success'); assert.equal(r.image.contentType, 'image/jpeg');
  const row = q1(`SELECT * FROM defect_images`); assert.match(row.r2_key, /^defects\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
  assert.ok(r2.has(row.r2_key));
  const g = await call('get_image', { query: { id: String(r.image.id) } });
  assert.equal(g.status, 200); assert.equal(g.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(g.headers.get('X-Content-Type-Options'), 'nosniff'); assert.match(g.headers.get('Cache-Control'), /private/);
  assert.equal(new Uint8Array(await g.arrayBuffer()).length, JPEG().length);
  const etag = g.headers.get('ETag');
  const n304 = await call('get_image', { query: { id: String(r.image.id) }, headers: { 'If-None-Match': etag } });
  assert.equal(n304.status, 304);
  const list = await J(await call('get_defect_images', { query: { defectId: String(id) } }));
  assert.equal(list.images.length, 1);
  assert.equal((await J(await call('get_defects', { query: { limit: '5' } }))).defects[0].imageCount, 1);
});
test('PNG وWebP مقبولين، HEIC وSVG وملف نص ومحتوى تالف مرفوضين', async () => {
  const id = (await register()).res.defect.id;
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Array(40).fill(1)]);
  const webp = new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map(c => c.charCodeAt(0)), new Array(30).fill(2)));
  assert.equal((await J(await call('add_defect_image', { form: imgForm(id, png, 'a.png') }))).status, 'success');
  assert.equal((await J(await call('add_defect_image', { form: imgForm(id, webp, 'a.webp') }))).status, 'success');
  const heic = new Uint8Array([0, 0, 0, 24, ...[...'ftypheic'].map(c => c.charCodeAt(0)), ...new Array(30).fill(0)]);
  const h = await J(await call('add_defect_image', { form: imgForm(id, heic, 'a.heic') }));
  assert.equal(h.status, 'rejected'); assert.match(h.message, /HEIC/);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await J(await call('add_defect_image', { form: imgForm(id, svg, 'a.jpg') }))).status, 'rejected');   // امتداد jpg بس المحتوى SVG
  assert.equal((await J(await call('add_defect_image', { form: imgForm(id, new TextEncoder().encode('hello world, plain text file'), 'a.jpg') }))).status, 'rejected');
  assert.equal((await J(await call('add_defect_image', { form: imgForm(id, new Uint8Array(4), 'a.jpg') }))).status, 'rejected');
  assert.equal(r2.size, 2);
});
test('صورة أكبر من 15MB مرفوضة (ومش بتتخزّن)', async () => {
  const id = (await register()).res.defect.id;
  const big = new Uint8Array(15 * 1024 * 1024 + 1); big.set([0xFF, 0xD8, 0xFF]);
  const r = await J(await call('add_defect_image', { form: imgForm(id, big) }));
  assert.equal(r.status, 'rejected'); assert.equal(r2.size, 0);
});
test('أقصى 10 صور للقطعة', async () => {
  const id = (await register()).res.defect.id;
  for (let i = 0; i < 10; i++) assert.equal((await J(await call('add_defect_image', { form: imgForm(id, JPEG()) }))).status, 'success');
  assert.equal((await J(await call('add_defect_image', { form: imgForm(id, JPEG()) }))).status, 'rejected');
});
test('الصور بعد اتصلحت / إلغاء مرفوضة، وديفو مش موجود مرفوض', async () => {
  const id = (await register()).res.defect.id;
  await call('set_status', { body: { employee: EMP, defectId: id, status: 'repaired' } });
  assert.equal((await J(await call('add_defect_image', { form: imgForm(id, JPEG()) }))).status, 'rejected');
  assert.equal((await J(await call('add_defect_image', { form: imgForm(99999, JPEG()) }))).status, 'rejected');
});
const failImageInsert = () => sqlite.exec(`CREATE TRIGGER fail_img BEFORE INSERT ON defect_images BEGIN SELECT RAISE(ABORT, 'boom'); END`);
const healImageInsert = () => sqlite.exec(`DROP TRIGGER IF EXISTS fail_img`);
test('فشل D1 بعد نجاح R2 → الملف اتمسح من R2 (مفيش يتيم)', async () => {
  const id = (await register()).res.defect.id;
  failImageInsert();
  const r = await J(await call('add_defect_image', { form: imgForm(id, JPEG()) }));
  healImageInsert();
  assert.equal(r.status, 'error'); assert.equal(r2.size, 0, 'R2 لازم يفضل فاضي');
  assert.equal(q1(`SELECT COUNT(*) c FROM defect_images`).c, 0);
  const lg = qa(`SELECT * FROM logs WHERE type='image_added'`); assert.equal(JSON.parse(lg[0].extra).result, 'error');
});
test('فشل D1 + فشل مسح R2 → warning فيه المفتاح اليتيم', async () => {
  const id = (await register()).res.defect.id;
  failImageInsert(); IMAGES.failDelete = true;
  const r = await J(await call('add_defect_image', { form: imgForm(id, JPEG()) }));
  healImageInsert();
  assert.equal(r.status, 'warning'); assert.match(r.orphanKey, /^defects\//); assert.ok(r2.has(r.orphanKey));
});
test('مسح صورة: D1 + R2، وبعد اتصلحت مرفوض', async () => {
  const id = (await register()).res.defect.id;
  const img = (await J(await call('add_defect_image', { form: imgForm(id, JPEG()) }))).image;
  const d = await J(await call('delete_defect_image', { body: { employee: EMP, imageId: img.id } }));
  assert.equal(d.status, 'success'); assert.equal(r2.size, 0); assert.equal(q1(`SELECT COUNT(*) c FROM defect_images`).c, 0);
  assert.equal((await J(await call('delete_defect_image', { body: { employee: EMP, imageId: img.id } }))).status, 'already');
});
test('get_image لصورة مش موجودة = 404', async () => {
  assert.equal((await call('get_image', { query: { id: '777' } })).status, 404);
});

// ── 6) المخزن الرقمي والسجل ─────────────────────────────────
test('get_defects: فلاتر + ترتيب + pagination + count + export + status counts', async () => {
  const t1 = (await newType('عيب أ')).id, t2 = (await newType('عيب ب')).id;
  for (let i = 0; i < 4; i++) await register({ side: 'right' }, t1);
  const left = (await register({ side: 'left', origin: 'return', repairable: false }, t2)).res.defect.id;
  shop.stock = 0; await register({ stockMode: 'skip' }, t1);
  const all = await J(await call('get_defects', { query: { limit: '3', offset: '0' } }));
  assert.equal(all.defects.length, 3);
  assert.equal((await J(await call('get_defects_count'))).total, 6);
  assert.equal((await J(await call('get_defects', { query: { sides: 'left' } }))).defects[0].id, left);
  assert.equal((await J(await call('get_defects_count', { query: { statuses: 'unrepairable', origins: 'return', types: String(t2) } }))).total, 1);
  assert.equal((await J(await call('get_defects_count', { query: { deductStates: 'skipped' } }))).total, 1);
  assert.equal((await J(await call('get_defects_count', { query: { skus: 'GT1' } }))).total, 6);
  assert.equal((await J(await call('get_defects_count', { query: { skus: 'zzz' } }))).total, 0);
  assert.equal((await J(await call('get_defects_count', { query: { search: 'ملاحظة' } }))).total, 6);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  assert.equal((await J(await call('get_defects_count', { query: { dateFrom: today, dateTo: today } }))).total, 6);
  assert.equal((await J(await call('get_defects_count', { query: { dateTo: '2020-01-01' } }))).total, 0);
  const asc = await J(await call('get_defects', { query: { sortBy: 'id', sortDir: 'asc', limit: '2' } }));
  assert.ok(asc.defects[0].id < asc.defects[1].id);
  const bad = await J(await call('get_defects', { query: { sortBy: 'id; DROP TABLE defects', sortDir: 'x' } }));
  assert.equal(bad.defects.length, 6);
  const ex = await J(await call('get_defects_export'));
  assert.equal(ex.cap, 2000); assert.equal(ex.total, 6); assert.equal(ex.truncated, false); assert.equal(ex.defects.length, 6);
  const sc = await J(await call('get_status_counts'));
  assert.equal(sc.counts.awaiting_repair, 5); assert.equal(sc.counts.unrepairable, 1); assert.equal(sc.skipped, 1);
});
test('سجل العمليات: login/logout مستثنيين، count/export بنفس الفلاتر، وترتيب بمفتاح خاص بالأداة', async () => {
  await call('verify_employee', { body: { username: EMP, pin: '1234' } });
  const { res } = await register(); await call('set_status', { body: { employee: EMP, defectId: res.defect.id, status: 'repaired' } });
  const logs = await J(await call('get_logs'));
  assert.ok(logs.entries.every(e => e.type !== 'login'));
  assert.deepEqual(logs.entries.map(e => e.type).sort(), ['defect_type_added', 'registered', 'repaired']);
  assert.equal((await J(await call('get_logs_count', { query: { types: 'repaired' } }))).total, 1);
  const ex = await J(await call('get_logs_export', { query: { types: 'repaired' } }));
  assert.equal(ex.total, 1); assert.equal(ex.truncated, false); assert.equal(ex.cap, 2000);
  const sorted = await J(await call('get_logs', { query: { sortBy: 'defectId', sortDir: 'asc' } }));
  assert.equal(sorted.entries.length, 3);
});
test('كل قيم type المكتوبة متسجّلة (مفيش _unregistered ولا تنبيهات)', async () => {
  const { res } = await register(); await call('add_defect_image', { form: imgForm(res.defect.id, JPEG()) });
  await call('set_status', { body: { employee: EMP, defectId: res.defect.id, status: 'unrepairable' } });
  await call('cancel_defect', { body: { employee: EMP, defectId: res.defect.id } });
  await call('cancel_defect', { body: { employee: EMP, defectId: res.defect.id } });
  assert.equal(q1(`SELECT COUNT(*) c FROM log_value_alerts`).c, 0);
  assert.equal(q1(`SELECT COUNT(*) c FROM logs WHERE extra LIKE '%_unregistered%'`).c, 0);
});
test('البحث: list_skus / lookup_barcode بيرجّعوا شكل موحّد + eligibility', async () => {
  const s = await J(await call('list_skus', { query: { search: 'GT1' } }));
  assert.equal(s.variants[0].variantId, VARIANT_ID); assert.equal(s.variants[0].available, 5); assert.equal(s.variants[0].ineligibleReason, null);
  const b = await J(await call('lookup_barcode', { query: { barcode: '09473858' } }));
  assert.equal(b.variants.length, 1);
  assert.equal((await J(await call('lookup_barcode', { query: { barcode: '000' } }))).variants.length, 0);   // مطابقة تامة بس
  assert.equal((await call('list_skus', { query: { search: 'a' } })).status, 400);
  shop.suspended = true;
  assert.equal((await J(await call('list_skus', { query: { search: 'GT1' } }))).variants.length, 0);
});
test('action مجهول = 404 ، GET على endpoint POST = 405', async () => {
  assert.equal((await call('nope')).status, 404);
  assert.equal((await call('register_defect')).status, 405);
});

// ── تشغيل ──────────────────────────────────────────────────
let failed = 0;
for (const t of tests) {
  reset();
  try { await t.fn(); console.log(`  ✓ ${t.name}`); }
  catch (e) { failed++; console.log(`  ✗ ${t.name}\n      ${String(e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} عدّوا`);
process.exit(failed ? 1 : 0);

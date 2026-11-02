// ══════════════════════════════════════════════════════════════
// §HEADER
// defect-products-worker — EcomModa v1.0.0
// Account: ecommoda-dev (762c353004e8472b20261fba273bfe8d)
// D1: DB → ecommoda-dev-logs · R2: IMAGES → defect-products-images
//
// skills: worker-builder v3.10.0 · constants v4.4.0 · shopify-graphql-helper v2.4.0 — 02-11-2026
//
// ديفوهات — تسجيل قطعة فيها عيب: خصم 1 من المخزون (available) + سجل رقمي
// (D1) + صور اختيارية (R2). القطعة بتتصلّح فبترجع للستوك +1، أو بتتعلّم
// غير قابلة للإصلاح فبتفضل سجل. الأداة صفحة جوّه هب المخزن.
//
// CHANGELOG v1.0.0 (02-11-2026) — النسخة الأولى
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const TOOL_NAME      = 'defect_products';
const WORKER_VERSION = '1.0.0';

// الأداة دي واجهة واحدة (صفحة في هب المخزن) — القايمة البيضاء لـ appId مقفولة.
const AUTH_APPS = new Set([TOOL_NAME]);
function resolveAuthTool(appId) { return AUTH_APPS.has(appId) ? appId : TOOL_NAME; }

// حالات القطعة (status) — بتتحقق في الـ Worker، مفيش CHECK في D1 عشان
// نقدر نزوّد «تم التخلص منها» لاحقًا من غير تعديل الجدول.
const STATUS = {
  AWAITING:     'awaiting_repair',   // قابلة للإصلاح — لسه
  REPAIRED:     'repaired',          // اتصلحت (نهائي) — اتضاف +1 للستوك
  UNREPAIRABLE: 'unrepairable',      // غير قابلة للإصلاح — سجل دائم
  CANCELLED:    'cancelled',         // اتلغى التسجيل — رجع الستوك (لو اتخصم)
};

// حالة خصم المخزون (deduct_state)
const DEDUCT = {
  PENDING:     'pending',      // الصف اتكتب والخصم لسه ما اتأكدش
  DONE:        'done',         // اتخصم 1 واتأكد من شوبيفاي
  SKIPPED:     'skipped',      // اتسجّل بدون خصم (الرصيد كان 0 — قرار الموظف)
  UNCONFIRMED: 'unconfirmed',  // النداء وصل ومعرفناش النتيجة — إعادة بنفس المفتاح آمنة
};

// حالة رجوع الكمية للستوك (restock_state) — «اتصلحت» أو «إلغاء» بيستخدموها
const RESTOCK = { NONE: 'none', PENDING: 'pending', DONE: 'done', UNCONFIRMED: 'unconfirmed' };

const SIDES   = ['right', 'left', 'both'];   // اليمين · اليسار · الفردتين
const ORIGINS = ['new', 'return'];           // جديد · مرتجع

// عمليات المخزون الثلاثة: كل واحدة ليها delta وسبب شوبيفاي ومفتاح idempotency ثابت.
// المفتاح = request_id + لاحقة، يعني إعادة نفس العملية بتدّي نفس نتيجة شوبيفاي
// الأصلية بدل ما تتنفّذ تاني (@idempotent — متاح من API 2026-01، وإلزامي من 2026-04).
const STOCK_OPS = {
  deduct:  { delta: -1, reason: 'damaged',    keySuffix: 'deduct'  },
  repair:  { delta:  1, reason: 'restock',    keySuffix: 'restock' },
  cancel:  { delta:  1, reason: 'correction', keySuffix: 'cancel'  },
};

// سلسلة السقوف (worker-builder Step 5A ⑪):
//   ① الواجهة CHUNK / ② الـ Worker MAX_BATCH — غير منطبقين: كل نداء كتابة بيشتغل
//     على قطعة واحدة، مفيش endpoint بياخد مصفوفة.
//   ③ شوبيفاي — استعلامات خفيفة (variant + مستوى مخزون واحد)، البحث بـ 25 صف
//     والباركود بـ 5، فالتكلفة بعيدة جدًا عن سقف الـ 1000 نقطة.
// مصدر الحالة: عابرة (الديفوهات بتتسجّل يوميًا لكن القراءة صفحات 100 صف).
const SEARCH_PAGE_SIZE   = 25;
const BARCODE_MAX_MATCH  = 5;
const REGISTRY_PAGE_MAX  = 100;
const DEFECT_EXPORT_MAX  = 2000;     // بيرجع للواجهة كـ `cap`
const LOG_EXPORT_MAX     = 2000;     // سقف التصدير — بيرجع للواجهة كـ `cap`

const IMAGE_MAX_BYTES      = 15 * 1024 * 1024;   // قرار أحمد 02-11-2026
const IMAGES_PER_DEFECT_MAX = 10;                // قرار أحمد 02-11-2026
const RETRY_WINDOW_MS      = 30 * 60 * 1000;     // بعدها الصف المعلّق يحتاج مراجعة يدوية
const NOTES_MAX            = 1000;
const TYPE_NAME_MIN        = 2;
const TYPE_NAME_MAX        = 60;
const TYPES_TOTAL_MAX      = 300;

// ════════════════════════════════════════════════════════════
// §LOG-REG — الحارس الديناميكي لقيم اللوج (الطبقة ٥، worker-builder Step 7-ج)
// ════════════════════════════════════════════════════════════
// قطعة الأداة دي بس من log-values.json اللي جنبها — بتتحدّث معاه في نفس
// الـ commit. ممنوع شحن السجل الكامل بتاع كل الأدوات هنا.
const LOG_REGISTRY = {
  defect_products: new Set([
    'login', 'logout',
    'registered', 'status_changed', 'repaired', 'cancelled',
    'image_added', 'image_deleted', 'defect_type_added',
    'rejected',
  ]),
};

const isRegisteredLogValue = (tool, type) => !!LOG_REGISTRY[tool]?.has(type);

// UPSERT على (source_tool, tool, type) — صف واحد لكل قيمة، hits بيعدّ.
const LOG_ALERT_SQL = `
  INSERT INTO log_value_alerts
    (source_tool, tool, type, first_seen, last_seen, hits,
     worker_version, sample_order_name, sample_employee, sample_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_tool, tool, type) DO UPDATE SET
    last_seen         = excluded.last_seen,
    hits              = log_value_alerts.hits + excluded.hits,
    worker_version    = excluded.worker_version,
    sample_order_name = excluded.sample_order_name,
    sample_employee   = excluded.sample_employee,
    sample_notes      = excluded.sample_notes,
    status            = CASE WHEN log_value_alerts.status = 'ignored'
                             THEN 'ignored' ELSE 'open' END
`;

// فشل التنبيه ممنوع يأثر على أي حاجة — try/catch صامت.
async function noteUnregisteredLogValues(db, entries) {
  const byPair = new Map();
  for (const e of entries) {
    const key = `${e.tool}\u0000${e.type}`;
    const acc = byPair.get(key);
    if (acc) { acc.hits++; continue; }
    byPair.set(key, { entry: e, hits: 1 });
  }
  const now = new Date().toISOString();
  for (const { entry, hits } of byPair.values()) {
    try {
      await db.prepare(LOG_ALERT_SQL).bind(
        TOOL_NAME, entry.tool ?? '(بدون tool)', entry.type ?? '(بدون type)',
        now, now, hits, WORKER_VERSION ?? null,
        entry.orderName ?? null, entry.employee ?? null,
        entry.notes ? String(entry.notes).slice(0, 200) : null,
      ).run();
    } catch (e) { /* متعمّد: التنبيه فهرس، وفشله أهون من تعطيل الأداة */ }
  }
}

// ══════════════════════════════════════════════════════════════
// §CORS — الأداة بتكتب (مخزون) → Option B (قايمة صارمة)
// ══════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
];
function getCORS(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // Content-Type لازم يتسمح بيه عشان رفع الصور (multipart) — الـ preflight.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// طلب غلط (مدخل ناقص/شكله غلط) → 400. مش نتيجة عملية — الواجهة الملتزمة عمرها ما تبعته.
class BadRequest extends Error {}

// ─── §HELPERS::time — توقيت القاهرة يتحسب مايتكتبش ثابت (constants §13) ───
const CAIRO_TZ = 'Africa/Cairo';
const _cairoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAIRO_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function cairoParts(d) {
  const o = {};
  for (const p of _cairoFmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';        // حارس: بعض المحركات بترجّع 24
  return o;
}
function cairoOffsetMinutes(d) {             // ١٨٠ صيفًا · ١٢٠ شتاءً
  const p = cairoParts(d);
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day,
                              +p.hour, +p.minute, +p.second) - d.getTime()) / 60000);
}
function cairoDate() { const p = cairoParts(new Date()); return `${p.year}-${p.month}-${p.day}`; }
// حدود يوم تقويمي بالقاهرة → UTC — الإزاحة تتقاس عند **ظهر** اليوم
function cairoDayBoundsUTC(dateStr) {
  const offMin = cairoOffsetMinutes(new Date(`${dateStr}T12:00:00.000Z`));
  return {
    start: new Date(Date.parse(`${dateStr}T00:00:00.000Z`) - offMin * 60000).toISOString(),
    end:   new Date(Date.parse(`${dateStr}T23:59:59.999Z`) - offMin * 60000).toISOString(),
  };
}

// ─── §HELPERS::assertEnv ───
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
  bosta:   ['BOSTA_API_KEY'],
  stock:   ['LOCATION_ID'],
};

function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB) missing.push('DB (D1 binding)');
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من ` +
      `Dashboard → Settings → Variables ثم Promote النسخة. (شغّل ?action=diag)`
    );
  }
}

// LOCATION_ID ناقص بيتحوّل لـ gid://.../undefined ويفشل جوّه الميوتيشن — نوقف قبلها برسالة باسمه.
function requireLocationId(env) {
  const id = String(env.LOCATION_ID ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('LOCATION_ID غير مضبوط أو غير صالح — راجع [vars] في wrangler.toml');
  }
  return `gid://shopify/Location/${id}`;
}

function numericId(gid) { return String(gid || '').split('/').pop(); }

// بصمة قصيرة للسر — للتأكد إن كل أعضاء المجموعة على نفس القيمة (constants §6).
async function secretFingerprint(secret) {
  if (!secret) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(buf)].slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// ══════════════════════════════════════════════════════════════
// §SHARED — copy verbatim from references/shared-functions.md — never modify
// ══════════════════════════════════════════════════════════════
// SHARED: Auth & Logging Functions — EcomModa D1 Pattern v1.3.0

/**
 * Verify employee and return display_name if correct.
 * Updates last_login automatically.
 * Returns: string (display_name) or null if wrong PIN.
 * Throws: Error if account is suspended.
 */
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;

  if (!row.is_active) {
    throw new Error('الحساب موقوف — تواصل مع المسؤول');
  }

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

/**
 * Check if employee exists and has a PIN registered.
 * Used in Login screen to decide: normal login vs first-time PIN setup.
 */
async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return {
    exists:   true,
    hasPin:   !!row.pin,
    isActive: !!row.is_active,
  };
}

/**
 * Register PIN for the first time.
 * Throws if: user not found / suspended / already has PIN.
 */
async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?')
    .bind(pin, username)
    .run();

  return true;
}

/**
 * Write a log entry to D1.
 * Only tool and type are required. All other fields optional (null if not provided).
 * §LOG-REG (worker-builder Step 7-ج): مفيش رفض كتابة أبدًا — القيمة غير المسجّلة
 * بتتكتب برضه وبتاخد extra._unregistered وبتتسجّل في log_value_alerts بعد الكتابة.
 */
async function writeLog(db, entry) {
  const unregistered = !isRegisteredLogValue(entry.tool, entry.type);
  const extra = unregistered
    ? { ...(entry.extra || {}), _unregistered: true }
    : entry.extra;

  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    extra ? JSON.stringify(extra) : null
  ).run();

  if (unregistered) await noteUnregisteredLogValues(db, [entry]);
}

/**
 * بنّاء شرط الفلترة الموحّد للسجل — التلات دوال تحته بتستخدمه.
 * login/logout مستثنيين في SQL دايمًا — مش client-side.
 */
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

/**
 * Fetch logs from D1 with server-side filtering + pagination (max 100/page).
 * ⚠️ Do NOT use this for XLSX export — use getLogsExport() instead.
 */
async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا**.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee', orderName: 'order_name',
  machine: `json_extract(extra, '$.machine')`, result: `json_extract(extra, '$.result')`,
};
// مفاتيح خاصة بالأداة دي — إضافة فوق الكتلة المشتركة (مش تعديل عليها).
Object.assign(LOG_SORT_COLUMNS, {
  sku: 'sku', productTitle: 'product_title', type: 'type',
  delta: 'delta', valueBefore: 'value_before', valueAfter: 'value_after',
  defectId: `CAST(json_extract(extra, '$.defectId') AS INTEGER)`,
});

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

/** Count total matching log rows — بنفس فلاتر getLogs/getLogsExport بالظبط. */
async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * Fetch all matching logs for XLSX export — up to LOG_EXPORT_MAX rows.
 * ⚠️ بتقص في السكوت — الـ endpoint لازم يرجّع cap/total/truncated.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/** بيقرا فلاتر السجل من الـ query string — CSV للقوايم. */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}
// END SHARED BLOCK

// ─── §HELPERS::safeWriteLog — فشل D1 يبان (Step 5A ⑦) ───
// بترجّع true/false — العملية الأساسية حصلت بغض النظر. الواجهة بتحذّر لو false.
async function safeWriteLog(env, entry) {
  try {
    await writeLog(env.DB, { tool: TOOL_NAME, ...entry });
    return true;
  } catch (e) {
    console.error('writeLog failed', e?.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════════════
// ⚠️ التوكن مشترك بين كل Workers الستاك (نفس الـ Custom App) — ومعاه نفس
//    ميزانية تكلفة GraphQL. → worker-builder Step 5A ⑯
const OAUTH_MAX_ATTEMPTS = 3;

async function getAccessToken(env) {
  let lastErr = null;
  for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(
        `https://${env.SHOP_DOMAIN}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id:     env.CLIENT_ID,
            client_secret: env.CLIENT_SECRET,
            grant_type:    'client_credentials',
          }),
        }
      );
      if (!resp.ok) {
        const retriable = resp.status === 429 || resp.status >= 500;
        lastErr = new Error(`OAuth failed: ${resp.status}`);
        if (retriable && attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
        throw lastErr;
      }
      const data = await resp.json();
      if (!data.access_token) throw new Error('No access_token in response');
      return data.access_token;
    } catch (e) {
      lastErr = e;
      if (attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('OAuth: فشل غير معروف');
}

// ─── §SHOPIFY::shopifyGQL — العقد الإلزامي، انسخها كما هي ───
// أي فشل بيترمي. مفيش رد بيعدّي وهو فاشل:
//   ① فشل شبكة  ② HTTP status  ③ رد مش JSON  ④ data.errors  ⑤ data فاضية
// ⚠️ رسايل الأخطاء هنا مربوطة بـ UNKNOWN_OUTCOME_RE تحت (تصنيف «معرفناش النتيجة»).
let _lastThrottle = null, _lastQueryCost = null;

async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify', costLog = null) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);

    if (data.extensions?.cost) {
      const c = data.extensions.cost;
      if (c.throttleStatus) _lastThrottle = c.throttleStatus;
      _lastQueryCost = { op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null };
      if (costLog) costLog.push({ op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null });
    }
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}

// ─── §SHOPIFY::variants — البحث والقراءة ───
// 🔴 الموقوف = مش موجود. المنتج أو المقاس معلَّم `custom.suspended = "true"` (نص مش boolean).
//    العلامة نسخة مخزّنة مش مصدر حقيقة (constants §1) — نفس سلوك أداة الجرد.
function isSuspendedNode(v) {
  return v.suspended?.value === 'true'
      || v.product?.suspended?.value === 'true';
}

// الرصيد بيتقرا من `inventoryLevel(locationId:)` صراحةً (مش inventoryLevels(first:1)).
const VARIANT_FIELDS = `
  id sku barcode title displayName
  suspended: metafield(namespace: "custom", key: "suspended") { value }
  selectedOptions { name value }
  product {
    id title status vendor
    suspended: metafield(namespace: "custom", key: "suspended") { value }
    featuredImage { url altText }
  }
  inventoryItem {
    id tracked
    inventoryLevel(locationId: $loc) {
      quantities(names: ["available", "committed", "on_hand"]) { name quantity }
    }
  }
`;

function quantityOf(level, name) {
  const q = level?.quantities?.find(x => x.name === name);
  return q ? q.quantity : null;
}

// شكل موحّد للواجهة — الـ IDs أرقام مجرّدة (الـ gid بيتبني وقت الاستخدام).
function normalizeVariant(node) {
  const level = node.inventoryItem?.inventoryLevel || null;
  const v = {
    variantId:       numericId(node.id),
    inventoryItemId: numericId(node.inventoryItem?.id),
    productId:       numericId(node.product?.id),
    sku:             node.sku || '',
    barcode:         node.barcode || '',
    productTitle:    node.product?.title || '',
    variantTitle:    node.title || '',
    displayName:     node.displayName || '',
    options:         (node.selectedOptions || []).map(o => ({ name: o.name, value: o.value })),
    imageUrl:        node.product?.featuredImage?.url || null,
    productStatus:   node.product?.status || null,
    suspended:       isSuspendedNode(node),
    tracked:         node.inventoryItem?.tracked === true,
    hasLevel:        !!level,
    available:       quantityOf(level, 'available'),
    committed:       quantityOf(level, 'committed'),
    onHand:          quantityOf(level, 'on_hand'),
  };
  v.ineligibleReason = variantIneligibleReason(v);
  return v;
}

function variantIneligibleReason(v) {
  if (v.suspended)  return 'المنتج ده موقوف';
  if (!v.sku)       return 'المنتج ده من غير SKU';
  if (!v.tracked)   return 'مخزون المنتج ده مش متتبَّع في شوبيفاي — مينفعش يتخصم منه';
  if (!v.hasLevel)  return 'المنتج ده مش مفعّل في موقع المخزن';
  return null;
}

function cleanSearch(s) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
}

async function listSkus(env, token, search) {
  const esc = search.replace(/"/g, '\\"');
  const q = search.includes('/') ? `sku:"${esc}"` : `sku:${esc}* OR product_title:*${esc}*`;
  const gql = `
    query ListVariants($q: String, $loc: ID!) {
      productVariants(first: ${SEARCH_PAGE_SIZE}, query: $q, sortKey: SKU) {
        nodes { ${VARIANT_FIELDS} }
      }
    }`;
  const data = await shopifyGQL(env, token, gql, { q, loc: requireLocationId(env) }, 'listSkus');
  return data.data.productVariants.nodes.filter(n => !isSuspendedNode(n)).map(normalizeVariant);
}

async function lookupBarcode(env, token, barcode) {
  const gql = `
    query LookupBarcode($q: String!, $loc: ID!) {
      productVariants(first: ${BARCODE_MAX_MATCH}, query: $q) {
        nodes { ${VARIANT_FIELDS} }
      }
    }`;
  const esc = barcode.replace(/"/g, '\\"');
  const data = await shopifyGQL(env, token, gql, { q: `barcode:"${esc}"`, loc: requireLocationId(env) }, 'lookupBarcode');
  // مطابقة تامة بس — بحث شوبيفاي بالباركود ممكن يرجّع قريب.
  return data.data.productVariants.nodes
    .filter(n => n.barcode === barcode && !isSuspendedNode(n))
    .map(normalizeVariant);
}

async function fetchVariant(env, token, variantId) {
  const gql = `
    query VariantNode($ids: [ID!]!, $loc: ID!) {
      nodes(ids: $ids) { ... on ProductVariant { ${VARIANT_FIELDS} } }
    }`;
  const data = await shopifyGQL(env, token, gql,
    { ids: [`gid://shopify/ProductVariant/${variantId}`], loc: requireLocationId(env) }, 'fetchVariant');
  const node = data.data.nodes?.[0];
  return node && node.id ? normalizeVariant(node) : null;
}

// ─── §SHOPIFY::adjust — تعديل available بـ delta + مفتاح idempotency ───
// خطأ عملية المخزون له نوعين، والفرق بينهم هو اللي بيحدد إعادة المحاولة:
//   rejected = شوبيفاي رفضت صراحةً → مفيش أي أثر على المخزون
//   unknown  = النداء ممكن يكون وصل ومعرفناش النتيجة → إعادة بنفس المفتاح آمنة
class StockError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}
// ⚠️ مربوطة برسايل shopifyGQL فوق. «idempotency in progress» معناها طلب تاني شغّال
//    بنفس المفتاح — مش رفض، فتتصنّف unknown.
const UNKNOWN_OUTCOME_RE = /فشل الاتصال|ردّت HTTP|مش JSON|بدون data|idempoten|in progress|being processed/i;

async function shopifyAdjustAvailable(env, token, { inventoryItemId, delta, reason, refUri, key, costLog }) {
  // المفتاح بيتلزق في نص الاستعلام كـ literal — لازم شكله محكوم.
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(key)) throw new Error('idempotency key غير صالح');
  const locationId = requireLocationId(env);
  const query = `
    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: ${JSON.stringify(key)}) {
        userErrors { field message code }
        inventoryAdjustmentGroup { createdAt reason changes { name delta quantityAfterChange } }
      }
    }`;
  let data;
  try {
    data = await shopifyGQL(env, token, query, {
      input: {
        reason,
        name: 'available',
        referenceDocumentUri: refUri,
        changes: [{ delta, inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`, locationId }],
      },
    }, 'inventoryAdjustQuantities', costLog);
  } catch (e) {
    throw new StockError(e.message, UNKNOWN_OUTCOME_RE.test(e.message) ? 'unknown' : 'rejected');
  }
  const result = data.data?.inventoryAdjustQuantities;
  const errs   = result?.userErrors || [];
  if (errs.length) {
    const msg = errs.map(e => e.message).join(' | ');
    throw new StockError('inventoryAdjustQuantities: ' + msg, UNKNOWN_OUTCOME_RE.test(msg) ? 'unknown' : 'rejected');
  }
  // ③ تأكيد الـ payload — مجموعة تعديل فاضية أو بدلتا مختلفة معناها إن حاجة ما حصلتش زي المطلوب
  const group  = result?.inventoryAdjustmentGroup;
  const change = group?.changes?.find(c => c.name === 'available');
  if (!change || change.delta !== delta) {
    throw new StockError('inventoryAdjustQuantities: شوبيفاي ما أكدتش تعديل الكمية', 'unknown');
  }
  return { createdAt: group.createdAt, delta: change.delta, quantityAfterChange: change.quantityAfterChange ?? null };
}

// ══════════════════════════════════════════════════════════════
// §DEFECTS — الديفوهات
// ══════════════════════════════════════════════════════════════

// ─── §DEFECTS::normalize — توحيد اسم نوع العيب (منع التكرار بتهجئة مختلفة) ───
function normalizeTypeName(raw) {
  return String(raw ?? '').normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function typeNameKey(name) {
  return normalizeTypeName(name).toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')   // تشكيل + تطويل
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

// ─── §DEFECTS::shape — شكل الصف للواجهة ───
const DEFECT_SELECT = `
  SELECT d.*, t.name AS type_name,
         (SELECT COUNT(*) FROM defect_images i WHERE i.defect_id = d.id) AS image_count
  FROM defects d LEFT JOIN defect_types t ON t.id = d.defect_type_id`;

function shapeDefect(r) {
  return {
    id:              r.id,
    requestId:       r.request_id,
    variantId:       r.variant_id,
    sku:             r.sku,
    barcode:         r.barcode,
    productTitle:    r.product_title,
    variantTitle:    r.variant_title,
    defectTypeId:    r.defect_type_id,
    defectTypeName:  r.type_name ?? null,
    repairable:      !!r.repairable,
    side:            r.side,
    origin:          r.origin,
    notes:           r.notes,
    status:          r.status,
    deductState:     r.deduct_state,
    restockState:    r.restock_state,
    pendingOp:       r.pending_op ?? null,
    createdAt:       r.created_at,
    createdBy:       r.created_by,
    statusChangedAt: r.status_changed_at,
    statusChangedBy: r.status_changed_by,
    deductedAt:      r.deducted_at,
    restockedAt:     r.restocked_at,
    cancelledAt:     r.cancelled_at,
    cancelledBy:     r.cancelled_by,
    availableBefore: r.available_before,
    availableAfter:  r.available_after,
    imageCount:      r.image_count ?? 0,
  };
}

async function getDefectById(db, id) {
  return await db.prepare(`${DEFECT_SELECT} WHERE d.id = ?`).bind(id).first();
}
async function getDefectByRequestId(db, requestId) {
  return await db.prepare(`${DEFECT_SELECT} WHERE d.request_id = ?`).bind(requestId).first();
}

// ─── §DEFECTS::outcome — رد موحّد ───
// HTTP 200 دايمًا لنتيجة العملية؛ الواجهة بتتفرّع على `status`:
//   success · warning · error · rejected · already  (constants §12)
//   + needs_decision: الرصيد 0 — مفيش كتابة اتعملت، الموظف لازم يقرر (إلغاء / تسجيل بدون خصم)
function outcome(request, status, message, extra = {}) {
  return json({ ok: true, status, message, ...extra }, 200, request);
}

async function requireEmployee(db, username) {
  const u = String(username ?? '').trim();
  if (!u) throw new BadRequest('employee مطلوب');
  const row = await db.prepare('SELECT is_active FROM employees WHERE username = ?').bind(u).first();
  if (!row)           throw new BadRequest('الموظف غير موجود');
  if (!row.is_active) throw new BadRequest('الحساب موقوف — تواصل مع المسؤول');
  return u;
}

function parseId(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`${label} غير صالح`);
  return n;
}

// رفض قبل أي محاولة: صف سجل واحد type='rejected' (Step 5A ⑭) + رد بالحالة.
async function rejectWith(request, env, { employee, message, result = 'rejected', stage = 'preflight', defect = null, extra = {}, sku, productTitle }) {
  const logged = await safeWriteLog(env, {
    type: 'rejected', employee,
    sku: sku ?? defect?.sku ?? null,
    productTitle: productTitle ?? defect?.product_title ?? null,
    notes: message,
    extra: { result, stage, defectId: defect?.id ?? null, ...extra },
  });
  // الصف الكامل بس (فيه request_id) — صفوف الفحص الجزئية مالهاش شكل للواجهة
  return outcome(request, result, message, { logged, ...(defect?.request_id ? { defect: shapeDefect(defect) } : {}) });
}

const stockLabel = (v) => `${v.sku}${v.productTitle ? ' — ' + v.productTitle : ''}`;

// ─── §DEFECTS::stockOp — عملية مخزون واحدة بمفتاح ثابت ───
// الحالات: done | rejected (مفيش أثر) | unknown (ممكن تكون اتنفّذت).
async function runStockOp(env, token, row, op) {
  const spec = STOCK_OPS[op];
  const costLog = [];
  try {
    const res = await shopifyAdjustAvailable(env, token, {
      inventoryItemId: row.inventory_item_id,
      delta:  spec.delta,
      reason: spec.reason,
      refUri: `gid://Defect-Products/Defect/${row.id}`,
      key:    `${row.request_id}:${spec.keySuffix}`,
      costLog,
    });
    return { state: 'done', ...res, costLog };
  } catch (e) {
    if (e instanceof StockError) return { state: e.kind, error: e.message, costLog };
    return { state: 'unknown', error: e.message, costLog };
  }
}

const isFreshEnough = (iso) => iso && (Date.now() - Date.parse(iso)) <= RETRY_WINDOW_MS;

// ─── §DEFECTS::register ───
function validateRegisterInput(body) {
  const requestId = String(body.requestId ?? '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new BadRequest('requestId غير صالح');
  const variantId = String(body.variantId ?? '').trim();
  if (!/^\d{5,20}$/.test(variantId)) throw new BadRequest('variantId غير صالح');
  const defectTypeId = parseId(body.defectTypeId, 'نوع العيب');
  if (typeof body.repairable !== 'boolean') throw new BadRequest('«قابل للإصلاح» لازم يتحدد');
  if (!SIDES.includes(body.side))     throw new BadRequest('«أي فردة» لازم تتحدد');
  if (!ORIGINS.includes(body.origin)) throw new BadRequest('«جديد/مرتجع» لازم يتحدد');
  const notes = body.notes == null ? null : String(body.notes).trim();
  if (notes && notes.length > NOTES_MAX) throw new BadRequest(`الملاحظات أطول من ${NOTES_MAX} حرف`);
  const stockMode = body.stockMode == null ? 'deduct' : body.stockMode;
  if (stockMode !== 'deduct' && stockMode !== 'skip') throw new BadRequest('stockMode غير صالح');
  return { requestId, variantId, defectTypeId, repairable: body.repairable, side: body.side,
           origin: body.origin, notes: notes || null, stockMode };
}

async function registerDefect(request, env, body) {
  const employee = await requireEmployee(env.DB, body.employee);
  const input    = validateRegisterInput(body);
  assertEnv(env, 'shopify', 'stock');

  // إعادة نفس الطلب (ضغطة مكررة / ريتراي) — قبل أي قراءة من شوبيفاي.
  const existing = await getDefectByRequestId(env.DB, input.requestId);
  if (existing) return replayRegister(request, env, employee, existing);

  const typeRow = await env.DB.prepare('SELECT id, name, is_active FROM defect_types WHERE id = ?')
    .bind(input.defectTypeId).first();
  if (!typeRow || !typeRow.is_active) {
    return rejectWith(request, env, { employee, message: 'نوع العيب مش موجود أو متوقف' });
  }

  const token = await getAccessToken(env);
  const v = await fetchVariant(env, token, input.variantId);
  if (!v) return rejectWith(request, env, { employee, stage: 'lookup', message: 'المنتج مش موجود على شوبيفاي' });
  if (v.ineligibleReason) {
    return rejectWith(request, env, { employee, stage: 'lookup', message: v.ineligibleReason, sku: v.sku, productTitle: v.productTitle });
  }

  const available = v.available ?? 0;
  if (input.stockMode === 'deduct' && available < 1) {
    // مفيش كتابة: الموظف يقرر (إلغاء / تسجيل بدون خصم) ويبعت نفس الطلب بـ stockMode='skip'.
    return outcome(request, 'needs_decision',
      `الرصيد المتاح لـ ${stockLabel(v)} = ${available} — مفيش وحدة تتخصم. تسجّله بدون خصم من الستوك؟`,
      { reason: 'zero_stock', available, variant: v });
  }
  if (input.stockMode === 'skip' && available >= 1) {
    return rejectWith(request, env, { employee, stage: 'lookup', sku: v.sku, productTitle: v.productTitle,
      message: `الرصيد المتاح ${available} — لازم القطعة تتخصم من الستوك` });
  }

  const skip = input.stockMode === 'skip';
  const now  = new Date().toISOString();
  const status = input.repairable ? STATUS.AWAITING : STATUS.UNREPAIRABLE;

  try {
    await env.DB.prepare(`
      INSERT INTO defects
        (request_id, variant_id, inventory_item_id, product_id, sku, barcode, product_title, variant_title,
         defect_type_id, repairable, side, origin, notes, status, deduct_state, restock_state,
         created_at, created_by, available_before)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.requestId, v.variantId, v.inventoryItemId, v.productId, v.sku, v.barcode || null,
      v.productTitle, v.variantTitle || null,
      input.defectTypeId, input.repairable ? 1 : 0, input.side, input.origin, input.notes,
      status, skip ? DEDUCT.SKIPPED : DEDUCT.PENDING, RESTOCK.NONE,
      now, employee, available
    ).run();
  } catch (e) {
    // سباق: طلب بنفس الـ requestId دخل بين الفحص والإدخال.
    if (/UNIQUE/i.test(e.message)) {
      const again = await getDefectByRequestId(env.DB, input.requestId);
      if (again) return replayRegister(request, env, employee, again);
    }
    throw e;
  }

  const row = await env.DB.prepare('SELECT * FROM defects WHERE request_id = ?').bind(input.requestId).first();

  if (skip) {
    const logged = await safeWriteLog(env, {
      type: 'registered', employee, sku: v.sku, productTitle: v.productTitle,
      delta: 0, valueBefore: available, valueAfter: available,
      notes: `${stockLabel(v)} — اتسجّل بدون خصم (الرصيد 0)`,
      extra: { result: 'success', stage: 'write', defectId: row.id, requestId: input.requestId, stockMode: 'skip',
               side: input.side, origin: input.origin, repairable: input.repairable, defectType: typeRow.name },
    });
    const fresh = await getDefectById(env.DB, row.id);
    return outcome(request, 'success',
      'اتسجّل الديفو بدون خصم من الستوك (الرصيد كان 0).', { defect: shapeDefect(fresh), actions: ['سجل ديفو بدون خصم'], logged });
  }

  return finishDeduct(request, env, token, employee, row, v, typeRow.name, { first: true });
}

// إعادة طلب تسجيل موجود: متنفّذ → already؛ معلّق → إعادة بنفس المفتاح (آمنة) خلال النافذة.
async function replayRegister(request, env, employee, existing) {
  if (existing.deduct_state === DEDUCT.DONE || existing.deduct_state === DEDUCT.SKIPPED) {
    return rejectWith(request, env, { employee, result: 'already', stage: 'preflight', defect: existing,
      message: 'الديفو ده اتسجّل قبل كده — مفيش حاجة مطلوبة' });
  }
  if (!isFreshEnough(existing.created_at)) {
    return rejectWith(request, env, { employee, result: 'rejected', stage: 'preflight', defect: existing,
      message: 'خصم المخزون للقطعة دي لسه غير مؤكد من وقت طويل — راجع تاريخ المخزون في شوبيفاي (المرجع Defect/' + existing.id + ') قبل أي إعادة' });
  }
  assertEnv(env, 'shopify', 'stock');
  const token = await getAccessToken(env);
  const v = { sku: existing.sku, productTitle: existing.product_title, available: existing.available_before };
  return finishDeduct(request, env, token, employee, existing, v, existing.type_name ?? null, { first: false });
}

// تنفيذ الخصم + تحديث الحالة + سجل واحد. first=true → فشل صريح بيمسح الصف (مفيش أثر).
async function finishDeduct(request, env, token, employee, row, v, typeName, { first }) {
  const res = await runStockOp(env, token, row, 'deduct');
  const baseExtra = { defectId: row.id, requestId: row.request_id, stockMode: 'deduct', defectType: typeName,
                      side: row.side, origin: row.origin, repairable: !!row.repairable, queryCost: res.costLog };

  if (res.state === 'done') {
    const after = res.quantityAfterChange ?? (row.available_before != null ? row.available_before - 1 : null);
    let dbOk = true;
    try {
      await env.DB.prepare(`UPDATE defects SET deduct_state = ?, deducted_at = ?, available_after = ? WHERE id = ?`)
        .bind(DEDUCT.DONE, new Date().toISOString(), after, row.id).run();
    } catch (e) { dbOk = false; }
    const logged = await safeWriteLog(env, {
      type: 'registered', employee, sku: row.sku, productTitle: row.product_title,
      delta: -1, valueBefore: row.available_before, valueAfter: after,
      notes: `${stockLabel(v)} — خصم 1 من المخزون`,
      extra: { ...baseExtra, result: dbOk ? 'success' : 'warning', stage: 'write', stockOpAt: res.createdAt },
    });
    const fresh = await getDefectById(env.DB, row.id);
    if (!dbOk) {
      return outcome(request, 'warning',
        'اتخصم 1 من شوبيفاي لكن تحديث السجل المحلي فشل — أعد الضغط بنفس الطلب (آمن، مش هيخصم تاني).',
        { defect: shapeDefect(fresh), actions: ['خصم 1 من المخزون'], logged });
    }
    return outcome(request, 'success', 'اتسجّل الديفو واتخصم 1 من المخزون.',
      { defect: shapeDefect(fresh), actions: ['خصم 1 من المخزون'], logged });
  }

  if (res.state === 'rejected') {
    // شوبيفاي رفضت صراحةً → مفيش أثر. أول محاولة: نمسح الصف (مفيش ديفو بدون خصم) ؛ ريتراي: نسيبه.
    if (first) {
      try { await env.DB.prepare('DELETE FROM defects WHERE id = ? AND deduct_state = ?').bind(row.id, DEDUCT.PENDING).run(); }
      catch (e) { /* الصف هيفضل pending — الريتراي بنفس الطلب هيكمّل */ }
    }
    const logged = await safeWriteLog(env, {
      type: 'registered', employee, sku: row.sku, productTitle: row.product_title,
      notes: `${stockLabel(v)} — شوبيفاي رفضت الخصم: ${res.error}`,
      extra: { ...baseExtra, result: 'error', stage: 'write', error: res.error },
    });
    return outcome(request, 'error', `شوبيفاي رفضت خصم المخزون — ${res.error}`, { logged });
  }

  // unknown — النداء ممكن يكون وصل
  try {
    await env.DB.prepare('UPDATE defects SET deduct_state = ? WHERE id = ? AND deduct_state IN (?, ?)')
      .bind(DEDUCT.UNCONFIRMED, row.id, DEDUCT.PENDING, DEDUCT.UNCONFIRMED).run();
  } catch (e) { /* مش حرج */ }
  const logged = await safeWriteLog(env, {
    type: 'registered', employee, sku: row.sku, productTitle: row.product_title,
    notes: `${stockLabel(v)} — خصم المخزون غير مؤكد: ${res.error}`,
    extra: { ...baseExtra, result: 'warning', stage: 'write', error: res.error, unconfirmed: true },
  });
  const fresh = await getDefectById(env.DB, row.id);
  return outcome(request, 'warning',
    'ماعرفناش نتأكد إن الخصم اتنفّذ. متضغطش «تسجيل» من جديد — استخدم «إعادة المحاولة» لنفس الديفو (آمنة ومش هتخصم مرتين).',
    { defect: shapeDefect(fresh), error: res.error, retryable: true, logged });
}

// ─── §DEFECTS::status — تغيير الحالة (اتصلح · غير قابل للإصلاح · رجوع لقابل للإصلاح) ───
async function setStatus(request, env, body) {
  const employee = await requireEmployee(env.DB, body.employee);
  const defectId = parseId(body.defectId, 'defectId');
  const target   = String(body.status ?? '');
  if (![STATUS.REPAIRED, STATUS.UNREPAIRABLE, STATUS.AWAITING].includes(target)) throw new BadRequest('الحالة المطلوبة غير صالحة');

  const row = await env.DB.prepare('SELECT * FROM defects WHERE id = ?').bind(defectId).first();
  if (!row) return rejectWith(request, env, { employee, stage: 'lookup', message: 'الديفو مش موجود' });

  if (row.status === STATUS.CANCELLED) return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'التسجيل ده اتلغى' });
  if (row.status === STATUS.REPAIRED) {
    const already = target === STATUS.REPAIRED;
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', result: already ? 'already' : 'rejected',
      message: already ? 'القطعة دي اتصلحت قبل كده — مفيش حاجة مطلوبة' : 'القطعة اتصلحت — الحالة دي نهائية' });
  }
  if (row.status === target) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', result: 'already', message: 'القطعة دي بالحالة دي أصلًا — مفيش حاجة مطلوبة' });
  }
  // عملية مخزون معلّقة (إصلاح/إلغاء شغّال) — مفيش تغيير حالة جنبها
  if (row.restock_state !== RESTOCK.NONE && !(target === STATUS.REPAIRED && row.pending_op === 'repair')) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'فيه عملية مخزون شغّالة على القطعة دي لسه ما خلصتش' });
  }

  if (target === STATUS.REPAIRED) return repairDefect(request, env, employee, row);

  // unrepairable ↔ awaiting_repair — تغيير حالة بس، مالوش أثر على المخزون
  const from = row.status;
  if (!(from === STATUS.AWAITING || from === STATUS.UNREPAIRABLE)) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'التغيير ده مش مسموح من الحالة الحالية' });
  }
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`
    UPDATE defects SET status = ?, repairable = ?, status_changed_at = ?, status_changed_by = ?
    WHERE id = ? AND status = ? AND restock_state = ?`)
    .bind(target, target === STATUS.AWAITING ? 1 : 0, now, employee, row.id, from, RESTOCK.NONE).run();
  if (!res.meta?.changes) {
    const fresh = await getDefectById(env.DB, row.id);
    return rejectWith(request, env, { employee, defect: fresh, stage: 'write', result: 'rejected', message: 'الحالة اتغيّرت من موظف تاني — حدّث الصفحة' });
  }
  const logged = await safeWriteLog(env, {
    type: 'status_changed', employee, sku: row.sku, productTitle: row.product_title,
    notes: `${row.sku} — ${from} ← ${target}`,
    extra: { result: 'success', stage: 'write', defectId: row.id, from, to: target },
  });
  const fresh = await getDefectById(env.DB, row.id);
  return outcome(request, 'success', target === STATUS.UNREPAIRABLE ? 'اتعلّمت غير قابلة للإصلاح.' : 'اتعلّمت قابلة للإصلاح.',
    { defect: shapeDefect(fresh), logged });
}

// اتصلح: +1 للستوك (لو الخصم كان تم)، وبعدين الحالة نهائية.
async function repairDefect(request, env, employee, row) {
  if (row.status !== STATUS.AWAITING) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'لازم القطعة تكون «قابلة للإصلاح» الأول' });
  }
  const now = new Date().toISOString();

  if (row.deduct_state === DEDUCT.SKIPPED) {
    // ما اتخصمتش أصلًا → مفيش إضافة للستوك
    const res = await env.DB.prepare(`
      UPDATE defects SET status = ?, status_changed_at = ?, status_changed_by = ?
      WHERE id = ? AND status = ?`).bind(STATUS.REPAIRED, now, employee, row.id, STATUS.AWAITING).run();
    if (!res.meta?.changes) {
      const fresh = await getDefectById(env.DB, row.id);
      return rejectWith(request, env, { employee, defect: fresh, stage: 'write', message: 'الحالة اتغيّرت من موظف تاني — حدّث الصفحة' });
    }
    const logged = await safeWriteLog(env, {
      type: 'repaired', employee, sku: row.sku, productTitle: row.product_title, delta: 0,
      notes: `${row.sku} — اتصلحت (مسجّلة بدون خصم، فمفيش إضافة للستوك)`,
      extra: { result: 'success', stage: 'write', defectId: row.id, stockMode: 'skip' },
    });
    const fresh = await getDefectById(env.DB, row.id);
    return outcome(request, 'success', 'اتسجّلت اتصلحت. القطعة دي اتسجّلت بدون خصم فمفيش حاجة اتضافت للستوك.',
      { defect: shapeDefect(fresh), logged });
  }
  if (row.deduct_state !== DEDUCT.DONE) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'خصم المخزون للقطعة دي لسه غير مؤكد — مينفعش تتسجّل اتصلحت قبل ما يتأكد' });
  }
  return stockReturn(request, env, employee, row, { op: 'repair', finalStatus: STATUS.REPAIRED,
    doneMsg: 'اتسجّلت اتصلحت واتضاف 1 للستوك.', noteWord: 'اتصلحت — إضافة 1 للستوك' });
}

// رجوع الكمية للستوك (اتصلح / إلغاء) — claim ذرّي + عملية مخزون بمفتاح ثابت + إنهاء الحالة.
async function stockReturn(request, env, employee, row, { op, finalStatus, doneMsg, noteWord }) {
  assertEnv(env, 'shopify', 'stock');
  const now = new Date().toISOString();

  if (row.restock_state === RESTOCK.NONE) {
    const claim = await env.DB.prepare(`
      UPDATE defects SET restock_state = ?, pending_op = ?, status_changed_at = ?, status_changed_by = ?
      WHERE id = ? AND restock_state = ? AND status IN (?, ?)`)
      .bind(RESTOCK.PENDING, op, now, employee, row.id, RESTOCK.NONE, STATUS.AWAITING, STATUS.UNREPAIRABLE).run();
    if (!claim.meta?.changes) {
      const fresh = await getDefectById(env.DB, row.id);
      return rejectWith(request, env, { employee, defect: fresh, stage: 'write', message: 'الحالة اتغيّرت من موظف تاني — حدّث الصفحة' });
    }
  } else {
    // ريتراي لعملية معلّقة — بنفس المفتاح — جوه نافذة الأمان بس
    if (row.pending_op !== op) {
      return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'فيه عملية مخزون تانية شغّالة على القطعة دي' });
    }
    if (!isFreshEnough(row.status_changed_at)) {
      return rejectWith(request, env, { employee, defect: row, stage: 'lookup',
        message: 'عملية المخزون دي لسه غير مؤكدة من وقت طويل — راجع تاريخ المخزون في شوبيفاي (المرجع Defect/' + row.id + ') قبل أي إعادة' });
    }
  }

  const token = await getAccessToken(env);
  const res = await runStockOp(env, token, row, op);
  const baseExtra = { defectId: row.id, requestId: row.request_id, op, queryCost: res.costLog };

  if (res.state === 'done') {
    const done = new Date().toISOString();
    let dbOk = true;
    try {
      await env.DB.prepare(`
        UPDATE defects SET status = ?, restock_state = ?, pending_op = NULL, restocked_at = ?,
          status_changed_at = ?, status_changed_by = ?,
          cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
          cancelled_by = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_by END
        WHERE id = ?`)
        .bind(finalStatus, RESTOCK.DONE, done, done, employee, finalStatus, done, finalStatus, employee, row.id).run();
    } catch (e) { dbOk = false; }
    const logged = await safeWriteLog(env, {
      type: op === 'repair' ? 'repaired' : 'cancelled', employee, sku: row.sku, productTitle: row.product_title,
      delta: 1, valueAfter: res.quantityAfterChange,
      notes: `${row.sku} — ${noteWord}`,
      extra: { ...baseExtra, result: dbOk ? 'success' : 'warning', stage: 'write' },
    });
    const fresh = await getDefectById(env.DB, row.id);
    if (!dbOk) {
      return outcome(request, 'warning', 'اتضاف 1 للستوك في شوبيفاي لكن تحديث السجل المحلي فشل — أعد نفس العملية (آمن، مش هيضيف تاني).',
        { defect: shapeDefect(fresh), logged });
    }
    return outcome(request, 'success', doneMsg, { defect: shapeDefect(fresh), actions: ['إضافة 1 للمخزون'], logged });
  }

  if (res.state === 'rejected') {
    try {
      await env.DB.prepare('UPDATE defects SET restock_state = ?, pending_op = NULL WHERE id = ? AND restock_state = ?')
        .bind(RESTOCK.NONE, row.id, RESTOCK.PENDING).run();
    } catch (e) { /* مش حرج */ }
    const logged = await safeWriteLog(env, {
      type: op === 'repair' ? 'repaired' : 'cancelled', employee, sku: row.sku, productTitle: row.product_title,
      notes: `${row.sku} — شوبيفاي رفضت إضافة الكمية: ${res.error}`,
      extra: { ...baseExtra, result: 'error', stage: 'write', error: res.error },
    });
    const fresh = await getDefectById(env.DB, row.id);
    return outcome(request, 'error', `شوبيفاي رفضت إضافة الكمية للستوك — ${res.error}`, { defect: shapeDefect(fresh), logged });
  }

  try {
    await env.DB.prepare('UPDATE defects SET restock_state = ? WHERE id = ? AND restock_state IN (?, ?)')
      .bind(RESTOCK.UNCONFIRMED, row.id, RESTOCK.PENDING, RESTOCK.UNCONFIRMED).run();
  } catch (e) { /* مش حرج */ }
  const logged = await safeWriteLog(env, {
    type: op === 'repair' ? 'repaired' : 'cancelled', employee, sku: row.sku, productTitle: row.product_title,
    notes: `${row.sku} — إضافة الكمية غير مؤكدة: ${res.error}`,
    extra: { ...baseExtra, result: 'warning', stage: 'write', error: res.error, unconfirmed: true },
  });
  const fresh = await getDefectById(env.DB, row.id);
  return outcome(request, 'warning',
    'ماعرفناش نتأكد إن الكمية اتضافت. أعد نفس العملية — آمنة ومش هتضيف مرتين.',
    { defect: shapeDefect(fresh), error: res.error, retryable: true, logged });
}

// ─── §DEFECTS::cancel — إلغاء تسجيل بالغلط ───
async function cancelDefect(request, env, body) {
  const employee = await requireEmployee(env.DB, body.employee);
  const defectId = parseId(body.defectId, 'defectId');
  const row = await env.DB.prepare('SELECT * FROM defects WHERE id = ?').bind(defectId).first();
  if (!row) return rejectWith(request, env, { employee, stage: 'lookup', message: 'الديفو مش موجود' });

  if (row.status === STATUS.CANCELLED) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', result: 'already', message: 'التسجيل ده اتلغى قبل كده — مفيش حاجة مطلوبة' });
  }
  if (row.status === STATUS.REPAIRED) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'القطعة اتصلحت — مينفعش يتلغى تسجيلها' });
  }
  if (row.restock_state !== RESTOCK.NONE && row.pending_op !== 'cancel') {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'فيه عملية مخزون شغّالة على القطعة دي لسه ما خلصتش' });
  }

  if (row.deduct_state === DEDUCT.SKIPPED) {
    const now = new Date().toISOString();
    const res = await env.DB.prepare(`
      UPDATE defects SET status = ?, cancelled_at = ?, cancelled_by = ?, status_changed_at = ?, status_changed_by = ?
      WHERE id = ? AND status IN (?, ?)`)
      .bind(STATUS.CANCELLED, now, employee, now, employee, row.id, STATUS.AWAITING, STATUS.UNREPAIRABLE).run();
    if (!res.meta?.changes) {
      const fresh = await getDefectById(env.DB, row.id);
      return rejectWith(request, env, { employee, defect: fresh, stage: 'write', message: 'الحالة اتغيّرت من موظف تاني — حدّث الصفحة' });
    }
    const logged = await safeWriteLog(env, {
      type: 'cancelled', employee, sku: row.sku, productTitle: row.product_title, delta: 0,
      notes: `${row.sku} — اتلغى التسجيل (كان بدون خصم، فمفيش رجوع للستوك)`,
      extra: { result: 'success', stage: 'write', defectId: row.id, stockMode: 'skip' },
    });
    const fresh = await getDefectById(env.DB, row.id);
    return outcome(request, 'success', 'اتلغى التسجيل. كان مسجّل بدون خصم فمفيش حاجة رجعت للستوك.', { defect: shapeDefect(fresh), logged });
  }
  if (row.deduct_state !== DEDUCT.DONE) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'خصم المخزون للقطعة دي لسه غير مؤكد — مينفعش يتلغى قبل ما يتأكد' });
  }
  return stockReturn(request, env, employee, row, { op: 'cancel', finalStatus: STATUS.CANCELLED,
    doneMsg: 'اتلغى التسجيل ورجع 1 للستوك.', noteWord: 'اتلغى التسجيل — رجوع 1 للستوك' });
}

// ─── §DEFECTS::types — قايمة أنواع العيب ───
async function addDefectType(request, env, body) {
  const employee = await requireEmployee(env.DB, body.employee);
  const name = normalizeTypeName(body.name);
  if (name.length < TYPE_NAME_MIN || name.length > TYPE_NAME_MAX) {
    throw new BadRequest(`اسم النوع لازم يكون بين ${TYPE_NAME_MIN} و${TYPE_NAME_MAX} حرف`);
  }
  const key = typeNameKey(name);
  const found = await env.DB.prepare('SELECT id, name, is_active FROM defect_types WHERE name_key = ?').bind(key).first();
  if (found) {
    const msg = `النوع «${found.name}» موجود أصلًا`;
    const logged = await safeWriteLog(env, {
      type: 'rejected', employee, notes: msg,
      extra: { result: 'already', stage: 'lookup', typeId: found.id },
    });
    return outcome(request, 'already', msg, { type: { id: found.id, name: found.name }, logged });
  }
  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM defect_types').first();
  if ((total?.c ?? 0) >= TYPES_TOTAL_MAX) {
    return rejectWith(request, env, { employee, message: 'عدد الأنواع وصل للحد الأقصى — اتواصل مع المسؤول' });
  }
  const now = new Date().toISOString();
  let id;
  try {
    const res = await env.DB.prepare('INSERT INTO defect_types (name, name_key, created_by, created_at) VALUES (?, ?, ?, ?)')
      .bind(name, key, employee, now).run();
    id = res.meta?.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      const again = await env.DB.prepare('SELECT id, name FROM defect_types WHERE name_key = ?').bind(key).first();
      return outcome(request, 'already', `النوع «${again?.name ?? name}» موجود أصلًا`, { type: again });
    }
    throw e;
  }
  const logged = await safeWriteLog(env, {
    type: 'defect_type_added', employee, notes: `نوع عيب جديد: ${name}`,
    extra: { result: 'success', stage: 'write', typeId: id },
  });
  return outcome(request, 'success', `اتضاف النوع «${name}».`, { type: { id, name }, logged });
}

// ══════════════════════════════════════════════════════════════
// §IMAGES — الصور (R2)
// ══════════════════════════════════════════════════════════════
// الصورة مش في D1: الملف في R2، وD1 فيه مفتاحه (key) وحجمه ونوعه بس.
// اسم الملف بيتولّد من السيرفر (UUID) — مش اسم الملف اللي الموظف رفعه.

// النوع بيتحدد من أول بايتات الملف (magic bytes) مش من Content-Type اللي جاي من العميل.
// JPEG/PNG/WebP بس. SVG ممنوع (ممكن يشيل سكربت). HEIC/AVIF بنرفضهم برسالة واضحة.
function sniffImage(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return { type: 'image/png', ext: 'png' };
  const ascii = (from, len) => String.fromCharCode(...b.slice(from, from + len));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif'].includes(brand)) return { heic: true };
  }
  return null;
}

async function addDefectImage(request, env) {
  if (!env.IMAGES) throw new Error('R2 binding IMAGES غير مضبوط — راجع wrangler.toml');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > IMAGE_MAX_BYTES + 1024 * 1024) {
    return json({ ok: true, status: 'rejected', message: `الصورة أكبر من ${IMAGE_MAX_BYTES / 1024 / 1024}MB` }, 200, request);
  }
  const ct = request.headers.get('Content-Type') || '';
  if (!/multipart\/form-data/i.test(ct)) throw new BadRequest('الرفع لازم يكون multipart/form-data');

  const fd = await request.formData();
  const employee = await requireEmployee(env.DB, fd.get('employee'));
  const defectId = parseId(fd.get('defectId'), 'defectId');
  const file = fd.get('file');
  if (!file || typeof file === 'string') throw new BadRequest('الملف مطلوب');

  const row = await env.DB.prepare('SELECT id, sku, product_title, status FROM defects WHERE id = ?').bind(defectId).first();
  if (!row) return rejectWith(request, env, { employee, stage: 'lookup', message: 'الديفو مش موجود' });
  if (row.status === STATUS.REPAIRED || row.status === STATUS.CANCELLED) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: 'الصور بتتضاف قبل الإصلاح بس' });
  }
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM defect_images WHERE defect_id = ?').bind(defectId).first();
  if ((cnt?.c ?? 0) >= IMAGES_PER_DEFECT_MAX) {
    return rejectWith(request, env, { employee, defect: row, stage: 'lookup', message: `الحد الأقصى ${IMAGES_PER_DEFECT_MAX} صور للقطعة الواحدة` });
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return rejectWith(request, env, { employee, defect: row, message: `الصورة أكبر من ${IMAGE_MAX_BYTES / 1024 / 1024}MB` });
  }
  if (file.size < 16) return rejectWith(request, env, { employee, defect: row, message: 'الملف فاضي أو تالف' });

  const buf   = await file.arrayBuffer();
  const sniff = sniffImage(new Uint8Array(buf, 0, Math.min(32, buf.byteLength)));
  if (sniff?.heic) {
    return rejectWith(request, env, { employee, defect: row, message: 'الصيغة دي (HEIC) مش مدعومة — صوّر بالكاميرا مباشرة أو اختار JPEG أو PNG' });
  }
  if (!sniff) {
    return rejectWith(request, env, { employee, defect: row, message: 'نوع الملف مش مدعوم — JPEG أو PNG أو WebP بس' });
  }

  const p   = cairoParts(new Date());
  const key = `defects/${p.year}/${p.month}/${crypto.randomUUID()}.${sniff.ext}`;
  const now = new Date().toISOString();

  // ① R2 الأول
  const obj = await env.IMAGES.put(key, buf, {
    httpMetadata:   { contentType: sniff.type },
    customMetadata: { defectId: String(defectId), employee, createdAt: now },
  });
  // الحجم الفعلي من R2 مش من Content-Length بس
  const size = obj?.size ?? buf.byteLength;
  if (size > IMAGE_MAX_BYTES) {
    await env.IMAGES.delete(key).catch(() => {});
    return rejectWith(request, env, { employee, defect: row, message: `الصورة أكبر من ${IMAGE_MAX_BYTES / 1024 / 1024}MB` });
  }

  // ② D1 بعده — لو فشل نمسح من R2 (مفيش ملفات يتيمة)
  let imageId;
  try {
    const res = await env.DB.prepare(`
      INSERT INTO defect_images (defect_id, r2_key, size_bytes, content_type, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(defectId, key, size, sniff.type, now, employee).run();
    imageId = res.meta?.last_row_id;
  } catch (e) {
    let orphan = null;
    try { await env.IMAGES.delete(key); } catch (e2) { orphan = key; }
    const logged = await safeWriteLog(env, {
      type: 'image_added', employee, sku: row.sku, productTitle: row.product_title,
      notes: `${row.sku} — فشل تسجيل الصورة: ${e.message}`,
      extra: { result: 'error', stage: 'write', defectId, error: e.message, orphanKey: orphan },
    });
    return outcome(request, orphan ? 'warning' : 'error',
      orphan ? `فشل تسجيل الصورة، وفشل مسح الملف من R2 (المفتاح: ${orphan}) — بلّغ المسؤول`
             : 'فشل تسجيل الصورة — أعد المحاولة',
      { logged, ...(orphan ? { orphanKey: orphan } : {}) });
  }

  const logged = await safeWriteLog(env, {
    type: 'image_added', employee, sku: row.sku, productTitle: row.product_title,
    notes: `${row.sku} — صورة جديدة (${Math.round(size / 1024)}KB)`,
    extra: { result: 'success', stage: 'write', defectId, imageId, sizeBytes: size, contentType: sniff.type },
  });
  return outcome(request, 'success', 'اتضافت الصورة.',
    { image: { id: imageId, defectId, sizeBytes: size, contentType: sniff.type, createdAt: now, createdBy: employee }, logged });
}

async function deleteDefectImage(request, env, body) {
  const employee = await requireEmployee(env.DB, body.employee);
  const imageId  = parseId(body.imageId, 'imageId');
  const img = await env.DB.prepare(`
    SELECT i.id, i.defect_id, i.r2_key, d.sku, d.product_title, d.status
    FROM defect_images i JOIN defects d ON d.id = i.defect_id WHERE i.id = ?`).bind(imageId).first();
  if (!img) return rejectWith(request, env, { employee, stage: 'lookup', result: 'already', message: 'الصورة مش موجودة (اتمسحت قبل كده)' });
  if (img.status === STATUS.REPAIRED || img.status === STATUS.CANCELLED) {
    return rejectWith(request, env, { employee, stage: 'lookup', sku: img.sku, productTitle: img.product_title,
      message: 'الصور بتتعدّل قبل الإصلاح بس' });
  }
  await env.DB.prepare('DELETE FROM defect_images WHERE id = ?').bind(imageId).run();
  let orphan = null;
  try { await env.IMAGES.delete(img.r2_key); } catch (e) { orphan = img.r2_key; }
  const logged = await safeWriteLog(env, {
    type: 'image_deleted', employee, sku: img.sku, productTitle: img.product_title,
    notes: `${img.sku} — اتمسحت صورة`,
    extra: { result: orphan ? 'warning' : 'success', stage: 'write', defectId: img.defect_id, imageId, orphanKey: orphan },
  });
  return outcome(request, orphan ? 'warning' : 'success',
    orphan ? `اتمسحت الصورة من السجل، لكن مسح الملف من R2 فشل (المفتاح: ${orphan}) — بلّغ المسؤول` : 'اتمسحت الصورة.',
    { imageId, logged, ...(orphan ? { orphanKey: orphan } : {}) });
}

// الصورة بتتخدم stream من R2 — مش بتتحمّل في الذاكرة. الـ bucket private،
// والـ Authorization مطلوب زي أي action (الواجهة بتعمل fetch بهيدر وتحوّل الرد لـ blob).
async function getImage(request, env, id) {
  if (!env.IMAGES) throw new Error('R2 binding IMAGES غير مضبوط — راجع wrangler.toml');
  const img = await env.DB.prepare('SELECT r2_key, content_type FROM defect_images WHERE id = ?').bind(id).first();
  if (!img) return json({ ok: false, error: 'الصورة مش موجودة' }, 404, request);
  const obj = await env.IMAGES.get(img.r2_key);
  if (!obj) return json({ ok: false, error: 'ملف الصورة مش موجود في التخزين' }, 404, request);

  const headers = new Headers(getCORS(request));
  headers.set('Content-Type', img.content_type || 'application/octet-stream');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('ETag', obj.httpEtag);
  if (request.headers.get('If-None-Match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

// ══════════════════════════════════════════════════════════════
// §REGISTRY — المخزن الرقمي (قراءة)
// ══════════════════════════════════════════════════════════════
const csvParam = (url, k) => (url.searchParams.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
const likeEsc  = (s) => String(s).replace(/[\\%_]/g, m => '\\' + m);

function defectFiltersFrom(url) {
  return {
    statuses:   csvParam(url, 'statuses').filter(s => Object.values(STATUS).includes(s)),
    types:      csvParam(url, 'types').map(Number).filter(n => Number.isInteger(n) && n > 0),
    sides:      csvParam(url, 'sides').filter(s => SIDES.includes(s)),
    origins:    csvParam(url, 'origins').filter(s => ORIGINS.includes(s)),
    deductStates: csvParam(url, 'deductStates').filter(s => Object.values(DEDUCT).includes(s)),
    employees:  csvParam(url, 'employees'),
    skus:       csvParam(url, 'skus').map(cleanSearch).filter(Boolean),
    products:   csvParam(url, 'products').map(cleanSearch).filter(Boolean),
    repairable: ['0', '1'].includes(url.searchParams.get('repairable')) ? url.searchParams.get('repairable') : null,
    search:     cleanSearch(url.searchParams.get('search')) || null,
    dateFrom:   /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('dateFrom') || '') ? url.searchParams.get('dateFrom') : null,
    dateTo:     /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('dateTo') || '')   ? url.searchParams.get('dateTo')   : null,
  };
}

function buildDefectFilterSQL(select, f) {
  let sql = `${select} FROM defects d LEFT JOIN defect_types t ON t.id = d.defect_type_id WHERE 1 = 1`;
  const b = [];
  const inList = (col, vals) => {
    if (vals.length) { sql += ` AND ${col} IN (${vals.map(() => '?').join(',')})`; b.push(...vals); }
  };
  inList('d.status', f.statuses);
  inList('d.defect_type_id', f.types);
  inList('d.side', f.sides);
  inList('d.origin', f.origins);
  inList('d.deduct_state', f.deductStates);
  inList('d.created_by', f.employees);
  if (f.repairable != null) { sql += ' AND d.repairable = ?'; b.push(Number(f.repairable)); }
  const anyLike = (cols, tokens) => {
    if (!tokens.length) return;
    sql += ' AND (' + tokens.map(() => '(' + cols.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')').join(' OR ') + ')';
    for (const t of tokens) for (let i = 0; i < cols.length; i++) b.push(`%${likeEsc(t)}%`);
  };
  anyLike(['d.sku'], f.skus);
  anyLike(['d.product_title', 'd.variant_title'], f.products);
  if (f.search) anyLike(['d.sku', 'd.product_title', 'd.barcode', 'd.notes'], [f.search]);
  // حدود اليوم بتوقيت القاهرة (مش UTC) — الإزاحة بتتحسب من Intl
  if (f.dateFrom) { sql += ' AND d.created_at >= ?'; b.push(cairoDayBoundsUTC(f.dateFrom).start); }
  if (f.dateTo)   { sql += ' AND d.created_at <= ?'; b.push(cairoDayBoundsUTC(f.dateTo).end); }
  return { sql, b };
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL (ORDER BY مابيقبلش bind).
//    المفاتيح لازم تطابق `data-sort-key` في الواجهة حرفيًا؛ مفتاح بره القايمة بيرجع للافتراضي.
const DEFECT_SORT_COLUMNS = {
  date: 'd.created_at', time: 'd.created_at', sku: 'd.sku', product: 'd.product_title',
  type: 't.name', status: 'd.status', employee: 'd.created_by', side: 'd.side',
  origin: 'd.origin', repairable: 'd.repairable', images: 'image_count', id: 'd.id',
};
function defectOrderBy(sortBy, sortDir) {
  const col = DEFECT_SORT_COLUMNS[String(sortBy || '')] || 'd.created_at';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return ` ORDER BY ${col} ${dir}, d.id DESC`;   // كاسر تعادل إلزامي
}
const DEFECT_LIST_SELECT = `SELECT d.*, t.name AS type_name,
  (SELECT COUNT(*) FROM defect_images i WHERE i.defect_id = d.id) AS image_count`;

async function getDefects(db, url) {
  const f = defectFiltersFrom(url);
  const limitRaw  = parseInt(url.searchParams.get('limit')  || '50', 10);
  const offsetRaw = parseInt(url.searchParams.get('offset') || '0',  10);
  const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), REGISTRY_PAGE_MAX) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  const { sql, b } = buildDefectFilterSQL(DEFECT_LIST_SELECT, f);
  const q = sql + defectOrderBy(url.searchParams.get('sortBy'), url.searchParams.get('sortDir')) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q).bind(...b, limit, offset).all()).results.map(shapeDefect);
}
async function getDefectsCount(db, url) {
  const { sql, b } = buildDefectFilterSQL('SELECT COUNT(*) AS total', defectFiltersFrom(url));
  return (await db.prepare(sql).bind(...b).first())?.total ?? 0;
}
async function getDefectsExport(db, url) {
  const { sql, b } = buildDefectFilterSQL(DEFECT_LIST_SELECT, defectFiltersFrom(url));
  // التصدير والعدّ بيتجاهلوا الترتيب عن قصد (نفس منطق السجل).
  return (await db.prepare(sql + ' ORDER BY d.created_at DESC, d.id DESC LIMIT ?').bind(...b, DEFECT_EXPORT_MAX).all()).results.map(shapeDefect);
}

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // ALWAYS first: CORS preflight
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    // 🔴 حارس السر الغايب — من غيره السر الناقص بيدّي "Bearer undefined" مقبول (Step 8).
    if (typeof env.WORKER_SECRET !== 'string' || !env.WORKER_SECRET.trim())
      return json({ ok: false, error: 'WORKER_SECRET غير مضبوط على الـ Worker', step: 'env' }, 500, request);

    // ALWAYS second: WORKER_SECRET check
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: getCORS(request),
      });

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';
    const isPost = request.method === 'POST';
    const needPost = () => json({ error: 'POST required' }, 405, request);

    try {

      // ─── §AUTH ────────────────────────────────────────────────────
      // (الهب مابيناديهمش — الدخول في Worker الهب — بس موجودين بالنص حسب القاعدة ٣)
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin, appId } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);

        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);

        let logged = true;
        try {
          await writeLog(env.DB, {
            tool:     resolveAuthTool(appId),
            type:     'login',
            employee: username,
            notes:    `دخول: ${displayName}`,
          });
        } catch (e) {
          logged = false;
        }
        return json({ ok: true, displayName, logged }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        const appId    = url.searchParams.get('appId');
        let logged = true;
        if (username) {
          try {
            await writeLog(env.DB, {
              tool:     resolveAuthTool(appId),
              type:     'logout',
              employee: username,
              notes:    `خروج: ${username.replace(/_/g, ' ')}`,
            });
          } catch (e) {
            logged = false;
          }
        }
        return json({ ok: true, logged }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §DEFECTS — endpoints الأداة ──────────────────────────────

      // بحث عن منتج (SKU أو اسم)
      if (action === 'list_skus') {
        const search = cleanSearch(url.searchParams.get('search'));
        if (search.length < 2) return json({ ok: false, error: 'اكتب حرفين على الأقل للبحث' }, 400, request);
        assertEnv(env, 'shopify', 'stock');
        const token = await getAccessToken(env);
        return json({ ok: true, variants: await listSkus(env, token, search) }, 200, request);
      }

      // بحث بالباركود (سكانر)
      if (action === 'lookup_barcode') {
        const barcode = cleanSearch(url.searchParams.get('barcode'));
        if (!barcode) return json({ ok: false, error: 'barcode مطلوب' }, 400, request);
        assertEnv(env, 'shopify', 'stock');
        const token = await getAccessToken(env);
        return json({ ok: true, variants: await lookupBarcode(env, token, barcode) }, 200, request);
      }

      if (action === 'get_defect_types') {
        const { results } = await env.DB.prepare(
          'SELECT id, name FROM defect_types WHERE is_active = 1 ORDER BY name'
        ).all();
        return json({ ok: true, types: results }, 200, request);
      }

      if (action === 'add_defect_type') {
        if (!isPost) return needPost();
        return await addDefectType(request, env, await readJsonBody(request));
      }

      if (action === 'register_defect') {
        if (!isPost) return needPost();
        return await registerDefect(request, env, await readJsonBody(request));
      }

      if (action === 'set_status') {
        if (!isPost) return needPost();
        return await setStatus(request, env, await readJsonBody(request));
      }

      if (action === 'cancel_defect') {
        if (!isPost) return needPost();
        return await cancelDefect(request, env, await readJsonBody(request));
      }

      if (action === 'add_defect_image') {
        if (!isPost) return needPost();
        return await addDefectImage(request, env);
      }

      if (action === 'delete_defect_image') {
        if (!isPost) return needPost();
        return await deleteDefectImage(request, env, await readJsonBody(request));
      }

      if (action === 'get_defect_images') {
        const defectId = parseId(url.searchParams.get('defectId'), 'defectId');
        const { results } = await env.DB.prepare(`
          SELECT id, defect_id, size_bytes, content_type, created_at, created_by
          FROM defect_images WHERE defect_id = ? ORDER BY id`).bind(defectId).all();
        return json({ ok: true, images: results.map(r => ({
          id: r.id, defectId: r.defect_id, sizeBytes: r.size_bytes, contentType: r.content_type,
          createdAt: r.created_at, createdBy: r.created_by,
        })) }, 200, request);
      }

      if (action === 'get_image') {
        return await getImage(request, env, parseId(url.searchParams.get('id'), 'id'));
      }

      // المخزن الرقمي — فلترة وترتيب وpagination من السيرفر
      if (action === 'get_defects') {
        return json({ ok: true, defects: await getDefects(env.DB, url) }, 200, request);
      }
      if (action === 'get_defects_count') {
        return json({ ok: true, total: await getDefectsCount(env.DB, url) }, 200, request);
      }
      if (action === 'get_defects_export') {
        const [defects, total] = await Promise.all([getDefectsExport(env.DB, url), getDefectsCount(env.DB, url)]);
        return json({ ok: true, defects, cap: DEFECT_EXPORT_MAX, total, truncated: total > DEFECT_EXPORT_MAX }, 200, request);
      }
      if (action === 'get_status_counts') {
        const { results } = await env.DB.prepare('SELECT status, COUNT(*) AS c FROM defects GROUP BY status').all();
        const extra = await env.DB.prepare(`
          SELECT SUM(CASE WHEN deduct_state = 'skipped' THEN 1 ELSE 0 END) AS skipped,
                 SUM(CASE WHEN deduct_state IN ('pending','unconfirmed') OR restock_state IN ('pending','unconfirmed') THEN 1 ELSE 0 END) AS needs_review
          FROM defects`).first();
        const counts = Object.fromEntries(results.map(r => [r.status, r.c]));
        return json({ ok: true, counts, skipped: extra?.skipped ?? 0, needsReview: extra?.needs_review ?? 0 }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §LOG-ENDPOINTS ───────────────────────────────────────────
      if (action === 'get_logs') {
        const p = logParamsFrom(url, TOOL_NAME);
        // 🔴 parseInt('abc') → NaN وبيوصل لـ D1 كـ bind ويرجّع خطأ غامض — الحراسة إلزامية.
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '100', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',   10);
        const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        const sortBy  = url.searchParams.get('sortBy');
        const sortDir = url.searchParams.get('sortDir');
        const entries = await getLogs(env.DB, { ...p, limit, offset, sortBy, sortDir });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }

      // الصفوف **والحقيقة** مع بعض: cap · total · truncated
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),
        ]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total,
                      truncated: total > LOG_EXPORT_MAX }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §CONFIG-ENDPOINTS ────────────────────────────────────────
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME }, 200, request);
      }

      // فحص ذاتي بدون أي كتابة. checks مصفوفة [{ ok, label, detail }] — ممنوع أي قيمة سر.
      if (action === 'diag') {
        const checks = [];
        const add = (ok, label, detail) => checks.push({ ok, label, detail });
        const envInfo = Object.keys(env).map(k => `${k}(${typeof env[k] === 'string' ? env[k].length : typeof env[k]})`).join(' · ');
        add(true, 'متغيرات البيئة', envInfo);
        const fp = await secretFingerprint(env.WORKER_SECRET);
        add(!!fp, 'WORKER_SECRET', fp ? `مضبوط (${env.WORKER_SECRET.length} حرف) · بصمة ${fp} · مجموعة warehouse_ops` : 'غير مضبوط');
        add(!!env.LOCATION_ID, 'LOCATION_ID', env.LOCATION_ID ? `مضبوط (${env.LOCATION_ID})` : 'ناقص — [vars] في wrangler.toml');
        try {
          const c = await env.DB.prepare(
            `SELECT (SELECT COUNT(*) FROM defects) AS defects, (SELECT COUNT(*) FROM defect_types) AS types,
                    (SELECT COUNT(*) FROM defect_images) AS images`).first();
          add(true, 'D1 (الجداول)', `defects=${c.defects} · types=${c.types} · images=${c.images}`);
        } catch (e) { add(false, 'D1 (الجداول)', e.message); }
        try {
          if (!env.IMAGES) throw new Error('binding IMAGES غير موجود');
          const l = await env.IMAGES.list({ limit: 1 });
          add(true, 'R2 (IMAGES)', `متصل — ${l.objects.length ? 'فيه ملفات' : 'فاضي'}`);
        } catch (e) { add(false, 'R2 (IMAGES)', e.message); }
        try {
          assertEnv(env, 'shopify');
          const token = await getAccessToken(env);
          add(true, 'شوبيفاي OAuth', 'التوكن اتجاب');
          const scopes = await shopifyGQL(env, token, `{ currentAppInstallation { accessScopes { handle } } }`, {}, 'diag:scopes');
          const have = (scopes.data.currentAppInstallation?.accessScopes || []).map(s => s.handle);
          const need = ['read_products', 'read_inventory', 'write_inventory'];
          const missing = need.filter(s => !have.includes(s));
          add(missing.length === 0, 'صلاحيات شوبيفاي', missing.length ? `ناقص: ${missing.join('، ')}` : need.join(' · '));
          try {
            const loc = await shopifyGQL(env, token, `query($id: ID!) { location(id: $id) { name isActive } }`,
              { id: requireLocationId(env) }, 'diag:location');
            add(!!loc.data.location?.isActive, 'LOCATION_ID → موقع', loc.data.location ? `${loc.data.location.name} (${loc.data.location.isActive ? 'فعّال' : 'متوقف'})` : 'مش لاقي الموقع');
          } catch (e) { add(false, 'LOCATION_ID → موقع', e.message); }
        } catch (e) { add(false, 'شوبيفاي', e.message); }
        add(true, 'نسخة الـ API', 'API 2026-01 — @idempotent اختياري ومستخدم؛ إلزامي من 2026-04');
        add(true, 'CORS', `Origin الحالي: ${request.headers.get('Origin') || '(مفيش)'} · المسموح: ${ALLOWED_ORIGINS.join(', ')}`);
        add(true, 'التوقيت', `${cairoDate()} (إزاحة القاهرة ${cairoOffsetMinutes(new Date())} دقيقة)`);
        return json({
          ok: checks.every(c => c.ok), version: WORKER_VERSION, checks,
          // بندين منفصلين: الرصيد المتبقي، وتكلفة آخر نداء (Step 5A ⑮)
          throttleStatus: _lastThrottle, lastQueryCost: _lastQueryCost,
        }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      return json({ error: 'Unknown action' }, 404, request);
    } catch (err) {
      if (err instanceof BadRequest) return json({ ok: false, error: err.message }, 400, request);
      console.error(err);
      return json({ ok: false, error: err.message }, 500, request);
    }
  },
};

async function readJsonBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('الطلب لازم يكون JSON object');
  return body;
}

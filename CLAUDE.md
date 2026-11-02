<div dir="rtl" style="text-align: right;">

# ديفوهات (`Defect-Products`)

![version](https://img.shields.io/badge/version-v1.0.0-blue)

**بتعمل إيه:** الموظف بيسجّل قطعة فيها عيب → بتتخصم 1 من مخزون شوبيفاي (`available`)، وبتتحط في **مخزن رقمي** (سجل بكل التفاصيل + صور اختيارية). القطعة القابلة للإصلاح لما تتصلّح بترجع للستوك +1، وغير القابلة بتفضل سجل. + تاب سجل العمليات.
**مين بيستخدمها:** المخزن (كل موظف)
**الإصدار:** Worker `v1.0.0`

> 🔴 **الريبو ده Worker فقط.** الواجهة صفحة جوّه هب المخزن (`Warehouse-Operations-Center`) باسم `Defect-Products.html` (قاعدة `constants` §5.2) — سابقة `Bosta-Orders-Shipped-Scanner`.

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Warehouse-Operations-Center/Defect-Products.html   ← صيغة مشتقة من القاعدة، اتأكد إنها منشورة قبل ما تحطها في أي توثيق
الـ Worker : https://defect-products-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: defect-products-worker     ← لازم يطابق name في wrangler.toml
```

## الـ Endpoints

القياسية: `check_employee` · `register_pin` · `verify_employee` · `log_logout` · `get_employees` · `get_logs` · `get_logs_count` · `get_logs_export` · `get_config` · `diag`.
> الهب مابينادش `check_employee`/`register_pin`/`verify_employee`/`log_logout` (الدخول في Worker الهب) — موجودين بالنص حسب `worker-builder` القاعدة ٣.

| `?action=` | طريقة | بيعمل إيه |
|---|---|---|
| `list_skus` | GET | بحث بالـ SKU/الاسم/الباركود (الموقوف مستبعد) + الرصيد المتاح |
| `lookup_barcode` | GET | بحث بالباركود (مطابقة تامة) |
| `get_defect_types` | GET | قايمة أنواع العيب |
| `add_defect_type` | POST | نوع جديد (اسم موحّد ضد التكرار — موجود = `already`) |
| `register_defect` | POST | تسجيل + خصم 1. الرصيد 0 → `needs_decision`؛ `stockMode:'skip'` = تسجيل بدون خصم |
| `set_status` | POST | `repaired` (+1 للستوك) · `unrepairable` · `awaiting_repair` |
| `cancel_defect` | POST | إلغاء تسجيل (+1 للستوك لو كان اتخصم) |
| `add_defect_image` | POST multipart | صورة (JPEG/PNG/WebP، ≤15MB، ≤10 للقطعة) → R2 ثم D1 |
| `delete_defect_image` | POST | مسح صورة (قبل الإصلاح بس) |
| `get_defect_images` | GET | بيانات صور قطعة (مش الملفات) |
| `get_image` | GET | الصورة نفسها stream (بهيدر `Authorization` — `<img src>` مباشر مايشتغلش) |
| `get_defects` · `get_defects_count` · `get_defects_export` | GET | المخزن الرقمي: فلترة/ترتيب/pagination من السيرفر + تصدير بـ `cap`/`total`/`truncated` |
| `get_status_counts` | GET | عدّادات الحالات + «بدون خصم» + «يحتاج مراجعة» |

**عقد الرد:** نتيجة أي عملية = HTTP 200 و`{ ok:true, status, message, ... }` والواجهة بتتفرّع على `status`:
`success` · `warning` · `error` · `rejected` · `already` (constants §12) + `needs_decision` (الرصيد 0 — مفيش كتابة اتعملت). مدخل ناقص/غلط = 400.

## D1

```
tool  : defect_products
type  : registered · status_changed · repaired · cancelled · image_added · image_deleted · defect_type_added · rejected · login · logout
```

جداول الأداة (في `ecommoda-dev-logs`، اتعملت 02-11-2026):

| الجدول | الغرض |
|---|---|
| `defects` | صف لكل قطعة. `request_id` فريد (حماية الضغطة المكررة). `deduct_state` (`pending`/`done`/`skipped`/`unconfirmed`) · `restock_state` (`none`/`pending`/`done`/`unconfirmed`) · `pending_op` (`repair`/`cancel`) |
| `defect_types` | أنواع العيب. `name_key` فريد (الاسم بعد توحيد الألف والتشكيل والمسافات) |
| `defect_images` | `defect_id` + `r2_key` فريد + الحجم والنوع. **الملف نفسه في R2** |

الحالات (`status`): `awaiting_repair` → `repaired` (نهائي) · `unrepairable` ↔ `awaiting_repair` · `cancelled`. القيم بتتحقق في الـ Worker (مفيش CHECK في D1 عشان نقدر نزوّد «تم التخلص منها» بدون تعديل الجدول).

## المخزون — القواعد

- **كل عملية مخزون = `inventoryAdjustQuantities` بـ `delta` نسبي + `@idempotent(key: "<requestId>:<deduct|restock|cancel>")`** (API 2026-01: اختياري ومستخدم؛ **من 2026-04 إلزامي**). المفتاح ثابت لنفس العملية → إعادتها بتدّي نتيجة شوبيفاي الأصلية ومش بتتنفّذ تاني.
- الأسباب: `damaged` (خصم) · `restock` (اتصلحت) · `correction` (إلغاء). `referenceDocumentUri = gid://Defect-Products/Defect/<id>` (بيظهر في تاريخ المخزون).
- نتيجة النداء تلات حالات مش اتنين: **نجح ومتأكدين** · **رفض صريح** (مفيش أثر — الصف بيتمسح في أول تسجيل) · **معرفناش** (`unconfirmed` → warning؛ الإعادة بنفس المفتاح آمنة خلال 30 دقيقة، وبعدها مراجعة يدوية).
- 🔴 **التسجيل بدون خصم** (الرصيد 0، بقرار الموظف) → `deduct_state='skipped'`: «اتصلحت» و«إلغاء» **مايضيفوش** للستوك (ما اتخصمش أصلًا). و`skip` مقبول بس لو الرصيد < 1.
- الخصم من `available` زي أداة الجرد؛ القطعة بتتنقل فعليًا لغرفة ديفوهات منفصلة فمش داخلة في جرد الرفوف.
- كمية الخصم **1 دايمًا** (زوج واحد) — «اليمين/اليسار/الفردتين» تصنيف بس.

## المضبوط فعليًا في الداشبورد

> اللي **لازم يتظبط** (مش حالة محققة — أحمد بيعمله بعد اكتمال الريبو):

```
Bindings : DB → ecommoda-dev-logs · IMAGES → defect-products-images (R2)   ← من wrangler.toml
Secrets  : WORKER_SECRET (= قيمة مجموعة warehouse_ops) · CLIENT_ID · CLIENT_SECRET   → ثم Promote
Vars     : SHOP_DOMAIN · LOCATION_ID   ← من [vars] في wrangler.toml
Build watch paths : index.js + wrangler.toml   ← chip لكل ملف في سطر منفصل
```

الـ bucket `defect-products-images` (private) اتعمل 02-11-2026 **قبل** الـ binding (ترتيب إلزامي). موقعه الافتراضي ENAM بينما D1 في فرانكفورت.

## الصور (R2)

- اسم الملف يتولّد من السيرفر: `defects/YYYY/MM/<uuid>.<ext>` — مش اسم الملف المرفوع.
- النوع من **أول بايتات الملف** مش `Content-Type`. SVG ممنوع. HEIC/AVIF مرفوضين برسالة واضحة.
- الترتيب: `R2.put` ← `D1 insert` ← لو D1 فشل `R2.delete` ← لو المسح فشل `warning` فيه المفتاح اليتيم.
- العرض: stream من R2 + `X-Content-Type-Options: nosniff` + `Cache-Control: private` + `ETag`/304 + CSP `sandbox`.
- مفيش مسح صور بعد «اتصلحت» أو «إلغاء». حذف الصف نفسه من D1 مش مدعوم (إلغاء بدل حذف).

## CORS

`ALLOWED_ORIGINS` صارمة (`https://ecommoda-dev.github.io`) — لأن الأداة **بتكتب مخزون**. الـ preflight بيسمح بـ `Authorization` و`Content-Type` (multipart).

## فخاخ الأداة دي

- **ترقية API لـ `2026-04`+**: الميوتيشن بتتطلب `@idempotent` — الأداة دي جاهزة. **أدوات تانية في الستاك (الجرد وغيرها) مش جاهزة** → بند ترقية مفتوح، `grep` على كل الـ Workers قبل أي ترقية.
- `LOCATION_ID` ناقص أو غلط = الرصيد يرجع `null` والتسجيل يتوقف (`hasLevel`) — `?action=diag` بيتحقق منه.
- عملية مخزون معلّقة (`pending`/`unconfirmed`) على قطعة بتمنع أي عملية مخزون تانية عليها (مفيش تعارض بين اتصلحت وإلغاء).
- `request_id` مصدره الواجهة (UUID لكل ضغطة «تسجيل»). الواجهة **لازم** تعيد استخدامه عند «إعادة المحاولة» ومايتولّدش جديد.
- `get_image` محتاج هيدر `Authorization` → الواجهة بتعمل `fetch` وتحوّل الرد لـ `blob` (+ `revokeObjectURL` عند الإغلاق). الدالتين `apiUpload`/`apiGetBlob` بتتضافوا لنواة الهب (`shared/core.js`) في **الهبّين** (التوأم).
- `UNKNOWN_OUTCOME_RE` في `index.js` مربوطة برسايل `shopifyGQL` — لو اتغيّر نص رسالة هناك، تصنيف «معرفناش» بيتأثر.

## الفحص

```bash
node check-log-values.mjs        # قيم اللوج (exit 0 قبل أي تسليم)
node docs/worker-check.mjs       # 47 اختبار سلوكي محلي (D1/R2/شوبيفاي مزيّفين) — exit 0
```

> ⚠️ `check-log-values.mjs` هنا نسخة ريبو `Inventory-Audit-Updater` — مفيهاش `CHECK_VERSION` ولا `(?<!\$)` اللي الـ skill بيذكرهم (نسخة v3.2)، وكل الريبوهات اللي فحصتها (`Courier-Names` · `COD-Payment-Center` · الهبّين) كذلك. التشيك عدّى (exit 0) وكود الأداة مفيهوش `${type}` في template، فمفيش false positive معروف.

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v3.10.0 |
| ecommoda-constants | v4.4.0 |
| shopify-graphql-helper | v2.4.0 |

آخر مطابقة: 02-11-2026 · `index.js` v1.0.0
✅ الواجهة اتبنت (`Defect-Products.html` في هب المخزن v1.70.0 + `apiUpload`/`apiGetBlob` في `core.js` الهبّين) — الفحص: صفحة 107 بند · api-layer 16 بند.
🔴 معلّقة: إنشاء الـ Worker `defect-products-worker` + `WORKER_SECRET` (= `warehouse_ops`) + `CLIENT_ID`/`CLIENT_SECRET` + Promote + Build watch paths (أحمد — في الآخر) · تسجيل الأداة في `ecommoda-constants` (فهرس tool→ريبو + عضو `warehouse_ops` رقم ١١ + الـ bucket/binding + قيم اللوج) — `SKILLS-UPDATE-PACK.md` · الاختبار الحي على SKU تجريبي بعد إنشاء الـ Worker.

## مسائل مفتوحة

- موقع الـ bucket ENAM (الافتراضي) بينما D1 في FRA — لو اتضح بطء في عرض الصور يتعاد إنشاء الـ bucket (لسه فاضي) بـ location hint أوروبي.
- مسح الصور اليتيمة وتقرير المساحة (`reconcile_images` / `get_storage_stats` من الملف الأصلي) مؤجّلين — مش في v1.0.0.
- `resolve_unconfirmed` (حسم يدوي لعملية مخزون عدّت نافذة الـ 30 دقيقة) مؤجّل — الحالة نادرة بفضل `@idempotent`؛ حاليًا بتظهر «يحتاج مراجعة» في `get_status_counts`.

آخر تحديث: 02-11-2026 — 10:52

</div>

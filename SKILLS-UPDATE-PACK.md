<div dir="rtl" style="text-align: right;">

# SKILLS-UPDATE-PACK — أداة ديفوهات (`Defect-Products`)

ما يلزم تحديثه في المهارات بعد بناء الأداة (بيتقرا في جلسة تحديث مهارات مخصّصة).

## ecommoda-constants
1. **فهرس tool→ريبو (§7.0):** `defect_products` → `Defect-Products` (Worker فقط؛ الواجهة `Defect-Products.html` في `Warehouse-Operations-Center`).
2. **قيم اللوج (`log-values.json` بتاع الريبو):** `type` ∈ `registered · status_changed · repaired · cancelled · image_added · image_deleted · defect_type_added · rejected · login · logout`.
3. **`secret-groups.md`:** `defect-products-worker` عضو **رقم ١١** في `warehouse_ops` (مع الهب). عضو غير مسجّل = تدوير السر بيتكسر بصمت.
4. **الموارد:** R2 bucket `defect-products-images` (private، binding `IMAGES`) · D1 `ecommoda-dev-logs` (جداول `defects` · `defect_types` · `defect_images`).
5. **§5.2:** صفحة الهب `Defect-Products.html` = اسم الريبو بالحرف.

## ecommoda-worker-builder / shopify-graphql-helper
- **بند ترقية API لـ `2026-04`+:** `@idempotent(key:)` إلزامي على ميوتيشن المخزون. الأداة دي جاهزة؛ **أدوات تانية (الجرد `Inventory-Audit-Updater` وغيرها) مش جاهزة** → `grep` على كل الـ Workers قبل أي ترقية.
- `inventoryAdjustQuantities`: في schema الأحدث (2026-10) `changeFromQuantity` بقى مطلوب في `InventoryChangeInput`، و`ProductVariant.barcode` متقادم (استخدم `barcodes`). الأداة بتستخدم 2026-01 بـ `delta` + `@idempotent`.
- نمط «نتيجة مجهولة» (`unconfirmed`) + مفتاح idempotency ثابت للعملية + نافذة إعادة 30 دقيقة — مرشّح يتحوّل لمرجع.

## ecommoda-html-builder
- مكوّن `ecoSrvFilters` المشترك أقدم من v8.6.0 (فلتر النص كلمة واحدة · بحث القوايم ٧ · تاريخ بلا أقسام · بلا فلتر وقت) — ترقيته بند مفتوح بيأثّر على باقي الصفحات.
- `apiUpload`/`apiGetBlob` اتضافوا لـ `core.js` (الهبّين): رفع multipart وعرض ملفات بهيدر `Authorization` (`fetch` → `blob` → `revokeObjectURL`).
- مصدر مدى الباركود: بلجن Retail Force Barcode — Format «General» بنمط `[0-9]{9}` (القديم ٨).

</div>

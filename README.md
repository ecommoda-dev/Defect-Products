<div dir="rtl" style="text-align: right;">

# ديفوهات — Defect Products

![version](https://img.shields.io/badge/version-v1.1.0-blue)

أداة داخلية لموظفي مخزن EcomModa: تسجيل قطعة فيها عيب → **خصم 1 من المخزون** على شوبيفاي → **مخزن رقمي** بكل التفاصيل (نوع العيب · قابل للإصلاح · أي فردة · جديد/مرتجع · ملاحظات · صور اختيارية). القطعة اللي تتصلّح بترجع للستوك، والغير قابلة للإصلاح بتفضل سجل.

- **الـ Worker:** Cloudflare Workers (`index.js`) — Shopify GraphQL Admin API + D1 + R2
- **الواجهة:** صفحة `Defect-Products.html` جوّه [`Warehouse-Operations-Center`](https://github.com/ecommoda-dev/Warehouse-Operations-Center) (هب المخزن)

التفاصيل (الـ endpoints والحالات وقواعد المخزون والصور والفخاخ) → [`CLAUDE.md`](./CLAUDE.md).

```bash
node docs/worker-check.mjs      # اختبار سلوكي محلي
node check-log-values.mjs       # قيم اللوج
```

---

آخر تحديث: 02-11-2026 — 10:52

</div>

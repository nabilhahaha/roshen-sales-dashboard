// Import-order flow — orchestrates parse → mapping → validate → preview →
// create Draft. Business logic lives in services; order creation reuses the
// SAME orders service as manual entry, so imported orders are identical.
import { toast } from '../../../components/notifications/toast.js';
import { today } from '../../../utils/format.js';
import { parseOrderWorkbook } from '../../../services/import/excel-order-parser.js';
import {
  listMappings, findMatchingMapping, mappingToIdx, suggestMapping, saveMapping, idxToLabelMap,
} from '../../../services/import/order-mapping.service.js';
import { validateImport } from '../../../services/import/order-import-validator.js';
import { listSkus } from '../../../services/sku/sku.service.js';
import * as Orders from '../../../services/purchase-orders/orders.service.js';
import { exportErrorReport } from '../../../utils/documents.js';
import { parseWorkbookFromArrayBuffer } from '../../../services/pi/pi-parser.js';
import { looksLikePiDocument, documentToOrderPlan, planLinesForDb } from '../../../services/import/pi-document-import.js';
import { renderWizard } from './mapping-wizard.view.js';
import { renderPreview } from './import-preview.view.js';
import { renderDocumentPreview } from './pi-document-preview.view.js';

export async function startImportFlow(root, ctx, arrayBuffer, filename) {
  let parsed;
  try { parsed = parseOrderWorkbook(arrayBuffer, window.XLSX); }
  catch (e) { toast('Could not read Excel: ' + (e.message || e), 'err'); return ctx.navigate('order-history'); }
  if (!parsed.columns.length || !parsed.rows.length) { toast('No data rows found in the Excel file', 'err'); return ctx.navigate('order-history'); }

  let skus;
  try { skus = await listSkus(); }
  catch (e) { toast('Could not load SKU Master: ' + (e.message || e), 'err'); return ctx.navigate('order-history'); }

  // The real business document first: if the file is a supplier PI (header
  // block + document number + items table), import it exactly as it reads —
  // no manual column mapping needed. Fall back to the mapping wizard for
  // plain item lists or unrecognized layouts.
  let piDoc = null;
  try { piDoc = parseWorkbookFromArrayBuffer(arrayBuffer, window.XLSX); } catch (e) { piDoc = null; }
  if (piDoc && looksLikePiDocument(piDoc)) {
    const plan = documentToOrderPlan(piDoc, skus, filename);
    renderDocumentPreview(root, {
      plan, filename,
      handlers: {
        cancel: () => ctx.navigate('order-history'),
        manual: () => showWizard(),
        confirm: (p) => createFromDocument(p),
      },
    });
    return void 0;
  }

  async function createFromDocument(plan) {
    try {
      const order = await Orders.createOrder(plan.header);
      await Orders.replaceItems(order.id, planLinesForDb(plan.lines));
      toast(`PI ${order.order_number} created from ${filename || 'the document'}`, 'ok');
      ctx.navigate('purchase-orders', { orderId: order.id, mode: 'edit' });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/duplicate key|unique/i.test(msg) && plan.header.order_number)
        toast(`A PI with document number ${plan.header.order_number} already exists — open it from PI History instead.`, 'err');
      else toast('Create failed: ' + msg, 'err');
    }
  }

  const match = findMatchingMapping(parsed.columns);
  let mapByIdx = match ? mappingToIdx(match.map, parsed.columns) : suggestMapping(parsed.columns);
  if (match) toast(`Applied saved mapping “${match.name}”`, 'info');

  function showWizard() {
    renderWizard(root, {
      columns: parsed.columns, mapByIdx, savedMappings: listMappings(), filename,
      handlers: {
        cancel: () => ctx.navigate('order-history'),
        continue: (m) => { mapByIdx = m; showPreview(); },
        saveMapping: (name, m) => {
          if (!name) { toast('Enter a mapping name first', 'err'); return; }
          saveMapping(name, idxToLabelMap(m, parsed.columns));
          mapByIdx = m;
          toast(`Mapping “${name}” saved — it will auto-apply next time`, 'ok');
          showWizard();
        },
        applySaved: (name) => {
          const sm = listMappings().find((x) => x.name === name);
          if (sm) { mapByIdx = mappingToIdx(sm.map, parsed.columns); toast(`Applied “${name}”`, 'ok'); showWizard(); }
        },
      },
    });
  }

  function showPreview() {
    const fields = new Set(Object.values(mapByIdx));
    if (!fields.has('quantity')) { toast('Map a column to Quantity', 'err'); return; }
    if (!fields.has('item_code') && !fields.has('roshen_id')) { toast('Map a column to Item Code or Roshen ID', 'err'); return; }
    const result = validateImport(parsed.rows, mapByIdx, skus);
    renderPreview(root, {
      result, filename,
      handlers: {
        back: showWizard,
        cancel: () => ctx.navigate('order-history'),
        downloadErrors: () => {
          if (!result.failed.length) { toast('No failed rows to export', 'info'); return; }
          exportErrorReport(result.failed, filename);
          toast('Error report downloaded', 'ok');
        },
        confirm: (editedLines) => createDraft(editedLines),
      },
    });
  }

  // `lines` are the (possibly edited) preview lines.
  async function createDraft(lines) {
    if (!lines.length) { toast('No valid lines to import', 'err'); return; }
    try {
      // Same services as manual creation — the order is a normal Draft.
      const order = await Orders.createOrder({ order_date: today(), supplier: 'Roshen', notes: 'Imported from ' + (filename || 'Excel'), source_filename: filename || null });
      await Orders.replaceItems(order.id, lines.map((l) => ({
        item_code: l.item_code, roshen_id: l.roshen_id, item_description: l.item_description,
        ordered_cases: l.ordered_cases, price_case: l.price_case,
        uom: l.uom ?? null, units_qty: l.units_qty ?? null, unit_price: l.unit_price ?? null,
        discount_percent: l.discount_percent ?? null, net_unit_price: l.net_unit_price ?? null,
        taxable_amount: l.taxable_amount ?? null, vat_percent: l.vat_percent ?? null,
        vat_amount: l.vat_amount ?? null, amount: l.amount ?? null,
      })));
      toast(`Draft order ${order.order_number} created from Excel`, 'ok');
      ctx.navigate('purchase-orders', { orderId: order.id, mode: 'edit' });
    } catch (e) { toast('Create failed: ' + (e.message || e), 'err'); }
  }

  showWizard();
}

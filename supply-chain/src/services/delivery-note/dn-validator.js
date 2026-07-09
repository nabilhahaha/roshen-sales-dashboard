// Delivery-Note validator (pure). Turns mapped Excel rows into DN lines with
// physical batches, computes batch-level shelf life, and matches each line to
// the Purchase Order's fulfillment ledger (open delivery balance). Matching is
// only by Roshen ID → Item Code, never by description.
import { parseNumber, lineKey as keyOf } from '../../utils/format.js';
import { shelfLife, parseDate, toISO } from '../../models/shelf-life.js';

// mapByIdx: { colIdx: fieldKey }  ->  field: colIdx
function fieldIndex(mapByIdx) {
  const f = {};
  Object.keys(mapByIdx).forEach((idx) => { f[mapByIdx[idx]] = idx; });
  return f;
}

// opts: { rows, mapByIdx, skuIndex:{byRoshen,byCode}, fulfillment:[view rows], asOf }
export function buildDeliveryNote(opts) {
  const { rows, mapByIdx, skuIndex = {}, fulfillment = [], asOf } = opts;
  const fi = fieldIndex(mapByIdx);
  const val = (row, field) => (fi[field] != null ? row[fi[field]] : '');
  const byRoshen = skuIndex.byRoshen || {};
  const byCode = skuIndex.byCode || {};

  // PO open-delivery balance per line key
  const poByKey = {};
  fulfillment.forEach((r) => {
    poByKey[keyOf(r.roshen_id, r.item_code)] = {
      ordered: Number(r.ordered_cases || 0),
      delivered: Number(r.delivered_cases || 0),
      open_delivery: Number(r.open_delivery || 0),
    };
  });

  const lines = {};
  rows.forEach((row) => {
    const roshen = String(val(row, 'roshen_id') || '').trim();
    const code = String(val(row, 'item_code') || '').trim();
    const key = keyOf(roshen, code);
    if (!key) return; // skip rows with no usable key

    const sku = byRoshen[roshen] || byCode[code] || null;
    const cases = parseNumber(val(row, 'cartons')) || 0;
    const boxes = parseNumber(val(row, 'boxes'));
    const pieces = parseNumber(val(row, 'pieces'));
    const expiry = toISO(val(row, 'expiry_date'));
    const mfg = toISO(val(row, 'manufacturing_date'));
    // Skip footer / non-item rows: a real batch line has a Roshen ID, a
    // resolvable SKU, or at least a real expiry date. This drops "TOTAL",
    // signature and confirmation rows while keeping genuine unmapped items.
    if (!roshen && !sku && !expiry) return;
    const batchNo = String(val(row, 'batch_no') || '').trim() || null;
    const desc = String(val(row, 'description') || '').trim() || (sku && sku.item_description) || '';

    if (!lines[key]) {
      lines[key] = {
        line_key: key,
        roshen_id: roshen || (sku && sku.roshen_id) || '',
        item_code: code || (sku && sku.item_code) || '',
        description: desc,
        uom: String(val(row, 'uom') || '').trim() || null,
        barcode: String(val(row, 'barcode') || '').trim() || null,
        sku,
        batches: [],
      };
    }
    const line = lines[key];
    // merge identical physical batch (same batch id + expiry)
    const bKey = (batchNo || '') + '|' + (expiry || '');
    let batch = line.batches.find((b) => b._bkey === bKey);
    if (!batch) {
      const sl = shelfLife(sku, { expiry_date: expiry, manufacturing_date: mfg }, asOf);
      batch = {
        _bkey: bKey, batch_no: batchNo,
        expiry_date: expiry, manufacturing_date: mfg,
        cases: 0, boxes: null, pieces: null,
        shelf: sl, belowMinimum: !!sl.belowMinimum,
        __rows: [],
      };
      line.batches.push(batch);
    }
    batch.cases += cases;
    if (boxes != null) batch.boxes = (batch.boxes || 0) + boxes;
    if (pieces != null) batch.pieces = (batch.pieces || 0) + pieces;
    batch.__rows.push(row.__row);
  });

  // finalise lines + match to PO
  const out = Object.values(lines).map((line) => {
    const totalCases = line.batches.reduce((a, b) => a + b.cases, 0);
    const po = poByKey[line.line_key] || null;
    const kind = po ? 'matched' : 'additional';
    const overDelivery = !!(po && totalCases > po.open_delivery + 0.0001);
    const belowShelf = line.batches.some((b) => b.belowMinimum);
    return { ...line, totalCases, po, kind, overDelivery, belowShelf };
  });

  const summary = {
    lineCount: out.length,
    batchCount: out.reduce((a, l) => a + l.batches.length, 0),
    matched: out.filter((l) => l.kind === 'matched').length,
    additional: out.filter((l) => l.kind === 'additional').length,
    overDelivery: out.filter((l) => l.overDelivery).length,
    belowShelfLife: out.reduce((a, l) => a + l.batches.filter((b) => b.belowMinimum).length, 0),
    totalCartons: out.reduce((a, l) => a + l.totalCases, 0),
  };
  summary.ok = summary.additional === 0 && summary.overDelivery === 0;
  return { lines: out, summary };
}

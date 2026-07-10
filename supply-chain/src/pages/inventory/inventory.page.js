// Inventory — batch-level on-hand balances (FEFO: earliest expiry first) with
// live shelf life, plus the movement ledger (the source of truth). Read-only.
import { mount, delegate } from '../../utils/dom.js';
import { esc, qty, num } from '../../utils/format.js';
import { loading, emptyState, tableWrap, card } from '../../components/table/table.js';
import { shelfChip } from '../../components/table/badges.js';
import { shelfLife } from '../../models/shelf-life.js';
import { today } from '../../utils/format.js';
import { listInventory, listMovements, inventorySummary } from '../../services/inventory/inventory.service.js';
import { listSkus, indexByRoshen, indexByCode } from '../../services/sku/sku.service.js';

export async function render(root, ctx) {
  mount(root, loading('Loading inventory…'));
  let inv, moves, summary, skus;
  try {
    [inv, moves, summary, skus] = await Promise.all([listInventory(), listMovements(), inventorySummary(), listSkus()]);
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }
  const byRoshen = indexByRoshen(skus), byCode = indexByCode(skus);
  const skuFor = (r) => byRoshen[String(r.roshen_id || '').trim()] || byCode[String(r.item_code || '').trim()] || null;

  const kpi = (l, v, s) => `<div class="erp-kpi"><div class="k-lbl">${l}</div><div class="k-val">${v}</div><div class="k-sub">${s}</div></div>`;

  const invRows = inv.map((r) => {
    const sl = shelfLife(skuFor(r), { expiry_date: r.expiry_date }, today());
    return `<tr>
      <td class="mono"><b>${esc(r.roshen_id || r.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc(r.description || '')}</div></td>
      <td class="mono">${esc(r.batch_no || '—')}</td>
      <td>${esc(r.expiry_date || '—')}</td>
      <td>${shelfChip(sl)}</td>
      <td>${esc(r.warehouse || '—')}</td>
      <td class="num"><b>${qty(r.cases_on_hand)}</b></td></tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:22px">No stock on hand yet. Release a goods receipt to add inventory.</td></tr>';

  const moveRows = moves.slice(0, 60).map((m) => `<tr>
    <td>#${m.id} · ${esc((m.created_at || '').slice(0, 10))}</td>
    <td><span class="sc-badge ${m.cases_delta >= 0 ? 'confirmed' : 'closed'}">${esc(m.movement_type)}</span></td>
    <td class="mono">${esc(m.roshen_id || m.item_code)}${m.batch_id ? `<div style="font-size:10.5px;color:var(--text-muted)">batch #${m.batch_id}</div>` : ''}</td>
    <td class="mono">${esc(m.batch_no || '—')}</td>
    <td>${esc(m.warehouse || '—')}</td>
    <td class="num" style="color:#2FB344">${Number(m.qty_in) ? '+' + qty(m.qty_in) : ''}</td>
    <td class="num" style="color:#E03131">${Number(m.qty_out) ? '−' + qty(m.qty_out) : ''}</td>
    <td class="num"><b>${m.running_balance != null ? qty(m.running_balance) : '—'}</b></td>
    <td class="mono" style="font-size:11px">${esc(m.reference_module || '')}${m.reference_module ? ' · ' : ''}${esc(m.reference || '')}</td></tr>`).join('')
    || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:18px">No transactions recorded.</td></tr>';

  mount(root, `
    <div class="erp-kpi-row">
      ${kpi('SKUs in stock', num(summary.skus), 'distinct items')}
      ${kpi('Batches', num(summary.batches), 'on-hand lots')}
      ${kpi('Cases on hand', qty(summary.cases), 'across all batches')}
    </div>
    ${card(`<div class="sc-card-h"><h3>🏬 On-hand by batch (FEFO)</h3><div class="sc-spacer"></div>
      <span style="font-size:11px;color:var(--text-muted)">earliest expiry first · shelf life computed live</span></div>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th>Batch / Lot</th><th>Expiry</th><th>Remaining shelf life</th><th>Warehouse</th><th class="num">Cases</th></tr></thead><tbody>${invRows}</tbody></table>`)}`)}
    ${card(`<div class="sc-card-h"><h3>📜 Transaction ledger</h3><div class="sc-spacer"></div>
      <span style="font-size:11px;color:var(--text-muted)">every stock movement, newest first · latest 60</span></div>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Txn</th><th>Type</th><th>Item</th><th>Batch</th><th>Warehouse</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th>Reference</th></tr></thead><tbody>${moveRows}</tbody></table>`)}`)}
  `);
  delegate(root, {});
}

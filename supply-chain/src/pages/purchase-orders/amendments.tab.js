// Purchase Order AMENDMENTS tab — ERP-style change management UI.
// The original order is never edited: changes are drafted here, walk the
// Draft → Submitted → Approved → Applied workflow (Approve/Apply = Super
// Admin only), and are kept forever with a full before/after diff and an
// immutable audit trail. Everything renders from the amendments service —
// no business rules live in this file.
import { esc, qty, money, fmtDay } from '../../utils/format.js';
import { toast } from '../../components/notifications/toast.js';
import { t } from '../../i18n/i18n.js';
import { canApproveAmendments, currentActor } from '../../models/permissions.js';
import {
  listAmendments, getAmendment, amendmentAudit, amendmentContext,
  validateAmendment, createAmendment, submitAmendment, approveAmendment,
  rejectAmendment, cancelAmendment, applyAmendment,
} from '../../services/amendments/amendments.service.js';

const AMD_BADGE = { Draft: 'none', Submitted: 'pi', Approved: 'approved', Applied: 'confirmed', Rejected: 'closed', Cancelled: 'closed' };
const badge = (s) => `<span class="sc-badge ${AMD_BADGE[s] || 'none'}">${esc(s)}</span>`;
const d16 = (v) => esc(String(v || '').slice(0, 16).replace('T', ' '));

// colour rules for the difference screen:
// green = increase · red = decrease · blue = price change · orange = ETA change
const diffCell = (oldV, newV, kind) => {
  if (newV == null || String(oldV) === String(newV)) return `<span class="amd-same">${esc(oldV == null ? '—' : oldV)}</span>`;
  const cls = kind === 'price' ? 'amd-price' : kind === 'eta' ? 'amd-eta' : (Number(newV) > Number(oldV) ? 'amd-up' : 'amd-down');
  return `<span class="${cls}">${esc(oldV == null ? '—' : oldV)} → <b>${esc(newV)}</b></span>`;
};

export async function renderAmendmentsTab(el, { orderId, orderNumber, supplier }) {
  el.innerHTML = '<div class="sk-page-head"><span class="sc-spin" style="width:13px;height:13px"></span></div>';
  let [amendments, ctx] = await Promise.all([listAmendments(orderId), amendmentContext(orderId)]);
  let editor = null;   // in-progress draft rows (create mode)
  let viewing = null;  // amendment detail (diff + audit)

  const reload = async () => {
    [amendments, ctx] = await Promise.all([listAmendments(orderId), amendmentContext(orderId)]);
  };

  function paint() {
    const superAdmin = canApproveAmendments();
    el.innerHTML = `
      <div class="sc-card">
        <div class="sc-card-h"><h3>📝 ${t('Amendments')}</h3>
          <span class="sc-badge none">${amendments.length}</span>
          <div class="sc-spacer"></div>
          <button class="sc-btn sm ghost" data-amd="xls">📊 ${t('Export Excel')}</button>
          <button class="sc-btn sm ghost" data-amd="pdf">🖨 ${t('Export PDF')}</button>
          <button class="sc-btn sm" data-amd="create">+ ${t('Create Amendment')}</button></div>
        <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">${t('The original Purchase Order is never edited directly — every change is an amendment with full history, approval workflow and an immutable audit trail. Only a Super Admin can Approve or Apply.')}</p>
        <div class="sc-table-wrap"><table class="sc-table"><thead><tr>
          <th>${t('Revision')}</th><th>${t('Created By')}</th><th>${t('Applied By')}</th>
          <th>${t('Created Date')}</th><th>${t('Applied Date')}</th><th>${t('Status')}</th><th>${t('Reason')}</th></tr></thead><tbody>
          ${amendments.map((a) => `<tr class="sc-row-link" data-view="${a.id}">
            <td class="mono"><b>AMD-${String(a.amendment_no).padStart(2, '0')}</b></td>
            <td>${esc(a.created_by)}</td><td>${esc(a.applied_by || '—')}</td>
            <td style="font-size:11.5px">${d16(a.created_at)}</td><td style="font-size:11.5px">${a.applied_at ? d16(a.applied_at) : '—'}</td>
            <td>${badge(a.status)}</td><td style="font-size:12px;max-width:260px">${esc(a.reason)}</td></tr>`).join('')
          || `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:18px">${t('No amendments yet — the order is exactly as imported.')}</td></tr>`}
        </tbody></table></div>
      </div>
      <div data-el="amd-editor"></div>
      <div data-el="amd-view"></div>`;

    el.querySelector('[data-amd="create"]').addEventListener('click', openEditor);
    el.querySelector('[data-amd="xls"]').addEventListener('click', exportExcel);
    el.querySelector('[data-amd="pdf"]').addEventListener('click', exportPdf);
    el.querySelectorAll('[data-view]').forEach((r) => r.addEventListener('click', () => openView(+r.dataset.view)));
    if (editor) paintEditor();
    if (viewing) paintView();
  }

  // ---- create: header modal-card + item editor -------------------------------
  function openEditor() {
    const open = amendments.find((a) => ['Draft', 'Submitted', 'Approved'].includes(a.status));
    if (open) return toast(t('An amendment is already in progress — finish it first'), 'err');
    const no = amendments.length ? Math.max(...amendments.map((a) => a.amendment_no)) + 1 : 1;
    editor = {
      no,
      head: { reason: '', referenceEmail: '', referenceNumber: '', comments: '' },
      rows: ctx.items.map((it) => ({
        op: null, po_item_id: it.id, item_code: it.item_code, roshen_id: it.roshen_id,
        supplier_item_code: it.supplier_item_code, description: it.item_description,
        old_qty: Number(it.ordered_cases), new_qty: null,
        old_price: Number(it.price_case), new_price: null,
        old_eta: it.expected_arrival || null, new_eta: null, sku_id: it.sku_id,
      })),
      added: [],
    };
    viewing = null;
    paint();
    el.querySelector('[data-el="amd-editor"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function collectLines() {
    const lines = [];
    editor.rows.forEach((r) => {
      if (r.op === 'remove') { lines.push({ ...r, op: 'remove' }); return; }
      const changed = (r.new_qty != null && r.new_qty !== '' && Number(r.new_qty) !== r.old_qty)
        || (r.new_price != null && r.new_price !== '' && Number(r.new_price) !== r.old_price)
        || (r.new_eta && r.new_eta !== r.old_eta);
      if (changed) lines.push({
        ...r, op: 'change',
        new_qty: r.new_qty !== null && r.new_qty !== '' ? Number(r.new_qty) : null,
        new_price: r.new_price !== null && r.new_price !== '' ? Number(r.new_price) : null,
      });
    });
    editor.added.forEach((r) => { if (r.item_code || r.roshen_id) lines.push({ ...r, op: 'add', new_qty: Number(r.new_qty), new_price: Number(r.new_price) }); });
    return lines;
  }

  function paintEditor() {
    const host = el.querySelector('[data-el="amd-editor"]');
    const e = editor;
    const lines = collectLines();
    const errors = validateAmendment(lines, ctx);
    const shippedOf = (r) => ctx.shipped[(r.roshen_id || '') && r.roshen_id + '|' + r.item_code] ?? 0;
    host.innerHTML = `<div class="sc-card amd-card">
      <div class="sc-card-h"><h3>📝 ${t('New Amendment')} <span class="mono">AMD-${String(e.no).padStart(2, '0')}</span></h3>
        <div class="sc-spacer"></div>${badge('Draft')}</div>
      <div class="amd-head">
        <div class="sc-field"><label>${t('Amendment Number')}</label><input class="sc-input" value="AMD-${String(e.no).padStart(2, '0')}" disabled></div>
        <div class="sc-field"><label>${t('Created Date')}</label><input class="sc-input" value="${new Date().toISOString().slice(0, 10)}" disabled></div>
        <div class="sc-field"><label>${t('Created By')}</label><input class="sc-input" value="${esc(currentActor())}" disabled></div>
        <div class="sc-field"><label>${t('Reason')} *</label><input class="sc-input" data-h="reason" value="${esc(e.head.reason)}" placeholder="${t('Why is the order changing?')}"></div>
        <div class="sc-field"><label>${t('Reference Email')}</label><input class="sc-input" data-h="referenceEmail" value="${esc(e.head.referenceEmail)}"></div>
        <div class="sc-field"><label>${t('Reference Number')}</label><input class="sc-input" data-h="referenceNumber" value="${esc(e.head.referenceNumber)}"></div>
        <div class="sc-field" style="grid-column:1/-1"><label>${t('Comments')}</label><textarea class="sc-input" data-h="comments" rows="2">${esc(e.head.comments)}</textarea></div>
      </div>
      <div class="sc-table-wrap"><table class="sc-table amd-table"><thead><tr>
        <th>${t('Roshen SKU')}</th><th>${t('Supplier SKU')}</th><th>${t('Description')}</th>
        <th class="num">${t('Current Qty')}</th><th class="num">${t('New Qty')}</th><th class="num">${t('Difference')}</th>
        <th class="num">${t('Current Price')}</th><th class="num">${t('New Price')}</th><th class="num">${t('Difference')}</th>
        <th>${t('Expected Arrival')}</th><th>${t('New Expected Arrival')}</th><th></th></tr></thead><tbody>
        ${e.rows.map((r, i) => {
          const dq = r.new_qty !== null && r.new_qty !== '' ? Number(r.new_qty) - r.old_qty : 0;
          const dp = r.new_price !== null && r.new_price !== '' ? +(Number(r.new_price) - r.old_price).toFixed(2) : 0;
          return `<tr class="${r.op === 'remove' ? 'amd-removed' : ''}">
          <td class="mono">${esc(r.item_code)}<div style="font-size:10px;color:var(--text-muted)">${esc(r.roshen_id || '')}</div></td>
          <td class="mono">${esc(r.supplier_item_code || '—')}</td>
          <td style="font-size:11.5px;max-width:180px">${esc(String(r.description || '').slice(0, 40))}</td>
          <td class="num">${qty(r.old_qty)}</td>
          <td><input class="sc-input sm num amd-in" type="number" min="0" step="1" data-row="${i}" data-f="new_qty" value="${r.new_qty ?? ''}" placeholder="${qty(r.old_qty)}" ${r.op === 'remove' ? 'disabled' : ''}></td>
          <td class="num">${dq ? `<span class="${dq > 0 ? 'amd-up' : 'amd-down'}">${dq > 0 ? '+' : ''}${qty(dq)}</span>` : '—'}</td>
          <td class="num">${money(r.old_price)}</td>
          <td><input class="sc-input sm num amd-in" type="number" min="0" step="0.01" data-row="${i}" data-f="new_price" value="${r.new_price ?? ''}" placeholder="${money(r.old_price)}" ${r.op === 'remove' ? 'disabled' : ''}></td>
          <td class="num">${dp ? `<span class="amd-price">${dp > 0 ? '+' : ''}${money(dp)}</span>` : '—'}</td>
          <td style="font-size:11.5px">${esc(r.old_eta ? fmtDay(r.old_eta) : '—')}</td>
          <td><input class="sc-input sm amd-in" type="date" data-row="${i}" data-f="new_eta" value="${r.new_eta || ''}" ${r.op === 'remove' ? 'disabled' : ''}></td>
          <td><button class="sc-btn sm ghost" data-rm="${i}" title="${t('Remove SKU')}">${r.op === 'remove' ? '↩ ' + t('Keep') : '🗑 ' + t('Remove')}</button></td></tr>`;
        }).join('')}
        ${e.added.map((r, i) => `<tr class="amd-added">
          <td><input class="sc-input sm mono" data-add="${i}" data-f="item_code" value="${esc(r.item_code || '')}" placeholder="ROS…"></td>
          <td><input class="sc-input sm mono" data-add="${i}" data-f="supplier_item_code" value="${esc(r.supplier_item_code || '')}"></td>
          <td><input class="sc-input sm" data-add="${i}" data-f="description" value="${esc(r.description || '')}" placeholder="${t('Description')}"></td>
          <td class="num">—</td>
          <td><input class="sc-input sm num" type="number" min="0" data-add="${i}" data-f="new_qty" value="${r.new_qty || ''}"></td>
          <td class="num"><span class="amd-up">+${qty(Number(r.new_qty) || 0)}</span></td>
          <td class="num">—</td>
          <td><input class="sc-input sm num" type="number" min="0" step="0.01" data-add="${i}" data-f="new_price" value="${r.new_price || ''}"></td>
          <td class="num">—</td><td>—</td>
          <td><input class="sc-input sm" type="date" data-add="${i}" data-f="new_eta" value="${r.new_eta || ''}"></td>
          <td><button class="sc-btn sm ghost" data-unadd="${i}">✖</button></td></tr>`).join('')}
      </tbody></table></div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="sc-btn sm ghost" data-amd="addsku">＋ ${t('Add New SKU')}</button>
        <span class="sc-spacer"></span>
        <span style="font-size:11.5px;color:var(--text-muted);align-self:center">${lines.length} ${t('change(s)')}</span>
        <button class="sc-btn ghost" data-amd="discard">${t('Discard')}</button>
        <button class="sc-btn" data-amd="save" ${!lines.length || errors.length ? 'disabled' : ''}>💾 ${t('Save Draft')}</button></div>
      ${errors.length ? `<div class="amd-errors">${errors.map((x) => `<div>⚠ <b>${esc(x.line)}</b> — ${esc(x.error)}</div>`).join('')}</div>` : ''}
    </div>`;

    // wire inputs — state saves on EVERY keystroke (so no value is ever lost),
    // the recompute/re-render happens asynchronously after change/blur (so the
    // browser finishes its event dispatch before the DOM is replaced)
    const saveVal = (inp) => {
      if (inp.dataset.row != null) editor.rows[+inp.dataset.row][inp.dataset.f] = inp.value;
      else if (inp.dataset.add != null) editor.added[+inp.dataset.add][inp.dataset.f] = inp.value;
    };
    host.querySelectorAll('.amd-in, [data-add][data-f]').forEach((inp) => {
      inp.addEventListener('input', () => saveVal(inp));
      inp.addEventListener('change', () => { saveVal(inp); setTimeout(paintEditor, 0); });
    });
    host.querySelectorAll('[data-h]').forEach((inp) => inp.addEventListener('input', () => { editor.head[inp.dataset.h] = inp.value; }));
    host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      const r = editor.rows[+b.dataset.rm];
      r.op = r.op === 'remove' ? null : 'remove';
      paintEditor();
    }));
    host.querySelectorAll('[data-unadd]').forEach((b) => b.addEventListener('click', () => { editor.added.splice(+b.dataset.unadd, 1); paintEditor(); }));
    host.querySelector('[data-amd="addsku"]').addEventListener('click', () => { editor.added.push({ new_qty: '', new_price: '', new_eta: '' }); paintEditor(); });
    host.querySelector('[data-amd="discard"]').addEventListener('click', () => { editor = null; paint(); });
    host.querySelector('[data-amd="save"]').addEventListener('click', async () => {
      try {
        if (!editor.head.reason.trim()) return toast(t('A reason is required'), 'err');
        await createAmendment(orderId, { ...editor.head, lines: collectLines() });
        toast(t('Amendment saved as Draft'), 'ok');
        editor = null;
        await reload(); paint();
      } catch (err) { toast(err.message || String(err), 'err'); }
    });
  }

  // ---- view: workflow actions + difference screen + audit --------------------
  async function openView(id) {
    viewing = { ...(await getAmendment(id)), audit: await amendmentAudit(id) };
    editor = null;
    paint();
    el.querySelector('[data-el="amd-view"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function paintView() {
    const a = viewing;
    const host = el.querySelector('[data-el="amd-view"]');
    const superAdmin = canApproveAmendments();
    const act = (k, label, cls = 'ghost') => `<button class="sc-btn sm ${cls}" data-act-amd="${k}">${label}</button>`;
    const actions = [
      a.status === 'Draft' ? act('submit', '📤 ' + t('Submit'), '') : '',
      a.status === 'Submitted' && superAdmin ? act('approve', '✅ ' + t('Approve'), '') : '',
      a.status === 'Approved' && superAdmin ? act('apply', '⚡ ' + t('Apply Amendment'), '') : '',
      ['Submitted', 'Approved'].includes(a.status) && superAdmin ? act('reject', '✖ ' + t('Reject')) : '',
      ['Draft', 'Submitted'].includes(a.status) ? act('cancel', '🚫 ' + t('Cancel')) : '',
    ].join(' ');
    host.innerHTML = `<div class="sc-card amd-card">
      <div class="sc-card-h"><h3>📋 AMD-${String(a.amendment_no).padStart(2, '0')} — ${t('Difference')}</h3>
        ${badge(a.status)}<div class="sc-spacer"></div>${actions}
        <button class="sc-btn sm ghost" data-act-amd="close">✖</button></div>
      <div class="bf-info" style="margin-top:0">
        <div class="bf-kv"><span>${t('Reason')}</span><b>${esc(a.reason)}</b></div>
        <div class="bf-kv"><span>${t('Reference Email')}</span><b>${esc(a.reference_email || '—')}</b></div>
        <div class="bf-kv"><span>${t('Reference Number')}</span><b>${esc(a.reference_number || '—')}</b></div>
        <div class="bf-kv"><span>${t('Comments')}</span><b>${esc(a.comments || '—')}</b></div>
        ${a.rejection_reason ? `<div class="bf-kv"><span>${t('Rejection Reason')}</span><b>${esc(a.rejection_reason)}</b></div>` : ''}
      </div>
      <div class="amd-legend">
        <span class="amd-up">■ ${t('Increase')}</span><span class="amd-down">■ ${t('Decrease')}</span>
        <span class="amd-price">■ ${t('Price Change')}</span><span class="amd-eta">■ ${t('ETA Change')}</span></div>
      <div class="sc-table-wrap"><table class="sc-table"><thead><tr>
        <th>${t('Operation')}</th><th>${t('Roshen SKU')}</th><th>${t('Description')}</th>
        <th>${t('Quantity')} (${t('Before')} → ${t('After')})</th><th>${t('Price')} (${t('Before')} → ${t('After')})</th>
        <th>${t('Expected Arrival')} (${t('Before')} → ${t('After')})</th></tr></thead><tbody>
        ${a.lines.map((l) => `<tr>
          <td>${l.op === 'add' ? '<span class="amd-up">＋ ' + t('Added') + '</span>' : l.op === 'remove' ? '<span class="amd-down">－ ' + t('Removed') + '</span>' : t('Changed')}</td>
          <td class="mono">${esc(l.item_code || l.roshen_id || '')}</td>
          <td style="font-size:11.5px">${esc(String(l.description || '').slice(0, 42))}</td>
          <td>${diffCell(l.old_qty != null ? qty(l.old_qty) : null, l.new_qty != null ? qty(l.new_qty) : null, 'qty')}</td>
          <td>${diffCell(l.old_price != null ? money(l.old_price) : null, l.new_price != null ? money(l.new_price) : null, 'price')}</td>
          <td>${diffCell(l.old_eta ? fmtDay(l.old_eta) : null, l.new_eta ? fmtDay(l.new_eta) : null, 'eta')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="sc-card" style="margin-top:12px"><div class="sc-card-h"><h3>🔒 ${t('Audit Log')}</h3>
        <span class="sc-badge none">${a.audit.length}</span></div>
        <div class="sc-table-wrap"><table class="sc-table"><thead><tr>
          <th>${t('User')}</th><th>${t('Date')}</th><th>${t('Action')}</th><th>IP</th><th>${t('Browser')}</th><th>${t('Device')}</th>
          <th>${t('Old Value')}</th><th>${t('New Value')}</th><th>${t('Reason')}</th></tr></thead><tbody>
          ${a.audit.map((x) => `<tr>
            <td>${esc(x.actor)}</td><td style="font-size:11px">${d16(x.at)}</td><td>${esc(x.action)}</td>
            <td class="mono" style="font-size:10.5px">${esc(x.ip || '—')}</td>
            <td style="font-size:10.5px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.browser || '')}">${esc(String(x.browser || '—').split(' · ')[0])}</td>
            <td>${esc(x.device || '—')}</td>
            <td style="font-size:10.5px;max-width:170px">${esc(x.old_value ? JSON.stringify(x.old_value).slice(0, 60) : '—')}</td>
            <td style="font-size:10.5px;max-width:170px">${esc(x.new_value ? JSON.stringify(x.new_value).slice(0, 60) : '—')}</td>
            <td style="font-size:11px">${esc(x.reason || '—')}</td></tr>`).join('')}
        </tbody></table></div></div>
    </div>`;

    host.querySelectorAll('[data-act-amd]').forEach((b) => b.addEventListener('click', async () => {
      const k = b.dataset.actAmd;
      try {
        if (k === 'close') { viewing = null; paint(); return; }
        if (k === 'submit') await submitAmendment(a.id);
        if (k === 'approve') await approveAmendment(a.id);
        if (k === 'apply') { await applyAmendment(a.id); toast(t('Amendment applied — every screen now shows the new figures'), 'ok'); }
        if (k === 'reject') {
          const why = prompt(t('Rejection reason:'));
          if (!why) return;
          await rejectAmendment(a.id, why);
        }
        if (k === 'cancel') await cancelAmendment(a.id);
        await reload();
        viewing = { ...(await getAmendment(a.id)), audit: await amendmentAudit(a.id) };
        paint();
        if (k !== 'apply') toast(t('Amendment updated'), 'ok');
      } catch (err) { toast(err.message || String(err), 'err'); }
    }));
  }

  // ---- exports: Original PI · Current PI · Revision History · Differences ----
  // "Original PI" = today's lines rolled BACK through every applied amendment
  function originalItems() {
    const items = ctx.items.map((it) => ({ ...it }));
    const applied = amendments.filter((a) => a.status === 'Applied').sort((x, y) => y.amendment_no - x.amendment_no);
    // reverse in newest-first order using the stored before/after snapshots
    return appliedRollback(items, applied);
  }
  function appliedRollback(items, appliedDesc) {
    // synchronous rollback using cached lines (fetched below in export)
    return { items, appliedDesc };
  }
  async function exportRows() {
    const detail = await Promise.all(amendments.map((a) => getAmendment(a.id)));
    const current = ctx.items.map((it) => ({ ...it }));
    let original = current.map((it) => ({ ...it }));
    detail.filter((a) => a.status === 'Applied').sort((x, y) => y.amendment_no - x.amendment_no).forEach((a) => {
      a.lines.forEach((l) => {
        if (l.op === 'change') {
          const it = original.find((x) => x.id === l.po_item_id);
          if (!it) return;
          if (l.old_qty != null) it.ordered_cases = Number(l.old_qty);
          if (l.old_price != null) it.price_case = Number(l.old_price);
          if (l.old_eta !== null) it.expected_arrival = l.old_eta;
        } else if (l.op === 'add') {
          original = original.filter((x) => !(x.item_code === l.item_code && String(x.roshen_id || '') === String(l.roshen_id || '')));
        } else if (l.op === 'remove') {
          original.push({ item_code: l.item_code, roshen_id: l.roshen_id, item_description: l.description, ordered_cases: Number(l.old_qty || 0), price_case: Number(l.old_price || 0), expected_arrival: l.old_eta });
        }
      });
    });
    return { detail, current, original };
  }
  const itemAoa = (items) => [[t('Roshen SKU'), t('ERP Item Code'), t('Description'), t('Ordered Qty'), t('Price / Case'), t('Line Total'), t('Expected Arrival')],
    ...items.map((it) => [it.item_code, it.roshen_id, it.item_description, Number(it.ordered_cases || 0), Number(it.price_case || 0), +(Number(it.ordered_cases || 0) * Number(it.price_case || 0)).toFixed(2), it.expected_arrival || ''])];

  async function exportExcel() {
    if (!window.XLSX) return toast(t('Excel engine not loaded'), 'err');
    const { detail, current, original } = await exportRows();
    const wb = window.XLSX.utils.book_new();
    const add = (name, aoa) => {
      const ws = window.XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = (aoa[0] || []).map((h, i) => ({ wch: Math.min(42, Math.max(String(h).length + 2, ...aoa.slice(1).map((r) => String(r[i] ?? '').length + 2))) }));
      window.XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    };
    add(t('Original PI'), itemAoa(original));
    add(t('Current PI'), itemAoa(current));
    add(t('Revision History'), [[t('Revision'), t('Status'), t('Created By'), t('Created Date'), t('Applied By'), t('Applied Date'), t('Reason'), t('Reference Number')],
      ...detail.map((a) => [`AMD-${String(a.amendment_no).padStart(2, '0')}`, a.status, a.created_by, String(a.created_at).slice(0, 16).replace('T', ' '), a.applied_by || '', a.applied_at ? String(a.applied_at).slice(0, 16).replace('T', ' ') : '', a.reason, a.reference_number || ''])]);
    add(t('Differences'), [[t('Revision'), t('Operation'), t('Roshen SKU'), t('Description'), t('Old Qty'), t('New Qty'), t('Old Price'), t('New Price'), t('Old ETA'), t('New ETA')],
      ...detail.flatMap((a) => a.lines.map((l) => [`AMD-${String(a.amendment_no).padStart(2, '0')}`, l.op, l.item_code || l.roshen_id, l.description || '', l.old_qty ?? '', l.new_qty ?? '', l.old_price ?? '', l.new_price ?? '', l.old_eta || '', l.new_eta || '']))]);
    window.XLSX.writeFile(wb, `${String(orderNumber).replace(/[^\w-]+/g, '_')}_amendments.xlsx`);
    toast(t('Amendments exported'), 'ok');
  }

  async function exportPdf() {
    const { detail, current, original } = await exportRows();
    const w = window.open('', '_blank', 'width=1200,height=800');
    if (!w) return toast(t('Allow pop-ups to export'), 'err');
    const itemsTable = (items) => `<table><thead><tr><th>${t('Roshen SKU')}</th><th>${t('Description')}</th><th class="r">${t('Ordered Qty')}</th><th class="r">${t('Price / Case')}</th><th class="r">${t('Line Total')}</th></tr></thead>
      <tbody>${items.map((it) => `<tr><td>${esc(it.item_code || '')}</td><td>${esc(String(it.item_description || '').slice(0, 48))}</td>
        <td class="r">${qty(it.ordered_cases)}</td><td class="r">${money(it.price_case)}</td><td class="r">${money(Number(it.ordered_cases || 0) * Number(it.price_case || 0))}</td></tr>`).join('')}</tbody></table>`;
    w.document.write(`<!doctype html><html dir="${document.documentElement.dir}"><head><title>${esc(orderNumber)} — ${t('Amendments')}</title><style>
      @page{size:A4 landscape;margin:12mm}
      body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:10px}
      h1{font-size:16px;margin:0}h2{font-size:12px;margin:14px 0 6px}.sub{color:#555;font-size:10px;margin:2px 0 10px}
      .logo{font-size:13px;font-weight:800;letter-spacing:.04em}
      table{width:100%;border-collapse:collapse;margin-bottom:6px}th,td{border:1px solid #bbb;padding:3px 5px;text-align:start}
      th{background:#efefef;font-size:9px;text-transform:uppercase}td.r{text-align:end}
      thead{display:table-header-group}
      .up{color:#2FB344;font-weight:700}.down{color:#E03131;font-weight:700}
      footer{position:fixed;bottom:0;inset-inline-end:0;font-size:8px;color:#888}
    </style></head><body>
      <div class="logo">🏭 Roshen / Relia — Supply Chain</div>
      <h1>${t('Amendments')} — ${esc(orderNumber)}</h1>
      <div class="sub">${t('Supplier')}: ${esc(supplier || '—')} · ${t('Generated')} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
      <h2>${t('Original PI')}</h2>${itemsTable(original)}
      <h2>${t('Current PI')}</h2>${itemsTable(current)}
      <h2>${t('Revision History')}</h2>
      <table><thead><tr><th>${t('Revision')}</th><th>${t('Status')}</th><th>${t('Created By')}</th><th>${t('Created Date')}</th><th>${t('Applied By')}</th><th>${t('Applied Date')}</th><th>${t('Reason')}</th></tr></thead>
      <tbody>${detail.map((a) => `<tr><td>AMD-${String(a.amendment_no).padStart(2, '0')}</td><td>${esc(a.status)}</td><td>${esc(a.created_by)}</td>
        <td>${String(a.created_at).slice(0, 16).replace('T', ' ')}</td><td>${esc(a.applied_by || '—')}</td>
        <td>${a.applied_at ? String(a.applied_at).slice(0, 16).replace('T', ' ') : '—'}</td><td>${esc(a.reason)}</td></tr>`).join('') || `<tr><td colspan="7">${t('No amendments yet — the order is exactly as imported.')}</td></tr>`}</tbody></table>
      <h2>${t('Differences')}</h2>
      <table><thead><tr><th>${t('Revision')}</th><th>${t('Operation')}</th><th>${t('Roshen SKU')}</th><th>${t('Old Qty')}</th><th>${t('New Qty')}</th><th>${t('Old Price')}</th><th>${t('New Price')}</th><th>${t('Old ETA')}</th><th>${t('New ETA')}</th></tr></thead>
      <tbody>${detail.flatMap((a) => a.lines.map((l) => `<tr><td>AMD-${String(a.amendment_no).padStart(2, '0')}</td>
        <td class="${l.op === 'add' ? 'up' : l.op === 'remove' ? 'down' : ''}">${esc(l.op)}</td><td>${esc(l.item_code || l.roshen_id || '')}</td>
        <td>${l.old_qty ?? '—'}</td><td>${l.new_qty ?? '—'}</td><td>${l.old_price ?? '—'}</td><td>${l.new_price ?? '—'}</td>
        <td>${l.old_eta || '—'}</td><td>${l.new_eta || '—'}</td></tr>`)).join('') || `<tr><td colspan="9">—</td></tr>`}</tbody></table>
      <footer>Roshen / Relia Supply Chain · ${esc(orderNumber)}</footer>
    </body></html>`);
    w.document.close();
    setTimeout(() => { w.print(); }, 400);
  }

  paint();
}

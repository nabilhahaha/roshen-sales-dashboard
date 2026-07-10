// Import Order route — file upload entry point, then hands off to the import
// flow (mapping → preview → create). Rendered into its own fresh content node.
import { mount, wire } from '../../../utils/dom.js';
import { toast } from '../../../components/notifications/toast.js';
import { startImportFlow } from './import-order.flow.js';

export function render(root, ctx) {
  mount(root, `
    <div class="sc-card-h"><h3>📥 Import Purchase Order from Excel</h3><div class="sc-spacer"></div>
      <button class="sc-btn sm ghost" data-act="cancel">← Cancel</button></div>
    <div class="sc-card">
      <div class="erp-drop" data-el="drop">
        <div style="font-size:40px;opacity:.6">📄</div>
        <div style="margin-top:10px;font-weight:700;color:var(--text-primary)">Upload a Purchase Order Excel</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">.xlsx / .xls — you'll map the columns and preview before the order is created</div>
        <input type="file" accept=".xlsx,.xls" data-el="file" style="display:none">
      </div>
    </div>`);

  const drop = root.querySelector('[data-el="drop"]');
  const file = root.querySelector('[data-el="file"]');
  wire(root, { cancel: () => ctx.navigate('order-history') });
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => handle(file.files && file.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files && e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });

  function handle(f) {
    if (!f) return;
    if (typeof window.XLSX === 'undefined') { toast('Excel engine not loaded', 'err'); return; }
    const rd = new FileReader();
    rd.onload = (e) => startImportFlow(root, ctx, e.target.result, f.name, f);
    rd.readAsArrayBuffer(f);
  }
}

// Placeholder page for reserved future modules.
import { mount } from '../utils/dom.js';
import { esc } from '../utils/format.js';
import { labelOf, iconOf } from '../models/navigation.js';

const DESC = {
  shipment: 'Track supplier shipments, containers, vessels, BL numbers and ETAs against approved PIs.',
  'goods-receiving': 'Receive goods against a PI, record received quantities, and post discrepancies.',
  inventory: 'Live stock on hand per SKU, warehouse and batch, fed by goods receiving.',
  'batch-tracking': 'Lot / batch numbers per received line for full traceability.',
  expiry: 'Shelf-life and expiry monitoring with near-expiry alerts.',
  'returns-supplier': 'Raise and track returns of defective or expired stock back to Roshen.',
  claims: 'Log and follow commercial / quality claims with the supplier.',
  reports: 'Cross-module procurement and supplier-performance reports.',
  settings: 'Company details, warehouses, suppliers, currencies and workflow rules.',
};

export function render(root, ctx) {
  const section = ctx.section;
  mount(root, `<div class="sc-card erp-soon">
    <div class="erp-soon-ic">${iconOf(section)}</div>
    <h3>${esc(labelOf(section))}</h3>
    <span class="sc-badge pi">Planned module</span>
    <p>${esc(DESC[section] || 'This Supply Chain module is reserved for a future release.')}</p>
    <p class="erp-soon-note">Reserved in the navigation now so the workflow can extend into it later — it will connect to the same Supabase database.</p>
  </div>`);
}

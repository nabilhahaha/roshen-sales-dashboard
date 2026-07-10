// Purchase History — completed purchase orders (fully received & closed).
// Active orders live on the Purchase Orders screen; both use the SAME shared
// list renderer — one list implementation, two workflow views.
import { renderOrdersList } from '../purchase-orders/orders-list.view.js';

export async function render(root, ctx) {
  return renderOrdersList(root, ctx, 'history');
}

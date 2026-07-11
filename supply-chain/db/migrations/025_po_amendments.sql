-- 025 — Purchase Order Amendments (ERP-style, full history, immutable audit)
--
-- The original Purchase Order is NEVER edited directly: every change goes
-- through an amendment (Draft → Submitted → Approved → Applied / Rejected /
-- Cancelled). Applying an amendment updates supply_order_items through the
-- normal service path; the amendment rows keep the complete before/after
-- forever. Nothing here is deletable.

create table if not exists po_amendments (
  id bigint generated always as identity primary key,
  order_id bigint not null references supply_orders(id),
  amendment_no int not null,
  status text not null default 'Draft'
    check (status in ('Draft','Submitted','Approved','Applied','Rejected','Cancelled')),
  reason text not null,
  reference_email text,
  reference_number text,
  comments text,
  created_by text not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz, submitted_by text,
  approved_at timestamptz, approved_by text,
  applied_at timestamptz, applied_by text,
  rejected_at timestamptz, rejected_by text, rejection_reason text,
  cancelled_at timestamptz, cancelled_by text,
  unique (order_id, amendment_no)
);
create index if not exists po_amendments_order_idx on po_amendments(order_id);

-- one row per changed line: complete before/after snapshot
create table if not exists po_amendment_lines (
  id bigint generated always as identity primary key,
  amendment_id bigint not null references po_amendments(id),
  -- SET NULL: removing an (undocumented) order line must not be blocked by
  -- the amendment's own snapshot row — the snapshot keeps the full item data
  po_item_id bigint references supply_order_items(id) on delete set null,
  op text not null check (op in ('add','change','remove')),
  item_code text, roshen_id text, supplier_item_code text, description text,
  sku_id bigint,
  old_qty numeric, new_qty numeric,
  old_price numeric, new_price numeric,
  old_eta date, new_eta date
);
create index if not exists po_amendment_lines_amd_idx on po_amendment_lines(amendment_id);

-- immutable audit: user, timestamp, ip, browser, device, old/new, reason
create table if not exists po_amendment_audit (
  id bigint generated always as identity primary key,
  amendment_id bigint not null references po_amendments(id),
  order_id bigint not null,
  action text not null,
  actor text not null,
  at timestamptz not null default now(),
  ip text, browser text, device text,
  old_value jsonb, new_value jsonb,
  reason text
);
create index if not exists po_amendment_audit_amd_idx on po_amendment_audit(amendment_id);

-- nothing is deletable; the audit trail is also immutable
create or replace function po_amendment_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'amendment records are permanent — % on % is not allowed', tg_op, tg_table_name;
end $$;

drop trigger if exists po_amendment_audit_immutable on po_amendment_audit;
create trigger po_amendment_audit_immutable
  before update or delete on po_amendment_audit
  for each row execute function po_amendment_immutable();
drop trigger if exists po_amendments_no_delete on po_amendments;
create trigger po_amendments_no_delete
  before delete on po_amendments
  for each row execute function po_amendment_immutable();
drop trigger if exists po_amendment_lines_no_delete on po_amendment_lines;
create trigger po_amendment_lines_no_delete
  before delete on po_amendment_lines
  for each row execute function po_amendment_immutable();

-- per-line expected arrival (amendable); header expected_arrival stays
alter table supply_order_items add column if not exists expected_arrival date;

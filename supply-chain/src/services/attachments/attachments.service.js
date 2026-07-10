// Document attachments — files live in Supabase Storage, the database keeps
// ONLY metadata. Screens list metadata lazily (nothing is fetched until the
// attachments panel is opened) and files are streamed straight from storage
// on preview/download, so a PI with hundreds of attachments stays fast.
//
// Any PI / Delivery Note / Supplier Invoice carries multiple attachments of
// any supported type. Replacing uploads a new revision — the old version is
// marked superseded but kept permanently (audit); storage objects are never
// deleted or overwritten.
import { getClient } from '../supabase/client.js';

export const BUCKET = 'supply-attachments';
export const DOC_TYPES = ['purchase_order', 'delivery_note', 'supplier_invoice'];

// Supported formats — deliberately NOT pdf-only.
export const ACCEPTED = {
  pdf:  'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
  csv:  'text/csv',
  jpg:  'image/jpeg', jpeg: 'image/jpeg',
  png:  'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  eml:  'message/rfc822',
  msg:  'application/vnd.ms-outlook',
};
export const ACCEPT_ATTR = Object.keys(ACCEPTED).map((e) => '.' + e).join(',');
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

const extOf = (name) => String(name || '').split('.').pop().toLowerCase();
export const isAccepted = (name) => !!ACCEPTED[extOf(name)];
export const kindOf = (nameOrMime) => {
  const s = String(nameOrMime || '').toLowerCase();
  const e = extOf(s);
  if (s.includes('pdf')) return 'pdf';
  if (s.includes('image') || ['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(e)) return 'image';
  if (['doc', 'docx'].includes(e) || s.includes('msword') || s.includes('wordprocessingml')) return 'word';
  if (['eml', 'msg'].includes(e) || s.includes('rfc822') || s.includes('ms-outlook')) return 'email';
  return 'sheet';
};
// in-app preview: pdf, most images, Excel (parsed grid), plain-text emails
export const canPreview = (att) => {
  const k = kindOf(att.mime || att.filename);
  const e = extOf(att.filename);
  if (k === 'pdf' || k === 'sheet') return e !== 'csv' ? true : true;
  if (k === 'image') return e !== 'heic';
  if (k === 'email') return e === 'eml';
  return false;   // word/msg: download only
};

// Attach the ORIGINAL uploaded document to the record it created — called by
// every import flow (PI / DN / Supplier Invoice) so the user never has to
// upload the same file twice and the source document stays linked forever.
// Best-effort by design: the document row is already saved; a failed
// attachment must never roll it back (the caller may warn the user).
export async function attachOriginalDocument(docType, docId, file, actor) {
  if (!file) return false;
  try { await uploadAttachment(docType, docId, file, { actor: actor || 'import' }); return true; }
  catch (e) { try { console.error('Attaching the original document failed:', e); } catch (x) {} return false; }
}

// Metadata list — current revisions first-class, history available on demand.
export async function listAttachments(docType, docId, { includeHistory = false } = {}) {
  let q = getClient().from('document_attachments')
    .select('id,doc_type,doc_id,filename,mime,byte_size,storage_path,revision,supersedes_id,superseded,uploaded_by,created_at')
    .eq('doc_type', docType).eq('doc_id', docId).order('created_at', { ascending: false });
  if (!includeHistory) q = q.eq('superseded', false);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function countAttachments(docType, docId) {
  const { count, error } = await getClient().from('document_attachments')
    .select('id', { count: 'exact', head: true }).eq('doc_type', docType).eq('doc_id', docId).eq('superseded', false);
  if (error) throw error;
  return count || 0;
}

export function attachmentUrl(att) {
  const { data } = getClient().storage.from(BUCKET).getPublicUrl(att.storage_path);
  return data.publicUrl;
}

// Upload one file (File/Blob + name) and record its metadata. Pass replaceId
// to upload a new REVISION of an existing attachment — the old row is marked
// superseded (kept forever), the new row continues the chain.
export async function uploadAttachment(docType, docId, file, { name, replaceId, actor } = {}) {
  if (!DOC_TYPES.includes(docType)) throw new Error('Unknown document type: ' + docType);
  const filename = name || file.name || 'attachment';
  if (!isAccepted(filename)) throw new Error(`"${filename}" is not a supported type. Allowed: PDF, Excel (${'xlsx/xls/csv'}), images (jpg/png/heic/webp).`);
  const size = file.size != null ? file.size : null;
  if (size != null && size > MAX_BYTES) throw new Error(`"${filename}" is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
  const c = getClient();

  let revision = 1, supersedes = null;
  if (replaceId) {
    const { data: prev, error: eP } = await c.from('document_attachments').select('id,revision').eq('id', replaceId).single();
    if (eP) throw eP;
    revision = Number(prev.revision || 1) + 1;
    supersedes = prev.id;
  }

  const safe = filename.replace(/[^\w.\-]+/g, '_');
  const path = `${docType}/${docId}/${Date.now()}_r${revision}_${safe}`;
  const mime = ACCEPTED[extOf(filename)] || file.type || 'application/octet-stream';
  const { error: eUp } = await c.storage.from(BUCKET).upload(path, file, { contentType: mime, upsert: false });
  if (eUp) throw new Error('Upload failed: ' + (eUp.message || eUp));

  const { data: row, error: eIns } = await c.from('document_attachments').insert({
    doc_type: docType, doc_id: docId, filename, mime, byte_size: size,
    storage_path: path, revision, supersedes_id: supersedes, uploaded_by: actor || null,
  }).select().single();
  if (eIns) throw eIns;
  if (replaceId) {
    const { error: eSup } = await c.from('document_attachments').update({ superseded: true }).eq('id', replaceId);
    if (eSup) throw eSup;
  }
  return row;
}

// Full revision chain for one attachment (newest first) — loaded on demand.
// Walks the supersedes_id links in both directions.
export async function attachmentHistory(att) {
  const { data, error } = await getClient().from('document_attachments')
    .select('id,filename,mime,revision,byte_size,storage_path,supersedes_id,superseded,uploaded_by,created_at')
    .eq('doc_type', att.doc_type).eq('doc_id', att.doc_id);
  if (error) throw error;
  const all = data || [];
  const related = new Set([att.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of all) {
      const linked = (r.supersedes_id && related.has(r.supersedes_id)) ||
                     (related.has(r.id)) ||
                     all.some((x) => related.has(x.id) && x.supersedes_id === r.id);
      if (linked && !related.has(r.id)) { related.add(r.id); grew = true; }
    }
  }
  return all.filter((r) => related.has(r.id)).sort((a, b) => b.revision - a.revision || b.id - a.id);
}

// Every attachment across a purchase order's WHOLE document chain (the PO
// itself, all its delivery notes and supplier invoices) — the same records the
// per-document panels show, fetched in one sweep so any screen in the chain
// (e.g. the warehouse receipt, which has no uploaded original of its own) can
// reference them WITHOUT duplicating files.
export async function listChainAttachments(orderId) {
  const c = getClient();
  const [{ data: dns }, { data: sis }] = await Promise.all([
    c.from('delivery_notes').select('id,dn_number').eq('order_id', orderId),
    c.from('supplier_invoices').select('id,invoice_number').eq('order_id', orderId),
  ]);
  const dnIds = (dns || []).map((d) => d.id), siIds = (sis || []).map((s) => s.id);
  const dnName = {}; (dns || []).forEach((d) => { dnName[d.id] = d.dn_number; });
  const siName = {}; (sis || []).forEach((s) => { siName[s.id] = s.invoice_number; });
  const sel = 'id,doc_type,doc_id,filename,mime,byte_size,storage_path,revision,uploaded_by,created_at';
  const qs = [c.from('document_attachments').select(sel).eq('doc_type', 'purchase_order').eq('doc_id', orderId).eq('superseded', false)];
  if (dnIds.length) qs.push(c.from('document_attachments').select(sel).eq('doc_type', 'delivery_note').in('doc_id', dnIds).eq('superseded', false));
  if (siIds.length) qs.push(c.from('document_attachments').select(sel).eq('doc_type', 'supplier_invoice').in('doc_id', siIds).eq('superseded', false));
  const results = await Promise.all(qs);
  const out = [];
  results.forEach((r) => (r.data || []).forEach((a) => out.push({
    ...a,
    doc_label: a.doc_type === 'purchase_order' ? 'Purchase Order'
      : a.doc_type === 'delivery_note' ? 'DN ' + (dnName[a.doc_id] || '#' + a.doc_id)
      : 'Invoice ' + (siName[a.doc_id] || '#' + a.doc_id),
  })));
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

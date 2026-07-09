// Delivery-Note field catalogue + heuristic rules for the shared mapping
// engine. Matching is only ever by Item Code / Roshen ID — never description.

export const DN_MAPPING = {
  storeKey: 'roshen_sc_dn_mappings_v1',
  fields: [
    { key: 'item_code', label: 'Item Code' },
    { key: 'roshen_id', label: 'Roshen ID', required: true },  // primary match key
    { key: 'description', label: 'Item Name / Description' },
    { key: 'expiry_date', label: 'Expiry Date', required: true },
    { key: 'manufacturing_date', label: 'Manufacturing Date' },
    { key: 'batch_no', label: 'Batch / Lot No.' },
    { key: 'cartons', label: 'Cartons (cases)', required: true },
    { key: 'boxes', label: 'Boxes' },
    { key: 'pieces', label: 'Pieces' },
    { key: 'uom', label: 'Unit of Measure' },
    { key: 'barcode', label: 'Barcode' },
  ],
  // Order matters: specific/compound labels are matched before generic ones so
  // e.g. "BAR code (box)" maps to barcode (not boxes) and "Unit of measure"
  // maps to uom (not pieces). Each field is assigned at most once.
  rules: [
    [/item\s*code|^sku$|article|short\s*code/i, 'item_code'],
    [/roshen|^code$|^\s*code\s*$/i, 'roshen_id'],
    [/manufactur|prod(uction)?\s*date|\bmfg\b/i, 'manufacturing_date'],
    [/expiry|expire|best\s*before|exp\.?\s*date|shelf\s*life/i, 'expiry_date'],
    [/batch|\blot\b/i, 'batch_no'],
    [/bar\s*code|barcode|\bean\b/i, 'barcode'],
    [/uom|unit\s*of\s*measure|\bmeasure\b/i, 'uom'],
    [/carton|cases|\bctn\b/i, 'cartons'],
    [/item\s*name|description|desc\b|product\s*name/i, 'description'],
    [/^box|\bbox(es)?\b/i, 'boxes'],
    [/^pcs|\bpcs\b|pieces/i, 'pieces'],
  ],
};

/**
 * Fill the "Order list" and "PO Multivac" sheets of Template_Purchase_Order_2026.xlsx.
 *
 * Only these package parts are ever modified:
 *   - the XML of the "Order list" sheet and of the "PO Multivac" sheet
 *   - the comments + VML parts that belong to "Order list" (so its note moves with its cell)
 *   - xl/workbook.xml (defined names of the two sheets, and fullCalcOnLoad)
 *   - xl/calcChain.xml (removed, with its relationship and content-type entry; Excel rebuilds it)
 * Every other part is copied byte for byte.
 */
import {
  NS_M,
  Package,
  TemplateError,
  all,
  cellMap,
  cellText,
  child,
  colStyles,
  colToN,
  colWidths,
  dumpXml,
  findSheet,
  fmtNum,
  insertAfter,
  kids,
  mapRefs,
  neededRowHeight,
  newEl,
  parseXml,
  readRels,
  resolveTarget,
  rowMap,
  rowsOf,
  SheetInfo,
  sharedStrings,
  shiftRange,
  shiftRowsInFormula,
  splitRef,
} from './ooxml';
import { MODES, ModeProfile, PoMode } from './profiles';

export const ORDER_SHEET = 'Order list';
export const PO_SHEET = 'PO Multivac';
const UNSUPPORTED = [
  'conditionalFormatting', 'dataValidations', 'autoFilter', 'rowBreaks', 'colBreaks',
  'hyperlinks', 'tableParts', 'drawing', 'extLst', 'ignoredErrors',
];
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface QuoteItem {
  reference: string;
  description: string;
  netPrice: number;
  quantity: number;
  unit?: string;
  /** optional PO "Details" text for this item (only used for the first item when the user chose Replace) */
  details?: string;
}

export type DetailsMode = 'keep' | 'clear';

export interface FillOptions {
  items: QuoteItem[];
  /** Multivac: EUR -> MUR (Order list column I). Third party: ZAR -> MUR (Quotation_3rd Pty column I). */
  rate: number;
  /** Third party only: MUR per EUR (Quotation_3rd Pty column T). */
  rate2?: number;
  quotationNo: string;
  detailsMode: DetailsMode;
  /** defaults to 'multivac' */
  mode?: PoMode;
}

export interface OrderInfo {
  header: number;
  first: number;
  last: number;
  totalsOld: number;
  totalsNew: number;
  k: number;
  existing: number;
}

export interface PoInfo {
  header: number;
  first: number;
  last: number;
  totalOld: number;
  totalNew: number;
  k: number;
  existing: number;
}

export interface PoSheetResult {
  name: string;
  part: string;
  info: PoInfo;
}

export interface FillResult {
  bytes: Uint8Array;
  pkg: Package;
  mode: PoMode;
  costPart: string;
  costName: string;
  order: OrderInfo;
  pos: PoSheetResult[];
  commentParts: string[];
}

// ---------------------------------------------------------------- cell setters
function clearCell(c: Element) {
  while (c.firstChild) c.removeChild(c.firstChild);
  c.removeAttribute('t');
}

export function setText(c: Element, text: string) {
  clearCell(c);
  if (text === '') return;
  const doc = c.ownerDocument!;
  c.setAttribute('t', 'inlineStr');
  const is = newEl(doc, 'is');
  const t = newEl(doc, 't');
  t.appendChild(doc.createTextNode(text));
  if (text !== text.trim()) t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  is.appendChild(t);
  c.appendChild(is);
}

export function setNumber(c: Element, x: number) {
  clearCell(c);
  const v = newEl(c.ownerDocument!, 'v');
  v.appendChild(c.ownerDocument!.createTextNode(fmtNum(x)));
  c.appendChild(v);
}

export function setFormula(c: Element, text: string) {
  clearCell(c);
  const f = newEl(c.ownerDocument!, 'f');
  f.appendChild(c.ownerDocument!.createTextNode(text));
  c.appendChild(f);
}

function getCell(row: Element, col: string, styles: Record<string, string> = {}): Element {
  const r = row.getAttribute('r')!;
  let after: Element | null = null;
  for (const c of kids(row, 'c')) {
    const cc = splitRef(c.getAttribute('r')!)[0];
    if (cc === col) return c;
    if (colToN(cc) < colToN(col)) after = c;
  }
  const nc = newEl(row.ownerDocument!, 'c');
  nc.setAttribute('r', `${col}${r}`);
  // a cell that does not exist yet would otherwise lose the column's formatting
  if (styles[col]) nc.setAttribute('s', styles[col]);
  insertAfter(row, nc, after);
  return nc;
}

function requireCell(cells: Record<string, Element>, col: string, sheet: string, row: number): Element {
  const c = cells[col];
  if (!c) throw new TemplateError(`"${sheet}": cell ${col}${row} is missing in the template row.`);
  return c;
}

// ------------------------------------------------------------ structure helpers
function guard(root: Element, sheet: string) {
  const bad = UNSUPPORTED.filter((t) => child(root, t));
  if (bad.length) {
    throw new TemplateError(
      `"${sheet}" contains ${bad.join(', ')}, which this app cannot shift safely. Nothing was changed.`,
    );
  }
  for (const f of all(root, 'f')) {
    if (f.getAttribute('t') === 'shared' && !(f.textContent || '').trim()) {
      throw new TemplateError(`"${sheet}" uses shared formulas this app cannot move safely. Nothing was changed.`);
    }
  }
}

export function findRowByText(
  root: Element,
  sst: string[],
  col: string,
  pred: (t: string) => boolean,
  start = 1,
  end = 1e9,
): number | null {
  for (const row of rowsOf(root)) {
    const r = parseInt(row.getAttribute('r')!, 10);
    if (r < start || r > end) continue;
    const c = cellMap(row)[col];
    if (c) {
      const txt = cellText(c, sst);
      if (txt !== null && pred(txt)) return r;
    }
  }
  return null;
}

/**
 * Insert k copies of the template item row at insertAt (Excel "insert rows" semantics):
 * all rows >= insertAt move down by k, and every formula, merged range and the dimension
 * are shifted accordingly.
 */
function insertItemRows(root: Element, templateRowNo: number, insertAt: number, k: number) {
  if (k <= 0) return;
  const rows = rowsOf(root);
  // 1. shift formulas everywhere (item rows refer to the totals row with K$4-style refs)
  for (const row of rows) {
    const r = parseInt(row.getAttribute('r')!, 10);
    for (const c of kids(row, 'c')) {
      const f = child(c, 'f');
      if (!f) continue;
      const text = f.textContent || '';
      if (text) {
        if (text.includes('!') && r >= insertAt) {
          throw new TemplateError(`Cross-sheet formula in moved cell ${c.getAttribute('r')}: ${text}`);
        }
        f.textContent = shiftRowsInFormula(text, insertAt, k);
      }
      if (f.getAttribute('ref')) f.setAttribute('ref', shiftRange(f.getAttribute('ref')!, insertAt, k));
    }
  }
  // 2. renumber rows that move
  for (const row of rows) {
    const r = parseInt(row.getAttribute('r')!, 10);
    if (r >= insertAt) {
      row.setAttribute('r', String(r + k));
      for (const c of kids(row, 'c')) {
        const [col] = splitRef(c.getAttribute('r')!);
        c.setAttribute('r', `${col}${r + k}`);
      }
    }
  }
  // 3. new rows are exact copies of the (already shifted) template row
  const template = rowMap(root).get(templateRowNo)!;
  const sheetData = child(root, 'sheetData')!;
  const anchor = rowsOf(root).find((row) => parseInt(row.getAttribute('r')!, 10) >= insertAt + k) || null;
  for (let i = 0; i < k; i++) {
    const newNo = insertAt + i;
    const nr = template.cloneNode(true) as Element;
    nr.setAttribute('r', String(newNo));
    for (const c of kids(nr, 'c')) {
      const [col] = splitRef(c.getAttribute('r')!);
      c.setAttribute('r', `${col}${newNo}`);
      const f = child(c, 'f');
      if (f) {
        for (const a of ['t', 'ref', 'si']) f.removeAttribute(a);
        const text = f.textContent || '';
        if (text) {
          f.textContent = mapRefs(text, (_c, _ac, ar, r) => (r === templateRowNo && !ar ? newNo : r));
        }
      }
    }
    sheetData.insertBefore(nr, anchor);
  }
  // 4. merged cells + dimension
  const mc = child(root, 'mergeCells');
  if (mc) for (const m of kids(mc, 'mergeCell')) m.setAttribute('ref', shiftRange(m.getAttribute('ref')!, insertAt, k));
  const dim = child(root, 'dimension');
  if (dim) dim.setAttribute('ref', shiftRange(dim.getAttribute('ref')!, insertAt, k));
}

/** Totals row: SUM(X<first>:X<anything>) / SUM(X<first>) -> SUM(X<first>:X<last>). */
function rewriteTotalRanges(rowEl: Element, first: number, last: number) {
  const re = new RegExp(`^SUM\\(([A-Z]+)${first}(?::([A-Z]+)\\d+)?\\)$`);
  for (const c of kids(rowEl, 'c')) {
    const f = child(c, 'f');
    const text = f?.textContent || '';
    if (!f || !text) continue;
    const m = re.exec(text);
    if (m && (m[2] === undefined || m[2] === m[1])) f.textContent = `SUM(${m[1]}${first}:${m[1]}${last})`;
  }
}

/** Remove cached results from formula cells so they get recomputed (cells in `keep` are left alone). */
export function stripCached(root: Element, keep: (c: Element) => boolean = () => false) {
  for (const c of all(root, 'c')) {
    if (!child(c, 'f') || keep(c)) continue;
    const v = child(c, 'v');
    if (v) c.removeChild(v);
    c.removeAttribute('t');
  }
}

// ------------------------------------------------------------- the cost + PO sheets
/** Order list (Multivac) or Quotation_3rd Pty (third party): the cost build-up that receives the quotation lines. */
function fillCostSheet(
  root: Element,
  sst: string[],
  sheetName: string,
  items: QuoteItem[],
  rate: number,
  extra: Record<string, number>,
): OrderInfo {
  guard(root, sheetName);
  const hdr = findRowByText(root, sst, 'A', (t) => t.trim().toLowerCase() === 'reference', 1, 10);
  if (hdr === null) throw new TemplateError(`"${sheetName}": header cell "Reference" not found in column A.`);
  const first = hdr + 1;
  let rm = rowMap(root);
  let totals: number | null = null;
  for (const r of [...rm.keys()].sort((a, b) => a - b)) {
    if (r <= first) continue;
    const e = cellMap(rm.get(r)!)['E'];
    const f = e ? child(e, 'f') : null;
    if (f && (f.textContent || '').startsWith('SUM(E')) {
      totals = r;
      break;
    }
  }
  if (totals === null) throw new TemplateError(`"${sheetName}": totals row (SUM in column E) not found.`);
  const existing = totals - first;
  const n = items.length;
  if (n < existing) {
    throw new TemplateError(
      `"${sheetName}" has ${existing} item rows but the quotation has only ${n} items. Spare rows are not handled automatically.`,
    );
  }
  const k = n - existing;
  const styles = colStyles(root);
  const tmpl = cellMap(rm.get(first)!);
  const duty = parseFloat(cellText(requireCell(tmpl, 'O', sheetName, first), sst) || '0');
  const vatRaw = cellText(requireCell(tmpl, 'P', sheetName, first), sst);
  const vat = vatRaw === null ? 0.15 : parseFloat(vatRaw);
  insertItemRows(root, first + existing - 1, totals, k);
  const last = first + n - 1;
  rm = rowMap(root);
  items.forEach((it, i) => {
    const row = rm.get(first + i)!;
    setText(getCell(row, 'A', styles), it.reference);
    setText(getCell(row, 'B', styles), it.description);
    setNumber(getCell(row, 'E', styles), it.netPrice);
    setNumber(getCell(row, 'F', styles), it.quantity);
    setNumber(getCell(row, 'I', styles), rate);
    for (const [col, v] of Object.entries(extra)) setNumber(getCell(row, col, styles), v);
    setNumber(getCell(row, 'O', styles), duty);
    setNumber(getCell(row, 'P', styles), vat);
  });
  rewriteTotalRanges(rm.get(totals + k)!, first, last);
  return { header: hdr, first, last, totalsOld: totals, totalsNew: totals + k, k, existing };
}

/** PO sheets (PO Multivac, PO Bizerba, PO Handtmann): same layout, items link to the cost sheet. */
function fillPo(
  root: Element,
  sst: string[],
  poName: string,
  costName: string,
  items: QuoteItem[],
  ol: OrderInfo,
  detailsMode: DetailsMode,
  quotationNo: string,
): PoInfo {
  guard(root, poName);
  const hdr = findRowByText(root, sst, 'A', (t) => t.trim().toLowerCase() === 'pos', 1, 60);
  if (hdr === null) throw new TemplateError(`"${poName}": header cell "Pos" not found in column A.`);
  const first = hdr + 1;
  // "Total" (Multivac) or "Total Exwork:" (Bizerba, Handtmann)
  const total = findRowByText(root, sst, 'D', (t) => t.trim().toLowerCase().startsWith('total'), first);
  if (total === null) throw new TemplateError(`"${poName}": "Total" row not found in column D.`);
  const existing = total - first;
  const n = items.length;
  if (n < existing) throw new TemplateError(`"${poName}" has ${existing} item rows but there are only ${n} items.`);
  const k = n - existing;
  insertItemRows(root, first + existing - 1, total, k);
  let rm = rowMap(root);
  const styles = colStyles(root);
  items.forEach((it, i) => {
    const r = first + i;
    const cells = cellMap(rm.get(r)!);
    const src = ol.first + i;
    setNumber(requireCell(cells, 'A', poName, r), i + 1);
    setFormula(requireCell(cells, 'B', poName, r), `'${costName}'!A${src}`);
    setFormula(requireCell(cells, 'C', poName, r), `'${costName}'!B${src}`);
    setFormula(requireCell(cells, 'D', poName, r), `'${costName}'!F${src}`);
    // Unit price = the quotation's net price per unit (column E). Never the line total (column G),
    // otherwise Total Price = Qty x (Qty x price).
    setFormula(requireCell(cells, 'F', poName, r), `'${costName}'!E${src}`);
    setFormula(requireCell(cells, 'G', poName, r), `F${r}*D${r}`);
    const det = getCell(rm.get(r)!, 'E', styles);
    if (it.details) setText(det, it.details);
    else if (i === 0 && detailsMode === 'keep') {
      /* leave the template's own Details cell exactly as it is */
    } else clearCell(det); // new rows never inherit the first row's sample text
  });
  const last = first + n - 1;
  rewriteTotalRanges(rm.get(total + k)!, first, last);

  // Item rows have a fixed one-line height but wrap their text, so long descriptions would be
  // clipped in print. Grow each row to fit its wrapped text.
  const widths = colWidths(root);
  const baseHt = parseFloat(rm.get(first)!.getAttribute('ht') || '15.6');
  items.forEach((it, i) => {
    const row = rm.get(first + i)!;
    const texts: [string, number][] = [
      [it.description, widths['C'] ?? 27.5],
      [it.reference, widths['B'] ?? 15.3],
    ];
    const det =
      i === 0 && !it.details && detailsMode === 'keep' ? cellText(cellMap(row)['E'], sst) : it.details;
    if (det) texts.push([det, widths['E'] ?? 14.8]);
    const [ht, lines] = neededRowHeight(baseHt, texts);
    if (lines > 1) {
      row.setAttribute('ht', String(ht));
      row.setAttribute('customHeight', '1');
    }
  });

  if (quotationNo) {
    const qr = findRowByText(root, sst, 'A', (t) => t.trim().toLowerCase().startsWith('your quotation'));
    if (qr === null) throw new TemplateError(`"${poName}": "Your Quotation:" cell not found.`);
    rm = rowMap(root);
    setText(getCell(rm.get(qr)!, 'A', styles), `Your Quotation: ${quotationNo}`);
  }
  return { header: hdr, first, last, totalOld: total, totalNew: total + k, k, existing };
}

// ------------------------------------------------- comments / VML / workbook parts
function shiftComments(pkg: Package, sheetPart: string, insertAt: number, k: number): string[] {
  if (k <= 0) return [];
  const touched: string[] = [];
  const rels = readRels(pkg, sheetPart);
  const hasComments = Object.values(rels).some(([t]) => t.endsWith('/comments'));
  for (const [typ, target] of Object.values(rels)) {
    const part = resolveTarget(sheetPart, target);
    if (typ.endsWith('/comments')) {
      const xml = pkg.getText(part);
      const out = xml.replace(/<comment ref="([A-Z]+\d+)"/g, (_m, ref) => {
        const [col, r] = splitRef(ref);
        return `<comment ref="${col}${r >= insertAt ? r + k : r}"`;
      });
      if (out !== xml) {
        pkg.setText(part, out);
        touched.push(part);
      }
    } else if (typ.endsWith('/vmlDrawing') && hasComments) {
      const xml = pkg.getText(part);
      const out = xml.replace(/<v:shape [\s\S]*?<\/v:shape>/g, (shape) => {
        const row0 = /<x:Row>(\d+)<\/x:Row>/.exec(shape);
        if (!row0 || parseInt(row0[1], 10) + 1 < insertAt) return shape;
        let s = shape.replace(/<x:Row>(\d+)<\/x:Row>/g, (_m, r) => `<x:Row>${parseInt(r, 10) + k}</x:Row>`);
        s = s.replace(/<x:Anchor>([^<]*)<\/x:Anchor>/g, (_m, inner) => {
          const v = inner.split(',').map((x: string) => x.trim());
          v[2] = String(parseInt(v[2], 10) + k);
          v[6] = String(parseInt(v[6], 10) + k);
          return `<x:Anchor>\n    ${v.join(', ')}</x:Anchor>`;
        });
        return s;
      });
      if (out !== xml) {
        pkg.setText(part, out);
        touched.push(part);
      }
    }
  }
  return touched;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function editWorkbookParts(pkg: Package, shifts: Record<string, [number, number]>) {
  let wb = pkg.getText('xl/workbook.xml');
  wb = wb.replace(/(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/g, (_m, head, text, tail) => {
    for (const [name, [insertAt, k]] of Object.entries(shifts)) {
      const pat = new RegExp(
        `((?:'|&apos;)${escapeRe(name)}(?:'|&apos;)!)(\\$?[A-Z]+\\$?\\d+(?::\\$?[A-Z]+\\$?\\d+)?)`,
        'g',
      );
      text = text.replace(pat, (_mm: string, a: string, b: string) => a + shiftRange(b, insertAt, k));
    }
    return head + text + tail;
  });
  if (!wb.includes('fullCalcOnLoad')) wb = wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  pkg.setText('xl/workbook.xml', wb);

  if (pkg.has('xl/calcChain.xml')) {
    pkg.delete('xl/calcChain.xml');
    pkg.setText(
      'xl/_rels/workbook.xml.rels',
      pkg.getText('xl/_rels/workbook.xml.rels').replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ''),
    );
    pkg.setText(
      '[Content_Types].xml',
      pkg.getText('[Content_Types].xml').replace(/<Override\b[^>]*calcChain[^>]*\/>/g, ''),
    );
  }
}

// ----------------------------------------------------------------------- main
export function validateOptions(o: FillOptions) {
  if (!o.items.length) throw new TemplateError('The quotation has no items.');
  if (!(o.rate > 0)) throw new TemplateError('The exchange rate must be a positive number.');
  if (MODES[o.mode ?? 'multivac'].secondRateCol && !(o.rate2 && o.rate2 > 0)) {
    throw new TemplateError('The EUR to MUR rate must be a positive number.');
  }
  o.items.forEach((it, i) => {
    if (!it.reference.trim() || !it.description.trim()) throw new TemplateError(`Item ${i + 1} has an empty reference or description.`);
    if (!Number.isFinite(it.netPrice) || it.netPrice < 0) throw new TemplateError(`Item ${i + 1}: invalid net price.`);
    if (!Number.isFinite(it.quantity) || it.quantity <= 0) throw new TemplateError(`Item ${i + 1}: invalid quantity.`);
  });
}

/** Resolves the cost sheet for a profile, checking costSheetCandidates if primary is not found. */
export function resolveCostSheet(pkg: Package, profile: ModeProfile): SheetInfo {
  const candidates = profile.costSheetCandidates && profile.costSheetCandidates.length > 0
    ? profile.costSheetCandidates
    : [profile.costSheet];
  for (const cand of candidates) {
    try {
      return findSheet(pkg, cand);
    } catch {
      // try next candidate
    }
  }
  return findSheet(pkg, profile.costSheet);
}

/** The PO sheet(s) of a type. A missing optional sheet (PO Others) is skipped; any other missing sheet is an error. */
export function resolvePoSheets(pkg: Package, profile: ModeProfile): SheetInfo[] {
  const out: SheetInfo[] = [];
  for (const n of profile.poSheets) {
    const candidates = profile.poSheetCandidates?.[n] ?? [n];
    let found: SheetInfo | null = null;
    for (const cand of candidates) {
      try {
        found = findSheet(pkg, cand);
        break;
      } catch {
        // try next candidate
      }
    }
    if (found) {
      out.push(found);
    } else if (!profile.poOptional) {
      throw new TemplateError(`Sheet "${n}" not found (or ambiguous).`);
    }
  }
  return out;
}

export interface FinalizeContext {
  pkg: Package;
  sheets: { name: string; root: Element }[];
}

/**
 * Edit the package in memory. `finalize` (calc.ts) computes cached values afterwards;
 * it gets the parsed sheet documents so it can inject results before they are serialized.
 */
export async function fillWorkbook(
  template: ArrayBuffer | Uint8Array,
  opts: FillOptions,
  finalize: (ctx: FinalizeContext) => void,
): Promise<FillResult> {
  validateOptions(opts);
  const mode: PoMode = opts.mode ?? 'multivac';
  const profile = MODES[mode];
  const pkg = await Package.load(template);
  const sst = sharedStrings(pkg);
  const cost = resolveCostSheet(pkg, profile);
  const poSheets = resolvePoSheets(pkg, profile);
  const costDoc = parseXml(pkg.get(cost.part));
  const poDocs = poSheets.map((p) => parseXml(pkg.get(p.part)));
  const costRoot = costDoc.documentElement;

  const extra: Record<string, number> = profile.secondRateCol ? { [profile.secondRateCol]: opts.rate2! } : {};
  const order = fillCostSheet(costRoot, sst, cost.name, opts.items, opts.rate, extra);
  const pos: PoSheetResult[] = poSheets.map((p, i) => ({
    name: p.name,
    part: p.part,
    info: fillPo(poDocs[i].documentElement, sst, p.name, cost.name, opts.items, order, opts.detailsMode, opts.quotationNo),
  }));

  const commentParts = shiftComments(pkg, cost.part, order.totalsOld, order.k);
  const shifts: Record<string, [number, number]> = { [cost.name]: [order.totalsOld, order.k] };
  for (const p of pos) shifts[p.name] = [p.info.totalOld, p.info.k];
  editWorkbookParts(pkg, shifts);

  finalize({
    pkg,
    sheets: [
      { name: cost.name, root: costRoot },
      ...pos.map((p, i) => ({ name: p.name, root: poDocs[i].documentElement })),
    ],
  });

  pkg.set(cost.part, dumpXml(costDoc));
  poSheets.forEach((p, i) => pkg.set(p.part, dumpXml(poDocs[i])));
  const bytes = await pkg.save();
  return { bytes, pkg, mode, costPart: cost.part, costName: cost.name, order, pos, commentParts };
}

export { NS_M };

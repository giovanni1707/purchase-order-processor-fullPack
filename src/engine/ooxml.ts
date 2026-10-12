/**
 * Small OOXML helpers. The workbook is edited at package (zip/XML) level on purpose:
 * loading and saving it with a spreadsheet library would silently drop the header logo,
 * hidden-sheet settings, extension data validations, external-link caches and more.
 * Every part we do not need to change is copied byte for byte.
 *
 * Needs the standard DOMParser / XMLSerializer globals (browser, or @xmldom/xmldom in Node tests).
 */
import JSZip from 'jszip';

export const NS_M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const td = new TextDecoder();
const te = new TextEncoder();

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

// ----------------------------------------------------------------- A1 helpers
export function colToN(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

export function nToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function splitRef(ref: string): [string, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new TemplateError(`Bad cell reference: ${ref}`);
  return [m[1], parseInt(m[2], 10)];
}

// Unqualified A1 reference. The look-behind skips sheet-qualified references
// (Sheet!A1, 'My sheet'!A1) and names; the look-ahead skips function names.
const REF_SRC = "(?<![A-Za-z0-9_!'.$])(\\$?)([A-Z]{1,3})(\\$?)(\\d+)(?![A-Za-z0-9_(!])";

/** Apply fn(col, absCol, absRow, row) -> newRow to each unqualified A1 reference. Text in "quotes" is left alone. */
export function mapRefs(
  formula: string,
  fn: (col: string, absCol: boolean, absRow: boolean, row: number) => number,
): string {
  const parts = formula.split(/("(?:[^"]|"")*")/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(new RegExp(REF_SRC, 'g'), (_m, ac, col, ar, row) => {
      const nr = fn(col, ac === '$', ar === '$', parseInt(row, 10));
      return `${ac}${col}${ar}${nr}`;
    });
  }
  return parts.join('');
}

/** Same behaviour as Excel's "insert k rows at insertAt" for unqualified refs. */
export function shiftRowsInFormula(formula: string, insertAt: number, k: number): string {
  return mapRefs(formula, (_c, _ac, _ar, r) => (r >= insertAt ? r + k : r));
}

/** Shift an A1 or A1:B2 range (no sheet name) like Excel does on row insert. */
export function shiftRange(rng: string, insertAt: number, k: number): string {
  const one = (ref: string) => {
    const m = /^(\$?[A-Z]+)(\$?)(\d+)$/.exec(ref);
    if (!m) return ref;
    const r = parseInt(m[3], 10);
    return `${m[1]}${m[2]}${r >= insertAt ? r + k : r}`;
  };
  return rng.split(':').map(one).join(':');
}

// ------------------------------------------------------------- package access
export class Package {
  order: string[] = [];
  data = new Map<string, Uint8Array>();
  deleted = new Set<string>();

  static async load(buf: ArrayBuffer | Uint8Array): Promise<Package> {
    const zip = await JSZip.loadAsync(buf);
    const p = new Package();
    for (const name of Object.keys(zip.files)) {
      const f = zip.files[name];
      if (f.dir) continue;
      p.order.push(name);
      p.data.set(name, await f.async('uint8array'));
    }
    return p;
  }

  has(name: string) {
    return this.data.has(name) && !this.deleted.has(name);
  }
  get(name: string): Uint8Array {
    const d = this.data.get(name);
    if (!d) throw new TemplateError(`Package part missing: ${name}`);
    return d;
  }
  set(name: string, content: Uint8Array) {
    if (!this.data.has(name)) throw new TemplateError(`Package part missing: ${name}`);
    this.data.set(name, content);
  }
  delete(name: string) {
    this.deleted.add(name);
  }
  getText(name: string) {
    return td.decode(this.get(name));
  }
  setText(name: string, text: string) {
    this.set(name, te.encode(text));
  }
  parts(): string[] {
    return this.order.filter((n) => !this.deleted.has(n));
  }

  async save(): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const name of this.order) {
      if (this.deleted.has(name)) continue;
      zip.file(name, this.data.get(name)!, { compression: 'DEFLATE', binary: true, createFolders: false });
    }
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------------------ DOM
export function parseXml(bytes: Uint8Array): Document {
  return new DOMParser().parseFromString(td.decode(bytes), 'application/xml');
}

export function dumpXml(doc: Document): Uint8Array {
  return te.encode(XML_DECL + new XMLSerializer().serializeToString(doc.documentElement));
}

export function kids(el: Element, tag?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!tag || (n as Element).localName === tag)) out.push(n as Element);
  }
  return out;
}

export function child(el: Element, tag: string): Element | null {
  return kids(el, tag)[0] ?? null;
}

export function all(el: Element | Document, tag: string): Element[] {
  return Array.from(el.getElementsByTagNameNS(NS_M, tag)) as Element[];
}

export function newEl(doc: Document, tag: string): Element {
  return doc.createElementNS(NS_M, tag);
}

export function insertAfter(parent: Node, node: Node, ref: Node | null) {
  parent.insertBefore(node, ref ? ref.nextSibling : parent.firstChild);
}

export function relsPath(part: string) {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

function normPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

export function resolveTarget(part: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const dir = part.slice(0, part.lastIndexOf('/'));
  return normPath(`${dir}/${target}`);
}

export function readRels(pkg: Package, part: string): Record<string, [string, string]> {
  const p = relsPath(part);
  if (!pkg.has(p)) return {};
  const out: Record<string, [string, string]> = {};
  for (const r of Array.from(parseXml(pkg.get(p)).documentElement.childNodes)) {
    if (r.nodeType !== 1) continue;
    const e = r as Element;
    out[e.getAttribute('Id')!] = [e.getAttribute('Type')!, e.getAttribute('Target')!];
  }
  return out;
}

export interface SheetInfo {
  name: string;
  state: string;
  part: string;
}

export function sheetParts(pkg: Package): SheetInfo[] {
  const wb = parseXml(pkg.get('xl/workbook.xml')).documentElement;
  const rels = readRels(pkg, 'xl/workbook.xml');
  const sheets = child(wb, 'sheets');
  if (!sheets) throw new TemplateError('xl/workbook.xml has no <sheets>');
  return kids(sheets, 'sheet').map((s) => {
    const rid = s.getAttributeNS(NS_R, 'id') || s.getAttribute('r:id')!;
    return {
      name: s.getAttribute('name')!,
      state: s.getAttribute('state') || 'visible',
      part: resolveTarget('xl/workbook.xml', rels[rid][1]),
    };
  });
}

const normName = (x: string) => x.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

export function findSheet(pkg: Package, wanted: string): SheetInfo {
  const sheets = sheetParts(pkg);
  const exact = sheets.find((s) => s.name === wanted);
  if (exact) return exact;
  // tolerant: ignore case, surrounding spaces and the difference between "_", "-" and " "
  for (const norm of [(x: string) => x.trim().toLowerCase(), normName]) {
    const hits = sheets.filter((s) => norm(s.name) === norm(wanted));
    if (hits.length === 1) return hits[0];
  }
  throw new TemplateError(`Sheet "${wanted}" not found (or ambiguous).`);
}

export function sharedStrings(pkg: Package): string[] {
  if (!pkg.has('xl/sharedStrings.xml')) return [];
  const root = parseXml(pkg.get('xl/sharedStrings.xml')).documentElement;
  return kids(root, 'si').map((si) => all(si, 't').map((t) => t.textContent || '').join(''));
}

export function cellText(c: Element, sst: string[]): string | null {
  const t = c.getAttribute('t');
  if (t === 'inlineStr') return all(c, 't').map((x) => x.textContent || '').join('');
  const v = child(c, 'v');
  if (!v || v.textContent == null || v.textContent === '') return null;
  if (t === 's') return sst[parseInt(v.textContent, 10)];
  return v.textContent;
}

export const rowsOf = (root: Element): Element[] => kids(child(root, 'sheetData')!, 'row');

export function rowMap(root: Element): Map<number, Element> {
  return new Map(rowsOf(root).map((r) => [parseInt(r.getAttribute('r')!, 10), r]));
}

export function cellMap(row: Element): Record<string, Element> {
  const out: Record<string, Element> = {};
  for (const c of kids(row, 'c')) out[splitRef(c.getAttribute('r')!)[0]] = c;
  return out;
}

export function colWidths(root: Element): Record<string, number> {
  const out: Record<string, number> = {};
  const cols = child(root, 'cols');
  if (!cols) return out;
  for (const c of kids(cols, 'col')) {
    const lo = parseInt(c.getAttribute('min')!, 10);
    const hi = parseInt(c.getAttribute('max')!, 10);
    if (hi - lo > 50) continue;
    for (let n = lo; n <= hi; n++) out[nToCol(n)] = parseFloat(c.getAttribute('width')!);
  }
  return out;
}

/** {column letter: default style index} from the sheet's <cols> block (used for cells that do not exist yet). */
export function colStyles(root: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const cols = child(root, 'cols');
  if (!cols) return out;
  for (const c of kids(cols, 'col')) {
    const lo = parseInt(c.getAttribute('min')!, 10);
    const hi = parseInt(c.getAttribute('max')!, 10);
    const st = c.getAttribute('style');
    if (!st || hi - lo > 50) continue;
    for (let n = lo; n <= hi; n++) out[nToCol(n)] = st;
  }
  return out;
}

export function wrappedLines(text: string, cpl: number): number {
  if (!text) return 1;
  let lines = 0;
  for (const para of String(text).split('\n')) {
    let cur = 0;
    let n = 1;
    for (const word of para.split(' ')) {
      let w = word.length;
      while (w > cpl) {
        if (cur) n += 1;
        n += Math.floor(w / cpl) - (w % cpl === 0 ? 1 : 0);
        w = w % cpl || cpl;
        cur = 0;
      }
      if (cur && cur + 1 + w > cpl) {
        n += 1;
        cur = w;
      } else {
        cur = cur + (cur ? 1 : 0) + w;
      }
    }
    lines += n;
  }
  return lines;
}

export const charsPerLine = (width: number) => Math.max(6, Math.floor(width * 0.88));

export function neededRowHeight(baseHt: number, textsAndWidths: [string, number][]): [number, number] {
  const lines = Math.max(1, ...textsAndWidths.map(([t, w]) => wrappedLines(t, charsPerLine(w))));
  return [Math.round(baseHt * lines * 100) / 100, lines];
}

export const ERROR_VALUES = new Set(['#REF!', '#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#NUM!', '#NULL!']);

export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) throw new TemplateError(`Not a finite number: ${x}`);
  return String(x);
}

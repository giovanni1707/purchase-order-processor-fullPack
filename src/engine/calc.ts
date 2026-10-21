/**
 * Calculation helpers. There is no Excel in the browser, so results are computed with HyperFormula
 * and stored as cached values; the workbook is also flagged fullCalcOnLoad so Excel recalculates anyway.
 */
import { HyperFormula } from 'hyperformula';
import { ERROR_VALUES, all, cellText, child, colToN, fmtNum, newEl, splitRef } from './ooxml';

export interface SheetRef {
  name: string;
  root: Element;
}

export type CellValue = number | string | boolean | null;

const SHEET_REF_RE = /(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!/g;

/** True when a formula points at a sheet outside `internal` (or at an external workbook). */
export function isExternalFormula(text: string, internal: Set<string>): boolean {
  const stripped = text.replace(/"(?:[^"]|"")*"/g, '""');
  if (stripped.includes('[')) return true;
  for (const m of stripped.matchAll(SHEET_REF_RE)) {
    const name = (m[1] ?? m[2]).replace(/''/g, "'");
    if (!internal.has(name)) return true;
  }
  return false;
}

function literalValue(c: Element, sst: string[]): CellValue {
  const t = c.getAttribute('t');
  const txt = cellText(c, sst);
  if (t === 'e') return null;
  if (txt === null) return t === 'inlineStr' ? '' : null;
  if (t === 's' || t === 'str' || t === 'inlineStr') return txt;
  if (t === 'b') return txt === '1';
  const n = Number(txt);
  return Number.isFinite(n) ? n : txt;
}

export interface BuiltCalc {
  hf: HyperFormula;
  ids: Record<string, number>;
  /** cells whose formula points outside the two sheets: cached value is kept as is */
  external: Set<Element>;
  /** literal text of non-formula text cells, "Sheet!A1" -> text */
  texts: Map<string, string>;
}

export function buildCalc(sheets: SheetRef[], sst: string[]): BuiltCalc {
  const internal = new Set(sheets.map((s) => s.name));
  const external = new Set<Element>();
  const texts = new Map<string, string>();
  const matrices: Record<string, (string | number | boolean | null)[][]> = {};

  for (const sh of sheets) {
    const cells = all(sh.root, 'c');
    let maxR = 1;
    let maxC = 1;
    for (const c of cells) {
      const [col, r] = splitRef(c.getAttribute('r')!);
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, colToN(col));
    }
    const m: (string | number | boolean | null)[][] = Array.from({ length: maxR }, () => Array(maxC).fill(null));
    for (const c of cells) {
      const [col, r] = splitRef(c.getAttribute('r')!);
      const f = child(c, 'f');
      const ftext = f?.textContent || '';
      let val: CellValue;
      if (f && ftext) {
        if (isExternalFormula(ftext, internal)) {
          external.add(c);
          val = literalValue(c, sst);
        } else val = `=${ftext}`;
      } else {
        val = literalValue(c, sst);
        const t = c.getAttribute('t');
        if (typeof val === 'string' && (t === 's' || t === 'inlineStr')) texts.set(`${sh.name}!${col}${r}`, val);
        if (typeof val === 'string' && val.startsWith('=')) val = `'${val}`;
      }
      m[r - 1][colToN(col) - 1] = val;
    }
    matrices[sh.name] = m;
  }
  const hf = HyperFormula.buildFromSheets(matrices, { licenseKey: 'gpl-v3' });
  const ids: Record<string, number> = {};
  for (const sh of sheets) ids[sh.name] = hf.getSheetId(sh.name)!;
  return { hf, ids, external, texts };
}

/** Value of a formula cell as HyperFormula computes it (errors -> "#REF!" style strings). */
export function calcValue(calc: BuiltCalc, sheetName: string, coord: string, formula: string): CellValue {
  const [col, r] = splitRef(coord);
  const v = calc.hf.getCellValue({ sheet: calc.ids[sheetName], row: r - 1, col: colToN(col) - 1 }) as unknown;
  // a plain reference to a text cell keeps its text (HyperFormula would read "0012" as the number 12)
  const direct = /^(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!)?\$?([A-Z]+)\$?(\d+)$/.exec(formula);
  if (direct) {
    const src = (direct[1] ?? direct[2] ?? sheetName).replace(/''/g, "'");
    const txt = calc.texts.get(`${src}!${direct[3]}${direct[4]}`);
    if (txt !== undefined) return txt;
  }
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const val = (v as { value?: string }).value;
    return typeof val === 'string' && ERROR_VALUES.has(val) ? val : '#VALUE!';
  }
  return v as CellValue;
}

/** Write recalculated results into every non-external formula cell of a sheet. */
export function injectCached(sh: SheetRef, calc: BuiltCalc) {
  const doc = sh.root.ownerDocument!;
  for (const c of all(sh.root, 'c')) {
    const f = child(c, 'f');
    if (!f || calc.external.has(c)) continue;
    const val = calcValue(calc, sh.name, c.getAttribute('r')!, f.textContent || '');
    for (const old of Array.from(c.childNodes)) {
      if ((old as Element).localName === 'v') c.removeChild(old);
    }
    c.removeAttribute('t');
    const v = newEl(doc, 'v');
    let text: string;
    if (val === null) {
      c.setAttribute('t', 'str');
      text = '';
    } else if (typeof val === 'boolean') {
      c.setAttribute('t', 'b');
      text = val ? '1' : '0';
    } else if (typeof val === 'number') {
      text = fmtNum(val);
    } else if (ERROR_VALUES.has(val)) {
      c.setAttribute('t', 'e');
      text = val;
    } else {
      c.setAttribute('t', 'str');
      text = val;
    }
    if (text) v.appendChild(doc.createTextNode(text));
    c.appendChild(v);
  }
}

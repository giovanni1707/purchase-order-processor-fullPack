/**
 * Re-opens the SAVED workbook and checks it against the original template and the extracted data.
 * The download is only offered when every check passes.
 */
import { buildCalc, calcValue } from './calc';
import { FillOptions, findRowByText, findXeroHeaderRow, findXeroTotalsRow, resolveCostSheet, resolvePoSheets, resolveXeroSheet } from './fill';
import { MODES, manualCostCols } from './profiles';
import {
  ERROR_VALUES,
  Package,
  all,
  bytesEqual,
  cellMap,
  cellText,
  child,
  kids,
  mapRefs,
  parseXml,
  readRels,
  resolveTarget,
  rowMap,
  sharedStrings,
  sheetParts,
  shiftRange,
  shiftRowsInFormula,
  splitRef,
} from './ooxml';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyInput {
  original: ArrayBuffer | Uint8Array;
  output: Uint8Array;
  opts: FillOptions;
  invoiceAmount?: number;
  lineAmounts?: number[];
  listPrices?: number[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const fText = (c: Element | undefined | null) => (c ? child(c, 'f')?.textContent || null : null);
const ser = (el: Element | undefined) => (el ? new XMLSerializer().serializeToString(el) : '');

export async function verifyWorkbook(inp: VerifyInput): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail: ok ? undefined : detail });
  const { items, rate, quotationNo, detailsMode } = inp.opts;
  const n = items.length;

  const mode = inp.opts.mode ?? 'multivac';
  const profile = MODES[mode];
  const manualCols = manualCostCols(mode);
  const orig = await Package.load(inp.original);
  const out = await Package.load(inp.output);
  const oSst = sharedStrings(orig);
  const nSst = sharedStrings(out);
  const oOl = resolveCostSheet(orig, profile);
  const nOl = resolveCostSheet(out, profile);
  const COST = nOl.name;
  const poNames = resolvePoSheets(orig, profile);
  const nPoNames = resolvePoSheets(out, profile);
  const oXero = resolveXeroSheet(orig, profile);
  const nXero = resolveXeroSheet(out, profile);

  // ------------------------------------------------------------ package integrity
  const sig = (p: Package) => JSON.stringify(sheetParts(p).map((s) => [s.name, s.state, s.part]));
  check('Sheet names, order and visibility unchanged', sig(orig) === sig(out), 'The sheet list differs from the template.');

  const olRels = readRels(orig, oOl.part);
  const olExtra = Object.values(olRels)
    .filter(([t]) => t.endsWith('/comments') || t.endsWith('/vmlDrawing'))
    .map(([, target]) => resolveTarget(oOl.part, target));
  const xeroExtra = oXero
    ? Object.values(readRels(orig, oXero.part))
        .filter(([t]) => t.endsWith('/comments') || t.endsWith('/vmlDrawing'))
        .map(([, target]) => resolveTarget(oXero.part, target))
    : [];
  const allowed = new Set([
    oOl.part,
    ...poNames.map((p) => p.part),
    ...(oXero ? [oXero.part] : []),
    'xl/workbook.xml',
    '[Content_Types].xml',
    'xl/_rels/workbook.xml.rels',
    'xl/calcChain.xml',
    ...olExtra,
    ...xeroExtra,
  ]);
  const changed: string[] = [];
  for (const p of orig.parts()) {
    if (allowed.has(p)) continue;
    if (!out.has(p) || !bytesEqual(orig.get(p), out.get(p))) changed.push(p);
  }
  const added = out.parts().filter((p) => !orig.has(p));
  check(
    `All other package parts are byte-identical (${orig.parts().filter((p) => !allowed.has(p)).length} parts)`,
    changed.length === 0 && added.length === 0,
    `Changed: ${changed.join(', ') || '-'}; added: ${added.join(', ') || '-'}`,
  );
  const wbOut = out.getText('xl/workbook.xml');
  check('Excel set to recalculate on open (fullCalcOnLoad)', wbOut.includes('fullCalcOnLoad="1"'));
  check(
    'Stale calc chain removed cleanly',
    !out.has('xl/calcChain.xml') &&
      !/calcChain/.test(out.getText('xl/_rels/workbook.xml.rels')) &&
      !/calcChain/.test(out.getText('[Content_Types].xml')),
  );

  // ----------------------------------------------------------------- sheets
  const oO = parseXml(orig.get(oOl.part)).documentElement;
  const nO = parseXml(out.get(nOl.part)).documentElement;

  // anchors in the ORIGINAL cost sheet
  const oHdr = findRowByText(oO, oSst, 'A', (t) => t.trim().toLowerCase() === 'reference', 1, 10)!;
  const first = oHdr + 1;
  const oRows = rowMap(oO);
  let oTotals = 0;
  for (const r of [...oRows.keys()].sort((a, b) => a - b)) {
    if (r <= first) continue;
    const t = fText(cellMap(oRows.get(r)!)['E']);
    if (t && t.startsWith('SUM(E')) {
      oTotals = r;
      break;
    }
  }
  const existing = oTotals - first;
  const k = n - existing;
  const last = first + n - 1;
  const totals = oTotals + k;

  // ------------------------------------------------------------------- Order list
  const nRows = rowMap(nO);
  check(
    `${COST}: ${n} item rows, totals row right below (row ${totals})`,
    nRows.has(totals) &&
      !!fText(cellMap(nRows.get(totals)!)['E']) &&
      findRowByText(nO, nSst, 'A', (t) => t.trim().toLowerCase() === 'reference', 1, 10) === oHdr,
    'Item row count or header position is not what was expected.',
  );

  const tmplRowNo = first + existing - 1;
  const duty = Number(cellText(cellMap(oRows.get(first)!)['O'], oSst) || 0);
  const vatRaw = cellText(cellMap(oRows.get(first)!)['P'], oSst);
  const vat = vatRaw === null ? 0.15 : Number(vatRaw);
  items.forEach((it, i) => {
    const r = first + i;
    const row = nRows.get(r);
    const problems: string[] = [];
    if (!row) problems.push('row missing');
    else {
      const cells = cellMap(row);
      const txt = (col: string) => (cells[col] ? cellText(cells[col], nSst) : null);
      const isText = (col: string) => cells[col]?.getAttribute('t') === 'inlineStr';
      const num = (col: string) => (cells[col] && !fText(cells[col]) ? Number(txt(col)) : NaN);
      if (txt('A') !== it.reference || !isText('A')) problems.push('reference');
      if (txt('B') !== it.description || !isText('B')) problems.push('part name');
      if (num('E') !== it.netPrice) problems.push('net price');
      if (num('F') !== it.quantity) problems.push('quantity');
      if (num('I') !== rate) problems.push('exchange rate');
      if (profile.secondRateCol && num(profile.secondRateCol) !== inp.opts.rate2) problems.push('EUR rate');
      if (num('O') !== duty) problems.push('duty');
      if (num('P') !== vat) problems.push('VAT');
      // every other column keeps the template formula (row numbers adjusted)
      const base = oRows.get(i < existing ? r : tmplRowNo)!;
      for (const [col, bc] of Object.entries(cellMap(base))) {
        if (manualCols.includes(col)) continue;
        const bf = fText(bc);
        let expected = bf === null ? null : shiftRowsInFormula(bf, oTotals, k);
        if (expected !== null && i >= existing) {
          expected = mapRefs(expected, (_c, _ac, ar, rr) => (rr === tmplRowNo && !ar ? r : rr));
        }
        if (fText(cells[col]) !== expected) problems.push(`formula ${col}`);
      }
    }
    check(`${COST} row ${r}: ${it.reference}`, problems.length === 0, problems.join(', '));
  });

  {
    const tr = nRows.get(totals);
    const bad: string[] = [];
    for (const [col, c] of Object.entries(cellMap(oRows.get(oTotals)!))) {
      const of = fText(c);
      if (!of || !new RegExp(`^SUM\\(${col}${first}(?::${col}\\d+)?\\)$`).test(of)) continue;
      if (!tr || fText(cellMap(tr)[col]) !== `SUM(${col}${first}:${col}${last})`) bad.push(col);
    }
    check(`${COST} totals SUM ranges cover exactly rows ${first} to ${last}`, !!tr && bad.length === 0, `Columns: ${bad.join(', ')}`);
  }

  const movedIntact = (oRoot: Element, nRoot: Element, oS: string[], nS: string[], oldAt: number, kk: number) => {
    const oR = rowMap(oRoot);
    const nR = rowMap(nRoot);
    const bad: string[] = [];
    for (const [r, row] of oR) {
      if (r < oldAt) continue;
      const nr = nR.get(r + kk);
      if (!nr) {
        bad.push(`row ${r + kk} missing`);
        continue;
      }
      const a = cellMap(row);
      const b = cellMap(nr);
      if (Object.keys(a).sort().join() !== Object.keys(b).sort().join()) bad.push(`row ${r + kk}: cells differ`);
      for (const col of Object.keys(a)) {
        if (!b[col]) continue;
        const af = fText(a[col]);
        const bf = fText(b[col]);
        if (af !== null) {
          // the totals row's SUM ranges are extended on purpose; they have their own check
          const isTotalsSum = r === oldAt && /^SUM\(/.test(af);
          if (!isTotalsSum && bf !== shiftRowsInFormula(af, oldAt, kk)) bad.push(`${col}${r + kk} formula`);
        } else if (bf === null && cellText(a[col], oS) !== cellText(b[col], nS)) bad.push(`${col}${r + kk} value`);
        if (a[col].getAttribute('s') !== b[col].getAttribute('s')) bad.push(`${col}${r + kk} style`);
      }
    }
    return bad;
  };
  check(
    `${COST}: totals row and everything below moved down ${k} rows intact`,
    (() => movedIntact(oO, nO, oSst, nSst, oTotals, k).length === 0)(),
    movedIntact(oO, nO, oSst, nSst, oTotals, k).slice(0, 5).join('; '),
  );

  const mergeSet = (root: Element) => {
    const mc = child(root, 'mergeCells');
    return mc ? kids(mc, 'mergeCell').map((m) => m.getAttribute('ref')!) : [];
  };
  check(
    `${COST}: merged cells shifted`,
    mergeSet(oO).map((m) => shiftRange(m, oTotals, k)).sort().join() === mergeSet(nO).sort().join(),
    'Merged ranges differ.',
  );

  {
    const cm = Object.values(olRels).find(([t]) => t.endsWith('/comments'));
    if (!cm) check(`${COST}: cell comment moved with its cell`, true);
    else {
      const part = resolveTarget(oOl.part, cm[1]);
      const refs = (x: string) => [...x.matchAll(/<comment ref="([A-Z]+\d+)"/g)].map((m) => m[1]).sort();
      const exp = refs(orig.getText(part))
        .map((ref) => {
          const [c, r] = splitRef(ref);
          return `${c}${r >= oTotals ? r + k : r}`;
        })
        .sort();
      const got = refs(out.getText(part));
      const vml = Object.values(olRels).find(([t]) => t.endsWith('/vmlDrawing'));
      let vmlOk = true;
      if (vml) {
        const vp = resolveTarget(oOl.part, vml[1]);
        const rws = (x: string) => [...x.matchAll(/<x:Row>(\d+)<\/x:Row>/g)].map((m) => Number(m[1]));
        vmlOk = rws(orig.getText(vp)).map((r) => (r + 1 >= oTotals ? r + k : r)).join() === rws(out.getText(vp)).join();
      }
      check(`${COST}: cell comment (and its note shape) moved with its cell`, exp.join() === got.join() && vmlOk, `Expected ${exp.join()}, found ${got.join()}`);
    }
  }

  // --------------------------------------------------------------------- PO sheets
  const poInfo: { name: string; total: number; root: Element; kp: number; oldTotal: number }[] = [];
  poNames.forEach((oPoS, idx) => {
    const nPoS = nPoNames[idx];
    const PO = nPoS.name;
    const oP = parseXml(orig.get(oPoS.part)).documentElement;
    const nP = parseXml(out.get(nPoS.part)).documentElement;
    const oPRows = rowMap(oP);
    const pHdr = findRowByText(oP, oSst, 'A', (t) => t.trim().toLowerCase() === 'pos', 1, 60)!;
    const pFirst = pHdr + 1;
    const isTotal = (t: string) => t.trim().toLowerCase().startsWith('total');
    const pTotalOld = findRowByText(oP, oSst, 'D', isTotal, pFirst)!;
    const kp = n - (pTotalOld - pFirst);
    const pLast = pFirst + n - 1;
    const pTotal = pTotalOld + kp;
    poInfo.push({ name: PO, total: pTotal, root: nP, kp, oldTotal: pTotalOld });
    const pRows = rowMap(nP);

    check(
      `${PO}: ${n} item rows, Total row at ${pTotal}`,
      pRows.has(pTotal) && findRowByText(nP, nSst, 'D', isTotal, pFirst) === pTotal,
      'PO item row count or Total row position is not what was expected.',
    );
    items.forEach((it, i) => {
      const r = pFirst + i;
      const src = first + i;
      const row = pRows.get(r);
      const problems: string[] = [];
      if (!row) problems.push('row missing');
      else {
        const cells = cellMap(row);
        if (Number(cellText(cells['A'], nSst)) !== i + 1) problems.push('Pos');
        const exp: Record<string, string> = {
          B: `'${COST}'!A${src}`,
          C: `'${COST}'!B${src}`,
          D: `'${COST}'!F${src}`,
          F: `'${COST}'!E${src}`,
          G: `F${r}*D${r}`,
        };
        for (const [col, f] of Object.entries(exp)) if (fText(cells[col]) !== f) problems.push(`${col} formula`);
        const det = cells['E'] ? cellText(cells['E'], nSst) : null;
        if (it.details) {
          if (det !== it.details) problems.push('Details text');
        } else if (i === 0 && detailsMode === 'keep') {
          const was = cellMap(oPRows.get(pFirst)!)['E'];
          if (det !== (was ? cellText(was, oSst) : null)) problems.push('Details should be kept');
        } else if (det) problems.push('Details should be empty');
      }
      check(`${PO} row ${r}: Pos ${i + 1} links to ${COST} row ${src}`, problems.length === 0, problems.join(', '));
    });
    {
      const tr = pRows.get(pTotal);
      check(
        `${PO} total = SUM(G${pFirst}:G${pLast})`,
        !!tr && fText(cellMap(tr)['G']) === `SUM(G${pFirst}:G${pLast})`,
        `Found: ${tr ? fText(cellMap(tr)['G']) : 'no row'}`,
      );
    }
    const moved = movedIntact(oP, nP, oSst, nSst, pTotalOld, kp);
    check(`${PO}: Total row and the footer below moved down ${kp} rows intact`, moved.length === 0, moved.slice(0, 5).join('; '));
    check(
      `${PO}: merged cells shifted`,
      mergeSet(oP).map((m) => shiftRange(m, pTotalOld, kp)).sort().join() === mergeSet(nP).sort().join(),
      'Merged ranges differ.',
    );
    {
      const qr = findRowByText(nP, nSst, 'A', (t) => t.trim().toLowerCase().startsWith('your quotation'));
      const txt = qr ? cellText(cellMap(pRows.get(qr)!)['A'], nSst) : null;
      check(`${PO}: quotation number written ("Your Quotation: ${quotationNo}")`, txt === `Your Quotation: ${quotationNo}`, `Found: ${txt}`);
    }
    {
      const find = (root: Element, coord: string) => all(root, 'c').find((x) => x.getAttribute('r') === coord);
      check(
        `${PO}: PO number and date cells (linked to "Template") untouched`,
        ser(find(oP, 'A4')) === ser(find(nP, 'A4')) && ser(find(oP, 'F4')) === ser(find(nP, 'F4')),
        'A4 or F4 was modified.',
      );
    }
  });

  // --------------------------------------------------------------------- XERO Costing sheet
  let xeroShift: { name: string; oldTotal: number; kx: number } | null = null;
  if (oXero && nXero) {
    const XERO = nXero.name;
    const oX = parseXml(orig.get(oXero.part)).documentElement;
    const nX = parseXml(out.get(nXero.part)).documentElement;
    const xHdr = findXeroHeaderRow(oX, oSst);
    if (xHdr !== null) {
      const xFirst = xHdr + 1;
      const xTotalsOld = findXeroTotalsRow(oX, oSst, xFirst);
      const xLast = xFirst + n - 1;
      const xRows = rowMap(nX);
      if (xTotalsOld !== null) {
        const kx = n - (xTotalsOld - xFirst);
        const xTotalsNew = xTotalsOld + kx;
        xeroShift = { name: XERO, oldTotal: xTotalsOld, kx };
        check(
          `${XERO}: ${n} item rows, Totals row at ${xTotalsNew}`,
          xRows.has(xTotalsNew) && findXeroTotalsRow(nX, nSst, xFirst) === xTotalsNew,
          'XERO Costing item row count or Totals row position is not what was expected.',
        );
      } else {
        const extraRows = [...xRows.keys()].filter((r) => r > xLast);
        check(
          `${XERO}: ${n} item rows (${xFirst} to ${xLast}) with no stale rows`,
          extraRows.length === 0,
          `Unexpected rows after ${xLast}: ${extraRows.join(', ')}`,
        );
      }
      items.forEach((it, i) => {
        const r = xFirst + i;
        const src = first + i;
        const row = xRows.get(r);
        const problems: string[] = [];
        if (!row) problems.push('row missing');
        else {
          const cells = cellMap(row);
          const exp: Record<string, string> = {
            A: `'${COST}'!A${src}`,
            B: `'${COST}'!B${src}`,
            C: `'${COST}'!E${src}`,
            D: `'${COST}'!F${src}`,
          };
          for (const [col, f] of Object.entries(exp)) {
            if (fText(cells[col]) !== f) problems.push(`${col} formula`);
          }
          if (cellText(cells['A'], nSst) !== it.reference) problems.push('Reference value');
          if (cellText(cells['B'], nSst) !== it.description) problems.push('Description value');
          if (Math.abs(Number(cellText(cells['C'], nSst)) - it.netPrice) > 1e-6) problems.push('EX WORKS units value');
          if (Math.abs(Number(cellText(cells['D'], nSst)) - it.quantity) > 1e-6) problems.push('Quantity value');
        }
        check(`${XERO} row ${r}: links A, B, C, D to ${COST} row ${src}`, problems.length === 0, problems.join(', '));
      });
    }
  }

  {
    const dn = (t: string) => [...t.matchAll(/<definedName\b[^>]*>([\s\S]*?)<\/definedName>/g)].map((m) => m[1]);
    const o = dn(orig.getText('xl/workbook.xml'));
    const nn = dn(wbOut);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shift = (s: string, name: string, at: number, kk: number) =>
      s.replace(
        new RegExp(`((?:(?:'|&apos;)${esc(name)}(?:'|&apos;)|(?<![A-Za-z0-9_';])${esc(name)})!)(\\$?[A-Z]+\\$?\\d+(?::\\$?[A-Z]+\\$?\\d+)?)`, 'g'),
        (_m, a, b) => a + shiftRange(b, at, kk),
      );
    const expected = o.map((s0) => {
      let x = shift(s0, oOl.name, oTotals, k);
      for (const p of poInfo) x = shift(x, p.name, p.oldTotal, p.kp);
      if (xeroShift) x = shift(x, xeroShift.name, xeroShift.oldTotal, xeroShift.kx);
      return x;
    });
    check('Defined names (print area, filter names) updated like Excel would', expected.join('|') === nn.join('|'), 'A defined name was not shifted correctly.');
  }

  // ------------------------------------------------------------------------ numbers
  const sheets = [{ name: nOl.name, root: nO }, ...poInfo.map((p) => ({ name: p.name, root: p.root }))];
  const calc = buildCalc(sheets, nSst);
  const cellOf = (sheet: string, coord: string) => all(sheets.find((x) => x.name === sheet)!.root, 'c').find((c) => c.getAttribute('r') === coord);
  const val = (sheet: string, coord: string): unknown => {
    const cell = cellOf(sheet, coord);
    if (!cell) return null;
    const f = fText(cell);
    return f ? calcValue(calc, sheet, coord, f) : cellText(cell, nSst);
  };
  const sumNet = round2(items.reduce((s, it) => s + it.netPrice * it.quantity, 0));
  const exworks = Number(val(nOl.name, `G${totals}`));
  const poTotals = poInfo.map((p) => ({ name: p.name, total: Number(val(p.name, `G${p.total}`)) }));
  check(`Total Exworks (${COST} G${totals} = ${round2(exworks)}) = sum(net x qty) = ${sumNet}`, Math.abs(exworks - sumNet) <= 0.01, `Computed ${exworks}`);
  for (const p of poTotals) {
    check(`${p.name} total (${round2(p.total)}) equals ${COST} Total Exworks`, Math.abs(p.total - exworks) <= 0.01, `PO ${p.total} vs ${COST} ${exworks}`);
  }
  if (inp.invoiceAmount !== undefined) {
    check(`Total equals the quotation Invoice amount ${inp.invoiceAmount} (+/- 0.01)`, Math.abs(exworks - inp.invoiceAmount) <= 0.01, `Total ${round2(exworks)} vs invoice ${inp.invoiceAmount}`);
  }
  if (inp.lineAmounts) {
    const bad = items.map((it, i) => (Math.abs(it.netPrice * it.quantity - (inp.lineAmounts![i] ?? NaN)) > 0.01 ? String(i + 1) : '')).filter(Boolean);
    check('Each line: net price x quantity = PDF line amount', bad.length === 0, `Lines: ${bad.join(', ')}`);
  }
  if (inp.listPrices) {
    const bad = items.map((it, i) => (inp.listPrices![i] !== undefined && it.netPrice > inp.listPrices![i] + 1e-9 ? String(i + 1) : '')).filter(Boolean);
    check('Net price never above list price', bad.length === 0, `Lines: ${bad.join(', ')}`);
  }
  {
    let sum = 0;
    let count = 0;
    for (let r = first; r <= last; r++) {
      const v = val(nOl.name, `L${r}`);
      if (typeof v === 'number') {
        sum += v;
        count++;
      }
    }
    check('Freight allocation % column adds up to 100', count === 0 || Math.abs(sum - 100) <= 0.01, `Sum is ${round2(sum)}`);
  }
  {
    const bad: string[] = [];
    const stale: string[] = [];
    for (const sh of sheets) {
      for (const c of all(sh.root, 'c')) {
        if (calc.external.has(c)) continue;
        const coord = c.getAttribute('r')!;
        if (c.getAttribute('t') === 'e') bad.push(`${sh.name}!${coord}`);
        const f = fText(c);
        if (!f) continue;
        const fresh = calcValue(calc, sh.name, coord, f);
        if (typeof fresh === 'string' && ERROR_VALUES.has(fresh)) bad.push(`${sh.name}!${coord}`);
        const stored = cellText(c, nSst);
        const t = c.getAttribute('t');
        const same =
          typeof fresh === 'number'
            ? t !== 'str' && t !== 'e' && stored !== null && Math.abs(Number(stored) - fresh) <= 1e-6 * Math.max(1, Math.abs(fresh))
            : fresh === null
              ? stored === null || stored === ''
              : typeof fresh === 'boolean'
                ? stored === (fresh ? '1' : '0')
                : stored === fresh;
        if (!same) stale.push(`${sh.name}!${coord}`);
      }
    }
    check(`No Excel errors in ${sheets.map((x) => x.name).join(', ')}`, bad.length === 0, bad.slice(0, 6).join(', '));
    check('Stored results match a fresh recalculation of the saved file', stale.length === 0, stale.slice(0, 6).join(', '));
  }
  return checks;
}

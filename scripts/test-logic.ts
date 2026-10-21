// Run: npx tsx scripts/test-logic.ts   (no API key needed: Gemini is replaced by a fake)
import { analyze, applyAnswer, parseNumber, startWorking, toItems, type RawExtraction, type RawPosition, type Working } from '../src/services/quotation';
import { buildPrompts, runExtraction, runSupplierDetection, type Generate } from '../src/services/geminiExtractor';
import { detectSupplierFromPdfBytes, detectSupplierFromText } from '../src/services/supplierDetector';

let failed = 0, passed = 0;
const ok = (name: string, cond: boolean, d: unknown = '') => { if (cond) passed++; else { failed++; console.log('FAIL', name, '->', typeof d === 'string' ? d : JSON.stringify(d)); } };
const eq = (name: string, a: unknown, b: unknown) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

const pos = (position: string, reference: string | null, description: string | null, price: number | null, quantity: number | null, extra: Partial<RawPosition> = {}): RawPosition =>
  ({ position, reference, description, price, quantity, unit: 'PC', flags: [], ...extra });
const ex = (positions: RawPosition[], extra: Partial<RawExtraction> = {}): RawExtraction =>
  ({ quotationNumber: 'Q-1', documentTotal: null, currency: 'ZAR', positions, ignoredLines: [], unclear: [], ...extra });

// ---------------------------------------------------------------- numbers
for (const [t, v] of [['3,52', 3.52], ['1.234,56', 1234.56], ['1,234.56', 1234.56], ['R 1 234,50', 1234.5], ['12.5', 12.5], ['€ 7', 7], ['1.234.567,89', 1234567.89], ['2,5 pcs', 2.5]] as const) {
  const r: any = parseNumber(t); ok(`parse ${t}`, r.value === v, r);
}
for (const t of ['1,234', 'abc', '']) ok(`parse rejects "${t}"`, 'error' in parseNumber(t));

// -------------------------------------------------- Handtmann: unit = Net Price / Quantity
{
  const w = startWorking('handtmann', ex([pos('1', 'H-1', 'Seal', 100, 4), pos('2', 'H-2', 'Ring', 100, 3)], { documentTotal: 200 }));
  const a = analyze(w); eq('handtmann clean: no issues', a.issues.length, 0);
  const b = toItems(w);
  eq('handtmann unit price = 100/4', b.items[0].netPrice, 25);
  ok('handtmann unit price = 100/3 keeps full precision', Math.abs(b.items[1].netPrice * 3 - 100) < 1e-9, b.items[1].netPrice);
  eq('handtmann line amounts = Net Price as printed', b.lineAmounts, [100, 100]);
}
{ // same numbers for Bizerba: price is used as printed, never divided
  const w = startWorking('bizerba', ex([pos('1', 'B-1', 'Seal', 100, 4, { lineAmount: 400 })]));
  eq('bizerba price as printed', toItems(w).items[0].netPrice, 100);
}
// -------------------------------------------------------------- missing values -> chat
{
  let w: Working = startWorking('handtmann', ex([pos('1', 'H-1', 'Seal', 100, null), pos('2', null, 'Ring', 50, 2)]));
  let a = analyze(w);
  eq('missing quantity + reference found', a.issues.map((i) => i.id), ['missing:0:quantity', 'missing:1:reference']);
  ok('question names the line and the field', a.issues[0].question.includes('line 1') && a.issues[0].question.includes('quantity'), a.issues[0].question);
  let r: any = applyAnswer(w, a.issues[0], 'abc'); ok('bad number is rejected with a message', 'error' in r, r);
  r = applyAnswer(w, a.issues[0], 'keep'); ok('"keep" is refused for a missing value', 'error' in r, r);
  r = applyAnswer(w, a.issues[0], '4'); w = r.w; a = analyze(w); eq('after quantity answer', a.issues.map((i) => i.id), ['missing:1:reference']);
  r = applyAnswer(w, a.issues[0], 'H-2'); w = r.w; a = analyze(w); eq('all answered: no issues', a.issues.length, 0);
  eq('answers used in the items', toItems(w).items.map((i) => [i.reference, i.quantity, i.netPrice]), [['H-1', 4, 25], ['H-2', 2, 25]]);
}
{ // zero quantity never reaches the division
  const a = analyze(startWorking('handtmann', ex([pos('1', 'H-1', 'Seal', 100, 0)])));
  eq('zero quantity is a question, not a division', a.issues[0]?.id, 'missing:0:quantity');
}
// ---------------------------------------------------------- doubts with candidates
{
  let w: Working = startWorking('bizerba', ex([pos('1', 'B-1', 'Seal', 10, 3, { flags: [{ field: 'quantity', reason: 'Two reading passes disagreed (3 / 8).', candidates: ['3', '8'] }] })]));
  let a = analyze(w);
  eq('flag -> check issue', a.issues[0]?.id, 'check:0:quantity');
  eq('buttons: keep + other reading', a.issues[0].choices?.map((c) => c.value), ['keep', '8']);
  const r: any = applyAnswer(w, a.issues[0], '8'); w = r.w; a = analyze(w);
  eq('chosen candidate applied', w.ex.positions[0].quantity, 8); eq('no more issues', a.issues.length >= 0 && a.issues.filter((i) => i.kind !== 'priceKind').length, 0);
}
// ------------------------------------------------------ price kind: ask, never assume
{
  let w: Working = startWorking('bizerba', ex([pos('1', 'B-1', 'Seal', 100, 4, { lineAmount: 100 }), pos('2', 'B-2', 'Ring', 30, 1, { lineAmount: 30 })]));
  let a = analyze(w);
  eq('price equals line total -> priceKind question', a.issues.map((i) => i.id), ['priceKind']);
  const r: any = applyAnswer(w, a.issues[0], 'line'); w = r.w;
  eq('after "line total": divided by quantity', toItems(w).items.map((i) => i.netPrice), [25, 30]);
  eq('clean afterwards', analyze(w).issues.length, 0);
}
{ // Other with nothing to cross-check: ask once
  const a = analyze(startWorking('other', ex([pos('1', 'O-1', 'Seal', 10, 5)])));
  eq('other, nothing to cross-check -> asks', a.issues.map((i) => i.id), ['priceKind']);
  const b = analyze(startWorking('other', ex([pos('1', 'O-1', 'Seal', 10, 1)])));
  eq('quantity 1 everywhere -> no question needed', b.issues.length, 0);
}
{ // line total printed and consistent: no question
  const a = analyze(startWorking('other', ex([pos('1', 'O-1', 'Seal', 10, 5, { lineAmount: 50 })])));
  eq('consistent line total -> clean', a.issues.length, 0);
}
{ // price x qty disagrees with printed line total
  let w: Working = startWorking('other', ex([pos('1', 'O-1', 'Seal', 10, 5, { lineAmount: 45 })]));
  let a = analyze(w); eq('line mismatch', a.issues[0]?.id, 'lineMismatch:0');
  const r: any = applyAnswer(w, a.issues[0], '9'); w = r.w; eq('corrected price clears it', analyze(w).issues.length, 0);
}
// ------------------------------------------------------------ totals
{ // Multivac invoice amount must match: ask which line is wrong
  let w: Working = startWorking('multivac', ex([pos('10', 'M-1', 'A', 5, 1, { lineAmount: 5, listPrice: 6 }), pos('20', 'M-2', 'B', 7, 1, { lineAmount: 7, listPrice: 9 })], { documentTotal: 13 }));
  let a = analyze(w); eq('multivac total mismatch', a.issues[0]?.id, 'total');
  let r: any = applyAnswer(w, a.issues[0], '99'); ok('unknown position rejected', 'error' in r, r);
  r = applyAnswer(w, a.issues[0], 'pos 20'); w = r.w; a = analyze(w); eq('asks about that price', a.issues[0]?.id, 'check:1:price');
  r = applyAnswer(w, a.issues[0], '8'); w = r.w; r = applyAnswer(w, analyze(w).issues[0] ?? { id: 'x', kind: 'total', question: '' } as any, 'x'); // line total now disagrees (7 vs 8)
  a = analyze(w); ok('line total contradiction asked next', a.issues[0]?.kind === 'lineMismatch', a.issues[0]);
  r = applyAnswer(w, a.issues[0], '8'); w = r.w; a = analyze(w); eq('now sums to 13 -> clean', a.issues.length, 0);
}
{ // user can accept a mismatch
  let w: Working = startWorking('multivac', ex([pos('10', 'M-1', 'A', 5, 1, { lineAmount: 5 })], { documentTotal: 9 }));
  const a = analyze(w); const r: any = applyAnswer(w, a.issues[0], 'accept'); w = r.w;
  eq('accepted mismatch stops asking', analyze(w).issues.length, 0); ok('accepted flag kept for the verifier', w.totalAccepted);
}
{ // third-party total differences are only a notice (freight, VAT...)
  const a = analyze(startWorking('bizerba', ex([pos('1', 'B-1', 'Seal', 10, 1)], { documentTotal: 12.5 })));
  eq('bizerba total mismatch is a notice', [a.issues.length, a.notices.some((n) => n.includes('12.5'))], [0, true]);
}
// ------------------------------------------------------------- headers / quotation number / fractions
{
  const w = startWorking('other', ex([pos('1', null, 'Seal', 10, 1)], { headersFound: { reference: false, description: true, price: true, quantity: true } }), { reference: 'Product Code', description: 'Item Details', price: 'Unit Price', quantity: 'Qty' });
  const a = analyze(w); eq('missing header asked first', a.issues.map((i) => i.id), ['header:reference']);
  const r: any = applyAnswer(w, a.issues[0], 'Part No.'); eq('header answer triggers re-extraction', r.reextract?.reference, 'Part No.'); eq('other headers kept', r.reextract?.price, 'Unit Price');
}
{
  const a = analyze(startWorking('handtmann', ex([pos('1', 'H', 'S', 10, 1)], { quotationNumber: null })));
  eq('missing quotation number asked', a.issues[0]?.id, 'quotationNumber');
  const a2 = analyze(startWorking('handtmann', ex([pos('1', 'H', 'S', 10, 2.5)])));
  eq('fractional PC quantity asked', a2.issues[0]?.id, 'fraction:0');
  const a3 = analyze(startWorking('handtmann', ex([pos('1', 'H', 'S', 10, 2.5, { unit: 'm' })])));
  eq('fractional metres are fine', a3.issues.length, 0);
}
// ------------------------------------------------------------------ prompts
{
  const h = buildPrompts('handtmann').p1, b = buildPrompts('bizerba').p1, m = buildPrompts('multivac').p1;
  const o = buildPrompts('other', { reference: 'Product Code', description: 'Item Details', price: 'Unit Price', quantity: 'Qty' }).p1;
  ok('handtmann prompt: headers + do not divide', h.includes('“Code”') && h.includes('“Quantity”') && h.includes('“Net Price”') && h.includes('Do NOT divide'));
  ok('bizerba prompt: headers, no dividing', b.includes('“Item”') && b.includes('“Qty”') && b.includes('Do not multiply or divide'));
  ok('other prompt: the user headers', ['Product Code', 'Item Details', 'Unit Price', 'Qty'].every((x) => o.includes(`“${x}”`)));
  ok('multivac prompt unchanged in substance', m.includes('MULTIVAC') && m.includes('Invoice amount') && m.includes('AFTER the customer discount'));
  ok('only Multivac prompt avoids column headers', !m.includes('EXACT column headers'));
}
// ------------------------------------------------------- extraction pipeline (fake model)
const j = (e: RawExtraction) => JSON.stringify(e);
const mk = (qty: number, flags: RawPosition['flags'] = []) => ex([pos('1', 'R1', 'Seal', 10, qty, { flags }), pos('2', 'R2', 'Ring', 5, 1)], { headersFound: { reference: true, description: true, price: true, quantity: true } });
async function pipe(answers: RawExtraction[]) {
  let calls = 0; const gen: Generate = async () => j(answers[Math.min(calls++, answers.length - 1)]);
  const res = await runExtraction(gen, { supplier: 'bizerba' }); return { res, calls };
}
{
  let { res, calls } = await pipe([mk(2), mk(2)]); eq('agree -> 2 calls, no doubts', [calls, res.extraction!.positions.flatMap((p) => p.flags).length], [2, 0]);
  ({ res, calls } = await pipe([mk(2), mk(3), mk(2)])); eq('disagree, reconcile settles -> 3 calls, no doubt', [calls, res.extraction!.positions[0].flags.length], [3, 0]);
  ({ res, calls } = await pipe([mk(2), mk(3), mk(4)])); eq('reconcile matches neither -> doubt with both readings', [res.extraction!.positions[0].flags[0]?.field, res.extraction!.positions[0].flags[0]?.candidates], ['quantity', ['2', '3']]);
  ({ res, calls } = await pipe([mk(2), mk(3), mk(2, [{ field: 'quantity', reason: 'blurry' }])])); eq('reconcile unsure -> doubt kept', res.extraction!.positions[0].flags[0]?.reason, 'blurry');
  const f = [{ field: 'price' as const, reason: 'faint' }];
  ({ res } = await pipe([mk(2, f), mk(2)])); eq('only one pass unsure, both agree -> trusted', res.extraction!.positions[0].flags.length, 0);
  ({ res } = await pipe([mk(2, f), mk(2, f)])); eq('both passes unsure -> asked', res.extraction!.positions[0].flags.map((x) => x.field), ['price']);
  ({ res } = await pipe([ex([]), ex([])])); ok('no positions -> clear error', res.success === false && !!res.error, res);
}
// ------------------------------------------------------- supplier detection
{
  const m = detectSupplierFromText('MULTIVAC Sepp Haggenmüller SE & Co. KG Bahnhofstr. 4 87787 Wolfertschwenden Pos. 10 Invoice amount');
  eq('detect Multivac quotation', [m.supplier, m.confidence, m.detectedName], ['multivac', 'high', 'Multivac']);

  const b = detectSupplierFromText('Bizerba SE & Co. KG Wilhelm-Kraut-Straße 65 72336 Balingen www.bizerba.com Item Description Net Price Qty');
  eq('detect Bizerba quotation', [b.supplier, b.confidence, b.detectedName], ['bizerba', 'high', 'Bizerba']);

  const h = detectSupplierFromText('Albert Handtmann Maschinenfabrik GmbH & Co. KG Hubertus-Liebrecht-Str. 10-12 88400 Biberach www.handtmann.de Code Description Net Price Quantity');
  eq('detect Handtmann quotation', [h.supplier, h.confidence, h.detectedName], ['handtmann', 'high', 'Handtmann']);

  const o = detectSupplierFromText('ULMA Packaging GmbH Quotation No. 99412 Item Reference Description Unit Price Quantity Total');
  eq('detect Other supplier quotation', [o.supplier, o.confidence, o.detectedName], ['other', 'high', 'ULMA Packaging GmbH']);

  const u = detectSupplierFromText('12345');
  eq('detect uncertain when insufficient text', [u.supplier, u.confidence], ['uncertain', 'low']);

  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Title (BIZERBA Quotation) >>\nstream\n(Bizerba SE & Co. KG Balingen www.bizerba.com) Tj\nendstream\n%%EOF');
  const pb = await detectSupplierFromPdfBytes(pdfBytes);
  eq('detect supplier from PDF bytes', [pb.supplier, pb.confidence], ['bizerba', 'high']);

  const geminiOther = await runSupplierDetection(async () =>
    JSON.stringify({ supplier: 'other', confidence: 'high', detectedName: 'Weber Maschinenbau GmbH', reason: 'Header and logo show Weber Maschinenbau GmbH' }),
  );
  eq('Gemini supplier detection for Other', [geminiOther.supplier, geminiOther.confidence, geminiOther.detectedName], ['other', 'high', 'Weber Maschinenbau GmbH']);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

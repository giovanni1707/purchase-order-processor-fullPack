// Node test: npm run test:engine -- [items.json] [template.xlsx] [template-with-PO-Others.xlsx]
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
(globalThis as any).DOMParser = DOMParser;
(globalThis as any).XMLSerializer = XMLSerializer;
import fs from 'node:fs';
const { buildPurchaseOrder, verifyWorkbook } = await import('../src/engine/index');
type Mode = 'multivac' | 'bizerba' | 'handtmann' | 'other';
const raw = JSON.parse(fs.readFileSync(process.argv[2] || '/home/claude/items.json', 'utf8'));
const items = raw.map((o: any) => ({ reference: o.reference, description: o.description, netPrice: o.net_price, quantity: o.quantity, unit: o.unit }));
const tpl = new Uint8Array(fs.readFileSync(process.argv[3] || '/mnt/user-data/uploads/Template_Purchase_Order_2026.xlsx'));
const tplOthers = new Uint8Array(fs.readFileSync(process.argv[4] || '/tmp/Template_with_others.xlsx'));
const invoice = process.argv[2] ? Math.round(raw.reduce((s: number, o: any) => s + o.net_price * o.quantity, 0) * 100) / 100 : 475.37;

async function run(label: string, mode: Mode, detailsMode: 'keep' | 'clear', o: { replaceText?: string; verifyRate?: number; template?: Uint8Array } = {}) {
  const template = o.template ?? tpl;
  const its = items.map((i: any, idx: number) => ({ ...i, details: idx === 0 ? o.replaceText : undefined }));
  const opts = { items: its, rate: mode === 'multivac' ? 54.99 : 3.12, rate2: mode === 'multivac' ? undefined : 54.99, quotationNo: '21400572', detailsMode, mode };
  const res = await buildPurchaseOrder(template, opts);
  fs.writeFileSync(`/tmp/ts_out_${label}.xlsx`, res.bytes);
  const checks = await verifyWorkbook({
    original: template, output: res.bytes, opts: { ...opts, rate: o.verifyRate ?? opts.rate }, invoiceAmount: invoice,
    lineAmounts: raw.map((x: any) => x.line_amount), listPrices: mode === 'multivac' ? raw.map((x: any) => x.list_price) : undefined,
  });
  const failed = checks.filter((c) => !c.ok);
  console.log(`${label}: ${checks.length - failed.length}/${checks.length} checks passed  [filled: ${[res.costName, ...res.pos.map((p) => p.name)].join(', ')}]`);
  for (const f of failed.slice(0, 4)) console.log('   FAIL', f.name, '->', f.detail);
}
await run('clear', 'multivac', 'clear');
await run('keep', 'multivac', 'keep');
await run('replace', 'multivac', 'clear', { replaceText: 'Spare parts for line 3' });
await run('tampered(expect failures)', 'multivac', 'clear', { verifyRate: 54.98 });
await run('bizerba', 'bizerba', 'clear');
await run('bizerba-keep', 'bizerba', 'keep');
await run('handtmann', 'handtmann', 'clear');
await run('handtmann-keep', 'handtmann', 'keep');
await run('other-with-sheet', 'other', 'clear', { template: tplOthers });
await run('other-without-sheet', 'other', 'clear');

// Drives the real <App/> in jsdom through all four PO types and the clarification chat (Gemini is mocked).
// Run: npx tsx scripts/ui-smoke.tsx [items.json] [template.xlsx] [template-with-PO-Others.xlsx]
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
const w: any = dom.window;
for (const k of ['window', 'document', 'DOMParser', 'XMLSerializer', 'FileReader', 'Event', 'MouseEvent', 'HTMLElement', 'HTMLInputElement', 'Node', 'navigator']) {
  Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(w.HTMLElement.prototype, 'oninput', { value: null, writable: true, configurable: true });
import fs from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';

const raw = JSON.parse(fs.readFileSync(process.argv[2] || '/home/claude/items.json', 'utf8'));
const tpl = fs.readFileSync(process.argv[3] || '/mnt/user-data/uploads/Template_Purchase_Order_2026.xlsx');
const tplOthers = fs.readFileSync(process.argv[4] || '/tmp/Template_with_others.xlsx');
(w.File.prototype as any).arrayBuffer = function () {
  return new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(this); });
};

const pos = (o: any, i: number, over: any = {}) => ({ position: String(o.pos), reference: o.reference, description: o.description, price: o.net_price, quantity: o.quantity, unit: o.unit || 'PC', listPrice: o.list_price, lineAmount: o.line_amount, flags: [], ...over });
const base = (positions: any[], extra: any = {}) => ({ quotationNumber: '21400572', documentTotal: 475.37, currency: 'EUR', positions, ignoredLines: [], unclear: [], ...extra });
const hf = { reference: true, description: true, price: true, quantity: true };

let queue: any[] = []; const requests: any[] = [];
(globalThis as any).fetch = async (_u: string, init: any) => {
  requests.push(JSON.parse(init.body));
  const next = queue.shift();
  return { ok: true, status: 200, json: async () => ({ success: true, extraction: next }) };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = () => document.body.textContent || '';
const waitFor = async (cond: () => boolean, ms = 30000) => { for (let i = 0; i < ms / 250 && !cond(); i++) await act(async () => { await sleep(250); }); return cond(); };
async function setFile(input: HTMLInputElement, file: any) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new w.Event('change', { bubbles: true })); });
}
async function setValue(input: HTMLInputElement, v: string) {
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
  await act(async () => { (input as any)[key].onChange({ target: { value: v } }); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }); };
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
async function chat(answer: string) {
  await setValue(document.querySelector('input[aria-label="Your answer"]') as HTMLInputElement, answer);
  await click(button('Send'));
}

let failed = 0;
const ok = (name: string, cond: boolean, d = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + d)); if (!cond) failed++; };

async function open(label: string, mode: string, template: Buffer, rates: [string, string?], cols?: string[]) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(<App />); });
  ok(`${label}: four type buttons`, ['Multivac', 'Bizerba', 'Handtmann', 'Other'].every((x) => !!button(x)));
  await click(button(mode));
  if (cols) for (const [i, k] of ['reference', 'description', 'price', 'quantity'].entries()) await setValue(byId(`col-${k}`), cols[i]);
  const inputs = [...document.querySelectorAll('input[type=file]')] as HTMLInputElement[];
  await setFile(inputs[0], new w.File([new Uint8Array([37, 80, 68, 70])], 'q.pdf', { type: 'application/pdf' }));
  await setFile(inputs[1], new w.File([new Uint8Array(template)], 'Template_Purchase_Order_2026.xlsx'));
  await waitFor(() => text().includes('PO Details text') || text().includes('PO Others” sheet'), 40000);
  await setValue(byId('rate'), rates[0]);
  if (rates[1]) await setValue(byId('rate2'), rates[1]);
  return root;
}
async function generate(label: string) {
  const gen = button('Generate purchase order'); ok(`${label}: Generate enabled`, !gen.disabled); await click(gen);
}
const passed = () => /All checks passed \((\d+) of (\d+)\)/.exec(text());
const finish = async (label: string, sheets: string[], notSheets: string[] = []) => {
  ok(`${label}: finished`, await waitFor(() => !!passed() || text().includes('checks failed'), 60000), text().slice(0, 300));
  const m = passed(); ok(`${label}: all checks passed`, !!m && m[1] === m[2], text().slice(0, 500));
  ok(`${label}: sheets filled = ${sheets.join(' + ')}`, sheets.every((s) => text().includes(`${s} ${raw.length} rows`)) && notSheets.every((s) => !text().includes(`${s} ${raw.length}`)));
  ok(`${label}: download enabled`, !!button('Download') && !button('Download').disabled);
};

// 1. Multivac, clean
{
  queue = [base(raw.map(pos))]; requests.length = 0;
  const root = await open('Multivac', 'Multivac', tpl, ['54.99']); await generate('Multivac');
  await finish('Multivac', ['Order list', 'PO Multivac'], ['PO Bizerba', 'PO Handtmann']);
  ok('Multivac: request carries supplier', requests[0].supplier === 'multivac');
  await act(async () => { root.unmount(); });
}
// 2. Multivac with an unreadable price -> chat
{
  const ps = raw.map(pos); ps[2] = { ...ps[2], price: null };
  queue = [base(ps)]; requests.length = 0;
  const root = await open('Multivac chat', 'Multivac', tpl, ['54.99']); await generate('Multivac chat');
  ok('Multivac chat: chat opens', await waitFor(() => !!document.querySelector('[data-testid=clarification]')));
  ok('Multivac chat: asks about the exact line and field', text().includes('price is missing') && text().includes('line 30'), text().slice(0, 400));
  await chat('abc'); ok('Multivac chat: bad number is explained', text().includes('could not find a number'));
  await chat('2,01');
  await finish('Multivac chat', ['Order list', 'PO Multivac']);
  ok('Multivac chat: the user\'s answer is in the workbook rows', text().includes('2.01'));
  await act(async () => { root.unmount(); });
}
// 3. Handtmann: Net Price / Quantity, missing quantity answered in chat
{
  const ps = raw.map(pos).map((p: any) => ({ ...p, listPrice: null, lineAmount: null }));
  ps[0] = { ...ps[0], quantity: 2, price: 462.3 };            // line total for qty 2 -> unit 231.15
  ps[1] = { ...ps[1], quantity: null, flags: [{ field: 'quantity', reason: 'The quantity cell is empty.' }] };
  queue = [base(ps, { documentTotal: 706.52, currency: 'ZAR', headersFound: hf })]; requests.length = 0;
  const root = await open('Handtmann', 'Handtmann', tpl, ['3.12', '54.99']); await generate('Handtmann');
  ok('Handtmann: chat asks for the missing quantity', await waitFor(() => !!document.querySelector('[data-testid=clarification]')) && text().includes('line 20') && text().includes('quantity'), text().slice(0, 400));
  await chat('1');
  await finish('Handtmann', ['Quotation_3rd Pty', 'PO Handtmann'], ['PO Bizerba', 'PO Others']);
  ok('Handtmann: unit price = Net Price / Quantity (462.30 / 2 = 231.15)', text().includes('231.15') && !text().includes('462.30'), text().slice(0, 800));
  ok('Handtmann: request carries supplier', requests[0].supplier === 'handtmann');
  await act(async () => { root.unmount(); });
}
// 4. Bizerba: price equals line total -> chat offers buttons
{
  const ps = raw.map(pos).map((p: any) => ({ ...p, listPrice: null, lineAmount: null }));
  ps[0] = { ...ps[0], quantity: 2, price: 462.3, lineAmount: 462.3 };
  queue = [base(ps, { documentTotal: 706.52, currency: 'ZAR', headersFound: hf })];
  const root = await open('Bizerba', 'Bizerba', tpl, ['3.12', '54.99']); await generate('Bizerba');
  ok('Bizerba: asks unit price or line total', await waitFor(() => !!document.querySelector('[data-testid=clarification]')) && text().includes('price per unit'), text().slice(0, 400));
  await click(button('Line total'));
  await finish('Bizerba', ['Quotation_3rd Pty', 'PO Bizerba'], ['PO Handtmann', 'PO Others']);
  ok('Bizerba: line total divided by quantity', text().includes('231.15') && !text().includes('462.30'));
  await act(async () => { root.unmount(); });
}
// 5. Other with PO Others: user headers sent, missing header corrected in chat, re-read
{
  const ps = raw.map(pos).map((p: any) => ({ ...p, listPrice: null }));
  queue = [base(ps, { currency: 'ZAR', headersFound: { ...hf, reference: false } }), base(ps, { currency: 'ZAR', headersFound: hf })]; requests.length = 0;
  const root = await open('Other', 'Other', tplOthers, ['3.12', '54.99'], ['Product Code', 'Item Details', 'Unit Price', 'Qty']); await generate('Other');
  ok('Other: first request carries the four headers', await waitFor(() => requests.length >= 1) && requests[0].supplier === 'other' && requests[0].columns.reference === 'Product Code' && requests[0].columns.quantity === 'Qty', JSON.stringify(requests[0]));
  ok('Other: chat asks for the missing header', await waitFor(() => !!document.querySelector('[data-testid=clarification]')) && text().includes('Product Code'), text().slice(0, 400));
  await chat('Part No.');
  ok('Other: PDF re-read with the corrected header', await waitFor(() => requests.length >= 2) && requests[1].columns.reference === 'Part No.' && requests[1].columns.price === 'Unit Price', JSON.stringify(requests[1]));
  await finish('Other', ['Quotation_3rd Pty', 'PO Others'], ['PO Bizerba', 'PO Handtmann']);
  await act(async () => { root.unmount(); });
}
// 6. Other on a workbook without PO Others: warning, cost sheet only
{
  const ps = raw.map(pos).map((p: any) => ({ ...p, listPrice: null }));
  queue = [base(ps, { currency: 'ZAR', headersFound: hf })];
  const root = await open('Other (no PO Others)', 'Other', tpl, ['3.12', '54.99'], ['Code', 'Desc', 'Price', 'Qty']);
  ok('Other (no PO Others): warned before running', text().includes('no “PO Others” sheet'));
  await generate('Other (no PO Others)');
  await finish('Other (no PO Others)', ['Quotation_3rd Pty'], ['PO Bizerba', 'PO Handtmann', 'PO Others']);
  ok('Other (no PO Others): notice in the result', text().includes('so only Quotation_3rd Pty was filled'));
  await act(async () => { root.unmount(); });
}
console.log(failed ? `\n${failed} UI check(s) failed` : '\nUI smoke test passed');
process.exit(failed ? 1 : 0);

import { useRef, useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, FileText, Loader2, XCircle } from 'lucide-react';
import { MODES, MODE_IDS, buildPurchaseOrder, inspectWorkbook, verifyWorkbook } from './engine';
import type { CheckResult, DetailsMode, PoMode, QuoteItem, WorkbookInspection } from './engine';
import Clarification, { type ChatMessage } from './components/Clarification';
import {
  COLUMN_LABEL,
  DEFAULT_COLUMNS,
  analyze,
  applyAnswer,
  fmt,
  linesTotal,
  startWorking,
  toItems,
  type ColumnKey,
  type ColumnMap,
  type Issue,
  type RawExtraction,
  type Working,
} from './services/quotation';

type Phase = 'idle' | 'running' | 'clarify' | 'done' | 'error';
type DetailsChoice = 'keep' | 'clear' | 'replace';

interface Result {
  mode: PoMode;
  sheets: string[];
  items: QuoteItem[];
  quotationNo: string;
  documentTotal: number | null;
  rate: number;
  rate2?: number;
  total: number;
  checks: CheckResult[];
  bytes: Uint8Array;
  fileName: string;
  notices: string[];
}

/** Everything the final step needs, captured when Generate is pressed (later chat answers must not see newer form edits). */
interface RunContext {
  mode: PoMode;
  pdf: File;
  template: Uint8Array;
  fileName: string;
  rate: number;
  rate2?: number;
  detailsChoice: DetailsChoice;
  detailsText: string;
  existingDetails: string[];
  cols?: ColumnMap;
  missingPo: boolean;
}

const RATE_RE = /^\d+(\.\d+)?$/;
// Vercel accepts request bodies up to 4.5 MB; a PDF grows by about a third when sent as base64.
const MAX_PDF_BYTES = 3_200_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COLUMN_KEYS: ColumnKey[] = ['reference', 'description', 'price', 'quantity'];
const OTHER_PLACEHOLDER: ColumnMap = { reference: 'e.g. Product Code', description: 'e.g. Item Details', price: 'e.g. Unit Price', quantity: 'e.g. Qty' };
const EXPECTED_CURRENCY: Record<PoMode, string> = { multivac: 'EUR', bizerba: 'ZAR', handtmann: 'ZAR', other: 'EUR' };

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the PDF file.'));
    r.readAsDataURL(file);
  });

function DropZone(props: { label: string; hint: string; accept: string; file: File | null; icon: 'pdf' | 'xlsx'; onFile: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const Icon = props.icon === 'pdf' ? FileText : FileSpreadsheet;
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) props.onFile(f);
      }}
      className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3 transition ${
        over ? 'border-slate-500 bg-slate-100' : props.file ? 'border-emerald-300 bg-emerald-50' : 'border-slate-300 hover:border-slate-400'
      }`}
    >
      <Icon className={`h-6 w-6 shrink-0 ${props.file ? 'text-emerald-600' : 'text-slate-400'}`} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-800">{props.label}</div>
        <div className="truncate text-xs text-slate-500">{props.file ? props.file.name : props.hint}</div>
      </div>
      <input
        ref={ref}
        type="file"
        accept={props.accept}
        className="hidden"
        onChange={(e) => {
          props.onFile(e.target.files?.[0] || null);
          e.target.value = '';
        }}
      />
    </div>
  );
}

const TYPE_HINT: Record<PoMode, string> = {
  multivac: 'Reads the Multivac quotation layout.',
  bizerba: `Reads these columns: ${Object.values(DEFAULT_COLUMNS.bizerba).join(', ')}.`,
  handtmann: `Reads these columns: ${Object.values(DEFAULT_COLUMNS.handtmann).join(', ')}. Unit price = Net Price ÷ Quantity.`,
  other: 'Tell me which columns of the PDF to use.',
};

export default function App() {
  const [pdf, setPdf] = useState<File | null>(null);
  const [xlsx, setXlsx] = useState<File | null>(null);
  const [inspection, setInspection] = useState<WorkbookInspection | null>(null);
  const [mode, setMode] = useState<PoMode>('multivac');
  const [rate, setRate] = useState('');
  const [rate2, setRate2] = useState('');
  const [cols, setCols] = useState<ColumnMap>({ reference: '', description: '', price: '', quantity: '' });
  const [detailsChoice, setDetailsChoice] = useState<DetailsChoice>('clear');
  const [detailsText, setDetailsText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  // clarification chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Issue | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [chatBusy, setChatBusy] = useState(false);
  const working = useRef<Working | null>(null);
  const ctx = useRef<RunContext | null>(null);
  const msgId = useRef(0);
  const runId = useRef(0);

  const isRate = (v: string) => RATE_RE.test(v.trim()) && Number(v) > 0;
  const secondRate = mode === 'bizerba' || mode === 'handtmann';
  const rateOk = isRate(rate);
  const rate2Ok = !secondRate || isRate(rate2);
  const colsOk = mode !== 'other' || COLUMN_KEYS.every((k) => cols[k].trim());
  const rateError = rate.trim() !== '' && !rateOk ? 'Enter one plain number, e.g. 54.99' : '';
  const rate2Error = secondRate && rate2.trim() !== '' && !isRate(rate2) ? 'Enter one plain number, e.g. 54.99' : '';
  const existingDetails = inspection?.details[mode] ?? [];
  const replaceMissing = existingDetails.length > 0 && detailsChoice === 'replace' && !detailsText.trim();
  const canRun = !!pdf && !!xlsx && inspection?.ok === true && inspection.modes[mode] && rateOk && rate2Ok && colsOk && !replaceMissing && phase !== 'running';

  async function chooseWorkbook(f: File | null) {
    setXlsx(f);
    setInspection(null);
    setDetailsChoice('clear');
    setDetailsText('');
    if (f) {
      const info = await inspectWorkbook(await f.arrayBuffer());
      setInspection(info);
      if (info.ok && !info.modes[mode]) setMode(MODE_IDS.find((m) => info.modes[m]) ?? 'multivac');
    }
  }

  function reset() {
    runId.current++; // ignore any answer still being processed
    setPhase('idle');
    setResult(null);
    setError('');
    setProgress('');
    setMessages([]);
    setPending(null);
    setChatBusy(false);
    working.current = null;
  }

  const say = (role: ChatMessage['role'], text: string) => setMessages((m) => [...m, { id: ++msgId.current, role, text }]);

  async function callExtract(c: RunContext, columns?: ColumnMap): Promise<RawExtraction> {
    const pdfBase64 = await readBase64(c.pdf);
    const resp = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64, supplier: c.mode, columns: columns ?? c.cols }),
    });
    let data: any;
    try {
      data = await resp.json();
    } catch {
      throw new Error(resp.status === 413 ? 'The PDF is too large to send.' : `The server returned an unreadable answer (HTTP ${resp.status}).`);
    }
    if (data?.error) throw new Error(data.error);
    if (!resp.ok || !data?.success || !data?.extraction) throw new Error(`Extraction failed (HTTP ${resp.status}).`);
    return data.extraction as RawExtraction;
  }

  /** Check the data; ask the user about anything critical, otherwise build the workbook. */
  async function proceed(w: Working, intro: 'first' | 'answered') {
    working.current = w;
    const a = analyze(w);
    if (a.issues.length) {
      setPending(a.issues[0]);
      setRemaining(a.issues.length);
      if (intro === 'first') say('assistant', 'I need to check a few things before I fill the workbook. I will not guess any value.');
      say('assistant', a.issues[0].question);
      setPhase('clarify');
      return;
    }
    if (intro === 'answered') say('assistant', 'Thank you, that is everything I needed. Generating the purchase order…');
    setPending(null);
    setPhase('running');
    await build(w, a.notices);
  }

  async function run() {
    if (!pdf || !xlsx) return;
    const myRun = ++runId.current;
    setPhase('running');
    setError('');
    setMessages([]);
    try {
      if (pdf.size > MAX_PDF_BYTES) throw new Error('This PDF is too large for the online version (limit about 3 MB). Please use a smaller file.');
      const c: RunContext = {
        mode,
        pdf,
        template: new Uint8Array(await xlsx.arrayBuffer()),
        fileName: xlsx.name,
        rate: Number(rate.trim()),
        rate2: secondRate ? Number(rate2.trim()) : (MODES[mode].secondRateCol ? Number(rate.trim()) : undefined),
        detailsChoice,
        detailsText: detailsText.trim(),
        existingDetails,
        cols: mode === 'other' ? Object.fromEntries(COLUMN_KEYS.map((k) => [k, cols[k].trim()])) as ColumnMap : undefined,
        missingPo: !!inspection?.missingPo[mode],
      };
      ctx.current = c;
      setProgress('Reading quotation…');
      const ex = await callExtract(c);
      if (myRun !== runId.current) return;
      await proceed(startWorking(mode, ex, c.cols), 'first');
    } catch (e: any) {
      if (myRun !== runId.current) return;
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function onAnswer(text: string) {
    const w = working.current;
    const c = ctx.current;
    if (!w || !c || !pending || chatBusy) return;
    const myRun = runId.current;
    const label = pending.choices?.find((x) => x.value === text)?.label;
    say('user', label ?? text);
    const r = applyAnswer(w, pending, text);
    if ('error' in r) {
      say('assistant', `${r.error}\n\n${pending.question}`);
      return;
    }
    setChatBusy(true);
    try {
      if ('reextract' in r) {
        say('assistant', 'Thank you. I will read the PDF again with that header…');
        const ex = await callExtract(c, r.reextract);
        if (myRun !== runId.current) return;
        c.cols = r.reextract;
        setChatBusy(false);
        await proceed(startWorking(c.mode, ex, r.reextract), 'answered');
      } else {
        setChatBusy(false);
        await proceed(r.w, 'answered');
      }
    } catch (e: any) {
      if (myRun !== runId.current) return;
      setChatBusy(false);
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function build(w: Working, minorNotices: string[]) {
    const c = ctx.current!;
    setProgress('Filling workbook…');
    const { items: built, lineAmounts, listPrices } = toItems(w);
    const items: QuoteItem[] = built.map((i) => ({ ...i }));
    const hasDetails = c.existingDetails.length > 0;
    const detailsMode: DetailsMode = hasDetails && c.detailsChoice === 'keep' ? 'keep' : 'clear';
    if (hasDetails && c.detailsChoice === 'replace') items[0].details = c.detailsText;
    const quotationNo = w.ex.quotationNumber!;
    const opts = { items, rate: c.rate, rate2: c.rate2, quotationNo, detailsMode, mode: c.mode };
    const built2 = await buildPurchaseOrder(c.template, opts);

    setProgress('Verifying…');
    const total = linesTotal(w);
    const docTotal = w.ex.documentTotal;
    // Multivac: the lines must equal the Invoice amount (unless the user accepted a difference). Others: only when it matches.
    const checkTotal = docTotal !== null && !w.totalAccepted && (c.mode === 'multivac' || Math.abs(total - docTotal) <= 0.01) ? docTotal : undefined;
    const checks = await verifyWorkbook({ original: c.template, output: built2.bytes, opts, invoiceAmount: checkTotal, lineAmounts, listPrices });

    const notices: string[] = [];
    const cur = w.ex.currency;
    if (cur && cur.toUpperCase() !== EXPECTED_CURRENCY[c.mode]) notices.push(`The quotation currency is ${cur}, but this sheet expects ${EXPECTED_CURRENCY[c.mode]}. Please check the prices.`);
    if (w.totalAccepted && docTotal !== null) notices.push(`You accepted a difference between the lines (${fmt(total)}) and the quotation total (${fmt(docTotal)}).`);
    if (w.priceKind === 'line' && c.mode !== 'handtmann') notices.push('You said the price column is a line total, so the unit price is Price ÷ Quantity.');
    if (c.mode === 'handtmann') notices.push('Handtmann: unit price = Net Price ÷ Quantity.');
    notices.push(...minorNotices);
    if (c.mode === 'multivac') {
      notices.push('Order list columns A, B, E, F, I now hold typed values instead of links to Quotation_Multivac.');
      notices.push('The PO number and date at the top of PO Multivac come from the Template sheet and still show placeholders until you fill Template.');
      notices.push('Footer dates on PO Multivac and the rate-header date in Order list are fixed text and were left unchanged.');
    } else if (c.mode === 'other') {
      notices.push(`${built2.costName}: column I holds the EUR to MUR rate (${c.rate}) you entered.`);
      notices.push(`Only ${[built2.costName, ...built2.pos.map((p) => p.name)].join(', ')} was filled; the other PO sheets are unchanged.`);
      if (c.missingPo) notices.push(`This workbook has no “PO Others” sheet, so only ${built2.costName} was filled. Add a PO Others sheet (a copy of PO Bizerba) and run again to get the purchase order.`);
      notices.push('Unit Price on the PO reads the net unit price (column E), not the line total (column G), so Total Price is right when Qty is above 1.');
      notices.push('The PO number and date at the top of the PO come from the Template sheet and still show placeholders until you fill Template.');
      notices.push('Footer dates on the PO are fixed text and were left unchanged.');
    } else {
      notices.push(`${built2.costName}: column I (op) holds the ZAR to MUR rate and column T the EUR to MUR rate you entered.`);
      notices.push(`Only ${[built2.costName, ...built2.pos.map((p) => p.name)].join(', ')} was filled; the other PO sheets are unchanged.`);
      if (c.missingPo) notices.push(`This workbook has no “PO Others” sheet, so only ${built2.costName} was filled. Add a PO Others sheet (a copy of PO Bizerba) and run again to get the purchase order.`);
      notices.push('Unit Price on the PO reads the net unit price (column E), not the line total (column G), so Total Price is right when Qty is above 1.');
      notices.push('The PO number and date at the top of the PO come from the Template sheet and still show placeholders until you fill Template.');
      notices.push('Footer dates on the PO are fixed text and were left unchanged.');
    }
    if (hasDetails) notices.push(c.detailsChoice === 'keep' ? 'PO Details text: kept as in the template.' : c.detailsChoice === 'clear' ? 'PO Details text: cleared.' : 'PO Details text: replaced with your text.');
    if (items.length > 12 && !c.missingPo) notices.push("With many items the PO's closing frame can flow onto a second printed page.");
    notices.push('Excel will recalculate when the file opens and may ask about updating external links.');
    notices.push('Existing errors in other sheets were left as they were.');

    setResult({
      mode: c.mode,
      sheets: [built2.costName, ...built2.pos.map((p) => p.name)],
      items,
      quotationNo,
      documentTotal: docTotal,
      rate: c.rate,
      rate2: c.rate2,
      total,
      checks,
      bytes: built2.bytes,
      fileName: `${c.fileName.replace(/\.xlsx$/i, '')}_filled.xlsx`,
      notices,
    });
    setPhase('done');
  }

  function download() {
    if (!result) return;
    const blob = new Blob([result.bytes as BlobPart], { type: XLSX_MIME });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  const failed = result?.checks.filter((c) => !c.ok) || [];
  const allPass = !!result && failed.length === 0;
  const showForm = phase === 'idle' || phase === 'error' || (phase === 'running' && messages.length === 0);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 text-slate-900">
      <div className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">MULTIVAC Purchase Order</h1>
        <p className="mt-1 text-sm text-slate-500">Fills the quotation and purchase order sheets from a quotation PDF.</p>

        {showForm && (
          <div className="mt-6 space-y-4">
            <div>
              <div className="text-sm font-medium text-slate-800">Purchase order type</div>
              <div className="mt-1 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 sm:grid-cols-4">
                {MODE_IDS.map((m) => {
                  const unavailable = !!inspection?.ok && !inspection.modes[m];
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={unavailable || phase === 'running'}
                      title={unavailable ? 'The chosen workbook does not contain these sheets' : undefined}
                      onClick={() => setMode(m)}
                      className={`rounded-lg px-3 py-2 text-sm font-medium transition ${mode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'} disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      {MODES[m].label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Fills: {[MODES[mode].costSheet, ...MODES[mode].poSheets].join(', ')}. {TYPE_HINT[mode]}
              </p>
            </div>

            {mode === 'other' && (
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-sm font-medium text-slate-800">Column headers in the quotation PDF</div>
                <p className="text-xs text-slate-500">Type each header exactly as it is written in the PDF.</p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {COLUMN_KEYS.map((k) => (
                    <div key={k}>
                      <label className="text-xs font-medium text-slate-700" htmlFor={`col-${k}`}>
                        {COLUMN_LABEL[k]}
                      </label>
                      <input
                        id={`col-${k}`}
                        value={cols[k]}
                        onChange={(e) => setCols({ ...cols, [k]: e.target.value })}
                        placeholder={OTHER_PLACEHOLDER[k]}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <DropZone label="Quotation PDF" hint="Drop or click to choose" accept="application/pdf,.pdf" file={pdf} icon="pdf" onFile={setPdf} />
            <DropZone label="Template_Purchase_Order_2026.xlsx" hint="Drop or click to choose" accept=".xlsx" file={xlsx} icon="xlsx" onFile={chooseWorkbook} />
            {inspection?.ok && !inspection.modes[mode] && (
              <p className="text-sm text-red-600">
                This workbook does not contain the {MODES[mode].label} sheets. Sheets detected in this file: {inspection.sheetNames.join(', ')}.
              </p>
            )}
            {inspection?.ok && inspection.modes[mode] && inspection.missingPo[mode] && (
              <p className="text-sm text-amber-700">This workbook has no “PO Others” sheet. Only {MODES[mode].costSheet} will be filled. Add a PO Others sheet to get the purchase order too.</p>
            )}

            <div className={secondRate ? 'grid gap-4 sm:grid-cols-2' : ''}>
              <div>
                <label className="text-sm font-medium text-slate-800" htmlFor="rate">
                  {mode === 'other'
                    ? 'EUR to MUR Rate (1Eur = ?Mur)'
                    : secondRate
                      ? 'ZAR to MUR rate (1 ZAR = ? MUR)'
                      : 'Exchange rate (1 EUR = ? MUR)'}
                </label>
                <input
                  id="rate"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder={secondRate ? 'e.g. 3.08' : 'e.g. 54.99'}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                />
                {rateError && <p className="mt-1 text-xs text-red-600">{rateError}</p>}
              </div>
              {secondRate && (
                <div>
                  <label className="text-sm font-medium text-slate-800" htmlFor="rate2">
                    EUR to MUR rate (1 EUR = ? MUR)
                  </label>
                  <input
                    id="rate2"
                    inputMode="decimal"
                    value={rate2}
                    onChange={(e) => setRate2(e.target.value)}
                    placeholder="e.g. 54.99"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                  />
                  {rate2Error && <p className="mt-1 text-xs text-red-600">{rate2Error}</p>}
                </div>
              )}
            </div>

            {inspection?.ok && existingDetails.length > 0 && (
              <div>
                <div className="text-sm font-medium text-slate-800">PO Details text</div>
                <p className="text-xs text-slate-500">The template holds “{existingDetails.join(' / ')}” in the first Details cell.</p>
                <div className="mt-2 flex gap-4 text-sm">
                  {(['keep', 'clear', 'replace'] as const).map((c) => (
                    <label key={c} className="flex items-center gap-1.5">
                      <input type="radio" name="details" checked={detailsChoice === c} onChange={() => setDetailsChoice(c)} />
                      {c === 'keep' ? 'Keep' : c === 'clear' ? 'Clear' : 'Replace with my text'}
                    </label>
                  ))}
                </div>
                {detailsChoice === 'replace' && (
                  <input value={detailsText} onChange={(e) => setDetailsText(e.target.value)} placeholder="Details text" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500" />
                )}
              </div>
            )}

            {phase === 'error' && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              onClick={run}
              disabled={!canRun}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phase === 'running' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {progress}
                </>
              ) : (
                'Generate purchase order'
              )}
            </button>
          </div>
        )}

        {(phase === 'clarify' || (phase === 'running' && messages.length > 0)) && (
          <Clarification messages={messages} choices={phase === 'clarify' ? pending?.choices : undefined} remaining={phase === 'clarify' ? remaining : 0} busy={chatBusy || phase === 'running'} onAnswer={onAnswer} onRestart={reset} />
        )}

        {phase === 'done' && result && (
          <div className="mt-6 space-y-4">
            <div className={`flex items-center gap-2 rounded-lg p-3 text-sm font-medium ${allPass ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
              {allPass ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {allPass ? `All checks passed (${result.checks.length} of ${result.checks.length})` : `${failed.length} of ${result.checks.length} checks failed. No download offered.`}
            </div>
            {!allPass && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">
                {failed.map((c, i) => (
                  <li key={i}>
                    {c.name}
                    {c.detail ? `: ${c.detail}` : ''}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-slate-600">
              {MODES[result.mode].label} · {result.mode === 'multivac' || result.mode === 'other' ? `Rate ${result.rate}` : `ZAR to MUR ${result.rate} · EUR to MUR ${result.rate2}`} ·{' '}
              {result.sheets.map((n) => `${n} ${result.items.length} rows`).join(' · ')} · Total Exworks {result.total.toFixed(2)}
              {result.documentTotal !== null ? ` vs quotation total ${result.documentTotal.toFixed(2)}` : ''} · Quotation {result.quotationNo}
            </p>

            <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Reference</th>
                    <th className="px-3 py-2">Part Name</th>
                    <th className="px-3 py-2 text-right">Net Price</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((it, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-mono">{it.reference}</td>
                      <td className="px-3 py-1.5">{it.description}</td>
                      <td className="px-3 py-1.5 text-right">{it.netPrice.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right">
                        {it.quantity}
                        {it.unit && it.unit.toUpperCase() !== 'PC' ? ` ${it.unit}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-700">Notices</div>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-slate-600">
                {result.notices.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>

            <div className="flex items-center justify-between">
              <button onClick={download} disabled={!allPass} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">
                <Download className="h-4 w-4" />
                Download filled workbook
              </button>
              <button onClick={reset} className="text-sm text-slate-500 underline">
                Start over
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Supplier rules and clarification logic. Pure TypeScript (no browser, no Gemini): used by the server
 * (prompts), the screen (chat) and the tests.
 *
 * Principle: a value that is missing, unreadable or contradicted by another number on the quotation is
 * never guessed. It becomes an Issue, the chat asks the user, and the answer is applied deterministically.
 */

export type Supplier = 'multivac' | 'bizerba' | 'handtmann' | 'other';
export const SUPPLIERS: Supplier[] = ['multivac', 'bizerba', 'handtmann', 'other'];
export const SUPPLIER_LABEL: Record<Supplier, string> = {
  multivac: 'Multivac',
  bizerba: 'Bizerba',
  handtmann: 'Handtmann',
  other: 'Others',
};

export type ColumnKey = 'reference' | 'description' | 'price' | 'quantity';
export type ColumnMap = Record<ColumnKey, string>;
export type FieldKey = 'reference' | 'description' | 'price' | 'quantity' | 'unit';
export type PriceKind = 'unit' | 'line';

/** Column headers the supplier's quotation uses (Other: typed by the user). */
export const DEFAULT_COLUMNS: Record<'bizerba' | 'handtmann', ColumnMap> = {
  bizerba: { reference: 'Item', description: 'Description', price: 'Net Price', quantity: 'Qty' },
  handtmann: { reference: 'Code', description: 'Description', price: 'Net Price', quantity: 'Quantity' },
};

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  reference: 'Reference',
  description: 'Description',
  price: 'Buying Price 20% discount units(ZAR)',
  quantity: 'Quantity',
};

/** Handtmann prints the line total under "Net Price"; the others print the price per unit. */
export const defaultPriceKind = (s: Supplier): PriceKind => (s === 'handtmann' ? 'line' : 'unit');

export interface Flag {
  field: FieldKey;
  reason: string;
  /** other readings of the same value (offered as buttons in the chat) */
  candidates?: string[];
}

export interface RawPosition {
  position: string;
  reference: string | null;
  description: string | null;
  /** value of the supplier's price column exactly as printed (see PriceKind) */
  price: number | null;
  quantity: number | null;
  unit: string | null;
  /** Multivac only */
  listPrice?: number | null;
  /** line total printed in the PDF, when the PDF has one */
  lineAmount?: number | null;
  flags: Flag[];
}

export interface RawExtraction {
  quotationNumber: string | null;
  /** invoice amount / grand total printed on the quotation, when there is one */
  documentTotal: number | null;
  currency: string | null;
  positions: RawPosition[];
  ignoredLines: { lineText: string; reason: string }[];
  unclear: { item: string; reason: string }[];
  /** Bizerba / Handtmann / Other: was each requested column found in the PDF? */
  headersFound?: Record<ColumnKey, boolean>;
}

export interface Working {
  supplier: Supplier;
  columns?: ColumnMap;
  ex: RawExtraction;
  priceKind: PriceKind;
  /** true when the price kind is fixed by the supplier rule or the user answered */
  priceKindConfirmed: boolean;
  confirmed: string[];
  totalAccepted: boolean;
}

export type IssueKind = 'header' | 'quotationNumber' | 'missing' | 'check' | 'fraction' | 'lineMismatch' | 'priceKind' | 'total';

export interface Choice {
  label: string;
  value: string;
}

export interface Issue {
  id: string;
  kind: IssueKind;
  itemIndex?: number;
  field?: FieldKey | ColumnKey;
  question: string;
  choices?: Choice[];
}

export interface Analysis {
  issues: Issue[];
  /** minor points: shown on the result screen, never block */
  notices: string[];
}

export function startWorking(supplier: Supplier, ex: RawExtraction, columns?: ColumnMap): Working {
  const fixed = supplier === 'handtmann' || supplier === 'multivac';
  return {
    supplier,
    columns: columns ?? (supplier === 'bizerba' || supplier === 'handtmann' ? { ...DEFAULT_COLUMNS[supplier] } : undefined),
    ex: normalise(ex),
    priceKind: defaultPriceKind(supplier),
    priceKindConfirmed: fixed,
    confirmed: [],
    totalAccepted: false,
  };
}

function normalise(ex: RawExtraction): RawExtraction {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : null) || null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    quotationNumber: s(ex.quotationNumber),
    documentTotal: n(ex.documentTotal),
    currency: s(ex.currency),
    ignoredLines: ex.ignoredLines || [],
    unclear: ex.unclear || [],
    headersFound: ex.headersFound,
    positions: (ex.positions || []).map((p, i) => ({
      position: String(p.position ?? i + 1),
      reference: s(p.reference),
      description: s(p.description),
      price: n(p.price),
      quantity: n(p.quantity),
      unit: s(p.unit),
      listPrice: n(p.listPrice),
      lineAmount: n(p.lineAmount),
      flags: (p.flags || []).filter((f) => f && f.field),
    })),
  };
}

// --------------------------------------------------------------------- numbers
const round2 = (x: number) => Math.round(x * 100) / 100;
export const fmt = (x: number) => (Math.round(x * 10000) / 10000).toString();

/**
 * Parse a number typed by a person. Accepts "3,52", "1.234,56", "1,234.56", "R 1 234,50", "€12.5".
 * A lone comma followed by exactly three digits ("1,234") is ambiguous and is rejected, never guessed.
 */
export function parseNumber(input: string): { value: number } | { error: string } {
  const m = /-?\d[\d\s.,\u00a0]*/.exec(input);
  if (!m) return { error: 'I could not find a number in that answer. Please type just the number, for example 12.50.' };
  let t = m[0].replace(/[\s\u00a0]/g, '').replace(/[.,]+$/, '');
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    t = t.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = t.split(sep);
    if (parts.length > 2) {
      if (!parts.slice(1).every((p) => p.length === 3)) return { error: 'That number is not clear. Please write it like 1234.50.' };
      t = parts.join('');
    } else if (sep === ',' && parts[1].length === 3 && parts[0].length <= 3) {
      return { error: `“${m[0].trim()}” could mean ${parts[0]}.${parts[1]} or ${parts[0]}${parts[1]}. Please write it with a decimal point, for example ${parts[0]}.${parts[1]} or ${parts[0]}${parts[1]}.` };
    } else if (sep === ',') {
      t = t.replace(',', '.');
    }
  }
  const v = Number(t);
  if (!Number.isFinite(v)) return { error: 'I could not read that as a number. Please type it like 12.50.' };
  return { value: v };
}

// ---------------------------------------------------------------------- items
export interface ItemOut {
  reference: string;
  description: string;
  netPrice: number;
  quantity: number;
  unit?: string;
}

export interface BuiltItems {
  items: ItemOut[];
  lineAmounts?: number[];
  listPrices?: number[];
}

/** Final data for the workbook. Handtmann: Unit Net Price = Net Price / Quantity. Others: price as printed. */
export function toItems(w: Working): BuiltItems {
  const ps = w.ex.positions;
  const items: ItemOut[] = ps.map((p) => ({
    reference: p.reference!,
    description: p.description!,
    netPrice: w.priceKind === 'line' ? p.price! / p.quantity! : p.price!,
    quantity: p.quantity!,
    unit: p.unit || undefined,
  }));
  let lineAmounts: number[] | undefined;
  if (w.priceKind === 'line') lineAmounts = ps.map((p) => p.price!);
  else if (ps.every((p) => p.lineAmount != null)) lineAmounts = ps.map((p) => p.lineAmount!);
  const listPrices = w.supplier === 'multivac' && ps.every((p) => p.listPrice != null) ? ps.map((p) => p.listPrice!) : undefined;
  return { items, lineAmounts, listPrices };
}

export const linesTotal = (w: Working) =>
  round2(w.ex.positions.reduce((s, p) => s + (w.priceKind === 'line' ? p.price! : p.price! * p.quantity!), 0));

// -------------------------------------------------------------------- analysis
const priceName = (s: Supplier) =>
  s === 'handtmann' ? 'Net Price (the line total as printed)' : s === 'multivac' ? 'net price (per unit, after discount)' : 'net price (as printed in the price column)';

const fieldName = (s: Supplier, f: FieldKey | ColumnKey) =>
  f === 'price' ? priceName(s) : f === 'reference' ? 'part reference' : f === 'description' ? 'description' : f === 'quantity' ? 'quantity' : 'unit';

const shown = (p: RawPosition, f: FieldKey): string => {
  const v = p[f];
  return v === null || v === undefined ? '' : String(v);
};

const lineLabel = (p: RawPosition, i: number) => `line ${p.position || i + 1}${p.reference ? ` (${p.reference})` : ''}`;

export function analyze(w: Working): Analysis {
  const issues: Issue[] = [];
  const notices: string[] = [];
  const { ex, supplier } = w;
  const done = (k: string) => w.confirmed.includes(k);

  // 1. columns the PDF does not have (Bizerba / Handtmann / Other): nothing else can be trusted until fixed
  if (supplier !== 'multivac' && ex.headersFound) {
    const cols = w.columns!;
    for (const key of ['reference', 'description', 'price', 'quantity'] as ColumnKey[]) {
      if (ex.headersFound[key] === false) {
        issues.push({
          id: `header:${key}`,
          kind: 'header',
          field: key,
          question: `I could not find a column called “${cols[key]}” (for ${COLUMN_LABEL[key]}) in this PDF. What is the exact column header in the PDF?`,
        });
      }
    }
    if (issues.length) return { issues, notices };
  }

  // 2. quotation number
  if (!ex.quotationNumber) {
    issues.push({
      id: 'quotationNumber',
      kind: 'quotationNumber',
      question: 'I could not read the quotation number. What is it? (It is written on the purchase orders as “Your Quotation: …”.)',
    });
  }

  // 3. each line, each field
  ex.positions.forEach((p, i) => {
    const where = lineLabel(p, i);
    const need = (f: FieldKey, bad: boolean, reasonText: string) => {
      if (done(`${i}:${f}`)) return;
      const flagged = p.flags.find((x) => x.field === f);
      if (bad) {
        issues.push({
          id: `missing:${i}:${f}`,
          kind: 'missing',
          itemIndex: i,
          field: f,
          question: `${reasonText} What is the ${fieldName(supplier, f)} for ${where}?`,
        });
      } else if (flagged) {
        issues.push({
          id: `check:${i}:${f}`,
          kind: 'check',
          itemIndex: i,
          field: f,
          question: `I am not sure about the ${fieldName(supplier, f)} for ${where}: ${flagged.reason} I read “${shown(p, f)}”. Is that right? If not, type the correct value.`,
          choices: [
            { label: `Yes, “${shown(p, f)}” is right`, value: 'keep' },
            ...(flagged.candidates || []).filter((c) => c !== shown(p, f)).map((c) => ({ label: `Use “${c}”`, value: c })),
          ],
        });
      }
    };
    need('reference', !p.reference, 'The part reference is missing or unreadable.');
    need('description', !p.description, 'The description is missing or unreadable.');
    need('quantity', p.quantity === null || p.quantity <= 0, 'The quantity is missing or unreadable.');
    need('price', p.price === null || p.price < 0, 'The price is missing or unreadable.');
    const unit = (p.unit || 'PC').toUpperCase();
    if (p.quantity && p.quantity > 0 && !Number.isInteger(p.quantity) && unit === 'PC' && !done(`${i}:fraction`) && !done(`${i}:quantity`)) {
      issues.push({
        id: `fraction:${i}`,
        kind: 'fraction',
        itemIndex: i,
        field: 'quantity',
        question: `The quantity for ${where} is ${fmt(p.quantity)} but the unit is PC (pieces). Is ${fmt(p.quantity)} right? If not, type the correct quantity.`,
        choices: [{ label: `Yes, ${fmt(p.quantity)} is right`, value: 'keep' }],
      });
    }
  });
  if (issues.length) return { issues, notices };

  // 4. cross-checks between prices, quantities, line totals and the quotation total
  const ps = ex.positions;
  if (w.priceKind === 'unit') {
    const wrong = ps.map((p, i) => ({ p, i })).filter(({ p, i }) => p.lineAmount != null && !done(`${i}:linecheck`) && Math.abs(p.price! * p.quantity! - p.lineAmount) > 0.01);
    const swapped = wrong.filter(({ p }) => Math.abs(p.price! - p.lineAmount!) <= 0.01 && p.quantity !== 1);
    if (!w.priceKindConfirmed && wrong.length > 0 && swapped.length === wrong.length) {
      issues.push(priceKindIssue('The price column equals the line total on the lines where the quantity is more than 1.'));
    } else {
      for (const { p, i } of wrong) {
        issues.push({
          id: `lineMismatch:${i}`,
          kind: 'lineMismatch',
          itemIndex: i,
          field: 'price',
          question: `For ${lineLabel(p, i)}, price ${fmt(p.price!)} × quantity ${fmt(p.quantity!)} = ${fmt(round2(p.price! * p.quantity!))}, but the PDF shows a line total of ${fmt(p.lineAmount!)}. Which price is right? Type the correct unit price, or choose to keep it.`,
          choices: [{ label: `Keep ${fmt(p.price!)}`, value: 'keep' }],
        });
      }
    }
  }
  if (issues.length) return { issues, notices };

  const sum = linesTotal(w);
  const total = ex.documentTotal;
  if (total !== null && !w.totalAccepted && Math.abs(sum - total) > 0.01) {
    const sumIfLine = round2(ps.reduce((s, p) => s + p.price!, 0));
    if (supplier !== 'multivac' && w.priceKind === 'unit' && !w.priceKindConfirmed && Math.abs(sumIfLine - total) <= 0.01 && ps.some((p) => p.quantity !== 1)) {
      issues.push(priceKindIssue('The prices add up to the quotation total only if they are line totals.'));
    } else if (supplier === 'multivac') {
      issues.push(totalIssue(w, sum, total, 'The lines should add up exactly to the Invoice amount.'));
    } else {
      notices.push(
        `The lines add up to ${fmt(sum)} but the quotation shows a total of ${fmt(total)}. This can be freight, VAT or discounts; please check if that is expected.`,
      );
    }
  } else if (total === null && supplier !== 'multivac') {
    notices.push('The quotation shows no overall total, so the line sum could not be cross-checked.');
  }
  // price kind cannot be told from the document at all: ask once instead of assuming
  if (
    (supplier === 'bizerba' || supplier === 'other') &&
    !w.priceKindConfirmed &&
    !issues.length &&
    total === null &&
    !ps.some((p) => p.lineAmount != null) &&
    ps.some((p) => p.quantity !== 1)
  ) {
    issues.push(priceKindIssue('The PDF has no line totals or overall total I could use to tell.'));
  }
  if (issues.length) return { issues, notices };

  // 5. minor points
  if (ex.ignoredLines.length) notices.push(`Lines without price and quantity were skipped: ${ex.ignoredLines.map((l) => l.lineText).join('; ')}`);
  for (const u of ex.unclear) notices.push(`Reader note: ${u.item}: ${u.reason}`);
  const seen = new Map<string, number>();
  ps.forEach((p) => seen.set(p.reference!, (seen.get(p.reference!) || 0) + 1));
  const dups = [...seen].filter(([, c]) => c > 1).map(([r]) => r);
  if (dups.length) notices.push(`The same part reference appears on more than one line: ${dups.join(', ')}.`);
  if (ps.some((p) => p.unit && p.unit.toUpperCase() !== 'PC')) {
    notices.push(
      `Non-PC units: ${ps.filter((p) => p.unit && p.unit.toUpperCase() !== 'PC').map((p) => `${p.position} (${fmt(p.quantity!)} ${p.unit})`).join(', ')}. Quantity is entered as printed.`,
    );
  }
  return { issues, notices };
}

function priceKindIssue(why: string): Issue {
  return {
    id: 'priceKind',
    kind: 'priceKind',
    question: `${why} Is the price in the price column the price per unit, or the total for the line (quantity × unit price)?`,
    choices: [
      { label: 'Price per unit', value: 'unit' },
      { label: 'Line total (divide by quantity)', value: 'line' },
    ],
  };
}

function totalIssue(w: Working, sum: number, total: number, why: string): Issue {
  const labels = w.ex.positions.map((p) => p.position).join(', ');
  return {
    id: 'total',
    kind: 'total',
    question: `The lines add up to ${fmt(sum)} but the quotation total is ${fmt(total)} (difference ${fmt(round2(sum - total))}). ${why} If one line is wrong, type its position (${labels}) and I will ask about its price. Otherwise choose to continue.`,
    choices: [{ label: 'Continue anyway', value: 'accept' }],
  };
}

// --------------------------------------------------------------------- answers
export type ApplyResult = { w: Working } | { w: Working; reextract: ColumnMap } | { error: string };

const clone = (w: Working): Working => JSON.parse(JSON.stringify(w));

export function applyAnswer(w0: Working, issue: Issue, raw: string): ApplyResult {
  const answer = raw.trim();
  if (!answer) return { error: 'Please type an answer or pick one of the buttons.' };
  const w = clone(w0);
  const p = issue.itemIndex !== undefined ? w.ex.positions[issue.itemIndex] : undefined;
  const confirm = (k: string) => {
    if (!w.confirmed.includes(k)) w.confirmed.push(k);
  };

  switch (issue.kind) {
    case 'header': {
      const key = issue.field as ColumnKey;
      const cols = { ...(w.columns ?? (w.supplier === 'bizerba' || w.supplier === 'handtmann' ? DEFAULT_COLUMNS[w.supplier] : ({} as ColumnMap))) };
      cols[key] = answer;
      return { w, reextract: cols };
    }
    case 'quotationNumber':
      w.ex.quotationNumber = answer;
      return { w };
    case 'priceKind':
      if (answer !== 'unit' && answer !== 'line') return { error: 'Please choose “Price per unit” or “Line total”.' };
      w.priceKind = answer;
      w.priceKindConfirmed = true;
      return { w };
    case 'total': {
      if (answer === 'accept' || /^(continue|accept|ok|okay|yes)\b/i.test(answer)) {
        w.totalAccepted = true;
        return { w };
      }
      const label = answer.replace(/^(pos(ition)?|line)\s*/i, '').trim();
      const idx = w.ex.positions.findIndex((x) => x.position === label);
      if (idx < 0) return { error: `I could not find position “${answer}”. Type one of: ${w.ex.positions.map((x) => x.position).join(', ')}, or choose Continue anyway.` };
      const t = w.ex.positions[idx];
      t.flags = t.flags.filter((f) => f.field !== 'price');
      t.flags.push({ field: 'price', reason: 'You asked me to double-check this price.' });
      w.confirmed = w.confirmed.filter((k) => k !== `${idx}:price` && k !== `${idx}:linecheck`);
      return { w };
    }
    case 'lineMismatch':
    case 'fraction':
    case 'missing':
    case 'check': {
      if (!p || !issue.field) return { error: 'Internal error: this question is not linked to a line.' };
      const field = issue.field as FieldKey;
      const key = issue.kind === 'lineMismatch' ? `${issue.itemIndex}:linecheck` : issue.kind === 'fraction' ? `${issue.itemIndex}:fraction` : `${issue.itemIndex}:${field}`;
      if (answer === 'keep') {
        if (issue.kind === 'missing') return { error: 'That value is missing, so I need you to type it.' };
        confirm(key);
        if (issue.kind === 'fraction') confirm(`${issue.itemIndex}:quantity`);
        p.flags = p.flags.filter((f) => f.field !== field);
        return { w };
      }
      if (field === 'price' || field === 'quantity') {
        const n = parseNumber(answer);
        if ('error' in n) return { error: n.error };
        if (field === 'quantity' && !(n.value > 0)) return { error: 'The quantity must be more than 0.' };
        if (field === 'price' && n.value < 0) return { error: 'The price cannot be negative.' };
        p[field] = n.value;
      } else {
        p[field] = answer;
      }
      p.flags = p.flags.filter((f) => f.field !== field);
      confirm(`${issue.itemIndex}:${field}`);
      if (issue.kind === 'fraction') confirm(key);
      if (issue.kind === 'lineMismatch') confirm(key);
      return { w };
    }
  }
}

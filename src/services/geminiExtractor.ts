import { GoogleGenAI, Type } from '@google/genai';
import {
  DEFAULT_COLUMNS,
  type ColumnMap,
  type FieldKey,
  type Flag,
  type RawExtraction,
  type RawPosition,
  type Supplier,
} from './quotation.js';
import {
  detectSupplierFromPdfBytes,
  detectSupplierFromText,
  type DetectedSupplierCategory,
  type SupplierDetectionResult,
} from './supplierDetector.js';

export type { RawExtraction, RawPosition, Supplier, ColumnMap } from './quotation.js';
export type { DetectedSupplierCategory, SupplierDetectionResult } from './supplierDetector.js';

export interface ExtractionResult {
  success: boolean;
  extraction?: RawExtraction;
  error?: string;
}

export interface ExtractOptions {
  supplier: Supplier;
  /** Bizerba / Handtmann default to their own headers; Other must provide all four */
  columns?: ColumnMap;
}

/** Sends one prompt (+ the PDF) and returns the model's JSON text. Injectable so the pipeline can be tested. */
export type Generate = (prompt: string, schema: unknown) => Promise<string>;

// --------------------------------------------------------------------- schema
function buildSchema(supplier: Supplier) {
  const n = { type: Type.NUMBER, nullable: true };
  const s = { type: Type.STRING, nullable: true };
  const positionProps: Record<string, unknown> = {
    position: { type: Type.STRING, description: "Line / position label as printed (e.g. '10', '20'). If the quotation has none, number the lines 1, 2, 3." },
    reference: { ...s, description: 'The part reference as a STRING, keeping leading zeros. null if it is not printed or unreadable.' },
    description: { ...s, description: 'Full item description (join continuation lines and dimension lines). null if missing.' },
    price: { ...n, description: 'The value printed in the price column, exactly as printed (see instructions). null if missing or unreadable.' },
    quantity: { ...n, description: 'Quantity as a number. null if missing or unreadable.' },
    unit: { ...s, description: 'Unit (PC, m, ...). null if not printed.' },
    listPrice: { ...n, description: 'Per-unit list price before discount, only if the quotation prints one. Otherwise null.' },
    lineAmount: { ...n, description: 'The line total printed on the quotation for this line, only if it prints one. Otherwise null.' },
    flags: {
      type: Type.ARRAY,
      description: 'One entry for each field of THIS line that is missing, hard to read, ambiguous, or that you had to infer. Leave empty when everything on the line is clearly printed.',
      items: {
        type: Type.OBJECT,
        properties: {
          field: { type: Type.STRING, enum: ['reference', 'description', 'price', 'quantity', 'unit'] },
          reason: { type: Type.STRING, description: 'One short sentence a person can understand.' },
        },
        required: ['field', 'reason'],
      },
    },
  };
  const top: Record<string, unknown> = {
    quotationNumber: { ...s, description: 'The number that identifies this quotation / offer (not the customer number, not a customer reference). null if not found.' },
    documentTotal: { ...n, description: 'The overall total of the quotation if one is printed (the amount before VAT/tax if both are shown). null if none.' },
    currency: { ...s, description: 'Currency code of the prices (EUR, ZAR, USD...). null if not shown.' },
    positions: { type: Type.ARRAY, description: 'Every line item on ALL pages.', items: { type: Type.OBJECT, properties: positionProps, required: Object.keys(positionProps) } },
    ignoredLines: {
      type: Type.ARRAY,
      description: 'Sub-total, text, header or note lines without price and quantity that you skipped.',
      items: { type: Type.OBJECT, properties: { lineText: { type: Type.STRING }, reason: { type: Type.STRING } }, required: ['lineText', 'reason'] },
    },
    unclear: {
      type: Type.ARRAY,
      description: "ONLY document-level problems that cannot be tied to one line. Line-level doubts belong in that line's flags.",
      items: { type: Type.OBJECT, properties: { item: { type: Type.STRING }, reason: { type: Type.STRING } }, required: ['item', 'reason'] },
    },
  };
  if (supplier !== 'multivac') {
    top.headersFound = {
      type: Type.OBJECT,
      description: 'For each requested column: true if a column with that header exists in the quotation table, false if it does not.',
      properties: { reference: { type: Type.BOOLEAN }, description: { type: Type.BOOLEAN }, price: { type: Type.BOOLEAN }, quantity: { type: Type.BOOLEAN } },
      required: ['reference', 'description', 'price', 'quantity'],
    };
  }
  return { type: Type.OBJECT, properties: top, required: Object.keys(top) };
}

// -------------------------------------------------------------------- prompts
const RULES = `GENERAL RULES (apply to every value):
- Copy what is printed. NEVER guess, estimate, calculate or complete a value that is not printed: use null.
- If a value is partly unreadable, ambiguous, or you had to infer it, still return your best reading and add an entry to that line's flags (field + one short reason). Do NOT flag values that are clearly printed.
- European numbers: 3,52 = 3.52 and 1.234,56 = 1234.56.
- Include every line item on ALL pages. If a line is split across a page break, join its pieces into one line. Skip header, sub-total, page and note lines (list them in ignoredLines).
- "unclear" is only for problems that cannot be tied to one line.`;

export function columnsFor(supplier: Supplier, columns?: ColumnMap): ColumnMap | undefined {
  if (supplier === 'bizerba' || supplier === 'handtmann') return { ...DEFAULT_COLUMNS[supplier], ...(columns || {}) };
  if (supplier === 'other') return columns;
  return undefined;
}

function columnBlock(cols: ColumnMap, priceNote: string) {
  return `Read the quotation table using these EXACT column headers (ignore capitals and trailing punctuation, but never substitute a different column):
- reference -> the column headed “${cols.reference}” (the part reference)
- description -> the column headed “${cols.description}”
- quantity -> the column headed “${cols.quantity}”
- price -> the column headed “${cols.price}”. ${priceNote}
If a requested column does not exist in the quotation, set headersFound for it to false and return null for that field on every line. Do not use another column in its place.
If the document has a separate line-total / extended-price column, put it in lineAmount.
quotationNumber: the quotation / offer number of the document. documentTotal: the overall quotation total if printed.`;
}

export function buildPrompts(supplier: Supplier, columns?: ColumnMap) {
  let task: string;
  if (supplier === 'multivac') {
    task = `Extract all order line items from the attached MULTIVAC quotation PDF.
1. Count and list all positions (Pos. 10, 20, 30...) across ALL pages. If a position is split across a page break, join the description lines into one description.
2. For each position:
   - position: the item position number (e.g. "10", "20")
   - reference: the bold material number (keep as a STRING with leading zeros intact)
   - description: the part description plus its dimension line (e.g. "Tension spring D1=9")
   - price: per-unit "Net price" AFTER the customer discount (NOT the list price, NOT the line amount)
   - listPrice: list price per unit
   - quantity: quantity ordered/quoted
   - unit: unit code (PC, m, etc.)
   - lineAmount: the line total shown on the PDF
3. documentTotal: the final "Invoice amount" (Total Exworks) on the quotation.
   quotationNumber: the "Document" number at the top of the quotation (e.g. 21400572), NOT the customer number and NOT the "Your quote request" reference.`;
  } else if (supplier === 'handtmann') {
    task = `Extract all order line items from the attached HANDTMANN quotation PDF.
${columnBlock(columnsFor('handtmann', columns)!, 'IMPORTANT: on Handtmann quotations the Net Price is the amount for the WHOLE line (quantity times unit price). Return it exactly as printed in price. Do NOT divide it by the quantity; that is done later.')}`;
  } else if (supplier === 'bizerba') {
    task = `Extract all order line items from the attached BIZERBA quotation PDF.
${columnBlock(columnsFor('bizerba', columns)!, 'Return the value printed in this column exactly as printed. Do not multiply or divide it.')}`;
  } else {
    const cols = columnsFor('other', columns)!;
    task = `Extract all order line items from the attached supplier quotation PDF. The supplier is not known in advance.
${columnBlock(cols, 'Return the value printed in this column exactly as printed. Do not multiply or divide it.')}`;
  }
  const p1 = `You are a specialist quotation document extractor.\n${task}\n\n${RULES}`;
  const p2 = `You are an independent quality-assurance auditor reviewing this quotation PDF. Audit every line with precision and extract it.\n${task}\n\n${RULES}`;
  const p3 = (differences: string[]) =>
    `You are a senior auditor reconciling discrepancies between two extraction passes of this quotation.\nSpecific differences identified:\n${differences.join('\n')}\n\nCarefully inspect the PDF for these points and give the verified, definitive extraction of the whole document, following the same task:\n${task}\n\n${RULES}\nIf a value is still genuinely ambiguous after inspection, return your best reading and flag it.`;
  return { p1, p2, p3 };
}

// -------------------------------------------------------------------- compare
const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const sameNum = (a: number | null | undefined, b: number | null | undefined, tol: number) =>
  a == null || b == null ? a == null && b == null : Math.abs(a - b) <= tol;
const FIELD_EQ: Record<FieldKey, (a: RawPosition, b: RawPosition) => boolean> = {
  reference: (a, b) => norm(a.reference) === norm(b.reference),
  description: (a, b) => norm(a.description) === norm(b.description),
  price: (a, b) => sameNum(a.price, b.price, 0.005),
  quantity: (a, b) => sameNum(a.quantity, b.quantity, 0.0005),
  unit: (a, b) => norm(a.unit) === norm(b.unit),
};
const FIELDS = Object.keys(FIELD_EQ) as FieldKey[];
const show = (p: RawPosition, f: FieldKey) => (p[f] == null ? '(nothing)' : String(p[f]));

export function compareRuns(r1: RawExtraction, r2: RawExtraction): string[] {
  const d: string[] = [];
  if (norm(r1.quotationNumber) !== norm(r2.quotationNumber)) d.push(`Quotation number: pass 1 read "${r1.quotationNumber}", pass 2 read "${r2.quotationNumber}"`);
  if (!sameNum(r1.documentTotal, r2.documentTotal, 0.01)) d.push(`Document total: pass 1 read ${r1.documentTotal}, pass 2 read ${r2.documentTotal}`);
  if (r1.positions.length !== r2.positions.length) {
    d.push(`Number of line items: pass 1 found ${r1.positions.length}, pass 2 found ${r2.positions.length}`);
    return d;
  }
  r1.positions.forEach((p, i) => {
    const q = r2.positions[i];
    for (const f of FIELDS) if (!FIELD_EQ[f](p, q)) d.push(`Line ${p.position} ${f}: pass 1 read ${show(p, f)}, pass 2 read ${show(q, f)}`);
  });
  return d;
}

const clean = (ex: RawExtraction): RawExtraction => ({
  quotationNumber: ex.quotationNumber ?? null,
  documentTotal: ex.documentTotal ?? null,
  currency: ex.currency ?? null,
  ignoredLines: ex.ignoredLines || [],
  unclear: ex.unclear || [],
  headersFound: ex.headersFound,
  positions: (ex.positions || []).map((p) => ({ ...p, flags: Array.isArray(p.flags) ? p.flags.filter((f) => f?.field) : [] })),
});

/**
 * Decide which doubts are real. Two independent passes that read the same value are trusted; a doubt is kept
 * only when both passes had it, or when the passes disagreed and the reconciliation could not settle it.
 */
export function mergeFlags(r1: RawExtraction, r2: RawExtraction, final: RawExtraction, reconciled: boolean): RawExtraction {
  const out = clean(final);
  if (r1.positions.length !== r2.positions.length || r1.positions.length !== out.positions.length) return out;
  out.positions.forEach((fp, i) => {
    const a = r1.positions[i];
    const b = r2.positions[i];
    const flags: Flag[] = [];
    for (const f of FIELDS) {
      const agree = FIELD_EQ[f](a, b);
      const fa = a.flags.find((x) => x.field === f);
      const fb = b.flags.find((x) => x.field === f);
      const fin = fp.flags.find((x) => x.field === f);
      if (agree) {
        if (fa && fb) flags.push({ field: f, reason: fa.reason });
      } else {
        const settled = reconciled && !fin && (FIELD_EQ[f](fp, a) || FIELD_EQ[f](fp, b));
        if (!settled) {
          const cands = [...new Set([show(a, f), show(b, f)].filter((x) => x !== '(nothing)'))];
          flags.push({ field: f, reason: fin?.reason || `Two reading passes disagreed (${show(a, f)} / ${show(b, f)}).`, candidates: cands });
        }
      }
    }
    fp.flags = flags;
  });
  return out;
}

// ------------------------------------------------------------------- pipeline
export async function runExtraction(generate: Generate, opts: ExtractOptions): Promise<ExtractionResult> {
  const { supplier } = opts;
  const schema = buildSchema(supplier);
  const prompts = buildPrompts(supplier, opts.columns);
  const parse = (t: string): RawExtraction => clean(JSON.parse(t || '{}'));

  const [t1, t2] = await Promise.all([generate(prompts.p1, schema), generate(prompts.p2, schema)]);
  const r1 = parse(t1);
  const r2 = parse(t2);
  const diffs = compareRuns(r1, r2);
  let final = r1;
  let reconciled = false;
  if (diffs.length) {
    final = parse(await generate(prompts.p3(diffs), schema));
    reconciled = true;
  }
  const ex = mergeFlags(r1, r2, final, reconciled);

  // document-level values the passes disagreed on and the reconciliation could not settle: ask, never pick
  if (reconciled) {
    if (norm(r1.quotationNumber) !== norm(r2.quotationNumber) && norm(ex.quotationNumber) !== norm(r1.quotationNumber) && norm(ex.quotationNumber) !== norm(r2.quotationNumber)) ex.quotationNumber = null;
    if (!sameNum(r1.documentTotal, r2.documentTotal, 0.01) && !sameNum(ex.documentTotal, r1.documentTotal, 0.01) && !sameNum(ex.documentTotal, r2.documentTotal, 0.01)) ex.documentTotal = null;
    if (r1.positions.length !== r2.positions.length && ex.positions.length !== r1.positions.length && ex.positions.length !== r2.positions.length) {
      ex.unclear.push({ item: 'Number of line items', reason: `The two reading passes found ${r1.positions.length} and ${r2.positions.length} lines, the final list has ${ex.positions.length}. Please check the item table.` });
    }
  }

  if (!ex.positions.length) {
    return { success: false, error: 'No line items were found in this PDF. Check that it is the right supplier type and, for Other, that the column headers are spelled as in the PDF.' };
  }
  return { success: true, extraction: ex };
}

// --------------------------------------------------------- real Gemini client
async function callGeminiWithRetry(ai: GoogleGenAI, params: any, maxRetries = 3, initialDelay = 1500): Promise<any> {
  let delay = initialDelay;
  const isCapacity = (err: any) => {
    const e = String(err?.message || err);
    return err?.status === 429 || err?.status === 503 || /429|503|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED|quota|rate limit/i.test(e);
  };
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      if (isCapacity(err) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      if (isCapacity(err) && params.model !== 'gemini-3.1-flash-lite') {
        return await ai.models.generateContent({ ...params, model: 'gemini-3.1-flash-lite' });
      }
      throw err;
    }
  }
}

export async function extractQuotationFromPdf(pdfBase64: string, apiKey: string, opts: ExtractOptions): Promise<ExtractionResult> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
  const generate: Generate = async (prompt, schema) => {
    const res = await callGeminiWithRetry(ai, {
      model: 'gemini-3.8-flash',
      contents: [{ parts: [{ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }, { text: prompt }] }],
      config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 },
    });
    return res.text || '{}';
  };
  return runExtraction(generate, opts);
}

// --------------------------------------------------------- supplier detection
const SUPPLIER_DETECTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    supplier: {
      type: Type.STRING,
      enum: ['multivac', 'bizerba', 'handtmann', 'other', 'uncertain'],
      description:
        'Category of the issuing supplier: "multivac" for MULTIVAC, "bizerba" for BIZERBA, "handtmann" for HANDTMANN, "other" for any other identifiable supplier company, or "uncertain" if the supplier cannot be confidently identified.',
    },
    confidence: {
      type: Type.STRING,
      enum: ['high', 'medium', 'low'],
      description: 'Confidence in the supplier identification.',
    },
    detectedName: {
      type: Type.STRING,
      nullable: true,
      description: 'The name of the issuing supplier company printed on the quotation (e.g. "Multivac", "Bizerba", "Handtmann", or the third-party vendor name). null if uncertain.',
    },
    reason: {
      type: Type.STRING,
      description: 'One short sentence explaining what identifying information (logo, company name, address, domain, or layout) was used.',
    },
  },
  required: ['supplier', 'confidence', 'detectedName', 'reason'],
};

export const SUPPLIER_DETECTION_PROMPT = `You are a specialist document classifier for a Purchase Order application.
Inspect the attached quotation PDF (including company name, VAT registration number, postal/street address, telephone/fax numbers, email, commercial register, managing directors, logo, and table layout) to classify the quotation into one of four supplier categories: "multivac", "handtmann", "bizerba", or "other" (or "uncertain").

CRITICAL RULE — DISTINGUISHING MULTIVAC FROM HANDTMANN AND OTHERS:
Both Handtmann and Multivac quotations can contain the word "MULTIVAC" in their company details. Distinguish them using the specific company details below, and NEVER classify a genuine Multivac or Handtmann quotation as "other":

1. "multivac" (MULTIVAC Category — Issued by MULTIVAC Service und Logistik GmbH & Co. KG in Germany):
   Classify as supplier: "multivac", confidence: "high", detectedName: "Multivac" when the document contains ANY of these German Multivac identifiers:
   - Company name: MULTIVAC Service und Logistik GmbH & Co. KG (or MULTIVAC Sepp Haggenmüller SE & Co. KG)
   - Personally liable partner: MULTIVAC Service und Logistik Verwaltungs GmbH
   - Address: Gewerbestraße 15, 87787 Wolfertschwenden, Germany
   - Telephone: +49 (0) 8334 601-0
   - Fax: +49 (0) 8334 601-199
   - Email: muwo@multivac.de or stefan.kirchmann@multivac.de (or any @multivac.de email)
   - Website: www.multivac.com (when accompanied by German Wolfertschwenden / MULTIVAC Service und Logistik details)
   - VAT ID: DE 364316979
   - Commercial register: Amtsgericht Memmingen, HRA 13980
   - Managing directors: Dr. Christian Lau, Dr. Johannes Epple
   - Standard Multivac quotation table layout (Pos. 10, 20..., List price, Net price, Invoice amount, Your quote request)
   IMPORTANT: Do NOT confuse the customer/recipient address on a Multivac quotation with the issuing supplier. Even if a customer company name appears in the recipient block, if the issuing company is MULTIVAC Service und Logistik GmbH & Co. KG (Wolfertschwenden, Germany), you MUST classify it as "multivac", NEVER "other".

2. "handtmann" (HANDTMANN Category — Issued by MULTIVAC SOUTHERN AFRICA (Pty) Ltd or Handtmann):
   Classify as supplier: "handtmann", confidence: "high", detectedName: "Handtmann" when the document is issued by MULTIVAC SOUTHERN AFRICA (Pty) Ltd or matches ANY of these Handtmann identifiers:
   - Company name: MULTIVAC SOUTHERN AFRICA (Pty) Ltd
   - VAT Registration Number: 4770217620
   - Postal address: PostNet Suite 514, Private Bag H607, Heidelberg, 1438
   - Telephone: +27 (0) 16 340 5800
   - Fax: +27 (0) 16 340 5819
   - OR direct Handtmann identifiers (Albert Handtmann, Handtmann Maschinenfabrik, Biberach, handtmann.de, HANDTMANN, or Handtmann table columns: Code, Description, Quantity, Net Price).
   IMPORTANT: Whenever the issuing company is MULTIVAC SOUTHERN AFRICA (Pty) Ltd or VAT Registration Number 4770217620 is present (and it is not issued by MULTIVAC Service und Logistik GmbH & Co. KG in Germany), the document MUST be classified as "handtmann", NEVER "multivac" or "other".

3. "bizerba" (BIZERBA Category):
   Classify as supplier: "bizerba", confidence: "high", detectedName: "Bizerba" when the document is issued by BIZERBA (e.g., Bizerba SE & Co. KG, Bizerba Southern Africa (Pty) Ltd, Balingen, Wilhelm-Kraut-Straße, bizerba.com, bizerba.co.za).

4. "other" (Others Category):
   Classify as supplier: "other", confidence: "high", detectedName: "<Actual Issuing Company Name>" ONLY when the quotation is issued by a third-party supplier company that is NOT MULTIVAC Service und Logistik GmbH & Co. KG, NOT MULTIVAC SOUTHERN AFRICA (Pty) Ltd, NOT Handtmann, and NOT Bizerba. Never return the buyer/customer name as the supplier.

5. "uncertain":
   If the document does not contain sufficient identifying information to determine the supplier confidently, return supplier: "uncertain" and confidence: "low". Never guess.`;

const VALID_DETECTED_SUPPLIERS: DetectedSupplierCategory[] = ['multivac', 'bizerba', 'handtmann', 'other', 'uncertain'];

export async function runSupplierDetection(generate: Generate): Promise<SupplierDetectionResult> {
  const raw = await generate(SUPPLIER_DETECTION_PROMPT, SUPPLIER_DETECTION_SCHEMA);
  const parsed = JSON.parse(raw || '{}');
  let supplier: DetectedSupplierCategory = VALID_DETECTED_SUPPLIERS.includes(parsed?.supplier)
    ? parsed.supplier
    : 'uncertain';
  let detectedName = typeof parsed?.detectedName === 'string' && parsed.detectedName.trim() ? parsed.detectedName.trim() : null;
  const reason = typeof parsed?.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'Analyzed PDF document content.';

  const combinedEvidence = `${detectedName ?? ''} ${reason}`;
  const hasGermanMultivacEvidence =
    /MULTIVAC\s*SERVICE\s*UND\s*LOGISTIK/i.test(combinedEvidence) ||
    /\bSERVICE\s+UND\s+LOGISTIK\s+(?:GMBH|VERWALTUNGS)/i.test(combinedEvidence) ||
    /DE\s*364\s*316\s*979/i.test(combinedEvidence) ||
    /\bHRA\s*13980\b/i.test(combinedEvidence) ||
    /MUWO\s*@\s*MULTIVAC\.DE/i.test(combinedEvidence) ||
    /STEFAN\.KIRCHMANN\s*@\s*MULTIVAC\.DE/i.test(combinedEvidence) ||
    /87787\s*WOLFERTSCHWENDEN/i.test(combinedEvidence) ||
    /\bWOLFERTSCHWENDEN\b/i.test(combinedEvidence) ||
    /GEWERBESTR(?:ASSE|AßE|A.{1,3}E|\.)\s*15\b/i.test(combinedEvidence) ||
    /AMTSGERICHT\s*MEMMINGEN/i.test(combinedEvidence) ||
    /DR\.?\s*CHRISTIAN\s*LAU/i.test(combinedEvidence) ||
    /DR\.?\s*JOHANNES\s*EPPLE/i.test(combinedEvidence) ||
    /\+?\s*49\s*(?:\(\s*0\s*\)|0)?\s*8334\s*601\b/.test(combinedEvidence) ||
    /SEPP\s*HAGGENM/i.test(combinedEvidence);

  const hasSouthAfricanHandtmannEvidence =
    /MULTIVAC\s*SOUTHERN\s*AFRICA/i.test(combinedEvidence) ||
    /\b477\s*021\s*7620\b/.test(combinedEvidence) ||
    /POSTNET\s*SUITE\s*514/i.test(combinedEvidence) ||
    /PRIVATE\s*BAG\s*H\s*607/i.test(combinedEvidence) ||
    /HEIDELBERG\s*,?\s*1438\b/i.test(combinedEvidence) ||
    /(?:\+?\s*27\s*(?:\(\s*0\s*\)|0)?\s*16|\b016)\s*340\s*58(?:00|19)\b/.test(combinedEvidence);

  if (hasGermanMultivacEvidence) {
    supplier = 'multivac';
    detectedName = 'Multivac';
  } else if (hasSouthAfricanHandtmannEvidence) {
    supplier = 'handtmann';
    detectedName = 'Handtmann';
  } else if (supplier === 'other' && detectedName) {
    // Safeguard: if the model classified the document as 'other' but the detected supplier name itself is Multivac, Handtmann, or Bizerba
    if (/bizerba/i.test(detectedName)) {
      supplier = 'bizerba';
      detectedName = 'Bizerba';
    } else if (/handtmann/i.test(detectedName)) {
      supplier = 'handtmann';
      detectedName = 'Handtmann';
    } else if (/multivac/i.test(detectedName)) {
      supplier = 'multivac';
      detectedName = 'Multivac';
    }
  }

  const confidence: 'high' | 'medium' | 'low' =
    supplier === 'uncertain'
      ? 'low'
      : parsed?.confidence === 'high' || parsed?.confidence === 'medium' || parsed?.confidence === 'low'
        ? parsed.confidence
        : 'high';
  return {
    supplier,
    confidence: supplier === 'handtmann' || supplier === 'multivac' || supplier === 'bizerba' ? 'high' : confidence,
    detectedName,
    reason,
  };
}

export async function detectSupplierFromPdf(
  pdfBase64: string,
  apiKey?: string,
  extractedText?: string,
): Promise<SupplierDetectionResult> {
  const local =
    typeof extractedText === 'string'
      ? detectSupplierFromText(extractedText)
      : await detectSupplierFromPdfBytes(Uint8Array.from(Buffer.from(pdfBase64, 'base64')));

  // If deterministic text analysis identified the supplier (Multivac, Bizerba, Handtmann, or Other) with high confidence,
  // return it immediately without making an external API call.
  if (local.supplier !== 'uncertain' && local.confidence === 'high') {
    return local;
  }

  if (!apiKey) {
    return local;
  }

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
    const generate: Generate = async (prompt, schema) => {
      const res = await callGeminiWithRetry(ai, {
        model: 'gemini-3.8-flash',
        contents: [{ parts: [{ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }, { text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      return res.text || '{}';
    };
    const remote = await runSupplierDetection(generate);
    if (remote.supplier !== 'uncertain' && remote.confidence !== 'low') {
      return remote;
    }
    if (local.supplier !== 'uncertain' && local.confidence === 'high') {
      return local;
    }
    return remote;
  } catch (err) {
    if (local.supplier !== 'uncertain') {
      return local;
    }
    throw err;
  }
}



import { detectSupplierFromPdf, extractQuotationFromPdf } from './geminiExtractor.js';
import { SUPPLIERS, type ColumnMap, type ColumnKey, type Supplier } from './quotation.js';

export interface HandlerResult {
  status: number;
  body: unknown;
}

const KEYS: ColumnKey[] = ['reference', 'description', 'price', 'quantity'];

function friendlyError(err: any): string {
  const e = String(err?.message || err);
  if (err?.status === 429 || e.includes('429') || e.includes('quota') || e.includes('RESOURCE_EXHAUSTED')) {
    return 'Gemini API quota exceeded. Please check your API key quota or try again in a moment.';
  }
  if (e.includes('API_KEY_INVALID') || e.includes('API key not valid')) return 'Invalid Gemini API key. Please check your GEMINI_API_KEY configuration.';
  return err?.message || 'Failed to extract quotation data.';
}

/** Shared by the Express server (local) and the Vercel function (deployed). */
export async function handleExtract(body: any, apiKey: string | undefined, noKeyMessage: string): Promise<HandlerResult> {
  const pdfBase64 = body?.pdfBase64;
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return { status: 400, body: { success: false, error: 'Quotation PDF base64 is required in request body.' } };
  }
  const supplier: Supplier = (body?.supplier ?? 'multivac') as Supplier;
  if (!SUPPLIERS.includes(supplier)) return { status: 400, body: { success: false, error: `Unknown supplier "${body?.supplier}".` } };

  let columns: ColumnMap | undefined;
  if (body?.columns && typeof body.columns === 'object') {
    columns = {} as ColumnMap;
    for (const k of KEYS) {
      const v = body.columns[k];
      if (typeof v === 'string' && v.trim()) columns[k] = v.trim().slice(0, 120);
    }
  }
  if (supplier === 'other' && !(columns && KEYS.every((k) => columns![k]))) {
    return { status: 400, body: { success: false, error: 'For Other, all four column headers (Reference, Description, Price, Quantity) are required.' } };
  }
  if (!apiKey) return { status: 500, body: { success: false, error: noKeyMessage } };

  try {
    const result = await extractQuotationFromPdf(pdfBase64, apiKey, { supplier, columns });
    return { status: 200, body: result };
  } catch (err: any) {
    console.error('Extraction error:', err);
    return { status: 500, body: { success: false, error: friendlyError(err) } };
  }
}

export async function handleDetectSupplier(body: any, apiKey: string | undefined): Promise<HandlerResult> {
  const pdfBase64 = body?.pdfBase64;
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return { status: 400, body: { success: false, error: 'Quotation PDF base64 is required in request body.' } };
  }

  try {
    const extractedText = typeof body?.extractedText === 'string' ? body.extractedText : undefined;
    const detection = await detectSupplierFromPdf(pdfBase64, apiKey, extractedText);
    return { status: 200, body: { success: true, detection } };
  } catch (err: any) {
    console.error('Supplier detection error:', err);
    return { status: 500, body: { success: false, error: friendlyError(err) } };
  }
}


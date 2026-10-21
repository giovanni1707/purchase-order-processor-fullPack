import type { Supplier } from './quotation.js';

export type DetectedSupplierCategory = Supplier | 'uncertain';

export interface SupplierDetectionResult {
  supplier: DetectedSupplierCategory;
  confidence: 'high' | 'medium' | 'low';
  /** Display name of the detected supplier company if identified (e.g. "Multivac", "Bizerba", "Handtmann", or the 3rd-party company name) */
  detectedName: string | null;
  /** Short human-readable explanation of the identifying information found */
  reason: string;
}

interface BrandMatch {
  supplier: 'multivac' | 'bizerba' | 'handtmann';
  label: string;
  score: number;
  signals: string[];
}

const MULTIVAC_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bMULTIVAC\s+SEPP\s+HAGGENM/i, weight: 10, label: 'MULTIVAC Sepp Haggenmüller company name' },
  { re: /\bSEPP\s+HAGGENM(?:Ü|UE|U)LLER\b/i, weight: 9, label: 'Sepp Haggenmüller company details' },
  { re: /\bWOLFERTSCHWENDEN\b/i, weight: 8, label: 'Wolfertschwenden headquarters address' },
  { re: /\bMULTIVAC\.(?:COM|DE|CO\.ZA|FR|CO\.UK)\b/i, weight: 9, label: 'multivac domain' },
  { re: /\bMULTIVAC\s+(?:EXPORT|SOUTHERN\s+AFRICA|DEUTSCHLAND|FRANCE|UK)\b/i, weight: 9, label: 'MULTIVAC entity name' },
  { re: /\bMULTIVAC\b/i, weight: 6, label: 'MULTIVAC name/logo text' },
  { re: /\bYOUR\s+QUOTE\s+REQUEST\b[\s\S]{0,400}\bINVOICE\s+AMOUNT\b/i, weight: 5, label: 'Multivac quotation layout' },
];

const BIZERBA_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bBIZERBA\s+(?:SE\s*&\s*CO|GMBH|SOUTHERN\s+AFRICA|\(PTY\)|PTY\s+LTD|INC|S\.A)/i, weight: 10, label: 'Bizerba legal entity name' },
  { re: /\bWILHELM[- ]KRAUT[- ]STR/i, weight: 9, label: 'Bizerba Wilhelm-Kraut-Straße address' },
  { re: /\bBIZERBA\.(?:COM|DE|CO\.ZA|FR|CO\.UK)\b/i, weight: 9, label: 'bizerba domain' },
  { re: /\bBALINGEN\b/i, weight: 5, label: 'Balingen address' },
  { re: /\bBIZERBA\b/i, weight: 6, label: 'BIZERBA name/logo text' },
];

const HANDTMANN_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bALBERT\s+HANDTMANN\b/i, weight: 10, label: 'Albert Handtmann company name' },
  { re: /\bHANDTMANN\s+(?:MASCHINENFABRIK|ARMATURENFABRIK|SERVICE|GMBH|INC)/i, weight: 10, label: 'Handtmann legal entity name' },
  { re: /\bHUBERTUS[- ]LIEBRECHT[- ]STR/i, weight: 9, label: 'Handtmann Hubertus-Liebrecht-Straße address' },
  { re: /\bHANDTMANN\.(?:DE|COM)\b/i, weight: 9, label: 'handtmann domain' },
  { re: /\bBIBERACH\b/i, weight: 5, label: 'Biberach address' },
  { re: /\bHANDTMANN\b/i, weight: 6, label: 'HANDTMANN name/logo text' },
];

const LEGAL_ENTITY_RE =
  /\b([A-Z][A-Za-z0-9&.,' -]{2,60}?\s+(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|\(Pty\)\s*Ltd\.?|Pty\s+Ltd\.?|Ltd\.?|Limited|Inc\.?|Incorporated|Corp\.?|Corporation|S\.A\.?(?:R\.L\.?)?|S\.r\.l\.?|B\.V\.?|N\.V\.?|AG|SE\s*&\s*Co\.?\s*KG|PLC|LLC))\b/g;

const EXPLICIT_SUPPLIER_HEADER_RE = /\b(?:Supplier|Vendor|Issued\s+by|From|Company)\s*:\s*([A-Z][A-Za-z0-9&.,' ()-]{2,60})/i;

const QUOTATION_KEYWORDS_RE =
  /\b(?:Quotation|Quote|Offer|Angebot|Devis|Proforma|Estimate|Order\s+Confirmation|Unit\s+Price|Net\s+Price|Quantity|Qty|Description|Reference|Part\s+No|Item\s+No|Total)\b/gi;

const BUYER_IGNORE_RE = /\b(?:Customer|Bill\s+To|Ship\s+To|Sold\s+To|Deliver\s+To)\b/i;

function scoreBrand(
  text: string,
  supplier: 'multivac' | 'bizerba' | 'handtmann',
  label: string,
  patterns: Array<{ re: RegExp; weight: number; label: string }>,
): BrandMatch {
  let score = 0;
  const signals: string[] = [];
  for (const p of patterns) {
    if (p.re.test(text)) {
      score += p.weight;
      signals.push(p.label);
    }
  }
  return { supplier, label, score, signals };
}

/**
 * Deterministically analyzes extracted PDF text to identify the supplier category.
 * Returns 'uncertain' when the text lacks reliable supplier identification.
 */
export function detectSupplierFromText(rawText: string): SupplierDetectionResult {
  const text = (rawText || '').replace(/\0/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 10) {
    return {
      supplier: 'uncertain',
      confidence: 'low',
      detectedName: null,
      reason: 'No readable supplier text was found in the PDF.',
    };
  }

  const matches: BrandMatch[] = [
    scoreBrand(text, 'multivac', 'Multivac', MULTIVAC_PATTERNS),
    scoreBrand(text, 'bizerba', 'Bizerba', BIZERBA_PATTERNS),
    scoreBrand(text, 'handtmann', 'Handtmann', HANDTMANN_PATTERNS),
  ].sort((a, b) => b.score - a.score);

  const top = matches[0];
  const second = matches[1];

  // If two primary suppliers both have strong scores and are close, treat as uncertain rather than guessing
  if (top.score >= 6 && second.score >= 6 && top.score - second.score < 4) {
    return {
      supplier: 'uncertain',
      confidence: 'low',
      detectedName: null,
      reason: `Multiple supplier names (${top.label} and ${second.label}) appear in the document.`,
    };
  }

  if (top.score >= 6) {
    return {
      supplier: top.supplier,
      confidence: top.score >= 6 ? 'high' : 'medium',
      detectedName: top.label,
      reason: `Identified ${top.label} from document content (${top.signals.slice(0, 2).join(', ')}).`,
    };
  }

  // Check if it is a clearly identifiable third-party ("Others") quotation
  const quoteKeywordMatches = text.match(QUOTATION_KEYWORDS_RE) || [];
  const hasQuoteStructure = quoteKeywordMatches.length >= 2;

  let thirdPartyName: string | null = null;
  const explicitMatch = EXPLICIT_SUPPLIER_HEADER_RE.exec(text);
  if (explicitMatch?.[1]) {
    const candidate = explicitMatch[1].trim();
    if (!/multivac|bizerba|handtmann/i.test(candidate)) {
      thirdPartyName = candidate;
    }
  }

  if (!thirdPartyName) {
    let m: RegExpExecArray | null;
    LEGAL_ENTITY_RE.lastIndex = 0;
    while ((m = LEGAL_ENTITY_RE.exec(text)) !== null) {
      const candidate = m[1].trim();
      if (/multivac|bizerba|handtmann/i.test(candidate)) continue;
      if (BUYER_IGNORE_RE.test(candidate)) continue;
      if (/^(?:Page|Item|Total|Net\s+Price|Unit\s+Price|Quantity|Description)\b/i.test(candidate)) continue;
      thirdPartyName = candidate;
      break;
    }
  }

  if (thirdPartyName && hasQuoteStructure) {
    return {
      supplier: 'other',
      confidence: 'high',
      detectedName: thirdPartyName,
      reason: `Identified third-party supplier "${thirdPartyName}" from the quotation document.`,
    };
  }

  return {
    supplier: 'uncertain',
    confidence: 'low',
    detectedName: null,
    reason: 'Could not confidently identify the supplier from the PDF text.',
  };
}

// ------------------------------------------------ PDF byte stream text extractor

function decodePdfLiteralString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next >= '0' && next <= '7') {
        let oct = next;
        if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
        if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else {
        out += next;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function decodePdfHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length < 2) return '';
  if (clean.toUpperCase().startsWith('FEFF')) {
    let out = '';
    for (let i = 4; i + 3 < clean.length; i += 4) {
      const code = parseInt(clean.slice(i, i + 4), 16);
      if (code >= 32 && code <= 0xd7ff) out += String.fromCharCode(code);
    }
    return out;
  }
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32 && code <= 126) out += String.fromCharCode(code);
  }
  return out;
}

function extractStringsFromStreamContent(content: string): string {
  const chunks: string[] = [];

  // 1. Literal strings (...)
  const litRe = /\((?:\\.|[^\\()])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = litRe.exec(content)) !== null) {
    const inner = m[0].slice(1, -1);
    const decoded = decodePdfLiteralString(inner).trim();
    if (decoded.length >= 2) chunks.push(decoded);
  }

  // 2. Hex strings <...>
  const hexRe = /<([0-9A-Fa-f\s]{4,})>/g;
  while ((m = hexRe.exec(content)) !== null) {
    const decoded = decodePdfHexString(m[1]).trim();
    if (decoded.length >= 2) chunks.push(decoded);
  }

  return chunks.join(' ');
}

async function tryInflate(data: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      writer.write(data as unknown as BufferSource).catch(() => {});
      writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          parts.push(value);
          total += value.byteLength;
          if (total > 1_000_000) break;
        }
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        merged.set(p, offset);
        offset += p.byteLength;
      }
      return new TextDecoder('latin1').decode(merged);
    } catch {
      // try next format
    }
  }
  return null;
}

/**
 * Extracts readable text from a PDF byte buffer (uncompressed text + FlateDecode streams)
 * and runs deterministic supplier detection on it.
 */
export async function extractTextFromPdfBytes(bytes: Uint8Array): Promise<string> {
  const rawLatin1 = new TextDecoder('latin1').decode(bytes);
  const parts: string[] = [];

  // Extract strings from uncompressed PDF content
  parts.push(extractStringsFromStreamContent(rawLatin1));

  // Also capture plain readable ASCII text when a test/simple PDF stores plain text directly
  const plainText = rawLatin1
    .replace(/stream[\s\S]*?endstream/g, ' ')
    .replace(/[^\x20-\x7E\xC0-\xFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plainText) parts.push(plainText);

  // Decompress up to 15 FlateDecode streams to inspect embedded page text
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = streamRe.exec(rawLatin1)) !== null && count < 15) {
    const body = match[1];
    if (body.length < 4 || body.length > 500_000) continue;
    count++;
    const streamBytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) streamBytes[i] = body.charCodeAt(i) & 0xff;
    const inflated = await tryInflate(streamBytes);
    if (inflated) {
      const extracted = extractStringsFromStreamContent(inflated);
      if (extracted) parts.push(extracted);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export async function detectSupplierFromPdfBytes(bytes: Uint8Array): Promise<SupplierDetectionResult> {
  const text = await extractTextFromPdfBytes(bytes);
  return detectSupplierFromText(text);
}

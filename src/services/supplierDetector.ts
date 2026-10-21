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
  { re: /\bMULTIVAC\s+SERVICE\s+UND\s+LOGISTIK\s+GMBH(?:\s*&\s*CO\.?\s*KG)?\b/i, weight: 20, label: 'MULTIVAC Service und Logistik GmbH & Co. KG' },
  { re: /\bMULTIVAC\s+SERVICE\s+UND\s+LOGISTIK\s+VERWALTUNGS\s+GMBH\b/i, weight: 16, label: 'MULTIVAC Service und Logistik Verwaltungs GmbH' },
  { re: /\bMULTIVAC\s+SEPP\s+HAGGENM/i, weight: 16, label: 'MULTIVAC Sepp Haggenmüller company name' },
  { re: /\bSEPP\s+HAGGENM(?:Ü|UE|U)LLER\b/i, weight: 12, label: 'Sepp Haggenmüller company details' },
  { re: /\bDE\s*364\s*316\s*979\b/i, weight: 20, label: 'MULTIVAC VAT ID DE 364316979' },
  { re: /\bGEWERBESTR(?:ASSE|AßE|\.)\s*15\b/i, weight: 15, label: 'Gewerbestraße 15 address' },
  { re: /\b87787\s+WOLFERTSCHWENDEN\b/i, weight: 15, label: '87787 Wolfertschwenden address' },
  { re: /\bWOLFERTSCHWENDEN\b/i, weight: 10, label: 'Wolfertschwenden headquarters address' },
  { re: /\+?\s*49\s*(?:\(0\)|0)?\s*8334\s*601\s*[-–]?\s*0\b/, weight: 14, label: 'Telephone +49 (0) 8334 601-0' },
  { re: /\+?\s*49\s*(?:\(0\)|0)?\s*8334\s*601\s*[-–]?\s*199\b/, weight: 14, label: 'Fax +49 (0) 8334 601-199' },
  { re: /\bMUWO@MULTIVAC\.DE\b/i, weight: 18, label: 'Email muwo@multivac.de' },
  { re: /\bSTEFAN\.KIRCHMANN@MULTIVAC\.DE\b/i, weight: 16, label: 'Contact email stefan.kirchmann@multivac.de' },
  { re: /\b[A-Z0-9._%+-]+@MULTIVAC\.DE\b/i, weight: 10, label: 'multivac.de email' },
  { re: /\bAMTSGERICHT\s+MEMMINGEN\b/i, weight: 14, label: 'Amtsgericht Memmingen commercial register' },
  { re: /\bHRA\s*13980\b/i, weight: 15, label: 'Commercial register HRA 13980' },
  { re: /\bDR\.?\s+CHRISTIAN\s+LAU\b/i, weight: 14, label: 'Managing director Dr. Christian Lau' },
  { re: /\bDR\.?\s+JOHANNES\s+EPPLE\b/i, weight: 14, label: 'Managing director Dr. Johannes Epple' },
  { re: /\bYOUR\s+QUOTE\s+REQUEST\b/i, weight: 5, label: 'Multivac quote request header' },
  { re: /\bPOS\.?\s*10\b[\s\S]{0,800}\bINVOICE\s+AMOUNT\b/i, weight: 8, label: 'Multivac Pos. 10 / Invoice amount layout' },
  { re: /\bLIST\s+PRICE\b[\s\S]{0,600}\bINVOICE\s+AMOUNT\b/i, weight: 6, label: 'Multivac List price / Invoice amount layout' },
  { re: /\bWWW\.MULTIVAC\.COM\b/i, weight: 3, label: 'www.multivac.com website' },
];

const BIZERBA_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bBIZERBA\s+(?:SE\s*&\s*CO|GMBH|SOUTHERN\s+AFRICA|SOUTH\s+AFRICA|\(PTY\)|PTY\s+LTD|INC|S\.A|LTD|LIMITED)/i, weight: 15, label: 'Bizerba legal entity name' },
  { re: /\bWILHELM[- ]KRAUT[- ]STR/i, weight: 12, label: 'Bizerba Wilhelm-Kraut-Straße address' },
  { re: /\bBIZERBA\.(?:COM|DE|CO\.ZA|FR|CO\.UK)\b/i, weight: 14, label: 'bizerba domain' },
  { re: /\bBALINGEN\b/i, weight: 6, label: 'Balingen address' },
  { re: /\bBIZERBA\b/i, weight: 12, label: 'BIZERBA name/logo text' },
  { re: /\bB\s+I\s+Z\s+E\s+R\s+B\s+A\b/i, weight: 12, label: 'BIZERBA spaced header text' },
];

const HANDTMANN_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  // Primary Handtmann issuer in Southern Africa: MULTIVAC SOUTHERN AFRICA (Pty) Ltd & its company details
  { re: /\bMULTIVAC\s+SOUTHERN\s+AFRICA(?:\s*\(PTY\)\s*LTD\.?|\s+PTY\s+LTD\.?)?\b/i, weight: 20, label: 'MULTIVAC SOUTHERN AFRICA (Pty) Ltd' },
  { re: /\b477\s*021\s*7620\b/, weight: 20, label: 'VAT Registration Number 4770217620' },
  { re: /\bPOSTNET\s+SUITE\s+514\b/i, weight: 15, label: 'PostNet Suite 514 postal address' },
  { re: /\bPRIVATE\s+BAG\s+H\s*607\b/i, weight: 15, label: 'Private Bag H607 postal address' },
  { re: /\bHEIDELBERG\s*,?\s*1438\b/i, weight: 14, label: 'Heidelberg, 1438 postal address' },
  { re: /(?:\+?\s*27\s*(?:\(0\)|0)?\s*16|\b016)\s*340\s*5800\b/, weight: 15, label: 'Telephone +27 (0) 16 340 5800' },
  { re: /(?:\+?\s*27\s*(?:\(0\)|0)?\s*16|\b016)\s*340\s*5819\b/, weight: 15, label: 'Fax +27 (0) 16 340 5819' },
  // Direct Handtmann identifiers
  { re: /\bALBERT\s+HANDTMANN\b/i, weight: 16, label: 'Albert Handtmann company name' },
  { re: /\bHANDTMANN\s+(?:MASCHINENFABRIK|ARMATURENFABRIK|SERVICE|GMBH|INC|SOUTHERN\s+AFRICA|SOUTH\s+AFRICA|\(PTY\)|PTY\s+LTD|LTD|LIMITED|PROCESS|PROCESSING|SOLUTIONS|AG|S\.A)/i, weight: 16, label: 'Handtmann legal entity name' },
  { re: /\bHUBERTUS[- ]LIEBRECHT[- ]STR/i, weight: 12, label: 'Handtmann Hubertus-Liebrecht-Straße address' },
  { re: /\bHANDTMANN\.(?:DE|COM|CO\.ZA|CO\.UK|FR|AT|CH|NL|IT|ES)\b/i, weight: 14, label: 'handtmann domain' },
  { re: /\bBIBERACH\b/i, weight: 7, label: 'Biberach address' },
  { re: /\bHANDTMANN\b/i, weight: 12, label: 'HANDTMANN name/logo text' },
  { re: /\bH\s+A\s+N\s+D\s+T\s+M\s+A\s+N\s+N\b/i, weight: 12, label: 'HANDTMANN spaced header text' },
  { re: /\b(?:VF\s*(?:600|608|610|612|616|620|622|628|630|800|818|820|828|830|838|840|842)|PVLH\s*\d+|HVF\s*\d+|AL[- ]SYSTEM)\b/i, weight: 8, label: 'Handtmann machine model reference' },
];

const LEGAL_ENTITY_RE =
  /\b([A-Z][A-Za-z0-9&.,' -]{2,60}?\s+(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|\(Pty\)\s*Ltd\.?|Pty\s+Ltd\.?|Ltd\.?|Limited|Inc\.?|Incorporated|Corp\.?|Corporation|S\.A\.?(?:R\.L\.?)?|S\.r\.l\.?|B\.V\.?|N\.V\.?|AG|SE\s*&\s*Co\.?\s*KG|PLC|LLC))\b/g;

const EXPLICIT_SUPPLIER_HEADER_RE = /\b(?:Supplier|Vendor|Issued\s+by|From|Company)\s*:\s*([A-Z][A-Za-z0-9&.,' ()-]{2,60})/i;

const QUOTATION_KEYWORDS_RE =
  /\b(?:Quotation|Quote|Offer|Angebot|Devis|Proforma|Estimate|Order\s+Confirmation|Unit\s+Price|Net\s+Price|Quantity|Qty|Description|Reference|Code|Part\s+No|Item\s+No|Total)\b/gi;

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

function findThirdPartyEntity(text: string): string | null {
  const explicitMatch = EXPLICIT_SUPPLIER_HEADER_RE.exec(text);
  if (explicitMatch?.[1]) {
    const candidate = explicitMatch[1].trim();
    if (!/multivac|bizerba|handtmann/i.test(candidate)) {
      return candidate;
    }
  }

  let m: RegExpExecArray | null;
  LEGAL_ENTITY_RE.lastIndex = 0;
  while ((m = LEGAL_ENTITY_RE.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (/multivac|bizerba|handtmann/i.test(candidate)) continue;
    if (BUYER_IGNORE_RE.test(candidate)) continue;
    if (/^(?:Page|Item|Code|Total|Net\s+Price|Unit\s+Price|Quantity|Description)\b/i.test(candidate)) continue;
    return candidate;
  }
  return null;
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

  const multivac = scoreBrand(text, 'multivac', 'Multivac', MULTIVAC_PATTERNS);
  const bizerba = scoreBrand(text, 'bizerba', 'Bizerba', BIZERBA_PATTERNS);
  const handtmann = scoreBrand(text, 'handtmann', 'Handtmann', HANDTMANN_PATTERNS);

  const thirdPartyName = findThirdPartyEntity(text);

  // Check supplier-specific table column header signatures:
  // Handtmann uses: Code | Description | Quantity | Net Price
  const hasHandtmannColumns =
    /\bCode\b/i.test(text) &&
    /\bDescription\b/i.test(text) &&
    /\bQuantity\b/i.test(text) &&
    /\bNet\s+Price\b/i.test(text) &&
    bizerba.score === 0 &&
    multivac.score < 10;

  if (hasHandtmannColumns) {
    handtmann.score += 12;
    handtmann.signals.push('Handtmann quotation columns (Code, Description, Quantity, Net Price)');
  }

  // Bizerba uses: Item | Description | Qty | Net Price
  const hasBizerbaColumns =
    /\bItem\b/i.test(text) &&
    /\bDescription\b/i.test(text) &&
    /\bQty\b/i.test(text) &&
    /\bNet\s+Price\b/i.test(text) &&
    handtmann.score === 0 &&
    !thirdPartyName;

  if (hasBizerbaColumns) {
    bizerba.score += 10;
    bizerba.signals.push('Bizerba quotation columns (Item, Description, Qty, Net Price)');
  }

  // Priority 1: Explicit Bizerba identification (in case MULTIVAC SOUTHERN AFRICA is the customer on a Bizerba quote)
  const hasExplicitBizerbaBrand = /\bBIZERBA\b/i.test(text) || /\bB\s+I\s+Z\s+E\s+R\s+B\s+A\b/i.test(text);
  const hasExplicitHandtmannBrand =
    /\bHANDTMANN\b/i.test(text) ||
    /\bH\s+A\s+N\s+D\s+T\s+M\s+A\s+N\s+N\b/i.test(text) ||
    /\b477\s*021\s*7620\b/.test(text) ||
    /\bPOSTNET\s+SUITE\s+514\b/i.test(text) ||
    /\bPRIVATE\s+BAG\s+H\s*607\b/i.test(text);

  if (hasExplicitBizerbaBrand && !hasExplicitHandtmannBrand && bizerba.score >= 10) {
    return {
      supplier: 'bizerba',
      confidence: 'high',
      detectedName: 'Bizerba',
      reason: `Identified Bizerba from document content (${bizerba.signals.slice(0, 2).join(', ')}).`,
    };
  }

  // Priority 2: Handtmann (including MULTIVAC SOUTHERN AFRICA (Pty) Ltd, VAT 4770217620, Heidelberg address, or Handtmann brand/columns)
  if (handtmann.score >= 10 && handtmann.score >= multivac.score) {
    return {
      supplier: 'handtmann',
      confidence: 'high',
      detectedName: 'Handtmann',
      reason: `Identified Handtmann from company details (${handtmann.signals.slice(0, 2).join(', ')}).`,
    };
  }

  // Priority 3: MULTIVAC (MULTIVAC Service und Logistik GmbH & Co. KG, Wolfertschwenden, DE 364316979, HRA 13980, etc.)
  if (multivac.score >= 10 && handtmann.score < 10 && bizerba.score < 10 && !thirdPartyName) {
    return {
      supplier: 'multivac',
      confidence: 'high',
      detectedName: 'Multivac',
      reason: `Identified Multivac from company details (${multivac.signals.slice(0, 2).join(', ')}).`,
    };
  }

  if (bizerba.score >= 10) {
    return {
      supplier: 'bizerba',
      confidence: 'high',
      detectedName: 'Bizerba',
      reason: `Identified Bizerba from document content (${bizerba.signals.slice(0, 2).join(', ')}).`,
    };
  }

  if (handtmann.score >= 6) {
    return {
      supplier: 'handtmann',
      confidence: 'high',
      detectedName: 'Handtmann',
      reason: `Identified Handtmann from document content (${handtmann.signals.slice(0, 2).join(', ')}).`,
    };
  }

  // Priority 3: Clearly identifiable third-party ("Others") quotation
  const quoteKeywordMatches = text.match(QUOTATION_KEYWORDS_RE) || [];
  const hasQuoteStructure = quoteKeywordMatches.length >= 2;

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

function decodePdfLiteralString(raw: string, cmap?: Map<number, string>): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      if (next === 'n') bytes.push(10);
      else if (next === 'r') bytes.push(13);
      else if (next === 't') bytes.push(9);
      else if (next === '\n' || next === '\r') {
        if (next === '\r' && raw[i + 1] === '\n') i++;
      } else if (next >= '0' && next <= '7') {
        let oct = next;
        if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
        if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
        bytes.push(parseInt(oct, 8) & 0xff);
      } else {
        bytes.push(next.charCodeAt(0) & 0xff);
      }
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }

  let asciiOut = '';
  for (const b of bytes) {
    if ((b >= 32 && b <= 126) || (b >= 160 && b <= 255) || b === 9 || b === 10 || b === 13) {
      asciiOut += String.fromCharCode(b);
    }
  }

  if (cmap && cmap.size > 0 && bytes.length >= 2 && bytes.length % 2 === 0) {
    let cmapOut = '';
    let mappedCount = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const cid = (bytes[i] << 8) | bytes[i + 1];
      const mapped = cmap.get(cid);
      if (mapped) {
        cmapOut += mapped;
        mappedCount++;
      }
    }
    if (mappedCount > 0 && cmapOut.length >= asciiOut.replace(/\s+/g, '').length) {
      return asciiOut ? `${asciiOut} ${cmapOut}` : cmapOut;
    }
  }

  return asciiOut;
}

function decodePdfHexString(hex: string, cmap?: Map<number, string>): string {
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

  let asciiOut = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      asciiOut += String.fromCharCode(code);
    }
  }

  if (cmap && cmap.size > 0) {
    let cmapOut2 = '';
    if (clean.length % 4 === 0) {
      for (let i = 0; i + 3 < clean.length; i += 4) {
        const cid = parseInt(clean.slice(i, i + 4), 16);
        const mapped = cmap.get(cid);
        if (mapped) cmapOut2 += mapped;
      }
    }
    let cmapOut1 = '';
    for (let i = 0; i + 1 < clean.length; i += 2) {
      const cid = parseInt(clean.slice(i, i + 2), 16);
      const mapped = cmap.get(cid);
      if (mapped) cmapOut1 += mapped;
    }
    const extra = [cmapOut2, cmapOut1].filter(Boolean).join(' ');
    if (extra) return asciiOut ? `${asciiOut} ${extra}` : extra;
  }

  return asciiOut;
}

function decodeHexToUnicode(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  if (!clean) return '';
  if (clean.length <= 4) {
    const code = parseInt(clean, 16);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
  }
  let out = '';
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const code = parseInt(clean.slice(i, i + 4), 16);
    if (Number.isFinite(code) && code > 0) out += String.fromCodePoint(code);
  }
  return out;
}

function parseToUnicodeCMap(content: string, cmap: Map<number, string>): void {
  if (!content.includes('beginbfchar') && !content.includes('beginbfrange')) return;

  const charBlockRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = charBlockRe.exec(content)) !== null) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(block[1])) !== null) {
      const src = parseInt(m[1], 16);
      const dst = decodeHexToUnicode(m[2]);
      if (Number.isFinite(src) && dst) cmap.set(src, dst);
    }
  }

  const rangeBlockRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeBlockRe.exec(content)) !== null) {
    const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = rangeRe.exec(block[1])) !== null) {
      const start = parseInt(m[1], 16);
      const end = parseInt(m[2], 16);
      const baseCode = parseInt(m[3], 16);
      if (Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(baseCode) && end >= start && end - start <= 512) {
        for (let cid = start; cid <= end; cid++) {
          const cp = baseCode + (cid - start);
          if (cp > 0 && cp <= 0x10ffff) cmap.set(cid, String.fromCodePoint(cp));
        }
      }
    }
  }
}

function extractLiteralStringsWithBalancedParens(content: string, cmap?: Map<number, string>): string[] {
  const results: string[] = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    if (content[i] !== '(') {
      i++;
      continue;
    }
    let depth = 1;
    i++;
    const start = i;
    while (i < n && depth > 0) {
      const ch = content[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth === 0) {
      const inner = content.slice(start, i - 1);
      const decoded = decodePdfLiteralString(inner, cmap);
      if (decoded.length >= 1) results.push(decoded);
    }
  }
  return results;
}

function extractStringsFromStreamContent(content: string, cmap?: Map<number, string>): string {
  const chunks: string[] = [];

  // 1. Reconstruct words across kerning arrays: [(H) -15 (andtmann)] TJ or [<0048> -10 <0061...>] TJ
  const tjArrayRe = /\[([^\[\]]{1,8000})\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = tjArrayRe.exec(content)) !== null) {
    const inner = m[1];
    let line = '';
    let idx = 0;
    while (idx < inner.length) {
      const ch = inner[idx];
      if (ch === '(') {
        let depth = 1;
        idx++;
        const start = idx;
        while (idx < inner.length && depth > 0) {
          if (inner[idx] === '\\') {
            idx += 2;
            continue;
          }
          if (inner[idx] === '(') depth++;
          else if (inner[idx] === ')') depth--;
          idx++;
        }
        line += decodePdfLiteralString(inner.slice(start, Math.max(start, idx - 1)), cmap);
      } else if (ch === '<') {
        const end = inner.indexOf('>', idx + 1);
        if (end === -1) break;
        line += decodePdfHexString(inner.slice(idx + 1, end), cmap);
        idx = end + 1;
      } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
        const numMatch = /^-?\d+(?:\.\d+)?/.exec(inner.slice(idx));
        if (numMatch) {
          const kern = parseFloat(numMatch[0]);
          if (kern < -120) line += ' ';
          idx += numMatch[0].length;
        } else {
          idx++;
        }
      } else {
        idx++;
      }
    }
    const trimmed = line.trim();
    if (trimmed.length >= 1) chunks.push(trimmed);
  }

  // 2. Literal strings (...) with full support for nested balanced parentheses like "(Company (Pty) Ltd)"
  const litTokens = extractLiteralStringsWithBalancedParens(content, cmap);
  if (litTokens.length > 0) {
    chunks.push(litTokens.join(''));
    chunks.push(litTokens.join(' '));
  }

  // 3. Hex strings <...>
  const hexRe = /<([0-9A-Fa-f\s]{2,})>/g;
  const hexTokens: string[] = [];
  while ((m = hexRe.exec(content)) !== null) {
    const decoded = decodePdfHexString(m[1], cmap).trim();
    if (decoded.length >= 1) hexTokens.push(decoded);
  }
  if (hexTokens.length > 0) {
    chunks.push(hexTokens.join(''));
    chunks.push(hexTokens.join(' '));
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
 * Extracts readable text from a PDF byte buffer (uncompressed text + FlateDecode streams + ToUnicode CMaps)
 * and runs deterministic supplier detection on it.
 */
export async function extractTextFromPdfBytes(bytes: Uint8Array): Promise<string> {
  const rawLatin1 = new TextDecoder('latin1').decode(bytes);
  const parts: string[] = [];
  const cmap = new Map<number, string>();

  parseToUnicodeCMap(rawLatin1, cmap);

  // Decompress up to 80 FlateDecode streams; first pass collects ToUnicode CMaps, second extracts text
  const inflatedStreams: string[] = [];
  const streamRe = /stream(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)?endstream/g;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = streamRe.exec(rawLatin1)) !== null && count < 80) {
    const body = match[1];
    if (body.length < 4 || body.length > 750_000) continue;
    count++;
    const streamBytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) streamBytes[i] = body.charCodeAt(i) & 0xff;
    const inflated = await tryInflate(streamBytes);
    if (inflated) {
      parseToUnicodeCMap(inflated, cmap);
      inflatedStreams.push(inflated);
    }
  }

  // Extract strings from uncompressed PDF content
  parts.push(extractStringsFromStreamContent(rawLatin1, cmap));

  // Also capture plain readable ASCII text when a test/simple PDF stores plain text directly
  const plainText = rawLatin1
    .replace(/stream[\s\S]*?endstream/g, ' ')
    .replace(/[^\x20-\x7E\xC0-\xFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plainText) parts.push(plainText);

  for (const inflated of inflatedStreams) {
    const extracted = extractStringsFromStreamContent(inflated, cmap);
    if (extracted) parts.push(extracted);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export async function detectSupplierFromPdfBytes(bytes: Uint8Array): Promise<SupplierDetectionResult> {
  const text = await extractTextFromPdfBytes(bytes);
  return detectSupplierFromText(text);
}


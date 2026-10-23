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
  { re: /MULTIVAC\s*SERVICE\s*UND\s*LOGISTIK\s*GMBH(?:\s*&\s*CO\.?\s*KG)?/i, weight: 25, label: 'MULTIVAC Service und Logistik GmbH & Co. KG' },
  { re: /\bSERVICE\s+UND\s+LOGISTIK\s+GMBH\s*&\s*CO\.?\s*KG\b/i, weight: 20, label: 'Service und Logistik GmbH & Co. KG' },
  { re: /MULTIVAC\s*SERVICE\s*UND\s*LOGISTIK\s*VERWALTUNGS\s*GMBH/i, weight: 22, label: 'MULTIVAC Service und Logistik Verwaltungs GmbH' },
  { re: /\bSERVICE\s+UND\s+LOGISTIK\s+VERWALTUNGS\s+GMBH\b/i, weight: 18, label: 'Service und Logistik Verwaltungs GmbH' },
  { re: /MULTIVAC\s*SEPP\s*HAGGENM/i, weight: 18, label: 'MULTIVAC Sepp Haggenmüller company name' },
  { re: /SEPP\s*HAGGENM(?:Ü|UE|U|\S{1,2})LLER/i, weight: 14, label: 'Sepp Haggenmüller company details' },
  { re: /DE\s*364\s*316\s*979/i, weight: 25, label: 'MULTIVAC VAT ID DE 364316979' },
  { re: /GEWERBESTR(?:ASSE|AßE|A.{1,3}E|\.)\s*15\b/i, weight: 16, label: 'Gewerbestraße 15 address' },
  { re: /87787\s*WOLFERTSCHWENDEN/i, weight: 18, label: '87787 Wolfertschwenden address' },
  { re: /WOLFERTSCHWENDEN/i, weight: 14, label: 'Wolfertschwenden headquarters address' },
  { re: /\+?\s*49\s*(?:\(\s*0\s*\)|0)?\s*8334\s*601\s*[-–]?\s*0\b/, weight: 16, label: 'Telephone +49 (0) 8334 601-0' },
  { re: /\+?\s*49\s*(?:\(\s*0\s*\)|0)?\s*8334\s*601\s*[-–]?\s*199\b/, weight: 16, label: 'Fax +49 (0) 8334 601-199' },
  { re: /\+?\s*49\s*(?:\(\s*0\s*\)|0)?\s*8334\s*601\b/, weight: 12, label: 'Telephone prefix +49 (0) 8334 601' },
  { re: /MUWO\s*@\s*MULTIVAC\.DE/i, weight: 22, label: 'Email muwo@multivac.de' },
  { re: /STEFAN\.KIRCHMANN\s*@\s*MULTIVAC\.DE/i, weight: 20, label: 'Contact email stefan.kirchmann@multivac.de' },
  { re: /[A-Z0-9._%+-]+\s*@\s*MULTIVAC\.DE\b/i, weight: 14, label: 'multivac.de email' },
  { re: /AMTSGERICHT\s*MEMMINGEN/i, weight: 16, label: 'Amtsgericht Memmingen commercial register' },
  { re: /\bHRA\s*13980\b/i, weight: 18, label: 'Commercial register HRA 13980' },
  { re: /DR\.?\s*CHRISTIAN\s*LAU/i, weight: 16, label: 'Managing director Dr. Christian Lau' },
  { re: /DR\.?\s*JOHANNES\s*EPPLE/i, weight: 16, label: 'Managing director Dr. Johannes Epple' },
  { re: /\bYOUR\s+QUOTE\s+REQUEST\b/i, weight: 6, label: 'Multivac quote request header' },
  { re: /\bPOS\.?\s*10\b[\s\S]{0,800}\bINVOICE\s+AMOUNT\b/i, weight: 10, label: 'Multivac Pos. 10 / Invoice amount layout' },
  { re: /\bLIST\s+PRICE\b[\s\S]{0,600}\bINVOICE\s+AMOUNT\b/i, weight: 10, label: 'Multivac List price / Invoice amount layout' },
  { re: /WWW\.MULTIVAC\.COM/i, weight: 3, label: 'www.multivac.com website' },
];

const BIZERBA_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /BIZERBA\s*(?:SE\s*&\s*CO|GMBH|SOUTHERN\s*AFRICA|SOUTH\s*AFRICA|\(PTY\)|PTY\s*LTD|INC|S\.A|LTD|LIMITED)/i, weight: 18, label: 'Bizerba legal entity name' },
  { re: /WILHELM[- ]*KRAUT[- ]*STR/i, weight: 15, label: 'Bizerba Wilhelm-Kraut-Straße address' },
  { re: /BIZERBA\.(?:COM|DE|CO\.ZA|FR|CO\.UK)/i, weight: 16, label: 'bizerba domain' },
  { re: /72336\s*BALINGEN/i, weight: 14, label: '72336 Balingen address' },
  { re: /\bBALINGEN\b/i, weight: 8, label: 'Balingen address' },
  { re: /BIZERBA/i, weight: 12, label: 'BIZERBA name/logo text' },
  { re: /\bB\s+I\s+Z\s+E\s+R\s+B\s+A\b/i, weight: 12, label: 'BIZERBA spaced header text' },
];

const HANDTMANN_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  // Primary Handtmann issuer in Southern Africa: MULTIVAC SOUTHERN AFRICA (Pty) Ltd & its company details
  { re: /MULTIVAC\s*SOUTHERN\s*AFRICA(?:\s*\(PTY\)\s*LTD\.?|\s+PTY\s+LTD\.?)?/i, weight: 22, label: 'MULTIVAC SOUTHERN AFRICA (Pty) Ltd' },
  { re: /477\s*021\s*7620/, weight: 22, label: 'VAT Registration Number 4770217620' },
  { re: /POSTNET\s*SUITE\s*514/i, weight: 16, label: 'PostNet Suite 514 postal address' },
  { re: /PRIVATE\s*BAG\s*H\s*607/i, weight: 16, label: 'Private Bag H607 postal address' },
  { re: /HEIDELBERG\s*,?\s*1438/i, weight: 15, label: 'Heidelberg, 1438 postal address' },
  { re: /(?:\+?\s*27\s*(?:\(\s*0\s*\)|0)?\s*16|\b016)\s*340\s*5800/, weight: 16, label: 'Telephone +27 (0) 16 340 5800' },
  { re: /(?:\+?\s*27\s*(?:\(\s*0\s*\)|0)?\s*16|\b016)\s*340\s*5819/, weight: 16, label: 'Fax +27 (0) 16 340 5819' },
  // Direct Handtmann identifiers
  { re: /ALBERT\s*HANDTMANN/i, weight: 18, label: 'Albert Handtmann company name' },
  { re: /HANDTMANN\s*(?:MASCHINENFABRIK|ARMATURENFABRIK|SERVICE|GMBH|INC|SOUTHERN\s*AFRICA|SOUTH\s*AFRICA|\(PTY\)|PTY\s*LTD|LTD|LIMITED|PROCESS|PROCESSING|SOLUTIONS|AG|S\.A)/i, weight: 18, label: 'Handtmann legal entity name' },
  { re: /HUBERTUS[- ]*LIEBRECHT[- ]*STR/i, weight: 14, label: 'Handtmann Hubertus-Liebrecht-Straße address' },
  { re: /HANDTMANN\.(?:DE|COM|CO\.ZA|CO\.UK|FR|AT|CH|NL|IT|ES)/i, weight: 16, label: 'handtmann domain' },
  { re: /88400\s*BIBERACH/i, weight: 14, label: '88400 Biberach address' },
  { re: /\bBIBERACH\b/i, weight: 8, label: 'Biberach address' },
  { re: /HANDTMANN/i, weight: 14, label: 'HANDTMANN name/logo text' },
  { re: /\bH\s+A\s+N\s+D\s+T\s+M\s+A\s+N\s+N\b/i, weight: 14, label: 'HANDTMANN spaced header text' },
  { re: /\b(?:VF\s*(?:600|608|610|612|616|620|622|628|630|800|818|820|828|830|838|840|842)|PVLH\s*\d+|HVF\s*\d+|AL[- ]SYSTEM)\b/i, weight: 8, label: 'Handtmann machine model reference' },
];

const LEGAL_ENTITY_RE =
  /\b([A-Z][A-Za-z0-9&.'’-]*(?:\s+[A-Za-z0-9&.,'’()-]+){0,5}\s+(?:GmbH(?:\s*&\s*Co\.?\s*(?:KG|OHG))?|\(Pty\)\s*Ltd\.?|Pty\s+Ltd\.?|Ltd\.?|Limited|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?\s*,\s*Ltd\.?|S\.A\.?(?:R\.L\.?|S\.?)?|S\.r\.l\.?|S\.p\.A\.?|S\.L\.?|B\.V\.?|N\.V\.?|AG|SE(?:\s*&\s*Co\.?\s*KG)?|PLC|LLC|LLP|Kft\.?|Sp\.\s*z\s*o\.o\.?|ApS|A\/S|AB|Oy))(?=$|[\s,.;:)!\]])/gi;

const EXPLICIT_SUPPLIER_HEADER_RE = /\b(?:Supplier|Vendor|Issued\s+by|Seller)\s*:\s*([A-Z][A-Za-z0-9&.,' ()-]{2,60})/i;

const QUOTATION_KEYWORDS_RE =
  /\b(?:Quotation|Quote|Offer|Angebot|Devis|Proforma|Estimate|Invoice|Order|Proposal|Tender|RFQ|Price|Preis|Prix|Amount|Betrag|Montant|Subtotal|Sub-Total|Total|Summe|Quantity|Qty|Menge|Description|Bezeichnung|Designation|Reference|Ref|Code|Part|Item|Pos|Position|Article|Artikel|Material|Unit|Net|Gross|VAT|Tax|MwSt|TVA|Discount|Rabatt|Delivery|Payment|Terms|Currency|EUR|ZAR|USD|GBP|CHF|MUR)\b/gi;

const BUYER_IGNORE_RE = /\b(?:Customer|Client|Bill\s+To|Ship\s+To|Sold\s+To|Deliver\s+To|Delivery\s+To|Recipient|Buyer|Consignee)\b/i;

const PRECEDING_NON_SUPPLIER_LABEL_RE =
  /(?:Customer|Client|Bill\s+To|Ship\s+To|Sold\s+To|Deliver\s+To|Delivery\s+To|Recipient|Buyer|Consignee|Producer|Creator|Author|Bank)\s*:?\s*$/i;

const LEADING_HEADER_NOISE_RE =
  /^(?:(?:Quotation|Quote|Offer|Angebot|Devis|Proforma|Estimate|Invoice|Order|Page|Date|Datum|Document|Doc|Number|No\.?|Ref\.?|Reference|Item|Code|Total|Net|Unit|Price|Quantity|Qty|Description|Pos\.?|Currency|Tel\.?|Telephone|Phone|Fax|Email|E-Mail|VAT|Tax|Reg\.?|From|Issued\s+by|Supplier|Vendor|Seller|To|M\/s|[A-Z0-9]*\d[A-Z0-9#:/.-]*|[#:/.-]+)\s+)+/i;

const NON_SUPPLIER_ENTITY_IGNORE_RE =
  /multivac|bizerba|handtmann|service\s+und\s+logistik|verwaltungs\s+gmbh|haggenm|wolfertschwenden|memmingen|balingen|biberach|heidelberg|adobe|microsoft|linotype|monotype|heidelberger\s+druck|foxit|kofax|canon\b|ricoh\b|xerox\b|hewlett|urw\b|sap\s+(?:se|ag)\b|bank\b|sparkasse|commerzbank|unicredit|landesbank|nedbank|standard\s+bank|firststrand|absa\b|fnb\b|capitec|investec|hsbc|barclays|citibank|deutsche\s+bank/i;

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
    if (!NON_SUPPLIER_ENTITY_IGNORE_RE.test(candidate) && !BUYER_IGNORE_RE.test(candidate)) {
      return candidate;
    }
  }

  // Replace buyer/customer mentions of known brands (e.g. "Customer: MULTIVAC") with a hard delimiter ";" so multi-word matching cannot cross them
  const cleanedText = text.replace(
    /\b(?:Customer|Client|Bill\s+To|Ship\s+To|Sold\s+To|Deliver\s+To|Delivery\s+To|Recipient|Buyer|Consignee)\s*:?\s*(?:MULTIVAC|BIZERBA|HANDTMANN)\b(?![\s,]*(?:\(Pty\)|Pty\b|GmbH\b|SE\b|Service\s+und\s+Logistik|Southern\s+Africa))/gi,
    ' ; ',
  );

  let m: RegExpExecArray | null;
  LEGAL_ENTITY_RE.lastIndex = 0;
  while ((m = LEGAL_ENTITY_RE.exec(cleanedText)) !== null) {
    const prefixStart = Math.max(0, m.index - 40);
    const preceding = cleanedText.slice(prefixStart, m.index);
    if (PRECEDING_NON_SUPPLIER_LABEL_RE.test(preceding)) continue;

    let candidate = m[1].trim();
    if (BUYER_IGNORE_RE.test(candidate)) continue;
    candidate = candidate.replace(LEADING_HEADER_NOISE_RE, '').replace(/\s+/g, ' ').trim();
    if (!candidate || candidate.length < 4) continue;
    if (NON_SUPPLIER_ENTITY_IGNORE_RE.test(candidate)) continue;
    if (/^(?:Page|Item|Code|Total|Net\s+Price|Unit\s+Price|Quantity|Description|Pos|Document|Date|Currency)\b/i.test(candidate)) continue;
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
    handtmann.score > 0 &&
    bizerba.score === 0 &&
    multivac.score < 10 &&
    !thirdPartyName;

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
    bizerba.score > 0 &&
    handtmann.score === 0 &&
    multivac.score < 10 &&
    !thirdPartyName;

  if (hasBizerbaColumns) {
    bizerba.score += 10;
    bizerba.signals.push('Bizerba quotation columns (Item, Description, Qty, Net Price)');
  }

  // Priority 1: Explicit Bizerba identification
  const hasExplicitBizerbaBrand = /BIZERBA/i.test(text) || /\bB\s+I\s+Z\s+E\s+R\s+B\s+A\b/i.test(text);
  const hasExplicitHandtmannBrand =
    /HANDTMANN/i.test(text) ||
    /\bH\s+A\s+N\s+D\s+T\s+M\s+A\s+N\s+N\b/i.test(text) ||
    /477\s*021\s*7620/.test(text) ||
    /POSTNET\s*SUITE\s*514/i.test(text) ||
    /PRIVATE\s*BAG\s*H\s*607/i.test(text);

  if (hasExplicitBizerbaBrand && !hasExplicitHandtmannBrand && bizerba.score >= 10 && multivac.score < 15) {
    return {
      supplier: 'bizerba',
      confidence: 'high',
      detectedName: 'Bizerba',
      reason: `Identified Bizerba from document content (${bizerba.signals.slice(0, 2).join(', ')}).`,
    };
  }

  // Priority 2: Explicit German MULTIVAC company identification (MULTIVAC Service und Logistik GmbH & Co. KG, DE 364316979, Wolfertschwenden, HRA 13980, muwo@multivac.de, etc.)
  const hasExplicitGermanMultivac =
    /MULTIVAC\s*SERVICE\s*UND\s*LOGISTIK/i.test(text) ||
    /\bSERVICE\s+UND\s+LOGISTIK\s+(?:GMBH|VERWALTUNGS)/i.test(text) ||
    /DE\s*364\s*316\s*979/i.test(text) ||
    /\bHRA\s*13980\b/i.test(text) ||
    /MUWO\s*@\s*MULTIVAC\.DE/i.test(text) ||
    /STEFAN\.KIRCHMANN\s*@\s*MULTIVAC\.DE/i.test(text) ||
    /87787\s*WOLFERTSCHWENDEN/i.test(text) ||
    /GEWERBESTR(?:ASSE|AßE|A.{1,3}E|\.)\s*15\b/i.test(text) ||
    /AMTSGERICHT\s*MEMMINGEN/i.test(text) ||
    /DR\.?\s*CHRISTIAN\s*LAU/i.test(text) ||
    /DR\.?\s*JOHANNES\s*EPPLE/i.test(text);

  if (hasExplicitGermanMultivac && !hasExplicitHandtmannBrand && !hasExplicitBizerbaBrand) {
    return {
      supplier: 'multivac',
      confidence: 'high',
      detectedName: 'Multivac',
      reason: `Identified Multivac from company details (${multivac.signals.slice(0, 2).join(', ')}).`,
    };
  }

  // Priority 3: Handtmann (MULTIVAC SOUTHERN AFRICA (Pty) Ltd, VAT 4770217620, Heidelberg address, or Handtmann brand/columns)
  if (handtmann.score >= 10 && handtmann.score >= multivac.score) {
    return {
      supplier: 'handtmann',
      confidence: 'high',
      detectedName: 'Handtmann',
      reason: `Identified Handtmann from company details (${handtmann.signals.slice(0, 2).join(', ')}).`,
    };
  }

  // Priority 4: MULTIVAC score >= 10 (e.g. Wolfertschwenden, Sepp Haggenmüller, +49 8334 601, Pos. 10 / Invoice amount layout)
  if (multivac.score >= 10 && multivac.score > handtmann.score && bizerba.score < 10) {
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

  // Priority 5: Efficiently classify as "Others" once confirmed NOT to be Multivac, Bizerba, or Handtmann
  const quoteKeywordMatches = text.match(QUOTATION_KEYWORDS_RE) || [];
  const distinctQuoteKeywords = new Set(quoteKeywordMatches.map((k) => k.toLowerCase()));
  const hasDecimalPrice = /\b\d+[.,]\d{2}\b/.test(text);

  // Guard against bare ambiguous stubs like "MULTIVAC Quotation 12345" where "MULTIVAC" appears with no company details and no table structure
  const hasBareAmbiguousMultivac =
    /\bMULTIVAC\b/i.test(text) && !thirdPartyName && distinctQuoteKeywords.size < 3;

  const hasQuoteStructure =
    !hasBareAmbiguousMultivac &&
    (distinctQuoteKeywords.size >= 2 ||
      ( Boolean(thirdPartyName) && distinctQuoteKeywords.size >= 1 ) ||
      ( distinctQuoteKeywords.size >= 1 && hasDecimalPrice && text.length >= 40 ));

  if (hasQuoteStructure) {
    return {
      supplier: 'other',
      confidence: 'high',
      detectedName: thirdPartyName,
      reason: thirdPartyName
        ? `Identified third-party supplier "${thirdPartyName}" from the quotation document.`
        : 'Document does not match Multivac, Bizerba, or Handtmann and is classified as Others.',
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

function decodeLiteralToBytes(raw: string): number[] {
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
  return bytes;
}

function bytesToAscii(bytes: number[]): string {
  if (bytes.length >= 4 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let u16 = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      if (code >= 32 && code <= 0xd7ff) u16 += String.fromCharCode(code);
    }
    return u16;
  }
  let out = '';
  for (const b of bytes) {
    if ((b >= 32 && b <= 126) || (b >= 160 && b <= 255) || b === 9 || b === 10 || b === 13) {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function decodeHexToBytes(hex: string): number[] {
  const clean = hex.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function bytesToCMap2(bytes: number[], cmap: Map<number, string>): string {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return '';
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const cid = (bytes[i] << 8) | bytes[i + 1];
    const mapped = cmap.get(cid);
    if (mapped) out += mapped;
  }
  return out;
}

function bytesToCMap1(bytes: number[], cmap: Map<number, string>): string {
  let out = '';
  let mappedCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    const mapped = cmap.get(bytes[i]);
    if (mapped) {
      out += mapped;
      mappedCount++;
    }
  }
  return mappedCount > 0 ? out : '';
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

function parseToUnicodeCMap(content: string, cmaps: Array<Map<number, string>>): void {
  if (!content.includes('beginbfchar') && !content.includes('beginbfrange')) return;

  const localMap = new Map<number, string>();

  const charBlockRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = charBlockRe.exec(content)) !== null) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(block[1])) !== null) {
      const src = parseInt(m[1], 16);
      const dst = decodeHexToUnicode(m[2]);
      if (Number.isFinite(src) && dst) localMap.set(src, dst);
    }
  }

  const rangeBlockRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeBlockRe.exec(content)) !== null) {
    // 1. Array form: <start> <end> [<dst1> <dst2> ...]
    const arrayRangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = arrayRangeRe.exec(block[1])) !== null) {
      const start = parseInt(m[1], 16);
      const end = parseInt(m[2], 16);
      const hexItems = m[3].match(/<([0-9A-Fa-f]+)>/g) || [];
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 512) {
        for (let idx = 0; idx < hexItems.length && start + idx <= end; idx++) {
          const dst = decodeHexToUnicode(hexItems[idx].slice(1, -1));
          if (dst) localMap.set(start + idx, dst);
        }
      }
    }

    // 2. Sequential form: <start> <end> <base>
    const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((m = rangeRe.exec(block[1])) !== null) {
      const start = parseInt(m[1], 16);
      const end = parseInt(m[2], 16);
      const baseCode = parseInt(m[3], 16);
      if (Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(baseCode) && end >= start && end - start <= 512) {
        for (let cid = start; cid <= end; cid++) {
          const cp = baseCode + (cid - start);
          if (cp > 0 && cp <= 0x10ffff) localMap.set(cid, String.fromCodePoint(cp));
        }
      }
    }
  }

  if (localMap.size > 0 && cmaps.length < 24) {
    cmaps.push(localMap);
  }
}

function extractLiteralByteTokensWithBalancedParens(content: string): number[][] {
  const results: number[][] = [];
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
      const bytes = decodeLiteralToBytes(inner);
      if (bytes.length > 0) results.push(bytes);
    }
  }
  return results;
}

function extractStringsFromStreamContent(content: string, cmaps: Array<Map<number, string>>): string {
  const asciiChunks: string[] = [];
  const cmap2Chunks: string[][] = cmaps.map(() => []);
  const cmap1Chunks: string[][] = cmaps.map(() => []);

  // 1. Reconstruct words across kerning arrays: [(H) -15 (andtmann)] TJ or [<0048> -10 <0061...>] TJ
  // Keep ASCII reconstruction completely separate from each CMap reconstruction so characters never interleave mid-word.
  const tjArrayRe = /\[([^\[\]]{1,8000})\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = tjArrayRe.exec(content)) !== null) {
    const inner = m[1];
    let asciiLine = '';
    const c2Lines = cmaps.map(() => '');
    const c1Lines = cmaps.map(() => '');

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
        const bytes = decodeLiteralToBytes(inner.slice(start, Math.max(start, idx - 1)));
        asciiLine += bytesToAscii(bytes);
        for (let c = 0; c < cmaps.length; c++) {
          c2Lines[c] += bytesToCMap2(bytes, cmaps[c]);
          c1Lines[c] += bytesToCMap1(bytes, cmaps[c]);
        }
      } else if (ch === '<') {
        const end = inner.indexOf('>', idx + 1);
        if (end === -1) break;
        const bytes = decodeHexToBytes(inner.slice(idx + 1, end));
        asciiLine += bytesToAscii(bytes);
        for (let c = 0; c < cmaps.length; c++) {
          c2Lines[c] += bytesToCMap2(bytes, cmaps[c]);
          c1Lines[c] += bytesToCMap1(bytes, cmaps[c]);
        }
        idx = end + 1;
      } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
        const numMatch = /^-?\d+(?:\.\d+)?/.exec(inner.slice(idx));
        if (numMatch) {
          const kern = parseFloat(numMatch[0]);
          if (kern < -120) {
            asciiLine += ' ';
            for (let c = 0; c < cmaps.length; c++) {
              c2Lines[c] += ' ';
              c1Lines[c] += ' ';
            }
          }
          idx += numMatch[0].length;
        } else {
          idx++;
        }
      } else {
        idx++;
      }
    }

    if (asciiLine.trim()) asciiChunks.push(asciiLine.trim());
    for (let c = 0; c < cmaps.length; c++) {
      if (c2Lines[c].trim()) cmap2Chunks[c].push(c2Lines[c].trim());
      if (c1Lines[c].trim()) cmap1Chunks[c].push(c1Lines[c].trim());
    }
  }

  // 2. Literal strings (...) with support for nested balanced parentheses like "(Company (Pty) Ltd)"
  const litByteTokens = extractLiteralByteTokensWithBalancedParens(content);
  if (litByteTokens.length > 0) {
    const asciiTokens = litByteTokens.map(bytesToAscii).filter(Boolean);
    if (asciiTokens.length > 0) {
      asciiChunks.push(asciiTokens.join(''));
      asciiChunks.push(asciiTokens.join(' '));
    }
    for (let c = 0; c < cmaps.length; c++) {
      const t2 = litByteTokens.map((b) => bytesToCMap2(b, cmaps[c])).filter(Boolean);
      if (t2.length > 0) cmap2Chunks[c].push(t2.join(''), t2.join(' '));
      const t1 = litByteTokens.map((b) => bytesToCMap1(b, cmaps[c])).filter(Boolean);
      if (t1.length > 0) cmap1Chunks[c].push(t1.join(''), t1.join(' '));
    }
  }

  // 3. Hex strings <...>
  const hexRe = /<([0-9A-Fa-f\s]{2,})>/g;
  const hexByteTokens: number[][] = [];
  while ((m = hexRe.exec(content)) !== null) {
    const bytes = decodeHexToBytes(m[1]);
    if (bytes.length > 0) hexByteTokens.push(bytes);
  }
  if (hexByteTokens.length > 0) {
    const asciiHex = hexByteTokens.map(bytesToAscii).filter(Boolean);
    if (asciiHex.length > 0) {
      asciiChunks.push(asciiHex.join(''));
      asciiChunks.push(asciiHex.join(' '));
    }
    for (let c = 0; c < cmaps.length; c++) {
      const t2 = hexByteTokens.map((b) => bytesToCMap2(b, cmaps[c])).filter(Boolean);
      if (t2.length > 0) cmap2Chunks[c].push(t2.join(''), t2.join(' '));
      const t1 = hexByteTokens.map((b) => bytesToCMap1(b, cmaps[c])).filter(Boolean);
      if (t1.length > 0) cmap1Chunks[c].push(t1.join(''), t1.join(' '));
    }
  }

  const allParts: string[] = [...asciiChunks];
  for (let c = 0; c < cmaps.length; c++) {
    if (cmap2Chunks[c].length > 0) allParts.push(cmap2Chunks[c].join(' '));
    if (cmap1Chunks[c].length > 0) allParts.push(cmap1Chunks[c].join(' '));
  }
  return allParts.join(' ');
}

function bytesToLatin1String(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    parts.push(String.fromCharCode.apply(null, sub as unknown as number[]));
  }
  return parts.join('');
}

async function inflateOnce(buf: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<string | null> {
  if (buf.length < 2) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(buf as unknown as BufferSource).catch(() => {});
    writer.close().catch(() => {});
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        parts.push(value);
        total += value.byteLength;
        if (total > 1_000_000) break;
      }
    }
  } catch {
    // Preserve any chunks already read into `parts`
  }
  if (total > 0) {
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.byteLength;
    }
    return bytesToLatin1String(merged);
  }
  return null;
}

async function tryInflate(data: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined' || data.length < 2) return null;

  // Strip trailing PDF stream padding bytes (spaces, CR, LF, tabs, nulls) before 'endstream'
  let end = data.length;
  while (
    end > 2 &&
    (data[end - 1] === 0x00 ||
      data[end - 1] === 0x09 ||
      data[end - 1] === 0x0a ||
      data[end - 1] === 0x0d ||
      data[end - 1] === 0x20)
  ) {
    end--;
  }
  const trimmed = end < data.length ? data.subarray(0, end) : data;

  if (trimmed[0] === 0x78) {
    const res1 = await inflateOnce(trimmed, 'deflate');
    if (res1) return res1;
    if (trimmed.length !== data.length) {
      const res2 = await inflateOnce(data, 'deflate');
      if (res2) return res2;
    }
    // Fallback: strip 2-byte zlib header (0x78 0x..) and 4-byte Adler32 trailer and inflate as raw deflate
    if (trimmed.length > 6) {
      const res3 = await inflateOnce(trimmed.subarray(2, trimmed.length - 4), 'deflate-raw');
      if (res3) return res3;
    }
    return null;
  }

  const rawRes = await inflateOnce(trimmed, 'deflate-raw');
  if (rawRes) return rawRes;
  return inflateOnce(trimmed, 'deflate');
}

// Fast in-memory cache so repeated calls on the same PDF buffer never re-run decompression or detection
const pdfBufferCache = new WeakMap<Uint8Array, { text: string; detection: SupplierDetectionResult }>();
const pdfFingerprintCache = new Map<string, { text: string; detection: SupplierDetectionResult }>();

function computePdfFingerprint(bytes: Uint8Array): string {
  const len = bytes.byteLength;
  let h1 = 0x811c9dc5;
  const step = Math.max(1, Math.floor(len / 512));
  for (let i = 0; i < len; i += step) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `${len}:${h1.toString(16)}`;
}

const SKIP_BINARY_STREAM_DICT_RE = /\/Subtype\s*\/Image|\/Filter\s*\/(?:DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)|\/FontFile[123]?\b/i;

/**
 * Extracts readable text from a PDF byte buffer (uncompressed text + FlateDecode streams + ToUnicode CMaps).
 * Caches and reuses extracted text for identical PDF buffers.
 */
export async function extractTextFromPdfBytes(bytes: Uint8Array): Promise<string> {
  const cachedByRef = pdfBufferCache.get(bytes);
  if (cachedByRef) return cachedByRef.text;

  const fp = computePdfFingerprint(bytes);
  const cachedByFp = pdfFingerprintCache.get(fp);
  if (cachedByFp) {
    pdfBufferCache.set(bytes, cachedByFp);
    return cachedByFp.text;
  }

  // Use true 1-to-1 ISO-8859-1 conversion so char indices match `bytes` offsets 1:1 and 0x80..0x9F are never corrupted
  const rawLatin1 = bytesToLatin1String(bytes);
  const parts: string[] = [];
  const cmaps: Array<Map<number, string>> = [];

  const nonStreamContent = rawLatin1.replace(/stream[\s\S]*?endstream/g, ' ');
  parseToUnicodeCMap(nonStreamContent, cmaps);

  const inflatedStreams: string[] = [];
  const uncompressedStreams: string[] = [];
  const streamRe = /(stream[ \t]*(?:\r\n|\r|\n))([\s\S]*?)((?:\r\n|\r|\n)?endstream)/g;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = streamRe.exec(rawLatin1)) !== null && count < 120) {
    const prefixLen = match[1].length;
    const bodyLen = match[2].length;
    if (bodyLen < 4 || bodyLen > 750_000) continue;

    // Inspect the preceding object dictionary (~250 chars before 'stream') to skip binary image/font streams
    const dictStart = Math.max(0, match.index - 260);
    const dictHeader = rawLatin1.slice(dictStart, match.index);
    if (SKIP_BINARY_STREAM_DICT_RE.test(dictHeader)) continue;

    count++;
    const bodyStart = match.index + prefixLen;
    const streamBytes = bytes.subarray(bodyStart, bodyStart + bodyLen);
    const inflated = await tryInflate(streamBytes);
    if (inflated) {
      parseToUnicodeCMap(inflated, cmaps);
      inflatedStreams.push(inflated);
    } else if (!/\/Filter\s*(?:\/|\[\s*\/)FlateDecode/i.test(dictHeader)) {
      parseToUnicodeCMap(match[2], cmaps);
      uncompressedStreams.push(match[2]);
    }
  }

  // Extract strings from non-stream PDF metadata/headers and uncompressed streams
  const headerStrings = extractStringsFromStreamContent(nonStreamContent, cmaps);
  if (headerStrings) parts.push(headerStrings);

  for (const rawStream of uncompressedStreams) {
    const extracted = extractStringsFromStreamContent(rawStream, cmaps);
    if (extracted) parts.push(extracted);
  }

  for (const inflated of inflatedStreams) {
    const extracted = extractStringsFromStreamContent(inflated, cmaps);
    if (extracted) parts.push(extracted);
  }

  // Also capture plain readable ASCII text when a test/simple PDF stores plain text directly outside streams
  const plainText = nonStreamContent
    .replace(/[^\x20-\x7E\xC0-\xFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plainText) parts.push(plainText);

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  const detection = detectSupplierFromText(text);
  const entry = { text, detection };
  pdfBufferCache.set(bytes, entry);
  if (pdfFingerprintCache.size > 50) {
    const firstKey = pdfFingerprintCache.keys().next().value;
    if (firstKey) pdfFingerprintCache.delete(firstKey);
  }
  pdfFingerprintCache.set(fp, entry);
  return text;
}

export async function detectSupplierFromPdfBytesWithText(
  bytes: Uint8Array,
): Promise<{ text: string; detection: SupplierDetectionResult }> {
  const cachedByRef = pdfBufferCache.get(bytes);
  if (cachedByRef) return cachedByRef;

  const fp = computePdfFingerprint(bytes);
  const cachedByFp = pdfFingerprintCache.get(fp);
  if (cachedByFp) {
    pdfBufferCache.set(bytes, cachedByFp);
    return cachedByFp;
  }

  const text = await extractTextFromPdfBytes(bytes);
  const after = pdfBufferCache.get(bytes) || pdfFingerprintCache.get(fp);
  if (after) return after;
  const detection = detectSupplierFromText(text);
  return { text, detection };
}

export async function detectSupplierFromPdfBytes(bytes: Uint8Array): Promise<SupplierDetectionResult> {
  const { detection } = await detectSupplierFromPdfBytesWithText(bytes);
  return detection;
}


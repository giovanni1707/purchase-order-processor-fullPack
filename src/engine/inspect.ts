import { findRowByText, resolvePoSheets } from './fill';
import { MODES, MODE_IDS, PoMode } from './profiles';
import { Package, cellMap, cellText, findSheet, parseXml, rowMap, sharedStrings } from './ooxml';

export interface WorkbookInspection {
  ok: boolean;
  error?: string;
  /** which purchase-order types this workbook can produce (cost sheet and PO sheet present) */
  modes: Record<PoMode, boolean>;
  /** current text of the first Details cell of the type's PO sheet (the template ships sample text there) */
  details: Record<PoMode, string[]>;
  /** "Other" only: the workbook has no PO Others sheet, so only the cost sheet would be filled */
  missingPo: Record<PoMode, boolean>;
}

const empty = <T,>(v: T): Record<PoMode, T> => ({ multivac: v, bizerba: v, handtmann: v, other: v });

/** Cheap check done when the workbook is chosen: which PO types are possible? what is in the Details cells? */
export async function inspectWorkbook(buf: ArrayBuffer | Uint8Array): Promise<WorkbookInspection> {
  const res: WorkbookInspection = {
    ok: false,
    modes: empty(false),
    details: { multivac: [], bizerba: [], handtmann: [], other: [] },
    missingPo: empty(false),
  };
  let pkg: Package;
  try {
    pkg = await Package.load(buf);
  } catch {
    return { ...res, error: 'This file could not be read as an Excel workbook (.xlsx).' };
  }
  const sst = sharedStrings(pkg);
  for (const id of MODE_IDS) {
    try {
      const profile = MODES[id];
      findSheet(pkg, profile.costSheet);
      const pos = resolvePoSheets(pkg, profile);
      const texts: string[] = [];
      for (const po of pos) {
        const root = parseXml(pkg.get(po.part)).documentElement;
        const hdr = findRowByText(root, sst, 'A', (t) => t.trim().toLowerCase() === 'pos', 1, 60);
        if (hdr === null) continue;
        const row = rowMap(root).get(hdr + 1);
        const cell = row ? cellMap(row)['E'] : undefined;
        const text = cell ? cellText(cell, sst) : null;
        if (text && text.trim() && !texts.includes(text.trim())) texts.push(text.trim());
      }
      res.modes[id] = true;
      res.details[id] = texts;
      res.missingPo[id] = pos.length < profile.poSheets.length;
    } catch {
      /* this type is not available in the workbook */
    }
  }
  res.ok = MODE_IDS.some((m) => res.modes[m]);
  if (!res.ok) {
    res.error =
      "This is not the Template_Purchase_Order workbook (it needs 'Order list' + 'PO Multivac', 'Quotation_3rd Pty' + 'PO Bizerba' / 'PO Handtmann', or 'Others_3rd Pty' + 'PO Others').";
  }
  return res;
}

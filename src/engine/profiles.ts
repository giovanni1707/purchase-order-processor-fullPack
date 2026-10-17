/** The purchase-order types the app can produce. Sheet names are matched tolerantly (case, "_" / "-" / space). */
export type PoMode = 'multivac' | 'bizerba' | 'handtmann' | 'other';

export interface ModeProfile {
  id: PoMode;
  label: string;
  /** the primary cost build-up sheet that receives the quotation lines */
  costSheet: string;
  /** fallback candidates if primary costSheet is not found */
  costSheetCandidates?: string[];
  /** the ONE printable purchase-order sheet of this type (other PO sheets are left untouched) */
  poSheets: string[];
  /** fallback candidates for PO sheets */
  poSheetCandidates?: Record<string, string[]>;
  /** the PO sheet may be missing from the workbook: then only the cost sheet is filled */
  poOptional?: boolean;
  /** third-party cost sheet also carries a MUR-per-EUR rate (column T) */
  secondRateCol?: string;
}

const THIRD_PARTY_COST = 'Quotation_3rd Pty';
const OTHERS_COST = 'Others_3rd Pty';

export const MODES: Record<PoMode, ModeProfile> = {
  multivac: { id: 'multivac', label: 'Multivac', costSheet: 'Order list', poSheets: ['PO Multivac'] },
  bizerba: { id: 'bizerba', label: 'Bizerba', costSheet: THIRD_PARTY_COST, poSheets: ['PO Bizerba'], secondRateCol: 'T' },
  handtmann: { id: 'handtmann', label: 'Handtmann', costSheet: THIRD_PARTY_COST, poSheets: ['PO Handtmann'], secondRateCol: 'T' },
  other: {
    id: 'other',
    label: 'Others',
    costSheet: OTHERS_COST,
    costSheetCandidates: [OTHERS_COST, 'Others-3rd pty', 'Others', 'Other_3rd Pty', THIRD_PARTY_COST, 'Quotation-3rd pty'],
    poSheets: ['PO Others'],
    poSheetCandidates: {
      'PO Others': ['PO Others', 'PO-Others', 'PO_Others', 'PO Other', 'PO-Other', 'PO_Other', 'PO others', 'PO-others'],
    },
    poOptional: true,
    secondRateCol: 'T',
  },
};

export const MODE_IDS = Object.keys(MODES) as PoMode[];

/** Columns of the cost sheet that are typed by the app (everything else keeps the template's formulas). */
export function manualCostCols(mode: PoMode): string[] {
  return MODES[mode].secondRateCol ? ['A', 'B', 'E', 'F', 'G', 'I', 'T', 'O', 'P'] : ['A', 'B', 'E', 'F', 'G', 'I', 'O', 'P'];
}

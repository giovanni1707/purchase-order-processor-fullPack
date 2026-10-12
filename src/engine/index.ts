import { buildCalc, injectCached } from './calc';
import { FillOptions, FillResult, fillWorkbook } from './fill';
import { sharedStrings } from './ooxml';

export * from './fill';
export * from './profiles';
export * from './ooxml';
export { verifyWorkbook } from './verify';
export { inspectWorkbook } from './inspect';
export type { WorkbookInspection } from './inspect';
export type { CheckResult, VerifyInput } from './verify';

/** Fill the workbook and store HyperFormula results as cached values in the two edited sheets. */
export function buildPurchaseOrder(template: ArrayBuffer | Uint8Array, opts: FillOptions): Promise<FillResult> {
  return fillWorkbook(template, opts, ({ pkg, sheets }) => {
    const sst = sharedStrings(pkg);
    const calc = buildCalc(sheets, sst);
    for (const sh of sheets) injectCached(sh, calc);
  });
}

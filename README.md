# MULTIVAC Purchase Order

Upload a quotation PDF and `Template_Purchase_Order_2026.xlsx`, choose the purchase order type, type the exchange rate(s), and get the workbook back with only the matching sheets filled. Every other sheet is returned byte-for-byte unchanged.

| Type | Cost sheet | PO sheet | Reads from the PDF |
|---|---|---|---|
| Multivac | Order list | PO Multivac | Multivac layout |
| Bizerba | Quotation_3rd Pty | PO Bizerba | Item, Description, Qty, Net Price |
| Handtmann | Quotation_3rd Pty | PO Handtmann | Code, Description, Quantity, Net Price (unit price = Net Price ÷ Quantity) |
| Other | Quotation_3rd Pty | PO Others (if the workbook has it) | the four headers you type |

Anything missing, unreadable or contradictory is never guessed: a chat asks the user, one question at a time.

* Extraction: server-side Gemini (`/api/extract`), run twice and reconciled; ambiguity stops the run.
* Excel: the package XML is edited directly with JSZip (no load-and-save library), so hidden sheets, logos, comments, external links and custom XML survive.
* Verification: the saved file is re-opened and checked (package integrity, formulas, totals vs. the quotation's Invoice amount, no Excel errors, HyperFormula recalculation). Download is only offered when every check passes.

```
npm install
cp .env.example .env   # set GEMINI_API_KEY
npm run dev
npm run test:engine    # engine + verifier, all four types, no API key needed
npx tsx scripts/test-logic.ts   # supplier rules, chat answers, extraction pipeline (fake model)
npx tsx scripts/ui-smoke.tsx    # the real screen in jsdom, all four types and the chat
```

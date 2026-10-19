/*
 * GST invoice numbers (Phase 2 P4). Pure functions: easy to test, no DB.
 *
 * Prices in the shop INCLUDE GST, so tax is taken OUT of each amount:
 *   taxable = gross × 100 / (100 + rate),  tax = gross − taxable
 * All money is integer paise. Rounding happens once per line, and the parts
 * always add up exactly to what the customer paid.
 */

export interface InvoiceItemInput {
  name: string;
  quantity: number;
  unitPricePaise: number; // incl. GST
  lineTotalPaise: number; // unit × qty
}

export interface InvoiceLine {
  name: string;
  quantity: number;
  unitPricePaise: number;
  /** This line's share of the coupon discount */
  discountPaise: number;
  /** Paid for the line (incl. GST) */
  grossPaise: number;
  taxablePaise: number;
  /** Intra-state: CGST + SGST (half each). Inter-state: IGST. */
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface InvoiceTotals {
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

/**
 * Splits `total` over `weights` in proportion, in whole paise. The leftover
 * paise go to the biggest remainders, so the parts sum to exactly `total`.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    parts[i] += 1;
  }
  return parts;
}

/**
 * @param ratePercent GST rate, e.g. 18
 * @param intraState  seller and buyer in the same state → CGST + SGST
 */
export function computeInvoice(
  items: InvoiceItemInput[],
  discountPaise: number,
  ratePercent: number,
  intraState: boolean,
): { lines: InvoiceLine[]; totals: InvoiceTotals } {
  const discounts = allocate(
    discountPaise,
    items.map((i) => i.lineTotalPaise),
  );

  const lines = items.map((item, i): InvoiceLine => {
    const gross = item.lineTotalPaise - discounts[i];
    const taxable = Math.round((gross * 100) / (100 + ratePercent));
    const tax = gross - taxable;
    const cgst = intraState ? Math.floor(tax / 2) : 0;
    return {
      name: item.name,
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
      discountPaise: discounts[i],
      grossPaise: gross,
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: intraState ? tax - cgst : 0,
      igstPaise: intraState ? 0 : tax,
    };
  });

  const sum = (k: keyof InvoiceLine) =>
    lines.reduce((a, l) => a + (l[k] as number), 0);
  return {
    lines,
    totals: {
      grossPaise: sum('grossPaise'),
      discountPaise: sum('discountPaise'),
      taxablePaise: sum('taxablePaise'),
      cgstPaise: sum('cgstPaise'),
      sgstPaise: sum('sgstPaise'),
      igstPaise: sum('igstPaise'),
    },
  };
}

/** Indian financial year (April–March) of a date, in India time: "2026-27". */
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + 330 * 60_000); // UTC+5:30, no DST
  const y =
    ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/**
 * SF/26-27/000042. GST: unique, consecutive within a financial year, at
 * most 16 characters (so the short year).
 */
export const invoiceNumber = (fy: string, seq: number) =>
  `SF/${fy.slice(2)}/${String(seq).padStart(6, '0')}`;

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? below100(rest) : '']
    .filter(Boolean)
    .join(' ');
}

/** Indian numbering (crore, lakh, thousand). 0 → "Zero". */
function inWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${inWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

/** 2399750 paise → "Rupees Twenty-Three Thousand Nine Hundred Ninety-Seven and Fifty Paise Only" */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${inWords(rupees)}${p ? ` and ${below100(p)} Paise` : ''} Only`;
}

/** 1899900 → "18,999.00" (Indian grouping: 1,23,45,678.00) */
export function formatRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${sign}${grouped}.${String(abs % 100).padStart(2, '0')}`;
}

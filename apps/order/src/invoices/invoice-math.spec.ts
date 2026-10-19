import {
  allocate,
  amountInWords,
  computeInvoice,
  financialYear,
  formatRupees,
  invoiceNumber,
} from './invoice-math';

describe('invoice math', () => {
  const items = [
    {
      name: 'Phone',
      quantity: 1,
      unitPricePaise: 1899900,
      lineTotalPaise: 1899900,
    },
    {
      name: 'Shoes',
      quantity: 2,
      unitPricePaise: 249900,
      lineTotalPaise: 499800,
    },
  ];

  it('takes GST out of the price; CGST + SGST inside the state', () => {
    const { lines, totals } = computeInvoice(items, 0, 18, true);
    // 18,999 incl. 18% → taxable 16,100.85, tax 2,898.15
    expect(lines[0]).toMatchObject({
      grossPaise: 1899900,
      taxablePaise: 1610085,
      cgstPaise: 144907,
      sgstPaise: 144908,
      igstPaise: 0,
    });
    // Every line adds up exactly to what was paid.
    for (const l of lines) {
      expect(l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise).toBe(
        l.grossPaise,
      );
    }
    expect(totals.grossPaise).toBe(2399700);
  });

  it('IGST for another state', () => {
    const { lines } = computeInvoice(items, 0, 18, false);
    expect(lines[1]).toMatchObject({
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 76241,
    });
    expect(lines[1].taxablePaise + lines[1].igstPaise).toBe(499800);
  });

  it('spreads a coupon over the lines by value, to the paisa', () => {
    const { lines, totals } = computeInvoice(items, 100001, 18, true);
    expect(lines.map((l) => l.discountPaise).reduce((a, b) => a + b)).toBe(
      100001,
    );
    expect(totals.grossPaise).toBe(2399700 - 100001);
    expect(lines[0].discountPaise).toBeGreaterThan(lines[1].discountPaise);
  });

  it('allocate: biggest remainders get the leftover paise', () => {
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(7, [0, 0])).toEqual([0, 0]);
  });

  it('financial year in India time, April to March', () => {
    expect(financialYear(new Date('2026-10-19T10:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T18:00:00Z'))).toBe('2026-27'); // 23:30 IST
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toBe('2027-28'); // 00:00 IST, 1 April
    expect(invoiceNumber('2026-27', 42)).toBe('SF/26-27/000042');
    expect(invoiceNumber('2026-27', 42).length).toBeLessThanOrEqual(16);
  });

  it('amount in words, Indian style', () => {
    expect(amountInWords(2399700)).toBe(
      'Rupees Twenty-Three Thousand Nine Hundred Ninety-Seven Only',
    );
    expect(amountInWords(12345678950)).toBe(
      'Rupees Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine and Fifty Paise Only',
    );
    expect(amountInWords(100)).toBe('Rupees One Only');
  });

  it('formats rupees with Indian grouping', () => {
    expect(formatRupees(1899900)).toBe('18,999.00');
    expect(formatRupees(12345678950)).toBe('12,34,56,789.50');
    expect(formatRupees(5)).toBe('0.05');
  });
});

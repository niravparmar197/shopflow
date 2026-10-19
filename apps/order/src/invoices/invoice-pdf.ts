import PDFDocument from 'pdfkit';
import {
  amountInWords,
  formatRupees,
  type InvoiceLine,
  type InvoiceTotals,
} from './invoice-math';

export interface InvoiceDocument {
  number: string;
  issuedAt: Date;
  orderNo: string;
  orderDate: Date;
  seller: { name: string; address: string; state: string; gstin: string };
  buyer: { name: string; lines: string[]; state: string | null };
  placeOfSupply: string;
  intraState: boolean;
  ratePercent: number;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  /** e.g. "CANCELLED: the payment was refunded" */
  note?: string;
}

const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#d1d5db';
const ACCENT = '#4f46e5';

const date = (d: Date) =>
  d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
// The built-in PDF fonts have no ₹ sign, so amounts say "Rs.".
const rs = (paise: number) => `Rs. ${formatRupees(paise)}`;

/** Renders the tax invoice as an A4 PDF. */
export function renderInvoicePdf(inv: InvoiceDocument): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `Tax invoice ${inv.number}`, Author: inv.seller.name },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = 40;
  const width = 515;

  // ---- header ----
  doc
    .fillColor(ACCENT)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text('ShopFlow', left, 40);
  doc
    .fillColor(INK)
    .fontSize(14)
    .text('TAX INVOICE', left, 44, { width, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Invoice no. ${inv.number}`, left, 64, { width, align: 'right' })
    .text(`Invoice date ${date(inv.issuedAt)}`, { width, align: 'right' })
    .text(`Order ${inv.orderNo} of ${date(inv.orderDate)}`, {
      width,
      align: 'right',
    });

  // ---- seller | buyer ----
  const top = 110;
  const col = width / 2 - 10;
  const block = (x: number, title: string, rows: string[]) => {
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(MUTED)
      .text(title, x, top, { width: col });
    doc.moveDown(0.3).font('Helvetica').fontSize(9.5).fillColor(INK);
    rows.forEach((r, i) => {
      doc
        .font(i === 0 ? 'Helvetica-Bold' : 'Helvetica')
        .text(r, x, undefined, { width: col });
    });
    return doc.y;
  };
  const yA = block(left, 'SOLD BY', [
    inv.seller.name,
    inv.seller.address,
    `GSTIN: ${inv.seller.gstin}`,
  ]);
  const yB = block(left + width / 2 + 10, 'BILL TO / SHIP TO', [
    inv.buyer.name,
    ...inv.buyer.lines,
  ]);
  let y = Math.max(yA, yB) + 10;

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      `Place of supply: ${inv.placeOfSupply}  ·  ${
        inv.intraState
          ? 'Intra-state supply: CGST + SGST'
          : 'Inter-state supply: IGST'
      }  ·  GST ${inv.ratePercent}% (included in prices)`,
      left,
      y,
      { width },
    );
  y = doc.y + 12;

  // ---- items table ----
  const cols = [
    { title: '#', w: 20, align: 'left' as const },
    { title: 'Item', w: 165, align: 'left' as const },
    { title: 'Qty', w: 30, align: 'right' as const },
    { title: 'Price incl. GST', w: 65, align: 'right' as const },
    { title: 'Discount', w: 55, align: 'right' as const },
    { title: 'Taxable value', w: 65, align: 'right' as const },
    {
      title: inv.intraState ? 'CGST + SGST' : 'IGST',
      w: 60,
      align: 'right' as const,
    },
    { title: 'Total', w: 55, align: 'right' as const },
  ];
  const row = (cells: string[], bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const h = Math.max(
      ...cells.map((c, i) => doc.heightOfString(c, { width: cols[i].w - 4 })),
    );
    if (y + h > 770) {
      doc.addPage();
      y = 40;
    }
    let x = left;
    cells.forEach((c, i) => {
      doc
        .fillColor(INK)
        .text(c, x + 2, y, { width: cols[i].w - 4, align: cols[i].align });
      x += cols[i].w;
    });
    y += h + 6;
    doc
      .moveTo(left, y - 3)
      .lineTo(left + width, y - 3)
      .strokeColor(LINE)
      .lineWidth(0.5)
      .stroke();
  };

  doc.rect(left, y - 4, width, 18).fill('#f3f4f6');
  row(
    cols.map((c) => c.title),
    true,
  );
  inv.lines.forEach((l, i) =>
    row([
      String(i + 1),
      l.name,
      String(l.quantity),
      formatRupees(l.unitPricePaise),
      l.discountPaise ? `-${formatRupees(l.discountPaise)}` : '-',
      formatRupees(l.taxablePaise),
      formatRupees(l.cgstPaise + l.sgstPaise + l.igstPaise),
      formatRupees(l.grossPaise),
    ]),
  );

  // ---- totals ----
  y += 6;
  const t = inv.totals;
  const totalRows: [string, string][] = [
    ['Taxable value', rs(t.taxablePaise)],
    ...(inv.intraState
      ? ([
          [`CGST @ ${inv.ratePercent / 2}%`, rs(t.cgstPaise)],
          [`SGST @ ${inv.ratePercent / 2}%`, rs(t.sgstPaise)],
        ] as [string, string][])
      : ([[`IGST @ ${inv.ratePercent}%`, rs(t.igstPaise)]] as [
          string,
          string,
        ][])),
    ...(t.discountPaise
      ? ([['Coupon discount (already applied)', `-${rs(t.discountPaise)}`]] as [
          string,
          string,
        ][])
      : []),
  ];
  for (const [label, value] of totalRows) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(label, left + 255, y, { width: 160, align: 'right' });
    doc
      .fillColor(INK)
      .text(value, left + 415, y, { width: 100, align: 'right' });
    y += 15;
  }
  doc
    .moveTo(left + 255, y)
    .lineTo(left + width, y)
    .strokeColor(INK)
    .lineWidth(0.8)
    .stroke();
  y += 6;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text('Total paid', left + 255, y, { width: 160, align: 'right' })
    .text(rs(t.grossPaise), left + 415, y, { width: 100, align: 'right' });
  y += 20;
  doc
    .font('Helvetica-Oblique')
    .fontSize(9)
    .fillColor(MUTED)
    .text(amountInWords(t.grossPaise), left, y, { width, align: 'right' });
  y = doc.y + 14;

  if (inv.note) {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#b91c1c')
      .text(inv.note, left, y, { width });
    y = doc.y + 10;
  }

  // ---- footer ----
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      'This is a computer-generated invoice and needs no signature. ShopFlow is a demo shop: ' +
        'the seller and GSTIN are examples, not a real business.',
      left,
      Math.max(y, 740),
      { width, align: 'center' },
    );

  doc.end();
  return done;
}

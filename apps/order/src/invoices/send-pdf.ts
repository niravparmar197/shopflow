import type { Response } from 'express';

/** Sends an invoice PDF as a download. Private: it has an address in it. */
export function sendInvoice(
  res: Response,
  { number, pdf }: { number: string; pdf: Buffer },
) {
  const file = `invoice-${number.replace(/\//g, '-')}.pdf`;
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${file}"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'private, no-store',
    })
    .end(pdf);
}

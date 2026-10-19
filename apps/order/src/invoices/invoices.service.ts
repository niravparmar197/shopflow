import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import { OrderItem } from '../orders/order-item.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order-status';
import { Invoice } from './invoice.entity';
import { computeInvoice, financialYear, invoiceNumber } from './invoice-math';
import { type InvoiceDocument, renderInvoicePdf } from './invoice-pdf';

/** Statuses that mean "the customer paid". */
const PAID_STATES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Issues the invoice inside the caller's transaction (the saga calls it
   * when the order becomes PAID). Safe to call twice: the second call
   * returns the first invoice.
   */
  async issue(m: EntityManager, order: Order): Promise<Invoice> {
    const existing = await m.findOneBy(Invoice, { orderId: order.id });
    if (existing) return existing;

    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    // Next number for this year. The UPSERT locks the counter row until
    // commit: numbers are unique and, with rollbacks undone, gap-free.
    const [{ last_seq: seq }] = await m.query<{ last_seq: number }[]>(
      `INSERT INTO invoice_counters (financial_year, last_seq) VALUES ($1, 1)
       ON CONFLICT (financial_year)
       DO UPDATE SET last_seq = invoice_counters.last_seq + 1
       RETURNING last_seq`,
      [fy],
    );
    const invoice = m.create(Invoice, {
      orderId: order.id,
      number: invoiceNumber(fy, seq),
      financialYear: fy,
      seq,
      gstRatePercent: String(
        this.config.get('GST_RATE_PERCENT', { infer: true }),
      ),
      sellerState: this.config.get('SELLER_STATE', { infer: true }),
      issuedAt,
    });
    await m.insert(Invoice, invoice);
    this.logger.log(`Invoice ${invoice.number} for order ${order.id}`);
    return invoice;
  }

  /**
   * The PDF for one order. `userId` = a customer (only their own orders);
   * undefined = an admin. Paid orders from before invoices existed get
   * their invoice now.
   */
  async pdf(
    orderId: string,
    userId?: string,
  ): Promise<{ number: string; pdf: Buffer }> {
    const { order, invoice } = await this.ds.transaction(async (m) => {
      // Row lock: two first downloads at once can't issue two numbers.
      const order = await m
        .getRepository(Order)
        .createQueryBuilder('o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: orderId })
        .getOne();
      if (!order || (userId && order.userId !== userId)) {
        throw new NotFoundException({
          code: 'ORDER_NOT_FOUND',
          message: 'Order not found',
        });
      }
      let invoice = await m.findOneBy(Invoice, { orderId });
      if (!invoice) {
        if (!PAID_STATES.includes(order.status)) {
          throw new ConflictException({
            code: 'INVOICE_NOT_READY',
            message: 'The invoice is ready once the order is paid',
          });
        }
        invoice = await this.issue(m, order);
      }
      order.items = await m.findBy(OrderItem, { orderId });
      return { order, invoice };
    });

    return {
      number: invoice.number,
      pdf: await renderInvoicePdf(this.document(order, invoice)),
    };
  }

  private document(order: Order, invoice: Invoice): InvoiceDocument {
    const rate = Number(invoice.gstRatePercent);
    const addr = order.shippingAddress;
    // GST: place of supply = where the goods are delivered.
    const buyerState = addr?.state ?? null;
    const intraState = !buyerState || same(buyerState, invoice.sellerState);
    const { lines, totals } = computeInvoice(
      order.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPricePaise: i.unitPricePaise,
        lineTotalPaise: i.lineTotalPaise,
      })),
      order.discountPaise,
      rate,
      intraState,
    );
    return {
      number: invoice.number,
      issuedAt: invoice.issuedAt,
      orderNo: order.id.slice(0, 8).toUpperCase(),
      orderDate: order.createdAt,
      seller: {
        name: this.config.get('SELLER_NAME', { infer: true }),
        address: this.config.get('SELLER_ADDRESS', { infer: true }),
        state: invoice.sellerState,
        gstin: this.config.get('SELLER_GSTIN', { infer: true }),
      },
      buyer: addr
        ? {
            name: addr.fullName,
            lines: [
              addr.line1,
              ...(addr.line2 ? [addr.line2] : []),
              `${addr.city}, ${addr.state} ${addr.pincode}`,
              `Phone ${addr.phone}`,
              ...(order.customerEmail ? [order.customerEmail] : []),
            ],
            state: addr.state,
          }
        : {
            name: order.customerEmail ?? 'Customer',
            lines: ['(no delivery address on this order)'],
            state: null,
          },
      placeOfSupply: buyerState ?? invoice.sellerState,
      intraState,
      ratePercent: rate,
      lines,
      totals,
      note:
        order.status === OrderStatus.CANCELLED
          ? 'CANCELLED: this order was cancelled after payment and refunded.'
          : undefined,
    };
  }
}

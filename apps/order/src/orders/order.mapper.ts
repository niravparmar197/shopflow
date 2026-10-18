import { Order } from './order.entity';

/** Public JSON shape of an order (no version or internal ids). */
export function toOrderResponse(order: Order) {
  return {
    id: order.id,
    status: order.status,
    failureReason: order.failureReason,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    totalPaise: order.totalPaise,
    couponCode: order.couponCode,
    currency: order.currency,
    shippingAddress: order.shippingAddress,
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    items: (order.items ?? []).map((item) => ({
      productId: item.productId,
      name: item.name,
      unitPricePaise: item.unitPricePaise,
      quantity: item.quantity,
      lineTotalPaise: item.lineTotalPaise,
    })),
    createdAt: order.createdAt,
  };
}

/** Admin view of an order: the public shape plus who placed it. */
export function toAdminOrderResponse(order: Order) {
  return {
    ...toOrderResponse(order),
    userId: order.userId,
    customerEmail: order.customerEmail,
    updatedAt: order.updatedAt,
  };
}

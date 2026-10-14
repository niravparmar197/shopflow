// The one error shape every service returns (AllExceptionsFilter, sendError),
// documented once for all endpoints.
export class ErrorResponseDto {
  /** Machine-readable code, e.g. SOLD_OUT, PRICE_CHANGED, or the status name (CONFLICT) */
  code!: string;

  /** Human-readable message ("Validation failed" for invalid input) */
  message!: string;

  /** Validation messages, or extra data, e.g. { retryAfterSec } for SERVER_BUSY */
  details?: unknown;

  /** Echo of the x-correlation-id header (or a new one); quote it in bug reports */
  correlationId!: string;

  /** Paste into Jaeger to see the whole request (absent if not traced) */
  traceId?: string;
}

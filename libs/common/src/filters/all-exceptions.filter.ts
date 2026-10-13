import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Set by pino-http from the x-correlation-id header (see CommonModule).
function correlationIdOf(req: Request): string {
  return typeof req.id === 'string' || typeof req.id === 'number'
    ? String(req.id)
    : 'unknown';
}

/** Same shape as AllExceptionsFilter, for plain Express middleware. */
export function sendError(
  req: Request,
  res: Response,
  status: number,
  message: string,
  /** A specific code (default: from the status) and extra data. */
  extra: { code?: string; details?: unknown } = {},
) {
  if (res.headersSent) return;
  const payload: ErrorResponse = {
    code: extra.code ?? HttpStatus[status] ?? 'ERROR',
    message,
    ...(extra.details === undefined ? {} : { details: extra.details }),
    correlationId: correlationIdOf(req),
  };
  res.status(status).json(payload);
}

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown; // validation messages, or extra data an exception adds
  correlationId: string;
}

// Turns every error into one shape: { code, message, details, correlationId }.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body =
      exception instanceof HttpException ? exception.getResponse() : null;
    const message: unknown =
      typeof body === 'string'
        ? body
        : ((body as { message?: unknown } | null)?.message ??
          'Something went wrong');

    // An exception can name its own error code ({ code, message }), e.g.
    // INVALID_ORDER_TRANSITION; otherwise it comes from the status.
    const customCode = (body as { code?: unknown } | null)?.code;
    const correlationId = correlationIdOf(req);

    // Log the real error for 500s, but never send its details to the client.
    if (status >= 500) {
      this.logger.error({ err: exception, correlationId }, 'Unhandled error');
    }

    const isValidation = Array.isArray(message);
    const payload: ErrorResponse = {
      code:
        typeof customCode === 'string'
          ? customCode
          : (HttpStatus[status] ?? 'ERROR'), // e.g. "CONFLICT"
      message: isValidation ? 'Validation failed' : String(message),
      details: isValidation
        ? message
        : (body as { details?: unknown } | null)?.details,
      correlationId,
    };
    // An error that says when to retry (e.g. 429 SERVER_BUSY) also gets the
    // standard header, which clients and load tools understand.
    const retryAfterSec = (payload.details as { retryAfterSec?: unknown })
      ?.retryAfterSec;
    if (typeof retryAfterSec === 'number' && retryAfterSec > 0) {
      res.setHeader('Retry-After', Math.ceil(retryAfterSec));
    }
    res.status(status).json(payload);
  }
}

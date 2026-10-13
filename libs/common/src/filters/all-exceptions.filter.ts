import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown[];
  correlationId: string;
}

// Turns every error into one shape: { code, message, details, correlationId }.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string | number }>();

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

    const correlationId = req.id !== undefined ? String(req.id) : 'unknown';

    // Log the real error for 500s, but never send its details to the client.
    if (status >= 500) {
      this.logger.error({ err: exception, correlationId }, 'Unhandled error');
    }

    const isValidation = Array.isArray(message);
    const payload: ErrorResponse = {
      code: HttpStatus[status] ?? 'ERROR', // e.g. "CONFLICT"
      message: isValidation ? 'Validation failed' : String(message),
      details: isValidation ? (message as unknown[]) : undefined,
      correlationId,
    };
    res.status(status).json(payload);
  }
}

import {
  Catch,
  HttpException,
  Logger,
  RpcExceptionFilter,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Observable, throwError } from 'rxjs';

const HTTP_TO_GRPC: Record<number, status> = {
  400: status.INVALID_ARGUMENT,
  401: status.UNAUTHENTICATED,
  403: status.PERMISSION_DENIED,
  404: status.NOT_FOUND,
  409: status.ALREADY_EXISTS,
  429: status.RESOURCE_EXHAUSTED,
  503: status.UNAVAILABLE,
  504: status.DEADLINE_EXCEEDED,
};

// gRPC has no HTTP statuses: turn Nest's HttpExceptions into gRPC status codes
// so the caller (the gateway) can map them back.
@Catch()
export class GrpcExceptionFilter implements RpcExceptionFilter<unknown> {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  catch(exception: unknown): Observable<never> {
    if (exception instanceof RpcException) {
      return throwError(() => exception.getError());
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message = (body as { message?: unknown } | null)?.message;
      return throwError(() => ({
        code: HTTP_TO_GRPC[exception.getStatus()] ?? status.UNKNOWN,
        message: Array.isArray(message)
          ? message.join('; ')
          : exception.message,
      }));
    }
    // Log the real error, but never send its details to the caller.
    this.logger.error({ err: exception }, 'Unhandled gRPC error');
    return throwError(() => ({
      code: status.INTERNAL,
      message: 'Internal error',
    }));
  }
}

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { TimeoutError } from 'rxjs';

interface GrpcError {
  code?: number;
  details?: string;
}

/** Maps a failed gRPC call to the HTTP error the client should see. */
export function toHttpError(service: string, err: unknown): HttpException {
  if (err instanceof TimeoutError) {
    return new GatewayTimeoutException(`${service} timed out`);
  }
  const { code, details } = (err ?? {}) as GrpcError;
  switch (code) {
    case status.INVALID_ARGUMENT:
      return new BadRequestException(details || 'Bad request');
    case status.NOT_FOUND:
      return new NotFoundException(details || 'Not found');
    case status.ALREADY_EXISTS:
      return new ConflictException(details || 'Conflict');
    case status.UNAUTHENTICATED:
      return new UnauthorizedException(details || 'Unauthorized');
    case status.PERMISSION_DENIED:
      return new ForbiddenException(details || 'Forbidden');
    case status.DEADLINE_EXCEEDED:
      return new GatewayTimeoutException(`${service} timed out`);
    case status.UNAVAILABLE:
      return new ServiceUnavailableException(`${service} unavailable`);
    default:
      // Internal details of the other service are not passed on.
      return new BadGatewayException(`${service} error`);
  }
}

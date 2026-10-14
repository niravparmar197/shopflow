import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from './error-response.dto';

/** One documented error response: the shared shape plus the codes it can carry. */
export const ApiError = (status: number, codes: string) =>
  ApiResponse({ status, type: ErrorResponseDto, description: codes });

import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtPayload } from '@app/common';
import { PaymentsService } from './payments.service';

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** The payment for one of your orders. */
  @Get(':orderId')
  get(
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.payments.findMine(user.sub, orderId);
  }
}

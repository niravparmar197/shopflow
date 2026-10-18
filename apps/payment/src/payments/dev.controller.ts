import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsIn } from 'class-validator';
import { Repository } from 'typeorm';
import {
  CurrentUser,
  type Env,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { ResilienceRegistry } from '@app/resilience';
import {
  FAKE_MODES,
  type FakeMode,
  FakePaymentProvider,
} from '../providers/fake.provider';
import { PaymentProviderFactory } from '../providers/provider.factory';
import { WebhookService } from '../webhooks/webhook.service';
import { Payment } from './payment.entity';

class FakeModeDto {
  @IsIn(FAKE_MODES)
  mode!: FakeMode;
}

class FakePayDto {
  @IsIn(['succeeded', 'failed'])
  outcome!: 'succeeded' | 'failed';
}

/**
 * DEV ONLY: fault injection, and "pay" with the fake provider.
 * Not registered in production, and answers 404 there anyway.
 */
@ApiExcludeController()
@Controller('payments/dev')
@UseGuards(JwtAuthGuard)
export class DevController {
  constructor(
    private readonly providers: PaymentProviderFactory,
    private readonly resilience: ResilienceRegistry,
    private readonly config: ConfigService<Env, true>,
    private readonly webhooks: WebhookService,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
  ) {}

  @Post('fake-mode')
  setMode(@Body() dto: FakeModeDto) {
    this.assertNotProduction();
    const p = this.providers.default();
    if (!(p instanceof FakePaymentProvider)) throw new NotFoundException();
    p.mode = dto.mode;
    return { mode: p.mode };
  }

  @Get('circuits')
  circuits() {
    this.assertNotProduction();
    return this.resilience.states();
  }

  /**
   * The "Pay" / "Decline" buttons of the web demo. The browser can't sign a
   * webhook (the secret stays here), so this builds a correctly signed fake
   * webhook and runs it through the NORMAL path: signature check, dedupe,
   * row lock, outbox → payment.succeeded → the order becomes PAID.
   */
  @Post('fake-pay/:orderId')
  @HttpCode(200)
  async fakePay(
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: FakePayDto,
  ) {
    this.assertNotProduction();
    if (!(this.providers.default() instanceof FakePaymentProvider)) {
      throw new NotFoundException();
    }

    // Only YOUR payment (someone else's order is a 404, not a 403).
    const payment = await this.payments.findOneBy({
      orderId,
      userId: user.sub,
    });
    if (!payment?.providerOrderId) {
      throw new NotFoundException({
        code: 'PAYMENT_NOT_STARTED',
        message: 'Start the checkout first',
      });
    }

    const secret = this.config.getOrThrow('FAKE_WEBHOOK_SECRET', {
      infer: true,
    });
    const { raw, signature } = FakePaymentProvider.sign(secret, {
      id: `evt_${randomUUID()}`,
      type:
        dto.outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      providerOrderId: payment.providerOrderId,
      reason: dto.outcome === 'failed' ? 'CARD_DECLINED' : undefined,
    });
    return this.webhooks.handle('fake', Buffer.from(raw), {
      'x-fake-signature': signature,
    });
  }

  private assertNotProduction() {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new NotFoundException();
    }
  }
}

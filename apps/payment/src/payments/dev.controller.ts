import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn } from 'class-validator';
import { type Env, JwtAuthGuard } from '@app/common';
import { ResilienceRegistry } from '@app/resilience';
import {
  FAKE_MODES,
  type FakeMode,
  FakePaymentProvider,
} from '../providers/fake.provider';
import { PaymentProviderFactory } from '../providers/provider.factory';

class FakeModeDto {
  @IsIn(FAKE_MODES)
  mode!: FakeMode;
}

/**
 * DEV ONLY: fault injection to test retry, timeout and the circuit breaker.
 * Not registered in production, and answers 404 there anyway.
 */
@Controller('payments/dev')
@UseGuards(JwtAuthGuard)
export class DevController {
  constructor(
    private readonly providers: PaymentProviderFactory,
    private readonly resilience: ResilienceRegistry,
    private readonly config: ConfigService<Env, true>,
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

  private assertNotProduction() {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new NotFoundException();
    }
  }
}

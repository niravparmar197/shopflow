import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import type { CartLine } from '../cart/cart.service';
import { Coupon, CouponType } from './coupon.entity';
import { discountFor } from './discount/discount.strategy';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { OrderHistoryService } from './order-history.service';
import {
  CouponContext,
  CouponRejected,
  CouponRule,
  OrderHistory,
} from './rules/coupon-rule';
import {
  ActiveRule,
  CategoryRule,
  DateWindowRule,
  FirstOrderRule,
  MinCartRule,
  UsageLimitRule,
} from './rules/rules';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_PERCENT = 90; // no 100% coupons by mistake

export interface CouponResult {
  code: string;
  applied: boolean;
  discountPaise: number;
  reason?: string;
}

@Injectable()
export class CouponsService {
  private readonly chain: CouponRule;

  constructor(
    @InjectRepository(Coupon) private readonly repo: Repository<Coupon>,
    private readonly history: OrderHistoryService,
  ) {
    // Built once. Cheap in-memory checks first, the one needing I/O last.
    this.chain = new ActiveRule();
    this.chain
      .setNext(new DateWindowRule())
      .setNext(new UsageLimitRule())
      .setNext(new MinCartRule())
      .setNext(new CategoryRule())
      .setNext(new FirstOrderRule());
  }

  async create(dto: CreateCouponDto) {
    if (dto.type === CouponType.PERCENT && dto.value > MAX_PERCENT) {
      throw new BadRequestException(
        `A percent coupon can be at most ${MAX_PERCENT}%`,
      );
    }
    if (dto.validTo <= dto.validFrom) {
      throw new BadRequestException('validTo must be after validFrom');
    }
    try {
      return await this.repo.save(
        this.repo.create({ ...dto, code: dto.code.toUpperCase() }),
      );
    } catch (err) {
      // The unique index is the real guard against duplicate codes.
      if (
        err instanceof QueryFailedError &&
        (err.driverError as { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException('Coupon code already exists');
      }
      throw err;
    }
  }

  list() {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  findByCode(code: string) {
    return this.repo.findOne({ where: { code: code.toUpperCase() } });
  }

  /**
   * Runs the rules and computes the discount. A failed rule is a normal
   * result (applied: false + reason), not an error: a coupon applied earlier
   * can stop qualifying when the cart changes, and the cart must still load.
   */
  async evaluate(
    code: string,
    userId: string,
    lines: CartLine[],
    subtotalPaise: number,
  ): Promise<CouponResult> {
    const coupon = await this.findByCode(code);
    if (!coupon) {
      return {
        code,
        applied: false,
        discountPaise: 0,
        reason: 'Coupon not found',
      };
    }
    return this.evaluateCoupon(coupon, userId, lines, subtotalPaise);
  }

  /** For the "apply" endpoint: fails loudly if the coupon can't be used now. */
  async assertApplicable(
    code: string,
    userId: string,
    lines: CartLine[],
    subtotalPaise: number,
  ) {
    const coupon = await this.findByCode(code);
    if (!coupon) throw new NotFoundException('Coupon not found');
    const result = await this.evaluateCoupon(
      coupon,
      userId,
      lines,
      subtotalPaise,
    );
    if (!result.applied) throw new BadRequestException(result.reason);
    return result;
  }

  /**
   * Checkout only, inside its transaction: checks the rules again and uses
   * up one redemption. Any failure is a 409 and rolls the order back.
   */
  async redeem(
    manager: EntityManager,
    code: string,
    userId: string,
    lines: CartLine[],
    subtotalPaise: number,
  ): Promise<{ code: string; discountPaise: number }> {
    const coupon = await manager
      .getRepository(Coupon)
      .findOne({ where: { code: code.toUpperCase() } });
    const result = coupon
      ? await this.evaluateCoupon(
          coupon,
          userId,
          lines,
          subtotalPaise,
          this.history.within(manager),
        )
      : null;
    if (!coupon || !result?.applied) {
      throw new ConflictException({
        code: 'COUPON_NOT_APPLICABLE',
        message: result?.reason ?? 'Coupon not found',
      });
    }
    await this.consumeOne(manager, coupon.id);
    return { code: coupon.code, discountPaise: result.discountPaise };
  }

  /**
   * Check and +1 in one UPDATE. Postgres locks the row, so a second
   * checkout waits, re-checks the WHERE against the new count, and updates
   * nothing. A "read count, then save count + 1" would let both through.
   */
  private async consumeOne(manager: EntityManager, couponId: string) {
    const res = await manager
      .createQueryBuilder()
      .update(Coupon)
      .set({ usedCount: () => 'used_count + 1' })
      .where('id = :id', { id: couponId })
      .andWhere('is_active = true')
      .andWhere('(usage_limit IS NULL OR used_count < usage_limit)')
      .execute();
    if (res.affected !== 1) {
      throw new ConflictException({
        code: 'COUPON_EXHAUSTED',
        message: 'This coupon has reached its usage limit',
      });
    }
  }

  private async evaluateCoupon(
    coupon: Coupon,
    userId: string,
    lines: CartLine[],
    subtotalPaise: number,
    history: OrderHistory = this.history,
  ): Promise<CouponResult> {
    const priced = lines.filter(
      (l) => l.available && l.lineTotalPaise !== undefined,
    );
    const ctx: CouponContext = {
      coupon,
      userId,
      lines: priced,
      subtotalPaise,
      now: new Date(),
      history,
    };

    try {
      await this.chain.validate(ctx);
    } catch (err) {
      if (err instanceof CouponRejected) {
        return {
          code: coupon.code,
          applied: false,
          discountPaise: 0,
          reason: err.message,
        };
      }
      throw err;
    }

    // A category coupon only discounts items of that category.
    const eligiblePaise = coupon.category
      ? priced
          .filter((l) => l.category === coupon.category)
          .reduce((sum, l) => sum + (l.lineTotalPaise ?? 0), 0)
      : subtotalPaise;

    return {
      code: coupon.code,
      applied: true,
      discountPaise: discountFor(coupon.type).calculate(eligiblePaise, coupon),
    };
  }
}

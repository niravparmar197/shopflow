import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, QueryFilter, Types } from 'mongoose';
import { ProductsService } from '../products/products.service';
import type { ListReviewsQuery, WriteReviewDto } from './dto/review.dto';
import { PurchaseCheckClient } from './purchase-check.client';
import { Review } from './review.schema';

type StoredReview = Review & { _id: Types.ObjectId };

const MONGO_DUPLICATE_KEY = 11000;

/** The public shape: no user id. Every review is from a verified buyer. */
export const toReviewResponse = (r: StoredReview) => ({
  id: String(r._id),
  rating: r.rating,
  title: r.title,
  body: r.body,
  authorName: r.authorName,
  verifiedPurchase: true,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const encodeCursor = (r: StoredReview) =>
  Buffer.from(
    JSON.stringify({ t: r.createdAt.toISOString(), id: String(r._id) }),
  ).toString('base64url');

function afterCursor(raw: string): QueryFilter<Review> {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as {
      t?: string;
      id?: string;
    };
    const t = new Date(c.t ?? '');
    if (Number.isNaN(t.getTime()) || !isValidObjectId(c.id)) throw new Error();
    const id = new Types.ObjectId(c.id);
    return {
      $or: [{ createdAt: { $lt: t } }, { createdAt: t, _id: { $lt: id } }],
    };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel(Review.name) private readonly model: Model<Review>,
    private readonly products: ProductsService,
    private readonly purchases: PurchaseCheckClient,
  ) {}

  /** Newest first, cursor paging. The first page also has the summary. */
  async list(productId: string, q: ListReviewsQuery) {
    await this.products.findOne(productId); // 404 for an unknown product
    const filter: QueryFilter<Review> = { productId };
    if (q.cursor) Object.assign(filter, afterCursor(q.cursor));

    const rows = await this.model
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(q.limit + 1)
      .lean<StoredReview[]>();
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return {
      items: page.map(toReviewResponse),
      nextCursor: hasMore ? encodeCursor(page.at(-1)!) : null,
      ...(q.cursor ? {} : { summary: await this.summary(productId) }),
    };
  }

  /** Average, count and how many reviews gave each star. */
  private async summary(productId: string) {
    const rows = await this.model.aggregate<{ _id: number; n: number }>([
      { $match: { productId } },
      { $group: { _id: '$rating', n: { $sum: 1 } } },
    ]);
    const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>;
    for (const r of rows) stars[r._id] = r.n;
    const count = rows.reduce((a, r) => a + r.n, 0);
    const sum = rows.reduce((a, r) => a + r._id * r.n, 0);
    return {
      ratingAvg: count ? Math.round((sum / count) * 10) / 10 : 0,
      ratingCount: count,
      stars,
    };
  }

  async mine(productId: string, userId: string) {
    const review = await this.model
      .findOne({ productId, userId })
      .lean<StoredReview>();
    if (!review) {
      throw new NotFoundException({
        code: 'REVIEW_NOT_FOUND',
        message: 'You have not reviewed this product',
      });
    }
    return toReviewResponse(review);
  }

  /** Creates or edits the caller's review. Only for customers who got it. */
  async write(productId: string, userId: string, dto: WriteReviewDto) {
    await this.products.findOne(productId); // 404 for an unknown product
    if (!(await this.purchases.hasReceived(userId, productId))) {
      throw new ForbiddenException({
        code: 'NOT_A_BUYER',
        message: 'Only customers who received this product can review it',
      });
    }

    const save = () =>
      this.model
        .findOneAndUpdate(
          { productId, userId },
          {
            $set: {
              rating: dto.rating,
              title: dto.title ?? '',
              body: dto.body,
              authorName: dto.authorName,
            },
          },
          { upsert: true, returnDocument: 'before', runValidators: true },
        )
        .lean<StoredReview>();

    let before: StoredReview | null;
    try {
      before = await save();
    } catch (err) {
      // Two first reviews at the same moment: both tried to insert, the
      // unique index let one win. Ours is now an edit of that one.
      if ((err as { code?: number }).code !== MONGO_DUPLICATE_KEY) throw err;
      before = await save();
    }

    // Move the product's totals by the difference (atomic $inc).
    await this.products.adjustRating(
      productId,
      dto.rating - (before?.rating ?? 0),
      before ? 0 : 1,
    );
    return toReviewResponse(
      (await this.model.findOne({ productId, userId }).lean<StoredReview>())!,
    );
  }

  async remove(productId: string, userId: string) {
    const removed = await this.model
      .findOneAndDelete({ productId, userId })
      .lean<StoredReview>();
    if (!removed) {
      throw new NotFoundException({
        code: 'REVIEW_NOT_FOUND',
        message: 'You have not reviewed this product',
      });
    }
    await this.products.adjustRating(productId, -removed.rating, -1);
  }
}

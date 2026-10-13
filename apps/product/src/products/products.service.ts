import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { isValidObjectId, Model, QueryFilter, Types } from 'mongoose';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import { UpdateProductDto } from './dto/update-product.dto';
import { CacheService } from '@app/common';
import { Product } from './product.schema';

const MONGO_DUPLICATE_KEY = 11000;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const MAX_LIMIT = 50;
const MAX_IDS = 100;
export const MAX_IMAGES = 8;

const PRODUCT_TTL_SEC = 300; // single products
const LIST_TTL_SEC = 60; // lists change more often
const NOT_FOUND_TTL_SEC = 30;
const LIST_VERSION = 'products:list';
const productKey = (idOrSlug: string) => `product:v1:${idOrSlug.toLowerCase()}`;

type ProductRecord = Product & { _id: Types.ObjectId };
type NormalizedListQuery = Omit<ListProductsQuery, 'limit'> & {
  limit: number;
};

// Opaque to clients: where the previous page ended (createdAt + _id tie-breaker).
interface Cursor {
  t: string;
  id: string;
}

const encodeCursor = (c: Cursor) =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): { createdAt: Date; id: Types.ObjectId } {
  try {
    const c = JSON.parse(
      Buffer.from(raw, 'base64url').toString(),
    ) as Partial<Cursor>;
    const createdAt = new Date(c.t ?? '');
    if (Number.isNaN(createdAt.getTime()) || !isValidObjectId(c.id)) {
      throw new Error('bad cursor');
    }
    return { createdAt, id: new Types.ObjectId(c.id) };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

const isDuplicateKey = (err: unknown) =>
  (err as { code?: number } | null)?.code === MONGO_DUPLICATE_KEY;

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private readonly model: Model<Product>,
    private readonly cache: CacheService,
  ) {}

  async create(dto: CreateProductDto) {
    let created: ProductRecord;
    try {
      created = (await this.model.create(dto)).toObject();
    } catch (err) {
      // The unique index on slug is the real guard against duplicates.
      if (isDuplicateKey(err)) {
        throw new ConflictException('Slug already exists');
      }
      throw err;
    }
    // Also clears a cached "not found" for this slug.
    await this.invalidate([created._id, created.slug]);
    return created;
  }

  async findOne(idOrSlug: string) {
    const key = idOrSlug.toLowerCase();
    const product = await this.cache.getOrSet(
      productKey(key),
      PRODUCT_TTL_SEC,
      () => this.findOneFromDb(key),
      { negativeTtlSec: NOT_FOUND_TTL_SEC },
    );
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private findOneFromDb(idOrSlug: string) {
    const filter = OBJECT_ID.test(idOrSlug)
      ? { _id: idOrSlug }
      : { slug: idOrSlug };
    return this.model.findOne({ ...filter, isActive: true }).lean();
  }

  async list(q: ListProductsQuery) {
    // gRPC callers skip the HTTP validation pipe, so enforce the cap here too.
    // Built in a fixed field order so equal queries share one cache key.
    const query: NormalizedListQuery = {
      category: q.category?.toLowerCase(),
      minPrice: q.minPrice,
      maxPrice: q.maxPrice,
      q: q.q,
      cursor: q.cursor,
      limit: Math.min(Math.max(Math.trunc(q.limit) || 20, 1), MAX_LIMIT),
    };
    const version = await this.cache.getVersion(LIST_VERSION);
    const hash = createHash('sha1').update(JSON.stringify(query)).digest('hex');
    const result = await this.cache.getOrSet(
      `products:list:v${version}:${hash}`,
      LIST_TTL_SEC,
      () => this.listFromDb(query),
    );
    return result!; // the loader never returns null
  }

  private async listFromDb(q: NormalizedListQuery) {
    const filter: QueryFilter<Product> = { isActive: true };
    if (q.category) filter.category = q.category;
    if (q.minPrice !== undefined || q.maxPrice !== undefined) {
      filter.pricePaise = {
        ...(q.minPrice !== undefined && { $gte: q.minPrice }),
        ...(q.maxPrice !== undefined && { $lte: q.maxPrice }),
      };
    }
    if (q.q) filter.$text = { $search: q.q };

    // Cursor pagination: "items older than the last one I saw". Unlike
    // ?page=N it doesn't skip rows and doesn't shift when products are added.
    if (q.cursor) {
      const { createdAt, id } = decodeCursor(q.cursor);
      filter.$or = [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: id } }, // same timestamp: break the tie by _id
      ];
    }

    const items = await this.model
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(q.limit + 1) // one extra tells us whether there is a next page
      .lean();

    const hasMore = items.length > q.limit;
    const page = hasMore ? items.slice(0, q.limit) : items;
    const last = page.at(-1);

    return {
      items: page,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              t: last.createdAt.toISOString(),
              id: String(last._id),
            })
          : null,
    };
  }

  /** Active products among the given ids; unknown or invalid ids are skipped. */
  async findByIds(ids: string[]) {
    if (ids.length > MAX_IDS) {
      throw new BadRequestException(`At most ${MAX_IDS} ids per request`);
    }
    const valid = ids.filter((id) => OBJECT_ID.test(id));
    if (valid.length === 0) return [];
    return this.model.find({ _id: { $in: valid }, isActive: true }).lean();
  }

  async update(id: Types.ObjectId, dto: UpdateProductDto) {
    const { version, ...changes } = dto;
    let before: ProductRecord | null;
    try {
      // Optimistic lock: only matches if nobody updated it since the client
      // read it. The old document tells us which slug key to clear if the
      // slug changes.
      before = await this.model
        .findOneAndUpdate(
          { _id: id, version },
          { $set: changes, $inc: { version: 1 } },
          { returnDocument: 'before', runValidators: true },
        )
        .lean();
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new ConflictException('Slug already exists');
      }
      throw err;
    }

    if (!before) {
      if (!(await this.model.exists({ _id: id }))) {
        throw new NotFoundException('Product not found');
      }
      throw new ConflictException(
        'Product was changed by someone else. Reload and try again.',
      );
    }

    const updated = (await this.model.findById(id).lean())!;
    await this.invalidate([id, before.slug, updated.slug]);
    return updated;
  }

  /** Attaches an uploaded image key, keeping the per-product limit. */
  async addImage(productId: string, key: string) {
    // One atomic update: "images.7 doesn't exist" means fewer than 8 images,
    // so two uploads confirmed at the same time can't push it past the limit.
    const updated = await this.model
      .findOneAndUpdate(
        {
          _id: productId,
          [`images.${MAX_IMAGES - 1}`]: { $exists: false },
        },
        { $addToSet: { images: key }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .lean();

    if (!updated) {
      if (!(await this.model.exists({ _id: productId }))) {
        throw new NotFoundException('Product not found');
      }
      throw new BadRequestException(`Maximum ${MAX_IMAGES} images per product`);
    }
    await this.invalidate([updated._id, updated.slug]); // readers see it at once
    return updated;
  }

  // Always after the DB write. Deleting first would let a concurrent read put
  // the old value back before the write lands. Deleting (not updating) the
  // keys means two writers can't leave the wrong value behind.
  private async invalidate(idsAndSlugs: unknown[]) {
    const keys = new Set(idsAndSlugs.map((k) => productKey(String(k))));
    await this.cache.del(...keys);
    await this.cache.bumpVersion(LIST_VERSION); // every cached list is now old
  }
}

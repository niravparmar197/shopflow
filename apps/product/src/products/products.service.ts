import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, QueryFilter, Types } from 'mongoose';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './product.schema';

const MONGO_DUPLICATE_KEY = 11000;
const OBJECT_ID = /^[a-f\d]{24}$/i;

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
  ) {}

  async create(dto: CreateProductDto) {
    try {
      return (await this.model.create(dto)).toObject();
    } catch (err) {
      // The unique index on slug is the real guard against duplicates.
      if (isDuplicateKey(err)) {
        throw new ConflictException('Slug already exists');
      }
      throw err;
    }
  }

  async findOne(idOrSlug: string) {
    const filter = OBJECT_ID.test(idOrSlug)
      ? { _id: idOrSlug }
      : { slug: idOrSlug.toLowerCase() };
    const product = await this.model
      .findOne({ ...filter, isActive: true })
      .lean();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async list(q: ListProductsQuery) {
    const filter: QueryFilter<Product> = { isActive: true };
    if (q.category) filter.category = q.category.toLowerCase();
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

  async update(id: Types.ObjectId, dto: UpdateProductDto) {
    const { version, ...changes } = dto;
    try {
      // Optimistic lock: only matches if nobody updated it since the client read it.
      const updated = await this.model
        .findOneAndUpdate(
          { _id: id, version },
          { $set: changes, $inc: { version: 1 } },
          { returnDocument: 'after', runValidators: true },
        )
        .lean();
      if (updated) return updated;
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new ConflictException('Slug already exists');
      }
      throw err;
    }

    if (!(await this.model.exists({ _id: id }))) {
      throw new NotFoundException('Product not found');
    }
    throw new ConflictException(
      'Product was changed by someone else. Reload and try again.',
    );
  }
}

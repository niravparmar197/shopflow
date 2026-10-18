import { ApiProperty } from '@nestjs/swagger';

/** A product as stored (a lean Mongo document or .toObject()). */
export interface StoredProduct {
  _id: unknown;
  name: string;
  slug: string;
  description?: string;
  category: string;
  pricePaise: number;
  currency?: string;
  images?: string[];
  attributes?: Record<string, unknown>;
  isActive?: boolean;
  version?: number;
  createdAt: Date | string;
}

/**
 * One product as the API returns it. The SAME shape as the public catalog
 * (gateway, gRPC): `id`, and images as full URLs, never internal S3 keys.
 */
export class ProductResponseDto {
  @ApiProperty({ example: '6713a1f2c9e4b2a1d0f3e456' })
  id!: string;

  @ApiProperty({ example: 'OnePlus Nord CE 4 (8GB, 128GB)' })
  name!: string;

  @ApiProperty({ example: 'oneplus-nord-ce-4-8gb-128gb' })
  slug!: string;

  @ApiProperty({
    example: 'Snapdragon 7 Gen 3, 100W fast charging, 50MP camera.',
  })
  description!: string;

  @ApiProperty({ example: 'phones', description: 'Lowercase category' })
  category!: string;

  @ApiProperty({
    example: 2499900,
    description: 'Price in paise (2499900 = ₹24,999)',
  })
  pricePaise!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({
    type: [String],
    description: 'Full image URLs (the CDN / MinIO base + key)',
    example: [
      'http://localhost:9002/shopflow-products/products/6713a1f2c9e4b2a1d0f3e456/1.webp',
    ],
  })
  images!: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { ram: '8GB', storage: '128GB' },
    description: 'Free-form attributes per category',
  })
  attributes!: Record<string, unknown>;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({
    example: 3,
    description: 'Send this back on PATCH (optimistic lock)',
  })
  version!: number;

  @ApiProperty({ example: '2026-10-18T10:00:00.000Z' })
  createdAt!: string;
}

/** Stored product → API shape (same rules as the gRPC mapper). */
export const toProductResponse = (
  p: StoredProduct,
  assetBase: string,
): ProductResponseDto => ({
  id: String(p._id),
  name: p.name,
  slug: p.slug,
  description: p.description ?? '',
  category: p.category,
  pricePaise: p.pricePaise,
  currency: p.currency ?? 'INR',
  images: (p.images ?? []).map((key) => `${assetBase}/${key}`),
  attributes: p.attributes ?? {},
  isActive: p.isActive ?? true,
  version: p.version ?? 0,
  createdAt: new Date(p.createdAt).toISOString(),
});

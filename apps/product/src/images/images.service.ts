import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';
import { Env } from '@app/common';
import { MAX_IMAGES, ProductsService } from '../products/products.service';
import {
  IMAGE_TYPES,
  ImageType,
  MAX_IMAGE_BYTES,
  UploadUrlDto,
} from './dto/upload-url.dto';

const UPLOAD_URL_TTL_SEC = 300;

// What each allowed type must start with. The Content-Type of an upload is
// whatever the client claimed, so the bytes are checked too.
const looksLike: Record<ImageType, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const isImageType = (t: string | undefined): t is ImageType =>
  t !== undefined && t in IMAGE_TYPES;

/**
 * Product images. Browsers upload straight to S3 with a presigned POST, so
 * file bytes never pass through our servers. Uploads land in tmp/ (expired
 * by a bucket lifecycle rule) until confirmed.
 */
@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly products: ProductsService,
  ) {
    const endpoint = config.get('S3_ENDPOINT', { infer: true });
    this.bucket = config.getOrThrow('S3_BUCKET', { infer: true });
    // No credentials here: the SDK reads AWS_* env vars locally and the
    // IAM role on AWS.
    this.s3 = new S3Client({
      region: config.get('S3_REGION', { infer: true }),
      ...(endpoint && { endpoint, forcePathStyle: true }), // MinIO needs path-style URLs
    });
  }

  /** Step 1: a short-lived permission to upload one image of this type. */
  async createUploadUrl(productId: string, dto: UploadUrlDto) {
    const product = await this.products.findOne(productId); // 404 if missing
    if (product.images.length >= MAX_IMAGES) {
      throw new BadRequestException(`Maximum ${MAX_IMAGES} images per product`);
    }

    const key = `tmp/${productId}/${randomUUID()}.${IMAGE_TYPES[dto.contentType]}`;
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      // Enforced by S3 itself: bigger files or another type are rejected.
      Conditions: [
        ['content-length-range', 1, MAX_IMAGE_BYTES],
        ['eq', '$Content-Type', dto.contentType],
      ],
      Fields: { 'Content-Type': dto.contentType },
      Expires: UPLOAD_URL_TTL_SEC,
    });
    return { url, fields, key, expiresIn: UPLOAD_URL_TTL_SEC };
  }

  /** Step 3: check the stored file, move it to products/, attach it. */
  async confirm(productId: string, key: string) {
    if (!key.startsWith(`tmp/${productId}/`)) {
      throw new BadRequestException('Key does not belong to this product');
    }

    const head = await this.s3
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch((err: unknown) => {
        if (err instanceof NotFound) return null;
        throw err;
      });
    if (!head) throw new BadRequestException('Upload not found or expired');

    // Never trust the client: check what is really stored.
    const type = head.ContentType;
    const valid =
      isImageType(type) &&
      key.endsWith(`.${IMAGE_TYPES[type]}`) &&
      (head.ContentLength ?? 0) <= MAX_IMAGE_BYTES &&
      looksLike[type](await this.readStart(key));
    if (!valid) {
      await this.delete(key);
      throw new BadRequestException('Invalid image file');
    }

    const finalKey = key.replace(/^tmp\//, 'products/');
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${key}`,
        Key: finalKey,
        ContentType: type,
        // The name is unique per upload, so it can be cached forever.
        CacheControl: 'public, max-age=31536000, immutable',
        MetadataDirective: 'REPLACE',
      }),
    );

    try {
      const product = await this.products.addImage(productId, finalKey);
      this.logger.log({ productId, key: finalKey }, 'image confirmed');
      return product;
    } catch (err) {
      await this.delete(finalKey); // e.g. the 8-image limit was hit meanwhile
      throw err;
    } finally {
      await this.delete(key);
    }
  }

  private async readStart(key: string): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: 'bytes=0-11',
      }),
    );
    return Buffer.from((await res.Body?.transformToByteArray()) ?? []);
  }

  private async delete(key: string) {
    await this.s3
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch((err: unknown) =>
        this.logger.warn({ err, key }, 'image delete failed'),
      );
  }
}

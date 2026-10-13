import { BadRequestException } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { ImagesService } from './images.service';

const PNG = Buffer.from('89504e470d0a1a0a0000000d', 'hex');
const HTML = Buffer.from('<html><body>');

describe('ImagesService.confirm', () => {
  const productId = 'a'.repeat(24);
  const key = `tmp/${productId}/0b0e8a4c-63f5-4d1e-9a1b-1b2c3d4e5f60.png`;
  const finalKey = key.replace('tmp/', 'products/');

  const config = {
    get: jest.fn((k: string) => (k === 'S3_REGION' ? 'ap-south-1' : undefined)),
    getOrThrow: jest.fn(() => 'bucket'),
  };
  const products = { addImage: jest.fn(), findOne: jest.fn() };

  // Fake S3: answers HeadObject/GetObject with the given object, records calls.
  function build(object: { type: string; size: number; bytes: Buffer } | null) {
    const send = jest.fn((cmd: unknown) => {
      if (cmd instanceof HeadObjectCommand) {
        return object
          ? Promise.resolve({
              ContentType: object.type,
              ContentLength: object.size,
            })
          : Promise.reject(
              new NotFound({ message: 'NotFound', $metadata: {} }),
            );
      }
      if (cmd instanceof GetObjectCommand) {
        return Promise.resolve({
          Body: { transformToByteArray: () => Promise.resolve(object!.bytes) },
        });
      }
      return Promise.resolve({});
    });
    const svc = new ImagesService(config as any, products as any);
    (svc as any).s3 = { send };
    const sent = (type: new (...args: any[]) => unknown) =>
      send.mock.calls
        .map(([c]) => c as { input: { Key: string } })
        .filter((c) => c instanceof type)
        .map((c) => c.input.Key);
    return { svc, sent };
  }

  beforeEach(() => jest.clearAllMocks());

  it('rejects a key minted for another product', async () => {
    const { svc, sent } = build(null);
    await expect(
      svc.confirm(productId, `tmp/${'b'.repeat(24)}/x.png`),
    ).rejects.toThrow('Key does not belong to this product');
    expect(sent(HeadObjectCommand)).toEqual([]);
  });

  it('rejects when the upload does not exist', async () => {
    const { svc } = build(null);
    await expect(svc.confirm(productId, key)).rejects.toThrow(
      'Upload not found or expired',
    );
  });

  it('deletes and rejects a stored file of a type that is not allowed', async () => {
    const { svc, sent } = build({
      type: 'application/pdf',
      size: 100,
      bytes: PNG,
    });
    await expect(svc.confirm(productId, key)).rejects.toThrow(
      BadRequestException,
    );
    expect(sent(DeleteObjectCommand)).toEqual([key]);
    expect(products.addImage).not.toHaveBeenCalled();
  });

  it('deletes and rejects a file whose bytes are not the claimed image type', async () => {
    const { svc, sent } = build({ type: 'image/png', size: 100, bytes: HTML });
    await expect(svc.confirm(productId, key)).rejects.toThrow(
      'Invalid image file',
    );
    expect(sent(DeleteObjectCommand)).toEqual([key]);
    expect(sent(CopyObjectCommand)).toEqual([]);
  });

  it('moves a valid image to products/, attaches it, and removes the tmp file', async () => {
    products.addImage.mockResolvedValue({ images: [finalKey] });
    const { svc, sent } = build({ type: 'image/png', size: 100, bytes: PNG });

    await expect(svc.confirm(productId, key)).resolves.toEqual({
      images: [finalKey],
    });
    expect(sent(CopyObjectCommand)).toEqual([finalKey]);
    expect(products.addImage).toHaveBeenCalledWith(productId, finalKey);
    expect(sent(DeleteObjectCommand)).toEqual([key]);
  });

  it('removes the copied file when attaching fails (e.g. image limit)', async () => {
    products.addImage.mockRejectedValue(new BadRequestException('Maximum 8'));
    const { svc, sent } = build({ type: 'image/png', size: 100, bytes: PNG });

    await expect(svc.confirm(productId, key)).rejects.toThrow('Maximum 8');
    expect(sent(DeleteObjectCommand).sort()).toEqual([finalKey, key].sort());
  });
});

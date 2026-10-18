import { ApiProperty } from '@nestjs/swagger';

/** A presigned POST: send the file to `url` as multipart form data with `fields`. */
export class UploadUrlResponseDto {
  @ApiProperty({ example: 'http://localhost:9002/shopflow-products' })
  url!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Add these form fields BEFORE the file field',
    example: {
      key: 'tmp/6713a1f2c9e4b2a1d0f3e456/0b9c2f3e-8d1a-4c6b-9e7f-1a2b3c4d5e6f.webp',
      'Content-Type': 'image/webp',
      Policy: '…',
      'X-Amz-Signature': '…',
    },
  })
  fields!: Record<string, string>;

  @ApiProperty({
    example:
      'tmp/6713a1f2c9e4b2a1d0f3e456/0b9c2f3e-8d1a-4c6b-9e7f-1a2b3c4d5e6f.webp',
    description: 'Send this key to /confirm after the upload',
  })
  key!: string;

  @ApiProperty({ example: 300, description: 'Seconds the URL stays valid' })
  expiresIn!: number;
}

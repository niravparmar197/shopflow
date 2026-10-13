import { IsIn, IsInt, Max, Min } from 'class-validator';

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type ImageType = keyof typeof IMAGE_TYPES;
export const ALLOWED_TYPES = Object.keys(IMAGE_TYPES) as ImageType[];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export class UploadUrlDto {
  @IsIn(ALLOWED_TYPES)
  contentType!: ImageType;

  // Lets us refuse early; S3 itself enforces the real limit on upload.
  @IsInt()
  @Min(1)
  @Max(MAX_IMAGE_BYTES)
  sizeBytes!: number;
}

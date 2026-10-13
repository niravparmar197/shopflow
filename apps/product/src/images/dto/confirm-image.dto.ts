import { IsString, Matches } from 'class-validator';

export class ConfirmImageDto {
  // Exactly the shape upload-url hands out: tmp/<productId>/<uuid>.<ext>
  @IsString()
  @Matches(/^tmp\/[a-f0-9]{24}\/[a-f0-9-]{36}\.(jpg|png|webp)$/, {
    message: 'key must be a key returned by upload-url',
  })
  key!: string;
}

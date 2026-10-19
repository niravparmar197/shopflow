import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/** A delivery address in India. */
export class CreateAddressDto {
  /** Who receives the parcel */
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  fullName!: string;

  /** 10-digit Indian mobile number (spaces, +91 or a leading 0 are removed) */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '')
      : value,
  )
  @Matches(/^[6-9]\d{9}$/, {
    message: 'phone must be a 10-digit mobile number',
  })
  phone!: string;

  /** House / flat, building, street */
  @Transform(trim)
  @IsString()
  @Length(3, 200)
  line1!: string;

  /** Area, landmark (optional) */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 200)
  line2?: string;

  @Transform(trim)
  @IsString()
  @Length(2, 100)
  city!: string;

  @Transform(trim)
  @IsString()
  @Length(2, 100)
  state!: string;

  /** 6-digit PIN code */
  @Transform(trim)
  @Matches(/^[1-9]\d{5}$/, { message: 'pincode must be 6 digits' })
  pincode!: string;

  /** Use this address by default (the first address always is) */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto extends PartialType(CreateAddressDto) {}

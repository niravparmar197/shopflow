import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/**
 * Where the order goes. The order keeps this COPY (a snapshot, like the
 * prices): later edits to the address book never change a placed order.
 * Same rules as the user service's address book.
 */
export class ShippingAddressDto {
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  fullName!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '')
      : value,
  )
  @Matches(/^[6-9]\d{9}$/, {
    message: 'phone must be a 10-digit mobile number',
  })
  phone!: string;

  @Transform(trim)
  @IsString()
  @Length(3, 200)
  line1!: string;

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

  @Transform(trim)
  @Matches(/^[1-9]\d{5}$/, { message: 'pincode must be 6 digits' })
  pincode!: string;
}

export type ShippingAddress = {
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
};

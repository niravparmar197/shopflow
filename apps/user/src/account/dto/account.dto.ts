import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsNewPassword } from '../../auth/dto/password';
import { normaliseEmail, trim } from '../../auth/dto/transforms';

/** A one-time token from an email link (base64url, 43 chars). */
const IsLinkToken = () => applyDecorators(IsString(), Length(20, 200));

export class ForgotPasswordDto {
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  /** The token from the reset link */
  @IsLinkToken()
  token!: string;

  @IsNewPassword()
  password!: string;
}

export class VerifyEmailDto {
  /** The token from the verify link */
  @IsLinkToken()
  token!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(72)
  currentPassword!: string;

  @IsNewPassword()
  newPassword!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  fullName?: string;

  /** 10-digit Indian mobile; null or "" removes it (IsOptional skips null) */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === '' || value === null) return null;
    return typeof value === 'string'
      ? value.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '')
      : value;
  })
  @Matches(/^[6-9]\d{9}$/, {
    message: 'phone must be a 10-digit mobile number',
  })
  phone?: string | null;
}

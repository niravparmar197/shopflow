import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';
import { IsNewPassword } from './password';
import { normaliseEmail, trim } from './transforms';

export class SignupDto {
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsNewPassword()
  password!: string;

  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;
}

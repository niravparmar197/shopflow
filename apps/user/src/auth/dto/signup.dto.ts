import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';
import { normaliseEmail, trim } from './transforms';

export class SignupDto {
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(8, 72) // bcrypt only uses the first 72 bytes
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'password must contain at least one letter and one number',
  })
  password!: string;

  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;
}

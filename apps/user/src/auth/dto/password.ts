import { applyDecorators } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';

/** The one password rule: signup, reset and change all use it. */
export const IsNewPassword = () =>
  applyDecorators(
    IsString(),
    Length(8, 72), // bcrypt only uses the first 72 bytes
    Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
      message: 'password must contain at least one letter and one number',
    }),
  );

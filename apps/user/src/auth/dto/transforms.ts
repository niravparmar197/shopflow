import { TransformFnParams } from 'class-transformer';

// Only touch real strings, so a missing field stays missing and fails
// validation instead of becoming the string "undefined".
export const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const normaliseEmail = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

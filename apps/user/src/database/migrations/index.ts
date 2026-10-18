// Every migration, oldest first. The webpack bundle has no .ts files for a
// glob to find, so add each new migration class here when you generate it.
import { CreateUsersAndRefreshTokens1791875564338 } from './1791875564338-CreateUsersAndRefreshTokens';
import { AddRefreshTokenFamily1791878522479 } from './1791878522479-AddRefreshTokenFamily';
import { AddAddresses1792347866375 } from './1792347866375-AddAddresses';

export const MIGRATIONS = [
  CreateUsersAndRefreshTokens1791875564338,
  AddRefreshTokenFamily1791878522479,
  AddAddresses1792347866375,
];

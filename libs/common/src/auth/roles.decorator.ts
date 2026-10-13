import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Allows only users whose access token has one of these roles. Use with RolesGuard. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

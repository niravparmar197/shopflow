import cookieParser from 'cookie-parser';
import type { BootstrapOptions } from '@app/common';

// Shared by main.ts and the integration tests, so both run the same setup.
export const userAppOptions: BootstrapOptions = {
  globalPrefix: 'v1',
  swagger: { title: 'User & Auth' },
  configure: (app) => app.use(cookieParser()), // reads the refresh token cookie
};

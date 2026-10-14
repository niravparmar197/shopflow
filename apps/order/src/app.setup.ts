import type { BootstrapOptions } from '@app/common';

// Shared by main.ts and the integration tests, so both run the same setup.
export const orderAppOptions: BootstrapOptions = {
  globalPrefix: 'v1',
  swagger: { title: 'Orders & Cart' },
};

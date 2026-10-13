import type { BootstrapOptions } from '@app/common';

// Shared by main.ts and the integration tests, so both run the same setup.
export const paymentAppOptions: BootstrapOptions = {
  globalPrefix: 'v1',
  // Webhook signatures are computed over the exact bytes; re-serialised JSON
  // (spaces, key order) would not match. The parsed body is still available.
  rawBody: true,
};

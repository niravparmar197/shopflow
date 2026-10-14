// Every migration, oldest first. The webpack bundle has no .ts files for a
// glob to find, so add each new migration class here when you generate it.
import { InitPayments1791896196209 } from './1791896196209-InitPayments';
import { WebhooksRefunds1791898304787 } from './1791898304787-WebhooksRefunds';

export const MIGRATIONS = [
  InitPayments1791896196209,
  WebhooksRefunds1791898304787,
];

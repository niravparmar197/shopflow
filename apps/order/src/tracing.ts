// FIRST import in main.ts: patches http, pg, redis… before anything loads them.
import { startTracing } from '@app/observability';

startTracing('order');

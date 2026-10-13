/**
 * A message that can never succeed (not JSON, wrong shape, unknown version).
 * Retrying is useless, so it is skipped (Part 3: sent to a dead-letter topic).
 */
export class PoisonMessageError extends Error {}

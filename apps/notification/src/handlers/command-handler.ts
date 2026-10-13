/**
 * The RECEIVER side of the Command pattern: executes one kind of command
 * (picked by the job name). A new channel = a new command + a new handler;
 * the worker and the dispatcher don't change.
 */
export interface CommandHandler<P = unknown> {
  readonly jobName: string;
  execute(payload: P, key: string): Promise<void>;
}

export const COMMAND_HANDLERS = Symbol('COMMAND_HANDLERS');

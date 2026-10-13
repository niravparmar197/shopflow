export class InvalidSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
    this.name = 'InvalidSignatureError';
  }
}

import crypto from 'crypto';

export function generateInstanceId(): string {
  return `mob-${crypto.randomUUID()}`;
}

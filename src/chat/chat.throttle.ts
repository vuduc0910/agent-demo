import { minutes, seconds, ThrottlerModuleOptions } from '@nestjs/throttler';

const throttlers = [
  { name: 'burst', ttl: seconds(10), limit: 3 },
  { name: 'sustained', ttl: minutes(10), limit: 20 },
];

export const CHAT_THROTTLE: ThrottlerModuleOptions = {
  throttlers,
  generateKey: (_context, tracker, throttler) => `chat:${throttler}:${tracker}`,
  errorMessage:
    "You're sending messages too quickly. Please wait a moment and try again.",
};

export const SKIP_CHAT_THROTTLE = Object.fromEntries(
  throttlers.map((t) => [t.name, true]),
);

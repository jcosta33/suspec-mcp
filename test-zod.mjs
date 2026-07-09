import { z } from 'zod';

// Test: does z.object({}).passthrough() require the field or make it optional?
const schema = z.object({
  level: z.literal('clean'),
  value: z.object({}).passthrough(),
});

const withValue = { level: 'clean', value: {} };
const noValue = { level: 'clean' };

console.log('With value field:', schema.safeParse(withValue).success);
console.log('Without value field:', schema.safeParse(noValue).success);
console.log('Schema error for missing value:', schema.safeParse(noValue).error?.issues[0]?.message);

import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs a trivial assertion', () => {
    expect(1 + 1).toBe(2);
  });
});

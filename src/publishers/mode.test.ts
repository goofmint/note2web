import { describe, expect, it } from 'vitest';
import { GIT_MODE_SERVICES, isGitModeService } from './mode.js';

describe('isGitModeService', () => {
  it.each(GIT_MODE_SERVICES)('treats "%s" as git mode', (service) => {
    expect(isGitModeService(service)).toBe(true);
  });

  it.each(['qiita', 'devto', 'note', 'hatena'] as const)(
    'treats "%s" as API/CLI mode',
    (service) => {
      expect(isGitModeService(service)).toBe(false);
    },
  );
});

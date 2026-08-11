import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, formatTimestamp } from './logger.js';

describe('formatTimestamp', () => {
  it('formats a fixed instant in Asia/Tokyo regardless of the default timezone', () => {
    expect(formatTimestamp(new Date('2026-01-15T00:00:00Z'), 'Asia/Tokyo')).toBe(
      '2026-01-15T09:00:00+09:00',
    );
  });

  it('defaults to Asia/Tokyo when no timezone is given', () => {
    expect(formatTimestamp(new Date('2026-01-15T00:00:00Z'))).toBe('2026-01-15T09:00:00+09:00');
  });

  it('resolves the DST offset for America/New_York in summer (-04:00)', () => {
    expect(formatTimestamp(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(
      '2026-07-15T08:00:00-04:00',
    );
  });

  it('resolves the standard-time offset for America/New_York in winter (-05:00)', () => {
    expect(formatTimestamp(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(
      '2026-01-15T07:00:00-05:00',
    );
  });

  it('is deterministic and does not depend on the process TZ / locale', () => {
    const a = formatTimestamp(new Date('2026-03-01T03:04:05Z'), 'Asia/Tokyo');
    const b = formatTimestamp(new Date('2026-03-01T03:04:05Z'), 'Asia/Tokyo');
    expect(a).toBe(b);
    expect(a).toBe('2026-03-01T12:04:05+09:00');
  });
});

describe('createLogger', () => {
  const fixedDate = new Date('2026-08-11T00:00:00Z'); // 2026-08-11T09:00:00+09:00
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  function lastStdoutEvent(): unknown {
    const calls = stdoutSpy.mock.calls;
    const lastCall = calls[calls.length - 1];
    if (lastCall === undefined) {
      throw new Error('process.stdout.write was not called');
    }
    return JSON.parse(String(lastCall[0]).trim());
  }

  it('writes run_start with ts/level/event and no other fields', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.runStart();

    const event = lastStdoutEvent();
    expect(event).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'run_start',
    });
  });

  it('writes run_end with the published/skipped/failed summary', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.runEnd({ published: 3, skipped: 1, failed: 2 });

    const event = lastStdoutEvent();
    expect(event).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'run_end',
      published: 3,
      skipped: 1,
      failed: 2,
    });
  });

  it('writes export_done with noteCount', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.exportDone({ noteCount: 42 });

    expect(lastStdoutEvent()).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'export_done',
      noteCount: 42,
    });
  });

  it('writes note_published with service/noteUuid/title/result/url', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.notePublished({
      service: 'zenn',
      noteUuid: '5c1c-uuid',
      title: 'Hello',
      result: 'updated',
      url: 'https://example.com/hello',
    });

    expect(lastStdoutEvent()).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'note_published',
      service: 'zenn',
      noteUuid: '5c1c-uuid',
      title: 'Hello',
      result: 'updated',
      url: 'https://example.com/hello',
    });
  });

  it('writes note_published without url when omitted', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.notePublished({
      service: 'qiita',
      noteUuid: 'uuid-2',
      title: 'No URL',
      result: 'created',
    });

    const event = lastStdoutEvent() as Record<string, unknown>;
    expect(event.url).toBeUndefined();
    expect(event.result).toBe('created');
  });

  it('writes note_skipped with service/noteUuid/title', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.noteSkipped({ service: 'devto', noteUuid: 'uuid-3', title: 'Skipped' });

    expect(lastStdoutEvent()).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'note_skipped',
      service: 'devto',
      noteUuid: 'uuid-3',
      title: 'Skipped',
    });
  });

  it('writes note_failed with error', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.noteFailed({
      service: 'hatena',
      noteUuid: 'uuid-4',
      title: 'Failed',
      error: 'network error',
    });

    expect(lastStdoutEvent()).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'note_failed',
      service: 'hatena',
      noteUuid: 'uuid-4',
      title: 'Failed',
      error: 'network error',
    });
  });

  it('writes asset_uploaded with service/assetHash/key/url', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.assetUploaded({
      service: 'zenn',
      assetHash: 'sha256:abc',
      key: 'images/abc.png',
      url: 'https://example.com/abc.png',
    });

    expect(lastStdoutEvent()).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'asset_uploaded',
      service: 'zenn',
      assetHash: 'sha256:abc',
      key: 'images/abc.png',
      url: 'https://example.com/abc.png',
    });
  });

  it('writes warn at level=warn with message and optional tags', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.warn({
      message: 'tag truncated',
      service: 'qiita',
      noteUuid: 'uuid-5',
      title: 'Warned',
    });

    expect(lastStdoutEvent()).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'warn',
      event: 'warn',
      message: 'tag truncated',
      service: 'qiita',
      noteUuid: 'uuid-5',
      title: 'Warned',
    });
  });

  it('writes warn without the optional service/noteUuid/title', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.warn({ message: 'unsupported element rendered as text' });

    expect(lastStdoutEvent()).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'warn',
      event: 'warn',
      message: 'unsupported element rendered as text',
    });
  });

  it('emits every event type to stdout', () => {
    const logger = createLogger({ now: () => fixedDate });
    logger.runStart();
    logger.runEnd({ published: 1, skipped: 0, failed: 0 });
    logger.exportDone({ noteCount: 1 });
    logger.notePublished({
      service: 'zenn',
      noteUuid: 'u1',
      title: 't1',
      result: 'created',
    });
    logger.noteSkipped({ service: 'zenn', noteUuid: 'u2', title: 't2' });
    logger.noteFailed({ service: 'zenn', noteUuid: 'u3', title: 't3', error: 'e' });
    logger.assetUploaded({ service: 'zenn', assetHash: 'h', key: 'k' });
    logger.warn({ message: 'm' });

    expect(stdoutSpy).toHaveBeenCalledTimes(8);
    const events = stdoutSpy.mock.calls.map(
      (call: Parameters<typeof process.stdout.write>) =>
        (JSON.parse(String(call[0]).trim()) as { event: string }).event,
    );
    expect(events).toEqual([
      'run_start',
      'run_end',
      'export_done',
      'note_published',
      'note_skipped',
      'note_failed',
      'asset_uploaded',
      'warn',
    ]);
  });
});

describe('createLogger file output', () => {
  let dir: string;
  let filePath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-logger-test-'));
    filePath = join(dir, 'log.jsonl');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends each emitted line to the file when file is configured', () => {
    const fixedDate = new Date('2026-08-11T00:00:00Z');
    const logger = createLogger({ file: filePath, now: () => fixedDate });

    logger.runStart();
    logger.exportDone({ noteCount: 2 });

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'run_start',
    });
    expect(JSON.parse(lines[1]!)).toEqual({
      ts: '2026-08-11T09:00:00+09:00',
      level: 'info',
      event: 'export_done',
      noteCount: 2,
    });
  });

  it('preserves existing file content and appends after it', () => {
    writeFileSync(filePath, '{"existing":true}\n');
    const logger = createLogger({ file: filePath, now: () => new Date('2026-08-11T00:00:00Z') });

    logger.runStart();

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ existing: true });
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: 'run_start' });
  });

  it('keeps JSON Lines integrity when the existing file lacks a trailing newline', () => {
    writeFileSync(filePath, '{"existing":true}');
    const logger = createLogger({ file: filePath, now: () => new Date('2026-08-11T00:00:00Z') });

    logger.runStart();

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ existing: true });
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: 'run_start' });
  });

  it('does not create a file when file is not configured', () => {
    const logger = createLogger({ now: () => new Date('2026-08-11T00:00:00Z') });
    logger.runStart();

    expect(existsSync(filePath)).toBe(false);
  });

  it('still writes to stdout when file is configured', () => {
    const logger = createLogger({ file: filePath, now: () => new Date('2026-08-11T00:00:00Z') });
    logger.runStart();

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });
});

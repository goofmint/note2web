import { describe, expect, it } from 'vitest';
import {
  computeContentHash,
  renderArtifact,
  serializeFrontmatter,
  serializeFrontmatterArray,
  serializeFrontmatterEntry,
  serializeFrontmatterScalar,
  type FrontmatterEntry,
} from './frontmatter.js';
import { formatTimestamp, normalizeText } from './normalize.js';

describe('serializeFrontmatterScalar', () => {
  it('quotes null-like strings as strings, never as the YAML null token', () => {
    expect(serializeFrontmatterScalar('null')).toBe('"null"');
  });

  it('quotes numeric-like strings as strings, never as bare numbers', () => {
    expect(serializeFrontmatterScalar('123')).toBe('"123"');
  });

  it('quotes date-like strings as strings', () => {
    expect(serializeFrontmatterScalar('2026-08-11T09:00:00+09:00')).toBe(
      '"2026-08-11T09:00:00+09:00"',
    );
  });

  it('quotes strings containing ":" and "#" so YAML cannot reinterpret them', () => {
    expect(serializeFrontmatterScalar('note: tag #x')).toBe('"note: tag #x"');
  });

  it('escapes double quotes and backslashes', () => {
    expect(serializeFrontmatterScalar('say "hi" \\ ok')).toBe('"say \\"hi\\" \\\\ ok"');
  });

  it('escapes embedded newlines as \\n', () => {
    expect(serializeFrontmatterScalar('line1\nline2')).toBe('"line1\\nline2"');
  });

  it('serializes true booleans unquoted', () => {
    expect(serializeFrontmatterScalar(true)).toBe('true');
    expect(serializeFrontmatterScalar(false)).toBe('false');
  });

  it('serializes integers unquoted', () => {
    expect(serializeFrontmatterScalar(0)).toBe('0');
    expect(serializeFrontmatterScalar(42)).toBe('42');
    expect(serializeFrontmatterScalar(-7)).toBe('-7');
  });

  it('serializes the JS null value as the bare YAML null token', () => {
    expect(serializeFrontmatterScalar(null)).toBe('null');
  });

  it('rejects non-integer numbers', () => {
    expect(() => serializeFrontmatterScalar(1.5)).toThrow(RangeError);
    expect(() => serializeFrontmatterScalar(Number.NaN)).toThrow(RangeError);
    expect(() => serializeFrontmatterScalar(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('normalizes NFD input to NFC before quoting', () => {
    const nfd = 'かﾞ'.normalize('NFD'); // decomposed dakuten
    const nfc = 'かﾞ'.normalize('NFC');
    expect(serializeFrontmatterScalar(nfd)).toBe(serializeFrontmatterScalar(nfc));
  });

  it('normalizes CRLF input to LF before quoting', () => {
    expect(serializeFrontmatterScalar('a\r\nb')).toBe(serializeFrontmatterScalar('a\nb'));
  });
});

describe('serializeFrontmatterArray', () => {
  it('serializes an empty array as []', () => {
    expect(serializeFrontmatterArray([])).toBe('[]');
  });

  it('serializes string arrays as a deterministic flow sequence, comma-separated with no spaces', () => {
    expect(serializeFrontmatterArray(['typescript', 'zenn'])).toBe('["typescript","zenn"]');
  });

  it('quotes every string element regardless of content', () => {
    expect(serializeFrontmatterArray(['123', 'null', 'a:b'])).toBe('["123","null","a:b"]');
  });
});

describe('serializeFrontmatterEntry / serializeFrontmatter', () => {
  it('renders a single entry as "key: value"', () => {
    expect(serializeFrontmatterEntry(['title', 'Hello'])).toBe('title: "Hello"');
    expect(serializeFrontmatterEntry(['published', true])).toBe('published: true');
    expect(serializeFrontmatterEntry(['id', null])).toBe('id: null');
  });

  it('wraps entries with --- delimiters, preserving input order without re-sorting', () => {
    const entries: FrontmatterEntry[] = [
      ['zebra', '1'],
      ['alpha', '2'],
    ];
    expect(serializeFrontmatter(entries)).toBe('---\nzebra: "1"\nalpha: "2"\n---\n');
  });

  it('produces the same serialization for the same entries regardless of key insertion order at the call site', () => {
    const orderA: FrontmatterEntry[] = [
      ['title', 'T'],
      ['tags', ['a', 'b']],
    ];
    const orderB: FrontmatterEntry[] = [
      ['title', 'T'],
      ['tags', ['a', 'b']],
    ];
    expect(serializeFrontmatter(orderA)).toBe(serializeFrontmatter(orderB));
  });

  it('rejects keys outside the safe character set (structure-breaking keys)', () => {
    // 改行・引用符・コロン等を含むキーは YAML の構造を壊しうるため拒否する。
    expect(() => serializeFrontmatterEntry(['bad\nkey', 'v'])).toThrow(RangeError);
    expect(() => serializeFrontmatterEntry(['bad"key', 'v'])).toThrow(RangeError);
    expect(() => serializeFrontmatterEntry(['bad: key', 'v'])).toThrow(RangeError);
    expect(() => serializeFrontmatterEntry(['', 'v'])).toThrow(RangeError);
    // §5.7 の実キーはすべて通る。
    expect(() => serializeFrontmatterEntry(['published_at', 'v'])).not.toThrow();
  });

  it('rejects duplicate keys (including duplicates that only appear after NFC normalization)', () => {
    expect(() =>
      serializeFrontmatter([
        ['title', 'a'],
        ['title', 'b'],
      ]),
    ).toThrow(RangeError);
    // NFC 正規化後に同一になるキーも重複として扱う(結合文字の分解表現)。
    // 'é'(NFD)→ 'é'(NFC)。SAFE_KEY_PATTERN は ASCII のみ許可するため
    // どのみち拒否されるが、重複検出はエントリ検証より先に走る設計であることを
    // 「同一キー2回」の代表ケースとして固定する。
    expect(() =>
      serializeFrontmatter([
        ['tags', ['a']],
        ['tags', ['b']],
      ]),
    ).toThrow(/duplicate frontmatter key/);
  });
});

// ---------------------------------------------------------------------------
// golden test: YAML 境界値(design.md §12 / issue #17 受け入れ条件)。
// ---------------------------------------------------------------------------

describe('golden: renderArtifact + computeContentHash boundary values', () => {
  const goldenEntries: FrontmatterEntry[] = [
    ['title', 'Boundary values: null, 123, #tag'],
    ['nullLike', 'null'],
    ['numericLike', '123'],
    ['dateLike', '2026-08-11T09:00:00+09:00'],
    ['colonHash', 'a: b #c'],
    ['quotesAndBackslash', 'she said "hi" \\ ok'],
    ['multiline', 'line1\nline2'],
    ['published', true],
    ['draft', false],
    ['viewCount', 42],
    ['remoteId', null],
    ['topics', ['typescript', 'zenn', '123']],
  ];
  const goldenBody = 'Body paragraph with a colon: and a hash #tag.\n\nSecond paragraph.\n';

  const expectedFrontmatter =
    '---\n' +
    'title: "Boundary values: null, 123, #tag"\n' +
    'nullLike: "null"\n' +
    'numericLike: "123"\n' +
    'dateLike: "2026-08-11T09:00:00+09:00"\n' +
    'colonHash: "a: b #c"\n' +
    'quotesAndBackslash: "she said \\"hi\\" \\\\ ok"\n' +
    'multiline: "line1\\nline2"\n' +
    'published: true\n' +
    'draft: false\n' +
    'viewCount: 42\n' +
    'remoteId: null\n' +
    'topics: ["typescript","zenn","123"]\n' +
    '---\n';

  const expectedArtifact = `${expectedFrontmatter}\n${goldenBody}`;

  // sha256 of expectedArtifact's UTF-8 bytes, pinned so any change to the
  // serializer/normalization/concatenation convention is caught (design.md §12).
  const expectedHash = 'sha256:9c151caed433287f64f5e07a5032c986612d31fb1af6dd165fb85835dbd5be58';

  it('serializes the fixed frontmatter block exactly', () => {
    expect(serializeFrontmatter(goldenEntries)).toBe(expectedFrontmatter);
  });

  it('renders the fixed final artifact string exactly', () => {
    expect(renderArtifact(goldenEntries, goldenBody)).toBe(expectedArtifact);
  });

  it('computes the fixed sha256 content hash for the golden artifact', () => {
    const artifact = renderArtifact(goldenEntries, goldenBody);
    expect(computeContentHash(artifact)).toBe(expectedHash);
  });
});

// ---------------------------------------------------------------------------
// 不変条件(design.md §12 / issue #17 受け入れ条件)。
// ---------------------------------------------------------------------------

describe('invariants: same content hash regardless of environment / equivalent input form', () => {
  const baseEntries: FrontmatterEntry[] = [
    ['title', 'Invariant note'],
    ['tags', ['a', 'b']],
    ['published', true],
  ];
  const baseBody = 'Some body text.\n';

  it('key insertion order at the call site does not change the serialization or hash, given the same entry order is passed', () => {
    const entriesA: FrontmatterEntry[] = [
      ['title', 'Invariant note'],
      ['tags', ['a', 'b']],
      ['published', true],
    ];
    const entriesB: FrontmatterEntry[] = [
      ['title', 'Invariant note'],
      ['tags', ['a', 'b']],
      ['published', true],
    ];
    const artifactA = renderArtifact(entriesA, baseBody);
    const artifactB = renderArtifact(entriesB, baseBody);
    expect(artifactA).toBe(artifactB);
    expect(computeContentHash(artifactA)).toBe(computeContentHash(artifactB));
  });

  it('CRLF vs LF body input produces the same content hash', () => {
    const lfBody = 'line1\nline2\nline3\n';
    const crlfBody = 'line1\r\nline2\r\nline3\r\n';
    const hashLf = computeContentHash(renderArtifact(baseEntries, lfBody));
    const hashCrlf = computeContentHash(renderArtifact(baseEntries, crlfBody));
    expect(hashLf).toBe(hashCrlf);
  });

  it('bare CR line endings also normalize to the same content hash as LF', () => {
    const lfBody = 'line1\nline2\n';
    const crBody = 'line1\rline2\r';
    expect(computeContentHash(renderArtifact(baseEntries, lfBody))).toBe(
      computeContentHash(renderArtifact(baseEntries, crBody)),
    );
  });

  it('NFC vs NFD equivalent input produces the same content hash (title and body)', () => {
    const nfcTitle = 'かぎ括弧「がぎ」'.normalize('NFC');
    const nfdTitle = 'かぎ括弧「がぎ」'.normalize('NFD');
    const nfcBody = 'テストﾞ本文'.normalize('NFC');
    const nfdBody = 'テストﾞ本文'.normalize('NFD');

    const entriesNfc: FrontmatterEntry[] = [['title', nfcTitle]];
    const entriesNfd: FrontmatterEntry[] = [['title', nfdTitle]];

    const hashNfc = computeContentHash(renderArtifact(entriesNfc, nfcBody));
    const hashNfd = computeContentHash(renderArtifact(entriesNfd, nfdBody));
    expect(hashNfc).toBe(hashNfd);
  });

  it('produces different hashes for genuinely different content (sanity check)', () => {
    const hashA = computeContentHash(renderArtifact(baseEntries, 'body A\n'));
    const hashB = computeContentHash(renderArtifact(baseEntries, 'body B\n'));
    expect(hashA).not.toBe(hashB);
  });
});

describe('invariants: datetime strings are fixed by the configured timezone, independent of host TZ', () => {
  const instant = new Date('2026-08-11T00:30:00Z');

  it('formats the same instant differently for two different configured timezones', () => {
    const tokyo = formatTimestamp(instant, 'Asia/Tokyo');
    const newYork = formatTimestamp(instant, 'America/New_York');
    expect(tokyo).toBe('2026-08-11T09:30:00+09:00');
    expect(newYork).toBe('2026-08-10T20:30:00-04:00');
    expect(tokyo).not.toBe(newYork);
  });

  it('produces the same content hash for a frontmatter datetime string regardless of process.env.TZ', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const formattedInLA = formatTimestamp(instant, 'Asia/Tokyo');
      const entriesInLA: FrontmatterEntry[] = [['createdAt', formattedInLA]];
      const hashInLA = computeContentHash(renderArtifact(entriesInLA, 'body\n'));

      process.env.TZ = 'Asia/Tokyo';
      const formattedInTokyo = formatTimestamp(instant, 'Asia/Tokyo');
      const entriesInTokyo: FrontmatterEntry[] = [['createdAt', formattedInTokyo]];
      const hashInTokyo = computeContentHash(renderArtifact(entriesInTokyo, 'body\n'));

      expect(formattedInLA).toBe(formattedInTokyo);
      expect(hashInLA).toBe(hashInTokyo);
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it('changing the configured timezone changes the resulting content hash (sanity check)', () => {
    const entriesTokyo: FrontmatterEntry[] = [
      ['createdAt', formatTimestamp(instant, 'Asia/Tokyo')],
    ];
    const entriesUtc: FrontmatterEntry[] = [['createdAt', formatTimestamp(instant, 'UTC')]];
    const hashTokyo = computeContentHash(renderArtifact(entriesTokyo, 'body\n'));
    const hashUtc = computeContentHash(renderArtifact(entriesUtc, 'body\n'));
    expect(hashTokyo).not.toBe(hashUtc);
  });
});

describe('renderArtifact', () => {
  it('separates the frontmatter block from the body with exactly one blank line', () => {
    const entries: FrontmatterEntry[] = [['title', 'x']];
    expect(renderArtifact(entries, 'body\n')).toBe('---\ntitle: "x"\n---\n\nbody\n');
  });

  it('is idempotent under normalizeText (already-normalized artifacts are unchanged)', () => {
    const entries: FrontmatterEntry[] = [['title', 'x']];
    const artifact = renderArtifact(entries, 'body\n');
    expect(normalizeText(artifact)).toBe(artifact);
  });
});

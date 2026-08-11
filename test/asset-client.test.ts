import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createS3UploaderClient, type AssetsConfig } from '../src/assets/client.js';

const R2_ASSETS: AssetsConfig = {
  provider: 'r2',
  bucket: 'blog-assets',
  endpoint: 'https://example-account.r2.cloudflarestorage.com',
  region: 'auto',
  prefix: 'notes/',
  public_base_url: 'https://assets.example.com/notes/',
  access_key_id_env: 'NOTE2WEB_TEST_R2_ACCESS_KEY_ID',
  secret_access_key_env: 'NOTE2WEB_TEST_R2_SECRET_ACCESS_KEY',
};

const S3_ASSETS: AssetsConfig = {
  provider: 's3',
  bucket: 'blog-assets',
  region: 'us-east-1',
  public_base_url: 'https://assets.example.com/notes/',
  access_key_id_env: 'NOTE2WEB_TEST_S3_ACCESS_KEY_ID',
  secret_access_key_env: 'NOTE2WEB_TEST_S3_SECRET_ACCESS_KEY',
};

describe('createS3UploaderClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env[R2_ASSETS.access_key_id_env];
    delete process.env[R2_ASSETS.secret_access_key_env];
    delete process.env[S3_ASSETS.access_key_id_env];
    delete process.env[S3_ASSETS.secret_access_key_env];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when the access_key_id_env variable is not set (FR-30: never reads a literal)', () => {
    process.env[R2_ASSETS.secret_access_key_env] = 'secret';
    expect(() => createS3UploaderClient(R2_ASSETS)).toThrow(/NOTE2WEB_TEST_R2_ACCESS_KEY_ID/);
  });

  it('throws when the secret_access_key_env variable is not set', () => {
    process.env[R2_ASSETS.access_key_id_env] = 'key';
    expect(() => createS3UploaderClient(R2_ASSETS)).toThrow(/NOTE2WEB_TEST_R2_SECRET_ACCESS_KEY/);
  });

  it('builds a client exposing putObject for provider "r2" once both env vars are set', () => {
    process.env[R2_ASSETS.access_key_id_env] = 'key';
    process.env[R2_ASSETS.secret_access_key_env] = 'secret';

    const client = createS3UploaderClient(R2_ASSETS);

    expect(typeof client.putObject).toBe('function');
  });

  it('builds a client exposing putObject for provider "s3" once both env vars are set', () => {
    process.env[S3_ASSETS.access_key_id_env] = 'key';
    process.env[S3_ASSETS.secret_access_key_env] = 'secret';

    const client = createS3UploaderClient(S3_ASSETS);

    expect(typeof client.putObject).toBe('function');
  });
});

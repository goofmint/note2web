/**
 * S3 互換(R2 / S3)クライアント生成層(design.md §5.5「AssetUploader」、§7 の
 * `assets` 設定ブロック)。
 *
 * AssetUploader 本体(`uploader.ts`)から接続設定の詳細(R2 / S3 のクライアント
 * オプション差分・認証情報の取得元)を分離する。AssetUploader は本モジュールが
 * 返す最小限の `UploaderClient`(`putObject` のみ)だけを参照するため、テストでは
 * 実 `@aws-sdk/client-s3` を経由せず `vi.fn()` ベースの偽実装を注入できる
 * (`src/subprocess.ts` の `SubprocessRunner` / `src/transform/body.ts` の DI 慣習と
 * 同じパターン)。
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

/** `Config['assets']`(design.md §7)の別名。呼び出し側の import を短くするための再公開。 */
export type AssetsConfig = Config['assets'];

/** `UploaderClient.putObject` に渡すパラメータ。 */
export interface PutObjectParams {
  /** アップロード先バケット名(`assets.bucket`)。 */
  bucket: string;
  /** オブジェクトキー(`buildAssetKey` が組み立てたもの)。 */
  key: string;
  /** アップロードするファイル実体のバイト列。 */
  body: Buffer;
  /** 拡張子から推定した MIME タイプ。 */
  contentType: string;
}

/**
 * AssetUploader がアップロードに必要とする最小限のクライアントインターフェース。
 * 本番では `createS3UploaderClient` が返す実装を、テストでは `vi.fn()` ベースの
 * 偽実装を注入する。
 */
export interface UploaderClient {
  putObject(params: PutObjectParams): Promise<void>;
}

/** `assets.access_key_id_env` / `assets.secret_access_key_env` が指す環境変数の値を読む。 */
function requireEnv(envName: string): string {
  const value = process.env[envName];
  if (value === undefined || value === '') {
    // `config.ts` の `loadConfig` が `*_env` の存在チェックを既に行っているため、
    // 通常この分岐には到達しない。`createS3UploaderClient` を `loadConfig` を経由しない
    // 経路(テスト等)から呼んだ場合の防御として残す。
    throw new Error(`environment variable "${envName}" is not set`);
  }
  return value;
}

/**
 * `assets` 設定(design.md §7)から S3 互換クライアントを生成する。
 *
 * - `provider === 'r2'`: `endpoint` を設定し、`region` は設定値、無ければ `'auto'`
 *   を既定にし、`forcePathStyle: true` を設定する(R2 は仮想ホスト形式に非対応のため)。
 * - `provider === 's3'`: `endpoint` は設定しない。`region` は設定値をそのまま使う
 *   (スキーマ上 `provider: 's3'` でも `region` は optional だが、S3 は `region`
 *   未設定だと呼び出しに失敗するため、値が無ければ SDK の既定解決に委ねる)。
 * - checksum 関連のオプション(`ChecksumAlgorithm` 等)は明示設定しない(R2 が
 *   未対応のため。CodeRabbit plan Design Choice 2 参照)。
 * - 認証情報は `process.env` から `access_key_id_env` / `secret_access_key_env` の
 *   名前で参照した値を使う。config にリテラル値は書かない(FR-30)。
 */
export function createS3UploaderClient(assets: AssetsConfig): UploaderClient {
  const accessKeyId = requireEnv(assets.access_key_id_env);
  const secretAccessKey = requireEnv(assets.secret_access_key_env);
  const credentials = { accessKeyId, secretAccessKey };

  const client =
    assets.provider === 'r2'
      ? new S3Client({
          region: assets.region ?? 'auto',
          endpoint: assets.endpoint,
          forcePathStyle: true,
          credentials,
        })
      : new S3Client({
          region: assets.region,
          credentials,
        });

  return {
    async putObject({ bucket, key, body, contentType }: PutObjectParams): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}

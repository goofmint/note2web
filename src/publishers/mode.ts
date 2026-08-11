/**
 * 配信モード判定(design.md §6 手順5・6f・7、§5.6 書き込みポイント)。
 *
 * Git 出力モード(Zenn / Hugo / Jekyll。design.md §5.7 GitRepoPublisher)と
 * API / CLI モード(Qiita / dev.to / note.com / はてな)とで、sync フローの
 * 状態確定タイミングが変わる(§5.6: API/CLI は `publish()` 成功ごと即時、
 * Git は `finalize()` の PR 作成成功後に一括)。この判定を1箇所に集約する。
 */

import type { ServiceName } from '../config.js';

/** design.md §5.7 で Git 出力モードとされるサービス。 */
export const GIT_MODE_SERVICES = ['zenn', 'hugo', 'jekyll'] as const;

type GitModeService = (typeof GIT_MODE_SERVICES)[number];

/** `service` が Git 出力モード(Zenn / Hugo / Jekyll)かどうか。 */
export function isGitModeService(service: ServiceName): service is GitModeService {
  return (GIT_MODE_SERVICES as readonly ServiceName[]).includes(service);
}

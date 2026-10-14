import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * config.json 的 worlds.presence 段，默认禁用；bot 或部署可启用。
 *
 * 没有密钥：感知走本机桌面，截图落本机。窗口标题与截图会不会发到模型端点由部署的
 * provider 决定，不归这个 World 管；开发者已知情选择不加隐私旋钮（2026-09-19）。
 */
export interface PresenceConfigSection {
  enabled: boolean;
  /**
   * 轮询间隔（毫秒）。前台窗口与键鼠空闲一起查，两次轮询之间的瞬时变化看不见——
   * 这是诚实的边界，不是故障。默认 10000；低于 2000 会被拉回 2000，
   * 再密只是拿 token 换分辨率，「他在干什么」用不上。
   */
  pollIntervalMs: number;
  /**
   * 键鼠空闲超过这么久算「离开」（毫秒），恢复输入算「回来」。
   * 默认 300000（5 分钟）：去倒杯水不算离开，去吃顿饭算。
   */
  awayAfterMs: number;
  /**
   * 「回来」值得当场叫醒的离开时长（毫秒）。默认 600000（10 分钟）：离开比这短，回来那条
   * 只 piggyback，随她下次开口一起到；够久才当场叫醒。0 = 每次回来都叫醒（老行为）。
   *
   * 注意它得比 `awayAfterMs` 长才有意义——「离开」本身就要连续 `awayAfterMs` 没输入才判得出来，
   * 所以任何一次真实的离开都不短于 `awayAfterMs`。
   */
  backWakeAfterMs: number;
}

export const PRESENCE_DEFAULTS: PresenceConfigSection = {
  enabled: false,
  pollIntervalMs: 10000,
  awayAfterMs: 300000,
  backWakeAfterMs: 600000,
};

/** World 配置的 JSON Schema 声明。 */
export const PRESENCE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:presence',
  owner: 'world:presence',
  schema: {
    type: 'object',
    title: 'Presence',
    properties: {
      'worlds.presence.pollIntervalMs': {
        type: 'integer',
        title: '轮询间隔（毫秒）',
        description: '多久看一次前台窗口和键鼠空闲。默认 10000；低于 2000 按 2000 算。改完要重启这个 World。',
      },
      'worlds.presence.awayAfterMs': {
        type: 'integer',
        title: '离开判定（毫秒）',
        description: '键鼠空闲超过这么久就投 presence.away，恢复输入投 presence.back。默认 300000（5 分钟）。',
        'x-hot': true,
      },
      'worlds.presence.backWakeAfterMs': {
        type: 'integer',
        title: '回来叫醒门槛（毫秒）',
        description: '离开超过这么久，回来时才当场叫醒；比这短的只随她下次开口一起到。默认 600000（10 分钟）；0 = 每次回来都叫醒。要比「离开判定」长才有意义。',
        'x-hot': true,
      },
    },
  },
};

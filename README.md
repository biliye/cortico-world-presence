# cortico-world-presence

Cortico 的「在场感」World:让 bot 知道开发者在不在电脑前、在干什么,想看的时候能截一张屏。
Windows 专用(传感器与截图都走 Win32,经由系统自带的 PowerShell,零安装)。

## 它给什么

- **事件**(被动):
  - `presence.switched` —— 前台窗口切到了哪(应用名 + 标题 + 上一个窗口停留多久);
  - `presence.activity` —— ambient 姿势下的合并批,或 call 姿势下 3 秒内的连续变化;
  - `presence.away` / `presence.back` —— 键鼠空闲超过阈值 / 恢复输入,带离开时长;
  - `presence.down` —— 传感器进程起不来或退了。
- **工具**(主动):
  - `presence_windows` —— 前台、键鼠空闲秒数、可见窗口清单;距她上次看的变化当场附在回执里;
  - `presence_screenshot` —— 截图,`full`(所有显示器拼一张,默认)/ `foreground` / 指定 hwnd;
    PNG 直接附进回执,模型不吃图时回执里会把话说破;
  - `presence_set_mode` —— 切 `ambient`(攒批不叫醒,默认)/ `call`(即投叫醒);运行态,重启回默认。

## 配置(`worlds.presence`)

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | bot 或部署启用 |
| `pollIntervalMs` | `10000` | 轮询间隔;两次轮询之间的瞬时变化看不见。下限 2000,改完要重启 World |
| `awayAfterMs` | `300000` | 键鼠空闲超过这么久算「离开」。热生效 |

没有密钥。窗口标题与截图会随模型调用发到部署配置的模型端点——这是设计内的事,部署者知情;
不加隐私旋钮是开发者的拍板(2026-09-19)。

## 验证

```bash
pnpm typecheck
pnpm test      # 单元测试用注入的假传感器;另有一条真 PowerShell 的采样用例
pnpm smoke     # 对真桌面:采样 6 秒 + 列窗口 + 真截一张全屏落盘
```

装进实例后的第三级目击:时间线里出现 `presence.switched`;让她调 `presence_windows` 与
`presence_screenshot`;**重点:她拿到截图后能否真的描述出屏幕内容**(模型端吃不吃图的实底,
框架侧 `multimodal` 只保证 PNG 附进了请求)。

## 设计记录

`../../design/cortico-world-presence.md`(相对本包,在工作区的 `state/design/` 下)。

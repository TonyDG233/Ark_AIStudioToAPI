# 运输通道决策与 400 排查手册（2026-10-17）

## 两条运输通道（均在 Node→浏览器→Google 这一层）

- **直连通道（DirectSigner）**：主页面签名器 → 直发 `GenerateContent`。`MAKERSUITE_DIRECT=on` 时优先。
- **原生通道（build.js）**：Node → App 预览 `build.js` → Studio shim → 宿主 → `ProxyStreamedCall`。
  `MAKERSUITE_DIRECT` 未开时它是唯一通道（默认状态）。

## 静态路由规则（没有"失败后自动改道"）

- `MAKERSUITE_DIRECT` 未开 → 全部原生（默认）。
- 开启后：**所有 real 流生成请求 = 直连候选**；非 real 模式不是候选（静态规则，debug 日志
  `not a direct candidate (streaming_mode=...)`），照旧走原生。
- 直连候选遇到**自身不可用**（签名器离线/未就绪/发送失败）→ **显式拒绝**：
  向客户端返回明确错误（502，消息含原因与处置建议），日志 WARN：
  `[DirectSigner] request=<id>: refused (<原因>); not delegating to native`。
  绝不悄悄改道；拒绝不计入账号故障（消息带 `skipAccountSwitch`）。
- 请求体超出**页面编码器**能力（如 `toolConfig ANY/allowedFunctionNames`）→ 由页面编码时
  显式报错（HTTP 400 + 具体原因：字段路径、收到的值、处置建议），同样不改道。

## 每请求路径怎么看

| 结果             | 日志指纹                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| 直连             | `[DirectSigner] request=<id>: serving via direct path`（debug）                                         |
| 直连拒绝         | `[DirectSigner] request=<id>: refused (...); not delegating to native`（warn）+ 客户端 502 明确错误     |
| 原生             | `Context#N Received request: POST ...`（build.js 侧）                                                   |
| ATG 临时禁用触发 | `[ATG] client synthetic transport detected (ctx): tool=..., reason=...; local wrap skipped`（**info**） |

## 日志级别约定

- **INFO**：ATG 临时禁用触发（检测命中）、签名器连接/断开、任务错误（WARN/ERROR 级）。
- **DEBUG**：路径决策（serving/not-a-candidate）、task done 摘要、warmup 生命周期、signer_status 变化、
  页面 console（已改 `console.debug`）、frame 级日志。

## 未来出现 400 时的三类指纹

| 类型           | 时延特征                     | 日志指纹                                                                                                               | 含义与处置                                                                                                                        |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A 本地编码 400 | 毫秒级（dispatch 后 1–10ms） | `task error ... status=400: [DirectSigner] codec rejected this request: <字段路径+值+建议>`                            | 页面编码器编不了该请求体（本地拒绝，非 Google）。按 message 中的字段修正请求，或走原生通道（开自动改道/关 `MAKERSUITE_DIRECT`）。 |
| B 直连上游 400 | 秒级（Google 往返后）        | `task error ... status=400: [DirectSigner] upstream (HTTP 400) rejected the request: <Google 原文>`（日志另带 sample） | Google 拒了 `GenerateContent`。Google 原文即证据；若端点整体被关 → 关闭 `MAKERSUITE_DIRECT` 全场回原生。                          |
| C 原生上游 400 | 秒级                         | `Context#N Request processing failed: Google API returned error: 400 ...`                                              | Google 拒了 `ProxyStreamedCall`（宿主通道）。                                                                                     |
| D 直连拒绝 502 | 毫秒级、无 task              | `refused (...)`（warn）+ 客户端错误消息                                                                                | 签名器通道问题（离线/未就绪）。修页面/等就绪，或关 `MAKERSUITE_DIRECT`。                                                          |

## ATG 与通道的关系（解耦）

- ATG 只改**请求体内容**：包装 `[ATG] wrapped (ctx)`（debug）/ 检测跳过
  `[ATG] client synthetic transport detected (ctx)`（info）；它**不决定**通道。
- 前缀不同（`[ATG]` vs `[DirectSigner]`），互不掩盖。

## 无隐藏策略（承诺）

- 自动行为仅两条，且都可 grep：① ATG 检测跳过本地包装（info）；② 静态路由规则（本手册）。
- **没有**"失败后自动改道另一条通道"的逻辑；一切失败以明确错误 + 原文日志呈现。

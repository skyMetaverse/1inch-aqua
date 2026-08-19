# Rebalance Bot 运行逻辑详解

## 1. 文档目的

本文档说明当前 `src/app/rebalance-bot.ts` 的完整运行逻辑，包括启动初始化、配置加载、状态恢复、官方 API 快照、配置仓位数量对账、缺失 LP 补建、已有 LP 动态再平衡、`dock -> ship` 交易状态机、批量 `multicall`、错误处理、进程退出和安全边界。

本文档对应当前实现。相关代码发生行为变化时，必须同步更新本文档、配置说明和测试。

## 2. 运行目标

Rebalance Bot 同时处理两类任务：

1. 持续维持 `config/lp.add.jsonc` 声明的配置仓位数量。
2. 根据已有 LP 的成交余额、价格区间、`illiquidity` 状态和市场数据，对已有仓位执行动态重挂。

配置文件中的 `positions[]` 同时表示目标配置槽位和缺失仓位的初始创建模板，但不固定已有 LP 的运行模式。

例如，某个配置槽位最初使用 `upper` 模式创建，后续成交后两侧资产接近等值，Bot 可以将它动态重挂为 `two-sided`。之后如果资产再次明显偏向某一侧，也可以重新选择 `upper` 或 `lower`。

因此，配置和已有策略的职责如下：

```text
lp.add.jsonc
    目标 LP 数量
    缺失 LP 的初始 token、余额比例、区间和费率模板

官方策略 API + 链上状态 + EMSH current
    已有 LP 的当前成交状态
    已有 LP 是否需要重挂
    已有 LP 重挂成哪一种模式
```

## 3. 相关模块

`rebalance-bot.ts` 不是独立完成所有逻辑，而是协调以下模块：

- `src/config/rebalance-config.ts`：校验 Bot 运行配置。
- `src/config/lp-config.ts`：校验 LP 创建模板和稳定配置槽位 `id`。
- `src/infra/aqua-api.ts`：查询官方 Aqua 策略 API 和 Pair 市场 API。
- `src/infra/emsh.ts`：查询 EMSH `current` 价格。
- `src/domain/rebalance.ts`：执行无副作用的再平衡领域决策。
- `src/infra/rebalance-state.ts`：保存计划、观察数据、配置槽位和进程锁。
- `src/app/add-lp.ts`：复用余额读取、授权、策略构建、单笔 ship 和批量 ship。
- `src/aqua/multicall.ts`：构造 Aqua registry `multicall(bytes[])`。
- `src/infra/rpc.ts`：本地签名、EIP-1559 交易构造和 `eth_sendRawTransaction` 广播。
- `src/infra/rebalance-terminal.ts`：TTY 动态状态面板。

整体流程如下：

```text
读取配置
  -> 获取 state 文件锁
  -> 解密私钥
  -> 校验 RPC、registry 和 app
  -> 读取并迁移 state
  -> 恢复未完成交易计划
  -> 查询官方 open 策略
  -> 对账配置槽位
  -> 首轮授权预检
  -> 批量或单笔补建缺失 LP
  -> 处理已有策略的动态再平衡
  -> 保存状态并等待下一轮
```

## 4. 启动流程

### 4.1 解析命令参数

支持以下调用方式：

```bash
bun run rebalance-bot
bun run rebalance-bot config/rebalance.jsonc
bun run rebalance-bot --help
```

Bot 不提供 `--dry-run`。输入私钥解密密码后，满足条件的操作可能直接执行真实 `dock`、授权和 `ship` 交易。

### 4.2 初始化日志和终端面板

启动时创建文件审计日志和终端输出对象。

TTY 环境下：

- 终端使用动态面板。
- 日志文件仍保存完整逐行日志。
- 面板只负责展示，不替代审计日志。

非 TTY、CI 或输出重定向环境下：

- 终端改为逐行输出。
- 日志文件继续保存完整内容。

每一条业务日志都应该能够在日志文件中还原本轮决策和交易过程。

### 4.3 加载和校验 Bot 配置

Bot 读取 `config/rebalance.jsonc`，校验：

- `chainId`。
- 轮询间隔 `polling.intervalSeconds`。
- 连续越界确认次数 `polling.stableSnapshotsRequired`。
- EMSH current 最大允许年龄。
- Pair/EMSH 最大价格偏差。
- Pair 最少 swaps 数量。
- 重挂费率和区间宽度。
- 重挂额外偏离阈值。
- cooldown 时间。
- 单边转双边的最低 USD 比例。
- state 文件路径。
- LP 模板路径。
- API 索引宽限时间。

百分比、费率和价格相关配置以字符串输入，例如：

```jsonc
"singleSidedWidth": "0.15%"
```

进入领域计算后转换为 bigint 定点数，不使用 JavaScript 浮点数作为核心交易参数。

### 4.4 加载和校验 LP 模板

Bot 根据 `runtime.lpConfigPath` 加载 LP 配置，默认是：

```text
config/lp.add.jsonc
```

每个 `positions[]` 必须具有唯一的非空 `id`。这个 `id` 是稳定配置槽位标识，用来保存：

```text
配置槽位 id -> 当前 strategyHash
```

Bot 还会校验 LP 配置的 `chainId` 必须和 Bot 配置一致。链不一致时立即停止，避免按错误网络配置创建策略。

### 4.5 获取进程锁

锁文件路径为：

```text
{stateFile}.lock
```

Bot 使用排他创建方式获得锁。同一个 state 文件同时只能有一个 Bot 进程运行，以防止：

- 两个进程同时 dock 同一个策略。
- 两个进程同时创建替代策略。
- 两个进程争用同一个 nonce。
- 两个进程互相覆盖 state 文件。

收到 `SIGINT` 或 `SIGTERM` 时释放锁。`SIGKILL`、断电和进程崩溃无法执行用户态清理，残留锁只能在确认没有 Bot 进程后手工删除。

### 4.6 读取 RPC 和解密私钥

Bot 只从 `.env` 中读取 `RPC_URL`，不把整个 `.env` 加载到环境变量中，也不把私钥内容写入日志或 state。

私钥通过 `scripts/encrypt-private-key.ts` 交互解密，随后在本地转换为 `PrivateKeyAccount`。交易全部本地签名，通过 `eth_sendRawTransaction` 广播，不使用节点托管账户签名。

进程清理时会将内存中的私钥 Buffer 填零。

### 4.7 校验网络、registry 和 app

Bot 通过 RPC 读取真实 `chainId`，要求与配置一致，然后取得：

- Aqua registry 地址。
- Aqua SwapVM app 地址。

还会检查 registry 是否存在合约代码。网络、SDK 地址或合约代码校验失败时，不进入交易循环。

## 5. state 文件和状态模型

当前 state 版本为 `4`，主要结构如下：

```json
{
  "version": 4,
  "plans": {},
  "observations": {},
  "configuredSlots": {}
}
```

状态文件通过临时文件、`fsync` 和 `rename` 原子替换保存，避免进程中断时留下半个 JSON。

### 5.1 `plans`

`plans` 保存每个逻辑仓位的交易计划。逻辑仓位 key 包含：

```text
chainId
maker
app
排序后的 token 地址
strategyHash
```

同一 pair 的不同 `strategyHash` 是不同逻辑仓位，必须分别保存观察计数和交易恢复状态。

计划阶段包括：

```text
PLAN_PERSISTED
DOCK_SENT
DOCK_VERIFIED
SHIP_PREPARED
SHIP_SENT
ACTIVE_LATEST
BLOCKED
```

阶段含义：

- `PLAN_PERSISTED`：已经决定重挂并保存计划，但尚未发送 dock。
- `DOCK_SENT`：dock 已进入发送阶段，保存了 dock 交易 hash。
- `DOCK_VERIFIED`：dock receipt、`Docked` 事件和 docked `rawBalances` 已验证。
- `SHIP_PREPARED`：已读取 dock 后钱包余额，并冻结 ship 金额、salt 和新策略 hash。
- `SHIP_SENT`：ship 已进入发送阶段，保存了 ship 交易 hash。
- `ACTIVE_LATEST`：新策略 ship 完成，事件和 rawBalances 全部复核通过。
- `BLOCKED`：发生错误，但当前不能安全自动重做。

### 5.2 `observations`

每个 strategyHash 有一条观察记录：

```text
strategyHash
breachCount
lastShipAt
```

其中：

- `breachCount`：连续有效越界快照次数。
- `lastShipAt`：最近一次 ship 完成时间，用于 cooldown。

策略回到区间内时，`breachCount` 归零。新策略 ship 成功后，观察记录迁移到新 strategyHash，计数重置为零。

### 5.3 `configuredSlots`

`configuredSlots` 保存配置槽位和当前 strategyHash 的关联：

```json
{
  "configuredSlots": {
    "upper-1inch-usdt": {
      "strategyHash": "0x...",
      "updatedAt": 1234567890
    }
  }
}
```

它只用于配置数量对账和 API 索引延迟保护，不用于固定已有 LP 的动态模式。

动态重挂成功后：

```text
旧 strategyHash
  -> 新 strategyHash
```

对应配置槽位的 hash 关联也会迁移，但不会把动态选择的 `targetMode` 写回 LP 初始模板。

## 6. 主循环

Bot 启动完成后进入永久轮询。每轮按照以下顺序执行：

```text
1. 恢复未完成计划
2. 查询官方 open 策略
3. 对账配置槽位
4. 第一次循环时执行授权预检
5. 补建缺失配置 LP
6. 处理已有策略的动态再平衡
7. 渲染面板
8. sleep intervalSeconds
```

任何一轮发生异常，Bot 会记录本轮错误，等待配置的轮询间隔，然后继续下一轮。已广播或已冻结的计划不会因为本轮异常而被覆盖。

## 7. 未完成计划恢复

每轮开始时，Bot 遍历 `state.plans`。除了 `ACTIVE_LATEST` 和 `BLOCKED`，其他阶段都优先恢复：

```text
PLAN_PERSISTED
DOCK_SENT
DOCK_VERIFIED
SHIP_PREPARED
SHIP_SENT
```

恢复优先于新决策，防止旧计划未完成时又创建第二个替代仓位。

### 7.1 可以安全删除并重做的 BLOCKED 计划

只有以下情况允许删除旧计划并在下一轮重新决策：

1. 节点明确返回 `nonce too low`。
2. dock 模拟前收到精确的 `Transaction creation failed.`，并且计划没有任何 dock hash、ship hash、钱包冻结金额、目标金额或新策略 hash。

这两类情况都要求确认旧 raw 没有被接受，也没有发生资金冻结。

任何已经产生以下字段的计划都不能按这个规则删除：

- `dockTransactionHash`
- `shipTransactionHash`
- `walletBalancesRaw`
- `targetAmountsRaw`
- `shipStrategyHash`

### 7.2 已广播或已冻结计划的恢复原则

如果计划已经处于：

```text
DOCK_SENT
DOCK_VERIFIED
SHIP_PREPARED
SHIP_SENT
```

则 RPC 读取失败、回执读取异常或其他临时错误不能把它覆盖为普通 BLOCKED，也不能生成第二个计划。Bot 下一轮必须使用 state 中原有 hash、金额和 salt，继续恢复同一笔交易。

## 8. 官方策略 API 快照

Bot 调用官方策略 API 查询当前 maker 的 `status=open` 策略。

API 主要提供：

- 当前 open strategyHash。
- strategyBytes。
- maker、app、chainId。
- openedAt。
- token 和 decimals。
- initialBalance。
- currentBalance。
- classification。
- performance。

`currentBalance.raw` 用于 dock 前和链上状态的一致性校验，不作为新 ship 的最终资金来源。新 ship 的金额只能在 dock 成功后从钱包实际余额读取。

## 9. 配置槽位对账

对账函数是 `reconcileConfiguredPositionSlots()`。

### 9.1 交易对匹配

配置模板和 API 策略通过两个 token 地址组成的排序 key 匹配，忽略 token 原始顺序：

```text
[token0, token1]
[token1, token0]
```

会被视为同一个 pair。

### 9.2 已有关联继续占用槽位

如果配置槽位关联的 strategyHash 当前仍在 API 返回列表中，则槽位保持占用，不会补仓。

### 9.3 API 索引宽限

如果最近成功 ship 的 strategyHash 暂时没有出现在 API 中，Bot 会根据：

```text
now - configuredSlot.updatedAt
```

与 `slotIndexingGraceSeconds` 比较。

在宽限期内，Bot 假设可能是：

```text
链上 ship 已成功
官方策略 API 尚未索引新 hash
```

因此不会重复创建 LP。

### 9.4 首次升级时的历史绑定

如果旧 state 没有槽位关联，Bot 会将同一 pair 的当前 active 策略按 `openedAt` 和 `strategyHash` 稳定排序，分配给尚未占用的配置槽位。

这个操作只建立：

```text
配置槽位 -> 当前 strategyHash
```

不会按照初始模板强制修改策略模式。

### 9.5 对账输出

每轮日志会记录：

```text
目标仓位数
已关联槽位数
待补足槽位数
```

## 10. 首轮授权预检

每个 Bot 进程首次处理策略快照时，会收集当前受支持策略涉及的 token，读取：

```text
allowance(maker, Aqua registry)
```

如果 allowance 精确等于 `MAX_UINT256`，加入当前进程内缓存。后续动态 ship 可以跳过这个 token 的重复 allowance 读取。

缓存具有以下限制：

- 只存在于当前进程。
- 不写入 state。
- 重启后必须重新读取。
- 如果 ship 模拟失败，会删除相关 token 的缓存。

这样可以处理运行期间被外部 revoke allowance 的情况。

## 11. 缺失 LP 补建

配置槽位对账返回缺失的 `PositionConfig[]` 后，Bot 调用 `addConfiguredPositions()`。

缺失 LP 使用模板中的：

- token 地址和顺序。
- `balancePercent`。
- 费率。
- 区间模式。
- 上下边界宽度。

### 11.1 单个缺口

缺少一个槽位时，执行单笔 ship：

```text
余额读取
  -> allowance
  -> current
  -> 策略构建
  -> 授权
  -> ship 模拟
  -> 单笔 ship 广播
  -> receipt 和 rawBalances 复核
```

### 11.2 两个或更多缺口

同一轮缺少两个或更多槽位时，必须使用一笔 Aqua registry multicall：

```text
每个模板分别读取余额和 allowance
  -> 每个模板分别计算金额和价格区间
  -> 每个模板分别构建 ship 策略
  -> 每个 ship 分别模拟
  -> 构造 multicall([ship1, ship2, ...])
  -> 模拟整个 multicall
  -> 只广播一笔 raw transaction
  -> 同一 receipt 逐策略复核
```

批量交易必须满足：

- 子调用数量至少为 2。
- 所有子调用目标都是同一个 Aqua registry。
- 所有子调用 `value` 都为 0。
- 所有 calldata 非空。

Receipt 复核包括：

- 每个策略的 `Shipped` 事件。
- 每个非零投入 token 的 `Pushed` 事件。
- 每个 token 的 `rawBalances`。
- `tokensCount == 2`。

只有所有子策略都复核成功后，Bot 才一次性更新对应的 `configuredSlots`。如果 multicall 失败，不能写入部分槽位关联；下一轮根据 API 和 state 重新判断缺口。

### 11.3 批量补建和动态重挂的区别

批量 multicall 只用于同一轮发现的多个全新缺失配置 LP。

已有策略的动态重挂仍然是单个逻辑仓位的独立恢复流程：

```text
一个策略 -> 一个 dock 计划 -> 一个 ship 计划
```

这样可以分别保存和恢复每个策略的：

- 旧 strategyHash。
- dock hash。
- 钱包快照。
- 目标金额。
- salt。
- 新 strategyHash。
- ship hash。

## 12. 已有策略筛选

`unsupportedStrategyReason()` 对 API 策略执行安全筛选。自动处理要求同时满足：

```text
maker == 当前解密私钥账户
chainId == Bot 配置 chainId
app == 当前 Aqua SwapVM app
classification.type == concentrated
classification.state == active 或 illiquidity
```

未知 app、未知策略类型、未知状态、maker 不匹配或链不匹配的策略会写入 BLOCK 日志，不自动 dock。

## 13. Pair 和 EMSH 数据

### 13.1 Pair API

对于 `active` 策略，Bot 按 pair 去重请求 Pair 市场数据，主要使用：

- `lastPrice`。
- `swaps`。
- `volumeUsd`。

其中：

- `swaps` 用于最低市场活跃度门槛。
- `lastPrice` 与 EMSH current 做价格源交叉校验。
- `volumeUsd` 只记录观察，不直接作为重挂门槛。

### 13.2 EMSH current

EMSH current 是新区间计算的唯一价格来源。Bot 会：

1. 读取 current 原始价格文本。
2. 校验时间戳不能过期或异常未来。
3. 以 18 位定点精度解析。
4. 超过 18 位小数时向下量化并记录丢弃精度。

Pair `lastPrice` 不直接用于构造新区间。

## 14. 旧区间解析和越界计算

策略的旧区间从 `strategyBytes` 中解析出 Aqua `sqrtPrice`，然后结合两个 token 的真实 decimals 恢复成人类显示价格。

这一步不能先把 rawPrice 截断为普通整数，否则混合 decimals 的交易对可能丢失窄区间精度。

得到：

```text
oldRange.min
oldRange.current
oldRange.max
```

current 在旧区间内时，越界距离为 0。

current 低于下边界时，按下边界计算相对偏离；current 高于上边界时，按上边界计算相对偏离。全部使用 bigint 定点计算。

## 15. 连续越界和 cooldown

### 15.1 连续越界

当越界距离超过 `recenterExcess` 时，`breachCount` 增加；否则清零。

例如：

```text
stableSnapshotsRequired = 3
```

则必须连续三轮满足有效越界，才能通过连续确认门槛。

### 15.2 cooldown

新策略 ship 成功后写入 `lastShipAt`。在 `cooldownSeconds` 内，即使价格出现新的越界，也不会立即再次重挂。

cooldown 只影响正常 `active` 策略。`illiquidity` 是强制重挂状态，不等待 cooldown。

## 16. 领域决策

核心决策函数是：

```ts
decideRebalance()
```

返回：

```text
keep
rehang
block
```

### 16.1 源模式识别

源模式根据策略创建时的 `initialBalance.raw` 识别：

```text
initial token0 > 0，token1 == 0
    -> upper

initial token0 == 0，token1 > 0
    -> lower

initial token0 > 0，token1 > 0
    -> two-sided

两侧都为 0
    -> block
```

不能使用 currentBalance 识别源模式，因为单边策略成交后可能同时拥有两种 token。

### 16.2 illiquidity

`classification.state == illiquidity` 时，直接要求重挂，但新模式仍根据当前余额决定：

- 两侧有余额且 USD 接近等值：`two-sided`。
- 两侧有余额但价值不接近：保留 USD 价值较大的一侧，选择 `upper` 或 `lower`。
- 只有 token0 有余额：`upper`。
- 只有 token1 有余额：`lower`。

它跳过 Pair 活跃度、连续越界和 cooldown 门槛，但不跳过任何链上交易安全校验。

### 16.3 正常 active 策略

正常 active 策略必须先通过：

- Pair 数据存在。
- Pair swaps 达到最低值。
- Pair lastPrice 与 EMSH current 偏差不超过配置上限。
- cooldown 已结束。

随后处理模式转换和价格越界。

### 16.4 单边部分成交转双边

如果源策略不是双边，当前两侧都有余额，并且：

```text
小侧 USD / 大侧 USD >= convertToTwoSidedMinValueRatioBps
```

则重挂为 `two-sided`。

默认比例为 `8000` bps，即 80%。

### 16.5 越界重挂模式

如果正常 active 策略持续有效越界：

- 原本是双边且当前两侧都有余额：重挂为 `two-sided`。
- 单边部分成交且两侧价值不接近：保留 USD 价值较大的一侧，重挂为 `upper` 或 `lower`。
- 当前只剩 token0：重挂为 `upper`。
- 当前只剩 token1：重挂为 `lower`。

如果价格没有超过额外偏离阈值，或者连续越界次数不足，则保持当前策略。

## 17. 创建动态重挂计划

当决策为 `rehang` 时，Bot 创建 `PLAN_PERSISTED` 计划。

计划保存：

- 旧 strategyHash。
- 旧 strategyBytes。
- 旧策略 app。
- 两个 token。
- API currentBalance.raw。
- 目标模式。
- 基于 EMSH current 生成的新 sqrtPrice 区间。
- fee。
- 决策原因。
- 配置槽位 id（如果当前策略属于某个配置槽位）。

此时不保存新 ship 金额，因为新金额必须等旧策略 dock 成功后读取钱包余额决定。

## 18. 动态重挂的 dock 流程

### 18.1 已完成阶段直接跳过

如果计划已经处于：

```text
DOCK_VERIFIED
SHIP_PREPARED
SHIP_SENT
ACTIVE_LATEST
```

不会再次发送 dock。

### 18.2 校验 source strategy

Bot 重新计算 `sourceStrategyBytes` 的 hash，必须与持久化的 `sourceStrategyHash` 一致。

### 18.3 正常 dock 前链上核对

逐 token 查询：

```text
rawBalances(maker, app, sourceStrategyHash, token)
```

要求链上余额和 API 快照中的 `sourceCurrentRaw` 完全一致，且 `tokensCount == 2`。

如果不一致，删除尚未广播的计划，下一轮重新拉 API，不使用链上余额猜测修改计划。

### 18.4 dock 模拟和持久化

Bot 构造 dock calldata，先执行 `eth_call` 模拟。模拟成功后立即把阶段写成 `DOCK_SENT`，然后本地签名并广播。

这样即使广播或回执等待期间进程中断，state 仍然知道该计划已经进入 dock 发送阶段。

### 18.5 dock 广播和复核

广播完成后保存 `dockTransactionHash`，等待一个确认，然后校验：

- receipt 状态为成功。
- 存在匹配的 `Docked` 事件。
- 每个 token 的 `rawBalances` 为 0。
- `tokensCount == 0xff`，表示已 dock。

全部成功后阶段变为 `DOCK_VERIFIED`。

## 19. 动态重挂的 ship 流程

### 19.1 dock 后读取钱包余额

只有 dock 完成后，Bot 才读取两个 token 的钱包余额：

```text
balanceOf(maker, token0)
balanceOf(maker, token1)
```

这两个值是新策略资金的唯一来源。

### 19.2 按目标模式导出金额

`deriveWalletShipAmounts()` 规则：

```text
upper
    -> [wallet token0 balance, 0]

lower
    -> [0, wallet token1 balance]

two-sided
    -> [wallet token0 balance, wallet token1 balance]
```

双边模式要求两侧余额都大于 0，不能在余额不足时静默降级为单边。

### 19.3 冻结金额、salt 和新 hash

Bot 生成随机 salt，构建新策略，然后一次性保存：

- `walletBalancesRaw`。
- `targetAmountsRaw`。
- `walletSnapshotAt`。
- `salt`。
- `shipStrategyHash`。
- `shipFundingSource = WALLET_SNAPSHOT`。
- `stage = SHIP_PREPARED`。

进入 `SHIP_PREPARED` 后，即使钱包余额发生变化，也不能重新计算本次投入金额或生成新的 strategyHash。

### 19.4 恢复 SHIP_PREPARED

恢复时使用 state 中保存的：

- sqrtPrice。
- fee。
- targetAmountsRaw。
- salt。
- shipStrategyHash。

重新构建策略并校验生成的 hash 必须和持久化 hash 相同。不会因为余额变化创建第二个策略。

### 19.5 ship 前余额和授权检查

对每个非零投入 token：

1. 重新读取钱包余额，只用于确认余额仍然覆盖冻结金额。
2. 如果余额不足，停止执行，不改变计划金额。
3. 如果 token 未命中当前进程的最大授权缓存，则读取 allowance。
4. allowance 不足时按兼容流程执行授权。

授权成功后仍需重新确认实际 allowance 覆盖冻结金额。

### 19.6 ship 模拟、广播和复核

Bot 先模拟 ship。模拟成功后把阶段写为 `SHIP_SENT`，再本地签名广播，并保存 `shipTransactionHash`。

receipt 成功后逐步校验：

- 匹配的 `Shipped` 事件。
- 每个非零 token 的匹配 `Pushed` 事件。
- 每个 token 的 `rawBalances` 等于冻结的 `targetAmountsRaw`。
- `tokensCount == 2`。

所有复核完成后，计划变为 `ACTIVE_LATEST`。

## 20. ship 完成后的观察和槽位迁移

新策略 ship 完成后：

1. 为新 strategyHash 创建观察记录。
2. `breachCount` 重置为 0。
3. `lastShipAt` 更新为当前时间。
4. 旧计划标记为 `ACTIVE_LATEST`。
5. 如果计划关联配置槽位，将该槽位迁移到新的 strategyHash。
6. 保存 state。

槽位迁移只更新 hash 关联，不强制改变后续动态模式。

## 21. Aqua shared liquidity 语义

Aqua `ship` 主要登记 virtual balance，不立即执行 ERC20 转账。真实 token 转移发生在后续应用执行 `pull()` 时。

因此多个 strategyHash 可以登记同一个 maker 钱包余额。Bot 不会简单把多个策略的虚拟余额相加，再以总额超过钱包余额为理由阻止 ship。

但后续真实成交仍然可能受到：

- 钱包余额。
- ERC20 allowance。
- 其他策略已经消耗的实际资金。
- pull 执行时机。

影响，最终可能出现 `illiquidity` 或成交失败。这个风险在 ship 登记阶段需要监控，但不能简单等同为 ship 本身错误。

## 22. raw 广播和 RPC 不确定性

所有 dock、ship 和 multicall 都遵循：

```text
本地读取 nonce 和费用
  -> 本地签名
  -> eth_sendRawTransaction
```

禁止节点代签。

如果广播响应超时，但本地已经根据签名交易计算出 hash，则：

```text
记录本地 hash
不重新广播 raw transaction
等待同一个 hash 的 receipt
```

这样避免因为 RPC 响应不确定而重复发送同一业务交易。

## 23. 错误处理分类

### 23.1 API 快照与链上余额不一致

如果 dock 前发现 API 快照和链上 `rawBalances` 不一致：

- 删除尚未广播的计划。
- 写日志说明快照已失效。
- 下一轮重新获取 API。
- 不使用链上余额猜测新的决策。

### 23.2 `nonce too low`

如果节点明确返回 `nonce too low`：

- 认为当前 raw 未被接受。
- 删除未发送计划。
- 下一轮重新读取 pending nonce。
- 重新构造交易。
- 不重发旧 raw。

### 23.3 已广播或已冻结阶段发生错误

如果计划已经具有交易 hash，或者已经冻结钱包金额和新策略 hash：

- 保留原计划。
- 不生成第二个 strategyHash。
- 不改变 targetAmountsRaw。
- 下一轮继续等待或恢复原交易。

### 23.4 其他错误

对于未广播、未冻结阶段的其他错误，计划会被标记为 `BLOCKED`，保存：

```text
blockedReason
updatedAt
```

只有明确符合安全重试条件时，后续才会删除并重新决策。

## 24. 退出和资源清理

正常退出、异常退出、`SIGINT` 和 `SIGTERM` 都进入统一清理函数：

1. 防止重复清理。
2. 将私钥 Buffer 填零。
3. 释放 state 文件锁。
4. 关闭 TTY 动态面板。
5. 移除终止信号处理器。

`SIGKILL`、断电和进程崩溃无法执行清理。发现残留 `.lock` 文件时，必须先确认没有其他 Bot 进程，再人工删除。

## 25. 一轮运行示例：补建两个缺失 LP

假设：

```text
配置目标槽位：3 个
官方 API 当前 active：1 个
缺失槽位：2 个
```

本轮会执行：

```text
查询 API
  -> 识别两个缺失配置槽位
  -> 读取两个模板的 token 余额和 allowance
  -> 计算两个模板的目标 raw amount
  -> 分别获取 current 和构建两个策略
  -> 分别模拟两个 ship
  -> 构造 multicall([shipA, shipB])
  -> 模拟整个 multicall
  -> 广播一笔交易
  -> 等待一个 receipt
  -> 验证策略 A 的 Shipped/Pushed/rawBalances
  -> 验证策略 B 的 Shipped/Pushed/rawBalances
  -> 更新两个 configuredSlots
  -> 等待下一轮 API 索引新策略
```

如果 API 在下一轮仍然只返回旧的一个策略，只要新 ship 的槽位仍处于索引宽限期内，Bot 不会重复补建。

## 26. 一轮运行示例：已有 LP 动态转双边

假设某配置槽位最初创建为 `upper`：

```text
initialBalance:
    token0 > 0
    token1 = 0
```

经过成交后：

```text
currentBalance:
    token0 > 0
    token1 > 0

USD 价值：
    token0 = 1000
    token1 = 850
```

如果配置阈值为 80%，则：

```text
850 / 1000 = 85%
```

Bot 会：

```text
识别源模式为 upper
  -> 识别当前两侧都有余额
  -> 判断两侧 USD 接近等值
  -> targetMode = two-sided
  -> 创建重挂计划
  -> dock 旧策略
  -> 读取 dock 后钱包余额
  -> 冻结双边投入金额
  -> ship 新策略
  -> 将配置槽位关联迁移到新 hash
```

配置文件本身不会被修改，也不会把该槽位永久改成 `two-sided`。

## 27. 关键安全原则

当前实现的核心安全约束如下：

1. 配置槽位负责目标数量和缺失模板，不固定已有 LP 模式。
2. 每个 strategyHash 都有独立逻辑仓位 key、观察数据和恢复计划。
3. API `currentBalance.raw` 只用于 dock 前一致性校验。
4. 新策略资金必须来自 dock 后真实钱包余额。
5. `SHIP_PREPARED` 后金额、salt 和 hash 不得改变。
6. 已广播交易不自动重发 raw transaction。
7. 已广播或已冻结计划优先恢复，不能重新生成替代策略。
8. 两个及以上新缺失 LP 使用一笔 atomic multicall。
9. 所有 ship 必须经过 receipt、事件和 rawBalances 多层复核。
10. 只有确认未广播、未冻结且可追踪状态不存在时，才允许删除计划重做。
11. 百分比、费率、价格和余额核心计算使用 bigint 定点数。
12. mixed-decimals pair 必须保留 decimals-aware sqrtPrice 精度。
13. 私钥只在本地内存中短暂存在，不写入日志或状态文件。
14. state 文件使用原子保存和进程锁，避免并发覆盖和半写入。

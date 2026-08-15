# Aqua 自动再平衡 Bot 开发设计

## 1. 目的与边界

本文档定义 Aqua 自动再平衡 Bot 第一版的配置、数据来源、自动交易流程、恢复机制和验证要求。实现范围仅限当前仓库 `/Users/syskey/git/1inch-aqua`；参考项目 `/Users/syskey/git/aqua` 仅用于确认 1inch 网页端 API 的真实请求方式和字段。

Bot 的目标是持续监控当前 maker 钱包的全部受支持 Aqua 集中流动性仓位，并在策略报价不再贴近市场或单边仓位已形成接近等值的两侧资产时，自动关闭旧仓位并创建新仓位。目标是维持策略可被 resolver 路由成交的竞争力，不以手续费最大化为唯一目标。

Aqua 不会因价格源变化自动成交。成交必须由 resolver/taker 发起并执行 swap；Bot 只能重建贴近市场的报价，不能保证成交。

### 1.1 第一版包含

1. 常驻 `bun run rebalance-bot` 入口；运行后交互解密本地私钥并直接执行自动监控和重挂，不提供 `--dry-run`。
2. 发现官方 API `status=open` 返回的当前 maker 全部仓位；自动处理 concentrated 的 `active` 状态，其他状态显示明确阻止原因。
3. 通过官方策略 API 读取策略余额、USD 估值、策略成交量和手续费。
4. 通过官方 Pair API 读取交易对市场活跃度。
5. 通过官方 EMSH `current` API 获取用于精确计算区间的 current 价格。
6. 自动生成并持久化每个逻辑仓位的唯一最新计划。
7. 自动执行 `dock -> ship`，并复用现有本地签名、ERC20 授权、模拟、事件与链上余额复核逻辑。
8. 记录完整中文运行日志和可恢复状态文件。
9. 支持单边重挂、单边部分成交转双边、双边居中重挂。

### 1.2 第一版不包含

- Telegram、飞书、邮件或桌面告警。
- 外部 swap、自动将两种资产合并为单一资产。
- 自动调整 fee。
- Web UI、数据库服务、云端密钥管理。
- 未识别的 Aqua app、非 concentrated、非两种 ERC20 的策略自动交易。
- 在 API 响应不完整、价格源冲突或安全预检失败时猜测并继续交易。

## 2. 已确认外部数据源

### 2.1 官方策略 API：仓位发现与重挂决策

```text
GET https://proxy-app.1inch.com/v2.0/aqua/v1.0/strategies/makers/{maker}
  ?status=open
  &limit=100
  &chainId={chainId}
```

请求需先调用 `GET /v2.0/auth/token` 获取 Bearer token，并使用 1inch 网页端一致的 `referer`、`user-agent` 和 `accept-language` 请求头。

已实际观测的响应包含：

```text
items[].chainId
items[].maker
items[].app
items[].strategyHash
items[].strategyBytes
items[].openedAt
items[].tokens[].address
items[].tokens[].meta.{symbol,decimals}
items[].tokens[].initialBalance.{raw,usd}
items[].tokens[].currentBalance.{raw,usd}
items[].performance.{volume,fees}
items[].classification.{type,state,feePercent}
total
nextCursor
prevCursor
```

本 API 是以下策略决策的唯一仓位来源：

- 哪些仓位应被监控。
- 当前策略的两侧 `raw` 余额与 `usd` 估值。
- 当前策略本身是否出现成交量或手续费变化。
- 单边是否因部分成交形成两侧资产。
- 两侧资产是否达到转双边的近似等值条件。

限制：API 不返回策略当前价格、价格时间戳、策略上下界、`inRange` 或偏离区间的 bps。因此它无法独立判断策略是否贴近市场。

分页要求：第一版必须通过真实接口确认 `nextCursor` 的请求参数和翻页行为。若某轮 API 返回非空 `nextCursor` 但程序无法完整翻页，该轮必须停止自动交易，不能把前 100 条当作全部仓位。

### 2.2 官方 Pair API：市场活跃度

```text
POST https://proxy-app.1inch.com/v2.0/bff/v1.0/tokens-market/{chainId}/pair
body: { "pairs": [[token0, token1], ...] }
```

已实际观测的响应字段：

```text
 token0, token1
 lastPrice
 diffPercent1h, diffPercent24h, diffPercent7d
 volumeUsd
 swaps
```

Pair API 用于判断交易对近期是否存在自然市场活动，不能作为策略区间的唯一价格来源，也不能证明 Aqua 策略一定会被 resolver 路由。

实测同一 `1INCH/UNI` pair 的 `lastPrice` 与 EMSH current 可相差远大于 5 bp。因此 `lastPrice` 不可直接参与 `bigint` 的策略区间计算；它只作为活跃度和价格源偏差保护信号。

### 2.3 官方 EMSH current API：精确市场价格

```text
GET https://proxy-app.1inch.com/v2.0/charts/v1.0/chart/tradingview/{token0}/{token1}/86400/{chainId}/current
```

现有 `src/infra/emsh.ts` 已实现：从原始 JSON 文本抽取 `price` 数字字面量，拒绝科学计数法，并返回接口时间戳。价格超过 Aqua 的 18 位定点精度时，由价格源边界使用 bigint 向下量化并记录精度损失；它是第一版计算新策略 5 bp 区间的唯一价格输入。

EMSH current 仅用于市场价格与区间计算；不读取钱包仓位、不决定单边转双边。

### 2.4 官方波动率和 K 线 API：观察数据

```text
GET /v2.0/charts/v1.0/chart/volatility/{token0}/{token1}/{1W|1M|3M}/{chainId}
GET /v2.0/charts/v1.0/chart/tradingview/{token0}/{token1}/{resolution}/{chainId}
```

第一版不以波动率或 K 线自动改 fee 或区间宽度，避免将 JSON number 直接用于核心交易参数。可记录为中文日志中的市场背景，后续版本再加入经验证的风控规则。

### 2.5 RPC：仅作为交易安全边界

RPC 不参与“是否重挂、重挂成什么模式”的业务决策，不按新区块轮询全部策略余额。仅当 API 已形成明确计划时，执行一次必要链上安全预检：

1. 核对 RPC `chainId`、SDK registry 地址和 registry 合约代码。
2. 读取目标策略每个 token 的 `rawBalances`，确认仍为 active，token count 完整，且余额与计划 API 快照的 `currentBalance.raw` 完全一致。
3. 模拟 `dock`。
4. 广播后校验 receipt、`Docked` 事件和 docked 状态。
5. `dock` 已确认后读取钱包两个 ERC20 的实际余额；以 API 决定的模式导出最终投入额，并原子持久化 wallet snapshot、amounts、salt 和新 hash。
6. `ship` 前再次读取钱包余额、decimals、allowance，只验证已冻结金额并按已有通用兼容逻辑授权，不得改变计划金额。
7. 模拟并广播 `ship`；校验 receipt、`Shipped`、非零 `Pushed` 与新的 `rawBalances`。

若 API 快照与 dock 前预检链上余额不一致，计划立即失效；Bot 重新拉取 API，不使用链上余额改变模式。dock 确认后，钱包余额是新策略资金来源；一经冻结为 SHIP_PREPARED，后续余额变化不得改变该次投入数量。

## 3. 支持策略与逻辑仓位

仅对同时满足以下条件的仓位自动处理：

```text
classification.type = concentrated
classification.state = active
chainId 与本地 RPC 一致
maker 与解密私钥派生地址一致
app 等于当前 SDK 支持的 Aqua SwapVM app
strategyHash = keccak256(strategyBytes)
tokens 恰好为两个、地址不重复、均含有效 raw/currentBalance
```

其他仓位必须写中文日志并跳过，不得自动 `dock`：

```text
未知 app
非 concentrated
多 token 或非两个 token
hash 校验失败
余额、USD 字段缺失或类型异常
API 分页无法确认完整
```

逻辑仓位 key 固定为：

```text
{chainId}:{maker}:{app}:{sortedTokenAddress0}:{sortedTokenAddress1}:{strategyHash}
```

每个 open 且受支持的 `strategyHash` 都代表一个独立 Aqua 仓位，逻辑 key 使用 `{chainId}:{maker}:{app}:{sortedToken0}:{sortedToken1}:{strategyHash}`，因此相同 pair 的多个策略会分别监控、分别维护越界计数和分别执行重挂。`illiquidity` 是 1inch 策略 API 返回的分类标签，但当前 SDK、API 字段和已记录的真实响应均未给出可用于自动交易的正式语义；它会作为 open 策略在面板以 BLOCK 显示，不能被推断为“必然价格越界”或直接执行 `dock -> ship`。重挂生成新 hash 后，旧计划保留为 API 索引延迟期间的保护记录，新 hash 使用独立观察状态。

## 4. 默认策略参数

第一版采用已确认的起始参数：

```text
轮询间隔：30 秒
连续越界确认：3 次轮询
最短重挂冷却：900 秒（15 分钟）
单边区间宽度：5 bp（0.05%）
双边区间半宽：5 bp（上下各 0.05%，总宽 10 bp）
越界额外缓冲：3 bp（0.03%）
单边转双边阈值：较小侧 USD >= 较大侧 USD 的 80%
```

含义：

```text
lower 单边： [current × (1 - 0.05%), current]
upper 单边： [current, current × (1 + 0.05%)]
双边：       [current × (1 - 0.05%), current × (1 + 0.05%)]
```

“越界额外缓冲 3 bp”表示不在刚越过边界时立即交易。只有价格在区间外，且相对最近边界额外偏离至少 3 bp，并连续满足 3 次轮询和 15 分钟冷却期，才计划自动重挂。这样避免在边界噪声附近反复 `dock + ship`。

所有百分比和区间计算必须继续使用 `bigint` 定点数；配置不得使用 JavaScript number 表示百分比或价格。

## 5. 配置设计

新增本地运行配置：

```text
config/rebalance.jsonc
```

该文件必须加入 `.gitignore`，提交仅包含 `config/rebalance.example.jsonc`。建议第一版配置如下：

```jsonc
{
  // 仅支持与 RPC 严格一致的单链运行。
  "chainId": 1,

  "polling": {
    "intervalSeconds": 30,
    "stableSnapshotsRequired": 3,
    "maxCurrentPriceAgeSeconds": 120
  },

  "market": {
    // 当前范围以 EMSH current 为准；Pair API 用于最少 swaps 与价格交叉保护。
    "maxPairPriceDeviationPercent": "1%",
    "minimumPairSwaps": 1
  },

  "rebalance": {
    "fee": "0.001%",
    "singleSidedWidth": "0.05%",
    "twoSidedHalfWidth": "0.05%",
    "recenterExcess": "0.03%",
    "cooldownSeconds": 900,
    "convertToTwoSidedMinValueRatioBps": 8000
  },

  "runtime": {
    "stateFile": "state/rebalance-state.json"
  }
}
```

字段说明：

- `fee`：新建仓位的固定 Aqua taker fee；不信任 API `feePercent: number` 直接作为交易参数。
- `minimumPairSwaps`：Pair API 的 swaps 低于该阈值时不自动重挂。Pair `volumeUsd` 因统计窗口和小额 pair 聚合口径不稳定，仅记录到日志，不参与自动交易门槛。
- `maxPairPriceDeviationPercent`：EMSH current 与 Pair `lastPrice` 偏离超过阈值时停止自动交易，记录两源价格冲突。实测 `1INCH/UNI` 的两者可正常相差约 `0.30%`，因为接口语义不同；默认使用 `1%` 作为异常熔断，而不是误用 5 bp 要求两者一致。
- `convertToTwoSidedMinValueRatioBps=8000`：小侧 USD 至少为大侧 USD 的 80% 时视为接近等值。
- `stateFile`：持久化状态，仅用于幂等恢复与计划生命周期，绝不替代 API 形成业务决策；同路径 `.lock` 用于阻止第二个 Bot 进程并发操作同一份计划。

每个 `currentBalance.raw` 必须是非负十进制整数字符串。`usd` 必须为有限、非负 number；缺失、NaN、Infinity、负数或值为零时按对应规则阻止自动执行。

## 6. 模式判定与重挂规则

### 6.1 API 余额分类

先以策略 API 返回的 `initialBalance.raw` 识别源模式，再以 `currentBalance.raw` 识别当前资产状态：

```text
initial token0 > 0, token1 = 0：源模式为 upper 单边
initial token0 = 0, token1 > 0：源模式为 lower 单边
initial token0 > 0, token1 > 0：源模式为双边
initial 两侧均为 0：阻止自动处理

current token0 > 0, token1 = 0：当前只持有 token0
current token0 = 0, token1 > 0：当前只持有 token1
current token0 > 0, token1 > 0：当前同时持有两侧资产
current 两侧均为 0：阻止自动处理
```

不能只根据当前两侧余额判断“这是双边”：原单边策略发生部分成交后也会同时有两侧余额。单边转双边规则仅适用于源模式为单边、当前两侧余额均非零的仓位。源模式为双边的仓位始终使用双边重挂规则，即使当前成交后只剩一侧资产，也仅将新策略降级为对应单边。

### 6.2 单边策略

源模式为单边、当前市场价格仍满足原策略区间且没有形成两侧余额时，保持。

市场价格持续脱离旧区间，且满足 3 次确认、3 bp 额外偏离和 15 分钟冷却期时：

```text
关闭旧策略并确认 dock
-> 读取目标侧实际钱包 raw 余额并全额冻结
-> 使用 EMSH current 已计算的区间
-> 以同方向创建新的 5 bp 单边策略
```

若 API 显示单边策略已发生部分成交、两侧 raw 均大于零：

```text
小侧 USD / 大侧 USD >= 80%：
  关闭旧策略并确认 dock
  -> 使用两侧实际钱包余额并全额冻结
  -> 使用 EMSH current 创建上下各 5 bp 的双边策略

小侧 USD / 大侧 USD < 80%：
  关闭旧策略
  -> 以 USD 较大的一侧 raw 余额创建对应方向的 5 bp 单边策略
  -> 较小侧资产保留在钱包，不进行外部 swap、不并入新策略
```

最后一条会使较小侧资产退出 Aqua，留在 maker 钱包。它不丢失资产，但会改变资产部署范围，必须在日志和状态文件中明确记录。

### 6.3 双边策略

双边仓位价格仍在旧区间内时，保持。

价格满足持续越界、额外偏离和冷却条件时：

```text
关闭旧策略并确认 dock
-> 严格使用两侧实际钱包余额并全额冻结
-> 使用 EMSH current 创建上下各 5 bp 的双边策略
```

若一侧 raw 为零，按 6.1 自动降级为对应单边逻辑。

### 6.4 价格与 swaps 门槛

一次自动重挂同时必须满足：

1. EMSH current 时间戳在配置最大年龄内，价格为正且可解析为 1e18 bigint；超过 18 位时必须先向下量化且量化结果仍大于零。
2. Pair API 的 `lastPrice` 正、有限，且与 EMSH current 的偏离不超过配置阈值。
3. Pair API 的 `swaps >= minimumPairSwaps`；`volumeUsd` 仅记录为观察数据，不作为自动交易门槛。
4. 当前策略 API 快照结构完整且支持。
5. 计划不在冷却期，并满足价格越界确认。

任一条件不满足：保持当前策略，不广播交易，记录详细中文原因。Pair API 的 swaps 不能证明 Aqua 一定成交；它仅作为最低市场活动信号，价格安全仍以 Pair/EMSH 交叉校验为准。

## 7. 自动执行状态机与恢复

Bot 每次只处理一个逻辑仓位，所有 wallet 交易严格串行，避免 nonce 竞争。

```text
DISCOVERED
  -> API_VALIDATED
  -> KEEP
  |-> PLAN_PERSISTED
       -> DOCK_PRECHECKED
       -> DOCK_SENT
       -> DOCK_VERIFIED
       -> SHIP_PREPARED
       -> SHIP_SENT
       -> SHIP_VERIFIED
       -> ACTIVE_LATEST
  |-> BLOCKED
```

### 7.1 计划状态

状态文件中每个逻辑仓位最多保留一份最新计划。计划至少记录：

```text
version
logicalPositionKey
sourceStrategyHash
sourceApp
sourceTokens
sourceApiSnapshotDigest
sourceCurrentBalanceRaw
sourceCurrentBalanceUsd
decisionReason
targetMode
targetSqrtPriceMin
targetSqrtPriceMax
createdAt
lastUpdatedAt
stage
dockTransactionHash?
walletBalancesRaw?       # 仅 SHIP_PREPARED 后存在
targetAmountsRaw?       # 由 walletBalancesRaw 与 targetMode 严格推导
walletSnapshotAt?
salt?
shipStrategyHash?
shipTransactionHash?
```

写入必须使用“写临时文件 -> fsync -> 原子 rename”流程，避免进程崩溃留下半个 JSON。状态文件权限必须限制为当前用户；不包含私钥、密码、Bearer token 或完整 RPC URL。Bot 运行时以排他方式创建 `${stateFile}.lock`；`SIGINT`（Ctrl+C）和 `SIGTERM` 的处理器会同步释放该锁、清除内存私钥并恢复终端。SIGKILL、断电或进程崩溃无法运行用户态清理逻辑，只有确认没有运行中的 Bot 后才能人工删除遗留锁。

状态格式为 v3：dock 前只持久化 decimals-aware `targetSqrtPriceMin/Max` 与旧策略 API 快照；dock 后的 `SHIP_PREPARED` 才持久化钱包实际余额、按模式导出的 `targetAmountsRaw`、salt 和 ship hash。v1 状态文件可能包含 mixed-decimals 的错误报价，Bot 必须拒绝自动恢复；v2 的 PLAN_PERSISTED、DOCK_SENT、DOCK_VERIFIED 会删除其旧 API ship 金额并升级为 v3，v2 已 SHIP_SENT 或 ACTIVE_LATEST 则保留既有 hash 完成旧计划，不能重建为新钱包余额策略。

### 7.2 已 dock、未 ship 的恢复

`dock` 和 `ship` 是两笔独立交易，不能原子化。最关键失败点为：旧仓位已关闭，但新仓位暂时未创建。

恢复规则：

```text
若 stateFile 存在 PLAN_PERSISTED / DOCK_SENT / DOCK_VERIFIED / SHIP_PREPARED / SHIP_SENT 未完成计划：
  下一轮优先恢复该计划。
  不为同一 logicalPositionKey 生成新计划。
  DOCK_VERIFIED 尚未冻结新策略：重新读取实际钱包余额，并创建一次 SHIP_PREPARED 快照。
  SHIP_PREPARED 已冻结钱包余额、salt 与 hash：只验证必要余额、授权和 ship 模拟后继续，不能重新读取余额改变金额。
  若 ship 已发送，先查询持久化 hash 的 receipt，确认成功后完成复核；失败才进入阻止状态。
  若进程在 RPC 接收交易后、交易 hash 尚未来得及写入 stateFile 时中断，计划阶段会缺少 hash。此时 Bot 必须阻止该逻辑仓位，不能猜测重发；调用方需先在链上确认原交易是否已落链，再处理该状态文件。
```

若 SHIP_PREPARED 后钱包余额已不足以支付冻结金额，停止自动交易并保留状态文件与中文日志。不得悄悄降低投入数量、改变单/双边模式或生成第二个 hash。

### 7.3 API 更新延迟

交易后策略 API 可能短暂滞后。新 `ship` 经 receipt、事件和 rawBalances 链上复核成功后，状态机可标记为 `ACTIVE_LATEST`；在 API 返回已持久化的新 strategy hash 前，Bot 只记录并等待索引同步，不会对仍返回的旧 hash 再次生成计划或再次 ship。

## 8. 交易安全流程

### 8.1 dock

1. 校验 API strategy hash、strategy bytes、maker、chain、app 和 token 列表。
2. 链上读取全部 rawBalances，并要求与 API 计划 raw 金额完全一致。
3. 构建并 `eth_call` 模拟 dock。
4. 使用 `PrivateKeyAccount` 本地签名；广播前显式读取 pending nonce、估算 gas 和最新区块 EIP-1559 `baseFeePerGas`，通过 `eth_sendRawTransaction` 广播，不调用部分 RPC 不兼容的隐式 `eth_fillTransaction`。若 .env 同时设置 `MAX_FEE_PER_GAS_GWEI` 与 `MAX_PRIORITY_FEE_PER_GAS_GWEI`，则采用该对上限，并在 `maxFee < baseFee + priority` 时本地拒绝广播。
5. 等待至少一个确认。
6. 校验目标 `Docked` 事件。
7. 回读全部 rawBalances，确认余额为零且 tokensCount 为 docked 哨兵。

### 8.2 ship

1. 从已持久化计划读取目标 token raw amount 和精确 sqrt 价格区间；不得重新根据链上余额改变计划。
2. 查询钱包 ERC20 balance、decimals、allowance，确认计划金额可用。
3. 对每个非零投入 token 使用已有通用授权流程：不足则非零 allowance 先清零，再尝试 `approve(MAX_UINT256)`，以回读 allowance 覆盖本次投入为成功条件。
4. 使用现有 `buildConcentratedStrategy()`，每次生成随机 uint64 salt 与新 hash。
5. 先 `eth_call` 模拟 ship，再本地签名广播。
6. 校验 receipt、`Shipped`，每个非零 token 的 `Pushed`，以及新 hash 的 rawBalances。

错误、网络超时、限流、返回字段漂移、模拟回滚或回执失败必须停止当前逻辑仓位的自动交易。不得继续处理同一计划的下一阶段，也不得基于猜测重试不同交易参数。

## 9. 日志要求

每次 Bot 进程创建独立日志文件：

```text
logs/YYYY-MM-DD HH-mm-ss.SSS.log
```

日志统一：

```text
YYYY-MM-DD HH:mm:ss.SSS [info]: 中文消息
```

每轮至少记录：

- 轮询序号、API 查询耗时、活跃仓位数量、分页状态。
- 每个支持/跳过仓位的 logicalPositionKey、strategyHash、模式、API 两侧 raw/USD 余额、策略成交量/手续费变化。
- EMSH current 原文与时间戳；Pair lastPrice、volumeUsd、swaps、价格偏离。
- 旧区间、当前价格位置、连续越界次数、冷却状态、重挂决定和原因。
- 计划创建、替换、持久化、恢复、失效和阻止原因。
- 每笔 approve/dock/ship 的模拟、广播 hash、receipt、事件与链上复核结果。
- 小侧资产未被并入新单边策略时的 token 与 raw amount。

不记录私钥、密码、Bearer token、完整 RPC URL、完整 calldata 或未经脱敏的异常堆栈。

交互 TTY 的终端展示与审计日志分离：终端使用 ANSI 原位刷新对齐策略表，显示策略短 hash、交易对、完整 current、完整旧区间、完整越界、连续确认、完整 Pair/EMSH 价差、状态/原因及最近 8 条关键事件。数值列按本轮实际内容动态计算宽度，禁止以省略号截断；终端宽度不足时切换为逐策略多行详情，而不是降低数值精度。计划、dock、ship、恢复、阻止、错误和跳过事件进入近期事件区，连续重复事件只更新时间，普通轮询不刷屏。顶部同时显示 API open 数和实际展示行数，真正不支持的策略也以 BLOCK 行列出并显示 maker、chain、app、type 或 state 的明确原因。`stdout` 非 TTY、CI 或重定向时不输出 ANSI，自动保留原有逐行日志。无论终端模式如何，`logs/` 中均保留上述完整 `[info]` 审计行并作为复核依据。

## 10. 模块和文件规划

```text
config/
  rebalance.example.jsonc          # 可提交中文配置示例
  rebalance.jsonc                  # 本地真实配置，必须忽略
  README.md                         # 补充 Bot 配置和运行说明

docs/
  Aqua自动再平衡Bot开发设计.md      # 本文档

src/
  app/
    rebalance-bot.ts                # 常驻轮询、状态机和自动执行入口
  aqua/
    strategy.ts                     # 复用；必要时新增已验证的策略区间解析工具
  config/
    rebalance-config.ts             # Bot JSONC 严格校验
  domain/
    rebalance.ts                    # 纯决策：余额分类、USD 比例、偏离、计划生成
  infra/
    aqua-api.ts                     # API token、strategies、Pair、分页和响应严格校验
    rebalance-state.ts              # 原子状态文件、锁和恢复记录
    emsh.ts                         # 复用 current
    erc20.ts / logger.ts / rpc.ts   # 复用
    rebalance-terminal.ts            # TTY 对齐状态表与近期事件渲染

test/
  aqua-api.test.ts
  rebalance-config.test.ts
  rebalance.test.ts
  rebalance-state.test.ts
  rebalance-terminal.test.ts         # 对齐列宽、事件队列和非 TTY 降级
```

可以从 `scripts/cancel-all-active-lp.ts` 提取 API 查询、dock 预检和事件验证；提取后须保留现有一键关闭行为与测试覆盖，不能让 Bot 和关闭脚本复制两套不一致的交易安全逻辑。

## 11. 测试与验收

### 11.1 单元测试

必须覆盖：

1. 配置缺字段、未知字段、无效百分比、无效秒数、无效 USD 阈值。
2. API 策略响应中的地址、hash、token 数、raw、usd、分类和分页异常。
3. 单边 upper/lower、双边、零余额和部分成交余额分类。
4. 小侧 USD 恰好 80%、略低于 80%、USD 为零或无效时的转双边判定。
5. 5 bp 单边和双边精确区间、3 bp 越界缓冲、连续三次确认和 15 分钟冷却。
6. Pair/EMSH 价格偏离、低 volume、低 swaps、过期 current 阻止执行。
7. 每逻辑仓位仅保留最新计划；新快照替换旧计划。
8. 状态文件原子写入、损坏状态拒绝启动、`DOCK_VERIFIED` 后恢复优先级。
9. `dock` 成功而 `ship` 失败时不生成第二计划、不改变原计划金额。
10. 本地签名广播仍只使用 `eth_sendRawTransaction`，并且不依赖 `eth_fillTransaction`。

### 11.2 集成与手工验收

1. 在无活跃仓位钱包运行：稳定轮询、无交易、中文日志正确。
2. 在含一个受支持仓位的钱包运行：API、Pair、EMSH 三类请求的真实字段和方向均记录。
3. 使用 `rebalance.jsonc` 的本地测试参数，验证连续三次越界后只生成一次计划和一次交易序列。
4. 使用小额真实仓位演练完整 `dock -> ship`，核对 API、receipt、事件和 rawBalances。
5. 人为中断在 `dock` 确认后、`ship` 前的进程；重启验证仅恢复原计划。
6. 验证 API 与链上 raw 不一致、Pair/EMSH 价差过大、RPC 限流、授权失败、ship 模拟失败时都不会继续广播。

### 11.3 上线门槛

真实自动运行前必须完成：

```text
bun test
bunx tsc --noEmit
git diff --check
```

并完成至少一次小额端到端恢复演练。实际运行配置、状态文件、日志和 `.env` 均不得提交到 Git。

## 12. 待实施前需再次真实验证的接口行为

以下不是可假设的协议契约，编码时必须用真实调用确认并更新本文档：

1. `strategies/makers` 的 `nextCursor` 请求参数、翻页顺序和总量一致性。
2. Pair API 是否接受批量 pair，返回顺序是否与请求一一对应，及地址顺序是否强制规范排序。
3. `lastPrice` 的时间语义，以及 Pair/EMSH 合理偏离阈值在高波动时是否需要调整。
4. strategies API 新 ship 后的索引延迟分布。
5. 已确认使用每个策略的 `strategyHash` 作为独立标识；同一 pair 的多个 open concentrated `active` 策略必须分别监控，不得按 pair 合并或跳过；`illiquidity` 等未确认状态也必须显示，而非静默遗漏。

真实返回与本文档冲突时，以真实行为为准，修正实现、测试、示例和本文档后再继续自动交易。

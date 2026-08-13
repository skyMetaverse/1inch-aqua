# 添加 LP 功能开发设计文档

## 1. 文档目的

本文档定义当前项目 `/Users/syskey/git/1inch-aqua` 的添加 LP 功能、配置格式、目录规划、交易流程、日志要求和后续扩展边界。

参考项目 `/Users/syskey/git/aqua` 只用于确认 1inch Aqua API、Aqua SDK 和交易构建方式；所有新功能均在当前项目实现。

本文档是第一阶段开发依据。实现过程中如果真实接口返回、SDK 编码行为与本文档存在差异，必须以真实运行结果为准，并同步修正文档和示例。

## 2. 已确认范围

### 2.1 第一阶段目标

实现一个可真实广播链上交易的添加 LP 脚本，完成以下闭环：

1. 读取并解析 JSONC 配置。
2. 读取 `.env` 中的 `RPC_URL` 和加密私钥。
3. 复用现有私钥解密模块，交互式输入密码。
4. 从私钥派生钱包地址。
5. 查询两个 ERC20 代币的 `decimals`、钱包余额和 Aqua registry allowance。
6. 按配置的余额百分比计算投入数量。
7. 调用 EMSH 的 `current` 接口获取本次创建使用的实时价格。
8. 使用无损定点整数运算计算价格区间。
9. 构建 Aqua 集中流动性策略和 `ship` 交易。
10. 必要时按代币兼容规则发送最大值 ERC20 `approve` 交易并等待确认。
11. 发送 `ship` 交易并等待确认。
12. 将完整过程写入本次运行专属日志文件。

### 2.2 明确不包含

第一阶段不实现：

- Chainlink 价格接口。
- Chainlink 与 EMSH 价格交叉校验。
- 追加已有策略的流动性。
- 修改已有策略参数。
- 自动平仓或定时任务。
- Web UI。
- 多种日志级别和复杂日志路由。

这些功能应在现有模块边界上迭代，不应通过修改添加 LP 主流程来堆叠。

## 3. 目录规划

当前项目保持轻量入口，新增业务代码按职责拆分：

```text
1inch-aqua/
├── config/
│   ├── lp.add.example.jsonc       # 中文注释的配置示例，不含真实地址或密钥
│   └── README.md                   # 配置字段、单位和填写规则
├── docs/
│   └── 添加LP功能开发设计文档.md
├── src/
│   ├── app/
│   │   └── add-lp.ts              # 添加 LP 应用编排入口
│   ├── config/
│   │   ├── jsonc.ts               # JSONC 解析
│   │   └── lp-config.ts           # 配置类型、结构校验和规范化
│   ├── domain/
│   │   └── fixed.ts               # 百分比、金额、费率、价格区间和方向的无损定点计算
│   ├── infra/
│   │   ├── erc20.ts               # ERC20 只读查询和最大授权交易编码
│   │   ├── emsh.ts                # EMSH current 接口适配
│   │   ├── rpc.ts                 # 本地签名 raw transaction 广播
│   │   └── logger.ts              # 统一中文日志与运行日志文件
│   └── aqua/
│       └── strategy.ts             # Aqua 策略与 ship 构建适配
├── config/
│   ├── lp.add.example.jsonc       # 添加 LP 示例配置
│   └── README.md                  # 配置字段与单边规则说明
├── test/                          # 所有单元与回归测试，按被测模块命名
├── scripts/
│   ├── encrypt-private-key.ts      # 已有私钥加密和解密模块，保持不变
│   └── cancel-all-active-lp.ts     # 当前优先实现：查询并串行 dock 当前 maker 的全部活跃仓位
├── logs/                           # 运行时生成，必须加入 .gitignore
├── index.ts                        # 保留为项目说明或统一入口
├── package.json
├── README.md
└── tsconfig.json
```

### 3.1 模块边界原则

- `config` 只负责输入文件，不读取 RPC、不解密私钥、不发送交易。
- `domain` 只负责无副作用的精确计算，不能依赖网络和日志模块。
- `infra` 负责第三方接口、RPC、日志和文件系统适配。
- `aqua` 只负责把已经校验好的领域参数转换为 Aqua SDK 交易数据。
- `app` 负责按顺序编排流程、处理失败路径和输出关键业务日志。
- `wallet` 负责私钥的取得、传递和清理，不允许向其他模块暴露密码。

这样后续替换 EMSH 接口、增加其他价格源或增加测试网络时，不需要重写价格计算和交易编排。

## 4. 配置文件设计

### 4.1 文件格式

配置文件使用 JSONC：JSON 语法加 `//` 和 `/* ... */` 注释。配置文件建议默认路径为：

```text
config/lp.add.jsonc
```

也应支持通过命令行参数传入其他路径，例如：

```bash
bun run src/app/add-lp.ts config/lp.add.jsonc
```

JSONC 解析必须在读取后转换为标准对象，再进行严格结构校验。不能使用 `eval` 或执行配置内容。

### 4.2 配置示例

```jsonc
{
  // 目标链 ID。第一阶段按 1inch Aqua SDK 支持的链进行校验。
  "chainId": 1,

  // 本次执行要添加的 LP 仓位列表。
  "positions": [
    {
      "pair": {
        "tokens": [
          {
            // 仅用于日志和人工核对，不作为链上查询依据。
            "symbol": "1INCH",

            // ERC20 合约地址。
            "address": "0x111111111117dc0aa78b770fa6a738034120c302",

            // 使用钱包该代币余额的百分比，支持 0% 到 100% 和小数。
            // 例如 30% 表示使用余额的 30%。
            "balancePercent": "30%"
          },
          {
            "symbol": "USDT",
            "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "balancePercent": "50%"
          }
        ]
      },

      // 按池子页面显示的百分比填写，0.001% 就是链上实际费率 0.001%。
      // 不在配置中填写 BPS。
      "fee": "0.001%",

      "range": {
        // two-sided：双边；upper：上单边；lower：下单边。
        "mode": "two-sided",

        // current 价格向上浮动的百分比，可与下方不同。
        "upperPercent": "80%",

        // current 价格向下浮动的百分比，可与上方不同。
        "lowerPercent": "30%"
      }
    }
  ]
}
```

### 4.3 配置字段规则

#### `chainId`

- 必填正整数。
- 必须与 RPC 网络和 Aqua SDK 支持的网络一致。
- 网络不一致时在任何交易发送前终止。

#### `pair.tokens`

- 必须恰好两个代币。
- 两个地址必须不同，必须是有效 ERC20 地址。
- 数组顺序用于定义用户可读的价格方向：`[token0, token1]` 表示 `1 token0 = N token1`。
- `symbol` 只用于日志和人工复核，链上真实信息以地址查询结果为准。
- 不配置 `base`、`quote`。
- 不配置 `decimals`，运行时通过链上 `decimals()` 查询。
- 第一阶段只支持 ERC20，不处理原生 ETH；需要使用 WETH 等 ERC20 包装资产。

#### `balancePercent`

- 使用字符串表达，例如 `"0%"`、`"12.5%"`、`"100%"`。
- 允许范围为 `[0%, 100%]`，支持小数和较高精度。
- 以钱包当前链上 raw balance 为基准计算。
- 计算结果必须向下取整到 raw token 单位。
- 不能因为百分比计算产生超过钱包余额的数量。
- 配置为 `0%` 或计算后的 raw amount 为零时，必须明确记录并在发送前拒绝该仓位。

#### `fee`

- 使用带 `%` 的十进制字符串，表示池子最终显示的实际费率。
- 例：`"0.001%"` 必须创建实际费率为 `0.001%` 的池子。
- 不允许把配置单位解释为小数费率或 BPS。
- 脚本内部才转换到 Aqua SDK 的费率参数。
- 当前参考 SDK 的 `withFeeTokenIn()` 使用 BPS 参数；实现必须通过精确十进制解析完成百分比到 BPS 的转换，并验证 SDK 编码精度。
- 不能静默四舍五入、截断或替换为相邻费率。配置无法被当前 SDK 精确表达时，必须在广播前失败。

当前 SDK 参考关系为：

```text
1 bps = 0.01%
配置 0.001% = 0.1 bps
配置 0.04%  = 4 bps
```

当前安装的 SDK 实际编码为 `feePercent × 10^7` 的整数（等价于 `bps × 10^5`），允许范围为 0 到 1,000,000,000（100%）。已添加 `0.001% -> 10000 -> 0.1 bps` 的运行时策略构建测试；任何不能精确表示为该整数的费率都会在广播前拒绝。

#### `range`

- `mode` 必填，取值为 `two-sided`、`upper`、`lower`。
- `upperPercent`、`lowerPercent` 均使用带 `%` 的十进制字符串。
- 两侧可以完全不同，不能强制对称。
- `two-sided` 使用上下两个字段。
- `upper` 使用 `upperPercent`，下侧边界为 current 价格。
- `lower` 使用 `lowerPercent`，上侧边界为 current 价格。
- 上浮比例支持很小和很大的值，例如 `"0.001%"`、`"80%"`、`"300%"`。
- 下浮比例必须小于 `100%`，否则价格下限不大于零。
- 不使用 `Number` 计算边界。

## 5. 环境变量与敏感信息

`.env` 只保存运行所需配置，不提交版本库：

```dotenv
ENCRYPTED_PRIVATE_KEY=<已有加密私钥密文>
RPC_URL=https://your-rpc.example
```

规则：

- 继续复用 `scripts/encrypt-private-key.ts` 的 `getDecryptedPrivateKey()`。
- 解密密码只能通过隐藏 TTY 输入获取。
- 私钥不允许出现在日志、错误信息、命令行参数或文件中。
- 调用方持有的私钥 Buffer 在成功和异常路径都必须 `fill(0)`。
- `RPC_URL` 可以在启动时记录脱敏后的主机信息，但不能输出包含凭证的完整 URL。

## 6. 价格与精度设计

### 6.1 价格来源

- 唯一价格来源是 EMSH 的 `current` 接口。
- 不实现 Chainlink 接口。
- 不使用 `lastPrice`、缓存价格、旧价格或配置中的静态价格回退。
- current 请求失败、返回为空、价格非法或时间信息不可信时，直接停止本仓位广播。
- 当前实现最大接受数据年龄为 120 秒，最多允许 60 秒未来时间偏差；超出范围直接停止。
- 已通过真实请求确认路径为 `GET /v2.0/charts/v1.0/chart/tradingview/{token0}/{token1}/86400/{chainId}/current`，响应为 `{"data":{"result":{"timestamp":...,"price":...}}}`。
- 已通过同一非锚定交易对的正反 token 顺序请求确认：传入 `[token0, token1]` 时，`price` 表示 `1 token0 = N token1`；交换参数后返回倒数价格。
- 服务端当前将 `price` 序列化为 JSON number。实现读取原始响应文本并提取该数字字面量，不经过 JSON 解析后的 JavaScript `number`；若接口改为科学计数法、空值、零值、负值或时间戳不可信，必须停止广播。

### 6.2 用户价格方向与 Aqua 方向

用户配置的 token 顺序是可读方向。例如：

```text
[token0=1INCH, token1=USDT]
```

表示日志中的价格为：

```text
1 1INCH = N USDT
```

Aqua SwapVM SDK 的集中流动性价格使用规范 token 排序下的 `P = tokenGt / tokenLt`。已通过当前安装的 SDK `ConcentrateGrowLiquidity2DArgs.fromRawPrices` 源码和官方 README 确认：`rawPriceMin`、`rawPriceMax` 直接是该人类价格比的 `1e18` 定点值，SDK 内部计算 `sqrt(P * 1e18)`；不应按两个 ERC20 的 `decimals` 再缩放。`decimals` 仅用于余额 raw amount 的读取和日志展示。

因此必须有独立的价格方向转换模块：

1. 根据地址确定 Aqua 的 `tokenLt` 和 `tokenGt`。
2. 将 EMSH current 返回的用户方向价格转换为 SDK 方向。
3. 根据 SDK 方向计算 `rawPriceMin` 和 `rawPriceMax`。
4. 将用户方向的上下边界和 SDK 方向的 raw 边界同时写入日志。

任何反向转换都必须使用精确整数或定点有理数运算，不能先转成浮点数。

### 6.3 精确计算要求

核心交易参数禁止使用 JavaScript `Number`：

- current 价格作为十进制文本处理。
- 余额百分比、费率和区间百分比作为十进制文本处理。
- 使用 `bigint` 定点整数或精确有理数计算。
- `decimals` 只作为链上返回的整数精度使用。
- 余额百分比计算向下取整。
- 价格乘除、上下浮动、倒数和方向转换均保留明确的舍入策略。
- 最终传给 SDK 的 `rawPriceMin`、`rawPriceMax` 必须来自精确计算结果。
- `parseUnits`、`formatUnits` 或仓库已有精确转换函数只能作为定点转换工具，不能把核心价格变成浮点数。
- `Number` 只能用于不参与交易参数的普通展示，并且日志中的原始值必须同时保留字符串形式。

建议领域层提供以下无副作用函数：

```text
parsePercentage(text)
parseDecimal(text, scale)
calculatePercentAmount(rawBalance, balancePercent)
calculateRange(currentPrice, mode, upperPercent, lowerPercent)
convertDisplayPriceToAquaPrice(price, tokenOrder)
formatFixed(value, scale)
```

## 7. 链上交易流程

每个 position 按以下顺序执行：

1. 创建本次运行日志文件。
2. 读取 JSONC 并输出配置摘要。
3. 完成结构和数值校验。
4. 解密私钥并派生钱包地址。
5. 查询 RPC chain ID，确认与配置一致。
6. 查询两个代币的 `decimals()`。
7. 查询两个代币的 `balanceOf(wallet)`。
8. 按余额百分比计算 raw 投入数量。
9. 调用 EMSH current 接口。
10. 记录价格原始返回关键字段、时间戳、本地接收时间和请求耗时。
11. 计算用户可读区间。
12. 转换为 Aqua SDK 价格方向和 raw price。
13. 在日志中输出完整交易预览。
14. 构建 Aqua 策略、strategy bytes、strategy hash 和 ship calldata；每次构建使用 SDK 支持的 `uint64` 加密随机 salt，避免相同参数与已关闭策略重用同一 hash。
15. 查询两个代币对 Aqua registry 的 allowance。
16. allowance 不是最大值时，按代币兼容规则发送最大值授权，并等待每笔授权成功回执。
17. 发送 ship 交易并等待成功回执。
18. 输出交易哈希、区块号、策略哈希、投入数量、价格和区间。
19. 清理敏感 Buffer，记录本次运行结果。

任一步骤失败，都必须：

- 记录中文失败原因。
- 停止后续交易发送。
- 等待中的交易明确标记状态。
- 清理私钥和临时敏感 Buffer。
- 保留已完成步骤的日志，便于复盘。

### 7.1 授权策略

- spender 固定为当前链 Aqua registry 地址，地址来自 SDK 常量或经校验的配置适配器。
- 当当前 allowance 未覆盖本次仓位的 raw 投入数量时，授权请求的目标为 ERC20 `uint256` 最大值：`2^256 - 1`，即 `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`。
- 每个代币都先查询 `allowance(wallet, aquaRegistry)`；只要 allowance 已覆盖本次投入就跳过授权。不能把“等于 `MAX_UINT256`”作为通用成功条件，因为 ERC20 ABI 的 `approve(uint256)` 不限制合约内部 allowance 存储位宽或无限授权哨兵值。
- approve 确认后必须重新查询 allowance；实际额度覆盖本次投入才允许发送 ship。若合约将 `MAX_UINT256` 截断、映射为内部无限额度或设置其他上限，但仍覆盖本次投入，视为授权成功；若不足，停止后续交易。
- 当前 allowance 非零但不足本次投入时，对所有 ERC20 统一执行以下顺序，避免维护“必须先清零”的 token 地址名单：
  1. 发送 `approve(aquaRegistry, 0)`。
  2. 等待该清零交易成功确认。
  3. 再发送 `approve(aquaRegistry, MAX_UINT256)`。
  4. 等待授权交易成功确认，并重新查询 allowance，确认其覆盖本次投入。
- 当前 allowance 为零时，只需尝试最大值授权，无需额外清零交易。
- 该策略会让允许直接更新额度的标准 ERC20 在额度不足时多消耗一笔清零交易，但统一覆盖 USDT 类限制，且不依赖 token symbol、地址白名单或内部位宽猜测。
- 任一 approve 或 allowance 复查失败、回滚、超时，均不得发送 ship。
- 最大授权会允许 Aqua registry 在用户后续持有该代币时持续使用该代币额度。这是本需求明确选择的授权策略，日志和 README 必须对此风险作出清晰提示，并在后续迭代提供撤销授权脚本。

本规则的外部依据：

- [Tether USDT 已验证源码 `TetherToken.sol`](https://github.com/tethercoin/USDT/blob/main/TetherToken.sol)：`approve` 要求旧 allowance 非零时，新的非零授权必须先清零，说明需要通用兼容策略。
- [Ethereum 主网 USDT Etherscan 合约源码](https://etherscan.io/address/0xdac17f958d2ee523a2206206994597c13d831ec7#code)：用于核对该行为的已验证合约代码。
- [OpenZeppelin `SafeERC20.forceApprove`](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.5.0/contracts/token/ERC20/utils/SafeERC20.sol)：针对 USDT 类代币提供最大授权和清零重设的兼容思路；本项目选择预先清零，使每种 ERC20 采用同一可审计流程。
- [Uniswap 官方 `Uni.sol`](https://github.com/Uniswap/governance/blob/master/contracts/Uni.sol)：公开 `approve(uint256)` ABI 下内部 `allowances` 使用 `uint96`，并将输入 `uint256(-1)` 映射为 `uint96(-1)`；说明 ABI 宽度不等于内部 allowance 表示范围。
- Ethereum 主网 UNI 实链交易 `0x2d90d6eaeb1508d7f74bd214164946b4a0df3fced849bc848bdb495331e21e32`：`approve(MAX_UINT256)` 回执成功，但 `Approval` 事件和 `allowance` 回读均为 `79228162514264337593543950335`（`2^96 - 1`），验证了上述通用处理需要。

### 7.2 交易确认

- 交易广播后记录 hash。
- 使用 RPC 等待 receipt。
- receipt status 不是成功时视为失败。
- 交易超时必须记录 hash 和等待时长，不得伪报成功。
- ship 成功后 strategy hash 以本地构建值为主，并在日志中记录交易确认信息。

## 8. 日志设计

### 8.1 日志文件

每次运行创建一个独立日志文件，文件名统一使用：

```text
YYYY-MM-DD HH-mm-ss.SSS.log
```

示例：

```text
2026-07-24 18-30-55.545.log
```

文件名在所有平台都使用连字符 `-` 分隔时分秒，避免 Windows 不支持 `:` 的问题。日志内容仍使用冒号格式的时间戳。

建议输出目录：

```text
logs/2026-07-24 18-30-55.545.log
```

`logs/` 必须加入 `.gitignore`。日志文件不应提交版本库。

### 8.2 日志行格式

所有日志统一为 `info`：

```text
2026-07-24 18:30:55.545 [info]: 开始执行添加 LP
```

日志模块负责：

- 生成毫秒级本地时间戳。
- 同时写入终端和本次日志文件。
- 统一补齐 `[info]:` 格式。
- 保证关键步骤开始、成功、失败均有记录。
- 处理文件写入失败并在终端给出明确错误。

业务模块不能自行拼接时间戳或日志级别。

### 8.3 必须记录的信息

每个 position 至少记录：

- 运行开始时间、配置路径和日志路径。
- chain ID、脱敏 RPC 主机和钱包地址。
- token symbol、地址、配置顺序和链上 decimals。
- 配置的余额百分比、raw balance、可读余额和最终投入 raw amount。
- allowance 查询结果、是否已为最大值授权，以及本次采用的授权兼容规则。
- 每笔清零授权和最大值授权的 token、spender、目标额度、交易 hash、receipt 状态、区块号和确认耗时。
- EMSH current 请求参数、请求开始/结束时间、接口耗时、返回价格和接口时间戳。
- current 价格的用户方向、Aqua 内部方向和精度。
- `mode`、上下浮动百分比、用户可读区间、raw price 区间。
- fee 原始配置、换算后的内部参数和精度校验结果。
- strategy hash、ship 目标地址、交易 data 长度或安全摘要。
- approve hash、receipt 状态、区块号和确认耗时。
- ship hash、receipt 状态、区块号和确认耗时。
- 最终成功或失败结论。

### 8.4 日志安全

禁止写入：

- 明文私钥。
- 解密密码。
- 解密后的私钥 Buffer。
- 完整加密私钥密文。
- 带认证信息的完整 RPC URL。
- 不必要的完整交易 calldata。

交易 calldata 如需复盘，只记录目标地址、方法类型、长度和脱敏摘要；价格、金额、hash 等业务审计字段必须完整记录。

## 9. 校验与失败路径

发送任何交易前必须完成：

- JSONC 语法和字段校验。
- 地址校验和重复 token 校验。
- chain ID 与 RPC 网络校验。
- `balancePercent` 范围校验。
- fee 百分比格式、非负性和 SDK 可表达性校验。
- range 模式和上下比例校验。
- current 返回值、时间戳和价格方向校验。
- 投入 raw amount 大于零且不超过余额。
- `priceMin < priceMax` 且价格均大于零。
- strategy 构建成功。
- allowance 是否覆盖本次投入、截断/无限授权哨兵值回读、非零不足授权的清零重设流程和每笔 approve 回执确认。

所有失败都必须在发送下一笔交易前停止。多 position 执行策略应在实现前明确：第一阶段默认任一 position 失败即停止后续 position，避免部分成功后继续消耗资产；后续如需“失败后继续”再增加显式配置。

## 10. 测试与验证计划

### 10.1 单元测试

- JSONC 注释解析。
- 缺失字段、未知字段和错误类型。
- 地址格式、重复地址。
- `0%`、`100%`、小数百分比和超范围百分比。
- raw balance 按百分比向下取整。
- 费率 `0.001%`、`0.01%`、`0.04%` 和较大费率的精确转换。
- 每次策略构建生成不同的 `uint64` salt 和 strategy hash。
- 上下不对称区间。
- `two-sided`、`upper`、`lower` 三种模式。
- 下浮 `100%` 和负价格拒绝。
- 用户价格方向与 Aqua 价格方向的正向、反向转换。
- 大价格、小价格和高 decimals 场景下无浮点损耗。

### 10.2 集成测试

- 使用 mock RPC 验证 `decimals`、`balanceOf`、`allowance` 调用。
- 验证标准 ERC20 的零 allowance 直接最大值授权、已最大值授权跳过，以及非最大值授权更新路径。
- 验证 `MAX_UINT256` 输入被截断或映射为内部无限授权哨兵值后，只要实际 allowance 覆盖本次投入即可继续。
- 验证实际 allowance 不足本次投入时，即使 approve receipt 成功也不发送 ship。
- 验证零 allowance 直接最大值授权、任意非零且不足 allowance 先清零确认再最大值授权，以及任一步失败时不发送 ship。
- 模拟 approve 成功、失败、回滚和超时。
- 模拟 ship 成功、失败、回滚和超时。
- 模拟 EMSH current 返回正常、空值、零值、负值、非法格式和过期时间戳。
- 验证 current 失败时不会广播 ship。
- 验证日志文件创建、内容格式和敏感信息不泄露。
- 验证导入私钥模块不会触发加密脚本副作用。

### 10.3 真实环境验证

真实广播前必须先完成：

1. 只读 RPC 查询验证。
2. 小额测试钱包验证。
3. 交易预览日志人工复核。
4. 标准 ERC20 最大授权、非标准 ERC20 回读额度覆盖判断、非零不足授权的清零重设以及 ship 的回执验证。
5. 链上策略页面费率与配置值核对。
6. 日志中的 current 价格、计算区间和链上结果复盘。

## 11. 取消/关闭仓位调研结论

第一阶段虽然只实现添加 LP，但后续实现取消仓位时必须遵循 Aqua 的真实协议语义。这里的“取消仓位”对应 Aqua 的 `dock` 操作，不是传统 AMM 的赎回或提币操作。

### 11.1 当前优先实现：一键取消全部活跃 LP 脚本

由于需要先验证真实关闭链路，当前优先于添加 LP 实现 `scripts/cancel-all-active-lp.ts`。该脚本不读取 JSONC 仓位配置，而是复用加密私钥和 `RPC_URL`，由当前 maker 钱包发现并串行关闭全部活跃仓位。

脚本行为：

1. 默认真实广播；`--dry-run` 只执行仓位查询、链上预检和 dock 模拟，不广播交易。
2. 使用本文档定义的日志格式写入 `logs/YYYY-MM-DD HH-mm-ss.SSS.log`，所有记录均为中文 `[info]`。
3. 对每个 API 仓位校验 maker、chainId、地址、完整 token 列表，以及 `strategyHash = keccak256(strategyBytes)`。
4. 使用仓位返回的原始 `app` 构建 dock，避免用固定 router 地址覆盖仓位创建时的 app。
5. 在广播前读取每个 token 的 `rawBalances` 并使用 `eth_call` 模拟 dock。
6. 使用解密私钥派生的本地 `PrivateKeyAccount` 签名，通过 RPC 的 `eth_sendRawTransaction` 广播；禁止将裸 maker 地址作为账户传给 `viem`，以免错误调用节点代签的 `eth_sendTransaction`。
7. 串行关闭，避免 nonce 竞争；任一仓位失败即停止后续仓位，保留已完成操作和失败原因日志。
8. 每笔成功交易必须同时通过 receipt status、目标 `Docked` 事件和关闭后的 `rawBalances` 状态复核。
9. 只关闭仓位，不撤销 ERC20 allowance；撤销授权保留为独立后续操作。
10. 当接口返回数量达到当前 `limit=100` 时立即失败，避免在未确认分页语义时仅关闭前 100 个仓位。

### 11.2 仓位发现接口

参考项目已确认 1inch Aqua 页面使用以下接口查询某个 maker 的策略：

```text
GET /v2.0/aqua/v1.0/strategies/makers/{makerAddress}
  ?status=open
  &limit=100
  &chainId={chainId}
```

它适合在后续实现“列出当前已开仓位”和“按仓位关闭”时作为仓位发现接口。调用方使用本地解密私钥派生出的 maker 地址查询，`status` 可传 `open` 或 `closed`。

返回的每个仓位至少包含后续 dock 所需的资料：

- `chainId`、`maker`、`app`。
- `strategyHash`。
- `strategyBytes`，可用于重新计算并核对 `keccak256(strategyBytes)` 是否等于 `strategyHash`。
- `tokens[].address`，用于构造 dock 的完整 token 列表。
- `tokens[].initialBalance`、`tokens[].currentBalance`、`tokens[].wallet.balance`、`tokens[].wallet.allowance`。
- `classification.type`、`classification.state`、`classification.feePercent`、`openedAt`、`closedAt` 及性能统计。

接口的正确用途是“发现和展示候选仓位”，不能把 API 返回当作最终链上状态。关闭前仍必须：

1. 校验返回的 `maker` 与本地钱包地址一致。
2. 校验 `app` 属于目标链已确认的 Aqua 应用。
3. 校验 `strategyHash` 与 `strategyBytes` 的 Keccak-256 计算结果一致。
4. 通过 Aqua registry 的 `rawBalances` 和 `eth_call` 模拟确认策略仍可 dock。
5. 在 dock 成功后以交易 receipt、`Docked` 事件和链上状态作为最终成功依据；策略查询 API 未及时更新只能记录为索引延迟，不能覆盖链上结论。

`limit=100` 是参考实现当前传入的上限。在未取得真实响应中的分页字段或服务端限制说明前，不能断言一次请求可返回超过 100 条的“全部”仓位；后续实现需要对返回结构进行真实请求验证，并在存在分页时完整拉取。

该接口属于 1inch 页面 API，不是 Aqua 合约的状态读取接口。实现时应复用统一的 API 认证和请求通道，并将其隔离在 `infra/` 的仓位查询适配器中，避免领域层依赖 HTTP 返回格式。

### 11.3 链上实际操作

关闭一个仓位只需要 maker 钱包发送一笔 Aqua registry 的 `dock` 交易：

```typescript
const dockTx = aqua.dock({
  app: new Address(originalApp),
  strategyHash: new HexString(strategyHash),
  tokens: [new Address(token0), new Address(token1)]
})
```

参数必须满足：

- `app` 必须与创建仓位时注册的原始 Aqua app 地址一致；当前集中流动性仓位通常是 AquaSwapVMRouter，但一键关闭脚本必须使用策略接口返回并经链上预检确认的原始 app。
- `strategyHash` 必须是目标仓位的真实 hash，优先从策略查询接口的 `strategyHash` 获取；也可由完整 `strategyBytes` 重新计算 `keccak256` 得到。
- `tokens` 必须包含该策略创建时的全部 token，数量和 token 集合不能缺失。只传一个 token 或传错 token 会触发合约校验失败。
- 交易发送者必须是该策略的 maker 钱包。
- `dock` 的 `value` 为 `0`，不需要发送原生币作为业务金额；仍需支付链上 gas。

Aqua 合约的实现会对每个 token 将策略虚拟余额设置为 `0`，并把其状态标记为 docked，然后发出 `Docked(maker, app, strategyHash)` 事件。关闭不产生 `Pulled` 事件；`Pulled` 表示 Aqua 应用在交易成交过程中从 maker 钱包拉取代币，不能用作 dock 成功标志。

### 11.4 资金和授权行为

- Aqua 不托管 maker 的 ERC20。代币在仓位存续期间也一直留在 maker 钱包中，只有成交时才会由 Aqua 应用通过 allowance 从钱包转出。
- 因此 `dock` 不会把代币转回钱包，也没有“取回剩余 LP 代币”的步骤。
- `dock` 本身不需要 ERC20 approve，也不需要先把 Aqua registry allowance 设为零。
- 关闭仓位后，原策略不能继续成交；但 ERC20 allowance 仍然可能保留。
- 如果用户希望彻底停止相关 Aqua 应用继续使用钱包资产，还需要单独发送 ERC20 `approve(spender, 0)` 撤销授权。撤销授权是独立的风险控制操作，不应默认和 dock 绑定，避免影响同一钱包中其他仍在使用该授权的仓位。
- 当前项目采用最大授权策略，因此后续必须提供“关闭仓位”和“撤销授权”两个明确分开的操作入口，并在日志中清楚区分二者。

### 11.5 关闭后的验证

发送 dock 后必须等待交易 receipt，并同时完成：

1. receipt status 为成功。
2. 解析交易日志，确认目标 Aqua registry 发出 `Docked`，且 maker、app、strategyHash 与目标一致。
3. 通过策略查询接口查询该仓位的状态，确认不再属于 `status=open` 结果；接口更新存在延迟时，必须记录查询时间和待确认状态，不能伪报 API 已同步。
4. 如实现链上只读复核，可查询目标 token 的 Aqua raw balance，确认已进入 docked/inactive 状态，而不能只依据本地交易发送成功。

### 11.6 与调整仓位的关系

Aqua 策略配置是不可变的。`dock` 后旧策略 hash 会被永久标记为关闭，不能使用相同的 `strategyHash` 原地重开。修改费率、价格区间或投入配置时，必须生成不同的 strategy bytes 和新的 strategy hash，流程应为：

```text
dock 旧策略 -> 等待确认 -> 构建新的 strategy bytes/hash -> 必要时补充/复用授权 -> ship 新策略
```

因为代币没有从钱包转入 Aqua，dock 后不需要做资金提现或再次充值。新策略是否继续使用同一钱包的最大 allowance，应由新策略的 token 集合和授权状态决定。

### 11.7 依据与可信级别

- [Aqua 官方合约 `src/Aqua.sol`](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)：`dock` 将各 token 的虚拟余额清零并标记为 docked，只发出 `Docked`；`pull` 才会执行 ERC20 `transferFrom` 并发出 `Pulled`。
- [Aqua 官方 README](https://github.com/1inch/aqua/blob/main/README.md)：说明关闭策略使用 `dock`，以及 dock 后虚拟余额被移除。
- [Aqua 官方 TypeScript SDK 文档](https://business.1inch.com/portal/documentation/sdks/aqua-sdk)：说明 `dock` 参数为 `app`、`strategyHash` 和完整 token 列表，并提供关闭策略示例。
- [1inch Aqua 官方“Manage & close”说明](https://1inch.com/aqua/learn/manage-close)：说明关闭是清除策略配置的一笔交易，不移动代币；撤销 allowance 是另一个用于停止所有新成交的操作。
- 参考项目的 [策略查询接口封装](/Users/syskey/git/aqua/src/aqua/strategies.ts)：确认 Aqua 页面 API 的路径、查询参数与已观测字段。它仅用于仓位发现和展示，链上合约源码、RPC 读取和交易事件仍是状态最终依据。

## 12. 后续迭代方向

目录规划为以下迭代保留扩展点：

- `price/`：增加其他价格源、价格源交叉校验和价格偏差策略。
- `aqua/`：增加追加资金、读取已有策略和策略生命周期管理。
- `jobs/`：增加定时执行、重试策略和任务状态存储。
- `portfolio/`：增加多钱包、多链和资产风险控制。
- `logger/`：增加 JSON 日志、日志轮转和外部告警，但不改变业务层日志调用接口。
- `config/`：增加多个配置文件、环境覆盖和 dry-run 模式。
- `simulation/`：增加发送前 eth_call 模拟和 gas 预算检查。

后续扩展必须遵守：领域计算不依赖网络，第三方接口通过适配器隔离，交易发送必须经过统一编排和日志审计。

## 13. 实现前待确认项

以下内容必须在编码时通过真实代码或真实请求确认：

1. EMSH 服务端 JSON number 在服务端序列化前是否已经损失超过其数字字面量的精度；当前客户端已避免二次 JavaScript 浮点损失，但无法恢复服务端此前的精度截断。
2. 所有目标链的 Aqua registry 和 SwapVM router 地址。
3. 目标链上清零再授权的 gas 成本与非标准 ERC20 行为；本阶段统一采用清零重设，不依赖地址白名单。
4. RPC 是否支持交易回执等待、链 ID 查询、必要的 eth_call 和 `eth_sendRawTransaction`。

未确认前不应把示例返回值当作稳定接口契约，也不应广播真实资产交易。

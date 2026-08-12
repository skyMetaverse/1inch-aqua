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
- 撤销 LP（dock）。
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
│   │   ├── jsonc.ts               # JSONC 去注释和解析
│   │   └── lp-config.ts            # 配置类型、结构校验和规范化
│   ├── domain/
│   │   ├── percentage.ts           # 百分比字符串解析与精确计算
│   │   ├── price.ts                # 价格方向、区间和定点价格运算
│   │   └── amount.ts               # decimals、余额百分比和 raw amount 计算
│   ├── infra/
│   │   ├── erc20.ts                # ERC20 只读查询和交易编码
│   │   ├── emsh.ts                 # EMSH current 接口适配
│   │   ├── rpc.ts                  # RPC 客户端和交易确认
│   │   └── logger.ts                # 统一中文日志与运行日志文件
│   ├── aqua/
│   │   └── strategy.ts             # Aqua 策略、最大授权、ship 构建适配
│   └── wallet/
│       └── private-key.ts          # 复用现有解密模块并管理敏感 Buffer 生命周期
├── scripts/
│   └── encrypt-private-key.ts      # 已有私钥加密和解密模块，保持不变
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

SDK 当前底层编码还会把 BPS 转换为更细的固定整数。实现必须以已安装版本的真实编码结果为准，并为 `0.001%` 添加专门测试。

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
- EMSH 的真实接口路径、请求参数和返回字段必须在实现时用真实请求复核，不能仅凭示例推断。

### 6.2 用户价格方向与 Aqua 方向

用户配置的 token 顺序是可读方向。例如：

```text
[token0=1INCH, token1=USDT]
```

表示日志中的价格为：

```text
1 1INCH = N USDT
```

Aqua SwapVM SDK 的集中流动性价格使用规范 token 排序下的 `P = tokenGt / tokenLt`。因此必须有独立的价格方向转换模块：

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
14. 构建 Aqua 策略、strategy bytes、strategy hash 和 ship calldata。
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
- 授权目标固定为 ERC20 `uint256` 最大值：`2^256 - 1`，即 `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`。
- 每个代币都先查询 `allowance(wallet, aquaRegistry)`；仅当 allowance 已等于最大值时跳过授权。即使 allowance 已覆盖本次投入数量但不是最大值，仍按本需求更新为最大值。
- 标准 ERC20 且当前 allowance 为零时，直接发送一笔 `approve(aquaRegistry, MAX_UINT256)`。
- Ethereum 主网 USDT（`0xdAC17F958D2ee523a2206206994597C13D831ec7`）属于非标准授权代币：当当前 allowance 非零且不是最大值时，直接设置新的非零 allowance 会 revert。因此必须严格按以下顺序执行：
  1. 发送 `approve(aquaRegistry, 0)`。
  2. 等待该清零交易成功确认。
  3. 再发送 `approve(aquaRegistry, MAX_UINT256)`。
  4. 等待最大值授权交易成功确认，并重新查询 allowance，确认其等于最大值。
- 对 USDT 当前 allowance 为零的情形，只需发送最大值授权，无需额外清零交易。
- 第一阶段将此兼容规则显式限定为已确认的 Ethereum 主网 USDT 地址。其他链的 USDT、其他代币或代理升级后的行为，必须在实现时通过真实合约代码或模拟调用确认后才可加入相应规则；不能根据 symbol 猜测。
- 任一 approve 或 allowance 复查失败、回滚、超时，均不得发送 ship。
- 最大授权会允许 Aqua registry 在用户后续持有该代币时持续使用该代币额度。这是本需求明确选择的授权策略，日志和 README 必须对此风险作出清晰提示，并在后续迭代提供撤销授权脚本。

本规则的外部依据：

- [Tether USDT 已验证源码 `TetherToken.sol`](https://github.com/tethercoin/USDT/blob/main/TetherToken.sol)：`approve` 要求旧 allowance 非零时，新的非零授权必须先清零。
- [Ethereum 主网 USDT Etherscan 合约源码](https://etherscan.io/address/0xdac17f958d2ee523a2206206994597c13d831ec7#code)：用于核对当前主网地址的已验证合约代码。
- [OpenZeppelin `SafeERC20.forceApprove`](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.5.0/contracts/token/ERC20/utils/SafeERC20.sol)：针对 USDT 类代币提供先尝试直接授权，失败后清零再设置目标额度的兼容思路；本项目第一阶段采用更明确、可审计的 allowance 分支流程。

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
- allowance 最大值状态、USDT 清零后再授权流程和每笔 approve 回执确认。

所有失败都必须在发送下一笔交易前停止。多 position 执行策略应在实现前明确：第一阶段默认任一 position 失败即停止后续 position，避免部分成功后继续消耗资产；后续如需“失败后继续”再增加显式配置。

## 10. 测试与验证计划

### 10.1 单元测试

- JSONC 注释解析。
- 缺失字段、未知字段和错误类型。
- 地址格式、重复地址。
- `0%`、`100%`、小数百分比和超范围百分比。
- raw balance 按百分比向下取整。
- 费率 `0.001%`、`0.01%`、`0.04%` 和较大费率的精确转换。
- 上下不对称区间。
- `two-sided`、`upper`、`lower` 三种模式。
- 下浮 `100%` 和负价格拒绝。
- 用户价格方向与 Aqua 价格方向的正向、反向转换。
- 大价格、小价格和高 decimals 场景下无浮点损耗。

### 10.2 集成测试

- 使用 mock RPC 验证 `decimals`、`balanceOf`、`allowance` 调用。
- 验证标准 ERC20 的零 allowance 直接最大值授权、已最大值授权跳过，以及非最大值授权更新路径。
- 验证 Ethereum 主网 USDT 的零 allowance 直接最大值授权、非零 allowance 先清零确认再最大值授权，以及任一步失败时不发送 ship。
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
4. 标准 ERC20 最大授权、Ethereum 主网 USDT 清零后最大授权以及 ship 的回执验证。
5. 链上策略页面费率与配置值核对。
6. 日志中的 current 价格、计算区间和链上结果复盘。

## 11. 后续迭代方向

目录规划为以下迭代保留扩展点：

- `price/`：增加其他价格源、价格源交叉校验和价格偏差策略。
- `aqua/`：增加 dock、追加资金、读取已有策略和策略生命周期管理。
- `jobs/`：增加定时执行、重试策略和任务状态存储。
- `portfolio/`：增加多钱包、多链和资产风险控制。
- `logger/`：增加 JSON 日志、日志轮转和外部告警，但不改变业务层日志调用接口。
- `config/`：增加多个配置文件、环境覆盖和 dry-run 模式。
- `simulation/`：增加发送前 eth_call 模拟和 gas 预算检查。

后续扩展必须遵守：领域计算不依赖网络，第三方接口通过适配器隔离，交易发送必须经过统一编排和日志审计。

## 12. 实现前待确认项

以下内容必须在编码时通过真实代码或真实请求确认：

1. EMSH current 接口的准确 URL、query 参数和响应字段路径。
2. EMSH current 价格的报价方向及其与用户 token 顺序的关系。
3. EMSH 返回价格的字符串/数字类型和最大有效小数位；如服务端返回 JSON number，必须确认其是否已经产生精度损耗，并决定是否需要原始响应通道或服务端提供字符串字段。
4. 当前安装的 Aqua SDK 对费率内部精度、最小值和最大值的真实编码边界。
5. 所有目标链的 Aqua registry 和 SwapVM router 地址。
6. 非 Ethereum 主网 USDT 或其他非标准 ERC20 的最大授权兼容规则及其合约行为。
7. RPC 是否支持交易回执等待、链 ID 查询和必要的 eth_call。

未确认前不应把示例返回值当作稳定接口契约，也不应广播真实资产交易。

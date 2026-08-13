# 添加 LP 配置

添加 LP 使用 JSONC 配置。默认路径为 `config/lp.add.jsonc`，可参考 `config/lp.add.example.jsonc` 创建实际配置文件。实际配置文件包含真实资产比例，应只在本机保存；不要提交到版本库。

```bash
cp config/lp.add.example.jsonc config/lp.add.jsonc
bun run add-lp config/lp.add.jsonc --dry-run
```

## 字段

- `chainId`：目标链 ID，必须和 `.env` 中 `RPC_URL` 连接到的网络一致。
- `positions`：本次依次创建的仓位。任一仓位失败时，停止后续仓位。
- `pair.tokens`：恰好两个 ERC20。数组顺序定义展示价格：`[token0, token1]` 表示 `1 token0 = N token1`。不填写 `decimals`，脚本会链上查询。
- `symbol`：日志展示文本；真实代币以 `address` 为准。
- `balancePercent`：该 token 当前钱包余额的使用比例，必须是带 `%` 的字符串，范围 `0%` 到 `100%`。
- `fee`：页面显示的实际池子费率，例如 `"0.001%"` 创建费率为 `0.001%` 的策略。当前 SDK 最小精确粒度为 `0.0000001%`，更小的值会在广播前拒绝。
- `range.mode`：`two-sided`、`upper`、`lower`。
- `upperPercent`：current 向上浮动百分比。双边和上单边必须大于 `0%`。
- `lowerPercent`：current 向下浮动百分比。双边和下单边必须大于 `0%` 且小于 `100%`。

## 单边规则

根据 `tokens[0] -> tokens[1]` 的显示价格方向：

- `upper`：区间在 current 上方，只允许 `tokens[0]` 使用非零 `balancePercent`，`tokens[1]` 必须为 `0%`。
- `lower`：区间在 current 下方，`tokens[0]` 必须为 `0%`，只允许 `tokens[1]` 使用非零 `balancePercent`。
- `two-sided`：两个 token 都必须计算出大于零的投入 raw amount。

脚本以 EMSH `current` 接口作为唯一价格来源。请求失败、时间戳过期、零/负价格、科学计数法价格或价格区间无效时，会在授权和 `ship` 广播前停止。EMSH 返回超过 18 位小数时，脚本会在价格源边界使用 `bigint` 向下量化到 Aqua 的 18 位精度，并在日志记录被舍弃的小数；配置中的百分比、费率和其他价格字段仍拒绝超精度输入。

## 运行

`--dry-run` 会完成：配置校验、私钥解密、RPC/ERC20 查询、EMSH current、定点区间计算、策略构建、approve 模拟和 ship 模拟。它不会广播任何链上交易。

```bash
bun run add-lp config/lp.add.jsonc --dry-run
```

确认 `logs/` 中的仓位摘要、投入资产、配置报价与反向报价区间、费率、strategy hash 和交易预览无误后，再去掉 `--dry-run` 真实执行：

```bash
bun run add-lp config/lp.add.jsonc
```

真实执行仅在现有 allowance 未覆盖本次投入时尝试 `MAX_UINT256`。确认后脚本重新读取实际 allowance，只要该额度覆盖本次投入就继续；不会假设所有 ERC20 都原样存储 `MAX_UINT256`。所有非零且不足的 allowance 会先发送并确认 `approve(0)`，随后尝试最大授权，以兼容要求清零后才能修改额度的 ERC20。授权成功后 ship 失败时，授权仍会保留；脚本不会自动撤销授权。

## 自动再平衡 Bot

复制 `rebalance.example.jsonc` 为本地 `rebalance.jsonc` 后运行：

```bash
cp config/rebalance.example.jsonc config/rebalance.jsonc
bun run rebalance-bot config/rebalance.jsonc
```

此命令没有 `--dry-run`：输入私钥解密密码后会持续监控，并在满足策略条件时直接广播 `dock`、必要授权和 `ship`。仅支持当前 SDK 的 active concentrated 两 token 策略；未知 app、同一 pair 多条 active 策略、API 分页未确认、市场数据异常或链上预检不一致时会停止该仓位的自动处理并写中文日志。

Bot 使用官方 `strategies/makers` API 发现仓位和决定当前余额形态，使用 Pair API 检查市场活跃度，使用 EMSH current 计算 5 bp 区间。RPC 不按区块轮询仓位，只在已决定重挂的交易前后做 rawBalances、模拟、事件和回执复核。运行状态写入配置指定的 `stateFile`，其中包含待恢复计划但不包含私钥、密码、Bearer token 或完整 RPC URL；该文件与本地 `rebalance.jsonc` 均被 Git 忽略。

若 `dock` 已确认而 `ship` 因 RPC、余额、授权或合约状态变化失败，Bot 保留同一份计划并在下一轮优先恢复，不会生成第二个策略 hash 或悄悄修改投入金额。运行前应阅读 [Aqua自动再平衡Bot开发设计.md](/Users/syskey/git/1inch-aqua/docs/Aqua自动再平衡Bot开发设计.md)。

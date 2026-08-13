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

脚本以 EMSH `current` 接口作为唯一价格来源。请求失败、时间戳过期、零/负价格、科学计数法价格或价格区间无效时，会在授权和 `ship` 广播前停止。

## 运行

`--dry-run` 会完成：配置校验、私钥解密、RPC/ERC20 查询、EMSH current、无损区间计算、策略构建、approve 模拟和 ship 模拟。它不会广播任何链上交易。

```bash
bun run add-lp config/lp.add.jsonc --dry-run
```

确认 `logs/` 中的代币、当前价格、区间、费率、strategy hash 和交易预览无误后，再去掉 `--dry-run` 真实执行：

```bash
bun run add-lp config/lp.add.jsonc
```

真实执行仅在现有 allowance 未覆盖本次投入时尝试 `MAX_UINT256`。确认后脚本重新读取实际 allowance，只要该额度覆盖本次投入就继续；不会假设所有 ERC20 都原样存储 `MAX_UINT256`。所有非零且不足的 allowance 会先发送并确认 `approve(0)`，随后尝试最大授权，以兼容要求清零后才能修改额度的 ERC20。授权成功后 ship 失败时，授权仍会保留；脚本不会自动撤销授权。

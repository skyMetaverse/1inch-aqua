# 1inch Aqua 取消/关闭 LP 仓位调研

## 1. 调研范围与结论口径

本文只研究 1inch Aqua 现有官方合约源码、官方 SDK 和官方帮助文档所描述的 `dock` 操作，不修改业务代码或既有设计文档。

- **已确认**：由官方 Aqua 合约源码或官方 SDK/帮助文档直接支持的结论。
- **待真实环境验证**：需要针对目标链、目标 Aqua 部署地址、实际 SDK 版本或实际仓位再通过 RPC、`eth_call`、交易回执确认的事项。

主要一手资料：

- [官方 Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)
- [官方 IAqua.sol 接口](https://github.com/1inch/aqua/blob/main/src/interfaces/IAqua.sol)
- [官方 @1inch/aqua-sdk README](https://github.com/1inch/sdks/blob/master/typescript/aqua/README.md)
- [官方 Aqua 策略生命周期文档](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/strategy-lifecycle)
- [官方 Aqua 智能合约参考](https://business.1inch.com/portal/documentation/aqua/reference/smart-contract)
- [官方 Aqua 事件与接口参考](https://business.1inch.com/portal/documentation/aqua/reference/events-and-interfaces)

## 2. `dock` 的准确调用参数

官方接口签名为：

```solidity
function dock(
    address app,
    bytes32 strategyHash,
    address[] calldata tokens
) external;
```

参数含义：

| 参数 | 含义 | 来源 |
| --- | --- | --- |
| `app` | 与策略关联的 Aqua app 合约地址 | [IAqua.sol](https://github.com/1inch/aqua/blob/main/src/interfaces/IAqua.sol) |
| `strategyHash` | `keccak256(strategy)` 的策略哈希；SDK 通过 `AquaProtocolContract.calculateStrategyHash(strategy)` 计算 | [Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)、[Aqua SDK README](https://github.com/1inch/sdks/blob/master/typescript/aqua/README.md) |
| `tokens` | 要关闭的策略代币地址数组 | [IAqua.sol](https://github.com/1inch/aqua/blob/main/src/interfaces/IAqua.sol)、[Aqua SDK README](https://github.com/1inch/sdks/blob/master/typescript/aqua/README.md) |

SDK 的调用构造形式是：

```typescript
const dockTx = aqua.dock({
  app: new Address(app),
  strategyHash: AquaProtocolContract.calculateStrategyHash(new HexString(strategy)),
  tokens: [new Address(token0), new Address(token1)],
})
```

SDK 只负责编码交易数据；交易的 `to` 应是当前链 Aqua 合约地址，`value` 为 SDK 交易对象给出的原生币值（该调用不需要代币转账）。目标链地址不能只凭示例硬编码，应使用目标 SDK 版本的网络常量并通过 RPC 核对部署代码。

## 3. 谁可以调用，以及链上前置条件

### 3.1 调用者必须是 maker

**已确认。** `Aqua.sol` 的 `dock` 没有显式的 `maker` 参数，内部直接使用 `msg.sender` 访问：

```solidity
_balances[msg.sender][app][strategyHash][tokens[i]]
```

因此关闭仓位必须由创建/持有该策略余额的 maker 钱包发送交易。其他地址即使知道 `app`、`strategyHash` 和代币列表，也不会命中该 maker 的余额槽位，通常会因前置条件回滚。

来源：[官方 Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)。

### 3.2 `tokens` 必须覆盖策略全部代币

**已确认。** 合约对每个传入代币检查：

```solidity
require(balance.tokensCount == tokens.length, DockingShouldCloseAllTokens(app, strategyHash));
balance.store(0, _DOCKED);
```

`ship` 时每个策略代币槽位保存同一个 `tokens.length`。所以对于双代币策略，`dock` 必须传入两个代币地址；漏传、传入数量不一致或传入不属于该策略的地址，都会使交易回滚。官方错误名称也明确为 `DockingShouldCloseAllTokens`。

调用前建议读取每个候选代币的 `rawBalances(maker, app, strategyHash, token)`，确认其 `tokensCount` 与本次 `tokens.length` 一致，并确认 `strategyHash` 是原始 strategy bytes 的 Keccak-256 哈希。

来源：[官方 Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)、[官方 IAqua.sol](https://github.com/1inch/aqua/blob/main/src/interfaces/IAqua.sol)。

### 3.3 策略必须仍处于可关闭的活动状态

**已确认。** 活动策略的 `tokensCount` 是策略代币数量；`dock` 成功后将其写为内部哨兵值 `_DOCKED = 0xff`，余额写为零。再次对同一策略执行通常会因 `0xff != tokens.length` 而回滚。活动余额不足不是 `dock` 的前置条件，因为 `dock` 不读取 maker 的 ERC20 余额，也不发起代币转账。

**边界：空数组。** 当前源码的循环在 `tokens.length == 0` 时不会执行，随后仍会发出 `Docked(msg.sender, app, strategyHash)`。这不会清除任何代币槽位，不能视为有效关闭仓位。调用方不应使用空数组；目标链部署版本是否与当前源码一致，需通过真实 `eth_call`/字节码和回执验证。

来源：[官方 Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)。

## 4. 是否转移或赎回代币

**已确认：`dock` 不转移、不赎回 ERC20。** 官方实现的 `dock` 只有内部余额状态更新和 `Docked` 事件，没有 `IERC20.safeTransfer` 或 `safeTransferFrom` 调用。Aqua 的余额是 maker 授予 app 的**虚拟余额/内部记账额度**，代币一直留在 maker 钱包；官方 SDK 也将 dock 描述为移除策略虚拟余额并关闭策略。

因此：

- `dock` 不会把剩余“LP 余额”转回 maker，因为该余额并未由 Aqua 持有。
- `dock` 不会产生 ERC20 `Transfer` 事件。
- 如果策略此前已经通过 `pull` 实际转走代币，`dock` 不会反向返还已转走的代币；它只把该策略的剩余虚拟额度清零。
- 关闭后的 maker 资产余额应通过各代币合约的 `balanceOf(maker)` 单独查询确认，而不是从 `dock` 回执推断。

来源：[官方 Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)、[官方 Aqua 核心概念文档](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/core-concepts)、[官方 Aqua SDK README](https://github.com/1inch/sdks/blob/master/typescript/aqua/README.md)。

## 5. 会触发的事件

成功执行会在 Aqua 合约上触发一个：

```solidity
event Docked(address maker, address app, bytes32 strategyHash);
```

事件字段：

- `maker`：发送 `dock` 交易的地址，即 `msg.sender`。
- `app`：调用参数中的 app 地址。
- `strategyHash`：调用参数中的策略哈希。

当前官方接口未定义代币地址或金额字段，也不会因为 `dock` 自动触发 `Pushed`、`Pulled` 或 ERC20 `Transfer`。交易失败/回滚时，状态和事件都不会保留在链上。

事件签名及 Aqua 注册表事件归属见：[官方 IAqua.sol](https://github.com/1inch/aqua/blob/main/src/interfaces/IAqua.sol)、[官方 Aqua 事件与接口参考](https://business.1inch.com/portal/documentation/aqua/reference/events-and-interfaces)。SDK 提供 `DockedEvent.fromLog(log)` 用于解析该事件，见：[官方 Aqua SDK README](https://github.com/1inch/sdks/blob/master/typescript/aqua/README.md)。

## 6. 是否需要撤销 ERC20 allowance

### 6.1 `dock` 本身不需要新的 ERC20 allowance，也不会自动撤销 allowance

**已确认。** Aqua 在执行策略 `pull` 时使用的是代币对 Aqua 合约的授权：

```solidity
IERC20(token).safeTransferFrom(maker, to, amount);
```

而 `dock` 没有任何 ERC20 调用。因此：

- 执行 `dock` 前不需要为 `dock` 额外调用 ERC20 `approve`。
- 执行 `dock` 不会调用 `approve(token, Aqua, 0)`。
- 已存在的 `allowance(maker, AquaAddress)` 不会因为关闭策略自动变化。
- 如果曾为 Aqua 设置过最大授权，该授权仍持续存在，直到 maker 另行调用代币的 `approve(AquaAddress, 0)` 或设置其他额度。

来源：[官方 Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol) 中的 `pull`/`dock` 实现；[官方 Aqua 核心概念文档](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/core-concepts) 说明代币留在 maker 钱包并由授权支持策略。

### 6.2 是否应该主动撤销 allowance

这是运营和安全策略，不是 `dock` 的协议前置条件。若该 maker 不再信任该 Aqua 部署地址，或希望关闭后收回长期授权风险，可在 `dock` 成功确认后，针对每个代币单独发送：

```solidity
approve(aquaAddress, 0)
```

该操作是独立 ERC20 交易，不属于 `dock` 原子流程；应等待其回执并重新查询 allowance。非标准 ERC20（例如某些要求先清零再设置非零值的代币）必须依据目标链上的真实合约行为处理，不能仅依据 symbol 推断。

## 7. 关闭后重开或调整策略的关系

### 7.1 同一 `strategyHash` 不能通过再次 `ship` 修改或重开

**已确认。** `strategyHash = keccak256(strategy)`。`ship` 对每个策略代币要求原槽位 `balance.tokensCount == 0`，否则抛出 `StrategiesMustBeImmutable`；`dock` 后槽位不是零，而是 `_DOCKED = 0xff`。因此同一 `app + maker + strategyHash + token` 不能通过再次 `ship` 重新激活或调整金额。

这意味着 `dock` 是该策略哈希的终止/撤销状态，不是暂停后可原地恢复的开关。

来源：[官方 Aqua.sol](https://github.com/1inch/aqua/blob/main/src/Aqua.sol)、[官方 IAqua.sol](https://github.com/1inch/aqua/blob/main/src/interfaces/IAqua.sol)。

### 7.2 调整策略需要新 strategy bytes，从而得到新 hash

**已确认的协议约束；具体 app 兼容性待验证。** 如果要调整价格区间、费率、代币组合或其他策略参数，应按 app 的策略编码规则生成新的 strategy bytes，使其产生新的 `keccak256` 哈希，然后以新哈希执行新的 `ship`。对于多数策略，通常还需要使用新的 salt/nonce 等字段保证 bytes 确实变化；是否允许相同参数搭配某个 salt，由具体 app 的策略校验逻辑决定。

官方 SDK 示例也从完整 strategy bytes 计算 hash，并将其用于 dock；策略编码由具体 Aqua app 定义，而非由 `dock` 修改。来源：[官方 Aqua SDK README](https://github.com/1inch/sdks/blob/master/typescript/aqua/README.md)、[官方 Aqua 策略文档](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/strategy)。

### 7.3 重新 ship 前的 allowance 关系

如果 dock 后未撤销 `allowance(maker, AquaAddress)`，重新 ship 新策略通常不需要重新 approve，只要现有授权额度足够后续策略的 `pull`；但这是授权额度是否足够的常规 ERC20 判断，不是 dock 自动保留了某种 LP 仓位。若已主动撤销 allowance，则新策略真正执行 swap/pull 前需要重新授权。

## 8. 建议的实际执行顺序

1. 从可靠来源取得完整 strategy bytes，并计算 `strategyHash = keccak256(strategy)`。
2. 确认 RPC `chainId` 和目标 Aqua 合约地址；不要跨链复用地址配置而不核对部署。
3. 用 maker 地址查询 `rawBalances(maker, app, strategyHash, token)`，枚举并确认全部策略代币及其 `tokensCount`。
4. 组装非空且完整的 `tokens[]`，其长度应与策略代币数一致。
5. 对 Aqua 合约执行 `eth_call` 模拟 `dock(app, strategyHash, tokens)`，检查是否回滚。
6. 由 maker 钱包发送交易并等待成功回执。
7. 解码 Aqua 的 `Docked(maker, app, strategyHash)` 日志。
8. 回读所有代币的 `rawBalances`，确认余额为 `0` 且状态不再是活动状态；再按独立运营策略决定是否撤销 ERC20 allowance。
9. 若调整策略，生成新的 strategy bytes/hash 后再执行新的 `ship` 流程；不要尝试用原 hash 原地重开。

## 9. 待真实环境验证项

以下内容不能只靠文档结论代替实链确认：

- 目标链实际 Aqua 地址是否为当前官方 SDK 常量中的地址，以及该地址的代码是否对应当前 `Aqua.sol` 版本。
- 目标仓位的真实 `app`、`strategyHash`、代币完整列表和 maker 地址。
- 目标 RPC 对 `rawBalances`、`eth_call`、日志查询和交易回执的支持情况。
- 目标代币的实际 `allowance`、余额和非标准 ERC20 行为；尤其是撤销或重新设置授权时是否需要代币特定流程。
- `dock` 交易的 gas、确认时间、链重组/延迟以及回执中的实际日志。
- 目标 app 是否在 Aqua 之外维护仓位状态、是否需要额外的 app/router 关闭动作；Aqua `dock` 本身只处理 Aqua 注册表中的虚拟余额。
- 同一 app 对新 strategy bytes、salt/nonce、代币顺序和重新 `ship` 的具体校验规则。

以上待验证项不应在未完成只读模拟和小额实链测试前，直接作为真实资产关闭流程的充分保证。

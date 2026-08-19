# AKUV 共享流动性调研

> 调研范围：只读核对 Aqua/SwapVM 官方资料、官方 GitHub 源码和本地已安装 SDK；未读取 `.env`，未调用本地私钥，未广播交易。本文中的“AKUV”按用户语境理解为 Aqua 的共享流动性/SwapVM 集中流动性活动。官方资料检索到的正式术语主要是 Aqua、shared liquidity、virtual balances、SwapVM，未在官方源码或官方文档中确认“AKUV”是一个单独的协议组件或特殊 strategy 类型。

## 1. AKUV/shared liquidity 的协议机制

### 已确认

1. Aqua 不托管 maker 的 ERC20。token 保留在 maker 钱包；Aqua registry 只保存虚拟余额记账。官方文档将 virtual balance 定义为针对 maker 对 Aqua 的 ERC20 allowance 的内部计数器，而不是 deposit、锁仓或所有权转移。
2. Aqua 的核心 storage 维度是：`maker -> app -> strategyHash -> token`。每个策略有自己的虚拟余额槽，但不同策略槽背后的真实 token 是同一个 maker 钱包余额。
3. `ship()` 注册策略并写入初始虚拟额度；`dock()` 关闭策略并清理虚拟额度，两者本身都不转移 token。
4. 成交时由 AquaApp 调用 `pull()` 和 `push()`：
   - `pull()` 从 maker 钱包直接 `transferFrom(maker, taker/recipient)`，并减少对应策略的虚拟余额；
   - `push()` 从 app/taker 路径把输入 token 转回 maker 钱包，并增加对应策略的虚拟余额。
5. 共享的含义是：同一个钱包里的同一份真实资产可以同时被多个策略引用。多个策略可以各自报出虚拟深度，但某一笔真实成交最终仍受 maker 的实际钱包余额和可用 allowance 约束。实际余额不足时，`pull()` 失败，成交原子回滚，不产生 Aqua 坏账。

### 关键来源

- 官方 Aqua 仓库 README：<https://github.com/1inch/aqua>，Shared Liquidity、virtual balances、Aqua 架构说明。
- 官方源码：<https://github.com/1inch/aqua/blob/main/src/Aqua.sol>，`_balances` 嵌套 mapping、`rawBalances`、`safeBalances`、`ship`、`dock`、`pull`、`push`。
- 官方开发文档：<https://business.1inch.com/portal/documentation/aqua/liquidity-layer/core-concepts>，Maker/Taker、strategy、virtual balance、共享策略和 underfunding 说明。
- 官方开发文档：<https://business.1inch.com/portal/documentation/aqua/liquidity-layer/virtual-balances>，共享余额示例、SLR、`pull`/`push` 和 allowance 语义。
- 官方博客：<https://blog.1inch.com/aqua-developer-release/>，明确表述同一 wallet balance 可支持多个 strategies，资产保持在钱包中。

## 2. `amountsAndTokens` 对钱包 ERC20 与 virtual balances 的真实语义

### 已确认

Aqua SDK 的 `amountsAndTokens` 是 SDK 对 `ship(address app, bytes strategy, address[] tokens, uint256[] amounts)` 的便捷输入。SDK 只把对象数组拆成两个平行数组：

```ts
amountsAndTokens.map(({ token }) => token)
amountsAndTokens.map(({ amount }) => amount)
```

它没有把 amount 解释为从钱包立即转出的金额，也没有在 SDK 层做钱包余额、allowance 或总额校验。

官方 `Aqua.sol` 的 `ship()` 实际逻辑是：

```solidity
strategyHash = keccak256(strategy);
...
_balances[msg.sender][app][strategyHash][tokens[i]]
    .store(amounts[i].toUint248(), tokensCount);
```

然后发出 `Shipped` 和每个 token 对应的 `Pushed` 事件。`ship()` 没有 `IERC20.transferFrom`，没有 `balanceOf`，也没有 allowance 检查。因此：

- `amountsAndTokens[i].amount` = 该 `strategyHash` 对该 token 的初始 virtual balance，单位是 ERC20 raw/base units；
- 它不是“从钱包 pull 的金额”；
- 它不是 ship 交易时的实际 token 支出；
- `amount = 0` 仍可以登记该 token 的策略槽，`tokensCount` 仍按传入 token 数量记录；
- 真实 ERC20 是否足够，要到后续 swap 的 `pull()` 执行时才由 ERC20 `transferFrom` 结果体现；
- 合约把 amount 转成 `uint248`，超出范围会因 SafeCast 失败，不能把它当作任意大的 `uint256` 存储。

这里有一个重要的证据优先级：部分官方文字把 allowance 描述为 virtual allocation 的约束，但当前官方 `Aqua.sol` 的 `ship()` 代码本身没有强制“所有策略 virtual amount 总和不超过 allowance”。严格按源码，ship 阶段不强制该上限；allowance/实际余额是在 `pull()` 的实际转账阶段发挥作用。集成方仍应监控 virtual commitment 与真实余额/allowance 的覆盖关系，因为过度虚拟承诺会造成策略无法成交。

### 关键来源

- 本地 SDK 类型：[node_modules/@1inch/aqua-sdk/dist/index.d.ts](/Users/syskey/git/1inch-aqua/node_modules/@1inch/aqua-sdk/dist/index.d.ts:10)，`ShipArgs`、`AmountsAndTokens`。
- 本地 SDK 编码实现：[node_modules/@1inch/aqua-sdk/dist/index.mjs](/Users/syskey/git/1inch-aqua/node_modules/@1inch/aqua-sdk/dist/index.mjs:464)，`encodeShipCallData()` 将 token/amount 平行映射为 ABI 参数。
- 本地 SDK CommonJS 实现：[node_modules/@1inch/aqua-sdk/dist/aqua-protocol-contract/aqua-protocol-contract.js](/Users/syskey/git/1inch-aqua/node_modules/@1inch/aqua-sdk/dist/aqua-protocol-contract/aqua-protocol-contract.js:23)，`ship()` 只构造 calldata，`calculateStrategyHash()` 对 strategy bytes 做 `keccak256`。
- 本地 SDK README：[node_modules/@1inch/aqua-sdk/README.md](/Users/syskey/git/1inch-aqua/node_modules/@1inch/aqua-sdk/README.md:37)，说明 `ship` 是 setting virtual token balances；示例说明 ship 后 token 进入 virtual balance system。
- 官方源码：<https://github.com/1inch/aqua/blob/main/src/Aqua.sol>，约 `rawBalances`、`ship`、`pull`、`push` 定义处。
- 官方文档：<https://business.1inch.com/portal/documentation/aqua/reference/smart-contract>，`ship` 参数、virtual amount、strategy hash 说明。

## 3. 同一 maker/app 下不同 `strategyHash` 如何共享资金

### 已确认

Aqua 的 key 不是“钱包余额账户减法”，而是独立的 registry 槽位：

```text
_balances[maker][app][strategyHash][token]
```

因此，同一 maker、同一 app 下，只要三个 strategy bytes 不同并产生三个不同 hash，就可以分别 `ship()`：

```text
wallet: 100 TOKEN
  Strategy A / hashA: virtual 100 TOKEN
  Strategy B / hashB: virtual 100 TOKEN
  Strategy C / hashC: virtual 100 TOKEN
```

这三个槽位可以同时 active；它们的 virtual amount 可以都引用同一钱包余额。若任何一个策略成交，`pull()` 都从同一个 maker 钱包发起 ERC20 `transferFrom`。如果多个策略累计实际成交使钱包余额不足，后续 `pull()` 会失败，而不是从 Aqua 获得额外资金。

对本仓库的 SwapVM 集中流动性实现：

- `app` 是 `AQUA_SWAP_VM_CONTRACT_ADDRESSES[chainId]` 对应的 AquaSwapVM app/router；
- strategy bytes 是 `Order.encode()` 的结果，其中包含 maker、program 和 traits；
- program 中的价格区间、费率和 salt 会影响 strategy bytes；
- `salt` 用于避免相同参数下 hash 相同；本仓库 [src/aqua/strategy.ts](/Users/syskey/git/1inch-aqua/src/aqua/strategy.ts:65) 使用随机 `uint64` salt；
- 不需要为“共享流动性”另造特殊 strategy/program。共享是 Aqua registry 的 accounting/资金模型；program 仍由 SwapVM 正常定义价格和成交逻辑。

若希望使用不同 app，也可以共享同一个 maker 钱包，但会形成不同的 app 维度槽位；swap 时调用方必须与 ship 时的 app 匹配。对本仓库三个集中策略而言，通常是同一个 SwapVM app、三个不同 strategyHash。

### 关键来源

- 官方源码：<https://github.com/1inch/aqua/blob/main/src/Aqua.sol>，mapping 声明和 `ship`/`pull` 使用的 key。
- 官方文档：<https://business.1inch.com/portal/documentation/aqua/liquidity-layer/strategy>，strategy identity 为 `(maker, app, strategyHash)`，以及每策略独立槽位、同钱包共享真实资产。
- 官方文档：<https://business.1inch.com/portal/documentation/aqua/swapvm/program-order-and-strategy>，Program、Order、Strategy 三层关系和 hash/immutability。
- 本地实现：[src/aqua/strategy.ts](/Users/syskey/git/1inch-aqua/src/aqua/strategy.ts:69)，`AquaXYCAmmStrategy -> Order.new -> order.encode -> aqua.ship`。
- 本地实现：[src/app/add-lp.ts](/Users/syskey/git/1inch-aqua/src/app/add-lp.ts:271)，同一个 maker 下按每个 position 构建策略。

## 4. 三个 strategy 的正确注资、模拟与余额校验模型

以下假设三个 strategy 在同一链、同一 maker、同一 Aqua registry/app 下，并分别使用 `hashA/hashB/hashC`。

### 4.1 注资/授权模型

1. 每个 strategy 的 ship 输入应是其希望登记的 virtual allocation：

```text
ship(A, [T0, T1], [a0, a1])
ship(B, [T0, T1], [b0, b1])
ship(C, [T0, T1], [c0, c1])
```

2. 不应把 `a0+b0+c0` 或 `a1+b1+c1` 当成 ship 时必须从钱包支付的金额。ship 不转 ERC20。
3. ERC20 approval 的 spender 应是 Aqua registry，因为未来 `pull()` 会由 app 调 Aqua，再由 Aqua 对 maker 钱包执行 `transferFrom`。授权金额应按运营策略覆盖实际可能成交的输出 token；它不是 ship amount 的即时扣款证明。
4. 仍需监控真实 `balanceOf(maker)`、`allowance(maker, registry)` 与所有 active strategy 的 virtual balances。共享流动性允许 virtual totals 大于 wallet balance，但这意味着部分成交场景会暂时不可执行。

### 4.2 模拟模型

1. 先对每个 strategy 的独立 ship calldata 做 `eth_call`，检查其自身 registry/app/strategyHash/token 数量和不可重复 hash 约束。
2. 再将三个 ship calldata 放入同一个 Aqua registry `multicall(bytes[])`，对完整 multicall 做一次 `eth_call`，必要时 `estimateGas`。这是正确的原子性校验：若某个策略因 hash 已存在、token 数量非法或 calldata 错误失败，整笔 multicall 回滚。
3. 模拟 ship 不会模拟未来 swap，也不应把 ship 的成功解释为“钱包已经有三份实际资金”。若要验证成交能力，应另行用 SwapVM `quote`/swap-path `eth_call` 针对每个 strategy、方向和交易规模模拟 `pull/push` 路径；quote 主要验证 program/virtual balance 逻辑，不能替代对真实钱包余额和 allowance 的运营监控。
4. multicall 的 `msg.sender` 语义必须确认保持为 maker；本仓库的 `buildAquaMulticallTransaction()` 只编码 registry 的 `multicall(bytes[])`，且要求每个 child 的 target 是 registry、value 为 0。实际部署的 AquaRouter/Multicall 实现应与该调用模型匹配。

### 4.3 余额校验模型

- ship 前可做“信息性”余额检查：记录每 token 的钱包余额、allowance、各策略拟登记 virtual amount，以及 virtual total/wallet ratio；发现 underfunding 时告警或按产品政策拒绝，但不能把它当作 Aqua ship 的协议必要条件。
- 不应执行“wallet balance >= 三个 strategy amount 之和”作为 multicall ship 的硬失败条件。该条件把共享 virtual allocations 错当成三次真实转账，可能错误阻止合法的共享流动性开仓。
- ship 后应按 `(maker, app, strategyHash, token)` 读取 `rawBalances` 或对合法 token pair 使用 `safeBalances`，逐策略验证链上 virtual amount 等于该策略的输入 amount、`tokensCount` 等于 ship 的 token 数量。
- 如果业务目标不是“共享流动性”，而是保证三个策略无论同时成交都能独立兑现，则应显式采用更严格的产品级资金政策，例如限制 virtual totals 不超过钱包/allowance，或按 worst-case concurrent fill 做风险预算。这是应用层风控，不是 Aqua `ship()` 的必需语义。

## 5. `src/app/add-lp.ts` 可能不正确或需要明确区分的行为

### 已确认的风险/语义偏差

1. 原先 `broadcastPreparedShips()` 在 multicall 前按 token 汇总三个 strategy 的 amount，并用钱包 `balanceOf` 做 `balance < total` 硬失败。该检查与 Aqua shared liquidity 语义不一致：三个 amount 是三个 virtual allocation，不是三次 ERC20 转账。本次已移除这段合计余额硬校验。
2. `addPosition()` 为每个 position 读取钱包 ERC20 balance，并按 `balancePercent` 计算 ship amount。这种计算可以作为“想登记多少 virtual liquidity”的产品输入，但日志和变量若称为“实际投入/注资”容易误导。实际 ship 阶段没有 token 转出；真实转出发生在未来 swap 的 `pull()`。
3. `ensureMaximumAllowance()` 以本策略 `requiredAmount` 触发 approve。由于 ship 本身不 pull token，这不是 ship 成功的协议必要条件，而是为了未来成交建立 allowance 的提前操作。对多个共享策略而言，按每个 position 分别触发授权会产生不必要的重复读取/授权流程；尤其在 dry-run 中，它模拟的是 approve calldata，不是 ship 的资金需求。
4. 当前脚本先对每个 child 单独 `publicClient.call(ship)`，随后再对完整 multicall 模拟。这种重复模拟不是协议错误，但单独 ship call 成功不等于最终 multicall 必然成功；最终完整 multicall 模拟才是原子提交前的关键结果。
5. `verifyShipReceipt()` 使用 `rawBalances` 校验每个策略槽位的 virtual amount，这个校验方向正确；`rawBalances` 不验证 token 是否属于 active strategy，所以这里必须依赖本次 ship 的 token 列表和 `tokensCount === 2`，当前代码确实做了这项配合校验。若未来 token 列表或 token 数量可变，生产代码应改用 `safeBalances` 或显式检查完整 token 集合。
6. `buildConcentratedStrategy()` 为单边策略传两个 token，其中一侧 amount 为 0。对 Aqua registry 来说，零 amount 仍是该 strategy 的 virtual balance 槽位；对 SwapVM program 是否允许该方向及其后续 quote/fill，则由具体 program/SwapVM 逻辑决定，不能仅依据 ship 成功判断单边成交一定可行。
7. 当前工作区 `src/aqua/multicall.ts` 的注释和构造器把 multicall 视为 registry 的 atomic batch。需要保持对实际部署合约的确认：官方 AquaRouter 组合了 Aqua、Simulator、Multicall；若链上地址不是包含该 multicall 实现的 AquaRouter，仅凭 SDK registry 地址或本地 ABI 不能推断 multicall 一定存在。
8. `strategyHash` 必须真正不同。脚本使用随机 salt，通常可以满足这一点；但重试、恢复或持久化场景应保存并复用 strategy bytes/salt，避免重新生成 hash 后把“同一仓位”误当成新策略，也避免旧 active strategy 未 dock 时留下多份 virtual allocation。

### 本地关键位置

- [src/app/add-lp.ts](/Users/syskey/git/1inch-aqua/src/app/add-lp.ts:224)：按钱包余额百分比计算每个 strategy 的 amount。
- [src/app/add-lp.ts](/Users/syskey/git/1inch-aqua/src/app/add-lp.ts:271)：构建 strategy 和 ship calldata。
- [src/app/add-lp.ts](/Users/syskey/git/1inch-aqua/src/app/add-lp.ts:282)：按单策略 amount 提前确保 allowance。
- [src/app/add-lp.ts](/Users/syskey/git/1inch-aqua/src/app/add-lp.ts:286)：单策略 ship 模拟。
- [src/app/add-lp.ts](/Users/syskey/git/1inch-aqua/src/app/add-lp.ts:302)：receipt、事件和 `rawBalances` 校验。
- [src/app/add-lp.ts](/Users/syskey/git/1inch-aqua/src/app/add-lp.ts:342)：批量 ship 编排；当前未提交改动已删除错误的合计钱包余额硬校验。
- [src/aqua/strategy.ts](/Users/syskey/git/1inch-aqua/src/aqua/strategy.ts:69)：SwapVM program、Order、strategy hash、ship 交易。
- [src/aqua/multicall.ts](/Users/syskey/git/1inch-aqua/src/aqua/multicall.ts:41)：registry multicall calldata 编码和 child 校验。
- [node_modules/@1inch/aqua-sdk/dist/index.mjs](/Users/syskey/git/1inch-aqua/node_modules/@1inch/aqua-sdk/dist/index.mjs:464)：已安装 `@1inch/aqua-sdk@0.3.0` 的真实 ship 编码。

## 结论（不超过 250 字）

Aqua 的 `ship` 不从钱包转 ERC20，只为 `(maker, app, strategyHash, token)` 写入 virtual balance；真实转账只在 swap 的 `pull/push` 中发生。不同 strategyHash 可同时引用同一钱包余额，因此三个 strategy 的 multicall 应以完整 calldata 的原子模拟和逐策略 virtual balance 校验为主，不能把各策略 amount 求和后与钱包余额硬比较。钱包余额和 allowance 仍应作为未来成交能力的风控监控。本次已移除该合计余额校验，方向符合协议语义。

## 6. 本次只读链上验证

使用公共 Ethereum RPC 对主网 Aqua registry `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` 执行无签名 `eth_call`：构造两个不同 `strategyHash` 的 SwapVM 集中策略，每条声明 `10^30` raw 1INCH 虚拟额度，合计 `2 × 10^30`，并编码为同一笔 `multicall([ship, ship])`。调用成功，未读取本地 `.env`、未解密私钥、未广播或改变链上状态。该结果验证主网部署不会在 `ship` 阶段按钱包真实余额合计扣除重叠 virtual allocation。
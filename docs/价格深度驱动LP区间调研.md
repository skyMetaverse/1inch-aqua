# 价格深度驱动 LP 区间调研

## 结论摘要

- 推文提出的“资金名义价值 / 价格区间宽度”可以作为 Aqua 集中流动性仓位的**方向性候选筛选指标**：在同一交易对、同一方向、相近费率且当前价格附近时，资金相同则更窄区间通常意味着更高的局部流动性密度。
- 它不能单独作为 Aqua 的建仓或重挂规则。已核验的 Aqua 官方资料没有承诺 resolver/路由会仅按该比值排序；实际可成交性还取决于具体交易量的 `quote`、价格曲线、手续费、虚拟余额、钱包真实余额和其他策略。
- 当前策略不是一个单一的“双边 0.05% 仓位”。它是两条 `1INCH/USDT` 单边 concentrated 策略，实时链上快照的实际总宽度均约为 `0.05%`；上方 1INCH 侧仅约 `5.51699 USDT`，下方 USDT 侧为 `532.603857 USDT`，方向性资金严重不对称。
- 若机械套用推文的参考密度，USDT 下侧需要窄于约 `0.022535%`（`2.2535 bp`）才会超过该参考；1INCH 上侧需要窄于约 `0.000233%`（`0.0233 bp`），不具备可操作性。前者还小于本次 Pair/EMSH 价格差 `2.5086 bp`，不能据此直接缩窄。

本文只做研究和只读查询；未修改既有代码或配置，未读取、输出或写入任何私钥、JWT、完整 RPC URL 或其他密钥材料。

## 1. 推文原文与方法

### 1.1 原文可访问性

已直接获取原推文正文：[X @yiqiangchen_ / 2088521836242031043](https://x.com/yiqiangchen_/status/2088521836242031043)。本次无需使用镜像。X 内容可能被作者编辑、删除或因登录策略而变化；以下只归纳本次获取到的文字，不把其中的收益或路由判断视为协议事实。

推文给出的例子是：

- 观察一个 `1INCH/USDC` 生效仓位；初始余额为 `25,525`，上下区间宽度为 `0.68% + 0.40% = 1.08%`。
- 定义“单位价格深度”为 `初始余额 / 区间宽度`：`25,525 / 1.08 = 23,634.259`。
- 对 `5,000` USDC，推得若总区间小于 `5,000 / 23,634.259 ≈ 0.212%`，该指标会高于参考仓位。
- 作者据此认为更高密度会带来更小滑点，且“路由算法会优先吃高密度的池子”。推文也明确提示无常损失和套利风险。

### 1.2 可复算的定义

为避免把“百分数”与小数比例混淆，本文把区间宽度记为**百分点**（percentage point）：`0.05%` 即 `0.05` 个百分点，也等于 `5 bp`。

对某一报价方向 `s`：

```text
V_s = 该方向在建仓时的名义 USD 价值
W_s = 该方向覆盖的价格宽度，单位为百分点
D_s = V_s / W_s
```

其中 `D_s` 的单位为 `USD / 百分点`。在引用推文指标时，只有同一交易对、同一报价方向、同样的宽度口径才可比较。若目标密度为 `D_ref`，资金为 `V_s`，则满足该指标的最大宽度为：

```text
W_s,max = V_s / D_ref
```

这是**局部筛选代理指标**，不是 Aqua 或任何路由器公开承诺的价格深度公式。集中流动性曲线不是严格线性的；更可靠的“深度”定义应是指定交易方向、指定输入金额、指定费率下的实际 `quote` 输出和滑点。

## 2. 为什么可部分应用到 Aqua

### 已确认的适用前提

1. Aqua 的 concentrated（项目中称 `concentrated`，官方教程中称 Straight）仓位允许设置价格上下界；官方说明指出，区间越窄，越多流动性在当前价格附近活跃，但越容易因价格离开区间而停止报价。来源：[1inch Concentrated (Straight)](https://1inch.com/aqua/learn/strategy-types/concentrated)、[Set a concentrated range](https://1inch.com/aqua/learn/tutorials/concentrated-range)。
2. Aqua 的策略（dApp 中的 position）在 `ship()` 后不可原地修改；变更区间或费率必须 `dock()` 旧策略再 `ship()` 新策略。来源：[官方 LP and Taker Guide](https://business.1inch.com/portal/documentation/aqua/getting-started/liquidity-provider-and-taker-guide)、[Strategy lifecycle](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/strategy-lifecycle)。项目的 `src/app/rebalance-bot.ts` 也按此流程重挂。
3. Aqua 记录的是按策略分配的虚拟余额，代币仍留在 maker 钱包；成交时才原子 `pull/push`。因此比较资金时应优先使用策略 `initialBalance/currentBalance`，并同时核实钱包真实余额是否覆盖虚拟承诺。来源：[Core Concepts](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/core-concepts)。
4. 本项目构建的正是两 token `AquaXYCAmmStrategy.newConcentrate(...)` 策略，使用 decimals-aware `sqrtPriceMin/Max` 编码区间，见 `src/aqua/strategy.ts` 和 `src/domain/fixed.ts`。这与“以价格区间集中资金”的结构相符。

### 不能从推文推出的结论

1. **路由优先级未被验证。** 推文称路由会优先选择“高密度池”。官方一手资料描述的是 taker 对具体策略执行 `quote()/swap()`，没有给出“以 `初始余额/区间宽度` 全局排序”的路由规则。因此不能将该说法实现为确定性假设。
2. **不同报价方向不能合并。** 当前上、下侧是两条单边策略，分别服务相反方向。把两侧名义价值相加后再除以某个总宽度，会掩盖一侧几乎没有竞争力的事实。
3. **初始余额不是实时可成交深度。** 成交后，`currentBalance`、价格位置和钱包覆盖都会变化；同一钱包还可将同一资产虚拟分配给多条策略。必须以每次决策时的策略余额、钱包余额与实际报价核验为准。
4. **费率和交易量不可省略。** 相同区间的 `0.001%` 与其他费率策略不是同一报价；小额交易更可能受费率、舍入和固定 gas 影响。窄区间也会提高越界、`dock -> ship` 和无常损失暴露的频率。

## 3. 本项目当前配置与资金规模

### 3.1 静态配置事实

读取 `config/lp.add.jsonc` 与 `config/rebalance.jsonc` 得到：

| 来源 | 方向与投入 | 宽度 | 费率 |
| --- | --- | ---: | ---: |
| `lp.add.jsonc` | `upper`：`1INCH 100%`，`USDT 0%` | `0.05%` | `0.001%` |
| `lp.add.jsonc` | `lower`：`1INCH 0%`，`USDT 100%` | `0.06%` | `0.001%` |
| `rebalance.jsonc` | 单边重挂 | `singleSidedWidth = 0.05%` | `0.001%` |
| `rebalance.jsonc` | 双边重挂 | 上下各 `0.05%`，总 `0.10%` | `0.001%` |

`lp.add.jsonc` 的 `100%` 是“使用该 token 当时钱包余额的 100%”，不是固定 USD 金额。它不应与已上链仓位余额混为一谈。

配置还显示：轮询间隔 `30 s`、连续越界 `3` 次、越界额外阈值 `0.03%`、冷却 `100 s`。如果继续缩窄区间，这套短冷却和低额外阈值会显著增加重挂频率和 gas/执行风险，需与目标宽度一起评估。

### 3.2 实时只读快照

**取样时间：`2026-08-15T12:29:12.723Z`。** 查询方式为项目现有 API 适配器和 RPC 的只读 `eth_call`；未解密私钥、未模拟交易、未发送交易。策略可能被运行中的外部流程快速重挂，以下是时间点快照，不代表长期状态。

| 项目 | 快照值 |
| --- | ---: |
| EMSH current（`1 1INCH = N USDT`） | `0.08293846768824059` |
| Pair `lastPrice` | `0.08295927397627635` |
| Pair/EMSH 偏离 | `0.0250864%`，即 `2.5086 bp` |
| Pair `volumeUsd` | `2.3447633241228782` |
| Pair `swaps` | `3` |
| 活跃 `1INCH/USDT` concentrated 策略数 | `2` |

`volumeUsd` 和 `swaps` 来自官方 Pair API，但响应未提供统计窗口；本研究不将其解释为日、小时或任意固定周期的成交量。

链上/官方策略 API 返回的两条活跃策略如下：

| 虚拟资金方向 | 初始/当前余额 | API USD 价值 | 实际上链显示区间（USDT/1INCH） | 实际宽度 |
| --- | ---: | ---: | ---: | ---: |
| 1INCH 单边 | `66.521223882487937583 1INCH` | `5.51699 USDT` | `0.082777497853241605` 至 `0.08281888660249938` | 约 `0.05%` |
| USDT 单边 | `532.603857 USDT` | `532.603857 USDT` | `0.082896998454287872` 至 `0.082938467687709508` | 约 `0.05%` |

名义合计约为 `538.120847 USDT`，但不应用作单边深度计算的分子。两条策略的 API `performance.volumeUsd` 与 `feesUsd` 在该快照均为 `0`。

值得注意的是：`lp.add.jsonc` 为新建的 USDT 下单边写的是 `0.06%`，而此快照已上链的 USDT 策略实际宽度约 `0.05%`，与 `rebalance.jsonc` 一致。仅凭只读快照无法确认差异是由自动重挂、人工建仓还是配置版本变更造成；任何后续优化前都应先统一“首次建仓宽度”和“重挂宽度”的意图。

### 3.3 映射推文的单位价格深度

推文参考密度为：

```text
D_ref = 25,525 / 1.08 = 23,634.2593 USD / 百分点
```

以实际 `0.05%` 单边宽度和本次 API USD 估值计算：

| 报价方向 | `V_s` | `W_s` | 当前 `D_s = V_s/W_s` | 相对 `D_ref` |
| --- | ---: | ---: | ---: | ---: |
| 1INCH 侧 | `5.51699` USDT | `0.05` | `110.3398` USDT/百分点 | `0.4669%` |
| USDT 侧 | `532.603857` USDT | `0.05` | `10,652.0771` USDT/百分点 | `45.0705%` |

若直接用 `lp.add.jsonc` 的 `0.06%` 创建 USDT 下单边，其代理密度会是 `8,876.7310 USDT/百分点`，即参考密度的 `37.5587%`。

为达到推文参考密度，资金不变时的理论最大宽度为：

| 报价方向 | 理论最大宽度 | 换算 bp | 解释 |
| --- | ---: | ---: | --- |
| 1INCH 侧 | `< 0.00023343%` | `< 0.02334 bp` | 远低于可合理维护的范围，不建议仅为追指标缩窄到此值。 |
| USDT 侧 | `< 0.02253525%` | `< 2.25352 bp` | 仅是达到代理指标的数学边界，不是可直接部署的建议。 |

USDT 侧的理论 `2.25352 bp` 已小于本次 `Pair lastPrice` 与 EMSH current 的 `2.5086 bp` 差异。项目目前只把两源偏离超过 `1%` 视为熔断，故该条件不能证明 2.25 bp 窄区间安全；相反，它说明必须先建立更严格的价格一致性和实际报价验证，不能机械照搬推文阈值。

## 4. 对当前 0.05% 的优化思路

以下是优先级顺序，不是本次执行的配置变更建议。

### 4.1 用“方向性实际报价”替代单一密度比

对每个方向分别选取固定的候选交易额（例如与目标 taker 单笔规模相符的多个 USD 档位），在相同时间点采集：

```text
输入金额 -> SwapVM quote 输出 -> 有效成交价/滑点 -> 可用 virtual balance -> 钱包真实余额覆盖
```

将本策略与同交易对、同方向、相近费率的候选策略比较。只有在这些金额档位的有效报价更优或可接受时，`D_s` 才有运营价值。`初始余额/区间宽度` 可作为快速筛选或排序特征，不应直接成为自动重挂的唯一参数。

### 4.2 按方向管理资金与宽度

- USDT 侧约占本次名义资金的 `99%`，在 `0.05%` 下也只有推文参考代理密度的约 `45%`；若要提高该侧竞争力，优先评估增加该方向资金、选择可承受的更窄区间，或接受其不以该参考密度竞争。
- 1INCH 侧只有约 `5.52 USDT`。在不增加 1INCH 资金的前提下，任何正常 bp 级范围都不可能达到该参考密度。应避免以极端窄的子 bp 区间追逐该比值；更合理的选择是增加方向性资金、保留较宽风险区间，或暂不提供该方向。
- 两侧不能以 `538.12 / 0.10%` 之类的合并数字替代上述判断，因为 taker 在每个方向只能使用对应单边策略的余额。

### 4.3 为宽度设置可验证的下限和上限

可把每个方向的候选宽度表示为：

```text
W_candidate = V_s / D_target
W_final = clamp(W_candidate, W_floor, W_ceiling)
```

但只有 `W_candidate >= W_floor` 时才有可能既满足目标密度又满足风险下限；否则应增加资金、降低目标密度或放弃该方向，而不是无条件缩窄。

`W_floor` 至少应由以下实测量的较大者决定：

- 同时刻 EMSH 与独立价格/Pair 价格的正常偏离分布，而非只看一次快照；
- 指定交易额的实际 quote 舍入与滑点；
- 价格波动在轮询间隔、三次确认和 `100 s` 冷却内的分位数；
- `dock -> ship` 的 gas、失败恢复和停报时间所能承受的成本；
- 价格区间编码量化误差（项目已有 sqrt 回读校验）。

`W_ceiling` 则应由希望覆盖的波动、库存风险和允许的再平衡频率决定。Aqua 官方教程同样明确了“窄区间提升当前活跃度但更需维护”的取舍，而非单向鼓励缩窄。

### 4.4 统一首次建仓与重挂策略

当前 `lp.add.jsonc` 的下单边为 `0.06%`，而 Bot 的所有单边重挂为 `0.05%`。在引入深度驱动参数前，应先明确以下一项：

- 首次建仓和重挂应使用相同的每方向宽度；或
- `0.06% -> 0.05%` 是有意的过渡策略，并应记录触发原因、预期密度和风险差异。

否则任何一次正常重挂都会改变初始部署时的竞争性和库存暴露，回测与实时结果不可直接比较。

### 4.5 采用小额、可回滚的实证流程

1. 在只读模式先记录多时段的 EMSH、Pair、策略余额、钱包覆盖、策略 `volumeUsd/feesUsd` 与实际区间。
2. 对每一方向用统一交易额调用实际 quote，建立“宽度、方向资金、费率、滑点、成交量”的样本，而非只观察排行榜。
3. 仅用小额策略比较 `0.05%`、一个不低于验证后 `W_floor` 的窄档、一个较宽档；记录 fill、手续费、库存变化、重挂次数和 gas。
4. 只有在样本显示净收益和成交改善覆盖重挂成本、库存风险及价格源误差后，再把规则参数化到 Bot。

## 5. 当前数据缺口与边界

下列信息尚未获得，不能臆造：

1. 1inch resolver/Pathfinder 对多个 Aqua concentrated 策略的真实选择、拆单和排序算法；尤其是是否、何时使用推文中的密度比。
2. 与推文参考仓位同一时点的完整策略字节、当前余额、费率、实际成交记录和真实钱包覆盖。推文示例是 `1INCH/USDC`，当前项目是 `1INCH/USDT`，不可当作同一市场的可直接基准。
3. 官方 Pair `volumeUsd`、`swaps` 的统计时间窗和样本交易额分布。
4. 全市场同方向的 active 策略、各策略费率与对统一交易额的实际 quote；本次只查询了当前 maker 的策略，不能据此得到市场总深度。
5. 足够长时间的价格源偏差、波动率、实际 fill、手续费、无常损失和 `dock -> ship` gas 成本样本。
6. `lp.add.jsonc` 的 `0.06%` 与已上链/重挂 `0.05%` 的实际变更来源；本次严格只读，未追溯运行日志或修改状态文件。

## 6. 来源与复核路径

### 一手外部来源

- [推文原文：@yiqiangchen_ / 2088521836242031043](https://x.com/yiqiangchen_/status/2088521836242031043)
- [1inch Aqua: Concentrated (Straight)](https://1inch.com/aqua/learn/strategy-types/concentrated)
- [1inch Aqua: Set a concentrated range](https://1inch.com/aqua/learn/tutorials/concentrated-range)
- [1inch 官方：Liquidity Provider and Taker Guide](https://business.1inch.com/portal/documentation/aqua/getting-started/liquidity-provider-and-taker-guide)
- [1inch 官方：Core Concepts](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/core-concepts)
- [1inch 官方：Strategy lifecycle](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/strategy-lifecycle)
- [1inch/aqua 协议源码](https://github.com/1inch/aqua)

### 本地只读复核依据

- `config/lp.add.jsonc`：当前待新增的双单边资金比例、费率、区间。
- `config/rebalance.jsonc`：当前轮询、重挂阈值、单边/双边宽度和冷却时间。
- `src/aqua/strategy.ts`：集中策略由 `AquaXYCAmmStrategy.newConcentrate` 构建。
- `src/app/rebalance-bot.ts`、`src/domain/rebalance.ts`：单边/双边重挂、价格交叉校验、冷却与余额模式逻辑。
- `src/infra/aqua-api.ts`、`src/infra/emsh.ts`：本次使用的官方策略、Pair 和 EMSH current API 适配器。
- `scripts/check-lp-prices.ts`：项目已有只读检查脚本。该脚本要求 WBTC、cbBTC、USDT 三组目标齐全，而当前配置只有两条 USDT 仓位，因此真实执行后在查询资产前以配置前置条件退出；未绕过或修改该安全限制。

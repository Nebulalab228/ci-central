# ci-central

集中化的可复用 CI workflow。目前提供 **AI PR Review**(多模型并行审查 PR,中文输出,支持 thinking)。

各业务仓库不再各自维护审查逻辑,只放一个十几行的"瘦身调用",指向这里的 `.github/workflows/pr-review.yml`。**换供应商 / 换模型 / 改 prompt 时,绝大多数情况只改这一个仓库。**

---

## 架构

```
业务仓库 (.github/workflows/ai-pr-review.yml)   ← 瘦身 caller,~10 行
        │  uses: TshyGO/ci-central/.github/workflows/pr-review.yml@main
        │  secrets: 显式映射两个 PR Agent 仓库级 secret
        ▼
ci-central/.github/workflows/pr-review.yml     ← 真正的审查逻辑(本仓库)
        │  调 OpenAI 兼容端点 /chat/completions
        ▼
供应商:OpenCode Go (https://opencode.ai/zen/go/v1)
        模型:glm-5.2 + kimi-k3 + grok-4.5,各自带一个跨上游的 fallback
```

每个模型出一条独立评论(评论头 `<!-- ai-pr-review-bot:<model> -->`),三条并行发。

### ⚠️ 选模型看的是「上游」,不是模型本身

OpenCode Go 只是个网关,背后转发给若干第三方上游。**一个上游挂了,它下面挂的所有模型会同时返回 503 `failover_exhausted`。**
2026-07 出现过两次多小时宕机(07-02、07-06→07-07),原因就是当时的第二个模型 `qwen3.7-max` 唯一的上游 `Console Go` 躺了。

已实测的归属(2026-07-23 重测):

| 上游 | 模型 |
|---|---|
| **`Console Go`**(不稳定) | `glm-5.2`、`kimi-k3`、`grok-4.5`、`kimi-k2.7-code`、`kimi-k2.6`、`kimi-k2.5`、`deepseek-v4-pro`、`deepseek-v4-flash`、`qwen3.7-max`、`minimax-m2.7`、`minimax-m2.5`、`hy3` |
| `Alibaba` | `qwen3.7-plus`、`qwen3.6-plus`、`qwen3.5-plus` |
| `MiniMax` | `minimax-m3`(会把 `<think>` 写进 `content`,workflow 里已剥离) |

**归属会被网关悄悄改掉**:2026-07-08 时 `glm-5.2` 在 `fireworks`/`frank`、`kimi-k2.6` 在 `moonshotai`,现在两个都被挪到了 `Console Go`。上面这张表只是快照,改模型前重测一遍。

**`models` 里的模型和它的 `fallbacks` 必须落在不同上游**,否则 fallback 形同虚设。

> ⚠️ 现在三个主模型 `glm-5.2` / `kimi-k3` / `grok-4.5` **全在 `Console Go`** —— 网关上只有它供这三个 id,没得选。
>
> **只有 `glm-5.2` 的 fallback(`minimax-m3`)跨出了 Console Go**;`kimi-k3` 和 `grok-4.5` 是**指定**回落到 `qwen3.7-max` 的,而它也在 Console Go。所以这两条链只挡得住"单个模型自己抽风"(比如 kimi-k3 的配额),**挡不住 Console Go 整体宕机**——那种时候只有 GLM 那条评论还在。这是明知代价的选择:`qwen3.7-max` 唯一上游就是 Console Go,2026-07-02 和 07-06 两次多小时静默正是它造成的。想要三条都保命,把这两个 fallback 换回 `qwen3.7-plus` / `qwen3.6-plus`(Alibaba)即可。
>
> `kimi-k3` 单独有个坑:2026-07-23 实测大约 8 次里只成 1 次(429 `Provider rate limit exceeded`,或 400 `Upstream request failed`),而同在 Console Go 的 `glm-5.2`、`grok-4.5` 一次就过。所以它这条 review 大概率由 fallback `qwen3.7-max` 顶上,评论里会显示"由备用模型生成"的横幅。等上游放开配额后可复测。
>
> `qwen3.8-max` 还用不了:Qwen 3.8 Max 2026-07-19 才放出 preview(只在阿里自家 Token Plan / Qoder 上),OpenCode Zen 两个端点的 `/models` 都还没有 qwen3.8 开头的 id。上了之后可以考虑顶替 `qwen3.7-max`。

重新测归属的办法——故意发一个非法参数,读错误里的 provider 名:

```bash
curl -sS "$BASE/chat/completions" -H "authorization: Bearer $KEY" \
  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"temperature":99}'
# → {"error":{"message":"Error from provider (Console Go): ..."}}
```

平时也不用猜:每次 review 的 job 日志里都有 `[<model>] upstream=<实际上游>`。

**密钥/地址(secret)来源:**

| 仓库 | secret 来源 |
|---|---|
| NebulaLab | 仓库级 `PR_AGENT_OPENAI_API_BASE` / `PR_AGENT_OPENAI_KEY` |
| NebulaLab-Docs | 仓库级同名 secret |
| NebulaLab-Plugins | 仓库级同名 secret |

> 所有仓库均位于 `TshyGO` 个人账号下。调用方必须显式映射两个 secret，避免依赖组织级 secret 或跨仓继承行为。

---

## 常见操作

### 1. 换模型 / 改默认模型(改 1 处)

编辑本仓库 `.github/workflows/pr-review.yml` 顶部的 input 默认值:

```yaml
on:
  workflow_call:
    inputs:
      models:
        default: "glm-5.2,kimi-k3,grok-4.5"      # ← 改这里(逗号分隔,多个并行)
      model_labels:
        default: '{"glm-5.2":"GLM-5.2","kimi-k3":"Kimi-K3","grok-4.5":"Grok-4.5", ...}'   # ← 顺手改显示名
      fallbacks:
        # ↓ 原则上必须换上游!当前 kimi-k3/grok-4.5 两条是知情破例(见上方 ⚠️)
        default: '{"glm-5.2":["minimax-m3"],"kimi-k3":["qwen3.7-max"],"grok-4.5":["qwen3.7-max"]}'
```

改之前**先查上游归属**(见上文表格),别把主模型和它的 fallback 放在同一个上游。合并到 `main` 后,所有业务仓库下次审查自动用新模型。可用模型列表:

```bash
curl -s https://opencode.ai/zen/go/v1/models -H "Authorization: Bearer <KEY>" | jq '.data[].id'
```

> 个别仓库想用不同模型,可在它的瘦身 caller 里 `with: { models: "..." }` 覆盖,不影响其它仓库。

### 1b. diff 预算

`diff_char_budget`(默认 100000)是发给模型的 **patch 正文**字符上限。按文件整块打包,**不会把某个 patch 从中间切断**;测试文件排在最后,不够时先丢测试。放不下的文件会在 prompt 末尾列出来。

> 历史坑:旧版硬编码 24000 且从中间一刀切,PR #374 的 18 个文件里有 10 个(**全部前端组件**)根本没进 prompt,模型只能反复说"前端组件无法审阅"。

### 2. 换供应商 / 换 key(改 2 处)

新供应商需是 **OpenAI 兼容**(`/chat/completions`,返回 `choices[].message.content`;思考链放 `reasoning_content`)。

```bash
# 隐藏输入一次，再通过 stdin 写入三个调用仓库
read -rsp "PR Agent API base: " NEW_BASE && printf '\n'
read -rsp "PR Agent API key: " NEW_KEY && printf '\n'
for repo in TshyGO/NebulaLab TshyGO/NebulaLab-Docs TshyGO/NebulaLab-Plugins; do
  printf '%s' "$NEW_BASE" | gh secret set PR_AGENT_OPENAI_API_BASE -R "$repo"
  printf '%s' "$NEW_KEY" | gh secret set PR_AGENT_OPENAI_KEY -R "$repo"
done
unset NEW_BASE NEW_KEY
```

> GitHub 不允许读取已有 secret 的明文。轮换密钥时应从同一可信来源向三个调用仓库重新写入。

### 3. 改 prompt / 审查重点(改 1 处)

编辑本仓库 `pr-review.yml` 里 `script:` 内的 `system` / `user` 文案。

### 4. 接入一个新仓库

1. 在 `TshyGO` 账号下创建或转入仓库。
2. 加文件 `.github/workflows/ai-pr-review.yml`,内容见下方"瘦身 caller 模板"。
3. 在调用仓库设置 `PR_AGENT_OPENAI_API_BASE` 和 `PR_AGENT_OPENAI_KEY` 两个仓库级 secret。

<details><summary>瘦身 caller 模板</summary>

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
  issue_comment:
    types: [created]
concurrency:
  group: ai-pr-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false
jobs:
  ai-pr-review:
    if: |
      github.event.sender.type != 'Bot' &&
      (
        github.event_name == 'pull_request' ||
        (
          github.event_name == 'issue_comment' &&
          github.event.issue.pull_request != null &&
          contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
          startsWith(github.event.comment.body, '/review')
        )
      )
    uses: TshyGO/ci-central/.github/workflows/pr-review.yml@main
    permissions:
      contents: read
      issues: write
      pull-requests: write
    secrets:
      PR_AGENT_OPENAI_KEY: ${{ secrets.PR_AGENT_OPENAI_KEY }}
      PR_AGENT_OPENAI_API_BASE: ${{ secrets.PR_AGENT_OPENAI_API_BASE }}
```
</details>

### 触发方式

- 开 / reopen / ready-for-review / push 到 PR → 自动审查。
- 在 PR 里评论 `/review`(限 OWNER/MEMBER/COLLABORATOR)→ 手动重审。

---

## 维护者备忘(踩过的坑)

- **本仓库必须保持公开**:GitHub 不允许"公开仓调用私有仓的可复用 workflow";本仓库公开后,公开+私有业务仓都能调。本仓库内**无任何密钥**(secret 运行时注入),公开安全。
- **个人账号下的调用仓库**:每个仓库各自保存 repo secret，并在 caller 中显式映射。
- **业务仓的 main 有 ruleset 拦直推时**:临时给 ruleset 加 `RepositoryRole admin / always` bypass → `gh pr merge <n> --admin --squash` → 把 `bypass_actors` 还原。
- **测 `/review` 别用 Git Bash**:它会把 `/review` 当路径转换成 `D:/Git/review` 导致 `if` 不匹配。用 PowerShell 发评论,或设 `MSYS_NO_PATHCONV=1`。
- 模型响应:最终结论读 `message.content`,思考链读 `message.reasoning_content`。
- **别加 `enable_thinking: true`**。它曾经能用(当时 `glm-5.2` 走 `frank` 上游),网关把 `glm-5.2` 换到 Fireworks 之后直接 400:`Extra inputs are not permitted, field: 'enable_thinking'`。而且**根本不需要**——会思考的模型不带这个字段照样返回 `reasoning_content`(实测 glm-5.2 28266 字、qwen3.7-plus 24417 字)。同理,任何"可选参数"都可能被下一个上游拒绝,`callModel()` 会按名字摘掉被拒字段重试一次。
- **上游会在你不知情时被换掉**。同一个模型 id,今天是 `frank/GLM-5.2`,明天是 `accounts/fireworks/models/glm-5p2`,请求契约跟着变。所以请求体只带各家都认的字段,并且靠 job 日志里的 `upstream=` 追踪实际由谁服务。
- **上游会「假死」**(TCP 连上但一直不回包),不只是报 5xx。所以每个模型有一个 `MODEL_BUDGET_MS`(~6 分钟)的**总时长上限**:单次尝试封顶 `requestTimeoutMs`(5 分钟,够最重的思考响应 ~270s),预算耗尽就放弃该模型转 fallback,重试的退避永不睡过预算线。job 上还有 `timeout-minutes: 20` 兜底。**别再把这些值往大调**——曾经把单次超时抬到 480s×4 次,撞上上游假死时一个 job 空转了 26 分钟。想验证:测试里 `clockPerFetch` 用假时钟把预算路径跑通,不需要真等。
- **改完先跑测试**:`node test/pr-review.test.mjs`。它把 `pr-review.yml` 里那段内联 `script:` 原样抠出来,配 mock 的 GitHub API 和 stub 的 `fetch` 执行,覆盖降级链、剥 `<think>`、字段自愈、diff 打包/截断、发评论失败等路径。不需要任何密钥,PR 上自动跑(见 `.github/workflows/test.yml`)。

# ragbox 中文文档

`ragbox` 是一个面向 Markdown/MDX 文档目录的结构化 RAG 工具。它把文档目录索引成本地 PageIndex JSON，然后用 OpenAI-compatible 模型基于索引回答问题。

## 安装

```bash
npm install -g @bndynet/ragbox
```

## 前置条件

你需要准备：

- Node.js 18 或更新版本
- 本地 PageIndex Python 脚本，通常是 `run_pageindex.py`
- 一个兼容 OpenAI `/chat/completions` 的模型服务
- 模型服务 API key
- 一个包含 `.md` 或 `.mdx` 的文档目录

`ragbox` 不会自动安装 PageIndex，需要你通过 `PAGEINDEX_CLI` 指定本地脚本路径。

## 快速开始

```bash
export PAGEINDEX_CLI=/path/to/PageIndex/run_pageindex.py
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1

ragbox index ./docs --output-dir ./.ragbox-index
ragbox query ./.ragbox-index "怎么配置认证？"
ragbox watch ./docs --output-dir ./.ragbox-index
```

同一套模型服务参数也可以直接通过命令传给 `index`、`watch` 或 `query`：

```bash
ragbox index ./docs \
  --output-dir ./.ragbox-index \
  --api-key sk-... \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini

ragbox query ./.ragbox-index "怎么配置认证？" \
  --api-key sk-... \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini
```

## 项目配置

创建项目配置：

```bash
ragbox init
```

它会写入 `ragbox.config.json`：

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "/path/to/PageIndex/run_pageindex.py"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "docs": {
    "rootDir": "./docs",
    "outputDir": "./.ragbox-index"
  }
}
```

配置文件中的相对路径会按配置文件所在目录解析。命令行参数会覆盖配置文件值。API key 通常建议继续放在环境变量里，不要写进 `ragbox.config.json`。

只有一个文档源时，用顶层 `docs` 就够了，不需要传 `--source`。项目里确实有多个命名文档源时，再使用可选的 `sources` 映射。

使用配置里的 docs：

```bash
ragbox index
ragbox query "怎么配置认证？"
ragbox watch --jsonl
ragbox --config ./ragbox.config.json index
```

如果有多个文档目录，在 `sources` 里给每个目录起一个名字：

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "/path/to/PageIndex/run_pageindex.py"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "sources": {
    "docs": {
      "rootDir": "./docs",
      "outputDir": "./.ragbox-index/docs"
    },
    "api": {
      "rootDir": "./packages/api/docs",
      "outputDir": "./.ragbox-index/api"
    },
    "web": {
      "rootDir": "./apps/web/content",
      "outputDir": "./.ragbox-index/web",
      "include": ["**/*.md", "**/*.mdx"],
      "exclude": ["**/draft/**"]
    }
  }
}
```

命名 source 分别索引，query 时可以全局查，也可以限定 source：

```bash
ragbox index --source docs
ragbox index --source api
ragbox index --source web

ragbox query "部署步骤是什么？"
ragbox query --source api "怎么配置认证？"
ragbox query --source docs,api "认证链路整体是怎样的？"
ragbox query --all-sources "部署步骤是什么？"
```

配置了多个 source 时，`ragbox query "..."` 默认查询全部 source。`--all-sources` 是同样行为的显式写法；要缩小范围时再用 `--source`。

也可以按环境拆配置文件：

```bash
ragbox --config prod index
ragbox --config ./ragbox.config.prod.json query "怎么部署？"
```

## 配置

配置解析优先级为：命令行参数、`ragbox.config.json`、环境变量、默认值。

| 配置 | 环境变量 | 命令参数 | 用于 | 默认值 |
| --- | --- | --- | --- | --- |
| PageIndex 脚本 | `PAGEINDEX_CLI` | 无 | `index`, `watch` | 索引时必填 |
| Python 可执行文件 | `PAGEINDEX_PYTHON` | `--pageindex-python` | `index`, `watch` | `python3` |
| 输出目录 | `RAGBOX_OUTPUT_DIR` | `--output-dir` | `index`, `watch` | `<folder>/.pageindex` |
| 并发数 | `PAGEINDEX_CONCURRENCY` | `--concurrency` | `index`, `watch` | `1` |
| API Base URL | `OPENAI_BASE_URL` | `--base-url` | `index`, `watch`, `query` | `https://api.openai.com/v1` |
| API Key | `OPENAI_API_KEY` | `--api-key` | `index`, `watch`, `query` | query 必填，PageIndex 通常也需要 |
| 模型 | `PAGEINDEX_MODEL`, `LLM_MODEL` | `--model` | `index`, `watch`, `query` | `gpt-4o-mini` |

生产环境建议用环境变量或 secret manager 管理 API key。`--api-key` 适合本地测试，但可能出现在 shell history 或进程列表里。

## 命令说明

### `ragbox init`

创建 `ragbox.config.json` 文件。

```bash
ragbox init
ragbox init --docs-dir ./content --output-dir ./.idx
ragbox init --output ./configs/ragbox.config.json --force
```

### `ragbox index <folder>`

索引 Markdown/MDX 文档目录。

```bash
ragbox index ./docs
ragbox index ./docs --output-dir ./.ragbox-index
ragbox index ./docs --output-dir ./.ragbox-index --json
ragbox index ./docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox index ./docs --pageindex-python /opt/venvs/pageindex/bin/python
ragbox index ./docs --base-url https://api.openai.com/v1 --model gpt-4o-mini
```

它会扫描 `**/*.md` 和 `**/*.mdx`，计算文件 hash，只重新索引新增、修改、之前失败的文件，并跳过未变化的 ready 文件。

使用 `--json` 可以输出带版本号的机器可读结果，包含输出路径和统计信息：

```json
{
  "version": 1,
  "command": "index",
  "rootDir": "/repo/docs",
  "outputDir": "/repo/.ragbox-index",
  "manifestPath": "/repo/.ragbox-index/manifest.json",
  "rootTreePath": "/repo/.ragbox-index/root-tree.json",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "counts": {
    "total": 12,
    "ready": 12,
    "failed": 0,
    "added": 12,
    "modified": 0,
    "retryFailed": 0,
    "unchanged": 0,
    "deleted": 0
  }
}
```

### `ragbox query [target] <question>`

基于 docs 目录或已有索引目录回答问题。如果传 docs 目录，目录下需要有默认的 `.pageindex` 索引。

```bash
ragbox query ./docs "怎么配置认证？"
ragbox query ./.ragbox-index "部署步骤是什么？"
ragbox query ./docs/.pageindex "怎么配置认证？"
ragbox query ./.ragbox-index "怎么配置认证？" --model gpt-4o-mini --api-key sk-...
ragbox query ./.ragbox-index "怎么配置认证？" --json
ragbox query "部署步骤是什么？"
ragbox query --source docs,api "认证链路整体是怎样的？"
ragbox query --all-sources "部署步骤是什么？"
```

这里建议使用和索引时相同的 `--base-url`，通常是 OpenAI-compatible 根地址，例如 `https://api.openai.com/v1`。如果某些代理只能提供完整接口地址，`query` 也兼容完整的 `/chat/completions` URL。

显式传 target 时，第一个参数可以是：

- docs 目录，里面有 `.pageindex/manifest.json` 和 `.pageindex/root-tree.json`
- 索引输出目录，里面有：

```text
manifest.json
root-tree.json
indexes/
```

查询流程：

1. 读取 `manifest.json` 和 `root-tree.json`
2. 让 LLM 从文档树中选择相关文档
3. 读取相关文档的 PageIndex JSON
4. 去掉节点里的 `text` 字段，只让 LLM 基于结构选择相关节点
5. 回到完整 JSON 中取出选中节点的 `text`
6. 把这些文本拼成上下文，让 LLM 生成最终答案

对多个配置 source，`ragbox query "..."` 默认查询全部 source。可以用 `--source` 传逗号分隔的名字来缩小范围，也可以用 `--all-sources` 显式表达全局查询。多源 query 会对每个 source 执行正常的结构化查询流程，然后让 LLM 基于各 source 选出的片段融合成一个最终回答。来源引用会加上 source 前缀，例如 `api:auth.md#n1`。

使用 `--json` 可以输出带版本号的结果契约。单 source query 返回 `QueryResult`；多 source query 返回融合后的 `answer`、每个 source 的 `results`、带 source 前缀的 `sources`、`warnings` 和 `timingsMs`。

单 source `QueryResult` 字段：

- `answer`：最终回答文本
- `selectedDocuments`：从 `root-tree.json` 中选中的文档
- `selectedNodes`：每篇文档中选中的 PageIndex 节点
- `sources`：最终回答使用的来源引用和节点文本
- `warnings`：不可用文档、缺失节点或空上下文等提醒
- `timingsMs`：解析、选择和生成回答的耗时

### `ragbox watch <folder>`

先执行一次索引，然后监听文档变化并增量更新。

```bash
ragbox watch ./docs
ragbox watch ./docs --output-dir ./.ragbox-index
ragbox watch ./docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox watch ./docs --base-url https://api.openai.com/v1 --model gpt-4o-mini
ragbox watch ./docs --output-dir ./.ragbox-index --jsonl
```

`watch` 监听 `.md` 和 `.mdx` 文件的新增、修改、删除。它会忽略 `node_modules`、`.git`、`.pageindex`、`dist`、`build`，以及位于文档目录内的自定义输出目录。

使用 `--jsonl` 可以为集成场景输出带版本号的 JSON Lines 事件流。事件包括 `watch-start`、`watch-file-event`、`watch-index-start`、`watch-index-done`、`watch-index-failed`、`watch-stop` 和 `index-progress`。

## 输出目录

默认输出：

```text
docs/.pageindex/
  manifest.json
  root-tree.json
  indexes/
    <stable-doc-id>.pageindex.json
  state/
    file-state.json
```

自定义输出：

```bash
ragbox index ./docs --output-dir ./.ragbox-index
ragbox query ./.ragbox-index "..."
```

输出目录可能包含源文档正文和元数据。如果文档是私有的，不要把输出目录公开暴露。

## 生产使用建议

常见方式有两种：

- 部署时执行 `ragbox index`，应用只读取完成后的索引目录
- 文档会独立变化时，把 `ragbox watch` 作为后台服务运行

建议：

- 把输出目录放在源码目录外，例如 `/var/lib/ragbox/docs-index`
- 多副本应用需要读取同一份完整索引，可以挂载只读卷或随部署产物分发
- API key 放环境变量或 secret manager
- 先用 `--concurrency 1`，确认 PageIndex 和模型服务限流后再提高
- 如果要求零停机更新，可以先索引到 staging 目录，成功后再切换读目录

部署时索引示例：

```bash
export PAGEINDEX_CLI=/opt/PageIndex/run_pageindex.py
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1

ragbox index /srv/app/docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox query /var/lib/ragbox/docs-index "怎么配置认证？"
```

SDK 调用：

```js
const {
  createIndex,
  inspectIndex,
  queryIndex,
  validateIndex,
  watchIndex
} = require("@bndynet/ragbox");

await createIndex("/srv/app/docs", {
  configPath: "./ragbox.config.json",
  outputDir: "/var/lib/ragbox/docs-index",
  pageIndexCli: "/opt/PageIndex/run_pageindex.py"
});

const result = await queryIndex(
  "/var/lib/ragbox/docs-index",
  "怎么配置认证？"
);

console.log(result.answer);
console.log(result.sources);

const validation = await validateIndex("/var/lib/ragbox/docs-index");
console.log(validation.ok);

const inspect = await inspectIndex("/var/lib/ragbox/docs-index");
console.log(inspect.counts);

const watcher = await watchIndex("/srv/app/docs", {
  outputDir: "/var/lib/ragbox/docs-index",
  pageIndexCli: "/opt/PageIndex/run_pageindex.py",
  onEvent: (event) => console.log(event)
});
await watcher.ready;
await watcher.close();
```

包根入口只导出产品化 SDK API。底层工具仍保留在 `advanced` namespace，适合更定制的集成：

```js
const { advanced } = require("@bndynet/ragbox");

const location = await advanced.resolveQueryIndexLocation("/var/lib/ragbox/docs-index");
```

## 设计思路

核心思路：

- 一个 `.md`/`.mdx` 文件生成一棵 PageIndex 树
- 一个文档目录生成一个 `manifest.json` 和一个 `root-tree.json`
- 查询时先选相关文档，再选相关节点，最后只用选中节点的正文回答

基础流程不需要向量数据库。Markdown 索引时，ragbox 默认会让 PageIndex 生成 `node_id` 和 `text`。query 时只会在“选节点”prompt 里临时去掉 `text`，最终回答阶段仍会使用选中节点的正文。

## 与传统 Vector DB RAG 的对比

传统 Vector RAG 通常会切 chunk、做 embedding，再按向量相似度召回。`ragbox` 则优先保留源文档层级，并让 LLM 基于这棵结构树做选择。

| 维度 | Vector DB RAG | `ragbox` |
| --- | --- | --- |
| 索引单位 | 文本 chunk | Markdown/MDX 文件和 PageIndex 节点 |
| 检索信号 | 向量相似度 | LLM 基于文档树和节点树选择 |
| 存储 | 向量数据库加文档存储 | 输出目录下的本地 JSON 文件 |
| 上下文形态 | 扁平 chunk 列表 | 带文件路径和 node id 的结构化节点 |
| 优势 | 大规模模糊召回快 | 保留文档层级，引用来源更清晰 |
| 取舍 | 需要 embedding 和索引基础设施 | 依赖 PageIndex 质量和 LLM 选择效果 |

两种方式也可以组合：先用向量检索做大范围候选召回，再用 PageIndex 树做结构化过滤、上下文组织和引用生成。

## 常见问题

- `PAGEINDEX_CLI is required to run PageIndex`：设置 `PAGEINDEX_CLI=/path/to/run_pageindex.py`
- `OPENAI_API_KEY is required for query`：设置 `OPENAI_API_KEY` 或传 `--api-key`
- `Expected a docs folder... or a ragbox output directory`：`query` 的第一个参数可以传带 `.pageindex/` 的 docs 目录，也可以直接传索引输出目录
- `PageIndex completed but no generated JSON result was found`：如果你的 PageIndex CLI 不使用默认的 `--output` 参数名，把 `PAGEINDEX_OUTPUT_ARG` 设置成它支持的输出路径参数名。

## 限制

- 需要你本地已经安装并配置 PageIndex
- 查询质量依赖 PageIndex JSON 结构和所使用的 LLM
- 当前基础流程是树结构选择，不是向量检索

## 本地开发

```bash
npm install
npm run build
npm run ragbox -- --help
```

### 真实 E2E 验证

推荐用脚本运行：

```bash
cp .env.e2e.local.example .env.e2e.local
npm run test:e2e
```

`npm run test:e2e` 会运行 `./scripts/e2e.sh`，脚本会读取 `.env.e2e.local`。你也可以直接 export 变量后运行它：

```bash
export RAGBOX_E2E=1
export PAGEINDEX_CLI=/path/to/PageIndex/run_pageindex.py
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1
export PAGEINDEX_MODEL=gpt-4o-mini
export RAGBOX_E2E_QUERY_MODEL=gpt-4o-mini
export RAGBOX_E2E_DOCS_DIR=./examples
export RAGBOX_E2E_OUTPUT_DIR=./examples/.pageindex
export RAGBOX_E2E_EXPECTED_TEXT=PKCE
export RAGBOX_VERBOSE=1

# 可选
export RAGBOX_E2E_PAGEINDEX_PYTHON=/path/to/python
export RAGBOX_E2E_HEARTBEAT_MS=10000
export RAGBOX_E2E_COMMAND_TIMEOUT_MS=300000

npm run test:e2e
```

`.env.e2e.local` 已被 git ignore。只有在你明确想绕过脚本时，才使用 `npm run test:e2e:raw`。

这个测试默认使用 `./examples`，执行 `ragbox index ./examples --output-dir ./examples/.pageindex`，查询生成的 JSON 索引目录，然后再查询 docs 目录本身。运行时会打印实时阶段日志、逐文档索引进度、query 进度，以及长时间命令的心跳日志。`./examples` 现在包含 100 个 Markdown demo 文档；如果你想先快速验证 OAuth 文档，可以设置 `RAGBOX_E2E_DOCS_DIR=./examples/authentication/oauth2`。

默认 e2e 问题是一个英文模糊问题：“What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk?”。e2e 日志会分别打印从索引目录 query 和从 docs 目录 query 得到的最终答案。

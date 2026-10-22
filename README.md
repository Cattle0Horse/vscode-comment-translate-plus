# 注释翻译+

命令分类为 `Comment Translate Plus`。“翻译并替换”优先处理单一选区，否则处理光标所在注释、字符串或 Markdown/YAML 单元，支持取消、缓存和原生撤销，见[用法与边界](docs/configuration.md#翻译并替换)。

独立重实现 [vscode-comment-translate](https://github.com/intellism/vscode-comment-translate)，重点改善结构化内容的翻译对应关系和编辑器内阅读体验。

独立 `.yaml` / `.yml` 文件与 Markdown frontmatter 共用字段显示：保留冒号、缩进和程序值，只翻译字符串字段名与值。示例见 [yaml-fields.yaml](fixtures/development/yaml-fields.yaml) 和 [yaml-stream.yml](fixtures/development/yaml-stream.yml)。

已实现 Markdown/SKILL、代码注释与可选字符串翻译、对照/占位模式、独立悬停、原生 Markdown 翻译预览、多配置切换、自动范围与自定义保留词。翻译源为 OpenAI 兼容接口、Google 和 Bing；密钥位于 settings.json 的 `profiles[].apiKey`，允许为空。OpenAI 使用普通文本分隔与有限局部重试，支持完整 system/user 模板、固定变量、语言名称及条件片段。结构参考与正文相同时省略，按最终消息预算组批，缓存和在途合并按单元。长译文在原编辑器中自动折行继续暂停，支持 hover 替换及“翻译并替换”命令（优先选区，否则光标所在单元），可原生撤销；聊天、独立选区查看/复制、批量编辑、命名和导出不做。

- [本机安装与使用](docs/local-use.md)
- [官方宿主的多种用例](docs/host-cases.md)
- [目标、历史依据与后续阶段](docs/product.md)
- [需要实现的功能与当前状态](docs/features.md)
- [上游体验对照、差距与 hover 测试](docs/upstream-comparison.md)
- [配置、批次与请求限速规则](docs/configuration.md)
- [提示词模板、条件片段与语言名称](docs/prompts.md)
- [文本语种检测与跳过目标语言](docs/language-detection.md)
- [YAML 译文显示与翻译中标识](docs/translation-display.md)
- [日志级别、完整请求与翻译结果](docs/logging.md)
- [新增翻译服务的接入协议](docs/translation-providers.md)
- [Agent 开发约定](AGENTS.md)
- [扩展开发与调试流程](docs/development.md)
- [结果验证、性能测量与命令](docs/verification.md)
- [独立重实现决策](docs/adr/0001-independent-reimplementation.md)
- [功能排除决策及 hover 替换例外](docs/adr/0002-excluded-features.md)
- [长译文换行：暂无法实现及原因](docs/adr/0003-long-translation-wrapping-blocked.md)
- [目标调整：S4、S5 需要实现](docs/adr/0004-positive-scope-and-browse-controls.md)

## 本地开发

需要 Node.js 22 和 pnpm 12.14.0；官方 Web 宿主由工具下载，不依赖系统 VS Code。扩展 API 基线为 1.140。先安装锁定依赖：

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test
pnpm test:extension
pnpm test:ui
pnpm test:package
```

代码采用 2 空格缩进，使用 Oxfmt 与 Oxlint；`pnpm format` 修复格式，`pnpm check` 包含只读格式/lint 与 TypeScript 检查。原始测试语料不参与格式化。

运行 `pnpm serve:web` 使用官方 VS Code Web 宿主；需要持续构建时另开终端运行 `pnpm watch`。F5 的 **Attach VS Code Web** 配置会启动同一官方宿主并附加到专用 Chromium，不启动系统 VS Code 扩展宿主。

先按[配置示例](docs/configuration.md)填写 `commentTranslatePlus.profiles` 和 `activeProfile`，打开文件后点击右上角眼睛图标执行“切换当前文档注释浏览模式”。点击状态栏打开完整操作菜单，右键菜单也提供语言、配置、模式、取消、重试和日志入口。模式切换不占用右上角图标；所有扩展命令均无默认快捷键，可自行绑定。独立悬停默认开启，关闭注释浏览模式仍可悬停翻译；需要完全关闭时一并停用 `hover.enabled`。

对照模式通过空 CodeLens 占行、decoration 在原文下方绘制译文，不修改源文件；完整结果在原文 hover 中查看。占位模式隐藏原文，光标进入单元时恢复；可通过编辑器导航定位，或先切回对照模式。Markdown 翻译预览使用 VS Code 原生锁定侧边视图，只渲染译文并跟随源文编辑更新。注释浏览、hover、预览共享限速和有容量限制的内存缓存，开关、文档关闭和同内容跨文件不主动丢弃缓存。

YAML 译文显示/hover 显示翻译后的字段名与实际值，不显示 `|`、`>` 等序列化标记，非字符串值原样保留。翻译中在原文行末显示旋转图标，完成或取消后移除。日志默认摘要，错误指出文件位置、具体差异和未完成数；需要完整提示词与响应时打开 `commentTranslatePlus.logDetails`。

`pnpm package` 生成 `artifacts/comment-translate-plus.vsix`；`pnpm vscode:install` 仅安装已有 VSIX，`pnpm vscode:build:install` 先构建再安装。安装通过终端的 `code` 命令执行，覆盖同版本构建。`pnpm test:package` 解包正式产物并在官方 Web 宿主验证，核对实际加载 bundle 的指纹，不向系统安装扩展。首次运行会下载官方 VS Code Web 和独立 Chromium；当前宿主验证版本为 Web 1.143.0，窗口验证的构建与版本另见[验证记录](docs/verification.md)。

本地已有 `http://127.0.0.1:9999/v1/...` 服务时，运行 **`pnpm test:local`** 自动发现模型并注入服务和测试密钥；运行 **`pnpm serve:local`** 打开已配置并自动开启示例翻译的官方 Web 宿主。左侧 `examples/` 可打开 16 类样本，切换文件后手动开启翻译；[样本说明](docs/host-cases.md)。代码字符串翻译需开启 `commentTranslatePlus.browse.strings`。日常使用可[安装本地 VSIX](docs/local-use.md)。默认回归使用模拟服务，真实联调见[配置文档](docs/configuration.md#本地服务自动注入)。

`pnpm verify --results fixtures/results.reference.json` 与默认 `pnpm bench` 仍只检验原有工具。解析/组批的真实代码测量可在 `pnpm test` 后执行 `pnpm bench --target tools/parsing-bench.mjs --samples 5 --warmup 1 --output artifacts/parsing-bench.json`；它不衡量翻译服务性能，详见[验证文档](docs/verification.md)。

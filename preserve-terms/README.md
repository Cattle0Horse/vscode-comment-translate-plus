# 保留词库

从公开技术词典与名称目录收集候选词，生成 `resources/` 下的保留词文件。词表使用 JSON 数组，支持字符串字面值与显式正则对象，仅匹配完整待译单元。

## 词库

| 文件                                 | 内容                                                     | 用途                 |
| ------------------------------------ | -------------------------------------------------------- | -------------------- |
| `resources/preserve-terms.json`      | 手工补充规则与筛选后的技术名称，排除已识别的普通词歧义项 | 内置默认词库         |
| `resources/preserve-terms.full.json` | 全部候选词、手工补充规则和规范拼写，包含普通词           | 按领域选择的扩展词库 |

默认词库排除 `tools`、`make`、`less`、`string`、`Token` 等歧义项；完整词库保留这些条目。两份词库均保留显式正则规则。技术名称也可能具有普通语义，筛选不能代替针对阅读领域和目标语言的审核。

## 维护文件

- `collect.mjs`：下载上游默认分支的最新数据，提取名称、去重并生成两份词库。
- `verify.mjs`：使用产品解析器校验词库、检查包含关系，并确认离线重建结果一致。
- `additions.json`：人工维护的补充名称与正则规则；修改补充规则时编辑此文件，再重新生成。
- `manifest.json`：来源仓库、下载地址、转换结果摘要、输出路径和许可证信息。
- `licenses/`：来源的完整版权与许可声明，再分发词库时应保留。

过程产物由 Git 忽略：`snapshots/` 保存下载的原始数据，`candidates/` 保存分类候选及筛选子集，`provenance.json` 记录词条来源，`review.json` 记录歧义词与异常条目，`verification.json` 记录校验结果。

## 数据来源

| 来源                                                                                                   | 提取内容                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [CSpell](https://github.com/streetsidesoftware/cspell-dicts/tree/main/dictionaries/software-terms/src) | 计算机缩写、网络协议、软件工具、服务名称和软件概念词  |
| [Devicon](https://github.com/devicons/devicon/blob/master/devicon.json)                                | 技术名称 `name` 及别名 `altnames`                     |
| [GitHub Linguist](https://github.com/github-linguist/linguist/blob/main/lib/linguist/languages.yml)    | 编程语言名称、别名 `aliases` 和完整文件名 `filenames` |

来源信息和许可证见 `manifest.json` 与 `licenses/`。仅收集文字名称，不收集图标。

## 生成与校验

在仓库根目录安装依赖并运行：

```powershell
pnpm install --frozen-lockfile

# 下载上游最新数据并生成两份词库；需要联网
node preserve-terms/collect.mjs

# 使用本地快照重建，不联网
node preserve-terms/collect.mjs --offline

# 校验词库；需要先生成词库及快照
node preserve-terms/verify.mjs
```

脚本通过 `HEAD` 地址读取各仓库默认分支的最新内容。更新后审查两份词库的增删及歧义项。修改人工名单、排除项或 `additions.json` 后也需要重新生成，不直接编辑生成的资源文件。

生成的词库、来源清单、原始快照与许可证排除 Oxfmt 格式化；许可证通过 `.gitattributes` 保留原始字节。脚本、手工补充规则与 README 使用仓库的格式和静态检查。

## 转换边界

- CSpell 按行读取，移除注释和词条外侧空白；特殊词典语法进入检查记录，不自动解释为正则。
- Devicon 不提取 tags、图标样式 aliases 或颜色；内部名称可能是小写 slug，不能全部视作正式产品拼写。
- Linguist 不提取文件扩展名，避免把短扩展名当成独立保留词。
- 两份输出词库与人工补充文件的字符串按 `toLowerCase()` 忽略大小写去重，不生成正则；依次保留人工补充、人工名单规范名称、上游的首个拼写。匹配时忽略大小写，命中后仍保留待译原文的大小写。正则规则原样保留并遵守各自 flags。候选文件和来源快照保留原始拼写，`provenance.json` 记录规范名称及全部来源拼写；人工名单只收录来源中能找到对应名称的项。
- 软件概念词不自动进入默认词库；完整词库包含这些候选，启用后可能使本应翻译的完整单元原样保留。

脚本不会修改用户设置或调用翻译服务。例如保留 `GitHub` 不会阻止 `Use GitHub.` 整句翻译；解析校验和可复现性检查不能代替翻译质量审核。

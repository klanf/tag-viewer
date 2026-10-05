# knowledge/ —— 仓库内置「知识」目录

这个目录随**仓库分发**，内容是标签翻译这类「知识」数据（不含任何图片、
不含任何本机文件路径）。应用在数据目录下自动发现不到 `weilin_data*` 时，
会回落到这份内置库 —— 所以新装机器**零配置**就有中文标签
（解析顺序见 `electron/core/translate.js` 的 `resolveWeiLinDirs`）。

## 目录里的东西

| 内容 | 是什么 |
|---|---|
| `weilin_data(雷昂_Lion@bilibil)/` | WeiLin 标签翻译库（SQLite），约 1MB |

## 数据来源与授权（重要）

- **来源**：[WeiLin-Comfyui-Tools](https://github.com/weilin9999/WeiLin-Comfyui-Tools)
  （ComfyUI 提示词/标签插件）所使用的中文翻译库，即插件 `userdatas/` 下的
  `userdatas_zh_CN_danbooru.db` 与 `userdatas_zh_CN_tags.db` 两个文件，
  原样收录、未做任何修改。
- **署名**：目录名里的 `雷昂_Lion@bilibil` 是这份库在社区流传时携带的
  整理者署名，原样保留。
- **授权现状**：截至 2026-10-02 **未取得权利人的明确书面许可**，
  按社区分享惯例凭署名善意使用。若权利人提出要求，会立即从仓库移除；
  移除后应用自动降级为英文标签，功能不受影响（这是代码里既有的降级路径）。
- 应用**只读**这两个文件（`readOnly` 打开），不会回写。

## 想用自己的翻译？

- 数据目录下放一个 `weilin_data` 开头的文件夹（内含同名两个 .db），
  优先级**高于**这份内置库；
- 少量补译写数据目录的 `local_translations.json`（格式 `{"英文标签": "中文"}`），
  它补在 WeiLin 库没有的词条上。

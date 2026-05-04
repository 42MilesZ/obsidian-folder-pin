# Folder Pin

[English](./README_EN.md)

在 Obsidian 文件资源管理器中将文件夹钉为标签页，一键切换项目上下文，告别反复展开、折叠和滚动。

> ⚠️ 插件持续迭代中 — 提交至 Obsidian 社区插件市场前，本文档仍会补充截图与演示 GIF。

## 为什么做这个插件

同一个 vault 里管理多个大型项目时，每次切换都要展开、折叠、滚动文件树。Folder Pin 让你把文件夹钉为资源管理器标签页的根目录，每个项目拥有独立的聚焦视图，切换只需一次点击。

## 功能特性

- **文件夹钉为标签页** — 每个标签页以钉选文件夹为根，隐藏其余内容。
- **多资源管理器视图** — 通过命令面板执行 `Open another Folder Pin explorer` 可开启多个独立视图。
- **标签页独立状态** — 展开状态、滚动位置、选中文件均按标签页记忆。
- **布局切换** — 标签栏支持网格等多种布局方式。
- **字体样式控制** — 可调整顶层钉选文件夹的字重、字号和间距。
- **文件类型标记** — 在文件名旁显示小段文字标记，标识文件扩展名。
- **可选「返回上级」按钮** — 快速从钉选子目录跳回父文件夹。
- **集成默认资源管理器** — 可选将钉选行为也应用到 Obsidian 原生文件资源管理器。

## 演示

![demo](./assets/demo.gif)

## 安装

### 从社区插件市场安装（上架后可用）

1. 打开 Obsidian → **设置 → 第三方插件**。
2. 搜索 **Folder Pin**。
3. 安装并启用。

### 手动安装（审核期间的推荐方式）

1. 从 [GitHub Releases](https://github.com/42MilesZ/obsidian-folder-pin/releases) 下载最新版本的 `main.js`、`manifest.json` 和 `styles.css`。
2. 将三个文件放入 `<你的 vault>/.obsidian/plugins/folder-pin/`。
3. 重新加载 Obsidian → 在**设置 → 第三方插件**中启用 Folder Pin。

## 使用方法

1. 从侧边栏图标打开 Folder Pin 资源管理器视图，或在命令面板中执行 `Open another Folder Pin explorer`。
2. 在资源管理器中右键点击任意文件夹 → **Pin as tab**，该文件夹即变为新标签页。
3. 点击标签页切换上下文，每个标签页独立保留展开状态和滚动位置。

## 设置项

| 设置项 | 说明 |
|---|---|
| Enable default file explorer pinning | 将钉选行为同时应用到 Obsidian 原生文件资源管理器 |
| Show "Go up" button | 在每个标签页顶部显示返回父文件夹按钮 |
| Tab layout | 标签栏布局模式：`grid` 或其他布局 |
| Folder level 1 weight / font size / spacing | 顶层钉选文件夹名称的字重、字号、间距 |
| File type marker style | 文件名旁的扩展名标记样式 |

## 兼容性

- **最低 Obsidian 版本：** 1.6.2
- **仅桌面端** — 使用了移动端不可用的 Node API。

## 开发

```bash
npm install
npm run dev      # esbuild 监听模式
npm run build    # 一次性生产构建 → main.js
```

测试时将构建产物和 `manifest.json` / `styles.css` 软链接或复制到 `.obsidian/plugins/folder-pin/` 即可。

## 许可证

[MIT](./LICENSE) © 2026 Chu HanYue

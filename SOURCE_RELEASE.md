# 源码发布整理报告

发布版本：MineRadio PC 2.1.0  
整理日期：2026-08-05

## 已纳入

- Electron 主进程、预加载脚本和桌面能力源码
- 网页前端、播放器、歌词、可视化和设置模块
- MusicFree 插件宿主、运行时、统一曲目模型和元数据补全模块
- Bilibili 视频媒体模式与普通音频播放链路
- 通用歌曲及歌单链接导入模块
- 汽水音乐、酷狗、QQ 等现有 API 接入源码
- Wallpaper Engine、本地音乐库、桌面歌词和无缝衔接模块
- 安装器脚本、应用图标、许可证和第三方组件说明

## 已排除

- `node_modules/`
- `data/` 及用户运行数据库
- `test/`、`tests/`、`__tests__/`
- `test-fixtures/`
- `*.test.js`、`*.spec.js`
- 测试覆盖率、日志、缓存和临时文件
- Electron 安装目录中的 EXE、DLL、运行库及卸载程序
- 用户登录信息、播放历史、本地音乐路径和第三方私有插件

## 整理验证

- `package.json` 与 `package-lock.json` JSON 解析通过
- 156 个 JavaScript 文件通过 `node --check` 语法检查
- 未发现常见 GitHub Token、OpenAI Key、Google API Key 或 PEM 私钥特征
- 未发现测试目录、测试脚本、依赖目录或运行数据库残留

本报告只说明源码发布包的静态整理与语法验证结果，不等同于完整的 Electron 构建或所有在线音乐服务的联网回归测试。


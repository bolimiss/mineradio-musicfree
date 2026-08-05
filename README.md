# MineRadio PC 2.1.0

MineRadio 是一款 Windows 沉浸式音乐播放器，包含 MusicFree 插件运行时、统一音源解析、歌词与播放队列、Bilibili 视频媒体模式、歌单导入、桌面歌词、Wallpaper Engine 与可视化效果。

## 本源码包说明

此目录由 MineRadio 2.1.0 当前桌面端应用源码整理而成，用于代码托管和后续开发。发布时已主动排除：

- `node_modules` 依赖目录
- `data` 运行数据库及用户歌单数据
- `test`、`tests`、`*.test.js`、`*.spec.js` 和测试夹具
- 日志、缓存、临时文件和本地环境配置
- 安装目录中的 Electron 可执行文件、DLL 和卸载程序

源码包不会携带用户登录状态、Cookies、播放历史或本地音乐资料。

## 目录结构

```text
build/                    安装器脚本、图标和构建素材
cuefield/                 无缝衔接与自动混音逻辑
desktop/                  Electron 主进程、预加载脚本与桌面能力
docs/                     第三方组件说明
musicfree-runtime/        MusicFree 插件运行时与统一模型
public/                   MineRadio 前端页面、样式、播放器与视觉模块
qishui-audio-decryptor/   汽水音乐媒体处理模块
qishui-auth-v6/           汽水音乐授权页面所需前端资源
universal-import/         跨平台歌曲及歌单链接导入模块
server.js                 本地服务与应用 API 入口
musicfree-plugin-host.js  MusicFree 插件管理和媒体解析入口
```

## 安装依赖

要求 Node.js 18 或更高版本：

```bash
npm ci
```

`package.json` 的 Electron 入口为 `desktop/main.js`。本源码整理自已安装的桌面版本，Electron 运行时和打包器并未混入源码包；进行二次开发或生成安装包时，请在自己的构建环境中配置兼容的 Electron 与打包工具。

## 发布前配置

`package.json` 中的 `mineradio.update` 保存了当前版本的更新源设置。若发布到自己的 GitHub 仓库，请将其中的 `owner`、`repo` 和镜像策略改为自己的发布地址，避免客户端继续检查原更新源。

## 数据与隐私

应用运行后产生的数据应保存在被 `.gitignore` 排除的目录中。请勿将以下内容提交到公开仓库：

- 登录凭据、Cookie、Access Token 或二维码登录会话
- 用户歌单、播放历史和本地音乐路径
- `.env`、私钥、签名证书和代码签名密码
- 第三方私有音源插件

## 许可证

项目使用 `GPL-3.0-only` 许可证。第三方组件和移植说明见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 与 [docs/THIRD_PARTY_PORTS.md](docs/THIRD_PARTY_PORTS.md)。发布衍生版本时请保留这些文件，并遵守各第三方组件的许可证要求。


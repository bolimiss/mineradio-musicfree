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

- 本软件接入musicfree做为音源接口 个人觉得这个比LX要好一点 网上暂时没看见有做这个接口 那我就不客气了
- 已经做了2天了 因为在忙 里面因该还有一点bug是我没有发现的 所以就麻烦各位大佬了 联系qq 192565935
- 里面最强我最推荐的就是bilbili源 因为我小改了一下 所以和别的二创不一样 请各位自行饮用
- 软件内置播放源 我针对性的优化了一下 如果导入音源还是建议本地 网络导入不建议
- 软件内改的全是codex中 ai改的 我本来就是打工人但也很喜欢 也非常感叹时代的发展 让我也能体验自己做出的成就
- 也非常希望mineradio原创大佬 可以观摩小弟二创软件 并在此感谢musicfree一只猫头猫大佬和mineradio原创大佬
- 有问题请重启软件
- 如有建议和交流请加上方qq联系我

## 许可证

项目使用 `GPL-3.0-only` 许可证。第三方组件和移植说明见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 与 [docs/THIRD_PARTY_PORTS.md](docs/THIRD_PARTY_PORTS.md)。发布衍生版本时请保留这些文件，并遵守各第三方组件的许可证要求。


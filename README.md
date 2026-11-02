# 小鲸鲸

基于 DSH 和 NapCat 的 QQ 陪伴机器人，支持 Windows 本地部署。

## 功能

- 独立人格、长期记忆、用户画像与关系记录。
- QQ 私聊、群聊、好友申请及群管理。
- 92 张表情包、图片识别、网页检索。
- 本地参考音色语音合成、QQ 一对一语音通话。
- 日记、说说、收藏与主动消息。
- 程序同步更新，个人数据与运行配置独立存储。

歌唱功能为实验功能，支持检索歌曲参考并转换片段。需额外安装后端及模型，不保证音源可用性、完整歌曲生成或合成质量。语音采用参考音频克隆，未进行独立权重微调。

## 运行环境

- Windows 11
- Python 3.12
- Node.js 22 或更高版本
- DSH 0.2.1-rc.2
- QQ 9.9.33-52230、NapCat 4.18.41
- FFmpeg
- NVIDIA CUDA 显卡：用于本地参考音色合成
- VB-Cable：用于原生语音通话
- 兼容 OpenAI 接口的模型服务及 API Key

安装过程需要下载数 GB 的模型与依赖。QQ、DSH、FFmpeg 和 VB-Cable 需单独安装，程序包不包含这些软件。模型 API 费用由对应服务提供方收取。

相关下载：[DSH](https://github.com/deepseek-ai/deepseek-harness) · [NapCat](https://github.com/NapNeko/NapCatQQ) · [Python](https://www.python.org/downloads/windows/) · [Node.js](https://nodejs.org/) · [FFmpeg](https://ffmpeg.org/download.html) · [VB-Cable](https://vb-audio.com/Cable/)

## 安装

1. 解压 Release 中的 Windows ZIP 包。
2. 运行 `configure.cmd`，填写机器人 QQ、管理员 QQ、模型接口、API Key、DSH CLI 路径及专用 NapCat 路径。
3. 运行 `install.cmd` 安装依赖和语音模型。已有 NapCat 账号配置不会被覆盖；按提示导入 `instance/napcat-config/` 中的配置。
4. 关闭专用 QQ，运行 `enable-calls.cmd` 部署原生社交与通话桥。
5. 运行 `doctor.cmd` 检查环境，再运行 `start.cmd` 启动并扫码登录。

API Key 输入不回显。安装失败后可重跑 `install.cmd`；`configure.cmd` 不覆盖已有实例。

QQ 机器人须使用独立安装目录。`napcat.mjs` 通常位于 `versions/<版本>/resources/app/napcat/napcat.mjs`；DSH CLI 位于 `resources/runtime/cli/bin/dsh.cmd`。默认端口为 18081 和 8643，端口被占用时启动失败。

## 更新

- `check-update.cmd`：检查仓库更新。
- `update.cmd`：从本仓库的 `main` 分支同步程序文件。

更新前关闭机器人、DSH 及语音服务，更新后重新启动。同步过程保留聊天、记忆、用户画像、关系记录、收藏、API Key、个人运行配置、模型及依赖环境。运行中的进程不支持热更新。

更新程序校验文件清单与路径，检测到本地代码修改时停止并提示合并。程序备份位于 `update-backups/`；更新失败时自动恢复程序文件。依赖发生变化后需运行 `install.cmd`；原生 QQ 桥发生变化后需关闭专用 QQ 并重新运行 `enable-calls.cmd`。

### v2.104-preview.1 升级

将新版的 `update.py`、`update.cmd`、`check-update.cmd` 复制到旧版根目录，与原 `manifest.json`、`settings.local.json` 同级。关闭旧版服务后运行 `update.cmd`。

升级过程中保留旧目录和 `instance/`，无需重新运行配置。Git 克隆安装同样使用 `update.cmd`；已配置实例不应先通过 `git pull` 覆盖旧模板基线。

## 可选组件

- 本地视觉：运行 `install-vision.cmd` 安装模型，通过 `instance/scripts/vision-on.cmd` 开启。
- 语义检索：首次使用时下载嵌入模型。
- 歌唱实验：相关工具位于 `template/qq-persona/p1/tools/ops/`，后端与权重需另行安装。

通话依赖 VB-Cable、识别服务及语音合成服务。依赖未就绪时不接听来电。部分原生社交操作依赖 QQ 桥部署。

## 目录与数据

- `template/`：程序源码、人格模板、表情与声音素材。
- `instance/`：个人运行实例，存放聊天、记忆、好友记录及运行状态。
- `settings.local.json`：账号、API Key 和安装路径。
- `manifest.json`：发布文件的 SHA-256 校验清单。
- `update-backups/`：更新前的程序备份，可能包含生成后的账号与连接令牌。

`instance/`、`settings.local.json`、更新备份及更新状态均已加入 Git 忽略。对外分发仅使用原始 Release 包或干净仓库，不能打包已使用的安装目录。

首次安装使用空白数据，不包含维护者的好友资料、聊天记录、记忆、登录态或密钥。移动已配置的目录后，需重新生成人格配置并部署含路径的 NapCat 补丁。

## 版本状态

当前为预发布版本。已通过隔离配置、旧版升级、数据保留、失败回滚、隐私扫描及文件完整性检查。完整的新机器安装和真实 QQ 升级流程尚未完成验证。

## 第三方组件

组件来源与许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。QQ 与 AVSDK 从本机安装读取，不随项目分发。

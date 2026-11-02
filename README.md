# 小鲸鲸 · Windows 同步更新版（预发布）

蓝色鲸鱼娘 QQ 陪伴项目。保留人格、92 张正式表情、当前认可的含笑清亮参考声线，以及记忆、搜索、图片、日记/说说、好友/群管理和原生电话功能代码。

首次安装创建空白实例，不携带原作者好友、聊天、记忆、画像、登录态或密钥；之后同步更新保留使用者自己的记忆与关系。当前声线使用参考克隆，并非训练后的独立模型。当前代码含自动查歌/片段转换实验，需另装本地歌唱后端和权重，不保证所有歌或整首歌曲都能生成。

## 后续更新：不需要重新培养

维护者将通过本仓库的 `main` 分支发布后续源码。双击 `check-update.cmd` 查询；关闭机器人/DSH及语音服务后，双击 `update.cmd` 从官方仓库同步，再重新启动。仅替换已发布的程序文件，记忆、好感/关系、聊天、好友、收藏、API Key及个人运行配置原样保留；模型和依赖环境也不会被删除。

更新前校验清单与路径，运行中拒绝更新；发现程序自定义修改会停止并提示合并，不覆盖它们。程序文件备份保存在 `update-backups/`，应用失败自动恢复程序文件。若显示依赖变化，运行 `install.cmd`；原生QQ桥代码更新后，需在关闭专用QQ时重跑 `enable-calls.cmd` 再启动。这是主动同步更新，正在聊天的进程不会热替换。

已下载最初 `v2.104-preview.1` 的用户：把新版包的 `update.py`、`update.cmd`、`check-update.cmd` 复制到旧版根目录（与旧 `manifest.json`、`settings.local.json` 同级），关闭旧机器人后运行 `update.cmd`；不要重新配置、不要覆盖整个instance，也不要删除旧目录。使用Git克隆的用户同样运行 `update.cmd`，已配置实例请勿先用git pull覆盖旧模板基线。

## 安装前

当前目标环境是 Windows 11、Python 3.12、Node.js 22+、DSH 0.2.1-rc.2、QQ 9.9.33-52230 / NapCat 4.18.41。请先自行安装 DSH、ffmpeg 和独立的机器人 QQ/NapCat。原生通话还需要 VB-Cable。QQ/NapCat 和 DSH 程序本体不随包分发。

- DSH：https://github.com/deepseek-ai/deepseek-harness
- NapCat：https://github.com/NapNeko/NapCatQQ
- Node.js：https://nodejs.org/
- Python：https://www.python.org/downloads/windows/
- FFmpeg：https://ffmpeg.org/download.html
- VB-Cable：https://vb-audio.com/Cable/

当前声线推理使用 NVIDIA CUDA 显卡；其他硬件尚未适配为同等体验。安装会下载数 GB 的模型和依赖，需要网络、磁盘空间及可用模型 API。模型 Key/计费由使用者自行配置。

## 使用步骤

1. 下载 Release 附件中的 Windows ZIP 并解压。仓库源码也可用，文件内容相同。
2. 双击 `configure.cmd`，填写机器人 QQ、管理员 QQ、API 地址、模型名、API Key、DSH CLI 和专用 NapCat 的 `napcat.mjs` 路径。API Key 输入不回显。
3. 双击 `install.cmd` 安装依赖和参考声线模型。首次下载可能较久；失败时可重跑此入口，不覆盖个人数据。若已有 NapCat 账号配置，安装器会保留它，提示手动导入 `instance/napcat-config/` 的配置。
4. 关闭专用机器人 QQ，运行 `enable-calls.cmd` 部署原生社交/电话桥，按提示确认；重启后生效。VB-Cable、识别和声线服务未就绪时不会接听。未部署桥时，部分原生社交操作不可用。
5. 双击 `doctor.cmd` 检查依赖，再双击 `start.cmd`，按专用 QQ 窗口提示扫码。

`napcat.mjs` 通常位于专用 QQ 安装目录的 `versions/<版本>/resources/app/napcat/napcat.mjs`。`dsh.cmd` 位于已安装 DSH 的 `resources/runtime/cli/bin/dsh.cmd`。不要使用个人日常 QQ 的安装目录。启动入口会拒绝占用现有 18081/8643 端口；并行运行多个机器人需要另外配置端口。

## 文件和隐私

- `template/`：可分享的源码、人格、表情与必要声音素材。
- `instance/`：配置后创建的个人运行实例，包含之后的好友信息、记忆、聊天及运行令牌，已 Git 忽略。
- `settings.local.json`：你自己的 API Key/账号/安装路径，已 Git 忽略。不要将其发给别人。
- `manifest.json`：发布文件 SHA-256 清单；配置前会检查文件完整性。

再次分享请使用原始 Release 包或干净仓库，不能压缩已经配置使用的整个文件夹。重新配置时请解压一个新目录；安装器拒绝覆盖现有实例。移动已配置目录后，需要重新生成该实例的人格产物，且重新部署包含路径的 NapCat 补丁。

视觉、嵌入和创作代码已保留，语义检索模型按现有实现首次使用时下载；运行 `install-vision.cmd` 下载本地视觉模型，再用 `instance/scripts/vision-on.cmd` 开启。歌唱实验保留当前自动检索/转换源码和下载工具，不包含私人歌曲素材、缓存、ready授权、实验模型或失败试听，需另行准备本地后端。没有新增消息判定模型，也没有改变人格聊天调用链。

本版本完成导出隐私扫描和本地隔离配置测试，**尚未在全新 Windows 机器完成安装、QQ 送达与通话听感验收**。首次发布使用预发布标记。

## 第三方来源

见 `THIRD_PARTY.md`。各组件保留原许可证；QQ/AVSDK 从使用者自己的安装读取，不附带腾讯二进制或任何账号授权。

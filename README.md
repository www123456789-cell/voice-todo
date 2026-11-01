# 语音待办（voice-todo）

自用 Obsidian 插件：录音 → 转写 → AI 整理 → 写入笔记 → 待办汇集。

方案见 `../语音待办-方案.md`。

## 当前进度

- M1（已做）：录音、落盘、状态栏计时、插链接到当前笔记 / 新建笔记
- M2（已做）：停录后自动转写（本机 faster-whisper 调 video-transcribe 脚本），转写结果替换占位块；手动命令「转写当前笔记里的音频」
- M3（已做，等 key 验证）：DeepSeek 整理，写入提要/正文/待办 + frontmatter `ai_title`；key 存 SecretStorage
- M4（已做）：待办汇总到 Todo.md，按文本去重、去掉重复来源链接
- M5（已做）：云端转写适配层（requestUrl + 手工 multipart，手机端走这条），转写/整理失败处挂「重试」按钮
- M6（未做）：手机端联调（iOS 上录音格式 m4a、转写完删音频、临时目录排除同步）

## 安装（手机 / 其它设备）

仓库：`www123456789-cell/voice-todo`，release tag 与 `manifest.json` 的 version 一致（当前 `0.1.0`）。

- 手机：BRAT → Add beta plugin → 填 `www123456789-cell/voice-todo`
- 桌面：直接把本目录放进 `.obsidian/plugins/voice-todo/`，或同样用 BRAT

注意：EasySync 不同步插件文件（2026-10-13 实测），手机端只能走 BRAT。

## 发布

```powershell
.\publish.ps1 -TokenFile C:\path\to\token.txt
```

- token 需要 classic PAT，勾 `repo`；想连 `.github/workflows/release.yml` 一起推，还要勾 `workflow`（只勾 repo 时该文件会 404，脚本会警告但继续发 release）
- 脚本做三件事：建/更新仓库文件 → 建 tag（= manifest.version）的 release → 挂 `main.js` / `manifest.json` / `styles.css`
- 附件名必须一字不差，BRAT 只认这三个名字

## 开发

```powershell
npm install
npm run typecheck
npm run build          # 产出 main.js
.\deploy.ps1           # 构建并复制到 vault，然后 Ctrl+R 重载
```

multipart 组装有独立验证：`npx esbuild src/transcribeCloud.ts --bundle --format=cjs --platform=node --alias:obsidian=./tmp/obsidian-stub.mjs --outfile=tmp/mp.cjs`，然后 `node tmp/multipart-test.mjs`（本地起 HTTP 服务回环校验，不联网）。

## 用法

1. 点左侧 ribbon 的麦克风图标，或命令面板「语音待办：开始 / 停止录音」
2. 状态栏显示录音时长，再点一次停止并保存
3. 有打开的笔记时，音频链接插到光标处；没有则新建一条笔记

录音文件：`<录音保存目录>/<年>/YYYYMMDD-HHmmss.webm`

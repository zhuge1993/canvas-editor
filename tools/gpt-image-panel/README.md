# GPT Image Panel — 独立集成与本地改造区

本目录将上游 GPT Image Panel 与现有 FlowBoard 仓库隔离，保留独立的前后端、依赖和运行配置。

- 上游项目：https://github.com/Z1rconium/gpt-image-panel
- 上游许可：CC BY-NC 4.0；仅按许可允许的非商业用途使用，并保留署名和许可。
- 上游参考 revision（本轮对照上游 main 时的 HEAD）：`434a422edd2313ec5416634075681507965b10d9`
- 原始上游说明：`UPSTREAM-README.md`
- 许可副本：`LICENSE`

## 已导入内容

已经对照上游 revision `434a422edd2313ec5416634075681507965b10d9` 核对文件：上游树共 579 个文件，排除 `.trellis/` 内部开发元数据后，495 个项目文件均已导入；其中 490 个文件与上游字节级一致，5 个文件（`.env.example`、`.gitignore`、`README.md`、`docker-compose.yml`、`package.json`）是为本仓库本地运行作的有意修改，另外保留了 `UPSTREAM-README.md` 副本。构建和测试状态以当前 CI 实际结果为准。

核心能力以现有上游实现为基础，包括图片生成/编辑、画笔与套索蒙版、参考图、画廊、Agent 对话与分支、尺寸/比例设置。当前尚未将它嵌入 FlowBoard 原有主界面，目录隔离优先。

## 本地开发（Windows PowerShell）

先准备后端环境，在仓库根目录执行：

```powershell
cd tools/gpt-image-panel
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
```

启动后端（仅本机开发；不要在对外服务时启用匿名访问）：

```powershell
$env:ALLOW_UNAUTHENTICATED = "true"
.\.venv\Scripts\granian.exe --interface asgi backend.app.main:app --host 127.0.0.1 --port 9090 --reload
```

另开一个 PowerShell 窗口启动前端：

```powershell
cd tools/gpt-image-panel/frontend
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`。开发前端会把 `/api` 和 `/health` 代理到本机的 9090 端口。匿名访问仅适合绑定本机回环地址的开发环境；正式部署请设置足够强的 `ACCESS_KEY`，不要把 `ALLOW_UNAUTHENTICATED=true` 暴露到网络。

## 本地 Docker 运行

在 `tools/gpt-image-panel` 目录：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，为 `ACCESS_KEY` 设置强随机值，然后执行：

```powershell
docker compose up --build -d
```

Compose 默认会构建当前目录中的源码，不再默认拉取上游已发布镜像；服务端口默认只绑定到 `127.0.0.1:9090`。

## 验证命令

从 `tools/gpt-image-panel` 目录运行后端测试：

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests -q
```

前端检查和单元测试：

```powershell
cd frontend
npm ci
npm run check
npm run test:unit
npm run build
npm run check:bundle
npm run check:worker-build
```

仓库根目录的 `.github/workflows/gpt-image-panel-ci.yml` 会为这个隔离目录执行前后端验证。只有 CI 实际通过后，才会将构建/测试状态标记为通过。

## 改造边界

- 应用代码、依赖、配置与运行数据优先保持在本目录，避免影响 FlowBoard 既有功能。
- 保留上游许可证和署名；新增或修改功能时记录改动。
- 不提交 API key、访问令牌、真实 `.env` 文件或用户数据。

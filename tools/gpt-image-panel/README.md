# GPT Image Panel — 本地改造区

此目录用于在 `zhuge1993/canvas-editor` 仓库中独立集成和改造上游项目：

- 上游： https://github.com/Z1rconium/gpt-image-panel
- 上游许可：CC BY-NC 4.0；本地非商业改造需保留署名与许可说明。
- 上游文档副本：`UPSTREAM-README.md`
- 已导入的上游元文件：`LICENSE`、`package.json`、`docker-compose.yml`、`.env.example`
- 目标：尽量保留上游功能，并逐步实现：
  1. 画笔/套索等局部蒙版编辑，尽可能保护未选区域；
  2. 粘贴剪贴板图片作为参考图，并可附带修改提示；
  3. 宽高比和输出尺寸/分辨率选择；
  4. 从指定历史轮次分支出新对话；
  5. 本地自托管运行说明。

## 当前导入状态

**上游完整应用源码尚未导入，本目录目前不是可运行版本。** 已从上游 GitHub 文件接口成功读取并提交 README、LICENSE、package.json、docker-compose.yml 和 .env.example。下一步必须导入 backend/、frontend/、deploy/ 等实际源码目录，再做功能改造和测试。

## 约定

- 所有集成文件限定在本目录，避免覆盖仓库现有应用。
- 保留上游 LICENSE/NOTICE/署名信息，并在改动后标注修改内容。
- 不提交 API 密钥、令牌或个人配置。
- 上游原始说明保存在 `UPSTREAM-README.md`，本文件用于记录集成状态。

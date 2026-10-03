# 设备验收脚本

这些脚本针对已经资格验证并安装的 Dior 手机，不是通用桌面测试。固定 QA 目录是
`/tmp/dior-kernel-test/voice-qa`，结果写入该目录，不保存麦克风音频。
模型、运行库与生成语音测试夹具不随源码分发。

- `audit-live-voice.py`：早期独立 voice/model/KWS 三进程的基准审计；共享服务部署后
  使用 `audit-shared-final.py --bundle-sha <当前网站bundle SHA256>` 核对四个进程、
  唯一模型、UID/socket、30 秒闲置、开机启动和数据/分享/游客接口边界。
- `test-supervisor-recovery.py`：仅对核对过路径的 voice 控制器暂停 350ms，再恢复，
  检查 supervisor 新实例恢复全双工、唤醒词保留及网站/穿透 PID 不变。
- `test-kws-controller.py`：需要先停止 **仅 voice** 服务，避免同时占用 PCM。
  注入外部准备的 Piper 16 kHz mono 夹具，真实 KWS/ASR/mixer/speaker 联动。
  预期文件是 `fixtures/derived-prefix-550.wav`、`max.wav`、`min.wav`、
  `confirm.wav`、`identity.wav`。它用独立的测试 settings，不改生产唤醒词。
  完成后必须重新启动 voice 并等到 ready。

设备服务命令都使用 `rc-service --nodeps dior-voice`，不要停止共享 ASR、网站或穿透。
各脚本的生成音频检查和故障注入不等同于真人说话、听感、远距离噪声或 24 小时验收。

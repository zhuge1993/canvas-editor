# 快速判断

网站使用本机 bge-small-zh-v1.5 小模型进行短文本与候选描述匹配。登录后点击“快速判断”，选择有权访问的文字摘要范围，再输入内容和候选描述。支持选择、真假描述匹配、等级描述匹配，结果不会修改数据。

GET /api/decision/status 返回固定模型的就绪、冷却及输入限制；POST /api/decision/evaluate 接收 `{state, context:{kind,id?}, questions:[{id,type,question,options?,levels?,criteria?}]}`。真假判断的 criteria 必须有 true/false 两种不同的完整描述。

最多 4 题、16 个选择项或 10 个等级；权重必须有限、在 0 至 1 之间且总和为 1。模型最多 128 token，包括网页合并的摘要；超长输入拒绝，不截断。输入文字编码一次，候选描述以小型内存缓存复用，返回结果前重新验证登录与资料权限。

百分比是归一化后的语义匹配权重，不是经过校准的判断正确率；问题名称用于标注，完整选项描述决定匹配含义。模型不生成聊天回答，不做通用逻辑推理。

部署、速度与限制见 models/fast-decision/README.md；OpenAI 格式接口见 frontend/docs/openai-compatible.md。外部 API 使用独立 Bearer Key，仅判断调用方提供的文本，不访问网站数据。旧“二狗”及手机 AgentJev-0.6B 服务已移除。

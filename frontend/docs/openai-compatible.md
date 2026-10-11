# OpenAI 格式 API

模型：`bge-small-zh-v1.5`。在接入工具中选择 OpenAI 兼容接口，填写你的网站地址加 `/v1`、独立 API Key 和该模型名称。

支持：`GET /v1/models`、`POST /v1/chat/completions`，非流式 ChatCompletion 响应与 SSE ChatCompletionChunk 响应、`stream_options.include_usage`、文本 content parts、`response_format: {type: "json_object"}`。输入必须有最后一条 user 文本消息。结果是分类 JSON，放在 `choices[0].message.content`；SSE 在匹配完成后发送完整结果及 `[DONE]`，没有逐字生成过程。

普通 user 文本使用四个预设类别：程序故障（bug）、需求建议（request）、进度查询（progress）、其他（other）。自定义候选项时，将以下 JSON 序列化后放入最后一条 user 消息：

```json
{
  "id": "my-task",
  "state": "保存画布后新增图形消失了。",
  "questions": [{
    "id": "category",
    "type": "choice",
    "question": "问题分类",
    "options": {
      "bug": "程序故障，功能异常，使用时出现问题",
      "request": "新功能需求，希望增加新功能",
      "progress": "查询进度，询问工作完成情况"
    }
  }]
}
```

`question` 标注任务，候选描述控制语义匹配；不是自然语言指令执行器。真假判断必须提供 `criteria: {true: "程序故障，功能无法使用", false: "功能正常，能够使用"}`。等级评分使用从低到高的完整 `levels` 描述。每条模型输入最多 128 token，不截断，超长输入返回 400；最多 4 题、每题 16 个候选项。请求体上限 16KiB。

返回的 `distribution` 是 softmax 归一化后的语义匹配权重，不是经校准的正确率。`usage.completion_tokens` 为 0，因为没有逐字生成；`prompt_tokens` 统计本次实际编码 token，缓存命中会降低它。system/developer/assistant 消息仅作协议兼容，不改变分类器行为；只判断最后一条 user 消息。temperature、max_tokens 等生成参数不改变模型计算。n 仅支持 1。

```python
import json
from openai import OpenAI

client = OpenAI(base_url="https://你的手机网站地址/v1", api_key="你的独立API密钥")
response = client.chat.completions.create(
    model="bge-small-zh-v1.5",
    messages=[{"role": "user", "content": "登录页面打不开，使用时一直报错。"}],
    response_format={"type": "json_object"},
)
decision = json.loads(response.choices[0].message.content)
print(decision["results"][0]["answers"][0])
```

API 密钥从服务环境 `FLOWBOARD_API_KEY_FILE` 指定的文件读取；留空则外部 API 返回 503。部署默认为 `/etc/flowboard/decision-api.key`，文件 root:flowboard 0640，父目录 root:flowboard 0750。密钥不放在网页、URL、日志或源码。网站 API 只向本机推理服务转发输入，不将外部 API Key 或 Cookie 传给推理进程，也不提供网站资料读取权限。模型进程不监听局域网，外部调用通过现有 HTTPS 网站入口。

错误采用 `{error:{message,type,param,code}}`：密钥缺失或错误为 401，模型或配置不可用为 503，温度冷却为 503/code=cooling，繁忙或限速为 429。外部 API 最多 60 次/分钟、2 个网关请求并发，模型一次只计算一个请求。工具调用、图片、音频、logprobs、JSON Schema 和其他端点明确拒绝；该接口不是通用聊天模型或完整 OpenAI API 实现。

已使用官方 OpenAI Python SDK 通过手机实际公网入口验证模型列表、三种普通文本分类、SSE/usage 以及错误密钥拒绝。响应封装依据：[OpenAI 官方 Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/)。

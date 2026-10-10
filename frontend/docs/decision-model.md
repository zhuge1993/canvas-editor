# 概率判断

登录后点击“概率判断”，输入待判断的内容、问题以及候选选项。支持选择最合适选项、判断是或否，以及从低到高的评分。界面显示真实模型的概率分布；服务不可用时显示不可用状态，不产生模拟结果。参考范围限定为当前用户有权访问的工作台、项目或画布。判断不会修改项目数据。

接口：

- GET /api/decision/status：模型就绪状态、固定模型名称及输入限制。
- POST /api/decision/evaluate：`{state, context:{kind,id?}, questions:[{id,type,question,options?,levels?}]}`。
- 返回模型名称、各问题的结果与概率、参考来源及只读标志。

每次最多4个问题，每题最多16个选择项或10个评分等级。问题和选项标识必须唯一；概率必须有限、在0至1之间且总和为1。超长 token 输入由模型服务拒绝，不静默截断。返回结果前重新验证会话与资料授权。

模型准备与启动见 models/agentjev/README.md。默认网站通过本机 http://127.0.0.1:8149 调用 AgentJev-0.6B。旧网页录音、语音问答、播报接口及手机唤醒助手已从源码移除。设备上旧安装需执行 linux/dior/retire-assistant.py --apply；新模型的手机安装与实测限制见 models/agentjev/README.md；旧助手卸载与新模型安装分别执行。

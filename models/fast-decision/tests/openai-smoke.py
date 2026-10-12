from pathlib import Path
import json
import time
from openai import OpenAI,AuthenticationError,BadRequestError

import os
base=os.environ['OPENAI_BASE_URL']
secret=os.environ['OPENAI_API_KEY']
client=OpenAI(base_url=base,api_key=secret,timeout=30,max_retries=0)
model='bge-small-zh-v1.5'
assert client.models.list().data[0].id==model
tests=[]
for text,expected in [('登录页面打不开了，使用时一直报错。','bug'),('希望增加导出PDF功能。','request'),('这个任务目前完成到哪一步了？','progress')]:
 start=time.monotonic()
 response=client.chat.completions.create(model=model,messages=[{'role':'user','content':text}],response_format={'type':'json_object'})
 seconds=round(time.monotonic()-start,3)
 result=json.loads(response.choices[0].message.content)
 actual=result['results'][0]['answers'][0]['value']
 tests.append({'text':text,'expected':expected,'actual':actual,'network_seconds':seconds,'model_ms':result['usage']['wall_ms']})
 assert actual==expected,tests[-1]
stream=client.chat.completions.create(model=model,messages=[{'role':'user','content':'登录页面打不开了。'}],stream=True,stream_options={'include_usage':True})
text='';usage=None
for chunk in stream:
 if chunk.choices:text+=chunk.choices[0].delta.content or ''
 if chunk.usage:usage=chunk.usage
assert json.loads(text)['model']==model and usage is not None
try:
 OpenAI(base_url=base,api_key='wrong_key_'+('x'*32),max_retries=0).models.list()
except AuthenticationError:pass
else:raise AssertionError('invalid key accepted')
report={'status':'PASS_REAL_OPENAI_PYTHON_SDK','base_url':base,'model':model,'classification_cases':tests,'stream_and_usage':True,'invalid_key_denied':True}
print(json.dumps(report,ensure_ascii=True))

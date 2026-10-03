"""Host-only adapter contracts; fake native output, no model/device evidence."""
import collections
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time
import types

core=types.ModuleType('interfaces')
class LanguageReply:
    def __init__(self,text,intent=None):self.text=text;self.intent=intent
core.LanguageReply=LanguageReply;sys.modules['interfaces']=core
spec=importlib.util.spec_from_file_location('llm_adapter',Path(__file__).with_name('adapter.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Fake(module.LocalLanguageModel):
    def __init__(self):
        self._lock=threading.Lock();self._history_lock=threading.Lock();self._history=collections.deque(maxlen=2)
        self._history_epoch=0;self._serial=0;self.last_metrics=None;self.sent=[];self.status='complete';self.reply='回答'
        self.cancel_on_receive=None;self.clear_on_receive=False;self.reject_context_once=False
    def _send(self,value):self.sent.append(dict(value))
    def _receive(self,deadline):
        if self.cancel_on_receive:self.cancel_on_receive.set();self.cancel_on_receive=None
        if self.clear_on_receive:self.clear_history();self.clear_on_receive=False
        status=self.status
        if self.reject_context_once:self.reject_context_once=False;status='prompt_context_limit'
        return {'type':'done','id':self.sent[-1]['id'],'status':status,'text':self.reply}
    def close(self):pass

checks=[];model=Fake()
def ask(text,cancel=None):return model.generate(text,cancel=cancel or threading.Event(),deadline=time.monotonic()+5)
for i in range(3):ask('第'+str(i)+'问'+'甲'*80)
assert len(model._history)==2 and all(len(q)<=24 and len(a)<=24 for q,a in model._history)
checks.append('two_turns_each_side24_limit')
ask('接着说');assert '前文：' in model.sent[-1]['text'];assert len(model.sent[-1]['text'].encode())<=768 and model.sent[-1]['max_tokens']==24
checks.append('bounded_context_prepend')
ask('字'*256);assert model.sent[-1]['text']=='字'*256
checks.append('drop_history_for_current_question_byte_budget')
before=list(model._history);cancel=threading.Event();model.cancel_on_receive=cancel
assert ask('取消的这一问',cancel).text=='' and list(model._history)==before
checks.append('cancelled_response_not_recorded')
model.status='deadline';assert ask('失败的一问').text=='' and list(model._history)==before;model.status='complete'
checks.append('failed_response_not_recorded')
model.clear_on_receive=True;ask('正在结束的对话');assert not model._history
checks.append('clear_invalidates_inflight_history_save')
ask('先前的一问');model.reject_context_once=True;ask('当前小问题')
assert model.sent[-1]['text']=='当前小问题' and model.last_metrics['history_excerpt_turns']==0
checks.append('native_token_limit_retry_without_old_context')
model.clear_history();assert not model._history
checks.append('explicit_clear')
print(json.dumps({'status':'PASS_HOST_ADAPTER_CONTRACTS','checks':checks,'real_model_tested':False,'phone_tested':False},ensure_ascii=False))

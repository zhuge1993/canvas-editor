"""Typed deterministic skills. Web/LLM text is never dispatched as a command."""
from dataclasses import dataclass
from datetime import datetime,timezone,timedelta
import html
import json
import re
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from settings import validate_wake

@dataclass(frozen=True)
class Intent:
    kind:str
    value:object=None

def normalize(text):
    import unicodedata
    return ''.join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith('P')).lower()

def parse_intent(text):
    if not isinstance(text,str) or len(text)>512:return Intent('unsupported')
    s=normalize(text)
    match=re.fullmatch(r'(?:把|将)?(?:唤醒词|你的名字)(?:改成|改为|换成|设为|设置成|设置为)(.+)',s)
    if not match:match=re.fullmatch(r'(?:以后|从现在起)(?:我)?(?:叫你|称呼你)(.+)',s)
    # Streaming ASR can transcribe jiào as 教. Only an explicit future
    # nickname phrase with 小/阿 enters the existing confirmation flow;
    # ordinary teaching requests remain chat, and wake matching is untouched.
    if not match:match=re.fullmatch(r'(?:以后|从现在起)(?:我)?教你([小阿][\u3400-\u9fff]{1,7})',s)
    if match:
        try:return Intent('change_wake_word',validate_wake(match[1]))
        except ValueError:return Intent('invalid_wake_word')
    if s in ('取消','算了','停止','停下','别说了'):return Intent('cancel')
    if s in ('你是谁','你叫什么','你叫什么名字','你叫啥','叫啥','你的名字是什么'):return Intent('identity')
    if any(v in s for v in ('几点','现在时间','报时')):return Intent('time')
    if s in ('状态','设备状态','系统状态','你能做什么'):return Intent('status')
    volume=s.rstrip('啊呀吧')
    head=r'(?:把|将)?(?:手机|当前)?(?:音量|声音)(?:给)?'
    action=r'(?:调整到|调到|设置为|设为|改为|改成|调成|开到)?'
    if re.fullmatch(head+action+r'(?:最大|最高|拉满)',volume):return Intent('volume',100)
    if re.fullmatch(head+action+r'(?:最小|最低)',volume):return Intent('volume',0)
    match=re.fullmatch(head+action+r'(?:百分之)?(\d{1,3}|[零〇一二两三四五六七八九十百]{1,3})(?:百分比)?',volume)
    if match:
        token=match[1]
        digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}
        if token.isdigit():n=int(token)
        elif token in digits:n=digits[token]
        elif token in ('百','一百'):n=100
        elif re.fullmatch(r'[一二两三四五六七八九]?十[一二三四五六七八九]?',token):
            left,right=token.split('十');n=(digits[left] if left else 1)*10+(digits[right] if right else 0)
        else:return Intent('invalid_volume')
        return Intent('volume',n) if 0<=n<=100 else Intent('invalid_volume')
    if s in ('音量大一点','调大音量','声音大一点','大声一点'):return Intent('volume_delta',10)
    if s in ('音量小一点','调小音量','声音小一点','小声一点'):return Intent('volume_delta',-10)
    if s in ('静音','关闭声音'):return Intent('volume',0)
    match=re.fullmatch(r'(?:帮我)?(?:查一下|查询|搜一下|搜索)(.{1,120})',text.strip())
    if match:return Intent('query',match[1])
    return Intent('chat',text.strip())

class EvidenceSearch:
    """Bing-first HTTPS evidence, with one bounded DNS/HTTP flight at a time."""
    def __init__(self,opener=urllib.request.urlopen):
        self.opener=opener;self._slot=threading.Lock()
    def _request(self,url,allowed,cancel,deadline):
        if cancel.is_set() or time.monotonic()>=deadline:raise TimeoutError('query_cancelled')
        request=urllib.request.Request(url,headers={'User-Agent':'DiorLocalVoiceAssistant/1 (read-only evidence)'})
        with self.opener(request,timeout=min(3,max(.1,deadline-time.monotonic()))) as response:
            final=response.geturl()
            if urllib.parse.urlparse(final).hostname not in allowed or not final.startswith('https://'):raise ValueError('unexpected_query_redirect')
            data=response.read(32769)
        if len(data)>32768:raise ValueError('query_response_limit')
        if cancel.is_set() or time.monotonic()>=deadline:raise TimeoutError('query_cancelled_or_deadline')
        return data
    def _wiki(self,query,cancel,deadline):
        params=urllib.parse.urlencode({'action':'query','format':'json','list':'search','srsearch':query,'srlimit':1,'utf8':1})
        url='https://zh.wikipedia.org/w/api.php?'+params
        records=json.loads(self._request(url,{'zh.wikipedia.org'},cancel,deadline)).get('query',{}).get('search',[])
        if records:
            row=records[0];title=str(row.get('title',''))[:120]
            excerpt=html.unescape(re.sub(r'<[^>]+>','',str(row.get('snippet',''))))[:500]
            if title and excerpt:return {'engine':'wikipedia','title':title,'excerpt':excerpt,
                'source_url':'https://zh.wikipedia.org/wiki/'+urllib.parse.quote(title),
                'retrieved_utc':datetime.now(timezone.utc).isoformat(),'untrusted_data':True}
        return None
    def _bing(self,query,cancel,deadline):
        params=urllib.parse.urlencode({'format':'rss','q':query})
        data=self._request('https://cn.bing.com/search?'+params,{'cn.bing.com','www.bing.com','bing.com'},cancel,deadline)
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():raise ValueError('rss_entity_rejected')
        tree=ET.fromstring(data)
        for item in tree.findall('./channel/item')[:3]:
            title=(item.findtext('title') or '')[:120];link=item.findtext('link') or ''
            excerpt=html.unescape(re.sub(r'<[^>]+>','',item.findtext('description') or ''))[:500]
            parsed=urllib.parse.urlparse(link)
            if title and excerpt and parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password:
                return {'engine':'bing_rss','title':title,'excerpt':excerpt,'source_url':link[:2048],
                    'retrieved_utc':datetime.now(timezone.utc).isoformat(),'untrusted_data':True}
        return None
    def _direct(self,query,cancel,deadline):
        try:result=self._bing(query,cancel,deadline)
        except (OSError,TimeoutError,ET.ParseError):result=None
        if result is not None:return result
        if cancel.is_set() or time.monotonic()>=deadline:raise TimeoutError('query_cancelled_or_deadline')
        return self._wiki(query,cancel,deadline)
    def lookup(self,query,cancel,deadline):
        if not isinstance(query,str) or not 0<len(query)<=120:raise ValueError('query_limit')
        remaining=deadline-time.monotonic()
        if cancel.is_set() or remaining<=0:raise TimeoutError('query_cancelled_or_deadline')
        if remaining>30:raise ValueError('query_deadline_limit')
        if not self._slot.acquire(blocking=False):raise RuntimeError('query_busy')
        done=threading.Event();box={}
        def flight():
            try:
                result=self._direct(query,cancel,deadline)
                # Neither late DNS/HTTP completion nor cancellation can feed
                # an old result back into a newer voice generation.
                if not cancel.is_set() and time.monotonic()<deadline:box['result']=result
            except Exception as error:
                if not cancel.is_set() and time.monotonic()<deadline:box['error']=error
            finally:self._slot.release();done.set()
        thread=threading.Thread(target=flight,name='voice-evidence-flight',daemon=True)
        try:thread.start()
        except BaseException:self._slot.release();raise
        while True:
            if cancel.is_set():raise TimeoutError('query_cancelled')
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('query_deadline')
            if done.wait(min(.02,remaining)):
                if cancel.is_set() or time.monotonic()>=deadline:raise TimeoutError('query_cancelled_or_deadline')
                if 'error' in box:raise box['error']
                return box.get('result')

def time_reply(clock=None):
    instant=clock() if clock else datetime.now(timezone(timedelta(hours=8)))
    return '现在是%d点%02d分。'%(instant.hour,instant.minute)

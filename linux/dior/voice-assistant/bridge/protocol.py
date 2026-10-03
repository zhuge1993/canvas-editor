"""Private inference bridge framing and bounded request contract."""
import base64
import json
import re
import socket
import time

MAX_FRAME=1024*1024
MAX_RESPONSE=1280*1024
OPS={'status','chat','tts','transcribe','clear_history','begin_voice_asr','end_voice_asr'}
class BridgeError(Exception):
    def __init__(self,code):self.code=code;super().__init__(code)
def utf8_clip(text,limit):return text.encode('utf8')[:limit].decode('utf8','ignore')
def depth_ok(raw):
    depth=0;quoted=False;escaped=False
    for ch in raw:
        if quoted:
            if escaped:escaped=False
            elif ch==92:escaped=True
            elif ch==34:quoted=False
        elif ch==34:quoted=True
        elif ch in (123,91):
            depth+=1
            if depth>8:return False
        elif ch in (125,93):
            depth-=1
            if depth<0:return False
    return depth==0 and not quoted
def encode(value,limit=MAX_RESPONSE):
    data=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
    if len(data)>limit:raise BridgeError('response_limit')
    return data
def receive(connection,deadline,buffer=None,limit=MAX_FRAME):
    buffer=bytearray() if buffer is None else buffer
    while True:
        end=buffer.find(b'\n')
        if end>=0:
            raw=bytes(buffer[:end]);del buffer[:end+1]
            if not raw or len(raw)+1>limit or not depth_ok(raw):raise BridgeError('invalid_request')
            try:value=json.loads(raw)
            except (ValueError,UnicodeError):raise BridgeError('invalid_request')
            if not isinstance(value,dict):raise BridgeError('invalid_request')
            return value
        if len(buffer)>=limit:raise BridgeError('frame_limit')
        left=deadline-time.monotonic()
        if left<=0:raise BridgeError('deadline')
        connection.settimeout(left)
        try:part=connection.recv(min(65536,limit-len(buffer)))
        except socket.timeout:raise BridgeError('deadline')
        if not part:raise BridgeError('disconnected')
        buffer.extend(part)
def validate(request,role):
    if type(request.get('v')) is not int or request.get('v')!=1 or not isinstance(request.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',request['id']):raise BridgeError('invalid_request')
    op=request.get('op')
    if op not in OPS:raise BridgeError('invalid_request')
    if role=='operator' and op!='status':raise BridgeError('forbidden')
    if op in ('clear_history','begin_voice_asr','end_voice_asr') and role!='voice':raise BridgeError('forbidden')
    timeout=request.get('deadline_ms',25000)
    if type(timeout) is not int or not 1000<=timeout<=30000:raise BridgeError('invalid_request')
    allowed={'v','id','op','deadline_ms'}
    if op=='chat':
        allowed|={'text','context'};text=request.get('text');context=request.get('context','')
        if not isinstance(text,str) or not text.strip() or len(text)>1000 or len(text.encode())>3000 or not isinstance(context,str) or len(context.encode())>1536:raise BridgeError('invalid_request')
        if role=='voice' and context:raise BridgeError('invalid_request')
    if op=='tts':
        allowed.add('text');text=request.get('text')
        if not isinstance(text,str) or not text.strip() or len(text)>120 or len(text.encode())>480:raise BridgeError('invalid_request')
    if op=='transcribe':
        allowed.add('pcm16_base64');text=request.get('pcm16_base64')
        if not isinstance(text,str) or len(text)>853336:raise BridgeError('invalid_request')
        try:pcm=base64.b64decode(text,validate=True)
        except (ValueError,base64.binascii.Error):raise BridgeError('invalid_request')
        if not pcm or len(pcm)%2 or len(pcm)>640000 or base64.b64encode(pcm).decode()!=text:raise BridgeError('invalid_request')
    if op in ('begin_voice_asr','end_voice_asr'):
        allowed|={'lease_id','ttl_ms'}
        if not isinstance(request.get('lease_id'),str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',request['lease_id']):raise BridgeError('invalid_request')
        if op=='begin_voice_asr' and (type(request.get('ttl_ms',20000)) is not int or not 1<=request.get('ttl_ms',20000)<=20000):raise BridgeError('invalid_request')
    if set(request)-allowed:raise BridgeError('invalid_request')
    return timeout/1000

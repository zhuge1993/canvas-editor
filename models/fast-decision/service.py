"""Loopback semantic decisions with an OpenAI Chat Completions adapter."""
import argparse
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
import uuid
from engine import Engine,MODEL


def chat_input(data):
    if not isinstance(data,dict):raise ValueError('request must be an object')
    if data.get('model')!=MODEL:raise ValueError('unknown model; use '+MODEL)
    for name in ['tools','functions','tool_choice','function_call','modalities','audio','logprobs']:
        if name in data:raise ValueError(name+' is not supported by a semantic classifier')
    if data.get('n',1)!=1:raise ValueError('only n=1 is supported')
    if not isinstance(data.get('stream',False),bool):raise ValueError('stream must be boolean')
    if 'stream_options' in data:
        if not data.get('stream') or not isinstance(data['stream_options'],dict) or set(data['stream_options'])-{'include_usage'} or not isinstance(data['stream_options'].get('include_usage',False),bool):raise ValueError('invalid stream_options')
    if 'response_format' in data:
        if not isinstance(data['response_format'],dict) or data['response_format'].get('type') not in ['text','json_object']:raise ValueError('supported response_format types: text, json_object')
    messages=data.get('messages')
    if not isinstance(messages,list) or not 1<=len(messages)<=16:raise ValueError('messages must contain 1..16 text messages')
    users=[]
    for item in messages:
        if not isinstance(item,dict) or item.get('role') not in ['system','developer','user','assistant']:raise ValueError('invalid message role')
        content=item.get('content')
        if isinstance(content,list):
            if not content or any(not isinstance(part,dict) or part.get('type')!='text' or not isinstance(part.get('text'),str) for part in content):raise ValueError('only text content parts are supported')
            content=''.join(part['text'] for part in content)
        if not isinstance(content,str) or len(content)>4096:raise ValueError('only bounded text messages are supported')
        if item['role']=='user':users.append(content)
    if not users or messages[-1].get('role')!='user':raise ValueError('last message must be user text')
    text=users[-1]
    try:payload=json.loads(text)
    except json.JSONDecodeError:
        if text.lstrip().startswith(('{','[')):raise ValueError('malformed decision JSON')
        payload={'state':text,'questions':[{'id':'category','type':'choice','question':'文本归类','options':{
            'bug':'程序故障，功能异常，页面打不开，使用时出现错误',
            'request':'需求建议，希望增加新功能或修改现有功能',
            'progress':'查询进度，询问任务是否完成以及工作完成情况',
            'other':'日常问候，闲聊，以及其他无关内容'}}]}
    if not isinstance(payload,dict):raise ValueError('user JSON must be a decision object')
    return payload


def handler(engine):
    slot=threading.BoundedSemaphore(1)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def reply(self,status,data):
            raw=json.dumps(data,ensure_ascii=False,allow_nan=False).encode('utf-8')
            self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers()
            try:self.wfile.write(raw)
            except (BrokenPipeError,ConnectionResetError):pass
        def error(self,status,message,kind='invalid_request_error',code=None):
            self.reply(status,{'error':{'message':message,'type':kind,'param':None,'code':code}})
        def do_GET(self):
            if self.path=='/health':
                info=engine.info();self.reply(200,{'status':'ready' if info['available'] else 'unavailable',**info})
            elif self.path=='/v1/models':self.reply(200,{'object':'list','data':[{'id':MODEL,'object':'model','created':0,'owned_by':'local'}]})
            else:self.error(404,'endpoint not found')
        def do_POST(self):
            compatible=self.path=='/v1/chat/completions'
            if not compatible and self.path!='/api/evaluate':self.error(404,'endpoint not found');return
            if not slot.acquire(blocking=False):self.error(429,'model busy','rate_limit_error','model_busy');return
            try:
                self.connection.settimeout(10)
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=16384:self.error(413,'request exceeds 16384 bytes');return
                if self.headers.get('Content-Type','').split(';')[0].strip()!='application/json' or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Encoding','identity')!='identity':self.error(415,'uncompressed JSON required');return
                raw=self.rfile.read(length)
                if len(raw)!=length:raise ValueError('incomplete request')
                data=json.loads(raw,parse_constant=lambda v:(_ for _ in ()).throw(ValueError('nonfinite JSON')))
                payload=chat_input(data) if compatible else data
                result=engine.evaluate(payload)
                if not compatible:self.reply(200,result);return
                content=json.dumps(result,ensure_ascii=False,separators=(',',':'),allow_nan=False)
                identity='chatcmpl-'+uuid.uuid4().hex;created=int(time.time())
                usage={'prompt_tokens':result['usage']['input_path_tokens'],'completion_tokens':0,'total_tokens':result['usage']['input_path_tokens']}
                if data.get('stream'):
                    self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Cache-Control','no-store');self.send_header('Connection','close');self.end_headers();self.close_connection=True
                    def event(value):
                        self.wfile.write(('data: '+json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n\n').encode());self.wfile.flush()
                    base={'id':identity,'object':'chat.completion.chunk','created':created,'model':MODEL}
                    try:
                        event({**base,'choices':[{'index':0,'delta':{'role':'assistant','content':''},'finish_reason':None}]})
                        event({**base,'choices':[{'index':0,'delta':{'content':content},'finish_reason':None}]})
                        event({**base,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]})
                        if data.get('stream_options',{}).get('include_usage'):event({**base,'choices':[],'usage':usage})
                        self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
                    except (BrokenPipeError,ConnectionResetError):pass
                else:self.reply(200,{'id':identity,'object':'chat.completion','created':created,'model':MODEL,'choices':[{'index':0,'message':{'role':'assistant','content':content,'refusal':None},'finish_reason':'stop'}],'usage':usage})
            except (ValueError,TypeError,KeyError,UnicodeError) as error:
                self.error(400,str(error) if isinstance(error,ValueError) else 'invalid input')
            except Exception as error:
                code='cooling' if str(error)=='model cooling or temperature unavailable' else 'timeout' if str(error)=='model deadline exceeded' else 'inference_failed'
                if compatible:self.error(503,'model temporarily unavailable','server_error',code)
                else:self.reply(503,{'error':'model temporarily unavailable','code':code})
                if engine.process.poll() is not None:threading.Thread(target=self.server.shutdown,daemon=True).start()
            finally:slot.release()
    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,*args,**kwargs):
        self.connections=threading.BoundedSemaphore(8);super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.connections.acquire(blocking=False):self.shutdown_request(request);return
        request.settimeout(10)
        try:super().process_request(request,address)
        except BaseException:self.connections.release();raise
    def process_request_thread(self,request,address):
        try:super().process_request_thread(request,address)
        finally:self.connections.release()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path('/opt/fast-decision'))
    parser.add_argument('--port',type=int,default=8149)
    parser.add_argument('--threads',type=int,choices=range(1,5),default=2)
    args=parser.parse_args();engine=Engine(args.root,args.root/'fast-decision-worker',args.threads)
    server=Server(('127.0.0.1',args.port),handler(engine))
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close();engine.close()

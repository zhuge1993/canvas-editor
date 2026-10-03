#!/usr/bin/env python3
"""Local CPU ASR client for bounded PCM16 mono16k WAV files or readiness.

The default feeds WAV chunks at their real-time availability and then feeds
paced silence for endpoint detection. It does not record microphone audio.
No file is written: results go to stdout only.
"""
import argparse
import base64
import json
from pathlib import Path
import socket
import sys
import time
import wave

sys.dont_write_bytecode=True
LIMIT=65536

class Client:
    def __init__(self,path,timeout=95):
        self.socket=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.socket.settimeout(timeout);self.socket.connect(path)
        self.buffer=bytearray();self.serial=0
        while True:
            response=self.receive()
            if response.get('type')=='ready_session':self.ready=response;break
            if response.get('type')=='error':raise RuntimeError(response.get('code','service_error'))
            if response.get('type')!='queued':raise RuntimeError('invalid_service_handshake')
        self.socket.settimeout(15)

    def receive(self):
        while True:
            end=self.buffer.find(b'\n')
            if end>=0:
                line=bytes(self.buffer[:end]);del self.buffer[:end+1]
                if len(line)+1>LIMIT:raise RuntimeError('response_limit')
                result=json.loads(line)
                if not isinstance(result,dict):raise RuntimeError('invalid_service_response')
                return result
            if len(self.buffer)>=LIMIT:raise RuntimeError('response_limit')
            data=self.socket.recv(min(4096,LIMIT-len(self.buffer)))
            if not data:raise RuntimeError('service_disconnected')
            self.buffer.extend(data)

    def request(self,op,**data):
        self.serial+=1;ident='client_'+str(self.serial)
        request={'op':op,'id':ident,**data};line=(json.dumps(request,separators=(',',':'))+'\n').encode()
        if len(line)>LIMIT:raise ValueError('request_limit')
        self.socket.sendall(line);response=self.receive()
        if response.get('id')!=ident:raise RuntimeError('response_order')
        if response.get('type')=='error':raise RuntimeError(response.get('code','service_error'))
        return response

    def close(self):self.socket.close()

def sleep_until(deadline):
    delay=deadline-time.monotonic()
    if delay>0:time.sleep(delay)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wav',nargs='?',help='PCM16 mono16k WAV, max30s for eos, max27s for endpoint')
    parser.add_argument('--socket',default='/run/dior-asr/recognize.sock')
    parser.add_argument('--ready',action='store_true',help='Verify socket, loaded model, ping and CPU-only worker')
    parser.add_argument('--chunk-ms',type=int,default=200,metavar='20..1000')
    parser.add_argument('--finish-mode',choices=['endpoint','eos'],default='endpoint')
    parser.add_argument('--events',action='store_true',help='Print bounded per-chunk partial/final JSON to stdout')
    args=parser.parse_args()
    if not 20<=args.chunk_ms<=1000:parser.error('chunk-ms must be between20 and1000')
    if not args.ready and not args.wav:parser.error('Provide a WAV or --ready')
    client=None
    try:
        client=Client(args.socket)
        if args.ready:
            response=client.request('ping')
            print(json.dumps({'status':'READY','model_name':client.ready['model_name'],
                'gpu_used':False,'threads':client.ready['threads'],'worker_pid':response['worker_pid'],
                'model_load_count':response['model_load_count'],'max_rss_kib':response.get('max_rss_kib'),
                'temperature_c':client.ready.get('temperature_c')},ensure_ascii=False))
            return
        path=Path(args.wav)
        if not path.is_file() or path.stat().st_size>1024*1024:raise ValueError('Expected bounded regular WAV')
        with wave.open(str(path),'rb') as audio:
            if (audio.getnchannels(),audio.getsampwidth(),audio.getframerate(),audio.getcomptype())!=(1,2,16000,'NONE'):
                raise ValueError('Expected PCM16 mono16k WAV')
            duration=audio.getnframes()/16000.
            bound=27 if args.finish_mode=='endpoint' else 30
            if not 0<duration<=bound:raise ValueError('WAV exceeds audio budget for finish mode')
            begin=time.monotonic();seen=0;chunks=0;first_partial=None;last_real_accept=None;last_real_response=None
            final_texts=[];last_final_wall=None;last_reply=None;max_request=0;tail_count=0
            def consume(response,available,tail=False):
                nonlocal first_partial,last_final_wall,last_reply
                at=time.monotonic()-begin;last_reply=response
                if response.get('text') and first_partial is None:first_partial=at
                if response.get('type')=='final' and response.get('text'):
                    final_texts.append(response['text']);last_final_wall=at
                if args.events:print(json.dumps({'type':'event','audio_available_seconds':available,'wall_seconds':at,'synthetic_silence':tail,'response':response},ensure_ascii=False),flush=True)
            while True:
                raw=audio.readframes(args.chunk_ms*16)
                if not raw:break
                seen+=len(raw)//2;available=seen/16000.;sleep_until(begin+available)
                last_real_accept=time.monotonic()-begin;b=time.monotonic()
                response=client.request('feed',pcm16_base64=base64.b64encode(raw).decode())
                max_request=max(max_request,time.monotonic()-b);last_real_response=time.monotonic()-begin
                consume(response,available);chunks+=1
            endpoint=False
            if args.finish_mode=='endpoint':
                # A naturally finished segment may already have only silence
                # after it in the supplied file. Preserve its actual timestamp.
                endpoint=last_reply.get('type')=='final'
                for k in range(1,int(3000/args.chunk_ms)+1):
                    if endpoint:break
                    sleep_until(begin+duration+k*args.chunk_ms/1000.)
                    response=client.request('feed',pcm16_base64=base64.b64encode(bytes(args.chunk_ms*32)).decode())
                    tail_count+=1;consume(response,duration+k*args.chunk_ms/1000.,True)
                    if response.get('type')=='final':endpoint=True;break
            # finish releases this client/session lock and resets any remaining
            # segment. Its explicit-EOS output is never labeled an endpoint.
            terminal=client.request('finish');consume(terminal,duration,True)
            if args.finish_mode=='endpoint' and terminal.get('text'):
                # Text that appears only after explicit EOS cannot be claimed
                # as an already finalized endpoint result.
                endpoint=False
            end=time.monotonic()-begin
            print(json.dumps({'status':'PASS_PROTOCOL','input_mode':'paced_wav','finish_mode':args.finish_mode,
                'endpoint_detected':endpoint,'endpoint_timeout':args.finish_mode=='endpoint' and not endpoint,
                'final_result_kind':'endpoint' if endpoint else 'explicit_eos',
                'audio_seconds':duration,'first_partial_wall_seconds':first_partial,
                'last_real_chunk_accept_wall_seconds':last_real_accept,'last_real_chunk_response_wall_seconds':last_real_response,
                'last_text_final_wall_seconds':last_final_wall,'last_text_final_from_audio_deadline_seconds':None if last_final_wall is None else last_final_wall-duration,
                'after_last_real_chunk_accept_seconds':None if last_final_wall is None else last_final_wall-last_real_accept,
                'complete_client_wall_seconds':end,'max_chunk_request_seconds':max_request,'real_chunks':chunks,
                'paced_silence_chunks':tail_count,'model_name':client.ready['model_name'],'threads':client.ready['threads'],
                'gpu_used':False,'worker_pid':terminal['worker_pid'],'model_load_count':terminal['model_load_count'],
                'max_rss_kib':terminal.get('max_rss_kib'),'transcript':' '.join(final_texts)},ensure_ascii=False))
    except (OSError,ValueError,RuntimeError,wave.Error) as error:
        print(json.dumps({'status':'FAIL_PROTOCOL','error':str(error)},ensure_ascii=False));raise SystemExit(1)
    finally:
        if client:client.close()

if __name__=='__main__':main()

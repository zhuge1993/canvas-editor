#!/usr/bin/env python3
"""Fetch local readonly voice status, never inject speech or settings."""
import argparse
import json
import socket
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket',default='/run/dior-voice/control.sock')
    args=parser.parse_args()
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
        connection.settimeout(2);connection.connect(args.socket);connection.sendall(b'{"op":"status"}\n')
        data=bytearray()
        while b'\n' not in data:
            if len(data)>=4096:raise RuntimeError('status_limit')
            chunk=connection.recv(min(1024,4096-len(data)))
            if not chunk:raise RuntimeError('status_disconnected')
            data.extend(chunk)
        response=json.loads(bytes(data).split(b'\n',1)[0])
        print(json.dumps(response,ensure_ascii=False))
        if 'error' in response:raise SystemExit(1)
if __name__=='__main__':main()

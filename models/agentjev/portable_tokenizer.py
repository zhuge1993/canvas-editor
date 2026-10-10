"""Pure-Python Qwen byte-level BPE, checked against the pinned HF tokenizer."""
import json
from pathlib import Path
import re
import unicodedata
import heapq

CONTRACTION = re.compile(r"(?i:'s|'t|'re|'ve|'m|'ll|'d)")


def letter(char):
    return unicodedata.category(char).startswith('L')


def number(char):
    return unicodedata.category(char).startswith('N')


def pieces(text):
    i = 0
    while i < len(text):
        start = i
        match = CONTRACTION.match(text, i)
        if match:
            i += len(match[0])
        elif letter(text[i]) or (text[i] not in '\r\n' and not number(text[i]) and i+1 < len(text) and letter(text[i+1])):
            if not letter(text[i]): i += 1
            while i < len(text) and letter(text[i]): i += 1
        elif number(text[i]):
            i += 1
        else:
            j = i+1 if text[i] == ' ' else i
            while j < len(text) and not (text[j].isspace() or letter(text[j]) or number(text[j])):
                j += 1
            if j > i + (1 if text[i] == ' ' else 0):
                while j < len(text) and text[j] in '\r\n': j += 1
                i = j
            elif text[i].isspace():
                j = i
                while j < len(text) and text[j].isspace(): j += 1
                newline = max(text.rfind('\r', i, j), text.rfind('\n', i, j))
                i = newline+1 if newline >= i else j-1 if j < len(text) and j-i > 1 else j
            else:
                i += 1
        yield text[start:i]


class Tokenizer:
    def __init__(self, directory):
        config = json.loads((Path(directory)/'tokenizer.json').read_text(encoding='utf-8'))
        self.vocab = config['model']['vocab']
        merges = config['model']['merges']
        self.ranks = {tuple(pair.split(' ') if isinstance(pair, str) else pair): i for i, pair in enumerate(merges)}
        kept = list(range(ord('!'), ord('~')+1)) + list(range(161, 173)) + list(range(174, 256))
        mapped = list(kept)
        n = 0
        for byte in range(256):
            if byte not in kept:
                kept.append(byte); mapped.append(256+n); n += 1
        self.bytes = dict(zip(kept, map(chr, mapped)))
        self.special = {entry['content']: entry['id'] for entry in config.get('added_tokens', [])}
        self.pattern = re.compile('('+'|'.join(re.escape(word) for word in sorted(self.special, key=len, reverse=True))+')') if self.special else None

    def encode(self, text, add_special_tokens=False):
        if add_special_tokens:
            raise ValueError('decision tokenization never adds implicit special tokens')
        text = unicodedata.normalize('NFC', text)
        out = []
        for block in self.pattern.split(text) if self.pattern else [text]:
            if block in self.special:
                out.append(self.special[block]); continue
            for piece in pieces(block):
                symbols = [self.bytes[byte] for byte in piece.encode('utf-8')]
                n = len(symbols)
                previous = list(range(-1,n-1)); following = list(range(1,n))+[-1]
                versions = [0]*n; alive = [True]*n; heap=[]
                def enqueue(left):
                    if left < 0 or following[left] < 0: return
                    right = following[left]
                    rank = self.ranks.get((symbols[left],symbols[right]))
                    if rank is not None: heapq.heappush(heap,(rank,left,right,versions[left],versions[right]))
                for index in range(n-1): enqueue(index)
                while heap:
                    _,left,right,lv,rv=heapq.heappop(heap)
                    if not alive[left] or not alive[right] or following[left]!=right or versions[left]!=lv or versions[right]!=rv: continue
                    symbols[left]+=symbols[right]; versions[left]+=1; alive[right]=False
                    following[left]=following[right]
                    if following[right]>=0: previous[following[right]]=left
                    enqueue(previous[left]); enqueue(left)
                out.extend(self.vocab[symbols[index]] for index in range(n) if alive[index])
        return out

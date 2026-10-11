from pathlib import Path
import random
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tokenizer import Tokenizer
from transformers import AutoTokenizer
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--assets',type=Path,required=True)
root=parser.parse_args().assets
native=Tokenizer(root);ref=AutoTokenizer.from_pretrained(root,local_files_only=True)
texts=['保存画布后图形消失。','Hello WORLD café ÉlÉPHANT','[CLS]你好[MASK]！[SEP]','é́ñ中🙂👨‍👩‍👧‍👦１２٣Ⅳ','  a\r\nb\t\x00c\u200d','你好①②\u3000世界']
random.seed(17);chars='工作你好中ABCxyz 123\t\n\r🙂。！é́\u200d\u3000'
texts+=[''.join(random.choice(chars) for _ in range(random.randrange(1,70))) for _ in range(500)]
for text in texts:
 got=native.encode(text,limit=512);want=ref.encode(text,add_special_tokens=True)
 if got!=want:raise AssertionError((repr(text),got,want))
print('PASS BERT tokenizer parity:',len(texts))

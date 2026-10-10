"""Compare stdlib phone tokenization against the pinned HF assets."""
import argparse
from pathlib import Path
import random
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from portable_tokenizer import Tokenizer
from transformers import AutoTokenizer

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--assets',type=Path,required=True)
args=parser.parse_args()
native=Tokenizer(args.assets)
reference=AutoTokenizer.from_pretrained(args.assets,local_files_only=True)
samples=['保存画布后新增的图形消失了。','[STATE] 用户想调小声音\n[QUESTION] 属于哪个类别？\n[CANDIDATE] 调整音量',"I'm not sure. It's 1234567.", '  \t你好\r\n  abc  ','é́ñ中文🙂👨‍👩‍👧‍👦１２٣Ⅳ', '<|im_start|>user\n你好<|im_end|>']
random.seed(7)
alphabet='中英文你好工作0123456789ABCxyz \t\n\r🙂！。é́\u3000\u200d'
samples.extend(''.join(random.choice(alphabet) for _ in range(random.randrange(1,200))) for _ in range(500))
for text in samples:
    got=native.encode(text)
    want=reference.encode(text,add_special_tokens=False)
    if got!=want:raise AssertionError((repr(text),got,want))
print('PASS tokenizer parity:',len(samples),'texts')

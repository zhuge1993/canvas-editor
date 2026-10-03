#!/usr/bin/env python3
"""Compile complete Chinese wake words into official-model ppinyin tokens."""
import argparse
import json
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
sys.path.insert(0,str(HERE/'pypinyin-vendor'))
from pypinyin import pinyin,Style

def compile_keyword(word,tokens_path,*,score=1.5,threshold=.35):
    if not isinstance(word,str) or not 2<=len(word)<=8 or any(not '\u4e00'<=ch<='\u9fff' for ch in word):
        raise ValueError('Wake keyword must be a complete2..8character Chinese phrase; single 二 is rejected')
    if not .1<=score<=5 or not .1<=threshold<=.95:raise ValueError('bounded acoustic score/threshold required')
    tokens={line.rsplit(' ',1)[0] for line in Path(tokens_path).read_text(encoding='utf8').splitlines() if line.strip()}
    initials=pinyin(word,style=Style.INITIALS,strict=False,errors='exception')
    finals=pinyin(word,style=Style.FINALS_TONE,strict=False,errors='exception')
    sequence=[]
    for initial,final in zip(initials,finals):
        sequence.extend(piece for piece in (initial[0],final[0]) if piece)
    if not sequence or any(piece not in tokens for piece in sequence):raise ValueError('Keyword has unsupported model phoneme')
    return ' '.join(sequence)+' :'+format(score,'.6g')+' #'+format(threshold,'.6g')+' @'+word

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('keyword');p.add_argument('--tokens',type=Path,default=HERE/'model-small/tokens.txt')
    p.add_argument('--score',type=float,default=1.5);p.add_argument('--threshold',type=float,default=.35)
    p.add_argument('--output',type=Path);p.add_argument('--json',action='store_true')
    a=p.parse_args();line=compile_keyword(a.keyword,a.tokens,score=a.score,threshold=a.threshold)
    if a.output:a.output.write_text(line+'\n',encoding='utf8')
    print(json.dumps({'keyword':a.keyword,'keywords_string':line,'phoneme_tokens':line.split(' :',1)[0].split(),
                      'single_character_alias_allowed':False,'phonetic_homophones_can_not_be_distinguished':True},ensure_ascii=False) if a.json else line)

if __name__=='__main__':main()

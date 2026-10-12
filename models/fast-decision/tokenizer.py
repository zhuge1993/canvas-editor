"""Bounded BERT Chinese WordPiece tokenizer, stdlib only."""
from pathlib import Path
import re
import unicodedata


def chinese(cp):
    return any(a<=cp<=b for a,b in [(0x4e00,0x9fff),(0x3400,0x4dbf),(0x20000,0x2a6df),(0x2a700,0x2b73f),(0x2b740,0x2b81f),(0x2b820,0x2ceaf),(0xf900,0xfaff),(0x2f800,0x2fa1f)])


class Tokenizer:
    def __init__(self,assets):
        # The vocabulary itself contains Unicode U+2028. splitlines() would
        # treat that token as a delimiter and shift every subsequent token ID.
        self.vocab={word.rstrip('\r'):i for i,word in enumerate((Path(assets)/'vocab.txt').read_text(encoding='utf-8').split('\n')[:-1])}
        self.special={key:self.vocab[key] for key in ['[UNK]','[SEP]','[PAD]','[CLS]','[MASK]']}
        self.special_pattern=re.compile('('+ '|'.join(re.escape(key) for key in self.special)+')')

    def encode(self,text,limit=128):
        if not isinstance(text,str) or len(text)>4096:raise ValueError('text exceeds tokenizer bounds')
        ids=[self.special['[CLS]']]
        for part in self.special_pattern.split(text):
            if part in self.special:ids.append(self.special[part]);continue
            cleaned=''
            for c in part:
                cp=ord(c);cat=unicodedata.category(c)
                if cp in [0,0xfffd] or (cat.startswith('C') and c not in '\t\n\r'):continue
                if c.isspace():cleaned+=' '
                elif chinese(cp):cleaned+=' '+c+' '
                else:cleaned+=c
            for token in cleaned.split():
                # Pinned BGE tokenizer uses do_lower_case=false and does not
                # strip accents. Preserve text exactly after basic cleaning.
                pieces=[];current=''
                for c in token:
                    cp=ord(c)
                    if (33<=cp<=47 or 58<=cp<=64 or 91<=cp<=96 or 123<=cp<=126 or unicodedata.category(c).startswith('P')):
                        if current:pieces.append(current);current=''
                        pieces.append(c)
                    else:current+=c
                if current:pieces.append(current)
                for piece in pieces:
                    words=[];start=0
                    if len(piece)>100:words=[self.special['[UNK]']]
                    else:
                        while start<len(piece):
                            end=len(piece);match=None
                            while end>start:
                                fragment=('##' if start else '')+piece[start:end]
                                if fragment in self.vocab:match=self.vocab[fragment];break
                                end-=1
                            if match is None:words=[self.special['[UNK]']];break
                            words.append(match);start=end
                    ids.extend(words)
        ids.append(self.special['[SEP]'])
        if len(ids)>limit:raise ValueError('input too long; shorten text, nothing was truncated')
        return ids

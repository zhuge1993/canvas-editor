"""Small atomic wake-word setting; never stores recordings or transcripts."""
import json
import os
from pathlib import Path
import re
import stat
import uuid

DEFAULT_WAKE='二狗'
def validate_wake(value):
    if not isinstance(value,str) or len(value.encode('utf8'))>48:
        raise ValueError('invalid_wake_word')
    value=value.strip()
    if not re.fullmatch(r'[\u3400-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9]{1,15}',value):
        raise ValueError('wake_word_requires2to8ChineseOr2to16AsciiLettersDigits')
    return value

class Settings:
    def __init__(self,path):
        self.path=Path(path);self.wake_word=DEFAULT_WAKE;self.load_error=False
        if self.path.exists():
            try:
                info=self.path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_size>1024:raise ValueError('invalid_settings_file')
                record=json.loads(self.path.read_text(encoding='utf8'))
                if not isinstance(record,dict) or set(record)!={'version','wake_word'} or type(record['version']) is not int or record['version']!=1:raise ValueError('invalid_settings_schema')
                self.wake_word=validate_wake(record['wake_word'])
            except (OSError,ValueError,UnicodeError):self.load_error=True

    def save_wake(self,value):
        value=validate_wake(value)
        data=(json.dumps({'version':1,'wake_word':value},ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(data)>1024:raise ValueError('settings_limit')
        self.path.parent.mkdir(parents=True,exist_ok=True)
        temp=self.path.with_name('.'+self.path.name+'.'+uuid.uuid4().hex+'.tmp')
        try:
            fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,getattr(stat,'S_IRUSR',256)|getattr(stat,'S_IWUSR',128))
            with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
            if self.path.exists() and not stat.S_ISREG(self.path.lstat().st_mode):raise ValueError('refuse_settings_link')
            os.replace(temp,self.path)
            if os.name!='nt':
                directory=os.open(self.path.parent,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(directory)
                finally:os.close(directory)
            self.wake_word=value;self.load_error=False
        finally:
            if temp.exists():temp.unlink()

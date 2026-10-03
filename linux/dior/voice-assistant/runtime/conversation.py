"""Bounded in-memory conversation ownership, separate from inference and playback.

No file, network, model, mixer or tool is executed here. A model result is only
a candidate: the caller must report successful *actual playback* to commit it.
Token counters, when supplied, must be local pure functions and count the real
model template (including tools). The default UTF-8 proxy is conservative, not
a claim of exact tokenization for every model.
"""
from collections import deque
from dataclasses import dataclass,field
import copy
import json
import math
from types import MappingProxyType
import threading
import uuid

from settings import DEFAULT_WAKE,validate_wake

DEFAULT_INSTRUCTIONS='你是手机上的中文语音助手。自然、简洁地交流，不声称已执行未经工具确认的操作。'
_MAX_RESULT_BYTES=2048
_TOOL_NAMES=frozenset(('set_volume','get_time','get_status','search','propose_wake_word'))


class ToolValidationError(ValueError):pass
class ConversationBudgetError(ValueError):pass
class StaleTurnError(ValueError):pass
class ToolContextError(ValueError):pass


def _text(value,limit,*,single_line=False):
    if not isinstance(value,str) or not value.strip() or len(value)>limit:
        raise ValueError('bounded_nonempty_text_required')
    if any(ord(ch)<32 and ch not in ('\n','\t') for ch in value):raise ValueError('invalid_text_control')
    if single_line and any(ord(ch)<32 for ch in value):raise ValueError('single_line_text_required')
    value.encode('utf-8',errors='strict')
    return value.strip()


def _json(value):
    return json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':'))


def _arguments(name,args):
    if name not in _TOOL_NAMES or type(args) is not dict:raise ToolValidationError('unknown_tool_or_arguments')
    if name=='set_volume':
        if set(args)!={'percent'} or type(args['percent']) is not int or not 0<=args['percent']<=100:
            raise ToolValidationError('volume_requires_integer0to100')
        return {'percent':args['percent']}
    if name in ('get_time','get_status'):
        if args:raise ToolValidationError('tool_takes_no_arguments')
        return {}
    key='query' if name=='search' else 'name'
    if set(args)!={key}:raise ToolValidationError('unexpected_tool_arguments')
    try:
        value=_text(args[key],120 if name=='search' else 48,single_line=True)
        if name=='propose_wake_word':value=validate_wake(value)
    except (ValueError,UnicodeError) as error:raise ToolValidationError('invalid_tool_text') from error
    return {key:value}


@dataclass(frozen=True)
class ToolProposal:
    name:str
    arguments:dict
    requires_confirmation:bool=field(init=False)
    def __post_init__(self):
        if type(self.name) is not str:raise ToolValidationError('tool_name_required')
        args=_arguments(self.name,self.arguments)
        object.__setattr__(self,'arguments',MappingProxyType(args))
        object.__setattr__(self,'requires_confirmation',self.name=='propose_wake_word')
    def as_payload(self):return {'name':self.name,'arguments':dict(self.arguments)}


def validate_tool_proposal(value):
    """Validate a proposal only; the model cannot authorize or execute an action."""
    if isinstance(value,ToolProposal):value=value.as_payload()
    if isinstance(value,str):
        try:size=len(value.encode('utf-8'))
        except UnicodeError as error:raise ToolValidationError('invalid_proposal_utf8') from error
        if size>2048:raise ToolValidationError('proposal_size_limit')
        def unique(pairs):
            result={}
            for key,item in pairs:
                if key in result:raise ToolValidationError('duplicate_json_key')
                result[key]=item
            return result
        try:value=json.loads(value,object_pairs_hook=unique)
        except (ValueError,RecursionError) as error:raise ToolValidationError('invalid_proposal_json') from error
    if type(value) is not dict or set(value)!={'name','arguments'}:
        raise ToolValidationError('proposal_schema')
    return ToolProposal(value['name'],value['arguments'])


def tool_definitions():
    """OpenAI-compatible finite tool schemas; callers must use a supported template."""
    definitions=[]
    for name in ('set_volume','get_time','get_status','search','propose_wake_word'):
        properties={};required=[]
        if name=='set_volume':properties={'percent':{'type':'integer','minimum':0,'maximum':100}};required=['percent']
        elif name=='search':properties={'query':{'type':'string','minLength':1,'maxLength':120}};required=['query']
        elif name=='propose_wake_word':
            properties={'name':{'type':'string','minLength':2,'maxLength':16,
                'pattern':r'^(?:[\u3400-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9]{1,15})$'}};required=['name']
        description={
            'set_volume':'设置手机扬声器音量，百分比0到100。',
            'get_time':'读取手机当前时间。',
            'get_status':'读取手机和助手实际状态。',
            'search':'联网查询，返回实际来源。',
            'propose_wake_word':'提出修改唤醒词；必须等待用户确认，不能立即改名。',
        }[name]
        definitions.append({'type':'function','function':{'name':name,'description':description,'strict':True,
            'parameters':{'type':'object','properties':properties,'required':required,'additionalProperties':False}}})
    return definitions


def _result(value):
    if type(value) is not dict or set(value)!={'ok','data'} or type(value['ok']) is not bool or type(value['data']) is not dict:
        raise ToolValidationError('result_requires_ok_bool_and_data_object')
    count=[0]
    def check(item,depth=0):
        count[0]+=1
        if depth>4 or count[0]>128:raise ToolValidationError('result_structure_limit')
        if item is None or type(item) is bool:return
        if type(item) is int:
            if not -(2**63)<=item<2**63:raise ToolValidationError('result_integer_limit')
            return
        if type(item) is float:
            if not math.isfinite(item):raise ToolValidationError('result_nonfinite_number')
            return
        if type(item) is str:
            if len(item)>1024 or any(ord(ch)<32 and ch not in ('\n','\t') for ch in item):raise ToolValidationError('result_text_limit')
            item.encode('utf-8');return
        if type(item) is list:
            if len(item)>16:raise ToolValidationError('result_array_limit')
            for child in item:check(child,depth+1)
            return
        if type(item) is dict:
            if len(item)>32:raise ToolValidationError('result_object_limit')
            for key,child in item.items():
                if type(key) is not str or not 0<len(key)<=64 or any(ord(ch)<32 for ch in key):raise ToolValidationError('result_key_limit')
                check(child,depth+1)
            return
        raise ToolValidationError('result_must_be_json_data')
    check(value)
    encoded=_json(value)
    if len(encoded.encode('utf-8'))>_MAX_RESULT_BYTES:raise ToolValidationError('result_byte_limit')
    return json.loads(encoded)


@dataclass(frozen=True)
class ContextBudget:
    max_context_chars:int=4096
    max_context_bytes:int=8192
    max_context_tokens:int=1024
    output_reserve_tokens:int=128
    max_message_chars:int=1024
    max_history_turns:int=5
    max_messages:int=12
    max_tools_per_turn:int=4
    def __post_init__(self):
        ranges={'max_context_chars':(256,32768),'max_context_bytes':(256,65536),
                'max_context_tokens':(128,8192),'output_reserve_tokens':(0,1024),
                'max_message_chars':(1,8192),'max_history_turns':(0,32),
                'max_messages':(2,128),'max_tools_per_turn':(0,8)}
        for key,(low,high) in ranges.items():
            value=getattr(self,key)
            if type(value) is not int or not low<=value<=high:raise ValueError('invalid_budget_'+key)
        if self.output_reserve_tokens>=self.max_context_tokens or self.max_message_chars>self.max_context_chars:
            raise ValueError('invalid_budget_relationship')


@dataclass(frozen=True)
class TurnTicket:
    epoch:int
    turn_id:int


@dataclass
class _Turn:
    ticket:TurnTicket
    messages:list
    candidate:str=None
    tool_count:int=0


class Conversation:
    def __init__(self,*,wake_word=DEFAULT_WAKE,instructions=DEFAULT_INSTRUCTIONS,budget=None,token_counter=None):
        self._wake_word=validate_wake(wake_word);self.instructions=_text(instructions,1024)
        self.budget=budget or ContextBudget()
        if not isinstance(self.budget,ContextBudget):raise TypeError('ContextBudget_required')
        if token_counter is not None and not callable(token_counter):raise TypeError('local_token_counter_required')
        self.token_counter=token_counter;self._lock=threading.RLock();self._history=deque();self._active=None
        self._epoch=1;self._turn_id=0;self.session_id=uuid.uuid4().hex
        if not self._fits([self._system()]):raise ConversationBudgetError('system_exceeds_context_budget')

    @property
    def wake_word(self):
        with self._lock:return self._wake_word

    def _system(self):
        return {'role':'system','content':self.instructions+'\n当前助手名和唤醒词：'+self._wake_word+'。'}

    def _fits(self,messages):
        encoded=_json(messages);budget=self.budget
        if len(messages)>budget.max_messages or len(encoded)>budget.max_context_chars or len(encoded.encode('utf-8'))>budget.max_context_bytes:return False
        if self.token_counter is None:tokens=len(encoded.encode('utf-8'))+16*len(messages)
        else:
            tokens=self.token_counter(copy.deepcopy(messages))
            if type(tokens) is not int or tokens<0:raise ValueError('invalid_token_counter_result')
        return tokens<=budget.max_context_tokens-budget.output_reserve_tokens

    def _all(self):
        messages=[self._system()]
        for turn in self._history:messages.extend(turn)
        if self._active:messages.extend(self._active.messages)
        return messages

    def _trim(self):
        while len(self._history)>self.budget.max_history_turns:self._history.popleft()
        while self._history and not self._fits(self._all()):self._history.popleft()
        if not self._fits(self._all()):raise ConversationBudgetError('active_turn_exceeds_context_budget')

    def _current(self,ticket):
        return type(ticket) is TurnTicket and self._active is not None and ticket==self._active.ticket

    def _discard_active(self):
        # Actual executed tool facts survive a cancelled spoken response.
        # An ordinary unanswered input and an unheard candidate are discarded.
        if self._active and self._active.tool_count:self._history.append(copy.deepcopy(self._active.messages))
        self._active=None;self._trim()

    def begin_user(self,text):
        text=_text(text,self.budget.max_message_chars)
        with self._lock:
            user={'role':'user','content':text}
            if not self._fits([self._system(),user]):raise ConversationBudgetError('user_exceeds_context_budget')
            self._discard_active();self._turn_id+=1
            ticket=TurnTicket(self._epoch,self._turn_id);self._active=_Turn(ticket,[user]);self._trim()
            return ticket

    def messages(self,ticket=None):
        with self._lock:
            if ticket is not None and not self._current(ticket):raise StaleTurnError('stale_turn')
            self._trim();return copy.deepcopy(self._all())

    def simple_chat_messages(self,ticket):
        """Strict first-probe template. Never hide or relabel actual tool facts."""
        messages=self.messages(ticket)
        expected='user'
        for message in messages[1:]:
            if set(message)!={'role','content'} or message['role']!=expected or not isinstance(message['content'],str):
                raise ToolContextError('requires_official_tool_chat_template')
            expected='assistant' if expected=='user' else 'user'
        if expected!='assistant':raise ToolContextError('simple_chat_must_end_with_user')
        return messages

    def model_completed(self,ticket,text):
        text=_text(text,self.budget.max_message_chars)
        with self._lock:
            if not self._current(ticket) or self._active.candidate is not None:return False
            self._active.candidate=text;return True

    def playback_completed(self,ticket,*,succeeded=True):
        if type(succeeded) is not bool:raise TypeError('playback_success_bool_required')
        with self._lock:
            if not self._current(ticket):return False
            if not succeeded:self._discard_active();return False
            if self._active.candidate is None:return False
            complete=copy.deepcopy(self._active.messages)
            complete.append({'role':'assistant','content':self._active.candidate})
            self._history.append(complete);self._active=None;self._trim();return True

    def cancel(self,ticket):
        with self._lock:
            if not self._current(ticket):return False
            self._discard_active();return True

    def clear(self):
        with self._lock:self._epoch+=1;self._active=None;self._history.clear()

    def set_wake_word(self,value):
        value=validate_wake(value)
        with self._lock:
            previous=self._wake_word;self._wake_word=value
            if not self._fits([self._system()]):
                self._wake_word=previous;raise ConversationBudgetError('identity_exceeds_context_budget')
            self._discard_active();self._epoch+=1;self._trim()

    def record_tool_result(self,ticket,proposal,result,*,confirmed=False):
        """Caller supplies a real executor receipt. No operation is performed here.

        Proposal validation does not authorize execution. Wake-word changes need
        an explicit trusted confirmation; the caller still validates KWS and
        persists the real setting before calling set_wake_word.
        """
        proposal=validate_tool_proposal(proposal);result=_result(result)
        if type(confirmed) is not bool:raise ToolValidationError('confirmation_bool_required')
        if proposal.requires_confirmation and not confirmed:raise ToolValidationError('wake_change_requires_confirmation')
        with self._lock:
            if not self._current(ticket) or self._active.candidate is not None:return False
            if self._active.tool_count>=self.budget.max_tools_per_turn:raise ToolValidationError('tool_count_limit')
            ident='call_%d_%d_%d'%(ticket.epoch,ticket.turn_id,self._active.tool_count+1)
            pair=[{'role':'assistant','content':None,'tool_calls':[{'id':ident,'type':'function','function':{
                'name':proposal.name,'arguments':_json(dict(proposal.arguments))}}]},
                {'role':'tool','tool_call_id':ident,'content':_json(result)}]
            if not self._fits([self._system()]+self._active.messages+pair):raise ConversationBudgetError('tool_result_exceeds_context_budget')
            self._active.messages.extend(pair);self._active.tool_count+=1;self._trim();return True

    def status(self):
        with self._lock:
            return {'session_id':self.session_id,'session_epoch':self._epoch,'turn_id':self._turn_id,
                'wake_word':self._wake_word,'active_turn_id':self._active.ticket.turn_id if self._active else None,
                'candidate_pending_playback':bool(self._active and self._active.candidate is not None),
                'history_turns':len(self._history),'history_messages':sum(len(turn) for turn in self._history),
                'token_count_mode':'local_tokenizer' if self.token_counter else 'conservative_utf8_estimate',
                'recording_or_transcript_files':False}

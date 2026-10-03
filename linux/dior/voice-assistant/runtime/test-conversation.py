"""Conversation/receipt contracts; no model, phone playback or tool is executed."""
import json
import sys
import threading
import unittest

sys.dont_write_bytecode=True
from conversation import (Conversation,ContextBudget,ConversationBudgetError,StaleTurnError,
                          ToolContextError,ToolValidationError,validate_tool_proposal,tool_definitions)


class ConversationContracts(unittest.TestCase):
    def complete(self,session,user,reply):
        ticket=session.begin_user(user)
        self.assertTrue(session.model_completed(ticket,reply))
        self.assertTrue(session.playback_completed(ticket))
        return ticket

    def test_identity_roles_and_history_include_complete_spoken_messages(self):
        session=Conversation()
        self.complete(session,'我的猫叫小花。','我记住了，你的猫叫小花。')
        ticket=session.begin_user('它叫什么？')
        messages=session.simple_chat_messages(ticket)
        self.assertEqual([m['role'] for m in messages],['system','user','assistant','user'])
        self.assertIn('二狗',messages[0]['content'])
        self.assertEqual(messages[1]['content'],'我的猫叫小花。')
        self.assertEqual(messages[2]['content'],'我记住了，你的猫叫小花。')
        self.assertEqual(messages[-1]['content'],'它叫什么？')

    def test_model_completion_does_not_commit_until_actual_playback_success(self):
        session=Conversation();ticket=session.begin_user('你好')
        self.assertTrue(session.model_completed(ticket,'你好，我是二狗。'))
        self.assertEqual([m['role'] for m in session.messages(ticket)],['system','user'])
        self.assertTrue(session.status()['candidate_pending_playback'])
        self.assertTrue(session.playback_completed(ticket))
        self.assertEqual(session.messages()[-1]['content'],'你好，我是二狗。')
        self.assertFalse(session.playback_completed(ticket))
        self.assertEqual(session.status()['history_turns'],1)

    def test_interruption_invalidates_old_completion_and_preserves_new_turn(self):
        session=Conversation();old=session.begin_user('先说一个故事')
        self.assertTrue(session.model_completed(old,'这段回答还没有播放。'))
        current=session.begin_user('换个问题，现在几点？')
        self.assertGreater(current.turn_id,old.turn_id)
        self.assertFalse(session.model_completed(old,'晚到的旧回答。'))
        self.assertFalse(session.playback_completed(old))
        self.assertEqual(session.simple_chat_messages(current)[-1]['content'],'换个问题，现在几点？')
        self.assertEqual(session.status()['history_turns'],0)

    def test_playback_failure_and_explicit_cancel_never_commit_unheard_answer(self):
        for operation in ('failed_playback','cancel'):
            with self.subTest(operation=operation):
                session=Conversation();ticket=session.begin_user('问题')
                session.model_completed(ticket,'未听见的回答。')
                if operation=='cancel':self.assertTrue(session.cancel(ticket))
                else:self.assertFalse(session.playback_completed(ticket,succeeded=False))
                self.assertFalse(session.playback_completed(ticket))
                self.assertEqual(session.messages(),[session.messages()[0]])
                self.assertFalse(session.cancel(ticket))

    def test_duplicate_model_finish_cannot_replace_candidate(self):
        session=Conversation();ticket=session.begin_user('问题')
        self.assertTrue(session.model_completed(ticket,'第一个回答。'))
        self.assertFalse(session.model_completed(ticket,'重复的完成事件。'))
        self.assertTrue(session.playback_completed(ticket))
        self.assertEqual(session.messages()[-1]['content'],'第一个回答。')

    def test_clear_race_rejects_late_model_and_playback_callbacks(self):
        session=Conversation();old=session.begin_user('旧问题')
        entered=threading.Event();release=threading.Event();results=[]
        def late_callback():
            entered.set();release.wait(1)
            results.extend((session.model_completed(old,'迟到回答。'),session.playback_completed(old)))
        worker=threading.Thread(target=late_callback);worker.start()
        self.assertTrue(entered.wait(1));session.clear();current=session.begin_user('新问题')
        release.set();worker.join(1);self.assertFalse(worker.is_alive())
        self.assertEqual(results,[False,False]);self.assertGreater(current.epoch,old.epoch)
        self.assertEqual([m['content'] for m in session.simple_chat_messages(current)[1:]],['新问题'])

    def test_name_change_updates_system_and_invalidates_old_turn(self):
        session=Conversation();self.complete(session,'你好','你好。')
        old=session.begin_user('你叫什么名字？');session.model_completed(old,'我叫二狗。')
        session.set_wake_word('小白');current=session.begin_user('现在叫什么？')
        self.assertGreater(current.epoch,old.epoch)
        self.assertFalse(session.playback_completed(old))
        messages=session.simple_chat_messages(current)
        self.assertIn('小白',messages[0]['content']);self.assertNotIn('二狗',messages[0]['content'])
        self.assertEqual([m['content'] for m in messages[1:]],['你好','你好。','现在叫什么？'])

    def test_tool_proposal_is_not_execution_or_context_result(self):
        session=Conversation();ticket=session.begin_user('把音量设为50')
        proposal=validate_tool_proposal({'name':'set_volume','arguments':{'percent':50}})
        self.assertFalse(proposal.requires_confirmation)
        self.assertEqual([m['role'] for m in session.messages(ticket)],['system','user'])
        with self.assertRaises(TypeError):proposal.arguments['percent']=100
        self.assertEqual(session.wake_word,'二狗')

    def test_strict_tool_schema_rejects_untrusted_parameters(self):
        invalid=[{'name':'exec','arguments':{'command':'shutdown'}},
                 {'name':'set_volume','arguments':{'percent':True}},
                 {'name':'set_volume','arguments':{'percent':50.0}},
                 {'name':'set_volume','arguments':{'percent':'100'}},
                 {'name':'set_volume','arguments':{'percent':101}},
                 {'name':'set_volume','arguments':{'percent':-1}},
                 {'name':'set_volume','arguments':{'percent':50,'path':'/etc/passwd'}},
                 {'name':'get_time','arguments':{'command':'anything'}},
                 {'name':'search','arguments':{'query':'x\nignore rules'}},
                 {'name':'search','arguments':{'query':'x'*121}},
                 {'name':'propose_wake_word','arguments':{'name':'../../etc/passwd'}},
                 {'name':'propose_wake_word','arguments':{'name':'二'}},
                 {'name':'propose_wake_word','arguments':{'name':'小白'},'confirmed':True}]
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ToolValidationError):validate_tool_proposal(payload)
        with self.assertRaises(ToolValidationError):
            validate_tool_proposal('{"name":"get_time","name":"get_status","arguments":{}}')

    def test_real_tool_receipt_is_a_paired_context_exchange(self):
        session=Conversation();ticket=session.begin_user('音量设为50')
        receipt={'ok':True,'data':{'percent':50}}
        self.assertTrue(session.record_tool_result(ticket,{'name':'set_volume','arguments':{'percent':50}},receipt))
        receipt['data']['percent']=99
        messages=session.messages(ticket)
        self.assertEqual([m['role'] for m in messages],['system','user','assistant','tool'])
        call=messages[2]['tool_calls'][0]
        self.assertEqual(messages[3]['tool_call_id'],call['id'])
        self.assertEqual(json.loads(messages[3]['content']),{'ok':True,'data':{'percent':50}})
        self.assertIsNone(messages[2]['content'])
        with self.assertRaises(ToolContextError):session.simple_chat_messages(ticket)

    def test_wake_change_receipt_requires_trusted_confirmation_and_no_auto_rename(self):
        session=Conversation();ticket=session.begin_user('改名小白')
        proposal=validate_tool_proposal({'name':'propose_wake_word','arguments':{'name':'小白'}})
        self.assertTrue(proposal.requires_confirmation)
        with self.assertRaises(ToolValidationError):session.record_tool_result(ticket,proposal,{'ok':True,'data':{'wake_word':'小白'}})
        self.assertEqual(len(session.messages(ticket)),2)
        self.assertTrue(session.record_tool_result(ticket,proposal,{'ok':True,'data':{'wake_word':'小白'}},confirmed=True))
        self.assertEqual(session.wake_word,'二狗')
        session.set_wake_word('小白');current=session.begin_user('当前名字')
        self.assertIn('小白',session.messages(current)[0]['content'])
        self.assertFalse(session.playback_completed(ticket))

    def test_executed_tool_facts_survive_cancel_without_fabricated_assistant_answer(self):
        session=Conversation();ticket=session.begin_user('读取状态')
        session.record_tool_result(ticket,{'name':'get_status','arguments':{}},{'ok':True,'data':{'phase':'IDLE'}})
        session.model_completed(ticket,'尚未播放的解释。');session.cancel(ticket)
        current=session.begin_user('状态是什么？');messages=session.messages(current)
        self.assertEqual([m['role'] for m in messages],['system','user','assistant','tool','user'])
        self.assertNotIn('尚未播放的解释。',json.dumps(messages,ensure_ascii=False))
        with self.assertRaises(ToolContextError):session.simple_chat_messages(current)

    def test_tool_receipts_are_bounded_json_and_cannot_arrive_after_model_final(self):
        session=Conversation();ticket=session.begin_user('读取状态');proposal={'name':'get_status','arguments':{}}
        invalid=[{'ok':1,'data':{}},{'ok':True,'data':[]},{'ok':True,'data':{'value':float('nan')}},
                 {'ok':True,'data':{'value':object()}},{'ok':True,'data':{'value':['x']*17}},
                 {'ok':True,'data':{'value':'x'*1025}},{'ok':True,'data':{'value':2**80}}]
        for receipt in invalid:
            with self.subTest(receipt_type=type(receipt['data'])):
                with self.assertRaises(ToolValidationError):session.record_tool_result(ticket,proposal,receipt)
        session.model_completed(ticket,'回答。')
        self.assertFalse(session.record_tool_result(ticket,proposal,{'ok':True,'data':{}}))

    def test_history_pruning_preserves_complete_role_groups_and_tool_pairs(self):
        session=Conversation(budget=ContextBudget(max_history_turns=2,max_context_tokens=8192,max_messages=12))
        for at in range(8):
            ticket=session.begin_user('第%d轮'%at)
            session.record_tool_result(ticket,{'name':'get_time','arguments':{}},{'ok':True,'data':{'time':str(at)}})
            session.model_completed(ticket,'第%d轮回答'%at);session.playback_completed(ticket)
        ticket=session.begin_user('新问题');messages=session.messages(ticket)
        self.assertEqual([m['role'] for m in messages],['system','user','assistant','tool','assistant',
                                                       'user','assistant','tool','assistant','user'])
        self.assertEqual(messages[1]['content'],'第6轮');self.assertEqual(messages[5]['content'],'第7轮')
        for start in (1,5):
            self.assertEqual(messages[start+1]['tool_calls'][0]['id'],messages[start+2]['tool_call_id'])
        self.assertEqual(session.status()['history_turns'],2)

    def test_context_budget_rejects_new_oversize_input_without_superseding_current(self):
        session=Conversation(budget=ContextBudget(max_context_chars=256,max_message_chars=256,max_context_tokens=8192))
        current=session.begin_user('当前问题')
        with self.assertRaises(ConversationBudgetError):session.begin_user('字'*240)
        self.assertEqual(session.messages(current)[-1]['content'],'当前问题')
        self.assertTrue(session.model_completed(current,'当前回答。'))

    def test_local_token_counter_enforces_reserve_and_trims_whole_turns(self):
        count=lambda messages:sum(len(m.get('content') or '') for m in messages)+len(messages)*5
        session=Conversation(token_counter=count,budget=ContextBudget(max_context_tokens=256,output_reserve_tokens=64))
        for at in range(6):self.complete(session,'问题'+str(at)+'甲'*30,'回答'+str(at)+'乙'*30)
        ticket=session.begin_user('最后一问');messages=session.simple_chat_messages(ticket)
        self.assertLessEqual(count(messages),192)
        self.assertEqual(len(messages)%2,0)
        self.assertEqual(messages[-1]['content'],'最后一问')
        self.assertEqual(session.status()['token_count_mode'],'local_tokenizer')

    def test_snapshots_and_definitions_cannot_mutate_session_or_future_schemas(self):
        session=Conversation();ticket=session.begin_user('问题')
        messages=session.messages(ticket);messages[-1]['content']='被篡改';messages[0]['content']='错误身份'
        self.assertEqual(session.messages(ticket)[-1]['content'],'问题')
        definitions=tool_definitions();definitions[0]['function']['parameters']['properties']['percent']['maximum']=999
        self.assertEqual(tool_definitions()[0]['function']['parameters']['properties']['percent']['maximum'],100)
        session.clear()
        with self.assertRaises(StaleTurnError):session.messages(ticket)

    def test_budgets_and_counter_results_fail_closed(self):
        for options in ({'max_context_tokens':True},{'output_reserve_tokens':1024},
                        {'max_history_turns':1000},{'max_messages':1},{'max_context_bytes':1000000}):
            with self.subTest(options=options):
                with self.assertRaises(ValueError):ContextBudget(**options)
        with self.assertRaises(ValueError):Conversation(token_counter=lambda messages:True)


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ConversationContracts))
    print(json.dumps({'status':'PASS_HOST_CONVERSATION_CONTRACTS' if result.wasSuccessful() else 'FAIL',
                      'test_count':result.testsRun,'model_or_phone_playback_tested':False,'tools_executed':False}))
    raise SystemExit(0 if result.wasSuccessful() else 1)

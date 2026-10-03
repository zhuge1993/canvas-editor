"""Observed nickname ASR homophone must still require explicit confirmation."""
import tempfile,unittest
from pathlib import Path
from assistant import Assistant
from settings import Settings
from skills import parse_intent
from test_contracts import Audio as FakeAudio,ASR as FakeASR,TTS as FakeTTS

class RenameCompatibility(unittest.TestCase):
    def test_observed_nickname_can_propose(self):
        self.assertEqual(parse_intent('以后教你小白').kind,'change_wake_word')
        self.assertEqual(parse_intent('以后教你小白').value,'小白')
    def test_teaching_requests_stay_chat(self):
        for text in ('以后教你做饭','以后教你数学','教你小白','以后教你小'):
            self.assertEqual(parse_intent(text).kind,'chat')
    def test_no_unconfirmed_save(self):
        with tempfile.TemporaryDirectory() as directory:
            settings=Settings(Path(directory)/'settings.json')
            core=Assistant(FakeAudio(),FakeASR(),FakeTTS(),settings)
            core.start()
            try:
                core.handle_text('以后教你小白',mode='dialog')
                self.assertIsNotNone(core.pending)
                self.assertEqual(settings.wake_word,'二狗')
                self.assertFalse(settings.path.exists())
                core.handle_text('确认',mode='confirm')
                self.assertFalse(settings.path.exists())
                core.handle_text('取消',mode='dialog')
                self.assertIsNone(core.pending)
                self.assertFalse(settings.path.exists())
            finally:core.close()

if __name__=='__main__':unittest.main()

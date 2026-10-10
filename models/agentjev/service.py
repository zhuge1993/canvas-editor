"""Private AgentJev adapter: real trained decision head, no speech or generation."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
from prepare import HERE, MANIFEST, verify


def load_engine(root, threads=2, max_tokens=1024, quantization='none'):
    import torch
    from safetensors.torch import load_file
    from transformers import AutoTokenizer, Qwen3Config, Qwen3Model
    from transformers.models.qwen3.modeling_qwen3 import Qwen3RotaryEmbedding
    root = Path(root).resolve()
    source = root / 'upstream'
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != MANIFEST['sourceRevision']:
        raise ValueError('upstream source revision mismatch')
    for name, expected in MANIFEST['files'].items():
        verify(root / 'assets' / name, expected)
    sys.path.insert(0, str(source))
    from agentjev.model import AgentJevModel, CandidateSetEncoder, ScalarScorer
    from agentjev.encoders import PathEncoder
    from jev_service.engine import DecisionEngine
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    torch.backends.mha.set_fastpath_enabled(False)
    config = Qwen3Config.from_pretrained(root / 'assets', local_files_only=True)
    config._attn_implementation = 'eager'
    # Allocate the exact upstream skeleton on meta: the released full state dict
    # replaces all tensors, so downloading/loading the base weights is unnecessary.
    with torch.device('meta'):
        model = AgentJevModel.__new__(AgentJevModel)
        torch.nn.Module.__init__(model)
        model.hidden_size = config.hidden_size
        model.path_encoder = PathEncoder(Qwen3Model(config))
        model.proj_in = torch.nn.Linear(config.hidden_size, 256)
        model.set_encoder = CandidateSetEncoder(256, 4, 2)
        model.proj_out = torch.nn.Linear(256, config.hidden_size)
        model.scorer = ScalarScorer(config.hidden_size, 256)
    model.load_state_dict(load_file(str(root / 'assets' / 'model.safetensors')), strict=True, assign=True)
    # RoPE frequencies are a non-persistent buffer and are not in the checkpoint.
    model.path_encoder.backbone.rotary_emb = Qwen3RotaryEmbedding(config, device='cpu')
    if any(tensor.is_meta for tensor in list(model.parameters()) + list(model.buffers())):
        raise ValueError('model contains uninitialized meta tensors')
    model = model.float().eval()
    if quantization == 'int8':
        # Preserve the trained candidate head; replace only Linear arithmetic.
        # This reduces linear-weight memory, not embedding-table memory.
        model = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
    engine = DecisionEngine.__new__(DecisionEngine)
    engine.torch = torch
    engine.device = 'cpu'
    engine.max_tokens = max_tokens
    engine.path_batch = 1
    engine.lock = threading.Lock()
    engine.encoder = 'shared'
    engine.inference_encoder = 'shared'
    engine.trained_config = None
    engine.collate = None
    engine.tokenizer = AutoTokenizer.from_pretrained(root / 'assets', local_files_only=True)
    if engine.tokenizer.pad_token_id is None:
        engine.tokenizer.pad_token = engine.tokenizer.eos_token
    engine.model = model
    engine.checkpoint_name = MANIFEST['model']
    engine.checkpoint_sha256 = MANIFEST['files']['model.safetensors']['sha256']
    temperatures = json.loads((root / 'assets' / 'temperatures.json').read_text())
    engine.temperatures = {kind: float(value['temperature']) for kind, value in temperatures.items()}
    return engine


def handler(engine):
    from decision_contract import prepare
    slot = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log user text or probabilities.

        def reply(self, status, data):
            raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != '/health':
                self.reply(404, {'error': 'not found'})
                return
            info = engine.info()
            self.reply(200, {'status': 'ready' if info.get('available', True) else 'unavailable', **info, 'phoneQualified': False})

        def do_POST(self):
            if self.path != '/api/evaluate':
                self.reply(404, {'error': 'not found'})
                return
            if not slot.acquire(blocking=False):
                self.reply(429, {'error': 'model busy'})
                return
            try:
                self.connection.settimeout(10)
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 16384:
                    self.reply(413, {'error': 'request exceeds 16384 bytes'})
                    return
                if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                    self.reply(415, {'error': 'JSON required'})
                    return
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('incomplete request')
                data = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
                prepared = prepare(data)
                if len(prepared) != 1 or len(prepared[0]['questions']) > 4 or any(len(q['keys']) > 16 for q in prepared[0]['questions']):
                    raise ValueError('one state, at most four questions and sixteen options')
                result = engine.evaluate(data)
                self.reply(200, result)
            except (ValueError, TypeError, KeyError):
                self.reply(400, {'error': 'invalid or overlong input'})
            except Exception as error:
                print(json.dumps({'event': 'inference_error', 'type': type(error).__name__}), flush=True)
                code = 'cooling' if str(error) == 'model cooling or temperature unavailable' else 'timeout' if str(error) == 'model deadline exceeded' else 'inference_failed'
                self.reply(503, {'error': 'model inference failed', 'code': code})
                if hasattr(engine,'process') and engine.process.poll() is not None:
                    threading.Thread(target=self.server.shutdown,daemon=True).start()
            finally:
                slot.release()
    return Handler


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=HERE / 'runtime')
    parser.add_argument('--threads', type=int, choices=range(1, 5), default=2)
    parser.add_argument('--max-tokens', type=int, choices=[512, 1024, 2048], default=1024)
    parser.add_argument('--port', type=int, default=8149)
    parser.add_argument('--quantization', choices=['none', 'int8'], default='none')
    parser.add_argument('--backend', choices=['torch', 'native'], default='torch')
    parser.add_argument('--worker', type=Path)
    args = parser.parse_args()
    started = time.monotonic()
    if args.backend == 'native':
        if not args.worker: parser.error('--worker is required for the native backend')
        from native_engine import NativeEngine
        engine = NativeEngine(args.root, args.worker, args.threads, args.max_tokens)
    else:
        engine = load_engine(args.root, args.threads, args.max_tokens, args.quantization)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(engine))
    print(json.dumps({'event': 'ready', 'seconds': round(time.monotonic() - started, 2), **engine.info()}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if hasattr(engine,'close'): engine.close()

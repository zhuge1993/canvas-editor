"""Export the complete trained architecture, then quantize its encoder for CPU."""
import argparse
import json
from pathlib import Path
from service import load_engine
from prepare import HERE


def export(root, output):
    import numpy as np
    import onnx
    from onnx import numpy_helper, TensorProto
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic, QuantType
    import torch
    engine = load_engine(root)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    model = engine.model

    class Encoder(torch.nn.Module):
        def __init__(self, backbone):
            super().__init__()
            self.backbone = backbone

        def forward(self, input_ids, lengths):
            positions = torch.arange(input_ids.shape[1], device=input_ids.device)
            valid = positions[None, :] < lengths[:, None]
            allowed = (positions[:, None] >= positions[None, :])[None, :, :] & valid[:, None, :]
            mask = torch.where(allowed, 0.0, -10000.0).to(self.backbone.embed_tokens.weight.dtype)[:, None]
            hidden = self.backbone(input_ids=input_ids, attention_mask=mask, use_cache=False).last_hidden_state
            return hidden[torch.arange(input_ids.shape[0],device=input_ids.device), lengths-1]

    class Head(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.proj_in = model.proj_in
            self.set_encoder = model.set_encoder
            self.proj_out = model.proj_out
            self.scorer = model.scorer

        def forward(self, vectors):
            import torch.nn.functional as F
            x = self.proj_in(vectors)
            for layer in self.set_encoder.encoder.layers:
                normalized = layer.norm1(x)
                projected = F.linear(normalized, layer.self_attn.in_proj_weight, layer.self_attn.in_proj_bias)
                q, k, v = projected.chunk(3, dim=-1)
                def split(value):
                    return value.reshape(value.shape[0], value.shape[1], 4, 64).transpose(1, 2)
                attention = torch.softmax(torch.matmul(split(q), split(k).transpose(-2, -1)) / 8.0, dim=-1)
                mixed = torch.matmul(attention, split(v)).transpose(1, 2).reshape(x.shape[0], x.shape[1], 256)
                x = x + layer.self_attn.out_proj(mixed)
                x = x + layer.linear2(F.gelu(layer.linear1(layer.norm2(x))))
            return self.scorer(vectors + self.proj_out(x))

    tokens = torch.tensor([engine.tokenizer.encode('[STATE] 保存失败\n[QUESTION] 是什么问题\n[CANDIDATE] 程序故障', add_special_tokens=False)])
    # A temporary FP16 export remains below protobuf's 2GB limit. It is converted
    # back to FP32 external tensors before INT8 quantization for old CPU runtimes.
    if not (output/'encoder.int8.onnx').exists():
        encoder = Encoder(model.path_encoder.backbone.half()).eval()
        with torch.inference_mode():
            torch.onnx.export(encoder, (tokens,torch.tensor([tokens.shape[1]])), str(output/'encoder.fp16.onnx'), dynamo=False,
                              opset_version=17, input_names=['input_ids','lengths'], output_names=['vectors'],
                              dynamic_axes={'input_ids': {0: 'batch',1: 'tokens'},'lengths':{0:'batch'},'vectors':{0:'batch'}}, do_constant_folding=False)
        print('encoder graph exported', flush=True)
        graph = onnx.load(str(output/'encoder.fp16.onnx'))
        for tensor in graph.graph.initializer:
            if tensor.data_type == TensorProto.FLOAT16:
                replacement = numpy_helper.from_array(numpy_helper.to_array(tensor).astype(np.float32), tensor.name)
                tensor.CopyFrom(replacement)
        for value in list(graph.graph.input) + list(graph.graph.output) + list(graph.graph.value_info):
            if value.type.tensor_type.elem_type == TensorProto.FLOAT16:
                value.type.tensor_type.elem_type = TensorProto.FLOAT
        for node in graph.graph.node:
            for attribute in node.attribute:
                if attribute.name == 'to' and attribute.i == TensorProto.FLOAT16:
                    attribute.i = TensorProto.FLOAT
                if attribute.type == onnx.AttributeProto.TENSOR and attribute.t.data_type == TensorProto.FLOAT16:
                    attribute.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(attribute.t).astype(np.float32)))
        graph.ir_version = 8
        if (output/'encoder.fp32.data').exists(): (output/'encoder.fp32.data').unlink()
        onnx.save_model(graph, str(output/'encoder.fp32.onnx'), save_as_external_data=True,
                        all_tensors_to_one_file=True, location='encoder.fp32.data', size_threshold=1024)
        del graph
        from onnx_utils import quantize_encoder
        quantize_encoder(output)
        print('encoder INT8 quantized', flush=True)
    head = Head(model.float()).eval()
    vectors = torch.randn(1, 3, model.hidden_size)
    with torch.inference_mode():
        torch.onnx.export(head, (vectors,), str(output/'head.onnx'), dynamo=False, opset_version=17,
                          input_names=['vectors'], output_names=['logits'], dynamic_axes={'vectors': {1: 'candidates'}, 'logits': {1: 'candidates'}})
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    enc = ort.InferenceSession(str(output/'encoder.int8.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    scorer = ort.InferenceSession(str(output/'head.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    values = enc.run(None, {'input_ids': tokens.numpy(),'lengths':np.array([tokens.shape[1]],dtype=np.int64)})[0]
    logits = scorer.run(None, {'vectors': np.stack([values[0], values[0]], axis=0)[None]})[0]
    if not np.isfinite(values).all() or not np.isfinite(logits).all():
        raise ValueError('nonfinite exported inference')
    (output/'export-check.json').write_text(json.dumps({'status': 'PASS_ONNX_LOAD_AND_FINITE_OUTPUT', 'phoneQualified': False, 'encoder_shape': list(values.shape), 'head_shape': list(logits.shape)})+'\n', encoding='utf-8')
    print('ONNX encoder and trained head verified on host', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=HERE/'runtime')
    parser.add_argument('--output', type=Path, default=HERE/'runtime'/'onnx')
    args = parser.parse_args()
    export(args.root, args.output)

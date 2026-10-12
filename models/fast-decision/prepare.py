"""Prepare pinned BGE weights and export a complete INT8 encoder on desktop."""
import argparse
import hashlib
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
SOURCE=json.loads((HERE/'manifest.json').read_text(encoding='utf-8'))


def digest(file):
    h=hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return {'bytes':file.stat().st_size,'sha256':h.hexdigest()}


def prepare(root):
    from huggingface_hub import hf_hub_download
    import numpy as np
    import torch
    from transformers import AutoModel,AutoTokenizer
    import onnx
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic,QuantType
    root=Path(root).resolve();assets=root/'assets';assets.mkdir(parents=True,exist_ok=True)
    names=['model.safetensors','config.json','tokenizer_config.json','vocab.txt']
    for name in names:
        file=Path(hf_hub_download(SOURCE['repo'],name,revision=SOURCE['revision'],local_dir=assets))
        if digest(file)!=SOURCE['files'][name]:raise ValueError('upstream artifact mismatch: '+name)
    torch.set_num_threads(2)
    model=AutoModel.from_pretrained(assets,local_files_only=True,attn_implementation='eager').eval()
    tokenizer=AutoTokenizer.from_pretrained(assets,local_files_only=True)
    class Encoder(torch.nn.Module):
        def __init__(self):super().__init__();self.model=model
        def forward(self,input_ids,attention_mask,token_type_ids):
            return torch.nn.functional.normalize(self.model(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).last_hidden_state[:,0],p=2,dim=1)
    inputs=tokenizer(['保存画布后图形消失','程序故障'],padding=True,return_tensors='pt')
    fp=root/'encoder.fp32.onnx';quant=root/'encoder.int8.onnx'
    with torch.inference_mode():
        torch.onnx.export(Encoder(),tuple(inputs[k] for k in ['input_ids','attention_mask','token_type_ids']),str(fp),dynamo=False,opset_version=17,input_names=['input_ids','attention_mask','token_type_ids'],output_names=['vectors'],dynamic_axes={k:{0:'batch',1:'tokens'} for k in inputs}|{'vectors':{0:'batch'}},do_constant_folding=True)
    graph=onnx.load(fp);graph.ir_version=8;onnx.save(graph,fp)
    quantize_dynamic(str(fp),str(quant),op_types_to_quantize=['MatMul','Gather'],weight_type=QuantType.QInt8)
    options=ort.SessionOptions();options.intra_op_num_threads=2
    session=ort.InferenceSession(str(quant),sess_options=options,providers=['CPUExecutionProvider'])
    result=session.run(None,{k:v.numpy() for k,v in inputs.items()})[0]
    if result.shape!=(2,512) or not np.isfinite(result).all():raise ValueError('exported inference failed')
    manifest={**SOURCE,'files':{**SOURCE['files'],'encoder.int8.onnx':digest(quant)}}
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print('Pinned BGE assets and INT8 encoder prepared; native phone execution is a separate check.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=HERE/'runtime')
    prepare(parser.parse_args().root)

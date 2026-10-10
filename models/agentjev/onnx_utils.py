"""Fold constant weight transposes so every projection can be quantized."""
def quantize_encoder(directory):
    from pathlib import Path
    import onnx
    from onnx import numpy_helper
    from onnxruntime.quantization import quantize_dynamic, QuantType
    root = Path(directory)
    graph = onnx.load(str(root/'encoder.fp32.onnx'))
    tensors = {item.name: item for item in graph.graph.initializer}
    keep = []
    for node in graph.graph.node:
        if node.op_type == 'Transpose' and node.input[0] in tensors:
            values = numpy_helper.to_array(tensors[node.input[0]])
            order = next((attribute.ints for attribute in node.attribute if attribute.name == 'perm'), None)
            tensors[node.output[0]] = numpy_helper.from_array(values.transpose(order), node.output[0])
        else: keep.append(node)
    used = {name for node in keep for name in node.input}
    del graph.graph.node[:]; graph.graph.node.extend(keep)
    del graph.graph.initializer[:]; graph.graph.initializer.extend(value for key,value in tensors.items() if key in used)
    del tensors
    data = root/'encoder.folded.data'
    if data.exists(): data.unlink()
    onnx.save_model(graph,str(root/'encoder.folded.onnx'),save_as_external_data=True,all_tensors_to_one_file=True,location=data.name,size_threshold=1024)
    del graph
    for filename in ['encoder.int8.onnx','encoder.int8.onnx.data']:
        target=root/filename
        if target.exists(): target.unlink()
    quantize_dynamic(str(root/'encoder.folded.onnx'),str(root/'encoder.int8.onnx'),op_types_to_quantize=['MatMul','Gather','Gemm'],weight_type=QuantType.QInt8,use_external_data_format=True)

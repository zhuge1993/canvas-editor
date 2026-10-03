#!/usr/bin/env python3
"""Score supplied ASR text; never run a recognizer or change its transcript."""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import unicodedata

HERE = Path(__file__).resolve().parent


def dictionary(path):
    result = {}
    for line in path.read_text(encoding='utf8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        source, targets = line.split('\t', 1)
        result[source] = targets.split(' ')[0]
    return result


class TraditionalToSimplified:
    """OpenCC dictionary matching only; no homophone or ASR corrections."""
    def __init__(self, directory_path):
        directory_path = Path(directory_path)
        self.chars = dictionary(directory_path/'TSCharacters.txt')
        self.phrases = dictionary(directory_path/'TSPhrases.txt')
        self.max_phrase = max(map(len, self.phrases))

    def convert(self, text):
        result = []; i = 0
        while i < len(text):
            chosen = None
            for size in range(min(self.max_phrase, len(text)-i), 1, -1):
                piece = text[i:i+size]
                if piece in self.phrases:
                    chosen = self.phrases[piece]; i += size; break
            if chosen is None:
                chosen = self.chars.get(text[i], text[i]); i += 1
            result.append(chosen)
        return ''.join(result)


def strip_punctuation_and_space(text):
    # Deliberately retain case, digits, symbols and homophones. No NFKC, numeral
    # spelling conversion, filler-word deletion, or whitespace-generated words.
    return ''.join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith('P'))


def align(reference, hypothesis):
    """Character Levenshtein with deterministic edit trace: equal,S,D,I."""
    rows = [[0]*(len(hypothesis)+1) for _ in range(len(reference)+1)]
    for i in range(len(reference)+1): rows[i][0] = i
    for j in range(len(hypothesis)+1): rows[0][j] = j
    for i, rc in enumerate(reference, 1):
        for j, hc in enumerate(hypothesis, 1):
            rows[i][j] = min(rows[i-1][j-1]+(rc != hc), rows[i-1][j]+1, rows[i][j-1]+1)
    i = len(reference); j = len(hypothesis); edits = []
    while i or j:
        if i and j and reference[i-1] == hypothesis[j-1] and rows[i][j] == rows[i-1][j-1]:
            edits.append({'op':'equal','reference':reference[i-1],'hypothesis':hypothesis[j-1]}); i-=1; j-=1
        elif i and j and rows[i][j] == rows[i-1][j-1]+1:
            edits.append({'op':'substitute','reference':reference[i-1],'hypothesis':hypothesis[j-1],'reference_index':i-1,'hypothesis_index':j-1}); i-=1; j-=1
        elif i and rows[i][j] == rows[i-1][j]+1:
            edits.append({'op':'delete','reference':reference[i-1],'hypothesis':'','reference_index':i-1,'hypothesis_index':j}); i-=1
        else:
            edits.append({'op':'insert','reference':'','hypothesis':hypothesis[j-1],'reference_index':i,'hypothesis_index':j-1}); j-=1
    edits.reverse()
    differences = [edit for edit in edits if edit['op'] != 'equal']
    s = sum(x['op']=='substitute' for x in differences)
    d = sum(x['op']=='delete' for x in differences)
    ins = sum(x['op']=='insert' for x in differences)
    return {'reference_normalized':reference,'hypothesis_normalized':hypothesis,
            'reference_characters':len(reference),'substitutions':s,'deletions':d,'insertions':ins,
            'edit_distance':rows[-1][-1],'CER':rows[-1][-1]/len(reference) if reference else None,
            'exact_match':reference==hypothesis,'differences':differences}


def numeric(value):
    return value if isinstance(value, (int,float)) and not isinstance(value,bool) and math.isfinite(value) and value >= 0 else None


def timing(record, duration):
    mode = record.get('mode', 'paced_streaming' if record.get('paced') is True or record.get('input_mode') == 'paced_wav' else 'batch_offline')
    inference = numeric(record.get('inference_seconds', record.get('batch_seconds',record.get('processing_seconds'))))
    result = {'mode':mode,'audio_duration_s':duration,'recognizer_processing_seconds':inference,
              'processing_RTF':inference/duration if inference is not None and duration>0 else None,
              'batch_inference_seconds':inference if mode=='batch_offline' else None,
              'load_seconds':numeric(record.get('load_seconds',record.get('model_load_seconds'))),'streaming_tail_latency_seconds':None,
              'streaming_first_partial_seconds':None}
    if mode == 'paced_streaming':
        final = numeric(record.get('final_result_wall_s', record.get('last_text_final_wall_seconds')))
        last = numeric(record.get('last_audio_accepted_wall_s', record.get('last_real_chunk_accept_wall_seconds')))
        first = numeric(record.get('first_partial_wall_s',record.get('first_partial_wall_seconds')))
        if final is not None and last is not None and final >= last:
            result['streaming_tail_latency_seconds'] = final-last
        if first is not None: result['streaming_first_partial_seconds'] = first
        result['streaming_after_audio_end_deadline_seconds'] = numeric(record.get('after_audio_deadline_seconds', record.get('last_text_final_from_audio_deadline_seconds')))
        result['last_audio_accept_timing'] = record.get('last_audio_accept_timing','before_client_feed_request_final_real_chunk' if record.get('input_mode') == 'paced_wav' else 'unspecified')
        result['streaming_wall_seconds'] = numeric(record.get('wall_seconds', record.get('complete_client_wall_seconds')))
        result['streaming_tail_processing_seconds'] = numeric(record.get('tail_processing_seconds'))
        result['streaming_max_block_seconds'] = numeric(record.get('max_block_seconds', record.get('max_chunk_request_seconds')))
        result['streaming_p95_block_seconds'] = numeric(record.get('p95_block_seconds'))
        result['timing_valid'] = result['streaming_tail_latency_seconds'] is not None
        result['final_result_kind'] = record.get('final_result_kind', 'not_supplied')
        result['endpoint_detected'] = record.get('endpoint_detected')
        result['last_speech_phoneme_annotated'] = False
        result['timing_note'] = 'Wall time from final paced real input delivery to final result; before/after AcceptWaveform is recorded separately. Audio-end-deadline latency also exposes backlog. Neither equals whole-file batch time.'
    else:
        result['timing_valid'] = inference is not None
        result['timing_note'] = 'Whole-file decode time after model load; does not demonstrate microphone streaming tail latency.'
    return result


def records(document, source):
    if isinstance(document, list):
        for row in document: yield from records(row, source)
    elif isinstance(document, dict):
        if 'runs' in document:
            common = {k:v for k,v in document.items() if k not in ['runs','stderr','stdout']}
            for run in document['runs']:
                yield dict(common, **run, _source=str(source))
        elif any(key in document for key in ['cases','results','hypotheses']):
            key = next(key for key in ['cases','results','hypotheses'] if key in document)
            common = {k:v for k,v in document.items() if k not in ['cases','results','hypotheses','stderr','stdout']}
            for row in document[key]:
                yield from records(dict(common,**row) if isinstance(row,dict) else row, source)
        elif 'transcript' in document or 'text' in document:
            yield dict(document, _source=str(source))
        else:
            raise ValueError('Unrecognized ASR result schema: '+str(source))
    else: raise ValueError('ASR result must be an object or list')


def input_documents(path):
    text = path.read_text(encoding='utf8')
    try: return [json.loads(text)]
    except json.JSONDecodeError:
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
        metadata = {}; results = []
        for row in rows:
            if not isinstance(row,dict): raise ValueError('JSONL result must be an object')
            if 'transcript' in row or 'text' in row: results.append(dict(metadata,**row))
            elif 'model_load_seconds' in row or 'model_name' in row: metadata.update(row)
            else: raise ValueError('Unrecognized JSONL metadata/result')
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',default=str(HERE/'evaluation-manifest.json'))
    parser.add_argument('--opencc-dir',type=Path,default=HERE/'opencc',help='Pinned OpenCC dictionaries downloaded outside the repository')
    parser.add_argument('--hypotheses',nargs='+',required=True)
    parser.add_argument('--report',required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding='utf8'))
    samples = manifest['samples']; by_id = {}
    for sample in samples:
        by_id[sample['id']] = sample; by_id[sample['file']] = sample
    converter = TraditionalToSimplified(args.opencc_dir); scores = []
    for path_value in args.hypotheses:
        path = Path(path_value)
        for record in records(input_documents(path), path):
            sample_name = record.get('sample_id',record.get('id',record.get('audio_name',record.get('file'))))
            if sample_name is None: raise ValueError('ASR result missing sample_id/audio_name: '+str(path))
            sample_name = Path(sample_name).name
            if sample_name not in by_id: raise ValueError('Unknown sample '+sample_name)
            sample = by_id[sample_name]
            hypothesis = record.get('transcript',record.get('text'))
            if not isinstance(hypothesis,str): raise ValueError('Missing original ASR text')
            reference = sample.get('reference_text')
            item = {'sample_id':sample['id'],'file':sample['file'],'group':sample['group'],'language':sample['language'],
                    'model':record.get('model',record.get('model_name',record.get('backend','unspecified'))),
                    'run':record.get('run',1),'source_report':str(path),'reference_original':reference,
                    'hypothesis_original':hypothesis,'timing':timing(record,sample['duration_s']),
                    'status':'SCORED' if reference is not None else 'NOT_SCORED_NO_SUPPLIED_REFERENCE'}
            if reference is not None:
                r = strip_punctuation_and_space(reference); h = strip_punctuation_and_space(hypothesis)
                item['strict'] = align(r,h)
                item['traditional_to_simplified'] = align(strip_punctuation_and_space(converter.convert(reference)),strip_punctuation_and_space(converter.convert(hypothesis)))
            scores.append(item)
    buckets = defaultdict(list); distinct = set()
    for item in scores:
        if item['status'] != 'SCORED': continue
        key = (item['model'],item['group'],item['language'],item['sample_id'])
        if key in distinct: continue
        distinct.add(key); buckets[key[:3]].append(item)
    summaries = []
    for (model,group,language), cases in buckets.items():
        summary = {'model':model,'group':group,'language':language,'unique_sample_count':len(cases),'aggregation':'first measured run per distinct sample; repetitions are not independent accuracy samples'}
        for normalization in ['strict','traditional_to_simplified']:
            errors = sum(x[normalization]['edit_distance'] for x in cases)
            characters = sum(x[normalization]['reference_characters'] for x in cases)
            summary[normalization] = {'errors':errors,'reference_characters':characters,'micro_CER':errors/characters if characters else None,
                                      'exact_sentence_count':sum(x[normalization]['exact_match'] for x in cases)}
        summaries.append(summary)
    report = {'scoring_version':1,'normalization_policy':manifest['normalization_policy'],
              'limitations':manifest['limitations'],'model_accuracy_summaries':summaries,'per_run':scores,
              'tested_unique_samples':len({x['sample_id'] for x in scores}),
              'manifest_sha256':hashlib.sha256(Path(args.manifest).read_bytes()).hexdigest()}
    target = Path(args.report); target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'summaries':summaries,'scored_runs':len(scores),'report':str(target)},ensure_ascii=False))


if __name__ == '__main__': main()

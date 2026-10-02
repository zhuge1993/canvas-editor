#!/usr/bin/env python3
"""Bounded non-root GPU computation/rendering regression; no display writes."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

PREFIX = Path('/opt/dior-android')


def snapshot():
    result = {'kernel': os.uname().version, 'uid': os.geteuid()}
    for name, file in (
        ('tainted', '/proc/sys/kernel/tainted'),
        ('reset_count', '/sys/class/kgsl/kgsl-3d0/reset_count'),
    ):
        try:
            result[name] = Path(file).read_text().strip()
        except OSError as error:
            result[name+'_error'] = str(error)
    result['reset_count_note'] = 'Includes normal adreno_start cold starts; not a fault-only counter.'
    return result


def run_case(directory, label, kind, repeat, version=None):
    command = [sys.executable, str(PREFIX/'run-native.py'), '--kind', kind,
               '--timeout', '45', '--', '--repeat', str(repeat)]
    if version:
        command += ['--version', str(version)]
    start = time.monotonic()
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=50)
        result = json.loads(completed.stdout)
        (directory/(label+'.json')).write_text(json.dumps(result, indent=2)+'\n')
        (directory/(label+'.stderr')).write_text(completed.stderr)
        passed = completed.returncode == 0 and result.get('completed_iterations') == repeat
        if kind == 'opencl':
            passed = passed and result.get('hardware_compute_pass') is True
            passed = passed and result.get('device_type') == 4
            mismatches = sum(item.get('mismatched_elements', 1) for item in result.get('rounds', []))
        else:
            passed = passed and result.get('hardware_render_pass') is True
            passed = passed and result.get('gles_fragment_compute_pass') is True
            mismatches = sum(check.get('mismatched_pixels', 1)
                for iteration in result.get('iterations', [])
                for check in iteration.get('clears', []) + [iteration.get('shader_triangle', {}),
                                                          iteration.get('texture_arithmetic', {})])
        return {'label': label, 'kind': kind, 'requested_version': version,
                'repeat': repeat, 'pass': bool(passed and mismatches == 0),
                'mismatches': mismatches, 'returncode': completed.returncode,
                'elapsed_ms': round((time.monotonic()-start)*1000, 3),
                'error': result.get('error'), 'device': result.get('device_name', result.get('gl_renderer'))}
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        return {'label': label, 'kind': kind, 'pass': False, 'error': str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise RuntimeError('Run GPU acceptance as the ordinary dior account')
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {'before': snapshot(), 'cases': [], 'hardware_stability_pass': False,
              'display_framebuffer_changed': False, 'global_libraries_replaced': False}
    for label, kind, repeat, version in (
        ('gles3-smoke', 'gles', 3, 3),
        ('opencl-50', 'opencl', 50, None),
        ('gles2-50', 'gles', 50, 2),
        ('gles3-50', 'gles', 50, 3),
    ):
        result['cases'].append(run_case(output.parent, label, kind, repeat, version))
        if not result['cases'][-1]['pass']:
            break
    if all(case['pass'] for case in result['cases']) and len(result['cases']) == 4:
        for cycle in range(3):
            for kind in ('opencl', 'gles'):
                label = 'reopen-%s-%d' % (kind, cycle+1)
                result['cases'].append(run_case(output.parent, label, kind, 3,
                                                3 if kind == 'gles' else None))
                if not result['cases'][-1]['pass']:
                    break
            if not result['cases'][-1]['pass']:
                break
    if len(result['cases']) == 10 and all(case['pass'] for case in result['cases']):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(run_case, output.parent, 'mixed-opencl', 'opencl', 50),
                       pool.submit(run_case, output.parent, 'mixed-gles3', 'gles', 50, 3)]
            result['cases'].extend(future.result() for future in futures)
        if all(case['pass'] for case in result['cases']):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(run_case, output.parent, 'concurrent-gles3-%d'%number,
                                       'gles', 50, 3) for number in (1, 2)]
                result['cases'].extend(future.result() for future in futures)
    result['after'] = snapshot()
    result['hardware_stability_pass'] = (len(result['cases']) == 14 and
        all(case['pass'] for case in result['cases']) and result['after'].get('tainted') == '0')
    output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))
    return 0 if result['hardware_stability_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

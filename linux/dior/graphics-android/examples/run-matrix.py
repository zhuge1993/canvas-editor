#!/usr/bin/env python3
"""Run only the independent FP32 matrix worker; never modify the private SDK."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

sys.dont_write_bytecode = True
EXPECTED_WORKER_SHA256 = 'fe7772f6f9b94f01d72dbaea5ee8454735630665b0d09f9f14c3e019b0f5a72d'
WORKER = Path(__file__).resolve().with_name('dior-matrix-worker')
SDK_LAUNCHER = Path('/opt/dior-android/run-native.py')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--timeout', type=float, default=45)
    parser.add_argument('--trace', action='store_true')
    args = parser.parse_args()
    if not 3 <= args.repeat <= 1000 or not 0.1 <= args.timeout <= 300:
        parser.error('repeat must be 3..1000 and timeout 0.1..300')
    result = {'application': 'independent FP32 matrix multiplication',
              'hardware_application_compute_pass': False, 'cpu_fallback_permitted': False,
              'global_properties_changed': False, 'sdk_changed': False, 'cases': []}
    descriptor = None
    try:
        if os.geteuid() == 0:
            raise RuntimeError('Run this application as the ordinary dior user, without sudo')
        result['uid'] = os.geteuid()
        before_taint = Path('/proc/sys/kernel/tainted').read_text().strip()
        result['kernel_tainted_before'] = before_taint
        if before_taint != '0':
            raise RuntimeError('Start this independent acceptance on an untainted kernel')
        worker_info = WORKER.lstat()
        if not stat.S_ISREG(worker_info.st_mode) or not os.access(WORKER, os.X_OK):
            raise RuntimeError('The fixed sibling matrix worker must be a regular executable')
        actual_sha = hashlib.sha256(WORKER.read_bytes()).hexdigest()
        if actual_sha != EXPECTED_WORKER_SHA256:
            raise RuntimeError('Matrix worker SHA256 differs from the reviewed build')
        result['worker_sha256'] = actual_sha
        specification = importlib.util.spec_from_file_location('dior_sdk_transport', SDK_LAUNCHER)
        transport = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(transport)
        # Reuse read-only SDK path/property validation, not its executable
        # whitelist. Only this new sibling executable is launched below.
        _unused_production_worker, sdk_environment, descriptor = transport.runtime_environment('opencl', [])
        environment = {name: sdk_environment[name] for name in
                       ('LD_LIBRARY_PATH', 'ANDROID_PROPERTY_WORKSPACE')}
        environment.update(PATH='/usr/local/bin:/usr/bin:/bin', LANG='C.UTF-8', TZ='UTC')
        for dimension in (16, 32):
            command = [str(WORKER), '--dimension', str(dimension), '--repeat', str(args.repeat)]
            if args.trace:
                command.append('--trace')
            done = transport.run_child(command, environment, descriptor, args.timeout)
            if done['stderr']:
                sys.stderr.buffer.write(done['stderr'])
                sys.stderr.buffer.flush()
            native = json.loads(done['stdout'].decode('utf-8'))
            case = {'dimension': dimension, 'returncode': done['returncode'],
                    'runner_error': done['runner_error'], 'result': native, 'pass': False}
            result['cases'].append(case)
            rounds = native.get('rounds', [])
            case['pass'] = (done['returncode'] == 0 and done['runner_error'] is None and
                            native.get('status') == 'PASS_GPU_COMPUTE' and
                            native.get('hardware_compute_pass') is True and native.get('device_type') == 4 and
                            native.get('data_type') == 'float32' and native.get('matrix_dimension') == dimension and
                            native.get('elements') == dimension*dimension and
                            native.get('requested_iterations') == args.repeat and
                            native.get('completed_iterations') == args.repeat and len(rounds) == args.repeat and
                            all(entry.get('pass') is True and entry.get('mismatched_elements') == 0 and
                                0 <= entry.get('max_absolute_error', -1) <= 0.000001 for entry in rounds))
            if not case['pass']:
                raise RuntimeError('Independent matrix GPU validation failed')
        result['kernel_tainted_after'] = Path('/proc/sys/kernel/tainted').read_text().strip()
        result['hardware_application_compute_pass'] = (len(result['cases']) == 2 and
                                                       result['kernel_tainted_after'] == '0')
    except (OSError, RuntimeError, ValueError, AttributeError) as error:
        result['error'] = str(error)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    print(json.dumps(result, indent=2), flush=True)
    return 0 if result['hardware_application_compute_pass'] else 1


if __name__ == '__main__':
    sys.exit(main())

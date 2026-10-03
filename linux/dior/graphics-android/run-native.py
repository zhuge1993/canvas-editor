#!/usr/bin/env python3
"""Run the private Android GPU runtime as a bounded, separate Bionic process.

The root installer creates /opt/dior-android/properties-area. This launcher
requires no sudo and never creates or changes that file or /dev properties.
AOSP android-4.4.4_r2 bionic system_properties.c uses the inherited workspace
descriptor when /dev/__properties__ is absent. Its 128 KiB area has a 128-byte
header (bytes_used, serial, magic, version) followed by a 20-byte trie root.
The installer may populate immutable, non-secret board/platform properties.

Examples: run-native.py --kind opencl --timeout 45 -- --repeat 50
          run-native.py --kind gles --timeout 45 -- --version 2 --repeat 50
"""
import argparse
import json
import os
from pathlib import Path
import signal
import stat
import struct
import subprocess
import sys
import threading
import time


PREFIX = Path('/opt/dior-android')
PROPERTY_SIZE = 128 * 1024
PROPERTY_HEADER = (20, 0, 0x504F5250, 0xFC6ED0AB)
STDOUT_LIMIT = 1024 * 1024
STDERR_LIMIT = 256 * 1024
EXECUTABLES = {'opencl': 'dior-opencl-probe', 'gles': 'dior-gles-probe'}


class RuntimeErrorDetail(RuntimeError):
    pass


def within_prefix(path, prefix):
    resolved = Path(path).resolve(strict=True)
    if not resolved.is_relative_to(prefix):
        raise RuntimeErrorDetail('runtime path resolves outside the private prefix: ' + str(path))
    return resolved


def trusted_path(path, directory=False):
    info = path.stat()
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected_type(info.st_mode):
        raise RuntimeErrorDetail('runtime path has the wrong file type: ' + str(path))
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeErrorDetail('runtime files must belong to root and must not be group/world writable: ' + str(path))


def library_paths(base):
    aliases = within_prefix(base / 'aliases', base)
    trusted_path(aliases, directory=True)
    # KitKat's loader concatenates search directories with a failed absolute
    # dlopen name. Retain this alias directory, rather than resolving each alias
    # into LD_LIBRARY_PATH, so /vendor/... and /system/... reach the private SDK.
    for name, target in (('system', base/'system'), ('vendor', base/'system/vendor')):
        resolved = within_prefix(aliases/name, base)
        if resolved != target.resolve(strict=True):
            raise RuntimeErrorDetail('private loader alias points to the wrong SDK directory: ' + name)
        trusted_path(resolved, directory=True)
    directories = [str(aliases)]
    for relative in ('system/lib', 'system/vendor/lib', 'system/vendor/lib/egl'):
        path = within_prefix(base / relative, base)
        trusted_path(path, directory=True)
        directories.append(str(path))
    return directories


def validate_property_area(blob):
    """Validate KitKat trie/object bounds without returning any property values."""
    if len(blob) != PROPERTY_SIZE:
        raise RuntimeErrorDetail('properties-area has the wrong length')
    used, serial, magic, version = struct.unpack_from('<IIII', blob, 0)
    if (magic, version) != PROPERTY_HEADER[2:] or used < 20 or used > PROPERTY_SIZE-128 or used % 4:
        raise RuntimeErrorDetail('properties-area has an invalid KitKat header/data length')
    data = memoryview(blob)[128:128+used]
    if data[0] != 0 or bytes(data[1:4]) != bytes(3):
        raise RuntimeErrorDetail('properties-area has an invalid trie root')
    root_prop, root_left, root_right, root_children = struct.unpack_from('<IIII', data, 4)
    if root_prop or root_left or root_right:
        raise RuntimeErrorDetail('properties-area root must have no property or sibling links')
    pending = [root_children] if root_children else []
    visited = set()
    property_offsets = set()
    while pending:
        offset = pending.pop()
        if offset < 20 or offset % 4 or offset+20 > used or offset in visited:
            raise RuntimeErrorDetail('properties-area trie has an invalid, repeated or cyclic offset')
        visited.add(offset)
        name_length = data[offset]
        if (not 1 <= name_length <= 31 or bytes(data[offset+1:offset+4]) != bytes(3) or
                offset+20+name_length+1 > used or data[offset+20+name_length] != 0):
            raise RuntimeErrorDetail('properties-area trie token exceeds its data bounds')
        prop, left, right, children = struct.unpack_from('<IIII', data, offset+4)
        pending.extend(link for link in (left, right, children) if link)
        if not prop:
            continue
        # prop_info consists of serial, a 92-byte value buffer and a NUL-terminated
        # property name. Validate offsets/lengths; never expose the actual values.
        if prop < 20 or prop % 4 or prop+97 > used or prop in property_offsets:
            raise RuntimeErrorDetail('properties-area property object exceeds its data bounds')
        property_offsets.add(prop)
        prop_serial = struct.unpack_from('<I', data, prop)[0]
        value_length = prop_serial >> 24
        if value_length >= 92 or prop_serial & 1 or data[prop+4+value_length] != 0:
            raise RuntimeErrorDetail('properties-area property value length/serial is invalid')
        name_end = bytes(data[prop+96:min(prop+128, used)]).find(b'\0')
        if name_end < 1:
            raise RuntimeErrorDetail('properties-area property name is not terminated within its data bounds')
    return {'bytes_used': used, 'serial': serial, 'trie_nodes': len(visited), 'properties': len(property_offsets)}


def runtime_environment(kind, native_args, prefix=PREFIX):
    """Validate immutable installation paths and return a read-only property FD.

    prefix exists as an internal test parameter; the CLI always uses PREFIX.
    Ownership and descriptor checks occur before executing any native code.
    """
    base = prefix.resolve(strict=True)
    trusted_path(base, directory=True)
    executable = within_prefix(base / 'bin' / EXECUTABLES[kind], base)
    trusted_path(executable)
    if not os.access(executable, os.X_OK):
        raise RuntimeErrorDetail('native probe is not executable: ' + str(executable))
    directories = library_paths(base)
    # OpenCL's diagnostic library option can select only this immutable runtime.
    for index, value in enumerate(native_args):
        if value == '--library' and index + 1 < len(native_args):
            requested = Path(native_args[index + 1])
            if not requested.is_absolute():
                raise RuntimeErrorDetail('--library must use an absolute private-runtime path')
            trusted_path(within_prefix(requested, base))
    properties = base / 'properties-area'
    within_prefix(properties, base)
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(properties, flags)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != 0o444 or info.st_size != PROPERTY_SIZE):
            raise RuntimeErrorDetail('properties-area must be a root-owned 0444 regular 128 KiB file')
        validate_property_area(os.pread(descriptor, PROPERTY_SIZE, 0))
        environment = dict(os.environ)
        environment.pop('LD_PRELOAD', None)
        environment.pop('LD_AUDIT', None)
        environment['LD_LIBRARY_PATH'] = ':'.join(directories)
        environment['ANDROID_PROPERTY_WORKSPACE'] = '%d,%d' % (descriptor, PROPERTY_SIZE)
        return str(executable), environment, descriptor
    except BaseException:
        os.close(descriptor)
        raise


def run_child(command, environment, descriptor, timeout):
    """Capture finite output without communicate() allocating unbounded data.

    Test fixtures may omit the property descriptor; production always supplies
    the descriptor validated above. Child execution never uses a shell.
    """
    exceeded = threading.Event()
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    read_errors = []
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=environment, shell=False,
                             pass_fds=() if descriptor is None else (descriptor,),
                             close_fds=True, start_new_session=True, bufsize=0)
    deadline = time.monotonic() + timeout

    def drain(stream, name, limit):
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                room = limit - len(output[name])
                if len(chunk) > room:
                    exceeded.set()
                if room > 0:
                    output[name].extend(chunk[:room])
        except (OSError, ValueError) as error:
            read_errors.append(str(error))

    def terminate_group():
        if os.name == 'posix':
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif child.poll() is None:
            child.kill()

    readers = [threading.Thread(target=drain, args=(child.stdout, 'stdout', STDOUT_LIMIT), daemon=True),
               threading.Thread(target=drain, args=(child.stderr, 'stderr', STDERR_LIMIT), daemon=True)]
    for reader in readers:
        reader.start()
    reason = None
    try:
        while child.poll() is None:
            remaining = deadline - time.monotonic()
            if exceeded.is_set():
                reason = 'OUTPUT_LIMIT'
                break
            if remaining <= 0:
                reason = 'TIMEOUT'
                break
            try:
                child.wait(timeout=min(0.05, remaining))
            except subprocess.TimeoutExpired:
                pass
        if reason:
            terminate_group()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                reason += '_CLEANUP_TIMEOUT'
        # An inherited pipe held by a descendant is also subject to the route
        # deadline. It cannot keep the CLI alive after the native parent exits.
        for reader in readers:
            reader.join(timeout=max(0, deadline-time.monotonic()))
        if any(reader.is_alive() for reader in readers):
            reason = reason or 'OUTPUT_DRAIN_TIMEOUT'
            terminate_group()
            for reader in readers:
                reader.join(timeout=0.25)
        if exceeded.is_set():
            reason = reason or 'OUTPUT_LIMIT'
        if read_errors:
            reason = reason or 'OUTPUT_READ_ERROR'
    finally:
        if child.poll() is None:
            terminate_group()
        child.stdout.close()
        child.stderr.close()
    return {'returncode': child.returncode, 'stdout': bytes(output['stdout']),
            'stderr': bytes(output['stderr']), 'runner_error': reason,
            'output_limits': {'stdout': STDOUT_LIMIT, 'stderr': STDERR_LIMIT}}


def native_success(kind, result, native_args):
    if not isinstance(result, dict):
        return False
    if kind == 'opencl' and '--inventory-only' in native_args:
        return (result.get('status') == 'INVENTORY_ONLY' and result.get('inventory_pass') is True and
                result.get('hardware_compute_pass') is False)
    requested = result.get('requested_iterations') if kind == 'opencl' else result.get('repeat')
    completed = result.get('completed_iterations')
    if (type(requested) is not int or type(completed) is not int or
            requested < 1 or requested != completed):
        return False
    if kind == 'opencl':
        return (result.get('status') == 'PASS_GPU_COMPUTE' and result.get('hardware_compute_pass') is True and
                result.get('device_type') == 4 and result.get('device_available') is True and
                result.get('compiler_available') is True and requested >= 3 and
                not result.get('error') and not result.get('cleanup_error'))
    return (result.get('status') == 'PASS_GPU_RENDER' and result.get('hardware_render_pass') is True and
            result.get('gles_fragment_compute_pass') is True and result.get('hardware_identity') is True and
            result.get('software_renderer') is False and result.get('cleanup_passed') is True and
            result.get('gl_error') == 0 and result.get('egl_error') == 0 and not result.get('error'))


def failure_result(kind, status, message, returncode=None):
    return {'status': status, 'error': message, 'kind': kind,
            'hardware_compute_pass': False, 'hardware_render_pass': False,
            'gles_fragment_compute_pass': False, 'native_returncode': returncode,
            'android_code_runs_in_separate_process': True, 'global_property_file_created': False}


def child_result(kind, native_args, done):
    code = done['returncode']
    if done['runner_error']:
        status = done['runner_error']
        return failure_result(kind, status, 'native execution failed: ' + status, code), 124 if 'TIMEOUT' in status else 1
    try:
        result = json.loads(done['stdout'].decode('utf-8'))
        if not isinstance(result, dict):
            raise ValueError('native output is not a JSON object')
    except (UnicodeError, ValueError) as error:
        return failure_result(kind, 'FAIL_NATIVE_OUTPUT', str(error), code), 1 if code in (None, 0) else exit_status(code)
    if code != 0:
        # Never forward a true capability claim after a signal or failed exit.
        if any(result.get(name) is True for name in
               ('hardware_compute_pass', 'hardware_render_pass', 'gles_fragment_compute_pass', 'inventory_pass')):
            result = failure_result(kind, 'FAIL_NATIVE_PROCESS', 'native process failed despite a success claim', code)
        return result, exit_status(code)
    if not native_success(kind, result, native_args):
        return failure_result(kind, 'FAIL_NATIVE_VALIDATION', 'zero exit status without a complete hardware validation result', code), 1
    return result, 0


def exit_status(returncode):
    if returncode is None:
        return 1
    return min(255, 128-returncode) if returncode < 0 else min(255, returncode)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', choices=tuple(EXECUTABLES), required=True)
    parser.add_argument('--timeout', type=float, default=45)
    parser.add_argument('native_args', nargs=argparse.REMAINDER, help='native options after --')
    args = parser.parse_args(argv)
    if not 0.1 <= args.timeout <= 300:
        parser.error('--timeout must be between 0.1 and 300 seconds')
    native_args = args.native_args[1:] if args.native_args[:1] == ['--'] else args.native_args
    descriptor = None
    try:
        executable, environment, descriptor = runtime_environment(args.kind, native_args)
        done = run_child([executable, *native_args], environment, descriptor, args.timeout)
        if done['stderr']:
            sys.stderr.buffer.write(done['stderr'])
            sys.stderr.buffer.flush()
        result, code = child_result(args.kind, native_args, done)
    except (OSError, RuntimeErrorDetail) as error:
        result, code = failure_result(args.kind, 'FAIL_RUNTIME_CONFIGURATION', str(error)), 1
    finally:
        if descriptor is not None:
            os.close(descriptor)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return code


if __name__ == '__main__':
    sys.exit(main())

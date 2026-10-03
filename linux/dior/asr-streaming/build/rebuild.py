#!/usr/bin/env python3
"""Rebuild the pinned ARMv7 CPU ASR in a caller-selected, isolated output tree."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform
import posixpath
import re
import shutil
import stat
import subprocess
import tarfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / 'dependencies.lock.json').read_text(encoding='utf-8'))
TARGET = 'armv7-none-linux-androideabi19'
INTERPRETER = '/opt/dior-android/system/bin/linker'


def sha(path, algorithm='sha256'):
    result = hashlib.new(algorithm)
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def check_file(path, expected=None):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError('Expected a regular input file: ' + path.name)
    value = sha(path)
    if expected is not None and value != expected:
        raise ValueError('Input SHA256 mismatch: ' + path.name)
    return value


def path_arg(value):
    result = Path(value).expanduser().resolve()
    if any(char in str(result) for char in ('\n', '\r', ';', '"')):
        raise ValueError('Unsupported control/quote/semicolon in build path')
    return result


def q(path):
    return str(path).replace('\\', '/')


def flag_string(values):
    return ' '.join('"' + q(item) + '"' if any(c.isspace() for c in q(item)) else q(item) for item in values)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def tree_hashes(root):
    values = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('Generated source tree contains an unexpected link')
        if path.is_file() and path.name != '.dior-source.json':
            values[path.relative_to(root).as_posix()] = check_file(path)
    return values


def checked_receipt(root, key, expected):
    receipt = root / '.dior-source.json'
    if not receipt.is_file():
        raise ValueError('Refusing an unmanaged generated source tree')
    data = json.loads(receipt.read_text(encoding='utf-8'))
    if data.get(key) != expected or data.get('files') != tree_hashes(root):
        raise ValueError('Generated source receipt/hash mismatch; use a fresh --out')


def git_output(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args])


def check_sherpa(source):
    commit = git_output(source, 'rev-parse', 'HEAD').decode().strip()
    if commit != LOCK['sherpa']['commit']:
        raise ValueError('Sherpa HEAD differs from the pinned commit')
    # Git blobs are checked directly. Working-tree edits are never copied.
    for relative, expected in LOCK['sherpa']['recipes'].items():
        blob = git_output(source, 'show', commit + ':' + relative)
        if hashlib.sha256(blob).hexdigest() != expected:
            raise ValueError('Pinned upstream recipe SHA mismatch: ' + relative)
    return commit


def check_ndk(archive, host_tag, supplied_sha):
    record = LOCK['ndk'][host_tag]
    if archive.stat().st_size != record['bytes']:
        raise ValueError('NDK archive size differs from official r17c')
    actual = check_file(archive, record.get('sha256') or supplied_sha)
    if not record.get('sha256') and not supplied_sha:
        raise ValueError('Provide --ndk-zip-sha256 for this not-yet-qualified host archive')
    if sha(archive, 'sha1') != record['official_sha1']:
        raise ValueError('NDK archive differs from the official r17c SHA1')
    return actual


def dependency_inputs(args):
    overrides = {}
    for value in args.dep_archive:
        name, separator, location = value.partition('=')
        if not separator or name not in {item['name'] for item in LOCK['archives']} or name in overrides:
            raise ValueError('--dep-archive must be a unique locked name=path')
        overrides[name] = path_arg(location)
    result = {}
    missing = []
    for item in LOCK['archives']:
        path = overrides.get(item['name'], args.archive_cache / item['filename'])
        if path.exists():
            check_file(path, item['sha256'])
        else:
            missing.append(item['name'])
        result[item['name']] = path
    if missing and not args.download:
        raise ValueError('Missing dependency archives; supply --dep-archive or opt in with --download: ' + ', '.join(missing))
    return result


def download(item, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + '.partial')
    with urllib.request.urlopen(item['url'], timeout=60) as response, temporary.open('wb') as handle:
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > 512 * 1024 * 1024:
                raise ValueError('Dependency download exceeds byte budget')
            handle.write(chunk)
    check_file(temporary, item['sha256'])
    os.replace(temporary, destination)


def archive_entries(path, data=None):
    if path is not None and path.suffix == '.zip':
        with zipfile.ZipFile(path) as archive:
            for item in archive.infolist():
                mode = item.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise ValueError('Dependency archive links are not accepted')
                yield item.filename, item.is_dir(), None if item.is_dir() else archive.read(item), mode
    else:
        with tarfile.open(path, 'r:*') if path is not None else tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
            members = archive.getmembers()
            if len(members) > 30000:
                raise ValueError('Too many source archive entries')
            by_name = {item.name:item for item in members}
            for item in members:
                source = item
                if item.issym() or item.islnk():
                    # Three pinned upstream Kotlin aliases are symlinks. Copy the
                    # internal regular target; never create a filesystem link.
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(item.name), item.linkname)
                                               if item.issym() else item.linkname)
                    if item.linkname.startswith('/') or target.startswith('../') or target == '..':
                        raise ValueError('Source archive link escaped its root')
                    source = by_name.get(target)
                    if source is None or not source.isfile():
                        raise ValueError('Source archive link must name an internal regular file')
                elif not item.isdir() and not item.isfile():
                    raise ValueError('Source archive devices/special files are not accepted')
                yield item.name, item.isdir(), None if item.isdir() else archive.extractfile(source).read(), source.mode


def extract_owned(path, destination, data=None, remove_top=True):
    if destination.exists():
        raise ValueError('Generated source destination already exists; use a fresh --out directory')
    destination.mkdir(parents=True)
    count = total = 0
    top = None
    seen = set()
    for name, directory, content, mode in archive_entries(path, data):
        parts = PurePosixPath(name.rstrip('/')).parts
        if not parts or parts[0] == '/' or any(part in ('.', '..') for part in parts):
            raise ValueError('Unsafe archive path')
        if '\\' in name or ':' in name:
            raise ValueError('Non-portable archive path')
        if remove_top:
            if top is None:
                top = parts[0]
            if parts[0] != top:
                raise ValueError('Dependency archive must have one root directory')
            parts = parts[1:]
        if not parts:
            continue
        relative = '/'.join(parts)
        if relative in seen:
            raise ValueError('Duplicate archive path')
        seen.add(relative)
        target = destination.joinpath(*parts)
        if not target.resolve().is_relative_to(destination.resolve()):
            raise ValueError('Archive target escaped its generated directory')
        count += 1
        total += len(content) if content is not None else 0
        if count > 30000 or total > 1024 * 1024 * 1024:
            raise ValueError('Source extraction budget exceeded')
        if directory:
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(0o755 if mode & 0o111 else 0o644)


def prepare_sources(args, dependencies):
    source = args.out / 'sherpa-source'
    receipt = source / '.dior-source.json'
    if not source.exists():
        extract_owned(None, source, git_output(args.sherpa_source, 'archive', LOCK['sherpa']['commit']), remove_top=False)
        changed = []
        for path in (source / 'sherpa-ncnn/csrc').iterdir():
            if path.suffix not in ('.cc', '.h'):
                continue
            original = path.read_text(encoding='utf-8')
            edited = original.replace('#if __ANDROID_API__ >= 9\n', '#if __ANDROID_API__ >= 9 && !defined(DIOR_NO_ANDROID_ASSETS)\n')
            if edited != original:
                path.write_text(edited, encoding='utf-8', newline='\n')
                changed.append(path.relative_to(source).as_posix())
        if len(changed) != 19:
            raise ValueError('Expected exactly 19 checked API19 APK asset guards')
        write_json(receipt, {'commit': LOCK['sherpa']['commit'], 'asset_guard_files': changed, 'files': tree_hashes(source)})
    else:
        checked_receipt(source, 'commit', LOCK['sherpa']['commit'])
    roots = {}
    for item in LOCK['archives']:
        destination = args.out / 'dependency-sources' / item['name']
        dep_receipt = destination / '.dior-source.json'
        archive = dependencies[item['name']]
        if not archive.exists():
            download(item, archive)
        check_file(archive, item['sha256'])
        if not destination.exists():
            extract_owned(archive, destination)
            if item['name'] == 'ncnn':
                cmake = destination / 'src/CMakeLists.txt'
                cmake.write_text(''.join(line for line in cmake.read_text(encoding='utf-8').splitlines(True)
                                         if 'ncnn PROPERTIES VERSION' not in line), encoding='utf-8', newline='\n')
            if item['name'] == 'kaldi_native_fbank':
                check_file(destination / 'cmake/kissfft.cmake', 'f6038500a227a48df0e309b9490bd9c8cec8ee376008d7211e3fc96f0c689580')
            write_json(dep_receipt, {'archive_sha256': item['sha256'], 'files': tree_hashes(destination)})
        else:
            checked_receipt(destination, 'archive_sha256', item['sha256'])
        roots[item['name']] = destination
    return source, roots


def tool_layout(args):
    suffix = '.exe' if args.host_tag.startswith('windows') else ''
    gcc = args.gcc_root or args.ndk_root / 'toolchains/arm-linux-androideabi-4.9/prebuilt' / args.host_tag
    llvm = args.ndk_root / 'toolchains/llvm/prebuilt' / args.host_tag
    stl = args.stl_root or args.ndk_root / 'sources/cxx-stl/llvm-libc++'
    return {'clang': args.clang or llvm / ('bin/clang' + suffix), 'gcc': gcc,
            'ld': gcc / ('bin/arm-linux-androideabi-ld' + suffix),
            'link': gcc / ('bin/arm-linux-androideabi-gcc' + suffix),
            'ar': gcc / ('bin/arm-linux-androideabi-ar' + suffix),
            'ranlib': gcc / ('bin/arm-linux-androideabi-ranlib' + suffix),
            'strip': gcc / ('bin/arm-linux-androideabi-strip' + suffix),
            'readelf': gcc / ('bin/arm-linux-androideabi-readelf' + suffix),
            'omp': args.omp or llvm / 'lib64/clang/6.0.2/lib/linux/arm/libomp.a',
            'atomic': args.atomic or gcc / 'arm-linux-androideabi/lib/armv7-a/libatomic.a',
            'stl': stl, 'libcxxabi': args.libcxxabi or args.ndk_root / 'sources/cxx-stl/llvm-libc++abi'}


def check_tools_against_zip(args, tools):
    stock = tool_layout(argparse.Namespace(**{**vars(args), 'clang': None, 'gcc_root': None, 'stl_root': None,
                                               'omp': None, 'atomic': None, 'libcxxabi': None}))
    pairs = [(tools[name], stock[name]) for name in ('clang', 'link', 'ld', 'ar', 'ranlib', 'strip', 'readelf', 'omp', 'atomic')]
    for name in ('libc++_static.a', 'libc++abi.a', 'libandroid_support.a', 'libunwind.a'):
        pairs.append((tools['stl'] / 'libs/armeabi-v7a' / name, stock['stl'] / 'libs/armeabi-v7a' / name))
    with zipfile.ZipFile(args.ndk_zip) as archive:
        for actual, expected in pairs:
            member = 'android-ndk-r17c/' + expected.relative_to(args.ndk_root).as_posix()
            with archive.open(member) as handle:
                value = hashlib.sha256()
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    value.update(chunk)
            check_file(actual, value.hexdigest())
    version = subprocess.check_output([str(tools['clang']), '--version'], text=True)
    if '6.0.2' not in version:
        raise ValueError('Expected the qualified NDK r17c Clang 6.0.2')


def common_flags(args, tools):
    return ['-O3', '-DNDEBUG', '-D__ANDROID_API__=19', '-DDIOR_NO_ANDROID_ASSETS=1', '-D_GNU_SOURCE', '-D_XOPEN_SOURCE=600',
            '-march=armv7-a', '-mfloat-abi=softfp', '-mfpu=neon-vfpv4', '-fPIC',
            '--sysroot=' + q(args.ndk_root / 'platforms/android-19/arch-arm'),
            '-isystem', q(args.ndk_root / 'sources/android/support/include'),
            '-isystem', q(args.ndk_root / 'sysroot/usr/include'),
            '-isystem', q(args.ndk_root / 'sysroot/usr/include/arm-linux-androideabi'),
            '-I', q(tools['stl'] / 'include'), '-I', q(tools['libcxxabi'] / 'include'),
            '-include', q(args.source_root / 'dior-api19-compat.h')]


def checked_libs(directory, manifest_path):
    data = json.loads(manifest_path.read_text(encoding='utf-8'))
    if data.get('commit', data.get('source_commit')) != LOCK['sherpa']['commit']:
        raise ValueError('Static libraries must have pinned Sherpa provenance')
    values = data.get('archives', data.get('libraries', {}))
    hashes = {PureWindowsPath(name).name: value for name, value in values.items()}
    if set(hashes) != set(LOCK['libraries']):
        raise ValueError('Expected exactly the eight qualified static libraries')
    files = []
    for name in LOCK['libraries']:
        path = directory / name
        check_file(path, hashes[name])
        files.append(path)
    return files


def commands(args, tools, source, dep_roots):
    flags = common_flags(args, tools)
    libraries = args.libs_dir or args.out / 'libraries/lib'
    plan = []
    if args.mode != 'wrappers':
        cmake_flags = flags + ['--gcc-toolchain=' + q(tools['gcc']), '-fuse-ld=' + q(tools['ld'])]
        configure = [args.cmake, '-S', str(source), '-B', str(args.out / 'libraries'), '-G', 'Ninja',
                     '-DCMAKE_MAKE_PROGRAM=' + q(args.ninja), '-DCMAKE_TOOLCHAIN_FILE=' + q(args.out / 'dior-toolchain.cmake'),
                     '-DCMAKE_C_FLAGS=' + flag_string(cmake_flags), '-DCMAKE_CXX_FLAGS=' + flag_string(cmake_flags),
                     '-DCMAKE_CXX_STANDARD=14', '-DBUILD_SHARED_LIBS=OFF', '-DSHERPA_NCNN_ENABLE_C_API=ON',
                     '-DSHERPA_NCNN_ENABLE_BINARY=OFF', '-DSHERPA_NCNN_ENABLE_PORTAUDIO=OFF', '-DSHERPA_NCNN_ENABLE_JNI=OFF',
                     '-DSHERPA_NCNN_ENABLE_GENERATE_INT8_SCALE_TABLE=OFF', '-DNCNN_VULKAN=OFF', '-DNCNN_PLATFORM_API=OFF',
                     '-DNCNN_ARM82=OFF', '-DNCNN_ARM84=OFF', '-DKALDIFST_BUILD_PYTHON=OFF', '-DKALDIFST_BUILD_TESTS=OFF',
                     '-DOpenMP_CXX_FLAGS=-fopenmp', '-DOpenMP_CXX_LIB_NAMES=omp', '-DOpenMP_C_FLAGS=-fopenmp',
                     '-DOpenMP_C_LIB_NAMES=omp', '-DOpenMP_omp_LIBRARY=' + q(tools['omp'])]
        for name, root in dep_roots.items():
            configure.append('-DFETCHCONTENT_SOURCE_DIR_' + name.upper() + '=' + q(root))
        plan += [('configure', configure), ('libraries', [args.cmake, '--build', str(args.out / 'libraries'),
                                                        '--target', 'sherpa-ncnn-c-api', '-j', str(args.jobs)])]
    if args.mode != 'libraries':
        plan.append(('compat', [tools['clang'], '-target', TARGET, *flags, '-std=c11', '-c',
                                args.source_root / 'dior-api19-compat.c', '-o', args.out / 'compat.o']))
        names = ('worker', 'benchmark') if args.wrapper == 'both' else (args.wrapper,)
        for name in names:
            plan.append((name + '-compile', [tools['clang'], '-target', TARGET, *flags,
                                             '-std=c++14' if name == 'worker' else '-std=c++17',
                                             '-I', source, '-I', dep_roots['json'] / 'single_include', '-c',
                                             args.source_root / ('stream-' + name + '.cpp'), '-o', args.out / (name + '.o')]))
            libs = [libraries / name for name in LOCK['libraries']]
            stl = [tools['stl'] / 'libs/armeabi-v7a' / name for name in
                   ('libc++_static.a', 'libc++abi.a', 'libandroid_support.a', 'libunwind.a')]
            plan.append((name + '-link', [tools['link'], *flags, '-pie', '-Wl,--hash-style=sysv',
                                          '-Wl,--dynamic-linker,' + INTERPRETER, args.out / (name + '.o'), args.out / 'compat.o',
                                          '-Wl,--start-group', *libs, tools['omp'], tools['atomic'], *stl,
                                          '-Wl,--end-group', '-lm', '-ldl', '-llog', '-o', args.out / ('stream-' + name)]))
            plan.append((name + '-strip', [tools['strip'], '--strip-debug', args.out / ('stream-' + name)]))
    return [(name, [str(arg) for arg in command]) for name, command in plan]


def initialize_output(args):
    if args.out == args.sherpa_source or args.out == args.source_root or args.out == args.ndk_root:
        raise ValueError('Output must differ from all source/toolchain roots')
    if args.out.is_relative_to(args.sherpa_source) or args.out.is_relative_to(args.source_root) or args.out.is_relative_to(args.ndk_root):
        raise ValueError('Output cannot be nested in an input source/toolchain root')
    marker = args.out / '.dior-build-owner.json'
    if args.out.exists() and any(args.out.iterdir()) and not marker.is_file():
        raise ValueError('Refusing an existing nonempty unmanaged output directory')
    args.out.mkdir(parents=True, exist_ok=True)
    signature = hashlib.sha256(json.dumps({'ndk':q(args.ndk_root),'src':q(args.source_root),
                                          'sherpa':q(args.sherpa_source),'host':args.host_tag,
                                          'tools':{key:q(value) for key,value in tool_layout(args).items()}}, sort_keys=True).encode()).hexdigest()
    if marker.exists() and (json.loads(marker.read_text(encoding='utf-8')).get('commit') != LOCK['sherpa']['commit']
                            or json.loads(marker.read_text(encoding='utf-8')).get('configuration_sha256') != signature):
        raise ValueError('Use a fresh output directory for a changed source commit')
    write_json(marker, {'kind': 'dior-asr-generated-build-v1', 'commit': LOCK['sherpa']['commit'], 'configuration_sha256':signature})


def execute(args, tools, dependencies):
    initialize_output(args)
    check_tools_against_zip(args, tools)
    source, roots = prepare_sources(args, dependencies)
    if args.mode == 'wrappers':
        if args.libs_dir is None or args.libs_manifest is None:
            raise ValueError('Wrapper mode requires --libs-dir and --libs-manifest')
        checked_libs(args.libs_dir, args.libs_manifest)
    toolchain = ['set(CMAKE_SYSTEM_NAME Linux)', 'set(CMAKE_SYSTEM_PROCESSOR arm)',
                 'set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)']
    for variable, tool in (('CMAKE_C_COMPILER', 'clang'), ('CMAKE_CXX_COMPILER', 'clang'), ('CMAKE_AR', 'ar'), ('CMAKE_RANLIB', 'ranlib')):
        toolchain.append('set(' + variable + ' "' + q(tools[tool]) + '")')
    toolchain += ['set(CMAKE_C_COMPILER_TARGET ' + TARGET + ')', 'set(CMAKE_CXX_COMPILER_TARGET ' + TARGET + ')']
    (args.out / 'dior-toolchain.cmake').write_text('\n'.join(toolchain) + '\n', encoding='utf-8')
    libraries_record = args.out / 'LIBRARIES.json'
    for name, command in commands(args, tools, source, roots):
        print('Running ' + name, flush=True)
        with (args.out / (name + '.log')).open('w', encoding='utf-8') as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(name + ' failed; inspect the local generated log')
        if name == 'libraries':
            write_json(libraries_record, {'commit': LOCK['sherpa']['commit'], 'gpu_used': False,
                                         'archives': {name: check_file(args.out / 'libraries/lib' / name) for name in LOCK['libraries']}})
    if args.mode == 'libraries':
        print('Static library build completed; no wrapper/native execution requested')
        return
    outputs = {}
    for name in (('worker', 'benchmark') if args.wrapper == 'both' else (args.wrapper,)):
        binary = args.out / ('stream-' + name)
        proof = subprocess.check_output([str(tools['readelf']), '-h', '-l', '-d', str(binary)], text=True)
        needed = re.findall(r'Shared library: \[([^\]]+)\]', proof)
        if set(needed) != {'libm.so', 'libdl.so', 'liblog.so', 'libc.so'} or INTERPRETER not in proof:
            raise ValueError('Unexpected ELF interpreter or dynamic dependencies')
        (args.out / (name + '-ELF-PROOF.txt')).write_text(proof, encoding='utf-8')
        outputs[binary.name] = {'bytes': binary.stat().st_size, 'sha256': check_file(binary),
                                'needed_libraries': needed, 'interpreter': INTERPRETER}
    write_json(args.out / 'BUILD.json', {'commit': LOCK['sherpa']['commit'], 'backend': 'CPU_NEON_OPENMP',
                                       'gpu_used': False, 'ndk_zip_sha256': sha(args.ndk_zip), 'outputs': outputs,
                                       'phone_execution_verified': False, 'prior_output_hash_match': {
                                           name: item['sha256'] == LOCK['prior_outputs'].get(name) for name, item in outputs.items()}})
    print('Build and ELF checks completed; phone execution still requires separate verification')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sherpa-source', default=os.environ.get('DIOR_SHERPA_SOURCE'), type=path_arg)
    parser.add_argument('--source-root', default=HERE.parent / 'src', type=path_arg)
    parser.add_argument('--out', default=os.environ.get('DIOR_ASR_BUILD_DIR'), type=path_arg)
    parser.add_argument('--ndk-root', default=os.environ.get('DIOR_NDK_ROOT'), type=path_arg)
    parser.add_argument('--ndk-zip', default=os.environ.get('DIOR_NDK_ZIP'), type=path_arg)
    parser.add_argument('--ndk-zip-sha256', default=os.environ.get('DIOR_NDK_ZIP_SHA256'))
    parser.add_argument('--host-tag', choices=('windows-x86_64', 'linux-x86_64', 'darwin-x86_64'),
                        default={'Windows':'windows-x86_64','Linux':'linux-x86_64','Darwin':'darwin-x86_64'}.get(platform.system(),'windows-x86_64'))
    parser.add_argument('--cmake', default=os.environ.get('DIOR_CMAKE', 'cmake'))
    parser.add_argument('--ninja', default=os.environ.get('DIOR_NINJA', 'ninja'))
    for option in ('clang', 'gcc-root', 'stl-root', 'libcxxabi', 'omp', 'atomic', 'archive-cache', 'libs-dir', 'libs-manifest'):
        parser.add_argument('--' + option, type=path_arg)
    parser.add_argument('--dep-archive', action='append', default=[], metavar='NAME=PATH')
    parser.add_argument('--download', action='store_true', help='Opt in to downloading missing SHA-pinned dependency archives')
    parser.add_argument('--mode', choices=('all', 'libraries', 'wrappers'), default='all')
    parser.add_argument('--wrapper', choices=('worker', 'benchmark', 'both'), default='both')
    parser.add_argument('--jobs', type=int, choices=range(1,33), default=4)
    parser.add_argument('--dry-run', action='store_true', help='Check inputs and print portable commands; no writes/builds/downloads')
    parser.add_argument('--verify-only', action='store_true', help='Check input hashes/provenance only; no writes/builds/downloads')
    parser.add_argument('--print-lock', action='store_true')
    args = parser.parse_args()
    if args.print_lock:
        print(json.dumps(LOCK, indent=2));return
    for name in ('sherpa_source', 'out', 'ndk_root', 'ndk_zip'):
        if getattr(args, name) is None:
            parser.error('--' + name.replace('_','-') + ' or its documented environment variable is required')
    args.archive_cache = args.archive_cache or args.out / 'downloads'
    check_sherpa(args.sherpa_source)
    ndk_hash = check_ndk(args.ndk_zip, args.host_tag, args.ndk_zip_sha256)
    for name, expected in LOCK['sources'].items():
        check_file(args.source_root / name, expected)
    dependencies = dependency_inputs(args)
    if args.mode == 'wrappers':
        if args.libs_dir is None or args.libs_manifest is None:
            parser.error('Wrapper mode needs --libs-dir and --libs-manifest')
        checked_libs(args.libs_dir, args.libs_manifest)
    tools = tool_layout(args)
    if args.verify_only or args.dry_run:
        if args.verify_only and any(not path.exists() for path in dependencies.values()):
            raise ValueError('--verify-only requires all archives already present')
        report = {'status':'INPUTS_VERIFIED','scope':'No compiler invocation, no output writes, no native execution',
                  'source_commit':LOCK['sherpa']['commit'],'ndk_zip_sha256':ndk_hash,'model_or_sdk_included':False,
                  'dependency_archives_present':sum(path.exists() for path in dependencies.values()),
                  'toolchain_root_files_verified':False,'compiled':False}
        if args.dry_run:
            roots = {item['name']:args.out / 'dependency-sources' / item['name'] for item in LOCK['archives']}
            substitutions = [(q(args.out),'<OUT>'),(q(args.source_root),'<SRC>'),(q(args.ndk_root),'<NDK>')]
            def portable(value):
                value=q(value)
                for old,new in substitutions:value=value.replace(old,new)
                return value
            report['commands']=[{'phase':name,'argv':[portable(value) for value in argv]}
                                for name,argv in commands(args,tools,args.out/'sherpa-source',roots)]
        print(json.dumps(report,indent=2));return
    execute(args,tools,dependencies)


if __name__ == '__main__':
    main()

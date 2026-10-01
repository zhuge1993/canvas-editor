#!/usr/bin/env python3
"""Render and read pixels with GLES2; never classify a software renderer as GPU.

Run on the phone: python3 dior-gles-probe.py --all --software-control
Each EGL route runs in a bounded subprocess because incompatible old kernel /
new Mesa combinations can abort in native code. No framebuffer is changed.
"""
import argparse
import ctypes as C
import ctypes.util
import glob
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

EGL_NONE = 0x3038
EGL_OPENGL_ES_API = 0x30A0
EGL_RENDERABLE_TYPE = 0x3040
EGL_OPENGL_ES2_BIT = 4
EGL_SURFACE_TYPE = 0x3033
EGL_PBUFFER_BIT = 1
EGL_CONTEXT_CLIENT_VERSION = 0x3098
EGL_WIDTH, EGL_HEIGHT = 0x3057, 0x3056
EGL_VENDOR, EGL_VERSION, EGL_EXTENSIONS = 0x3053, 0x3054, 0x3055
EGL_PLATFORM_GBM_KHR, EGL_PLATFORM_SURFACELESS_MESA = 0x31D7, 0x31DD
GL_RGBA, GL_UNSIGNED_BYTE, GL_TEXTURE_2D = 0x1908, 0x1401, 0x0DE1
GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_FRAMEBUFFER_COMPLETE = 0x8D40, 0x8CE0, 0x8CD5
GL_COLOR_BUFFER_BIT, GL_TRIANGLES, GL_FLOAT = 0x4000, 4, 0x1406
GL_VERTEX_SHADER, GL_FRAGMENT_SHADER = 0x8B31, 0x8B30
GL_COMPILE_STATUS, GL_LINK_STATUS, GL_INFO_LOG_LENGTH = 0x8B81, 0x8B82, 0x8B84
GL_VENDOR, GL_RENDERER, GL_VERSION = 0x1F00, 0x1F01, 0x1F02
SOFTWARE_NAMES = ("llvmpipe", "softpipe", "swrast", "software", "swiftshader", "lavapipe")


class ProbeError(RuntimeError):
    pass


def library(name):
    # musl systems can lack ldconfig and development-package .so symlinks.
    sonames = {"EGL": "libEGL.so.1", "GLESv2": "libGLESv2.so.2",
               "gbm": "libgbm.so.1", "drm": "libdrm.so.2"}
    errors = []
    for candidate in dict.fromkeys((C.util.find_library(name), sonames.get(name), "lib" + name + ".so")):
        if not candidate:
            continue
        try:
            return C.CDLL(candidate)
        except OSError as exc:
            errors.append(str(exc))
    raise OSError("cannot load %s: %s" % (name, "; ".join(errors)))


def api(lib, name, restype, *argtypes):
    fn = getattr(lib, name)
    fn.restype = restype
    fn.argtypes = list(argtypes)
    return fn


def decode(value):
    return value.decode("utf-8", "replace") if value else None


def inventory():
    result = {"kernel": os.uname().release, "nodes": [], "libraries": {}, "drm_versions": []}
    for name in ("EGL", "GLESv2", "gbm", "drm"):
        result["libraries"][name] = C.util.find_library(name)
    for path in sorted(set(glob.glob("/dev/dri/*") + glob.glob("/dev/kgsl-*"))):
        try:
            stat = os.stat(path)
            result["nodes"].append({"path": path, "major": os.major(stat.st_rdev),
                                    "minor": os.minor(stat.st_rdev), "mode": oct(stat.st_mode & 0o777)})
        except OSError as exc:
            result["nodes"].append({"path": path, "error": str(exc)})
    # A kgsl_dri.so alias only proves a loader entry exists, not a KGSL backend.
    result["kgsl_dri_alias"] = str(Path("/usr/lib/dri/kgsl_dri.so").resolve())
    try:
        class DRMVersion(C.Structure):
            _fields_ = [("major", C.c_int), ("minor", C.c_int), ("patch", C.c_int),
                        ("name_len", C.c_int), ("name", C.c_char_p),
                        ("date_len", C.c_int), ("date", C.c_char_p),
                        ("desc_len", C.c_int), ("desc", C.c_char_p)]
        drm = library("drm")
        get = api(drm, "drmGetVersion", C.POINTER(DRMVersion), C.c_int)
        free = api(drm, "drmFreeVersion", None, C.POINTER(DRMVersion))
        for path in sorted(glob.glob("/dev/dri/card*") + glob.glob("/dev/dri/renderD*")):
            fd = -1
            try:
                fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
                value = get(fd)
                if value:
                    info = value.contents
                    result["drm_versions"].append({"path": path, "name": decode(info.name),
                                                    "version": [info.major, info.minor, info.patch]})
                    free(value)
                else:
                    result["drm_versions"].append({"path": path, "error": "drmGetVersion failed"})
            except OSError as exc:
                result["drm_versions"].append({"path": path, "error": str(exc)})
            finally:
                if fd >= 0:
                    os.close(fd)
    except (OSError, AttributeError) as exc:
        result["drm_query_error"] = str(exc)
    return result


def render(route, node):
    start = time.monotonic()
    result = {"route": route, "node": node, "status": "FAIL", "render_pass": False,
              "hardware_render_pass": False, "software_renderer": None}
    display, surface, context = None, None, None
    fd, gbm_device, gbm = -1, None, None
    egl = library("EGL")
    gl = library("GLESv2")
    ptr, integer, uint, boolean = C.c_void_p, C.c_int, C.c_uint, C.c_uint
    get_error = api(egl, "eglGetError", integer)
    initialize = api(egl, "eglInitialize", boolean, ptr, C.POINTER(integer), C.POINTER(integer))
    query = api(egl, "eglQueryString", C.c_char_p, ptr, integer)
    get_proc = api(egl, "eglGetProcAddress", ptr, C.c_char_p)
    choose = api(egl, "eglChooseConfig", boolean, ptr, C.POINTER(integer), C.POINTER(ptr), integer,
                 C.POINTER(integer))
    bind = api(egl, "eglBindAPI", boolean, uint)
    create_context = api(egl, "eglCreateContext", ptr, ptr, ptr, ptr, C.POINTER(integer))
    create_pbuffer = api(egl, "eglCreatePbufferSurface", ptr, ptr, ptr, C.POINTER(integer))
    make_current = api(egl, "eglMakeCurrent", boolean, ptr, ptr, ptr, ptr)
    destroy_context = api(egl, "eglDestroyContext", boolean, ptr, ptr)
    destroy_surface = api(egl, "eglDestroySurface", boolean, ptr, ptr)
    terminate = api(egl, "eglTerminate", boolean, ptr)

    def require(ok, operation):
        if not ok:
            raise ProbeError("%s failed; EGL error=0x%04x" % (operation, get_error()))

    try:
        result["client_extensions"] = decode(query(None, EGL_EXTENSIONS))
        address = get_proc(b"eglGetPlatformDisplayEXT")
        if not address:
            raise ProbeError("eglGetPlatformDisplayEXT unavailable")
        platform_display = C.CFUNCTYPE(ptr, uint, ptr, C.POINTER(integer))(address)
        empty = (integer * 1)(EGL_NONE)
        if route == "gbm":
            fd = os.open(node, os.O_RDWR | os.O_CLOEXEC)
            gbm = library("gbm")
            create_gbm = api(gbm, "gbm_create_device", ptr, integer)
            gbm_device = create_gbm(fd)
            if not gbm_device:
                raise ProbeError("gbm_create_device returned NULL")
            backend_name = api(gbm, "gbm_device_get_backend_name", C.c_char_p, ptr)
            result["gbm_backend"] = decode(backend_name(gbm_device))
            display = platform_display(EGL_PLATFORM_GBM_KHR, gbm_device, empty)
        else:
            display = platform_display(EGL_PLATFORM_SURFACELESS_MESA, None, empty)
        require(display, "eglGetPlatformDisplayEXT")
        major, minor = integer(), integer()
        require(initialize(display, C.byref(major), C.byref(minor)), "eglInitialize")
        result["egl_version"] = [major.value, minor.value]
        result["egl_vendor"] = decode(query(display, EGL_VENDOR))
        result["egl_version_string"] = decode(query(display, EGL_VERSION))
        result["egl_extensions"] = decode(query(display, EGL_EXTENSIONS)) or ""
        require(bind(EGL_OPENGL_ES_API), "eglBindAPI")
        config, count = ptr(), integer()
        pbuffer_config = (integer * 13)(EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
            EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, EGL_NONE)
        ok = choose(display, pbuffer_config, C.byref(config), 1, C.byref(count))
        if ok and count.value:
            size = (integer * 5)(EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE)
            surface = create_pbuffer(display, config, size)
            require(surface, "eglCreatePbufferSurface")
            result["surface"] = "16x16 pbuffer"
        else:
            # GBM often exposes window configs only. A surfaceless GLES2 FBO is
            # still a real rendering target and does not touch the LCD.
            attrs = (integer * 5)(EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE, 0, EGL_NONE)
            require(choose(display, attrs, C.byref(config), 1, C.byref(count)) and count.value,
                    "eglChooseConfig (surfaceless)")
            if "EGL_KHR_surfaceless_context" not in result["egl_extensions"].split():
                raise ProbeError("no pbuffer or EGL_KHR_surfaceless_context")
            result["surface"] = "surfaceless context / 16x16 FBO"
        context_attributes = (integer * 3)(EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE)
        context = create_context(display, config, None, context_attributes)
        require(context, "eglCreateContext ES2")
        require(make_current(display, surface, surface, context), "eglMakeCurrent")
        get_string = api(gl, "glGetString", C.c_char_p, uint)
        result["gl_vendor"] = decode(get_string(GL_VENDOR))
        result["gl_renderer"] = decode(get_string(GL_RENDERER))
        result["gl_version"] = decode(get_string(GL_VERSION))
        if not result["gl_renderer"]:
            raise ProbeError("GL renderer absent")
        result["software_renderer"] = any(name in result["gl_renderer"].lower() for name in SOFTWARE_NAMES)
        result["recognized_adreno_renderer"] = bool(re.search(
            r"adreno|freedreno|\bfd[0-9]{3}\b", result["gl_renderer"], re.IGNORECASE))
        get_gl_error = api(gl, "glGetError", uint)

        def checked(operation):
            error = get_gl_error()
            if error:
                raise ProbeError("%s GL error=0x%04x" % (operation, error))

        gen_tex = api(gl, "glGenTextures", None, integer, C.POINTER(uint))
        bind_tex = api(gl, "glBindTexture", None, uint, uint)
        tex_image = api(gl, "glTexImage2D", None, uint, integer, integer, integer, integer,
                        integer, uint, uint, ptr)
        tex_param = api(gl, "glTexParameteri", None, uint, uint, integer)
        gen_fb = api(gl, "glGenFramebuffers", None, integer, C.POINTER(uint))
        bind_fb = api(gl, "glBindFramebuffer", None, uint, uint)
        attach = api(gl, "glFramebufferTexture2D", None, uint, uint, uint, uint, integer)
        fb_status = api(gl, "glCheckFramebufferStatus", uint, uint)
        viewport = api(gl, "glViewport", None, integer, integer, integer, integer)
        clear_color = api(gl, "glClearColor", None, C.c_float, C.c_float, C.c_float, C.c_float)
        clear = api(gl, "glClear", None, uint)
        finish = api(gl, "glFinish", None)
        read = api(gl, "glReadPixels", None, integer, integer, integer, integer, uint, uint, ptr)
        texture, framebuffer = uint(), uint()
        gen_tex(1, C.byref(texture)); bind_tex(GL_TEXTURE_2D, texture)
        for parameter in (0x2801, 0x2800):
            tex_param(GL_TEXTURE_2D, parameter, 0x2600)
        tex_image(GL_TEXTURE_2D, 0, GL_RGBA, 16, 16, 0, GL_RGBA, GL_UNSIGNED_BYTE, None)
        gen_fb(1, C.byref(framebuffer)); bind_fb(GL_FRAMEBUFFER, framebuffer)
        attach(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0)
        state = fb_status(GL_FRAMEBUFFER)
        if state != GL_FRAMEBUFFER_COMPLETE:
            raise ProbeError("FBO incomplete: 0x%04x" % state)
        viewport(0, 0, 16, 16)
        checked("FBO setup")
        result["clear_checks"] = []
        for color in ((1, 0, 0, 1), (0, 0, 1, 1), (1, 1, 1, 1)):
            clear_color(*color); clear(GL_COLOR_BUFFER_BIT); finish()
            pixels = (C.c_ubyte * (16 * 16 * 4))()
            read(0, 0, 16, 16, GL_RGBA, GL_UNSIGNED_BYTE, pixels)
            checked("glClear/glReadPixels")
            expected = [int(value * 255) for value in color]
            worst = max(abs(pixels[i] - expected[i % 4]) for i in range(len(pixels)))
            result["clear_checks"].append({"expected_rgba": expected, "max_channel_error": worst})
            if worst > 2:
                raise ProbeError("clear/read pixels mismatch: max error %d" % worst)
        shader_create = api(gl, "glCreateShader", uint, uint)
        shader_source = api(gl, "glShaderSource", None, uint, integer, C.POINTER(C.c_char_p), C.POINTER(integer))
        shader_compile = api(gl, "glCompileShader", None, uint)
        shader_status = api(gl, "glGetShaderiv", None, uint, uint, C.POINTER(integer))
        shader_log = api(gl, "glGetShaderInfoLog", None, uint, integer, C.POINTER(integer), C.c_char_p)

        def compile_shader(kind, source):
            shader = shader_create(kind)
            text = C.c_char_p(source)
            shader_source(shader, 1, C.byref(text), None); shader_compile(shader)
            success = integer()
            shader_status(shader, GL_COMPILE_STATUS, C.byref(success))
            if not success.value:
                buffer = C.create_string_buffer(2048)
                shader_log(shader, len(buffer), None, buffer)
                raise ProbeError("shader compile: " + decode(buffer.value))
            return shader

        vertex = compile_shader(GL_VERTEX_SHADER,
            b"attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}")
        fragment = compile_shader(GL_FRAGMENT_SHADER,
            b"precision mediump float; void main(){gl_FragColor=vec4(0.0,1.0,0.0,1.0);}")
        program_create = api(gl, "glCreateProgram", uint)
        shader_attach = api(gl, "glAttachShader", None, uint, uint)
        attrib_bind = api(gl, "glBindAttribLocation", None, uint, uint, C.c_char_p)
        program_link = api(gl, "glLinkProgram", None, uint)
        program_status = api(gl, "glGetProgramiv", None, uint, uint, C.POINTER(integer))
        program_log = api(gl, "glGetProgramInfoLog", None, uint, integer, C.POINTER(integer), C.c_char_p)
        use = api(gl, "glUseProgram", None, uint)
        attrib_enable = api(gl, "glEnableVertexAttribArray", None, uint)
        attrib_pointer = api(gl, "glVertexAttribPointer", None, uint, integer, uint, C.c_ubyte, integer, ptr)
        draw = api(gl, "glDrawArrays", None, uint, integer, integer)
        program = program_create(); shader_attach(program, vertex); shader_attach(program, fragment)
        attrib_bind(program, 0, b"position"); program_link(program)
        linked = integer(); program_status(program, GL_LINK_STATUS, C.byref(linked))
        if not linked.value:
            buffer = C.create_string_buffer(2048); program_log(program, len(buffer), None, buffer)
            raise ProbeError("program link: " + decode(buffer.value))
        use(program); attrib_enable(0)
        vertices = (C.c_float * 6)(-0.8, -0.8, 0.8, -0.8, 0, 0.8)
        attrib_pointer(0, 2, GL_FLOAT, 0, 0, vertices)
        clear_color(1, 0, 0, 1); clear(GL_COLOR_BUFFER_BIT); draw(GL_TRIANGLES, 0, 3); finish()
        pixels = (C.c_ubyte * (16 * 16 * 4))()
        read(0, 0, 16, 16, GL_RGBA, GL_UNSIGNED_BYTE, pixels); checked("shader draw/glReadPixels")
        center, corner = list(pixels[(8 * 16 + 8) * 4:(8 * 16 + 8) * 4 + 4]), list(pixels[:4])
        result["triangle_check"] = {"center_rgba": center, "corner_rgba": corner,
                                     "expected_center": [0, 255, 0, 255], "expected_corner": [255, 0, 0, 255]}
        if any(abs(a-b) > 2 for actual, expect in ((center, (0,255,0,255)), (corner, (255,0,0,255)))
               for a,b in zip(actual, expect)):
            raise ProbeError("shader triangle readback mismatch")
        result["render_pass"] = True
        result["hardware_render_pass"] = (not result["software_renderer"] and
                                            result["recognized_adreno_renderer"])
        result["status"] = ("PASS_GPU" if result["hardware_render_pass"] else
                             "PASS_SOFTWARE_ONLY" if result["software_renderer"] else
                             "PASS_RENDERER_UNCLASSIFIED")
    except (OSError, AttributeError, ProbeError) as exc:
        result["error"] = str(exc)
    finally:
        if display:
            make_current(display, None, None, None)
            if context:
                destroy_context(display, context)
            if surface:
                destroy_surface(display, surface)
            terminate(display)
        if gbm_device:
            api(gbm, "gbm_device_destroy", None, ptr)(gbm_device)
        if fd >= 0:
            os.close(fd)
        result["elapsed_ms"] = round((time.monotonic() - start) * 1000)
    return result


def run_all(software_control):
    results = []
    routes = [("surfaceless", None, None)]
    for path in sorted(glob.glob("/dev/dri/card*") + glob.glob("/dev/dri/renderD*")):
        routes.append(("gbm", path, None))
    if os.path.exists("/dev/kgsl-3d0"):
        routes.append(("gbm", "/dev/kgsl-3d0", "kgsl"))
    if software_control:
        routes.append(("surfaceless", None, "software-control"))
    for route, node, override in routes:
        env = dict(os.environ)
        for name in ("MESA_LOADER_DRIVER_OVERRIDE", "LIBGL_ALWAYS_SOFTWARE", "GALLIUM_DRIVER", "EGL_PLATFORM"):
            env.pop(name, None)
        env["EGL_LOG_LEVEL"] = "debug"
        if override == "software-control":
            env["LIBGL_ALWAYS_SOFTWARE"] = "true"
        elif override:
            env["MESA_LOADER_DRIVER_OVERRIDE"] = override
        command = [sys.executable, str(Path(__file__).resolve()), "--route", route]
        if node:
            command += ["--node", node]
        try:
            done = subprocess.run(command, capture_output=True, text=True, env=env, timeout=30)
            try:
                result = json.loads(done.stdout)
            except ValueError:
                result = {"route": route, "node": node, "status": "FAIL_NATIVE_PROCESS",
                          "hardware_render_pass": False, "stdout": done.stdout[-3000:]}
            result["returncode"] = done.returncode
            result["stderr"] = done.stderr[-16000:]
        except subprocess.TimeoutExpired as exc:
            result = {"route": route, "node": node, "status": "TIMEOUT", "hardware_render_pass": False,
                      "stderr": decode(exc.stderr) if isinstance(exc.stderr, bytes) else exc.stderr}
        result["loader_override"] = override
        results.append(result)
    return {"inventory": inventory(), "attempts": results,
            "hardware_render_pass": any(item.get("hardware_render_pass") for item in results)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--software-control", action="store_true")
    parser.add_argument("--route", choices=("gbm", "surfaceless"), default="surfaceless")
    parser.add_argument("--node", default="/dev/dri/card0")
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        result = run_all(args.software_control) if args.all else render(args.route, args.node if args.route == "gbm" else None)
    except (OSError, AttributeError) as exc:
        result = {"status": "FAIL_LIBRARY_LOAD", "error": str(exc), "hardware_render_pass": False}
    data = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        Path(args.output).write_text(data, encoding="utf-8")
    print(data, end="", flush=True)
    return 0 if result.get("hardware_render_pass") else 1


if __name__ == "__main__":
    sys.exit(main())

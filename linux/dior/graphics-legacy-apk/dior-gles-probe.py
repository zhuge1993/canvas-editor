#!/usr/bin/env python3
"""Validate GLES rendering and texture shader arithmetic by reading every pixel.

Run on the phone: python3 dior-gles-probe.py --all --software-control
Repeat a known working route: --route gbm --node /dev/dri/card0 --repeat 30
Each EGL route runs in a bounded subprocess because incompatible old kernel /
new Mesa combinations can abort in native code. The LCD is never changed.
The arithmetic fixture uses GLES2 fragment shaders, not OpenCL or compute shaders.
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
GL_EXTENSIONS, GL_SHADING_LANGUAGE_VERSION = 0x1F03, 0x8B8C
GL_DITHER, GL_TEXTURE0 = 0x0BD0, 0x84C0
SOFTWARE_NAMES = ("llvmpipe", "softpipe", "swrast", "software", "swiftshader", "lavapipe")
FIXTURE_SIZE = 16
COMPUTE_SIZE = 256


def renderer_identity(renderer):
    """Require the expected GPU family; a working software fallback is not a pass."""
    renderer = renderer or ""
    software = any(name in renderer.lower() for name in SOFTWARE_NAMES)
    recognized = bool(re.search(r"adreno|freedreno|\bfd[0-9]{3}\b", renderer, re.IGNORECASE))
    return {"software_renderer": software, "recognized_adreno_renderer": recognized,
            "hardware_renderer": recognized and not software}


def context_capabilities(version, extensions):
    # Creating an ES2 context does not prove OpenCL support, and an ES3.1 version
    # does not prove a compute dispatch worked. Report those separately.
    match = re.search(r"OpenGL ES(?:-[A-Z]+)?\s+(\d+)\.(\d+)", version or "")
    parsed = [int(match.group(1)), int(match.group(2))] if match else None
    return {"gles_version": parsed, "gles_extensions": sorted(set((extensions or "").split())),
            "fragment_shader_arithmetic_api": "OpenGL ES 2.0 texture/FBO fragment shader",
            "compute_shader_api_available_by_version": bool(parsed and tuple(parsed) >= (3, 1)),
            "compute_shader_verified": False, "opencl_verified": False,
            "general_compute_api_verified": False}


def arithmetic_fixture(iteration, size=FIXTURE_SIZE):
    """RGBA8 input with an exact integer reference for add, scale and difference.

    Input rows and glReadPixels both start at the bottom. Every iteration uses
    different data, so reusing the previous framebuffer cannot satisfy the test.
    Scaled channels are multiples of four to keep the expected result integral.
    """
    first, second, expected = bytearray(), bytearray(), bytearray()
    for y in range(size):
        for x in range(size):
            a = ((3*x + 5*y + 7*iteration) % 64,
                 4*((x + 3*y + iteration) % 16), (5*x + 7*y + 3*iteration) % 64, 255)
            b = (4*((7*x + y + 2*iteration) % 16),
                 (11*x + 13*y + iteration) % 64, (9*x + 2*y + 5*iteration) % 64, 255)
            first.extend(a); second.extend(b)
            expected.extend((a[0]+b[1], a[1]//2+b[0]//4, abs(a[2]-b[2]), 255))
    return bytes(first), bytes(second), bytes(expected)


def compare_pixels(actual, expected, tolerance=1):
    if len(actual) != len(expected) or len(expected) % 4:
        raise ProbeError("readback length mismatch")
    errors = [abs(a-b) for a, b in zip(actual, expected)]
    mismatched = sum(any(errors[i+c] > tolerance for c in range(4))
                     for i in range(0, len(errors), 4))
    return {"pixel_count": len(expected)//4, "mismatched_pixels": mismatched,
            "max_channel_error": max(errors, default=0), "tolerance": tolerance,
            "pass": mismatched == 0}


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


def cleanup_resources(egl, gl, gbm, *, display=None, surface=None, context=None,
                      display_initialized=False, context_current=False,
                      programs=(), shaders=(), framebuffers=(), textures=(),
                      gbm_device=None, fd=-1):
    """Release every owned resource, retaining failures without skipping peers."""
    errors = []

    def record(operation, message):
        errors.append({"operation": operation, "error": str(message)})

    def attempt(operation, callback, egl_boolean=False):
        try:
            value = callback()
            if egl_boolean and not value:
                try:
                    code = api(egl, "eglGetError", C.c_int)()
                    record(operation, "returned EGL_FALSE; EGL error=0x%04x" % code)
                except Exception as exc:
                    record(operation, "returned EGL_FALSE; error query failed: %s" % exc)
        except Exception as exc:
            record(operation, exc)

    # A created context can exist even when eglMakeCurrent failed. GL deletion
    # is valid only after make-current succeeded; context destruction below
    # still releases resources owned by an unbound context.
    if context_current:
        for value in programs:
            attempt("glDeleteProgram", lambda value=value:
                    api(gl, "glDeleteProgram", None, C.c_uint)(value))
        for value in shaders:
            attempt("glDeleteShader", lambda value=value:
                    api(gl, "glDeleteShader", None, C.c_uint)(value))
        for name, objects in (("glDeleteFramebuffers", framebuffers), ("glDeleteTextures", textures)):
            for value in objects:
                attempt(name, lambda name=name, value=value:
                        api(gl, name, None, C.c_int, C.POINTER(C.c_uint))(1, C.byref(value)))
        try:
            get_gl_error = api(gl, "glGetError", C.c_uint)
            for _ in range(64):
                code = get_gl_error()
                if code == 0:
                    break
                record("GL object cleanup", "GL error=0x%04x" % code)
            else:
                record("GL object cleanup", "GL error queue exceeded diagnostic bound")
        except Exception as exc:
            record("glGetError after cleanup", exc)

    if display:
        if context_current:
            attempt("eglMakeCurrent detach", lambda:
                    api(egl, "eglMakeCurrent", C.c_uint, C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p)
                    (display, None, None, None), egl_boolean=True)
        if context:
            attempt("eglDestroyContext", lambda:
                    api(egl, "eglDestroyContext", C.c_uint, C.c_void_p, C.c_void_p)(display, context), egl_boolean=True)
        if surface:
            attempt("eglDestroySurface", lambda:
                    api(egl, "eglDestroySurface", C.c_uint, C.c_void_p, C.c_void_p)(display, surface), egl_boolean=True)
        if display_initialized:
            attempt("eglTerminate", lambda:
                    api(egl, "eglTerminate", C.c_uint, C.c_void_p)(display), egl_boolean=True)
    if gbm_device:
        attempt("gbm_device_destroy", lambda:
                api(gbm, "gbm_device_destroy", None, C.c_void_p)(gbm_device))
    if fd >= 0:
        attempt("os.close", lambda: os.close(fd))
    return {"cleanup_pass": not errors, "cleanup_errors": errors,
            "cleanup_error": "; ".join(item["operation"] + ": " + item["error"] for item in errors)}


def render(route, node, repeat=1):
    start = time.monotonic()
    result = {"route": route, "node": node, "status": "FAIL", "render_pass": False,
              "hardware_render_pass": False, "software_renderer": None,
              "shader_arithmetic_pass": False, "hardware_shader_arithmetic_pass": False,
              "stability_pass": False, "requested_iterations": repeat,
              "completed_iterations": 0, "cleanup_pass": False}
    display, surface, context = None, None, None
    display_initialized, context_current = False, False
    fd, gbm_device, gbm = -1, None, None
    egl = library("EGL")
    gl = library("GLESv2")
    textures, framebuffers, shaders, programs = [], [], [], []
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
        display_initialized = True
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
        context_current = True
        get_string = api(gl, "glGetString", C.c_char_p, uint)
        result["gl_vendor"] = decode(get_string(GL_VENDOR))
        result["gl_renderer"] = decode(get_string(GL_RENDERER))
        result["gl_version"] = decode(get_string(GL_VERSION))
        result["gl_shading_language_version"] = decode(get_string(GL_SHADING_LANGUAGE_VERSION))
        result.update(context_capabilities(result["gl_version"], decode(get_string(GL_EXTENSIONS))))
        if not result["gl_renderer"]:
            raise ProbeError("GL renderer absent")
        result.update(renderer_identity(result["gl_renderer"]))
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
        gen_tex(1, C.byref(texture)); textures.append(texture); bind_tex(GL_TEXTURE_2D, texture)
        for parameter in (0x2801, 0x2800):
            tex_param(GL_TEXTURE_2D, parameter, 0x2600)
        tex_image(GL_TEXTURE_2D, 0, GL_RGBA, 16, 16, 0, GL_RGBA, GL_UNSIGNED_BYTE, None)
        gen_fb(1, C.byref(framebuffer)); framebuffers.append(framebuffer); bind_fb(GL_FRAMEBUFFER, framebuffer)
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
            if not shader:
                raise ProbeError("glCreateShader returned zero")
            shaders.append(shader)
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
        def link_program(vertex_shader, fragment_shader):
            linked_program = program_create()
            if not linked_program:
                raise ProbeError("glCreateProgram returned zero")
            programs.append(linked_program)
            shader_attach(linked_program, vertex_shader); shader_attach(linked_program, fragment_shader)
            attrib_bind(linked_program, 0, b"position"); program_link(linked_program)
            linked = integer(); program_status(linked_program, GL_LINK_STATUS, C.byref(linked))
            if not linked.value:
                buffer = C.create_string_buffer(2048)
                program_log(linked_program, len(buffer), None, buffer)
                raise ProbeError("program link: " + decode(buffer.value))
            return linked_program

        program = link_program(vertex, fragment)
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
        result["hardware_render_pass"] = result["hardware_renderer"]
        if not result["hardware_renderer"]:
            result["shader_arithmetic_status"] = "SKIPPED_NO_VERIFIED_HARDWARE_RENDERER"
            result["status"] = ("PASS_SOFTWARE_ONLY" if result["software_renderer"] else
                                 "PASS_RENDERER_UNCLASSIFIED")
            return result

        # Use an independent texture input and output FBO; sampling the render
        # target itself would be undefined. Disable dithering for RGBA8 checks.
        active_texture = api(gl, "glActiveTexture", None, uint)
        uniform_location = api(gl, "glGetUniformLocation", integer, uint, C.c_char_p)
        uniform_int = api(gl, "glUniform1i", None, integer, integer)
        uniform_float = api(gl, "glUniform1f", None, integer, C.c_float)
        disable = api(gl, "glDisable", None, uint)
        disable(GL_DITHER)
        arithmetic_fragment = compile_shader(GL_FRAGMENT_SHADER, b"""
precision mediump float;
uniform sampler2D firstInput;
uniform sampler2D secondInput;
uniform float inverseSize;
void main() {
  vec2 coordinate = gl_FragCoord.xy * inverseSize;
  vec4 a = texture2D(firstInput, coordinate);
  vec4 b = texture2D(secondInput, coordinate);
  gl_FragColor = vec4(a.r+b.g, a.g*0.5+b.r*0.25, abs(a.b-b.b), 1.0);
}
""")
        arithmetic_program = link_program(vertex, arithmetic_fragment)
        use(arithmetic_program)
        for name, value in ((b"firstInput", 0), (b"secondInput", 1)):
            location = uniform_location(arithmetic_program, name)
            if location < 0:
                raise ProbeError("shader texture uniform absent: " + decode(name))
            uniform_int(location, value)
        location = uniform_location(arithmetic_program, b"inverseSize")
        if location < 0:
            raise ProbeError("shader inverseSize uniform absent")
        uniform_float(location, 1.0/COMPUTE_SIZE)
        full_quad = (C.c_float * 12)(-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1)
        attrib_pointer(0, 2, GL_FLOAT, 0, 0, full_quad)
        viewport(0, 0, COMPUTE_SIZE, COMPUTE_SIZE)
        # Resize the output attached to the existing framebuffer.
        bind_tex(GL_TEXTURE_2D, texture)
        tex_image(GL_TEXTURE_2D, 0, GL_RGBA, COMPUTE_SIZE, COMPUTE_SIZE, 0,
                  GL_RGBA, GL_UNSIGNED_BYTE, None)
        if fb_status(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE:
            raise ProbeError("arithmetic FBO incomplete")
        inputs = []
        for unit in range(2):
            input_texture = uint()
            gen_tex(1, C.byref(input_texture)); textures.append(input_texture)
            inputs.append(input_texture)
            active_texture(GL_TEXTURE0+unit); bind_tex(GL_TEXTURE_2D, input_texture)
            for parameter in (0x2801, 0x2800):
                tex_param(GL_TEXTURE_2D, parameter, 0x2600)  # NEAREST
            for parameter in (0x2802, 0x2803):
                tex_param(GL_TEXTURE_2D, parameter, 0x812F)  # CLAMP_TO_EDGE
        checked("arithmetic setup")
        result["arithmetic_checks"] = []
        result["shader_arithmetic_kind"] = "GLES2 fragment shader texture vector arithmetic"
        result["arithmetic_size"] = [COMPUTE_SIZE, COMPUTE_SIZE]
        result["timing_scope"] = "wall clock; draw+finish excludes upload/readback; not application FPS"
        for iteration in range(repeat):
            first, second, expected = arithmetic_fixture(iteration, COMPUTE_SIZE)
            upload_start = time.monotonic()
            for unit, payload in enumerate((first, second)):
                active_texture(GL_TEXTURE0+unit); bind_tex(GL_TEXTURE_2D, inputs[unit])
                buffer = (C.c_ubyte*len(payload)).from_buffer_copy(payload)
                tex_image(GL_TEXTURE_2D, 0, GL_RGBA, COMPUTE_SIZE, COMPUTE_SIZE, 0,
                          GL_RGBA, GL_UNSIGNED_BYTE, buffer)
            checked("arithmetic texture upload")
            draw_start = time.monotonic()
            draw(GL_TRIANGLES, 0, 6); finish(); checked("arithmetic draw/finish")
            read_start = time.monotonic()
            pixels = (C.c_ubyte*(COMPUTE_SIZE*COMPUTE_SIZE*4))()
            read(0, 0, COMPUTE_SIZE, COMPUTE_SIZE, GL_RGBA, GL_UNSIGNED_BYTE, pixels)
            checked("arithmetic glReadPixels")
            compare_start = time.monotonic()
            check = compare_pixels(bytes(pixels), expected)
            check.update({"iteration": iteration+1,
                          "upload_ms": round((draw_start-upload_start)*1000, 3),
                          "draw_finish_ms": round((read_start-draw_start)*1000, 3),
                          "readback_ms": round((compare_start-read_start)*1000, 3)})
            result["arithmetic_checks"].append(check)
            if not check["pass"]:
                raise ProbeError("arithmetic iteration %d: %d pixels differ from CPU reference" %
                                 (iteration+1, check["mismatched_pixels"]))
            result["completed_iterations"] += 1
        result["shader_arithmetic_pass"] = True
        result["hardware_shader_arithmetic_pass"] = True
        result["stability_pass"] = result["completed_iterations"] == repeat
        result["status"] = "PASS_GPU"
    except (OSError, AttributeError, ProbeError) as exc:
        result["error"] = str(exc)
    finally:
        result.update(cleanup_resources(egl, gl, gbm, display=display, surface=surface,
            context=context, display_initialized=display_initialized, context_current=context_current,
            programs=programs, shaders=shaders, framebuffers=framebuffers, textures=textures,
            gbm_device=gbm_device, fd=fd))
        result["elapsed_ms"] = round((time.monotonic() - start) * 1000)
    return result


def validation_pass(result):
    return (result.get("status") == "PASS_GPU" and
            result.get("hardware_render_pass") is True and
            result.get("hardware_shader_arithmetic_pass") is True and
            result.get("stability_pass") is True and
            result.get("cleanup_pass") is True and not result.get("cleanup_error") and
            result.get("completed_iterations", 0) == result.get("requested_iterations", -1) and
            result.get("completed_iterations", 0) > 0)


def run_bounded(route, node, repeat=1, timeout=30, override=None, clean_environment=False):
    env = dict(os.environ)
    if clean_environment:
        for name in ("MESA_LOADER_DRIVER_OVERRIDE", "LIBGL_ALWAYS_SOFTWARE", "GALLIUM_DRIVER", "EGL_PLATFORM"):
            env.pop(name, None)
    env["EGL_LOG_LEVEL"] = "debug"
    if override == "software-control":
        env["LIBGL_ALWAYS_SOFTWARE"] = "true"
    elif override:
        env["MESA_LOADER_DRIVER_OVERRIDE"] = override
    command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--route", route,
               "--repeat", str(repeat)]
    if node:
        command += ["--node", node]
    try:
        done = subprocess.run(command, capture_output=True, text=True, env=env, timeout=timeout)
        try:
            result = json.loads(done.stdout)
            if not isinstance(result, dict):
                raise ValueError("worker did not return an object")
        except ValueError:
            result = {"route": route, "node": node, "status": "FAIL_NATIVE_PROCESS",
                      "hardware_render_pass": False, "hardware_shader_arithmetic_pass": False,
                      "stdout": done.stdout[-3000:]}
        result["returncode"] = done.returncode
        result["stderr"] = done.stderr[-16000:]
        if done.returncode != 0 and result.get("status") == "PASS_GPU":
            result["status"] = "FAIL_NATIVE_PROCESS"
            result["hardware_render_pass"] = False
            result["hardware_shader_arithmetic_pass"] = False
            result["stability_pass"] = False
        result["validation_pass"] = done.returncode == 0 and validation_pass(result)
    except subprocess.TimeoutExpired as exc:
        result = {"route": route, "node": node, "status": "TIMEOUT",
                  "hardware_render_pass": False, "hardware_shader_arithmetic_pass": False,
                  "stability_pass": False, "validation_pass": False,
                  "stderr": (decode(exc.stderr) if isinstance(exc.stderr, bytes) else exc.stderr or "")[-16000:]}
    result["loader_override"] = override
    result["timeout_seconds"] = timeout
    return result


def run_all(software_control, repeat=1, timeout=30):
    results = []
    routes = [("surfaceless", None, None)]
    for path in sorted(glob.glob("/dev/dri/card*") + glob.glob("/dev/dri/renderD*")):
        routes.append(("gbm", path, None))
    if os.path.exists("/dev/kgsl-3d0"):
        routes.append(("gbm", "/dev/kgsl-3d0", "kgsl"))
    if software_control:
        routes.append(("surfaceless", None, "software-control"))
    for route, node, override in routes:
        results.append(run_bounded(route, node, repeat, timeout, override, clean_environment=True))
    return {"inventory": inventory(), "attempts": results,
            "hardware_render_pass": any(item.get("hardware_render_pass") for item in results),
            "hardware_shader_arithmetic_pass": any(item.get("hardware_shader_arithmetic_pass") for item in results),
            "validation_pass": any(item.get("validation_pass") for item in results),
            "compute_shader_verified": False, "opencl_verified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--software-control", action="store_true")
    parser.add_argument("--route", choices=("gbm", "surfaceless"), default="surfaceless")
    parser.add_argument("--node", default="/dev/dri/card0")
    parser.add_argument("--output")
    parser.add_argument("--repeat", type=int, default=1, help="arithmetic iterations per hardware route (1..1000)")
    parser.add_argument("--timeout", type=float, default=30, help="deadline in seconds per route (0.1..300)")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.repeat <= 1000:
        parser.error("--repeat must be between 1 and 1000")
    if not 0.1 <= args.timeout <= 300:
        parser.error("--timeout must be between 0.1 and 300")
    if args.worker and args.all:
        parser.error("--worker cannot be combined with --all")
    try:
        node = args.node if args.route == "gbm" else None
        if args.worker:
            result = render(args.route, node, args.repeat)
            result["validation_pass"] = validation_pass(result)
        elif args.all:
            result = run_all(args.software_control, args.repeat, args.timeout)
        else:
            result = run_bounded(args.route, node, args.repeat, args.timeout)
    except (OSError, AttributeError) as exc:
        result = {"status": "FAIL_LIBRARY_LOAD", "error": str(exc), "hardware_render_pass": False,
                  "hardware_shader_arithmetic_pass": False, "validation_pass": False}
    data = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        Path(args.output).write_text(data, encoding="utf-8")
    print(data, end="", flush=True)
    return 0 if result.get("validation_pass") else 1


if __name__ == "__main__":
    sys.exit(main())

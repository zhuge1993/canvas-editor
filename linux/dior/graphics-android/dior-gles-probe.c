/* SPDX-License-Identifier: MIT
 * Native Android/Bionic Adreno GLES validation. Only the phone's original
 * vendor libraries are loaded. Rendering remains in a 16x16 offscreen FBO;
 * no display framebuffer, permissions, firmware or global EGL state is changed.
 * Run in a separate process with an external deadline and private Android props.
 */
#define _POSIX_C_SOURCE 200809L
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define SIDE 16
#define PIXELS (SIDE * SIDE)
#define BYTES (PIXELS * 4)
#define MAX_REPEAT 1000
#ifndef EGL_OPENGL_ES3_BIT_KHR
#define EGL_OPENGL_ES3_BIT_KHR 0x0040
#endif

#define EGL_FUNCTIONS(X) \
    X(eglGetDisplay, EGLDisplay, (EGLNativeDisplayType)) \
    X(eglInitialize, EGLBoolean, (EGLDisplay, EGLint *, EGLint *)) \
    X(eglBindAPI, EGLBoolean, (EGLenum)) \
    X(eglChooseConfig, EGLBoolean, (EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *)) \
    X(eglGetConfigAttrib, EGLBoolean, (EGLDisplay, EGLConfig, EGLint, EGLint *)) \
    X(eglCreatePbufferSurface, EGLSurface, (EGLDisplay, EGLConfig, const EGLint *)) \
    X(eglCreateContext, EGLContext, (EGLDisplay, EGLConfig, EGLContext, const EGLint *)) \
    X(eglMakeCurrent, EGLBoolean, (EGLDisplay, EGLSurface, EGLSurface, EGLContext)) \
    X(eglGetError, EGLint, (void)) \
    X(eglQueryString, const char *, (EGLDisplay, EGLint)) \
    X(eglDestroySurface, EGLBoolean, (EGLDisplay, EGLSurface)) \
    X(eglDestroyContext, EGLBoolean, (EGLDisplay, EGLContext)) \
    X(eglTerminate, EGLBoolean, (EGLDisplay))

#define GL_FUNCTIONS(X) \
    X(glGetString, const GLubyte *, (GLenum)) \
    X(glGetIntegerv, void, (GLenum, GLint *)) \
    X(glGetError, GLenum, (void)) \
    X(glDisable, void, (GLenum)) \
    X(glViewport, void, (GLint, GLint, GLsizei, GLsizei)) \
    X(glClearColor, void, (GLfloat, GLfloat, GLfloat, GLfloat)) \
    X(glClear, void, (GLbitfield)) \
    X(glReadPixels, void, (GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *)) \
    X(glPixelStorei, void, (GLenum, GLint)) \
    X(glGenTextures, void, (GLsizei, GLuint *)) \
    X(glDeleteTextures, void, (GLsizei, const GLuint *)) \
    X(glActiveTexture, void, (GLenum)) \
    X(glBindTexture, void, (GLenum, GLuint)) \
    X(glTexParameteri, void, (GLenum, GLenum, GLint)) \
    X(glTexImage2D, void, (GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *)) \
    X(glGenFramebuffers, void, (GLsizei, GLuint *)) \
    X(glDeleteFramebuffers, void, (GLsizei, const GLuint *)) \
    X(glBindFramebuffer, void, (GLenum, GLuint)) \
    X(glFramebufferTexture2D, void, (GLenum, GLenum, GLenum, GLuint, GLint)) \
    X(glCheckFramebufferStatus, GLenum, (GLenum)) \
    X(glCreateShader, GLuint, (GLenum)) \
    X(glShaderSource, void, (GLuint, GLsizei, const GLchar *const *, const GLint *)) \
    X(glCompileShader, void, (GLuint)) \
    X(glGetShaderiv, void, (GLuint, GLenum, GLint *)) \
    X(glGetShaderInfoLog, void, (GLuint, GLsizei, GLsizei *, GLchar *)) \
    X(glDeleteShader, void, (GLuint)) \
    X(glCreateProgram, GLuint, (void)) \
    X(glAttachShader, void, (GLuint, GLuint)) \
    X(glBindAttribLocation, void, (GLuint, GLuint, const GLchar *)) \
    X(glLinkProgram, void, (GLuint)) \
    X(glGetProgramiv, void, (GLuint, GLenum, GLint *)) \
    X(glGetProgramInfoLog, void, (GLuint, GLsizei, GLsizei *, GLchar *)) \
    X(glDeleteProgram, void, (GLuint)) \
    X(glUseProgram, void, (GLuint)) \
    X(glGetUniformLocation, GLint, (GLuint, const GLchar *)) \
    X(glUniform1i, void, (GLint, GLint)) \
    X(glGenBuffers, void, (GLsizei, GLuint *)) \
    X(glDeleteBuffers, void, (GLsizei, const GLuint *)) \
    X(glBindBuffer, void, (GLenum, GLuint)) \
    X(glBufferData, void, (GLenum, GLsizeiptr, const void *, GLenum)) \
    X(glEnableVertexAttribArray, void, (GLuint)) \
    X(glDisableVertexAttribArray, void, (GLuint)) \
    X(glVertexAttribPointer, void, (GLuint, GLint, GLenum, GLboolean, GLsizei, const void *)) \
    X(glDrawArrays, void, (GLenum, GLint, GLsizei)) \
    X(glFinish, void, (void))

#define DECLARE(name, result, arguments) typedef result (*fn_##name) arguments;
EGL_FUNCTIONS(DECLARE)
GL_FUNCTIONS(DECLARE)
#undef DECLARE
typedef const GLubyte *(*fn_glGetStringi)(GLenum, GLuint);
struct api {
#define FIELD(name, result, arguments) fn_##name name;
    EGL_FUNCTIONS(FIELD)
    GL_FUNCTIONS(FIELD)
#undef FIELD
    fn_glGetStringi glGetStringi;
};

struct check {
    unsigned checked_pixels;
    unsigned mismatched_pixels;
    unsigned first_x, first_y;
    unsigned char first_actual[4], first_expected[4];
    unsigned max_channel_error;
    GLenum gl_error;
    double elapsed_ms;
    int passed;
};
struct round_result {
    unsigned number;
    struct check clears[3];
    struct check triangle;
    struct check arithmetic;
    int passed;
};
struct result {
    unsigned requested_version, repeat, completed;
    EGLint egl_major, egl_minor, config_renderable;
    GLint max_texture, max_renderbuffer, max_attributes, max_texture_units;
    char *egl_vendor, *egl_version, *egl_extensions;
    char *gl_vendor, *gl_renderer, *gl_version, *glsl_version, *gl_extensions;
    char operation[128], error[1024], shader_log[4096], cleanup_error[512];
    EGLint egl_error;
    GLenum gl_error;
    int hardware_identity, software_renderer, passed, cleanup_passed;
    struct round_result *rounds;
};
struct resources {
    void *egl_library, *gl_library;
    EGLDisplay display;
    EGLContext context;
    EGLSurface surface;
    int initialized, current;
    GLuint framebuffer, target, input[2], vertices;
    GLuint triangle_program, arithmetic_program;
    GLuint triangle_vertex, triangle_fragment, arithmetic_vertex, arithmetic_fragment;
};
static int trace_enabled;
static const char egl_path[] = "/opt/dior-android/system/vendor/lib/egl/libEGL_adreno.so";
static const char gl_path[] = "/opt/dior-android/system/vendor/lib/egl/libGLESv2_adreno.so";

static void trace(const char *stage)
{
    if (!trace_enabled) return;
    (void)write(2, "[dior-gles] ", 12);
    (void)write(2, stage, strlen(stage));
    (void)write(2, "\n", 1);
}
static double now_ms(void)
{
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0.0;
    return (double)value.tv_sec * 1000.0 + (double)value.tv_nsec / 1000000.0;
}
static int fail(struct result *r, const char *operation, const char *message)
{
    if (!r->error[0]) {
        snprintf(r->operation, sizeof(r->operation), "%s", operation);
        snprintf(r->error, sizeof(r->error), "%s", message ? message : "operation failed");
    }
    return 0;
}
static char *copy_string(const char *value)
{
    size_t length;
    char *copy;
    if (!value) return NULL;
    length = strlen(value);
    if (length > 1024 * 1024) return NULL;
    copy = malloc(length + 1);
    if (copy) memcpy(copy, value, length + 1);
    return copy;
}
static int contains_case(const char *text, const char *needle)
{
    size_t i, j, length;
    if (!text || !needle) return 0;
    length = strlen(needle);
    for (i = 0; text[i]; i++) {
        for (j = 0; j < length; j++) {
            unsigned char a = (unsigned char)text[i + j], b = (unsigned char)needle[j];
            if (!a) break;
            if (a >= 'A' && a <= 'Z') a = (unsigned char)(a + ('a' - 'A'));
            if (b >= 'A' && b <= 'Z') b = (unsigned char)(b + ('a' - 'A'));
            if (a != b) break;
        }
        if (j == length) return 1;
    }
    return 0;
}
static int symbol(void *library, const char *name, void *target, size_t size, struct result *r)
{
    void *address;
    const char *error;
    if (size != sizeof(address)) return fail(r, name, "function/data pointer size mismatch");
    (void)dlerror();
    address = dlsym(library, name);
    error = dlerror();
    if (error || !address) return fail(r, name, error ? error : "missing vendor symbol");
    memcpy(target, &address, size);
    return 1;
}
static GLenum consume_gl_error(struct api *a)
{
    GLenum first = GL_NO_ERROR, current;
    unsigned count;
    for (count = 0; count < 64; count++) {
        current = a->glGetError();
        if (current == GL_NO_ERROR) break;
        if (first == GL_NO_ERROR) first = current;
    }
    return first;
}
static int check_gl(struct api *a, struct result *r, const char *operation)
{
    GLenum error = consume_gl_error(a);
    if (error != GL_NO_ERROR) {
        r->gl_error = error;
        return fail(r, operation, "vendor GLES returned a GL error");
    }
    return 1;
}
static int check_egl(struct api *a, struct result *r, const char *operation, EGLBoolean success)
{
    if (success == EGL_TRUE) return 1;
    r->egl_error = a->eglGetError();
    return fail(r, operation, "vendor EGL operation failed");
}

static int load_api(struct api *a, struct resources *s, struct result *r)
{
    void *optional;
    trace("before dlopen original vendor EGL");
    s->egl_library = dlopen(egl_path, RTLD_NOW | RTLD_GLOBAL);
    trace("after dlopen original vendor EGL");
    if (!s->egl_library) return fail(r, "dlopen vendor EGL", dlerror());
#define LOAD_EGL(name, result, arguments) if (!symbol(s->egl_library, #name, &a->name, sizeof(a->name), r)) return 0;
    EGL_FUNCTIONS(LOAD_EGL)
#undef LOAD_EGL
    trace("before dlopen original vendor GLES");
    s->gl_library = dlopen(gl_path, RTLD_NOW | RTLD_LOCAL);
    trace("after dlopen original vendor GLES");
    if (!s->gl_library) return fail(r, "dlopen vendor GLES", dlerror());
#define LOAD_GL(name, result, arguments) if (!symbol(s->gl_library, #name, &a->name, sizeof(a->name), r)) return 0;
    GL_FUNCTIONS(LOAD_GL)
#undef LOAD_GL
    (void)dlerror();
    optional = dlsym(s->gl_library, "glGetStringi");
    if (!dlerror() && optional && sizeof(optional) == sizeof(a->glGetStringi))
        memcpy(&a->glGetStringi, &optional, sizeof(optional));
    return 1;
}

static int create_context(struct api *a, struct resources *s, struct result *r)
{
    EGLConfig config = (EGLConfig)0;
    EGLint count = 0;
    EGLint attributes[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_SAMPLE_BUFFERS, 0, EGL_SAMPLES, 0,
        EGL_NONE
    };
    const EGLint surface_attributes[] = { EGL_WIDTH, SIDE, EGL_HEIGHT, SIDE, EGL_NONE };
    EGLint context_attributes[] = { EGL_CONTEXT_CLIENT_VERSION, (EGLint)r->requested_version, EGL_NONE };
    trace("before eglGetDisplay EGL_DEFAULT_DISPLAY");
    s->display = a->eglGetDisplay(EGL_DEFAULT_DISPLAY);
    trace("after eglGetDisplay");
    if (s->display == EGL_NO_DISPLAY) {
        r->egl_error = a->eglGetError();
        return fail(r, "eglGetDisplay", "vendor EGL has no default display");
    }
    trace("before eglInitialize");
    if (!check_egl(a, r, "eglInitialize", a->eglInitialize(s->display, &r->egl_major, &r->egl_minor))) return 0;
    trace("after eglInitialize");
    s->initialized = 1;
    r->egl_vendor = copy_string(a->eglQueryString(s->display, EGL_VENDOR));
    r->egl_version = copy_string(a->eglQueryString(s->display, EGL_VERSION));
    r->egl_extensions = copy_string(a->eglQueryString(s->display, EGL_EXTENSIONS));
    if (!r->egl_vendor || !r->egl_version || !r->egl_extensions) return fail(r, "EGL identity", "missing EGL identity or allocation failure");
    if (!check_egl(a, r, "eglBindAPI", a->eglBindAPI(EGL_OPENGL_ES_API))) return 0;
    if (r->requested_version == 3) attributes[3] = EGL_OPENGL_ES3_BIT_KHR;
    if (!check_egl(a, r, "eglChooseConfig", a->eglChooseConfig(s->display, attributes, &config, 1, &count))) return 0;
    /* Some Android 4.4 drivers advertise ES3 on configs carrying the ES2 bit.
     * The requested context and the actual GL version are still checked. */
    if (count == 0 && r->requested_version == 3) {
        attributes[3] = EGL_OPENGL_ES2_BIT;
        if (!check_egl(a, r, "eglChooseConfig ES2-compatible ES3 config", a->eglChooseConfig(s->display, attributes, &config, 1, &count))) return 0;
    }
    if (count < 1 || !config) return fail(r, "eglChooseConfig", "no matching RGBA8 pbuffer config");
    if (!check_egl(a, r, "eglGetConfigAttrib", a->eglGetConfigAttrib(s->display, config, EGL_RENDERABLE_TYPE, &r->config_renderable))) return 0;
    trace("before eglCreatePbufferSurface");
    s->surface = a->eglCreatePbufferSurface(s->display, config, surface_attributes);
    trace("after eglCreatePbufferSurface");
    if (s->surface == EGL_NO_SURFACE) {
        r->egl_error = a->eglGetError();
        return fail(r, "eglCreatePbufferSurface", "vendor EGL pbuffer creation failed");
    }
    trace("before eglCreateContext");
    s->context = a->eglCreateContext(s->display, config, EGL_NO_CONTEXT, context_attributes);
    trace("after eglCreateContext");
    if (s->context == EGL_NO_CONTEXT) {
        r->egl_error = a->eglGetError();
        return fail(r, "eglCreateContext", "requested vendor GLES context could not be created");
    }
    trace("before eglMakeCurrent");
    if (!check_egl(a, r, "eglMakeCurrent", a->eglMakeCurrent(s->display, s->surface, s->surface, s->context))) return 0;
    trace("after eglMakeCurrent");
    s->current = 1;
    return 1;
}

static int get_identity(struct api *a, struct result *r)
{
    GLint extension_count = 0;
    unsigned major = 0, minor = 0;
    size_t total, used;
    GLint index;
    const char *extension;
    r->gl_vendor = copy_string((const char *)a->glGetString(GL_VENDOR));
    r->gl_renderer = copy_string((const char *)a->glGetString(GL_RENDERER));
    r->gl_version = copy_string((const char *)a->glGetString(GL_VERSION));
    r->glsl_version = copy_string((const char *)a->glGetString(GL_SHADING_LANGUAGE_VERSION));
    if (!r->gl_vendor || !r->gl_renderer || !r->gl_version || !r->glsl_version) return fail(r, "GL identity", "missing GLES identity or allocation failure");
    if (sscanf(r->gl_version, "OpenGL ES %u.%u", &major, &minor) != 2 || major < r->requested_version)
        return fail(r, "GL version", "actual context does not provide the requested GLES version");
    (void)minor;
    r->software_renderer = contains_case(r->gl_renderer, "llvmpipe") || contains_case(r->gl_renderer, "softpipe") ||
        contains_case(r->gl_renderer, "swrast") || contains_case(r->gl_renderer, "swiftshader") ||
        contains_case(r->gl_renderer, "lavapipe") || contains_case(r->gl_renderer, "software");
    r->hardware_identity = contains_case(r->gl_vendor, "qualcomm") && contains_case(r->gl_renderer, "adreno") &&
        contains_case(r->gl_renderer, "305") && !r->software_renderer;
    if (!r->hardware_identity) return fail(r, "GPU identity", "renderer is not the original hardware Adreno 305");
    a->glGetIntegerv(GL_MAX_TEXTURE_SIZE, &r->max_texture);
    a->glGetIntegerv(GL_MAX_RENDERBUFFER_SIZE, &r->max_renderbuffer);
    a->glGetIntegerv(GL_MAX_VERTEX_ATTRIBS, &r->max_attributes);
    a->glGetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS, &r->max_texture_units);
    if (!check_gl(a, r, "GL identity and caps")) return 0;
    if (r->max_texture < SIDE || r->max_renderbuffer < SIDE || r->max_attributes < 2 || r->max_texture_units < 2)
        return fail(r, "GL caps", "required texture, framebuffer or shader resources unavailable");
    if (major >= 3 && a->glGetStringi) {
        a->glGetIntegerv(GL_NUM_EXTENSIONS, &extension_count);
        if (!check_gl(a, r, "GL extension count")) return 0;
        if (extension_count < 0 || extension_count > 4096) return fail(r, "GL extensions", "invalid extension count");
        total = 1;
        for (index = 0; index < extension_count; index++) {
            extension = (const char *)a->glGetStringi(GL_EXTENSIONS, (GLuint)index);
            if (!extension || strlen(extension) > 4096) return fail(r, "GL extensions", "invalid extension string");
            total += strlen(extension) + 1;
            if (total > 1024 * 1024) return fail(r, "GL extensions", "extension string exceeds diagnostic bound");
        }
        r->gl_extensions = malloc(total);
        if (!r->gl_extensions) return fail(r, "GL extensions", "allocation failed");
        used = 0;
        for (index = 0; index < extension_count; index++) {
            extension = (const char *)a->glGetStringi(GL_EXTENSIONS, (GLuint)index);
            if (!extension) return fail(r, "GL extensions", "extension disappeared during query");
            if (used) r->gl_extensions[used++] = ' ';
            memcpy(r->gl_extensions + used, extension, strlen(extension));
            used += strlen(extension);
        }
        r->gl_extensions[used] = '\0';
    } else {
        r->gl_extensions = copy_string((const char *)a->glGetString(GL_EXTENSIONS));
        if (!r->gl_extensions) return fail(r, "GL extensions", "missing extensions or allocation failure");
    }
    return check_gl(a, r, "GL extensions");
}

static int compile_shader(struct api *a, struct result *r, GLenum type, const char *text, GLuint *output)
{
    GLint compiled = GL_FALSE;
    GLsizei length = 0;
    trace("before glCreateShader / compile");
    *output = a->glCreateShader(type);
    if (!*output) return fail(r, "glCreateShader", "vendor GLES returned zero shader");
    a->glShaderSource(*output, 1, &text, NULL);
    a->glCompileShader(*output);
    a->glGetShaderiv(*output, GL_COMPILE_STATUS, &compiled);
    a->glGetShaderInfoLog(*output, (GLsizei)sizeof(r->shader_log), &length, r->shader_log);
    r->shader_log[sizeof(r->shader_log) - 1] = '\0';
    trace("after glCompileShader");
    if (!check_gl(a, r, "shader compilation")) return 0;
    if (compiled != GL_TRUE) return fail(r, "glCompileShader", "vendor GLES rejected shader; inspect shader_log");
    return 1;
}
static int program(struct api *a, struct result *r, const char *vertex, const char *fragment,
                   GLuint *vs, GLuint *fs, GLuint *output)
{
    GLint linked = GL_FALSE;
    GLsizei length = 0;
    if (!compile_shader(a, r, GL_VERTEX_SHADER, vertex, vs) || !compile_shader(a, r, GL_FRAGMENT_SHADER, fragment, fs)) return 0;
    *output = a->glCreateProgram();
    if (!*output) return fail(r, "glCreateProgram", "vendor GLES returned zero program");
    a->glAttachShader(*output, *vs);
    a->glAttachShader(*output, *fs);
    a->glBindAttribLocation(*output, 0, "position");
    a->glBindAttribLocation(*output, 1, "uv");
    trace("before glLinkProgram");
    a->glLinkProgram(*output);
    a->glGetProgramiv(*output, GL_LINK_STATUS, &linked);
    a->glGetProgramInfoLog(*output, (GLsizei)sizeof(r->shader_log), &length, r->shader_log);
    r->shader_log[sizeof(r->shader_log) - 1] = '\0';
    trace("after glLinkProgram");
    if (!check_gl(a, r, "program link")) return 0;
    if (linked != GL_TRUE) return fail(r, "glLinkProgram", "vendor GLES rejected linked program; inspect shader_log");
    return 1;
}
static void texture_parameters(struct api *a)
{
    a->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    a->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    a->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    a->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}
static int setup_rendering(struct api *a, struct resources *s, struct result *r)
{
    const char *triangle_vs, *triangle_fs, *arithmetic_vs, *arithmetic_fs;
    GLenum status;
    if (r->requested_version == 3) {
        triangle_vs = "#version 300 es\nin vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}";
        triangle_fs = "#version 300 es\nprecision highp float; out vec4 color; void main(){color=vec4(0.0,1.0,0.0,1.0);}";
        arithmetic_vs = "#version 300 es\nin vec2 position; in vec2 uv; out vec2 texcoord; void main(){gl_Position=vec4(position,0.0,1.0);texcoord=uv;}";
        arithmetic_fs = "#version 300 es\nprecision highp float; uniform sampler2D input_a; uniform sampler2D input_b; in vec2 texcoord; out vec4 color; void main(){vec4 a=texture(input_a,texcoord);vec4 b=texture(input_b,texcoord);color=vec4((a.r+b.r)*0.5,(3.0*a.g+b.g)*0.25,abs(a.b-b.b),1.0);}";
    } else {
        triangle_vs = "attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}";
        triangle_fs = "precision highp float; void main(){gl_FragColor=vec4(0.0,1.0,0.0,1.0);}";
        arithmetic_vs = "attribute vec2 position; attribute vec2 uv; varying vec2 texcoord; void main(){gl_Position=vec4(position,0.0,1.0);texcoord=uv;}";
        arithmetic_fs = "precision highp float; uniform sampler2D input_a; uniform sampler2D input_b; varying vec2 texcoord; void main(){vec4 a=texture2D(input_a,texcoord);vec4 b=texture2D(input_b,texcoord);gl_FragColor=vec4((a.r+b.r)*0.5,(3.0*a.g+b.g)*0.25,abs(a.b-b.b),1.0);}";
    }
    a->glDisable(GL_DITHER);
    a->glDisable(GL_BLEND);
    a->glDisable(GL_DEPTH_TEST);
    a->glDisable(GL_STENCIL_TEST);
    a->glDisable(GL_SCISSOR_TEST);
    a->glDisable(GL_CULL_FACE);
    a->glPixelStorei(GL_PACK_ALIGNMENT, 1);
    a->glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    a->glViewport(0, 0, SIDE, SIDE);
    a->glGenTextures(1, &s->target);
    a->glActiveTexture(GL_TEXTURE0);
    a->glBindTexture(GL_TEXTURE_2D, s->target);
    texture_parameters(a);
    a->glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, SIDE, SIDE, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    a->glGenFramebuffers(1, &s->framebuffer);
    a->glBindFramebuffer(GL_FRAMEBUFFER, s->framebuffer);
    a->glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s->target, 0);
    status = a->glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (!check_gl(a, r, "offscreen framebuffer setup")) return 0;
    if (!s->target || !s->framebuffer || status != GL_FRAMEBUFFER_COMPLETE) return fail(r, "glCheckFramebufferStatus", "RGBA8 FBO is incomplete");
    if (!program(a, r, triangle_vs, triangle_fs, &s->triangle_vertex, &s->triangle_fragment, &s->triangle_program)) return 0;
    if (!program(a, r, arithmetic_vs, arithmetic_fs, &s->arithmetic_vertex, &s->arithmetic_fragment, &s->arithmetic_program)) return 0;
    a->glGenTextures(2, s->input);
    a->glGenBuffers(1, &s->vertices);
    if (!check_gl(a, r, "input texture and vertex buffer setup")) return 0;
    if (!s->input[0] || !s->input[1] || !s->vertices) return fail(r, "input resources", "vendor GLES returned zero texture or buffer");
    return 1;
}

static void compare_pixel(struct check *check, const unsigned char *actual,
                          const unsigned char *expected, unsigned x, unsigned y, unsigned tolerance)
{
    unsigned c, difference, mismatch = 0;
    check->checked_pixels++;
    for (c = 0; c < 4; c++) {
        difference = actual[c] > expected[c] ? (unsigned)(actual[c] - expected[c]) : (unsigned)(expected[c] - actual[c]);
        if (difference > check->max_channel_error) check->max_channel_error = difference;
        if (difference > tolerance) mismatch = 1;
    }
    if (mismatch) {
        if (check->mismatched_pixels == 0) {
            check->first_x = x;
            check->first_y = y;
            memcpy(check->first_actual, actual, 4);
            memcpy(check->first_expected, expected, 4);
        }
        check->mismatched_pixels++;
    }
}
static int read_pixels(struct api *a, struct result *r, struct check *check, unsigned char pixels[BYTES], const char *operation)
{
    trace("before glFinish / glReadPixels");
    a->glFinish();
    a->glReadPixels(0, 0, SIDE, SIDE, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    trace("after glReadPixels");
    check->gl_error = consume_gl_error(a);
    if (check->gl_error != GL_NO_ERROR) {
        r->gl_error = check->gl_error;
        return fail(r, operation, "GL error during draw/readback");
    }
    return 1;
}
static int clear_check(struct api *a, struct result *r, struct check *check, unsigned channel)
{
    unsigned x, y;
    unsigned char pixels[BYTES], expected[4] = {0, 0, 0, 255};
    double start = now_ms();
    if (channel < 2) expected[channel == 0 ? 0 : 2] = 255;
    else expected[0] = expected[1] = expected[2] = 255;
    a->glClearColor((GLfloat)expected[0] / 255.0f, (GLfloat)expected[1] / 255.0f, (GLfloat)expected[2] / 255.0f, 1.0f);
    a->glClear(GL_COLOR_BUFFER_BIT);
    if (!read_pixels(a, r, check, pixels, "clear readback")) return 0;
    for (y = 0; y < SIDE; y++) for (x = 0; x < SIDE; x++)
        compare_pixel(check, pixels + 4 * (y * SIDE + x), expected, x, y, 0);
    check->elapsed_ms = now_ms() - start;
    check->passed = check->checked_pixels == PIXELS && check->mismatched_pixels == 0;
    return check->passed || fail(r, "clear pixels", "full-target red/blue/white clear did not match CPU reference");
}
static int triangle_check(struct api *a, struct resources *s, struct result *r, struct check *check)
{
    const GLfloat vertices[] = {-0.8f, -0.8f, 0.8f, -0.8f, 0.0f, 0.8f};
    const unsigned char red[4] = {255, 0, 0, 255}, green[4] = {0, 255, 0, 255};
    unsigned char pixels[BYTES];
    unsigned x, y;
    double start = now_ms();
    a->glClearColor(1.0f, 0.0f, 0.0f, 1.0f);
    a->glClear(GL_COLOR_BUFFER_BIT);
    a->glUseProgram(s->triangle_program);
    a->glBindBuffer(GL_ARRAY_BUFFER, s->vertices);
    a->glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)sizeof(vertices), vertices, GL_STATIC_DRAW);
    a->glEnableVertexAttribArray(0);
    a->glDisableVertexAttribArray(1);
    a->glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 2 * (GLsizei)sizeof(GLfloat), NULL);
    trace("before triangle glDrawArrays");
    a->glDrawArrays(GL_TRIANGLES, 0, 3);
    trace("after triangle glDrawArrays");
    if (!read_pixels(a, r, check, pixels, "triangle readback")) return 0;
    for (y = 0; y < SIDE; y++) for (x = 0; x < SIDE; x++) {
        double px = 2.0 * ((double)x + 0.5) / SIDE - 1.0;
        double py = 2.0 * ((double)y + 0.5) / SIDE - 1.0;
        double bottom = py + 0.8;
        double left = 0.5 * (py + 0.8) - (px + 0.8);
        double right = 0.5 * (py + 0.8) + px - 0.8;
        int inside = bottom > 0.0 && left < 0.0 && right < 0.0;
        /* Exclude only close rasterization-boundary centers, where top-left
         * coverage convention and fixed-point precision differ between APIs. */
        if (fabs(bottom) < 0.035 || fabs(left) < 0.035 || fabs(right) < 0.035) continue;
        compare_pixel(check, pixels + 4 * (y * SIDE + x), inside ? green : red, x, y, 0);
    }
    /* Independent center/corner/edge samples retain explicit expected colors. */
    compare_pixel(check, pixels + 4 * (8 * SIDE + 8), green, 8, 8, 0);
    compare_pixel(check, pixels, red, 0, 0, 0);
    compare_pixel(check, pixels + 4 * (8 * SIDE + 14), red, 14, 8, 0);
    compare_pixel(check, pixels + 4 * (2 * SIDE + 8), green, 8, 2, 0);
    check->elapsed_ms = now_ms() - start;
    check->passed = check->checked_pixels > 200 && check->mismatched_pixels == 0;
    return check->passed || fail(r, "triangle pixels", "compiled shader triangle did not match CPU geometry and explicit samples");
}
static int arithmetic_check(struct api *a, struct resources *s, struct result *r, struct check *check, unsigned phase)
{
    const GLfloat vertices[] = {-1.0f,-1.0f,0.0f,0.0f, 1.0f,-1.0f,1.0f,0.0f,
                               -1.0f,1.0f,0.0f,1.0f, 1.0f,1.0f,1.0f,1.0f};
    unsigned char inputs[2][BYTES], expected[BYTES], actual[BYTES];
    unsigned x, y, i;
    GLint location_a, location_b;
    double start = now_ms();
    for (y = 0; y < SIDE; y++) for (x = 0; x < SIDE; x++) {
        unsigned offset = 4 * (y * SIDE + x);
        inputs[0][offset] = (unsigned char)(4 * ((x * 3 + y * 5 + phase * 7) % 32));
        inputs[0][offset + 1] = (unsigned char)(4 * ((x * 5 + y + phase * 3) % 48));
        inputs[0][offset + 2] = (unsigned char)(2 * ((x + y * 3 + phase * 5) % 100));
        inputs[0][offset + 3] = 255;
        inputs[1][offset] = (unsigned char)(4 * ((x + y * 7 + phase * 11) % 48));
        inputs[1][offset + 1] = (unsigned char)(4 * ((x * 7 + y * 3 + phase) % 32));
        inputs[1][offset + 2] = (unsigned char)(2 * ((x * 3 + y + phase * 7) % 100));
        inputs[1][offset + 3] = 255;
        expected[offset] = (unsigned char)(((unsigned)inputs[0][offset] + inputs[1][offset]) / 2);
        expected[offset + 1] = (unsigned char)((3U * inputs[0][offset + 1] + inputs[1][offset + 1]) / 4);
        expected[offset + 2] = (unsigned char)abs((int)inputs[0][offset + 2] - (int)inputs[1][offset + 2]);
        expected[offset + 3] = 255;
    }
    a->glUseProgram(s->arithmetic_program);
    for (i = 0; i < 2; i++) {
        a->glActiveTexture(GL_TEXTURE0 + i);
        a->glBindTexture(GL_TEXTURE_2D, s->input[i]);
        texture_parameters(a);
        a->glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, SIDE, SIDE, 0, GL_RGBA, GL_UNSIGNED_BYTE, inputs[i]);
    }
    location_a = a->glGetUniformLocation(s->arithmetic_program, "input_a");
    location_b = a->glGetUniformLocation(s->arithmetic_program, "input_b");
    if (location_a < 0 || location_b < 0) return fail(r, "shader sampler uniforms", "linked arithmetic program has missing sampler uniforms");
    a->glUniform1i(location_a, 0);
    a->glUniform1i(location_b, 1);
    a->glBindBuffer(GL_ARRAY_BUFFER, s->vertices);
    a->glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)sizeof(vertices), vertices, GL_STATIC_DRAW);
    a->glEnableVertexAttribArray(0);
    a->glEnableVertexAttribArray(1);
    a->glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * (GLsizei)sizeof(GLfloat), NULL);
    a->glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * (GLsizei)sizeof(GLfloat), (const void *)(uintptr_t)(2 * sizeof(GLfloat)));
    trace("before arithmetic glDrawArrays");
    a->glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    trace("after arithmetic glDrawArrays");
    if (!read_pixels(a, r, check, actual, "texture arithmetic readback")) return 0;
    for (y = 0; y < SIDE; y++) for (x = 0; x < SIDE; x++)
        compare_pixel(check, actual + 4 * (y * SIDE + x), expected + 4 * (y * SIDE + x), x, y, 1);
    check->elapsed_ms = now_ms() - start;
    check->passed = check->checked_pixels == PIXELS && check->mismatched_pixels == 0;
    return check->passed || fail(r, "arithmetic pixels", "two-texture fragment arithmetic did not match independent integer CPU reference");
}

static void cleanup(struct api *a, struct resources *s, struct result *r)
{
    EGLBoolean good = EGL_TRUE;
    GLenum error;
    trace("before resource cleanup");
    r->cleanup_passed = 1;
    if (s->current) {
        if (s->vertices) a->glDeleteBuffers(1, &s->vertices);
        if (s->framebuffer) a->glDeleteFramebuffers(1, &s->framebuffer);
        if (s->target) a->glDeleteTextures(1, &s->target);
        if (s->input[0] || s->input[1]) a->glDeleteTextures(2, s->input);
        if (s->triangle_program) a->glDeleteProgram(s->triangle_program);
        if (s->arithmetic_program) a->glDeleteProgram(s->arithmetic_program);
        if (s->triangle_vertex) a->glDeleteShader(s->triangle_vertex);
        if (s->triangle_fragment) a->glDeleteShader(s->triangle_fragment);
        if (s->arithmetic_vertex) a->glDeleteShader(s->arithmetic_vertex);
        if (s->arithmetic_fragment) a->glDeleteShader(s->arithmetic_fragment);
        error = consume_gl_error(a);
        if (error != GL_NO_ERROR) {
            r->cleanup_passed = 0;
            snprintf(r->cleanup_error, sizeof(r->cleanup_error), "GLES cleanup returned error 0x%x", (unsigned)error);
        }
        good = a->eglMakeCurrent(s->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    }
    if (s->surface != EGL_NO_SURFACE && a->eglDestroySurface && a->eglDestroySurface(s->display, s->surface) != EGL_TRUE) good = EGL_FALSE;
    if (s->context != EGL_NO_CONTEXT && a->eglDestroyContext && a->eglDestroyContext(s->display, s->context) != EGL_TRUE) good = EGL_FALSE;
    if (s->initialized && a->eglTerminate && a->eglTerminate(s->display) != EGL_TRUE) good = EGL_FALSE;
    if (good != EGL_TRUE) {
        r->cleanup_passed = 0;
        snprintf(r->cleanup_error, sizeof(r->cleanup_error), "EGL resource cleanup failed with 0x%x", (unsigned)(a->eglGetError ? a->eglGetError() : 0));
    }
    if (s->gl_library && dlclose(s->gl_library)) r->cleanup_passed = 0;
    if (s->egl_library && dlclose(s->egl_library)) r->cleanup_passed = 0;
    trace("after resource cleanup");
}
static void json_string(FILE *out, const char *text)
{
    const unsigned char *p;
    if (!text) { fputs("null", out); return; }
    fputc('"', out);
    for (p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') { fputc('\\', out); fputc(*p, out); }
        else if (*p < 0x20) fprintf(out, "\\u%04x", (unsigned)*p);
        else fputc(*p, out);
    }
    fputc('"', out);
}
static const char *boolean(int value) { return value ? "true" : "false"; }
static void json_check(FILE *out, const struct check *check)
{
    fprintf(out, "{\"passed\":%s,\"checked_pixels\":%u,\"mismatched_pixels\":%u,\"max_channel_error\":%u,\"gl_error\":%u,\"transfer_draw_readback_ms\":%.6f",
            boolean(check->passed), check->checked_pixels, check->mismatched_pixels, check->max_channel_error, (unsigned)check->gl_error, check->elapsed_ms);
    if (check->mismatched_pixels) {
        fprintf(out, ",\"first_mismatch\":{\"x\":%u,\"y\":%u,\"actual\":[%u,%u,%u,%u],\"expected\":[%u,%u,%u,%u]}",
                check->first_x, check->first_y,
                (unsigned)check->first_actual[0], (unsigned)check->first_actual[1], (unsigned)check->first_actual[2], (unsigned)check->first_actual[3],
                (unsigned)check->first_expected[0], (unsigned)check->first_expected[1], (unsigned)check->first_expected[2], (unsigned)check->first_expected[3]);
    }
    fputc('}', out);
}
static void report(FILE *out, const struct result *r)
{
    unsigned i, j;
    fprintf(out, "{\n\"probe\":\"native-android-adreno-gles\",\"status\":\"%s\",\"hardware_render_pass\":%s,\"gles_fragment_compute_pass\":%s,\"opencl_tested\":false,\"display_framebuffer_changed\":false,\"requested_gles_version\":%u,\"repeat\":%u,\"completed_iterations\":%u,\"hardware_identity\":%s,\"software_renderer\":%s,\"cleanup_passed\":%s,",
            r->passed ? "PASS_GPU_RENDER" : "FAIL", boolean(r->passed), boolean(r->passed), r->requested_version, r->repeat, r->completed,
            boolean(r->hardware_identity), boolean(r->software_renderer), boolean(r->cleanup_passed));
    fputs("\n\"egl_library\":", out); json_string(out, egl_path);
    fputs(",\"gles_library\":", out); json_string(out, gl_path);
    fputs(",\"egl_vendor\":", out); json_string(out, r->egl_vendor);
    fputs(",\"egl_version\":", out); json_string(out, r->egl_version);
    fputs(",\"egl_extensions\":", out); json_string(out, r->egl_extensions);
    fputs(",\"gl_vendor\":", out); json_string(out, r->gl_vendor);
    fputs(",\"gl_renderer\":", out); json_string(out, r->gl_renderer);
    fputs(",\"gl_version\":", out); json_string(out, r->gl_version);
    fputs(",\"glsl_version\":", out); json_string(out, r->glsl_version);
    fputs(",\"gl_extensions\":", out); json_string(out, r->gl_extensions);
    fprintf(out, ",\n\"caps\":{\"egl_major\":%d,\"egl_minor\":%d,\"config_renderable_type\":%d,\"max_texture_size\":%d,\"max_renderbuffer_size\":%d,\"max_vertex_attribs\":%d,\"max_combined_texture_units\":%d},\"operation\":",
            r->egl_major, r->egl_minor, r->config_renderable, r->max_texture, r->max_renderbuffer, r->max_attributes, r->max_texture_units);
    json_string(out, r->operation);
    fputs(",\"error\":", out); json_string(out, r->error);
    fprintf(out, ",\"egl_error\":%d,\"gl_error\":%u,\"shader_log\":", r->egl_error, (unsigned)r->gl_error);
    json_string(out, r->shader_log);
    fputs(",\"cleanup_error\":", out); json_string(out, r->cleanup_error);
    fputs(",\n\"arithmetic_reference\":\"RGBA8 CPU integers: R=(A.r+B.r)/2; G=(3*A.g+B.g)/4; B=abs(A.b-B.b); alpha=255; tolerance=1 LSB\",\"iterations\":[", out);
    for (i = 0; i < r->repeat && r->rounds && r->rounds[i].number; i++) {
        const struct round_result *round = &r->rounds[i];
        if (i) fputc(',', out);
        fprintf(out, "\n{\"number\":%u,\"passed\":%s,\"clears\":[", round->number, boolean(round->passed));
        for (j = 0; j < 3; j++) { if (j) fputc(',', out); json_check(out, &round->clears[j]); }
        fputs("],\"shader_triangle\":", out); json_check(out, &round->triangle);
        fputs(",\"texture_arithmetic\":", out); json_check(out, &round->arithmetic);
        fputc('}', out);
    }
    fputs("\n]}\n", out);
}
static int parse_unsigned(const char *text, unsigned *out, unsigned maximum)
{
    char *end;
    unsigned long value;
    if (!text || !*text || *text == '-') return 0;
    errno = 0;
    value = strtoul(text, &end, 10);
    if (errno || *end || value == 0 || value > maximum) return 0;
    *out = (unsigned)value;
    return 1;
}
int main(int argc, char **argv)
{
    struct api api;
    struct resources resources;
    struct result result;
    FILE *out;
    int output_fd, i, okay = 1;
    unsigned round, channel;
    memset(&api, 0, sizeof(api));
    memset(&resources, 0, sizeof(resources));
    memset(&result, 0, sizeof(result));
    resources.display = EGL_NO_DISPLAY;
    resources.context = EGL_NO_CONTEXT;
    resources.surface = EGL_NO_SURFACE;
    result.requested_version = 2;
    result.repeat = 3;
    /* Keep a private output stream before vendor code can emit to fd 1. Avoid
     * stdout/stderr global FILE references across old Bionic constructors. */
    output_fd = dup(1);
    if (output_fd < 0) { (void)write(2, "cannot duplicate JSON output fd\n", 31); return 2; }
    out = fdopen(output_fd, "w");
    if (!out) { close(output_fd); return 2; }
    if (dup2(2, 1) < 0) { fclose(out); return 2; }
    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--trace")) trace_enabled = 1;
        else if (!strcmp(argv[i], "--version2")) result.requested_version = 2;
        else if (!strcmp(argv[i], "--version3")) result.requested_version = 3;
        else if (!strcmp(argv[i], "--version") && i + 1 < argc) {
            if (!parse_unsigned(argv[++i], &result.requested_version, 3) || result.requested_version < 2) okay = fail(&result, "arguments", "--version requires 2 or 3");
        } else if (!strcmp(argv[i], "--repeat") && i + 1 < argc) {
            if (!parse_unsigned(argv[++i], &result.repeat, MAX_REPEAT)) okay = fail(&result, "arguments", "--repeat requires 1..1000");
        } else okay = fail(&result, "arguments", "expected --version 2|3, --repeat 1..1000, --trace");
    }
    if (okay) {
        result.rounds = calloc(result.repeat, sizeof(*result.rounds));
        if (!result.rounds) okay = fail(&result, "round results", "allocation failed");
    }
    if (okay) okay = load_api(&api, &resources, &result);
    if (okay) okay = create_context(&api, &resources, &result);
    if (okay) okay = get_identity(&api, &result);
    if (okay) okay = setup_rendering(&api, &resources, &result);
    for (round = 0; okay && round < result.repeat; round++) {
        struct round_result *measurement = &result.rounds[round];
        measurement->number = round + 1;
        trace("begin rendering iteration");
        for (channel = 0; okay && channel < 3; channel++) okay = clear_check(&api, &result, &measurement->clears[channel], channel);
        if (okay) okay = triangle_check(&api, &resources, &result, &measurement->triangle);
        if (okay) okay = arithmetic_check(&api, &resources, &result, &measurement->arithmetic, round);
        if (okay) { measurement->passed = 1; result.completed++; }
        trace("end rendering iteration");
    }
    cleanup(&api, &resources, &result);
    result.passed = okay && result.hardware_identity && !result.software_renderer && result.cleanup_passed && result.completed == result.repeat;
    if (okay && !result.cleanup_passed) fail(&result, "cleanup", "rendering passed but resource cleanup failed");
    report(out, &result);
    okay = result.passed ? 0 : 1;
    free(result.egl_vendor); free(result.egl_version); free(result.egl_extensions);
    free(result.gl_vendor); free(result.gl_renderer); free(result.gl_version); free(result.glsl_version); free(result.gl_extensions);
    free(result.rounds);
    if (fclose(out)) okay = 1;
    return okay;
}

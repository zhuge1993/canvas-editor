#!/usr/bin/env python3
"""Ordinary Linux EGL/GLES2 application example for the isolated Dior runtime.

This program owns its shaders, VBO, two FBOs and CPU references. It imports no
GPU probe code. Explicit runtime selection applies to this process only.
Examples:
  python3 gpu-application-smoke.py --self-test
  python3 gpu-application-smoke.py --contexts 3 --iterations 3
Each context is a fresh ordinary-user process; the JSON gate rejects software,
wrong renderer, incomplete frames, GL errors, timeout and cleanup errors.
"""
import argparse
import ctypes as C
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

NONE=0x3038
PLATFORM_GBM=0x31D7
ES_API=0x30A0
ES2_BIT=4
RGBA=0x1908
UNSIGNED_BYTE=0x1401
TEXTURE_2D=0x0DE1
FRAMEBUFFER=0x8D40
COLOR_ATTACHMENT0=0x8CE0
FRAMEBUFFER_COMPLETE=0x8CD5
VERTEX_SHADER=0x8B31
FRAGMENT_SHADER=0x8B30
COMPILE_STATUS=0x8B81
LINK_STATUS=0x8B82
HIGH_FLOAT=0x8DF2
ARRAY_BUFFER=0x8892
STATIC_DRAW=0x88E4
FLOAT=0x1406
TRIANGLE_STRIP=5
DITHER=0x0BD0
PACK_ALIGNMENT=0x0D05
P=C.c_void_p
I=C.c_int
U=C.c_uint

VERTEX=b"""
attribute vec2 position;
void main() { gl_Position=vec4(position, 0.0, 1.0); }
"""
GRADIENT=b"""
precision highp float;
uniform vec2 imageSize;
uniform vec4 affine;
void main() {
  vec2 uv=gl_FragCoord.xy/imageSize;
  gl_FragColor=vec4(affine.x+affine.y*uv.x,
                   affine.z+affine.w*uv.y,
                   0.125+0.5*uv.x+0.25*uv.y, 1.0);
}
"""
CHECKER=b"""
precision highp float;
uniform float pixelShift;
uniform vec4 foreground;
uniform vec4 background;
void main() {
  vec2 cell=floor((gl_FragCoord.xy+vec2(pixelShift,2.0*pixelShift))/16.0);
  float parity=mod(cell.x+cell.y,2.0);
  gl_FragColor=mix(background,foreground,parity);
}
"""
AFFINES=((0.0,0.5,0.125,0.5),(0.125,0.25,0.0,0.75),(0.25,0.5,0.25,0.5))
PALETTES=(((0.125,0.75,0.25,1.0),(0.625,0.125,0.75,1.0)),
          ((0.75,0.25,0.5,1.0),(0.125,0.625,0.125,1.0)),
          ((0.25,0.5,0.875,1.0),(0.75,0.25,0.0,1.0)))

class Failure(RuntimeError):
    pass

def quantize(value):
    return max(0,min(255,int(value*255.0+0.5)))

def gradient_reference(size, coefficients):
    """Independent CPU evaluation at bottom-left pixel centers, RGBA8."""
    output=bytearray(size*size*4)
    a,b,c,d=coefficients
    offset=0
    for y in range(size):
        v=(y+0.5)/size
        for x in range(size):
            u=(x+0.5)/size
            output[offset:offset+4]=bytes((quantize(a+b*u),quantize(c+d*v),
                                         quantize(0.125+0.5*u+0.25*v),255))
            offset+=4
    return bytes(output)

def checker_reference(size, shift, foreground, background):
    """Integer cell calculation is independent of GLSL floor/mod operations."""
    colors=(bytes(map(quantize,background)),bytes(map(quantize,foreground)))
    output=bytearray(size*size*4)
    offset=0
    for y in range(size):
        row=(y+2*shift)//16
        for x in range(size):
            parity=((x+shift)//16+row)&1
            output[offset:offset+4]=colors[parity]
            offset+=4
    return bytes(output)

def compare(actual, expected, size):
    if len(actual)!=size*size*4 or len(expected)!=len(actual):
        raise Failure('readback/reference byte count differs')
    wrong=0
    maximum=0
    first=None
    for offset in range(0,len(expected),4):
        error=max(abs(actual[offset+c]-expected[offset+c]) for c in range(4))
        maximum=max(maximum,error)
        if error>2:
            wrong+=1
            if first is None:
                first={'x':(offset//4)%size,'y':(offset//4)//size,
                       'actual':list(actual[offset:offset+4]),
                       'expected':list(expected[offset:offset+4])}
    return {'pixels_checked':size*size,'mismatched_pixels':wrong,
            'max_channel_error':maximum,'tolerance':2,'first_mismatch':first,
            'actual_sha256':hashlib.sha256(actual).hexdigest(),
            'reference_sha256':hashlib.sha256(expected).hexdigest(),
            'pass':wrong==0}

def taint():
    return int(Path('/proc/sys/kernel/tainted').read_text(encoding='ascii').strip())

def signature(lib, name, result, *arguments):
    function=getattr(lib,name)
    function.restype=result
    function.argtypes=list(arguments)
    return function

def text(value):
    return value.decode('utf-8','replace') if value else ''

class Application:
    def __init__(self, prefix, node):
        self.prefix=Path(prefix)
        self.node=node
        self.fd=-1
        self.device=None
        self.display=None
        self.surface=None
        self.context=None
        self.initialized=False
        self.current=False
        self.programs=[]
        self.shaders=[]
        self.textures=[]
        self.framebuffers=[]
        self.buffers=[]
        self.egl=None
        self.gl=None
        self.gbm=None

    def egl_ok(self, ok, operation):
        if not ok:
            error=signature(self.egl,'eglGetError',I)()
            raise Failure('%s returned failure (EGL 0x%04x)'%(operation,error))

    def gl_ok(self, operation):
        error=signature(self.gl,'glGetError',U)()
        if error:
            raise Failure('%s: GL error 0x%04x'%(operation,error))

    def open(self):
        self.gbm=C.CDLL(str(self.prefix/'lib/libgbm.so.1'),mode=C.RTLD_GLOBAL)
        self.egl=C.CDLL(str(self.prefix/'lib/libEGL.so.1'),mode=C.RTLD_GLOBAL)
        self.gl=C.CDLL(str(self.prefix/'lib/libGLESv2.so.2'),mode=C.RTLD_GLOBAL)
        self.fd=os.open(self.node,os.O_RDWR|os.O_CLOEXEC)
        self.device=signature(self.gbm,'gbm_create_device',P,I)(self.fd)
        if not self.device:
            raise Failure('gbm_create_device returned NULL')
        backend=text(signature(self.gbm,'gbm_device_get_backend_name',C.c_char_p,P)(self.device))
        get_proc=signature(self.egl,'eglGetProcAddress',P,C.c_char_p)
        address=get_proc(b'eglGetPlatformDisplayEXT')
        if not address:
            raise Failure('eglGetPlatformDisplayEXT is unavailable')
        get_display=C.CFUNCTYPE(P,U,P,C.POINTER(I))(address)
        self.display=get_display(PLATFORM_GBM,self.device,(I*1)(NONE))
        self.egl_ok(self.display,'eglGetPlatformDisplayEXT GBM')
        major,minor=I(),I()
        self.egl_ok(signature(self.egl,'eglInitialize',U,P,C.POINTER(I),C.POINTER(I))(
                    self.display,C.byref(major),C.byref(minor)),'eglInitialize')
        self.initialized=True
        query=signature(self.egl,'eglQueryString',C.c_char_p,P,I)
        extensions=text(query(self.display,0x3055))
        self.egl_ok(signature(self.egl,'eglBindAPI',U,U)(ES_API),'eglBindAPI GLES')
        choose=signature(self.egl,'eglChooseConfig',U,P,C.POINTER(I),C.POINTER(P),I,C.POINTER(I))
        config,count=P(),I()
        attrs=(I*13)(0x3040,ES2_BIT,0x3033,1,0x3024,8,0x3023,8,0x3022,8,0x3021,8,NONE)
        if choose(self.display,attrs,C.byref(config),1,C.byref(count)) and count.value:
            self.surface=signature(self.egl,'eglCreatePbufferSurface',P,P,P,C.POINTER(I))(
                self.display,config,(I*5)(0x3057,16,0x3056,16,NONE))
            self.egl_ok(self.surface,'eglCreatePbufferSurface')
        else:
            attrs=(I*5)(0x3040,ES2_BIT,0x3033,0,NONE)
            self.egl_ok(choose(self.display,attrs,C.byref(config),1,C.byref(count)) and count.value,
                        'eglChooseConfig surfaceless')
            if 'EGL_KHR_surfaceless_context' not in extensions.split():
                raise Failure('GBM has neither pbuffer nor surfaceless context support')
        self.context=signature(self.egl,'eglCreateContext',P,P,P,P,C.POINTER(I))(
            self.display,config,None,(I*3)(0x3098,2,NONE))
        self.egl_ok(self.context,'eglCreateContext GLES2')
        self.egl_ok(signature(self.egl,'eglMakeCurrent',U,P,P,P,P)(
            self.display,self.surface,self.surface,self.context),'eglMakeCurrent')
        self.current=True
        get_string=signature(self.gl,'glGetString',C.c_char_p,U)
        identity={'gl_vendor':text(get_string(0x1F00)),
                  'gl_renderer':text(get_string(0x1F01)),
                  'gl_version':text(get_string(0x1F02)),
                  'glsl_version':text(get_string(0x8B8C)),
                  'gl_extensions':sorted(text(get_string(0x1F03)).split()),
                  'egl_vendor':text(query(self.display,0x3053)),
                  'egl_version':[major.value,minor.value],
                  'gbm_backend':backend,
                  'surface':'pbuffer' if self.surface else 'surfaceless FBO'}
        identity['software_marker']=bool(re.search(r'llvmpipe|softpipe|swrast|software|swiftshader',
                                            identity['gl_renderer'],re.I))
        if identity['gl_vendor'].lower()!='freedreno' or identity['gl_renderer']!='FD001' or identity['software_marker']:
            raise Failure('expected freedreno/FD001 hardware runtime, got '+repr(identity))
        if not identity['gl_version'].startswith('OpenGL ES 2.'):
            raise Failure('this example validates the pinned GLES2 API: '+identity['gl_version'])
        ranges=(I*2)()
        precision=I()
        signature(self.gl,'glGetShaderPrecisionFormat',None,U,U,C.POINTER(I),C.POINTER(I))(
            FRAGMENT_SHADER,HIGH_FLOAT,ranges,C.byref(precision))
        if precision.value<16:
            raise Failure('fragment highp precision insufficient for this reference')
        size=I()
        signature(self.gl,'glGetIntegerv',None,U,C.POINTER(I))(0x0D33,C.byref(size))
        identity['fragment_highp']={'range':list(ranges),'precision_bits':precision.value}
        identity['max_texture_size']=size.value
        signature(self.gl,'glDisable',None,U)(DITHER)
        signature(self.gl,'glPixelStorei',None,U,I)(PACK_ALIGNMENT,1)
        self.gl_ok('application API inventory and setup')
        return identity

    def shader(self, kind, source):
        shader=signature(self.gl,'glCreateShader',U,U)(kind)
        if not shader: raise Failure('glCreateShader returned zero')
        self.shaders.append(shader)
        array=(C.c_char_p*1)(source)
        length=(I*1)(len(source))
        signature(self.gl,'glShaderSource',None,U,I,C.POINTER(C.c_char_p),C.POINTER(I))(shader,1,array,length)
        signature(self.gl,'glCompileShader',None,U)(shader)
        ok=I()
        signature(self.gl,'glGetShaderiv',None,U,U,C.POINTER(I))(shader,COMPILE_STATUS,C.byref(ok))
        if not ok.value:
            log=C.create_string_buffer(4096)
            signature(self.gl,'glGetShaderInfoLog',None,U,I,C.POINTER(I),P)(shader,len(log),None,log)
            raise Failure('shader compile: '+text(log.value))
        self.gl_ok('compile application shader')
        return shader

    def program(self, vertex, fragment):
        program=signature(self.gl,'glCreateProgram',U)()
        if not program: raise Failure('glCreateProgram returned zero')
        self.programs.append(program)
        attach=signature(self.gl,'glAttachShader',None,U,U)
        attach(program,vertex);attach(program,fragment)
        signature(self.gl,'glBindAttribLocation',None,U,U,C.c_char_p)(program,0,b'position')
        signature(self.gl,'glLinkProgram',None,U)(program)
        ok=I()
        signature(self.gl,'glGetProgramiv',None,U,U,C.POINTER(I))(program,LINK_STATUS,C.byref(ok))
        if not ok.value:
            log=C.create_string_buffer(4096)
            signature(self.gl,'glGetProgramInfoLog',None,U,I,C.POINTER(I),P)(program,len(log),None,log)
            raise Failure('program link: '+text(log.value))
        self.gl_ok('link application program')
        return program

    def uniform(self, program, name):
        location=signature(self.gl,'glGetUniformLocation',I,U,C.c_char_p)(program,name.encode('ascii'))
        if location<0: raise Failure('required uniform absent: '+name)
        return location

    def target(self, size):
        texture,framebuffer=U(),U()
        signature(self.gl,'glGenTextures',None,I,C.POINTER(U))(1,C.byref(texture))
        self.textures.append(texture)
        signature(self.gl,'glBindTexture',None,U,U)(TEXTURE_2D,texture.value)
        parameter=signature(self.gl,'glTexParameteri',None,U,U,I)
        for name,value in ((0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812F),(0x2803,0x812F)):
            parameter(TEXTURE_2D,name,value)
        signature(self.gl,'glTexImage2D',None,U,I,I,I,I,I,U,U,P)(
            TEXTURE_2D,0,RGBA,size,size,0,RGBA,UNSIGNED_BYTE,None)
        signature(self.gl,'glGenFramebuffers',None,I,C.POINTER(U))(1,C.byref(framebuffer))
        self.framebuffers.append(framebuffer)
        signature(self.gl,'glBindFramebuffer',None,U,U)(FRAMEBUFFER,framebuffer.value)
        signature(self.gl,'glFramebufferTexture2D',None,U,U,U,U,I)(
            FRAMEBUFFER,COLOR_ATTACHMENT0,TEXTURE_2D,texture.value,0)
        if signature(self.gl,'glCheckFramebufferStatus',U,U)(FRAMEBUFFER)!=FRAMEBUFFER_COMPLETE:
            raise Failure('application FBO incomplete')
        self.gl_ok('allocate application %dx%d target'%(size,size))
        return framebuffer.value

    def geometry(self):
        vertices=(C.c_float*8)(-1,-1,1,-1,-1,1,1,1)
        buffer=U()
        signature(self.gl,'glGenBuffers',None,I,C.POINTER(U))(1,C.byref(buffer))
        self.buffers.append(buffer)
        signature(self.gl,'glBindBuffer',None,U,U)(ARRAY_BUFFER,buffer.value)
        signature(self.gl,'glBufferData',None,U,C.c_ssize_t,P,U)(ARRAY_BUFFER,C.sizeof(vertices),vertices,STATIC_DRAW)
        signature(self.gl,'glEnableVertexAttribArray',None,U)(0)
        signature(self.gl,'glVertexAttribPointer',None,U,I,U,C.c_ubyte,I,P)(0,2,FLOAT,0,0,None)
        self.gl_ok('upload application VBO')

    def draw(self, program, target, size):
        signature(self.gl,'glUseProgram',None,U)(program)
        signature(self.gl,'glBindFramebuffer',None,U,U)(FRAMEBUFFER,target)
        signature(self.gl,'glViewport',None,I,I,I,I)(0,0,size,size)
        start=time.monotonic()
        signature(self.gl,'glDrawArrays',None,U,I,I)(TRIANGLE_STRIP,0,4)
        signature(self.gl,'glFinish',None)()
        self.gl_ok('application draw and finish')
        gpu_wall=time.monotonic()-start
        pixels=(C.c_ubyte*(size*size*4))()
        start=time.monotonic()
        signature(self.gl,'glReadPixels',None,I,I,I,I,U,U,P)(0,0,size,size,RGBA,UNSIGNED_BYTE,pixels)
        self.gl_ok('application pixel readback')
        return bytes(pixels),{'draw_finish_wall_ms':round(gpu_wall*1000,3),
                             'readback_wall_ms':round((time.monotonic()-start)*1000,3)}

    def cleanup(self):
        errors=[]
        def attempt(name, callback, boolean=False):
            try:
                value=callback()
                if boolean and not value:
                    raise Failure('EGL_FALSE (0x%04x)'%signature(self.egl,'eglGetError',I)())
            except Exception as error:
                errors.append({'operation':name,'error':str(error)})
        if self.current:
            for program in self.programs:
                attempt('glDeleteProgram',lambda program=program:signature(self.gl,'glDeleteProgram',None,U)(program))
            for shader in self.shaders:
                attempt('glDeleteShader',lambda shader=shader:signature(self.gl,'glDeleteShader',None,U)(shader))
            for name,objects in (('glDeleteBuffers',self.buffers),('glDeleteFramebuffers',self.framebuffers),('glDeleteTextures',self.textures)):
                for item in objects:
                    attempt(name,lambda name=name,item=item:signature(self.gl,name,None,I,C.POINTER(U))(1,C.byref(item)))
            attempt('GL cleanup error queue',lambda:self.gl_ok('delete application objects'))
            attempt('eglMakeCurrent detach',lambda:signature(self.egl,'eglMakeCurrent',U,P,P,P,P)(
                    self.display,None,None,None),True)
        if self.context:
            attempt('eglDestroyContext',lambda:signature(self.egl,'eglDestroyContext',U,P,P)(self.display,self.context),True)
        if self.surface:
            attempt('eglDestroySurface',lambda:signature(self.egl,'eglDestroySurface',U,P,P)(self.display,self.surface),True)
        if self.initialized:
            attempt('eglTerminate',lambda:signature(self.egl,'eglTerminate',U,P)(self.display),True)
        if self.device:
            attempt('gbm_device_destroy',lambda:signature(self.gbm,'gbm_device_destroy',None,P)(self.device))
        if self.fd>=0:attempt('close DRM fd',lambda:os.close(self.fd))
        return {'cleanup_pass':not errors,'cleanup_errors':errors}

def worker(args):
    result={'status':'FAIL_APPLICATION','hardware_application_pass':False,'validation_pass':False,
            'context_index':args.worker_context,'uid':os.geteuid(),'groups':os.getgroups(),
            'requested_iterations':args.iterations,'completed_iterations':0,
            'frames':[],'cleanup_pass':False,'kernel':os.uname().release}
    application=Application(args.prefix,args.node)
    try:
        if os.geteuid()==0:raise Failure('run the example as ordinary dior/video user')
        result['kernel_taint_before']=taint()
        if result['kernel_taint_before']!=0:raise Failure('kernel was already tainted')
        result['identity']=application.open()
        vertex=application.shader(VERTEX_SHADER,VERTEX)
        gradient=application.program(vertex,application.shader(FRAGMENT_SHADER,GRADIENT))
        checker=application.program(vertex,application.shader(FRAGMENT_SHADER,CHECKER))
        targets={128:application.target(128),256:application.target(256)}
        application.geometry()
        locations={'size':application.uniform(gradient,'imageSize'),
                   'affine':application.uniform(gradient,'affine'),
                   'shift':application.uniform(checker,'pixelShift'),
                   'foreground':application.uniform(checker,'foreground'),
                   'background':application.uniform(checker,'background')}
        use=signature(application.gl,'glUseProgram',None,U)
        uniform4=signature(application.gl,'glUniform4f',None,I,C.c_float,C.c_float,C.c_float,C.c_float)
        uniform2=signature(application.gl,'glUniform2f',None,I,C.c_float,C.c_float)
        uniform1=signature(application.gl,'glUniform1f',None,I,C.c_float)
        for iteration in range(args.iterations):
            phase=iteration+args.worker_context
            coefficients=AFFINES[phase%len(AFFINES)]
            foreground,background=PALETTES[phase%len(PALETTES)]
            shift=5*iteration+3*args.worker_context
            use(gradient);uniform2(locations['size'],128,128);uniform4(locations['affine'],*coefficients)
            application.gl_ok('set gradient uniforms')
            actual,timing=application.draw(gradient,targets[128],128)
            check=compare(actual,gradient_reference(128,coefficients),128)
            result['frames'].append(dict(check,shader='affine_gradient',size=128,iteration=iteration+1,
                                         uniforms={'affine':list(coefficients)},**timing))
            if not check['pass']:raise Failure('affine gradient differs from independent CPU reference')
            use(checker);uniform1(locations['shift'],shift)
            uniform4(locations['foreground'],*foreground);uniform4(locations['background'],*background)
            application.gl_ok('set animated checker uniforms')
            actual,timing=application.draw(checker,targets[256],256)
            check=compare(actual,checker_reference(256,shift,foreground,background),256)
            result['frames'].append(dict(check,shader='animated_checker',size=256,iteration=iteration+1,
                                         uniforms={'pixel_shift':shift,'foreground':list(foreground),
                                                   'background':list(background)},**timing))
            if not check['pass']:raise Failure('animated checker differs from independent CPU reference')
            result['completed_iterations']+=1
    except Exception as error:
        result['error']=str(error)
    finally:
        result.update(application.cleanup())
        try:result['kernel_taint_after']=taint()
        except Exception as error:result['taint_read_error']=str(error)
    result['validation_pass']=bool(not result.get('error') and not result.get('taint_read_error')
        and result['cleanup_pass'] and result.get('kernel_taint_after')==0
        and result['completed_iterations']==args.iterations
        and len(result['frames'])==2*args.iterations and all(frame['pass'] for frame in result['frames']))
    result['hardware_application_pass']=result['validation_pass']
    result['status']='PASS_HARDWARE_APPLICATION' if result['validation_pass'] else 'FAIL_APPLICATION'
    return result

def supervise(args):
    result={'status':'FAIL_APPLICATION_SUITE','validation_pass':False,'hardware_application_pass':False,
            'example_scope':'ordinary Linux process; explicitly selected isolated EGL/GLES2/GBM runtime',
            'gpu_apis_verified':['OpenGL ES 2.0 rasterization and shader uniforms'],
            'compute_shader_verified':False,'opencl_verified':False,
            'expected_renderer':'FD001','contexts_requested':args.contexts,'contexts_completed':0,
            'iterations_per_context':args.iterations,'frames_requested':args.contexts*args.iterations*2,
            'runtime_prefix':str(Path(args.prefix).resolve()),'node':args.node,'cases':[]}
    deadline=time.monotonic()+args.timeout
    prefix=Path(args.prefix).resolve()
    env=os.environ.copy()
    env['LD_LIBRARY_PATH']=str(prefix/'lib')
    env['LIBGL_DRIVERS_PATH']=str(prefix/'lib/dri')
    env['MESA_LOADER_DRIVER_OVERRIDE']='kgsl'
    env.pop('LIBGL_ALWAYS_SOFTWARE',None)
    env.pop('GALLIUM_DRIVER',None)
    env.pop('FD_MESA_DEBUG',None)
    env.pop('MESA_GLSL',None)
    try:
        result['runtime_sha256']={}
        for relative in ('lib/libEGL.so.1','lib/libGLESv2.so.2','lib/libgbm.so.1','lib/dri/kgsl_dri.so'):
            result['runtime_sha256'][relative]=hashlib.sha256((prefix/relative).read_bytes()).hexdigest()
        for index in range(args.contexts):
            remaining=deadline-time.monotonic()
            if remaining<=0:raise Failure('suite deadline exceeded')
            command=[sys.executable,str(Path(__file__).resolve()),'--worker-context',str(index),
                     '--prefix',str(prefix),'--node',args.node,'--iterations',str(args.iterations)]
            start=time.monotonic()
            process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
            try:
                stdout,stderr=process.communicate(timeout=min(args.child_timeout,remaining))
            except subprocess.TimeoutExpired as timeout:
                process.kill()
                try:stdout,stderr=process.communicate(timeout=2)
                except subprocess.TimeoutExpired as pending:
                    stdout=pending.stdout or b'';stderr=pending.stderr or b''
                result['cases'].append({'context_index':index,'status':'FAIL_TIMEOUT','pid':process.pid,
                                        'returncode':process.poll(),'validation_pass':False,
                                        'stdout':text(stdout)[-2048:],'stderr':text(stderr)[-8192:]})
                raise Failure('context %d exceeded its bounded deadline'%index)
            elapsed=time.monotonic()-start
            try:case=json.loads(stdout)
            except (ValueError,UnicodeError):
                case={'context_index':index,'status':'FAIL_NATIVE_PROCESS','validation_pass':False,
                      'stdout':text(stdout)[-2048:]}
            case['returncode']=process.returncode
            case['elapsed_seconds']=round(elapsed,3)
            case['stderr']=text(stderr)[-8192:]
            result['cases'].append(case)
            valid=bool(process.returncode==0 and case.get('status')=='PASS_HARDWARE_APPLICATION'
                       and case.get('validation_pass') is True and case.get('hardware_application_pass') is True
                       and case.get('cleanup_pass') is True and not case.get('cleanup_errors')
                       and case.get('completed_iterations')==args.iterations
                       and len(case.get('frames',[]))==args.iterations*2
                       and all(frame.get('pass') is True for frame in case.get('frames',[]))
                       and case.get('identity',{}).get('gl_renderer')=='FD001'
                       and case.get('identity',{}).get('software_marker') is False
                       and case.get('uid',0)!=0)
            if not valid:raise Failure('context %d did not complete the application gate'%index)
            result['contexts_completed']+=1
        result['validation_pass']=True
        result['hardware_application_pass']=True
        result['status']='PASS_HARDWARE_APPLICATION_SUITE'
        result['frames_completed']=sum(len(case['frames']) for case in result['cases'])
    except Exception as error:result['error']=str(error)
    result['elapsed_seconds']=round(args.timeout-(deadline-time.monotonic()),3)
    result['timeout_seconds']=args.timeout
    return result

def self_test():
    gradient=gradient_reference(128,AFFINES[0])
    checker=checker_reference(256,0,*PALETTES[0])
    if list(gradient[:4])!=[0,32,33,255] or list(gradient[-4:])!=[127,159,222,255]:
        raise Failure('gradient reference corner calculation failed')
    if list(checker[:4])!=[159,32,191,255] or list(checker[16*4:16*4+4])!=[32,191,64,255]:
        raise Failure('checker cell boundary reference failed')
    damaged=bytearray(gradient);damaged[0]=255
    if not compare(gradient,gradient,128)['pass'] or compare(damaged,gradient,128)['pass']:
        raise Failure('complete pixel comparison did not detect a changed pixel')
    return {'status':'PASS_CPU_REFERENCE_ONLY','cpu_reference_pass':True,
            'validation_pass':False,'hardware_application_pass':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix',default='/opt/dior-graphics')
    parser.add_argument('--node',default='/dev/dri/card0')
    parser.add_argument('--contexts',type=int,default=3)
    parser.add_argument('--iterations',type=int,default=3)
    parser.add_argument('--timeout',type=float,default=180)
    parser.add_argument('--child-timeout',type=float,default=50)
    parser.add_argument('--worker-context',type=int,default=None,help=argparse.SUPPRESS)
    parser.add_argument('--self-test',action='store_true')
    args=parser.parse_args()
    if not 1<=args.contexts<=8 or not 1<=args.iterations<=32 or not 1<=args.timeout<=600 or not 1<=args.child_timeout<=120:
        parser.error('bounded contexts/iterations/deadlines required')
    if args.self_test:
        result=self_test();print(json.dumps(result));return 0
    if args.worker_context is not None:
        # Keep JSON on its own fd; Mesa/library stdout logs go to stderr.
        output=os.dup(1)
        os.dup2(2,1)
        result=worker(args)
        os.write(output,(json.dumps(result,sort_keys=True)+'\n').encode('utf-8'))
        os.close(output)
    else:
        result=supervise(args)
        print(json.dumps(result,sort_keys=True,indent=2))
    return 0 if result['validation_pass'] else 1

if __name__=='__main__':
    raise SystemExit(main())

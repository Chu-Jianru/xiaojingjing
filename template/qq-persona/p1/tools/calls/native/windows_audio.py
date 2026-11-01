"""Explicit virtual endpoints only. Native AVSDK command 102 selects its mic."""
# Command 102 uses the IMMDevice active collection, NOT QQ's 20061 list.
# MMDevice enumeration follows RicterZ/maibot-qq-voice-call 2c032a6 (GPL-3.0).
import threading
_inventory_lock=threading.Lock()

def native_device_inventory():
    # PortAudio may initialize the caller as STA. Keep metadata COM objects
    # entirely on one MTA worker, rather than changing its apartment model.
    if not _inventory_lock.acquire(blocking=False): raise RuntimeError('Audio inventory already running')
    values=[]; errors=[]
    def run():
        try: values.append(_native_device_inventory())
        except Exception as error: errors.append(error)
        finally: _inventory_lock.release()
    worker=threading.Thread(target=run,daemon=True)
    try: worker.start()
    except BaseException:
        _inventory_lock.release(); raise
    worker.join(2)
    if worker.is_alive(): raise RuntimeError('Audio inventory timed out')
    if errors: raise errors[0]
    return values[0]

def _native_device_inventory():
    import ctypes
    import uuid
    import winreg
    class GUID(ctypes.Structure):
        _fields_ = [('data', ctypes.c_ubyte*16)]
        def __init__(self, text): super().__init__((ctypes.c_ubyte*16).from_buffer_copy(uuid.UUID(text).bytes_le))
    def method(obj, slot, result, *args):
        table=ctypes.cast(obj,ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return ctypes.WINFUNCTYPE(result,ctypes.c_void_p,*args)(table[slot])
    def check(hr):
        if hr<0: raise RuntimeError('Windows audio metadata unavailable')
    def release(obj):
        if obj: method(obj,2,ctypes.c_ulong)(obj)
    ole=ctypes.OleDLL('ole32'); check(ole.CoInitializeEx(None,0))
    enumerator=ctypes.c_void_p(); result={}
    try:
        check(ole.CoCreateInstance(ctypes.byref(GUID('bcde0395-e52f-467c-8e3d-c4579291692e')),None,23,
            ctypes.byref(GUID('a95664d2-9614-4f35-a746-de8db63617e6')),ctypes.byref(enumerator)))
        for flow, direction, key in [(0,'output','Render'),(1,'input','Capture')]:
            collection=ctypes.c_void_p(); result[direction]=[]
            try:
                check(method(enumerator,3,ctypes.c_long,ctypes.c_int,ctypes.c_uint,ctypes.POINTER(ctypes.c_void_p))(
                    enumerator,flow,1,ctypes.byref(collection)))
                count=ctypes.c_uint()
                check(method(collection,3,ctypes.c_long,ctypes.POINTER(ctypes.c_uint))(collection,ctypes.byref(count)))
                if count.value>256: raise RuntimeError('Too many native audio endpoints')
                for index in range(count.value):
                    device=ctypes.c_void_p(); text=ctypes.c_void_p()
                    try:
                        check(method(collection,4,ctypes.c_long,ctypes.c_uint,ctypes.POINTER(ctypes.c_void_p))(collection,index,ctypes.byref(device)))
                        check(method(device,5,ctypes.c_long,ctypes.POINTER(ctypes.c_void_p))(device,ctypes.byref(text)))
                        identity=ctypes.wstring_at(text)
                        endpoint=identity[identity.rfind('{'):]
                        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r'SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio'+ '\\'+key+'\\'+endpoint+r'\Properties') as props:
                            try: name=winreg.QueryValueEx(props,'{a45c254e-df1c-4efd-8020-67d146a850e0},14')[0]
                            except FileNotFoundError:
                                label=winreg.QueryValueEx(props,'{a45c254e-df1c-4efd-8020-67d146a850e0},2')[0]
                                try: adapter=winreg.QueryValueEx(props,'{b3f8fa53-0004-438e-9003-51a46e139bfc},6')[0]
                                except FileNotFoundError: adapter=''
                                name=str(label)+(' ('+str(adapter)+')' if adapter else '')
                        result[direction].append({'id':index+1,'name':str(name),'guid':identity})
                    finally:
                        if text: ole.CoTaskMemFree(text)
                        release(device)
            finally: release(collection)
        return result
    finally:
        release(enumerator); ole.CoUninitialize()

def cable_device(name, channels):
    import sounddevice as sd
    candidates = [i for i, d in enumerate(sd.query_devices()) if d['name'] == name
                  and d[channels] >= 2
                  and sd.query_hostapis(d['hostapi'])['name'] == 'Windows WASAPI']
    if len(candidates) != 1:
        raise RuntimeError('Expected exactly one WASAPI VB-Cable endpoint: ' + name)
    return candidates[0]

def cable_render_device():
    return cable_device('CABLE Input (VB-Audio Virtual Cable)', 'max_output_channels')

def cable_capture_device():
    return cable_device('CABLE Output (VB-Audio Virtual Cable)', 'max_input_channels')

"use strict";
// Documented Core Audio interfaces only; no QQ offsets, defaults or PCM access.
// Loaded only inside the verified, isolated bot AV Host's PPAPI child.
const config = __CONFIG__;
const roots = [], hooks = [], addresses = new Set();
let redirects = 0, baseline = 0, errors = 0, activations = 0;
function keep(value) { roots.push(value); return value; }
function guid(bytes) { const p = keep(Memory.alloc(16)); p.writeByteArray(bytes); return p; }
const clsid = guid([0x95,0x03,0xde,0xbc,0x2f,0xe5,0x7c,0x46,0x8e,0x3d,0xc4,0x57,0x92,0x91,0x69,0x2e]);
const enumIid = guid([0xd2,0x64,0x56,0xa9,0x14,0x96,0x35,0x4f,0xa7,0x46,0xde,0x8d,0xb6,0x36,0x17,0xe6]);
const clientIid = guid([0x4c,0xad,0xb9,0x1c,0xfa,0xdb,0x32,0x4c,0xb1,0x78,0xc2,0xf5,0x68,0xa7,0x03,0xb2]);
const invalidIid = guid(Array(16).fill(0));
const targetId = keep(Memory.allocUtf16String(config.capture));
const ole = Module.load("ole32.dll");
const coinit = new NativeFunction(ole.getExportByName("CoInitializeEx"), "int", ["pointer","uint"]);
const uninit = new NativeFunction(ole.getExportByName("CoUninitialize"), "void", []);
const create = new NativeFunction(ole.getExportByName("CoCreateInstance"), "int", ["pointer","pointer","uint","pointer","pointer"]);
const free = new NativeFunction(ole.getExportByName("CoTaskMemFree"), "void", ["pointer"]);
function method(obj, slot, result, args) {
  return new NativeFunction(obj.readPointer().add(slot * Process.pointerSize).readPointer(), result, ["pointer", ...args]);
}
function output() { const p = Memory.alloc(Process.pointerSize); p.writePointer(ptr(0)); return p; }
function check(hr) { if (hr < 0) throw Error("Core Audio unavailable"); }
function release(obj) { method(obj, 2, "uint", [])(obj); }
function enumerator() {
  const p = output(); check(create(clsid, ptr(0), 1, enumIid, p)); return p.readPointer();
}
function device(en, id) {
  const p = output(); check(method(en, 5, "int", ["pointer","pointer"])(en, id, p)); return p.readPointer();
}
function identity(dev) {
  const p = output(); check(method(dev, 5, "int", ["pointer"])(dev, p));
  const text = p.readPointer();
  try { return text.readUtf16String(); } finally { free(text); }
}
function bind(dev) {
  const addr = dev.readPointer().add(3 * Process.pointerSize).readPointer();
  if (addresses.has(addr.toString())) return;
  if (addresses.size >= 16) throw Error("Unexpected audio implementations");
  addresses.add(addr.toString());
  hooks.push(Interceptor.attach(addr, {
    onEnter(args) {
      this.replacement = null;
      try {
        // Reading endpoint identity opens no audio stream. Render is untouched.
        const id = identity(args[0]).toLowerCase();
        if (!id.startsWith("{0.0.1.00000000}.")) return;
        if (errors) throw Error("Route guard faulted");
        activations++;
        if (id === config.capture.toLowerCase()) return;
        const en = enumerator();
        try { this.replacement = device(en, targetId); } finally { release(en); }
        args[0] = this.replacement;
        redirects++;
      } catch (_) {
        errors++;
        // An unsupported IID fails before IAudioClient can be obtained. Never
        // leave the original physical activation in place after a guard fault.
        args[1] = invalidIid;
      }
    },
    onLeave(_) {
      if (this.replacement) {
        try { release(this.replacement); } catch (_) { errors++; }
        this.replacement = null;
      }
    },
  }));
}
function initialize() {
  check(coinit(ptr(0), 0));
  const en = enumerator();
  try {
    for (const id of config.inputs) {
      const dev = device(en, Memory.allocUtf16String(id));
      try { bind(dev); } finally { release(dev); }
    }
    // One startup self-test obtains and releases a virtual IAudioClient only.
    // It never initializes/starts a stream or reads microphone samples.
    const sourceId = config.inputs.find(id => id.toLowerCase() !== config.capture.toLowerCase());
    if (!sourceId) throw Error("No independent activation probe");
    const dev = device(en, Memory.allocUtf16String(sourceId));
    const p = output(), before = redirects;
    try {
      check(method(dev, 3, "int", ["pointer","uint","pointer","pointer"])(dev, clientIid, 23, ptr(0), p));
      if (redirects !== before + 1 || errors) throw Error("Activation redirection failed");
    } finally {
      if (!p.readPointer().isNull()) release(p.readPointer());
      release(dev);
    }
    baseline = redirects;
  } finally { release(en); uninit(); }
}
initialize();
rpc.exports = {
  status() { return { pid: Process.id, installed: errors === 0, redirects: redirects - baseline, activations, errors }; },
};

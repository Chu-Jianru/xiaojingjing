"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");

class AudioRouteGuard {
  constructor(python, directory, hostPid, spawnChild = spawn) {
    this.python = python; this.directory = directory; this.hostPid = hostPid;
    this.spawnChild = spawnChild; this.child = null; this.timer = null;
    this.state = { installed: false, errors: 0 }; this.updated = 0; this.closed = false;
  }
  start() {
    if (this.closed || this.child) return;
    const child = this.spawnChild(this.python, ["-u", path.join(this.directory, "route_guard.py"), "--host", String(this.hostPid)],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    this.child = child; this.updated = 0;
    let pending = "";
    child.stdout.setEncoding("ascii");
    child.stdout.on("data", chunk => {
      if (this.child !== child) return;
      pending += chunk;
      if (pending.length > 8192) { child.kill(); return; }
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const value = JSON.parse(line);
          this.state = { installed: value.installed === true && value.hostPid === this.hostPid,
            pid: Number.isSafeInteger(value.pid) ? value.pid : null,
            redirects: Number.isSafeInteger(value.redirects) ? value.redirects : 0,
            errors: Number.isSafeInteger(value.errors) ? value.errors : 1 };
          this.updated = Date.now();
        } catch { this.state.installed = false; child.kill(); }
      }
    });
    child.stdin.on("error", () => {});
    const exited = () => {
      if (this.child !== child) return;
      this.child = null; this.state.installed = false; this.updated = 0;
      if (!this.closed) this.timer = setTimeout(() => this.start(), 3000);
    };
    child.once("exit", exited); child.once("error", exited);
    // A hung helper cannot retain readiness or prevent bounded recovery.
    const started = Date.now();
    const healthTimer = setInterval(() => {
      if (this.child === child && Date.now() - (this.updated || started) > 12000) child.kill();
    }, 1000);
    this.healthTimer = healthTimer;
    child.once("close", () => clearInterval(healthTimer));
  }
  status(pids, now = Date.now()) {
    return { ...this.state, ready: Boolean(this.child && this.state.installed && this.state.errors === 0
      && now - this.updated < 4000 && pids.includes(this.state.pid)) };
  }
  close() {
    this.closed = true; clearTimeout(this.timer); clearInterval(this.healthTimer);
    this.state.installed = false;
    const child = this.child;
    if (child) {
      child.stdin.end("stop\n");
      const timer = setTimeout(() => { if (this.child === child) child.kill(); }, 2000);
      timer.unref(); child.once("exit", () => clearTimeout(timer));
    }
  }
}
module.exports = { AudioRouteGuard };

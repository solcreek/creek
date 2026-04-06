// Minimal node:http shim for CF Workers.
// Plain objects with the minimum API surface that Next.js handler needs.
// Does NOT extend from node:stream (CF Workers stream compat may be incomplete).

import { EventEmitter } from "node:events";

export class IncomingMessage extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket || { encrypted: true, remoteAddress: "127.0.0.1", address: () => ({ port: 443 }), end() {}, destroy() {} };
    this.connection = this.socket;
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = true;
    this.headers = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    this.method = "GET";
    this.url = "/";
    this.statusCode = null;
    this.statusMessage = null;
    this.aborted = false;
    this.upgrade = false;
    this.readable = true;
    this._body = null;
    this._bodyConsumed = false;
  }
  // Readable stream interface (minimal)
  read() { return null; }
  push(chunk) {
    if (chunk === null) { this.complete = true; this.emit("end"); return; }
    this.emit("data", chunk);
  }
  pipe(dest) { return dest; }
  unpipe() {}
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
  setTimeout() { return this; }
  destroy() { this.emit("close"); return this; }
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      async next() { return { done: true, value: undefined }; }
    };
  }
}

export class ServerResponse extends EventEmitter {
  constructor(req) {
    super();
    this.req = req;
    this.statusCode = 200;
    this.statusMessage = "";
    this.headersSent = false;
    this.finished = false;
    this.writable = true;
    this.sendDate = true;
    this._headers = {};
    this._headerNames = {};
    this.socket = req?.socket || { encrypted: true, remoteAddress: "127.0.0.1" };
    this.connection = this.socket;
  }
  setHeader(name, value) { this._headers[name.toLowerCase()] = value; this._headerNames[name.toLowerCase()] = name; }
  getHeader(name) { return this._headers[name.toLowerCase()]; }
  getHeaders() { return { ...this._headers }; }
  getHeaderNames() { return Object.keys(this._headers); }
  hasHeader(name) { return name.toLowerCase() in this._headers; }
  removeHeader(name) { delete this._headers[name.toLowerCase()]; delete this._headerNames[name.toLowerCase()]; }
  writeHead(code, msg, hdrs) {
    this.statusCode = code;
    if (typeof msg === "string") this.statusMessage = msg;
    else if (typeof msg === "object") hdrs = msg;
    if (hdrs) Object.entries(hdrs).forEach(([k, v]) => this.setHeader(k, v));
    this.headersSent = true;
    return this;
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    this.emit("data", chunk);
    if (cb) cb();
    return true;
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = null; }
    if (typeof encoding === "function") { cb = encoding; encoding = null; }
    if (chunk) this.emit("data", chunk);
    this.finished = true;
    this.writable = false;
    this.emit("finish");
    this.emit("close");
    if (cb) cb();
    return this;
  }
  flushHeaders() { this.headersSent = true; }
  assignSocket() {}
  detachSocket() {}
  writeContinue() {}
  writeProcessing() {}
  setTimeout() { return this; }
  addTrailers() {}
  cork() {}
  uncork() {}
  // Writable interface stubs
  destroy() { return this; }
}

export function createServer() { throw new Error("http.createServer not available in CF Workers"); }
export function request() { throw new Error("http.request not available in CF Workers"); }
export function get() { throw new Error("http.get not available in CF Workers"); }

export const METHODS = ["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"];
export const STATUS_CODES = { 200:"OK",201:"Created",204:"No Content",301:"Moved Permanently",302:"Found",304:"Not Modified",400:"Bad Request",401:"Unauthorized",403:"Forbidden",404:"Not Found",500:"Internal Server Error" };

export default { IncomingMessage, ServerResponse, createServer, request, get, METHODS, STATUS_CODES };

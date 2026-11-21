// Incremental SHA-256 (lets the browser hash large files piece by piece).
(function (root) {
  const K = new Uint32Array(64);
  const H0 = new Uint32Array(8);
  (function init() {
    const frac = (x) => Math.floor((x - Math.floor(x)) * 4294967296);
    let n = 2, i = 0;
    while (i < 64) {
      let prime = true;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (prime) {
        if (i < 8) H0[i] = frac(Math.sqrt(n));
        K[i++] = frac(Math.cbrt(n));
      }
      n++;
    }
  })();

  function Sha256() {
    this.h = new Uint32Array(H0);
    this.buf = new Uint8Array(64);
    this.n = 0;
    this.len = 0;
    this.w = new Uint32Array(64);
  }

  Sha256.prototype.block = function (data, o) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++, o += 4) w[i] = (data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  };

  Sha256.prototype.update = function (d) {
    this.len += d.length;
    let i = 0;
    if (this.n) {
      while (i < d.length && this.n < 64) this.buf[this.n++] = d[i++];
      if (this.n === 64) { this.block(this.buf, 0); this.n = 0; }
    }
    for (; i + 64 <= d.length; i += 64) this.block(d, i);
    while (i < d.length) this.buf[this.n++] = d[i++];
    return this;
  };

  Sha256.prototype.hex = function () {
    const bits = this.len * 8;
    const pad = new Uint8Array(((this.n < 56 ? 56 : 120) - this.n) + 8);
    pad[0] = 0x80;
    const hi = Math.floor(this.len / 536870912), lo = (this.len << 3) >>> 0;
    const l = pad.length;
    pad[l - 8] = hi >>> 24; pad[l - 7] = hi >>> 16; pad[l - 6] = hi >>> 8; pad[l - 5] = hi;
    pad[l - 4] = lo >>> 24; pad[l - 3] = lo >>> 16; pad[l - 2] = lo >>> 8; pad[l - 1] = lo;
    void bits;
    const saved = this.len;
    this.update(pad);
    this.len = saved;
    return Array.from(this.h, (v) => v.toString(16).padStart(8, '0')).join('');
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Sha256;
  else root.Sha256 = Sha256;
})(typeof self !== 'undefined' ? self : this);

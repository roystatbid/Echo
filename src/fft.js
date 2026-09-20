// Minimal radix-2 Cooley-Tukey FFT. No dependencies so the app can be served as
// static files straight from GitHub Pages and still run offline on the iPad.

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export class FFT {
  /** @param {number} n transform size, must be a power of two */
  constructor(n) {
    if (n < 1 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of 2, got ${n}`);
    this.n = n;
    const levels = Math.round(Math.log2(n));

    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }

    // Bit-reversal permutation table.
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  /** Forward transform, in place. */
  transform(re, im) {
    const n = this.n;
    if (n === 1) return;

    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = this.cos[k], s = this.sin[k];
          const tre = re[l] * c + im[l] * s;
          const tim = im[l] * c - re[l] * s;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /** Inverse transform, in place, including the 1/n scaling. */
  inverse(re, im) {
    this.transform(im, re); // swapping re/im conjugates in and out
    const n = this.n;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

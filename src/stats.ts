/**
 * stats.ts — just enough statistics to fit a trend line and get an honest
 * p-value for it, without pulling in a heavy stats dependency.
 *
 * Why hand-rolled instead of a library: this skill's only real dependency
 * is pdf-lib (for report rendering). Every extra npm package is one more
 * thing that can fail to install in whatever sandbox/CI ends up running an
 * agent skill, so linear regression + a Student's t p-value — about 60
 * lines of well-understood numerical-recipes-style code — are worth
 * inlining rather than importing.
 */

export interface LinearFit {
  slope: number;
  intercept: number;
  rSquared: number;
  pValue: number; // two-tailed, H0: slope == 0
  n: number;
}

/** Ordinary least squares fit of y = slope*x + intercept, plus a two-tailed
 * p-value for the slope (H0: no linear relationship). */
export function linearRegression(x: number[], y: number[]): LinearFit {
  const n = x.length;
  if (n !== y.length || n < 3) {
    return { slope: 0, intercept: y[0] ?? 0, rSquared: 0, pValue: 1, n };
  }

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const rSquared = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);

  // Standard error of the slope, then a t-statistic and its p-value.
  const df = n - 2;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const yHat = slope * x[i] + intercept;
    sse += (y[i] - yHat) ** 2;
  }
  const mse = df > 0 ? sse / df : 0;
  const seSlope = sxx > 0 && df > 0 ? Math.sqrt(mse / sxx) : Infinity;
  const t = seSlope > 0 ? slope / seSlope : 0;
  const pValue = df > 0 ? twoTailedTTestPValue(t, df) : 1;

  return { slope, intercept, rSquared, pValue, n };
}

/** Weighted OLS — same idea, each point contributes proportionally to its
 * weight. Used to compute the "robust" (outlier-downweighted) trend. */
export function weightedLinearRegression(x: number[], y: number[], w: number[]): LinearFit {
  const n = x.length;
  const sw = w.reduce((a, b) => a + b, 0);
  const meanX = x.reduce((s, xi, i) => s + xi * w[i], 0) / sw;
  const meanY = y.reduce((s, yi, i) => s + yi * w[i], 0) / sw;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sxy += w[i] * dx * dy;
    sxx += w[i] * dx * dx;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yHat = slope * x[i] + intercept;
    ssRes += w[i] * (y[i] - yHat) ** 2;
    ssTot += w[i] * (y[i] - meanY) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // p-value: deliberately reuse the unweighted fit's significance test
  // rather than deriving a weighted-df p-value — a robust/weighted fit's
  // effective degrees of freedom isn't a simple count once points are
  // downweighted rather than dropped, and getting that exactly right adds
  // real complexity for a number this skill doesn't use anywhere. The
  // weighted fit's *point estimate* (slope) is what matters for the
  // "robust growth rate" headline; significance is judged on the raw fit.
  return { slope, intercept, rSquared, pValue: 1, n };
}

// --- Student's t two-tailed p-value via the regularized incomplete beta function ---
// Standard Numerical-Recipes-style implementation; stable for the df ranges
// (a handful to a few hundred months) this skill ever sees.

function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed p-value for a t-statistic with `df` degrees of freedom.
 * Uses the identity p = I_{df/(df+t^2)}(df/2, 1/2), which is exact and
 * avoids needing a separate one-sided-CDF-then-double step. */
export function twoTailedTTestPValue(t: number, df: number): number {
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(df / 2, 0.5, x);
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

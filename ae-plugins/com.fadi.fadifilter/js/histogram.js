export function cutoffs(histogram, count, method) {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (!total) throw new Error('No opaque pixels in the current frame');
  if (method === 'M7') {
    let seen = 0;
    return [(histogram.findIndex(value => (seen += value) >= total * .42) + .5) / histogram.length];
  }
  if (method === 'M1') {
    const result = [];
    let next = 1, seen = 0;
    histogram.forEach((n, i) => {
      seen += n;
      while (next < count && seen >= total * next / count) {
        result.push((i + 0.5) / histogram.length);
        next++;
      }
    });
    return result;
  }
  const n = histogram.length;
  const weights = [0], sums = [0];
  histogram.forEach((value, i) => {
    weights.push(weights[i] + value);
    sums.push(sums[i] + value * i);
  });
  let best = Array(n + 1).fill(-Infinity);
  best[0] = 0;
  const back = [];
  for (let k = 1; k <= count; k++) {
    const next = Array(n + 1).fill(-Infinity), parent = [];
    for (let end = k; end <= n; end++) {
      for (let start = k - 1; start < end; start++) {
        const mass = weights[end] - weights[start];
        const moment = sums[end] - sums[start];
        const score = best[start] + (mass ? moment * moment / mass : 0);
        if (score > next[end]) { next[end] = score; parent[end] = start; }
      }
    }
    best = next;
    back.push(parent);
  }
  const result = [];
  for (let k = count - 1, end = n; k > 0; k--) {
    end = back[k][end];
    result.unshift(end / n);
  }
  return result;
}

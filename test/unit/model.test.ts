import { FREE_TIER, absoluteCeiling, billedMs, breakEvenMs, ceiling, freeRequests, gbSecondsPerRequest, lambdaBill, meanOfBilled } from '../../model/free-tier';

const cents = (x: number) => Math.round(x * 100) / 100;

test('Lambda bills each request rounded up to the next millisecond, at least 1 ms', () => {
  expect(billedMs(0.2)).toBe(1);
  expect(billedMs(1.01)).toBe(2);
  expect(billedMs(12)).toBe(12);
});

test('a mean of billed durations is used as it is, never rounded again', () => {
  // Our first model rounded this mean up to 2 ms and overstated compute by 57%.
  expect(meanOfBilled(1.27)).toBe(1.27);
  expect(() => meanOfBilled(0.9)).toThrow(/at least 1 ms/);
});

test('GB-seconds per request', () => {
  expect(gbSecondsPerRequest(100, 1024)).toBe(0.1);
  expect(gbSecondsPerRequest(20, 128)).toBe(0.0025);
});

test.each([
  [128, 3200],
  [256, 1600],
  [512, 800],
  [1024, 400],
])('at %i MB, compute runs out with the request allowance at a mean of %i ms', (mb, ms) => {
  expect(breakEvenMs(mb)).toBeCloseTo(ms, 6);
});

test('a fast API runs out of free requests long before free compute', () => {
  expect(freeRequests(20, 256)).toEqual({ byCompute: 80_000_000, byCount: 1_000_000, free: 1_000_000, binding: 'requests' });
});

test('a slow, big function runs out of compute first', () => {
  const f = freeRequests(2000, 1024);
  expect(f.binding).toBe('compute');
  expect(f.free).toBe(200_000);
});

test('the bill past the free tier: arm64 compute is cheaper than x86, requests cost the same', () => {
  const arm = lambdaBill(3_000_000, 500, 1024, 'arm64');
  const x86 = lambdaBill(3_000_000, 500, 1024, 'x86_64');
  expect(cents(arm.requestCost)).toBe(0.4);
  expect(arm.requestCost).toBe(x86.requestCost);
  expect(arm.gbSeconds).toBe(1_500_000);
  expect(cents(arm.computeCost)).toBe(14.67); // 1,100,000 GB-s x $0.0000133334
  expect(cents(x86.computeCost)).toBe(18.33); // 1,100,000 GB-s x $0.0000166667
});

test('inside the free tier the bill is $0', () => {
  expect(lambdaBill(FREE_TIER.lambdaRequests, 20, 256, 'arm64').total).toBe(0);
});

test('the function URL caps a fast function at 10 requests per second per reserved unit', () => {
  const c = ceiling(2, 5, 256, 'arm64');
  expect(c.requests).toBe(20 * 31 * 86400);
  expect(cents(c.requestCost)).toBe(10.51);
});

test('a slow function is capped by concurrency instead', () => {
  const c = ceiling(2, 1000, 256, 'arm64');
  expect(c.requests).toBe(2 * 31 * 86400);
  expect(c.gbSeconds).toBe(2 * 0.25 * 31 * 86400);
});

test('the worst month with reserved concurrency 2 at 256 MB on arm64 costs $23.04', () => {
  const worst = absoluteCeiling(2, 256, 'arm64');
  expect(worst.requests).toBe(53_568_000);
  expect(worst.gbSeconds).toBe(1_339_200);
  expect(cents(worst.total)).toBe(23.04);
  // No duration does worse.
  for (const ms of [1, 10, 50, 99, 101, 500, 5000]) expect(ceiling(2, ms, 256, 'arm64').total).toBeLessThanOrEqual(worst.total + 1e-9);
});

test('reserved concurrency 1 at 128 MB keeps compute inside the free tier, whatever the traffic', () => {
  const worst = absoluteCeiling(1, 128, 'arm64');
  expect(worst.gbSeconds).toBeLessThan(FREE_TIER.lambdaGbSeconds);
  expect(worst.computeCost).toBe(0);
  expect(cents(worst.total)).toBe(5.16);
});

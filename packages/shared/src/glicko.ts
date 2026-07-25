/**
 * Glicko-2 rating (Glickman 2013). Ratings are per game. After each match both
 * players are updated against each other with result ∈ {1 win, 0.5 draw, 0 loss}.
 * Defaults: rating 1500, RD 350, volatility 0.06, system constant τ = 0.5.
 */

export interface Glicko {
  rating: number;
  rd: number;
  vol: number;
}

export const DEFAULT_GLICKO: Glicko = { rating: 1500, rd: 350, vol: 0.06 };

const SCALE = 173.7178;
const TAU = 0.5;
const EPS = 1e-6;

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expect = (mu: number, muj: number, phij: number) =>
  1 / (1 + Math.exp(-g(phij) * (mu - muj)));

export interface Opponent {
  rating: number;
  rd: number;
  /** 1 = win, 0.5 = draw, 0 = loss (from the subject player's perspective) */
  result: number;
}

/** Update one player's Glicko given their results this rating period. */
export function updateGlicko(player: Glicko, opponents: Opponent[]): Glicko {
  // Unrated period: only inflate RD toward the deviation cap.
  if (opponents.length === 0) {
    const phi = player.rd / SCALE;
    const phiStar = Math.min(Math.sqrt(phi * phi + player.vol * player.vol), 350 / SCALE);
    return { rating: player.rating, rd: phiStar * SCALE, vol: player.vol };
  }

  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;

  let vInv = 0;
  let deltaSum = 0;
  for (const o of opponents) {
    const muj = (o.rating - 1500) / SCALE;
    const phij = o.rd / SCALE;
    const e = expect(mu, muj, phij);
    const gj = g(phij);
    vInv += gj * gj * e * (1 - e);
    deltaSum += gj * (o.result - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Iterate the new volatility (Illinois algorithm).
  const a = Math.log(player.vol * player.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPS) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const newVol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  return {
    rating: newMu * SCALE + 1500,
    rd: Math.min(newPhi * SCALE, 350),
    vol: newVol,
  };
}

/** Convenience: update both sides of a single 1v1 given each score. */
export function updatePair(
  a: Glicko,
  b: Glicko,
  aResult: number
): { a: Glicko; b: Glicko } {
  return {
    a: updateGlicko(a, [{ rating: b.rating, rd: b.rd, result: aResult }]),
    b: updateGlicko(b, [{ rating: a.rating, rd: a.rd, result: 1 - aResult }]),
  };
}

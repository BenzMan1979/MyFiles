import { Board, FILES, Move, RANKS, Side, Square, fileOf, opponent, rankOf, sq } from './types';

const ORTHOGONAL: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAGONAL: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const KNIGHT: [number, number][] = [
  [1, 2],
  [-1, 2],
  [1, -2],
  [-1, -2],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
];

export const inBounds = (x: number, y: number) => x >= 0 && x < FILES && y >= 0 && y < RANKS;

export const inPalace = (side: Side, x: number, y: number) =>
  x >= 3 && x <= 5 && (side === 'red' ? y >= 0 && y <= 2 : y >= 7 && y <= 9);

/** True when rank y is on `side`'s own half of the river. */
export const onOwnHalf = (side: Side, y: number) => (side === 'red' ? y <= 4 : y >= 5);

export const forward = (side: Side) => (side === 'red' ? 1 : -1);

/** Moves for the piece on `from`, ignoring whether they leave the mover's king in check. */
export function pseudoMoves(board: Board, from: Square): Square[] {
  const piece = board[from];
  if (!piece) return [];
  const { side } = piece;
  const x0 = fileOf(from);
  const y0 = rankOf(from);
  const out: Square[] = [];

  const canLand = (x: number, y: number) => {
    const target = board[sq(x, y)];
    return !target || target.side !== side;
  };

  switch (piece.type) {
    case 'k':
      for (const [dx, dy] of ORTHOGONAL) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (inPalace(side, x, y) && canLand(x, y)) out.push(sq(x, y));
      }
      break;

    case 'a':
      for (const [dx, dy] of DIAGONAL) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (inPalace(side, x, y) && canLand(x, y)) out.push(sq(x, y));
      }
      break;

    case 'b':
      for (const [dx, dy] of DIAGONAL) {
        const x = x0 + 2 * dx;
        const y = y0 + 2 * dy;
        if (!inBounds(x, y) || !onOwnHalf(side, y)) continue;
        if (board[sq(x0 + dx, y0 + dy)]) continue; // 塞象眼
        if (canLand(x, y)) out.push(sq(x, y));
      }
      break;

    case 'n':
      for (const [dx, dy] of KNIGHT) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (!inBounds(x, y)) continue;
        const legX = Math.abs(dx) === 2 ? x0 + dx / 2 : x0;
        const legY = Math.abs(dy) === 2 ? y0 + dy / 2 : y0;
        if (board[sq(legX, legY)]) continue; // 蹩馬腿
        if (canLand(x, y)) out.push(sq(x, y));
      }
      break;

    case 'r':
      for (const [dx, dy] of ORTHOGONAL) {
        for (let x = x0 + dx, y = y0 + dy; inBounds(x, y); x += dx, y += dy) {
          const target = board[sq(x, y)];
          if (!target) {
            out.push(sq(x, y));
            continue;
          }
          if (target.side !== side) out.push(sq(x, y));
          break;
        }
      }
      break;

    case 'c':
      for (const [dx, dy] of ORTHOGONAL) {
        let screened = false;
        for (let x = x0 + dx, y = y0 + dy; inBounds(x, y); x += dx, y += dy) {
          const target = board[sq(x, y)];
          if (!screened) {
            if (target) screened = true;
            else out.push(sq(x, y));
          } else if (target) {
            if (target.side !== side) out.push(sq(x, y));
            break;
          }
        }
      }
      break;

    case 'p': {
      const f = forward(side);
      if (inBounds(x0, y0 + f) && canLand(x0, y0 + f)) out.push(sq(x0, y0 + f));
      if (!onOwnHalf(side, y0)) {
        for (const dx of [-1, 1]) {
          const x = x0 + dx;
          if (inBounds(x, y0) && canLand(x, y0)) out.push(sq(x, y0));
        }
      }
      break;
    }
  }
  return out;
}

export function findKing(board: Board, side: Side): Square {
  for (let s = 0; s < board.length; s++) {
    const p = board[s];
    if (p && p.type === 'k' && p.side === side) return s;
  }
  return -1;
}

/** True when `side`'s king is attacked, including the 將帥對臉 (flying general) rule. */
export function isInCheck(board: Board, side: Side): boolean {
  const king = findKing(board, side);
  if (king < 0) return true;
  const kx = fileOf(king);
  const ky = rankOf(king);
  const enemy = opponent(side);
  const isEnemy = (x: number, y: number, ...types: string[]) => {
    const p = board[sq(x, y)];
    return !!p && p.side === enemy && types.includes(p.type);
  };

  // Rook / cannon / facing king along files and ranks.
  for (const [dx, dy] of ORTHOGONAL) {
    let screens = 0;
    for (let x = kx + dx, y = ky + dy; inBounds(x, y); x += dx, y += dy) {
      const p = board[sq(x, y)];
      if (!p) continue;
      if (screens === 0) {
        if (p.side === enemy && (p.type === 'r' || (p.type === 'k' && dx === 0))) return true;
        screens = 1;
      } else {
        if (p.side === enemy && p.type === 'c') return true;
        break;
      }
    }
  }

  // Knights: the leg is the square next to the knight, toward the king.
  for (const [dx, dy] of KNIGHT) {
    const nx = kx + dx;
    const ny = ky + dy;
    if (!inBounds(nx, ny) || !isEnemy(nx, ny, 'n')) continue;
    const legX = Math.abs(dx) === 2 ? nx - Math.sign(dx) : nx;
    const legY = Math.abs(dy) === 2 ? ny - Math.sign(dy) : ny;
    if (!board[sq(legX, legY)]) return true;
  }

  // Pawns attack forward, and sideways once across the river.
  const pf = forward(enemy);
  if (inBounds(kx, ky - pf) && isEnemy(kx, ky - pf, 'p')) return true;
  for (const dx of [-1, 1]) {
    const x = kx + dx;
    if (inBounds(x, ky) && !onOwnHalf(enemy, ky) && isEnemy(x, ky, 'p')) return true;
  }

  return false;
}

/** Applies a move to a copy of the board. */
export function applyMove(board: Board, move: Move): Board {
  const next = board.slice();
  next[move.to] = next[move.from];
  next[move.from] = null;
  return next;
}

export function legalMovesFrom(board: Board, from: Square): Square[] {
  const piece = board[from];
  if (!piece) return [];
  return pseudoMoves(board, from).filter(
    (to) => !isInCheck(applyMove(board, { from, to }), piece.side),
  );
}

export function allLegalMoves(board: Board, side: Side): Move[] {
  const moves: Move[] = [];
  for (let from = 0; from < board.length; from++) {
    if (board[from]?.side !== side) continue;
    for (const to of legalMovesFrom(board, from)) moves.push({ from, to });
  }
  return moves;
}
